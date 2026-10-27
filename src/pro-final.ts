/**
 * Minimal conversation-mapping shapes used to prove that a Pro turn has
 * actually finished. ChatGPT adds many unrelated fields to these objects; the
 * verifier deliberately ignores them.
 */
export interface ConversationMappingMessage {
  id?: string;
  author?: { role?: string };
  recipient?: string;
  create_time?: number;
  content?: { content_type?: string; parts?: unknown[] };
  status?: string;
  end_turn?: boolean | null;
  metadata?: {
    model_slug?: string;
    turn_exchange_id?: string;
    poll_interval_ms?: number;
    reasoning_status?: string;
    finish_details?: { type?: string };
  } & Record<string, unknown>;
}

export interface ConversationMappingNode {
  id?: string;
  parent?: string | null;
  children?: string[];
  message?: ConversationMappingMessage | null;
}

export type ConversationMapping = Record<string, ConversationMappingNode>;

export interface ProTurnCompletion {
  done: boolean;
  finalText?: string;
  finalMessageId?: string;
  modelSlug?: string;
  finishReason?: string;
  reason?: string;
}

type KeyedMessage = {
  key: string;
  message: ConversationMappingMessage;
};

/**
 * Decide whether one exact Pro turn has reached a trustworthy final state.
 *
 * Important: `end_turn`, `finished_successfully`, stream terminators, and
 * create_time ordering are not completion proof. Pro can emit several short
 * progress texts carrying both flags and then resume reasoning. The live
 * mapping observed in August 2026 instead has this structural contract:
 *
 *   ... reasoning nodes -> reasoning_recap(reasoning_ended)
 *       -> recipient=all text(finish_details.type=stop)
 *
 * We therefore require that topology and reject any candidate followed by (or
 * graph-incomparable with) an `is_reasoning` node from the same turn, regardless
 * of content type. An optional current_node mapping key can select between
 * completed branches, but cannot excuse unresolved reasoning on another branch.
 * Failing closed is intentional: an unverifiable response must not be
 * returned or persisted as though it were the final answer.
 */
export function evaluateProTurnCompletion(
  mapping: ConversationMapping,
  turnExchangeId: string,
  currentNodeKey?: string | null,
): ProTurnCompletion {
  if (!turnExchangeId) {
    return { done: false, reason: "missing turn_exchange_id" };
  }

  const turnMessages: KeyedMessage[] = [];
  for (const [key, node] of Object.entries(mapping)) {
    const message = node.message;
    if (!message || message.author?.role !== "assistant") continue;
    if (message.metadata?.turn_exchange_id !== turnExchangeId) continue;
    turnMessages.push({ key, message });
  }

  if (turnMessages.length === 0) {
    return { done: false, reason: "no assistant nodes for current turn_exchange_id" };
  }

  const reasoningEnded = turnMessages.filter(({ message }) =>
    message.content?.content_type === "reasoning_recap" &&
    message.recipient === "all" &&
    message.status === "finished_successfully" &&
    // The recap ends reasoning, not the turn. Since October 2026 the live
    // frontend marks it end_turn=false; the descendant final text below must
    // still carry end_turn=true.
    message.metadata?.reasoning_status === "reasoning_ended"
  );
  if (reasoningEnded.length === 0) {
    return { done: false, reason: "trusted reasoning_ended signal not present" };
  }

  const terminalTexts = turnMessages.filter(({ message }) => {
    const parts = message.content?.parts;
    const finishType = message.metadata?.finish_details?.type;
    return message.content?.content_type === "text" &&
      message.recipient === "all" &&
      message.status === "finished_successfully" &&
      message.end_turn === true &&
      // finish_details is absent entirely on minimal Pro turns (observed
      // 2026-08: trivial prompts produce end_turn=true + finished_successfully
      // with no finish_details object). Absent is fine; an explicit non-stop
      // type (max_tokens, …) still disqualifies.
      (finishType === "stop" || finishType === undefined) &&
      typeof message.id === "string" &&
      message.id.length > 0 &&
      Array.isArray(parts) &&
      typeof parts[0] === "string" &&
      parts[0].length > 0;
  });

  const afterReasoningEnded = terminalTexts.filter(({ key }) =>
    reasoningEnded.some((ended) => isDescendantOf(mapping, key, ended.key))
  );
  if (afterReasoningEnded.length === 0) {
    return {
      done: false,
      reason: "no terminal recipient=all text after trusted reasoning_ended",
    };
  }

  const activeReasoning = turnMessages.filter(({ message }) =>
    message.metadata?.reasoning_status === "is_reasoning"
  );

  // current_node is a selector, not completion evidence. Validate its branch
  // and only discount historical reasoning on other independently finished
  // branches. A stale pointer, unfinished sibling, or corrupt ancestry must
  // not turn a progress message into a final answer.
  const hasSelection = currentNodeKey !== undefined && currentNodeKey !== null;
  let candidates = afterReasoningEnded;
  if (hasSelection) {
    if (typeof currentNodeKey !== "string" || !hasValidAncestry(mapping, currentNodeKey)) {
      return { done: false, reason: "invalid current_node or ancestry" };
    }
    const completeLeaves = afterReasoningEnded.filter(({ key }) =>
      hasValidAncestry(mapping, key) &&
      !afterReasoningEnded.some((other) => isDescendantOf(mapping, other.key, key))
    );
    candidates = completeLeaves.filter(({ key }) => key === currentNodeKey);
    if (candidates.length !== 1) {
      return { done: false, reason: "current_node is not a verified terminal leaf for this turn" };
    }
    if (!activeReasoning.every((active) =>
      active.key !== currentNodeKey &&
      !isDescendantOf(mapping, active.key, currentNodeKey) &&
      completeLeaves.some((leaf) => isDescendantOf(mapping, leaf.key, active.key))
    )) {
      return { done: false, reason: "unresolved reasoning remains on selected or sibling branch" };
    }
  }

  const structurallySafe = candidates.filter((candidate) =>
    hasSelection || activeReasoning.every((active) => {
      if (isDescendantOf(mapping, candidate.key, active.key)) return true;
      // Active reasoning after the candidate is a definite early-preamble
      // signature. An incomparable same-turn branch is also not proof of
      // completion, so reject it conservatively.
      return false;
    })
  );
  if (structurallySafe.length === 0) {
    return {
      done: false,
      reason: "active or graph-incomparable reasoning remains for final text candidate",
    };
  }

  // Prefer the leaf-most safe terminal text by ancestry, never by create_time.
  // Multiple incomparable leaves mean the branch is ambiguous, so fail closed.
  const leafCandidates = structurallySafe.filter((candidate) =>
    !structurallySafe.some((other) =>
      other.key !== candidate.key && isDescendantOf(mapping, other.key, candidate.key)
    )
  );
  if (leafCandidates.length !== 1) {
    return {
      done: false,
      reason: `ambiguous terminal text branches (${leafCandidates.length})`,
    };
  }

  const finalCandidate = leafCandidates[0];
  if (!finalCandidate) {
    return { done: false, reason: "terminal text candidate disappeared" };
  }
  const parts = finalCandidate.message.content?.parts;
  const finalText = Array.isArray(parts) && typeof parts[0] === "string" ? parts[0] : "";
  const finalMessageId = finalCandidate.message.id;
  if (!finalMessageId || !finalText) {
    return { done: false, reason: "terminal text is missing id or content" };
  }

  return {
    done: true,
    finalText,
    finalMessageId,
    modelSlug: finalCandidate.message.metadata?.model_slug,
    finishReason: finalCandidate.message.metadata?.finish_details?.type,
  };
}

function hasValidAncestry(mapping: ConversationMapping, key: string): boolean {
  const seen = new Set<string>();
  let current: string | null | undefined = key;
  while (current !== null && current !== undefined) {
    if (!current || seen.has(current) || !Object.hasOwn(mapping, current)) return false;
    seen.add(current);
    const node: ConversationMappingNode | undefined = mapping[current];
    if (!node || (node.parent != null && typeof node.parent !== "string")) return false;
    current = node.parent;
  }
  return true;
}

function isDescendantOf(
  mapping: ConversationMapping,
  descendantKey: string,
  ancestorKey: string,
): boolean {
  if (descendantKey === ancestorKey) return false;
  const seen = new Set<string>();
  let currentKey: string | null | undefined = descendantKey;
  while (currentKey && !seen.has(currentKey)) {
    seen.add(currentKey);
    const parent: string | null | undefined = mapping[currentKey]?.parent;
    if (!parent) return false;
    if (parent === ancestorKey) return true;
    currentKey = parent;
  }
  return false;
}
