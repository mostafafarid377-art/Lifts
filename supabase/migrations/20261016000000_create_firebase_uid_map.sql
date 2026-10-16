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
--   * email is UNIQUE                  → one row per address (no hidden twins).
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
  supabase_uuid uuid not null unique,
  email         text not null unique,
  provider_hint text not null default 'password',
  status        text not null default 'planned',
  created_at    timestamptz not null default now(),
  verified_at   timestamptz,
  constraint firebase_uid_map_status_check
    check (status in ('planned','provisioned','data_imported','verified','conflict','skipped'))
);

comment on table public.firebase_uid_map is
  'Planning-only mapping between Firebase Auth UIDs and pinned Supabase Auth UUIDs. Deny-by-default: RLS enabled with zero policies and no grants for anon/authenticated. service_role (trusted migration tooling outside the browser only) performs all access.';

alter table public.firebase_uid_map enable row level security;

revoke all privileges on table public.firebase_uid_map from public, anon, authenticated;

-- Trusted tooling only: the service_role key must never reach the browser
-- (see header). Supabase's default privileges usually already grant this;
-- stating it explicitly keeps the intended access path auditable.
grant select, insert, update, delete on table public.firebase_uid_map to service_role;
