import { describe, expect, test } from "vitest";
import { evaluateProTurnCompletion, type ConversationMapping } from "../src/pro-final.js";

const turn = "current-turn";
function branch(prefix: string): ConversationMapping {
  const node = (id: string, parent: string | null, type: string, reasoning?: string) => ({
    parent,
    message: {
      id, author: { role: "assistant" }, recipient: "all",
      status: "finished_successfully", end_turn: type === "text",
      content: { content_type: type, parts: type === "text" ? [`answer ${prefix}`] : [] },
      metadata: { turn_exchange_id: turn, reasoning_status: reasoning },
    },
  });
  return {
    [`${prefix}-thought`]: node(`${prefix}-thought`, null, "thoughts", "is_reasoning"),
    [`${prefix}-recap`]: node(`${prefix}-recap`, `${prefix}-thought`, "reasoning_recap", "reasoning_ended"),
    [`${prefix}-final`]: node(`${prefix}-final`, `${prefix}-recap`, "text"),
  };
}

describe("reasoning state and selected completion branches", () => {
  test.each(["reasoning", "future_node", "text"])("rejects resumed %s reasoning", (type) => {
    const mapping = branch("a");
    mapping.resumed = structuredClone(mapping["a-thought"]!);
    mapping.resumed.parent = "a-final";
    mapping.resumed.message!.content!.content_type = type;
    expect(evaluateProTurnCompletion(mapping, turn).done).toBe(false);
    expect(evaluateProTurnCompletion(mapping, turn, "a-final").done).toBe(false);
  });

  test("unknown reasoning before the completed answer remains valid", () => {
    const mapping = branch("a");
    mapping["a-thought"]!.message!.content!.content_type = "future_node";
    expect(evaluateProTurnCompletion(mapping, turn).done).toBe(true);
  });

  test.each(["a", "b"])("selects completed branch %s including historical sibling reasoning", (selected) => {
    const mapping = { ...branch("a"), ...branch("b") };
    expect(evaluateProTurnCompletion(mapping, turn).done).toBe(false);
    expect(evaluateProTurnCompletion(mapping, turn, `${selected}-final`)).toMatchObject({
      done: true, finalText: `answer ${selected}`, finalMessageId: `${selected}-final`,
    });
  });

  test("selects among branches without historical reasoning nodes too", () => {
    const mapping = { ...branch("a"), ...branch("b") };
    for (const prefix of ["a", "b"]) {
      mapping[`${prefix}-thought`]!.message!.metadata!.reasoning_status = undefined;
    }
    expect(evaluateProTurnCompletion(mapping, turn).reason).toContain("ambiguous");
    expect(evaluateProTurnCompletion(mapping, turn, "b-final").done).toBe(true);
  });

  test.each(["missing", "", "a-thought", "a-recap"])("rejects invalid selection %s", (key) => {
    expect(evaluateProTurnCompletion(branch("a"), turn, key).done).toBe(false);
  });

  test("rejects a pointer to another turn", () => {
    const mapping = { ...branch("a"), ...branch("b") };
    for (const [key, node] of Object.entries(mapping)) {
      if (key.startsWith("b")) node.message!.metadata!.turn_exchange_id = "other-turn";
    }
    expect(evaluateProTurnCompletion(mapping, turn, "b-final").done).toBe(false);
  });

  test.each(["missing-parent", "a-final"])("rejects broken/cyclic ancestry: %s", (parent) => {
    const mapping = branch("a");
    mapping["a-thought"]!.parent = parent;
    expect(evaluateProTurnCompletion(mapping, turn, "a-final").done).toBe(false);
  });

  test("rejects unfinished sibling reasoning even with a valid selection", () => {
    const mapping = { ...branch("a"), ...branch("b") };
    delete mapping["b-final"];
    expect(evaluateProTurnCompletion(mapping, turn, "a-final").done).toBe(false);
  });

  test("rejects resumed reasoning after an otherwise completed sibling", () => {
    const mapping = { ...branch("a"), ...branch("b") };
    mapping.resumed = structuredClone(mapping["b-thought"]!);
    mapping.resumed.parent = "b-final";
    expect(evaluateProTurnCompletion(mapping, turn, "a-final").done).toBe(false);
  });

  test("a stale pointer cannot select a non-leaf answer", () => {
    const mapping = { ...branch("a"), ...branch("b") };
    mapping["b-thought"]!.parent = "a-final";
    expect(evaluateProTurnCompletion(mapping, turn, "a-final").done).toBe(false);
    expect(evaluateProTurnCompletion(mapping, turn, "b-final").done).toBe(true);
  });

  test.each(["unfinished", "truncated", "empty", "no-recap"])("selection cannot override %s", (kind) => {
    const mapping = branch("a");
    const final = mapping["a-final"]!.message!;
    if (kind === "unfinished") final.end_turn = false;
    if (kind === "truncated") final.metadata!.finish_details = { type: "max_tokens" };
    if (kind === "empty") final.content!.parts = [""];
    if (kind === "no-recap") mapping["a-recap"]!.message!.metadata!.reasoning_status = undefined;
    expect(evaluateProTurnCompletion(mapping, turn, "a-final").done).toBe(false);
  });
});
