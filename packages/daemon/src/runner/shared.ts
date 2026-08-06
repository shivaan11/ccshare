import readline from "node:readline";
import {
  type PermissionResult,
  query,
  type PermissionMode as SDKPermissionMode,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { PermissionMode, SessionMode } from "@ccshare/protocol";
import type { SupabaseClient } from "@supabase/supabase-js";
import { config } from "../config.js";
import { ControlConsumer } from "../controls.js";
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
// SDK. Input arrives from the host's terminal AND from control_requests (both
// users' browsers); messages sent mid-turn queue and inject when the turn ends.

export type SharedRunnerOptions = {
  cwd: string;
  mode: SessionMode;
  model?: string;
  permissionMode?: PermissionMode;
  resume?: string;
};

type QueuedMessage = { text: string; authorId: string; authorName: string };

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

  console.log(`\n  ccshare session live: ${config.appUrl}/s/${sessionId}`);
  console.log(`  mode: ${opts.mode} · type to talk to Claude · Ctrl-C ends\n`);

  const input = new AsyncQueue<SDKUserMessage>();
  const pendingMessages: QueuedMessage[] = [];
  const pendingPermissions = new Map<
    string,
    (r: { allowed: boolean; by: string }) => void
  >();
  let turnInFlight = false;
  let titled = opts.resume !== undefined;
  let terminalPermission: ((allowed: boolean) => void) | null = null;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "› ",
  });

  const inject = async (msg: QueuedMessage): Promise<void> => {
    turnInFlight = true;
    await writer.write(
      {
        type: "user_message",
        text: msg.text,
        authorName: msg.authorName,
        via: msg.authorId === user.userId ? "tui" : "web",
        attachments: [],
      },
      msg.authorId,
    );
    await writer.write({ type: "status_change", status: "working" });
    input.push({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: `[${msg.authorName}]: ${msg.text}` }],
      },
      parent_tool_use_id: null,
      session_id: "",
      origin: { kind: "human" },
    } as SDKUserMessage);
    if (!titled) {
      titled = true;
      await updateSessionRow(client, sessionId, {
        title: msg.text.slice(0, 80),
      });
    }
  };

  const submit = async (msg: QueuedMessage): Promise<void> => {
    if (turnInFlight) {
      pendingMessages.push(msg);
      await writer.write({
        type: "control_note",
        note: "queued",
        controlId: crypto.randomUUID(),
        authorName: msg.authorName,
        text: msg.text.slice(0, 120),
      });
      return;
    }
    await inject(msg);
  };

  const releaseQueue = async (): Promise<void> => {
    turnInFlight = false;
    const next = pendingMessages.shift();
    if (next) await inject(next);
  };

  const resolvePermission = async (
    requestId: string,
    decision: "allow" | "deny",
    decidedByName: string,
  ): Promise<boolean> => {
    const resolver = pendingPermissions.get(requestId);
    if (!resolver) return false;
    pendingPermissions.delete(requestId);
    resolver({ allowed: decision === "allow", by: decidedByName });
    return true;
  };

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
      `\n  ⚠ permission: ${toolName} ${inputSummary}\n  allow? [y/N] (or answer in the web app) `,
    );

    const decision = await new Promise<{ allowed: boolean; by: string }>(
      (resolve) => {
        pendingPermissions.set(requestId, resolve);
        terminalPermission = (allowed) =>
          void resolvePermission(
            requestId,
            allowed ? "allow" : "deny",
            user.displayName,
          );
      },
    );
    terminalPermission = null;

    await writer.write({
      type: "permission_decision",
      requestId,
      decision: decision.allowed ? "allow" : "deny",
      decidedByName: decision.by,
    });
    await writer.write({ type: "status_change", status: "working" });
    rl.prompt();
    return decision.allowed
      ? { behavior: "allow", updatedInput: toolInput }
      : {
          behavior: "deny",
          message: `${decision.by} denied ${toolName} via ccshare`,
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

  const controls = new ControlConsumer(
    client,
    sessionId,
    user.userId,
    opts.mode,
    {
      sendMessage: (text, authorId, authorName) =>
        submit({ text, authorId, authorName }),
      interrupt: async () => {
        await q.interrupt().catch(() => undefined);
        await writer.write({ type: "status_change", status: "interrupted" });
        await releaseQueue();
      },
      permissionDecision: resolvePermission,
      setModel: async (model, byName) => {
        await q.setModel(model);
        await updateSessionRow(client, sessionId, { model });
        await writer.write({
          type: "settings_change",
          field: "model",
          value: model,
          changedByName: byName,
        });
      },
      setPermissionMode: async (mode, byName) => {
        await q.setPermissionMode(mode as SDKPermissionMode);
        await updateSessionRow(client, sessionId, { permission_mode: mode });
        await writer.write({
          type: "settings_change",
          field: "permission_mode",
          value: mode,
          changedByName: byName,
        });
      },
      setSessionMode: async (mode, byName) => {
        await updateSessionRow(client, sessionId, { mode });
        await writer.write({
          type: "settings_change",
          field: "session_mode",
          value: mode,
          changedByName: byName,
        });
      },
      noteQueued: async (controlId, authorName, text) => {
        await writer.write({
          type: "control_note",
          note: "queued",
          controlId,
          authorName,
          text: `${text.slice(0, 120)} (needs host approval)`,
        });
      },
    },
  );
  controls.start();

  rl.on("line", (line) => {
    const text = line.trim();
    if (terminalPermission) {
      terminalPermission(/^y(es)?$/i.test(text));
      return;
    }
    if (text.length === 0) {
      rl.prompt();
      return;
    }
    void submit({
      text,
      authorId: user.userId,
      authorName: user.displayName,
    }).catch((err) =>
      log.error({ err: String(err) }, "failed to send message"),
    );
  });

  let shuttingDown = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    rl.close();
    input.close();
    stopHeartbeat();
    await controls.stop();
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
        await releaseQueue();
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
