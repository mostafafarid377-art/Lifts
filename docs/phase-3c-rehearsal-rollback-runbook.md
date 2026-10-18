# LIFTS Phase 3c — O6: Authentication Rehearsal & Manual Rollback Run-Books

**Status: OFFLINE DOCUMENTATION ONLY.** This document is a run-book (plan §4,
Track O, row **O6** — “rehearsal artifacts: step-by-step expected-output
checklist … written now, executed live later”). It contains expected results
and failure conditions only.

**No step in this document has been performed.** No live service was contacted
to write it, no account exists because of it, and nothing here has been
deployed, provisioned, or executed against Firebase or Supabase. Every result
below is an *expectation derived from the plans and the reviewed code*, not an
observation.

- **Date:** 2026-10-19
- **Baseline:** `arena/f40c8656-lifts` @ `80beda4` (O1–O4 complete; suite 156/156 offline)
- **Inputs read:** `docs/phase-3-auth-migration-plan.md` (§5.3 step 4, §6, §8.4, §9, §5.4), `docs/phase-3c-remaining-work-plan.md` (§4 rows O5/O6, L-gates, G8/G10), O4 implementation + report, migration code (`build-manifest`, `provision-users`, `import-user-data`, `validate-migration`).
- **Scope:** documentation + offline test fixtures only. **Not** O5 (tooling), **not** O7 (cutover change-set), **not** Track L.

**Marker legend**

| Marker | Meaning |
|---|---|
| `[OFFLINE]` | Runnable/decidable with no live service, no account, no user-visible change. |
| `[APPROVAL-GATED: …]` | Requires your explicit approval **and** live services, account creation, or a user-visible change. Nothing marked this way may run without that approval. |

---

## Part A — Test-account authentication rehearsal (planned execution: L4 / L5)

### A.0 Preconditions (all required before any Part-A step)

| # | Precondition | Gate | Status |
|---|---|---|---|
| A0.1 | Confirm **D-12b**: single Supabase project used as rehearsal + target; project holds nothing production-critical | **APPROVAL-GATED (L0)** | NOT RUN |
| A0.2 | Both schema migrations applied + `supabase/README.md` post-apply checks 1–4 pass | **APPROVAL-GATED (L1)** | NOT RUN |
| A0.3 | Auth config: Email provider on, redirect allow-list (plan §7.1), password min 6, D-6 policy, templates | **APPROVAL-GATED (L2)** | NOT RUN |
| A0.4 | `staging-smoke` T0–T8 PASS from your machine (`--json` report filed) | **APPROVAL-GATED (L3)** | **NOT RUN** |
| A0.5 | **D-9 test-account policy**: all rehearsal accounts use reserved, obviously-synthetic addresses from one agreed domain/prefix; no real user addresses ever enter the rehearsal | **APPROVAL-GATED (D-9)** | undecided |
| A0.6 | Credentials (Dashboard session / trusted-env keys) live only outside the repository and chat | [OFFLINE] policy, enforced at execution | standing rule |

**Evidence rules (every step):** record step id, UTC timestamp, observed
output/screenshots, and PASS/FAIL/ABORT in a local evidence file kept with the
trusted-environment artifacts — **never in this repository** (test addresses
are still account-creation artifacts; keys/tokens never anywhere).

**Roster template (placeholders — fill at execution, approved at L0/D-9):**

| Account id | Address pattern | Providers | Used by |
|---|---|---|---|
| T1 | `rehearsal-1@<reserved-domain>` | password only | A1–A5 |
| T2 | `rehearsal-2@<reserved-domain>` | password only | A2, A3, A5 |
| T3 | `rehearsal-3@<reserved-domain>` | google.com only | A7 |
| T4 | `rehearsal-4@<reserved-domain>` | password + google.com | A6, A7 |

### A1 — Email sign-up — **APPROVAL-GATED (L4)**

- **Steps:** with Email provider configured (A0.3), create T1 via the sign-up
  path (dashboard “Add user” *or* the local preview page / SDK call — the
  method used must be recorded): email + password ≥ 6 chars, per D-6 either
  confirm-email ON (link followed) or OFF; migrated real users are
  pre-confirmed, new rehearsal users follow the D-6 policy.
- **Expected:** user row created with a server-generated UUID; session
  obtainable immediately (pre-confirmed) or after the confirmation link
  (D-6 ON); address stored case-normalized; **no** `app_metadata.firebase_uid`
  claim (rehearsal accounts are not migrated identities — their absence is
  correct and is what keeps them distinguishable from real pins).
- **Failure conditions:** create rejected (policy/rate limit); address
  normalized differently than recorded; confirmation link 404s or redirects
  outside the §7.1 allow-list (R7).
- **Abort:** any rehearsal account created with a real user’s address → stop,
  delete only that synthetic account after approval (E1/D-9 reconciliation),
  log incident.

### A2 — Email sign-in and sign-out — **APPROVAL-GATED (L4)**

- **Steps:** sign in T1 (correct password); sign out; sign in again (wrong
  password once first); confirm no session remains after sign-out (reload on
  a signed-out page stays signed out).
- **Expected:** sign-in issues a session; wrong password returns an auth
  error (enumeration behavior recorded as observed — it affects only the
  future UI copy, plan §1.3); sign-out clears the client session; Firebase
  and production traffic unaffected throughout (single-project rule).
- **Failure conditions:** sign-out leaves a usable session; wrong-password
  response shape contradicts what the future error mapping (G2) must handle;
  any request succeeds with no session.

### A3 — Session persistence across reload — **APPROVAL-GATED (L4)**

- **Steps:** sign in T1, hard-reload the local preview page (same origin in
  the §7.1 allow-list), observe session state; wait past the access-token
  lifetime (default 3600 s) with `autoRefreshToken: true` (already set in
  `js/supabase-client.js`) and confirm silent refresh; sign out and reload.
- **Expected:** reload keeps the session (persistSession); token refresh is
  silent; after sign-out, reload does **not** restore a session.
- **Failure conditions:** session lost on plain reload; refresh loop/console
  errors; session survives sign-out (R7/R9-adjacent; stop L4 until fixed).

### A4a — Password reset → set new password (SDK level) — **APPROVAL-GATED (L4)**

- **Steps:** with T1 signed out, trigger `resetPasswordForEmail` to the
  reserved address; open the link from the mailbox (D-10 pacing applies at
  volume); a recovery session opens (`detectSessionInUrl: true` already
  configured); call `auth.updateUser({ password: <new ≥6> })`; sign out; sign
  in with the new password; confirm the old password no longer works.
- **Expected:** exactly one mailbox message; link lands inside the §7.1
  allow-list; password update succeeds; new sign-in works, old fails; data
  row still owned by the same UUID (identity unchanged by reset).
- **Failure conditions:** link rejected (allow-list, R7); update succeeds but
  sign-in with the new password fails; recovery session lands on a *different*
  UUID (would be an identity defect — halt).
- **Note:** SMTP volume limits (R8/E16) are irrelevant at rehearsal scale
  (single messages) — record observed rate-limit behavior anyway for D-10.

### A4b — Password reset via the app UI — **APPROVAL-GATED (L9 preview build; depends on G2/O7)**

- **Dependency:** the “set new password” screen and Supabase error mapping
  (G2) do not exist yet — they ship in the cutover change-set (O7, approval-
  gated separately). Until that flagged build exists, A4b cannot run; A4a is
  the substitute at L4.
- **Steps (when the build exists):** from the auth screen, “Forgot password?”
  → mailbox → link → recovery screen → set password → lands signed in with
  data; also exercise wrong/expired-link messaging.
- **Expected:** friendly, mapped messages for every recovery error path;
  never a raw SDK error shown; Firebase production build untouched (flagged
  preview only).
- **Failure conditions:** unmapped raw error; recovery redirect loop; any
  user-visible change to the production Firebase site (immediate abort).

### A5 — Account recovery & error handling matrix — **APPROVAL-GATED (L4)**

| Case | Steps | Expected | Failure condition |
|---|---|---|---|
| Wrong password | sign in T1 with bad password | error returned; no session; rate-limit threshold observed (E16/R8) | session granted; account locked in a way that blocks rehearsal cleanup |
| Unknown email | sign in with nonexistent reserved address | response shape recorded (enumeration setting — plan §1.3/§5.2.3) | leaks or blocks differently than recorded — then G2 copy must follow the *observed* behavior |
| Expired/reused reset link | open an old link twice | second use rejected with a clear error | second use succeeds; silent success with no error |
| Recovery link while signed in as another account | sign in T2, open T1’s recovery link | recovery session **switches** user; prior in-memory state wiped (same property as plan §1.7/E11) | prior account’s data remains rendered |
| Rate limiting | repeat failures past threshold | throttling response observed and recorded | indefinite lockout of a rehearsal account without recovery |

### A6 — Multi-provider behavior (E3) — **APPROVAL-GATED (L4, needs D-8 Google setup or deferred with A7)**

- **Steps:** with T4 provisioned as password + google.com (rehearsal
  provisioning creates its own identities — no migrated pins involved):
  (1) reset-password path → sign in with the new password; (2) sign out →
  Google sign-in; (3) confirm both sessions report the **same UUID**;
  (4) confirm both identities appear on one user (dashboard/SDK read).
- **Expected:** one user, two identities, identical `user.id` on both paths;
  neither path creates a duplicate account.
- **Failure conditions:** two users for one address (E1); identities split
  across UUIDs; sign-in errors surface unmapped.

### A7 — Google sign-in + auto-link for a **pre-provisioned** account — **APPROVAL-GATED (L5, D-8) — BLOCKING GATE**

> **Google auto-linking has not been tested.** No claim that a Google
> sign-in lands on a pre-provisioned pinned UUID may be made until this
> rehearsal is executed under approval and recorded here with evidence
> (plan §8.4, R1, E4).

- **Setup (approval-gated):** Google provider enabled with a new web OAuth
  client (D-8): authorized origins per plan §8.3, exactly one redirect URI =
  the project’s `/auth/v1/callback`; consent screen published or test users
  listed.
- **Steps:** pre-provision a rehearsal user with pinned UUID P and email E
  (`app_metadata.firebase_uid` set as the real flow would); sign in with
  Google account whose address is E; observe the resulting session’s
  `user.id`.
- **Expected (the auto-link result to verify):** the session lands on the
  **pre-provisioned P** — GoTrue attaches the OAuth identity to the
  existing confirmed-email user; **no** second user with address E; identity
  list on P gains `google.com`; `app_metadata.firebase_uid` unchanged.
- **Failure conditions (any ⇒ gate fails):** new UUID created (duplicate —
  E1/E4); auth error; identity attached to a different user; claim lost.
- **Fallbacks if it fails (plan E4 — require approval each):** (i) leave the
  provider disabled until link behavior is confirmed; (ii) server-side admin
  identity link via trusted Admin API; (iii) keep affected Google accounts on
  Firebase temporarily (partial cutover — complicates rollback).
- **Consequence:** until A7 passes, Google cutover stays blocked no matter
  how green everything else is (plan §8.4).

### A8 — App smoke against the flagged adapter (plan §5.3 step 5) — **APPROVAL-GATED (L4; depends on O7/L9 flagged build)**

- **Dependency:** feature-flag wiring (G3) exists only in the not-yet-authored
  cutover change-set (O7). Rehearse on a preview/flagged build only; the
  production Firebase site must not change (req. 10).
- **Steps:** load, edit, save, kill network → offline snapshot, restore,
  sign-out flush — for a rehearsal account.
- **Expected:** parity with today’s safeguards (save queue, snapshot cleared
  only after confirmed write, flush-before-signout) but against `user_data`.
- **Failure conditions:** snapshot cleared without confirmed write; data
  written for the wrong UUID; any effect on the production origin.

---

## Part B — Manual rollback run-book (planned replacement for O5 tooling)

**Role:** per the approved O4-review classification, O5 *tooling* is optional;
the *capability* is mandatory. **This part is that mandatory artifact.** If
rollback ever proves frequent or complex enough to justify dedicated tooling,
propose O5 separately — it is explicitly **not** implemented now (scope: no O5,
no O7).

**Whole part: APPROVAL-GATED (rollback decision, D-5, D-4/D-7 as
applicable).** Every B-step below touches live systems or user-visible
behavior.

### B.1 — Define `T_cutover` — **APPROVAL-GATED (recorded during the approved L9 cutover)**

- `T_cutover` = the **UTC instant the L9 cutover deployment became the live
  GitHub Pages site** (the Pages build of the cutover merge finishing), and it
  is recorded as a triple `{ iso8601, commit_sha, pages_deployment_id }` in
  the trusted environment **at cutover time** (before any user traffic if
  possible; never later than +15 min, with the deployment id as arbiter).
- Why it matters: `public.user_data.updated_at` is the reverse-sync selector
  (plan §5.4); it must be directly comparable to the recorded ISO instant.
  The commit sha ties the data window to the exact frontend build; the
  deployment id removes ambiguity from Pages build queues.

### B.2 — Preconditions (all green or abort) — **APPROVAL-GATED (live verification)**

1. Rollback trigger exists and is agreed (auth breakage, data-loss reports,
   R1-class identity defects) **within the D-5 window** — the maximum age of
   un-reimported Supabase-era writes, agreed *before* cutover; exceeding it
   without a complete reverse-import is an abort-to-escalation, not a silent
   partial rollback.
2. L7 export artifacts present: two copies, checksums, `T_export` (they are
   the audit snapshot of what Firebase looked like pre-cutover).
3. Manifest (firebase_uid ↔ pin, with final statuses) available in the
   trusted environment — the reverse mapping; PII stays local.
4. **Firebase is intact and untouched** — verify read access to Auth +
   Firestore *before* starting; it is the recovery source of truth and must
   remain so until the window closes (B.9). **Never modify or delete anything
   in Firebase except the approved reverse-import writes in B.5.**
5. Credentials: Firebase service account + Supabase trusted-key access in the
   local environment only (never the repository, chat, or browser).
6. Fresh backups (B.6) taken.

### B.3 — `git revert` of the cutover merge (the frontend plane)

- **Steps:** `git revert -m 1 <cutover-merge-sha>` on the approved branch →
  merge/PR per normal review → GitHub Pages rebuilds from `main` → the live
  site serves the previous (Firebase) build. **APPROVAL-GATED (user-visible;
  this is production).**
- **What this does:** switches the *application* back to Firebase Auth +
  Firestore; sessions, rules, and data on the Firebase side were never
  modified, so existing Firebase users are unaffected (plan §5.4).
- **What this does NOT do — and why frontend revert alone is insufficient:**
  it performs **zero database operations**. Every write made through
  Supabase during the window (inserts/updates to `user_data`, password
  changes, new accounts) still exists in the Supabase project; the reverted
  app will never see them again, so without **B.4–B.5** those changes are
  stranded — that is precisely the rollback gap R4. Reverting code changes
  *which server the app talks to*; only the reverse-import changes *where
  the data lives*.
- LocalStorage needs no action by design: the O1 shim is copy-not-move, so
  old-uid keys remain intact for the Firebase build (verify presence, do not
  delete).

### B.4 — Identify post-cutover changes: `updated_at > T_cutover`

- **Step (read-only first — APPROVAL-GATED):** run in a trusted environment
  (Dashboard SQL editor or local psql), never from the browser:

  ```sql
  select user_id, updated_at, revision, schema_version
  from public.user_data
  where updated_at > '<T_cutover.iso8601>'
  order by updated_at;
  ```

- Export the result set (user_id, updated_at, revision) + a full payload dump
  of exactly those rows (service-role/trusted env only) with SHA-256 per row;
  file counts as `N_window`.
- **Expected:** one row per Supabase-era-changed account; rows at or below
  `T_cutover` are untouched by rollback (they mirror the L7 export).
- **Failure conditions / abort:** query errors; row count inconsistent with
  support reports of activity (investigate before writing anything); any row
  whose `user_id` is not in the manifest (orphan → O4-class discrepancy →
  escalate, never guess — E13).

### B.5 — Preserve newer data; avoid overwriting conflicting changes — **APPROVAL-GATED (live writes)**

Per-uid procedure, one row at a time (never bulk-blind):

1. Load the current Firebase document `users/{firebase_uid}` (reverse map:
   pin → firebase_uid from the manifest — **never from email**).
2. Compare timestamps in epoch millis: Supabase side = the row’s
   `updated_at` (and the payload’s own `savedAt`); Firebase side = the
   document’s `savedAt` (and `updateTime` if available).
3. **Write only if the Supabase payload is strictly newer.** If Firebase is
   equal-or-newer, **skip the row, log it as a conflict** for manual review —
   never overwrite a newer Firebase document (this includes any writes the
   user made through channels that bypassed Supabase during the window).
4. When writing: full-document write of the canonical payload under
   `users/{firebase_uid}` (the app’s own `set()` contract, plan §1.8) via
   Admin SDK in the trusted environment; record `{uid, from_updated_at,
   sha256, result}` in the reverse-import report.
5. Ambiguous cases (equal timestamps with differing payloads; unreadable
   rows; two plausible identities) → **skip + escalate**, never merge (E13).
6. Do **not** delete `user_data` rows or `firebase_uid_map` rows here — data
   rollback means “stop using + reconcile,” and deletions are a separate
   approval-gated cleanup (plan §5.4).

**Expected:** every write improves Firebase toward the newest state; the
report line count + conflicts + skipped = `N_window` (count identity).

### B.6 — Backup requirements (take *before* B.4 writes) — **APPROVAL-GATED (live exports)**

| Backup | Content | Requirement |
|---|---|---|
| Pre-existing | L7 export: auth list + Firestore docs, two copies, checksums | must already exist (cutover precondition) |
| New: Firebase snapshot | full export of affected `users/*` docs (ideally all docs) at rollback start | 2 copies, SHA-256, local-only |
| New: Supabase snapshot | full dump of `user_data` rows in the window (and ideally the whole table) | 2 copies, SHA-256, local-only |
| New: reverse-import plan | the `updated_at > T_cutover` selection + per-row plan | checksummed before any write |

Purpose: the rollback itself must be re-doable/auditable in both directions —
the Supabase snapshot keeps the forward state available if the reverse-import
turned out wrong.

### B.7 — Verification steps (after reverse-import)

1. Count identity: `|window rows| = |successful writes| + |skipped conflicts|`,
   zero unexplained deltas.
2. For every written uid: re-read the Firebase doc; semantic equality
   (canonical-JSON compare — same rule O4 uses; byte equality is meaningless
   across storage) against the Supabase snapshot payload; key sets identical.
3. Firebase sign-in with a rehearsal/known account succeeds on the reverted
   live site (Pages serving the previous build).
4. Supabase side: confirm rows are now inert (no app traffic); spot-check RLS
   still denies anon/authenticated (README checks) so stranded data stays
   private during the window.
5. LocalStorage spot-check on a shimmed device: old-uid keys still present.
   **APPROVAL-GATED (live checks).**

### B.8 — Abort conditions (stop writes, keep evidence)

- D-5 window exceeded with incomplete import → stop, escalate; residual list
  goes to manual per-user review.
- Any write landed under the wrong `firebase_uid` → halt immediately, freeze
  the report, quarantine (never delete) the wrong doc, escalate.
- Firebase unreachable/locked, credential leak suspected, or backup checksum
  mismatch → abort before writing.
- More than a small fraction of conflicts (threshold agreed at rollback start)
  → abort-to-escalation rather than partial-by-default.

### B.9 — Recovery confirmation and window close — **APPROVAL-GATED (live confirmation)**

1. B.3 site check + B.7 verifications all recorded PASS **for the steps
   actually executed** (here, unrun — this is a procedure, not evidence).
2. Residual conflict/skip list filed for manual review (never auto-merged).
3. User communication per D-7 if impact was visible.
4. Declare the **rollback window CLOSED**: from that moment Firebase is the
   sole source of truth again; Supabase rows remain as inert copies until a
   separate approval decides their fate; **Firebase decommission remains out
   of scope forever within this phase** (plan §5.4).
5. Retire `T_cutover` record into the run file (audit complete).

---

## Part C — Open decision: `firebase_uid_map` population (must be settled **before L8**)

**Status: UNRESOLVED — documentation only; this document does not choose an
answer.**

What the existing plan *does* specify:

- Table definition, constraints, and deny-all RLS (plan §3.1 / V2 / V3,
  migration `20261016000000_create_firebase_uid_map.sql`).
- The manifest is the source of truth; the table is a “database mirror”
  (plan §3.1), and O4’s gate enforces manifest ≡ table (E15).
- Trusted tooling *may* write the table with the service-role key (V3), and
  `staging-smoke.mjs` T5 writes/deletes **synthetic smoke rows only** as part
  of the L3 harness.

What the existing plan *does not* specify: **which approved step writes the
real manifest rows into `firebase_uid_map`, with which tool, and when that
write is synced** (nothing in §2.2, §5.3’s ordered steps, or the Track-L
table inserts real rows; O1–O3/O4 do not write it either — O4 only validates).

Consequence: **this decision must be settled and added to the plan before
L8**, so that: (a) the writer is approval-gated like every other live step,
(b) its output satisfies O4’s `MAP_MISSING`/`MAP_PIN_MISMATCH`/
`MAP_STATUS_MISMATCH` checks (row status must track manifest status), and
(c) the synthetic smoke writer is not mistaken for the real mechanism.
Candidate approaches may be evaluated at that time (e.g. a dedicated
manifest-load step in the approved L8 sequence using trusted-environment
tooling); choosing among them is out of O6’s scope.

---

## Scope attestation

- This document changed no production code, no authentication flow, no
  migration, no deployment setting, and no existing O1–O4 behavior; it
  contacted no service.
- Nothing in Parts A or B has been executed; PASS/FAIL labels above describe
  *expected evidence fields*, never results.
- O5 and O7 remain unimplemented by design; Track L remains untouched until
  separately approved (first gate: L0 / D-12b).
