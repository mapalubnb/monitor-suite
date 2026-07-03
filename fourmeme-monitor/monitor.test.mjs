import test from "node:test";
import assert from "node:assert/strict";

process.env.FOURMEME_MONITOR_TEST = "1";

const { __testables } = await import("./monitor.mjs");

test("default fourmeme frontend and api cadences are fast but bounded", () => {
  assert.equal(__testables.CONFIG.intervals.frontend, 10_000);
  assert.equal(__testables.CONFIG.intervals.api, 15_000);
  assert.equal(__testables.CONFIG.jitterMs, 200);
  assert.equal(__testables.CONFIG.apiProbeStaggerMs, 200);
});

test("startup card copy reflects active frontend and api cadences", () => {
  const progress = __testables.buildStartupProgressContent();
  const ready = __testables.buildStartupReadyContent();
  assert.match(progress, /前端：当前快照 [\s\S]*每 10 秒/);
  assert.match(progress, /API：每 15 秒/);
  assert.match(ready, /✅ \*\*监控运行中\*\*/);
  assert.match(ready, /\*\*运行状态\*\*[\s\S]*\*\*监控概览\*\*[\s\S]*\*\*前端能力\*\*[\s\S]*\*\*运行策略\*\*[\s\S]*\*\*通知状态\*\*/);
  assert.match(ready, /前端：[\s\S]*每 10 秒/);
  assert.match(ready, /API：[\s\S]*每 15 秒/);
  assert.match(ready, /NEXT_DATA · i18n · 路由发现 · 端点发现 · 新页面自动纳管/);
  assert.match(ready, /固定入口 \d+ 个｜当前监控池 \d+ 个｜详情：fm-status/);
  assert.match(ready, /更新时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
  assert.doesNotMatch(ready, /每 \d+s/);
  assert.doesNotMatch(ready, /- https:\/\/four\.meme/);
});

test("canonicalFrontendUrl normalizes tracking params, hash, query order, and trailing slash", () => {
  assert.equal(
    __testables.canonicalFrontendUrl("https://four.meme/zh-TW/create-token/?b=2&utm_source=x&a=1#top"),
    "https://four.meme/zh-TW/create-token?a=1&b=2",
  );
});

test("configured URL validation is looser than discoverable route validation but honors removal list", () => {
  assert.equal(__testables.isConfiguredFrontendUrl("https://four.meme/zh-TW/custom-campaign"), true);
  assert.equal(__testables.isDiscoverableFrontendUrl("https://four.meme/zh-TW/custom-campaign"), true);
  assert.equal(__testables.isConfiguredFrontendUrl("https://four.meme/en"), false);
});

test("presale detail routes are discoverable from homepage links", () => {
  __testables.setSnapshotForTests({});
  assert.equal(__testables.isDiscoverableFrontendUrl("https://four.meme/en/presale/102364633"), true);
  const signals = __testables.extractRouteSignals(
    `<a href="https://four.meme/en/presale/102364633"></a>`,
    null,
    null,
  );
  assert.deepEqual(signals.routes, ["/en/presale/102364633"]);
  const discovered = __testables.discoverFrontendUrlsFromPages({
    home: { routes: signals.routes },
  }, ["https://four.meme/en"]);
  assert.deepEqual(discovered, ["https://four.meme/en/presale/102364633"]);
});

test("new frontend route notification asks for confirmation before monitoring enrollment", () => {
  const notification = __testables.buildFrontendNewPageNotification({
    originalUrl: "https://four.meme/en/presale/102364633",
    assetFiles: ["/_next/static/a.js"],
    textContent: "Mame Inu Description Rule Details",
    i18nStrings: { a: "b" },
    routes: ["/en/presale/102364633"],
  });
  assert.equal(notification.title, "前端新路由发现：/en/presale/102364633");
  assert.match(notification.content, /尚未加入前端监控池/);
  assert.match(notification.aiInput, /Mame Inu Description Rule Details/);
  assert.deepEqual(notification.cardOpts.actions.map(a => a.value.action), ["frontend_add_route", "frontend_ignore_route"]);
  assert.equal(notification.dedupeKey, "frontend:new-page:https://four.meme/en/presale/102364633");
});

test("pending or ignored frontend routes are not rediscovered until approved", () => {
  const url = "https://four.meme/en/presale/102364633";
  const route = "/en/presale/102364633";
  __testables.setSnapshotForTests({
    _frontendPendingRoutes: { [url]: { url, status: "pending", updatedAt: Date.now() } },
  });
  assert.equal(__testables.getFrontendRouteDecision(url), "pending");
  assert.deepEqual(__testables.discoverFrontendUrlsFromPages({ home: { routes: [route] } }, []), []);

  __testables.setSnapshotForTests({
    _frontendIgnoredRoutes: { [url]: { url, status: "ignored", updatedAt: Date.now() } },
  });
  assert.equal(__testables.getFrontendRouteDecision(url), "ignored");
  assert.deepEqual(__testables.discoverFrontendUrlsFromPages({ home: { routes: [route] } }, []), []);
});

test("approved frontend routes are included in monitor URL pool", () => {
  const url = "https://four.meme/en/presale/102364633";
  __testables.setSnapshotForTests({
    frontendPages: {},
    _frontendRouteApprovals: { [url]: { url, status: "approved", updatedAt: Date.now() } },
  });
  assert.ok(__testables.getFrontendMonitorUrls().includes(url));
});

test("frontend fetch failures are grouped by domain and skip AI", () => {
  const snap = {
    _frontendFailCounts: {
      [__testables.urlToKey("https://four.meme/en/announcement")]: {
        count: 18,
        reason: "backoff",
        message: "[退避中] four.meme，剩余 80s，上次状态: 403",
      },
      [__testables.urlToKey("https://four.meme/en/campaign")]: {
        count: 18,
        reason: "backoff",
        message: "[退避中] four.meme，剩余 80s，上次状态: 403",
      },
    },
  };
  const notifications = __testables.buildFrontendFailureNotifications([
    "https://four.meme/en/announcement",
    "https://four.meme/en/campaign",
  ], snap);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].title, "⚠️ 前端抓取受限：four.meme");
  assert.equal(notifications[0].skipAi, true);
  assert.match(notifications[0].content, /影响 2 个页面/);
  assert.match(notifications[0].content, /\/en\/announcement/);
  assert.match(notifications[0].content, /\/en\/campaign/);
});

test("AI routing skips operational noise and keeps high-value changes", () => {
  assert.equal(__testables.shouldUseAiForNotification({
    title: "⚠️ 前端抓取受限：four.meme",
    content: "原因: backoff",
    skipAi: true,
  }), false);
  assert.equal(__testables.shouldUseAiForNotification({
    title: "前端新路由发现：/en/presale/102364633",
    content: "新页面",
  }), true);
  assert.equal(__testables.shouldUseAiForNotification({
    title: "前端 i18n 资源变更（影响 3 页）",
    content: "**类型：全局 i18n 资源变更**",
  }), false);
  assert.equal(__testables.shouldUseAiForNotification({
    title: "前端文案变更：/en/presale/102364633",
    content: "**📝 i18n 国际化字符串变更：**\n+ presale.error: You are not eligible",
  }), true);
  assert.equal(__testables.shouldUseAiForNotification({
    title: "链上创建者动作（1项）",
    content: "**ℹ️ 低风险：transfer**",
  }), false);
  assert.equal(__testables.shouldUseAiForNotification({
    title: "链上创建者动作（1项）",
    content: "**🚨 高风险：admin upgrade**",
  }), true);
  assert.equal(__testables.shouldUseAiForNotification({
    title: "GitHub 项目变更（1项）",
    content: "🔄 **仓库更新：** description: 旧 → 新",
  }), false);
  assert.equal(__testables.shouldUseAiForNotification({
    title: "API 变更",
    content: "**📡 API 结构变更：/v1/public/config**\n```+ buyFee (string)```",
  }), true);
});

test("token list optional sample fields do not trigger API structure noise", () => {
  const oldStruct = {
    token_search_new: {
      code: "number",
      msg: "string",
      data: "array",
      "data[]": "array",
      "data[0].tokenAddress": "string",
      "data[0].symbol": "string",
      "data[0].templateId": "string",
      "data[0].hold": "number",
    },
    token_search_cap: {
      code: "number",
      msg: "string",
      data: "array",
      "data[]": "array",
      "data[0].tokenAddress": "string",
      "data[0].symbol": "string",
      "data[0].taxFee": "number",
      "data[0].feeBurn": "number",
    },
    token_ranking_cap: {
      code: "number",
      msg: "string",
      data: "array",
      "data[]": "array",
      "data[0].tokenAddress": "string",
      "data[0].shortName": "string",
      "data[0].min30Increase": "number",
    },
  };
  const newStruct = {
    token_search_new: {
      code: "number",
      msg: "string",
      data: "array",
      "data[]": "array",
      "data[0].tokenAddress": "string",
      "data[0].symbol": "string",
    },
    token_search_cap: {
      code: "number",
      msg: "string",
      data: "array",
      "data[]": "array",
      "data[0].tokenAddress": "string",
      "data[0].symbol": "string",
    },
    token_ranking_cap: {
      code: "number",
      msg: "string",
      data: "array",
      "data[]": "array",
      "data[0].tokenAddress": "string",
    },
  };

  assert.deepEqual(__testables.diffApiStructures(oldStruct, newStruct), []);

  newStruct.token_search_new["data[0].tokenAddress"] = "number";
  const changes = __testables.diffApiStructures(oldStruct, newStruct);
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0].changed, ["data[0].tokenAddress: string → number"]);
});

test("extractTextContent ignores script content and handles greater-than in attributes", () => {
  const html = `<main data-x="a > b"><h1>Create Token</h1><script>throw new Error("<bad>")</script><p>Tax Fee</p></main>`;
  assert.equal(__testables.extractTextContent(html), "Create Token Tax Fee");
});

test("extractNextData returns stable objects with sorted hash independent of key order", () => {
  const a = `<script id="__NEXT_DATA__">{"props":{"b":2,"a":1},"page":"/x","query":{"z":1,"a":2}}</script>`;
  const b = `<script id="__NEXT_DATA__">{"query":{"a":2,"z":1},"page":"/x","props":{"a":1,"b":2}}</script>`;
  const nextA = __testables.extractNextData(a);
  const nextB = __testables.extractNextData(b);
  assert.deepEqual(nextA, nextB);
  assert.equal(__testables.stableJsonHash(nextA), __testables.stableJsonHash(nextB));
});

test("extractI18nFromStreamingHtml parses resources with braces inside strings", () => {
  const resources = {
    common: Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`key${i}`, `值 ${i} {keep}`])),
  };
  const payload = [1, `x\\"resources\\":${JSON.stringify(resources)} y`];
  const html = `<script>self.__next_f.push(${JSON.stringify(payload)})</script>`;
  const result = __testables.extractI18nFromStreamingHtml(html);
  assert.ok(result);
  assert.equal(result.i18nStrings["common.key0"], "值 0 {keep}");
});

test("extractI18nFromStreamingHtml does not truncate push payloads containing closing brackets in strings", () => {
  const resources = {
    common: Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`key${i}`, `value ${i} ] keep`]))
  };
  const payload = [1, `x\\"resources\\":${JSON.stringify(resources)} y`];
  const html = `<script>self.__next_f.push(${JSON.stringify(payload)})</script>`;
  const result = __testables.extractI18nFromStreamingHtml(html);
  assert.ok(result);
  assert.equal(result.i18nStrings["common.key0"], "value 0 ] keep");
});

test("extractI18nFromStreamingHtml preserves escaped quotes inside parsed flight resources", () => {
  const resources = {
    common: Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`key${i}`, `value ${i}`])),
    contract: {
      editModal: {
        warning: `The audit status will reset to "Pending".`
      }
    }
  };
  const payload = [1, `x"resources":${JSON.stringify(resources)},"children":"$L20" y`];
  const html = `<script>self.__next_f.push(${JSON.stringify(payload)})</script>`;
  const result = __testables.extractI18nFromStreamingHtml(html);
  assert.ok(result);
  assert.equal(result.i18nStrings["contract.editModal.warning"], `The audit status will reset to "Pending".`);
});

test("extractI18nFromStreamingHtml chooses the largest streaming resources block", () => {
  const small = {
    common: Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`key${i}`, `small ${i}`])),
  };
  const large = {
    common: Object.fromEntries(Array.from({ length: 35 }, (_, i) => [`key${i}`, `large ${i}`])),
    presale: { "Token contract": "代幣合約" },
  };
  const smallPayload = [1, `x"resources":${JSON.stringify(small)} y`];
  const largePayload = [1, `x"resources":${JSON.stringify(large)} y`];
  const html = [
    `<script>self.__next_f.push(${JSON.stringify(smallPayload)})</script>`,
    `<script>self.__next_f.push(${JSON.stringify(largePayload)})</script>`,
  ].join("");
  const result = __testables.extractI18nFromStreamingHtml(html);
  assert.ok(result);
  assert.equal(Object.keys(result.i18nStrings).length, 36);
  assert.equal(result.i18nStrings["presale.Token contract"], "代幣合約");
});

test("unchanged i18n extraction stays quiet after baseline", () => {
  const i18nResult = { i18nHash: "same-hash", i18nStrings: { a: "b" } };
  assert.equal(__testables.shouldLogI18nExtraction(null, i18nResult), true);
  assert.equal(__testables.shouldLogI18nExtraction({ i18nHash: "old-hash" }, i18nResult), true);
  assert.equal(__testables.shouldLogI18nExtraction({ i18nHash: "same-hash" }, i18nResult), false);
});

test("i18n changes are attributed to visible page text only", () => {
  const changes = [
    { type: "added", key: "launch.notEligibleForPresale", value: "You are not eligible for this presale" },
    { type: "added", key: "launch.visible", value: "Visible launch copy" },
    { type: "modified", key: "launch.button", oldValue: "Old Button", newValue: "New Button" },
  ];
  const partitioned = __testables.partitionI18nChangesByPageVisibility(
    changes,
    "Old Button",
    "Create Token Visible launch copy New Button",
  );
  assert.deepEqual(partitioned.visible.map(c => c.key), ["launch.visible", "launch.button"]);
  assert.deepEqual(partitioned.resourceOnly.map(c => c.key), ["launch.notEligibleForPresale"]);
});

test("full frontend diff includes i18n details for pure i18n changes", () => {
  const diffText = __testables.buildFullDiffText(
    "/en/create-token",
    null,
    null,
    null,
    null,
    [],
    null,
    null,
    "https://four.meme/en/create-token",
    [{ type: "added", key: "launch.notEligibleForPresale", value: "You are not eligible for this presale" }],
  );
  assert.match(diffText, /i18n 国际化字符串变更/);
  assert.match(diffText, /launch\.notEligibleForPresale/);
  assert.match(diffText, /You are not eligible for this presale/);
  assert.equal(__testables.hasMeaningfulFrontendDiffBody(diffText), true);
});

test("header-only frontend diff is not considered meaningful", () => {
  const diffText = [
    "============================================================",
    "前端变更详细 Diff — /zh-TW/agentic",
    "时间: 2026/6/22 09:59:54",
    "============================================================",
    "",
    "============================================================",
  ].join("\n");
  assert.equal(__testables.hasMeaningfulFrontendDiffBody(diffText), false);
});

test("frontend notification dedupe key ignores full diff timestamps", () => {
  const base = {
    title: "前端 i18n 资源变更（影响 2 页）",
    url: "https://four.meme",
    content: "**类型：全局 i18n 资源变更**\n+ common.presale.Token contract: 代幣合約",
  };
  const first = __testables.frontendNotificationDedupeKey({
    ...base,
    fullDiff: "时间: 2026/6/22 13:00:07\n+ common.presale.Token contract: 代幣合約",
  });
  const second = __testables.frontendNotificationDedupeKey({
    ...base,
    fullDiff: "时间: 2026/6/22 13:00:28\n+ common.presale.Token contract: 代幣合約",
  });
  assert.equal(first, second);
});

test("single-page frontend merged card does not repeat URL in body", () => {
  const card = __testables.buildMergedFrontendAssetNotification({
    pages: [{ label: "/en/announcement", url: "https://four.meme/en/announcement" }],
    items: [{
      pageLabel: "/en/announcement",
      url: "https://four.meme/en/announcement",
      pageContent: "**📝 页面文案变更：**\n\n**新增：**\n- Live feed",
    }],
    assetContent: "",
    fullDiffs: [],
    template: "orange",
    signature: "announcement-copy",
  });

  assert.equal(card.title, "前端变更：/en/announcement");
  assert.equal(card.url, "https://four.meme/en/announcement");
  assert.doesNotMatch(card.content, /URL:/);
  assert.equal((card.content.match(/https:\/\/four\.meme\/en\/announcement/g) || []).length, 0);
  assert.match(card.content, /\*\*📄 \/en\/announcement\*\*/);
  assert.match(card.content, /\*\*\/en\/announcement\*\*/);
});

test("frontend text change card content is readable without code block scrolling", () => {
  const content = __testables.formatFrontendTextChanges([
    { type: "added", text: "Create Token Loading FOUR MEME Announcement Live feed Disclaimer: Digital assets are highly speculative and involve significant risk of loss." },
    { type: "removed", text: "Create Token Loading FOUR MEME Announcement Latest < header class= max-w-3xl 2026.02.02 FOUR.MEME Tax Mode is Live Learn more 2025.12.09" },
    { type: "modified", oldText: "Latest announcements", newText: "Live feed" },
  ]);

  assert.doesNotMatch(content, /```/);
  assert.match(content, /\*\*新增：\*\*/);
  assert.match(content, /\*\*移除：\*\*/);
  assert.match(content, /原：<font color="red">Latest announcements<\/font>/);
  assert.match(content, /新：<font color="green">Live feed<\/font>/);
  assert.match(content, /<font color="green">Create Token Loading/);
  assert.match(content, /<font color="red">Create Token Loading/);
  assert.match(content, /&lt; header/);
});

test("fourmeme diff cards use inline red-green highlights without scroll blocks", () => {
  const samples = [
    __testables.formatPoolChanges([
      {
        type: "参数变更",
        symbol: "BNB",
        fieldChanges: ['buyFee: "1" → "2"'],
      },
    ]),
    __testables.formatFrontendSignalChanges({
      added: ["文案: Live feed"],
      removed: ["文案: Latest announcements"],
    }),
    __testables.formatI18nChanges([
      { type: "added", key: "announcement.liveFeed", value: "Live feed" },
      { type: "modified", key: "announcement.title", oldValue: "Latest", newValue: "Live" },
      { type: "removed", key: "announcement.old", value: "Old announcement" },
    ]),
    __testables.formatRouteChanges({
      added: ["/en/live"],
      removed: ["/en/latest"],
    }),
    __testables.formatApiChanges([
      { type: "结构变更", endpoint: "public_config", added: ["data.newField (string)"], removed: ["data.oldField"], changed: ["data.flag: boolean → string"] },
    ], {}),
    __testables.formatApiValueChanges([
      { type: "值变更", endpoint: "public_config", fieldChanges: [
        { action: "added", key: "data.new", value: "yes" },
        { action: "removed", key: "data.old", value: "no" },
        { action: "changed", key: "data.flag", old: false, new: true },
      ] },
    ]),
    __testables.formatOpenFourTemplateChanges({
      added: [{ id: "1", name: "Gift", status: "PUBLISHED", tag: "vault" }],
      statusChanged: [{ item: { id: "2", name: "Agent", status: "PUBLISHED" }, oldStatus: "DRAFT", newStatus: "PUBLISHED" }],
    }),
    __testables.formatContractChanges([
      { type: "合约地址变化", label: "TokenManager", oldAddress: "0xold", address: "0xnew", oldHash: "hashOld", newHash: "hashNew" },
    ]),
    __testables.formatOnchainChanges([
      { type: "Agent NFT 数量变更", old: 1, new: 2 },
      { type: "新增 Agent NFT 合约", addresses: ["0x0000000000000000000000000000000000000001"] },
      { type: "移除 Agent NFT 合约", addresses: ["0x0000000000000000000000000000000000000002"] },
    ]),
    __testables.formatGithubChanges([
      {
        sha: "1234567890abcdef",
        commit: {
          author: { name: "dev", date: "2026-06-27T00:00:00Z" },
          message: "更新文案",
        },
        files: [
          {
            filename: "src/page.tsx",
            status: "modified",
            additions: 1,
            deletions: 1,
            patch: "@@ -1 +1 @@\n-old copy\n+new copy",
          },
        ],
      },
    ]),
  ];

  for (const content of samples) {
    assert.doesNotMatch(content, /```/);
  }
  assert(samples.some(content => content.includes('<font color="green">')));
  assert(samples.some(content => content.includes('<font color="red">')));
});

test("fourmeme cards render long urls and addresses as concise links", () => {
  const failure = __testables.buildFrontendFailureNotifications([
    "https://four.meme/en/announcement",
  ], {
    _frontendFailCounts: {
      [__testables.urlToKey("https://four.meme/en/announcement")]: {
        count: 3,
        reason: "http_500",
        message: "HTTP 500",
      },
    },
  })[0];
  assert.match(failure.content, /\[\/en\/announcement\]\(https:\/\/four\.meme\/en\/announcement\)/);
  assert.doesNotMatch(failure.content, /- https:\/\/four\.meme/);

  const moduleCard = __testables.formatOpenFourNewModules([
    { address: "0x0000000000000000000000000000000000000001", roles: ["swap"], presetIds: ["1"] },
  ], { blockNumber: 123, txHash: "0xabcdef" });
  assert.match(moduleCard, /\[0x0000\.\.\.0001\]\(https:\/\/bscscan\.com\/address\/0x0000000000000000000000000000000000000001\)/);
  assert.doesNotMatch(moduleCard, /\*\*0x0000000000000000000000000000000000000001\*\*/);

  const contractCard = __testables.formatContractChanges([
    {
      type: "合约地址变化",
      label: "TokenManager",
      oldAddress: "0x0000000000000000000000000000000000000001",
      address: "0x0000000000000000000000000000000000000002",
      oldImpl: "0x0000000000000000000000000000000000000003",
      newImpl: "0x0000000000000000000000000000000000000004",
    },
  ]);
  assert.match(contractCard, /\[旧地址\]\(https:\/\/bscscan\.com\/address\/0x0000000000000000000000000000000000000001\)/);
  assert.match(contractCard, /\[新地址\]\(https:\/\/bscscan\.com\/address\/0x0000000000000000000000000000000000000002\)/);

  const actorCard = __testables.formatActorActions([
    {
      risk: "high",
      method: "create",
      blockNumber: 123,
      from: "0x0000000000000000000000000000000000000001",
      to: "0x0000000000000000000000000000000000000002",
      contractAddress: "0x0000000000000000000000000000000000000003",
      status: "0x1",
      reason: "test",
      hash: "0xabc",
    },
  ]);
  assert.match(actorCard, /\[0x0000\.\.\.0001\]\(https:\/\/bscscan\.com\/address\/0x0000000000000000000000000000000000000001\)/);
  assert.match(actorCard, /\[查看交易\]\(https:\/\/bscscan\.com\/tx\/0xabc\)/);
});

test("small i18n remove-only changes require consecutive confirmation", () => {
  const oldStrings = Object.fromEntries(Array.from({ length: 1102 }, (_, i) => [`k${i}`, `v${i}`]));
  const newStrings = { ...oldStrings };
  delete newStrings.k1;
  const changes = __testables.diffI18nStrings(oldStrings, newStrings);
  const state = {};
  assert.deepEqual(__testables.i18nChangeTypeCounts(changes), { added: 0, modified: 0, removed: 1 });
  assert.equal(__testables.shouldConfirmI18nRemoval(state, "page", changes, oldStrings, newStrings), false);
  assert.equal(__testables.shouldConfirmI18nRemoval(state, "page", changes, oldStrings, newStrings), false);
  assert.equal(__testables.shouldConfirmI18nRemoval(state, "page", changes, oldStrings, newStrings), true);
});

test("failed discovered frontend URLs are suppressed during cooldown", () => {
  const route = `/codex-suppressed-${Date.now()}`;
  const url = `https://four.meme/zh-TW${route}`;
  assert.equal(__testables.recordFailedDiscoveredFrontendUrls([url], [{ url, reason: "http_404", message: "HTTP 404 Not Found", status: 404 }]), true);
  assert.equal(__testables.isSuppressedDiscoveredFrontendUrl(url), true);
  const discovered = __testables.discoverFrontendUrlsFromPages({
    page: { routes: [route] }
  }, []);
  assert.deepEqual(discovered, []);
});

test("failed discovered frontend URL state wins over older discovery history", () => {
  const url = `https://four.meme/zh-TW/codex-stale-history-${Date.now()}`;
  const target = {
    [url]: { url, firstSeenAt: 1000, lastSeenAt: 1000 },
  };
  const source = {
    [url]: { url, firstSeenAt: 1000, lastSeenAt: 2000, failedDiscoveryAt: 5000, lastFailureStatus: 404 },
  };
  assert.equal(__testables.mergeRouteDecisionMap(target, source), true);
  assert.equal(target[url].failedDiscoveryAt, 5000);
  assert.equal(target[url].lastFailureStatus, 404);
});

test("unchanged frontend route state is not reported as a merged change", () => {
  const url = `https://four.meme/zh-TW/codex-unchanged-route-${Date.now()}`;
  const target = {
    [url]: { url, firstSeenAt: 1000, lastSeenAt: 2000, failedDiscoveryAt: 5000, lastFailureStatus: 404 },
  };
  const before = structuredClone(target);
  const source = {
    [url]: { ...target[url] },
  };
  assert.equal(__testables.mergeRouteDecisionMap(target, source), false);
  assert.deepEqual(target, before);
});

test("diffRoutes suppresses small remove-only SSR jitter", () => {
  const diff = __testables.diffRoutes(["/zh-TW/create-token", "/zh-TW/advanced"], ["/zh-TW/create-token"]);
  assert.deepEqual(diff, { added: [], removed: [] });
});

test("extractRouteSignals separates frontend pages from API endpoints", () => {
  const signals = __testables.extractRouteSignals(
    `<a href="/zh-TW/create-token">Create</a>`,
    { "chunk.js": { strings: ["/meme-api/v1/public/config", "/zh-TW/advanced"] } },
    null,
  );
  assert.deepEqual(signals.routes, ["/zh-TW/advanced", "/zh-TW/create-token"]);
  assert.deepEqual(signals.endpoints, ["/meme-api/v1/public/config"]);
});

test("extractRouteSignals filters resource links and placeholder dynamic routes", () => {
  const signals = __testables.extractRouteSignals(
    `<link rel="preload" href="/_next/static/chunks/app.js">
     <a href="/zh-TW/null">bad null</a>
     <a href="/zh-TW/token/undefined">bad token</a>
     <a href="/zh-TW/contract/1778027615723">dynamic contract</a>
     <a href="/zh-TW/contract/create">create contract</a>`,
    null,
    null,
  );
  assert.deepEqual(signals.routes, ["/zh-TW/contract/create"]);
});

test("classifyFetchFailure distinguishes backoff and rate limits", () => {
  assert.equal(__testables.classifyFetchFailure(new Error("[退避中] four.meme")), "backoff");
  assert.equal(__testables.classifyFetchFailure(new Error("HTTP 429 (风控)")), "rate_limited");
});

test("unchanged create-token assets reuse previous asset contents", () => {
  const oldFeatures = {
    assetHash: "same-assets",
    assetContents: {
      "main.js": { contentHash: "old", size: 100, strings: ["Create Token", "buyFee"], ext: "js" },
    },
  };
  const features = { assetHash: "same-assets" };
  assert.equal(
    __testables.shouldReuseFrontendAssetContents("https://four.meme/en/create-token", oldFeatures, features),
    true,
  );
});

test("frontend asset store stores shared asset summaries once", () => {
  const store = {};
  const first = {
    "a.js": { url: "https://four.meme/_next/a.js", contentHash: "h1", size: 10, strings: ["Create"], ext: "js" },
    "b.js": { url: "https://four.meme/_next/b.js", contentHash: "h2", size: 20, strings: ["Launch"], ext: "js" },
  };
  const second = {
    "a.js": { url: "https://four.meme/_next/a.js", contentHash: "h1", size: 10, strings: ["Create"], ext: "js" },
  };
  const firstRefs = __testables.compactFrontendAssetContents(first, store);
  const secondRefs = __testables.compactFrontendAssetContents(second, store);
  assert.deepEqual(firstRefs, { "a.js": "h1", "b.js": "h2" });
  assert.deepEqual(secondRefs, { "a.js": "h1" });
  assert.deepEqual(Object.keys(store).sort(), ["h1", "h2"]);
  assert.deepEqual(__testables.hydrateFrontendAssetContents(secondRefs, store), {
    "a.js": { contentHash: "h1", size: 10, strings: ["Create"], ext: "js", url: "https://four.meme/_next/a.js" },
  });
});

test("global i18n resource watch notifies resource once and confirmation once", () => {
  const state = {};
  const group = {
    signature: "sig-community",
    changes: [
      { type: "added", key: "community.topMembers", value: "Top members" },
      { type: "added", key: "community.shareCommunity", value: "Share Community" },
    ],
    pages: [
      { key: "https://four.meme/en/create-token", label: "/en/create-token", url: "https://four.meme/en/create-token" },
    ],
  };

  const first = __testables.registerGlobalI18nResourceWatch(state, group);
  assert.equal(first.isNew, true);
  assert.equal(first.item.primaryNamespace, "community");
  const resourceNotice = __testables.buildGlobalI18nResourceNotification(first.item);
  assert.equal(resourceNotice.dedupeKey, "frontend:i18n-resource:sig-community");
  assert.match(resourceNotice.content, /上线确认队列/);

  const second = __testables.registerGlobalI18nResourceWatch(state, group);
  assert.equal(second.isNew, false);

  const pending = __testables.confirmGlobalI18nResourceWatches(state, {
    create: {
      originalUrl: "https://four.meme/en/create-token",
      textContent: "Create Token",
      routes: [],
      assetContents: {
        "community.js": {
          strings: ["community.topMembers", "Top members", "community"],
        },
      },
    },
  });
  assert.equal(pending.notifications.length, 0);
  assert.equal(state._globalI18nResourceWatch[first.item.key].status, "pending");

  const confirmed = __testables.confirmGlobalI18nResourceWatches(state, {
    community: {
      originalUrl: "https://four.meme/en/community",
      textContent: "Top members Share Community",
      routes: ["/en/community"],
      assetContents: {},
    },
  });
  assert.equal(confirmed.notifications.length, 1);
  assert.equal(state._globalI18nResourceWatch[first.item.key].status, "confirmed");
  assert.equal(confirmed.notifications[0].dedupeKey, `frontend:i18n-resource-confirmed:${first.item.key}`);

  const repeated = __testables.confirmGlobalI18nResourceWatches(state, {
    community: {
      originalUrl: "https://four.meme/en/community",
      textContent: "Top members Share Community",
      routes: ["/en/community"],
      assetContents: {},
    },
  });
  assert.equal(repeated.notifications.length, 0);
});

test("global i18n resource watch confirms from static assets without probing guessed pages", () => {
  const state = {};
  const group = {
    signature: "sig-community-static",
    changes: [
      { type: "added", key: "community.topMembers", value: "Top members" },
      { type: "added", key: "community.members", value: "Members" },
    ],
    pages: [
      { key: "https://four.meme/en/create-token", label: "/en/create-token", url: "https://four.meme/en/create-token" },
    ],
  };
  const { item } = __testables.registerGlobalI18nResourceWatch(state, group);

  const extracted = __testables.extractStaticAssetPathsFromText(
    `self.__BUILD_MANIFEST={"app/community/page":["static/chunks/app/community/page-abc123.js"]}`,
  );
  assert.deepEqual(extracted, ["/_next/static/chunks/app/community/page-abc123.js"]);

  assert.equal(__testables.mergeStaticAssetIndexFromPages(state, {
    staticPage: {
      originalUrl: "https://four.meme/en/create-token",
      assetFiles: ["/_next/static/chunks/app/community/page-abc123.js"],
      assetContents: {
        "/_next/static/chunks/app/community/page-abc123.js": {
          url: "https://four.meme/_next/static/chunks/app/community/page-abc123.js",
          contentHash: "h-community",
          size: 1200,
          strings: ["/en/community", "community.topMembers", "Top members", "community.members", "Members"],
          ext: "js",
        },
      },
    },
  }), true);

  const evidence = __testables.detectGlobalI18nStaticEvidence(item, state);
  assert(evidence.some(e => e.type === "static_route"));
  const confirmed = __testables.confirmGlobalI18nResourceWatches(state, {
    create: {
      originalUrl: "https://four.meme/en/create-token",
      textContent: "Create Token",
      routes: [],
      assetContents: {},
    }
  });
  assert.equal(confirmed.notifications.length, 1);
  assert.equal(state._globalI18nResourceWatch[item.key].status, "confirmed");
  assert.match(confirmed.notifications[0].content, /静态资源路由信号/);
});

test("failed static asset expansion candidates are cooled down", () => {
  const state = {
    _frontendStaticIndex: {
      assets: {
        "/_next/static/chunks/app/layout-a.js": {
          path: "/_next/static/chunks/app/layout-a.js",
          strings: [],
        },
      },
    },
  };
  const pages = {
    create: {
      originalUrl: "https://four.meme/en/create-token",
      assetFiles: ["/_next/static/chunks/app/layout-a.js"],
      assetContents: {
        "/_next/static/chunks/app/layout-a.js": {
          strings: ['"/_next/static/build123/_buildManifest.js"', '"/_next/static/build123/_ssgManifest.js"'],
        },
      },
    },
  };

  const first = __testables.collectStaticAssetExpansionPaths(state, pages);
  assert.deepEqual(first, [
    "/_next/static/build123/_buildManifest.js",
    "/_next/static/build123/_ssgManifest.js",
  ]);

  assert.equal(__testables.recordStaticAssetExpansionResults(state, first, {}), true);
  assert.equal(Object.keys(state._frontendStaticIndex.failedAssets).length, 2);
  assert.deepEqual(__testables.collectStaticAssetExpansionPaths(state, pages), []);

  assert.equal(__testables.recordStaticAssetExpansionResults(state, [first[0]], {
    [first[0]]: { contentHash: "ok", size: 10, strings: [] },
  }), true);
  assert.equal(state._frontendStaticIndex.failedAssets[first[0]], undefined);
});

test("module metrics keep bounded duration history and totals", () => {
  const metrics = __testables.createModuleMetricsState();
  __testables.recordModuleMetric(metrics, "frontend", { durationMs: 10, requestCount: 3, backoffCount: 1, errorCount: 0 });
  __testables.recordModuleMetric(metrics, "frontend", { durationMs: 30, requestCount: 2, backoffCount: 0, errorCount: 1 });
  const summary = __testables.summarizeModuleMetrics(metrics, "frontend");
  assert.equal(summary.runs, 2);
  assert.equal(summary.lastDurationMs, 30);
  assert.equal(summary.avgDurationMs, 20);
  assert.equal(summary.requestCount, 5);
  assert.equal(summary.backoffCount, 1);
  assert.equal(summary.errorCount, 1);
});

test("host limiter spaces same-host tasks without changing caller order", async () => {
  let now = 0;
  const waits = [];
  const limiter = __testables.createHostLimiter({
    minDelayMs: 100,
    now: () => now,
    sleepFn: async (ms) => { waits.push(ms); now += ms; },
  });
  await limiter.schedule("https://four.meme/a", async () => "first");
  const second = await limiter.schedule("https://four.meme/b", async () => "second");
  assert.equal(second, "second");
  assert.deepEqual(waits, [100]);
});
