// Offline tests for scripts/migration/import-user-data.mjs (Phase 3c O3) —
// the user_data import runner core. Everything runs against an in-memory fake
// Data API: no network, no credentials, no real data. Covers: successful
// import, verbatim payload round-tripping (unknown/legacy/odd keys), missing
// and invalid input, duplicate identities, set/checksum conflicts, partial
// failures, retries, idempotent reruns, redaction of payloads and emails, and
// prevention of accidental live/network access (source scan + relative-only
// transport + CLI refusal).
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'migration', 'import-user-data.mjs');

let modsPromise = null;
function mods() {
  if (!modsPromise) {
    modsPromise = (async () => {
      const imp = await import(pathToFileURL(SCRIPT).href);
      const man = await import(pathToFileURL(path.join(ROOT, 'scripts', 'migration', 'build-manifest.mjs')).href);
      const prov = await import(pathToFileURL(path.join(ROOT, 'scripts', 'migration', 'provision-users.mjs')).href);
      return { ...imp, pinForUid: man.pinForUid, sha256Hex: man.sha256Hex, formatManifest: man.formatManifest, applyStatusUpdates: prov.applyStatusUpdates, parseManifestText: prov.parseManifestText };
    })();
  }
  return modsPromise;
}

const SAVED_AT = 1760000000000;

function R(uid, pinForUid, status = 'provisioned', over = {}) {
  return {
    firebase_uid: uid,
    supabase_uuid: pinForUid(uid),
    email: uid.replace(/[^a-z0-9]+/g, '-') + '@example.test',
    provider_hint: 'password',
    status,
    ...over
  };
}

function payload(seed) {
  return {
    cats: [{ id: 'push', label: 'Push', color: '#ff5c35' }],
    ex: { push: ['Bench Press'] },
    data: { 'Bench Press': [{ date: '2026-10-01', sets: [{ weight: 50, reps: 5, unit: 'kg' }] }] },
    futureField: { legacy: [1, 'two', null, { nested: true }] },
    constructor: 'preserved-string',
    'ünïcode ✓': 'ü',
    emptyString: '',
    zero: 0,
    savedAt: seed
  };
}

function D(uid, data, savedAt = SAVED_AT) {
  return {
    uid,
    savedAt,
    sha256: crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex'),
    data
  };
}

function defaultWrite(body, state) {
  if (!state.authUsers.has(body.user_id)) {
    return { status: 409, ok: false, data: { code: '23503', message: 'violates foreign key constraint "user_data_user_id_fkey"' } };
  }
  state.rows.set(body.user_id, JSON.parse(JSON.stringify(body)));
  return { status: 201, ok: true, data: [{ ...body }] };
}

function fakeData({ users = [], mutate = false, reorder = false, failFirst = 0, failStatus = 429, postLogic } = {}) {
  const state = { authUsers: new Set(users), rows: new Map() };
  const calls = [];
  let posts = 0;
  const call = async (method, href, opts = {}) => {
    calls.push({ method, href, body: opts.body ? JSON.parse(JSON.stringify(opts.body)) : null });
    if (method === 'POST' && href === '/rest/v1/user_data') {
      posts++;
      if (postLogic) {
        const r = postLogic(posts, opts.body, state);
        if (r === 'THROW') throw new Error('ECONNRESET (simulated)');
        return r;
      }
      if (posts <= failFirst) return { status: failStatus, ok: false, data: { message: 'transient (simulated)' } };
      const body = opts.body;
      const res = defaultWrite(body, state);
      if (res.status !== 201) return res;
      let rep = { ...body };
      if (mutate) rep = { ...body, payload: { ...body.payload, tampered: true } };
      if (reorder) rep = { ...body, payload: Object.fromEntries(Object.keys(body.payload).reverse().map(k => [k, body.payload[k]])) };
      return { status: 201, ok: true, data: [rep] };
    }
    return { status: 404, ok: false, data: { message: 'unrouted' } };
  };
  return { call, state, calls, counts: () => ({ posts }) };
}

const recorder = () => {
  const delays = [];
  return { delays, delay: async ms => { delays.push(ms); } };
};

async function run(rows, docs, backend, extra = {}) {
  const { runImport } = await mods();
  const rec = recorder();
  const report = await runImport({ rows, docs, call: backend.call, retryBaseMs: 5, delay: rec.delay, ...extra });
  return { report, delays: rec.delays };
}

const byUid = (report, uid) => report.results.filter(r => r.firebase_uid === uid);

// ── Successful import + payload preservation ───────────────────────────────

test('imports provisioned rows, advances status, respects FK ordering, issues only POST upserts', async () => {
  const { pinForUid } = await mods();
  const backend = fakeData({ users: [pinForUid('imp-alpha'), pinForUid('imp-bravo')] });
  const rows = [
    R('imp-alpha', pinForUid, 'provisioned'),
    R('imp-bravo', pinForUid, 'provisioned'),
    R('imp-waiting', pinForUid, 'planned'),
    R('imp-done', pinForUid, 'data_imported'),
    R('imp-skip', pinForUid, 'skipped'),
    R('imp-conflict', pinForUid, 'conflict')
  ];
  const docs = [
    D('imp-alpha', payload(1)),
    D('imp-bravo', payload(2)),
    D('imp-waiting', payload(3)),
    D('imp-done', payload(4)),
    D('imp-skip', payload(5)),
    D('imp-conflict', payload(6))
  ];
  const { report } = await run(rows, docs, backend);

  assert.equal(report.status, 'ok');
  assert.equal(report.totals.imported, 2);
  assert.deepEqual(Object.keys(report.updates).sort(), ['imp-alpha', 'imp-bravo']);
  for (const v of Object.values(report.updates)) assert.equal(v, 'data_imported');

  assert.equal(byUid(report, 'imp-waiting')[0].outcome, 'awaiting-provisioning');
  assert.equal(byUid(report, 'imp-done')[0].outcome, 'skipped-already-imported');
  assert.equal(byUid(report, 'imp-skip')[0].outcome, 'excluded-by-status');
  assert.equal(byUid(report, 'imp-conflict')[0].outcome, 'excluded-by-status');
  assert.match(byUid(report, 'imp-conflict')[0].detail, /E7/);

  assert.equal(backend.state.rows.size, 2, 'only provisioned users received rows');
  const alphaPin = pinForUid('imp-alpha');
  const stored = backend.state.rows.get(alphaPin);
  assert.equal(stored.user_id, alphaPin, 'user_id is the deterministic pin, never an email');
  assert.deepEqual(Object.keys(stored).sort(), ['payload', 'revision', 'schema_version', 'updated_at', 'user_id']);
  assert.equal(stored.schema_version, 1);
  assert.equal(stored.revision, 0);
  assert.equal(stored.updated_at, new Date(SAVED_AT).toISOString(), 'updated_at = export savedAt (plan §4.1)');
  assert.equal(JSON.stringify(stored.payload), JSON.stringify(payload(1)), 'payload written byte-for-byte');

  assert.equal(backend.calls.every(c => c.method === 'POST'), true, 'no DELETE/GET ever issued');
  assert.equal(backend.calls.every(c => c.href.startsWith('/rest/v1/')), true, 'relative transport paths only — no host, no live URL');
});

test('payload with unknown legacy and odd keys round-trips verbatim through the write', async () => {
  const { pinForUid } = await mods();
  const backend = fakeData({ users: [pinForUid('proto-uid')] });
  const weird = {
    ...payload(9),
    __proto__: { injected: true }, // own-key via object literal is a setter — build via JSON instead
  };
  // Build the exact JSON we expect to survive, including an own __proto__ key.
  const source = JSON.parse('{"cats":[],"futureOnly":{"deep":[1,2,3]},"__proto__":{"injected":true},"constructor":"kept","savedAt":42}');
  const docs = [D('proto-uid', source)];
  const rows = [R('proto-uid', pinForUid, 'provisioned')];
  const { report } = await run(rows, docs, backend);

  assert.equal(report.status, 'ok', JSON.stringify(report.notes));
  assert.equal(byUid(report, 'proto-uid')[0].outcome, 'imported');
  const stored = backend.state.rows.get(pinForUid('proto-uid'));
  assert.equal(JSON.stringify(stored.payload), JSON.stringify(source), 'every key — including own __proto__ — survives verbatim');
  assert.equal(JSON.parse(JSON.stringify(stored.payload)).futureOnly.deep.length, 3);
  void weird;
});

test('semantically equal reordered representation is accepted (canonical JSON check)', async () => {
  const { pinForUid } = await mods();
  const backend = fakeData({ users: [pinForUid('reorder-uid')], reorder: true });
  const { report } = await run([R('reorder-uid', pinForUid, 'provisioned')], [D('reorder-uid', payload(7))], backend);
  assert.equal(report.status, 'ok');
  assert.equal(byUid(report, 'reorder-uid')[0].outcome, 'imported');
});

test('a mutated representation halts the run and is never counted as written', async () => {
  const { pinForUid } = await mods();
  const backend = fakeData({ users: [pinForUid('mutate-uid')], mutate: true });
  const { report } = await run([R('mutate-uid', pinForUid, 'provisioned')], [D('mutate-uid', payload(8))], backend);
  assert.equal(report.status, 'halted');
  assert.equal(report.halted.reason, 'payload-mutation');
  assert.equal(byUid(report, 'mutate-uid')[0].outcome, 'failed');
  assert.ok(!('mutate-uid' in report.updates), 'no status advance on mutation');
  assert.ok(report.notes.some(n => /payload mutation/.test(n)));
});

// ── Validation before any write ────────────────────────────────────────────

test('all export problems are reported together before any write', async () => {
  const { pinForUid, sha256Hex } = await mods();
  const backend = fakeData({ users: [] });
  const good = D('valid-uid', payload(1));
  const docs = [
    good,
    { uid: 'bad-sha', savedAt: SAVED_AT, sha256: 'f'.repeat(64), data: payload(2) },          // checksum mismatch
    { uid: 'no-sha', savedAt: SAVED_AT, data: payload(3) },                                    // missing sha256
    { uid: 'no-savedat', sha256: sha256Hex(JSON.stringify(payload(4))), data: payload(4) },     // missing savedAt
    { uid: 'bad-savedat', savedAt: 'soon', sha256: sha256Hex(JSON.stringify(payload(5))), data: payload(5) },
    { uid: 'array-data', savedAt: SAVED_AT, sha256: sha256Hex(JSON.stringify([1])), data: [1] }, // payload not an object
    { uid: 'extra-field', savedAt: SAVED_AT, sha256: sha256Hex(JSON.stringify(payload(6))), data: payload(6), note: 'x' },
    { uid: 'valid-uid', savedAt: SAVED_AT, sha256: sha256Hex(JSON.stringify(payload(7))), data: payload(7) } // duplicate uid
  ];
  await assert.rejects(() => run([R('valid-uid', pinForUid, 'provisioned')], docs, backend), err => {
    for (const frag of ['sha256 mismatch', 'missing or malformed sha256', 'savedAt must be a finite', 'missing savedAt', 'data must be a JSON object', 'unknown field "note"', 'duplicate export uid "valid-uid"']) {
      assert.ok(err.errors.some(e => e.includes(frag)), 'reports: ' + frag);
    }
    return true;
  });
  assert.equal(backend.calls.length, 0, 'validation precedes every simulated write');
});

test('set mismatches refuse the run: unmapped document and provisioned-without-document', async () => {
  const { pinForUid, sha256Hex } = await mods();
  const backend = fakeData({ users: [] });
  const docsA = [{ uid: 'ghost-uid', savedAt: SAVED_AT, sha256: sha256Hex(JSON.stringify(payload(1))), data: payload(1) }];
  await assert.rejects(() => run([R('has-row', pinForUid, 'planned')], docsA, backend), /has no manifest row/);

  const docsB = [D('has-doc-uid', payload(2))];
  await assert.rejects(
    () => run([R('need-doc-uid', pinForUid, 'provisioned'), R('has-doc-uid', pinForUid, 'planned')], docsB, backend),
    /count-identity/
  );
  assert.equal(backend.calls.length, 0);
});

test('missing and malformed inputs are refused with labeled errors', async () => {
  const { runImport, parseExportDocs, parseManifestText, pinForUid, sha256Hex } = await mods();
  const backend = fakeData({ users: [] });
  const goodRows = [R('m-uid', pinForUid, 'provisioned')];
  const goodDocs = [{ uid: 'm-uid', savedAt: SAVED_AT, sha256: sha256Hex(JSON.stringify(payload(1))), data: payload(1) }];

  await assert.rejects(() => runImport({ rows: goodRows, docs: [], call: backend.call }), /export contains no documents/);
  await assert.rejects(() => runImport({ rows: [], docs: goodDocs, call: backend.call }), /manifest contains no rows/);
  assert.throws(() => parseExportDocs('not json at all'), /line 1: invalid JSON/);
  assert.throws(() => parseManifestText('not json at all'), /line 1: invalid JSON/);
  await assert.rejects(() => runImport({ rows: 'nope', docs: goodDocs, call: backend.call }), /manifest contains no rows/);
  assert.equal(backend.calls.length, 0);
});

test('duplicate identities in manifest or export refuse before any write', async () => {
  const { runImport, pinForUid, sha256Hex } = await mods();
  const backend = fakeData({ users: [] });
  const docs = [{ uid: 'dup-uid', savedAt: SAVED_AT, sha256: sha256Hex(JSON.stringify(payload(1))), data: payload(1) }];

  await assert.rejects(() => runImport({
    rows: [R('dup-uid', pinForUid, 'provisioned'), R('dup-uid', pinForUid, 'provisioned', { email: 'other@example.test' })],
    docs, call: backend.call
  }), /duplicate firebase_uid/);

  await assert.rejects(() => runImport({
    rows: [R('dup-uid', pinForUid, 'provisioned')],
    docs: [...docs, { uid: 'dup-uid', savedAt: SAVED_AT, sha256: sha256Hex(JSON.stringify(payload(2))), data: payload(2) }],
    call: backend.call
  }), /duplicate export uid/);

  assert.equal(backend.calls.length, 0);
});

// ── Failures, retries, partial states ──────────────────────────────────────

test('foreign-key violation from the backend halts safely with status unchanged', async () => {
  const { pinForUid } = await mods();
  const backend = fakeData({ users: [] }); // status says provisioned, but auth user is missing
  const rows = [R('fk-first', pinForUid, 'provisioned'), R('fk-second', pinForUid, 'provisioned')];
  const docs = [D('fk-first', payload(1)), D('fk-second', payload(2))];
  const { report } = await run(rows, docs, backend);

  assert.equal(report.status, 'halted');
  assert.equal(report.halted.reason, 'fk-violation');
  assert.equal(byUid(report, 'fk-first')[0].outcome, 'failed');
  assert.ok(!('fk-first' in report.updates), 'stays provisioned for a safe rerun after provisioning');
  assert.equal(byUid(report, 'fk-second')[0].outcome, 'not-run');
  assert.equal(backend.state.rows.size, 0);
});

test('retries a transient 429 with backoff, then imports', async () => {
  const { pinForUid } = await mods();
  const backend = fakeData({ users: [pinForUid('r429')], failFirst: 1, failStatus: 429 });
  const { report, delays } = await run([R('r429', pinForUid, 'provisioned')], [D('r429', payload(1))], backend);
  assert.equal(report.status, 'ok');
  const r = byUid(report, 'r429')[0];
  assert.equal(r.outcome, 'imported');
  assert.equal(r.attempts, 2);
  assert.deepEqual(delays, [5]);
  assert.equal(backend.state.rows.size, 1);
});

test('exhausted retries halt safely: row stays provisioned, exponential backoff, nothing else runs', async () => {
  const { pinForUid } = await mods();
  const backend = fakeData({
    users: [pinForUid('boom-first'), pinForUid('boom-second')],
    postLogic: () => ({ status: 500, ok: false, data: { message: 'boom' } })
  });
  const rows = [R('boom-first', pinForUid, 'provisioned'), R('boom-second', pinForUid, 'provisioned')];
  const docs = [D('boom-first', payload(1)), D('boom-second', payload(2))];
  const { report, delays } = await run(rows, docs, backend, { maxAttempts: 3 });

  assert.equal(report.status, 'halted');
  assert.equal(report.halted.reason, 'transient-failures-exhausted');
  const failed = byUid(report, 'boom-first')[0];
  assert.equal(failed.outcome, 'failed');
  assert.equal(failed.attempts, 3);
  assert.ok(!('boom-first' in report.updates));
  assert.equal(byUid(report, 'boom-second')[0].outcome, 'not-run');
  assert.deepEqual(delays, [5, 10]);
  assert.equal(backend.counts().posts, 3, 'no calls after exhaustion');
});

test('partial failure: middle row fails after the first imported; later rows never run', async () => {
  const { pinForUid } = await mods();
  const backend = fakeData({
    users: ['pf-a', 'pf-b', 'pf-c'].map(u => pinForUid(u)),
    postLogic: (n, body, state) => {
      if (body.user_id === pinForUid('pf-b')) return { status: 500, ok: false, data: { message: 'boom' } };
      if (!state.authUsers.has(body.user_id)) return { status: 409, ok: false, data: { code: '23503' } };
      state.rows.set(body.user_id, JSON.parse(JSON.stringify(body)));
      return { status: 201, ok: true, data: [{ ...body }] };
    }
  });
  const rows = ['pf-a', 'pf-b', 'pf-c'].map(u => R(u, pinForUid, 'provisioned'));
  const docs = ['pf-a', 'pf-b', 'pf-c'].map((u, i) => D(u, payload(i + 1)));
  const { report } = await run(rows, docs, backend);

  assert.equal(report.status, 'halted');
  assert.equal(byUid(report, 'pf-a')[0].outcome, 'imported');
  assert.equal(report.updates['pf-a'], 'data_imported');
  assert.equal(byUid(report, 'pf-b')[0].outcome, 'failed');
  assert.ok(!('pf-b' in report.updates));
  assert.equal(byUid(report, 'pf-c')[0].outcome, 'not-run');
  assert.equal(backend.state.rows.size, 1, 'only pf-a persisted — rerun resumes cleanly');
});

// ── Idempotent reruns ──────────────────────────────────────────────────────

test('rerun with updated statuses writes nothing', async () => {
  const { pinForUid, applyStatusUpdates } = await mods();
  const backend = fakeData({ users: [pinForUid('idem-a'), pinForUid('idem-b')] });
  const rows = [R('idem-a', pinForUid, 'provisioned'), R('idem-b', pinForUid, 'planned')];
  const docs = [D('idem-a', payload(1)), D('idem-b', payload(2))];

  const first = await run(rows, docs, backend);
  assert.equal(first.report.status, 'ok');
  assert.equal(first.report.totals.imported, 1);
  const after = backend.calls.length;

  const updated = applyStatusUpdates(rows, first.report.updates);
  const second = await run(updated, docs, backend);
  assert.equal(second.report.status, 'ok');
  assert.equal(second.report.totals.alreadyImported, 1);
  assert.equal(second.report.totals.awaitingProvisioning, 1);
  assert.deepEqual(second.report.updates, {});
  assert.equal(backend.calls.length, after, 'zero additional writes on rerun');
});

// ── Redaction + anti-live guarantees ───────────────────────────────────────

test('reports never contain payload contents or raw emails', async () => {
  const { pinForUid } = await mods();
  const backend = fakeData({ users: [pinForUid('secret-uid')] });
  const marker = 'TOPSECRET_PAYLOAD_MARKER_9f3a';
  const data = { ...payload(1), note: marker };
  const rows = [R('secret-uid', pinForUid, 'provisioned')];
  const { report } = await run(rows, [D('secret-uid', data)], backend);

  assert.equal(report.status, 'ok');
  const s = JSON.stringify(report);
  assert.ok(!s.includes(marker), 'payload contents never appear in the report');
  assert.ok(!s.includes('secret-uid@example.test'), 'raw email never appears in the report');
  assert.ok(s.includes('s***@example.test'), 'masked email present');
  assert.ok(!s.includes('"payload"'), 'no payload field is ever embedded');
});

test('module source contains no network primitives; runImport requires injected call', async () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  for (const banned of ["fetch(", 'node:http', 'node:https', 'node:net', 'XMLHttpRequest', 'WebSocket', 'https://', "'DELETE'", '"DELETE"', 'supabase.co', 'service_role']) {
    assert.ok(!src.includes(banned), 'source must not contain: ' + banned);
  }
  const { runImport } = await mods();
  await assert.rejects(() => runImport({ rows: [], docs: [] }), /injected call/);
  await assert.rejects(() => runImport({ rows: [], docs: [], call: async () => {}, maxAttempts: 0 }), /maxAttempts/);
});

test('canonicalJson: key order irrelevant, array order and primitives matter', async () => {
  const { canonicalJson } = await mods();
  assert.equal(canonicalJson({ a: 1, b: [1, 2] }), canonicalJson({ b: [1, 2], a: 1 }));
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
  assert.equal(canonicalJson(null), 'null');
  assert.equal(canonicalJson('x'), '"x"');
  assert.notEqual(canonicalJson({ a: '1' }), canonicalJson({ a: 1 }));
});

test('planImport classifies every status and carries checksums without payload', async () => {
  const { prepareImport, planImport, pinForUid } = await mods();
  const rows = [
    R('pl-import', pinForUid, 'provisioned'),
    R('pl-wait', pinForUid, 'planned'),
    R('pl-done', pinForUid, 'verified'),
    R('pl-skip', pinForUid, 'skipped'),
    R('pl-conflict', pinForUid, 'conflict')
  ];
  const docs = ['pl-import', 'pl-wait', 'pl-done', 'pl-conflict'].map((u, i) => D(u, payload(i)));
  const prepared = prepareImport({ rows, docs });
  const { entries, summary } = planImport(prepared.manifest, prepared.docs);
  assert.equal(entries.find(e => e.firebase_uid === 'pl-import').action, 'import');
  assert.equal(entries.find(e => e.firebase_uid === 'pl-wait').action, 'await-provisioning');
  assert.equal(entries.find(e => e.firebase_uid === 'pl-done').action, 'skip(already-imported)');
  assert.equal(entries.find(e => e.firebase_uid === 'pl-skip').action, 'exclude(skipped)');
  assert.equal(entries.find(e => e.firebase_uid === 'pl-conflict').action, 'exclude(conflict)');
  assert.deepEqual(summary, {
    total: 5, documents: 4, import: 1, 'await-provisioning': 1, 'skip(already-imported)': 1, excluded: 2
  });
  assert.match(entries[0].sha256, /^[0-9a-f]{64}$/);
  const s = JSON.stringify(entries);
  assert.ok(!s.includes('cats'), 'plan never contains payload contents');
});

// ── CLI guards (subprocess, offline) ───────────────────────────────────────

test('CLI --dry-run: validates both files, prints a masked plan, leaks nothing, touches nothing', async () => {
  const { formatManifest, pinForUid, sha256Hex } = await mods();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifts-imp-'));
  const manifestPath = path.join(dir, 'manifest.jsonl');
  const exportPath = path.join(dir, 'export.jsonl');
  const rows = [R('cli-imp', pinForUid, 'provisioned'), R('cli-wait', pinForUid, 'planned')];
  const data = { futureField: { marker: 'PAYLOAD_MARKER_CLI' }, cats: [] };
  const exportText = [
    JSON.stringify({ uid: 'cli-imp', savedAt: SAVED_AT, sha256: sha256Hex(JSON.stringify(data)), data }),
    JSON.stringify({ uid: 'cli-wait', savedAt: SAVED_AT, sha256: sha256Hex(JSON.stringify(data)), data })
  ].join('\n') + '\n';
  fs.writeFileSync(manifestPath, formatManifest(rows), 'utf8');
  fs.writeFileSync(exportPath, exportText, 'utf8');
  const before = [fs.readFileSync(manifestPath), fs.readFileSync(exportPath)];

  const res = spawnSync(process.execPath, [SCRIPT, '--dry-run', manifestPath, exportPath], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /DRY RUN/);
  assert.match(res.stdout, /import\s+cli-imp/);
  assert.match(res.stdout, /await-provisioning\s+cli-wait/);
  assert.ok(!res.stdout.includes('cli-imp@example.test'), 'raw email never printed');
  assert.match(res.stdout, /c\*\*\*@example\.test/);
  assert.ok(!res.stdout.includes('PAYLOAD_MARKER_CLI'), 'payload contents never printed');
  assert.ok(!res.stdout.includes(sha256Hex(JSON.stringify(data))), 'full checksum never printed (prefix only)');
  assert.match(res.stdout, /payload contents are never printed/);

  assert.deepEqual(fs.readFileSync(manifestPath), before[0], 'manifest file untouched');
  assert.deepEqual(fs.readFileSync(exportPath), before[1], 'export file untouched');
});

test('CLI exit codes: offline refusal (2), validation failure (1), usage (2), help (0)', async () => {
  const { formatManifest, pinForUid, sha256Hex } = await mods();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifts-imp-'));
  const goodMan = path.join(dir, 'm.jsonl');
  const goodExp = path.join(dir, 'e.jsonl');
  const badExp = path.join(dir, 'bad.jsonl');
  const data = { cats: [] };
  fs.writeFileSync(goodMan, formatManifest([R('cli-ok', pinForUid, 'provisioned')]), 'utf8');
  fs.writeFileSync(goodExp, JSON.stringify({ uid: 'cli-ok', savedAt: SAVED_AT, sha256: sha256Hex(JSON.stringify(data)), data }) + '\n', 'utf8');
  fs.writeFileSync(badExp, 'garbage line\n', 'utf8');

  const noArgs = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(noArgs.status, 2);

  const oneArg = spawnSync(process.execPath, [SCRIPT, goodMan], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(oneArg.status, 2, 'exactly two inputs required');

  const live = spawnSync(process.execPath, [SCRIPT, goodMan, goodExp], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(live.status, 2, 'live runs refused in this offline build');
  assert.match(live.stderr, /offline-only/);

  const invalid = spawnSync(process.execPath, [SCRIPT, '--dry-run', goodMan, badExp], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(invalid.status, 1, 'validation failure');
  assert.match(invalid.stderr, /line 1: invalid JSON/);

  const missing = spawnSync(process.execPath, [SCRIPT, '--dry-run', goodMan, path.join(dir, 'nope.jsonl')], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(missing.status, 2);

  const help = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /import-user-data\.mjs/);
});
