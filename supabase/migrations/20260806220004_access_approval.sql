-- Access approval flow: anyone may sign up (auth user + profile), but access
-- requires workspace membership — granted either by a standing email invite
-- (trigger) or by an owner approving the request in the web app.
-- Also tightens profiles: strangers can no longer enumerate member names.

alter table public.profiles add column if not exists email text;

update public.profiles p
set email = u.email
from auth.users u
where u.id = p.user_id and p.email is null;

create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  insert into public.profiles (user_id, display_name, avatar_url, email)
  values (
    new.id,
    coalesce(
      new.raw_user_meta_data ->> 'name',
      new.raw_user_meta_data ->> 'user_name',
      split_part(new.email, '@', 1)
    ),
    new.raw_user_meta_data ->> 'avatar_url',
    new.email
  )
  on conflict (user_id) do nothing;

  insert into public.workspace_members (workspace_id, user_id, role)
  select i.workspace_id, new.id, i.role
  from public.workspace_invites i
  where lower(i.email) = lower(new.email)
  on conflict do nothing;

  return new;
end;
$$;

create or replace function public.is_any_workspace_member()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.workspace_members m
    where m.user_id = (select auth.uid())
  );
$$;

drop policy "signed-in users read profiles" on public.profiles;

create policy "read own profile" on public.profiles
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy "members read profiles" on public.profiles
  for select to authenticated
  using (public.is_any_workspace_member());
