# LIFTS — Phase 3c: Prioritized Remaining Migration Work

**Status: PLANNING / OFFLINE PREPARATION ONLY.** Nothing in this document has been
executed against any live system. No Supabase project and no Firebase project was
contacted, no SQL was applied, no user or database row was created, modified, or
deleted, no real user data was read or migrated, no password was changed, nothing was
deployed, and **no live staging check has passed** — the Phase 3b matrix remains
**NOT RUN** (`docs/phase-3b-staging-report.md`). Firebase remains the production
backend for the live LIFTS website.

- **Date:** 2026-10-16
- **Branch / baseline:** `arena/f40c8656-lifts` @ `74b73ce` (+ this document and the
  Phase 3c test additions)
- **Sources reviewed:** `docs/phase-3-auth-migration-plan.md` (full, 890 lines),
  `docs/phase-3b-staging-report.md` (full), `supabase/README.md`, the migration
  harness/builder, the Phase 2 adapter pair, `index.html`, and the auth / recovery /
  switching / sign-out sections of `js/app.js` (inspection log in §2).
- **Environment facts:** Windows + Node.js 24 + Git on your machine; 60/60 tests were
  green at `74b73ce`; **one Supabase project only — no second staging project can be
  created** (see §1).

---

## 1. Constraint update: a single Supabase project (revises decision D-12)

You have **one** Supabase project (the ref referenced in `supabase/README.md`,
`msnoktushqwadtknxrij`) and cannot create a separate staging project. The plan’s
original assumption (“staged project first, production Supabase later”) no longer
applies as written. What this changes — and what it does not:

**Unchanged (still safe):**

- **Production is Firebase, not Supabase.** The live site authenticates and stores data
  via Firebase only (`index.html:17–19`, `js/firebase.js`). The single Supabase project
  is, today, not serving production traffic — so it is used *as* the staging project,
  exactly as the Phase 3b safety rules intend: Firebase is the production system and
  the rollback target no matter what happens there.
- Every Phase 3b guard remains: `https://<ref>.supabase.co` URL check,
  `STAGING_CONFIRM=I_UNDERSTAND_NON_PRODUCTION`, synthetic-only accounts for the
  smoke run, harness self-cleanup with `--cleanup-only` as the orphan sweeper, and the
  approval gate before any real user data.
- Migrations are schema-only and additive; applying them early to the only project is
  required anyway for the eventual target, and creates no users, moves no data, and
  touches no production code.

**Changed (new decision D-12b — approval required before any live step):**

| | |
|---|---|
| **D-12b** | Approve using the **single** Supabase project as rehearsal + target under these rules: (a) you confirm it currently holds **nothing production-critical** (no app depends on it; any existing content is disposable test content); (b) order is strict — schema → synthetic smoke → test accounts → validation gates → **only then** real data, each gated separately; (c) real-user import (L8) stays a distinct, separately approved step even after smoke PASS; (d) the failure mode “staging gets messy” degrades to “the unused target gets messy” — acceptable because production data never lives there until L8+. |
| **Recommendation** | **(a) proceed single-project** — deferring 3b indefinitely stalls the whole phase, and the risk budget above keeps production out of reach either way. |

**Explicit non-change:** even under D-12b, the app’s production deployment, Firebase
Auth/Firestore, and all live-user behavior remain untouched until the separately
approved cutover change-set (L9).

---

## 2. Inspection of the current implementation (offline read-only)

### 2.1 Migration adapter (Phase 2 — isolated, un-wired)

| File | Finding |
|---|---|
| `js/supabase-client.js` (59 lines) | Factory **not referenced by `index.html`** — the production page loads only Firebase CDN scripts (`index.html:17–19`) and `js/app.js` (`:584`). `validateClientConfig()` throws on `sb_secret_*` / `role=service_role` keys **before** the SDK is even imported (lazy `import()` of esm.sh happens only after validation). Auth options already set `persistSession/autoRefreshToken/detectSessionInUrl` (needed by the future recovery flow). Covered by 2 tests. |
| `js/supabase-data.js` (91 lines) | `loadSupabaseUserData` / `saveSupabaseUserData` derive row ownership **only** from `client.auth.getUser()` (never a caller-supplied uid; `UUID_RE` enforced). Load = `.eq('user_id').maybeSingle()`; save = full-row `.upsert(..., onConflict:'user_id')` matching Firestore `set()` semantics; payload is opaque (no whitelist/normalization), so unknown/future fields survive. Covered by 5 tests (7 total for the pair). |
| Verdict | The adapter is migration-ready and deliberately dormant. Wiring it into the save/load path **is** a production-file change and stays behind the cutover approval (L9). |

### 2.2 Authentication flow (`js/app.js` — Firebase 8.10.1 compat only)

- **Sign-up / sign-in:** `doAuth()` (`js/app.js:690`) → `createUserWithEmailAndPassword`
  / `signInWithEmailAndPassword`; client checks: non-empty fields, signup password
  match, **min 6 chars** (`:702`).
- **Password reset:** `doForgot()` (`:671`) → `sendPasswordResetEmail`; shown on the
  Sign In tab only.
- **Google:** `doGoogle()` (`:714`) → `signInWithPopup` with
  `prompt: 'select_account'` (`:720–721`); popup-cancel errors special-cased.
- **Auth state:** single `auth.onAuthStateChanged` (`:628`) — the uid-change branch
  calls `p1SwitchUser()` **before** the new account loads; same-account
  re-announcements never reload over unsaved state (`:636`).
- **Error mapping:** `friendlyErr()` (`:762`) maps Firebase codes; Supabase error codes
  are **not** mapped anywhere yet (gap G2 below).
- No anonymous sign-in exists (confirmed again this review). No Supabase import,
  call, or global exists anywhere in the production path.

### 2.3 Data recovery safeguards (inventory — all live today, all preserved)

| Safeguard | Location | Behavior pinned by |
|---|---|---|
| Per-uid save queue: serialized writes, newest-state-wins, retry/backoff, 15 s timeout | `newSV/drain/scheduleSave` `:545–620` | existing suites + manual audit |
| Local snapshot written synchronously with every change; removed **only** after confirmed cloud write (`snapClearIf`) | `:548–551`, `:589` | **new test** (§5) |
| Load-time conflict parking: snapshot wins only if `ts >= cloud.savedAt`, else parked under `lifts_snapconflict_<uid>` — never deleted | `snapPick` `:553–559` | code audit |
| Sign-out flush: `flushSave()` with 4 s cap **before** `auth.signOut()`; two-tier warning (snapshot exists vs nothing saved); user can abort | `doSignOut` `:734–760` | **2 new tests** (§5) |
| Quarantine keys for damaged snapshots/entries (3 + 100 caps) | `:141`, `:407` | code audit |
| Offline workout queue `lifts_pw_<uid>` merged by id, pruned only after confirmed save | `p1MergePending` `:3026–3044` | code audit |
| Active-workout restore: newer of local `updatedAt` vs cloud wins | `wkResolveRestore` `:2998` | code audit |
| All seven recovery keys are **uid-suffixed** (§1.9 of the plan) — the exact set the remap shim must handle | see plan | remap shim (O1) |

### 2.4 Account switching

`p1SwitchUser()` (`js/app.js:2941`): (1) unsaved in-memory state of the departing
account is written to **that uid’s** snapshot first (`:2946–2947`); (2) timers/save
queue/`loadSeq` cancelled; (3) every per-user in-memory structure wiped, including
`EXTRA`, `REPAIR`, selection state, and rendered DOM lists. **New test** pins
snapshot parking + wipe (§5). Existing test already pinned the UI-state half.

### 2.5 Sign-out

Exactly as audited in Step 2 of the walkthrough, now under test: flush → conditional
warnings → `auth.signOut()` → in-memory reset, and **localStorage is never cleared on
sign-out** (it belongs to the uid and is the recovery path).

### 2.6 Gap list — what does not exist yet

| # | Gap | Track |
|---|---|---|
| G1 | LocalStorage **remap shim** (plan §4.2) — the anti-mixing, copy-not-move bridge from Firebase-uid keys to UUID keys | O1 |
| G2 | Supabase error mapping + “set new password” recovery UI (plan §6.3) | L9 change-set |
| G3 | Feature-flag wiring of adapter into `loadUserData`/`drain` (plan §2.2 step 8) | L9 change-set |
| G4 | Firebase export tooling (plan §5.2) | L7 (live Firebase — separate approval) |
| G5 | Provision runner: Admin API `createUser` with pin, response-id == pin check, manifest status advance (beyond the synthetic smoke) | O2 → L8 |
| G6 | Import runner: `user_data` rows from manifest + export, FK order, per-row checksum | O3 → L8 |
| G7 | Validation gate tool: manifest ↔ table ↔ `app_metadata` ↔ `user_data` 4-way set equality (E15) + count identity + semantic payload diff | O4 → L8 |
| G8 | Rollback reverse-sync tool (plan §5.4 `updated_at > T_cutover` re-import) | O5 → post-L9 readiness |
| G9 | Google provider config + **auto-link proof** for pre-provisioned users (plan §8.4, R1/E4 — blocking gate for Google accounts) | L5 |
| G10 | Live smoke T0–T8 + auth-flow rehearsal (plan §5.3.4) | L3/L4 — **still NOT RUN** |
| — | Doc nit: plan §3.1 says pins are “UUIDv4”; the implemented builder emits deterministic **UUIDv5** (`build-manifest.mjs` header + test “uuidv5 pins follow RFC 4122”). Implemented behavior is authoritative; noted for a later doc touch-up. | — |

---

## 3. Safest next development step (entirely offline) — **O1: the remap shim**

**Why this is the safest and right next step:**

1. **Highest residual risk, lowest blast radius.** R9 (localStorage mixing two
   accounts) is rated High in the plan; D-11 requires the shim in the cutover
   change-set. Building and testing it *now* — as an isolated module that no
   production file imports — removes the biggest unknown from the eventual cutover
   batch without touching anything live.
2. **Purely offline-testable.** Its entire input surface is (a) `localStorage`,
   (b) a session object `{ user.id, user.app_metadata.firebase_uid }`, and (c) the
   pin derivation. No network, no keys, no server calls — fixture tests in the
   existing dependency-free `node --test` style.
3. **Follows the sanctioned pattern.** Like `js/supabase-client.js` /
   `js/supabase-data.js`, it ships as an isolated module **not referenced by
   `index.html`** until the approved cutover change-set wires it in. Zero change to
   the live Firebase app, auth flow, or deployment.

**Scope (acceptance criteria for O1):**

- New `js/phase3-remap.js` + `tests/phase3-remap.test.cjs`. No other file changes.
- **Identity gate:** run only when `session.user.app_metadata.firebase_uid` is a
  non-empty string **and** recomputing the pin — RFC 4122 UUIDv5 of that uid under the
  fixed project namespace `6e7a1c90-…-2a5d8e0f1b64`, same constant as
  `build-manifest.mjs` — equals `session.user.id`. Claim absent or pin mismatch →
  **no-op** (report only, never guess, never infer from email). This proves the
  session belongs to that old uid *without* ever reading the mapping table (which is
  service-role-only by design).
- **Copy, don’t move:** all seven prefixes (`lifts_snap_`, `lifts_snapconflict_`,
  `lifts_snapquarantine_`, `lifts_quarantine_`, `lifts_repairnote_`, `lifts_pw_`,
  `lifts_aw_`): old key present + new key absent → copy; old key always kept (rollback
  path; deletion is a separate later approval).
- **Conflict policy per type:** snapshot / active-workout → newer `ts`/`updatedAt`
  wins, loser parked under `lifts_snapconflict_<uuid>`; pending queue → union by
  workout `id` (same dedup as `p1MergePending`); quarantine / repairnote → capped
  concatenation at existing limits.
- **Strict 1:1, idempotent, per-device:** one old uid → one uuid; reruns are no-ops;
  never writes for a uid other than the current session; never runs signed out; never
  reads or writes network.

---

## 4. Prioritized plan for the remaining work

### Track O — offline preparation (no credentials, no network; can proceed under this standing constraint)

| # | Step | Depends on | Produces |
|---|---|---|---|
| **O1** | **Remap shim module + tests** (§3) — *next; awaiting your approval* | none | G1 closed, cutover-critical R9 mitigated |
| **O2** | Provision runner core: Admin-API `createUser({id: pin, email_confirm, app_metadata})` logic + pin-response verification + manifest status transitions, developed against the same **fake backend** style as `staging-smoke.test.cjs` (live call path inert until run with real keys) | O1 optional | G5 offline half |
| **O3** | Import runner core: manifest row + exported doc → planned `user_data` upsert operations; FK ordering; per-row sha256; refuses set mismatches — fixture-tested offline | O2 | G6 offline half |
| **O4** | Validation gate tool: 4-way reconciliation (manifest ↔ `firebase_uid_map` ↔ `app_metadata` ↔ `user_data`), count identity, semantic (canonical-JSON) payload diff per plan §5.3 | O2, O3 | G7 offline half |
| **O5** | Rollback reverse-sync tool core (`updated_at > T_cutover` → per-uid re-import plan), fixture-tested; live target only after L9 exists | O4 | G8 offline half |
| **O6** | Rehearsal artifacts: step-by-step expected-output checklist for the §5.3.4 auth-flow tests and the §8.4 Google auto-link test (written now, executed live later) | none | G10 run-books |
| O7 | *Deferred by rule:* authoring the cutover change-set itself (flag wiring G3, recovery UI G2, shim wiring) — **requires explicit approval as a production-file change-set; not part of standing offline scope** | O1–O6, L4, L5 | cutover PR |

### Track L — live Supabase (and eventually Firebase) operations — **each row is a separate approval; none are approved by this document**

| # | Step | Gate / precondition |
|---|---|---|
| **L0** | **Confirm D-12b** (single project as rehearsal + target) and confirm the project holds nothing production-critical | your explicit reply — *first gate* |
| L1 | Apply the two schema-only migrations (Dashboard SQL paste of the two files, or PAT + harness `--apply-migrations`) | L0 |
| L2 | Dashboard Auth config: Email provider on, redirect allow-list (plan §7.1), password min 6, confirm-email policy (D-6), templates | L1 |
| L3 | Run `staging-smoke` T0–T8 from **your machine** (egress works there); paste back the `--json` report | L1, L2; **no live PASS claim may exist before this** |
| L4 | Test-account auth-flow rehearsal (sign-up/in/reset/sign-out/persistence/multi-provider) per plan §5.3.4 + O6 checklist | L3 PASS; D-9 test-account policy |
| L5 | Google provider setup + **auto-link proof** that a Google sign-in lands on the pre-provisioned pinned UUID (R1/E4 — blocking for all Google users) | L4; D-8 |
| L6 | Optional D-14: one synthetic `$fbscrypt$` hash-import + login evaluation | separate explicit approval; recovery flow ships regardless |
| L7 | Firebase export (auth list + Firestore docs, two copies, checksums) — **read-only against Firebase; the only live-Firebase step in the phase** | separate explicit approval + D-3 trusted env |
| L8 | Manifest build → provision real users (pins verified) → import `user_data` → validation gates (O4 output must be all-green) | L3–L5 PASS, L7, D-4 delta policy |
| L9 | Cutover change-set (config-flagged merge: adapter wiring G3, shim wiring, recovery UI G2) + rollback window (D-5) + communication (D-7); rollback = revert merge | all gates; separate explicit approval |
| L10 | Delta re-check, reverse-import readiness (O5), post-cutover monitoring; Firebase decommission explicitly out of scope | L9 |

### Never, without a separate explicit approval

Modifying or deleting anything in Firebase; deploying the website; applying SQL to
any project; creating/modifying/deleting real users or rows outside an approved step;
reading or migrating real user data outside L7/L8; changing passwords; putting keys
or PII in the repository, chat, or logs; claiming any live check passed that has not
been run.

---

## 5. Test results (this turn)

| Suite | Tests | Pass | Fail |
|---|---|---|---|
| `tests/body-map.test.cjs` (existing) | 21 | 21 | 0 |
| `tests/body-map.test.cjs` (**+3 safeguard pins, new**) | 24 | 24 | 0 |
| `tests/supabase-preparation.test.cjs` | 7 | 7 | 0 |
| `tests/migration-manifest.test.cjs` | 18 | 18 | 0 |
| `tests/staging-smoke.test.cjs` | 14 | 14 | 0 |
| **Combined `node --test tests/*.test.cjs`** | **63** | **63** | **0** |

New tests added because the inspection found no automated pin on two of the strict
safeguards (“preserve all existing recovery safeguards”):

1. Sign-out flushes pending changes to the **old** user **before** `auth.signOut()`,
   then clears the confirmed snapshot.
2. Sign-out with an unflushable failure warns (“backup is stored on this device…”),
   **never calls** `auth.signOut()` when the user aborts, and keeps the snapshot.
3. Account switch parks unsaved changes under the **old** uid’s snapshot (unknown
   fields included) and wipes in-memory state, writing nothing for any other account.

## 6. Exact next step requiring your approval

**Approve O1 — build `js/phase3-remap.js` + `tests/phase3-remap.test.cjs`
exactly as scoped in §3:** offline only, isolated module, **no production file
modified, nothing wired into the app, no contact with any service**; suite rerun and
reported afterward (target: 63 → 63+N green).

The first **live** step remains a separate decision: **L0/D-12b** — your confirmation
to use the single Supabase project as rehearsal + target — which gates L1 (schema
apply) and everything after it. Nothing in Track L happens without that reply, and
Firebase / the live LIFTS site stay untouched regardless.
