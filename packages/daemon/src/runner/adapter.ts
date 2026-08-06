import type {
  SDKAssistantMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
  SDKUserMessage,
  SDKUserMessageReplay,
} from "@anthropic-ai/claude-agent-sdk";
import type { AssistantContentBlock, SessionEvent } from "@ccshare/protocol";
import { truncateValue } from "../transport.js";

// The ONLY place that knows Anthropic message shapes (DESIGN §1.5, §5.2).
// Everything downstream speaks @ccshare/protocol events.

type ApiBlock = { type: string } & Record<string, unknown>;

export type AdaptedEvent = { event: SessionEvent; blob?: unknown };
export type AdaptedDelta = {
  messageId: string;
  lane: "text" | "thinking";
  text: string;
};

export function adaptAssistantMessage(
  msg: SDKAssistantMessage,
): AdaptedEvent[] {
  const events: AdaptedEvent[] = [];
  const blocks: AssistantContentBlock[] = [];
  const content = (msg.message.content ?? []) as unknown as ApiBlock[];

  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      blocks.push({ type: "text", text: block.text });
    } else if (
      block.type === "thinking" &&
      typeof block.thinking === "string"
    ) {
      events.push({
        event: { type: "thinking", messageId: msg.uuid, text: block.thinking },
      });
    } else if (block.type === "tool_use") {
      const toolUseId = String(block.id);
      const toolName = String(block.name);
      const { value, truncated } = truncateValue(block.input);
      blocks.push({ type: "tool_use", toolUseId, toolName });
      events.push({
        event: {
          type: "tool_use",
          toolUseId,
          toolName,
          input: value,
          truncated,
        },
        blob: truncated ? block.input : undefined,
      });
    }
  }

  if (blocks.length > 0) {
    events.push({
      event: {
        type: "assistant_message",
        messageId: msg.uuid,
        content: blocks,
        model: msg.message.model,
      },
    });
  }
  return events;
}

// User-role messages in the stream are tool results (we author real user
// messages ourselves at injection time and never re-emit the echo).
export function adaptUserMessage(
  msg: SDKUserMessage | SDKUserMessageReplay,
): AdaptedEvent[] {
  const events: AdaptedEvent[] = [];
  const content = msg.message.content;
  if (!Array.isArray(content)) return events;

  for (const block of content as unknown as ApiBlock[]) {
    if (block.type !== "tool_result") continue;
    const raw =
      typeof block.content === "string"
        ? block.content
        : Array.isArray(block.content)
          ? (block.content as ApiBlock[])
              .map((c) => (typeof c.text === "string" ? c.text : ""))
              .join("\n")
          : "";
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
  return events;
}

export function adaptResultMessage(msg: SDKResultMessage): AdaptedEvent {
  const usage =
    "usage" in msg && msg.usage
      ? {
          inputTokens: msg.usage.input_tokens,
          outputTokens: msg.usage.output_tokens,
          cacheReadTokens: msg.usage.cache_read_input_tokens ?? undefined,
          cacheCreationTokens:
            msg.usage.cache_creation_input_tokens ?? undefined,
        }
      : undefined;
  return {
    event: {
      type: "turn_result",
      durationMs: msg.duration_ms,
      usage,
      costUsd: "total_cost_usd" in msg ? msg.total_cost_usd : undefined,
      stopReason:
        msg.subtype === "success"
          ? (msg.stop_reason ?? undefined)
          : msg.subtype,
      isError: msg.is_error,
    },
  };
}

export function adaptPartial(
  msg: SDKPartialAssistantMessage,
): AdaptedDelta | null {
  const event = msg.event as ApiBlock;
  if (event.type !== "content_block_delta") return null;
  const delta = event.delta as ApiBlock | undefined;
  if (!delta) return null;
  if (delta.type === "text_delta" && typeof delta.text === "string") {
    return { messageId: msg.uuid, lane: "text", text: delta.text };
  }
  if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
    return { messageId: msg.uuid, lane: "thinking", text: delta.thinking };
  }
  return null;
}

export function adaptMessage(msg: SDKMessage): {
  events: AdaptedEvent[];
  delta?: AdaptedDelta;
} {
  switch (msg.type) {
    case "assistant":
      return { events: adaptAssistantMessage(msg) };
    case "user":
      return { events: adaptUserMessage(msg) };
    case "result":
      return { events: [adaptResultMessage(msg)] };
    case "stream_event": {
      const delta = adaptPartial(msg);
      return { events: [], ...(delta ? { delta } : {}) };
    }
    default:
      return { events: [] };
  }
}
