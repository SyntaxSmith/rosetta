/**
 * Ranked list of CSS selectors used to locate ChatGPT's hidden `<input type="file">`
 * element in the composer. The page may expose multiple file-input nodes (avatar
 * uploader, message attach, etc.); the most specific selectors come first so we
 * attach to the composer's primary dropzone rather than a stray input elsewhere
 * on the page.
 *
 * Ported from oracle (predecessor project) — battle-tested across 2024-2026
 * ChatGPT DOM revisions.
 */
export const FILE_INPUT_SELECTORS = [
  'form input[type="file"]:not([accept])',
  'input[type="file"][multiple]:not([accept])',
  'input[type="file"][multiple]',
  'input[type="file"]:not([accept])',
  'form input[type="file"][accept]',
  'input[type="file"][accept]',
  'input[type="file"]',
  'input[type="file"][data-testid*="file"]',
] as const;

/**
 * Selectors that, when matched against an element with `data-state=uploading`
 * / `loading` / `pending` (or `aria-busy=true`, or visible "Uploading…" /
 * "Processing…" text), indicate ChatGPT's upload pipeline hasn't finished
 * yet. We wait for these to clear before declaring the attachment ready —
 * otherwise the send button stays disabled and typing-then-send races into
 * "Send button never became enabled" territory.
 *
 * Ported from oracle.
 */
export const UPLOAD_STATUS_SELECTORS = [
  '[data-testid*="upload"]',
  '[data-testid*="attachment"]',
  '[data-testid*="progress"]',
  '[data-state="loading"]',
  '[data-state="uploading"]',
  '[data-state="pending"]',
  '[aria-live="polite"]',
  '[aria-live="assertive"]',
] as const;
