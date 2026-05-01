/**
 * @syntaxsmith/rosetta — Programmatic access to ChatGPT (incl. Pro) by
 * translating between an auth-holder Chrome page and a Node API.
 *
 * Public surface:
 *   - openSession(...)         → RosettaSession
 *   - runConversation(...)     → RunConversationResult
 *   - fetchAvailableModels(...)
 *   - thread state: loadThread / saveThread / clearThread / listThreads
 *   - errors:       RosettaAuthError, RosettaRequestError
 */
export { openSession, RosettaAuthError, type Logger, type OpenSessionInput } from "./auth.js";
export {
  runConversation,
  fetchAvailableModels,
  closeAllOpenTabs,
  RosettaRequestError,
  type RunConversationOptions,
} from "./client.js";
export {
  loadThread,
  saveThread,
  clearThread,
  listThreads,
  resolveThreadName,
  type ThreadState,
} from "./state.js";
export { getRosettaHomeDir, setHomeOverrideForTest } from "./home.js";
export type {
  ChromeClient,
} from "./chrome.js";
export type {
  RosettaSession,
  SessionMeta,
  RunConversationInput,
  RunConversationResult,
  HttpRequestInput,
  HttpResponse,
  ModelsResponse,
  SseEvent,
  SseMessageFrame,
  SsePatchFrame,
  Attachment,
} from "./types.js";
export {
  parseConversationSse,
  aggregateAssistantMessage,
  stripCitations,
} from "./sse.js";
export {
  RosettaUploadError,
  MAX_DATA_TRANSFER_BYTES,
} from "./upload.js";
