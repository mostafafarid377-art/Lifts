# LIFTS — Phase 3b Staging Verification Report

**Status: NOT RUN — stopped at the access gate (no staging credentials, no tooling,
no network egress).**

- Report date: 2026-10-16
- Plan followed: `docs/phase-3-auth-migration-plan.md` (“Phase 3a verification
  addendum” → “Phase 3b-staging”)
- Harness: `scripts/migration/staging-smoke.mjs` (repeatable; committed with this report)
- Nothing was applied to any Supabase project (staging or production), no Firebase
  data was accessed, no user was created, no production code or deployment changed,
  and no credential exists in this repository, these files, or any log.

## Access gate (performed)

| Probe | Result |
|---|---|
| Supabase env vars / `.env` / `~/.supabase` / `~/.netrc` | none present (only variable *names* scanned) |
| `supabase` CLI / `psql` / `docker` | all missing (`node` only) |
| TLS to `https://msnoktushqwadtknxrij.supabase.co/auth/v1/health` | **blocked** (SSL_ERROR_SYSCALL — sandbox egress allowlist has no Supabase hosts) |
| TLS to `https://api.supabase.com` (Management API) | **blocked** (same) |

## Test matrix (tasks 1–9)

| # | Task | Status | Notes |
|---|---|---|---|
| 1 | Confirm staging project + URL | **NOT RUN** | Awaiting your confirmation that `msnoktushqwadtknxrij` (from `supabase/README.md`) is the **non-production** staging project — or the correct ref/URL to use instead |
| 2 | Apply the two schema-only migrations to staging | **NOT RUN** | No DB/Management credentials; `psql`/CLI absent. Harness supports two paths once provided (Dashboard SQL editor by you, or `--apply-migrations` + PAT) |
| 3 | Create synthetic users via Auth Admin API (never raw `auth.users` inserts) | **NOT RUN** | Implemented in harness T3; blocked by gate |
| 4 | Pinned UUID accepted; returned `user.id` matches pin (else stop + report conflict) | **NOT RUN** | Implemented in harness T3 (halts with `PIN CONFLICT` on mismatch); blocked by gate |
| 5 | Set + read back `app_metadata.firebase_uid` via trusted Admin API | **NOT RUN** | Implemented in harness T4; blocked by gate |
| 6 | Trusted role can write mapping table; unauthorized roles denied | **NOT RUN** | Implemented in harness T5/T6 (service write+read; anon and authenticated denial on select+insert); blocked by gate |
| 7 | RLS isolation for two synthetic users on `user_data` | **NOT RUN** | Implemented in harness T7 (two accounts, own-row only, cross-read empty); blocked by gate |
| 8 | Firebase password-hash import (optional) | **NOT RUN (not attempted by design)** | Awaiting explicit approval (plan decision D-14); no hash material was sought |
| 9 | Repeatable tests / this report + `node --test tests/*.test.cjs` | **Harness + report delivered (PASS) / unit suite PASS** | Unit suite result below; staging matrix above stays NOT RUN until the gate opens |

### Offline checks run instead (all PASS)

| Check | Result |
|---|---|
| Harness `--dry-run` (no credentials, no network) | **PASS** — prints the T0–T8 plan and lists missing env vars; exit 0 |
| Harness real-run preflight without credentials | **PASS (guard)** — refuses with exit 2 listing the required env vars; no partial execution |
| Harness refuses missing `STAGING_CONFIRM` guard / non-`.supabase.co` URL / wrong key types | **PASS (guard)** — coded as preflight refusals (no credential ever printed) |
| `node --test tests/*.test.cjs` | **PASS** — see exact counts in the “Unit results” section |

## Unit results (run 2026-10-16)

| Suite | Tests | Pass | Fail |
|---|---|---|---|
| `tests/body-map.test.cjs` (regression) | 21 | 21 | 0 |
| `tests/supabase-preparation.test.cjs` | 7 | 7 | 0 |
| `tests/migration-manifest.test.cjs` | 18 | 18 | 0 |
| **Combined `node --test tests/*.test.cjs`** | **46** | **46** | **0** |

## Exactly what you need to provide to unblock

1. **Project confirmation:** confirm the staging (non-production) Supabase project ref
   and URL — e.g. “`msnoktushqwadtknxrij` IS the staging project” — or give the correct
   one. The harness hard-requires an `https://<ref>.supabase.co` URL plus the explicit
   `STAGING_CONFIRM=I_UNDERSTAND_NON_PRODUCTION` env guard.
2. **Staging keys (kept out of Git — supply as environment variables on the machine
   that runs the harness, or via Arena’s secret mechanism if one is offered):**
   - `SUPABASE_STAGING_SECRET_KEY` — secret/service-role key (`sb_secret_…` or legacy
     `service_role` JWT) for the **staging** project only.
   - `SUPABASE_STAGING_PUBLISHABLE_KEY` — publishable/anon key (`sb_publishable_…` or
     legacy anon JWT) for the **staging** project only.
   - Do **not** send keys in chat if you can avoid it; the harness never prints them
     (redacted fingerprints only) and `.gitignore` covers local env files.
3. **Migration application — pick ONE:**
   - You run the two files (`supabase/migrations/20261015000000_create_user_data.sql`,
     `…/20261016000000_create_firebase_uid_map.sql`) in the staging **Dashboard SQL
     Editor**, or
   - Provide `SUPABASE_STAGING_ACCESS_TOKEN` (personal access token scoped to the
     staging project) and run the harness with `--apply-migrations`.
4. **Network path:** this sandbox cannot reach `*.supabase.co` or `api.supabase.com`
   (egress allowlist). Either the run happens from your own machine
   (`node scripts/migration/staging-smoke.mjs …` after `git pull`, then paste the
   `--json` report back to me), or Arena egress to those hosts must be enabled for
   this workspace.
5. **Staging Auth configuration:** Email provider **enabled** with sign-ins allowed
   for confirmed users (the harness creates users `email_confirm: true` and then
   signs in via password to test RLS; Google is not needed for Phase 3b).

## How to run (repeatable)

```sh
# 1) offline self-check, no credentials:
node scripts/migration/staging-smoke.mjs --dry-run

# 2) real staging run (in the trusted environment that holds the keys):
export SUPABASE_STAGING_URL="https://<ref>.supabase.co"
export SUPABASE_STAGING_SECRET_KEY="sb_secret_..."       # staging only
export SUPABASE_STAGING_PUBLISHABLE_KEY="sb_publishable_..."
export STAGING_CONFIRM=I_UNDERSTAND_NON_PRODUCTION
# optional, only to apply the two schema files:
# export SUPABASE_STAGING_ACCESS_TOKEN="..."             # personal access token

node scripts/migration/staging-smoke.mjs --apply-migrations --json /tmp/lifts-phase3b-report.json
echo "exit=$?"   # 0 = every step PASS · 1 = a FAIL (read the [FAIL] lines) · 2 = preflight
```

Expected PASS sequence: `T0 → T1 → T2 → T3 (×2) → T4 (×2) → T5 (×2) → T6 denials →
T6-auth (×2) → T7 (×2) → T8`. Any `PIN CONFLICT` in T3 stops the run before any
data import could be planned (plan addendum V1). Cleanup (T8) removes all synthetic
users (FK cascades their `user_data` rows) and mapping rows unless `--keep` is passed.

## Safety attestation

No production cutover has begun; Firebase remains the production backend; no SQL was
applied to any project; no real Firebase or Supabase user data was read, exported, or
migrated; no key is present in this repository, in committed files, or in logs
(harness redacts all credentials); the optional password-hash path (D-14) was not
attempted.
