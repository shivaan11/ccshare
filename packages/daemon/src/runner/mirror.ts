import { closeSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { AssistantContentBlock, SessionEvent } from "@ccshare/protocol";
import type { SupabaseClient } from "@supabase/supabase-js";
import chokidar from "chokidar";
import { log } from "../log.js";
import {
  createSessionRow,
  endSessionRow,
  resolveUserContext,
  startHeartbeat,
  updateSessionRow,
} from "../state.js";
import { EventWriter, truncateValue } from "../transport.js";

// Mirror runner — DESIGN §5.4. Tails ~/.claude/projects/**/<uuid>.jsonl so live
// TUI sessions stream to the workspace read-only. Only files created while
// watching are mirrored (no backfill), and Claude sessions that already have a
// live shared ccshare session are skipped to avoid double-streaming.

type TranscriptLine = {
  type?: string;
  uuid?: string;
  sessionId?: string;
  cwd?: string;
  message?: { role?: string; model?: string; content?: unknown };
};

type MirrorSession = {
  sessionId: string;
  writer: EventWriter;
  offset: number;
  partialLine: string;
  titled: boolean;
  stopHeartbeat: () => void;
};

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b: { type?: string; text?: string }) =>
      b.type === "text" ? (b.text ?? "") : "",
    )
    .filter(Boolean)
    .join("\n");
}

export function transcriptLineToEvents(
  line: TranscriptLine,
  hostName: string,
): { event: SessionEvent; blob?: unknown }[] {
  const events: { event: SessionEvent; blob?: unknown }[] = [];
  const content = line.message?.content;

  if (line.type === "user") {
    const blocks = Array.isArray(content)
      ? (content as Record<string, unknown>[])
      : [];
    for (const block of blocks) {
      if (block.type !== "tool_result") continue;
      const raw = blockText(block.content);
      const { value, truncated } = truncateValue(raw);
      events.push({
        event: {
          type: "tool_result",
          toolUseId: String(block.tool_use_id),
          output: value,
          isError: block.is_error === true,
          truncated,
        },
        blob: truncated ? raw : undefined,
      });
    }
    const text = typeof content === "string" ? content : blockText(content);
    if (
      text.trim().length > 0 &&
      !blocks.some((b) => b.type === "tool_result")
    ) {
      events.push({
        event: {
          type: "user_message",
          text,
          authorName: hostName,
          via: "tui",
          attachments: [],
        },
      });
    }
  } else if (line.type === "assistant" && Array.isArray(content)) {
    const messageId = line.uuid ?? crypto.randomUUID();
    const rendered: AssistantContentBlock[] = [];
    for (const block of content as Record<string, unknown>[]) {
      if (block.type === "text" && typeof block.text === "string") {
        rendered.push({ type: "text", text: block.text });
      } else if (
        block.type === "thinking" &&
        typeof block.thinking === "string"
      ) {
        events.push({
          event: { type: "thinking", messageId, text: block.thinking },
        });
      } else if (block.type === "tool_use") {
        const { value, truncated } = truncateValue(block.input);
        rendered.push({
          type: "tool_use",
          toolUseId: String(block.id),
          toolName: String(block.name),
        });
        events.push({
          event: {
            type: "tool_use",
            toolUseId: String(block.id),
            toolName: String(block.name),
            input: value,
            truncated,
          },
          blob: truncated ? block.input : undefined,
        });
      }
    }
    if (rendered.length > 0) {
      events.push({
        event: {
          type: "assistant_message",
          messageId,
          content: rendered,
          model: line.message?.model,
        },
      });
    }
  }
  return events;
}

export async function runMirror(client: SupabaseClient): Promise<void> {
  const user = await resolveUserContext(client);
  const root = join(homedir(), ".claude", "projects");
  const sessions = new Map<string, MirrorSession>(); // by file path

  log.info({ root }, "mirroring new TUI sessions (read-only)");
  console.log(
    "\n  ccshare watch: new `claude` TUI sessions will stream read-only.",
  );
  console.log("  Ctrl-C stops mirroring (sessions are marked ended).\n");

  const watcher = chokidar.watch(root, {
    ignoreInitial: true,
    ignored: (path, stats) =>
      Boolean(stats?.isFile() && !path.endsWith(".jsonl")),
  });

  const pump = async (path: string): Promise<void> => {
    const session = sessions.get(path);
    if (!session) return;
    const size = statSync(path).size;
    if (size <= session.offset) return;
    const fd = openSync(path, "r");
    const buffer = Buffer.alloc(size - session.offset);
    readSync(fd, buffer, 0, buffer.length, session.offset);
    closeSync(fd);
    session.offset = size;

    const chunk = session.partialLine + buffer.toString("utf8");
    const lines = chunk.split("\n");
    session.partialLine = lines.pop() ?? "";

    for (const raw of lines) {
      if (!raw.trim()) continue;
      let line: TranscriptLine;
      try {
        line = JSON.parse(raw) as TranscriptLine;
      } catch {
        continue;
      }
      for (const { event, blob } of transcriptLineToEvents(
        line,
        user.displayName,
      )) {
        await session.writer.write(event, null, blob);
        if (!session.titled && event.type === "user_message") {
          session.titled = true;
          await updateSessionRow(client, session.sessionId, {
            title: event.text.slice(0, 80),
          });
        }
      }
    }
  };

  const register = async (path: string): Promise<void> => {
    const claudeSessionId = basename(path, ".jsonl");
    // Give a co-located shared session time to claim its claude_session_id,
    // then skip mirroring it (it is already streaming with full fidelity).
    await new Promise((r) => setTimeout(r, 3000));
    const { data: existing } = await client
      .from("sessions")
      .select("id")
      .eq("claude_session_id", claudeSessionId)
      .eq("status", "live")
      .limit(1);
    if (existing && existing.length > 0) return;

    let cwd = "unknown";
    const sessionId = await createSessionRow(client, {
      workspaceId: user.workspaceId,
      hostUserId: user.userId,
      kind: "mirror",
      mode: "moderated",
      cwd,
      claudeSessionId,
    });
    const session: MirrorSession = {
      sessionId,
      writer: new EventWriter(client, sessionId, 0),
      offset: 0,
      partialLine: "",
      titled: false,
      stopHeartbeat: startHeartbeat(client, sessionId),
    };
    sessions.set(path, session);
    await session.writer.write({
      type: "session_started",
      cwd,
      permissionMode: "default",
      sessionMode: "moderated",
      hostName: user.displayName,
      claudeSessionId,
      resumed: false,
    });
    log.info({ claudeSessionId }, "mirroring TUI session");
    await pump(path);
    // cwd arrives on the first transcript line; patch it in once known
    const firstLineCwd = async (): Promise<void> => {
      const { data } = await client
        .from("events")
        .select("payload")
        .eq("session_id", sessionId)
        .limit(1);
      const payload = data?.[0]?.payload as { cwd?: string } | undefined;
      if (payload?.cwd) {
        cwd = payload.cwd;
        await updateSessionRow(client, sessionId, { cwd });
      }
    };
    void firstLineCwd();
  };

  watcher.on(
    "add",
    (path) =>
      void register(path).catch((err) =>
        log.warn({ err: String(err) }, "mirror register failed"),
      ),
  );
  watcher.on(
    "change",
    (path) =>
      void pump(path).catch((err) =>
        log.warn({ err: String(err) }, "mirror pump failed"),
      ),
  );

  await new Promise<void>((resolve) => {
    const stop = async (): Promise<void> => {
      await watcher.close();
      for (const session of sessions.values()) {
        session.stopHeartbeat();
        await session.writer
          .write({ type: "session_ended", reason: "mirror_stopped" })
          .catch(() => undefined);
        await endSessionRow(client, session.sessionId);
        await session.writer.close();
      }
      resolve();
    };
    process.on("SIGINT", () => void stop());
    process.on("SIGTERM", () => void stop());
  });
}
