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
  assert.match(progress, /前端监控:[\s\S]*每 10s/);
  assert.match(progress, /API监控:[\s\S]*每 15s/);
  assert.match(ready, /前端监控:[\s\S]*每 10s/);
  assert.match(ready, /API监控:[\s\S]*每 15s/);
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

test("new frontend page notification records successful monitoring enrollment", () => {
  const notification = __testables.buildFrontendNewPageNotification({
    originalUrl: "https://four.meme/en/presale/102364633",
    assetFiles: ["/_next/static/a.js"],
    textContent: "Mame Inu Description Rule Details",
    i18nStrings: { a: "b" },
    routes: ["/en/presale/102364633"],
  });
  assert.equal(notification.title, "前端新页面发现：/en/presale/102364633");
  assert.match(notification.content, /已成功抓取并纳入同一前端监控池/);
  assert.equal(notification.dedupeKey, "frontend:new-page:https://four.meme/en/presale/102364633");
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
