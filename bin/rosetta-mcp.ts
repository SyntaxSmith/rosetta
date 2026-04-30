#!/usr/bin/env node
/**
 * rosetta-mcp — Model Context Protocol server for rosetta.
 *
 * Speaks MCP over stdio. Exposes a `consult` tool that runs a one-shot or
 * recall-threaded conversation against ChatGPT (instant or Pro) and returns
 * the assistant's text. Designed to be registered in Claude Code, Codex CLI,
 * Cline, or any other MCP-aware host.
 *
 * # Conversation model
 *
 * Each `rosetta-mcp` process IS one conversation by default — equivalent to
 * a single chatgpt.com tab where you keep typing into the same chat. The
 * server holds the current `(conversationId, messageId)` in memory so back-
 * to-back `consult` calls automatically thread together. When the host
 * (Claude Code, Codex, Cline, …) shuts the server down, the in-memory
 * conversation is gone — restart = clean slate.
 *
 * Tool args control deviations from that default:
 *   - `fresh: true`           → abandon the current session conversation, start
 *                               a new one (which becomes the new session default).
 *                               Like clicking "New chat" on chatgpt.com.
 *   - `recall: "<name>"`      → ignore session, route this call through a
 *                               disk-persisted named thread (`~/.rosetta/state.json`).
 *                               Use for long-lived contexts that must survive
 *                               MCP server restarts. Multiple distinct names
 *                               coexist as parallel contexts.
 *   - `fresh: true` + `recall: "<name>"` → reset that named thread, start over.
 *
 * # Configuration via env
 *   ROSETTA_CDP_PORT  — CDP debug port of the auth-holder Chrome (default 9222)
 *   ROSETTA_CDP_HOST  — CDP debug host (default 127.0.0.1)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  clearThread,
  openSession,
  RosettaAuthError,
  RosettaRequestError,
  runConversation,
  type RunConversationInput,
} from "../src/index.js";

const SERVER_NAME = "rosetta";
const SERVER_VERSION = "0.1.0";

const port = Number(process.env["ROSETTA_CDP_PORT"] ?? 9222);
const host = process.env["ROSETTA_CDP_HOST"] ?? "127.0.0.1";

// Per-MCP-server-process conversation pointer. Lives in memory only —
// process exit = clean reset. Cross-process persistence is opt-in via the
// `recall: "<name>"` arg, which routes to ~/.rosetta/state.json instead.
let sessionConvId: string | undefined;
let sessionMsgId: string | undefined;

const server = new McpServer({
  name: SERVER_NAME,
  version: SERVER_VERSION,
});

server.registerTool(
  "consult",
  {
    description:
      "Send a prompt to ChatGPT (instant or Pro) via a logged-in Chrome and " +
      "return the assistant's text. Pro thinking can take 30s–15min depending " +
      "on the prompt; the call blocks until the answer streams back.\n\n" +
      "By default, successive calls in the same MCP session continue the same " +
      "conversation (multi-turn context retained). Pass `fresh: true` to start " +
      "a new conversation, or `recall: \"<name>\"` to use a disk-persisted " +
      "thread that survives process restarts.",
    inputSchema: {
      prompt: z.string().min(1).describe("The user prompt to send to ChatGPT."),
      pro: z
        .boolean()
        .optional()
        .describe(
          "Use ChatGPT Pro (gpt-5-5-pro) with extended thinking. Slower but more capable.",
        ),
      model: z
        .string()
        .optional()
        .describe(
          "Explicit model slug (overrides `pro`). E.g. `gpt-5-3` (instant), `gpt-5-5-pro` (Pro).",
        ),
      fresh: z
        .boolean()
        .optional()
        .describe(
          "Abandon the current session conversation and start a new one. The new " +
            "conversation becomes the session default for subsequent calls. Combine " +
            "with `recall` to reset that named thread instead.",
        ),
      recall: z
        .string()
        .optional()
        .describe(
          "Use a disk-persisted named thread (survives MCP server restarts). " +
            "Different names coexist as independent parallel contexts. Omit to use " +
            "the current MCP session's in-memory conversation.",
        ),
      conversationId: z
        .string()
        .optional()
        .describe("Continue an explicit ChatGPT conversation by id (advanced; overrides session/recall)."),
      parentMessageId: z
        .string()
        .optional()
        .describe("Branch from a specific message id (advanced)."),
    },
  },
  async (args) => {
    const cdp = await openSession({ port, host });
    try {
      const model = args.model ?? (args.pro ? "gpt-5-5-pro" : "gpt-5-3");
      const usingNamedThread = typeof args.recall === "string" && args.recall.length > 0;

      // If `fresh` is set, wipe whichever thread we'd otherwise carry forward.
      if (args.fresh) {
        if (usingNamedThread) {
          clearThread(args.recall as string);
        } else {
          sessionConvId = undefined;
          sessionMsgId = undefined;
        }
      }

      // Build runConversation input. Three branches:
      //   1. Named cross-session thread → delegate everything to runConversation's
      //      `recall` machinery (it'll load + save to disk, auto-keepConversation).
      //   2. Implicit MCP session thread → pass conversationId/parentMessageId by
      //      hand from in-memory state; capture the result back into module scope.
      //   3. Caller explicitly pinned conversationId/parentMessageId → those win.
      const runInput: RunConversationInput = {
        prompt: args.prompt,
        model,
      };
      let isSessionThread = false;
      if (usingNamedThread) {
        runInput.recall = args.recall as string;
      } else {
        isSessionThread = true;
        if (sessionConvId && sessionMsgId) {
          runInput.conversationId = sessionConvId;
          runInput.parentMessageId = sessionMsgId;
        }
      }
      if (args.conversationId) runInput.conversationId = args.conversationId;
      if (args.parentMessageId) runInput.parentMessageId = args.parentMessageId;

      const result = await runConversation(cdp, runInput, {
        // Always keep the conversation alive — both named threads and the
        // session thread want to chain into future calls.
        keepConversation: true,
      });

      // Update the in-memory session pointer if this call participated in
      // the session thread. Named-thread persistence is handled by
      // runConversation itself.
      if (isSessionThread && result.conversationId && result.messageId) {
        sessionConvId = result.conversationId;
        sessionMsgId = result.messageId;
      }

      return {
        content: [
          {
            type: "text" as const,
            text: result.text,
          },
        ],
        structuredContent: {
          text: result.text,
          conversationId: result.conversationId,
          messageId: result.messageId,
          modelSlug: result.modelSlug ?? model,
          finishReason: result.finishReason ?? "",
          tookMs: result.tookMs,
          eventCount: result.eventCount,
          threadKind: usingNamedThread ? ("named" as const) : ("session" as const),
          threadName: usingNamedThread ? args.recall : undefined,
        },
      };
    } catch (err) {
      const message =
        err instanceof RosettaAuthError
          ? `auth error [${err.code}]: ${err.message}${err.hint ? `\nhint: ${err.hint}` : ""}`
          : err instanceof RosettaRequestError
            ? `request error [${err.code}] HTTP ${err.status}: ${err.message}` +
              (err.bodySnippet ? `\nbody: ${err.bodySnippet.slice(0, 240)}` : "")
            : err instanceof Error
              ? err.message
              : String(err);
      return {
        content: [{ type: "text" as const, text: message }],
        isError: true,
      };
    } finally {
      await cdp.close();
    }
  },
);

await server.connect(new StdioServerTransport());
