// Offline tests for scripts/migration/provision-users.mjs (Phase 3c O2) —
// the provisioning runner core. Everything runs against an in-memory fake
// Auth backend: no network, no credentials, no real data. Covers: format
// round-trips, all-at-once input validation (duplicates/conflicts/malformed),
// successful provisioning bodies (pinned id, claim, NO password), retries,
// duplicates/idempotent reruns, partial failures, pin/identity/email
// conflicts with safe halts, redaction of emails and backend messages, and
// CLI exit-code guards.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'migration', 'provision-users.mjs');

let modsPromise = null;
function mods() {
  if (!modsPromise) {
    modsPromise = (async () => {
      const prov = await import(pathToFileURL(SCRIPT).href);
      const man = await import(pathToFileURL(path.join(ROOT, 'scripts', 'migration', 'build-manifest.mjs')).href);
      return { ...prov, pinForUid: man.pinForUid };
    })();
  }
  return modsPromise;
}

const USERS = '/auth/v1/admin/users';

function R(uid, pinForUid, over = {}) {
  return {
    firebase_uid: uid,
    supabase_uuid: pinForUid(uid),
    email: uid.replace(/[^a-z0-9]+/g, '-') + '@example.test',
    provider_hint: 'password',
    status: 'planned',
    ...over
  };
}

function defaultCreate(body, state) {
  if (state.users.has(body.id)) {
    return { status: 422, ok: false, data: { code: 'user_already_exists', msg: 'id taken' } };
  }
  if ([...state.users.values()].some(u => u.email === body.email)) {
    // deliberate leak trap: backend echoes the raw email — the report must not carry it
    return { status: 422, ok: false, data: { code: 'email_exists', msg: `email ${body.email} already registered` } };
  }
  state.users.set(body.id, { id: body.id, email: body.email, app_metadata: { ...body.app_metadata } });
  return { status: 200, ok: true, data: { user: { id: body.id } } };
}

function fakeBackend({ postLogic, getLogic } = {}) {
  const state = { users: new Map() };
  const calls = [];
  let posts = 0;
  let gets = 0;
  const call = async (method, href, opts = {}) => {
    calls.push({ method, href, body: opts.body ? JSON.parse(JSON.stringify(opts.body)) : null });
    if (method === 'POST' && href === USERS) {
      posts++;
      if (postLogic) {
        const r = postLogic(posts, opts.body, state);
        if (r === 'THROW') throw new Error('ECONNRESET (simulated)');
        return r;
      }
      return defaultCreate(opts.body, state);
    }
    if (method === 'GET' && href.startsWith(USERS + '/')) {
      gets++;
      const id = decodeURIComponent(href.slice(USERS.length + 1));
      if (getLogic) {
        const r = getLogic(gets, id, state);
        if (r === 'THROW') throw new Error('network (simulated)');
        return r;
      }
      const u = state.users.get(id);
      return u
        ? { status: 200, ok: true, data: { user: { id: u.id, email: u.email, app_metadata: { ...u.app_metadata } } } }
        : { status: 404, ok: false, data: { message: 'User not found' } };
    }
    return { status: 404, ok: false, data: { message: 'unrouted' } };
  };
  return { call, state, calls, counts: () => ({ posts, gets }) };
}

const recorder = () => {
  const delays = [];
  return { delays, delay: async ms => { delays.push(ms); } };
};

async function run(rows, backend, extra = {}) {
  const { runProvision } = await mods();
  const rec = recorder();
  const report = await runProvision({ rows, call: backend.call, retryBaseMs: 5, delay: rec.delay, ...extra });
  return { report, delays: rec.delays };
}

const byUid = (report, uid) => report.results.filter(r => r.firebase_uid === uid);

// ── Format + validation ────────────────────────────────────────────────────

test('manifest format round-trips byte-for-byte and validation sorts deterministically', async () => {
  const { parseManifestText, validateProvisionRows, formatManifest, pinForUid } = await mods();
  const rows = ['prov-charlie', 'prov-alpha', 'prov-bravo'].map(u => R(u, pinForUid));
  const text = formatManifest(rows);
  assert.match(text, /\n$/, 'trailing newline preserved');
  const parsed = parseManifestText(text);
  const validated = validateProvisionRows(parsed);
  assert.deepEqual(JSON.parse(JSON.stringify(validated)), JSON.parse(JSON.stringify(rows.slice().sort((a, b) => (a.firebase_uid < b.firebase_uid ? -1 : 1)))));
  const again = formatManifest(validated);
  assert.equal(again, formatManifest(validateProvisionRows(parseManifestText(again))), 'rerun-stable bytes');
});

test('duplicate and conflicting identities are rejected together before any backend call', async () => {
  const { runProvision, pinForUid } = await mods();
  const backend = fakeBackend();
  const rows = [
    R('dup-uid', pinForUid),
    R('dup-uid', pinForUid, { email: 'other@example.test' }), // duplicate firebase_uid
    R('uuid-a', pinForUid, { supabase_uuid: '11111111-2222-4333-8444-555555555555' }),
    R('uuid-b', pinForUid, { supabase_uuid: '11111111-2222-4333-8444-555555555555' }), // duplicate pin
    R('email-a', pinForUid, { email: 'shared@example.test' }),
    R('email-b', pinForUid, { email: 'shared@example.test' }) // email identity conflict
  ];
  await assert.rejects(() => run(rows, backend), err => {
    assert.ok(err.errors.some(e => /duplicate firebase_uid/.test(e)));
    assert.ok(err.errors.some(e => /duplicate supabase_uuid/.test(e)));
    assert.ok(err.errors.some(e => /conflicting identity/.test(e)));
    return true;
  });
  assert.equal(backend.calls.length, 0, 'validation precedes every backend call');
});

test('malformed rows, unknown fields, and bad lines are all reported together', async () => {
  const { runProvision, parseManifestText, validateProvisionRows, pinForUid } = await mods();
  const backend = fakeBackend();
  const rows = [
    R('good-uid', pinForUid),
    R('bad-uuid', pinForUid, { supabase_uuid: 'not-a-uuid' }),
    R('bad-email', pinForUid, { email: 'not-an-email' }),
    R('upper-email', pinForUid, { email: 'UPPER@example.test' }),
    R('bad-status', pinForUid, { status: 'done' }),
    R('bad-hint', pinForUid, { provider_hint: 'magic-link' }),
    { firebase_uid: 'extra-field', supabase_uuid: pinForUid('extra-field'), email: 'extra@example.test', provider_hint: 'password', status: 'planned', note: 'x' },
    { firebase_uid: 'missing-field', supabase_uuid: pinForUid('missing-field'), email: 'miss@example.test', status: 'planned' }
  ];
  await assert.rejects(() => run(rows, backend), err => {
    for (const frag of ['malformed supabase_uuid', 'malformed email', 'not normalized to lowercase', 'unknown status', 'unknown provider_hint', 'unknown field "note"', 'missing provider_hint']) {
      assert.ok(err.errors.some(e => e.includes(frag)), 'reports: ' + frag);
    }
    return true;
  });
  assert.equal(backend.calls.length, 0);
  assert.throws(() => parseManifestText('this is not json'), /line 1: invalid JSON/);
  assert.throws(() => validateProvisionRows([]), /no rows/);
});

test('runProvision validates its own arguments', async () => {
  const { runProvision, pinForUid } = await mods();
  await assert.rejects(() => runProvision({ rows: [R('x', pinForUid)] }), /injected call/);
  await assert.rejects(() => runProvision({ rows: [R('x', pinForUid)], call: async () => {}, maxAttempts: 0 }), /maxAttempts/);
});

// ── Success path ───────────────────────────────────────────────────────────

test('provisions every planned row with pinned id + firebase_uid claim and never a password', async () => {
  const { pinForUid } = await mods();
  const backend = fakeBackend();
  const rows = [
    R('prov-charlie', pinForUid, { provider_hint: 'password+google.com' }),
    R('prov-alpha', pinForUid),
    R('prov-bravo', pinForUid)
  ];
  const { report } = await run(rows, backend);

  assert.equal(report.status, 'ok');
  assert.equal(report.totals.provisioned, 3);
  assert.deepEqual(Object.keys(report.updates).sort(), ['prov-alpha', 'prov-bravo', 'prov-charlie']);
  for (const v of Object.values(report.updates)) assert.equal(v, 'provisioned');
  assert.equal(backend.state.users.size, 3);

  // deterministic order: sorted by firebase_uid
  assert.deepEqual(backend.calls.map(c => c.body.app_metadata.firebase_uid), ['prov-alpha', 'prov-bravo', 'prov-charlie']);

  for (const c of backend.calls) {
    const body = c.body;
    assert.deepEqual(Object.keys(body).sort(), ['app_metadata', 'email', 'email_confirm', 'id'], 'exact create body — no password, nothing else');
    assert.equal(body.id, pinForUid(body.app_metadata.firebase_uid), 'id is the deterministic pin for that uid');
    assert.equal(body.email_confirm, true);
    assert.ok(!('password' in body) && !('passHash' in body) && !('password_hash' in body));
  }
  // results are masked, never raw emails
  const s = JSON.stringify(report);
  assert.ok(!s.includes('prov-alpha@example.test'), 'raw email never in the report');
  assert.ok(s.includes('p***@example.test'), 'masked email present');
  assert.equal(report.results.every(r => r.outcome === 'provisioned'), true);
});

// ── Conflicts and safe halts ───────────────────────────────────────────────

test('pin conflict: an unexpected returned id halts the run after that row', async () => {
  const { pinForUid } = await mods();
  const backend = fakeBackend({
    postLogic: (n, body, state) => (n === 1
      ? { status: 200, ok: true, data: { user: { id: '9e3f7c21-4b2a-4d18-9a6c-77e5b0f1d234' } } }
      : defaultCreate(body, state))
  });
  const rows = ['pc-alpha', 'pc-bravo', 'pc-charlie'].map(u => R(u, pinForUid));
  const { report } = await run(rows, backend);

  assert.equal(report.status, 'halted');
  assert.equal(report.halted.reason, 'pin-conflict');
  const first = byUid(report, 'pc-alpha')[0];
  assert.equal(first.outcome, 'conflict');
  assert.equal(first.toStatus, 'conflict');
  assert.match(first.detail, /PIN CONFLICT/);
  assert.equal(report.updates['pc-alpha'], 'conflict');
  assert.equal(report.results.filter(r => r.outcome === 'not-run').length, 2, 'remaining rows never run');
  assert.equal(report.totals.provisioned, 0);
  assert.equal(backend.counts().posts, 1, 'halted immediately');
  assert.equal(backend.state.users.size, 0, 'nothing created by the conflict flow');
});

test('a 200 response without a usable user id is a pin conflict, not a success', async () => {
  const { pinForUid } = await mods();
  const backend = fakeBackend({ postLogic: () => ({ status: 200, ok: true, data: {} }) });
  const { report } = await run([R('no-id', pinForUid)], backend);
  assert.equal(report.status, 'halted');
  assert.equal(byUid(report, 'no-id')[0].outcome, 'conflict');
  assert.equal(report.updates['no-id'], 'conflict');
});

test('foreign email conflict halts: no adoption, no GET, no DELETE', async () => {
  const { pinForUid } = await mods();
  const backend = fakeBackend();
  // a different account already holds this email
  backend.state.users.set('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', {
    id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', email: 'aaa-email-conflict@example.test', app_metadata: { firebase_uid: 'someone-else' }
  });
  const rows = ['aaa-email-conflict', 'zzz-email-after'].map(u => R(u, pinForUid));
  const { report } = await run(rows, backend);

  assert.equal(report.status, 'halted');
  assert.equal(report.halted.reason, 'email-exists');
  const hit = byUid(report, 'aaa-email-conflict')[0];
  assert.equal(hit.outcome, 'conflict');
  assert.match(hit.detail, /E1/);
  assert.equal(backend.counts().gets, 0, 'email conflicts are never probed for adoption');
  assert.equal(backend.calls.some(c => c.method === 'DELETE'), false, 'no delete ever');
  assert.equal(backend.state.users.size, 1, 'existing foreign user untouched');
  assert.equal(byUid(report, 'zzz-email-after')[0].outcome, 'not-run');
  // report must not echo the backend message (which contains the raw email)
  assert.ok(!JSON.stringify(report).includes('aaa-email-conflict@example.test'));
});

test('existing user at our pin with a foreign claim halts as conflict (never auto-adopt)', async () => {
  const { pinForUid } = await mods();
  const backend = fakeBackend();
  const uid = 'aaa-foreign-pin-uid';
  const pin = pinForUid(uid);
  backend.state.users.set(pin, { id: pin, email: 'occupied@example.test', app_metadata: { firebase_uid: 'a-different-uid' } });
  const rows = [R(uid, pinForUid), R('zzz-after-foreign', pinForUid)];
  const { report } = await run(rows, backend);

  assert.equal(report.status, 'halted');
  assert.equal(report.halted.reason, 'foreign-identity-at-pin');
  assert.equal(byUid(report, uid)[0].outcome, 'conflict');
  assert.equal(report.updates[uid], 'conflict');
  assert.equal(byUid(report, 'zzz-after-foreign')[0].outcome, 'not-run');
  assert.equal(backend.state.users.get(pin).app_metadata.firebase_uid, 'a-different-uid', 'foreign account untouched');
  assert.equal(backend.calls.some(c => c.method === 'DELETE'), false);
});

// ── Idempotent reruns ──────────────────────────────────────────────────────

test('rows already marked provisioned/skipped are never sent to the backend', async () => {
  const { pinForUid } = await mods();
  const backend = fakeBackend();
  const rows = [
    R('st-provisioned', pinForUid, { status: 'provisioned' }),
    R('st-verified', pinForUid, { status: 'verified' }),
    R('st-imported', pinForUid, { status: 'data_imported' }),
    R('st-conflict', pinForUid, { status: 'conflict' }),
    R('st-skipped', pinForUid, { status: 'skipped' })
  ];
  const { report } = await run(rows, backend);
  assert.equal(report.status, 'ok');
  assert.equal(backend.calls.length, 0, 'zero backend calls');
  assert.deepEqual(report.updates, {});
  assert.equal(report.totals.skipped, 5);
  assert.equal(report.results.every(r => r.outcome === 'skipped-status'), true);
});

test('rerun against an already-populated backend verifies the claim and records provisioned', async () => {
  const { pinForUid } = await mods();
  const uids = ['rerun-alpha', 'rerun-bravo'];
  const rows1 = uids.map(u => R(u, pinForUid));
  const backend = fakeBackend();
  const first = await run(rows1, backend);
  assert.equal(first.report.status, 'ok');
  assert.equal(backend.state.users.size, 2);

  // fresh "planned" input (as if the manifest were rebuilt) over the same backend
  const second = await run(uids.map(u => R(u, pinForUid)), backend);
  assert.equal(second.report.status, 'ok');
  assert.equal(backend.state.users.size, 2, 'no second user per identity');
  assert.equal(second.report.totals.provisioned, 2);
  for (const u of uids) {
    const r = byUid(second.report, u)[0];
    assert.equal(r.outcome, 'already-provisioned');
    assert.equal(r.toStatus, 'provisioned');
    assert.match(r.detail, /firebase_uid claim/);
    assert.equal(second.report.updates[u], 'provisioned');
  }
  assert.equal(second.report.results.every(r => r.attempts >= 1), true);
});

// ── Retries and partial failures ───────────────────────────────────────────

test('retries a transient 429 with backoff, then provisions', async () => {
  const { pinForUid } = await mods();
  const backend = fakeBackend({
    postLogic: (n, body, state) => (n === 1 ? { status: 429, ok: false, data: { message: 'slow down' } } : defaultCreate(body, state))
  });
  const { report, delays } = await run([R('retry-429', pinForUid)], backend);
  assert.equal(report.status, 'ok');
  const r = byUid(report, 'retry-429')[0];
  assert.equal(r.outcome, 'provisioned');
  assert.equal(r.attempts, 2);
  assert.deepEqual(delays, [5], 'one backoff wait (retryBaseMs * 2^0)');
});

test('retries thrown network errors, then provisions', async () => {
  const { pinForUid } = await mods();
  const backend = fakeBackend({
    postLogic: (n, body, state) => (n === 1 ? 'THROW' : defaultCreate(body, state))
  });
  const { report, delays } = await run([R('retry-throw', pinForUid)], backend);
  assert.equal(report.status, 'ok');
  assert.equal(byUid(report, 'retry-throw')[0].outcome, 'provisioned');
  assert.equal(byUid(report, 'retry-throw')[0].attempts, 2);
  assert.deepEqual(delays, [5]);
});

test('exhausted retries halt safely: row stays planned, backoff is exponential, nothing else runs', async () => {
  const { pinForUid } = await mods();
  const backend = fakeBackend({ postLogic: () => ({ status: 500, ok: false, data: { message: 'boom' } }) });
  const rows = [R('always-500', pinForUid), R('never-reached', pinForUid)];
  const { report, delays } = await run(rows, backend, { maxAttempts: 3 });

  assert.equal(report.status, 'halted');
  assert.equal(report.halted.reason, 'transient-failures-exhausted');
  const failed = byUid(report, 'always-500')[0];
  assert.equal(failed.outcome, 'failed');
  assert.equal(failed.attempts, 3);
  assert.ok(!('always-500' in report.updates), 'failed row keeps status planned for a safe rerun');
  assert.equal(byUid(report, 'never-reached')[0].outcome, 'not-run');
  assert.deepEqual(delays, [5, 10], 'exponential backoff: base, 2×base');
  assert.equal(backend.counts().posts, 3, 'no calls after exhaustion');
});

test('partial failure: middle row exhausts retries after the first row provisioned', async () => {
  const { pinForUid } = await mods();
  const backend = fakeBackend({
    postLogic: (n, body, state) => (body.app_metadata.firebase_uid === 'pf-bravo'
      ? { status: 500, ok: false, data: { message: 'boom' } }
      : defaultCreate(body, state))
  });
  const rows = ['pf-alpha', 'pf-bravo', 'pf-charlie'].map(u => R(u, pinForUid));
  const { report } = await run(rows, backend);

  assert.equal(report.status, 'halted');
  assert.equal(byUid(report, 'pf-alpha')[0].outcome, 'provisioned');
  assert.equal(report.updates['pf-alpha'], 'provisioned');
  assert.equal(byUid(report, 'pf-bravo')[0].outcome, 'failed');
  assert.ok(!('pf-bravo' in report.updates));
  assert.equal(byUid(report, 'pf-charlie')[0].outcome, 'not-run');
  assert.equal(backend.state.users.size, 1, 'only alpha exists — rerun can resume idempotently');
  assert.equal(backend.counts().posts, 1 + 3, 'alpha once + bravo exhausted attempts');
});

// ── Plan + format helpers ──────────────────────────────────────────────────

test('planProvision flags explicit pin overrides and needs no backend', async () => {
  const { planProvision, validateProvisionRows, pinForUid } = await mods();
  const rows = validateProvisionRows([
    R('plan-derived', pinForUid),
    R('plan-override', pinForUid, { supabase_uuid: '11111111-2222-4333-8444-555555555555' }),
    R('plan-skip', pinForUid, { status: 'skipped' })
  ]);
  const { entries, summary } = planProvision(rows);
  assert.deepEqual(summary, { total: 3, provision: 2, skip: 1 });
  const override = entries.find(e => e.firebase_uid === 'plan-override');
  assert.equal(override.override, true);
  assert.equal(override.action, 'provision');
  assert.equal(entries.find(e => e.firebase_uid === 'plan-derived').override, false);
  assert.equal(entries.find(e => e.firebase_uid === 'plan-skip').action, 'skip(skipped)');
  assert.ok(entries.every(e => !e.emailMasked.includes('plan-')), 'email is masked, not raw');
});

test('applyStatusUpdates + formatManifest keep the manifest contract stable', async () => {
  const { applyStatusUpdates, formatManifest, parseManifestText, validateProvisionRows, pinForUid } = await mods();
  const rows = ['fmt-alpha', 'fmt-bravo'].map(u => R(u, pinForUid));
  const before = formatManifest(rows);
  const updated = applyStatusUpdates(rows, { 'fmt-alpha': 'provisioned' });
  const after = formatManifest(updated);
  assert.equal(after.split('\n')[1], before.split('\n')[1], 'untouched rows byte-identical');
  assert.match(after.split('\n')[0], /"status":"provisioned"}$/, 'status field updated in place, order preserved');
  const round = validateProvisionRows(parseManifestText(after));
  assert.equal(round.find(r => r.firebase_uid === 'fmt-alpha').status, 'provisioned');
  assert.equal(round.find(r => r.firebase_uid === 'fmt-bravo').status, 'planned');
});

// ── CLI guards (subprocess, offline) ───────────────────────────────────────

test('CLI: --dry-run validates and prints a masked plan with exit 0', async () => {
  const { formatManifest, pinForUid } = await mods();
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lifts-prov-')), 'manifest.jsonl');
  const rows = [R('cli-alpha', pinForUid), R('cli-bravo', pinForUid)];
  fs.writeFileSync(file, formatManifest(rows), 'utf8');

  const res = spawnSync(process.execPath, [SCRIPT, '--dry-run', file], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /DRY RUN/);
  assert.match(res.stdout, /cli-alpha/);
  assert.ok(res.stdout.includes(pinForUid('cli-alpha')), 'plan prints the deterministic pin');
  assert.ok(!res.stdout.includes('cli-alpha@example.test'), 'raw email never printed');
  assert.match(res.stdout, /c\*\*\*@example\.test/);
  assert.match(res.stdout, /nothing was created, modified, or contacted/);
});

test('CLI: exit codes — offline refusal (2), validation failure (1), usage (2), help (0)', async () => {
  const { formatManifest, pinForUid } = await mods();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifts-prov-'));
  const good = path.join(dir, 'ok.jsonl');
  const bad = path.join(dir, 'bad.jsonl');
  fs.writeFileSync(good, formatManifest([R('cli-ok', pinForUid)]), 'utf8');
  fs.writeFileSync(bad, 'not a manifest line\n', 'utf8');

  const noArgs = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(noArgs.status, 2);

  const live = spawnSync(process.execPath, [SCRIPT, good], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(live.status, 2, 'live runs refused in this offline build');
  assert.match(live.stderr, /offline-only/);

  const invalid = spawnSync(process.execPath, [SCRIPT, '--dry-run', bad], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(invalid.status, 1, 'validation failure');
  assert.match(invalid.stderr, /line 1: invalid JSON/);

  const missing = spawnSync(process.execPath, [SCRIPT, '--dry-run', path.join(dir, 'nope.jsonl')], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(missing.status, 2, 'unreadable file is a usage error');

  const help = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /usage: node scripts\/migration\/provision-users\.mjs/);
});
