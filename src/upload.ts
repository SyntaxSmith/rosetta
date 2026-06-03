import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ChromeClient } from "./chrome.js";
import type { Attachment } from "./types.js";
import { FILE_INPUT_SELECTORS, UPLOAD_STATUS_SELECTORS } from "./upload.constants.js";

/** Soft cap on per-file size for in-page DataTransfer injection (20 MB raw). */
export const MAX_DATA_TRANSFER_BYTES = 20 * 1024 * 1024;

/** Default time we'll wait for the page's React pipeline to render a chip naming the file. */
const DEFAULT_ATTACHMENT_READY_TIMEOUT_MS = 60_000;

/**
 * How long to wait for ChatGPT's composer to wire its file-input `onChange`
 * handler before we set files on the input.
 *
 * This gate is load-bearing (reverse-engineered 2026-06): the composer's file
 * input element exists in the DOM ~0.5–1 s *before* React attaches the change
 * handler that drives the message-attachment upload. If we set files in that
 * window, React routes the file to the `/backend-api/files/library` endpoint
 * (the persistent "file library", not a chat attachment) — no chip renders, the
 * outgoing /f/conversation body carries no file reference, and the model never
 * sees the file. Worse, this mis-route is UNRECOVERABLE for the page load:
 * re-setting (even after clearing the input) never re-triggers the proper
 * pipeline; only a reload fixes it. So we must not set until the handler is up.
 * The delay is variable (not a fixed settle), so we poll for the handler rather
 * than sleeping a magic constant.
 */
const COMPOSER_UPLOAD_READY_TIMEOUT_MS = 15_000;

export class RosettaUploadError extends Error {
  constructor(
    message: string,
    public readonly code: "upload-failed" | "upload-timeout",
    public readonly attachmentPath: string,
  ) {
    super(message);
    this.name = "RosettaUploadError";
  }
}

/**
 * Inject a local file into ChatGPT's hidden `<input type="file">` so the page's
 * existing React upload pipeline runs end-to-end. Reads the file in Node,
 * base64-encodes it, then evals JS that decodes back to bytes, builds a `File`,
 * and assigns it to the input via three fallback strategies (prototype
 * descriptor → `defineProperty` getter → direct), defeating React's locked-down
 * inputs. Dispatches `change` so the page picks up the new value.
 *
 * Approach ported from oracle's `attachmentDataTransfer.ts` — same fallback
 * ladder, same 20 MB cap.
 */
export async function transferAttachmentViaDataTransfer(
  runtime: ChromeClient["Runtime"],
  attachment: Attachment,
  selector: string,
): Promise<{ fileName: string; size: number }> {
  const fileContent = await readFile(attachment.path);
  if (fileContent.length > MAX_DATA_TRANSFER_BYTES) {
    throw new RosettaUploadError(
      `Attachment ${path.basename(attachment.path)} is too large for data transfer (${fileContent.length} bytes). Maximum size is ${MAX_DATA_TRANSFER_BYTES} bytes.`,
      "upload-failed",
      attachment.path,
    );
  }

  const base64Content = fileContent.toString("base64");
  const fileName = path.basename(attachment.path);
  const mimeType = attachment.mimeType ?? guessMimeType(fileName);

  const expression = `(() => {
    if (!('File' in window) || !('Blob' in window) || !('DataTransfer' in window) || typeof atob !== 'function') {
      return { success: false, error: 'Required file APIs are not available in this browser' };
    }

    const fileInput = document.querySelector(${JSON.stringify(selector)});
    if (!fileInput) {
      return { success: false, error: 'File input not found' };
    }
    if (!(fileInput instanceof HTMLInputElement) || fileInput.type !== 'file') {
      return { success: false, error: 'Found element is not a file input' };
    }

    const base64Data = ${JSON.stringify(base64Content)};
    const binaryString = atob(base64Data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const blob = new Blob([bytes], { type: ${JSON.stringify(mimeType)} });

    const file = new File([blob], ${JSON.stringify(fileName)}, {
      type: ${JSON.stringify(mimeType)},
      lastModified: Date.now(),
    });

    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    let assigned = false;

    const proto = Object.getPrototypeOf(fileInput);
    const descriptor = proto ? Object.getOwnPropertyDescriptor(proto, 'files') : null;
    if (descriptor && descriptor.set) {
      try {
        descriptor.set.call(fileInput, dataTransfer.files);
        assigned = true;
      } catch (_e) {
        assigned = false;
      }
    }
    if (!assigned) {
      try {
        Object.defineProperty(fileInput, 'files', {
          configurable: true,
          get: function () { return dataTransfer.files; },
        });
        assigned = true;
      } catch (_e) {
        assigned = false;
      }
    }
    if (!assigned) {
      try {
        fileInput.files = dataTransfer.files;
        assigned = true;
      } catch (_e) {
        assigned = false;
      }
    }
    if (!assigned) {
      return { success: false, error: 'Unable to assign FileList to input' };
    }

    fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    return { success: true, fileName: file.name, size: file.size };
  })()`;

  const evalResult = await runtime.evaluate({ expression, returnByValue: true });
  if (evalResult.exceptionDetails) {
    throw new RosettaUploadError(
      `CDP eval threw while transferring file: ${evalResult.exceptionDetails.text ?? "unknown"}`,
      "upload-failed",
      attachment.path,
    );
  }
  const value = evalResult.result?.value as
    | { success?: boolean; error?: string; fileName?: string; size?: number }
    | undefined;
  if (!value || typeof value !== "object") {
    throw new RosettaUploadError(
      "CDP eval returned an unexpected value while transferring file",
      "upload-failed",
      attachment.path,
    );
  }
  if (!value.success) {
    throw new RosettaUploadError(
      `Failed to transfer file to browser: ${value.error ?? "Unknown error"}`,
      "upload-failed",
      attachment.path,
    );
  }

  return {
    fileName: value.fileName ?? fileName,
    size: typeof value.size === "number" ? value.size : fileContent.length,
  };
}

/**
 * Search the page for a usable file-input element by trying the ranked
 * `FILE_INPUT_SELECTORS` list in order. Returns the first selector that
 * matches a real `<input type="file">` element on the page, or `null` if
 * none of them resolve.
 */
export async function findFileInputSelector(
  runtime: ChromeClient["Runtime"],
): Promise<string | null> {
  const expression = `(() => {
    const selectors = ${JSON.stringify(FILE_INPUT_SELECTORS)};
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.tagName === 'INPUT' && el.type === 'file') {
        return sel;
      }
    }
    return null;
  })()`;
  const r = await runtime.evaluate({ expression, returnByValue: true });
  const v = r.result?.value;
  return typeof v === "string" ? v : null;
}

/**
 * Poll the page until ChatGPT renders an attachment "chip" that actually NAMES
 * the uploaded file, with no in-flight uploading/processing indicator. A chip
 * bearing the filename is the strongest drift-resistant signal that React's
 * upload pipeline ran end-to-end — the previous "any element matching a broad
 * selector" heuristic false-positived (it matched unrelated nodes), so a total
 * upload failure looked "ready" and we sent a message with no file attached.
 *
 * We deliberately do NOT require `input.files` to still hold the file: ChatGPT
 * clears the input after consuming the change event (so the same file can be
 * re-picked), so a non-empty `input.files` is neither necessary nor reliable
 * post-upload.
 *
 * Times out as `upload-timeout` if no named chip appears in `timeoutMs`.
 */
export async function waitForAttachmentReady(
  runtime: ChromeClient["Runtime"],
  attachment: Attachment,
  fileName: string,
  timeoutMs: number = DEFAULT_ATTACHMENT_READY_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const tickMs = 250;
  const stableMs = 800;
  let firstSeenAt: number | null = null;

  // Two signals, stable for >= stableMs:
  //   (1) chipNamed — a visible, reasonably-small element whose text contains
  //       the filename (or its stem). This is the upload-actually-happened
  //       proof: ChatGPT only renders the filename once the file is in the
  //       composer's attachment list.
  //   (2) !uploading — no aria-busy / data-state=uploading / "Uploading…"|
  //       "Processing…" indicator in flight (else the send button stays
  //       disabled and we'd race into a swallowed send).
  const stem = path.basename(fileName, path.extname(fileName));
  const expression = `(() => {
    const name = ${JSON.stringify(fileName)}.toLowerCase();
    const stem = ${JSON.stringify(stem)}.toLowerCase();
    // Match the full filename, or the stem when it's distinctive enough that a
    // truncated chip ("my-long-na…") won't false-match generic UI text.
    const candidates = Array.from(document.querySelectorAll('div,span,button,a,p,li,h1,h2,h3'));
    let chipNamed = false;
    for (const el of candidates) {
      if (!(el instanceof HTMLElement)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      const text = (el.textContent || '').toLowerCase().trim();
      if (!text || text.length > 256) continue;
      if (text.includes(name) || (stem.length >= 4 && text.includes(stem))) {
        chipNamed = true;
        break;
      }
    }
    const uploadingSelectors = ${JSON.stringify(UPLOAD_STATUS_SELECTORS)};
    const uploading = uploadingSelectors.some((sel) => {
      const nodes = Array.from(document.querySelectorAll(sel));
      return nodes.some((node) => {
        if (!(node instanceof HTMLElement)) return false;
        const ariaBusy = node.getAttribute('aria-busy');
        const dataState = node.getAttribute('data-state');
        if (ariaBusy === 'true' || dataState === 'loading' || dataState === 'uploading' || dataState === 'pending') {
          return true;
        }
        const text = (node.textContent || '').toLowerCase();
        return /\\buploading\\b/.test(text) || /\\bprocessing\\b/.test(text);
      });
    });
    return { chipNamed, uploading };
  })()`;

  while (Date.now() < deadline) {
    const r = await runtime.evaluate({ expression, returnByValue: true });
    const v = r.result?.value as
      | { chipNamed?: boolean; uploading?: boolean }
      | undefined;
    if (v?.chipNamed && !v.uploading) {
      if (firstSeenAt === null) firstSeenAt = Date.now();
      if (Date.now() - firstSeenAt >= stableMs) return;
    } else {
      firstSeenAt = null;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, tickMs));
  }

  throw new RosettaUploadError(
    `Attachment ${fileName} did not become ready within ${Math.round(timeoutMs / 1000)} s. The page never rendered a chip naming the file — the upload may have been rejected (size, MIME, or model doesn't accept this file type) or the composer DOM changed.`,
    "upload-timeout",
    attachment.path,
  );
}

/**
 * Resolve the `objectId` (RemoteObject handle) for the first element matching
 * `selector`, or `null` if nothing matches. We need the handle to hand the
 * input node to `DOM.setFileInputFiles` without enabling the heavyweight DOM
 * domain / walking the document.
 */
export async function resolveElementObjectId(
  runtime: ChromeClient["Runtime"],
  selector: string,
): Promise<string | null> {
  const r = await runtime.evaluate({
    expression: `document.querySelector(${JSON.stringify(selector)})`,
    returnByValue: false,
  });
  // A matched element yields an object handle (objectId); no match yields
  // `{ subtype: "null", value: null }` with no objectId.
  return r.result?.objectId ?? null;
}

/**
 * Wait until the composer's file input (or a nearby ancestor) carries a React
 * `onChange`/`onInput` handler — the signal that ChatGPT has wired its upload
 * pipeline to the input and a `change` event will be routed to the message
 * attachment flow (`POST /backend-api/files` → blob PUT → process_upload_stream)
 * rather than the `/files/library` mis-route. React stores element props on the
 * DOM node under a `__reactProps$<hash>` key; we walk a few ancestors because
 * the handler may live on a wrapper rather than the input itself.
 *
 * Resolves `true` once the handler is observed, or `false` on timeout. We return
 * `false` rather than throwing because by `timeoutMs` (15 s) the composer has
 * long since hydrated in any normal run, so setting files is safe regardless —
 * the heuristic is a guard against the early-set race, not a hard gate. See
 * COMPOSER_UPLOAD_READY_TIMEOUT_MS for why an early set is unrecoverable.
 */
export async function waitForComposerUploadReady(
  runtime: ChromeClient["Runtime"],
  selector: string,
  timeoutMs: number = COMPOSER_UPLOAD_READY_TIMEOUT_MS,
): Promise<boolean> {
  const expression = `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    for (let n = el, hops = 0; n && hops < 6; n = n.parentElement, hops++) {
      const key = Object.keys(n).find((k) => k.startsWith('__reactProps$'));
      if (key) {
        const p = n[key];
        if (p && (typeof p.onChange === 'function' || typeof p.onInput === 'function')) {
          return true;
        }
      }
    }
    return false;
  })()`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await runtime.evaluate({ expression, returnByValue: true });
    if (r.result?.value === true) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

/**
 * Sequentially attach each file to the composer. For each: locate the file
 * input, set the file on it via the trusted CDP `DOM.setFileInputFiles`
 * (real on-disk path — the same mechanism Playwright/Puppeteer use), then wait
 * for ChatGPT to render a chip naming the file. Fail-fast: if any attachment
 * errors, bail with the original error and leave already-attached files in the
 * composer (caller's problem to retry).
 *
 * Why CDP and not a hand-built DataTransfer + synthetic `change` event: the
 * synthetic path stopped triggering ChatGPT's React upload pipeline (observed
 * 2026-06 — no `POST /backend-api/files` fired, outgoing `/f/conversation` body
 * carried no attachment reference, yet a chip still rendered → silent failure).
 * `DOM.setFileInputFiles` dispatches the browser's own trusted change event,
 * which React reliably consumes across versions. `transferAttachmentViaDataTransfer`
 * is retained as a fallback for environments where the CDP path is unavailable.
 */
export async function attachFiles(
  client: Pick<ChromeClient, "Runtime" | "DOM">,
  attachments: readonly Attachment[],
): Promise<void> {
  const { Runtime: runtime, DOM } = client;
  for (const attachment of attachments) {
    const absPath = path.resolve(attachment.path);
    const info = await stat(absPath).catch(() => null);
    if (!info || !info.isFile()) {
      throw new RosettaUploadError(
        `Attachment not found or not a regular file: ${absPath}`,
        "upload-failed",
        attachment.path,
      );
    }
    if (info.size > MAX_DATA_TRANSFER_BYTES) {
      throw new RosettaUploadError(
        `Attachment ${path.basename(absPath)} is too large (${info.size} bytes). Maximum size is ${MAX_DATA_TRANSFER_BYTES} bytes.`,
        "upload-failed",
        attachment.path,
      );
    }
    const fileName = path.basename(absPath);

    const selector = await findFileInputSelector(runtime);
    if (!selector) {
      throw new RosettaUploadError(
        `Could not locate a file input on the ChatGPT page. The composer DOM may have changed; consider updating FILE_INPUT_SELECTORS.`,
        "upload-failed",
        attachment.path,
      );
    }

    // Gate: do not set files until ChatGPT has wired the composer's onChange
    // handler, or the file mis-routes to /files/library and never attaches (an
    // unrecoverable state for the page load). See waitForComposerUploadReady.
    await waitForComposerUploadReady(runtime, selector);

    const objectId = await resolveElementObjectId(runtime, selector);
    if (!objectId) {
      throw new RosettaUploadError(
        `File input matched selector "${selector}" but no element handle could be resolved.`,
        "upload-failed",
        attachment.path,
      );
    }

    try {
      await DOM.setFileInputFiles({ files: [absPath], objectId });
    } catch (err) {
      throw new RosettaUploadError(
        `DOM.setFileInputFiles failed for ${fileName}: ${err instanceof Error ? err.message : String(err)}`,
        "upload-failed",
        attachment.path,
      );
    }

    await waitForAttachmentReady(runtime, attachment, fileName);
  }
}

/**
 * Map a filename's extension to a best-guess MIME type. Falls back to
 * `application/octet-stream` for unknown extensions. Ported verbatim from
 * oracle.
 */
export function guessMimeType(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  const mimeTypes: Record<string, string> = {
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".csv": "text/csv",

    ".json": "application/json",
    ".js": "text/javascript",
    ".ts": "text/typescript",
    ".jsx": "text/javascript",
    ".tsx": "text/typescript",
    ".py": "text/x-python",
    ".java": "text/x-java",
    ".c": "text/x-c",
    ".cpp": "text/x-c++",
    ".h": "text/x-c",
    ".hpp": "text/x-c++",
    ".sh": "text/x-sh",
    ".bash": "text/x-sh",

    ".html": "text/html",
    ".css": "text/css",
    ".xml": "text/xml",
    ".yaml": "text/yaml",
    ".yml": "text/yaml",

    ".pdf": "application/pdf",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",

    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",

    ".zip": "application/zip",
    ".tar": "application/x-tar",
    ".gz": "application/gzip",
    ".7z": "application/x-7z-compressed",
  };

  return mimeTypes[ext] || "application/octet-stream";
}
