import test from "node:test";
import assert from "node:assert/strict";

import { balanceCardFontTags, buildCardJson, splitMessageContent } from "./feishu-client.mjs";

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

test("cards use JSON 2.0 structured layout and table rows preserve full values", () => {
  const address = "0x1234567890abcdef1234567890abcdef12345678";
  const card = JSON.parse(buildCardJson("状态", [
    "**01｜运行状态**",
    "状态：监控正常",
    "页面：12 个",
    "",
    "**02｜底池配置**",
    `01　符号 BNB｜状态 已启用｜地址 [${address}](https://bscscan.com/address/${address})｜募集总量 24 BNB`,
    `02　符号 USDT｜状态 已启用｜地址 [${address}](https://bscscan.com/address/${address})｜募集总量 100 USDT`,
  ].join("\n"), "green"));
  assert.equal(card.schema, "2.0");
  assert.equal(card.config.width_mode, "fill");
  assert.ok(card.body.elements.some(element => element.tag === "column_set"));
  const table = card.body.elements.find(element => element.tag === "table");
  assert.ok(table);
  assert.equal(table.row_height, "auto");
  assert.match(JSON.stringify(table.rows), new RegExp(address, "g"));
});

test("ordinary card actions are removed and only an existing DIFF adds a button", () => {
  const ordinary = JSON.parse(buildCardJson("普通卡片", "[网站](https://example.com)", "blue", {
    actions: [{ tag: "button", text: { tag: "plain_text", content: "打开网站" }, url: "https://example.com" }],
  }));
  assert.equal(ordinary.body.elements.filter(element => element.tag === "button").length, 0);
  assert.doesNotMatch(JSON.stringify(ordinary), /\*\*操作\*\*|打开网站/);

  const withDiff = JSON.parse(buildCardJson("变更卡片", "完整变更内容", "red", {
    diffFilePath: "/tmp/full.diff",
  }));
  const buttons = withDiff.body.elements.filter(element => element.tag === "button");
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].behaviors[0].value.action, "download_diff");
  assert.equal(buttons[0].behaviors[0].value.file, "/tmp/full.diff");
});

test("JSON 2.0 card padding uses Feishu-compatible one-or-four-value syntax", () => {
  const card = JSON.parse(buildCardJson("重启", "即将执行重启", "yellow"));
  const paddings = [];
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (typeof value.padding === "string") paddings.push(value.padding);
    for (const child of Object.values(value)) {
      if (Array.isArray(child)) child.forEach(visit);
      else visit(child);
    }
  };
  visit(card);
  assert.ok(paddings.length >= 2);
  for (const padding of paddings) {
    const parts = padding.trim().split(/\s+/);
    assert.ok(parts.length === 1 || parts.length === 4, `飞书不兼容的 padding：${padding}`);
  }
});
