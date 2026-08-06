-- Seed the single v1 workspace and its standing invites. Members are attached
-- automatically at first sign-in by handle_new_user(); adding a collaborator
-- later is one INSERT into workspace_invites.

with ws as (
  insert into public.workspaces (name) values ('quantdesk') returning id
)
insert into public.workspace_invites (workspace_id, email, role)
select id, 'shivaansood@gmail.com', 'owner' from ws;
