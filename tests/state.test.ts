import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  clearThread,
  listThreads,
  loadThread,
  resolveThreadName,
  saveThread,
} from "../src/state.js";
import { setHomeOverrideForTest } from "../src/home.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), "rosetta-test-"));
  setHomeOverrideForTest(tempDir);
});
afterEach(() => {
  setHomeOverrideForTest(null);
});

describe("resolveThreadName", () => {
  test("true → default", () => {
    expect(resolveThreadName(true)).toBe("default");
  });
  test("string → string", () => {
    expect(resolveThreadName("research")).toBe("research");
  });
  test("false → undefined", () => {
    expect(resolveThreadName(false)).toBeUndefined();
  });
  test("undefined → undefined", () => {
    expect(resolveThreadName(undefined)).toBeUndefined();
  });
  test("empty string → undefined", () => {
    expect(resolveThreadName("")).toBeUndefined();
  });
});

describe("thread persistence", () => {
  test("load returns undefined when nothing saved", () => {
    expect(loadThread("default")).toBeUndefined();
  });

  test("save then load round-trips", () => {
    saveThread("default", {
      conversationId: "c-1",
      messageId: "m-1",
      model: "gpt-5-5-pro",
      updatedAt: 1234567890,
    });
    expect(loadThread("default")).toEqual({
      conversationId: "c-1",
      messageId: "m-1",
      model: "gpt-5-5-pro",
      updatedAt: 1234567890,
    });
  });

  test("multiple threads coexist", () => {
    saveThread("a", { conversationId: "c-a", messageId: "m-a", updatedAt: 1 });
    saveThread("b", { conversationId: "c-b", messageId: "m-b", updatedAt: 2 });
    expect(loadThread("a")?.conversationId).toBe("c-a");
    expect(loadThread("b")?.conversationId).toBe("c-b");
    expect(listThreads().map((t) => t.name).sort()).toEqual(["a", "b"]);
  });

  test("save overwrites previous state for same name", () => {
    saveThread("x", { conversationId: "old", messageId: "old", updatedAt: 1 });
    saveThread("x", { conversationId: "new", messageId: "new", updatedAt: 2 });
    expect(loadThread("x")?.conversationId).toBe("new");
  });

  test("clearThread removes only the named thread", () => {
    saveThread("keep", { conversationId: "ck", messageId: "mk", updatedAt: 1 });
    saveThread("drop", { conversationId: "cd", messageId: "md", updatedAt: 2 });
    clearThread("drop");
    expect(loadThread("drop")).toBeUndefined();
    expect(loadThread("keep")?.conversationId).toBe("ck");
  });

  test("clearThread on missing name is a no-op", () => {
    expect(() => clearThread("nothing-here")).not.toThrow();
  });
});
