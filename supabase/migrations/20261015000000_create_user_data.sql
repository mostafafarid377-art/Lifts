-- LIFTS Phase 1: private per-user JSON payload storage.
-- Apply only through a reviewed Supabase migration workflow; this file has not
-- been applied to the live project.

create table public.user_data (
  user_id uuid primary key references auth.users (id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  schema_version integer not null default 1,
  revision bigint not null default 0,
  updated_at timestamptz not null default now()
);

-- RLS is the row-level boundary; explicit grants also prevent the anon role
-- (and PostgreSQL PUBLIC) from reaching this table through the Data API.
alter table public.user_data enable row level security;

revoke all privileges on table public.user_data from public, anon, authenticated;
grant select, insert, update, delete on table public.user_data to authenticated;

create policy user_data_select_own
  on public.user_data
  for select
  to authenticated
  using (auth.uid() = user_id);

create policy user_data_insert_own
  on public.user_data
  for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy user_data_update_own
  on public.user_data
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy user_data_delete_own
  on public.user_data
  for delete
  to authenticated
  using (auth.uid() = user_id);
