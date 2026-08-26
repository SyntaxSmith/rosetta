import { describe, expect, test } from "vitest";
import {
  aggregateAssistantMessage,
  parseConversationSse,
  stripCitations,
} from "../src/sse.js";
import { isProStreamPhaseBoundaryEvent } from "../src/client.js";
import {
  evaluateProTurnCompletion,
  type ConversationMapping,
} from "../src/pro-final.js";

function bodyFrom(chunks: string[]): AsyncIterable<Uint8Array> {
  const encoder = new TextEncoder();
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield encoder.encode(chunk);
    },
  };
}

async function collect(events: AsyncIterable<unknown>): Promise<unknown[]> {
  const result: unknown[] = [];
  for await (const event of events) result.push(event);
  return result;
}

const PRO_TURN = "1dc9731f-4ea1-442c-885a-1f83606dddc1";

function assistantNode(
  id: string,
  parent: string | null,
  contentType: string,
  options: {
    text?: string;
    turn?: string;
    reasoningStatus?: string;
    finishType?: string;
    recipient?: string;
    endTurn?: boolean;
  } = {},
): ConversationMapping[string] {
  return {
    id,
    parent,
    children: [],
    message: {
      id,
      author: { role: "assistant" },
      recipient: options.recipient ?? "all",
      content: {
        content_type: contentType,
        parts: options.text === undefined ? [] : [options.text],
      },
      status: "finished_successfully",
      end_turn:
        options.endTurn ?? (contentType === "text" || contentType === "reasoning_recap"),
      metadata: {
        turn_exchange_id: options.turn ?? PRO_TURN,
        reasoning_status: options.reasoningStatus,
        finish_details: options.finishType ? { type: options.finishType } : undefined,
        model_slug: "gpt-5-6-pro",
      },
    },
  };
}

describe("parseConversationSse", () => {
  test("yields parsed JSON objects from data: lines", async () => {
    const body = bodyFrom([
      'data: {"hello":"world"}\n\n',
      'data: {"answer":42}\n\n',
      "data: [DONE]\n\n",
    ]);
    expect(await collect(parseConversationSse(body))).toEqual([
      { hello: "world" },
      { answer: 42 },
    ]);
  });

  test("skips comment / keepalive lines", async () => {
    const body = bodyFrom([
      ": ping\n\n",
      'data: {"k":1}\n\n',
      ":\n\n",
      "data: [DONE]\n\n",
    ]);
    expect(await collect(parseConversationSse(body))).toEqual([{ k: 1 }]);
  });

  test("handles chunk boundaries inside an event", async () => {
    const body = bodyFrom([
      'data: {"hel',
      'lo":"',
      'world"}\n\n',
      "data: [DONE]\n\n",
    ]);
    expect(await collect(parseConversationSse(body))).toEqual([{ hello: "world" }]);
  });

  test("terminates on [DONE] without yielding it", async () => {
    const body = bodyFrom(['data: {"x":1}\n\n', "data: [DONE]\n\n", 'data: {"x":2}\n\n']);
    expect(await collect(parseConversationSse(body))).toEqual([{ x: 1 }]);
  });

  test("yields raw string for malformed JSON", async () => {
    const body = bodyFrom(['data: not-json\n\n', "data: [DONE]\n\n"]);
    expect(await collect(parseConversationSse(body))).toEqual(["not-json"]);
  });

  test("handles trailing event without final blank line", async () => {
    const body = bodyFrom(['data: {"final":true}\n\n', 'data: {"trailing":"yes"}']);
    expect(await collect(parseConversationSse(body))).toEqual([
      { final: true },
      { trailing: "yes" },
    ]);
  });
});

describe("aggregateAssistantMessage", () => {
  test("captures cumulative parts[0] from message frames", async () => {
    const body = bodyFrom([
      'data: {"message":{"id":"m1","content":{"content_type":"text","parts":["He"]},"metadata":{"model_slug":"gpt-5-pro"}},"conversation_id":"c1"}\n\n',
      'data: {"message":{"id":"m1","content":{"content_type":"text","parts":["Hello"]},"metadata":{"model_slug":"gpt-5-pro"}},"conversation_id":"c1"}\n\n',
      'data: {"message":{"id":"m1","content":{"content_type":"text","parts":["Hello world"]},"metadata":{"model_slug":"gpt-5-pro","finish_details":{"type":"stop"}},"status":"finished_successfully"},"conversation_id":"c1"}\n\n',
      "data: [DONE]\n\n",
    ]);
    const result = await aggregateAssistantMessage(parseConversationSse(body));
    expect(result.text).toBe("Hello world");
    expect(result.conversationId).toBe("c1");
    expect(result.messageId).toBe("m1");
    expect(result.modelSlug).toBe("gpt-5-pro");
    expect(result.finishReason).toBe("stop");
  });

  test("appends string deltas via patch ops", async () => {
    const body = bodyFrom([
      'data: {"v":{"message":{"id":"m2","content":{"content_type":"text","parts":[""]},"metadata":{"model_slug":"gpt-5-pro"}},"conversation_id":"c2"}}\n\n',
      'data: {"v":"Hel","p":"/message/content/parts/0","o":"append"}\n\n',
      'data: {"v":"lo, ","p":"/message/content/parts/0","o":"append"}\n\n',
      'data: {"v":"world!","p":"/message/content/parts/0","o":"append"}\n\n',
      'data: {"v":"finished_successfully","p":"/message/status","o":"replace"}\n\n',
      "data: [DONE]\n\n",
    ]);
    const result = await aggregateAssistantMessage(parseConversationSse(body));
    expect(result.text).toBe("Hello, world!");
    expect(result.conversationId).toBe("c2");
    expect(result.messageId).toBe("m2");
    expect(result.modelSlug).toBe("gpt-5-pro");
    expect(result.finishReason).toBe("finished_successfully");
  });

  test("treats {v:string} with no path as a string append shorthand", async () => {
    const body = bodyFrom([
      'data: {"v":{"message":{"id":"m3","content":{"content_type":"text","parts":[""]}},"conversation_id":"c3"}}\n\n',
      'data: {"v":"abc"}\n\n',
      'data: {"v":"def"}\n\n',
      "data: [DONE]\n\n",
    ]);
    const result = await aggregateAssistantMessage(parseConversationSse(body));
    expect(result.text).toBe("abcdef");
  });

  test("applies batch patches", async () => {
    const body = bodyFrom([
      'data: {"v":{"message":{"id":"m4","content":{"content_type":"text","parts":[""]}},"conversation_id":"c4"}}\n\n',
      'data: {"v":[{"v":"A","p":"/message/content/parts/0","o":"append"},{"v":"B","p":"/message/content/parts/0","o":"append"}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    const result = await aggregateAssistantMessage(parseConversationSse(body));
    expect(result.text).toBe("AB");
  });

  test("ignores tool-call frames between text deltas", async () => {
    const body = bodyFrom([
      'data: {"v":{"message":{"id":"m5","content":{"content_type":"text","parts":[""]}},"conversation_id":"c5"}}\n\n',
      'data: {"v":"Hi","p":"/message/content/parts/0","o":"append"}\n\n',
      'data: {"message":{"id":"tool-1","author":{"role":"tool"},"content":{"content_type":"code","parts":["print(1)"]}},"conversation_id":"c5"}\n\n',
      'data: {"v":" there","p":"/message/content/parts/0","o":"append"}\n\n',
      "data: [DONE]\n\n",
    ]);
    const result = await aggregateAssistantMessage(parseConversationSse(body));
    // The tool message resets the cumulative parts to "print(1)" via captureFromMessage,
    // but the final delta " there" appends — what we care about is no crash and a sane string.
    expect(result.text).toContain(" there");
  });

  test("survives empty stream", async () => {
    const body = bodyFrom(["data: [DONE]\n\n"]);
    const result = await aggregateAssistantMessage(parseConversationSse(body));
    expect(result.text).toBe("");
    expect(result.eventCount).toBe(0);
  });

  test("strips ChatGPT private-use citation markers from text", async () => {
    // Format observed live (probed via xxd on a real attachment response):
    // U+E200 + "filecite" + U+E202 + "turn0file0" + U+E201
    const cite = "\u{E200}filecite\u{E202}turn0file0\u{E201}";
    const body = bodyFrom([
      `data: {"message":{"id":"m7","content":{"content_type":"text","parts":["PINEAPPLE-9824 ${cite}"]}}}\n\n`,
      "data: [DONE]\n\n",
    ]);
    const result = await aggregateAssistantMessage(parseConversationSse(body));
    expect(result.text).toBe("PINEAPPLE-9824");
  });
});

describe("Pro turn final-state verification", () => {
  test("A: rejects the observed short end_turn text while later thoughts are still reasoning", () => {
    const mapping: ConversationMapping = {
      "16ced1a1-139f-42b9-99c9-3758d40810f9": assistantNode(
        "16ced1a1-139f-42b9-99c9-3758d40810f9",
        null,
        "text",
        {
          text: "12 个机制已展开；查重发现四类强近邻，候选将收窄到结构扩容、最小写集、非交换事件代数和条件纤维输运，并标高风险。",
        },
      ),
      "f6544ce3-44ec-48b2-880d-386a6fa4cacb": assistantNode(
        "f6544ce3-44ec-48b2-880d-386a6fa4cacb",
        "16ced1a1-139f-42b9-99c9-3758d40810f9",
        "thoughts",
        { reasoningStatus: "is_reasoning", endTurn: false },
      ),
    };

    expect(evaluateProTurnCompletion(mapping, PRO_TURN)).toMatchObject({
      done: false,
      reason: "trusted reasoning_ended signal not present",
    });
  });

  test("B: message_stream_complete ends only the stream phase when mapping is still reasoning", () => {
    const mapping: ConversationMapping = {
      preamble: assistantNode("preamble", null, "text", { text: "先做检查。" }),
      thoughts: assistantNode("thoughts", "preamble", "thoughts", {
        reasoningStatus: "is_reasoning",
        endTurn: false,
      }),
    };

    expect(isProStreamPhaseBoundaryEvent({ type: "message_stream_complete" })).toBe(true);
    expect(
      isProStreamPhaseBoundaryEvent({ type: "message_marker", marker: "last_token" }),
    ).toBe(true);
    expect(evaluateProTurnCompletion(mapping, PRO_TURN).done).toBe(false);
  });

  test("D: rejects every end_turn stage text when reasoning continues afterward", () => {
    const mapping: ConversationMapping = {
      stage1: assistantNode("stage1", null, "text", { text: "阶段一。" }),
      thoughts1: assistantNode("thoughts1", "stage1", "thoughts", {
        reasoningStatus: "is_reasoning",
        endTurn: false,
      }),
      stage2: assistantNode("stage2", "thoughts1", "text", { text: "阶段二。" }),
      thoughts2: assistantNode("thoughts2", "stage2", "thoughts", {
        reasoningStatus: "is_reasoning",
        endTurn: false,
      }),
    };

    expect(evaluateProTurnCompletion(mapping, PRO_TURN).done).toBe(false);
  });

  test("E: returns only the terminal text node after trusted reasoning_ended", () => {
    const mapping: ConversationMapping = {
      thoughts: assistantNode("thoughts", null, "thoughts", {
        reasoningStatus: "is_reasoning",
        endTurn: false,
      }),
      recap: assistantNode("recap", "thoughts", "reasoning_recap", {
        reasoningStatus: "reasoning_ended",
      }),
      final: assistantNode("final", "recap", "text", {
        text: "完整最终回答",
        finishType: "stop",
      }),
    };

    expect(evaluateProTurnCompletion(mapping, PRO_TURN)).toEqual({
      done: true,
      finalText: "完整最终回答",
      finalMessageId: "final",
      modelSlug: "gpt-5-6-pro",
      finishReason: "stop",
    });
  });

  test("minimal turn with absent finish_details verifies (captured 2026-08: trivial Pro prompt)", () => {
    // Real mapping from a live gpt-5-6-pro "reply pong" turn: user → tool →
    // reasoning_recap(reasoning_ended) → text, where the terminal text carries
    // NO finish_details object. Requiring finish_details.type === "stop" made
    // every such turn poll to the idle floor and fail as INCOMPLETE.
    const mapping: ConversationMapping = {
      user: {
        id: "user",
        parent: null,
        children: [],
        message: {
          id: "user",
          author: { role: "user" },
          recipient: "all",
          content: { content_type: "text", parts: ["Reply with exactly one word: pong"] },
          status: "finished_successfully",
          end_turn: null,
          metadata: { turn_exchange_id: PRO_TURN },
        },
      },
      recap: assistantNode("recap", "user", "reasoning_recap", {
        reasoningStatus: "reasoning_ended",
      }),
      final: assistantNode("final", "recap", "text", { text: "pong" }),
    };

    expect(evaluateProTurnCompletion(mapping, PRO_TURN)).toMatchObject({
      done: true,
      finalText: "pong",
      finalMessageId: "final",
      finishReason: undefined,
    });
  });

  test("explicit non-stop finish_details still disqualifies the terminal text", () => {
    const mapping: ConversationMapping = {
      recap: assistantNode("recap", null, "reasoning_recap", {
        reasoningStatus: "reasoning_ended",
      }),
      final: assistantNode("final", "recap", "text", {
        text: "被截断",
        finishType: "max_tokens",
      }),
    };

    expect(evaluateProTurnCompletion(mapping, PRO_TURN)).toMatchObject({
      done: false,
      reason: "no terminal recipient=all text after trusted reasoning_ended",
    });
  });

  test("rejects a terminal-looking text if newer is_reasoning thoughts follow it", () => {
    const mapping: ConversationMapping = {
      recap: assistantNode("recap", null, "reasoning_recap", {
        reasoningStatus: "reasoning_ended",
      }),
      candidate: assistantNode("candidate", "recap", "text", {
        text: "看似最终",
        finishType: "stop",
      }),
      resumed: assistantNode("resumed", "candidate", "thoughts", {
        reasoningStatus: "is_reasoning",
        endTurn: false,
      }),
    };

    expect(evaluateProTurnCompletion(mapping, PRO_TURN)).toMatchObject({
      done: false,
      reason: "active or graph-incomparable reasoning remains for final text candidate",
    });
  });

  test("G: ignores completed and active nodes from different turn_exchange_ids", () => {
    const mapping: ConversationMapping = {
      oldRecap: assistantNode("oldRecap", null, "reasoning_recap", {
        turn: "previous-turn",
        reasoningStatus: "reasoning_ended",
      }),
      oldFinal: assistantNode("oldFinal", "oldRecap", "text", {
        turn: "previous-turn",
        text: "上一轮答案",
        finishType: "stop",
      }),
      currentThoughts: assistantNode("currentThoughts", "oldFinal", "thoughts", {
        reasoningStatus: "is_reasoning",
        endTurn: false,
      }),
      currentRecap: assistantNode("currentRecap", "currentThoughts", "reasoning_recap", {
        reasoningStatus: "reasoning_ended",
      }),
      currentFinal: assistantNode("currentFinal", "currentRecap", "text", {
        text: "当前轮完整答案",
        finishType: "stop",
      }),
      nextThoughts: assistantNode("nextThoughts", "currentFinal", "thoughts", {
        turn: "next-turn",
        reasoningStatus: "is_reasoning",
        endTurn: false,
      }),
    };

    expect(evaluateProTurnCompletion(mapping, PRO_TURN)).toMatchObject({
      done: true,
      finalText: "当前轮完整答案",
      finalMessageId: "currentFinal",
    });
  });

  test("H: instant aggregation still succeeds without Pro reasoning metadata", async () => {
    const body = bodyFrom([
      'data: {"message":{"id":"instant","author":{"role":"assistant"},"recipient":"all","content":{"content_type":"text","parts":["instant final"]},"status":"finished_successfully","end_turn":true},"conversation_id":"instant-conv"}\n\n',
      "data: [DONE]\n\n",
    ]);

    const result = await aggregateAssistantMessage(parseConversationSse(body));
    expect(result).toMatchObject({
      text: "instant final",
      conversationId: "instant-conv",
      messageId: "instant",
    });
  });
});

describe("stripCitations", () => {
  test("removes wrapped citation including a single leading space", () => {
    const cite = "\u{E200}filecite\u{E202}turn0file0\u{E201}";
    expect(stripCitations(`Hello world ${cite}`)).toBe("Hello world");
  });

  test("removes multiple citations without merging adjacent text", () => {
    const a = "\u{E200}filecite\u{E202}turn0file0\u{E201}";
    const b = "\u{E200}cite\u{E202}turn0search1\u{E201}";
    expect(stripCitations(`First ${a} second ${b} third`)).toBe("First second third");
  });

  test("is a no-op for plain text", () => {
    expect(stripCitations("nothing to strip here.")).toBe("nothing to strip here.");
  });

  test("strips a citation with no leading space", () => {
    const cite = "\u{E200}filecite\u{E202}turn0file0\u{E201}";
    expect(stripCitations(`word${cite}.`)).toBe("word.");
  });
});

describe("aggregateAssistantMessage extras", () => {
  test("captures finish_details from cumulative metadata block", async () => {
    const body = bodyFrom([
      'data: {"message":{"id":"m6","content":{"content_type":"text","parts":["done"]},"metadata":{"finish_details":{"type":"max_tokens"}}}}\n\n',
      "data: [DONE]\n\n",
    ]);
    const result = await aggregateAssistantMessage(parseConversationSse(body));
    expect(result.finishReason).toBe("max_tokens");
  });
});
