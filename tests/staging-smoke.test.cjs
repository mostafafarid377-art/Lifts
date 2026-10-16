// Offline tests for scripts/migration/staging-smoke.mjs (Phase 3b, Step 2 fixes).
// Everything is synthetic: a scripted in-memory backend stands in for Supabase,
// so no test ever opens a network connection. Covers: normal cleanup, partial
// failures, UUID pin conflicts (verified + unverified ownership), cleanup
// failures, the finally-style cleanup guarantee (R-a), ownership re-verification
// (R-b), orphan sweep scoping (R-c/R-d), and T6 wording (R-e).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'migration', 'staging-smoke.mjs');

let modsPromise = null;
function mods() {
  if (!modsPromise) {
    modsPromise = (async () => {
      const smoke = await import(pathToFileURL(SCRIPT).href);
      const manifest = await import(pathToFileURL(path.join(ROOT, 'scripts', 'migration', 'build-manifest.mjs')).href);
      return { ...smoke, pinForUid: manifest.pinForUid };
    })();
  }
  return modsPromise;
}

const RUN = 'run0001';
const alphaUid = `fixture-staging-smoke-alpha-${RUN}`;
const bravoUid = `fixture-staging-smoke-bravo-${RUN}`;
const alphaEmail = `lifts-staging-smoke.alpha+${RUN}@example.com`;
const bravoEmail = `lifts-staging-smoke.bravo+${RUN}@example.com`;
const OTHER_ID = '9e3f7c21-4b2a-4d18-9a6c-77e5b0f1d234'; // id a conflict would "unexpectedly" return

function envOf() {
  return {
    url: 'https://staging-fake.supabase.co',
    secret: 'sb_secret_fake-test-key',
    publishable: 'sb_publishable_fake-test-key',
    pat: ''
  };
}

// ── scripted Supabase stand-in ─────────────────────────────────────────────
function fakeBackend(inject = {}) {
  const state = { users: new Map(), mapping: new Map(), userData: new Map() };
  const deletes = { users: [], mapping: [] };
  let adminCreates = 0;
  const getCalls = new Map();

  const ok = (status, data) => ({ status, ok: status >= 200 && status < 300, data });
  const rowsOf = m => [...m.values()];

  function filterEq(rows, key, val) {
    if (!val) return rows;
    if (val.startsWith('eq.')) {
      const want = val.slice(3);
      return rows.filter(r => String(r[key]) === want);
    }
    if (val.startsWith('in.(')) {
      const list = val.slice(4, -1).split(',').map(s => s.trim().replace(/^"|"$/g, ''));
      return rows.filter(r => list.includes(String(r[key])));
    }
    return rows;
  }
  function restQuery(url, rows, key) {
    return filterEq(rows, key, url.searchParams.get(key));
  }
  function role(o) {
    if (o.token === envOf().secret) return 'service';
    if (typeof o.token === 'string' && o.token.startsWith('tok.')) return { user: o.token.slice(4) };
    return 'anon';
  }
  const deny = () => ok(401, { code: '401', message: 'permission denied for table (simulated)' });

  async function call(method, href, o = {}) {
    const url = new URL(href);
    const p = url.pathname;
    const body = o.body;

    // ── Auth: health
    if (p === '/auth/v1/health') return ok(200, { date: 'fake' });

    // ── Auth: admin users
    if (p === '/auth/v1/admin/users' && method === 'POST') {
      adminCreates += 1;
      if (inject.conflictMode && adminCreates === 1) {
        const id = OTHER_ID;
        const stored = inject.conflictMode === 'verified'
          ? { id, email: body.email, password: body.password, app_metadata: { ...body.app_metadata } }
          : { id, email: 'stranger@outsider.test', password: body.password, app_metadata: { provider: 'email' } };
        state.users.set(id, stored);
        return ok(200, { user: { id } });
      }
      if (state.users.has(body.id)) return ok(422, { code: 'user_already_exists', msg: 'id taken' });
      if ([...state.users.values()].some(u => u.email === body.email)) return ok(422, { code: 'email_exists', msg: 'email taken' });
      state.users.set(body.id, { id: body.id, email: body.email, password: body.password, app_metadata: { ...body.app_metadata } });
      return ok(200, { user: { id: body.id } });
    }
    if (p === '/auth/v1/admin/users' && method === 'GET') {
      const page = Number(url.searchParams.get('page') || '1');
      const per = Number(url.searchParams.get('per_page') || '100');
      const all = rowsOf(state.users);
      return ok(200, { users: all.slice((page - 1) * per, page * per), aud: 'authenticated' });
    }
    if (p.startsWith('/auth/v1/admin/users/')) {
      const id = decodeURIComponent(p.slice('/auth/v1/admin/users/'.length));
      if (method === 'GET') {
        getCalls.set(id, (getCalls.get(id) || 0) + 1);
        const u = state.users.get(id);
        if (!u) return ok(404, { message: 'User not found' });
        if (inject.tamperFromGet && getCalls.get(id) >= inject.tamperFromGet) {
          return ok(200, { user: { id: u.id, email: u.email, app_metadata: {} } }); // claim stripped
        }
        return ok(200, { user: { id: u.id, email: u.email, app_metadata: { ...u.app_metadata } } });
      }
      if (method === 'DELETE') {
        if (inject.adminDeleteFail) return ok(500, { message: 'delete failed (simulated)' });
        if (!state.users.has(id)) return ok(404, { message: 'User not found' });
        deletes.users.push(id);
        state.users.delete(id);
        for (const [k, row] of [...state.userData]) if (row.user_id === id) state.userData.delete(k); // FK cascade
        return ok(204, null);
      }
    }

    // ── Auth: password grant
    if (p === '/auth/v1/token' && method === 'POST') {
      const u = [...state.users.values()].find(x => x.email === body.email && x.password === body.password);
      if (!u) return ok(400, { error: 'invalid_grant', error_description: 'invalid login credentials' });
      return ok(200, { access_token: `tok.${u.id}`, token_type: 'bearer', user: { id: u.id } });
    }

    // ── Data API
    const tableMissing = () => ok(404, { code: '42P01', message: `relation "public.${p.split('/').pop()}" does not exist` });
    if (p === '/rest/v1/firebase_uid_map') {
      if (inject.tablesMissing && method === 'GET') return tableMissing();
      const r = role(o);
      if (r === 'service') {
        if (method === 'GET') return ok(200, restQuery(url, rowsOf(state.mapping), 'firebase_uid'));
        if (method === 'POST') {
          if (inject.failMappingInsert) return ok(500, { message: 'insert failed (simulated)' });
          if (state.mapping.has(body.firebase_uid)) return ok(409, { code: '23505', message: 'duplicate key' });
          state.mapping.set(body.firebase_uid, { ...body });
          return ok(201, [{ ...body }]);
        }
        if (method === 'DELETE') {
          const want = url.searchParams.get('firebase_uid') || '';
          const uid = want.startsWith('eq.') ? want.slice(3) : null;
          const hit = uid && state.mapping.get(uid);
          if (uid) { state.mapping.delete(uid); deletes.mapping.push(uid); }
          return ok(200, hit ? [hit] : []);
        }
      }
      // anon / authenticated: no grants → refused; injectable "readable but empty" for R-e
      if (method === 'GET' && inject.anonReadable && r === 'anon') return ok(200, []);
      return deny();
    }
    if (p === '/rest/v1/user_data') {
      if (inject.tablesMissing && method === 'GET') return tableMissing();
      const r = role(o);
      if (r === 'service') {
        if (method === 'GET') return ok(200, restQuery(url, rowsOf(state.userData), 'user_id'));
        if (method === 'POST') {
          if (inject.failUserSeed && body && body.payload && body.payload.phase) {
            throw new Error('ECONNRESET (simulated mid-run network failure)');
          }
          if (state.userData.has(body.user_id)) return ok(409, { code: '23505', message: 'duplicate key' });
          state.userData.set(body.user_id, { user_id: body.user_id, payload: { ...body.payload } });
          return ok(201, [{ user_id: body.user_id, payload: { ...body.payload } }]);
        }
      }
      if (r && typeof r === 'object') { // authenticated: RLS auth.uid() = user_id
        if (method === 'GET') {
          const own = rowsOf(state.userData).filter(row => row.user_id === r.user);
          return ok(200, restQuery(url, own, 'user_id'));
        }
        return deny();
      }
      return deny();
    }
    return ok(404, { message: `unrouted: ${method} ${p} (fake)` });
  }

  return { call, state, deletes };
}

async function run(backend, opts = {}, extra = {}) {
  const { runSmoke } = await mods();
  return runSmoke({ env: envOf(), opts, call: backend.call, runId: RUN, ...extra });
}
const byId = (results, id) => results.filter(r => r.id === id);
const find = (results, re) => results.find(r => re.test(r.id + ' ' + r.detail));

// ── 1. normal cleanup ──────────────────────────────────────────────────────
test('happy path: all stages PASS and only this run\'s resources are deleted', async () => {
  const { pinForUid } = await mods();
  const b = fakeBackend();
  const { results, code } = await run(b);
  assert.equal(code, 0, JSON.stringify(results, null, 2));
  assert.ok(results.every(r => r.status === 'PASS'), JSON.stringify(results, null, 2));
  const alphaPin = pinForUid(alphaUid), bravoPin = pinForUid(bravoUid);
  assert.deepEqual([...b.deletes.users].sort(), [alphaPin, bravoPin].sort());
  assert.deepEqual([...b.deletes.mapping].sort(), [alphaUid, bravoUid].sort());
  assert.equal(b.state.users.size, 0);
  assert.equal(b.state.mapping.size, 0);
  assert.equal(b.state.userData.size, 0); // cascade verified
  assert.equal(byId(results, 'T8').length, 1);
  assert.equal(byId(results, 'T8')[0].status, 'PASS');
});

// ── 2. abort before creation ───────────────────────────────────────────────
test('missing tables: aborts before creating anything (no deletes)', async () => {
  const b = fakeBackend({ tablesMissing: true });
  const { results, code } = await run(b);
  assert.equal(code, 1);
  assert.ok(find(results, /table is missing/));
  assert.equal(b.deletes.users.length, 0);
  assert.equal(b.deletes.mapping.length, 0);
  assert.equal(b.state.users.size, 0);
  assert.equal(byId(results, 'T8').length, 0); // nothing created → finally path not entered
});

// ── 3. partial failure: mapping insert fails ───────────────────────────────
test('partial failure: mapping insert fails → T5 FAIL, cleanup still removes users', async () => {
  const b = fakeBackend({ failMappingInsert: true });
  const { results, code } = await run(b);
  assert.equal(code, 1);
  assert.ok(byId(results, 'T5').every(r => r.status === 'FAIL'));
  assert.equal(byId(results, 'T8')[0].status, 'PASS');
  assert.equal(b.state.users.size, 0, 'synthetic users must be cleaned despite T5 failure');
  assert.equal(b.deletes.users.length, 2);
});

// ── 4. R-a: exception after creation still cleans up ────────────────────────
test('R-a: network exception during user_data seed still runs cleanup', async () => {
  const b = fakeBackend({ failUserSeed: true });
  const { results, code } = await run(b);
  assert.equal(code, 1);
  assert.ok(find(results, /seed error: ECONNRESET/), 'T7 seed failure must be caught, not fatal');
  assert.equal(byId(results, 'T8')[0].status, 'PASS', 'cleanup must run after a mid-run network exception');
  assert.equal(b.state.users.size, 0);
  assert.equal(b.deletes.users.length, 2);
});

// ── 5. R-b: conflict with verified ownership ───────────────────────────────
test('R-b: verified pin conflict — unexpected id ownership-checked then cleaned; stages NOT RUN', async () => {
  const { pinForUid } = await mods();
  const b = fakeBackend({ conflictMode: 'verified' });
  const { results, code } = await run(b);
  assert.equal(code, 1);
  assert.ok(find(results, /PIN CONFLICT/));
  assert.ok(find(results, /T3b.*ownership verified/));
  for (const id of ['T4', 'T5', 'T6', 'T7']) {
    assert.ok(byId(results, id).some(r => r.status === 'NOT RUN'), `${id} must be NOT RUN after conflict`);
  }
  assert.ok(b.deletes.users.includes(OTHER_ID), 'ownership-PROVEN conflict user must be cleaned');
  assert.ok(b.deletes.users.includes(pinForUid(bravoUid)));
  assert.equal(b.state.users.size, 0);
  assert.equal(byId(results, 'T8')[0].status, 'PASS');
});

// ── 6. R-b: conflict WITHOUT verifiable ownership ───────────────────────────
test('R-b: unverified conflict user is reported for manual review and NOT deleted', async () => {
  const b = fakeBackend({ conflictMode: 'unverified' });
  const { results, code } = await run(b);
  assert.equal(code, 1);
  assert.ok(find(results, /MANUAL REVIEW REQUIRED.*will NOT be deleted/));
  assert.ok(find(results, /PIN CONFLICT/));
  assert.ok(b.deletes.users.includes(OTHER_ID) === false, 'unproven ownership must never be deleted');
  assert.ok(b.state.users.has(OTHER_ID), 'unexpected user must remain for manual review');
  const bravoId = (await mods()).pinForUid(bravoUid);
  assert.ok(b.deletes.users.includes(bravoId), 'the proven synthetic sibling must still be cleaned');
  assert.ok(b.state.users.size === 1);
  assert.ok(find(byId(results, 'T8').map(r => ({ ...r })), /MANUAL REVIEW \(not deleted\)/));
});

// ── 7. cleanup itself fails ────────────────────────────────────────────────
test('cleanup failure: delete errors surface as FAIL and resources remain, run exits 1', async () => {
  const b = fakeBackend({ adminDeleteFail: true });
  const { results, code } = await run(b);
  assert.equal(code, 1);
  assert.ok(find(results, /delete failed for/));
  assert.ok(find(results, /cleanup incomplete/));
  assert.equal(b.state.users.size, 2, 'users remain because deletion failed (reported, not hidden)');
});

// ── 8. R-b: ownership re-check blocks deletion ──────────────────────────────
test('R-b: ownership re-verification failure blocks deletion (manual review)', async () => {
  const b = fakeBackend({ tamperFromGet: 2 }); // T4 read ok; T8 pre-delete read comes back stripped
  const { results, code } = await run(b);
  assert.equal(code, 1);
  assert.ok(find(results, /ownership re-verification failed.*NOT deleted, manual review/));
  assert.equal(b.state.users.size, 2, 'users must survive when ownership cannot be re-proven');
  assert.equal(b.deletes.users.length, 0);
  assert.ok(find(results, /MANUAL REVIEW \(not deleted\)/));
});

// ── 9. apply without PAT ───────────────────────────────────────────────────
test('apply-without-PAT reports FAIL T0b', async () => {
  const b = fakeBackend();
  const { results, code } = await run(b, { apply: true });
  assert.equal(code, 1);
  assert.ok(byId(results, 'T0b').some(r => r.status === 'FAIL' && /requires SUPABASE_STAGING_ACCESS_TOKEN/.test(r.detail)));
});

// ── 10. R-e wording ────────────────────────────────────────────────────────
test('R-e: readable-but-empty table reported as no-data-disclosed, not authorization refusal', async () => {
  const b = fakeBackend({ anonReadable: true });
  const { results, code } = await run(b);
  assert.equal(code, 0, JSON.stringify(results, null, 2));
  const anonSelect = results.find(r => r.id === 'T6' && /anon SELECT/.test(r.detail));
  assert.ok(anonSelect && anonSelect.status === 'PASS');
  assert.match(anonSelect.detail, /no data disclosed \(HTTP 200, 0 rows; row-level denial\)/);
  assert.doesNotMatch(anonSelect.detail, /authorization refused/);
  const authLine = results.find(r => r.id === 'T6' && /authenticated SELECT/.test(r.detail));
  assert.match(authLine.detail, /authorization refused \(HTTP 401\)/);
});

// ── 11-12. pure assessments ────────────────────────────────────────────────
test('assessOrphanUser: delete only on full per-run cross-check; real users skipped', async () => {
  const { assessOrphanUser } = await mods();
  assert.equal(assessOrphanUser({ id: 'u1', email: 'person@company.org', app_metadata: { provider: 'email' } }).decision, 'skip');
  assert.equal(
    assessOrphanUser({ id: 'u1', email: 'plain@example.com', app_metadata: {} }).decision,
    'skip'
  );
  const good = assessOrphanUser({
    id: 'u1', email: alphaEmail,
    app_metadata: { firebase_uid: alphaUid, phase: '3b-staging', synthetic: true }
  });
  assert.equal(good.decision, 'delete');
  assert.deepEqual(good.expect, { uid: alphaUid, email: alphaEmail });
  // run-tag mismatch (uid from one run, email from another)
  assert.equal(assessOrphanUser({
    id: 'u2', email: `lifts-staging-smoke.alpha+run9999@example.com`,
    app_metadata: { firebase_uid: alphaUid, phase: '3b-staging', synthetic: true }
  }).decision, 'manual-review');
  // variant mismatch (alpha uid, bravo email)
  assert.equal(assessOrphanUser({
    id: 'u3', email: bravoEmail,
    app_metadata: { firebase_uid: alphaUid, phase: '3b-staging', synthetic: true }
  }).decision, 'manual-review');
  // markers without a recognizable uid
  assert.equal(assessOrphanUser({
    id: 'u4', email: 'someone@example.com',
    app_metadata: { firebase_uid: 'weird-uid', phase: '3b-staging', synthetic: true }
  }).decision, 'manual-review');
  // our email pattern but no markers
  assert.equal(assessOrphanUser({ id: 'u5', email: alphaEmail, app_metadata: {} }).decision, 'manual-review');
});

test('assessOrphanRow: fixture/negative rows verified or manual; foreign rows skipped', async () => {
  const { assessOrphanRow, pinForUid } = await mods();
  assert.equal(assessOrphanRow({ firebase_uid: 'some-real-user', supabase_uuid: pinForUid('x'), email: 'a@b.co' }).decision, 'skip');
  assert.equal(assessOrphanRow({}).decision, 'skip');
  assert.equal(assessOrphanRow({
    firebase_uid: alphaUid, supabase_uuid: pinForUid(alphaUid), email: alphaEmail
  }).decision, 'delete');
  assert.equal(assessOrphanRow({
    firebase_uid: alphaUid, supabase_uuid: pinForUid(alphaUid), email: 'not-ours@other.test'
  }).decision, 'manual-review');
  assert.equal(assessOrphanRow({
    firebase_uid: `denied-${RUN}`, supabase_uuid: '00000000-0000-4000-8000-000000000005', email: 'denied@example.com'
  }).decision, 'delete');
  assert.equal(assessOrphanRow({
    firebase_uid: `denied-${RUN}`, supabase_uuid: '00000000-0000-4000-8000-000000000005', email: 'other@x.test'
  }).decision, 'manual-review');
  // uid/email run-tag mismatch inside a fixture row
  assert.equal(assessOrphanRow({
    firebase_uid: alphaUid, supabase_uuid: pinForUid(alphaUid), email: `lifts-staging-smoke.alpha+run9999@example.com`
  }).decision, 'manual-review');
});

// ── 13. cleanup-only sweep scoping ─────────────────────────────────────────
test('cleanup-only: deletes verified orphans, reports ambiguous, leaves real users/rows untouched', async () => {
  const { runCleanupOnly, pinForUid } = await mods();
  const b = fakeBackend();
  const oldRun = 'old99';
  const orphanUid = `fixture-staging-smoke-bravo-${oldRun}`;
  const orphanEmail = `lifts-staging-smoke.bravo+${oldRun}@example.com`;
  // verified orphan from an earlier aborted run (+ its mapping row)
  b.state.users.set('orphan-1', { id: 'orphan-1', email: orphanEmail, app_metadata: { firebase_uid: orphanUid, phase: '3b-staging', synthetic: true } });
  b.state.mapping.set(orphanUid, { firebase_uid: orphanUid, supabase_uuid: pinForUid(orphanUid), email: orphanEmail, provider_hint: 'password', status: 'planned' });
  // ambiguous: run-tags do not cross-match → manual review, kept
  b.state.users.set('ambig-1', { id: 'ambig-1', email: `lifts-staging-smoke.alpha+run0001@example.com`, app_metadata: { firebase_uid: `fixture-staging-smoke-alpha-run9999`, phase: '3b-staging', synthetic: true } });
  b.state.mapping.set('fixture-staging-smoke-alpha-run0001', { firebase_uid: `fixture-staging-smoke-alpha-run0001`, supabase_uuid: pinForUid('fixture-staging-smoke-alpha-run0001'), email: 'mismatch@elsewhere.test', provider_hint: 'password', status: 'planned' });
  // real user + real row → must never appear in any report or action
  b.state.users.set('real-1', { id: 'real-1', email: 'real.person@company.org', app_metadata: { provider: 'email', providers: ['email'] } });
  b.state.mapping.set('real-user-key', { firebase_uid: 'real-user-key', supabase_uuid: pinForUid('real-user-key'), email: 'real.person@company.org', provider_hint: 'password', status: 'verified' });

  const { results, code } = await runCleanupOnly({ env: envOf(), call: b.call });
  assert.equal(code, 1, 'ambiguous items force exit 1 for review');
  assert.deepEqual(b.deletes.users, ['orphan-1'], 'only the fully verified orphan may be deleted');
  assert.ok(b.state.users.has('ambig-1'), 'ambiguous user kept');
  assert.ok(b.state.users.has('real-1'), 'real user untouched');
  assert.ok(!b.deletes.users.includes('real-1') && !b.deletes.users.includes('ambig-1'));
  assert.deepEqual(b.deletes.mapping, [orphanUid], 'only the verified fixture row may be deleted');
  assert.ok(b.state.mapping.has('fixture-staging-smoke-alpha-run0001'), 'ambiguous row kept');
  assert.ok(b.state.mapping.has('real-user-key'), 'real row kept');
  assert.ok(results.filter(r => /MANUAL REVIEW:/.test(r.detail)).length >= 2, 'both ambiguous resources reported');
  assert.ok(!JSON.stringify(results).includes('real.person'), 'real identities never even mentioned in the report');
  assert.ok(find(results, /users scanned=3 deleted=1 manual=1 skipped=1/));
  assert.ok(find(results, /mapping rows scanned=3 deleted=1 manual=1 skipped=1/));
});

// ── 14. CLI guards (subprocess, offline) ───────────────────────────────────
test('CLI guards: dry-run exits 0 without env; real run without env exits 2', () => {
  const dry = spawnSync(process.execPath, [SCRIPT, '--dry-run'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /DRY RUN/);
  assert.match(dry.stdout, /SUPABASE_STAGING_URL \(MISSING\)/);
  const real = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(real.status, 2);
  assert.match(real.stderr, /missing required environment variables/);
});
