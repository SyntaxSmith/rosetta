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
- Routine questions that do not benefit from an external second opinion.

## Threading model

Each MCP server process is one implicit conversation. Back-to-back `consult`
calls in the same host agent keep multi-turn context automatically.

- **Default (no threading flags) → continue the implicit session conversation.**
  Prefer this aggressively: follow-up questions, revisions, new evidence, related
  subtasks, alternative designs, and critique of an earlier answer all belong in
  the existing conversation. Do not pass `fresh` merely because the next prompt
  is self-contained or because this is another tool call.
- `fresh: true` → start a new conversation, which becomes the new session
  default. Use it only when at least one of these is true:
  1. the problem is genuinely unrelated and earlier context has no value;
  2. an independent adversarial/zero-context assessment is required;
  3. the current conversation is already very long, confused, or contaminated;
  4. the user explicitly asks for a new conversation.
- `recall: "<name>"` → ignore implicit session, route through a named disk-persisted thread. Different names = parallel contexts that survive restarts.
- `fresh: true` + `recall: "<name>"` → reset that named thread.

The implicit conversation is scoped to one MCP server process. Codex
subagents/agent threads may each own a different process even when they belong
to the same user task. When context must cross agent boundaries, host restarts,
or separate sessions, choose one stable descriptive `recall` name and reuse it;
do not compensate by repeatedly creating fresh conversations.

## Prompt patterns

- **Pro reasoning**: include the full problem statement, the constraints, and what kind of answer you want (proof? plan? code sketch?). Pro thinks harder when goals are explicit.
- **Cross-check**: paste your candidate answer + ask "find errors or confirm correctness, be specific."
- **Recall thread**: first call sets context ("we're working on X, here's the setup"); subsequent calls assume prior turns are remembered — don't re-paste.

## Response integrity

- Rosetta is expected to block until the backend Pro turn is verifiably complete. A short preamble or stage summary that plainly fails the requested output contract must be treated as **incomplete**, even if it looks polished or carries success-like metadata.
- Do not send a follow-up into that conversation until the original backend turn is confirmed complete. Report the incomplete/error state first; a follow-up can otherwise branch from an internal thoughts/code node and contaminate the named thread.
- This is a defensive caller check, not the completion mechanism. MCP transport and conversation-mapping verification remain responsible for returning only the full final answer.

## Prerequisite

Chrome must already be running with `--remote-debugging-port=9222 --user-data-dir=$HOME/.rosetta/profile` and signed in to chatgpt.com. If consult returns `auth error [not-logged-in]`, the user needs to start/sign in to that Chrome — don't retry blindly.
