import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getRosettaHomeDir } from "./home.js";

/**
 * Persistent per-thread conversation pointer.
 *
 * Each "thread" is a stable name (default: `default`) that maps to one
 * server-side ChatGPT conversation. When `runConversation` is called with
 * `recall`, we look up the thread's last `conversationId` + `messageId` and
 * thread the new turn into the same conversation — so successive invocations
 * build on the same context instead of starting fresh each time.
 *
 * Storage: a single JSON file at `<rosettaHome>/state.json`. Tiny, atomic
 * write, sync (we only write one entry per `runConversation`).
 */
export interface ThreadState {
  conversationId: string;
  messageId: string;
  model?: string;
  /** Unix ms — useful for TTL/eviction policies callers might want later. */
  updatedAt: number;
}

interface StateFile {
  version: 1;
  threads: Record<string, ThreadState>;
}

const FILE_NAME = "state.json";

function statePath(): string {
  return path.join(getRosettaHomeDir(), FILE_NAME);
}

function readAll(): StateFile {
  try {
    const raw = readFileSync(statePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<StateFile>;
    if (parsed.version === 1 && parsed.threads && typeof parsed.threads === "object") {
      return parsed as StateFile;
    }
  } catch {
    // missing / malformed — start fresh
  }
  return { version: 1, threads: {} };
}

function writeAll(file: StateFile): void {
  const dir = getRosettaHomeDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(statePath(), JSON.stringify(file, null, 2));
}

/**
 * Resolve a `recall` value to a thread name. `true` → "default", string →
 * the string. Returns `undefined` if recall is disabled (`false` / undefined).
 */
export function resolveThreadName(
  recall: boolean | string | undefined,
): string | undefined {
  if (recall === true) return "default";
  if (typeof recall === "string" && recall.length > 0) return recall;
  return undefined;
}

export function loadThread(name: string): ThreadState | undefined {
  return readAll().threads[name];
}

export function saveThread(name: string, state: ThreadState): void {
  const all = readAll();
  all.threads[name] = state;
  writeAll(all);
}

export function clearThread(name: string): void {
  const all = readAll();
  if (all.threads[name]) {
    delete all.threads[name];
    writeAll(all);
  }
}

export function listThreads(): Array<{ name: string; state: ThreadState }> {
  const all = readAll();
  return Object.entries(all.threads).map(([name, state]) => ({ name, state }));
}
