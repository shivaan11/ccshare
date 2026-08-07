#!/usr/bin/env node
// RLS verification against the LOCAL Supabase stack (`supabase start` first).
// Exercises the trust boundary with real user JWTs: the things the matrix in
// DESIGN §4.2 forbids must actually fail. Run: pnpm rls-check

import { createClient } from "@supabase/supabase-js";

const URL = "http://127.0.0.1:54321";
// Static local-dev demo keys (public in supabase CLI output; never production)
const SERVICE =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";
const ANON =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${ok ? "" : ` — ${detail}`}`);
  if (!ok) failures += 1;
}

async function userClient(email) {
  const password = "test-password-1234";
  const { data: created, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  let userId = created?.user?.id;
  if (error) {
    const { data: list } = await admin.auth.admin.listUsers();
    userId = list.users.find((u) => u.email === email)?.id;
  }
  const client = createClient(URL, ANON, { auth: { persistSession: false } });
  const { error: signInError } = await client.auth.signInWithPassword({
    email,
    password,
  });
  if (signInError) throw new Error(`sign-in failed: ${signInError.message}`);
  return { client, userId };
}

const host = await userClient("host@test.local");
const guest = await userClient("guest@test.local");
const outsider = await userClient("outsider@test.local");

// workspace with host + guest (service role — mirrors the invite flow)
const { data: ws, error: wsError } = await admin
  .from("workspaces")
  .insert({ name: "rls-check" })
  .select("id")
  .single();
if (wsError) {
  console.error(`workspace insert failed: ${wsError.message}`);
  process.exit(1);
}
await admin.from("workspace_members").insert([
  { workspace_id: ws.id, user_id: host.userId, role: "owner" },
  { workspace_id: ws.id, user_id: guest.userId, role: "member" },
]);

// host creates a live session
const { data: session, error: sessionError } = await host.client
  .from("sessions")
  .insert({
    workspace_id: ws.id,
    host_user_id: host.userId,
    kind: "shared",
    cwd: "/tmp/rls",
    mode: "moderated",
  })
  .select("id")
  .single();
check("host can create a session", !sessionError, sessionError?.message);

{
  const { error } = await host.client.from("events").insert({
    session_id: session.id,
    seq: 1,
    type: "status_change",
    payload: { type: "status_change", status: "idle" },
  });
  check("host can append events", !error, error?.message);
}
{
  const { error } = await guest.client.from("events").insert({
    session_id: session.id,
    seq: 2,
    type: "status_change",
    payload: { type: "status_change", status: "idle" },
  });
  check("guest CANNOT forge events", Boolean(error));
}
{
  const { data } = await guest.client
    .from("events")
    .select("seq")
    .eq("session_id", session.id);
  check("guest can read the transcript", (data ?? []).length === 1);
}
{
  const { data } = await outsider.client
    .from("sessions")
    .select("id")
    .eq("id", session.id);
  check("outsider CANNOT see the session", (data ?? []).length === 0);
}
{
  const { data, error } = await guest.client
    .from("control_requests")
    .insert({
      session_id: session.id,
      requested_by: guest.userId,
      action: { kind: "interrupt" },
    })
    .select("id")
    .single();
  check("guest can file control requests", !error, error?.message);

  const { data: after } = await guest.client
    .from("control_requests")
    .update({ status: "approved" })
    .eq("id", data.id)
    .select("status");
  check(
    "guest CANNOT self-approve (update blocked)",
    (after ?? []).length === 0,
  );
}
{
  const { error } = await guest.client.from("control_requests").insert({
    session_id: session.id,
    requested_by: host.userId, // spoof attempt
    action: { kind: "interrupt" },
  });
  check("guest CANNOT spoof requested_by", Boolean(error));
}
{
  const { error } = await outsider.client.from("control_requests").insert({
    session_id: session.id,
    requested_by: outsider.userId,
    action: { kind: "interrupt" },
  });
  check("outsider CANNOT file control requests", Boolean(error));
}

// cleanup
await admin.from("workspaces").delete().eq("id", ws.id);
for (const u of [host, guest, outsider]) {
  await admin.auth.admin.deleteUser(u.userId);
}

console.log(
  failures === 0
    ? "\nRLS check: all good"
    : `\nRLS check: ${failures} FAILURES`,
);
process.exit(failures === 0 ? 0 : 1);
