#!/usr/bin/env node
/**
 * rosetta CLI — quick programmatic access to ChatGPT via an auth-holder
 * Chrome.
 *
 * Subcommands:
 *   run "<prompt>"              one-shot, default model gpt-5-3
 *   run --pro "<prompt>"        use gpt-5-5-pro (Pro thinking)
 *   run --model <slug> ...      explicit model slug
 *   run --recall [<thread>] ... thread into a persistent named context
 *   run --stream ...            print tokens as they arrive
 *   threads                     list persisted recall threads
 *   forget <thread>             clear a thread's persisted state
 *   probe                       list models exposed to this account
 *   help                        show this message
 *
 * Common flags:
 *   --port <n>       CDP debug port (default 9222)
 *   --host <h>       CDP debug host (default 127.0.0.1)
 */

import { parseArgs } from "node:util";
import {
  clearThread,
  fetchAvailableModels,
  listThreads,
  openSession,
  RosettaAuthError,
  RosettaRequestError,
  runConversation,
} from "../src/index.js";

const HELP = `rosetta — ChatGPT (Pro) programmatic CLI

Usage:
  rosetta run "<prompt>"               one-shot against the default model
  rosetta run --pro "<prompt>"         Pro thinking (gpt-5-5-pro)
  rosetta run --model <slug> "<p>"     explicit model slug
  rosetta run --recall <thread> "<p>"  thread into a persistent context
  rosetta run --stream "<prompt>"      stream tokens to stdout as they arrive
  rosetta threads                      list persisted recall threads
  rosetta forget <thread>              clear a thread's persisted state
  rosetta probe                        list models exposed to this account
  rosetta help                         show this message

Common flags:
  --port <n>   CDP debug port (default 9222)
  --host <h>   CDP debug host (default 127.0.0.1)

Setup:
  Launch Chrome with --remote-debugging-port and sign in to chatgpt.com once:

    chromium --remote-debugging-port=9222 \\
      --user-data-dir=$HOME/.rosetta/profile \\
      https://chatgpt.com/

  (On macOS use the path "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
   with --remote-debugging-port; on Windows use chrome.exe.)`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const sub = argv[0];

  if (!sub || sub === "help" || sub === "-h" || sub === "--help") {
    console.log(HELP);
    process.exit(sub ? 0 : 2);
  }

  if (sub === "run") {
    await cmdRun(argv.slice(1));
    return;
  }
  if (sub === "threads") {
    await cmdThreads();
    return;
  }
  if (sub === "forget") {
    const name = argv[1];
    if (!name) {
      console.error("forget: missing thread name");
      process.exit(2);
    }
    clearThread(name);
    console.log(`cleared thread: ${name}`);
    return;
  }
  if (sub === "probe") {
    await cmdProbe(argv.slice(1));
    return;
  }
  console.error(`unknown subcommand: ${sub}\n\n${HELP}`);
  process.exit(2);
}

async function cmdRun(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      port: { type: "string" },
      host: { type: "string" },
      model: { type: "string", short: "m" },
      pro: { type: "boolean" },
      recall: { type: "string" },
      stream: { type: "boolean" },
    },
    allowPositionals: true,
  });
  const prompt = positionals[0];
  if (!prompt) {
    console.error("run: missing prompt argument");
    process.exit(2);
  }
  const port = Number(values.port ?? 9222);
  const host = values.host ?? "127.0.0.1";
  const model = values.pro
    ? "gpt-5-5-pro"
    : (values.model ?? "gpt-5-3");
  const recall = values.recall;
  const stream = values.stream;

  const session = await openSession({ port, host });
  try {
    const startedAt = Date.now();
    let firstChunk = true;
    const result = await runConversation(
      session,
      {
        prompt,
        model,
        ...(recall ? { recall } : {}),
      },
      stream
        ? {
            onChunk: (delta) => {
              if (firstChunk) {
                firstChunk = false;
              }
              process.stdout.write(delta);
            },
          }
        : {},
    );
    if (stream) {
      process.stdout.write("\n");
    } else {
      process.stdout.write(`${result.text}\n`);
    }
    process.stderr.write(
      `[rosetta] ${result.modelSlug ?? model} ${Date.now() - startedAt}ms ` +
        `${result.eventCount} events conversation=${result.conversationId} message=${result.messageId}\n`,
    );
  } finally {
    await session.close();
  }
}

async function cmdThreads(): Promise<void> {
  const threads = listThreads();
  if (threads.length === 0) {
    console.log("(no persisted threads)");
    return;
  }
  for (const { name, state } of threads) {
    const ageMin = Math.round((Date.now() - state.updatedAt) / 60_000);
    console.log(
      `${name}\tconversation=${state.conversationId} message=${state.messageId} model=${state.model ?? "?"} updated=${ageMin}m ago`,
    );
  }
}

async function cmdProbe(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      port: { type: "string" },
      host: { type: "string" },
    },
    allowPositionals: false,
  });
  const port = Number(values.port ?? 9222);
  const host = values.host ?? "127.0.0.1";
  const session = await openSession({ port, host });
  try {
    const models = await fetchAvailableModels(session);
    const list = models.models ?? [];
    if (list.length === 0) {
      console.log("(no models returned)");
      return;
    }
    for (const m of list) {
      console.log(
        `${m.slug.padEnd(28)} ${m.title ?? ""}${m.tags?.length ? ` [${m.tags.join(",")}]` : ""}`,
      );
    }
    console.log(
      "\n(Pro slugs like gpt-5-5-pro are hidden from this list; pass --pro on `run`.)",
    );
  } finally {
    await session.close();
  }
}

main().catch((err: unknown) => {
  if (err instanceof RosettaAuthError) {
    console.error(`auth error [${err.code}]: ${err.message}${err.hint ? `\nhint: ${err.hint}` : ""}`);
    process.exit(1);
  }
  if (err instanceof RosettaRequestError) {
    console.error(
      `request error [${err.code}] HTTP ${err.status}: ${err.message}` +
        (err.bodySnippet ? `\nbody: ${err.bodySnippet.slice(0, 240)}` : ""),
    );
    process.exit(1);
  }
  console.error("fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
