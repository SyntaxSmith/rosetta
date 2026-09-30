import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  pollConversationForFinal,
  RosettaRequestError,
  runConversationInTab,
  runWithNamedThreadPersistence,
  streamSecondLeg,
} from "../src/client.js";
import type { ChromeClient } from "../src/chrome.js";
import { setHomeOverrideForTest } from "../src/home.js";
import type { ConversationMapping } from "../src/pro-final.js";
import { loadThread, saveThread } from "../src/state.js";
import type { HttpResponse, RosettaSession, RunConversationResult } from "../src/types.js";

const TURN_ID = "turn-current";
const HANDOFF = {
  conversationId: "conversation-current",
  turnExchangeId: TURN_ID,
  topicId: "topic-current",
};

function response(status: number, body: unknown): HttpResponse {
  return { status, body, contentType: "application/json", headers: {} };
}

function activeMapping(): ConversationMapping {
  return {
    stage: {
      parent: null,
      message: {
        id: "stage",
        author: { role: "assistant" },
        recipient: "all",
        content: { content_type: "text", parts: ["阶段总结"] },
        status: "finished_successfully",
        end_turn: true,
        metadata: { turn_exchange_id: TURN_ID },
      },
    },
    thoughts: {
      parent: "stage",
      message: {
        id: "thoughts",
        author: { role: "assistant" },
        recipient: "all",
        content: { content_type: "thoughts", parts: [] },
        status: "finished_successfully",
        end_turn: false,
        metadata: {
          turn_exchange_id: TURN_ID,
          reasoning_status: "is_reasoning",
        },
      },
    },
  };
}

function finalMapping(): ConversationMapping {
  return {
    thoughts: {
      parent: null,
      message: {
        id: "thoughts",
        author: { role: "assistant" },
        recipient: "all",
        content: { content_type: "thoughts", parts: [] },
        status: "finished_successfully",
        end_turn: false,
        metadata: {
          turn_exchange_id: TURN_ID,
          reasoning_status: "is_reasoning",
        },
      },
    },
    recap: {
      parent: "thoughts",
      message: {
        id: "recap",
        author: { role: "assistant" },
        recipient: "all",
        content: { content_type: "reasoning_recap", parts: [] },
        status: "finished_successfully",
        end_turn: true,
        metadata: {
          turn_exchange_id: TURN_ID,
          reasoning_status: "reasoning_ended",
        },
      },
    },
    final: {
      parent: "recap",
      message: {
        id: "final-text-message",
        author: { role: "assistant" },
        recipient: "all",
        content: { content_type: "text", parts: ["完整最终回答"] },
        status: "finished_successfully",
        end_turn: true,
        metadata: {
          turn_exchange_id: TURN_ID,
          model_slug: "gpt-5-6-pro",
          finish_details: { type: "stop" },
        },
      },
    },
  };
}

type StreamPhase = "message-complete" | "socket-close" | "final-text";

function makeStreamHarness(
  phase: StreamPhase,
  mapping: ConversationMapping,
  abortAfterConversationGet = false,
): {
  client: ChromeClient;
  session: RosettaSession;
  controller: AbortController;
  conversationGets: ReturnType<typeof vi.fn>;
} {
  let createdHandler: ((event: { requestId: string; url: string }) => void) | undefined;
  let frameHandler:
    | ((event: { requestId: string; response: { payloadData: string } }) => void)
    | undefined;
  let closedHandler: ((event: { requestId: string }) => void) | undefined;
  const controller = new AbortController();
  const conversationGets = vi.fn(async () => {
    if (abortAfterConversationGet) setTimeout(() => controller.abort(), 0);
    return response(200, { mapping });
  });

  const Network = {
    webSocketCreated: vi.fn((handler) => {
      createdHandler = handler;
      return () => undefined;
    }),
    webSocketFrameReceived: vi.fn((handler) => {
      frameHandler = handler;
      return () => undefined;
    }),
    webSocketClosed: vi.fn((handler) => {
      closedHandler = handler;
      return () => undefined;
    }),
  };
  const Runtime = {
    evaluate: vi.fn(async ({ expression }: { expression: string }) => {
      if (expression.includes("(async () =>")) {
        queueMicrotask(() => {
          createdHandler?.({ requestId: "ws-1", url: "wss://ws.chatgpt.com/test" });
          if (phase === "socket-close") {
            closedHandler?.({ requestId: "ws-1" });
            return;
          }
          const encodedItem =
            phase === "final-text"
              ? 'data: {"message":{"id":"final-text-message","author":{"role":"assistant"},"recipient":"all","content":{"content_type":"text","parts":["完整最终回答"]}}}\n\ndata: {"type":"message_stream_complete"}\n\n'
              : 'data: {"type":"message_stream_complete"}\n\n';
          frameHandler?.({
            requestId: "ws-1",
            response: {
              payloadData: JSON.stringify([
                {
                  type: "message",
                  topic_id: HANDOFF.topicId,
                  payload: {
                    type: "conversation-turn-stream",
                    payload: { type: "stream-item", encoded_item: encodedItem },
                  },
                },
              ]),
            },
          });
        });
        return { result: { value: "ok" } };
      }
      return { result: { value: undefined } };
    }),
  };
  const client = { Network, Runtime } as unknown as ChromeClient;
  const session = {
    client,
    meta: {
      accessToken: "test-token",
      userAgent: "test",
      deviceId: "test",
      expiresAt: Date.now() + 60_000,
      acquiredAt: Date.now(),
      cdpPort: 9222,
      cdpHost: "127.0.0.1",
    },
    httpRequest: vi.fn(async (input: { url: string }) => {
      if (input.url === "/backend-api/celsius/ws/user") {
        return response(200, { websocket_url: "wss://ws.chatgpt.com/test" });
      }
      if (input.url === `/backend-api/conversation/${HANDOFF.conversationId}`) {
        return await conversationGets();
      }
      throw new Error(`unexpected URL: ${input.url}`);
    }),
    close: vi.fn(async () => undefined),
  } as unknown as RosettaSession;
  return { client, session, controller, conversationGets };
}

describe("Pro stream-to-REST completion gate", () => {
  test("B: message_stream_complete still polls and rejects when the turn remains in reasoning", async () => {
    const harness = makeStreamHarness("message-complete", activeMapping(), true);

    await expect(
      streamSecondLeg(
        harness.client,
        harness.session,
        "data: {}\n\n",
        HANDOFF,
        Date.now(),
        harness.controller.signal,
        0,
        undefined,
      ),
    ).rejects.toThrow("Aborted while polling conversation");
    expect(harness.conversationGets).toHaveBeenCalledTimes(1);
  });

  test("C: WebSocket close enters REST polling instead of returning the stage summary", async () => {
    const harness = makeStreamHarness("socket-close", activeMapping(), true);

    await expect(
      streamSecondLeg(
        harness.client,
        harness.session,
        "data: {}\n\n",
        HANDOFF,
        Date.now(),
        harness.controller.signal,
        0,
        undefined,
      ),
    ).rejects.toThrow("Aborted while polling conversation");
    expect(harness.conversationGets).toHaveBeenCalledTimes(1);
  });

  test("REST verification returns the full final answer without duplicating onChunk", async () => {
    const harness = makeStreamHarness("final-text", finalMapping());
    const chunks: string[] = [];

    const result = await streamSecondLeg(
      harness.client,
      harness.session,
      "data: {}\n\n",
      HANDOFF,
      Date.now(),
      undefined,
      0,
      (delta) => chunks.push(delta),
    );

    expect(result).toMatchObject({
      text: "完整最终回答",
      messageId: "final-text-message",
    });
    expect(chunks.join("")).toBe("完整最终回答");
    expect(chunks).toHaveLength(1);
  });

  test("an unverifiable turn times out as INCOMPLETE instead of returning stage text", async () => {
    vi.useFakeTimers();
    try {
      const harness = makeStreamHarness("message-complete", activeMapping());
      const pending = pollConversationForFinal(
        harness.session,
        HANDOFF,
        Date.now(),
        undefined,
        1,
        undefined,
      );
      const rejection = expect(pending).rejects.toThrow("INCOMPLETE Pro turn");

      await vi.advanceTimersByTimeAsync(370_000);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("bootstrap SSE capture", () => {
  function bootstrapHarness(text: string, failed: boolean, model = "gpt-6-pro") {
    const handlers: Record<string, (event: any) => unknown> = {};
    const subscribe = (name: string) => (handler: (event: any) => unknown) => {
      handlers[name] = handler;
      return () => { delete handlers[name]; };
    };
    const bytes = Buffer.from(text);
    const textOffset = bytes.indexOf(Buffer.from("完整"));
    const split = textOffset < 0 ? 17 : textOffset + 1;
    const Network = {
      enable: vi.fn(async () => undefined),
      requestWillBeSent: subscribe("request"),
      responseReceived: subscribe("response"),
      dataReceived: subscribe("data"),
      loadingFinished: subscribe("finished"),
      loadingFailed: subscribe("failed"),
      getResponseBody: vi.fn(async () => { throw new Error("aborted response body is unavailable"); }),
      streamResourceContent: vi.fn(async () => {
        // CDP can deliver live data before the buffered-prefix command reply.
        handlers.data?.({ requestId: "bootstrap", data: bytes.subarray(split).toString("base64") });
        queueMicrotask(() => {
          handlers[failed ? "failed" : "finished"]?.({
            requestId: "bootstrap", errorText: "net::ERR_ABORTED",
          });
        });
        return { bufferedData: bytes.subarray(0, split).toString("base64") };
      }),
    };
    const Fetch = {
      enable: vi.fn(async () => undefined),
      disable: vi.fn(async () => undefined),
      requestPaused: subscribe("paused"),
      continueRequest: vi.fn(async () => {
        handlers.request?.({ requestId: "bootstrap", request: { url: "https://chatgpt.com/backend-api/f/conversation" } });
        handlers.response?.({ requestId: "bootstrap", response: { status: 200, mimeType: "text/event-stream" } });
      }),
    };
    const client = {
      Network, Fetch,
      Page: {
        enable: vi.fn(async () => undefined),
        navigate: vi.fn(async () => ({ frameId: "frame" })),
        loadEventFired: vi.fn(async () => ({ timestamp: 0 })),
        bringToFront: vi.fn(async () => undefined),
      },
      Input: { insertText: vi.fn(async () => undefined) },
      Runtime: {
        enable: vi.fn(async () => undefined),
        evaluate: vi.fn(async ({ expression }: { expression: string }) => {
          if (expression.includes("document.hasFocus")) return { result: { value: true } };
          if (expression.includes("sendBtn.click")) {
            handlers.paused?.({ requestId: "fetch-bootstrap", request: {
              url: "https://chatgpt.com/backend-api/f/conversation",
              postData: JSON.stringify({ model: "gpt-5-6", messages: [] }), headers: {},
            } });
            return { result: { value: { state: "clicked" } } };
          }
          return { result: { value: "test prompt" } };
        }),
      },
    } as unknown as ChromeClient;
    const session = {
      client, meta: { accessToken: "test-token" },
      httpRequest: vi.fn(async (input: { url: string }) => {
        if (input.url === "/backend-api/celsius/ws/user") return response(503, {});
        return response(200, { mapping: finalMapping() });
      }),
    } as unknown as RosettaSession;
    const run = () => runConversationInTab(session, client, {
      prompt: "test prompt", model, conversationId: HANDOFF.conversationId,
    }, { timeoutMs: 1_000, keepConversation: true });
    return { run, Network, session };
  }

  test("a captured handoff survives the page abort and still verifies the final turn", async () => {
    const text = `data: ${JSON.stringify({ type: "stream_handoff",
      conversation_id: HANDOFF.conversationId, turn_exchange_id: TURN_ID,
      options: [{ type: "subscribe_ws_topic", topic_id: HANDOFF.topicId }],
    })}\n\ndata: [DONE]\n\n`;
    const harness = bootstrapHarness(text, true);
    await expect(harness.run()).resolves.toMatchObject({ text: "完整最终回答", messageId: "final-text-message" });
    expect(harness.Network.getResponseBody).not.toHaveBeenCalled();
    expect(harness.session.httpRequest).toHaveBeenCalledWith(expect.objectContaining({
      url: `/backend-api/conversation/${HANDOFF.conversationId}`,
    }));
  });

  test("an abort without a handoff remains a network error", async () => {
    const harness = bootstrapHarness('data: {"type":"keepalive"}\n\n', true);
    await expect(harness.run()).rejects.toThrow("Network loading failed: net::ERR_ABORTED");
    expect(harness.session.httpRequest).not.toHaveBeenCalled();
  });

  test.each([false, true])("instant SSE preserves UTF-8 on completion (page aborted: %s)", async (failed) => {
    const message = finalMapping().final!.message!;
    const text = `data: ${JSON.stringify({ conversation_id: HANDOFF.conversationId,
      message: { ...message, metadata: { ...message.metadata, model_slug: "gpt-5-6" } },
    })}\n\ndata: [DONE]\n\n`;
    const harness = bootstrapHarness(text, failed, "gpt-5-6");
    await expect(harness.run()).resolves.toMatchObject({ text: "完整最终回答" });
    expect(harness.Network.getResponseBody).not.toHaveBeenCalled();
  });

  test("[DONE] without a terminal instant assistant answer cannot recover an abort", async () => {
    const harness = bootstrapHarness("data: [DONE]\n\n", true, "gpt-5-6");
    await expect(harness.run()).rejects.toThrow("Network loading failed: net::ERR_ABORTED");
  });

  test("Pro text plus [DONE] cannot bypass the handoff and final-state verifier", async () => {
    const text = `data: ${JSON.stringify({ conversation_id: HANDOFF.conversationId,
      message: finalMapping().final!.message,
    })}\n\ndata: [DONE]\n\n`;
    const harness = bootstrapHarness(text, true);
    await expect(harness.run()).rejects.toThrow("Network loading failed: net::ERR_ABORTED");
  });
});

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), "rosetta-client-test-"));
  setHomeOverrideForTest(tempDir);
});

afterEach(() => {
  setHomeOverrideForTest(null);
});

describe("named thread final-pointer persistence", () => {
  const finalResult: RunConversationResult = {
    text: "完整最终回答",
    conversationId: "conversation-current",
    messageId: "final-text-message",
    modelSlug: "gpt-5-6-pro",
    finishReason: "stop",
    tookMs: 1,
    eventCount: 1,
  };

  test("F: a failed or incomplete operation leaves the old pointer unchanged", async () => {
    saveThread("named", {
      conversationId: "old-conversation",
      messageId: "old-final-text",
      updatedAt: 1,
    });

    await expect(
      runWithNamedThreadPersistence("named", async () => {
        throw new RosettaRequestError(
          "INCOMPLETE Pro turn: final state could not be verified",
          0,
          undefined,
          "server",
        );
      }),
    ).rejects.toThrow("INCOMPLETE Pro turn");
    expect(loadThread("named")).toMatchObject({
      conversationId: "old-conversation",
      messageId: "old-final-text",
    });
  });

  test("F: a verified operation persists only its final text messageId", async () => {
    await runWithNamedThreadPersistence("named", async () => finalResult);

    expect(loadThread("named")).toMatchObject({
      conversationId: "conversation-current",
      messageId: "final-text-message",
      model: "gpt-5-6-pro",
    });
  });
});
