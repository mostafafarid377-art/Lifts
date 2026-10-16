# LIFTS — Phase 3 Plan: Firebase → Supabase Auth & Data Migration

**Status:** PLANNING ONLY — no code in this document has been implemented, no users have
been migrated, no production data has been exported or copied, and nothing has been
deployed. **Authentication migration and live integration have NOT been tested.**

**Baseline:** `main` @ `90a362d` (Phase 1 schema + Phase 2 client/adapter merged via PRs
#8 and #9). Firebase remains the production backend for Auth and Firestore.

**Verified at planning time:**

- Existing regression suite: **21 passed** (`node --test tests/body-map.test.cjs`)
- Phase 2 preparation suite: **7 passed** (`node --test tests/supabase-preparation.test.cjs`)
- Working tree clean; no production integration or cutover has occurred.

**Scope guard (requirement 10):** this phase makes no change to the live auth flow,
performs no user migration, copies no production data, and deploys nothing. The only
artifact of this phase is this document.

---

## 1. Audit: current Firebase Auth implementation

All references are to the current `main` baseline.

### 1.1 SDK and wiring

| Item | Location | Behavior |
|---|---|---|
| SDK | `index.html:17–19` | Firebase **8.10.1 compat** via `<script>` tags: `firebase-app`, `firebase-auth`, `firebase-firestore` (globals; no bundler, works on any static host). |
| Init | `js/firebase.js:1–15` | `firebase.initializeApp(firebaseConfig)` (config in `js/config.js:1–9`, project `lifts-ec71b`); exports `auth = firebase.auth()`, `db = firebase.firestore()`. |
| App import | `js/app.js:11` | `const auth = firebase.auth();` |

### 1.2 Sign-up (email/password)

- UI: single auth screen, **Sign Up** tab reveals a confirm-password field
  (`switchTab()`, `js/app.js:650–663`; `index.html:30–45`).
- Handler `doAuth()` (`js/app.js:690–712`):
  1. Requires non-empty email and password (`js/app.js:699`).
  2. Signup mode: passwords must match (`js/app.js:701`).
  3. Password minimum **6 characters** (`js/app.js:702`).
  4. Calls `auth.createUserWithEmailAndPassword(email, pass)` (`js/app.js:706`).
- Success: no explicit callback — `onAuthStateChanged` fires and enters the app.
- Email verification is **not** required by the app (it never checks `emailVerified`).
- Duplicate email surfaces as `auth/email-already-in-use` → mapped in `friendlyErr()`
  (`js/app.js:762–777`) to “Email already registered — sign in instead”.

### 1.3 Sign-in (email/password)

- `doAuth()` login mode → `auth.signInWithEmailAndPassword(email, pass)`
  (`js/app.js:705`). Errors mapped: `auth/invalid-credential`, `auth/user-not-found`,
  `auth/wrong-password`, `auth/too-many-requests`, `auth/network-request-failed`, etc.
  (`js/app.js:762–777`). Note the map exposes “No account with that email”, i.e. the UI
  is written to tolerate user-enumeration behavior either way; the actual Firebase
  console setting (Email Enumeration Protection) must be recorded during export but does
  not affect this plan.

### 1.4 Password reset

- `doForgot()` (`js/app.js:671–688`): requires the email to be typed into the email
  field first, then `auth.sendPasswordResetEmail(email)` (`js/app.js:680`).
- Success: inline “Reset email sent!” for ~5 s. Errors via `friendlyErr()`.
- Shown only on the **Sign In** tab (`switchTab()`, `js/app.js:658–660`).
- What Firebase actually sends for **Google-only** accounts (reset vs. no-op error) is a
  console/provider behavior that must be observed during export, not assumed; the code
  path simply surfaces errors.

### 1.5 Google sign-in

- `doGoogle()` (`js/app.js:714–732`):
  - `new firebase.auth.GoogleAuthProvider()` with
    `provider.setCustomParameters({ prompt: 'select_account' })` (`js/app.js:720–721`)
    — the account picker is intentionally re-prompted every time.
  - `auth.signInWithPopup(provider)` (`js/app.js:722`).
  - Popup-closed / cancelled-popup errors are special-cased to a friendly message;
    everything else goes through `friendlyErr()`.
- No redirect fallback for blocked popups and no explicit `linkWithCredential`
  handling — a Google account is assumed to be a single self-contained identity.

### 1.6 Sign-out

- `doSignOut()` (`js/app.js:734–760`), behind a `confirm()`:
  1. **Flush before auth change:** `Promise.race([flushSave(), 4 s timeout])` pushes
     pending writes to the *current* user’s Firestore doc before `auth.signOut()`.
  2. If unsaved: warns once when a local snapshot exists (“backup is stored on this
     device…”) and a different, harsher warning when nothing could be saved; user can
     abort.
  3. `await auth.signOut()` (`js/app.js:747`), then resets in-memory state
     (`CATS/EX/DATA`) and the auth-screen form. **localStorage keys are intentionally
     not cleared** (they belong to the uid and are the recovery path).

### 1.7 Auth-state behavior

`auth.onAuthStateChanged(...)` (`js/app.js:628–650`) is the single source of truth:

- **Signed in:**
  - If the uid *changed* from the previous user → `p1SwitchUser()`
    (`js/app.js:2941–2964`): first writes any unsaved in-memory state into the *old*
    uid’s local snapshot (`lifts_snap_<oldUid>`), cancels timers, then wipes every trace
    of the previous account from memory — so no data can leak between accounts.
  - Sets `currentUser`, creates a per-uid save queue `SV = newSV(user.uid)`
    (`js/app.js:623`), hides the auth screen, shows app + tab bar, sets the nav badge
    from `displayName || email` (first 8 chars of the local part), and calls
    `loadUserData(user.uid)` (`js/app.js:628–646`).
  - Same-account re-announcements are ignored when data is already loaded, so a refresh
    event never reloads over unsaved in-memory state.
- **Signed out:** `currentUser = null`, `p1SwitchUser()` again (snapshots preserved),
  auth screen shown, app and tab bar hidden (`js/app.js:647–650`).
- **Profile screen** (`js/app.js:1909–1916`) reads `currentUser.email`,
  `currentUser.displayName`, derives initials — no other profile fields are used.

### 1.8 Data model bound to the uid (why auth migration touches data)

- One Firestore document per user: `users/{uid}` (`userRef()`, `js/app.js:434`),
  written as a **full-document `set()`** of the complete payload from `buildPayload()`
  (`js/app.js:529–539`): `EXTRA` unknown fields first (never overridden), then
  `cats, ex, data, msets, customMuscles, hiddenMuscles, splits, activeSplitId,
  routines, schedule, workouts, activeWorkout, awUpdatedAt, savedAt`.
- Writes go through a per-uid serialized save queue (`drain()`, `js/app.js:576–598`)
  with retry/timeout, and every pending write is mirrored synchronously into a local
  snapshot removed only after a confirmed cloud write.

### 1.9 UID-keyed local recovery records (all `localStorage`)

Every key is suffixed with the **Firebase uid**; this list is the complete inventory
that any mapping must account for:

| Key | Defined at | Contents / purpose | Lifetime |
|---|---|---|---|
| `lifts_snap_<uid>` | `js/app.js:548` | Full payload mirror of unconfirmed cloud writes (also the sign-out safety net) | Removed only after confirmed Firestore write (`snapClearIf`) |
| `lifts_snapconflict_<uid>` | `js/app.js:556` | Older local snapshot parked because cloud was newer | Kept until manually cleared |
| `lifts_snapquarantine_<uid>` | `js/app.js:407` | Up to 3 structurally damaged snapshots | Kept (up to 3) |
| `lifts_quarantine_<uid>` | `js/app.js:141` | Up to 100 unreadable entries set aside during load | Kept (up to 100) |
| `lifts_repairnote_<uid>` | `js/app.js:514–516` | Marker to avoid re-toasting the same repair notice | Until repair count changes |
| `lifts_pw_<uid>` | `js/app.js:2966` (`pwKey`) | Queue of workouts finished while offline; merged by id, pruned only after confirmed cloud save (`p1MergePending`, `js/app.js:3026–3044`) | Until pruned |
| `lifts_aw_<uid>` | `js/app.js:2966` (`awKey`) | In-progress active workout with `updatedAt` (newer of local/cloud wins on load, `wkResolveRestore` `js/app.js:2993–3024`) | Until workout finished/cleared |

Load-time merge rules live in `loadUserData()` (`js/app.js:441–527`): local snapshot
wins only if `ts >= cloud.savedAt` (`snapPick`, `js/app.js:553–559`), otherwise it is
parked under the conflict key — never silently deleted.

### 1.10 Hosting / origins (affects redirect configuration)

- **GitHub Pages (production):** `https://mostafafarid377-art.github.io/Lifts/` — legacy
  Pages build from `main`, branch root (verified via GitHub API during planning).
- **Local preview (README):** `python3 -m http.server 8080` → `http://localhost:8080`.
- Firebase authorized domain today: `lifts-ec71b.firebaseapp.com` + the Pages host
  (console setting; re-verify at export time).

---

## 2. How to migrate Firebase users to Supabase Auth safely

### 2.1 The two hard constraints

1. **UIDs differ.** Firebase UIDs are opaque strings (email/password ≈ 28-char
   random; Google provider UIDs are long numeric strings). Supabase Auth users are
   UUIDs. Local storage keys and the Firestore document path are built from the Firebase
   UID, and `public.user_data.user_id` is a `uuid` FK to `auth.users(id)` (Phase 1
   migration). There is no way to “keep” a Firebase UID as a Supabase primary key — an
   **explicit mapping** is mandatory (§3).
2. **Passwords cannot be transferred.** Supabase’s Admin API accepts a *plaintext*
   password only at creation time; it does **not** import external password hashes
   (Firebase’s scrypt/PBKDF2 variants are not accepted anywhere). We never have
   plaintext passwords, so **no email/password credential can move**. Every
   email/password user must choose a new password once, via the normal recovery flow
   (§6). Google users are unaffected — they re-authenticate with Google (§8).

### 2.2 Chosen strategy: pre-provision + explicit mapping + parallel run (staged cutover)

Alternatives considered:

| Option | Description | Verdict |
|---|---|---|
| **A. Pre-provision + mapping + one-time password reset (chosen)** | Before cutover, create every Firebase user in Supabase via the Admin API with a **pinned UUID**, import their Firestore doc into their `user_data` row, then flip the app in one revertable step. Users reset passwords on first failure or via notice. | Recommended: deterministic, offline-verifiable, rollback = revert the app flip. |
| B. Lazy migration (sign-in detection server-side) | Verify a Firebase credential server-side on first Supabase login and provision then. | Rejected: requires a trusted server holding Firebase verifier keys, runs during production traffic, and still cannot move the password — all risk of A with none of the determinism. |
| C. Dual-write period | App writes both backends. | Rejected for now: largest code-change surface, longest exposure; only revisit if a zero-downtime window is later required. Firebase remains production either way (req. 10). |

Sequence (all steps are *future, approval-gated*; none executed in this phase):

1. **Export** from Firebase in a trusted local environment (§5.2) — auth users and
   Firestore documents, with checksums.
2. **Build the mapping manifest**: `firebase_uid → pinned Supabase UUID` (+ normalized
   email, provider hints, status) — §3.
3. **Apply schema migrations** to the Supabase project (Phase 1 `user_data` +
   Phase 3 mapping table) — approval-gated, staged project first.
4. **Provision** auth users via Admin API: pinned UUID, lowercase email,
   `email_confirm: true`, `raw_app_meta_data: { firebase_uid }` (§3.3). No invitation
   emails are sent during bulk provisioning.
5. **Import** each user’s Firestore payload into `user_data(user_id = pinned_uuid)` as
   an opaque JSONB document — byte-for-byte source semantics, no normalization
   (mirrors `js/supabase-data.js` contract).
6. **Validate** (§5.3), then run a **staging rehearsal** end-to-end with test accounts —
   this is where sign-in/reset/Google flows must actually be tested *before* any
   production cutover claim can be made.
7. **Communicate** the one-time password reset (§6.5).
8. **Cutover**: merge the app’s Supabase configuration (config-flagged, small diff) to
   `main`; GitHub Pages rebuilds. Firebase Auth/Firestore stay fully intact and
   untouched — they are both the rollback target and the audit source of truth.
9. **Delta re-check**: re-run export diff between step 1 and step 8; import anything new
   or changed (§5.4 decision).

### 2.3 What is deliberately *not* migrated

- Firebase refresh sessions — all users sign in once on Supabase (unavoidable; same as
  any IdP move).
- Password hashes — impossible (§2.1); handled by §6.
- Firebase UID as primary key — replaced by mapping (§3).
- Anonymous Firebase users — the app never calls `signInAnonymously` (verified in
  source); if the Firebase console contains any (created outside this app), they are
  **excluded** and listed in the skip report.

---

## 3. Explicit mapping between Firebase UIDs and Supabase UUIDs

### 3.1 Design

- **Deterministic, pre-assigned UUIDs.** For every Firebase UID to be migrated, generate
  a UUIDv4 at manifest-build time and *pin* it. The Admin API accepts a caller-supplied
  `id` on user creation, so the Supabase UUID is known **before** any provisioning or
  import happens. Nothing is ever derived from email (emails can change and must never
  decide identity), and nothing is guessed at runtime.
- **Source of truth: an offline mapping manifest** (JSONL/CSV) kept in the trusted
  local environment — **never in this public repository** (it contains emails = PII):

  ```
  firebase_uid,supabase_uuid,email_normalized,provider_hint,status,migrated_at
  AIza…28charUid,11111111-…-…,user@example.com,password+google.com,verified,…
  ```

  Statuses: `planned → provisioned → data_imported → verified` plus terminal
  `conflict` / `skipped` (disabled/deleted/anonymous/duplicate-reconciliation).
  The manifest gets a checksum; re-generation requires approval (it must not silently
  change between export and import).

- **Database mirror: a mapping table** (schema-only in this phase, not applied):

  ```sql
  -- supabase/migrations/2026xxxx_create_firebase_uid_map.sql (Phase 3a, future)
  create table public.firebase_uid_map (
    firebase_uid  text primary key,
    supabase_uuid uuid not null unique,
    email         text not null,          -- normalized (lowercase) at export time
    provider_hint text not null default 'password',  -- password | google.com | password+google.com
    status        text not null default 'planned',
    created_at    timestamptz not null default now(),
    verified_at   timestamptz,
    check (status in ('planned','provisioned','data_imported','verified','conflict','skipped'))
  );

  alter table public.firebase_uid_map enable row level security;
  revoke all on table public.firebase_uid_map from public, anon, authenticated;
  -- no policies: reachable only with the service_role key, trusted environment only
  ```

  Uniqueness constraints (`firebase_uid` PK, `supabase_uuid` unique) make
  “two accounts mixed into one row” a database-level impossibility, and the
  deny-all RLS keeps PII out of the browser entirely.

- **Redundant runtime copy:** at provisioning time each Supabase user also receives
  `raw_app_meta_data = { firebase_uid: "<fid>" }`. This lets a signed-in session know
  its original Firebase UID (for the localStorage remap in §4) without exposing the
  mapping table. The mapping table remains authoritative; metadata is a convenience
  copy validated against it.

### 3.2 Why not the alternatives

- *Email as join key* — fails for changed/unverified/duplicate-case emails and breaks
  the moment a user updates an address; also invites cross-account mixing on typo
  fixes.
- *Hash-of-UID* — Firebase UIDs are not fixed-length/charset; no collision guarantee is
  worth losing auditability vs. an explicit table.
- *Client-side mapping lookup* — would require publishing the whole PII mapping to the
  browser; rejected.

### 3.3 Provisioning rules per account type (from `providerData` in the export)

| Firebase providers | Supabase provisioning |
|---|---|
| `password` only | Pinned UUID, email confirmed, **no usable password** until the user recovers (§6) |
| `google.com` only | Pinned UUID, email confirmed; Google identity must attach to this user on first Google sign-in (verify auto-link in staging — §8.4/§9) |
| `password` + `google.com` | Pinned UUID, email confirmed; password via recovery **and** Google identity — both paths must land on the same UUID (staging test case) |
| disabled / deleted between export and cutover | status `skipped`, no provision, no import |
| anonymous | excluded (none expected — §2.3) |

---

## 4. Mapping Firestore documents and UID-keyed local records without mixing accounts

### 4.1 Firestore document → `user_data` row

- The app writes exactly one document per auth user: `users/{uid}` (`js/app.js:434`),
  and only for `currentUser.uid` (the save queue is uid-bound, `js/app.js:544–566`) —
  so the data side is already strictly 1:1 with the uid.
- Import rule: for every manifest row with status ≥ `planned` and an exported document,
  insert:

  ```sql
  insert into public.user_data (user_id, payload, schema_version, revision, updated_at)
  values ('<pinned supabase_uuid>', '<exported doc as JSONB>', 1, <monotonic>, '<export savedAt>')
  on conflict (user_id) do update set …;  -- only in approved re-import/rollback flows
  ```

  The payload is copied **opaquely** (unknown/future fields preserved), matching the
  Phase 2 adapter contract in `js/supabase-data.js`.
- **No-mixing checks:** (a) pinned UUID is only ever taken from the manifest row whose
  `firebase_uid` matched the exported document id — never from email or prompt input;
  (b) `user_data.user_id` FK + unique PK means one row per account; (c) the import tool
  refuses to run if `firebase_uid` in the document id set ≠ manifest set minus
  explicit skips; (d) per-row source checksum recorded at export and verified
  post-import (§5.3).

### 4.2 Local recovery records (`lifts_*_<firebaseUid>`)

After cutover, sessions are UUID-keyed, but the records on each device are keyed by the
old Firebase UID. Plan: a **one-shot, copy-based remap shim** on first authenticated
Supabase session (future implementation; not written yet):

1. **Identity gate (the anti-mixing rule):** read `session.user.id` (UUID) and
   `session.user.user_metadata/raw_app_meta_data.firebase_uid`. Perform the remap
   **only** when `firebase_uid` is present **and** matches a row in the mapping (via
   metadata → the same pinned UUID). Never infer the uid from email, never remap for a
   session without the claim. A user whose Firebase account was skipped simply has no
   mapping — their old keys are left untouched.
2. **Copy, don’t move:** for each prefix in
   `lifts_snap_`, `lifts_snapconflict_`, `lifts_snapquarantine_`,
   `lifts_quarantine_`, `lifts_repairnote_`, `lifts_pw_`, `lifts_aw_`:
   - old key `…_<firebaseUid>` exists and new key `…_<uuid>` absent → **copy** value to
     the new key; keep the old key so rollback to Firebase finds it intact. A later,
     separate cleanup phase (post-stabilization, approval-gated) may delete old keys.
   - both exist → conflict policy per type: snapshot/aw → keep **newer `ts`/`updatedAt`**,
     park the loser under `lifts_snapconflict_<uuid>` (same semantics as `snapPick`);
     pending queue → union by workout `id` (same dedup as `p1MergePending`,
     `js/app.js:3026–3044`); quarantine/repairnote → concatenate capped at existing
     limits.
3. **Strict 1:1:** one old uid → one uuid, always; the shim never merges keys from two
   different old uids, and never writes while signed out or for a different uid than the
   current session.
4. **Idempotent and per-device:** re-runs are no-ops (new keys already exist); each
   device remaps only its own localStorage; devices that never had old keys simply read
   the already-imported cloud row.
5. **Interaction with load rules:** because the whole record (including `ts`,
   `updatedAt`, `savedAt`) is copied verbatim, `snapPick` / `wkResolveRestore` /
   `p1MergePending` behave exactly as today — e.g. an unconfirmed-write snapshot still
   wins over the imported cloud doc if it is newer, and flushes upward after cutover.

Until that shim exists, a user on an old device would still hold valid old-uid records
that the app (after cutover) would not see — this is acceptable *because* the shim runs
before the first Supabase load; the shim must ship in the same change-set as the cutover
or immediately after (decision D-11).

---

## 5. Export, backup, import, validation, rollback

### 5.1 Principles

- All export/import tooling runs in a **trusted local environment** with admin
  credentials (Firebase service account JSON, Supabase service-role key). Neither
  credential ever enters this repository, the browser, or chat (Phase 2 client already
  hard-rejects secret keys — `js/supabase-client.js`).
- Firebase/Firestore is **read-only** throughout; Supabase writes are additive.
- Everything is checksummed, timestamped, and re-runnable in idempotent “delta” mode.

### 5.2 Export & backup

1. **Auth export** (Admin SDK `listUsers`, paginated): per user →
   `{ uid, email, emailVerified, providerData[], createdAt, disabled, lastLoginAt }`.
   Output JSONL + row count + SHA-256 of the file. PII: stored only in the trusted env.
2. **Firestore export**: Admin SDK iterate `users/*` (or the Firebase managed
   export-to-GCS for a platform-level backup): per doc → `{ uid, savedAt, data, sha256,
   updateTime }`. Take **two copies** in different locations (local + second backup)
   before any import.
3. Record the export timestamp `T_export` and the Firebase console settings that affect
   behavior (enumeration protection, authorized domains).
4. **Backup of what we are leaving behind:** Firebase stays up and untouched — the live
   project *is* the rollback backup; the exports are the audit snapshot. No production
   data is copied anywhere in this planning phase.

### 5.3 Import & validation

Order (FK requires auth users first):

1. Apply migrations (`user_data` from Phase 1, mapping table from Phase 3a) — staged
   project first, per `supabase/README.md` verification checklist.
2. Provision auth users (pinned UUIDs, confirmed, `firebase_uid` metadata); record
   `provisioned`.
3. Import `user_data` rows; record `data_imported`.
4. **Validation gates (must all pass before any cutover discussion):**
   - **Count identity:** exported auth users = mapping rows (minus explicit skips);
     Firestore docs with `savedAt`/content = imported rows; zero unexplained deltas.
   - **Payload integrity:** per-user SHA-256 from export vs. re-read from `user_data`.
     Caveat: JSONB normalizes key order and numeric formatting, so compare
     *semantically* (canonicalized JSON deep-equality) rather than byte-wise; sizes and
     top-level key sets must match exactly; full deep-equal on 100% of rows is feasible
     at this app’s scale.
   - **RLS:** anon cannot read/write; two staging users each see only their own row
     (re-run the `supabase/README.md` post-apply checks).
   - **Auth flows on staging (manual + scripted):** email/password sign-up, sign-in,
     recovery reset → sign-in, sign-out, Google popup, session persistence across
     reload, and one multi-provider account — using **test accounts only**. These tests
     have not been performed yet.
   - **App smoke on staging:** load, edit, save, offline snapshot, sign-out flush —
     against the Phase 2 adapter behind a feature flag, still not in production.
5. **Delta between `T_export` and cutover** — see decision D-4: default = final re-export
   diff immediately before cutover + import of `changed/new` docs, plus skip-listing any
   deleted/disabled accounts.

### 5.4 Rollback

- **App rollback (primary):** cutover is a single small, config-flagged merge to `main`.
  GitHub Pages builds from `main`, so rollback = `git revert` of that merge → the live
  site is the Firebase app again within one Pages build. Firebase Auth sessions, rules,
  and data were never modified, so Firebase users are unaffected.
- **Data rollback:** Supabase rows are additive; aborting the migration simply leaves
  them unused (or deletes them later via the mapping, approval-gated).
- **The one real rollback gap — writes made *after* cutover:** users who used the
  Supabase-only period will have data that Firebase never saw. Mitigation: record
  `T_cutover`; on rollback, re-import every `user_data` row with `updated_at >
  T_cutover` back into `users/{firebase_uid}` via Admin SDK using the reverse mapping.
  The shim’s copy-not-move policy for localStorage means local unsaved snapshots also
  still exist under their original keys. **Residual risk:** a rollback during a
  Supabase outage could lose writes newer than the last reverse-import — acceptable
  only with a short, agreed window (decision D-5).
- **Never** delete Firebase users/data as part of any rollback; decommissioning Firebase
  is a separate, much later phase (out of scope here).

---

## 6. How existing users recover access (password reset)

### 6.1 The mechanism (per account type)

| Account | Recovery path |
|---|---|
| Email/password | One-time password reset on Supabase: auth screen → “Forgot password?” → Supabase `resetPasswordForEmail` → email link → app opens with a recovery session (`detectSessionInUrl: true` is already configured in `js/supabase-client.js`) → user sets a new password → signed in with data. |
| Google-only | No password exists or is needed; “recovery” is just signing in with Google (§8). |
| Multi-provider | Either path; both land on the same pinned UUID (staging test case §3.3). |

### 6.2 Why old passwords cannot be verified anywhere (requirement 6)

Firebase hashes are not accepted by Supabase, and we never see plaintext. There is no
“silent acceptance of the old password” option that is safe or possible. Communicating
this clearly is a product requirement, not an edge case.

### 6.3 Required app-side pieces (future; part of cutover scope, not built yet)

- Map recovery errors to `friendlyErr()`-style messages.
- A minimal “set new password” UI for the recovery session
  (`auth.updateUser({ password })`), or confirmation that the redirect target handles
  `type=recovery`.
- Optionally, a transient auth-screen notice during the transition window.

### 6.4 Supabase-side requirements

- Recovery email template’s redirect target must be in the allow-list (§7).
- SMTP capacity: free-tier email limits are fine for staging, but a **mass** recovery
  send needs either paced sending or custom SMTP (decision D-10).

### 6.5 Communication options (decision D-7)

- **(a)** Post-cutover only: users discover via failed sign-in → “Forgot password?”
  (zero pre-communication cost; some friction).
- **(b)** One pre-cutover email to the exported address list (needs approval: content,
  sender, rate; PII usage) + (a) as fallback.
- **(c)** In-app-only banner on Firebase (small production code change — conflicts with
  req. 10’s “do not modify the live auth flow”; only acceptable if explicitly approved).
- Recommendation: **(b) with (a) as fallback**, sent only after validation gates pass.

---

## 7. Exact Supabase Auth settings and redirect URLs

Target project referenced in `supabase/README.md`: `msnoktushqwadtknxrij` (confirm it is
the intended project before applying anything — decision D-12).

### 7.1 Dashboard → Authentication → URL Configuration

- **Site URL:** `https://mostafafarid377-art.github.io/Lifts/`
- **Additional Redirect URLs (allow-list):**

  ```
  http://localhost:8080/**
  http://127.0.0.1:8080/**
  https://mostafafarid377-art.github.io/Lifts/**
  ```

  - `8080` matches the README’s documented local preview; add
    `http://localhost:<port>/**` entries for any *other* dev port actually used (keep
    the list minimal — every entry is an open redirect target class).
  - Exact current production URL to confirm at cutover time: Pages serves the site at
    `/Lifts/`; both the bare path and `/**` wildcard are listed to cover recovery
    links landing on `index.html` with query/hash parameters.
  - Any Arena/preview host used during development must be added explicitly while in
    use and removed afterwards.

### 7.2 Authentication → Providers → Email

- **Enable “Email” provider** (email + password): ON — parity with today’s flow.
- **Confirm email (verification on signup):** decision D-6.
  - App never checks `emailVerified`, so either choice preserves behavior.
  - Recommendation: **ON for new sign-ups** (better security) while **all migrated
    users are provisioned pre-confirmed** (`email_confirm: true`) so nobody is blocked;
    alternative for strict parity: OFF entirely.
- **Secure email change / double confirm:** keep defaults ON.
- **Minimum password length:** the client enforces ≥ 6 (`js/app.js:702`); Supabase’s
  default minimum is 6. Keep **6** for parity, or raise to 8 **and** update the client
  message in the same change (decision D-6).
- **Rate limits / CAPTCHA (hCaptcha/Turnstile):** defaults, CAPTCHA OFF initially for
  parity; revisit post-migration.
- **JWT expiry & refresh token rotation:** defaults (3600 s, rotation ON) —
  `js/supabase-client.js` already sets `autoRefreshToken: true, persistSession: true,
  detectSessionInUrl: true`.

### 7.3 Email templates (if confirmations ON)

- “Confirm signup”, “Magic Link”, “Change Email” (if enabled), **“Reset Password”**
  templates: their `{{ .ConfirmationURL }}` / Site URL must resolve inside the §7.1
  allow-list; customize copy to mention the one-time reset if D-7(b) is approved.

### 7.4 Browser client (already enforced by Phase 2 code)

- Project URL + **publishable key** only (`sb_publishable_…` or legacy anon);
  `js/supabase-client.js` throws before loading the SDK on secret/service-role keys or
  a `role=service_role` JWT.

---

## 8. Google sign-in: preservation and provider configuration

### 8.1 It is supported

Supabase Auth provides a Google OAuth provider with a hosted popup/redirect flow — a
direct equivalent of today’s `signInWithPopup`. The current UX intent can be carried
over: `signInWithOAuth({ provider: 'google', options: { redirectTo, scopes: 'openid
email profile', queryParams: { prompt: 'select_account' } } })` preserves the
account-picker prompt used at `js/app.js:721`.

### 8.2 Supabase-side configuration (required before cutover)

- Dashboard → Authentication → Providers → **Google: enabled**, with an OAuth **Client
  ID + Client Secret** obtained from Google Cloud Console (decision D-8: who owns the
  Google Cloud project — a *new* web OAuth client is expected; the existing Firebase
  Google provider’s client credentials are not automatically reusable).

### 8.3 Google Cloud Console — OAuth client (Web application)

- **Authorized JavaScript origins:**

  ```
  https://mostafafarid377-art.github.io
  http://localhost:8080
  http://127.0.0.1:8080
  ```

  (plus any active dev origin; origin is the host without path.)

- **Authorized redirect URI (exactly one, per Supabase):**

  ```
  https://msnoktushqwadtknxrij.supabase.co/auth/v1/callback
  ```

- **OAuth consent screen:** External user type, scopes `openid`, `email`, `profile`.
  Publishing status “Testing” limits the user pool to test users — either publish (may
  require a verification review for non-test users past the threshold) or add all real
  Google accounts as test users. github.io origins do not require domain ownership
  verification; Google will show an unverified-app warning until the consent screen is
  verified — acceptable at this scale but worth recording (decision D-8).

### 8.4 The one Google-specific migration risk (gate for cutover)

Existing Google users must land on their **pre-provisioned pinned UUID**, not on a
freshly created duplicate. The assumed mechanism — GoTrue attaching the OAuth identity
to an existing, confirmed-email user with the same address — **must be proven in
staging with a real test Google account before cutover**; it is listed as untested
here. Failure modes and fallbacks are in §9 (duplicate identity). Until that staging
test passes, Google cutover is blocked regardless of everything else being green.

---

## 9. Account-linking, duplicate-email, and migration edge cases

| # | Edge case | Handling |
|---|---|---|
| E1 | **Supabase email already exists at provision time** (leftover test/sign-up accounts) | Admin create fails `email_exists`. Reconcile explicitly per account: adopt the existing user (re-pin mapping to *its* UUID, import data, mark `conflict→verified`) **or** delete it if it is disposable test data. Never a second user for one email — and the DB unique constraint enforces it. |
| E2 | **User signs up on Supabase pre-cutover with a real future-migrated email** | Same as E1; default = adopt only after identity verification (email confirmation state, created-at vs export), else skip + support ticket. Decision D-9 covers test-account policy during the pre-cutover period. |
| E3 | **Multi-provider Firebase account** (`password` + `google.com`) | Provision once (pinned); recovery sets a password; Google link must attach to the *same* UUID. Staging test case. |
| E4 | **Google auto-link to pre-provisioned user fails** (creates duplicate or errors) | Blocking gate (§8.4). Fallbacks: (i) enable the provider only after link-behavior confirmed; (ii) server-side admin link via Admin API identity endpoints; (iii) keep affected Google accounts on Firebase temporarily (partial cutover — only with explicit approval; complicates rollback). |
| E5 | **Email changed/changed-pending/unverified in Firebase at export** | Migrate the *primary* email at export; recovery emails go there. Unverified new emails are not migrated. Record `emailVerified`; mismatches flagged in validation report. |
| E6 | **Email casing/whitespace differences** | Normalize to lowercase on both sides at manifest build; Firebase emails are already case-insensitive-canonical — diff report for anything odd. |
| E7 | **Account disabled/deleted between export and cutover** | Delta re-check before cutover (§5.3.5); status `skipped`; its mapping row must never be used to import. |
| E8 | **New users created in the delta window** | Final delta export + provision + import; user count reconciliation must be exact before cutover. |
| E9 | **Anonymous Firebase users** (if any exist outside this app) | Excluded and listed; never provisioned. App source contains no anonymous sign-in (verified). |
| E10 | **Sessions alive during cutover** | Firebase tokens remain valid but the cutover app doesn’t use them; every user signs in once on Supabase. No cross-token carryover exists or is attempted. |
| E11 | **Recovery link opened while another account is signed in** | Recovery session switches the authenticated user; `onAuthStateChanged`-equivalent path (`js/app.js:628–650` design) wipes in-memory state of the previous account via the switch-user routine before loading — same safety property as today. |
| E12 | **Old-device localStorage under old uid** (device used before cutover) | Copy-based remap shim (§4.2) keyed strictly by the session’s `firebase_uid` claim; devices without a mapping claim are untouched. |
| E13 | **Two old Firebase accounts, one person** (possible: different emails) | Kept as two separate Supabase accounts — identity merge is a *support* decision, never automated (merging data = account mixing risk). |
| E14 | **Duplicate workout/payload entries within one user’s doc** | Not a migration concern: payload is copied opaquely; existing load-time normalization (`js/app.js:436–460`, `normWorkouts` dedup) already owns this. |
| E15 | **Mapping table or metadata drift** | Validation compares manifest ↔ mapping table ↔ `raw_app_meta_data` ↔ `user_data` UUID set; any 4-way mismatch fails the gate. |
| E16 | **Mass recovery emails hitting rate limits** | Pace or custom SMTP (D-10); fallback is users self-serving via the button (D-7a). |

---

## 10. Production stays Firebase (scope confirmation)

- No file outside this document changes in this phase; the live auth flow
  (`js/app.js` auth section, `js/firebase.js`, `index.html` script tags) is untouched.
- No users are created, exported, or copied; no migration SQL is applied; nothing is
  deployed; Firebase remains the sole production Auth + Firestore backend.
- Phase 2 artifacts remain isolated by design: `js/supabase-client.js` lazy-loads only
  when explicitly called, `js/supabase-data.js` is imported by tests only, and the
  `user_data` migration exists as an **unapplied** file (per `supabase/README.md`).
- Test status claim, verbatim: **regression 21 passed, preparation 7 passed; an
  authentication migration and live Supabase integration have not been built and have
  not been tested.** Every staging test named above is a *planned* test.

---

## Risks

| ID | Risk | Severity | Mitigation |
|---|---|---|---|
| R1 | Google identity does not attach to the pre-provisioned user → duplicate/split accounts | **High** | Blocking staging test (§8.4); fallbacks E4 |
| R2 | User misses the one-time reset and churns after cutover | Medium | D-7(b) pre-communication + prominent recovery UX; Google users unaffected |
| R3 | Export→cutover drift (writes, deletes, new sign-ups) | Medium | Delta re-export + count reconciliation gate (§5.3.5) |
| R4 | Rollback loses Supabase-era writes | Medium | `T_cutover` + reverse re-import procedure (§5.4); short agreed window (D-5) |
| R5 | PII (emails) leaking into the public repo | Medium | Manifest lives only in trusted env; mapping table is service-role-only; pre-commit check |
| R6 | Import writes payload to the wrong UUID | **High** | Pinned manifest-only UUIDs, 4-way set equality gate (E15), no email-based joins |
| R7 | Redirect allow-list misconfig → recovery/OAuth links rejected | Medium | Exact URL list (§7.1/§8.3) tested on staging + local before cutover |
| R8 | SMTP limits block recovery emails at volume | Low | D-10 pacing/custom SMTP; self-serve fallback |
| R9 | localStorage remap mixes two accounts on a shared device | **High** | Identity-gated, 1:1, copy-based shim (§4.2); keyed by verified `firebase_uid` claim only |
| R10 | Supabase free-tier project limits/limits changes mid-migration | Low | Confirm project + plan (D-12) before provisioning |

## Decisions requiring approval

| ID | Decision | Recommendation |
|---|---|---|
| D-1 | Migration strategy: A (pre-provision) vs B/C | **A** |
| D-2 | Apply Phase 1 `user_data` migration + new `firebase_uid_map` migration to a Supabase project (staged first) | Yes, approval-gated |
| D-3 | Who runs export/import, where credentials live (trusted local env), PII handling policy | Owner + local-only storage; never in repo/chat |
| D-4 | Delta-window strategy: final re-export pre-cutover vs quiet window | Final re-export + reconciliation |
| D-5 | Rollback window: acceptable max age of un-reimported Supabase-era writes | Agree a window (e.g. hours) before cutover |
| D-6 | Confirm-email policy for new sign-ups; password minimum (6 parity vs 8 + client change) | Confirm ON (migrated pre-confirmed); password 6 parity initially |
| D-7 | User communication: pre-cutover email / in-app notice / none | Pre-cutover email + post fallback |
| D-8 | New Google OAuth client: creation, consent-screen publishing, ownership | Create new web client; publish or manage test users |
| D-9 | Test-account policy on the target project during the pre-cutover period | Restrict to known test emails (avoids E1/E2) |
| D-10 | Custom SMTP vs paced sending for recovery volume | Pace first; custom SMTP if sending in bulk |
| D-11 | Ship localStorage remap shim in the cutover change-set vs immediately after | Same change-set |
| D-12 | Confirm target Supabase project (`msnoktushqwadtknxrij`) and staging project choice | Confirm before any apply |
| D-13 | Date/window for staging rehearsal completion before cutover is even discussed | Set after Phase 3a/3b land |

---

## Recommended next smallest safe implementation step

**Phase 3a — schema + offline mapping tooling, zero credentials, zero production
contact:**

1. Add `supabase/migrations/2026xxxx_create_firebase_uid_map.sql` (§3.1) as a
   **schema-only, not-applied** file with the same “apply only through a reviewed
   workflow” header as the Phase 1 migration.
2. Add `scripts/migration/build-manifest.mjs`: reads an exported Auth JSONL
   *(fixture-format only in tests; real input never enters the repo)* and emits the
   pinned-UUID mapping manifest with normalization, provider-hint derivation, and
   count/checksum assertions — plus
   `tests/migration-manifest.test.cjs` in the existing dependency-free `node --test`
   style (new tests must pass alongside the existing **21 + 7**).

Why this step: it is the smallest piece that everything downstream (provisioning,
import, validation, the remap shim) depends on; it is fully testable offline with
fixtures; and it touches no production code, no live auth flow, no real user data, and
deploys nothing. Explicitly, it does **not** constitute or test an authentication
migration.

**Stop point:** this document + Phase 3a are the only sanctioned artifacts of Phase 3
so far; cutover remains blocked on the approvals above and on staging validation that
has not yet been written or run.
