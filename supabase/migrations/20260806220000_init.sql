-- ccshare initial schema — DESIGN.md §4. Single-writer session model:
-- only the host daemon inserts events and mutates control_request state;
-- everyone else in the workspace reads, and requests actions via control_requests.

-- ---------------------------------------------------------------------------
-- Tables

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

-- Invites are matched by email at first sign-in (trigger below), so a member
-- can be added before they have ever logged in.
create table public.workspace_invites (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  email text not null,
  role text not null default 'member' check (role in ('owner', 'member')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, email)
);

create table public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  avatar_url text,
  created_at timestamptz not null default now()
);

create table public.sessions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  host_user_id uuid not null references auth.users(id),
  kind text not null check (kind in ('shared', 'mirror')),
  status text not null default 'live' check (status in ('live', 'ended')),
  mode text not null default 'moderated' check (mode in ('equal', 'moderated')),
  title text,
  cwd text not null,
  model text,
  permission_mode text,
  claude_session_id text,
  last_heartbeat_at timestamptz,
  created_at timestamptz not null default now(),
  ended_at timestamptz
);

create index sessions_workspace_idx
  on public.sessions (workspace_id, status, created_at desc);

-- Append-only event log. seq is assigned by the host daemon and is the
-- authoritative order; the composite PK makes redelivery/crash-resume safe.
create table public.events (
  session_id uuid not null references public.sessions(id) on delete cascade,
  seq bigint not null,
  type text not null,
  author_user_id uuid,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  primary key (session_id, seq)
);

-- Full payloads for events whose streamed copy was truncated (large tool output).
create table public.event_blobs (
  session_id uuid not null,
  seq bigint not null,
  content jsonb not null,
  primary key (session_id, seq),
  foreign key (session_id, seq)
    references public.events(session_id, seq) on delete cascade
);

create table public.control_requests (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  requested_by uuid not null references auth.users(id),
  action jsonb not null,
  status text not null default 'pending' check (
    status in ('pending', 'applied', 'needs_approval', 'approved',
               'rejected', 'superseded', 'failed')
  ),
  decided_by uuid,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);

create index control_requests_session_idx
  on public.control_requests (session_id, created_at);

create table public.attachments (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  uploader_id uuid not null references auth.users(id),
  storage_path text not null,
  mime text not null,
  bytes bigint,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Membership helpers (security definer so RLS policies can join freely)

create or replace function public.is_workspace_member(ws uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = ws and m.user_id = (select auth.uid())
  );
$$;

create or replace function public.is_session_member(sid uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.sessions s
    join public.workspace_members m on m.workspace_id = s.workspace_id
    where s.id = sid and m.user_id = (select auth.uid())
  );
$$;

create or replace function public.is_session_host(sid uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.sessions s
    where s.id = sid and s.host_user_id = (select auth.uid())
  );
$$;

-- ---------------------------------------------------------------------------
-- Row-level security (matrix in DESIGN.md §4.2)

alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.workspace_invites enable row level security;
alter table public.profiles enable row level security;
alter table public.sessions enable row level security;
alter table public.events enable row level security;
alter table public.event_blobs enable row level security;
alter table public.control_requests enable row level security;
alter table public.attachments enable row level security;

create policy "members read workspace" on public.workspaces
  for select to authenticated
  using (public.is_workspace_member(id));

create policy "members read membership" on public.workspace_members
  for select to authenticated
  using (public.is_workspace_member(workspace_id));

create policy "members read invites" on public.workspace_invites
  for select to authenticated
  using (public.is_workspace_member(workspace_id));

create policy "signed-in users read profiles" on public.profiles
  for select to authenticated
  using (true);

create policy "members read sessions" on public.sessions
  for select to authenticated
  using (public.is_workspace_member(workspace_id));

create policy "host creates own sessions" on public.sessions
  for insert to authenticated
  with check (
    host_user_id = (select auth.uid())
    and public.is_workspace_member(workspace_id)
  );

create policy "host updates own sessions" on public.sessions
  for update to authenticated
  using (host_user_id = (select auth.uid()));

create policy "members read events" on public.events
  for select to authenticated
  using (public.is_session_member(session_id));

create policy "host appends events" on public.events
  for insert to authenticated
  with check (public.is_session_host(session_id));

create policy "members read event blobs" on public.event_blobs
  for select to authenticated
  using (public.is_session_member(session_id));

create policy "host appends event blobs" on public.event_blobs
  for insert to authenticated
  with check (public.is_session_host(session_id));

create policy "members read control requests" on public.control_requests
  for select to authenticated
  using (public.is_session_member(session_id));

create policy "members file control requests" on public.control_requests
  for insert to authenticated
  with check (
    requested_by = (select auth.uid())
    and public.is_session_member(session_id)
    and exists (
      select 1 from public.sessions s
      where s.id = session_id and s.status = 'live' and s.kind = 'shared'
    )
  );

create policy "host decides control requests" on public.control_requests
  for update to authenticated
  using (public.is_session_host(session_id));

create policy "members read attachments" on public.attachments
  for select to authenticated
  using (public.is_session_member(session_id));

create policy "members add attachments" on public.attachments
  for insert to authenticated
  with check (
    uploader_id = (select auth.uid())
    and public.is_session_member(session_id)
  );

-- ---------------------------------------------------------------------------
-- New-user bootstrap: profile row + invite-based workspace membership

create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  insert into public.profiles (user_id, display_name, avatar_url)
  values (
    new.id,
    coalesce(
      new.raw_user_meta_data ->> 'name',
      new.raw_user_meta_data ->> 'user_name',
      split_part(new.email, '@', 1)
    ),
    new.raw_user_meta_data ->> 'avatar_url'
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

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Realtime: postgres_changes for registry/control tables

alter publication supabase_realtime add table public.sessions;
alter publication supabase_realtime add table public.control_requests;

-- Private broadcast/presence channels `session:{uuid}` — members only
create or replace function public.is_session_member_topic(topic text)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select case
    when topic ~ '^session:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then public.is_session_member(substring(topic from 9)::uuid)
    else false
  end;
$$;

create policy "session members receive broadcasts" on realtime.messages
  for select to authenticated
  using (public.is_session_member_topic(realtime.topic()));

create policy "session members send broadcasts" on realtime.messages
  for insert to authenticated
  with check (public.is_session_member_topic(realtime.topic()));

-- ---------------------------------------------------------------------------
-- Storage: private attachments bucket; path convention <session_id>/<file>

insert into storage.buckets (id, name, public)
values ('attachments', 'attachments', false)
on conflict (id) do nothing;

create policy "session members read attachment objects" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'attachments'
    and public.is_session_member(((storage.foldername(name))[1])::uuid)
  );

create policy "session members upload attachment objects" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'attachments'
    and public.is_session_member(((storage.foldername(name))[1])::uuid)
  );
