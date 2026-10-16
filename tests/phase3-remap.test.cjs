// Offline tests for js/phase3-remap.js (Phase 3c O1) — the identity-gated,
// copy-not-move localStorage remap shim. Everything runs in-process against a
// recording in-memory storage: no network, no credentials, no real data.
// Covers: pin derivation (differential vs build-manifest + RFC vector), the
// §4.2 identity gate (valid and invalid identities, zero storage touch on
// rejection), all seven documented prefixes, destination-conflict policies,
// malformed data, idempotent reruns, and byte-for-byte source preservation.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const MODULE_PATH = path.join(ROOT, 'js', 'phase3-remap.js');

// Same vm loader style as tests/supabase-preparation.test.cjs (repo has no
// package.json, so .js files are treated as CommonJS by bare Node imports).
function loadRemap() {
  const source = fs.readFileSync(MODULE_PATH, 'utf8').replace(/^export\s+/gm, '') + `
    globalThis.__remap = { REMAP_KEY_PREFIXES, PIN_NAMESPACE, uuidv5, expectedSupabaseUuid,
                           evaluateRemapIdentity, remapRecoveryKeys };
  `;
  const context = vm.createContext({ console });
  vm.runInContext(source, context, { filename: 'phase3-remap.js' });
  return context.__remap;
}
const M = loadRemap();
const plain = value => JSON.parse(JSON.stringify(value)); // normalize cross-realm arrays

// Reference pin implementation (node:crypto based) for differential checks.
let manifestPromise = null;
const manifest = () => {
  if (!manifestPromise) {
    manifestPromise = import(pathToFileURL(path.join(ROOT, 'scripts', 'migration', 'build-manifest.mjs')).href);
  }
  return manifestPromise;
};

const UID = 'fixture-remap-alpha-0001';

function memStorage(init = {}) {
  const map = new Map(Object.entries(init));
  const calls = { get: [], set: [], remove: [] };
  return {
    calls,
    getItem(k) { calls.get.push(String(k)); return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { const s = String(v); calls.set.push([String(k), s]); map.set(String(k), s); },
    removeItem(k) { calls.remove.push(String(k)); map.delete(String(k)); },
    snapshot() { return Object.fromEntries(map); },
    raw(k) { return map.get(k); }
  };
}

async function sessionFor(uid = UID) {
  const { pinForUid } = await manifest();
  return { user: { id: pinForUid(uid), app_metadata: { firebase_uid: uid } } };
}

const srcKey = (prefix, uid = UID) => prefix + uid;
async function dstKey(prefix) {
  const { pinForUid } = await manifest();
  return prefix + pinForUid(UID);
}
async function parkKey() {
  const { pinForUid } = await manifest();
  return 'lifts_snapconflict_' + pinForUid(UID);
}

const P = M.REMAP_KEY_PREFIXES;
const SNAP = 'lifts_snap_', SNAPC = 'lifts_snapconflict_', SNAPQ = 'lifts_snapquarantine_',
      QUAR = 'lifts_quarantine_', NOTE = 'lifts_repairnote_', PW = 'lifts_pw_', AW = 'lifts_aw_';

// ── Pin derivation ─────────────────────────────────────────────────────────

test('uuidv5 matches the RFC 4122 worked example', () => {
  assert.equal(
    M.uuidv5('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8'),
    '2ed6657d-e927-568b-95e1-2665a8aea6a2'
  );
  // second vector (python uuid.uuid5(NAMESPACE_DNS, 'python.org'))
  assert.equal(
    M.uuidv5('python.org', '6ba7b810-9dad-11d1-80b4-00c04fd430c8'),
    '886313e1-3b8a-5372-9b90-0c9aee199e5d'
  );
});

test('pins are identical to build-manifest pinForUid (pure-JS SHA-1 differential)', async () => {
  const { pinForUid } = await manifest();
  const uids = [
    '',
    'a',
    'user-123',
    '110000000000000000000',
    UID,
    'with unicode chars: é ✓ 中',
    'x'.repeat(200),
    'UPPER-Case-Uid',
    'trailing space '
  ];
  for (const uid of uids) {
    assert.equal(M.expectedSupabaseUuid(uid), pinForUid(uid), 'pin mismatch for ' + JSON.stringify(uid));
  }
});

test('REMAP_KEY_PREFIXES lists exactly the seven documented recovery keys', () => {
  assert.deepEqual([...P], [
    'lifts_snap_', 'lifts_snapconflict_', 'lifts_snapquarantine_',
    'lifts_quarantine_', 'lifts_repairnote_', 'lifts_pw_', 'lifts_aw_'
  ]);
});

// ── Identity gate (plan §4.2.1) ────────────────────────────────────────────

test('valid identity passes with the session uuid equal to the recomputed pin', async () => {
  const session = await sessionFor();
  const gate = M.evaluateRemapIdentity(session);
  assert.equal(gate.ok, true);
  assert.equal(gate.firebaseUid, UID);
  const { pinForUid } = await manifest();
  assert.equal(gate.uuid, pinForUid(UID));
  const upper = { user: { id: session.user.id.toUpperCase(), app_metadata: { firebase_uid: UID } } };
  assert.equal(M.evaluateRemapIdentity(upper).ok, true, 'RFC 4122 hex comparison is case-insensitive');
});

test('every invalid identity is rejected with zero storage reads or writes', async () => {
  const session = await sessionFor();
  const validId = session.user.id;
  const flipped = validId.replace(/.$/, c => (c === '0' ? '1' : '0'));
  const variants = [
    [null, 'no-session'],
    [undefined, 'no-session'],
    [{}, 'no-session'],
    [{ user: null }, 'no-session'],
    [{ user: {} }, 'missing-claim'],
    [{ user: { id: validId } }, 'missing-claim'],
    [{ user: { id: validId, app_metadata: null } }, 'missing-claim'],
    [{ user: { id: validId, app_metadata: {} } }, 'missing-claim'],
    [{ user: { id: validId, app_metadata: { firebase_uid: '' } } }, 'missing-claim'],
    [{ user: { id: validId, app_metadata: { firebase_uid: '   ' } } }, 'missing-claim'],
    [{ user: { id: validId, app_metadata: { firebase_uid: 42 } } }, 'missing-claim'],
    [{ user: { id: validId, app_metadata: { firebase_uid: { uid: UID } } } }, 'missing-claim'],
    [{ user: { id: '11111111-1111-4111-8111-111111111111', app_metadata: { firebase_uid: UID } } }, 'pin-mismatch'],
    [{ user: { id: flipped, app_metadata: { firebase_uid: UID } } }, 'pin-mismatch'],
    [{ user: { id: '', app_metadata: { firebase_uid: UID } } }, 'missing-session-uuid'],
    [{ user: { id: 42, app_metadata: { firebase_uid: UID } } }, 'missing-session-uuid'],
    [{ user: { id: 'not-a-uuid', app_metadata: { firebase_uid: UID } } }, 'pin-mismatch']
  ];
  assert.equal(variants.length, 17);
  for (const [variant, reason] of variants) {
    const gate = M.evaluateRemapIdentity(variant);
    assert.equal(gate.ok, false, JSON.stringify(variant));
    assert.equal(gate.reason, reason, JSON.stringify(variant));
  }

  // Rejection must touch storage NOWHERE — seed a fully populated store.
  const storage = memStorage(Object.fromEntries(P.map(p => [p + UID, '{"ts":1,"payload":{}}'])));
  for (const [variant] of variants) {
    const report = M.remapRecoveryKeys({ session: variant, storage });
    assert.equal(report.status, 'noop');
    assert.equal(report.actions.length, 0);
    assert.match(report.notes[0], /identity gate failed/);
  }
  assert.equal(storage.calls.get.length, 0, 'no reads before the gate passes');
  assert.equal(storage.calls.set.length, 0, 'no writes before the gate passes');
  assert.equal(storage.calls.remove.length, 0);
});

test('user_metadata is never a trusted claim — app_metadata only', () => {
  const report = M.remapRecoveryKeys({
    session: { user: { id: 'anything', user_metadata: { firebase_uid: UID } } },
    storage: memStorage({ ['lifts_snap_' + UID]: '{"ts":1,"payload":{}}' })
  });
  assert.equal(report.status, 'noop');
  assert.equal(report.gate.reason, 'missing-claim');
});

// ── All seven prefixes, happy path ─────────────────────────────────────────

function seedAllSevenSources(uid = UID) {
  return {
    [SNAP + uid]: JSON.stringify({ ts: 1000, payload: { cats: [{ id: 'push' }] } }),
    [SNAPC + uid]: JSON.stringify({ ts: 500, payload: { older: true } }),
    [SNAPQ + uid]: JSON.stringify([{ ts: 1, reason: 'unexpected structure', snapshot: { a: 1 } }]),
    [QUAR + uid]: JSON.stringify([{ sig: 'cats-unreadable|[1]', kind: 'cats-unreadable', ts: 1, raw: [1] }]),
    [NOTE + uid]: '3',
    [PW + uid]: JSON.stringify([{ id: 'w1', name: 'Push Day', date: '2026-10-10' }]),
    [AW + uid]: JSON.stringify({ aw: { id: 'active-1', startedAt: 1 }, updatedAt: 123 })
  };
}

test('happy path: all seven prefixes copy byte-for-byte and every source key survives untouched', async () => {
  const seed = seedAllSevenSources();
  const storage = memStorage(seed);
  const report = M.remapRecoveryKeys({ session: await sessionFor(), storage });

  assert.equal(report.status, 'remapped');
  assert.equal(report.gate.ok, true);
  assert.equal(report.actions.length, 7, JSON.stringify(report.actions, null, 2));
  for (let i = 0; i < P.length; i++) {
    const prefix = P[i];
    assert.equal(report.actions[i].prefix, prefix, 'actions follow REMAP_KEY_PREFIXES order');
    assert.equal(report.actions[i].action, 'copied');
    assert.equal(storage.raw(await dstKey(prefix)), seed[srcKey(prefix)], prefix + ' destination must be byte-identical');
    assert.equal(storage.raw(srcKey(prefix)), seed[srcKey(prefix)], prefix + ' source must be byte-for-byte preserved');
  }
  assert.equal(storage.calls.remove.length, 0, 'removeItem must never be called');
  assert.equal(report.notes.length, 0, 'clean run produces no notes');
});

test('works with a storage that has no removeItem at all (copy-only contract)', async () => {
  const seed = seedAllSevenSources();
  const map = new Map(Object.entries(seed));
  const storage = {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(String(k), String(v))
  };
  const report = M.remapRecoveryKeys({ session: await sessionFor(), storage });
  assert.equal(report.status, 'remapped');
  assert.equal(report.actions.filter(a => a.action === 'copied').length, 7);
  const after = Object.fromEntries(map);
  for (const k of Object.keys(seed)) assert.equal(after[k], seed[k], k + ' preserved');
});

// ── Destination conflicts (plan §4.2 per-type policy) ──────────────────────

test('snapshot conflict: newer source wins at the destination, displaced destination parked, source preserved', async () => {
  const src = JSON.stringify({ ts: 2000, payload: { mine: true } });
  const dst = JSON.stringify({ ts: 1000, payload: { theirs: true } });
  const storage = memStorage({ [SNAP + UID]: src, [await dstKey(SNAP)]: dst });
  const report = M.remapRecoveryKeys({ session: await sessionFor(), storage });

  assert.equal(report.status, 'remapped');
  assert.deepEqual(plain(report.actions.map(a => [a.action, a.kept || null])), [['parked', null], ['kept-newer', 'source']]);
  assert.equal(storage.raw(await dstKey(SNAP)), src, 'newer source occupies the destination');
  assert.equal(storage.raw(await parkKey()), dst, 'displaced destination parked under lifts_snapconflict_<uuid>');
  assert.equal(storage.raw(SNAP + UID), src, 'source untouched');
});

test('snapshot conflict: newer destination kept, older source parked for the new session', async () => {
  const src = JSON.stringify({ ts: 1000, payload: { old: true } });
  const dst = JSON.stringify({ ts: 2000, payload: { new: true } });
  const storage = memStorage({ [SNAP + UID]: src, [await dstKey(SNAP)]: dst });
  const report = M.remapRecoveryKeys({ session: await sessionFor(), storage });

  assert.equal(report.status, 'remapped');
  assert.equal(storage.raw(await dstKey(SNAP)), dst, 'destination not overwritten');
  assert.equal(storage.raw(await parkKey()), src, 'loser (source) parked under lifts_snapconflict_<uuid>');
  assert.equal(storage.raw(SNAP + UID), src, 'source untouched');
  assert.deepEqual(plain(report.actions.map(a => [a.action, a.kept || null])), [['kept-newer', 'destination'], ['parked', null]]);
});

test('snapshot tie keeps the source side (snapPick >= parity) and parks the displaced destination', async () => {
  const src = JSON.stringify({ ts: 1000, payload: { side: 'old-device' } });
  const dst = JSON.stringify({ ts: 1000, payload: { side: 'new-device' } });
  const storage = memStorage({ [SNAP + UID]: src, [await dstKey(SNAP)]: dst });
  const report = M.remapRecoveryKeys({ session: await sessionFor(), storage });
  assert.equal(storage.raw(await dstKey(SNAP)), src, '>= means source wins the tie');
  assert.equal(storage.raw(await parkKey()), dst);
  assert.equal(storage.raw(SNAP + UID), src);
  assert.equal(report.status, 'remapped');
});

test('lifts_snapconflict_ self-collision never overwrites its own park slot', async () => {
  const src = JSON.stringify({ ts: 9000, payload: { from: 'source' } });
  const dst = JSON.stringify({ ts: 1, payload: { from: 'destination' } });
  const storage = memStorage({ [SNAPC + UID]: src, [await dstKey(SNAPC)]: dst });
  const report = M.remapRecoveryKeys({ session: await sessionFor(), storage });

  assert.equal(report.status, 'noop');
  assert.equal(storage.raw(await dstKey(SNAPC)), dst, 'destination kept — no destructive overwrite');
  assert.equal(storage.raw(SNAPC + UID), src, 'source untouched');
  assert.ok(report.notes.some(n => /park-slot collision/.test(n)));
});

test('occupied park slot defers the overwrite — nothing is destroyed', async () => {
  const src = JSON.stringify({ ts: 5000, payload: { from: 'source' } });
  const dst = JSON.stringify({ ts: 1, payload: { from: 'destination' } });
  const parked = JSON.stringify({ ts: 77, payload: { already: 'parked' } });
  const storage = memStorage({
    [SNAP + UID]: src,
    [await dstKey(SNAP)]: dst,
    [await parkKey()]: parked
  });
  const report = M.remapRecoveryKeys({ session: await sessionFor(), storage });

  assert.equal(report.status, 'noop', 'deferred = no writes');
  assert.equal(storage.raw(await dstKey(SNAP)), dst, 'destination NOT overwritten');
  assert.equal(storage.raw(await parkKey()), parked, 'existing park record untouched');
  assert.equal(storage.raw(SNAP + UID), src, 'source preserved at source key');
  assert.ok(report.actions.some(a => a.action === 'deferred'));
  assert.ok(report.notes.some(n => /occupied/.test(n)));
});

test('active workout conflict follows updatedAt with the same park rules', async () => {
  const src = JSON.stringify({ aw: { id: 'old-active', startedAt: 1 }, updatedAt: 100 });
  const dst = JSON.stringify({ aw: { id: 'new-active', startedAt: 2 }, updatedAt: 200 });
  const storage = memStorage({ [AW + UID]: src, [await dstKey(AW)]: dst });
  const report = M.remapRecoveryKeys({ session: await sessionFor(), storage });

  assert.equal(storage.raw(await dstKey(AW)), dst, 'newer destination kept');
  assert.equal(storage.raw(await parkKey()), src, 'older source AW parked (plan: park under lifts_snapconflict_<uuid>)');
  assert.equal(storage.raw(AW + UID), src);
  assert.equal(report.status, 'remapped');
});

// ── Pending queue union (p1MergePending semantics) ─────────────────────────

test('pending queue unions by workout id (first-wins) and keeps unreadable entries', async () => {
  const src = JSON.stringify([
    { id: 'w1', name: 'src duplicate of w1' },
    { id: 'w2', name: 'brand new' },
    { id: 'w2', name: 'duplicate within source' },
    'junk',
    { name: 'no id at all' }
  ]);
  const dst = JSON.stringify([{ id: 'w1', name: 'already in destination' }]);
  const storage = memStorage({ [PW + UID]: src, [await dstKey(PW)]: dst });
  const report = M.remapRecoveryKeys({ session: await sessionFor(), storage });

  assert.equal(report.status, 'remapped');
  const merged = JSON.parse(storage.raw(await dstKey(PW)));
  assert.deepEqual(merged, [
    { id: 'w1', name: 'already in destination' },
    { id: 'w2', name: 'brand new' },
    'junk',
    { name: 'no id at all' }
  ]);
  assert.equal(storage.raw(PW + UID), src, 'source queue untouched');
  assert.ok(report.actions.some(a => a.action === 'unioned'));
});

// ── Quarantines ────────────────────────────────────────────────────────────

test('quarantine merge dedups by signature with destination entries winning', async () => {
  const dst = JSON.stringify([
    { sig: 'a|1', kind: 'x', ts: 1, raw: 1 },
    { sig: 'b|2', kind: 'y', ts: 2, raw: 2 }
  ]);
  const src = JSON.stringify([
    { sig: 'b|2', kind: 'y', ts: 9, raw: 'different but same sig' },
    { sig: 'c|3', kind: 'z', ts: 3, raw: 3 }
  ]);
  const storage = memStorage({ [QUAR + UID]: src, [await dstKey(QUAR)]: dst });
  const report = M.remapRecoveryKeys({ session: await sessionFor(), storage });

  const merged = JSON.parse(storage.raw(await dstKey(QUAR)));
  assert.deepEqual(merged.map(e => e.sig), ['a|1', 'b|2', 'c|3'], 'destination order kept, existing sig wins');
  assert.equal(merged[1].raw, 2, 'existing destination entry not replaced by source dupe');
  assert.equal(storage.raw(QUAR + UID), src, 'source untouched');
  assert.equal(report.status, 'remapped');
});

test('quarantine cap: destination never truncated, newest source entries preferred, remainder stays at source', async () => {
  const dstEntries = Array.from({ length: 99 }, (_, i) => ({ sig: 'q|' + i, kind: 'q', ts: i, raw: i }));
  const srcEntries = Array.from({ length: 5 }, (_, i) => ({ sig: 's|' + i, kind: 's', ts: 100 + i, raw: 100 + i }));
  const dst = JSON.stringify(dstEntries);
  const src = JSON.stringify(srcEntries);
  const storage = memStorage({ [QUAR + UID]: src, [await dstKey(QUAR)]: dst });
  const report = M.remapRecoveryKeys({ session: await sessionFor(), storage });

  const merged = JSON.parse(storage.raw(await dstKey(QUAR)));
  assert.equal(merged.length, 100, 'capped at 100');
  assert.deepEqual(merged.slice(0, 99).map(e => e.sig), dstEntries.map(e => e.sig), 'all 99 destination entries preserved');
  assert.equal(merged[99].sig, 's|4', 'newest source entry fills the one free slot');
  assert.equal(storage.raw(QUAR + UID), src, 'all five source entries remain intact at the source key');
  assert.ok(report.notes.some(n => /remain at source key/.test(n)));
});

test('quarantine destination already at cap is left untouched', async () => {
  const dst = JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ sig: 'q|' + i, kind: 'q', ts: i, raw: i })));
  const src = JSON.stringify([{ sig: 'new|1', kind: 'n', ts: 1, raw: 1 }]);
  const storage = memStorage({ [QUAR + UID]: src, [await dstKey(QUAR)]: dst });
  const report = M.remapRecoveryKeys({ session: await sessionFor(), storage });

  assert.equal(report.status, 'noop');
  assert.equal(storage.raw(await dstKey(QUAR)), dst, 'at-cap destination never rewritten');
  assert.equal(storage.raw(QUAR + UID), src, 'source intact');
  assert.ok(report.notes.some(n => /at cap 100/.test(n)));
});

test('snapshot quarantine (cap 3): destination preserved, newest source entries fill the rest', async () => {
  const dst = JSON.stringify([{ ts: 1, reason: 'dest', snapshot: { d: 1 } }]);
  const src = JSON.stringify([
    { ts: 2, reason: 's1', snapshot: { s: 1 } },
    { ts: 3, reason: 's2', snapshot: { s: 2 } },
    { ts: 4, reason: 's3', snapshot: { s: 3 } }
  ]);
  const storage = memStorage({ [SNAPQ + UID]: src, [await dstKey(SNAPQ)]: dst });
  M.remapRecoveryKeys({ session: await sessionFor(), storage });

  const merged = JSON.parse(storage.raw(await dstKey(SNAPQ)));
  assert.equal(merged.length, 3, 'capped at 3');
  assert.equal(merged[0].reason, 'dest', 'destination entry first and preserved');
  assert.deepEqual(merged.slice(1).map(e => e.reason), ['s2', 's3'], 'newest two source entries chosen');
  assert.equal(storage.raw(SNAPQ + UID), src, 'source intact — s1 still visible there');
});

// ── Repair note ────────────────────────────────────────────────────────────

test('repair note: copied when destination absent; destination marker kept when both exist', async () => {
  const storage = memStorage({ [NOTE + UID]: '3' });
  let report = M.remapRecoveryKeys({ session: await sessionFor(), storage });
  assert.equal(report.actions[0].action, 'copied');
  assert.equal(storage.raw(await dstKey(NOTE)), '3');

  storage.setItem(await dstKey(NOTE), '7');
  report = M.remapRecoveryKeys({ session: await sessionFor(), storage });
  assert.equal(report.status, 'noop');
  assert.equal(storage.raw(await dstKey(NOTE)), '7', 'destination marker kept (cap 1)');
  assert.equal(storage.raw(NOTE + UID), '3', 'source marker preserved');
  assert.ok(report.actions.some(a => a.action === 'kept' && /cap=1/.test(a.detail)));
});

// ── Malformed data ─────────────────────────────────────────────────────────

test('malformed sources are never written to the destination', async () => {
  const storage = memStorage({
    [SNAP + UID]: 'not json at all',
    [PW + UID]: '"a string, not an array"',
    [QUAR + UID]: '{"nope":true}',
    [SNAPQ + UID]: '42'
  });
  const report = M.remapRecoveryKeys({ session: await sessionFor(), storage });

  assert.equal(report.status, 'noop');
  assert.equal(storage.raw(await dstKey(SNAP)), undefined, 'no snapshot destination created');
  assert.equal(storage.raw(await dstKey(PW)), undefined);
  assert.equal(storage.raw(await dstKey(QUAR)), undefined);
  assert.equal(storage.raw(await dstKey(SNAPQ)), undefined);
  assert.equal(report.actions.filter(a => a.action === 'skipped').length, 4);
  assert.equal(storage.raw(SNAP + UID), 'not json at all', 'malformed source still preserved byte-for-byte');
  assert.equal(storage.raw(QUAR + UID), '{"nope":true}');
});

test('malformed destinations are never overwritten', async () => {
  const srcSnap = JSON.stringify({ ts: 99999, payload: { valid: true } });
  const srcPw = JSON.stringify([{ id: 'w9', name: 'valid queue entry' }]);
  const storage = memStorage({
    [SNAP + UID]: srcSnap,
    [await dstKey(SNAP)]: '{broken json',
    [PW + UID]: srcPw,
    [await dstKey(PW)]: 'not-an-array'
  });
  const report = M.remapRecoveryKeys({ session: await sessionFor(), storage });

  assert.equal(storage.raw(await dstKey(SNAP)), '{broken json', 'malformed destination left in place');
  assert.equal(storage.raw(await dstKey(PW)), 'not-an-array');
  assert.equal(storage.raw(SNAP + UID), srcSnap, 'source preserved');
  assert.equal(storage.raw(PW + UID), srcPw);
  assert.equal(report.status, 'noop');
  assert.ok(report.notes.some(n => /malformed destination/.test(n)));
});

// ── Idempotency + full preservation ────────────────────────────────────────

test('reruns are byte-stable: second run writes nothing and changes nothing', async () => {
  const storage = memStorage(seedAllSevenSources());
  storage.setItem(await dstKey(SNAP), JSON.stringify({ ts: 1, payload: { older: true } }));
  storage.setItem(await dstKey(AW), JSON.stringify({ aw: { id: 'x' }, updatedAt: 5 }));

  const session = await sessionFor();
  const run1 = M.remapRecoveryKeys({ session, storage });
  assert.equal(run1.status, 'remapped');
  const afterRun1 = storage.snapshot();
  const setsAfterRun1 = storage.calls.set.length;

  const run2 = M.remapRecoveryKeys({ session, storage });
  assert.equal(run2.status, 'noop', 'no writes on rerun');
  assert.equal(storage.calls.set.length, setsAfterRun1, 'zero additional setItem calls');
  assert.deepEqual(storage.snapshot(), afterRun1, 'every key byte-identical after rerun');
});

test('a fully conflicting run still preserves every source key byte-for-byte', async () => {
  const seed = seedAllSevenSources();
  const storage = memStorage(seed);
  storage.setItem(await dstKey(SNAP), JSON.stringify({ ts: 5000, payload: { dest: 1 } }));
  storage.setItem(await dstKey(SNAPC), JSON.stringify({ ts: 1, payload: { dest: 1 } }));
  storage.setItem(await dstKey(SNAPQ), JSON.stringify([{ ts: 99, reason: 'existing', snapshot: {} }]));
  storage.setItem(await dstKey(QUAR), JSON.stringify([{ sig: 'cats-unreadable|[1]', kind: 'cats-unreadable', ts: 5, raw: [9] }]));
  storage.setItem(await dstKey(NOTE), '9');
  storage.setItem(await dstKey(PW), JSON.stringify([{ id: 'w1', name: 'dest version' }, { id: 'w0', name: 'only in dest' }]));
  storage.setItem(await dstKey(AW), JSON.stringify({ aw: { id: 'dest-active' }, updatedAt: 999 }));

  const report = M.remapRecoveryKeys({ session: await sessionFor(), storage });

  for (const prefix of P) {
    assert.equal(storage.raw(srcKey(prefix)), seed[srcKey(prefix)],
      prefix + ' source must be byte-for-byte identical after a conflicting run');
  }
  assert.equal(storage.calls.remove.length, 0, 'no deletes, ever');
  assert.ok(report.actions.length > 0, 'conflicts were actually exercised');
});

// ── Robustness ─────────────────────────────────────────────────────────────

test('storage failures degrade to notes, never crash, and never block other prefixes', async () => {
  const seed = seedAllSevenSources();
  const storage = memStorage(seed);
  const pwKey = PW + UID;
  const realGet = storage.getItem.bind(storage);
  storage.getItem = k => {
    if (k === pwKey) throw new Error('storage disabled for this key');
    return realGet(k);
  };
  const report = M.remapRecoveryKeys({ session: await sessionFor(), storage });

  assert.equal(report.status, 'remapped', 'other prefixes still processed');
  assert.ok(report.notes.some(n => /storage read failed/.test(n)));
  assert.ok(report.actions.some(a => a.prefix === SNAP && a.action === 'copied'));
  assert.equal(storage.raw(await dstKey(PW)), undefined, 'failed prefix left without a destination');
});

test('invalid storage argument throws TypeError; missing session is a report not a crash', async () => {
  const msg = /remapRecoveryKeys requires a storage object with getItem and setItem functions/;
  assert.throws(() => M.remapRecoveryKeys({ session: {}, storage: null }), msg);
  assert.throws(() => M.remapRecoveryKeys({ session: {}, storage: { getItem() {} } }), msg);
  assert.throws(() => M.remapRecoveryKeys(), msg);
  const report = M.remapRecoveryKeys({ session: null, storage: memStorage() });
  assert.equal(report.status, 'noop');
  assert.equal(report.gate.reason, 'no-session');
});
