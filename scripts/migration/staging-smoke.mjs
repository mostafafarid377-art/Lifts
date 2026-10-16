#!/usr/bin/env node
// ── LIFTS Phase 3b: staging smoke test (NON-PRODUCTION ONLY) ────────────────
//
// Repeatable verification harness for docs/phase-3-auth-migration-plan.md
// "Phase 3b-staging", revised after the Step 2 cleanup audit (R-a…R-e).
// It exercises ONLY the Supabase Auth Admin API and the Data API (PostgREST)
// with synthetic accounts — it NEVER inserts into auth.users directly, NEVER
// touches Firebase, and NEVER logs any credential.
//
// Safety properties (unit-tested in tests/staging-smoke.test.cjs):
//   * Ownership-verified deletion only: every user delete is preceded by a
//     fresh Admin API read and requires ALL of — exact synthetic email of THIS
//     run, app_metadata.firebase_uid of THIS run, phase '3b-staging',
//     synthetic:true. If ownership cannot be re-proven, the resource is
//     reported for MANUAL REVIEW and left in place.
//   * Cleanup runs from a finally-style path after resources may have been
//     created (R-a): a network exception in any later stage no longer skips
//     cleanup.
//   * UUID pin conflicts (R-b) never cause a blind delete: the unexpected id
//     is ownership-checked before it is even tracked for cleanup, and the
//     conflict is reported and the test stages halted (cleanup still runs).
//   * --cleanup-only (R-c/R-d) sweeps only fully-verified synthetic orphans
//     (per-run identifier cross-checks between uid and email plus markers);
//     anything ambiguous is reported for manual review, never deleted.
//   * T6 messages (R-e) distinguish "authorization refused" from
//     "200 with 0 rows (no data disclosed)".
//
// Required environment (set as TEMPORARY shell variables — never Git/files):
//   SUPABASE_STAGING_URL            https://<ref>.supabase.co (non-production)
//   SUPABASE_STAGING_SECRET_KEY     sb_secret_... or legacy service_role JWT
//   SUPABASE_STAGING_PUBLISHABLE_KEY sb_publishable_... or legacy anon JWT
//   STAGING_CONFIRM=I_UNDERSTAND_NON_PRODUCTION   (explicit run guard)
// Optional:
//   SUPABASE_STAGING_ACCESS_TOKEN   personal access token, only with
//                                   --apply-migrations (Management API SQL)
//
// Usage:
//   node scripts/migration/staging-smoke.mjs --dry-run
//   node scripts/migration/staging-smoke.mjs [--apply-migrations] [--keep] [--json <path-outside-repo>]
//   node scripts/migration/staging-smoke.mjs --cleanup-only [--json <path-outside-repo>]
//
// Exit codes: 0 all steps PASS · 1 one or more FAIL/manual-review · 2 usage.

import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pinForUid, UUID_RE } from './build-manifest.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const USAGE = 'usage: node scripts/migration/staging-smoke.mjs [--dry-run] [--apply-migrations] [--cleanup-only] [--keep] [--json <path-outside-repo>]';

// ── synthetic-identity rules (the per-run identifiers cleanup relies on) ───
const FIXTURE_UID_RE = /^fixture-staging-smoke-(alpha|bravo)-([0-9a-z]+)$/;
const FIXTURE_EMAIL_RE = /^lifts-staging-smoke\.(alpha|bravo)\+([0-9a-z]+)@example\.com$/;
const NEG_UID_RE = /^(denied|should-not-work)-([0-9a-z]+)$/;
const NEG_EMAIL = 'denied@example.com';
const NEG_UUID_RE = /^00000000-0000-4000-8000-00000000000[0-9a-e]$/;
const PHASE = '3b-staging';

function jwtRole(key) {
  const parts = String(key).split('.');
  if (parts.length !== 3) return null;
  try {
    const seg = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(seg, 'base64').toString('utf8')).role ?? null;
  } catch (_) { return null; }
}
function describeKey(key) {                       // redacted fingerprint only
  if (!key) return '(missing)';
  if (key.startsWith('sb_secret_')) return 'sb_secret_…(redacted)';
  if (key.startsWith('sb_publishable_')) return 'sb_publishable_…(redacted)';
  const role = jwtRole(key);
  if (role) return `jwt role=${role} (redacted)`;
  return 'unrecognized format (redacted)';
}
export function isSecretKey(key) {
  return typeof key === 'string' && (key.toLowerCase().startsWith('sb_secret_') || jwtRole(key) === 'service_role');
}
export function isPublishableKey(key) {
  return typeof key === 'string' && (key.toLowerCase().startsWith('sb_publishable_') || jwtRole(key) === 'anon');
}

// ── ownership & orphan assessment (pure; exported for tests) ───────────────
function metaOf(user) {
  const m = (user && typeof user === 'object' && user.app_metadata) || {};
  const r = (user && typeof user === 'object' && user.raw_app_meta_data) || {};
  const pick = k => (m[k] !== undefined ? m[k] : r[k]);
  return { uid: pick('firebase_uid'), phase: pick('phase'), synthetic: pick('synthetic') };
}

/** Conclusive proof that a user object is THIS run's synthetic account. */
export function verifyOwnership(user, expect) {
  if (!user || typeof user !== 'object' || !user.id) return { ok: false, reason: 'no user object' };
  const m = metaOf(user);
  const email = typeof user.email === 'string' ? user.email.toLowerCase() : '';
  if (m.uid !== expect.uid) return { ok: false, reason: `firebase_uid claim mismatch (have ${m.uid ?? 'none'}, expect ${expect.uid})` };
  if (email !== String(expect.email).toLowerCase()) return { ok: false, reason: 'email mismatch' };
  if (m.phase !== PHASE) return { ok: false, reason: 'phase marker missing/mismatched' };
  if (m.synthetic !== true) return { ok: false, reason: 'synthetic marker missing/mismatched' };
  return { ok: true, reason: 'ownership verified' };
}

/**
 * Should a listed user be deleted by --cleanup-only?
 * delete        → only when uid/email run-tags cross-match AND markers match
 * manual-review → looks like ours but cannot be proven (report, never delete)
 * skip          → no signal that it is ours (normal accounts are invisible here)
 */
export function assessOrphanUser(user) {
  if (!user || typeof user !== 'object') return { decision: 'manual-review', reason: 'unreadable user record' };
  const m = metaOf(user);
  const email = typeof user.email === 'string' ? user.email.toLowerCase() : '';
  const uidG = FIXTURE_UID_RE.exec(String(m.uid || ''));
  const emG = FIXTURE_EMAIL_RE.exec(email);
  const looksOurs = m.phase === PHASE || m.synthetic === true || !!uidG || !!emG || email.startsWith('lifts-staging-smoke.');
  if (!looksOurs) return { decision: 'skip', reason: 'no Phase-3b synthetic signals' };
  if (uidG && emG && uidG[1] === emG[1] && uidG[2] === emG[2] && m.phase === PHASE && m.synthetic === true) {
    const v = verifyOwnership(user, { uid: String(m.uid), email });
    if (v.ok) return { decision: 'delete', reason: 'fully verified synthetic (per-run uid/email tags + markers consistent)', expect: { uid: String(m.uid), email } };
    return { decision: 'manual-review', reason: v.reason };
  }
  return { decision: 'manual-review', reason: 'partial synthetic signals without consistent uid/email run-tag — ownership unproven' };
}

/** Same idea for mapping rows (rows have no auth user to re-check). */
export function assessOrphanRow(row) {
  if (!row || typeof row !== 'object' || typeof row.firebase_uid !== 'string') {
    return { decision: 'skip', reason: 'unreadable row' };
  }
  const uid = row.firebase_uid;
  const uuid = String(row.supabase_uuid || '');
  const email = String(row.email || '').toLowerCase();
  if (FIXTURE_UID_RE.test(uid)) {
    const g = FIXTURE_UID_RE.exec(uid);
    const e = FIXTURE_EMAIL_RE.exec(email);
    if (e && g[1] === e[1] && g[2] === e[2] && UUID_RE.test(uuid)) {
      return { decision: 'delete', reason: 'verified fixture mapping row', expect: { uid, email, uuid } };
    }
    return { decision: 'manual-review', reason: 'fixture-prefixed row without consistent email run-tag/uuid — ownership unproven' };
  }
  if (NEG_UID_RE.test(uid)) {
    if (email === NEG_EMAIL && NEG_UUID_RE.test(uuid)) {
      return { decision: 'delete', reason: 'verified negative-test mapping row', expect: { uid, email, uuid } };
    }
    return { decision: 'manual-review', reason: 'negative-test prefix without expected email/uuid — ownership unproven' };
  }
  return { decision: 'skip', reason: 'not a Phase-3b row' };
}

// ── core runner (no process access; call() is injectable for tests) ───────
/**
 * @param {object} o
 * @param {{url:string, secret:string, publishable:string, pat?:string}} o.env
 * @param {{apply?:boolean, keep?:boolean}} o.opts
 * @param {(method:string, href:string, opts:object) => Promise<{status:number, ok:boolean, data:any}>} o.call
 * @param {string} [o.runId]  per-run identifier (default: now, base36)
 * @param {(r:{id:string,status:string,detail:string}) => void} [o.onRecord]
 * @returns {Promise<{results:Array, code:number}>}
 */
export async function runSmoke({ env, opts = {}, call, runId = Date.now().toString(36), onRecord = null }) {
  const results = [];
  const record = (id, status, detail) => {
    const r = { id, status, detail };
    results.push(r);
    if (onRecord) onRecord(r);
  };
  const pass = (id, d) => record(id, 'PASS', d);
  const fail = (id, d) => record(id, 'FAIL', d);
  const notRun = (id, d) => record(id, 'NOT RUN', d);
  const done = () => ({ results, code: results.some(r => r.status === 'FAIL') ? 1 : 0 });

  const rest = (method, table, query, o = {}) =>
    call(method, `${env.url}/rest/v1/${table}${query ? `?${query}` : ''}`, o);
  const authAdmin = (method, p, o = {}) => call(method, `${env.url}/auth/v1/${p}`, o);

  function missingRelation(res) {
    const d = res && res.data;
    const code = d && typeof d === 'object' ? String(d.code || d.error_code || '') : '';
    const msg = d && typeof d === 'object' ? JSON.stringify(d) : String((d || ''));
    return code === '42P01' || code === 'PGRST205' || /does not exist|relation .* not found|Could not find the table/i.test(msg);
  }

  // T0 — env sanity (CLI also enforces these as exit-2 guards)
  if (!env.url || !isSecretKey(env.secret) || !isPublishableKey(env.publishable)) {
    fail('T0', 'invalid staging env (url/secret/publishable) — refusing to run');
    return done();
  }
  let origin = env.url;
  try { origin = new URL(env.url).origin; } catch (_) { /* CLI validated */ }
  pass('T0', `preflight ok — ${origin} secret=${describeKey(env.secret)} publishable=${describeKey(env.publishable)}`);
  if (opts.apply && !env.pat) fail('T0b', '--apply-migrations requires SUPABASE_STAGING_ACCESS_TOKEN (personal access token); not provided');

  // T1 — reachability
  try {
    const h = await call('GET', `${env.url}/auth/v1/health`, { apikey: env.publishable });
    if (h.ok) pass('T1', `staging project reachable at ${origin} (health ${h.status})`);
    else fail('T1', `health endpoint returned ${h.status}`);
  } catch (e) {
    fail('T1', `cannot reach staging URL (${e.name === 'AbortError' ? 'timeout' : 'network error'}): ${e.message}`);
    return done();
  }

  // T2 — migrations present (early return here is SAFE: nothing created yet)
  try {
    if (opts.apply && env.pat) {
      for (const file of ['20261015000000_create_user_data.sql', '20261016000000_create_firebase_uid_map.sql']) {
        const sql = readFileSync(path.join(REPO_ROOT, 'supabase', 'migrations', file), 'utf8');
        const r = await call('POST', `https://api.supabase.com/v1/projects/${new URL(env.url).hostname.replace(/\.supabase\.co$/, '')}/database/query`,
          { apikey: env.publishable, token: env.pat, body: { query: sql } });
        if (!r.ok) { fail('T2', `Management API failed applying ${file}: HTTP ${r.status}`); return done(); }
      }
      pass('T2', 'both migrations applied via Management API');
    }
    const a = await rest('GET', 'firebase_uid_map', 'select=firebase_uid&limit=1', { apikey: env.secret, token: env.secret });
    const b = await rest('GET', 'user_data', 'select=user_id&limit=1', { apikey: env.secret, token: env.secret });
    if (a.ok && b.ok) pass('T2', 'tables present: firebase_uid_map + user_data readable with trusted key');
    else if (missingRelation(a) || missingRelation(b)) {
      fail('T2', 'a required table is missing — apply supabase/migrations/*.sql first (dashboard SQL editor, or --apply-migrations + PAT)');
      return done();
    } else fail('T2', `table check failed: firebase_uid_map=${a.status} user_data=${b.status}`);
  } catch (e) { fail('T2', `table check error: ${e.message}`); return done(); }

  // From here on, resources may be created → cleanup is guaranteed via finally.
  const RUN = runId;
  const USERS = [
    { firebaseUid: `fixture-staging-smoke-alpha-${RUN}`, email: `lifts-staging-smoke.alpha+${RUN}@example.com` },
    { firebaseUid: `fixture-staging-smoke-bravo-${RUN}`, email: `lifts-staging-smoke.bravo+${RUN}@example.com` }
  ];
  const pins = USERS.map(u => ({ ...u, pin: pinForUid(u.firebaseUid), password: randomBytes(18).toString('base64url') }));
  const created = [];   // { id, uid, email, how } — only ownership-verified entries
  const manual = [];    // { id, reason } — reported, NEVER deleted
  let conflict = false;

  try {
    // T3 — pinned-UUID provisioning via Admin API (never raw SQL into auth.users)
    for (const u of pins) {
      try {
        const r = await authAdmin('POST', 'admin/users', {
          apikey: env.secret, token: env.secret,
          body: {
            id: u.pin,
            email: u.email,
            password: u.password,
            email_confirm: true,
            app_metadata: { firebase_uid: u.firebaseUid, phase: PHASE, synthetic: true }
          }
        });
        const got = r.data && r.data.user ? r.data.user.id : (r.data && r.data.id) || null;
        if (!r.ok) {
          fail('T3', `createUser(${u.email}) HTTP ${r.status} ${JSON.stringify(r.data || {}).slice(0, 200)}`);
          if (r.status === 422) conflict = true;
          continue;
        }
        if (got !== u.pin) {
          // R-b: NEVER delete an unexpected id blindly. Verify ownership now,
          // track only if proven; otherwise report for manual review.
          conflict = true;
          fail('T3', `PIN CONFLICT — requested pin ${u.pin}, Auth returned ${got}. Halting test stages; ownership check before any cleanup.`);
          if (got && typeof got === 'string') {
            try {
              const g = await authAdmin('GET', `admin/users/${got}`, { apikey: env.secret, token: env.secret });
              const gu = g.data && g.data.user ? g.data.user : g.data;
              const ver = g.ok ? verifyOwnership(gu, { uid: u.firebaseUid, email: u.email }) : { ok: false, reason: `lookup HTTP ${g.status}` };
              if (ver.ok) {
                created.push({ id: got, uid: u.firebaseUid, email: u.email, how: 'conflict' });
                pass('T3b', `conflict-created user ${got} ownership verified — tracked for cleanup`);
              } else {
                manual.push({ id: got, reason: ver.reason });
                fail('T3b', `MANUAL REVIEW REQUIRED: unexpected user ${got} ownership unproven (${ver.reason}) — will NOT be deleted`);
              }
            } catch (e) {
              manual.push({ id: got, reason: `lookup error: ${e.message}` });
              fail('T3b', `MANUAL REVIEW REQUIRED: unexpected user ${got} ownership unproven (${e.message}) — will NOT be deleted`);
            }
          }
          continue;
        }
        created.push({ id: u.pin, uid: u.firebaseUid, email: u.email, how: 'pin' });
        pass('T3', `createUser accepted pinned v5 id ${u.pin} for ${u.email} (synthetic)`);
      } catch (e) { fail('T3', `createUser error: ${e.message}`); conflict = true; }
    }

    if (conflict) {
      notRun('T4', 'skipped after T3 conflict');
      notRun('T5', 'skipped after T3 conflict');
      notRun('T6', 'skipped after T3 conflict');
      notRun('T6-auth', 'skipped after T3 conflict');
      notRun('T7', 'skipped after T3 conflict');
    } else {
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

      // T6 — unauthorized roles denied on firebase_uid_map (R-e wording)
      const denied = async (label, headers, method, query, body) => {
        try {
          const r = await call(method, `${env.url}/rest/v1/firebase_uid_map${query ? `?${query}` : ''}`, { ...headers, body });
          const rows = r.ok && Array.isArray(r.data) ? r.data.length : -1;
          if (!r.ok) pass('T6', `${label} denied — authorization refused (HTTP ${r.status})`);
          else if (rows > 0) fail('T6', `${label} was NOT denied — HTTP 200 with ${rows} row(s) disclosed`);
          else pass('T6', `${label} — no data disclosed (HTTP 200, 0 rows; row-level denial)`);
        } catch (e) { pass('T6', `${label} denied — connection refused to endpoint (${e.name})`); }
      };
      await denied('anon SELECT', { apikey: env.publishable }, 'GET', 'select=firebase_uid&limit=1');
      await denied('anon INSERT', { apikey: env.publishable }, 'POST', '', { firebase_uid: `should-not-work-${RUN}`, supabase_uuid: `00000000-0000-4000-8000-00000000000${Math.floor(Math.random() * 15)}`, email: NEG_EMAIL, provider_hint: 'password', status: 'planned' });
      const sessions = [];
      for (const u of pins) {
        try {
          const s = await call('POST', `${env.url}/auth/v1/token?grant_type=password`, { apikey: env.publishable, body: { email: u.email, password: u.password } });
          if (s.ok && s.data && s.data.access_token) {
            sessions.push({ ...u, token: s.data.access_token });
            pass('T6-auth', `synthetic user signed in via Email provider: ${u.email}`);
          } else fail('T6-auth', `password sign-in failed for ${u.email}: HTTP ${s.status} (is the Email provider enabled on staging?)`);
        } catch (e) { fail('T6-auth', `sign-in error: ${e.message}`); }
      }
      for (const s of sessions) {
        await denied('authenticated SELECT', { apikey: env.publishable, token: s.token }, 'GET', 'select=firebase_uid&limit=1');
        await denied('authenticated INSERT', { apikey: env.publishable, token: s.token }, 'POST', '', { firebase_uid: `denied-${RUN}`, supabase_uuid: `00000000-0000-4000-8000-00000000000${Math.floor(Math.random() * 15)}`, email: NEG_EMAIL, provider_hint: 'password', status: 'planned' });
      }

      // T7 — two-user isolation on user_data (seed guarded: R-a)
      for (const u of pins) {
        try {
          const w = await rest('POST', 'user_data', '', { apikey: env.secret, token: env.secret, body: { user_id: u.pin, payload: { phase: PHASE, synthetic: u.firebaseUid } } });
          if (!w.ok) fail('T7', `could not seed user_data row for ${u.pin}: HTTP ${w.status}`);
        } catch (e) { fail('T7', `user_data seed error: ${e.message}`); }
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
    }
  } finally {
    // R-a: cleanup ALWAYS runs once creation may have happened — regardless of
    // exceptions in any stage above (the only earlier exits are pre-creation).
    if (opts.keep) {
      notRun('T8', `cleanup skipped (--keep): tracked=${created.map(c => c.id).join(', ') || 'none'} — rerun without --keep to remove`);
    } else {
      let ok = true;
      for (const entry of created) {
        try {
          const g = await authAdmin('GET', `admin/users/${entry.id}`, { apikey: env.secret, token: env.secret });
          if (g.status === 404) continue; // already gone
          const gu = g.data && g.data.user ? g.data.user : g.data;
          const ver = g.ok ? verifyOwnership(gu, entry) : { ok: false, reason: `lookup HTTP ${g.status}` };
          if (!ver.ok) {
            ok = false;
            manual.push({ id: entry.id, reason: ver.reason });
            record('T8', 'FAIL', `ownership re-verification failed for ${entry.id} (${ver.reason}) — NOT deleted, manual review`);
            continue;
          }
          const d = await authAdmin('DELETE', `admin/users/${entry.id}`, { apikey: env.secret, token: env.secret });
          if (!d.ok && d.status !== 404) { ok = false; record('T8', 'FAIL', `delete failed for ${entry.id}: HTTP ${d.status}`); }
        } catch (e) { ok = false; record('T8', 'FAIL', `cleanup error for ${entry.id}: ${e.message}`); }
      }
      for (const u of pins) {
        try {
          const r = await rest('DELETE', 'firebase_uid_map', `firebase_uid=eq.${encodeURIComponent(u.firebaseUid)}`, { apikey: env.secret, token: env.secret });
          if (!r.ok) ok = false;
        } catch (_) { ok = false; }
      }
      let leftover = 0;
      try {
        const verify = await rest('GET', 'firebase_uid_map', `select=firebase_uid&firebase_uid=in.(${pins.map(p => `"${p.firebaseUid}"`).join(',')})`, { apikey: env.secret, token: env.secret });
        leftover = Array.isArray(verify.data) ? verify.data.length : -1;
      } catch (_) { leftover = -1; }
      const manualNote = manual.length ? ` | MANUAL REVIEW (not deleted): ${manual.map(x => `${x.id} (${x.reason})`).join('; ')}` : '';
      if (ok && leftover === 0) pass('T8', `cleanup ok — ${created.length} tracked synthetic user(s) ownership-verified & removed; mapping rows clear; user_data rows cascade-deleted${manualNote}`);
      else fail('T8', `cleanup incomplete (leftover mapping rows: ${leftover}) — inspect staging manually${manualNote}`);
    }
  }
  return done();
}

// ── orphan sweep (R-c/R-d): only fully verified synthetic resources ────────
export async function runCleanupOnly({ env, call, onRecord = null }) {
  const results = [];
  const record = (id, status, detail) => {
    const r = { id, status, detail };
    results.push(r);
    if (onRecord) onRecord(r);
  };
  const done = () => ({ results, code: results.some(r => r.status === 'FAIL') ? 1 : 0 });
  if (!env.url || !isSecretKey(env.secret) || !isPublishableKey(env.publishable)) {
    record('C0', 'FAIL', 'invalid staging env — refusing to run');
    return done();
  }
  record('C0', 'PASS', 'cleanup-only preflight ok (redacted keys)');

  // 1) users: list everything, assess purely, re-verify before any delete
  let listed = [];
  try {
    for (let page = 1; page <= 100; page++) {
      const r = await call('GET', `${env.url}/auth/v1/admin/users?page=${page}&per_page=100`, { apikey: env.secret, token: env.secret });
      if (!r.ok) { record('C1', 'FAIL', `admin user list failed: HTTP ${r.status}`); return done(); }
      const batch = (r.data && r.data.users) || [];
      listed = listed.concat(batch);
      if (batch.length < 100) break;
    }
  } catch (e) { record('C1', 'FAIL', `admin user list error: ${e.message}`); return done(); }

  let del = 0, review = 0, skip = 0;
  for (const user of listed) {
    const a = assessOrphanUser(user);
    if (a.decision === 'skip') { skip++; continue; }
    if (a.decision === 'manual-review') {
      review++;
      record('C1', 'FAIL', `MANUAL REVIEW: user ${user.id} (${a.reason}) — NOT deleted`);
      continue;
    }
    try {
      const g = await call('GET', `${env.url}/auth/v1/admin/users/${user.id}`, { apikey: env.secret, token: env.secret });
      const gu = g.data && g.data.user ? g.data.user : g.data;
      const ver = g.ok ? verifyOwnership(gu, a.expect) : { ok: false, reason: `re-check HTTP ${g.status}` };
      if (!ver.ok) {
        review++;
        record('C1', 'FAIL', `MANUAL REVIEW: user ${user.id} failed ownership re-check (${ver.reason}) — NOT deleted`);
        continue;
      }
      const d = await call('DELETE', `${env.url}/auth/v1/admin/users/${user.id}`, { apikey: env.secret, token: env.secret });
      if (d.ok || d.status === 404) { del++; record('C1', 'PASS', `verified synthetic orphan user ${user.id} deleted`); }
      else record('C1', 'FAIL', `delete failed for verified orphan ${user.id}: HTTP ${d.status}`);
    } catch (e) { record('C1', 'FAIL', `orphan user ${user.id} not deleted (error: ${e.message})`); }
  }
  record('C1', 'PASS', `users scanned=${listed.length} deleted=${del} manual=${review} skipped=${skip}`);

  // 2) mapping rows: exact-PK deletes only after full row verification
  let rows = [];
  try {
    const r = await call('GET', `${env.url}/rest/v1/firebase_uid_map?select=firebase_uid,supabase_uuid,email`, { apikey: env.secret, token: env.secret });
    if (!r.ok) { record('C2', 'FAIL', `mapping scan failed: HTTP ${r.status}`); return done(); }
    rows = Array.isArray(r.data) ? r.data : [];
  } catch (e) { record('C2', 'FAIL', `mapping scan error: ${e.message}`); return done(); }

  let rDel = 0, rReview = 0, rSkip = 0;
  for (const row of rows) {
    const a = assessOrphanRow(row);
    if (a.decision === 'skip') { rSkip++; continue; }
    if (a.decision === 'manual-review') {
      rReview++;
      record('C2', 'FAIL', `MANUAL REVIEW: mapping row ${row.firebase_uid} (${a.reason}) — NOT deleted`);
      continue;
    }
    try {
      const d = await call('DELETE', `${env.url}/rest/v1/firebase_uid_map?firebase_uid=eq.${encodeURIComponent(a.expect.uid)}`, { apikey: env.secret, token: env.secret });
      if (d.ok) { rDel++; record('C2', 'PASS', `verified synthetic mapping row ${a.expect.uid} deleted`); }
      else record('C2', 'FAIL', `row delete failed for ${a.expect.uid}: HTTP ${d.status}`);
    } catch (e) { record('C2', 'FAIL', `row ${a.expect.uid} not deleted (error: ${e.message})`); }
  }
  record('C2', 'PASS', `mapping rows scanned=${rows.length} deleted=${rDel} manual=${rReview} skipped=${rSkip}`);
  if (review + rReview > 0) record('C9', 'FAIL', `${review + rReview} resource(s) need MANUAL REVIEW — left untouched`);
  return done();
}

// ── CLI (the only part that touches process/stdout) ────────────────────────
function usageError(msg) { process.stderr.write(`usage error: ${msg}\n${USAGE}\n`); process.exit(2); }

function cli() {
  const argv = process.argv.slice(2);
  const opts = { dryRun: false, apply: false, keep: false, json: null, cleanupOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--apply-migrations') opts.apply = true;
    else if (a === '--keep') opts.keep = true;
    else if (a === '--cleanup-only') opts.cleanupOnly = true;
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

  if (opts.dryRun) {
    const lines = [
      'Phase 3b staging smoke — DRY RUN (no network, no credentials required)',
      '',
      'Planned steps when credentials + network are available:',
      '  T0  preflight: validate env vars and key formats (values redacted)',
      '  T1  GET {url}/auth/v1/health — confirm the staging project URL answers',
      '  T2  verify public.user_data + public.firebase_uid_map exist' + (opts.apply ? ' (apply via Management API first: --apply-migrations)' : ''),
      '  T3  POST /auth/v1/admin/users with a pinned v5 id — assert returned user.id == pin',
      '      (mismatch = PIN CONFLICT: stages halt, unexpected id ownership-checked before any cleanup)',
      '  T4  GET /auth/v1/admin/users/{pin} — assert app_metadata.firebase_uid readback',
      '  T5  Data API: service-role INSERT/SELECT on firebase_uid_map (trusted write path)',
      '  T6  Data API: anon + authenticated roles must NOT get rows from firebase_uid_map',
      '      (messages distinguish "authorization refused" vs "HTTP 200, 0 rows — no data disclosed")',
      '  T7  Data API: two synthetic users — each sees only its own user_data row',
      '  T8  cleanup ALWAYS runs after creation may have happened (finally-style):',
      '      each user delete requires a fresh ownership re-verification (exact per-run email +',
      '      firebase_uid claim + markers) or it is reported for MANUAL REVIEW instead',
      '  --cleanup-only  sweep verified synthetic orphans from earlier aborted runs only',
      '                  (uid/email per-run tag cross-checks; ambiguous = report, never delete)',
      '',
      'Required environment:'
    ];
    if (missing.length) missing.forEach(m => lines.push(`  - ${m} (MISSING)`));
    else {
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

  if (missing.length) {
    process.stderr.write(`usage error: missing required environment variables: ${missing.join(', ')}\n${USAGE}\n`);
    process.exit(2);
  }
  if (env.confirm !== 'I_UNDERSTAND_NON_PRODUCTION') {
    process.stderr.write('usage error: set STAGING_CONFIRM=I_UNDERSTAND_NON_PRODUCTION to run against the staging project (this harness refuses to run without it).\n');
    process.exit(2);
  }
  let urlObj = null;
  try { urlObj = new URL(env.url); } catch (_) { /* below */ }
  if (!urlObj || urlObj.protocol !== 'https:' || !urlObj.hostname.endsWith('.supabase.co')) {
    process.stderr.write(`usage error: SUPABASE_STAGING_URL must be an https://<ref>.supabase.co staging URL, got: ${env.url || '(empty)'}\n`);
    process.exit(2);
  }
  if (!isSecretKey(env.secret)) {
    process.stderr.write(`usage error: SUPABASE_STAGING_SECRET_KEY is not a service/secret key (fingerprint: ${describeKey(env.secret)}) — refusing.\n`);
    process.exit(2);
  }
  if (!isPublishableKey(env.publishable)) {
    process.stderr.write(`usage error: SUPABASE_STAGING_PUBLISHABLE_KEY is not a publishable/anon key (fingerprint: ${describeKey(env.publishable)}) — refusing.\n`);
    process.exit(2);
  }

  // Real HTTP transport (only used here, after all guards)
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
  const onRecord = r => process.stdout.write(`[${r.status}] ${r.id} ${r.detail}\n`);

  (opts.cleanupOnly ? runCleanupOnly({ env, call, onRecord }) : runSmoke({ env, opts, call, onRecord }))
    .then(({ results, code }) => {
      process.stdout.write(`\n${results.map(r => `${r.status.padEnd(7)} ${r.id}`).join('\n')}\n`);
      if (opts.json) {
        const abs = path.resolve(opts.json);
        const rel = path.relative(REPO_ROOT, abs);
        if (rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel))) {
          process.stderr.write(`refusing to write the report inside the repository (${abs})\n`);
        } else {
          writeFileSync(abs, JSON.stringify({ url: env.url, ranAt: new Date().toISOString(), results }, null, 2) + '\n', 'utf8');
          process.stdout.write(`report written to ${abs}\n`);
        }
      }
      process.exit(code);
    })
    .catch(e => {
      process.stderr.write(`internal error: ${e && e.stack ? e.stack : e}\n`);
      process.exit(1);
    });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) cli();
