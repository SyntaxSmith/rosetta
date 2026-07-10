---
name: rosetta-consult
description: Call ChatGPT Pro via the rosetta MCP `consult` tool. Use when you want a second opinion or stronger reasoning than your own — hard math/proofs/algorithms, design cross-checks, brainstorming — or long-running research context across calls (recall). Everything runs on Pro by default; that's the point of rosetta. Tool surfaces as `mcp__rosetta__consult`.
---

# rosetta-consult

Tool: `mcp__rosetta__consult` (one tool, returns assistant text only — no files, no images).

## Model selection (2026-07, GPT-5.6 "Sol" lineup)

**Default is `gpt-5-6-pro` (Pro) — use it for everything.** rosetta exists precisely for Pro access; if a task doesn't merit Pro, it usually shouldn't go through rosetta at all (answer it yourself or use codex). Don't downgrade the model to "save" anything.

- Non-Pro slugs (`gpt-5-6-thinking`, `gpt-5-6`, `gpt-5-5`) exist via `model`, but only pass them when the user explicitly asks for a cheaper/faster tier.
- `thinkingEffort`: `"standard" | "extended" | "max"` — the web UI's 中/高/极高 lanes are `gpt-5-6-thinking` with these three values. Omit to use the model's natural default.

## When to call

- Hard reasoning, math derivations, proof checks, tricky algorithm design → default Pro (30 s – 15 min, blocks the call).
- Brainstorming, design alternatives, naming, writing feedback → default Pro too; Pro's breadth is what you're paying the latency for.
- Cross-checking your own answer when stakes are high → default Pro.
- Long-running research context that must survive across tool calls / MCP restarts → `recall: "<topic>"` (disk-persisted thread at `~/.rosetta/state.json`).

## When NOT to call

- Anything you can answer correctly yourself — consult costs a Chrome tab + focus mutex and slows down parallel work.
- Code edits, file ops, running commands — consult only returns text.
- A back-and-forth chat — each call is a one-shot Q→A; structure your prompts so a single answer is useful.

## Threading model

Each MCP server process is one implicit conversation. Back-to-back `consult` calls in the same Claude Code session keep multi-turn context automatically. Knobs:

- default (no flags) → continue the implicit session conversation.
- `fresh: true` → start a new conversation (becomes the new session default). Use when switching topic so prior context doesn't bleed.
- `recall: "<name>"` → ignore implicit session, route through a named disk-persisted thread. Different names = parallel contexts that survive restarts.
- `fresh: true` + `recall: "<name>"` → reset that named thread.

## Prompt patterns

- **Pro reasoning**: include the full problem statement, the constraints, and what kind of answer you want (proof? plan? code sketch?). Pro thinks harder when goals are explicit.
- **Cross-check**: paste your candidate answer + ask "find errors or confirm correctness, be specific."
- **Recall thread**: first call sets context ("we're working on X, here's the setup"); subsequent calls assume prior turns are remembered — don't re-paste.

## Prerequisite

Chrome must already be running with `--remote-debugging-port=9222 --user-data-dir=$HOME/.rosetta/profile` and signed in to chatgpt.com. If consult returns `auth error [not-logged-in]`, the user needs to start/sign in to that Chrome — don't retry blindly.
