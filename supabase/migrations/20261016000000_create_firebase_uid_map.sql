-- LIFTS Phase 3a: explicit Firebase UID ↔ Supabase UUID mapping (schema-only).
-- Apply only through a reviewed Supabase migration workflow; this file has NOT
-- been applied to any Supabase project and must not be applied until approved
-- (docs/phase-3-auth-migration-plan.md — decisions D-2/D-12).
--
-- Purpose: one authoritative row per Firebase account so Firestore documents
-- (users/{firebase_uid}) and uid-keyed local recovery records are imported and
-- remapped without ever guessing identity from an email address. The offline
-- builder (scripts/migration/build-manifest.mjs) produces the matching
-- manifest; this table mirrors it for tooling and later validation.
--
-- Invariants (deny duplicates at the database, not just in tooling):
--   * firebase_uid is the PRIMARY KEY  → exactly one mapping per Firebase UID.
--   * supabase_uuid is UNIQUE          → one-to-one pinned Supabase UUIDs.
--
-- Deliberate non-invariant: `email` is NOT unique and is NOT identity.
-- (Verified in the Phase 3a review, docs/phase-3-auth-migration-plan.md
-- "Phase 3a verification addendum".) Identity is firebase_uid → supabase_uuid
-- only; emails change over time (delta exports, in-app edits) and one account
-- legitimately carries several provider identities with the same address.
-- UNIQUE(email) would fight legitimate row updates while catching nothing the
-- offline builder does not already reject at export time; duplicates are
-- therefore reported as build errors / `status='conflict'` rows, never
-- enforced here. The column exists for provisioning and conflict reporting.
--
-- Access model — deny-by-default, browser roles see nothing:
--   * Row-level security is enabled and the table defines ZERO policies: for
--     the anon and authenticated roles every row operation is denied by
--     default (RLS denies when no policy allows).
--   * All explicit privileges are revoked from PUBLIC, anon and authenticated,
--     so even though authenticated holds schema USAGE, it cannot read or
--     modify any mapping row through Postgres, the Data API, or realtime.
--   * No SELECT/INSERT/UPDATE/DELETE policy may ever be added for anon or
--     authenticated on this table. If runtime code appears to need one, treat
--     that as a design error and revisit the plan instead of opening RLS.
--
-- How trusted migration tooling accesses this table WITHOUT exposing a
-- service-role key to the browser:
--   * The offline tooling (export → build-manifest → provisioning/import,
--     all scheduled later) runs OUTSIDE the browser, in the operator's
--     trusted local environment, and connects to the project as the
--   * service_role role (Supabase grants that role BYPASSRLS and the explicit
--     data privileges below). The service-role key is supplied from an
--     environment variable / secret manager on that machine only: never
--     committed to this repository, never written into js/ or index.html,
--     never placed in any manifest or export artifact in Git, and rejected
--     before client creation by js/supabase-client.js (which refuses
--     sb_secret_ keys and role=service_role JWTs in browser code).
--   * The browser app authenticates with the publishable (anon) key and an
--     end-user session; neither carries privileges over this table.

create table public.firebase_uid_map (
  firebase_uid  text primary key,
  -- Planned pin. Supabase Auth's Admin API (POST /admin/users) accepts a
  -- caller-supplied "id" (verified against supabase/auth internal/api/admin.go
  -- and the supabase-js AdminUserAttributes type), so this value is requested
  -- at provisioning and only trusted once status >= 'provisioned' and the
  -- Admin API response id has been checked to equal it. Because firebase_uid
  -- is the primary key, a future API that returns a different actual id can
  -- still be recorded here through approved reconciliation without ever
  -- remapping by email.
  supabase_uuid uuid not null unique,
  -- Advisory copy of the account email at export time — provisioning and
  -- conflict reporting only; never used for identity matching (see header).
  email         text not null,
  provider_hint text not null default 'password',
  status        text not null default 'planned',
  created_at    timestamptz not null default now(),
  verified_at   timestamptz,
  constraint firebase_uid_map_status_check
    check (status in ('planned','provisioned','data_imported','verified','conflict','skipped'))
);

comment on table public.firebase_uid_map is
  'Planning-only mapping between Firebase Auth UIDs and pinned Supabase Auth UUIDs. Deny-by-default: RLS enabled with zero policies and no grants for anon/authenticated. service_role (trusted migration tooling outside the browser only) performs all access.';
comment on column public.firebase_uid_map.email is
  'Advisory email snapshot at export time. Not unique by design, never used for identity matching; duplicate/changed emails are surfaced by the offline builder and status=conflict rows for human review.';
comment on column public.firebase_uid_map.supabase_uuid is
  'Planned Supabase Auth UUID (deterministic pin). Trustworthy only for status >= provisioned after the Admin API response id has been verified to match; mismatches are status=conflict and require approved reconciliation.';

alter table public.firebase_uid_map enable row level security;

revoke all privileges on table public.firebase_uid_map from public, anon, authenticated;

-- Trusted tooling only: the service_role key must never reach the browser
-- (see header). Supabase's default privileges usually already grant this;
-- stating it explicitly keeps the intended access path auditable.
grant select, insert, update, delete on table public.firebase_uid_map to service_role;
