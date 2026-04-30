import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  MAX_DATA_TRANSFER_BYTES,
  RosettaUploadError,
  guessMimeType,
  transferAttachmentViaDataTransfer,
} from "../src/upload.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), "rosetta-upload-test-"));
});
afterEach(() => {
  // Best-effort cleanup; small files in tmpdir, OS will reap regardless.
});

describe("guessMimeType", () => {
  test("maps common extensions", () => {
    expect(guessMimeType("foo.png")).toBe("image/png");
    expect(guessMimeType("foo.jpg")).toBe("image/jpeg");
    expect(guessMimeType("foo.jpeg")).toBe("image/jpeg");
    expect(guessMimeType("foo.pdf")).toBe("application/pdf");
    expect(guessMimeType("foo.csv")).toBe("text/csv");
    expect(guessMimeType("foo.json")).toBe("application/json");
    expect(guessMimeType("foo.md")).toBe("text/markdown");
  });

  test("is case-insensitive on the extension", () => {
    expect(guessMimeType("PHOTO.PNG")).toBe("image/png");
    expect(guessMimeType("Doc.PDF")).toBe("application/pdf");
  });

  test("falls back to application/octet-stream for unknown ext", () => {
    expect(guessMimeType("foo.unknownext")).toBe("application/octet-stream");
    expect(guessMimeType("noext")).toBe("application/octet-stream");
  });

  test("handles double-extension (only last segment counts)", () => {
    expect(guessMimeType("archive.tar.gz")).toBe("application/gzip");
    expect(guessMimeType("backup.tar")).toBe("application/x-tar");
  });
});

interface CapturedEval {
  expression: string;
  returnByValue?: boolean;
  awaitPromise?: boolean;
}

function makeStubRuntime(handler: (capture: CapturedEval) => unknown): {
  runtime: { evaluate: (params: CapturedEval) => Promise<{ result?: { value?: unknown } }> };
  captures: CapturedEval[];
} {
  const captures: CapturedEval[] = [];
  return {
    captures,
    runtime: {
      async evaluate(params) {
        captures.push(params);
        return { result: { value: handler(params) } };
      },
    },
  };
}

describe("transferAttachmentViaDataTransfer", () => {
  test("encodes file content as base64 inside the eval expression", async () => {
    const fixturePath = path.join(tempDir, "hello.txt");
    const fixtureContent = "Hello, ChatGPT attachments!";
    writeFileSync(fixturePath, fixtureContent, "utf8");

    const expectedBase64 = Buffer.from(fixtureContent, "utf8").toString("base64");

    const { runtime, captures } = makeStubRuntime(() => ({
      success: true,
      fileName: "hello.txt",
      size: fixtureContent.length,
    }));

    const result = await transferAttachmentViaDataTransfer(
      // The real Runtime is a CDP type; the helper only calls .evaluate, so the
      // structural stub above is enough.
      runtime as unknown as Parameters<typeof transferAttachmentViaDataTransfer>[0],
      { path: fixturePath },
      'input[type="file"]',
    );

    expect(result.fileName).toBe("hello.txt");
    expect(result.size).toBe(fixtureContent.length);
    expect(captures).toHaveLength(1);
    const expr = captures[0]!.expression;
    expect(expr).toContain(JSON.stringify(expectedBase64));
    expect(expr).toContain(JSON.stringify("hello.txt"));
    expect(expr).toContain(JSON.stringify("text/plain"));
    // Make sure the JS still wires up the change-event dispatch and the
    // 3-tier file-list assignment fallback.
    expect(expr).toContain("dispatchEvent(new Event('change'");
    expect(expr).toContain("descriptor.set.call");
    expect(expr).toContain("Object.defineProperty(fileInput, 'files'");
  });

  test("respects an explicit mimeType override", async () => {
    const fixturePath = path.join(tempDir, "blob.bin");
    writeFileSync(fixturePath, Buffer.from([0, 1, 2, 3, 4]));

    const { runtime, captures } = makeStubRuntime(() => ({
      success: true,
      fileName: "blob.bin",
      size: 5,
    }));

    await transferAttachmentViaDataTransfer(
      runtime as unknown as Parameters<typeof transferAttachmentViaDataTransfer>[0],
      { path: fixturePath, mimeType: "application/x-custom" },
      'input[type="file"]',
    );

    expect(captures[0]!.expression).toContain(JSON.stringify("application/x-custom"));
  });

  test("throws RosettaUploadError(upload-failed) when file exceeds the cap", async () => {
    const fixturePath = path.join(tempDir, "huge.bin");
    // Write one byte over the cap so we don't actually allocate 20 MB+.
    // The size check looks at the actual bytes-on-disk via readFile.
    const big = Buffer.alloc(MAX_DATA_TRANSFER_BYTES + 1, 0);
    writeFileSync(fixturePath, big);

    const { runtime } = makeStubRuntime(() => ({ success: true, fileName: "huge.bin", size: 1 }));

    await expect(
      transferAttachmentViaDataTransfer(
        runtime as unknown as Parameters<typeof transferAttachmentViaDataTransfer>[0],
        { path: fixturePath },
        'input[type="file"]',
      ),
    ).rejects.toBeInstanceOf(RosettaUploadError);
  });

  test("surfaces in-page failure as upload-failed", async () => {
    const fixturePath = path.join(tempDir, "ok.txt");
    writeFileSync(fixturePath, "x");

    const { runtime } = makeStubRuntime(() => ({
      success: false,
      error: "File input not found",
    }));

    const promise = transferAttachmentViaDataTransfer(
      runtime as unknown as Parameters<typeof transferAttachmentViaDataTransfer>[0],
      { path: fixturePath },
      'input[type="file"]',
    );
    await expect(promise).rejects.toMatchObject({
      name: "RosettaUploadError",
      code: "upload-failed",
      attachmentPath: fixturePath,
    });
  });
});
