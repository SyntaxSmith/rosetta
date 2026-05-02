import { Buffer } from "node:buffer";
import CDP from "chrome-remote-interface";
import type { ChromeClient } from "./chrome.js";
import {
  aggregateAssistantMessage,
  parseConversationSse,
} from "./sse.js";
import { loadThread, resolveThreadName, saveThread } from "./state.js";
import type {
  RunConversationInput,
  RunConversationResult,
  RosettaSession,
  HttpResponse,
  ModelsResponse,
} from "./types.js";
import { appendFileSync as __dbgAppend, openSync as __dbgOpen, writeSync as __dbgWrite } from "node:fs";
import { attachFiles } from "./upload.js";

const DBG = !!process.env["ROSETTA_DEBUG"];
const DBG_LOG = process.env["ROSETTA_DEBUG_LOG"];
// Sentinel — fires unconditionally when DBG_LOG is set so we can prove
// src/client.ts (vs dist/) is the loaded module. ESM-safe (uses imported fs).
if (DBG_LOG) {
  try {
    __dbgAppend(
      DBG_LOG,
      `[rosetta-debug ${new Date().toISOString().slice(11, 23)} pid=${process.pid}] MODULE-INIT src/client.ts loaded (DBG=${DBG})\n`,
    );
  } catch { /* swallow */ }
}
let _dbgFd: number | undefined;
const dbg = (label: string, extra?: unknown): void => {
  if (!DBG) return;
  const ts = new Date().toISOString().slice(11, 23);
  let line: string;
  if (extra === undefined) {
    line = `[rosetta-debug ${ts} pid=${process.pid}] ${label}\n`;
  } else {
    let s: string;
    try { s = typeof extra === "string" ? extra : JSON.stringify(extra); }
    catch { s = String(extra); }
    line = `[rosetta-debug ${ts} pid=${process.pid}] ${label} ${s}\n`;
  }
  process.stderr.write(line);
  if (DBG_LOG) {
    try {
      if (_dbgFd === undefined) _dbgFd = __dbgOpen(DBG_LOG, "a");
      __dbgWrite(_dbgFd, line);
    } catch { /* swallow */ }
  }
};

export class RosettaRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly bodySnippet?: string,
    public readonly code:
      | "auth"
      | "arkose"
      | "proof-of-work"
      | "rate-limit"
      | "cloudflare"
      | "server"
      | "sdk-missing"
      | "trigger-failed"
      | "unknown" = "unknown",
  ) {
    super(message);
    this.name = "RosettaRequestError";
  }
}

export interface RunConversationOptions {
  refreshSession?: () => Promise<RosettaSession>;
  /**
   * Hard wall-clock cap as a safety net. The call rejects if it has run this
   * long even when frames are still arriving — protects against a runaway
   * server pushing heartbeats forever. Defaults to 60 minutes (well past any
   * realistic Pro CoT). Set to 0 to disable.
   */
  timeoutMs?: number;
  /**
   * Idle gap allowed between consecutive frames (heartbeat OR stream-item).
   * The Pro WS server emits heartbeats every few seconds during CoT, so any
   * silence longer than this means the connection is genuinely stuck and we
   * can give up. Defaults to 90 seconds — that's ~30× the observed
   * heartbeat cadence, which is plenty of headroom for transient network
   * blips while still catching real failures fast. Set to 0 to disable
   * idle-timeout enforcement.
   */
  idleTimeoutMs?: number;
  /** Override of the placeholder character we type into the composer to trigger a send. */
  triggerChar?: string;
  /**
   * Live token-delta callback. Fires every time the assistant's accumulated
   * text grows during streaming, with just the newly-appended chunk. Useful
   * for rendering CoT progress in real time. The full text is also returned
   * in `RunConversationResult.text` at the end.
   */
  onChunk?: (delta: string) => void;
  /**
   * If true, do NOT soft-delete the conversation after the run. Use this on
   * intermediate turns of a multi-turn exchange — without it, deleting turn 1's
   * conversation makes ChatGPT redirect away from `/c/<id>` and turn 2's send
   * generates a body for a fresh chat, which our intercept then mis-rewrites.
   * Caller is responsible for cleaning up the final conversation.
   *
   * Defaults to true when `input.conversationId` is set (i.e. caller is doing
   * multi-turn and isn't on the last turn yet — they'll re-pass conversationId
   * to the next call), and false otherwise.
   */
  keepConversation?: boolean;
}

const DEFAULT_TIMEOUT_MS = 60 * 60_000;
const DEFAULT_IDLE_TIMEOUT_MS = 90_000;

/**
 * Sends a single message through ChatGPT's `/backend-api/f/conversation`
 * pipeline, using the auth-holder Chrome page as a "header generator":
 *
 *   1. We listen for the page's outgoing `/f/conversation` request via CDP
 *      `Fetch.requestPaused`. The page produces all of: `Authorization`,
 *      `X-OAI-IS`, `OAI-Client-Build-Number`/`-Version`/`-Device-Id`/
 *      `-Session-Id`/`-Language`, and the three single-use `OpenAI-Sentinel-*`
 *      tokens. They cannot be replayed and we cannot regenerate them in Node
 *      (proof-of-work + Turnstile + a server-known A256GCM key are involved).
 *
 *   2. We trigger that outgoing request synthetically by typing one character
 *      into the composer and dispatching Enter via `Input.dispatchKeyEvent`.
 *
 *   3. At the Request stage we swap `messages[0].content.parts` for the
 *      caller's prompt (and reset `conversation_id` / `parent_message_id`
 *      unless the caller passed multi-turn ids). The page never sees our
 *      placeholder character because the request body is rewritten before it
 *      hits the wire.
 *
 *   4. At the Response stage we `Fetch.takeResponseBodyAsStream` and stream
 *      the SSE bytes through `parseConversationSse` + `aggregateAssistantMessage`.
 *
 * That is, we own *what* gets asked, the page owns *the credential proofs*,
 * and ChatGPT serves the response. The composer placeholder is invisible to
 * the user/ChatGPT because the rewritten body never includes it.
 */
export async function runConversation(
  session: RosettaSession,
  input: RunConversationInput,
  options: RunConversationOptions = {},
): Promise<RunConversationResult> {
  // Recall: if the caller asked to thread into a persistent named context,
  // load the last (conversationId, messageId) from disk and merge them into
  // the input *before* we hand off to the in-tab pipeline. We also force
  // keepConversation=true so the soft-delete at end-of-call doesn't sever
  // the thread for future recalls.
  const threadName = resolveThreadName(input.recall);
  let effectiveInput = input;
  let effectiveOptions = options;
  if (threadName) {
    const persisted = loadThread(threadName);
    if (persisted) {
      effectiveInput = {
        ...input,
        conversationId: input.conversationId ?? persisted.conversationId,
        parentMessageId: input.parentMessageId ?? persisted.messageId,
      };
    }
    effectiveOptions = { ...options, keepConversation: true };
  }

  // Each call runs in its own freshly-created tab so concurrent calls don't
  // race on Fetch.requestPaused (Fetch.enable patterns are per-CDP-target).
  // Multi-turn turns share state via the conversationId, not via tab reuse.
  const result = await withFreshTab(session, async (tabClient) => {
    return await runConversationInTab(session, tabClient, effectiveInput, effectiveOptions);
  });

  if (threadName && result.conversationId && result.messageId) {
    saveThread(threadName, {
      conversationId: result.conversationId,
      messageId: result.messageId,
      model: result.modelSlug,
      updatedAt: Date.now(),
    });
  }

  return result;
}

async function runConversationInTab(
  session: RosettaSession,
  client: ChromeClient,
  input: RunConversationInput,
  options: RunConversationOptions,
): Promise<RunConversationResult> {
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const { Fetch, Runtime, Network, Page } = client;
  void options.triggerChar; // legacy: kept for backwards compat, no longer used

  await Page.enable();
  await Runtime.enable();
  await Network.enable({});
  // Start every turn on a fresh ChatGPT root so the composer is empty and the
  // page isn't auto-attaching to a previous conversation_id. Skipped when the
  // caller explicitly threads a conversation (multi-turn case) — for a fresh
  // tab we still need to navigate to the conversation URL so the page is on
  // the right state.
  dbg("runConversationInTab enter", {
    convId: input.conversationId, parentMsgId: input.parentMessageId,
    model: input.model, promptLen: input.prompt.length,
    hasAttachments: !!input.attachments?.length,
  });
  if (input.conversationId) {
    dbg("Page.navigate /c/<id> begin");
    const navStart = Date.now();
    await Page.navigate({
      url: `https://chatgpt.com/c/${encodeURIComponent(input.conversationId)}`,
    });
    dbg("Page.navigate /c/<id> done", { navMs: Date.now() - navStart });
    const wlStart = Date.now();
    await waitForLoad(Page);
    dbg("waitForLoad done", { waitMs: Date.now() - wlStart });
  } else {
    dbg("navigateToFreshChat begin");
    const fcStart = Date.now();
    await navigateToFreshChat(client);
    dbg("navigateToFreshChat done", { ms: Date.now() - fcStart });
  }
  // Only intercept at the Request stage — we let the response flow back to
  // the page naturally so React's send-action state machine actually
  // observes the SSE stream and clears itself. We capture our own copy via
  // Network.responseReceived + Network.getResponseBody after loadingFinished;
  // it's not live-streamed but it lets the page recover for the next turn.
  //
  // We intercept two URLs:
  //   - `/backend-api/f/conversation`         — the actual send (rewrite + claim)
  //   - `/backend-api/f/conversation/prepare` — pre-flight; pass through but
  //     use it as a "send pipeline already started" signal so we don't
  //     prematurely redo a click that's just slow.
  await Fetch.enable({
    patterns: [
      { urlPattern: "*/backend-api/f/conversation", requestStage: "Request" },
      { urlPattern: "*/backend-api/f/conversation/prepare", requestStage: "Request" },
    ],
  });
  dbg("Fetch.enable done (patterns: f/conversation + f/conversation/prepare)");

  let resolveResult: (r: RunConversationResult) => void;
  let rejectResult: (e: unknown) => void;
  // `completionSettled` mirrors the completion promise's state for the wait
  // loop. The wait loop only checks `claimed`, so without this an early
  // `rejectResult(err)` (e.g. `onPaused` threw because the page-issued body
  // was empty or unparseable) gets queued silently — the loop keeps spinning
  // until SEND_MAX_TOTAL_WAIT_MS, then throws the generic "stuck pipeline"
  // error and the real cause is lost. With this flag the loop exits as
  // soon as completion settles, and the subsequent `await completion`
  // surfaces the actual error or result.
  let completionSettled = false;
  const completion = new Promise<RunConversationResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  completion.then(
    () => { completionSettled = true; },
    () => { completionSettled = true; },
  );

  // Fetch.requestPaused requestIds and Network.* requestIds are NOT the same
  // namespace. We instead track the request by URL match: only one
  // /f/conversation flies per run, so the Network event for it is whichever
  // one fires after our Fetch.continueRequest.
  let claimed = false;
  // `prepareSeen` flips when ChatGPT issues `/f/conversation/prepare` — that
  // request reliably fires within 1–3 s of a successful click, well before
  // `/f/conversation` itself (which can take 15+ s on multi-turn Pro with
  // attachments). It's our "click landed, send pipeline started" signal —
  // but on its own it does NOT rule out a swallowed send. The 7b54098 bug
  // (multi-turn recall) is precisely "prepare fires, /f/conversation never
  // does". We pair `prepareSeen` with a bounded grace (`PREPARE_GRACE_MS`)
  // and the Stop-button probe so we can still redo after a stale prepare.
  let prepareSeen = false;
  let prepareSeenAt: number | undefined;
  let networkRequestId: string | undefined;
  let observedStatus: number | undefined;
  let observedContentType = "";

  const onNetworkRequestWillBeSent = (e: {
    requestId: string;
    request: { url: string };
  }) => {
    if (DBG && (e.request.url.includes("/backend-api/") || e.request.url.includes("ws.chatgpt.com"))) {
      dbg("Network.requestWillBeSent", { id: e.requestId, claimed, url: e.request.url });
    }
    if (!claimed) return;
    if (networkRequestId) return;
    if (e.request.url.endsWith("/backend-api/f/conversation")) {
      networkRequestId = e.requestId;
      dbg("networkRequestId bound", { id: e.requestId });
    }
  };

  const onPaused = async (event: {
    requestId: string;
    request: { url: string; postData?: string; headers: Record<string, string> };
  }) => {
    dbg("Fetch.requestPaused", { url: event.request.url, claimed, hasBody: !!event.request.postData });
    try {
      // Prepare is observation-only: pass through unmodified, just record
      // that the send pipeline has started. This deliberately matches before
      // the `/f/conversation` branch because the URL ends with `/prepare`
      // (suffix-distinguishable) — but `endsWith("/conversation")` would
      // wrongly match `/prepare` too if we're not careful, so we test
      // prepare first.
      if (event.request.url.endsWith("/backend-api/f/conversation/prepare")) {
        if (!prepareSeen) {
          prepareSeen = true;
          prepareSeenAt = Date.now();
          dbg("prepare observed — send pipeline started");
        }
        await Fetch.continueRequest({ requestId: event.requestId });
        return;
      }
      if (!event.request.url.endsWith("/backend-api/f/conversation")) {
        await Fetch.continueRequest({ requestId: event.requestId });
        return;
      }
      if (claimed) {
        await Fetch.continueRequest({ requestId: event.requestId });
        return;
      }
      if (!event.request.postData) {
        throw new RosettaRequestError(
          "Page-issued /f/conversation has no body to rewrite",
          0,
          undefined,
          "trigger-failed",
        );
      }
      const body = JSON.parse(event.request.postData) as Record<string, unknown>;
      rewriteBody(body, input);
      const newBody = JSON.stringify(body);
      const safeHeaders = Object.entries(event.request.headers)
        .filter(([k]) => k.toLowerCase() !== "content-length")
        .map(([name, value]) => ({ name, value }));
      claimed = true;
      await Fetch.continueRequest({
        requestId: event.requestId,
        postData: Buffer.from(newBody, "utf8").toString("base64"),
        headers: safeHeaders,
      });
    } catch (err) {
      rejectResult(err);
    }
  };

  const onResponseReceived = (e: {
    requestId: string;
    response: { status: number; mimeType?: string };
  }) => {
    if (e.requestId !== networkRequestId) return;
    observedStatus = e.response.status;
    observedContentType = e.response.mimeType || "";
    dbg("Network.responseReceived", { status: observedStatus, ct: observedContentType });
  };
  const onLoadingFinished = async (e: { requestId: string }) => {
    if (e.requestId !== networkRequestId) return;
    try {
      const r = await Network.getResponseBody({ requestId: e.requestId });
      const text = r.base64Encoded
        ? Buffer.from(r.body, "base64").toString("utf8")
        : r.body;
      const status = observedStatus ?? 0;
      if (status < 200 || status >= 300) {
        rejectResult(
          classifyError(
            status,
            text.slice(0, 400),
            Object.entries({ "content-type": observedContentType }).map(
              ([name, value]) => ({ name, value }),
            ),
          ),
        );
        return;
      }
      const handoff = extractStreamHandoff(text);
      if (handoff) {
        const result = await streamSecondLeg(
          client,
          session,
          text,
          handoff,
          startedAt,
          input.signal,
          idleTimeoutMs,
          options.onChunk,
        );
        resolveResult(result);
        return;
      }
      // Instant path: bootstrap *is* the full response. We still want
      // onChunk to fire if the caller asked for streaming — the bootstrap
      // contains all the patch deltas in order, so route through the same
      // aggregator wrapper.
      if (options.onChunk) {
        const dummyQueue = new ChunkQueue();
        dummyQueue.push(new TextEncoder().encode(text));
        dummyQueue.end();
        const events = parseConversationSse(dummyQueue);
        const result = await aggregateUntilFinished(events, startedAt, dummyQueue, options.onChunk);
        resolveResult(result);
        return;
      }
      const events = parseConversationSse(stringStream(text));
      const result = await aggregateAssistantMessage(events, startedAt);
      resolveResult(result);
    } catch (err) {
      rejectResult(err);
    }
  };
  const onLoadingFailed = (e: { requestId: string; errorText: string }) => {
    if (e.requestId !== networkRequestId) return;
    dbg("Network.loadingFailed", { err: e.errorText });
    rejectResult(
      new RosettaRequestError(
        `Network loading failed: ${e.errorText}`,
        observedStatus ?? 0,
        undefined,
        "server",
      ),
    );
  };

  // chrome-remote-interface event subscriptions return unsubscribe functions.
  // Without explicit cleanup, stale handlers from earlier runConversation
  // calls accumulate and race the active one.
  const unsubscribers: Array<() => void> = [
    Fetch.requestPaused(onPaused) as unknown as () => void,
    Network.requestWillBeSent(onNetworkRequestWillBeSent) as unknown as () => void,
    Network.responseReceived(onResponseReceived) as unknown as () => void,
    Network.loadingFinished(onLoadingFinished) as unknown as () => void,
    Network.loadingFailed(onLoadingFailed) as unknown as () => void,
  ];

  let timeoutHandle: NodeJS.Timeout | undefined;
  if (timeoutMs > 0) {
    timeoutHandle = setTimeout(() => {
      rejectResult(
        new RosettaRequestError(
          `runConversation hit wall-clock timeout after ${Math.round(timeoutMs / 1000)} s. ` +
            `This is the safety cap; CoT progress is gated by idleTimeoutMs (${idleTimeoutMs} ms).`,
          0,
          undefined,
          "trigger-failed",
        ),
      );
    }, timeoutMs);
  }

  try {
    if (input.attachments && input.attachments.length > 0) {
      // Files first, then prompt. Each attachment is fed into the page's
      // hidden file input via DataTransfer; we wait for the chip to render
      // before moving on. Sequential — ChatGPT's React pipeline assigns each
      // change event its own slot. See src/upload.ts.
      await attachFiles(client.Runtime, input.attachments);
    }
    dbg("driveComposerSend begin");
    const dcsStart = Date.now();
    await driveComposerSend(client, input.prompt);
    dbg("driveComposerSend done", { ms: Date.now() - dcsStart });

    // Wait for the page to actually issue /backend-api/f/conversation —
    // detected by `claimed` flipping when our Fetch.requestPaused fires.
    //
    // Two failure modes we have to handle:
    //   A. "Slow but legitimate": ChatGPT's send pipeline interleaves
    //      /conversation/init, /f/conversation/prepare, /sentinel/chat-
    //      requirements, autocompletions, analytics; click-to-
    //      /f/conversation is commonly 15-25 s and can hit 30 s+ with
    //      attachments. Button is in Stop state throughout.
    //   B. "Swallowed click" (multi-turn recall, original 7b54098 bug):
    //      click registers visually, /f/conversation/prepare fires, but
    //      /f/conversation NEVER does. Composer clears, button flips to
    //      Stop briefly then back to Send-but-disabled. No UI banner, no
    //      auto-retry server-side.
    //
    // The 4eddae9 attempt to gate redos on `prepareSeen` failed for case
    // (B): prepareSeen is true in BOTH cases, so trusting it as "pipeline
    // in flight" forever means we never redo a swallowed click. The fix:
    //   - Bound the post-prepare wait to PREPARE_GRACE_MS (35 s). Past
    //     that, the prepare is stale enough that case (B) is the
    //     overwhelmingly likely explanation.
    //   - Gate redos on a Stop-button probe (only Stop indicates case A).
    //     Send-disabled is exactly the case (B) signature, not a reason to
    //     keep waiting.
    //   - Reset prepareSeen on each redo so the grace clock restarts.
    const SEND_BASE_WAIT_MS = 25_000;          // grace before redo when no prepare seen yet
    const PREPARE_GRACE_MS = 35_000;           // grace after prepareSeen for /f/conversation to follow
    const SEND_MAX_TOTAL_WAIT_MS = 120_000;
    const SEND_REDO_LIMIT = 2;
    const PROBE_INTERVAL_MS = 2_500;
    const sendWaitStart = Date.now();
    let redoCount = 0;
    let lastProbeAt = 0;
    while (!claimed && !completionSettled) {
      if (Date.now() - sendWaitStart >= SEND_MAX_TOTAL_WAIT_MS) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
      if (claimed || completionSettled) break;

      // Should we even consider a redo yet?
      let consider = false;
      if (prepareSeen && prepareSeenAt !== undefined) {
        if (Date.now() - prepareSeenAt > PREPARE_GRACE_MS) consider = true;
      } else {
        if (Date.now() - sendWaitStart > SEND_BASE_WAIT_MS) consider = true;
      }
      if (!consider) continue;

      // Throttle the Stop-button probe; the inner sleep already polls
      // `claimed` cheaply.
      if (Date.now() - lastProbeAt < PROBE_INTERVAL_MS) continue;
      lastProbeAt = Date.now();
      const stopVisible = await isStopButtonVisible(client);
      if (stopVisible) {
        dbg("stop-button visible — pipeline genuinely in flight, keep waiting", {
          prepareSeen,
          waitedMs: Date.now() - sendWaitStart,
        });
        continue;
      }

      if (redoCount >= SEND_REDO_LIMIT) {
        dbg("redo limit reached — giving up", {
          prepareSeen,
          redoCount,
          waitedMs: Date.now() - sendWaitStart,
        });
        break;
      }
      redoCount++;
      dbg("send appears swallowed — retyping", {
        prepareSeen,
        sincePrepareMs: prepareSeenAt ? Date.now() - prepareSeenAt : null,
        redoCount,
      });
      // Reset so the next attempt's prepare resets the grace clock.
      prepareSeen = false;
      prepareSeenAt = undefined;
      await driveComposerSend(client, input.prompt);
    }
    if (!claimed && !completionSettled) {
      dbg("send still not claimed after wait — aborting", {
        prepareSeen,
        redoCount,
        waitedMs: Date.now() - sendWaitStart,
      });
      throw new RosettaRequestError(
        `Send button click was registered but ChatGPT never issued /backend-api/f/conversation within ${Math.round(SEND_MAX_TOTAL_WAIT_MS / 1000)} s ` +
          `(prepareSeen=${prepareSeen}, redos=${redoCount}). ` +
          `This usually indicates a stuck send pipeline.`,
        0,
        undefined,
        "trigger-failed",
      );
    }

    dbg("await completion (waiting for /backend-api/f/conversation response)");
    const result = await completion;
    dbg("completion resolved", { convId: result.conversationId, msgId: result.messageId, finish: result.finishReason });
    const shouldKeep =
      options.keepConversation ?? Boolean(input.conversationId);
    if (!shouldKeep && result.conversationId) {
      // Soft-delete the conversation we just created so the user's chat
      // history isn't polluted with our placeholder character + answer.
      await deleteConversation(session, result.conversationId).catch(() => undefined);
    }
    return result;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    for (const unsub of unsubscribers) {
      try {
        unsub();
      } catch {
        // ignore
      }
    }
    await Fetch.disable().catch(() => undefined);
  }
}

async function navigateToFreshChat(client: RosettaSession["client"]): Promise<void> {
  const { Page, Runtime } = client;
  // First navigate to root in case we're sitting on a /c/<id> page from a
  // prior turn — Page.reload alone would just re-render that conversation.
  // The cache-bust query forces a real navigation rather than a same-route
  // SPA soft transition, then ignoreCache reload tears down the SPA state.
  await Page.navigate({ url: `https://chatgpt.com/?t=${Date.now()}` });
  await waitForLoad(Page);
  await Page.reload({ ignoreCache: true });
  await waitForLoad(Page);

  // Now wait until the composer DOM is reachable AND stable AND empty.
  // We require it to be observed empty on TWO consecutive polls 250 ms apart
  // so a transient remount doesn't fool us.
  const deadline = Date.now() + 10_000;
  let consecutiveOk = 0;
  while (Date.now() < deadline) {
    const r = await Runtime.evaluate({
      expression: `(() => {
        const ce = document.querySelector('div#prompt-textarea, [contenteditable="true"]');
        const ta = document.querySelector('textarea');
        if (!ce && !ta) return { ready: false };
        const text = (ce?.innerText || ta?.value || "").trim();
        return { ready: true, empty: text.length === 0 };
      })()`,
      returnByValue: true,
    });
    const v = r.result?.value as { ready: boolean; empty?: boolean } | undefined;
    if (v?.ready && v.empty) {
      consecutiveOk += 1;
      if (consecutiveOk >= 2) return;
    } else {
      consecutiveOk = 0;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
}

async function waitForLoad(
  Page: RosettaSession["client"]["Page"],
): Promise<void> {
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, 6_000);
    Page.loadEventFired().then(() => {
      clearTimeout(t);
      resolve();
    });
  });
}

async function withFreshTab<T>(
  session: RosettaSession,
  fn: (client: ChromeClient) => Promise<T>,
): Promise<T> {
  const { Target } = session.client;
  const created = await Target.createTarget({
    url: "https://chatgpt.com/",
  });
  const targetId = created.targetId;
  // Track the open tab so external shutdown handlers (SIGINT/SIGTERM) can
  // close it if the process is killed before this finally runs.
  __openTabs.add({ session, targetId });
  let tabClient: ChromeClient | undefined;
  try {
    // CDP attach is its own RPC — if it throws, we still need to close the
    // already-created Target. Hence both the try entry and the assignment
    // happen inside the try block.
    tabClient = (await CDP({
      port: session.meta.cdpPort,
      host: session.meta.cdpHost ?? "127.0.0.1",
      target: targetId,
    })) as ChromeClient;
    // Wait for first load so the composer mount race is mostly resolved
    // before runConversationInTab kicks in.
    await tabClient.Page.enable();
    await waitForLoad(tabClient.Page);
    return await fn(tabClient);
  } finally {
    if (tabClient) await tabClient.close().catch(() => undefined);
    await Target.closeTarget({ targetId }).catch(() => undefined);
    for (const t of __openTabs) {
      if (t.targetId === targetId) { __openTabs.delete(t); break; }
    }
  }
}

/**
 * Tabs created by `withFreshTab` that haven't yet hit their finally block.
 * Exported (via the helper below) so a host process — typically the MCP
 * server — can install a SIGINT/SIGTERM handler that closes them on
 * graceful shutdown. SIGKILL still leaks (the process can't run code), but
 * graceful exits + Ctrl-C are now leak-free.
 */
const __openTabs = new Set<{ session: RosettaSession; targetId: string }>();
export async function closeAllOpenTabs(): Promise<void> {
  const snapshot = Array.from(__openTabs);
  __openTabs.clear();
  await Promise.allSettled(
    snapshot.map((t) => t.session.client.Target.closeTarget({ targetId: t.targetId })),
  );
}

async function deleteConversation(
  session: RosettaSession,
  conversationId: string,
): Promise<void> {
  // ChatGPT requires Authorization Bearer for write ops on conversations
  // (cookie-only auth returns 401). httpRequestViaChrome doesn't add it
  // automatically, so we attach it from the session meta here.
  await session.httpRequest({
    method: "PATCH",
    url: `/backend-api/conversation/${encodeURIComponent(conversationId)}`,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.meta.accessToken}`,
    },
    body: JSON.stringify({ is_visible: false }),
    responseType: "text",
  });
}

function rewriteBody(body: Record<string, unknown>, input: RunConversationInput): void {
  // The page composer is already populated with the real prompt, so
  // body.messages[0].content.parts is correct. We only override fields the
  // caller explicitly chose: model, conversation_id (multi-turn override),
  // parent_message_id (branching).
  if (input.model) body.model = input.model;
  if (input.conversationId) {
    if (!body.conversation_id) body.conversation_id = input.conversationId;
    if (input.parentMessageId) body.parent_message_id = input.parentMessageId;
  } else if (input.parentMessageId) {
    body.parent_message_id = input.parentMessageId;
  }
}

// Probe: is the *stop* button visible? This is the only DOM signal that
// reliably means "a send pipeline is genuinely in flight". A naïve probe
// based on the send button (`!enabled`) would conflate Stop with
// Send-but-disabled — but Send-disabled is exactly the swallowed-click
// signature (composer cleared, no pipeline running) and means we should
// redo, not keep waiting.
async function isStopButtonVisible(
  client: RosettaSession["client"],
): Promise<boolean> {
  const r = await client.Runtime.evaluate({
    expression: `(() => {
      const btn = document.querySelector('button[data-testid="stop-button"]') ||
        Array.from(document.querySelectorAll('button[aria-label]'))
          .find(b => /^stop /i.test(b.getAttribute('aria-label') || ''));
      return !!btn;
    })()`,
    returnByValue: true,
  });
  return r.result?.value === true;
}

// Global mutex for the focus-bound typing phase. Input.insertText and
// dispatchKeyEvent only deliver to whichever tab Chromium currently has in
// the foreground; even though Page.bringToFront is per-target, only one tab
// can be foreground at a time. We serialize typing across runs so each call
// gets its own brief focus window. Response streaming through Network
// events doesn't require focus and runs concurrently.
let typeMutex: Promise<unknown> = Promise.resolve();

async function driveComposerSend(
  client: RosettaSession["client"],
  promptText: string,
): Promise<void> {
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prev = typeMutex;
  typeMutex = next;
  await prev;
  try {
    await driveComposerSendInner(client, promptText);
  } finally {
    release();
  }
}

async function driveComposerSendInner(
  client: RosettaSession["client"],
  promptText: string,
): Promise<void> {
  const { Runtime, Input, Page } = client;
  // ChatGPT's composer is ProseMirror; its internal state updates only on
  // events it recognizes. Strategy:
  //   1. Page.bringToFront + small settle delay so insertText/dispatchKeyEvent
  //      reach this tab's renderer
  //   2. CDP Input.insertText (ProseMirror's preferred path — fires
  //      beforeinput, updates editor state, enables send button)
  //   3. Verify; if the editor still looks empty, escalate to a synthetic
  //      paste event (DataTransfer-bearing ClipboardEvent) which works
  //      off-focus too on most builds
  //   4. Last-resort: textContent + InputEvent (fires React's controlled
  //      component path; works for plain textarea even if ProseMirror
  //      ignores it)
  // The outer mutex serializes the focus-transfer phase so background tabs
  // wait their turn without starving.
  // Poll for actual OS-level focus on this tab. bringToFront alone is
  // unreliable on WSL/X11 — the window manager may not honor it
  // synchronously, and on multi-tab concurrent runs we need to make sure
  // CDP Input.* events actually land on this tab's renderer (they only go
  // to whichever tab the OS thinks is foreground). Retry up to ~3 s.
  const focusDeadline = Date.now() + 3000;
  let hasFocus = false;
  while (Date.now() < focusDeadline && !hasFocus) {
    await Page.bringToFront().catch(() => undefined);
    const r = await Runtime.evaluate({
      expression: `(() => {
        const ce = document.querySelector('div#prompt-textarea, [contenteditable="true"]');
        const ta = document.querySelector('textarea');
        const target = ce || ta;
        if (target) { target.focus(); try { target.click(); } catch (_e) {} }
        return document.hasFocus() && (target ? document.activeElement === target : true);
      })()`,
      returnByValue: true,
    });
    if (r.result?.value === true) {
      hasFocus = true;
      break;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
  }
  dbg("focus poll exit", { hasFocus });
  if (!hasFocus) {
    throw new RosettaRequestError(
      "Could not bring tab to front (OS focus poll timed out)",
      0,
      undefined,
      "trigger-failed",
    );
  }
  // Now insertText reliably lands.
  await Input.insertText({ text: promptText });
  dbg("Input.insertText done");
  // Verify; if not received, escalate to paste then textContent.
  const promptLiteral = JSON.stringify(promptText);
  const verifyDeadline = Date.now() + 1000;
  let observed = "";
  while (Date.now() < verifyDeadline) {
    const r = await Runtime.evaluate({
      expression: `(() => {
        const ce = document.querySelector('div#prompt-textarea, [contenteditable="true"]');
        const ta = document.querySelector('textarea');
        return (ce?.innerText || ta?.value || "");
      })()`,
      returnByValue: true,
    });
    observed = (r.result?.value as string) ?? "";
    if (observed.trim().length > 0) break;
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  dbg("verify after insertText", { observedLen: observed.length });
  if (observed.trim().length === 0) {
    dbg("escalate to paste fallback");
    await Runtime.evaluate({
      expression: `(() => {
        const ce = document.querySelector('div#prompt-textarea, [contenteditable="true"]');
        const ta = document.querySelector('textarea');
        const target = ce || ta;
        if (!target) return;
        target.focus();
        const dt = new DataTransfer();
        dt.setData('text/plain', ${promptLiteral});
        target.dispatchEvent(new ClipboardEvent('paste', {
          clipboardData: dt, bubbles: true, cancelable: true,
        }));
      })()`,
    });
    // Re-verify briefly
    const verifyDeadline2 = Date.now() + 800;
    while (Date.now() < verifyDeadline2) {
      const r = await Runtime.evaluate({
        expression: `(() => {
          const ce = document.querySelector('div#prompt-textarea, [contenteditable="true"]');
          const ta = document.querySelector('textarea');
          return (ce?.innerText || ta?.value || "");
        })()`,
        returnByValue: true,
      });
      observed = (r.result?.value as string) ?? "";
      if (observed.trim().length > 0) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    dbg("verify after paste", { observedLen: observed.length });
  }
  if (observed.trim().length === 0) {
    dbg("escalate to textContent fallback");
    await Runtime.evaluate({
      expression: `(() => {
        const ce = document.querySelector('div#prompt-textarea, [contenteditable="true"]');
        const ta = document.querySelector('textarea');
        if (ce) {
          ce.textContent = ${promptLiteral};
          ce.dispatchEvent(new InputEvent('input', {
            bubbles: true, data: ${promptLiteral}, inputType: 'insertFromPaste',
          }));
        } else if (ta) {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
          setter.call(ta, ${promptLiteral});
          ta.dispatchEvent(new Event('input', { bubbles: true }));
        }
      })()`,
    });
  }

  // Step 2: click send when the button is enabled. React may need a beat
  // after our InputEvent before the send button transitions from disabled
  // to enabled. Plain-text turns clear in <1 s; attachment turns can take
  // longer because the page enables send only once server-side processing
  // of every uploaded file has caught up. 15 s covers both comfortably —
  // we only wait the full window if the button is genuinely stuck.
  const clickDeadline = Date.now() + 15_000;
  let lastState: string | undefined;
  while (Date.now() < clickDeadline) {
    const r = await Runtime.evaluate({
      expression: `(() => {
        const sendBtn =
          document.querySelector('button[data-testid="send-button"]') ||
          Array.from(document.querySelectorAll('button[aria-label]'))
            .find(b => /send/i.test(b.getAttribute('aria-label') || ''));
        if (!sendBtn) return { state: "no-button" };
        if (sendBtn.disabled || sendBtn.getAttribute('aria-disabled') === 'true') {
          return { state: "disabled" };
        }
        sendBtn.click();
        return { state: "clicked" };
      })()`,
      returnByValue: true,
    });
    const v = r.result?.value as { state: string } | undefined;
    if (DBG && v?.state && v.state !== lastState) dbg("send-button state", v.state);
    if (v?.state) lastState = v.state;
    if (v?.state === "clicked") { dbg("send-button CLICKED"); return; }
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
  }
  // Forensic dump on failure: capture composer + button-region DOM so the
  // next failure can be diagnosed without re-running. Goes to stderr only
  // (never to the returned error) so it doesn't leak into MCP responses.
  try {
    const dump = await Runtime.evaluate({
      expression: `(() => {
        const composer = document.querySelector('#prompt-textarea, [contenteditable="true"]');
        let region = composer?.parentElement;
        for (let i = 0; i < 6 && region && region.parentElement; i++) region = region.parentElement;
        const buttons = region ? Array.from(region.querySelectorAll('button')).slice(0, 10).map(b => ({
          testId: b.getAttribute('data-testid'),
          aria: b.getAttribute('aria-label'),
          disabled: b.disabled || b.getAttribute('aria-disabled') === 'true',
          text: (b.textContent || '').trim().slice(0, 30),
        })) : [];
        return {
          composerText: (composer?.textContent || '').slice(0, 200),
          buttons,
          regionHtmlHead: (region?.outerHTML || '').slice(0, 1500),
        };
      })()`,
      returnByValue: true,
    });
    process.stderr.write(
      `[rosetta] trigger-failed [no-button] forensic dump:\n` +
        JSON.stringify(dump.result?.value, null, 2) + "\n",
    );
  } catch {
    // ignore — best-effort diagnostics
  }
  throw new RosettaRequestError(
    `Send button never became enabled after typing (last observed state: ${lastState ?? "unknown"})`,
    0,
    undefined,
    "trigger-failed",
  );
}

function stringStream(text: string): AsyncIterable<Uint8Array> {
  const encoder = new TextEncoder();
  return {
    async *[Symbol.asyncIterator]() {
      yield encoder.encode(text);
    },
  };
}

interface StreamHandoff {
  conversationId: string;
  turnExchangeId: string;
  topicId: string;
}

/**
 * Scan a bootstrap SSE byte buffer for a `stream_handoff` event. Pro turns
 * always emit one; instant turns never do. The returned topic_id binds the
 * second-leg WebSocket subscription.
 */
function extractStreamHandoff(sseText: string): StreamHandoff | null {
  // Split on SSE event boundaries; each event has lines starting with `data:`.
  const events = sseText.split("\n\n");
  for (const ev of events) {
    const dataLine = ev
      .split("\n")
      .find((l) => l.startsWith("data:"));
    if (!dataLine) continue;
    const json = dataLine.slice(5).trim();
    if (!json || json === "[DONE]") continue;
    try {
      const obj = JSON.parse(json) as Record<string, unknown>;
      if (obj.type !== "stream_handoff") continue;
      const options = (obj.options || []) as Array<{ type: string; topic_id: string }>;
      const ws = options.find((o) => o.type === "subscribe_ws_topic");
      if (!ws) continue;
      return {
        conversationId: String(obj.conversation_id ?? ""),
        turnExchangeId: String(obj.turn_exchange_id ?? ""),
        topicId: ws.topic_id,
      };
    } catch {
      // ignore malformed lines
    }
  }
  return null;
}

/**
 * Subscribe to the conversation-turn topic on ChatGPT's WebSocket and stream
 * the live CoT + final answer back into the aggregator. Returns the same
 * `RunConversationResult` shape as the instant path.
 *
 * Termination signals (any of these resolves):
 *   - assistant `/message/status` reaches `finished_successfully`
 *   - frame containing `data: [DONE]` in its encoded_item
 *   - `Network.webSocketClosed`
 *   - caller AbortSignal aborts
 */
async function streamSecondLeg(
  client: ChromeClient,
  session: RosettaSession,
  bootstrapText: string,
  handoff: StreamHandoff,
  startedAt: number,
  signal: AbortSignal | undefined,
  idleTimeoutMs: number,
  onChunk: ((delta: string) => void) | undefined,
): Promise<RunConversationResult> {
  const { Network, Runtime } = client;

  // 1. Get a fresh WS URL. The verify token has a TTL on the order of a
  // couple of hours, so we always re-fetch right before connecting.
  const wsResp = await session.httpRequest({
    method: "GET",
    url: "/backend-api/celsius/ws/user",
    headers: { Authorization: `Bearer ${session.meta.accessToken}` },
    responseType: "json",
  });
  if (wsResp.status < 200 || wsResp.status >= 300) {
    throw new RosettaRequestError(
      `Failed to get WS URL: HTTP ${wsResp.status}`,
      wsResp.status,
      typeof wsResp.body === "string" ? wsResp.body : JSON.stringify(wsResp.body),
      "server",
    );
  }
  const wsUrl = (wsResp.body as { websocket_url?: string }).websocket_url;
  if (!wsUrl) {
    throw new RosettaRequestError(
      "celsius/ws/user response missing websocket_url",
      0,
      JSON.stringify(wsResp.body).slice(0, 400),
      "server",
    );
  }

  // 2. Mutable byte queue: bootstrap text first, then encoded_item chunks
  // from incoming WS frames. The aggregator drains it.
  // Strip the bootstrap's terminal `data: [DONE]` — otherwise
  // parseConversationSse would terminate after consuming the bootstrap and
  // ignore the WS frames we're about to push. The WS frames carry their own
  // `[DONE]` when the CoT actually finishes; that's the one we want to
  // honor.
  const queue = new ChunkQueue();
  const bootstrapClean = bootstrapText.replace(/\n*data:\s*\[DONE\]\s*\n*$/m, "\n");
  queue.push(new TextEncoder().encode(bootstrapClean));

  // 3. Listen for WS frames bound to our topic. The page may have its own
  // long-lived WS (for the `conversations` topic); we open *our own* WS so
  // we don't rely on page logic to subscribe. CDP fires events for both.
  let ourWsRequestId: string | undefined;
  const onCreated = (e: { requestId: string; url: string }) => {
    dbg("Network.webSocketCreated", { id: e.requestId, url: e.url, alreadyClaimed: !!ourWsRequestId });
    if (!ourWsRequestId && e.url.includes("ws.chatgpt.com")) {
      ourWsRequestId = e.requestId;
    }
  };
  // WS frame envelope shape (reverse-engineered 2026-04-30):
  //   [ <command-reply OR live-message OR heartbeat> ]
  //
  // Subscribe reply:
  //   [{ type: "reply", reply: { type: "subscribe", topic_id, recovered,
  //      catchups: [<live-message>, ...] } }]
  //
  // Live message (and catchup):
  //   [{ type: "message", topic_id, payload: { type: "conversation-turn-stream",
  //      payload: { type: "stream-item" | "heartbeat",
  //                 encoded_item: "<SSE chunk>", ... } } }]
  //
  // The actual SSE bytes live at `payload.payload.encoded_item`. Heartbeats
  // (`payload.payload.type === "heartbeat"`) carry no encoded_item and are
  // ignored.
  type StreamItem = {
    type?: string;
    encoded_item?: string;
  };
  type WsMessage = {
    type?: string;
    topic_id?: string;
    payload?: { type?: string; payload?: StreamItem };
  };
  type WsReply = {
    type?: string;
    reply?: { type?: string; topic_id?: string; catchups?: WsMessage[] };
  };
  type WsItem = WsMessage | WsReply;
  const handleStreamItem = (msg: WsMessage): void => {
    if (msg.topic_id !== handoff.topicId) return;
    const inner = msg.payload?.payload;
    if (!inner) return;
    const enc = inner.encoded_item;
    if (!enc) return;
    queue.push(new TextEncoder().encode(enc));
  };
  let dbgFrameCount = 0;
  const onFrameRecv = (e: {
    requestId: string;
    response: { payloadData: string };
  }) => {
    if (e.requestId !== ourWsRequestId) return;
    const payload = e.response.payloadData;
    if (!payload) return;
    if (DBG) {
      dbgFrameCount += 1;
      if (dbgFrameCount <= 5 || dbgFrameCount % 50 === 0) {
        dbg("WS frame", { n: dbgFrameCount, len: payload.length, head: payload.slice(0, 80) });
      }
    }
    // Any frame at all — including heartbeats, replies, and stream-items —
    // counts as liveness. Reset the idle clock here, before parsing, so that
    // even an unrecognized envelope still keeps the call alive.
    lastFrameAt = Date.now();
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }
    const items = (Array.isArray(parsed) ? parsed : [parsed]) as WsItem[];
    for (const it of items) {
      if (!it || typeof it !== "object") continue;
      if (it.type === "message") {
        handleStreamItem(it as WsMessage);
      } else if (it.type === "reply") {
        const reply = (it as WsReply).reply;
        if (reply?.type === "subscribe" && Array.isArray(reply.catchups)) {
          for (const c of reply.catchups) handleStreamItem(c);
        }
      }
    }
  };
  const onClosed = (e: { requestId: string }) => {
    if (e.requestId === ourWsRequestId) queue.end();
  };

  // Idle-timeout watchdog. We enforce only an *idle* gap (no frame for N
  // seconds) — Pro CoT can take 15 min+, but the server emits heartbeats
  // every few seconds throughout, so any silence longer than `idleTimeoutMs`
  // means the connection is wedged. The wall-clock cap in runConversation
  // is just a runaway safety net.
  let lastFrameAt = Date.now();
  let idleTimer: NodeJS.Timeout | undefined;
  if (idleTimeoutMs > 0) {
    const tick = (): void => {
      const gap = Date.now() - lastFrameAt;
      if (gap >= idleTimeoutMs) {
        queue.end();
        return;
      }
      idleTimer = setTimeout(tick, Math.min(5_000, idleTimeoutMs - gap + 100));
    };
    idleTimer = setTimeout(tick, idleTimeoutMs);
  }

  const unsubs: Array<() => void> = [
    Network.webSocketCreated(onCreated) as unknown as () => void,
    Network.webSocketFrameReceived(onFrameRecv) as unknown as () => void,
    Network.webSocketClosed(onClosed) as unknown as () => void,
  ];

  let abortListener: (() => void) | undefined;
  if (signal) {
    abortListener = () => queue.end();
    signal.addEventListener("abort", abortListener);
  }

  try {
    // 4. Open WS in page context, then connect+subscribe.
    //
    // Wire protocol (reverse-engineered 2026-04-30):
    //   - Outer envelope is a JSON array of commands.
    //   - Each command is `{id, command: {type, ...}}` — singular `command`.
    //   - Must send `{type: "connect"}` BEFORE any `subscribe`. Server
    //     replies `{type: "reply", reply: {type: "connect", subscriptions: {}}}`.
    //   - Subscribe: `{type: "subscribe", topic_id, offset: "0"}`. Server
    //     replies with `{type: "reply", reply: {type: "subscribe", topic_id,
    //     recovered: true}}` and starts pushing topic frames.
    //
    // We funnel the connect+subscribe through a Promise that resolves on
    // the subscribe reply, so the caller knows when the second leg is
    // really listening.
    const setupExpr = `(async () => {
      try {
        if (!window.__oracleApiWs) window.__oracleApiWs = {};
        const reg = window.__oracleApiWs;
        const key = ${JSON.stringify(handoff.topicId)};
        if (reg[key]) { try { reg[key].close(); } catch (_e) {} }
        const ws = new WebSocket(${JSON.stringify(wsUrl)});
        reg[key] = ws;
        await new Promise((resolve, reject) => {
          ws.onopen = resolve;
          ws.onerror = () => reject(new Error("ws open failed"));
          setTimeout(() => reject(new Error("ws open timeout")), 10000);
        });
        // Connect, wait for ack.
        await new Promise((resolve, reject) => {
          const handler = (ev) => {
            try {
              const arr = JSON.parse(ev.data);
              const reply = Array.isArray(arr) ? arr[0] : arr;
              if (reply && reply.type === "reply" && reply.reply && reply.reply.type === "connect") {
                ws.removeEventListener("message", handler);
                resolve();
              }
            } catch (_e) {}
          };
          ws.addEventListener("message", handler);
          ws.send(JSON.stringify([{ id: 0, command: { type: "connect" } }]));
          setTimeout(() => { ws.removeEventListener("message", handler); reject(new Error("connect timeout")); }, 8000);
        });
        // Subscribe to our turn topic, wait for ack.
        await new Promise((resolve, reject) => {
          const handler = (ev) => {
            try {
              const arr = JSON.parse(ev.data);
              const reply = Array.isArray(arr) ? arr[0] : arr;
              if (reply && reply.type === "reply" && reply.reply && reply.reply.type === "subscribe") {
                ws.removeEventListener("message", handler);
                resolve();
              }
            } catch (_e) {}
          };
          ws.addEventListener("message", handler);
          ws.send(JSON.stringify([{
            id: 1,
            command: { type: "subscribe", topic_id: ${JSON.stringify(handoff.topicId)}, offset: "0" },
          }]));
          setTimeout(() => { ws.removeEventListener("message", handler); reject(new Error("subscribe timeout")); }, 8000);
        });
        return "ok";
      } catch (e) { return { __err: String(e) }; }
    })()`;
    dbg("WS setup begin", { wsHost: new URL(wsUrl).host, topic: handoff.topicId });
    const setupRes = await Runtime.evaluate({
      expression: setupExpr,
      awaitPromise: true,
      returnByValue: true,
    });
    const setupVal = setupRes.result?.value;
    if (setupVal && typeof setupVal === "object" && (setupVal as { __err: string }).__err) {
      dbg("WS setup failed", setupVal);
      throw new RosettaRequestError(
        `WS setup failed: ${(setupVal as { __err: string }).__err}`,
        0,
        undefined,
        "server",
      );
    }
    dbg("WS setup ok (subscribed)");

    // 5. Aggregate the merged stream until termination, firing onChunk
    //    deltas live as the assistant message grows.
    const events = parseConversationSse(queue);
    const result = await aggregateUntilFinished(events, startedAt, queue, onChunk);
    return result;
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    for (const u of unsubs) {
      try { u(); } catch { /* ignore */ }
    }
    if (signal && abortListener) signal.removeEventListener("abort", abortListener);
    // Close our WS in the page so the next call doesn't accumulate sockets.
    await Runtime.evaluate({
      expression: `(() => { try {
        const reg = window.__oracleApiWs || {};
        const ws = reg[${JSON.stringify(handoff.topicId)}];
        if (ws) ws.close();
        delete reg[${JSON.stringify(handoff.topicId)}];
      } catch (_e) {} })()`,
    }).catch(() => undefined);
  }
}

/**
 * Drains an SSE event iterator and detects Pro turn completion: status patch
 * to `finished_successfully`, `last_token` marker, or [DONE]. On detection,
 * end the underlying queue so the iterator terminates and we can return the
 * aggregated result.
 */
async function aggregateUntilFinished(
  events: AsyncIterable<unknown>,
  startedAt: number,
  queue: ChunkQueue,
  onChunk?: (delta: string) => void,
): Promise<RunConversationResult> {
  // Tee the stream into two consumers:
  //   1. the aggregator (folds events into final state)
  //   2. a sniffer that fires onChunk on text growth and ends the queue
  //      when the terminator arrives
  // The sniffer needs the same view as the aggregator so it sees real
  // assistant text deltas (not patches against tool/system messages).
  const [forAgg, forSniff] = teeAsync(events);
  (async () => {
    let lastText = "";
    try {
      for await (const ev of forSniff) {
        if (typeof ev !== "object" || ev === null) continue;
        const evObj = ev as Record<string, unknown>;
        if (onChunk) {
          const delta = extractAssistantDelta(evObj, lastText);
          if (delta.text.length > 0) {
            onChunk(delta.text);
            lastText = delta.newFullText;
          } else if (delta.newFullText !== lastText) {
            // Reset (e.g. assistant text replaced wholesale by a fresh
            // message frame) without growth — keep our view consistent.
            lastText = delta.newFullText;
          }
        }
        if (isFinishingEvent(evObj)) {
          queue.end();
          return;
        }
      }
    } catch { /* aggregator side will surface errors */ }
  })();
  return await aggregateAssistantMessage(forAgg, startedAt);
}

/**
 * Inspect a single SSE event and report any *new* assistant text it adds.
 * Returns:
 *   - `text`: the substring to forward to onChunk (empty when no new text)
 *   - `newFullText`: the caller's running snapshot of the assistant's full
 *     text after this event (used as the next-event baseline)
 */
function extractAssistantDelta(
  ev: Record<string, unknown>,
  prevFullText: string,
): { text: string; newFullText: string } {
  // Patch frame `{v: "delta", p: "/message/content/parts/0", o: "append"}`
  const v = ev.v;
  const p = (ev as { p?: unknown }).p;
  const o = (ev as { o?: unknown }).o;
  if (
    typeof v === "string" &&
    typeof p === "string" &&
    (p === "/message/content/parts/0" || p === "/message/content/parts/0/text")
  ) {
    if (o === "replace" || o === "r") {
      return { text: v, newFullText: v };
    }
    return { text: v, newFullText: prevFullText + v };
  }
  // Batched patches `{o: "patch", v: [<sub>, ...]}` (Pro WS)
  if (Array.isArray(v)) {
    let running = prevFullText;
    let added = "";
    for (const sub of v) {
      if (!sub || typeof sub !== "object") continue;
      const r = extractAssistantDelta(sub as Record<string, unknown>, running);
      if (r.text.length > 0) added += r.text;
      running = r.newFullText;
    }
    return { text: added, newFullText: running };
  }
  // Full-message frame: `{message: {author:{role:"assistant"}, content:{parts:[<text>]}}}`
  // OR wrapped in `{v: {message:{...}}, p:""|undefined, o:"add"}` (Pro WS bootstrap).
  let msg: Record<string, unknown> | undefined;
  if (ev.message && typeof ev.message === "object") {
    msg = ev.message as Record<string, unknown>;
  } else if (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    (p === undefined || p === "")
  ) {
    msg = (v as { message?: Record<string, unknown> }).message;
  }
  if (msg) {
    const author = msg.author as { role?: string } | undefined;
    if (author?.role && author.role !== "assistant") {
      return { text: "", newFullText: prevFullText };
    }
    const content = msg.content as { parts?: unknown[] } | undefined;
    const part = content?.parts?.[0];
    if (typeof part === "string") {
      // Cumulative-message flavor: parts[0] is the entire text-so-far.
      // Compute delta as suffix beyond prevFullText if it's a strict
      // extension; otherwise treat as wholesale replace.
      if (part.length === 0) return { text: "", newFullText: prevFullText };
      if (part === prevFullText) return { text: "", newFullText: prevFullText };
      if (part.startsWith(prevFullText)) {
        return { text: part.slice(prevFullText.length), newFullText: part };
      }
      return { text: part, newFullText: part };
    }
  }
  return { text: "", newFullText: prevFullText };
}

function isFinishingEvent(ev: Record<string, unknown>): boolean {
  // The only safe terminator. Pro and instant both emit it AFTER the final
  // assistant message + any tail metadata. Earlier signals like
  // `assistant end_turn=true` are unreliable: Pro replays the same message
  // twice — first with empty text, then with the answer — so terminating on
  // end_turn cuts the turn short and yields an empty result.
  if (ev.type === "message_stream_complete") return true;
  // Last-resort fallback for older builds that omit message_stream_complete.
  if (ev.type === "message_marker" && (ev as { marker?: string }).marker === "last_token") {
    return true;
  }
  return false;
}

function teeAsync<T>(
  source: AsyncIterable<T>,
): [AsyncIterable<T>, AsyncIterable<T>] {
  const buffers: T[][] = [[], []];
  const dones: boolean[] = [false, false];
  const waiters: Array<Array<() => void>> = [[], []];
  let pulling = false;
  let sourceDone = false;
  let sourceErr: unknown;
  const it = source[Symbol.asyncIterator]();
  async function pull() {
    if (pulling || sourceDone) return;
    pulling = true;
    try {
      while (!sourceDone) {
        const r = await it.next();
        if (r.done) {
          sourceDone = true;
          break;
        }
        const buf0 = buffers[0];
        const buf1 = buffers[1];
        if (buf0) buf0.push(r.value);
        if (buf1) buf1.push(r.value);
        for (const idx of [0, 1] as const) {
          const ws = waiters[idx];
          if (!ws) continue;
          while (ws.length) {
            const w = ws.shift();
            if (w) w();
          }
        }
      }
    } catch (e) {
      sourceErr = e;
      sourceDone = true;
    } finally {
      pulling = false;
      for (const idx of [0, 1] as const) {
        const dn = dones;
        dn[idx] = false; // let consumer drain remaining
        const ws = waiters[idx];
        if (!ws) continue;
        while (ws.length) {
          const w = ws.shift();
          if (w) w();
        }
      }
    }
  }
  function makeBranch(idx: 0 | 1): AsyncIterable<T> {
    return {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<T>> {
            const buf = buffers[idx];
            const ws = waiters[idx];
            if (!buf || !ws) return { value: undefined as unknown as T, done: true };
            while (buf.length === 0) {
              if (sourceDone) {
                if (sourceErr) throw sourceErr;
                return { value: undefined as unknown as T, done: true };
              }
              pull();
              await new Promise<void>((resolve) => ws.push(resolve));
            }
            const next = buf.shift();
            if (next === undefined) return { value: undefined as unknown as T, done: true };
            return { value: next, done: false };
          },
        };
      },
    };
  }
  return [makeBranch(0), makeBranch(1)];
}

class ChunkQueue implements AsyncIterable<Uint8Array> {
  private chunks: Uint8Array[] = [];
  private resolvers: Array<(c: Uint8Array | null) => void> = [];
  private closed = false;

  push(chunk: Uint8Array): void {
    if (this.closed) return;
    if (this.resolvers.length > 0) {
      const r = this.resolvers.shift() as (c: Uint8Array | null) => void;
      r(chunk);
    } else {
      this.chunks.push(chunk);
    }
  }

  end(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.resolvers.length > 0) {
      const r = this.resolvers.shift() as (c: Uint8Array | null) => void;
      r(null);
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<Uint8Array> {
    while (true) {
      if (this.chunks.length > 0) {
        yield this.chunks.shift() as Uint8Array;
        continue;
      }
      if (this.closed) return;
      const next = await new Promise<Uint8Array | null>((resolve) => {
        this.resolvers.push(resolve);
      });
      if (next === null) return;
      yield next;
    }
  }
}

/**
 * Lists the models available to the current ChatGPT account.
 * Pro is hidden from this endpoint; modelSlugs.ts holds the actual server slug.
 */
export async function fetchAvailableModels(
  session: RosettaSession,
): Promise<ModelsResponse> {
  const response = await session.httpRequest({
    method: "GET",
    url: "/backend-api/models?iim=false&is_gizmo=false",
    responseType: "json",
  });
  if (response.status < 200 || response.status >= 300) {
    throw classifyHttpResponse(response);
  }
  return response.body as ModelsResponse;
}

function classifyError(
  status: number,
  bodySnippet: string,
  responseHeaders?: Array<{ name: string; value: string }>,
): RosettaRequestError {
  const snippet = bodySnippet.slice(0, 400);
  const ct = (responseHeaders || []).find((h) => h.name.toLowerCase() === "content-type")?.value || "";
  if (status === 401) {
    return new RosettaRequestError(
      "401 Unauthorized — accessToken expired or invalid.",
      status,
      snippet,
      "auth",
    );
  }
  if (status === 403) {
    if (/arkose|funcaptcha/i.test(snippet)) {
      return new RosettaRequestError(
        "403 Forbidden — model requires Arkose. Re-run with --engine browser.",
        status,
        snippet,
        "arkose",
      );
    }
    if (ct.includes("text/html")) {
      return new RosettaRequestError(
        "403 Forbidden — Cloudflare bot challenge. Refresh chatgpt.com in the auth-holder Chrome.",
        status,
        snippet,
        "cloudflare",
      );
    }
    return new RosettaRequestError(
      `403 Forbidden: ${snippet || "(empty)"}`,
      status,
      snippet,
      "cloudflare",
    );
  }
  if (status === 429) {
    return new RosettaRequestError(
      `429 Too Many Requests${snippet ? `: ${snippet.slice(0, 80)}` : ""}.`,
      status,
      snippet,
      "rate-limit",
    );
  }
  if (status >= 500) {
    return new RosettaRequestError(
      `${status} ${snippet.slice(0, 80)}`.trim(),
      status,
      snippet,
      "server",
    );
  }
  return new RosettaRequestError(
    `HTTP ${status} from ChatGPT backend: ${snippet || "(empty body)"}`,
    status,
    snippet,
    "unknown",
  );
}

function classifyHttpResponse(response: HttpResponse): RosettaRequestError {
  const text = typeof response.body === "string" ? response.body : JSON.stringify(response.body);
  return classifyError(
    response.status,
    text,
    Object.entries(response.headers).map(([name, value]) => ({ name, value })),
  );
}
