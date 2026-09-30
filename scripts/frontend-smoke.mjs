// Run after npm run build with a logged-in Chrome on CDP 9222.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { openSession, runConversation } from "../dist/src/index.js";

const root = mkdtempSync(path.join(tmpdir(), "rosetta-frontend-smoke-"));
const firstToken = `DOC-${randomBytes(8).toString("hex")}`;
const nextToken = `NEXT-${randomBytes(8).toString("hex")}`;
const firstFile = path.join(root, "first-upload.txt");
const nextFile = path.join(root, "followup-upload.md");
writeFileSync(firstFile, `Verification token: ${firstToken}\n`);
writeFileSync(nextFile, `# Attachment verification\nSecond token: ${nextToken}\n`);
const receipts = [];
const conversations = new Set();
const session = await openSession({ port: 9222 });
console.log("ARTIFACT_ROOT", root);

async function check(name, input, expected) {
  console.log("START", name);
  const result = await runConversation(session, input, {
    timeoutMs: 180_000, keepConversation: true,
  });
  conversations.add(result.conversationId);
  const response = await session.httpRequest({
    method: "GET", url: `/backend-api/conversation/${result.conversationId}`,
    headers: { Authorization: `Bearer ${session.meta.accessToken}` }, responseType: "json",
  });
  const mapping = response.body.mapping;
  let node = Object.values(mapping).find(n => n.message?.id === result.messageId);
  while (node && node.message?.author?.role !== "user") node = mapping[node.parent];
  const actualPrompt = node?.message?.content?.parts?.filter(p => typeof p === "string").join("");
  const passed = expected.every(value => result.text.includes(value)) &&
    result.modelSlug === input.model && actualPrompt === input.prompt;
  const receipt = {
    name, requestedModel: input.model, returnedModel: result.modelSlug,
    text: result.text, expected, actualPrompt, passed, tookMs: result.tookMs,
    conversationId: result.conversationId, messageId: result.messageId,
    attachments: input.attachments.map(a => path.basename(a.path)),
    messageAttachments: node?.message?.metadata?.attachments?.map(a => a.name) ?? [],
  };
  receipts.push(receipt);
  writeFileSync(path.join(root, "receipts.json"), JSON.stringify(receipts, null, 2));
  console.log("RESULT", JSON.stringify(receipt));
  if (!passed) throw new Error(`${name}: response, model or sent prompt did not match`);
  return result;
}

try {
  const first = await check("pro-text-attachment", {
    model: "gpt-6-pro",
    prompt: "Read the attached text file. Reply with only the verification token written in the file.",
    attachments: [{ path: firstFile }],
  }, [firstToken]);
  await check("pro-followup-attachment", {
    model: "gpt-6-pro", conversationId: first.conversationId, parentMessageId: first.messageId,
    prompt: "Read the new attached Markdown file. Reply with the verification token from the first file and the second token from the new file, separated by one space.",
    attachments: [{ path: nextFile }],
  }, [firstToken, nextToken]);
  const image = await session.client.Runtime.evaluate({
    expression: `(() => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 96;
      const context = canvas.getContext('2d');
      context.fillStyle = '#0000ff'; context.fillRect(0, 0, 96, 96);
      return canvas.toDataURL('image/png').split(',')[1];
    })()`, returnByValue: true,
  });
  const png = path.join(root, "image-upload.png");
  writeFileSync(png, Buffer.from(image.result.value, "base64"));
  await check("instant-image-attachment", {
    model: "gpt-5-6",
    prompt: "What is the dominant color in the attached image? Reply with one lowercase English color word.",
    attachments: [{ path: png }],
  }, ["blue"]);
  console.log("ALL_LIVE_TESTS_PASSED");
} finally {
  for (const id of conversations) {
    await session.httpRequest({
      method: "PATCH", url: `/backend-api/conversation/${id}`,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.meta.accessToken}` },
      body: JSON.stringify({ is_visible: false }), responseType: "text",
    }).catch(() => undefined);
  }
  await session.close();
}
