#!/usr/bin/env node
// ── LIFTS Phase 3a: offline migration-manifest builder ─────────────────────
//
// Reads ONE local Firebase Auth export (JSONL lines, or a JSON array) and
// prints a deterministic firebase_uid → supabase_uuid migration manifest
// (JSONL) to stdout or to --out <path>.
//
//   node scripts/migration/build-manifest.mjs <auth-export.jsonl> [--out <path>]
//
// Safety contract (docs/phase-3-auth-migration-plan.md, Phase 3a):
//   * OFFLINE ONLY — plain file I/O, no network, no Firebase or Supabase SDK,
//     no user provisioning, no data migration. This tool only plans.
//   * Deterministic and safe to rerun: rows are keyed by firebase_uid and
//     sorted, so the same export always yields byte-identical output; pins are
//     derived (RFC 4122 UUIDv5 from the Firebase UID under a fixed project
//     namespace) or taken from an explicit supabase_uuid field — never
//     regenerated at random, so a rerun can never silently change pins.
//     For the same reason the manifest carries NO timestamps (a migrated_at
//     column is added by later phases when rows actually migrate).
//   * Never guesses from email: the pin depends only on the firebase_uid (or
//     an explicit supabase_uuid override for adopting an existing account).
//     Missing/duplicate/malformed/conflicting inputs fail the whole build
//     with per-record errors — nothing is dropped or invented.
//   * Exactly one mapping per firebase_uid and one-to-one unique
//     supabase_uuids are enforced here AND again by the firebase_uid_map
//     table's primary/unique keys.
//   * Real exports/manifests contain PII: keep them OUTSIDE this repository
//     (.gitignore covers exports/, manifests/ and friends). --out refuses to
//     write inside the repository.
//
// Exit codes: 0 success · 1 validation failure · 2 usage / I-O / policy error.
//
// Trusted tooling access to public.firebase_uid_map (see the migration file):
// runs outside the browser as service_role with the key from the local
// environment; the browser only ever holds the publishable key, and this
// table denies anon/authenticated by default (RLS enabled, zero policies).

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Same shape as the Phase 2 adapter's UUID_RE (js/supabase-data.js):
// version 1–8, RFC 4122 variant — accepts v4 pins and our v5-derived pins.
export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Fixed project namespace for name-based pins. NOT a secret and never
// changed: pin derivation must stay stable across reruns and machines.
const PIN_NAMESPACE = '6e7a1c90-3f2d-4b18-9c47-2a5d8e0f1b64';

const KNOWN_PROVIDERS = new Set(['password', 'google.com']);
const STATUSES = ['planned', 'provisioned', 'data_imported', 'verified', 'conflict', 'skipped'];
const ROW_FIELDS = ['firebase_uid', 'supabase_uuid', 'email', 'provider_hint', 'status'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class ManifestBuildError extends Error {
  constructor(errors) {
    const list = Array.isArray(errors) ? errors : [String(errors)];
    super(`manifest build failed with ${list.length} problem(s):\n${list.map(e => `  - ${e}`).join('\n')}`);
    this.name = 'ManifestBuildError';
    this.errors = list;
  }
}

class UsageError extends Error {}

/** RFC 4122 name-based UUIDv5 (SHA-1) — deterministic for a given name. */
export function uuidv5(name, namespace) {
  const ns = Buffer.from(String(namespace).replace(/-/g, ''), 'hex');
  const hash = createHash('sha1').update(Buffer.concat([ns, Buffer.from(String(name), 'utf8')])).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The pinned Supabase UUID for a Firebase UID — uid-only, never email. */
export function pinForUid(firebaseUid) {
  return uuidv5(firebaseUid, PIN_NAMESPACE);
}

/**
 * Parse a local Firebase Auth export: JSONL (one user object per non-empty
 * line) or a JSON array. Returns [{ rec, where }]; throws ManifestBuildError
 * with line numbers on malformed JSON or non-object records.
 */
export function parseExport(text) {
  const trimmed = String(text).trim();
  if (trimmed === '') return [];
  if (trimmed.startsWith('[')) {
    let arr;
    try {
      arr = JSON.parse(trimmed);
    } catch (e) {
      throw new ManifestBuildError([`invalid JSON: ${e.message}`]);
    }
    if (!Array.isArray(arr)) throw new ManifestBuildError(['expected a JSON array of user records']);
    return arr.map((rec, i) => {
      if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) {
        throw new ManifestBuildError([`record ${i + 1}: expected a JSON object`]);
      }
      return { rec, where: `record ${i + 1}` };
    });
  }
  const entries = [];
  const errors = [];
  text.split('\n').forEach((line, i) => {
    const t = line.trim();
    if (t === '') return;
    const where = `line ${i + 1}`;
    try {
      const rec = JSON.parse(t);
      if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) {
        errors.push(`${where}: expected a JSON object`);
      } else {
        entries.push({ rec, where });
      }
    } catch (e) {
      errors.push(`${where}: invalid JSON (${e.message})`);
    }
  });
  if (errors.length) throw new ManifestBuildError(errors);
  return entries;
}

function providerHint(rec, where, errors) {
  if (!Array.isArray(rec.providerData)) {
    errors.push(`${where}: missing provider data (expected a Firebase Auth "providerData" array)`);
    return null;
  }
  const ids = [];
  for (const p of rec.providerData) {
    const id = p && typeof p === 'object' && typeof p.providerId === 'string' ? p.providerId : null;
    if (id === null) {
      errors.push(`${where}: malformed providerData entry (string providerId required)`);
      return null;
    }
    if (!KNOWN_PROVIDERS.has(id)) {
      errors.push(`${where}: unsupported sign-in provider "${id}" — handle this account manually (nothing is inferred)`);
      return null;
    }
    if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length === 0) {
    errors.push(`${where}: no supported sign-in providers (anonymous or unknown) — exclude and review manually per plan E9`);
    return null;
  }
  // Stable order: password first, then google.com → password+google.com
  const ordered = [];
  if (ids.includes('password')) ordered.push('password');
  if (ids.includes('google.com')) ordered.push('google.com');
  return ordered.join('+');
}

/**
 * Validate entries and build manifest rows. All-or-nothing: any problem
 * throws ManifestBuildError listing every rejection (missing, duplicate,
 * malformed, conflicting). Entries come from parseExport(), or plain objects
 * are accepted and labelled "record N".
 */
export function buildManifest(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new ManifestBuildError(['export contains no user records — refusing to build an empty manifest']);
  }
  const errors = [];
  const candidates = [];

  entries.forEach((entry, i) => {
    let rec = entry;
    let where = `record ${i + 1}`;
    if (entry && typeof entry === 'object' && !Array.isArray(entry)
        && 'rec' in entry && typeof entry.where === 'string') {
      rec = entry.rec;
      where = entry.where;
    }
    if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) {
      errors.push(`${where}: expected a JSON object record`);
      return;
    }
    const before = errors.length;

    // firebase uid — the ONLY basis for a derived pin
    let uid = null;
    if (typeof rec.uid !== 'string' || rec.uid.trim() === '') {
      errors.push(`${where}: missing firebase uid (a mapping must be keyed by uid, never inferred)`);
    } else if (rec.uid !== rec.uid.trim() || /\s/.test(rec.uid)) {
      errors.push(`${where}: malformed firebase uid (unexpected whitespace)`);
    } else {
      uid = rec.uid;
    }

    // email — required for the row and for conflict checks, never a pin source
    let email = null;
    if (typeof rec.email !== 'string' || rec.email.trim() === '') {
      errors.push(`${where}: missing email`);
    } else if (!EMAIL_RE.test(rec.email.trim())) {
      errors.push(`${where}: malformed email "${rec.email}"`);
    } else {
      email = rec.email.trim().toLowerCase();
    }

    const hint = providerHint(rec, where, errors);

    // optional explicit pin (adopting an existing Supabase account)
    let override = null;
    if (Object.prototype.hasOwnProperty.call(rec, 'supabase_uuid') && rec.supabase_uuid !== undefined) {
      if (typeof rec.supabase_uuid !== 'string' || !UUID_RE.test(rec.supabase_uuid)) {
        errors.push(`${where}: malformed supabase_uuid "${rec.supabase_uuid}" (expected a RFC 4122 UUID)`);
      } else {
        override = rec.supabase_uuid.toLowerCase();
      }
    }

    if (errors.length === before && uid && email && hint) {
      candidates.push({ rec, where, uid, email, hint, override, disabled: rec.disabled === true });
    }
  });

  // Global one-to-one checks across all candidate rows
  const byUid = new Map();
  const byEmail = new Map();
  const byUuid = new Map();
  for (const c of candidates) {
    if (byUid.has(c.uid)) {
      errors.push(`duplicate firebase uid "${c.uid}" (${byUid.get(c.uid)} and ${c.where}) — exactly one mapping per uid is required`);
    } else {
      byUid.set(c.uid, c.where);
    }
    if (byEmail.has(c.email) && byEmail.get(c.email).uid !== c.uid) {
      errors.push(`conflicting mapping: email "${c.email}" is claimed by firebase uid "${byEmail.get(c.email).uid}" (${byEmail.get(c.email).where}) and "${c.uid}" (${c.where}) — refusing to guess identity from email`);
    } else if (!byEmail.has(c.email)) {
      byEmail.set(c.email, { uid: c.uid, where: c.where });
    }
    const uuid = c.override || pinForUid(c.uid);
    if (byUuid.has(uuid) && byUuid.get(uuid).uid !== c.uid) {
      errors.push(`duplicate supabase uuid "${uuid}" for firebase uid "${byUuid.get(uuid).uid}" (${byUuid.get(uuid).where}) and "${c.uid}" (${c.where}) — supabase_uuid must be one-to-one`);
    } else if (!byUuid.has(uuid)) {
      byUuid.set(uuid, { uid: c.uid, where: c.where });
    }
  }

  if (errors.length) throw new ManifestBuildError(errors);

  const rows = candidates.map(c => {
    const row = {
      firebase_uid: c.uid,
      supabase_uuid: c.override || pinForUid(c.uid),
      email: c.email,
      provider_hint: c.hint,
      status: c.disabled ? 'skipped' : 'planned'
    };
    for (const field of ROW_FIELDS) {
      if (!(field in row)) throw new Error(`internal: row missing ${field}`);
    }
    return row;
  });
  rows.sort((a, b) => (a.firebase_uid < b.firebase_uid ? -1 : a.firebase_uid > b.firebase_uid ? 1 : 0));

  const byStatus = Object.fromEntries(STATUSES.map(s => [s, 0]));
  for (const r of rows) byStatus[r.status] += 1;
  return { rows, summary: { total: rows.length, byStatus } };
}

/** Text → parsed + built in one step (what the CLI uses). */
export function buildManifestFromText(text) {
  return buildManifest(parseExport(text));
}

/** Rows → deterministic JSONL text (fixed field order, trailing newline). */
export function formatManifest(rows) {
  return rows.map(r => JSON.stringify(r)).join('\n') + '\n';
}

export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const USAGE = 'usage: node scripts/migration/build-manifest.mjs <auth-export.jsonl|export.json> [--out <path-outside-repo>]';

function parseArgs(argv) {
  const opts = { input: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') return { help: true };
    if (a === '--out') {
      if (i + 1 >= argv.length) throw new UsageError('--out requires a path');
      opts.out = argv[++i];
      continue;
    }
    if (a.startsWith('--out=')) {
      opts.out = a.slice('--out='.length);
      if (!opts.out) throw new UsageError('--out requires a path');
      continue;
    }
    if (a.startsWith('-')) throw new UsageError(`unknown option "${a}"\n${USAGE}`);
    if (opts.input !== null) throw new UsageError(`unexpected extra argument "${a}"\n${USAGE}`);
    opts.input = a;
  }
  if (!opts.input) throw new UsageError(`missing input file\n${USAGE}`);
  return opts;
}

function insideRepo(target) {
  const rel = path.relative(REPO_ROOT, target);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  let text;
  try {
    text = readFileSync(path.resolve(opts.input), 'utf8');
  } catch (e) {
    throw new UsageError(`cannot read export "${opts.input}": ${e.message}`);
  }

  const { rows, summary } = buildManifestFromText(text);
  const manifest = formatManifest(rows);
  const sha = sha256Hex(manifest);
  const counts = STATUSES.map(s => `${s}=${summary.byStatus[s]}`).join(' ');

  if (opts.out !== null) {
    const outAbs = path.resolve(opts.out);
    if (insideRepo(outAbs)) {
      throw new UsageError(`refusing to write inside the repository (${outAbs}) — keep real manifests and exports outside the repository (see .gitignore / docs/phase-3-auth-migration-plan.md)`);
    }
    if (path.resolve(opts.input) === outAbs) {
      throw new UsageError('--out must not overwrite the input export');
    }
    writeFileSync(outAbs, manifest, 'utf8');
    process.stderr.write(`wrote ${rows.length} rows to ${outAbs}\n`);
  } else {
    process.stdout.write(manifest);
  }
  process.stderr.write(`manifest: total=${summary.total} ${counts} sha256=${sha}\n`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    if (e instanceof ManifestBuildError) {
      e.errors.forEach(msg => process.stderr.write(`error: ${msg}\n`));
      process.stderr.write(`${e.message}\n`);
      process.exit(1);
    }
    if (e instanceof UsageError) {
      process.stderr.write(`usage error: ${e.message}\n`);
      process.exit(2);
    }
    process.stderr.write(`internal error: ${e && e.stack ? e.stack : e}\n`);
    process.exit(1);
  }
}
