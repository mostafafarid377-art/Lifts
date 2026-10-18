// Offline tests for scripts/migration/validate-migration.mjs (Phase 3c O4) —
// the four-way migration validation gate. Everything runs against an in-memory
// fake read-only backend: no network, no credentials, no SQL, no real data.
// Covers: all-green reconciliation, every individual mismatch category,
// missing/duplicate/conflicting/orphaned records, altered payloads (canonical
// JSON + key sets), identity-pin conflicts, incomplete input and incomplete
// state, count identity, report redaction, documented ambiguities, source
// isolation, and determinism of repeated runs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'migration', 'validate-migration.mjs');

let modsPromise = null;
function mods() {
  if (!modsPromise) {
    modsPromise = (async () => {
      const gate = await import(pathToFileURL(SCRIPT).href);
      const man = await import(pathToFileURL(path.join(ROOT, 'scripts', 'migration', 'build-manifest.mjs')).href);
      return { ...gate, pinForUid: man.pinForUid, sha256Hex: man.sha256Hex };
    })();
  }
  return modsPromise;
}

const SAVED_AT = 1760000000000;
const ISO_SAVED = new Date(SAVED_AT).toISOString();

function makeRow(pinForUid, uid, status, over = {}) {
  return {
    firebase_uid: uid,
    supabase_uuid: pinForUid(uid),
    email: uid.replace(/[^a-z0-9]+/g, '-') + '@example.test',
    provider_hint: 'password',
    status,
    ...over
  };
}

function payloadFor(seed) {
  return {
    cats: [{ id: 'push', label: 'Push', color: '#ff5c35' }],
    ex: { push: ['Bench Press'] },
    data: { 'Bench Press': [{ date: '2026-10-01', sets: [{ weight: 40 + seed, reps: 5, unit: 'kg' }] }] },
    savedAt: SAVED_AT + seed
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

function deepReorder(v) {
  if (Array.isArray(v)) return v.map(deepReorder);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).reverse()) out[k] = deepReorder(v[k]);
    return out;
  }
  return v;
}

function fakeBackend({ map = [], auth = [], data = [] } = {}) {
  const reads = [];
  return {
    reads,
    listMapRows: async () => { reads.push('map'); return map; },
    listAuthUsers: async () => { reads.push('auth'); return auth; },
    listUserData: async () => { reads.push('data'); return data; }
  };
}

async function greenParts() {
  const { pinForUid } = await mods();
  const rows = [
    makeRow(pinForUid, 'alice', 'data_imported'),
    makeRow(pinForUid, 'bob', 'verified'),
    makeRow(pinForUid, 'carol', 'skipped')
  ];
  const docs = [
    D('alice', payloadFor(1)),
    D('bob', payloadFor(2)),
    D('carol', payloadFor(3)) // skipped users may still have export docs — ignored by the gate
  ];
  const map = rows.filter(r => r.status !== 'skipped').map(r => ({
    firebase_uid: r.firebase_uid, supabase_uuid: r.supabase_uuid, email: r.email, provider_hint: r.provider_hint, status: r.status
  }));
  const auth = rows.filter(r => r.status !== 'skipped').map(r => ({
    id: r.supabase_uuid, email: r.email, app_metadata: { firebase_uid: r.firebase_uid }
  }));
  const data = rows.filter(r => r.status !== 'skipped').map(r => {
    const doc = docs.find(d => d.uid === r.firebase_uid);
    return {
      user_id: r.supabase_uuid,
      payload: deepReorder(doc.data), // simulated JSONB key-order normalization
      schema_version: 1,
      revision: 0,
      updated_at: ISO_SAVED
    };
  });
  return { rows, docs, map, auth, data, pinForUid };
}

async function gate(parts, backend) {
  const { runValidation } = await mods();
  return runValidation({
    rows: parts.rows,
    docs: parts.docs,
    backend: backend || fakeBackend({ map: parts.map, auth: parts.auth, data: parts.data })
  });
}

const cats = rep => rep.errors.map(e => e.category).sort();

// ── All-green ──────────────────────────────────────────────────────────────

test('all-green four-way reconciliation passes with reordered read-back payloads', async () => {
  const parts = await greenParts();
  const backend = fakeBackend({ map: parts.map, auth: parts.auth, data: parts.data });
  const rep = await gate(parts, backend);

  assert.equal(rep.status, 'pass');
  assert.deepEqual(rep.errors, []);
  assert.deepEqual(rep.flags, []);
  assert.deepEqual(backend.reads, ['map', 'auth', 'data'], 'exactly the three read-only list reads');
  assert.deepEqual(rep.countIdentity, { map: true, auth: true, data: true, docsForImported: true });
  assert.equal(rep.counts.manifestTotal, 3);
  assert.equal(rep.counts.skipped, 1);
  assert.equal(rep.counts.pending, 0);
  assert.equal(rep.counts.conflict, 0);
  assert.equal(rep.payloadChecks.length, 2, 'checksums recorded for imported rows');
  for (const pc of rep.payloadChecks) {
    assert.equal(pc.semanticMatch, true, 'canonical payload checksums match despite JSONB-style key reordering');
    assert.match(pc.exportSha256, /^[0-9a-f]{64}$/);
    assert.equal(pc.readBackSemanticSha, pc.exportSemanticSha);
  }
  assert.match(rep.targetState, /data_imported\/verified/);
});

test('advisory drifts (email, provider, updated_at, revision) are flags, never errors', async () => {
  const parts = await greenParts();
  parts.map[0].email = 'alice-changed@example.test';
  parts.map[0].provider_hint = 'google.com';
  parts.auth[0].email = 'alice-other@example.test';
  parts.data[0].updated_at = '2026-01-01T00:00:00.000Z';
  parts.data[0].revision = 3;
  const rep = await gate(parts);

  assert.equal(rep.status, 'pass', 'documented advisory checks never flip the gate');
  assert.deepEqual(rep.errors, []);
  const flagCats = rep.flags.map(f => f.category).sort();
  assert.deepEqual(flagCats, ['EMAIL_DRIFT', 'EMAIL_DRIFT', 'PROVIDER_DRIFT', 'REVISION_ADVANCED', 'UPDATED_AT_DRIFT']);
  const s = JSON.stringify(rep);
  assert.ok(!s.includes('alice-changed@example.test') && !s.includes('alice-other@example.test'), 'flagged emails never printed');
});

// ── Mapping table mismatches ───────────────────────────────────────────────

test('MAP_MISSING: manifest row without firebase_uid_map row', async () => {
  const parts = await greenParts();
  parts.map = parts.map.filter(m => m.firebase_uid !== 'alice');
  const rep = await gate(parts);
  assert.equal(rep.status, 'fail');
  assert.deepEqual(cats(rep), ['MAP_MISSING']);
  assert.equal(rep.errors[0].firebase_uid, 'alice');
  assert.equal(rep.countIdentity.map, false);
});

test('MAP_ORPHAN: firebase_uid_map row with no manifest entry', async () => {
  const parts = await greenParts();
  const { pinForUid } = await mods();
  parts.map.push({ firebase_uid: 'ghost-uid', supabase_uuid: pinForUid('ghost-uid'), email: 'ghost@example.test', provider_hint: 'password', status: 'provisioned' });
  const rep = await gate(parts);
  assert.equal(rep.status, 'fail');
  assert.deepEqual(cats(rep), ['MAP_ORPHAN']);
  assert.equal(rep.errors[0].firebase_uid, 'ghost-uid');
});

test('MAP_PIN_MISMATCH: map supabase_uuid differs from the manifest pin', async () => {
  const parts = await greenParts();
  parts.map[0].supabase_uuid = parts.pinForUid('someone-else');
  const rep = await gate(parts);
  assert.equal(rep.status, 'fail');
  assert.deepEqual(cats(rep), ['MAP_PIN_MISMATCH']);
  assert.equal(rep.errors[0].firebase_uid, 'alice');
  assert.equal(rep.errors[0].found, parts.pinForUid('someone-else'));
  assert.equal(rep.errors[0].supabase_uuid, parts.pinForUid('alice'));
});

test('MAP_STATUS_MISMATCH: map status diverges from manifest status', async () => {
  const parts = await greenParts();
  parts.map[0].status = 'planned';
  const rep = await gate(parts);
  assert.equal(rep.status, 'fail');
  assert.deepEqual(cats(rep), ['MAP_STATUS_MISMATCH']);
});

test('DUPLICATE_MAP_ROW: repeated firebase_uid or repeated supabase_uuid', async () => {
  const parts = await greenParts();
  parts.map.push({ ...parts.map[0] });
  const rep = await gate(parts);
  assert.equal(rep.status, 'fail');
  // one duplicated row violates both the firebase_uid and the supabase_uuid uniqueness
  assert.deepEqual(cats(rep), ['DUPLICATE_MAP_ROW', 'DUPLICATE_MAP_ROW']);
  assert.ok(rep.errors.some(e => /2 times/.test(e.detail)), 'uid duplication reported');
  assert.ok(rep.errors.some(e => /more than one firebase_uid_map row/.test(e.detail)), 'pin duplication reported');

  const parts2 = await greenParts();
  const { pinForUid } = await mods();
  parts2.map[1].supabase_uuid = pinForUid('alice'); // same pin under a different uid
  const rep2 = await gate(parts2);
  assert.equal(rep2.status, 'fail');
  assert.deepEqual(cats(rep2), ['DUPLICATE_MAP_ROW', 'MAP_PIN_MISMATCH']);
  assert.ok(rep2.errors.some(e => /more than one firebase_uid_map row/.test(e.detail)));
});

// ── Auth identity mismatches ───────────────────────────────────────────────

test('AUTH_MISSING: expected auth user absent for its pin', async () => {
  const parts = await greenParts();
  parts.auth = parts.auth.filter(a => a.app_metadata.firebase_uid !== 'bob');
  const rep = await gate(parts);
  assert.equal(rep.status, 'fail');
  assert.deepEqual(cats(rep), ['AUTH_MISSING']);
  assert.equal(rep.errors[0].firebase_uid, 'bob');
  assert.equal(rep.countIdentity.auth, false);
});

test('AUTH_ORPHAN: auth user id matching no manifest pin', async () => {
  const parts = await greenParts();
  const { pinForUid } = await mods();
  parts.auth.push({ id: pinForUid('stranger'), app_metadata: { firebase_uid: 'stranger' } });
  const rep = await gate(parts);
  assert.equal(rep.status, 'fail');
  assert.deepEqual(cats(rep), ['AUTH_ORPHAN']);
  assert.equal(rep.errors[0].supabase_uuid, pinForUid('stranger'));
});

test('AUTH_CLAIM_MISSING: auth user for an expected pin without firebase_uid claim', async () => {
  const parts = await greenParts();
  parts.auth[0].app_metadata = {};
  const rep = await gate(parts);
  assert.equal(rep.status, 'fail');
  assert.deepEqual(cats(rep), ['AUTH_CLAIM_MISSING']);
  assert.equal(rep.errors[0].firebase_uid, 'alice');
});

test('AUTH_CLAIM_MISMATCH: firebase_uid claim belongs to a different identity (pin conflict)', async () => {
  const parts = await greenParts();
  parts.auth[0].app_metadata = { firebase_uid: 'mallory' }; // no manifest identity
  const rep = await gate(parts);
  assert.equal(rep.status, 'fail');
  assert.deepEqual(cats(rep), ['AUTH_CLAIM_MISMATCH']);
  const e = rep.errors[0];
  assert.equal(e.firebase_uid, 'alice');
  assert.equal(e.claim, 'mallory');
  assert.equal(e.claim_manifest_pin, null);

  const parts2 = await greenParts();
  parts2.auth[0].app_metadata = { firebase_uid: 'bob' }; // real but foreign manifest identity
  const rep2 = await gate(parts2);
  assert.ok(rep2.errors.some(e => e.category === 'AUTH_CLAIM_MISMATCH' && e.claim === 'bob' && e.claim_manifest_pin === parts2.pinForUid('bob')));
});

test('DUPLICATE_AUTH_CLAIM: one firebase_uid claimed by two auth users', async () => {
  const parts = await greenParts();
  parts.auth[1].app_metadata = { firebase_uid: 'alice' }; // bob-pin now also claims alice
  const rep = await gate(parts);
  assert.equal(rep.status, 'fail');
  const c = cats(rep);
  assert.ok(c.includes('DUPLICATE_AUTH_CLAIM'), 'duplicate claim detected');
  assert.ok(c.includes('AUTH_CLAIM_MISMATCH'), 'the wrong claim on bob-pin is also reported');
  assert.ok(rep.errors.some(e => e.category === 'DUPLICATE_AUTH_CLAIM' && e.detail.includes('2 auth users')));
});

// ── user_data mismatches ───────────────────────────────────────────────────

test('DATA_MISSING: imported manifest row without user_data row', async () => {
  const parts = await greenParts();
  parts.data = parts.data.filter(r => r.user_id !== parts.pinForUid('alice'));
  const rep = await gate(parts);
  assert.equal(rep.status, 'fail');
  assert.deepEqual(cats(rep), ['DATA_MISSING']);
  assert.equal(rep.countIdentity.data, false);
});

test('DATA_ORPHAN: user_data row matching no manifest pin', async () => {
  const parts = await greenParts();
  parts.data.push({ user_id: parts.pinForUid('ghost'), payload: {}, schema_version: 1, revision: 0, updated_at: ISO_SAVED });
  const rep = await gate(parts);
  assert.equal(rep.status, 'fail');
  assert.deepEqual(cats(rep), ['DATA_ORPHAN']);
});

test('DUPLICATE_DATA_ROW: repeated user_id in user_data', async () => {
  const parts = await greenParts();
  parts.data.push({ ...parts.data[0] });
  const rep = await gate(parts);
  assert.equal(rep.status, 'fail');
  assert.deepEqual(cats(rep), ['DUPLICATE_DATA_ROW']);
  assert.match(rep.errors[0].detail, /2 times/);
});

test('DATA_EXCLUDED_ROW / AUTH_EXCLUDED_ROW / MAP_UNEXPECTED: skipped row leaked into live sources', async () => {
  const parts = await greenParts();
  const carol = parts.rows.find(r => r.firebase_uid === 'carol');
  parts.map.push({ firebase_uid: carol.firebase_uid, supabase_uuid: carol.supabase_uuid, email: carol.email, provider_hint: carol.provider_hint, status: 'skipped' });
  parts.auth.push({ id: carol.supabase_uuid, email: carol.email, app_metadata: { firebase_uid: 'carol' } });
  parts.data.push({ user_id: carol.supabase_uuid, payload: payloadFor(3), schema_version: 1, revision: 0, updated_at: ISO_SAVED });
  const rep = await gate(parts);
  assert.equal(rep.status, 'fail');
  assert.deepEqual(cats(rep), ['AUTH_EXCLUDED_ROW', 'DATA_EXCLUDED_ROW', 'MAP_UNEXPECTED']);
  assert.match(rep.errors.find(e => e.category === 'MAP_UNEXPECTED').detail, /skipped/);
});

// ── Payload integrity ──────────────────────────────────────────────────────

test('PAYLOAD_DIFFER: value altered under identical key set — reported without values', async () => {
  const parts = await greenParts();
  const marker = 'TOPSECRET_VALUE_9f3a';
  const row = parts.data.find(r => r.user_id === parts.pinForUid('alice'));
  row.payload = JSON.parse(JSON.stringify(parts.docs[0].data));
  row.payload.data['Bench Press'][0].sets[0].weight = marker;
  const rep = await gate(parts);

  assert.equal(rep.status, 'fail');
  assert.deepEqual(cats(rep), ['PAYLOAD_DIFFER']);
  const e = rep.errors[0];
  assert.equal(e.firebase_uid, 'alice');
  assert.match(e.detail, /differing keys: \[data\]/);
  assert.match(e.detail, /values never printed/);
  const check = rep.payloadChecks.find(pc => pc.firebase_uid === 'alice');
  assert.equal(check.semanticMatch, false);
  const s = JSON.stringify(rep);
  assert.ok(!s.includes(marker), 'payload values never appear in the report');
});

test('PAYLOAD_KEYSET: added or missing top-level key is reported by name only', async () => {
  const parts = await greenParts();
  const hidden = 'HIDDEN_VALUE_77';
  const row = parts.data.find(r => r.user_id === parts.pinForUid('alice'));
  row.payload = deepReorder(parts.docs[0].data);
  row.payload['smuggled_field'] = hidden;
  const rep = await gate(parts);

  assert.equal(rep.status, 'fail');
  assert.deepEqual(cats(rep), ['PAYLOAD_KEYSET']);
  assert.match(rep.errors[0].detail, /added in read-back: \[smuggled_field\]/);
  const s = JSON.stringify(rep);
  assert.ok(!s.includes(hidden), 'payload values never appear');

  const parts2 = await greenParts();
  delete parts2.data.find(r => r.user_id === parts2.pinForUid('alice')).payload.cats;
  const rep2 = await gate(parts2);
  assert.equal(rep2.status, 'fail');
  assert.deepEqual(cats(rep2), ['PAYLOAD_KEYSET']);
  assert.match(rep2.errors[0].detail, /missing from read-back: \[cats\]/);
});

test('DOC_MISSING: imported row without its export document (count identity)', async () => {
  const parts = await greenParts();
  parts.docs = parts.docs.filter(d => d.uid !== 'alice');
  const rep = await gate(parts);
  assert.equal(rep.status, 'fail');
  assert.deepEqual(cats(rep), ['DOC_MISSING']);
  assert.equal(rep.countIdentity.docsForImported, false);
});

test('DOC_ORPHAN: export document with no manifest entry', async () => {
  const parts = await greenParts();
  parts.docs.push(D('phantom', payloadFor(9)));
  const rep = await gate(parts);
  assert.equal(rep.status, 'fail');
  assert.deepEqual(cats(rep), ['DOC_ORPHAN']);
});

test('SCHEMA_VERSION / MALFORMED_ROW: row field contract violations', async () => {
  const parts = await greenParts();
  parts.data[0].schema_version = 2;
  const rep = await gate(parts);
  assert.equal(rep.status, 'fail');
  assert.deepEqual(cats(rep), ['SCHEMA_VERSION']);

  const parts2 = await greenParts();
  parts2.data[0].revision = -1;
  const rep2 = await gate(parts2);
  assert.equal(rep2.status, 'fail');
  assert.deepEqual(cats(rep2), ['MALFORMED_ROW']);
});

// ── Incomplete state / conflicts ───────────────────────────────────────────

test('incomplete state and unresolved conflicts never report a pass', async () => {
  const parts = await greenParts();
  // alice still only provisioned (import not yet complete): drop her data row
  // and keep the map mirror in sync so only the state errors remain.
  parts.rows.find(r => r.firebase_uid === 'alice').status = 'provisioned';
  parts.map.find(m => m.firebase_uid === 'alice').status = 'provisioned';
  parts.data = parts.data.filter(r => r.user_id !== parts.pinForUid('alice'));
  // dave is an unresolved conflict, present in the map per plan wording.
  const dave = makeRow(parts.pinForUid, 'dave', 'conflict');
  parts.rows.push(dave);
  parts.map.push({ firebase_uid: dave.firebase_uid, supabase_uuid: dave.supabase_uuid, email: dave.email, provider_hint: dave.provider_hint, status: 'conflict' });

  const rep = await gate(parts);
  assert.equal(rep.status, 'fail');
  assert.deepEqual(cats(rep), ['INCOMPLETE_STATE', 'UNRESOLVED_CONFLICT']);
  assert.equal(rep.counts.pending, 1);
  assert.equal(rep.counts.conflict, 1);
  assert.equal(rep.counts.flags, 0, 'no advisory noise masks the hard failures');
});

// ── Incomplete / invalid input ─────────────────────────────────────────────

test('invalid local inputs throw before any backend read', async () => {
  const { runValidation, pinForUid } = await mods();
  const parts = await greenParts();
  const backend = fakeBackend({ map: parts.map, auth: parts.auth, data: parts.data });

  const badDocs = parts.docs.map((d, i) => (i === 0 ? { ...d, sha256: 'f'.repeat(64) } : d));
  await assert.rejects(() => runValidation({ rows: parts.rows, docs: badDocs, backend }), /sha256 mismatch/);
  assert.deepEqual(backend.reads, [], 'no backend read happens on invalid input');

  await assert.rejects(() => runValidation({ rows: [{ firebase_uid: 'x' }], docs: parts.docs, backend }), /manifest/);

  await assert.rejects(
    () => runValidation({ rows: parts.rows, docs: parts.docs, backend: fakeBackend({ map: [{ firebase_uid: 'x' }] }) }),
    err => err.name === 'ManifestBuildError' && err.errors.some(e => /supabase_uuid must be a UUID/.test(e)) && err.errors.some(e => /status must be one of/.test(e))
  );
  void pinForUid;
});

test('backend interface is enforced: missing method, bad return, failed read', async () => {
  const { runValidation } = await mods();
  const parts = await greenParts();

  await assert.rejects(() => runValidation({ rows: parts.rows, docs: parts.docs }), /read-only backend/);
  await assert.rejects(() => runValidation({ rows: parts.rows, docs: parts.docs, backend: {} }), /listMapRows/);
  await assert.rejects(
    () => runValidation({ rows: parts.rows, docs: parts.docs, backend: { listMapRows: () => 'nope', listAuthUsers: async () => [], listUserData: async () => [] } }),
    /did not return an array/
  );
  await assert.rejects(
    () => runValidation({
      rows: parts.rows, docs: parts.docs,
      backend: { listMapRows: async () => { throw new Error('boom'); }, listAuthUsers: async () => [], listUserData: async () => [] }
    }),
    /listMapRows read failed: boom/
  );
  await assert.rejects(() => runValidation(), /read-only backend/);
});

// ── Aggregation, redaction, determinism ────────────────────────────────────

test('multiple mismatches are reported together with actionable categories', async () => {
  const parts = await greenParts();
  parts.map = parts.map.filter(m => m.firebase_uid !== 'alice');
  parts.auth = parts.auth.filter(a => a.app_metadata.firebase_uid !== 'bob');
  parts.data.find(r => r.user_id === parts.pinForUid('bob')).payload.savedAt = 1;
  const rep = await gate(parts);

  assert.equal(rep.status, 'fail');
  assert.deepEqual(cats(rep), ['AUTH_MISSING', 'MAP_MISSING', 'PAYLOAD_DIFFER']);
  assert.equal(rep.errors.length, 3, 'one run reports every discrepancy, not just the first');
  assert.ok(rep.errors.every(e => typeof e.detail === 'string' && e.detail.length > 10));
});

test('report redaction: no raw emails, payload values, passwords, or tokens', async () => {
  const parts = await greenParts();
  const marker = 'SECRET_PAYLOAD_TOKEN_31337';
  parts.data.find(r => r.user_id === parts.pinForUid('alice')).payload = { ...payloadFor(1), leaked: marker };
  parts.map.push({ firebase_uid: 'ghost-uid', supabase_uuid: parts.pinForUid('ghost-uid'), email: 'super-private-user@hidden.test', provider_hint: 'password', status: 'planned' });
  const rep = await gate(parts);

  assert.equal(rep.status, 'fail');
  const s = JSON.stringify(rep);
  assert.ok(!s.includes(marker), 'no payload values');
  assert.ok(!s.includes('super-private-user@hidden.test'), 'no raw emails');
  assert.ok(!s.includes('@example.test'), 'no fixture raw emails');
  assert.ok(!/@/.test(s), 'the report never contains an email address at all');
  assert.ok(!/password/i.test(s), 'no password material of any kind');
  assert.ok(!/sb_secret|service_role|Bearer\s/i.test(s), 'no key material');
});

test('repeated runs over the same inputs produce identical reports (deterministic)', async () => {
  const parts = await greenParts();
  parts.map = parts.map.filter(m => m.firebase_uid !== 'alice');
  parts.auth.push({ id: parts.pinForUid('stranger'), app_metadata: { firebase_uid: 'stranger' } });
  const b1 = fakeBackend({ map: parts.map, auth: parts.auth, data: parts.data });
  const b2 = fakeBackend({ map: parts.map, auth: parts.auth, data: parts.data });
  const r1 = await gate(parts, b1);
  const r2 = await gate(parts, b2);
  assert.deepEqual(r1, r2);
  assert.equal(r1.status, 'fail');
});

// ── Documentation + isolation ──────────────────────────────────────────────

test('RECONCILIATION_NOTES documents every resolved ambiguity from the plan', async () => {
  const { RECONCILIATION_NOTES } = await mods();
  assert.ok(Array.isArray(RECONCILIATION_NOTES) && RECONCILIATION_NOTES.length >= 5);
  const all = RECONCILIATION_NOTES.join('\n');
  for (const marker of ['firebase_uid_map writer', 'canonical', 'RLS', 'minus explicit skips', 'Firestore document', 'advisory', 'INCOMPLETE_STATE']) {
    assert.ok(all.includes(marker), 'documented ambiguity marker present: ' + marker);
  }
});

test('module source contains no network primitives or destructive SQL verbs as methods', async () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  for (const banned of ['fetch(', 'node:http', 'node:https', 'node:net', 'XMLHttpRequest', 'WebSocket', 'https://', "'DELETE'", '"DELETE"', 'service_role', 'supabase.co']) {
    assert.ok(!src.includes(banned), 'source must not contain: ' + banned);
  }
});
