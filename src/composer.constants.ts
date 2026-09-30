// The September 2026 composer uses a form marker instead of prompt-textarea
// and send/stop test IDs. Keep the selectors shared by sending and uploads.
export const COMPOSER_EDITOR_SELECTOR =
  '[data-chatgpt-composer] [contenteditable="true"], div#prompt-textarea, [contenteditable="true"]';

// The submit type identifies send independently of the UI language. Voice and
// dictation controls in the same form have type="button".
export const SEND_BUTTON_SELECTOR =
  '[data-chatgpt-composer] button[type="submit"], button[data-testid="send-button"]';

export const STOP_BUTTON_SELECTOR =
  '[data-chatgpt-composer] button[aria-label="停止"], button[data-testid="stop-button"]';
