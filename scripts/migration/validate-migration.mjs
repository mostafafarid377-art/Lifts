// ── LIFTS Phase 3c (O4): offline migration validation gate ─────────────────
//
// ISOLATION CONTRACT: this module is NOT referenced by index.html, js/app.js,
// or any production execution path. It performs NO network requests (no HTTP
// client, no fetch, no transport of any kind), NO SQL, NO provisioning, and
// NO writes of any kind: its entire output is an in-memory report object.
// Live Firebase/Supabase access is out of scope — the three data sources are
// read through an injected READ-ONLY backend interface, which tests supply as
// an in-memory fake. A future adapter that actually reads the project is a
// separate, approval-gated Track-L artifact and is deliberately not built here.
//
// Implements the plan's four-way reconciliation (plan §5.3 validation gates,
// §9 E15, phase-3c gap G7):
//
//   1. migration manifest        (source of truth: firebase_uid → pin)
//   2. public.firebase_uid_map   (DB mirror)
//   3. Supabase Auth app_metadata.firebase_uid claim (per auth user id)
//   4. public.user_data rows     (payload read-back)
//
// …plus export-document count identity and canonical-JSON payload diff
// (JSONB normalizes key order/formatting, so byte equality is never used;
// see RECONCILIATION_NOTES for every place the plan is ambiguous and the
// rule this tool applies instead — nothing is invented silently).
//
// Report redaction: firebase uids, pinned UUIDs, counts, sha256 checksums,
// top-level KEY NAMES of differing fields, masked-free fixed strings only.
// Payload VALUES, passwords, tokens, secret keys, and email addresses are
// never emitted (email/provider drift is compared as a boolean only).
//
// Gate semantics (requirement 6): status is 'pass' if and only if zero
// errors were recorded. Incomplete input throws before reconciliation;
// incomplete STATE (rows still planned/provisioned, unresolved conflicts)
// produces errors ⇒ 'fail'. Flags are documented advisory findings that
// never mask or replace an error.

import { ManifestBuildError, UUID_RE, sha256Hex } from './build-manifest.mjs';
import { validateProvisionRows, STATUSES } from './provision-users.mjs';
import { canonicalJson, validateImportDocs } from './import-user-data.mjs';

/**
 * Documented contract + ambiguities (requirement: document ambiguity rather
 * than inventing a rule silently). Pinned by tests.
 */
export const RECONCILIATION_NOTES = [
  'Gate target state (plan §5.3 lists gates after provisioning + import, but names no per-row target): rows must be data_imported or verified (present in Auth + user_data), or skipped (absent everywhere); planned/provisioned rows fail with INCOMPLETE_STATE and conflict rows fail with UNRESOLVED_CONFLICT.',
  'firebase_uid_map writer (plan §3.1 mirrors the manifest, yet no O1–O3 tool writes the table and no plan step specifies the population mechanism): O4 validates map ≡ manifest as E15 requires; how map rows get written/synced at L8 remains an open plan question.',
  'Payload "sizes must match exactly" (plan §5.3) vs JSONB normalization: byte-size equality is NOT enforced; the enforced checks are canonical-JSON deep equality plus exact top-level key-set equality (and the export sha256 verified at input time).',
  'Set wording "mapping rows (minus explicit skips)" (plan §5.3): skipped rows must be ABSENT from firebase_uid_map/Auth/user_data; conflict rows must be PRESENT in firebase_uid_map with status conflict (still failing the gate until manually reconciled, because E1/V1.3 may re-pin them).',
  'RLS, auth-flow, and app-smoke gates of plan §5.3 are live-session checks — out of scope here; they remain L3/L4 steps (supabase/README.md post-apply checks).',
  'Email / provider_hint drift: plan V2 keeps table email updatable and advisory-only (identity is firebase_uid → supabase_uuid), so drift is reported as a FLAG (compared only when both sides are present, never printed) while identity mismatches are errors.',
  'Users with no Firestore document: plan §4.1 imports only rows that have an exported document, and O3 refuses provisioned rows without one; the terminal manifest status for doc-less users is not specified anywhere — at gate time every non-skipped row is expected to have its export document (DOC_MISSING otherwise).',
  'updated_at / revision at read-back: plan fixes updated_at = export savedAt and revision monotonic at import, but defines no gate-time tolerance; schema_version must be 1 (error otherwise), a non-finite/negative revision is an error, updated_at drift and revision > 0 are flags (post-import writes are legal after cutover).'
];

const PENDING_STATUSES = new Set(['planned', 'provisioned']);
const AUTH_EXPECTED_STATUSES = new Set(['provisioned', 'data_imported', 'verified']);
const DATA_EXPECTED_STATUSES = new Set(['data_imported', 'verified']);

const isObj = v => typeof v === 'object' && v !== null && !Array.isArray(v);
const err = (category, detail, extra = {}) => ({ category, detail, ...extra });
const flag = (category, detail, extra = {}) => ({ category, detail, ...extra });

function requireBackend(backend) {
  if (!isObj(backend)) throw new TypeError('runValidation requires an injected read-only backend with listMapRows, listAuthUsers, listUserData functions');
  for (const m of ['listMapRows', 'listAuthUsers', 'listUserData']) {
    if (typeof backend[m] !== 'function') throw new TypeError(`backend.${m} must be a function`);
  }
}

async function readList(backend, method) {
  try {
    const list = await backend[method]();
    if (!Array.isArray(list)) throw new Error('did not return an array');
    return list;
  } catch (e) {
    throw new ManifestBuildError([`backend ${method} read failed: ${(e && e.message) || e}`]);
  }
}

/** Shape-validate backend lists before reconciliation (throw together). */
function validateBackendRows(mapRows, authUsers, userRows) {
  const errors = [];
  mapRows.forEach((r, i) => {
    const w = `map row ${i + 1}`;
    if (!isObj(r)) return errors.push(`${w}: expected an object`);
    if (typeof r.firebase_uid !== 'string' || !r.firebase_uid) errors.push(`${w}: missing firebase_uid`);
    if (typeof r.supabase_uuid !== 'string' || !UUID_RE.test(r.supabase_uuid)) errors.push(`${w}: supabase_uuid must be a UUID`);
    if (typeof r.status !== 'string' || !STATUSES.includes(r.status)) errors.push(`${w}: status must be one of ${STATUSES.join('|')}`);
    for (const k of ['email', 'provider_hint']) {
      if (k in r && typeof r[k] !== 'string') errors.push(`${w}: ${k} must be a string when present`);
    }
  });
  authUsers.forEach((u, i) => {
    const w = `auth user ${i + 1}`;
    if (!isObj(u)) return errors.push(`${w}: expected an object`);
    if (typeof u.id !== 'string' || !u.id) errors.push(`${w}: missing id`);
    if ('email' in u && u.email !== undefined && u.email !== null && typeof u.email !== 'string') errors.push(`${w}: email must be a string when present`);
    if ('app_metadata' in u && u.app_metadata !== null && u.app_metadata !== undefined && !isObj(u.app_metadata)) errors.push(`${w}: app_metadata must be an object when present`);
  });
  userRows.forEach((r, i) => {
    const w = `user_data row ${i + 1}`;
    if (!isObj(r)) return errors.push(`${w}: expected an object`);
    if (typeof r.user_id !== 'string' || !UUID_RE.test(r.user_id)) errors.push(`${w}: user_id must be a UUID`);
    if (!isObj(r.payload)) errors.push(`${w}: payload must be a JSON object`);
    if (typeof r.schema_version !== 'number') errors.push(`${w}: schema_version must be a number`);
    if (typeof r.revision !== 'number') errors.push(`${w}: revision must be a number`);
    if (typeof r.updated_at !== 'string' || !r.updated_at) errors.push(`${w}: updated_at must be a string`);
  });
  if (errors.length) throw new ManifestBuildError(errors);
}

function dupKeys(values) {
  const seen = new Map();
  const dups = new Set();
  for (const v of values) {
    if (seen.has(v)) dups.add(v);
    else seen.set(v, true);
  }
  return dups;
}

function differingTopKeys(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const diff = [];
  for (const k of [...keys].sort()) {
    const av = Object.keys(a).includes(k);
    const bv = Object.keys(b).includes(k);
    if (av !== bv) continue; // key-set handled separately
    if (canonicalJson(a[k]) !== canonicalJson(b[k])) diff.push(k);
  }
  return diff;
}

/**
 * Four-way reconciliation against an injected read-only backend.
 *
 * @param {object}   args.rows     Manifest entries (raw objects or {rec,where}).
 * @param {object[]} args.docs     Export documents {uid, savedAt, sha256, data}.
 * @param {object}   args.backend  { listMapRows, listAuthUsers, listUserData }.
 * @returns {Promise<object>} redacted report { status, counts, countIdentity, errors, flags }.
 */
export async function runValidation({ rows, docs, backend } = {}) {
  requireBackend(backend);

  // 1) Local inputs validated and thrown (together per source) before any read.
  const manifest = validateProvisionRows(rows);
  const exportDocs = validateImportDocs(docs);
  const docByUid = new Map(exportDocs.map(d => [d.uid, d]));

  // 2) Read-only backend fetches (fake in tests; no transport exists here).
  const mapRows = await readList(backend, 'listMapRows');
  const authUsers = await readList(backend, 'listAuthUsers');
  const userRows = await readList(backend, 'listUserData');
  validateBackendRows(mapRows, authUsers, userRows);

  const errors = [];
  const flags = [];
  const payloadChecks = [];
  const byUid = new Map(manifest.map(r => [r.firebase_uid, r]));
  const pinByUid = new Map(manifest.map(r => [r.firebase_uid, r.supabase_uuid]));
  const uidByPin = new Map(manifest.map(r => [r.supabase_uuid, r.firebase_uid]));

  const skipped = manifest.filter(r => r.status === 'skipped');
  const conflicts = manifest.filter(r => r.status === 'conflict');
  const pending = manifest.filter(r => PENDING_STATUSES.has(r.status));

  // 3) State completeness first: the gate target is post-import.
  for (const r of pending) {
    errors.push(err(
      'INCOMPLETE_STATE',
      `manifest row still "${r.status}" — gate target requires data_imported/verified (or skipped) before this gate can pass`,
      { firebase_uid: r.firebase_uid, supabase_uuid: r.supabase_uuid }
    ));
  }
  for (const r of conflicts) {
    errors.push(err(
      'UNRESOLVED_CONFLICT',
      'manifest status conflict — resolve manually (E1/V1.3 may re-pin supabase_uuid) before the gate can pass',
      { firebase_uid: r.firebase_uid, supabase_uuid: r.supabase_uuid }
    ));
  }

  // ── Source A: firebase_uid_map ──────────────────────────────────────────
  const expectedMapUids = new Set(manifest.filter(r => r.status !== 'skipped').map(r => r.firebase_uid));
  const mapDupUid = dupKeys(mapRows.map(r => r.firebase_uid));
  for (const u of mapDupUid) errors.push(err('DUPLICATE_MAP_ROW', `firebase_uid "${u}" appears ${mapRows.filter(r => r.firebase_uid === u).length} times in firebase_uid_map`, { firebase_uid: u }));
  const mapDupPin = dupKeys(mapRows.map(r => r.supabase_uuid));
  for (const p of mapDupPin) errors.push(err('DUPLICATE_MAP_ROW', `supabase_uuid "${p}" appears in more than one firebase_uid_map row`, { supabase_uuid: p, firebase_uid: uidByPin.get(p) }));

  const mapByUid = new Map();
  for (const r of mapRows) if (!mapByUid.has(r.firebase_uid)) mapByUid.set(r.firebase_uid, r);

  for (const r of manifest) {
    if (r.status === 'skipped') continue;
    const m = mapByUid.get(r.firebase_uid);
    if (!m) {
      errors.push(err('MAP_MISSING', `manifest row (status ${r.status}) has no firebase_uid_map row`, { firebase_uid: r.firebase_uid, supabase_uuid: r.supabase_uuid }));
      continue;
    }
    if (m.supabase_uuid !== r.supabase_uuid) {
      errors.push(err('MAP_PIN_MISMATCH', `firebase_uid_map supabase_uuid differs from the manifest pin for this firebase_uid`, { firebase_uid: r.firebase_uid, supabase_uuid: r.supabase_uuid, found: m.supabase_uuid }));
    }
    if (m.status !== r.status) {
      errors.push(err('MAP_STATUS_MISMATCH', `firebase_uid_map status "${m.status}" differs from manifest status "${r.status}"`, { firebase_uid: r.firebase_uid }));
    }
    if ('provider_hint' in m && typeof m.provider_hint === 'string' && m.provider_hint !== r.provider_hint) {
      flags.push(flag('PROVIDER_DRIFT', 'firebase_uid_map provider_hint differs from the manifest (advisory, not identity)', { firebase_uid: r.firebase_uid }));
    }
    if (typeof m.email === 'string' && m.email !== r.email) {
      flags.push(flag('EMAIL_DRIFT', 'firebase_uid_map email differs from the manifest email (advisory; values never printed)', { firebase_uid: r.firebase_uid }));
    }
  }
  for (const r of mapRows) {
    if (skipped.some(s => s.firebase_uid === r.firebase_uid)) {
      errors.push(err('MAP_UNEXPECTED', 'skipped manifest row present in firebase_uid_map — plan §5.3 expects skips absent ("minus explicit skips")', { firebase_uid: r.firebase_uid }));
      continue;
    }
    if (byUid.has(r.firebase_uid)) continue;
    errors.push(err('MAP_ORPHAN', 'firebase_uid_map row has no manifest entry (orphaned mapping)', { firebase_uid: r.firebase_uid, supabase_uuid: r.supabase_uuid }));
  }

  // ── Source B: Supabase Auth users (app_metadata.firebase_uid) ───────────
  const expectedAuthPins = new Set(manifest.filter(r => AUTH_EXPECTED_STATUSES.has(r.status)).map(r => r.supabase_uuid));
  const claimOwners = new Map(); // firebase_uid → [auth ids]
  for (const u of authUsers) {
    const claim = isObj(u.app_metadata) ? u.app_metadata.firebase_uid : undefined;
    if (typeof claim === 'string' && claim) {
      if (!claimOwners.has(claim)) claimOwners.set(claim, []);
      claimOwners.get(claim).push(u.id);
    }
  }
  for (const [claim, ids] of claimOwners) {
    if (ids.length > 1) {
      errors.push(err('DUPLICATE_AUTH_CLAIM', `app_metadata.firebase_uid "${claim}" is claimed by ${ids.length} auth users (ids: ${ids.join(', ')})`, { firebase_uid: byUid.has(claim) ? claim : undefined, supabase_uuid: byUid.has(claim) ? byUid.get(claim).supabase_uuid : undefined }));
    }
  }
  const authById = new Map(authUsers.map(u => [u.id, u]));
  for (const r of manifest) {
    const present = authById.get(r.supabase_uuid);
    const expected = AUTH_EXPECTED_STATUSES.has(r.status);
    if (!present) {
      if (expected) {
        errors.push(err('AUTH_MISSING', `manifest row (status ${r.status}) has no auth user for its pin`, { firebase_uid: r.firebase_uid, supabase_uuid: r.supabase_uuid }));
      }
      continue; // absent + not expected = correct; present + not expected = excluded (loop below)
    }
    if (!expected) continue; // presence of excluded pins is reported in the authUsers pass
    const claim = isObj(present.app_metadata) ? present.app_metadata.firebase_uid : undefined;
    if (typeof claim !== 'string' || !claim) {
      errors.push(err('AUTH_CLAIM_MISSING', 'auth user for the manifest pin has no app_metadata.firebase_uid claim', { firebase_uid: r.firebase_uid, supabase_uuid: r.supabase_uuid }));
    } else if (claim !== r.firebase_uid) {
      const owner = byUid.get(claim);
      errors.push(err('AUTH_CLAIM_MISMATCH', `auth user's firebase_uid claim belongs to ${owner ? 'a different manifest identity' : 'no manifest identity'} — identity pin conflict`, { firebase_uid: r.firebase_uid, supabase_uuid: r.supabase_uuid, claim, claim_manifest_pin: owner ? owner.supabase_uuid : null }));
    }
    if (typeof present.email === 'string' && typeof r.email === 'string' && present.email.toLowerCase() !== r.email.toLowerCase()) {
      flags.push(flag('EMAIL_DRIFT', 'auth user email differs from the manifest email (advisory; values never printed)', { firebase_uid: r.firebase_uid }));
    }
  }
  for (const u of authUsers) {
    if (expectedAuthPins.has(u.id)) continue;
    const owner = uidByPin.get(u.id);
    if (owner !== undefined) {
      const st = byUid.get(owner).status;
      errors.push(err('AUTH_EXCLUDED_ROW', `auth user exists for a pin whose manifest status is "${st}" (must be absent until provisioned/data_imported)`, { firebase_uid: owner, supabase_uuid: u.id }));
    } else {
      errors.push(err('AUTH_ORPHAN', 'auth user id matches no manifest pin (orphaned or leftover account — reconcile per D-9/E1/E2 before gating)', { supabase_uuid: u.id }));
    }
  }

  // ── Source C: user_data rows ────────────────────────────────────────────
  const expectedDataPins = new Set(manifest.filter(r => DATA_EXPECTED_STATUSES.has(r.status)).map(r => r.supabase_uuid));
  const dataDupPins = dupKeys(userRows.map(r => r.user_id));
  for (const p of dataDupPins) errors.push(err('DUPLICATE_DATA_ROW', `user_id "${p}" appears ${userRows.filter(r => r.user_id === p).length} times in user_data`, { supabase_uuid: p, firebase_uid: uidByPin.get(p) }));
  const rowByPin = new Map();
  for (const r of userRows) if (!rowByPin.has(r.user_id)) rowByPin.set(r.user_id, r);

  for (const r of manifest) {
    const row = rowByPin.get(r.supabase_uuid);
    if (DATA_EXPECTED_STATUSES.has(r.status)) {
      if (!row) {
        errors.push(err('DATA_MISSING', `manifest row (status ${r.status}) has no user_data row`, { firebase_uid: r.firebase_uid, supabase_uuid: r.supabase_uuid }));
        continue;
      }
      // Row present: field contract.
      if (row.schema_version !== 1) {
        errors.push(err('SCHEMA_VERSION', `user_data schema_version is ${row.schema_version}, expected 1`, { firebase_uid: r.firebase_uid, supabase_uuid: r.supabase_uuid }));
      }
      if (!Number.isFinite(row.revision) || row.revision < 0) {
        errors.push(err('MALFORMED_ROW', 'user_data revision must be a finite non-negative number', { firebase_uid: r.firebase_uid, supabase_uuid: r.supabase_uuid }));
      } else if (row.revision > 0) {
        flags.push(flag('REVISION_ADVANCED', `user_data revision is ${row.revision} (0 at import; >0 implies a post-import write)`, { firebase_uid: r.firebase_uid, supabase_uuid: r.supabase_uuid }));
      }
      // Payload integrity vs the export document (canonical JSON, key sets).
      const doc = docByUid.get(r.firebase_uid);
      if (!doc) {
        errors.push(err('DOC_MISSING', 'manifest row was imported but its export document is absent from the export set', { firebase_uid: r.firebase_uid, supabase_uuid: r.supabase_uuid }));
        continue;
      }
      const exportSemanticSha = sha256Hex(canonicalJson(doc.data));
      const readBackSemanticSha = sha256Hex(canonicalJson(row.payload));
      const expKeys = Object.keys(doc.data).sort();
      const gotKeys = Object.keys(row.payload).sort();
      const missing = expKeys.filter(k => !gotKeys.includes(k));
      const added = gotKeys.filter(k => !expKeys.includes(k));
      const semanticMatch = exportSemanticSha === readBackSemanticSha;
      payloadChecks.push({ firebase_uid: r.firebase_uid, supabase_uuid: r.supabase_uuid, exportSha256: doc.sha256, exportSemanticSha, readBackSemanticSha, semanticMatch });
      if (missing.length || added.length) {
        errors.push(err('PAYLOAD_KEYSET', `top-level key set differs${missing.length ? `; missing from read-back: [${missing.join(', ')}]` : ''}${added.length ? `; added in read-back: [${added.join(', ')}]` : ''}`, { firebase_uid: r.firebase_uid, supabase_uuid: r.supabase_uuid }));
      } else if (!semanticMatch) {
        const diffKeys = differingTopKeys(doc.data, row.payload);
        errors.push(err('PAYLOAD_DIFFER', `canonical JSON payload differs from the export under identical top-level keys${diffKeys.length ? `; differing keys: [${diffKeys.slice(0, 5).join(', ')}]` : ''} (values never printed)`, { firebase_uid: r.firebase_uid, supabase_uuid: r.supabase_uuid }));
      }
      const expectedUpdatedAt = new Date(doc.savedAt).toISOString();
      if (row.updated_at !== expectedUpdatedAt) {
        flags.push(flag('UPDATED_AT_DRIFT', `user_data.updated_at differs from the import-time value (export savedAt ${expectedUpdatedAt})`, { firebase_uid: r.firebase_uid, supabase_uuid: r.supabase_uuid }));
      }
    } else if (row) {
      errors.push(err('DATA_EXCLUDED_ROW', `user_data row exists for a pin whose manifest status is "${r.status}" (must be absent until data_imported)`, { firebase_uid: r.firebase_uid, supabase_uuid: r.supabase_uuid }));
    }
  }
  for (const r of userRows) {
    if (uidByPin.has(r.user_id)) continue;
    errors.push(err('DATA_ORPHAN', 'user_data row matches no manifest pin (orphaned row)', { supabase_uuid: r.user_id }));
  }

  // ── Source D: export documents (count identity with imported rows) ─────
  const expectedDocUids = new Set(manifest.filter(r => DATA_EXPECTED_STATUSES.has(r.status)).map(r => r.firebase_uid));
  for (const uid of expectedDocUids) {
    if (!docByUid.has(uid)) {
      // (already reported as DOC_MISSING above when a row existed; report when neither exists)
      if (!errors.some(e => e.category === 'DOC_MISSING' && e.firebase_uid === uid)) {
        errors.push(err('DOC_MISSING', 'imported manifest row has no export document', { firebase_uid: uid, supabase_uuid: byUid.get(uid).supabase_uuid }));
      }
    }
  }
  for (const d of exportDocs) {
    if (!byUid.has(d.uid)) {
      errors.push(err('DOC_ORPHAN', 'export document uid has no manifest entry (orphaned document)', { firebase_uid: d.uid }));
    }
  }

  // ── Count identity (plan §5.3) ─────────────────────────────────────────
  const counts = {
    manifestTotal: manifest.length,
    skipped: skipped.length,
    conflict: conflicts.length,
    pending: pending.length,
    expectedMap: expectedMapUids.size,
    actualMap: mapRows.length,
    expectedAuth: expectedAuthPins.size,
    actualAuth: authUsers.length,
    expectedData: expectedDataPins.size,
    actualData: userRows.length,
    expectedDocs: expectedDocUids.size,
    exportDocs: exportDocs.length,
    errors: errors.length,
    flags: flags.length
  };
  const countIdentity = {
    map: counts.actualMap === counts.expectedMap,
    auth: counts.actualAuth === counts.expectedAuth,
    data: counts.actualData === counts.expectedData,
    docsForImported: [...expectedDocUids].every(uid => docByUid.has(uid))
  };

  return {
    status: errors.length === 0 ? 'pass' : 'fail',
    targetState: 'non-skipped rows at data_imported/verified; skipped absent from map, Auth, and user_data',
    counts,
    countIdentity,
    payloadChecks,
    errors,
    flags
  };
}
