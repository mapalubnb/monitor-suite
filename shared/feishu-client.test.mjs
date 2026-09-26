import test from "node:test";
import assert from "node:assert/strict";
import { isAuthorizedSender, sendCard } from './feishu-client.mjs';

test('expired startup card does not send after credential retrieval', async () => {
  let sends = 0;
  const opts = {chatId: 'test', expiresAt: Date.now() + 60_000};
  const transport = {
    withToken: async () => { opts.expiresAt = Date.now() - 1; return {}; },
    client: {im: {message: {create: async () => { sends++; }}}},
  };
  await assert.rejects(sendCard('startup', 'test', 'green', opts, transport), /已过期/);
  assert.equal(sends, 0);
});

test('bot authorization denies an empty whitelist and unknown operators', () => {
  assert.equal(isAuthorizedSender('ou_one', []), false);
  assert.equal(isAuthorizedSender('', ['ou_one']), false);
  assert.equal(isAuthorizedSender('ou_other', ['ou_one']), false);
  assert.equal(isAuthorizedSender('ou_one', [' ou_one ']), true);
});

test('card retries resume unsent parts with stable request ids', async () => {
  let saved = [];
  let fail = true;
  const requests = [];
  const transport = {
    withToken: async () => ({}), pause: async () => {},
    client: { im: { message: { create: async request => {
      requests.push(request.data.uuid);
      if (requests.length === 2 && fail) throw new Error('offline');
      return { code: 0, data: { message_id: `message-${requests.length}` } };
    } } } },
  };
  const options = () => ({ chatId: 'test-chat', deliveryId: 'stable-alert', sentParts: [...saved], onPartSent: async parts => { saved = [...parts]; } });
  await assert.rejects(sendCard('test', 'x'.repeat(5000), 'red', options(), transport), /offline/);
  assert.equal(saved.length, 1);
  fail = false;
  const first = await sendCard('test', 'x'.repeat(5000), 'red', options(), transport);
  assert.equal(first, 'message-1');
  assert.equal(requests.length, 3);
  assert.equal(requests[1], requests[2]);
  assert.notEqual(requests[0], requests[1]);
});

import { assertFeishuResponse, balanceCardFontTags, buildCardJson, splitMessageContent } from "./feishu-client.mjs";
import { planCardParts, cardCapacity, isMultiPartCard, patchCard } from './feishu-client.mjs';
import { splitCardMarkdown } from './card-markdown.mjs';

test('dense headings are partitioned by final element and request byte budgets', async () => {
  const source = Array.from({ length: 75 }, (_, i) => `## 项目${i}\n值：正常`).join('\n');
  const parts = planCardParts('边界', source, 'blue');
  assert.ok(parts.length > 1);
  assert.equal(parts.map(part => part.content).join(''), source);
  for (const part of parts) {
    const capacity = cardCapacity(buildCardJson(part.title, part.content, 'blue'), {
      receive_id: 'oc_' + 'x'.repeat(32), msg_type: 'interactive', uuid: 'x'.repeat(40),
    });
    assert.ok(capacity.elements <= 200);
    assert.ok(capacity.bytes < 30_000);
  }
  await assert.rejects(patchCard('unused', '边界', source, 'blue'), /超过容量/);
});

test('Unicode graphemes, combining characters and emoji families survive card and text cuts', () => {
  for (const symbol of ['😀', '👩‍👩‍👧‍👦', 'e\u0301', '🇨🇳']) {
    const source = 'a'.repeat(3459) + symbol + 'b'.repeat(100);
    for (const parts of [planCardParts('文字', source).map(part => part.content), splitMessageContent(source, 3460)]) {
      assert.equal(parts.join(''), source);
      assert.ok(parts.every(part => part.isWellFormed()));
      assert.ok(parts.some(part => part.includes(symbol)));
    }
  }
});

test('links longer than the preferred chunk length remain clickable and fit the actual byte limit', () => {
  const url = 'https://example.com/' + 'a'.repeat(3500) + '(detail)';
  const link = `[名称\\]完整](${url})`;
  const source = '前文\n' + link + '\n后文';
  const parts = planCardParts('链接', source);
  assert.equal(parts.map(part => part.content).join(''), source);
  assert.ok(parts.some(part => part.content.includes(link)));
  assert.ok(parts.every(part => cardCapacity(buildCardJson(part.title, part.content, 'red')).bytes < 30_000));
});

test('code fences reopen with their language and close independently in every part', () => {
  for (const marker of ['```', '~~~~']) {
    const rows = Array.from({ length: 150 }, (_, i) => `日志${i} <font color="red">字面标签</font> **值**`);
    const parts = planCardParts('日志', marker + 'text\n' + rows.join('\n') + '\n' + marker);
    assert.ok(parts.length > 1);
    const retained = [];
    for (const { content } of parts) {
      assert.ok(content.startsWith(marker + 'text\n'));
      assert.ok(content.endsWith(marker));
      retained.push(content.slice((marker + 'text\n').length, -marker.length).trimEnd());
      const card = JSON.parse(buildCardJson('日志', content, 'blue'));
      assert.equal(card.body.elements.filter(el => el.element_id?.startsWith('code_')).length, 1);
    }
    assert.equal(retained.join('\n'), rows.join('\n'));
  }
});

test('nested font tags are balanced without interpreting tags inside code', () => {
  const source = '<font color="green"><font color="red">' + '完整证据'.repeat(1800) + '</font>尾部</font>';
  const parts = splitCardMarkdown(source, 3460);
  assert.ok(parts.length > 1);
  for (const part of parts) {
    assert.equal((part.match(/<font\b/g) || []).length, (part.match(/<\/font>/g) || []).length);
    assert.ok(part.startsWith('<font color="green">'));
  }
  assert.equal(parts.join('').replace(/<\/?font\b[^>]*>/g, ''), source.replace(/<\/?font\b[^>]*>/g, ''));
});

test('unrepresentable atomic links fail before sending any partial notification', async () => {
  let calls = 0;
  const transport = { withToken: async () => ({}), client: { im: { message: { create: async () => { calls++; } } } } };
  await assert.rejects(sendCard('超长链接', '正文\n[链接](https://example.com/' + 'a'.repeat(40_000) + ')', 'blue', {chatId:'test'}, transport), /无法无损分片/);
  assert.equal(calls, 0);
});

test('3461 through 3500 characters use the same multipart decision as sending', () => {
  for (const length of [3460, 3461, 3480, 3500]) {
    const source = 'a'.repeat(length);
    assert.equal(isMultiPartCard(source), planCardParts('监控通知', source).length > 1);
    assert.equal(isMultiPartCard(source), length > 3460);
  }
});

test('saved card plans preserve unsent content and message IDs across retries', async () => {
  let plan, saved = [], requests = [], fail = true;
  const transport = { withToken: async () => ({}), pause: async () => {}, client: { im: { message: {
    create: async request => {
      requests.push(request.data);
      if (requests.length === 2 && fail) throw Error('offline');
      return {code:0,data:{message_id:'part-'+requests.length}};
    },
  } } } };
  const opts = () => ({chatId:'test',deliveryId:'stable',sentParts:[...saved],cardParts:plan,
    onPlan:async parts=>{plan=structuredClone(parts);},onPartSent:async parts=>{saved=[...parts];}});
  await assert.rejects(sendCard('原标题', '证据'.repeat(2200), 'blue', opts(), transport), /offline/);
  assert.ok(plan.length > 1);
  fail = false;
  await sendCard('后续配置', '不能替换已冻结的正文', 'blue', opts(), transport);
  assert.equal(requests[1].uuid, requests[2].uuid);
  const original = JSON.parse(requests[1].content), retried = JSON.parse(requests[2].content);
  assert.equal(original.header.title.content, retried.header.title.content);
  assert.equal(original.body.elements[0].content, retried.body.elements[0].content);
  assert.equal(requests.length, 3);
});

test('time fields and bold markers remain intact at fragment boundaries', () => {
  const source = 'a'.repeat(3450) + '**首次观测**2026-09-26T06:55:52.123Z';
  const parts = planCardParts('时间', source);
  const cards = parts.map(part => buildCardJson(part.title, part.content, 'blue')).join('');
  assert.match(cards, /2026\/9\/26 14:55:52\.123/);
  assert.doesNotMatch(cards, /\*\*/);
  assert.equal(parts.map(part => part.content).join(''), source);
});

test('more than fifty table columns fall back to complete text without dropped values', () => {
  const source = '01　项目｜' + Array.from({length:51},(_,i)=>`字段${i} 值${i}`).join('｜');
  const card=JSON.parse(buildCardJson('表格',source,'blue'));
  assert.ok(!card.body.elements.some(element=>element.tag==='table'));
  assert.ok(card.body.elements.some(element=>element.content===source));
});

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
  assert.equal(card.config.width_mode, "default");
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

test("alert card mentions one configured user while ordinary cards stay quiet", () => {
  const openId = "ou_test_recipient";
  const alert = JSON.parse(buildCardJson("重点告警", "完整告警内容", "red", { mentionOpenId: openId }));
  const ordinary = JSON.parse(buildCardJson("普通通知", "普通内容", "blue"));
  assert.equal(alert.body.elements[0].element_id, "mention_1");
  assert.equal(alert.body.elements[0].content, `<at id=${openId}></at>`);
  assert.doesNotMatch(JSON.stringify(ordinary), /<at id=/);
});

test("invalid mention ids are ignored instead of entering card markdown", () => {
  const card = JSON.parse(buildCardJson("告警", "内容", "red", {
    mentionOpenId: "ou_bad\"></at><at id=all",
  }));
  assert.doesNotMatch(JSON.stringify(card), /<at id=/);
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

test("table columns shrink to their text while long addresses receive bounded space", () => {
  const address = "0x1234567890abcdef1234567890abcdef12345678";
  const card = JSON.parse(buildCardJson("状态", [
    "**04｜底池配置**",
    `01　符号 BNB｜状态 已启用｜地址 [${address}](https://bscscan.com/address/${address})｜募集总量 24 BNB`,
  ].join("\n"), "green"));
  const table = card.body.elements.find(element => element.tag === "table");
  assert.ok(table);
  const widths = Object.fromEntries(table.columns.map(column => [column.display_name, Number.parseInt(column.width, 10)]));
  assert.ok(widths.状态 <= 140);
  assert.ok(widths.募集总量 <= 260);
  assert.ok(widths.地址 >= 180 && widths.地址 <= 360);
  assert.ok(widths.项目 <= 240);
  assert.ok(table.columns.every(column => /^\d+px$/.test(column.width)));
});

test("Feishu reply errors propagate instead of being treated as success", () => {
  assert.equal(assertFeishuResponse({ code: 0, data: {} }, "回复卡片").code, 0);
  assert.throws(
    () => assertFeishuResponse({ code: 230099, msg: "invalid card" }, "回复卡片"),
    /回复卡片失败：code=230099: invalid card/,
  );
});
