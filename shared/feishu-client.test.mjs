import test from "node:test";
import assert from "node:assert/strict";

import { balanceCardFontTags, splitMessageContent } from "./feishu-client.mjs";

test("message chunks preserve every character and prefer semantic boundaries", () => {
  const address = "0x1234567890abcdef1234567890abcdef12345678";
  const copy = "这是需要完整保留的变更文案，包含所有标点、空格和上下文。".repeat(20);
  const content = [
    "**变更结论**",
    "",
    `- 地址: [${address}](https://bscscan.com/address/${address})`,
    "",
    `- 原文: ${copy}`,
    `- 新文: ${copy}新增内容`,
  ].join("\n");

  const chunks = splitMessageContent(content, 500);
  assert(chunks.length > 1);
  assert.equal(chunks.join(""), content);
  assert(chunks.every(chunk => chunk.length <= 500));
  assert(chunks.some(chunk => chunk.includes(address)));
});

test("single long line is split without truncating content", () => {
  const content = "完整内容".repeat(400);
  const chunks = splitMessageContent(content, 500);
  assert.equal(chunks.join(""), content);
  assert(chunks.every(chunk => chunk.length <= 500));
});

test("long colored copy stays readable in every card part", () => {
  const copy = "完整彩色文案".repeat(500);
  const content = `<font color="green">${copy}</font>`;
  const chunks = balanceCardFontTags(splitMessageContent(content, 500));
  assert(chunks.every(chunk => (chunk.match(/<font\b/g) || []).length === (chunk.match(/<\/font>/g) || []).length));
  assert.equal(chunks.join("").replace(/<\/?font(?:\s+color="green")?>/g, ""), copy);
});
