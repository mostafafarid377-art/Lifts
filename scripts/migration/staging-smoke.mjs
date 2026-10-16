#!/usr/bin/env node
// ── LIFTS Phase 3b: staging smoke test (NON-PRODUCTION ONLY) ────────────────
//
// Repeatable verification harness for docs/phase-3-auth-migration-plan.md
// "Phase 3b-staging". It exercises ONLY the Supabase Auth Admin API and the
// Data API (PostgREST) with synthetic accounts — it NEVER inserts into
// auth.users directly, NEVER touches Firebase, and NEVER logs any credential.
//
// Required environment (supply from your local secret store — never Git):
//   SUPABASE_STAGING_URL           e.g. https://<ref>.supabase.co  (confirm it is
//                                  the NON-PRODUCTION staging project first)
//   SUPABASE_STAGING_SECRET_KEY    sb_secret_... or legacy service_role JWT
//   SUPABASE_STAGING_PUBLISHABLE_KEY  sb_publishable_... or legacy anon JWT
//   STAGING_CONFIRM=I_UNDERSTAND_NON_PRODUCTION   (explicit run guard)
// Optional:
//   SUPABASE_STAGING_ACCESS_TOKEN  Supabase personal access token, only used
//                                  together with --apply-migrations (Management
//                                  API SQL endpoint) to apply the two schema
//                                  files from supabase/migrations/.
//
// Usage:
//   node scripts/migration/staging-smoke.mjs --dry-run
//   node scripts/migration/staging-smoke.mjs [--apply-migrations] [--keep] [--json <path-outside-repo>]
//
// Exit codes: 0 all steps PASS · 1 one or more steps FAIL · 2 preflight/usage.
// Steps: T0 preflight · T1 project reachability · T2 migrations applied (or
// applied via Management API) · T3 pinned-UUID createUser (halts on PIN
// CONFLICT) · T4 app_metadata.firebase_uid readback · T5 trusted-role mapping
// write · T6 unauthorized-role denial · T7 two-user RLS isolation on
// user_data · T8 cleanup (unless --keep).

import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const USAGE = 'usage: node scripts/migration/staging-smoke.mjs [--dry-run] [--apply-migrations] [--keep] [--json <path-outside-repo>]';

const results = [];
function record(id, status, detail) {
  results.push({ id, status, detail });
  process.stdout.write(`[${status}] ${id} ${detail}\n`);
}
const fail = (id, detail) => record(id, 'FAIL', detail);
const pass = (id, detail) => record(id, 'PASS', detail);
const notRun = (id, detail) => record(id, 'NOT RUN', detail);

// ── credential handling: values are read once, never printed ───────────────
function jwtRole(key) {
  const parts = String(key).split('.');
  if (parts.length !== 3) return null;
  try {
    const seg = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(seg, 'base64').toString('utf8')).role ?? null;
  } catch (_) { return null; }
}
function describeKey(key) {           // safe fingerprint for logs/reports
  if (!key) return '(missing)';
  if (key.startsWith('sb_secret_')) return 'sb_secret_…(redacted)';
  if (key.startsWith('sb_publishable_')) return 'sb_publishable_…(redacted)';
  const role = jwtRole(key);
  if (role) return `jwt role=${role} (redacted)`;
  return 'unrecognized format (redacted)';
}
function isSecretKey(key) {
  return typeof key === 'string' && (key.toLowerCase().startsWith('sb_secret_') || jwtRole(key) === 'service_role');
}
function isPublishableKey(key) {
  return typeof key === 'string' && (key.toLowerCase().startsWith('sb_publishable_') || jwtRole(key) === 'anon');
}

function usageError(msg) { process.stderr.write(`usage error: ${msg}\n${USAGE}\n`); process.exit(2); }

// ── arg parsing ────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const opts = { dryRun: false, apply: false, keep: false, json: null };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--dry-run') opts.dryRun = true;
  else if (a === '--apply-migrations') opts.apply = true;
  else if (a === '--keep') opts.keep = true;
  else if (a === '--json') { opts.json = argv[++i]; if (!opts.json) usageError('--json requires a path'); }
  else usageError(`unknown option "${a}"`);
}

const env = {
  url: (process.env.SUPABASE_STAGING_URL || '').trim().replace(/\/+$/, ''),
  secret: (process.env.SUPABASE_STAGING_SECRET_KEY || '').trim(),
  publishable: (process.env.SUPABASE_STAGING_PUBLISHABLE_KEY || '').trim(),
  pat: (process.env.SUPABASE_STAGING_ACCESS_TOKEN || '').trim(),
  confirm: process.env.STAGING_CONFIRM || ''
};
const missing = [];
if (!env.url) missing.push('SUPABASE_STAGING_URL');
if (!env.secret) missing.push('SUPABASE_STAGING_SECRET_KEY');
if (!env.publishable) missing.push('SUPABASE_STAGING_PUBLISHABLE_KEY');

// ── T0 dry-run: always available, prints the plan, needs no credentials ────
if (opts.dryRun) {
  const lines = [
    'Phase 3b staging smoke — DRY RUN (no network, no credentials required)',
    '',
    'Planned steps when credentials + network are available:',
    '  T0  preflight: validate env vars and key formats (values redacted)',
    '  T1  GET {url}/auth/v1/health — confirm the staging project URL answers',
    '  T2  verify public.user_data + public.firebase_uid_map exist' + (opts.apply ? ' (apply via Management API first: --apply-migrations)' : ''),
    '  T3  POST /auth/v1/admin/users with a pinned v5 id — assert returned user.id == pin (else PIN CONFLICT, halt)',
    '  T4  GET /auth/v1/admin/users/{pin} — assert app_metadata.firebase_uid readback',
    '  T5  Data API: service-role INSERT/SELECT on firebase_uid_map (trusted write path)',
    '  T6  Data API: authenticated + anon roles DENIED on firebase_uid_map (select and insert)',
    '  T7  Data API: two synthetic users — each sees only their own user_data row',
    '  T8  cleanup: admin user deletes (FK cascades user_data) + mapping-row deletes (skip with --keep)',
    '',
    'Required environment:'
  ];
  if (missing.length) {
    missing.forEach(m => lines.push(`  - ${m} (MISSING)`));
  } else {
    lines.push('  (all present)');
    lines.push(`    URL: ${env.url}`);
    lines.push(`    secret: ${describeKey(env.secret)}`);
    lines.push(`    publishable: ${describeKey(env.publishable)}` + (env.pat ? '' : ', PAT optional for --apply-migrations'));
  }
  lines.push('');
  lines.push(`Key fingerprints now: secret=${describeKey(env.secret)} publishable=${describeKey(env.publishable)}`);
  process.stdout.write(lines.join('\n') + '\n');
  process.exit(0);
}

// ── T0 preflight (real run) ────────────────────────────────────────────────
if (missing.length) {
  process.stderr.write(`usage error: missing required environment variables: ${missing.join(', ')}\n${USAGE}\n`);
  process.exit(2);
}
if (env.confirm !== 'I_UNDERSTAND_NON_PRODUCTION') {
  process.stderr.write('usage error: set STAGING_CONFIRM=I_UNDERSTAND_NON_PRODUCTION to run against the staging project (this harness refuses to run without it).\n');
  process.exit(2);
}
let urlObj = null;
try { urlObj = new URL(env.url); } catch (_) { /* handled below */ }
if (!urlObj || (urlObj.protocol !== 'https:') || !urlObj.hostname.endsWith('.supabase.co')) {
  process.stderr.write(`usage error: SUPABASE_STAGING_URL must be an https://<ref>.supabase.co staging URL, got: ${env.url || '(empty)'}\n`);
  process.exit(2);
}
const PROJECT_REF = urlObj.hostname.replace(/\.supabase\.co$/, '');
if (!isSecretKey(env.secret)) {
  process.stderr.write(`usage error: SUPABASE_STAGING_SECRET_KEY is not a service/secret key (fingerprint: ${describeKey(env.secret)}) — refusing.\n`);
  process.exit(2);
}
if (!isPublishableKey(env.publishable)) {
  process.stderr.write(`usage error: SUPABASE_STAGING_PUBLISHABLE_KEY is not a publishable/anon key (fingerprint: ${describeKey(env.publishable)}) — refusing.\n`);
  process.exit(2);
}
pass('T0', `preflight ok — project ref=${PROJECT_REF} secret=${describeKey(env.secret)} publishable=${describeKey(env.publishable)}`);
if (opts.apply && !env.pat) {
  fail('T0b', '--apply-migrations requires SUPABASE_STAGING_ACCESS_TOKEN (personal access token); not provided');
}

// ── HTTP helpers (never log headers or bodies containing credentials) ──────
async function call(method, href, { apikey, token, body, timeoutMs = 15000 } = {}) {
  const headers = { apikey, Prefer: 'return=representation' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(href, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ctl.signal });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = text.slice(0, 300); }
    return { status: res.status, ok: res.ok, data };
  } finally { clearTimeout(t); }
}
const rest = (method, table, query, o) =>
  call(method, `${env.url}/rest/v1/${table}${query ? `?${query}` : ''}`, o);
const authAdmin = (method, p, o) =>
  call(method, `${env.url}/auth/v1/${p}`, o);

function missingRelation(res) {
  const code = res && res.data && typeof res.data === 'object' ? String(res.data.code || res.data.error_code || '') : '';
  const msg = res && res.data && typeof res.data === 'object' ? JSON.stringify(res.data) : String(res && res.data || '');
  return code === '42P01' || code === 'PGRST205' || /does not exist|relation .* not found|Could not find the table/i.test(msg);
}

const RUN = Date.now().toString(36);
const USERS = [
  { firebaseUid: `fixture-staging-smoke-alpha-${RUN}`, email: `lifts-staging-smoke.alpha+${RUN}@example.com` },
  { firebaseUid: `fixture-staging-smoke-bravo-${RUN}`, email: `lifts-staging-smoke.bravo+${RUN}@example.com` }
];
const createdIds = [];

async function finish(code) {
  process.stdout.write(`\n${results.map(r => `${r.status.padEnd(7)} ${r.id}`).join('\n')}\n`);
  if (opts.json) {
    const abs = path.resolve(opts.json);
    const rel = path.relative(REPO_ROOT, abs);
    if (rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel))) {
      process.stderr.write(`refusing to write the report inside the repository (${abs})\n`);
    } else {
      writeFileSync(abs, JSON.stringify({ projectRef: PROJECT_REF, ranAt: new Date().toISOString(), results }, null, 2) + '\n', 'utf8');
      process.stdout.write(`report written to ${abs}\n`);
    }
  }
  process.exit(code);
}

async function main() {
  // T1 — project URL answers
  try {
    const h = await call('GET', `${env.url}/auth/v1/health`, { apikey: env.publishable });
    if (h.ok) pass('T1', `staging project reachable at ${urlObj.origin} (health ${h.status})`);
    else fail('T1', `health endpoint returned ${h.status}`);
  } catch (e) {
    fail('T1', `cannot reach staging URL (${e.name === 'AbortError' ? 'timeout' : 'network error'}) — check credentials host/network: ${e.message}`);
    return finish(1);
  }

  // T2 — migrations present (or applied via Management API)
  try {
    if (opts.apply && env.pat) {
      for (const file of ['20261015000000_create_user_data.sql', '20261016000000_create_firebase_uid_map.sql']) {
        const sql = readFileSync(path.join(REPO_ROOT, 'supabase', 'migrations', file), 'utf8');
        const r = await call('POST', `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
          apikey: env.publishable, token: env.pat, body: { query: sql }
        });
        if (!r.ok) { fail('T2', `Management API failed applying ${file}: HTTP ${r.status} ${typeof r.data === 'object' ? JSON.stringify(r.data).slice(0, 200) : ''}`); return finish(1); }
      }
      pass('T2', 'both migrations applied via Management API');
    }
    const a = await rest('GET', 'firebase_uid_map', 'select=firebase_uid&limit=1', { apikey: env.secret, token: env.secret });
    const b = await rest('GET', 'user_data', 'select=user_id&limit=1', { apikey: env.secret, token: env.secret });
    if (a.ok && b.ok) pass('T2', 'tables present: firebase_uid_map + user_data readable with trusted key');
    else if (missingRelation(a) || missingRelation(b)) {
      fail('T2', 'a required table is missing — apply supabase/migrations/*.sql first (dashboard SQL editor, or rerun with --apply-migrations + SUPABASE_STAGING_ACCESS_TOKEN)');
      return finish(1);
    } else fail('T2', `table check failed: firebase_uid_map=${a.status} user_data=${b.status}`);
  } catch (e) { fail('T2', `table check error: ${e.message}`); return finish(1); }

  // T3 — pinned-UUID provisioning via Admin API (never raw SQL into auth.users)
  const { pinForUid } = await import(pathToFileURL(path.join(SCRIPT_DIR, 'build-manifest.mjs')).href);
  const pins = USERS.map(u => ({ ...u, pin: pinForUid(u.firebaseUid), password: randomBytes(18).toString('base64url') }));
  let conflict = false;
  for (const u of pins) {
    try {
      const r = await authAdmin('POST', 'admin/users', {
        apikey: env.secret, token: env.secret,
        body: {
          id: u.pin,
          email: u.email,
          password: u.password,
          email_confirm: true,
          app_metadata: { firebase_uid: u.firebaseUid, phase: '3b-staging', synthetic: true }
        }
      });
      const got = r.data && r.data.user ? r.data.user.id : (r.data && r.data.id) || null;
      if (!r.ok) { fail('T3', `createUser(${u.email}) HTTP ${r.status} ${JSON.stringify(r.data || {}).slice(0, 200)}`); conflict = r.status === 422; continue; }
      if (got !== u.pin) {
        fail('T3', `PIN CONFLICT — requested pin ${u.pin} but Auth returned ${got}. Mapping pin rejected for this run; DO NOT import data for this row. (Manual review: plan addendum V1 mismatch contingency.)`);
        conflict = true;
        continue;
      }
      createdIds.push(u.pin);
      pass('T3', `createUser accepted pinned v5 id ${u.pin} for ${u.email} (synthetic)`);
    } catch (e) { fail('T3', `createUser error: ${e.message}`); }
  }
  if (conflict) return finish(1);

  // T4 — app_metadata.firebase_uid readback
  for (const u of pins) {
    try {
      const r = await authAdmin('GET', `admin/users/${u.pin}`, { apikey: env.secret, token: env.secret });
      const user = r.data && r.data.user ? r.data.user : r.data;
      const claim = user && user.app_metadata && user.app_metadata.firebase_uid;
      const claimRaw = user && user.raw_app_meta_data && user.raw_app_meta_data.firebase_uid;
      if (r.ok && (claim === u.firebaseUid || claimRaw === u.firebaseUid)) {
        pass('T4', `claim readback ok — ${u.pin} → app_metadata.firebase_uid=${u.firebaseUid}`);
      } else fail('T4', `claim missing/mismatch on ${u.pin}: app_metadata.firebase_uid=${JSON.stringify(claim)} (HTTP ${r.status})`);
    } catch (e) { fail('T4', `readback error: ${e.message}`); }
  }

  // T5 — trusted role writes the mapping row
  for (const u of pins) {
    try {
      const ins = await rest('POST', 'firebase_uid_map', '', {
        apikey: env.secret, token: env.secret,
        body: { firebase_uid: u.firebaseUid, supabase_uuid: u.pin, email: u.email, provider_hint: 'password', status: 'planned' }
      });
      const sel = await rest('GET', 'firebase_uid_map', `select=supabase_uuid&firebase_uid=eq.${encodeURIComponent(u.firebaseUid)}`, { apikey: env.secret, token: env.secret });
      const row = Array.isArray(sel.data) && sel.data[0];
      if (ins.ok && sel.ok && row && row.supabase_uuid === u.pin) pass('T5', `trusted role wrote+read mapping row for ${u.firebaseUid}`);
      else fail('T5', `trusted write/read failed: insert=${ins.status} select=${sel.status} row=${JSON.stringify(sel.data).slice(0, 160)}`);
    } catch (e) { fail('T5', `trusted write error: ${e.message}`); }
  }

  // T6 — unauthorized roles denied on firebase_uid_map
  const denied = async (label, headers, method, query, body) => {
    try {
      const r = await call(method, `${env.url}/rest/v1/firebase_uid_map${query ? `?${query}` : ''}`, { ...headers, body });
      const sawData = r.ok && Array.isArray(r.data) && r.data.length > 0;
      if (!r.ok || !sawData) pass('T6', `${label} denied (HTTP ${r.status})`);
      else fail('T6', `${label} was NOT denied — HTTP 200 with ${r.data.length} row(s)`);
    } catch (e) { pass('T6', `${label} denied (connection refused to endpoint: ${e.name})`); }
  };
  await denied('anon SELECT', { apikey: env.publishable }, 'GET', 'select=firebase_uid&limit=1');
  await denied('anon INSERT', { apikey: env.publishable }, 'POST', '', { firebase_uid: `should-not-work-${RUN}`, supabase_uuid: `00000000-0000-4000-8000-00000000000${Math.floor(Math.random() * 15)}` , email: 'denied@example.com', provider_hint: 'password', status: 'planned' });
  const sessions = [];
  for (const u of pins) {
    try {
      const s = await call('POST', `${env.url}/auth/v1/token?grant_type=password`, { apikey: env.publishable, body: { email: u.email, password: u.password } });
      if (s.ok && s.data && s.data.access_token) {
        sessions.push({ ...u, token: s.data.access_token });
        pass('T6-auth', `synthetic user signed in via Email provider: ${u.email}`);
      } else fail('T6-auth', `password sign-in failed for ${u.email}: HTTP ${s.status} ${JSON.stringify(s.data || {}).slice(0, 160)} (is the Email provider enabled on staging?)`);
    } catch (e) { fail('T6-auth', `sign-in error: ${e.message}`); }
  }
  for (const s of sessions) {
    await denied('authenticated SELECT', { apikey: env.publishable, token: s.token }, 'GET', 'select=firebase_uid&limit=1');
    await denied('authenticated INSERT', { apikey: env.publishable, token: s.token }, 'POST', '', { firebase_uid: `denied-${RUN}`, supabase_uuid: `00000000-0000-4000-8000-00000000000${Math.floor(Math.random() * 15)}`, email: 'denied@example.com', provider_hint: 'password', status: 'planned' });
  }

  // T7 — two-user isolation on user_data (RLS auth.uid() = user_id)
  for (const u of pins) {
    const w = await rest('POST', 'user_data', '', { apikey: env.secret, token: env.secret, body: { user_id: u.pin, payload: { phase: '3b-staging', synthetic: u.firebaseUid } } });
    if (!w.ok) fail('T7', `could not seed user_data row for ${u.pin}: HTTP ${w.status}`);
  }
  for (const s of sessions) {
    try {
      const own = await rest('GET', 'user_data', 'select=user_id,payload', { apikey: env.publishable, token: s.token });
      const rows = Array.isArray(own.data) ? own.data : [];
      const other = pins.find(p => p.pin !== s.pin);
      const cross = await rest('GET', 'user_data', `select=user_id&user_id=eq.${other.pin}`, { apikey: env.publishable, token: s.token });
      const crossRows = Array.isArray(cross.data) ? cross.data : [];
      if (own.ok && rows.length === 1 && rows[0].user_id === s.pin && cross.ok && crossRows.length === 0) {
        pass('T7', `RLS isolation ok — ${s.email} sees only its own row`);
      } else fail('T7', `isolation broken/odd for ${s.email}: own=${JSON.stringify(rows).slice(0, 160)} cross=${JSON.stringify(crossRows).slice(0, 160)}`);
    } catch (e) { fail('T7', `isolation check error: ${e.message}`); }
  }

  // T8 — cleanup
  if (opts.keep) {
    notRun('T8', `cleanup skipped (--keep): synthetic users ${pins.map(u => u.email).join(', ')} and mapping rows remain — rerun without --keep to remove`);
  } else {
    let ok = true;
    for (const id of createdIds) {
      try { const r = await authAdmin('DELETE', `admin/users/${id}`, { apikey: env.secret, token: env.secret }); if (!r.ok && r.status !== 404) ok = false; }
      catch (_) { ok = false; }
    }
    for (const u of pins) {
      try { const r = await rest('DELETE', 'firebase_uid_map', `firebase_uid=eq.${encodeURIComponent(u.firebaseUid)}`, { apikey: env.secret, token: env.secret }); if (!r.ok) ok = false; }
      catch (_) { ok = false; }
    }
    const verify = await rest('GET', 'firebase_uid_map', `select=firebase_uid&firebase_uid=in.(${pins.map(p => `"${p.firebaseUid}"`).join(',')})`, { apikey: env.secret, token: env.secret });
    const leftover = Array.isArray(verify.data) ? verify.data.length : -1;
    if (ok && leftover === 0) pass('T8', 'synthetic users and mapping rows removed (user_data rows cascade-deleted)');
    else fail('T8', `cleanup incomplete (leftover mapping rows: ${leftover}) — rerun cleanup or restore staging state`);
  }
}

const failed = () => results.filter(r => r.status === 'FAIL').length;
main()
  .then(() => finish(failed() ? 1 : 0))
  .catch(e => { fail('FATAL', e && e.stack ? e.stack.split('\n')[0] : String(e)); return finish(1); });
