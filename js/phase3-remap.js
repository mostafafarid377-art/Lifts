// ── LIFTS Phase 3c (O1): identity-gated localStorage remap shim ────────────
//
// ISOLATION CONTRACT: this module is NOT referenced by index.html, js/app.js,
// or any production execution path. It ships un-wired so it can be reviewed
// and fixture-tested offline; wiring it into the app is part of the
// separately approved cutover change-set (plan decision D-11). Nothing here
// contacts Firebase, Supabase, or any network; runs no SQL; needs no
// credentials; and never reads real user data — inputs are only a session
// object and a storage-like object you pass in.
//
// Implements docs/phase-3-auth-migration-plan.md §4.2 (copy-based remap of
// uid-keyed recovery records) with the identity gate from §4.2.1 + addendum
// V4/V9:
//
//   * Gate: run ONLY when session.user.app_metadata.firebase_uid is a
//     non-empty string AND recomputing the pinned Supabase UUID — RFC 4122
//     UUIDv5 of that uid under the fixed project namespace (identical to
//     scripts/migration/build-manifest.mjs) — equals session.user.id.
//     Claim absent or pin mismatch ⇒ zero reads and zero writes.
//     NEVER infer identity from email; NEVER read user_metadata (user-
//     editable, not a trustworthy claim — only service-role-controlled
//     app_metadata qualifies, per V4).
//   * Copy, don't move: source keys are never modified and never deleted
//     (this module does not even call removeItem), so rollback to Firebase
//     always finds the original records intact. Old-key cleanup is a
//     separate, later, approval-gated phase.
//   * Conflict policy (plan §4.2, second bullet), per record type:
//       - snapshot records (lifts_snap_, lifts_snapconflict_, shape
//         {ts, payload}) and active workout (lifts_aw_, {aw, updatedAt}):
//         newer ts/updatedAt wins at the destination (same >= tie rule as
//         snapPick); the loser is parked under lifts_snapconflict_<uuid>
//         when that slot is free and its content differs. Never overwrite
//         the destination when the park slot needed to preserve the
//         displaced record is itself occupied — that outcome is reported
//         for manual review instead (no data may be destroyed).
//       - pending-workout queue (lifts_pw_): union by workout id, same
//         first-wins dedup + unreadable-entries-kept semantics as
//         p1MergePending (js/app.js).
//       - quarantines (lifts_quarantine_ cap 100 with sig dedup;
//         lifts_snapquarantine_ cap 3): concatenate against the existing
//         destination, destination entries always preserved, newest
//         source entries preferred when the cap must trim, matching the
//         app's keep-newest (slice(-N)) direction. Source-side entries
//         that do not fit remain intact at the source key.
//       - repair note (lifts_repairnote_): concatenate capped at the
//         existing limit of one marker ⇒ destination marker kept; source
//         marker preserved at the source key.
//   * Idempotent: reruns perform no writes once destinations hold the
//     merged content, and never flip-flop conflicting records.
//
// Pure, synchronous, dependency-free ES module (no Node built-ins) so the
// same file works in a browser and under the repo's vm-based tests.
//
//   import { remapRecoveryKeys } from './phase3-remap.js';
//   const report = remapRecoveryKeys({ session, storage: window.localStorage });

export const REMAP_KEY_PREFIXES = Object.freeze([
  'lifts_snap_',
  'lifts_snapconflict_',
  'lifts_snapquarantine_',
  'lifts_quarantine_',
  'lifts_repairnote_',
  'lifts_pw_',
  'lifts_aw_'
]);

// Same fixed project namespace as scripts/migration/build-manifest.mjs —
// NOT a secret and never changed: pin derivation must stay stable forever.
export const PIN_NAMESPACE = '6e7a1c90-3f2d-4b18-9c47-2a5d8e0f1b64';

const QUARANTINE_CAP = 100;        // js/app.js quarantine(): a.slice(-100)
const SNAP_QUARANTINE_CAP = 3;     // js/app.js quarantineSnapshot(): a.slice(-3)
const REPAIRNOTE_CAP = 1;          // single marker value (String(REPAIR.unplaced))
const PARK_PREFIX = 'lifts_snapconflict_';

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// ── RFC 4122 UUIDv5 (pure JS) ──────────────────────────────────────────────
// Mirrors uuidv5() in build-manifest.mjs (SHA-1 over namespace + name, set
// version/variant bits). Implemented here without node:crypto so the module
// stays browser-safe; tests differential-check it against both node:crypto
// and build-manifest's pinForUid.

function utf8Bytes(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) {
      out.push(c);
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c >= 0xd800 && c <= 0xdbff) {
      const c2 = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
      if (c2 >= 0xdc00 && c2 <= 0xdfff) {
        i++;
        const cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
        continue;
      }
      out.push(0xef, 0xbf, 0xbd); // lone high surrogate → U+FFFD
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      out.push(0xef, 0xbf, 0xbd); // lone low surrogate → U+FFFD
    } else {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return out;
}

function sha1(bytes) {
  const len = bytes.length;
  const total = Math.ceil((len + 9) / 64) * 64;
  const buf = new Uint8Array(total);
  buf.set(bytes);
  buf[len] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(total - 8, Math.floor((len * 8) / 4294967296), false);
  dv.setUint32(total - 4, (len * 8) >>> 0, false);

  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const w = new Int32Array(80);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getInt32(off + i * 4, false);
    for (let i = 16; i < 80; i++) {
      const n = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
      w[i] = (n << 1) | (n >>> 31);
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      let f, k;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const t = ((((a << 5) | (a >>> 27)) + f) + ((e + k + w[i]) | 0)) | 0;
      e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = t;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
  }
  const out = new Uint8Array(20);
  const odv = new DataView(out.buffer);
  odv.setUint32(0, h0, false);
  odv.setUint32(4, h1, false);
  odv.setUint32(8, h2, false);
  odv.setUint32(12, h3, false);
  odv.setUint32(16, h4, false);
  return out;
}

/** RFC 4122 name-based UUIDv5 (SHA-1) — deterministic for a given name. */
export function uuidv5(name, namespace) {
  const nsHex = String(namespace).replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(nsHex)) throw new TypeError('uuidv5 namespace must be a UUID');
  const ns = new Uint8Array(16);
  for (let i = 0; i < 16; i++) ns[i] = parseInt(nsHex.slice(i * 2, i * 2 + 2), 16);
  const nameBytes = utf8Bytes(String(name));
  const combined = new Uint8Array(16 + nameBytes.length);
  combined.set(ns, 0);
  combined.set(nameBytes, 16);
  const bytes = sha1(combined).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  let hex = '';
  for (let i = 0; i < 16; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The pinned Supabase UUID for a Firebase UID — uid-only, never email. */
export function expectedSupabaseUuid(firebaseUid) {
  return uuidv5(String(firebaseUid), PIN_NAMESPACE);
}

// ── Identity gate (§4.2.1, V4) ─────────────────────────────────────────────
export function evaluateRemapIdentity(session) {
  const user = session && session.user;
  if (!user || typeof user !== 'object') {
    return { ok: false, reason: 'no-session' };
  }
  const meta = user.app_metadata;
  const claim = isObj(meta) ? meta.firebase_uid : undefined;
  if (typeof claim !== 'string' || claim.trim() === '') {
    return { ok: false, reason: 'missing-claim' };
  }
  if (typeof user.id !== 'string' || user.id.trim() === '') {
    return { ok: false, reason: 'missing-session-uuid' };
  }
  const expected = expectedSupabaseUuid(claim);
  if (user.id.trim().toLowerCase() !== expected) {
    return { ok: false, reason: 'pin-mismatch', expected };
  }
  return { ok: true, firebaseUid: claim, uuid: expected };
}

// ── Record-shape helpers (mirroring the app's read layers) ─────────────────

// js/app.js snapRead(): { ts, payload } with payload a non-null object.
function parseSnapshot(raw) {
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === 'object' && !Array.isArray(v) && v.payload && typeof v.payload === 'object') return v;
  } catch (_) { /* fall through */ }
  return null;
}

// js/app.js wkResolveRestore(): JSON object with (possibly missing) updatedAt.
function parseActiveWorkout(raw) {
  try {
    const v = JSON.parse(raw);
    if (isObj(v)) return v;
  } catch (_) { /* fall through */ }
  return null;
}

function parseArray(raw) {
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v)) return v;
  } catch (_) { /* fall through */ }
  return null;
}

const numOf = n => (Number.isFinite(Number(n)) ? Number(n) : NaN);

/**
 * Newer-record-wins core shared by snapshots ({ts}) and the active workout
 * ({updatedAt}) — tie rule mirrors snapPick's `>=` (source wins ties).
 * `field` selects the timestamp key. Returns the list of actions taken.
 * Storage read failures propagate to the per-prefix try/catch, which skips
 * the prefix before any write happens (never overwrite without confirming
 * the park slot is free).
 */
function processNewerWins(ctx) {
  const { prefix, srcKey, dstKey, parkKey, raw, dstRaw, field, notes, storage } = ctx;
  const actions = [];
  const src = parseNewerWinsSource(raw, field);
  const dst = dstRaw === null ? null : parseNewerWinsSource(dstRaw, field);

  if (dstRaw === null) {
    if (!src) {
      actions.push({ prefix, from: srcKey, to: dstKey, action: 'skipped', detail: 'malformed source — destination left absent' });
      return { actions, wrote: false };
    }
    return { actions: [{ prefix, from: srcKey, to: dstKey, action: 'copied' }], wrote: true, writes: [[dstKey, raw]] };
  }

  // Both keys exist → conflict policy.
  if (!src || !dst) {
    const side = !src ? 'source' : 'destination';
    actions.push({ prefix, from: srcKey, to: dstKey, action: !src ? 'skipped' : 'kept', detail: `malformed ${side} — destination untouched, source preserved at source key` });
    if (!src) notes.push(`${prefix}: malformed source — destination untouched`);
    else notes.push(`${prefix}: malformed destination — left in place for manual review`);
    return { actions, wrote: false };
  }

  const srcTs = numOf(src[field]);
  const dstTs = numOf(dst[field]);
  const dstClock = Number.isFinite(dstTs) ? dstTs : 0; // snapPick: (Number(cloud.savedAt)||0)
  const sourceWins = Number.isFinite(srcTs) && srcTs >= dstClock;

  if (sourceWins) {
    if (raw === dstRaw) {
      // Identical bytes on both sides (or a completed rerun): nothing to do.
      actions.push({ prefix, from: srcKey, to: dstKey, action: 'kept', detail: 'identical bytes — nothing to do' });
      return { actions, wrote: false };
    }
    // Plan: keep the newer record at the destination; the displaced
    // destination record must be parked BEFORE it can be replaced.
    if (dstKey === parkKey) {
      actions.push({ prefix, from: dstKey, to: dstKey, action: 'kept', detail: 'park slot is this key — destination kept; source remains at source key' });
      notes.push(`${prefix}: park-slot collision — conflict left for manual review; nothing overwritten`);
      return { actions, wrote: false };
    }
    const parkCurrent = readSlot(storage, parkKey); // may throw → prefix skipped, no writes
    if (parkCurrent !== null && parkCurrent !== dstRaw) {
      actions.push({ prefix, from: srcKey, to: dstKey, action: 'deferred', detail: 'park slot occupied — destination NOT overwritten; manual review' });
      notes.push(`${prefix}: park slot ${parkKey} occupied — destination left untouched to avoid data loss; source preserved at source key`);
      return { actions, wrote: false };
    }
    if (parkCurrent === null) {
      actions.push({ prefix, from: dstKey, to: parkKey, action: 'parked', detail: 'displaced destination record' });
      actions.push({ prefix, from: srcKey, to: dstKey, action: 'kept-newer', kept: 'source' });
      return { actions, wrote: true, writes: [[parkKey, dstRaw], [dstKey, raw]] };
    }
    // Park already holds exactly the displaced bytes (idempotent rerun).
    actions.push({ prefix, from: srcKey, to: dstKey, action: 'kept-newer', kept: 'source' });
    return { actions, wrote: true, writes: [[dstKey, raw]] };
  }

  // Destination newer (or source clock unusable): keep destination; the
  // loser (source) is parked for the new session when the slot is free.
  actions.push({ prefix, from: srcKey, to: dstKey, action: 'kept-newer', kept: 'destination' });
  if (dstKey === parkKey) {
    notes.push(`${prefix}: park slot is this key — source (older) stays only at its source key`);
    return { actions, wrote: false };
  }
  const parkCurrent = readSlot(storage, parkKey); // may throw → prefix skipped, no writes
  if (parkCurrent === null) {
    actions.push({ prefix, from: srcKey, to: parkKey, action: 'parked', detail: 'older source record' });
    return { actions, wrote: true, writes: [[parkKey, raw]] };
  }
  return { actions, wrote: false }; // slot taken — source still intact at source key
}

function parseNewerWinsSource(raw, field) {
  if (field === 'ts') return parseSnapshot(raw);
  return parseActiveWorkout(raw);
}

/** Raw slot read; null/undefined = absent. Throws on storage failures. */
function readSlot(storage, key) {
  const v = storage.getItem(key);
  return v === null || v === undefined ? null : String(v);
}

// ── Per-prefix processors ──────────────────────────────────────────────────
// Each returns { actions, wrote, writes? } and may push to notes.

function processPending({ prefix, srcKey, dstKey, raw, dstRaw, notes }) {
  const actions = [];
  if (dstRaw === null) {
    const arr = parseArray(raw);
    if (!arr) {
      actions.push({ prefix, from: srcKey, to: dstKey, action: 'skipped', detail: 'malformed source — destination left absent' });
      return { actions, wrote: false };
    }
    return { actions: [{ prefix, from: srcKey, to: dstKey, action: 'copied' }], wrote: true, writes: [[dstKey, raw]] };
  }
  const srcArr = parseArray(raw);
  const dstArr = parseArray(dstRaw);
  if (!srcArr || !dstArr) {
    const side = !srcArr ? 'source' : 'destination';
    actions.push({ prefix, from: srcKey, to: dstKey, action: !srcArr ? 'skipped' : 'kept', detail: `malformed ${side} — destination untouched, source preserved at source key` });
    notes.push(`${prefix}: malformed ${side.toLowerCase()} — no merge performed`);
    return { actions, wrote: false };
  }

  // Union by workout id, first-wins — mirrors p1MergePending (js/app.js):
  // destination entries keep their order; source entries join only when
  // their id is new; unreadable/non-object entries are kept when not
  // already present verbatim (so reruns stay byte-stable).
  const merged = dstArr.slice();
  const haveIds = new Set();
  const haveJson = new Set(dstArr.map(e => JSON.stringify(e)));
  for (const e of dstArr) {
    if (isObj(e) && e.id !== undefined && e.id !== null && String(e.id) !== '') haveIds.add(String(e.id));
  }
  const additions = [];
  for (const e of srcArr) {
    const isQueueEntry = isObj(e) && e.id !== undefined && e.id !== null && String(e.id) !== '';
    if (isQueueEntry) {
      const id = String(e.id);
      if (haveIds.has(id)) continue;
      haveIds.add(id);
      additions.push(e);
      haveJson.add(JSON.stringify(e));
    } else {
      const j = JSON.stringify(e);
      if (haveJson.has(j)) continue; // unreadable record already present verbatim
      additions.push(e);             // unreadable record: kept, never merged away
      haveJson.add(j);
    }
  }
  if (additions.length === 0) {
    actions.push({ prefix, from: srcKey, to: dstKey, action: 'kept', detail: 'all source entries already present' });
    return { actions, wrote: false };
  }
  merged.push(...additions);
  const serialized = JSON.stringify(merged);
  if (serialized === dstRaw) {
    actions.push({ prefix, from: srcKey, to: dstKey, action: 'kept', detail: 'union already in place' });
    return { actions, wrote: false };
  }
  actions.push({ prefix, from: srcKey, to: dstKey, action: 'unioned', detail: `+${additions.length} entr${additions.length === 1 ? 'y' : 'ies'} by id` });
  return { actions, wrote: true, writes: [[dstKey, serialized]] };
}

function processQuarantine({ prefix, srcKey, dstKey, raw, dstRaw, cap, dedupeBySig, notes }) {
  const actions = [];
  if (dstRaw === null) {
    const arr = parseArray(raw);
    if (!arr) {
      actions.push({ prefix, from: srcKey, to: dstKey, action: 'skipped', detail: 'malformed source — destination left absent' });
      return { actions, wrote: false };
    }
    return { actions: [{ prefix, from: srcKey, to: dstKey, action: 'copied' }], wrote: true, writes: [[dstKey, raw]] };
  }
  const srcArr = parseArray(raw);
  const dstArr = parseArray(dstRaw);
  if (!srcArr || !dstArr) {
    const side = !srcArr ? 'source' : 'destination';
    actions.push({ prefix, from: srcKey, to: dstKey, action: !srcArr ? 'skipped' : 'kept', detail: `malformed ${side} — destination untouched, source preserved at source key` });
    notes.push(`${prefix}: malformed ${side.toLowerCase()} — no merge performed`);
    return { actions, wrote: false };
  }

  const seen = new Set();
  const destJson = new Set(dstArr.map(e => JSON.stringify(e)));
  if (dedupeBySig) {
    for (const e of dstArr) if (isObj(e) && typeof e.sig === 'string') seen.add(e.sig);
  }
  let additions = [];
  for (const e of srcArr) {
    const sig = dedupeBySig && isObj(e) && typeof e.sig === 'string' ? e.sig : null;
    if (sig !== null) {
      if (seen.has(sig)) continue; // existing destination entry wins (js/app.js quarantine())
      seen.add(sig);
      additions.push(e);
      continue;
    }
    // No signature to dedupe on (or quarantine entry without one): skip
    // entries already present verbatim so reruns stay byte-stable.
    if (destJson.has(JSON.stringify(e))) continue;
    additions.push(e);
  }

  if (additions.length === 0) {
    actions.push({ prefix, from: srcKey, to: dstKey, action: 'kept', detail: 'no new entries' });
    return { actions, wrote: false };
  }
  if (dstArr.length >= cap) {
    // Destination already at its cap: never truncate destination data.
    actions.push({ prefix, from: srcKey, to: dstKey, action: 'kept', detail: `destination at cap ${cap} — additions remain only at source key` });
    notes.push(`${prefix}: destination at cap ${cap} — ${additions.length} source entr${additions.length === 1 ? 'y' : 'ies'} preserved at source key only`);
    return { actions, wrote: false };
  }
  const fits = cap - dstArr.length;
  const chosen = additions.slice(-fits); // keep-newest, matching slice(-N)
  const merged = dstArr.concat(chosen);
  const serialized = JSON.stringify(merged);
  if (serialized === dstRaw) {
    actions.push({ prefix, from: srcKey, to: dstKey, action: 'kept', detail: 'merge already in place' });
    return { actions, wrote: false };
  }
  const dropped = additions.length - chosen.length;
  actions.push({
    prefix, from: srcKey, to: dstKey, action: 'merged',
    detail: `+${chosen.length} entr${chosen.length === 1 ? 'y' : 'ies'} (cap ${cap})` + (dropped ? `, ${dropped} older left at source key` : '')
  });
  if (dropped) notes.push(`${prefix}: cap ${cap} kept destination + newest source entries; ${dropped} older source entr${dropped === 1 ? 'y' : 'ies'} remain at source key`);
  return { actions, wrote: true, writes: [[dstKey, serialized]] };
}

function processRepairnote({ prefix, srcKey, dstKey, raw, dstRaw, notes }) {
  const actions = [];
  if (dstRaw === null) {
    return { actions: [{ prefix, from: srcKey, to: dstKey, action: 'copied' }], wrote: true, writes: [[dstKey, raw]] };
  }
  // Concatenate [destination, source] capped at the existing limit of one
  // marker ⇒ destination kept; the source marker stays at the source key.
  actions.push({ prefix, from: srcKey, to: dstKey, action: 'kept', detail: `concatenate-capped cap=${REPAIRNOTE_CAP} → destination kept; source preserved at source key` });
  if (raw !== dstRaw) notes.push(`${prefix}: single-marker cap keeps destination; source marker preserved at source key`);
  return { actions, wrote: false };
}

// ── Main entry ─────────────────────────────────────────────────────────────

function requireStorage(storage) {
  if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') {
    throw new TypeError('remapRecoveryKeys requires a storage object with getItem and setItem functions');
  }
}

/**
 * Copy-based, identity-gated remap of uid-keyed recovery records.
 * Returns a report: { status: 'remapped'|'noop', gate, actions, notes }.
 * Throws only on programmer errors (missing/invalid arguments); data
 * problems become notes and skipped/deferred actions.
 */
export function remapRecoveryKeys({ session, storage } = {}) {
  requireStorage(storage);
  const gate = evaluateRemapIdentity(session);
  const notes = [];
  if (!gate.ok) {
    return { status: 'noop', gate, actions: [], notes: [`identity gate failed (${gate.reason}) — nothing read or written`] };
  }

  const srcBase = gate.firebaseUid;
  const dstBase = gate.uuid;
  const actions = [];
  let wrote = false;

  for (const prefix of REMAP_KEY_PREFIXES) {
    const srcKey = prefix + srcBase;
    const dstKey = prefix + dstBase;
    const parkKey = PARK_PREFIX + dstBase;
    if (srcKey === dstKey) {
      notes.push(`${prefix}: source and destination keys are identical — skipped`);
      continue;
    }
    let raw;
    try {
      raw = storage.getItem(srcKey);
    } catch (e) {
      notes.push(`${prefix}: storage read failed (${e && e.message}) — skipped`);
      continue;
    }
    if (raw === null || raw === undefined) continue; // nothing recorded under the old uid
    raw = String(raw);

    let dstRaw;
    try {
      dstRaw = storage.getItem(dstKey);
    } catch (e) {
      notes.push(`${prefix}: storage read failed (${e && e.message}) — skipped`);
      continue;
    }
    dstRaw = dstRaw === null || dstRaw === undefined ? null : String(dstRaw);

    try {
      let result;
      switch (prefix) {
        case 'lifts_snap_':
        case 'lifts_snapconflict_':
          result = processNewerWins({ prefix, srcKey, dstKey, parkKey, raw, dstRaw, field: 'ts', notes, storage });
          break;
        case 'lifts_aw_':
          result = processNewerWins({ prefix, srcKey, dstKey, parkKey, raw, dstRaw, field: 'updatedAt', notes, storage });
          break;
        case 'lifts_pw_':
          result = processPending({ prefix, srcKey, dstKey, raw, dstRaw, notes });
          break;
        case 'lifts_quarantine_':
          result = processQuarantine({ prefix, srcKey, dstKey, raw, dstRaw, cap: QUARANTINE_CAP, dedupeBySig: true, notes });
          break;
        case 'lifts_snapquarantine_':
          result = processQuarantine({ prefix, srcKey, dstKey, raw, dstRaw, cap: SNAP_QUARANTINE_CAP, dedupeBySig: false, notes });
          break;
        case 'lifts_repairnote_':
          result = processRepairnote({ prefix, srcKey, dstKey, raw, dstRaw, notes });
          break;
        default:
          result = { actions: [], wrote: false };
      }
      if (result.actions) actions.push(...result.actions);
      if (result.wrote && result.writes) {
        for (const [key, value] of result.writes) storage.setItem(key, value);
        wrote = true;
      }
    } catch (e) {
      notes.push(`${prefix}: storage write failed (${e && e.message}) — remaining keys continue`);
    }
  }

  return { status: wrote ? 'remapped' : 'noop', gate, actions, notes };
}
