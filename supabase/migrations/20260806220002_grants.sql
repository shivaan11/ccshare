-- Newer Supabase Postgres images no longer default-grant DML on public tables
-- to the API roles; without these grants every request fails with 42501 before
-- RLS is even consulted. Grants stay coarse — RLS (DESIGN §4.2) is the real
-- boundary, e.g. events stays append-only because no UPDATE policy exists.

grant usage on schema public to authenticated, service_role;

grant select, insert, update on all tables in schema public to authenticated;
grant all on all tables in schema public to service_role;

alter default privileges in schema public
  grant select, insert, update on tables to authenticated;
alter default privileges in schema public
  grant all on tables to service_role;

-- anon gets nothing: pre-auth requests never touch our tables.
