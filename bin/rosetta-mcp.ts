#!/usr/bin/env node
/**
 * rosetta-mcp — Model Context Protocol server for rosetta.
 *
 * Speaks MCP over stdio. Exposes a `consult` tool that runs a one-shot or
 * recall-threaded conversation against ChatGPT (instant or Pro) and returns
 * the assistant's text. Designed to be registered in Claude Code, Codex CLI,
 * Cline, or any other MCP-aware host.
 *
 * Configuration via environment variables:
 *   ROSETTA_CDP_PORT  — CDP debug port of the auth-holder Chrome (default 9222)
 *   ROSETTA_CDP_HOST  — CDP debug host (default 127.0.0.1)
 *
 * Tool schema:
 *   consult({ prompt, pro?, model?, recall?, parentMessageId?, conversationId? })
 *     → text
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  openSession,
  RosettaAuthError,
  RosettaRequestError,
  runConversation,
} from "../src/index.js";

const SERVER_NAME = "rosetta";
const SERVER_VERSION = "0.1.0";

const port = Number(process.env["ROSETTA_CDP_PORT"] ?? 9222);
const host = process.env["ROSETTA_CDP_HOST"] ?? "127.0.0.1";

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
      "on the prompt; the call blocks until the answer streams back.",
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
      recall: z
        .union([z.boolean(), z.string()])
        .optional()
        .describe(
          "Thread the call into a persistent conversation. `true` = default thread; " +
            "string = named thread (multiple parallel contexts).",
        ),
      conversationId: z
        .string()
        .optional()
        .describe("Continue an explicit ChatGPT conversation by id."),
      parentMessageId: z
        .string()
        .optional()
        .describe("Branch from a specific message id (advanced)."),
    },
  },
  async (args) => {
    const session = await openSession({ port, host });
    try {
      const model = args.model ?? (args.pro ? "gpt-5-5-pro" : "gpt-5-3");
      const result = await runConversation(session, {
        prompt: args.prompt,
        model,
        ...(args.recall !== undefined ? { recall: args.recall } : {}),
        ...(args.conversationId ? { conversationId: args.conversationId } : {}),
        ...(args.parentMessageId ? { parentMessageId: args.parentMessageId } : {}),
      });
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
      await session.close();
    }
  },
);

await server.connect(new StdioServerTransport());
