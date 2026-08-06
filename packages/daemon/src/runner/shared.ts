import readline from "node:readline";
import {
  type PermissionResult,
  query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { PermissionMode, SessionMode } from "@ccshare/protocol";
import type { SupabaseClient } from "@supabase/supabase-js";
import { config } from "../config.js";
import { log } from "../log.js";
import { AsyncQueue } from "../queue.js";
import {
  createSessionRow,
  endSessionRow,
  resolveUserContext,
  startHeartbeat,
  updateSessionRow,
} from "../state.js";
import { EventWriter } from "../transport.js";
import { adaptMessage } from "./adapter.js";

// Shared-session runner — DESIGN §5.3. Runs Claude Code headless via the Agent
// SDK, streams protocol events up, and (M1) takes host input from the terminal.
// M2 replaces the terminal composer with control_requests consumption.

export type SharedRunnerOptions = {
  cwd: string;
  mode: SessionMode;
  model?: string;
  permissionMode?: PermissionMode;
  resume?: string;
};

export async function runSharedSession(
  client: SupabaseClient,
  opts: SharedRunnerOptions,
): Promise<void> {
  const user = await resolveUserContext(client);
  const permissionMode: PermissionMode = opts.permissionMode ?? "default";

  const sessionId = await createSessionRow(client, {
    workspaceId: user.workspaceId,
    hostUserId: user.userId,
    kind: "shared",
    mode: opts.mode,
    cwd: opts.cwd,
    model: opts.model,
    permissionMode,
    claudeSessionId: opts.resume,
  });
  const writer = new EventWriter(client, sessionId, 0);
  const stopHeartbeat = startHeartbeat(client, sessionId);

  console.log(`\n  ccshare session live: ${config.appUrl}/s/${sessionId}\n`);
  console.log(`  Type to talk to Claude. Ctrl-C ends the session.\n`);

  const input = new AsyncQueue<SDKUserMessage>();
  let titled = opts.resume !== undefined;
  let pendingPermission: ((allowed: boolean) => void) | null = null;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "› ",
  });

  const injectUserMessage = async (text: string): Promise<void> => {
    await writer.write(
      {
        type: "user_message",
        text,
        authorName: user.displayName,
        via: "web",
        attachments: [],
      },
      user.userId,
    );
    await writer.write({ type: "status_change", status: "working" });
    input.push({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: `[${user.displayName}]: ${text}` }],
      },
      parent_tool_use_id: null,
      session_id: "",
      origin: { kind: "human" },
    } as SDKUserMessage);
    if (!titled) {
      titled = true;
      await updateSessionRow(client, sessionId, { title: text.slice(0, 80) });
    }
  };

  rl.on("line", (line) => {
    const text = line.trim();
    if (pendingPermission) {
      const allowed = /^y(es)?$/i.test(text);
      pendingPermission(allowed);
      pendingPermission = null;
      return;
    }
    if (text.length === 0) {
      rl.prompt();
      return;
    }
    void injectUserMessage(text).catch((err) =>
      log.error({ err: String(err) }, "failed to send message"),
    );
  });

  const canUseTool = async (
    toolName: string,
    toolInput: Record<string, unknown>,
  ): Promise<PermissionResult> => {
    const requestId = crypto.randomUUID();
    const inputSummary = JSON.stringify(toolInput).slice(0, 200);
    await writer.write({
      type: "permission_request",
      requestId,
      toolName,
      inputSummary,
      input: toolInput,
    });
    await writer.write({
      type: "status_change",
      status: "awaiting_permission",
    });

    process.stdout.write(
      `\n  ⚠ permission: ${toolName} ${inputSummary}\n  allow? [y/N] `,
    );
    const allowed = await new Promise<boolean>((resolve) => {
      pendingPermission = resolve;
    });

    await writer.write({
      type: "permission_decision",
      requestId,
      decision: allowed ? "allow" : "deny",
      decidedByName: user.displayName,
    });
    await writer.write({ type: "status_change", status: "working" });
    rl.prompt();
    return allowed
      ? { behavior: "allow", updatedInput: toolInput }
      : {
          behavior: "deny",
          message: `${user.displayName} denied ${toolName} via ccshare`,
        };
  };

  const q = query({
    prompt: input,
    options: {
      cwd: opts.cwd,
      model: opts.model,
      permissionMode,
      resume: opts.resume,
      includePartialMessages: true,
      settingSources: ["user", "project", "local"],
      canUseTool,
    },
  });

  let shuttingDown = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    rl.close();
    input.close();
    stopHeartbeat();
    await writer
      .write({ type: "session_ended", reason })
      .catch(() => undefined);
    await endSessionRow(client, sessionId);
    await writer.close();
    process.exit(0);
  };
  rl.on("SIGINT", () => void shutdown("host_exit"));
  process.on("SIGTERM", () => void shutdown("host_exit"));

  let announced = false;
  try {
    for await (const msg of q) {
      if (msg.type === "system" && msg.subtype === "init" && !announced) {
        announced = true;
        await writer.write({
          type: "session_started",
          cwd: msg.cwd,
          model: msg.model,
          permissionMode,
          sessionMode: opts.mode,
          hostName: user.displayName,
          claudeSessionId: msg.session_id,
          resumed: opts.resume !== undefined,
        });
        await updateSessionRow(client, sessionId, {
          claude_session_id: msg.session_id,
          model: msg.model,
        });
        rl.prompt();
        continue;
      }
      const { events, delta } = adaptMessage(msg);
      if (delta) writer.sendDelta(delta.messageId, delta.lane, delta.text);
      for (const { event, blob } of events) {
        await writer.write(event, null, blob);
      }
      if (msg.type === "result") {
        await writer.write({ type: "status_change", status: "idle" });
        rl.prompt();
      }
    }
  } catch (err) {
    log.error({ err: String(err) }, "session runner crashed");
    await writer
      .write({
        type: "turn_result",
        durationMs: 0,
        isError: true,
        stopReason: "runner_error",
      })
      .catch(() => undefined);
  }
  await shutdown("ended");
}
