# Supabase database preparation — Phase 1

## Migration

`migrations/20261015000000_create_user_data.sql` creates `public.user_data`, a single JSONB payload row per Supabase Auth user. The table has the requested schema, references `auth.users(id)` with `ON DELETE CASCADE`, enables row-level security, and defines separate owner-only `SELECT`, `INSERT`, `UPDATE`, and `DELETE` policies. It removes table privileges from PostgreSQL `PUBLIC`, `anon`, and `authenticated` before granting `authenticated` only the four required data operations. No `anon` policy or public grant is added.

This is a schema-only preparation step. It does not create users, move Firebase data, change the app, or configure Auth providers. The migration has **not** been applied to any Supabase project; the database must not be considered ready until it is applied and tested.

## Applying it later

For the supplied project (`msnoktushqwadtknxrij`), a manual option is to open that project's Supabase Dashboard → **SQL Editor**, review and run the full migration file, then verify the table and policies in **Database → Tables / Policies**. Do not run it until the migration is approved for application.

Alternatively, use the Supabase CLI from a trusted local environment after initializing/linking the project and reviewing the target. This checkout does not yet include `supabase/config.toml`. Never put a database password or service-role key in this repository or browser code; handle any required administrative credentials only in the trusted local environment.

## Post-apply security checks

Before connecting the app, verify all of the following against the target project:

1. `public.user_data` has the expected columns, primary key, and foreign key to `auth.users(id)` with cascade delete.
2. RLS is enabled and the four policies target only `authenticated`; the `SELECT`/`DELETE` policies use `auth.uid() = user_id`, `INSERT` uses it in `WITH CHECK`, and `UPDATE` uses it in both `USING` and `WITH CHECK`.
3. An unauthenticated/`anon` request cannot select or modify rows.
4. With two test authenticated users, each user can perform the required operations on their own row and cannot read or change the other user's row.

The Supabase `service_role` is privileged and can bypass RLS by design. Keep its key server-side and out of the app. This migration neither references nor exposes any service-role credential; the browser app must use the publishable key with an authenticated user session.
