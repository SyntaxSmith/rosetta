import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ChromeClient } from "./chrome.js";
import type { Attachment } from "./types.js";
import { FILE_INPUT_SELECTORS, UPLOAD_STATUS_SELECTORS } from "./upload.constants.js";

/** Soft cap on per-file size for in-page DataTransfer injection (20 MB raw). */
export const MAX_DATA_TRANSFER_BYTES = 20 * 1024 * 1024;

/** Default time we'll wait for the page's React pipeline to render an attachment chip. */
const DEFAULT_ATTACHMENT_READY_TIMEOUT_MS = 30_000;

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
 * Poll the page until ChatGPT renders an attachment "chip" / "pill" for the
 * uploaded file, AND the file-input still reports the file in `input.files`.
 * That combination means the React pipeline saw the `change` event and
 * processed the upload at least to the visible-pending stage.
 *
 * Simplified vs oracle's full state machine — we only need to know the page
 * accepted the file enough to send it. Server-side processing (PDF parsing
 * etc.) continues asynchronously after `send` and is the model's problem.
 *
 * Times out as `upload-timeout` if no chip appears in `timeoutMs`.
 */
export async function waitForAttachmentReady(
  runtime: ChromeClient["Runtime"],
  attachment: Attachment,
  fileName: string,
  timeoutMs: number = DEFAULT_ATTACHMENT_READY_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const tickMs = 250;
  const stableMs = 1000;
  let firstSeenAt: number | null = null;

  // We re-eval each tick. Three signals must all line up before we call the
  // attachment "ready":
  //   (1) input.files still contains our file (assignment stuck)
  //   (2) attachment chip is visible in the composer (React processed change)
  //   (3) no uploading/loading/pending in-flight indicators (server-side
  //       processing finished — without this, send button stays disabled)
  // All three true and stable for >= stableMs.
  const expression = `(() => {
    const expectedName = ${JSON.stringify(fileName)}.toLowerCase();
    const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
    let inputHasFile = false;
    for (const input of inputs) {
      if (!(input instanceof HTMLInputElement)) continue;
      const files = Array.from(input.files || []);
      if (files.some((f) => f && (f.name || '').toLowerCase().includes(expectedName))) {
        inputHasFile = true;
        break;
      }
    }
    const chipSelectors = [
      '[data-testid*="attachment"]',
      '[data-testid*="chip"]',
      '[data-testid*="upload"]',
      '[data-testid*="file"]',
      '[aria-label*="Remove"]',
      'button[aria-label*="Remove"]',
    ];
    let chipVisible = false;
    for (const sel of chipSelectors) {
      const nodes = Array.from(document.querySelectorAll(sel));
      if (nodes.some((n) => {
        if (!(n instanceof HTMLElement)) return false;
        const rect = n.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      })) {
        chipVisible = true;
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
    return { inputHasFile, chipVisible, uploading };
  })()`;

  while (Date.now() < deadline) {
    const r = await runtime.evaluate({ expression, returnByValue: true });
    const v = r.result?.value as
      | { inputHasFile?: boolean; chipVisible?: boolean; uploading?: boolean }
      | undefined;
    if (v?.inputHasFile && v.chipVisible && !v.uploading) {
      if (firstSeenAt === null) firstSeenAt = Date.now();
      if (Date.now() - firstSeenAt >= stableMs) return;
    } else {
      firstSeenAt = null;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, tickMs));
  }

  throw new RosettaUploadError(
    `Attachment ${fileName} did not become ready within ${Math.round(timeoutMs / 1000)} s. The page never rendered an attachment chip — the upload may have been rejected (size, MIME, or model doesn't accept this file type).`,
    "upload-timeout",
    attachment.path,
  );
}

/**
 * Sequentially attach each file to the composer. For each: locate file input,
 * inject file via DataTransfer, wait for the chip to render. Fail-fast: if any
 * attachment errors, bail with the original error and leave already-attached
 * files in the composer (caller's problem to retry).
 */
export async function attachFiles(
  runtime: ChromeClient["Runtime"],
  attachments: readonly Attachment[],
): Promise<void> {
  for (const attachment of attachments) {
    const selector = await findFileInputSelector(runtime);
    if (!selector) {
      throw new RosettaUploadError(
        `Could not locate a file input on the ChatGPT page. The composer DOM may have changed; consider updating FILE_INPUT_SELECTORS.`,
        "upload-failed",
        attachment.path,
      );
    }
    const transfer = await transferAttachmentViaDataTransfer(runtime, attachment, selector);
    await waitForAttachmentReady(runtime, attachment, transfer.fileName);
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
