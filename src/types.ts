import type { ChromeClient } from "./chrome.js";

/**
 * Auth-holder Chrome session. Chrome stays alive for the lifetime of the
 * session so its cookie jar + TLS context are reused for every call.
 *
 * `httpRequest` evaluates `fetch(...)` *inside* Chrome and returns the
 * decoded response — this side-steps Cloudflare bot detection that fires
 * the moment a request comes from Node directly with a non-browser TLS
 * fingerprint.
 */
export interface RosettaSession {
  client: ChromeClient;
  meta: SessionMeta;
  httpRequest(input: HttpRequestInput): Promise<HttpResponse>;
  close(): Promise<void>;
}

export interface SessionMeta {
  /** Captured for record-keeping; Chrome adds it to outgoing requests itself. */
  userAgent: string;
  /** Value of `oai-did` cookie at session open. */
  deviceId: string;
  /** Token from /api/auth/session, kept for diagnostics + the soft-delete header. */
  accessToken: string;
  /** Unix ms when the access token expires. */
  expiresAt: number;
  /** Unix ms when the session was opened. */
  acquiredAt: number;
  /** CDP target id (for debugging). */
  targetId?: string;
  /** CDP debug port — needed so runConversation can spawn fresh tabs. */
  cdpPort: number;
  /** CDP debug host. */
  cdpHost: string;
}

export interface HttpRequestInput {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Absolute or path-only ("/backend-api/models"). */
  url: string;
  /** Header overrides; Chrome supplies cookies, UA, and sec-* automatically. */
  headers?: Record<string, string>;
  /** Stringified JSON or form body. */
  body?: string;
  /** Hint for response decoding. Default: "json". */
  responseType?: "json" | "text" | "stream";
  /** AbortSignal for cancellation. */
  signal?: AbortSignal;
  /** Per-request timeout (Chrome side). Defaults to 5 min. */
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  /** Parsed body when responseType is "json", raw text otherwise. */
  body: unknown;
  /** Response content-type header (lowercased). */
  contentType: string;
  /** Subset of response headers we expose; not all are reachable from fetch().headers. */
  headers: Record<string, string>;
}

export interface Attachment {
  /** Absolute or cwd-relative path to a local file (e.g. PNG, PDF, CSV). */
  path: string;
  /** Optional MIME-type override. Sniffed from extension if omitted. */
  mimeType?: string;
}

export interface RunConversationInput {
  prompt: string;
  /** ChatGPT server-side slug, e.g. "gpt-5-5-pro". */
  model: string;
  /** Existing conversation_id to continue; omit on first turn. */
  conversationId?: string;
  /** parent_message_id for multi-turn; falls back to "client-created-root" for the first turn. */
  parentMessageId?: string;
  /** AbortSignal so the harness can cancel runs. */
  signal?: AbortSignal;
  /**
   * Recall persisted thread state — load the last (conversationId,
   * parentMessageId) for this thread and thread the new turn into the same
   * server-side conversation. `true` uses the "default" thread; a string
   * names a specific thread. When recall is in use, the conversation is NOT
   * auto-soft-deleted; instead the new (conversationId, messageId) is
   * persisted for the next call.
   */
  recall?: boolean | string;
  /**
   * Local files to attach to this prompt. Uploaded to ChatGPT before the
   * prompt is typed, same UX as drag-dropping a file in the web composer.
   * Sequential per-call: each file is fed in order, attachment must confirm
   * ready before the next one starts. Per-file size cap: 20 MB.
   */
  attachments?: Attachment[];
}

export interface RunConversationResult {
  text: string;
  conversationId: string;
  messageId: string;
  /** Server-reported model slug (may differ from input.model when ChatGPT downgrades). */
  modelSlug?: string;
  finishReason?: string;
  tookMs: number;
  /** Raw aggregated event count, for debugging. */
  eventCount: number;
}

/** Discriminated union of relevant SSE event payloads. */
export type SseEvent =
  | { kind: "message"; payload: SseMessageFrame }
  | { kind: "patch"; payload: SsePatchFrame }
  | { kind: "moderation"; payload: unknown }
  | { kind: "tool"; payload: unknown }
  | { kind: "unknown"; raw: unknown };

export interface SseMessageFrame {
  message?: {
    id?: string;
    author?: { role?: string };
    content?: { content_type?: string; parts?: unknown[] };
    metadata?: {
      model_slug?: string;
      finish_details?: { type?: string; stop_tokens?: unknown[] };
      [key: string]: unknown;
    };
    status?: string;
    end_turn?: boolean;
  };
  conversation_id?: string;
  error?: unknown;
}

export interface SsePatchFrame {
  v?: unknown;
  o?: string;
  p?: string;
  /** Newer `data: {"v":"..."}` raw-string deltas. */
  c?: string;
}

export interface ModelsResponse {
  models?: Array<{
    slug: string;
    title?: string;
    description?: string;
    tags?: string[];
    capabilities?: Record<string, unknown>;
  }>;
  categories?: unknown;
}
