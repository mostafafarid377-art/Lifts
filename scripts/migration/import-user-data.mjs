#!/usr/bin/env node
// ── LIFTS Phase 3c (O3): offline user_data import runner core ──────────────
//
// SAFETY CONTRACT (docs/phase-3c-remaining-work-plan.md, O3):
//   * OFFLINE ONLY — this build contains NO network primitives. The backend
//     is always an injected call(method, href, opts) function; tests use an
//     in-memory fake. The CLI refuses live execution (exit 2) and supports
//     only a read-only --dry-run that validates and prints a plan. Wiring a
//     real Data API transport is a separate Track-L approval (L8) — not in
//     this file. No credentials, no SQL execution, no Firebase or Supabase
//     contact, no real user data: fixtures are synthetic by construction.
//   * The CLI never writes files (input manifest/export are read-only), and
//     neither CLI nor reports ever print payload contents, passwords, tokens,
//     keys, or unmasked emails — only ids, masked emails, checksums, and
//     fixed status strings.
//   * Opaque payload preservation (plan §4.1 / adapter contract): the export
//     document's `data` object is passed through BY REFERENCE into the write
//     operation — never whitelisted, normalized, reordered, or dropped, so
//     unknown/legacy fields survive verbatim. A representation returned by
//     the backend is checked semantically (canonical JSON) against the
//     source; a genuine mutation halts the run.
//   * Identity: user_id comes ONLY from the manifest row whose firebase_uid
//     matches the export document's uid — never from email (plan §3.2/§4.1).
//   * FK ordering (plan §4.1/§5.3): only rows with status 'provisioned' are
//     imported (the auth user must exist first); 'planned' rows wait
//     ('awaiting-provisioning'); 'data_imported'/'verified' rows are rerun
//     skips; 'skipped'/'conflict' rows are never imported (E7).
//   * Checksums (plan §4.1(d)/§5.2): every export record carries
//     sha256 = sha256Hex(JSON.stringify(data)) — THE export contract for the
//     future L7 exporter — verified before any write; the source checksum is
//     echoed into the report for the later post-import gate (O4/L8).
//   * Set mismatches refuse the whole run BEFORE any write (plan §4.1(c)):
//     every export uid must have a manifest row, and every 'provisioned'
//     manifest row must have an export document; duplicate uids (manifest or
//     export) and checksum conflicts are all reported together.
//   * Idempotency + partial failures: reruns (updated statuses) write
//     nothing; a failed row keeps status 'provisioned' for a safe resume;
//     transient failures retry with exponential backoff then halt with the
//     remaining rows 'not-run'. Nothing is ever deleted — no DELETE method
//     exists here, and source manifest/export files are untouched.
//
// Manifest format preserved exactly (build-manifest.mjs); export contract:
// JSONL (or JSON array) of { uid, savedAt, sha256, data[, updateTime] }.
//
// Exit codes: 0 success · 1 validation failure · 2 usage / policy error.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ManifestBuildError, sha256Hex } from './build-manifest.mjs';
import { parseManifestText, validateProvisionRows, redactEmail, attemptCall } from './provision-users.mjs';

export const EXPORT_FIELDS = ['uid', 'savedAt', 'sha256', 'data', 'updateTime'];
export const USER_DATA_PATH = '/rest/v1/user_data';
const IMPORTABLE_FROM = 'provisioned';
const DONE_STATUSES = new Set(['data_imported', 'verified']);
const EXCLUDED_STATUSES = new Set(['skipped', 'conflict']);
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_MS = 250;
const SHA256_RE = /^[0-9a-f]{64}$/;
const MAX_DATE_MS = 8.64e15; // Date finiteness bound

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const sleep = ms => new Promise(res => setTimeout(res, ms));

/** Semantic JSON equality helper: keys sorted recursively (JSONB-safe). */
export function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (isObj(value)) {
    return '{' + Object.keys(value).sort()
      .map(k => JSON.stringify(k) + ':' + canonicalJson(value[k]))
      .join(',') + '}';
  }
  return JSON.stringify(value);
}

/**
 * Parse an export file: JSONL lines or one JSON array (same policy as
 * build-manifest parseExport). All problems reported together with labels.
 */
export function parseExportDocs(text) {
  const trimmed = String(text).trim();
  if (trimmed === '') return [];
  if (trimmed.startsWith('[')) {
    let arr;
    try {
      arr = JSON.parse(trimmed);
    } catch (e) {
      throw new ManifestBuildError([`export: invalid JSON: ${e.message}`]);
    }
    if (!Array.isArray(arr)) throw new ManifestBuildError(['export: expected a JSON array of documents']);
    return arr.map((rec, i) => {
      if (!isObj(rec)) throw new ManifestBuildError([`doc ${i + 1}: expected a JSON object`]);
      return { rec, where: `doc ${i + 1}` };
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
      if (!isObj(rec)) errors.push(`${where}: expected a JSON object`);
      else entries.push({ rec, where });
    } catch (e) {
      errors.push(`${where}: invalid JSON (${e.message})`);
    }
  });
  if (errors.length) throw new ManifestBuildError(errors);
  return entries;
}

/**
 * Validate export documents, collecting every problem. Returns candidates
 * sorted by uid, or null when any error exists. sha256 is verified against
 * sha256Hex(JSON.stringify(data)) before anything is eligible to write.
 */
function collectDocs(entries, errors) {
  if (!Array.isArray(entries) || entries.length === 0) {
    errors.push('export contains no documents — refusing to run on an empty export');
    return null;
  }
  const candidates = [];
  entries.forEach((entry, i) => {
    let rec = entry;
    let where = `doc ${i + 1}`;
    if (isObj(entry) && 'rec' in entry && typeof entry.where === 'string') {
      rec = entry.rec;
      where = entry.where;
    }
    if (!isObj(rec)) {
      errors.push(`${where}: expected a JSON object`);
      return;
    }
    const before = errors.length;
    for (const key of Object.keys(rec)) {
      if (!EXPORT_FIELDS.includes(key)) errors.push(`${where}: unknown field "${key}" (export contract: ${EXPORT_FIELDS.join(', ')})`);
    }

    let uid = null;
    if (typeof rec.uid !== 'string' || rec.uid.trim() === '') {
      errors.push(`${where}: missing uid`);
    } else if (rec.uid !== rec.uid.trim() || /\s/.test(rec.uid)) {
      errors.push(`${where}: malformed uid (unexpected whitespace)`);
    } else {
      uid = rec.uid;
    }

    if (rec.savedAt === undefined || rec.savedAt === null) {
      errors.push(`${where}: missing savedAt`);
    } else if (!Number.isFinite(rec.savedAt) || Math.abs(rec.savedAt) > MAX_DATE_MS) {
      errors.push(`${where}: savedAt must be a finite epoch-millisecond timestamp`);
    }

    let sha = null;
    if (typeof rec.sha256 !== 'string' || !SHA256_RE.test(rec.sha256)) {
      errors.push(`${where}: missing or malformed sha256 (64 lowercase hex chars)`);
    } else {
      sha = rec.sha256.toLowerCase();
    }

    if (!isObj(rec.data)) {
      errors.push(`${where}: data must be a JSON object (the complete LIFTS payload)`);
    } else if (sha) {
      const actual = sha256Hex(JSON.stringify(rec.data));
      if (actual !== sha) {
        errors.push(`${where}: sha256 mismatch for uid "${uid || '?'}" (export record corrupted or altered — refusing)`);
      }
    }

    if (rec.updateTime !== undefined && typeof rec.updateTime !== 'string' && !Number.isFinite(rec.updateTime)) {
      errors.push(`${where}: updateTime must be a string or number when present`);
    }

    if (errors.length === before) {
      candidates.push({ uid, savedAt: rec.savedAt, sha256: sha, data: rec.data, where });
    }
  });

  const byUid = new Map();
  for (const c of candidates) {
    if (byUid.has(c.uid)) {
      errors.push(`duplicate export uid "${c.uid}" (${byUid.get(c.uid)} and ${c.where}) — exactly one document per uid`);
    } else {
      byUid.set(c.uid, c.where);
    }
  }
  if (errors.length) return null;
  candidates.sort((a, b) => (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0));
  return candidates;
}

/** Standalone document validation (throws ManifestBuildError). */
export function validateImportDocs(entries) {
  const errors = [];
  const docs = collectDocs(entries, errors);
  if (errors.length) throw new ManifestBuildError(errors);
  return docs;
}

/**
 * Full pre-write gate: validated manifest + validated export + set-identity
 * cross-checks, ALL reported together. Throws before any backend call can
 * happen (plan §4.1 no-mixing checks c/d).
 */
export function prepareImport({ rows, docs } = {}) {
  const manifest = validateProvisionRows(rows);
  const errors = [];
  const collected = collectDocs(docs, errors);

  if (collected) {
    const manifestByUid = new Map(manifest.map(r => [r.firebase_uid, r]));
    const docUids = new Set(collected.map(d => d.uid));
    for (const d of collected) {
      if (!manifestByUid.has(d.uid)) {
        errors.push(`${d.where}: export uid "${d.uid}" has no manifest row — refusing to import unmapped data`);
      }
    }
    for (const r of manifest) {
      if (r.status === IMPORTABLE_FROM && !docUids.has(r.firebase_uid)) {
        errors.push(`manifest row "${r.firebase_uid}" is provisioned but has no export document — count-identity gate (plan §5.3)`);
      }
    }
  }

  if (errors.length) throw new ManifestBuildError(errors);
  return { manifest, docs: collected };
}

/** Read-only import plan over a prepared {manifest, docs} — zero writes. */
export function planImport(manifest, docs) {
  const byUid = new Map(docs.map(d => [d.uid, d]));
  const entries = manifest.map(row => {
    const doc = byUid.get(row.firebase_uid) || null;
    let action;
    if (row.status === IMPORTABLE_FROM) action = 'import';
    else if (DONE_STATUSES.has(row.status)) action = 'skip(already-imported)';
    else if (EXCLUDED_STATUSES.has(row.status)) action = `exclude(${row.status})`;
    else action = 'await-provisioning';
    return {
      firebase_uid: row.firebase_uid,
      supabase_uuid: row.supabase_uuid,
      emailMasked: redactEmail(row.email),
      action,
      sha256: doc ? doc.sha256 : null
    };
  });
  const counts = { import: 0, 'await-provisioning': 0, 'skip(already-imported)': 0 };
  let excluded = 0;
  for (const e of entries) {
    if (e.action.startsWith('exclude(')) excluded++;
    else counts[e.action] = (counts[e.action] || 0) + 1;
  }
  return { entries, summary: { total: entries.length, documents: docs.length, ...counts, excluded } };
}

// ── Import core ────────────────────────────────────────────────────────────

function buildWrite(row, doc) {
  // Mirrors plan §4.1 insert + js/supabase-data.js save shape. Payload is
  // referenced, never copied or rewritten.
  return {
    user_id: row.supabase_uuid,
    payload: doc.data,
    schema_version: 1,
    revision: 0,
    updated_at: new Date(doc.savedAt).toISOString()
  };
}

const statusOf = res => (res && Number.isFinite(Number(res.status)) ? Number(res.status) : NaN);
const errCode = res => {
  const d = res && res.data;
  if (!isObj(d)) return null;
  return typeof d.code === 'string' ? d.code : typeof d.error_code === 'string' ? d.error_code : null;
};

function representationOf(res) {
  if (!res || res.data === undefined || res.data === null) return null;
  const d = res.data;
  if (Array.isArray(d)) return isObj(d[0]) ? d[0] : null;
  if (isObj(d) && Array.isArray(d.records)) return isObj(d.records[0]) ? d.records[0] : null;
  return isObj(d) && d.user_id !== undefined ? d : null;
}

/**
 * Import export documents into user_data against an injected backend.
 * Validates manifest + export + set identity BEFORE the first write.
 * Redacted report only: ids, masked emails, checksums, fixed strings.
 */
export async function runImport({
  rows,
  docs,
  call,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  retryBaseMs = DEFAULT_RETRY_BASE_MS,
  delay = sleep
} = {}) {
  if (typeof call !== 'function') throw new TypeError('runImport requires an injected call(method, href, opts) function');
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new TypeError('maxAttempts must be a positive integer');

  const { manifest, docs: prepared } = prepareImport({ rows, docs });
  const docByUid = new Map(prepared.map(d => [d.uid, d]));

  const results = [];
  const updates = {};
  const notes = [];
  let halted = null;
  let imported = 0;
  let alreadyImported = 0;
  let excluded = 0;
  let awaiting = 0;

  for (const row of manifest) {
    const doc = docByUid.get(row.firebase_uid);
    const base = {
      firebase_uid: row.firebase_uid,
      supabase_uuid: row.supabase_uuid,
      email: redactEmail(row.email)
    };
    if (halted) {
      results.push({ ...base, outcome: 'not-run' });
      continue;
    }
    if (DONE_STATUSES.has(row.status)) {
      alreadyImported++;
      results.push({ ...base, outcome: 'skipped-already-imported', fromStatus: row.status });
      continue;
    }
    if (EXCLUDED_STATUSES.has(row.status)) {
      excluded++;
      results.push({
        ...base, outcome: 'excluded-by-status', fromStatus: row.status,
        detail: doc ? 'export document exists but is not imported (E7)' : 'no document expected'
      });
      continue;
    }
    if (row.status !== IMPORTABLE_FROM) {
      awaiting++;
      results.push({ ...base, outcome: 'awaiting-provisioning', fromStatus: row.status, detail: 'auth user not provisioned yet — FK ordering' });
      continue;
    }
    // status === 'provisioned' → prepareImport guarantees doc exists.

    const body = buildWrite(row, doc);
    const attempt = await attemptCall(call, 'POST', USER_DATA_PATH, { body }, maxAttempts, retryBaseMs, delay);

    if (attempt.exhausted) {
      results.push({ ...base, outcome: 'failed', fromStatus: row.status, attempts: attempt.attempts, sha256: doc.sha256 });
      notes.push(`${row.firebase_uid}: transient failures exhausted after ${attempt.attempts} attempts — row left "provisioned" for a safe rerun`);
      halted = { firebase_uid: row.firebase_uid, reason: 'transient-failures-exhausted' };
      continue;
    }

    const res = attempt.res;
    const st = statusOf(res);
    if (Number.isNaN(st)) {
      results.push({ ...base, outcome: 'failed', fromStatus: row.status, attempts: attempt.attempts, sha256: doc.sha256 });
      notes.push(`${row.firebase_uid}: malformed backend response — run halted`);
      halted = { firebase_uid: row.firebase_uid, reason: 'malformed-response' };
      continue;
    }

    if (st >= 200 && st < 300) {
      const rep = representationOf(res);
      if (rep) {
        if ((rep.user_id !== undefined && rep.user_id !== row.supabase_uuid) || canonicalJson(rep.payload) !== canonicalJson(doc.data)) {
          results.push({ ...base, outcome: 'failed', fromStatus: row.status, attempts: attempt.attempts, sha256: doc.sha256, detail: 'returned row does not semantically match the source payload — run halted (no data accepted as written)' });
          notes.push(`${row.firebase_uid}: payload mutation detected in backend response — run halted`);
          halted = { firebase_uid: row.firebase_uid, reason: 'payload-mutation' };
          continue;
        }
      } else {
        notes.push(`${row.firebase_uid}: response carried no representation — payload verification deferred to the O4/L8 validation gate`);
      }
      imported++;
      results.push({ ...base, outcome: 'imported', fromStatus: row.status, toStatus: 'data_imported', attempts: attempt.attempts, sha256: doc.sha256 });
      updates[row.firebase_uid] = 'data_imported';
      continue;
    }

    const code = errCode(res);
    if (code === '23503') {
      results.push({ ...base, outcome: 'failed', fromStatus: row.status, attempts: attempt.attempts, sha256: doc.sha256, detail: 'foreign-key violation — auth user missing (FK ordering)' });
      notes.push(`${row.firebase_uid}: foreign-key violation (HTTP ${st}) — auth user must be provisioned before import; run halted`);
      halted = { firebase_uid: row.firebase_uid, reason: 'fk-violation' };
      continue;
    }

    results.push({ ...base, outcome: 'failed', fromStatus: row.status, attempts: attempt.attempts, sha256: doc.sha256, detail: `unexpected backend response (HTTP ${st}${code ? `, ${code}` : ''})` });
    notes.push(`${row.firebase_uid}: unexpected backend response (HTTP ${st}) — run halted`);
    halted = { firebase_uid: row.firebase_uid, reason: 'unexpected-response' };
  }

  const byOutcome = {};
  for (const r of results) byOutcome[r.outcome] = (byOutcome[r.outcome] || 0) + 1;
  return {
    status: halted ? 'halted' : 'ok',
    totals: {
      manifest: manifest.length,
      documents: prepared.length,
      imported,
      alreadyImported,
      excluded,
      awaitingProvisioning: awaiting,
      notRun: byOutcome['not-run'] || 0
    },
    results,
    updates,
    halted,
    notes
  };
}

// ── CLI (read-only; dry-run only in this offline build) ────────────────────

const USAGE = 'usage: node scripts/migration/import-user-data.mjs --dry-run <manifest.jsonl> <export.jsonl>';

class UsageError extends Error {}

function parseArgs(argv) {
  const opts = { dryRun: false, inputs: [] };
  for (const a of argv) {
    if (a === '--help' || a === '-h') return { help: true };
    if (a === '--dry-run') { opts.dryRun = true; continue; }
    if (a.startsWith('-')) throw new UsageError(`unknown option "${a}"\n${USAGE}`);
    opts.inputs.push(a);
  }
  if (opts.inputs.length !== 2) throw new UsageError(`expected exactly two inputs: <manifest.jsonl> <export.jsonl>\n${USAGE}`);
  if (!opts.dryRun) {
    throw new UsageError('this build is offline-only: live import has no transport here and runs only under separate Track-L approval.\nRe-run with --dry-run to validate both files and print the plan.');
  }
  return opts;
}

function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const read = (p, label) => {
    try {
      return readFileSync(path.resolve(p), 'utf8');
    } catch (e) {
      throw new UsageError(`cannot read ${label} "${p}": ${e.message}`);
    }
  };
  const rows = parseManifestText(read(opts.inputs[0], 'manifest'));
  const docs = parseExportDocs(read(opts.inputs[1], 'export'));
  const { manifest, docs: prepared } = prepareImport({ rows, docs });
  const { entries, summary } = planImport(manifest, prepared);

  const lines = [];
  lines.push('LIFTS Phase 3 import runner — DRY RUN (offline, read-only, no backend, no credentials)');
  for (const e of entries) {
    const sha = e.sha256 ? `  sha256=${e.sha256.slice(0, 12)}…` : '';
    lines.push(`  ${e.action.padEnd(21)} ${e.firebase_uid} -> ${e.supabase_uuid}  ${e.emailMasked}${sha}`);
  }
  lines.push('');
  lines.push(`plan: manifest=${summary.total} documents=${summary.documents} import=${summary.import} await-provisioning=${summary['await-provisioning']} already-imported=${summary['skip(already-imported)']} excluded=${summary.excluded}`);
  lines.push('payload contents are never printed — nothing was written or contacted (docs/phase-3c-remaining-work-plan.md Track L gates the live run)');
  process.stdout.write(lines.join('\n') + '\n');
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
