import type { SessionMode } from "@ccshare/protocol";
import type { SupabaseClient } from "@supabase/supabase-js";
import { config } from "./config.js";
import { log } from "./log.js";

export type UserContext = {
  userId: string;
  displayName: string;
  workspaceId: string;
};

export async function resolveUserContext(
  client: SupabaseClient,
): Promise<UserContext> {
  const { data: userData, error: userError } = await client.auth.getUser();
  if (userError || !userData.user) throw new Error("Not logged in.");
  const userId = userData.user.id;

  const [{ data: profile }, { data: memberships, error: memberError }] =
    await Promise.all([
      client
        .from("profiles")
        .select("display_name")
        .eq("user_id", userId)
        .maybeSingle(),
      client.from("workspace_members").select("workspace_id").limit(1),
    ]);
  if (memberError) throw new Error(memberError.message);
  const workspaceId = memberships?.[0]?.workspace_id;
  if (!workspaceId) {
    throw new Error(
      "You are not a member of any workspace. Ask for an invite, then sign in to the web app once.",
    );
  }
  return {
    userId,
    displayName: profile?.display_name ?? "unknown",
    workspaceId,
  };
}

export async function createSessionRow(
  client: SupabaseClient,
  args: {
    workspaceId: string;
    hostUserId: string;
    kind: "shared" | "mirror";
    mode: SessionMode;
    cwd: string;
    model?: string;
    permissionMode?: string;
    claudeSessionId?: string;
  },
): Promise<string> {
  const { data, error } = await client
    .from("sessions")
    .insert({
      workspace_id: args.workspaceId,
      host_user_id: args.hostUserId,
      kind: args.kind,
      mode: args.mode,
      cwd: args.cwd,
      model: args.model ?? null,
      permission_mode: args.permissionMode ?? null,
      claude_session_id: args.claudeSessionId ?? null,
      last_heartbeat_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error) throw new Error(`Could not register session: ${error.message}`);
  return data.id as string;
}

export function startHeartbeat(
  client: SupabaseClient,
  sessionId: string,
): () => void {
  const timer = setInterval(() => {
    void client
      .from("sessions")
      .update({ last_heartbeat_at: new Date().toISOString() })
      .eq("id", sessionId)
      .then(({ error }) => {
        if (error) log.warn({ err: error.message }, "heartbeat failed");
      });
  }, config.heartbeatIntervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

export async function updateSessionRow(
  client: SupabaseClient,
  sessionId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const { error } = await client
    .from("sessions")
    .update(patch)
    .eq("id", sessionId);
  if (error) log.warn({ err: error.message }, "session update failed");
}

export async function endSessionRow(
  client: SupabaseClient,
  sessionId: string,
): Promise<void> {
  await updateSessionRow(client, sessionId, {
    status: "ended",
    ended_at: new Date().toISOString(),
  });
}
