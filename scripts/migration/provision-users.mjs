#!/usr/bin/env node
// ── LIFTS Phase 3c (O2): offline user-provisioning runner core ─────────────
//
// SAFETY CONTRACT (docs/phase-3c-remaining-work-plan.md, O2):
//   * OFFLINE ONLY — this build contains NO network code whatsoever. The
//     backend is always an injected `call(method, href, opts)` function; the
//     offline tests and dry-run use in-memory fakes. Executing the CLI
//     without --dry-run refuses with exit 2. Wiring a live transport is a
//     separate, approval-gated step (Track L) — not part of this file.
//   * No Firebase contact, no Supabase contact, no SQL, no credentials, no
//     real user data, nothing written to any file by the CLI (read-only).
//   * Provisioning payload: Admin-API createUser with the PLANNED PIN as the
//     id, `email_confirm: true`, and the `firebase_uid` claim in
//     app_metadata (plan §2.2 step 4 / addendum V1, V4). A password field is
//     NEVER set, generated, or transmitted (plan §3.3: no usable password
//     until the user recovers it; D-14 hash import is a separate decision).
//     Reports and plan output never contain raw emails (masked), passwords,
//     keys, or backend response bodies — only fixed strings, uids, pins,
//     status codes, and masked emails.
//   * Identity rules (requirement): deterministic UUIDv5 pins from the
//     manifest are the ONLY ids used; every input is validated BEFORE any
//     backend call (duplicates/conflicts rejected all-at-once); a returned
//     user id that differs from the requested pin HALTS the run with the row
//     marked `conflict` — never an email fallback, never a delete, never an
//     auto-adopt. Reruns are idempotent: provisioned rows are skipped, and a
//     pre-existing user at our pinned id is verified by its `firebase_uid`
//     claim before being treated as already provisioned.
//
// Manifest format preserved exactly: JSONL, one object per line, field order
// firebase_uid, supabase_uuid, email, provider_hint, status, trailing
// newline (scripts/migration/build-manifest.mjs formatManifest).
//
// Exit codes: 0 success · 1 validation failure · 2 usage / policy error.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ManifestBuildError, UUID_RE, formatManifest, pinForUid } from './build-manifest.mjs';

export const ROW_FIELDS = ['firebase_uid', 'supabase_uuid', 'email', 'provider_hint', 'status'];
export const STATUSES = ['planned', 'provisioned', 'data_imported', 'verified', 'conflict', 'skipped'];
export const PROVIDER_HINTS = ['password', 'google.com', 'password+google.com'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ADMIN_USERS_PATH = '/auth/v1/admin/users';
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_MS = 250;

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const sleep = ms => new Promise(res => setTimeout(res, ms));

/** Mask an email for any output: local part → first char + "***". */
export function redactEmail(email) {
  const s = String(email);
  const at = s.indexOf('@');
  if (at < 1) return '***';
  return s[0] + '***@' + s.slice(at + 1);
}

// ── Manifest parsing + validation (before ANY backend call) ────────────────

/** Strict JSONL manifest parser; all problems reported together with line labels. */
export function parseManifestText(text) {
  const rows = [];
  const errors = [];
  String(text).split('\n').forEach((line, i) => {
    const t = line.trim();
    if (t === '') return;
    const where = `line ${i + 1}`;
    try {
      const rec = JSON.parse(t);
      if (!isObj(rec)) errors.push(`${where}: expected a JSON object`);
      else rows.push({ rec, where });
    } catch (e) {
      errors.push(`${where}: invalid JSON (${e.message})`);
    }
  });
  if (errors.length) throw new ManifestBuildError(errors);
  return rows;
}

/**
 * Validate manifest rows and return them sorted by firebase_uid (the
 * builder's deterministic order). All-or-nothing: throws ManifestBuildError
 * listing every problem — malformed fields, unknown fields, duplicate
 * firebase_uid, duplicate/derived supabase_uuid collisions, and email
 * identity conflicts. Never guesses identity from email (plan §3.2).
 */
export function validateProvisionRows(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new ManifestBuildError(['manifest contains no rows — refusing to run on an empty manifest']);
  }
  const errors = [];
  const candidates = [];

  entries.forEach((entry, i) => {
    let rec = entry;
    let where = `row ${i + 1}`;
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
      if (!ROW_FIELDS.includes(key)) errors.push(`${where}: unknown field "${key}" (manifest format is ${ROW_FIELDS.join(', ')})`);
    }

    let uid = null;
    if (typeof rec.firebase_uid !== 'string' || rec.firebase_uid.trim() === '') {
      errors.push(`${where}: missing firebase_uid`);
    } else if (rec.firebase_uid !== rec.firebase_uid.trim() || /\s/.test(rec.firebase_uid)) {
      errors.push(`${where}: malformed firebase_uid (unexpected whitespace)`);
    } else {
      uid = rec.firebase_uid;
    }

    let uuid = null;
    if (typeof rec.supabase_uuid !== 'string' || !UUID_RE.test(rec.supabase_uuid)) {
      errors.push(`${where}: malformed supabase_uuid "${rec.supabase_uuid}" (expected an RFC 4122 UUID)`);
    } else {
      uuid = rec.supabase_uuid.toLowerCase();
    }

    let email = null;
    if (typeof rec.email !== 'string' || rec.email.trim() === '') {
      errors.push(`${where}: missing email`);
    } else if (!EMAIL_RE.test(rec.email)) {
      errors.push(`${where}: malformed email`);
    } else if (rec.email !== rec.email.toLowerCase()) {
      errors.push(`${where}: email is not normalized to lowercase (build-manifest output required)`);
    } else {
      email = rec.email;
    }

    if (!('provider_hint' in rec)) {
      errors.push(`${where}: missing provider_hint`);
    } else if (!PROVIDER_HINTS.includes(rec.provider_hint)) {
      errors.push(`${where}: unknown provider_hint "${rec.provider_hint}" (expected ${PROVIDER_HINTS.join(' | ')})`);
    }
    if (!('status' in rec)) {
      errors.push(`${where}: missing status`);
    } else if (!STATUSES.includes(rec.status)) {
      errors.push(`${where}: unknown status "${rec.status}" (expected ${STATUSES.join(' | ')})`);
    }

    if (errors.length === before) candidates.push({ rec, where, uid, uuid, email });
  });

  const byUid = new Map();
  const byEmail = new Map();
  const byUuid = new Map();
  for (const c of candidates) {
    if (byUid.has(c.uid)) {
      errors.push(`duplicate firebase_uid "${c.uid}" (${byUid.get(c.uid)} and ${c.where}) — exactly one row per uid`);
    } else {
      byUid.set(c.uid, c.where);
    }
    if (byEmail.has(c.email) && byEmail.get(c.email).uid !== c.uid) {
      errors.push(`conflicting identity: email "${c.email}" claimed by firebase_uid "${byEmail.get(c.email).uid}" (${byEmail.get(c.email).where}) and "${c.uid}" (${c.where}) — email is never an identity key`);
    } else if (!byEmail.has(c.email)) {
      byEmail.set(c.email, { uid: c.uid, where: c.where });
    }
    if (byUuid.has(c.uuid) && byUuid.get(c.uuid).uid !== c.uid) {
      errors.push(`duplicate supabase_uuid "${c.uuid}" for firebase_uid "${byUuid.get(c.uuid).uid}" (${byUuid.get(c.uuid).where}) and "${c.uid}" (${c.where}) — pins must be one-to-one`);
    } else if (!byUuid.has(c.uuid)) {
      byUuid.set(c.uuid, { uid: c.uid, where: c.where });
    }
  }

  if (errors.length) throw new ManifestBuildError(errors);

  const rows = candidates.map(c => ({ ...c.rec, supabase_uuid: c.uuid }));
  rows.sort((a, b) => (a.firebase_uid < b.firebase_uid ? -1 : a.firebase_uid > b.firebase_uid ? 1 : 0));
  return rows;
}

/** Immutable status transition (rerun input builder). Preserves field order. */
export function applyStatusUpdates(rows, updates) {
  return rows.map(r => (updates && updates[r.firebase_uid] ? { ...r, status: updates[r.firebase_uid] } : { ...r }));
}

/** Read-only plan over validated rows — performs zero backend calls. */
export function planProvision(rows) {
  const entries = rows.map(row => {
    const derived = pinForUid(row.firebase_uid);
    const override = row.supabase_uuid !== derived;
    return {
      firebase_uid: row.firebase_uid,
      supabase_uuid: row.supabase_uuid,
      emailMasked: redactEmail(row.email),
      action: row.status === 'planned' ? 'provision' : `skip(${row.status})`,
      override
    };
  });
  const planned = entries.filter(e => e.action === 'provision').length;
  return { entries, summary: { total: entries.length, provision: planned, skip: entries.length - planned } };
}

// ── Provisioning core ──────────────────────────────────────────────────────

function createBody(row) {
  // Password is NEVER part of provisioning (plan §3.3 / D-14 are separate).
  return {
    id: row.supabase_uuid,
    email: row.email,
    email_confirm: true,
    app_metadata: { firebase_uid: row.firebase_uid }
  };
}

const statusOf = res => (res && Number.isFinite(Number(res.status)) ? Number(res.status) : NaN);
const isTransient = res => {
  const st = statusOf(res);
  return st === 429 || st >= 500;
};
const errCode = res => {
  const d = res && res.data;
  if (!isObj(d)) return null;
  return typeof d.code === 'string' ? d.code : typeof d.error_code === 'string' ? d.error_code : null;
};

/**
 * Call with bounded retries on transient failures (429/5xx/throw).
 * Returns { attempts, res?, error?, exhausted? }. Never retries other 4xx.
 */
async function attemptCall(call, method, href, opts, maxAttempts, retryBaseMs, delay) {
  let attempts = 0;
  let last = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attempts = attempt;
    try {
      const res = await call(method, href, opts);
      if (!Number.isNaN(statusOf(res)) && !isTransient(res)) return { attempts, res };
      last = res;
    } catch (e) {
      last = e;
    }
    if (attempt < maxAttempts) await delay(retryBaseMs * Math.pow(2, attempt - 1));
  }
  return { attempts, res: last instanceof Error ? null : last, error: last instanceof Error ? last : null, exhausted: true };
}

/**
 * Provision all `planned` rows of a validated manifest against an injected
 * backend. Stops safely (remaining rows `not-run`) on: pin conflict, foreign
 * identity at the pinned id, foreign email, malformed response, or exhausted
 * transient retries. Returns a redacted report — never raw emails, bodies,
 * or backend messages.
 */
export async function runProvision({
  rows,
  call,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  retryBaseMs = DEFAULT_RETRY_BASE_MS,
  delay = sleep
} = {}) {
  if (typeof call !== 'function') throw new TypeError('runProvision requires an injected call(method, href, opts) function');
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new TypeError('maxAttempts must be a positive integer');
  const ordered = validateProvisionRows(
    (Array.isArray(rows) ? rows : []).map((r, i) => (isObj(r) && 'rec' in r && typeof r.where === 'string' ? r : isObj(r) ? { rec: r, where: `row ${i + 1}` } : r))
  );

  const results = [];
  const updates = {};
  const notes = [];
  let halted = null;
  let provisioned = 0;
  let skipped = 0;

  for (const row of ordered) {
    const base = {
      firebase_uid: row.firebase_uid,
      supabase_uuid: row.supabase_uuid,
      email: redactEmail(row.email)
    };
    if (halted) {
      results.push({ ...base, outcome: 'not-run' });
      continue;
    }
    if (row.status !== 'planned') {
      skipped++;
      results.push({ ...base, outcome: 'skipped-status', fromStatus: row.status });
      continue;
    }

    const attempt = await attemptCall(call, 'POST', ADMIN_USERS_PATH, { body: createBody(row) }, maxAttempts, retryBaseMs, delay);

    if (attempt.exhausted) {
      results.push({ ...base, outcome: 'failed', fromStatus: row.status, attempts: attempt.attempts });
      notes.push(`${row.firebase_uid}: transient failures exhausted after ${attempt.attempts} attempts — row left as "planned" for a safe rerun`);
      halted = { firebase_uid: row.firebase_uid, reason: 'transient-failures-exhausted' };
      continue;
    }

    const res = attempt.res;
    const st = statusOf(res);
    if (Number.isNaN(st)) {
      results.push({ ...base, outcome: 'failed', fromStatus: row.status, attempts: attempt.attempts });
      notes.push(`${row.firebase_uid}: malformed backend response — run halted`);
      halted = { firebase_uid: row.firebase_uid, reason: 'malformed-response' };
      continue;
    }

    if (st >= 200 && st < 300) {
      const returnedId = isObj(res.data) && isObj(res.data.user) ? res.data.user.id : null;
      if (typeof returnedId !== 'string' || returnedId.trim().toLowerCase() !== row.supabase_uuid) {
        // V1 workflow: pin mismatch → conflict, HALT. Never email fallback.
        results.push({ ...base, outcome: 'conflict', fromStatus: row.status, toStatus: 'conflict', attempts: attempt.attempts, detail: `PIN CONFLICT: requested pin ${row.supabase_uuid}, server returned an unexpected id` });
        updates[row.firebase_uid] = 'conflict';
        halted = { firebase_uid: row.firebase_uid, reason: 'pin-conflict' };
        continue;
      }
      provisioned++;
      results.push({ ...base, outcome: 'provisioned', fromStatus: row.status, toStatus: 'provisioned', attempts: attempt.attempts });
      updates[row.firebase_uid] = 'provisioned';
      continue;
    }

    const code = errCode(res);
    if (st === 422 && code === 'user_already_exists') {
      // Idempotent path — only if the existing user at OUR pin carries OUR claim.
      const check = await attemptCall(call, 'GET', `${ADMIN_USERS_PATH}/${row.supabase_uuid}`, undefined, maxAttempts, retryBaseMs, delay);
      if (check.exhausted || Number.isNaN(statusOf(check.res))) {
        results.push({ ...base, outcome: 'failed', fromStatus: row.status, attempts: attempt.attempts });
        notes.push(`${row.firebase_uid}: could not verify the existing pinned user — run halted`);
        halted = { firebase_uid: row.firebase_uid, reason: 'verification-unavailable' };
        continue;
      }
      const cst = statusOf(check.res);
      if (cst >= 200 && cst < 300) {
        const u = isObj(check.res.data) ? check.res.data.user : null;
        const claim = u && isObj(u.app_metadata) ? u.app_metadata.firebase_uid : null;
        if (claim === row.firebase_uid) {
          provisioned++;
          results.push({ ...base, outcome: 'already-provisioned', fromStatus: row.status, toStatus: 'provisioned', attempts: attempt.attempts, detail: 'existing user at pinned id verified by firebase_uid claim' });
          updates[row.firebase_uid] = 'provisioned';
          continue;
        }
        results.push({ ...base, outcome: 'conflict', fromStatus: row.status, toStatus: 'conflict', attempts: attempt.attempts, detail: `pinned id is occupied by a user without this row's firebase_uid claim — manual review (E1)` });
        updates[row.firebase_uid] = 'conflict';
        halted = { firebase_uid: row.firebase_uid, reason: 'foreign-identity-at-pin' };
        continue;
      }
      results.push({ ...base, outcome: 'conflict', fromStatus: row.status, toStatus: 'conflict', attempts: attempt.attempts, detail: 'user_already_exists but the pinned id is not readable — manual review' });
      updates[row.firebase_uid] = 'conflict';
      halted = { firebase_uid: row.firebase_uid, reason: 'pinned-id-unreadable' };
      continue;
    }

    if (st === 422 && code === 'email_exists') {
      // Plan E1: never a second user per email, never auto-adopt, never delete.
      results.push({ ...base, outcome: 'conflict', fromStatus: row.status, toStatus: 'conflict', attempts: attempt.attempts, detail: 'email already exists under a different account — manual reconciliation per E1 (no adoption, no delete)' });
      updates[row.firebase_uid] = 'conflict';
      halted = { firebase_uid: row.firebase_uid, reason: 'email-exists' };
      continue;
    }

    results.push({ ...base, outcome: 'failed', fromStatus: row.status, attempts: attempt.attempts, detail: `unexpected backend response (HTTP ${st}${code ? `, ${code}` : ''})` });
    notes.push(`${row.firebase_uid}: unexpected backend response (HTTP ${st}) — run halted`);
    halted = { firebase_uid: row.firebase_uid, reason: 'unexpected-response' };
  }

  const byOutcome = {};
  for (const r of results) byOutcome[r.outcome] = (byOutcome[r.outcome] || 0) + 1;
  return {
    status: halted ? 'halted' : 'ok',
    totals: { input: ordered.length, provisioned, skipped, notRun: byOutcome['not-run'] || 0 },
    results,
    updates,
    halted,
    notes
  };
}

export { ADMIN_USERS_PATH, formatManifest };

// ── CLI (read-only; dry-run only in this offline build) ────────────────────

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const USAGE = 'usage: node scripts/migration/provision-users.mjs --dry-run <manifest.jsonl>';

class UsageError extends Error {}

function parseArgs(argv) {
  const opts = { dryRun: false, input: null };
  for (const a of argv) {
    if (a === '--help' || a === '-h') return { help: true };
    if (a === '--dry-run') { opts.dryRun = true; continue; }
    if (a.startsWith('-')) throw new UsageError(`unknown option "${a}"\n${USAGE}`);
    if (opts.input !== null) throw new UsageError(`unexpected extra argument "${a}"\n${USAGE}`);
    opts.input = a;
  }
  if (!opts.input) throw new UsageError(`missing manifest file\n${USAGE}`);
  if (!opts.dryRun) {
    throw new UsageError('this build is offline-only: live provisioning has no transport here and runs only under separate Track-L approval.\nRe-run with --dry-run to validate and print the plan.');
  }
  return opts;
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
    throw new UsageError(`cannot read manifest "${opts.input}": ${e.message}`);
  }
  const rows = validateProvisionRows(parseManifestText(text));
  const { entries, summary } = planProvision(rows);

  const lines = [];
  lines.push('LIFTS Phase 3 provisioning runner — DRY RUN (offline, read-only, no backend, no credentials)');
  lines.push('');
  for (const e of entries) {
    const tag = e.action === 'provision' ? (e.override ? 'provision (explicit pin override)' : 'provision ') : e.action.padEnd(9);
    lines.push(`  ${tag}  ${e.firebase_uid} -> ${e.supabase_uuid}  ${e.emailMasked}`);
  }
  lines.push('');
  lines.push(`plan: total=${summary.total} provision=${summary.provision} skip=${summary.skip}`);
  lines.push('nothing was created, modified, or contacted — live runs require separate approval (docs/phase-3c-remaining-work-plan.md Track L)');
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
