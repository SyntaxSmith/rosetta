import type { RunConversationResult } from "./types.js";

/**
 * Iterates over `data: <json>` records from a ChatGPT SSE stream.
 *
 * The /backend-api/conversation endpoint emits one of:
 *   - `data: <json>\n\n`            normal frame
 *   - `data: [DONE]\n\n`             terminator (yields nothing, ends iterator)
 *   - `: ping\n\n`                   keepalive (skipped)
 *   - blank lines between events
 *
 * Implemented as an async generator so callers can `for await ... of`
 * without buffering the entire stream.
 *
 * Tolerates malformed JSON by yielding it as a `string` rather than throwing —
 * the aggregator decides how to handle that.
 */
export async function* parseConversationSse(
  body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
): AsyncIterable<unknown> {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of asAsyncIterable(body)) {
    buffer += decoder.decode(chunk, { stream: true });
    let nlIndex: number;
    while ((nlIndex = buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = buffer.slice(0, nlIndex);
      buffer = buffer.slice(nlIndex + 2);
      const dataLine = extractDataLine(rawEvent);
      if (!dataLine) continue;
      if (dataLine === "[DONE]") return;
      try {
        yield JSON.parse(dataLine);
      } catch {
        yield dataLine;
      }
    }
  }
  // Drain any final event without trailing CRLF.
  buffer += decoder.decode();
  const tail = extractDataLine(buffer);
  if (tail && tail !== "[DONE]") {
    try {
      yield JSON.parse(tail);
    } catch {
      yield tail;
    }
  }
}

function asAsyncIterable<T>(
  value: ReadableStream<T> | AsyncIterable<T>,
): AsyncIterable<T> {
  if (Symbol.asyncIterator in value) return value as AsyncIterable<T>;
  // Fallback for environments where ReadableStream isn't async-iterable.
  const reader = (value as ReadableStream<T>).getReader();
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          const { value: v, done } = await reader.read();
          return { value: v as T, done };
        },
      };
    },
  };
}

function extractDataLine(rawEvent: string): string | null {
  const trimmed = rawEvent.trim();
  if (!trimmed) return null;
  // Comment / keepalive — `:` prefix per SSE spec.
  if (trimmed.startsWith(":")) return null;
  // ChatGPT only emits `data:` lines today, but handle multi-line just in case.
  const dataLines = trimmed
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());
  if (dataLines.length === 0) return null;
  return dataLines.join("\n");
}

interface AggregatorState {
  conversationId?: string;
  messageId?: string;
  modelSlug?: string;
  finishReason?: string;
  fullText: string;
  eventCount: number;
}

/**
 * Reduces an SSE event stream to a single ChatGPT assistant message.
 *
 * Handles two stream flavors observed across 2024-2026 ChatGPT versions:
 *
 * 1. **Cumulative-message frames** — `{message:{id, content:{parts:[<text>]}, metadata:{...}}, conversation_id}`
 *    where `parts[0]` is the *full text so far*. We take the last such frame as authoritative.
 *
 * 2. **JSON-patch frames** — `{v:<value>, p:<path>, o:<op>}` for incremental updates.
 *    - `o === "append" | "a"` and `p === "/message/content/parts/0"` → append `v` to the text buffer.
 *    - `o === "replace" | "r"`                                       → replace text buffer.
 *    - bootstrap frame `{v:{message:{...}, conversation_id}}`        → seed state.
 *    - batch frame      `{v:[<patch>, <patch>, ...]}`                → apply each patch in sequence.
 *
 * Tool-call / moderation / `gizmo_interpreter` frames are skipped silently.
 */
export async function aggregateAssistantMessage(
  events: AsyncIterable<unknown>,
  startedAtMs: number = Date.now(),
): Promise<RunConversationResult> {
  const state: AggregatorState = { fullText: "", eventCount: 0 };

  for await (const event of events) {
    state.eventCount += 1;
    if (typeof event !== "object" || event === null) continue;
    applyEvent(event as Record<string, unknown>, state);
  }

  return {
    text: state.fullText,
    conversationId: state.conversationId ?? "",
    messageId: state.messageId ?? "",
    modelSlug: state.modelSlug,
    finishReason: state.finishReason,
    tookMs: Date.now() - startedAtMs,
    eventCount: state.eventCount,
  };
}

function applyEvent(event: Record<string, unknown>, state: AggregatorState): void {
  // Conversation id can show up at the top level on either flavor.
  if (typeof event.conversation_id === "string") state.conversationId = event.conversation_id;

  // Flavor 1: full message frame.
  if (event.message && typeof event.message === "object") {
    captureFromMessage(event.message as Record<string, unknown>, state);
    return;
  }

  // Flavor 2: patch frames use `v` (value), optional `p` (path), optional `o` (op).
  if ("v" in event) {
    applyPatchFrame(event, state);
    return;
  }
  // Some moderation / safety frames have no `v` and no `message`; ignore.
}

function applyPatchFrame(frame: Record<string, unknown>, state: AggregatorState): void {
  const { v, p, o } = frame as { v: unknown; p?: unknown; o?: unknown };

  // Bootstrap: `{v: {message, conversation_id}}` — seed state from inner
  // shape. The path may be `undefined` (instant SSE) or empty string `""`
  // with `o: "add"` (Pro WS frames), both meaning "add at root".
  const rootPath = p === undefined || p === "";
  if (typeof v === "object" && v !== null && !Array.isArray(v) && rootPath) {
    const inner = v as Record<string, unknown>;
    if (typeof inner.conversation_id === "string") state.conversationId = inner.conversation_id;
    if (inner.message && typeof inner.message === "object") {
      captureFromMessage(inner.message as Record<string, unknown>, state);
    }
    return;
  }

  // Batched patches: `{v: [<patch1>, <patch2>, ...]}` — same root semantics.
  if (Array.isArray(v) && rootPath) {
    for (const sub of v) {
      if (typeof sub === "object" && sub !== null) {
        applyPatchFrame(sub as Record<string, unknown>, state);
      }
    }
    return;
  }

  // String append on the text path.
  if (typeof v === "string") {
    const path = typeof p === "string" ? p : "";
    const op = typeof o === "string" ? o : "append";
    if (
      path === "" ||
      path === "/message/content/parts/0" ||
      path === "/message/content/parts/0/text"
    ) {
      if (op === "replace" || op === "r") {
        state.fullText = v;
      } else {
        // Default: append (matches `o: "append"` and the no-op shorthand `{v: "..."}`).
        state.fullText += v;
      }
      return;
    }
    if (path === "/message/status") {
      state.finishReason = v;
      return;
    }
    if (path === "/message/metadata/finish_details/type") {
      state.finishReason = v;
      return;
    }
    if (path === "/message/metadata/model_slug") {
      state.modelSlug = v;
      return;
    }
    // Unknown path — ignore.
    return;
  }

  // Object replace on a path (e.g., metadata block).
  if (typeof v === "object" && v !== null && typeof p === "string") {
    if (p === "/message/metadata") {
      const meta = v as Record<string, unknown>;
      if (typeof meta.model_slug === "string") state.modelSlug = meta.model_slug;
      const fd = meta.finish_details as Record<string, unknown> | undefined;
      if (fd && typeof fd.type === "string") state.finishReason = fd.type;
    }
  }
}

function captureFromMessage(
  message: Record<string, unknown>,
  state: AggregatorState,
): void {
  // Only mirror assistant messages into fullText / messageId. The Pro WS
  // stream interleaves tool ("Reasoning…") and system messages, all carrying
  // empty parts[0] — overwriting unconditionally would erase the assistant's
  // text every time a later tool/system frame lands. When `author.role` is
  // missing entirely (legacy / simplified frames) we treat the message as
  // assistant for backwards compat.
  const author = message.author as { role?: string } | undefined;
  const role = author?.role;
  const isAssistant = role === undefined || role === "assistant";

  if (isAssistant && typeof message.id === "string") state.messageId = message.id;
  if (isAssistant) {
    const content = message.content as Record<string, unknown> | undefined;
    if (content) {
      const parts = content.parts;
      if (Array.isArray(parts) && parts.length > 0 && typeof parts[0] === "string") {
        // Only replace fullText if the new value isn't empty — Pro replays
        // the same assistant message twice (first with text="" carrying the
        // end_turn flag, then with the actual answer); without this guard
        // the second-to-last frame can clobber the real text.
        const candidate = parts[0];
        if (candidate.length > 0 || state.fullText.length === 0) {
          state.fullText = candidate;
        }
      }
    }
  }

  const metadata = message.metadata as Record<string, unknown> | undefined;
  if (metadata) {
    if (typeof metadata.model_slug === "string") state.modelSlug = metadata.model_slug;
    const fd = metadata.finish_details as Record<string, unknown> | undefined;
    if (fd && typeof fd.type === "string") state.finishReason = fd.type;
  }
  if (
    isAssistant &&
    typeof message.status === "string" &&
    (!state.finishReason || state.finishReason === "in_progress")
  ) {
    state.finishReason = message.status;
  }
}
