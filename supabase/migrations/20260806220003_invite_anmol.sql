insert into public.workspace_invites (workspace_id, email, role)
select id, 'anmolsinha3802@gmail.com', 'member'
from public.workspaces
where name = 'quantdesk'
on conflict do nothing;
