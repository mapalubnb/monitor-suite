import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FOURMEME_MONITOR_TEST = "1";

const { __testables } = await import("./monitor.mjs");

test('API 混合名称样本与排序变化不会生成新增删除告警', () => {
  const { extractStructure, stabilizeApiListTypes, diffApiStructures } = __testables;
  const extract = rows => ({ token_search_new: extractStructure({data: rows}, '', 'token_search_new') });
  const baseline = extract([{name: 'normal'}]);
  const mixed = extract([{name: []}, {name: 'normal'}]);
  assert.deepEqual(mixed, extract([{name: 'normal'}, {name: []}]));
  const next = stabilizeApiListTypes(baseline, mixed, new Map());
  assert.deepEqual(diffApiStructures(baseline, next), []);
  assert.deepEqual(diffApiStructures(next, baseline), []);
  const legacy = structuredClone(baseline);
  legacy.token_search_new['data[0].name[]'] = 'array';
  assert.deepEqual(diffApiStructures(legacy, baseline), []);
});

test('API 稳定类型变更需三轮确认，失败和混合样本中断确认', () => {
  const { extractStructure, stabilizeApiListTypes, diffApiStructures } = __testables;
  const extract = name => ({ token_search_new: extractStructure({data: [{name}]}, '', 'token_search_new') });
  let baseline = extract('normal');
  const pending = new Map();
  const array = extract([]);
  assert.deepEqual(diffApiStructures(baseline, stabilizeApiListTypes(baseline, array, pending)), []);
  stabilizeApiListTypes(baseline, {}, pending);
  assert.equal(pending.size, 0);
  const mixed = {token_search_new: {'data[0].name': 'array|string'}};
  stabilizeApiListTypes(baseline, array, pending);
  stabilizeApiListTypes(baseline, mixed, pending);
  assert.equal(pending.size, 0);
  for (let i = 0; i < 2; i++) {
    const next = stabilizeApiListTypes(baseline, array, pending);
    assert.deepEqual(diffApiStructures(baseline, next), []);
    baseline = next;
  }
  const confirmed = stabilizeApiListTypes(baseline, array, pending);
  assert.deepEqual(diffApiStructures(baseline, confirmed)[0].changed, ['data[0].name: string → array']);
  assert.deepEqual(diffApiStructures(confirmed, stabilizeApiListTypes(confirmed, array, pending)), []);
});

test('API 真正新增数组字段与非列表类型变更仍立即报告', () => {
  const { stabilizeApiListTypes, diffApiStructures } = __testables;
  const before = {token_search_new: {code: 'number'}, public_config: {flag: 'boolean'}};
  const after = {token_search_new: {code: 'number', 'data[0].features': 'array', 'data[0].features[]': 'array'}, public_config: {flag: 'string'}};
  const changes = diffApiStructures(before, stabilizeApiListTypes(before, after, new Map()));
  assert.deepEqual(changes[0].added, ['data[0].features (array)']);
  assert.deepEqual(changes[1].changed, ['flag: boolean → string']);
});

test('first scan completion does not wait for the queued WSS follow-up scan', async () => {
  let releaseFirst, releaseSecond;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const secondGate = new Promise(resolve => { releaseSecond = resolve; });
  let count = 0, idle = false;
  const runner = __testables.createModuleRunner('startup-test', async () => {
    if (++count === 1) await firstGate;
    else await secondGate;
  }, 1000);
  const running = runner.run().then(() => { idle = true; });
  await runner.run();
  releaseFirst();
  assert.equal(await runner.firstRun, 'complete');
  assert.equal(idle, false);
  assert.equal(count, 2);
  releaseSecond();
  await running;
});

test('failed first scan settles startup progress without claiming success', async () => {
  const runner = __testables.createModuleRunner('startup-failure', async () => {
    throw new Error('simulated source unavailable');
  }, 1000);
  await runner.run();
  assert.equal(await runner.firstRun, 'failed');
  assert.equal(runner.firstRunStatus, 'failed');
});

test('real module runner atomically persists its state and notification and rolls back failed scans', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fourmeme-transaction-'));
  const config = __testables.CONFIG;
  const originalPath = config.snapshotFile;
  try {
    config.snapshotFile = join(dir, 'snapshot.json');
    const state = __testables.setSnapshotForTests({ poolConfig: { revision: 1 } });
    await __testables.saveSnapshot();
    const read = () => JSON.parse(readFileSync(config.snapshotFile, 'utf8'));
    const runner = __testables.createModuleRunner('pool', async () => {
      state.poolConfig.revision = 2;
      await __testables.saveSnapshot();
      assert.equal(read().poolConfig.revision, 1);
      await __testables.sendNotificationMaybeAi({ title: 'pool update', content: 'test', skipAi: true });
    }, 2000);
    await runner.run();
    assert.equal(read().poolConfig.revision, 2);
    assert.equal(read()._notificationOutbox.length, 1);
    assert.equal(read()._atomicNotifications, true);
    await __testables.createModuleRunner('pool', async () => {
      state.poolConfig.revision = 3;
      await __testables.saveSnapshot();
      throw new Error('simulated read failure');
    }, 2000).run();
    assert.equal(read().poolConfig.revision, 2);
    assert.equal(state.poolConfig.revision, 2);
  } finally {
    config.snapshotFile = originalPath;
    __testables.setSnapshotForTests({});
    rmSync(dir, { recursive: true, force: true });
  }
});

test('atomic snapshot migration ignores stale actor checkpoint and rejects corrupt snapshots', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fourmeme-snapshot-'));
  const config = __testables.CONFIG;
  const previous = { snapshotFile: config.snapshotFile, actorStateFile: config.actorStateFile };
  try {
    config.snapshotFile = join(dir, 'snapshot.json');
    config.actorStateFile = join(dir, 'actor-state.json');
    writeFileSync(config.snapshotFile, JSON.stringify({ _atomicNotifications: true, chainActorMonitor: { lastBlock: 200 } }));
    writeFileSync(config.actorStateFile, JSON.stringify({ chainActorMonitor: { lastBlock: 100 } }));
    assert.equal(__testables.loadSnapshot().chainActorMonitor.lastBlock, 200);
    writeFileSync(config.snapshotFile, '{broken');
    assert.throws(() => __testables.loadSnapshot(), /快照读取失败/);
  } finally {
    Object.assign(config, previous);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GitHub six commits are unique and pagination covers more than 100 commits", async () => {
  const commits = Array.from({ length: 106 }, (_, i) => ({ sha: `sha${i}` }));
  const pages = [];
  const result = await __testables.checkGithub('sha105', async (size, page) => {
    pages.push(page); return commits.slice((page - 1) * size, page * size);
  }, async sha => ({ sha, files: [] }), async () => {});
  assert.deepEqual(pages, [1, 2]);
  assert.equal(result.newCommits.length, 105);
  assert.equal(new Set(result.newCommits.map(c => c.sha)).size, 105);
  const six = await __testables.checkGithub('old', async () => commits.slice(0, 6), async sha => ({ sha }), async () => {});
  assert.equal(six.newCommits.length, 6);
});

test("missing actor blocks and mixed forks cannot advance a scan", async () => {
  await assert.rejects(__testables.fetchActorBlockActions(1, 1, { actors: new Map() }, { seenTxs: [] }, async () => [null]), /不完整/);
  const hash = `0x${'1'.repeat(64)}`;
  const calls = [1, 2].map(n => ({ params: [`0x${n}`, true] }));
  assert.throws(() => __testables.validateActorBlocks(calls, [
    { number: '0x1', hash, transactions: [] },
    { number: '0x2', hash, parentHash: 'wrong', transactions: [] },
  ]), /分叉/);
  await assert.rejects(__testables.fetchValidatedActorBlocks(
    calls.slice(0, 1), ['0x1111111111111111111111111111111111111111'],
    async (_, __, options) => options.parseResponse({ text: async () => '[{"id":1,"result":null}]' }),
    async () => [null],
  ), /不完整/);
});

test('large actor reads split before transport and validate across batch boundaries', async () => {
  const calls = Array.from({ length: 45 }, (_, i) => ({ method: 'eth_getBlockByNumber', params: ['0x' + (i + 1).toString(16), true] }));
  const sizes = [], hash = n => '0x' + n.toString(16).padStart(64, '0');
  let fork = false;
  const request = async (payload, _, options) => {
    sizes.push(payload.length);
    const data = payload.map(item => { const n = Number(item.params[0]); return { id: item.id, result: { number: item.params[0], hash: hash(n), parentHash: hash(fork && n === 21 ? 0 : n - 1), transactions: [] } }; });
    return options.parseResponse({ text: async () => JSON.stringify(data) });
  };
  assert.equal((await __testables.fetchValidatedActorBlocks(calls, ['actor'], request)).length, 45);
  assert.deepEqual(sizes, [20, 20, 5]); fork = true;
  await assert.rejects(__testables.fetchValidatedActorBlocks(calls, ['actor'], request), /分叉/);
});

test("OpenFour failed count and truncated preset pages never become removals", async () => {
  await assert.rejects(__testables.fetchOpenFourPresetIds(async () => [null]), /数量读取失败/);
  let calls = 0;
  await assert.rejects(__testables.fetchOpenFourPresetIds(async () => ++calls === 1 ? [`0x${'1'.padStart(64, '0')}`] : [null]), /列表读取失败/);
});

test("HTTP timeout includes stalled response body after headers", async () => {
  let headersSent = false;
  const server = createServer((_, res) => { res.writeHead(200); res.flushHeaders(); headersSent = true; res.write('partial'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await assert.rejects(__testables.fetchWithTimeout(`http://127.0.0.1:${server.address().port}/`, {}, 150), /abort/i);
    assert.equal(headersSent, true);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test("contract code cache preserves fast slot checks and expires for periodic audit", async () => {
  const cache = new Map();
  const calls = [{ method: 'eth_getStorageAt', params: ['0x1'] }, { method: 'eth_getCode', params: ['0x1'] }];
  const batches = [];
  const rpc = async batch => { batches.push(batch.map(c => c.method)); return batch.map(c => c.method === 'eth_getCode' ? '0x6000' : `0x${'0'.repeat(64)}`); };
  await __testables.cachedContractBatch(calls, rpc, cache, 1);
  await __testables.cachedContractBatch(calls, rpc, cache, 2);
  await __testables.cachedContractBatch(calls, rpc, cache, 600_001);
  assert.deepEqual(batches, [['eth_getStorageAt', 'eth_getCode'], ['eth_getStorageAt'], ['eth_getStorageAt', 'eth_getCode']]);
});

test("default fourmeme frontend and api cadences are fast but bounded", () => {
  assert.equal(__testables.CONFIG.intervals.pool, 2_000);
  assert.equal(__testables.CONFIG.intervals.frontend, 7_000);
  assert.equal(__testables.CONFIG.intervals.api, 10_000);
  assert.equal(__testables.CONFIG.intervals.openfourTemplates, 2_000);
  assert.equal(__testables.CONFIG.intervals.contract, 2_000);
  assert.equal(__testables.CONFIG.intervals.onchain, 2_000);
  assert.equal(__testables.CONFIG.actorMonitor.httpFallbackMs, 8_000);
  assert.equal(__testables.CONFIG.openFourRegistryLogMonitor.discoveryDebounceMs, 1_000);
  assert.equal(__testables.CONFIG.jitterMs, 100);
  assert.equal(__testables.CONFIG.apiProbeStaggerMs, 150);
  assert.equal(__testables.CONFIG.hostRequestMinDelayMs, 60);
  assert.equal(__testables.CONFIG.frontendRouteRemovalConfirmRuns, 2);
  assert.deepEqual(__testables.CONFIG.bscRpcUrls, [
    "https://bsc.rpc.blxrbdn.com",
    "https://rpc.48.club",
    "https://bnb-mainnet.g.alchemy.com/public",
    "https://bsc-rpc.publicnode.com",
  ]);
  assert.equal(__testables.nextUA(), __testables.nextUA());
});

test("RPC endpoint pool rotates healthy nodes and favors lower in-flight", () => {
  let now = 100;
  const pool = __testables.createRpcEndpointPool([
    "https://rpc-1.test",
    "https://rpc-2.test",
    "https://rpc-3.test",
  ], { now: () => now++, isBackedOff: () => false });
  const first = pool.acquire();
  const second = pool.acquire();
  assert.equal(first.endpoint.url, "https://rpc-1.test");
  assert.equal(second.endpoint.url, "https://rpc-2.test");
  pool.succeed(first);
  pool.succeed(second);
  assert.equal(pool.acquire().endpoint.url, "https://rpc-3.test");
});

test("RPC endpoint pool skips a backed-off node", () => {
  const pool = __testables.createRpcEndpointPool([
    "https://limited.test",
    "https://healthy.test",
  ], { isBackedOff: url => url.includes("limited") });
  assert.equal(pool.acquire().endpoint.url, "https://healthy.test");
});

test("RPC request immediately switches nodes after one endpoint is rate limited", async () => {
  const pool = __testables.createRpcEndpointPool([
    "https://limited.test",
    "https://healthy.test",
  ], { isBackedOff: () => false });
  const requestedUrls = [];
  const result = await __testables.requestBscRpcPayload(
    { jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] },
    8_000,
    {
      pool,
      inflight: new Map(),
      fetchFn: async url => {
        requestedUrls.push(url);
        if (url.includes("limited")) throw new Error("HTTP 429 (风控)");
        return { json: async () => ({ jsonrpc: "2.0", id: 1, result: "0x2" }) };
      },
    },
  );
  assert.equal(result.result, "0x2");
  assert.deepEqual(requestedUrls, ["https://limited.test", "https://healthy.test"]);
});

test("identical concurrent RPC payloads share one HTTP request", async () => {
  const pool = __testables.createRpcEndpointPool(["https://rpc.test"], { isBackedOff: () => false });
  const inflight = new Map();
  let requests = 0;
  let resolveRequest;
  const fetchFn = async () => {
    requests++;
    await new Promise(resolve => { resolveRequest = resolve; });
    return { json: async () => ({ jsonrpc: "2.0", id: 1, result: "0x1" }) };
  };
  const payload = { jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] };
  const first = __testables.requestBscRpcPayload(payload, 8_000, { pool, inflight, fetchFn });
  const second = __testables.requestBscRpcPayload(payload, 8_000, { pool, inflight, fetchFn });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests, 1);
  resolveRequest();
  assert.deepEqual(await Promise.all([first, second]), [
    { jsonrpc: "2.0", id: 1, result: "0x1" },
    { jsonrpc: "2.0", id: 1, result: "0x1" },
  ]);
  assert.equal(inflight.size, 0);
});

test("RPC request fails fast once every endpoint is backed off", async () => {
  const pool = __testables.createRpcEndpointPool([
    "https://rpc-1.test",
    "https://rpc-2.test",
  ], { isBackedOff: () => true });
  let requests = 0;
  await assert.rejects(
    __testables.requestBscRpcPayload(
      { jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] },
      8_000,
      { pool, inflight: new Map(), fetchFn: async () => { requests++; } },
    ),
    error => error.code === "BSC_RPC_ALL_BACKED_OFF",
  );
  assert.equal(requests, 0);
});

test("batch RPC responses are restored to request id order", () => {
  const calls = [
    { method: "eth_blockNumber", params: [] },
    { method: "eth_getCode", params: ["0x1", "latest"] },
  ];
  assert.deepEqual(__testables.normalizeBscRpcBatchResults(calls, [
    { jsonrpc: "2.0", id: 2, result: "0xcode" },
    { jsonrpc: "2.0", id: 1, result: "0xblock" },
  ]), ["0xblock", "0xcode"]);
});

test("actor raw prefilter does not retry through batch when all RPC nodes back off", async () => {
  const error = new Error("all backed off");
  error.code = "BSC_RPC_ALL_BACKED_OFF";
  let fallbackCalls = 0;
  await assert.rejects(
    __testables.fetchValidatedActorBlocks(
      [{ method: "eth_getBlockByNumber", params: ["latest", true] }],
      ["0x1111111111111111111111111111111111111111"],
      async () => { throw error; },
      async () => { fallbackCalls++; return []; },
    ),
    candidate => candidate === error,
  );
  assert.equal(fallbackCalls, 0);
});

test("contract fingerprints use storage and code without eth_getProof", async () => {
  const address = "0x1111111111111111111111111111111111111111";
  const implementation = "0x2222222222222222222222222222222222222222";
  const slot = `0x${"0".repeat(24)}${implementation.slice(2)}`;
  const batches = [];
  const result = await __testables.fetchContractFingerprintsForTargets([
    { label: "Proxy", addr: address, source: "test", networkCode: "BSC" },
  ], async calls => {
    batches.push(calls);
    assert.equal(calls.some(call => call.method === "eth_getProof"), false);
    if (batches.length === 1) {
      assert.deepEqual(calls.map(call => call.method), ["eth_getStorageAt", "eth_getCode"]);
      return [slot, "0x63a9059cbb00"];
    }
    assert.deepEqual(calls, [{ method: "eth_getCode", params: [implementation, "latest"] }]);
    return ["0x635c60da1b00"];
  });
  assert.equal(batches.length, 2);
  assert.equal(result.Proxy.address, address);
  assert.equal(result.Proxy.implAddress, implementation);
  assert.equal(result.Proxy.codeSize, 6);
  assert.equal(result.Proxy.implCodeSize, 6);
  assert.deepEqual(result.Proxy.selectors, ["0xa9059cbb"]);
  assert.deepEqual(result.Proxy.implSelectors, ["0x5c60da1b"]);
  assert.equal("rpcCodeHash" in result.Proxy, false);
  assert.equal("implRpcCodeHash" in result.Proxy, false);
});

test("contract fingerprint RPC failure cannot become empty bytecode", async () => {
  const zeroSlot = `0x${"0".repeat(64)}`;
  await assert.rejects(
    __testables.fetchContractFingerprintsForTargets([
      { label: "TokenManager", addr: "0x3333333333333333333333333333333333333333", source: "test" },
    ], async calls => {
      assert.deepEqual(calls.map(call => call.method), ["eth_getStorageAt", "eth_getCode"]);
      return [zeroSlot, null];
    }),
    /字节码读取失败，保留上一轮快照/,
  );
});

test("restart card reports process and baseline separately within one card", () => {
  const card = __testables.buildFourmemeRestartCard();
  assert.equal(card.title, "Four.meme 监控已启动");
  assert.match(card.content, /进程已启动/);
  assert.match(card.content, /前端：每 7 秒｜API：每 10 秒/);
  assert.match(card.content, /首轮检查：完成 0\/10/);
  assert.doesNotMatch(card.content, /全部模块首轮检查完成|监控启动中/);
  assert.ok(card.content.length < 460);
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
  assert.equal(notification.cardOpts, undefined);
  assert.doesNotMatch(notification.content, /卡片下方|加入监控”或“忽略/);
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

test("long Four.meme cards are kept as complete chunks instead of one-card patches", () => {
  assert.equal(__testables.isTooLongForSingleCard("短内容"), false);
  assert.equal(__testables.isTooLongForSingleCard("完整内容".repeat(25_000)), true);
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

test("fourmeme cards render complete urls, addresses and transaction hashes", () => {
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
  assert.match(failure.content, /\[https:\/\/four\.meme\/en\/announcement\]\(https:\/\/four\.meme\/en\/announcement\)/);

  const moduleCard = __testables.formatOpenFourNewModules([
    { address: "0x0000000000000000000000000000000000000001", roles: ["swap"], presetIds: ["1"] },
  ], { blockNumber: 123, txHash: "0xabcdef" });
  assert.match(moduleCard, /\[0x0000000000000000000000000000000000000001\]\(https:\/\/bscscan\.com\/address\/0x0000000000000000000000000000000000000001\)/);

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
  assert.match(actorCard, /\[0x0000000000000000000000000000000000000001\]\(https:\/\/bscscan\.com\/address\/0x0000000000000000000000000000000000000001\)/);
  assert.match(actorCard, /\[查看交易 0xabc\]\(https:\/\/bscscan\.com\/tx\/0xabc\)/);
});

test("fourmeme cards keep all readable copy and i18n values without truncation", () => {
  const longOld = `旧文案-${"完整内容".repeat(80)}`;
  const longNew = `新文案-${"完整内容".repeat(80)}`;
  const textChanges = Array.from({ length: 25 }, (_, i) => ({
    type: "modified",
    oldText: `${longOld}-${i}`,
    newText: `${longNew}-${i}`,
  }));
  const textContent = __testables.formatFrontendTextChanges(textChanges);
  assert.match(textContent, new RegExp(`${longOld}-24`));
  assert.match(textContent, new RegExp(`${longNew}-24`));
  assert.doesNotMatch(textContent, /完整内容\.\.\.|完整内容…|见 Diff 详情/);

  const i18nChanges = Array.from({ length: 25 }, (_, i) => ({
    type: "added",
    key: `full.namespace.copy_${i}`,
    value: `${longNew}-${i}`,
  }));
  const i18nContent = __testables.formatI18nChanges(i18nChanges);
  assert.match(i18nContent, /full\.namespace\.copy_24/);
  assert.match(i18nContent, new RegExp(`${longNew}-24`));
  assert.doesNotMatch(i18nContent, /还有 \d+ 条|完整内容…/);
});

test("openfour presetIds monitor reports on-chain registrations directly", () => {
  const diff = __testables.diffOpenFourPresetIds(
    { presetIds: ["1778027615725"] },
    { presetIds: ["1778027615725", "1778027615730"] }
  );
  assert.deepEqual(diff.added, ["1778027615730"]);
  assert.deepEqual(diff.removed, []);

  const content = __testables.formatOpenFourPresetIdChanges(diff, {
    presetIds: ["1778027615725", "1778027615730"],
    blockNumber: 123,
    txHash: "0xabc",
  });
  assert.match(content, /新增 presetIds/);
  assert.match(content, /presetId/);
  assert.match(content, /1778027615730/);
  assert.doesNotMatch(content, /未识别 schema/);
  assert.doesNotMatch(content, /OpenFourTools/);
});

test("openfour new module card includes current presetIds", () => {
  const content = __testables.formatOpenFourNewModules([
    { address: "0x0000000000000000000000000000000000000001", roles: ["swap"], presetIds: ["1778027615730"] },
  ], {
    presetIds: ["1778027615725", "1778027615730"],
  });
  assert.match(content, /本轮链上 presetIds：\*\* 1778027615725, 1778027615730/);
  assert.match(content, /presetIds/);
  assert.match(content, /1778027615730/);
  assert.doesNotMatch(content, /unknown/);
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

test("global route inventory ignores per-page deployment skew and confirms real removals", () => {
  const route = "/v1/public/token/search";
  const oldPages = {
    a: { originalUrl: "https://four.meme/en/create-token", routes: [route] },
    b: { originalUrl: "https://four.meme/en/advanced", routes: [route] },
  };
  const state = {
    _frontendGlobalRoutes: [route],
    _frontendGlobalRoutePendingRemovals: {},
  };

  const partial = __testables.reconcileGlobalFrontendRoutes(state, oldPages, {
    a: { originalUrl: "https://four.meme/en/create-token", routes: [] },
    b: oldPages.b,
  });
  assert.deepEqual(partial.added, []);
  assert.deepEqual(partial.removed, []);
  assert.deepEqual(state._frontendGlobalRoutePendingRemovals, {});

  const absentPages = {
    a: { originalUrl: "https://four.meme/en/create-token", routes: [] },
    b: { originalUrl: "https://four.meme/en/advanced", routes: [] },
  };
  const firstMissing = __testables.reconcileGlobalFrontendRoutes(state, oldPages, absentPages);
  assert.deepEqual(firstMissing.removed, []);
  assert.equal(state._frontendGlobalRoutePendingRemovals[route].count, 1);

  const confirmed = __testables.reconcileGlobalFrontendRoutes(state, absentPages, absentPages);
  assert.deepEqual(confirmed.removed, [route]);
  assert.deepEqual(state._frontendGlobalRoutes, []);
  assert.deepEqual(confirmed.removedPages.map(page => page.label), ["/en/create-token", "/en/advanced"]);
});

test("global route additions notify immediately and use evidence-safe copy without AI", () => {
  const route = "/v1/public/token/search";
  const state = { _frontendGlobalRoutes: [], _frontendGlobalRoutePendingRemovals: {} };
  const change = __testables.reconcileGlobalFrontendRoutes(state, {}, {
    page: { originalUrl: "https://four.meme/en/create-token", routes: [route] },
  });
  assert.deepEqual(change.added, [route]);
  const notification = __testables.buildGlobalFrontendRouteNotification(change);
  assert.equal(notification.skipAi, true);
  assert.match(notification.content, /API 引用新增：\/v1\/public\/token\/search/);
  assert.match(notification.content, /不代表对应功能或 API 已下线/);
  assert.doesNotMatch(notification.content, /功能失效|接口下线/);
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

test("transient fetch failures expose their network cause", () => {
  const err = new TypeError("fetch failed", {
    cause: Object.assign(new Error("Connect Timeout Error"), {
      code: "UND_ERR_CONNECT_TIMEOUT",
      address: "140.82.112.6",
      port: 443,
    }),
  });
  assert.equal(__testables.isTransientNetworkError(err), true);
  assert.match(__testables.formatNetworkError(err), /UND_ERR_CONNECT_TIMEOUT/);
  assert.match(__testables.formatNetworkError(err), /140\.82\.112\.6:443/);
  assert.match(__testables.formatNetworkError(err), /Connect Timeout Error/);
});

test("fetchSafe retries transient network errors and returns the recovered response", async () => {
  let attempts = 0;
  const delays = [];
  const response = { ok: true, status: 200 };
  const result = await __testables.fetchSafe(
    "https://api.github.com/repos/four-meme-community/four-meme-ai/commits",
    {},
    1_000,
    async () => {
      attempts++;
      if (attempts < 3) {
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("socket disconnected"), { code: "ECONNRESET" }),
        });
      }
      return response;
    },
    async delayMs => { delays.push(delayMs); },
  );
  assert.equal(result, response);
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [1_000, 2_000]);
});

test("frontend asset refresh reuses 45 unchanged resources and downloads only 2 new resources", () => {
  const current = new Map();
  const oldContents = {};
  for (let i = 0; i < 47; i++) {
    const key = `chunk-${i}.js`;
    const url = `https://four.meme/_next/${key}`;
    current.set(key, url);
    if (i < 45) oldContents[key] = { url, contentHash: `old-${i}`, size: 10, strings: [], ext: "js" };
  }
  const plan = __testables.planFrontendAssetRefresh(current, { assetContents: oldContents });
  assert.equal(Object.keys(plan.reusable).length, 45);
  assert.deepEqual([...plan.downloads.keys()], ["chunk-45.js", "chunk-46.js"]);
  const complete = {
    ...plan.reusable,
    "chunk-45.js": { url: current.get("chunk-45.js") },
    "chunk-46.js": { url: current.get("chunk-46.js") },
  };
  assert.equal(__testables.isAssetDownloadComplete(current, complete), true);
});

test("current Turbopack HTML keeps the real dpl asset URL while using the path as identity", () => {
  const html = `<!doctype html><html><head>
    <link rel="stylesheet" href="/_next/static/chunks/layout.css?dpl=1019">
    <script src="/_next/static/chunks/turbopack-runtime.js?dpl=1019"></script>
  </head><body><script>self.__next_f.push([1,"route"])</script></body></html>`;
  const features = __testables.extractPageFeatures(html, "https://four.meme/en/advanced");
  assert.deepEqual(features.assetFiles, [
    "/_next/static/chunks/layout.css",
    "/_next/static/chunks/turbopack-runtime.js",
  ]);
  assert.equal(
    features.assetUrlMap.get("/_next/static/chunks/turbopack-runtime.js"),
    "https://four.meme/_next/static/chunks/turbopack-runtime.js?dpl=1019",
  );
});

test("static asset headers match browser subresource semantics", () => {
  const userAgent = "Mozilla/5.0 Chrome/150.0.0.0 Safari/537.36";
  const scriptHeaders = __testables.staticAssetHeaders(
    "https://four.meme/_next/static/chunks/app.js?dpl=1019",
    "https://four.meme/en/advanced",
    userAgent,
  );
  assert.equal(scriptHeaders["User-Agent"], userAgent);
  assert.equal(scriptHeaders.Referer, "https://four.meme/en/advanced");
  assert.equal(scriptHeaders["Sec-Fetch-Dest"], "script");
  assert.equal(scriptHeaders["Sec-Fetch-Mode"], "no-cors");
  assert.equal(scriptHeaders["Sec-Fetch-Site"], "same-origin");
  assert.equal("Sec-Fetch-User" in scriptHeaders, false);
  assert.equal("Upgrade-Insecure-Requests" in scriptHeaders, false);
  assert.equal(
    __testables.staticAssetHeaders("https://four.meme/_next/static/chunks/app.css")["Sec-Fetch-Dest"],
    "style",
  );
});

test("dpl-only URL changes migrate cached assets without downloading all chunks again", () => {
  const key = "/_next/static/chunks/app.js";
  const oldUrl = `https://four.meme${key}?dpl=1018`;
  const newUrl = `https://four.meme${key}?dpl=1019`;
  const oldFeatures = {
    assetHash: "same-paths",
    assetContents: { [key]: { url: oldUrl, contentHash: "old", size: 10, strings: [], ext: "js" } },
  };
  const features = { assetHash: "same-paths", assetUrlMap: new Map([[key, newUrl]]) };
  assert.equal(__testables.shouldReuseFrontendAssetContents("https://four.meme/en/advanced", oldFeatures, features), false);
  const plan = __testables.planFrontendAssetRefresh(features.assetUrlMap, oldFeatures, {
    referer: "https://four.meme/en/advanced",
    userAgent: "Chrome/150",
  });
  assert.equal(plan.downloads.size, 0);
  assert.equal(plan.reusable[key].url, newUrl);
  assert.equal(__testables.isAssetDownloadComplete(features.assetUrlMap, plan.reusable), true);
});

test("a changed chunk path is downloaded with the current page request context", () => {
  const oldKey = "/_next/static/chunks/app-old.js";
  const newKey = "/_next/static/chunks/app-new.js";
  const current = new Map([[newKey, `https://four.meme${newKey}?dpl=1019`]]);
  const plan = __testables.planFrontendAssetRefresh(current, {
    assetContents: {
      [oldKey]: { url: `https://four.meme${oldKey}?dpl=1018`, contentHash: "old" },
    },
  }, {
    referer: "https://four.meme/en/advanced",
    userAgent: "Chrome/150",
  });
  assert.deepEqual([...plan.downloads.keys()], [newKey]);
  assert.equal(plan.downloads.get(newKey).referer, "https://four.meme/en/advanced");
});

test("failed new frontend asset remains pending and only the failed item is retried next round", async () => {
  __testables.resetFrontendAssetRetriesForTests();
  const current = new Map();
  const oldContents = {};
  for (let i = 0; i < 47; i++) {
    const key = `chunk-${i}.js`;
    const url = `https://four.meme/_next/${key}`;
    current.set(key, url);
    if (i < 45) oldContents[key] = { url, contentHash: `old-${i}`, size: 10, strings: [], ext: "js" };
  }
  const firstPlan = __testables.planFrontendAssetRefresh(current, { assetContents: oldContents });
  const first = await __testables.downloadAssetContents(firstPlan.downloads, null, {
    diagnostics: true,
    fetchFn: async url => url.endsWith("chunk-46.js")
      ? { ok: false, status: 403, headers: { get: () => null }, text: async () => "" }
      : { ok: true, status: 200, headers: { get: () => null }, text: async () => "fresh chunk" },
  });
  assert.deepEqual(Object.keys(first.contents), ["chunk-45.js"]);
  assert.equal(first.failures[0].reason, "HTTP 403");
  assert.ok(__testables.currentFrontendAssetRetry(current.get("chunk-46.js")));
  __testables.clearFrontendAssetFailure(current.get("chunk-46.js"));

  const secondPlan = __testables.planFrontendAssetRefresh(current, {
    assetContents: oldContents,
    assetDownloadPending: first.contents,
  });
  assert.deepEqual([...secondPlan.downloads.keys()], ["chunk-46.js"]);
  const second = await __testables.downloadAssetContents(secondPlan.downloads, null, {
    diagnostics: true,
    fetchFn: async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => "recovered chunk" }),
  });
  const merged = { ...secondPlan.reusable, ...second.contents };
  assert.equal(second.failures.length, 0);
  assert.equal(Object.keys(merged).length, 47);
  assert.equal(__testables.isAssetDownloadComplete(current, merged), true);
});

test("frontend asset retry state backs off across rounds and clears immediately after recovery", async () => {
  __testables.resetFrontendAssetRetriesForTests();
  const key = "/_next/static/chunks/new.js";
  const url = `https://four.meme${key}?dpl=1019`;
  const failedAt = Date.now();
  const state = __testables.recordFrontendAssetFailure(url, {
    filename: key,
    reason: "网络错误",
    message: "ECONNRESET",
    referer: "https://four.meme/en/advanced",
  }, failedAt);
  assert.equal(state.failCount, 1);
  assert.equal(state.nextRetryAt, failedAt + 30_000);
  assert.match(__testables.currentFrontendAssetRetry(url, failedAt + 1).message, /ECONNRESET/);
  assert.equal(__testables.currentFrontendAssetRetry(url, failedAt + 30_000), null);
  __testables.clearFrontendAssetFailure(url);
  __testables.recordFrontendAssetFailure(url, {
    filename: key,
    reason: "网络错误",
    message: "ECONNRESET",
  }, Date.now() - 30_001);

  const result = await __testables.downloadAssetContents(new Map([[key, {
    url,
    referer: "https://four.meme/en/advanced",
  }]]), null, {
    diagnostics: true,
    fetchFn: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => "recovered chunk",
    }),
  });
  assert.equal(result.failures.length, 0);
  assert.equal(__testables.currentFrontendAssetRetry(url), null);
});

test("downloaded frontend chunks with readable strings are parsed without a local analysis failure", async () => {
  __testables.resetFrontendAssetRetriesForTests();
  const key = "/_next/static/chunks/readable.js";
  const url = `https://four.meme${key}?dpl=1019`;
  const result = await __testables.downloadAssetContents(new Map([[key, { url }]]), null, {
    diagnostics: true,
    fetchFn: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => `"Create Token";"Enable Tax";"Launch your token now"`,
    }),
  });
  assert.equal(result.failures.length, 0);
  assert.deepEqual(result.contents[key].strings, ["Create Token", "Enable Tax", "Launch your token now"]);
});

test("frontend pages share one asset backoff and do not repeat a blocked request", async () => {
  __testables.resetFrontendAssetRetriesForTests();
  const key = "/_next/static/chunks/shared.js";
  const url = `https://four.meme${key}?dpl=1019`;
  __testables.recordFrontendAssetFailure(url, {
    filename: key,
    reason: "网络错误",
    message: "ETIMEDOUT",
  });
  const sharedCache = new Map();
  let requests = 0;
  const fetchFn = async () => {
    requests++;
    throw new Error("should not run during backoff");
  };
  const first = await __testables.downloadAssetContents(new Map([[key, { url, referer: "https://four.meme/en/advanced" }]]), sharedCache, { diagnostics: true, fetchFn });
  const second = await __testables.downloadAssetContents(new Map([[key, { url, referer: "https://four.meme/zh-TW/advanced" }]]), sharedCache, { diagnostics: true, fetchFn });
  assert.equal(requests, 0);
  assert.equal(first.failures[0].reason, "退避");
  assert.equal(second.failures[0].reason, "退避");
  assert.match(second.failures[0].message, /ETIMEDOUT/);
});

test("static asset HTTP failures do not enter the page and API domain backoff path", async () => {
  let requests = 0;
  const response = await __testables.fetchStaticAssetSafe(
    "https://four.meme/_next/static/chunk.js",
    {},
    1_000,
    async () => {
      requests++;
      return { ok: false, status: 403, text: async () => "Forbidden" };
    },
    async () => {},
  );
  assert.equal(response.status, 403);
  assert.equal(requests, 1);
});

test("frontend asset failure logs are aggregated and rate limited for 10 minutes", () => {
  __testables.resetFrontendAssetWarningsForTests();
  const lines = [];
  const details = {
    requested: 2,
    expected: 47,
    available: 45,
    failures: [
      { reason: "HTTP 403" },
      { reason: "HTTP 403" },
    ],
  };
  assert.equal(__testables.logFrontendAssetWarning("https://four.meme/en/advanced", details, 1_000, line => lines.push(line)), true);
  assert.equal(__testables.logFrontendAssetWarning("https://four.meme/en/advanced", details, 2_000, line => lines.push(line)), false);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /新资源下载未完成 0\/2/);
  assert.match(lines[0], /HTTP 403 2 个/);
  assert.match(lines[0], /首项/);
  assert.equal(__testables.logFrontendAssetWarning("https://four.meme/en/advanced", details, 601_001, line => lines.push(line)), true);
  assert.equal(lines.length, 2);
});

test("unchanged create-token assets reuse previous asset contents", () => {
  const url = "https://four.meme/_next/main.js?dpl=1019";
  const oldFeatures = {
    assetHash: "same-assets",
    assetContents: {
      "main.js": { url, contentHash: "old", size: 100, strings: ["Create Token", "buyFee"], ext: "js" },
    },
  };
  const features = { assetHash: "same-assets", assetUrlMap: new Map([["main.js", url]]) };
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

test("host limiter spaces request starts without waiting for the previous response", async () => {
  let now = 0;
  let releaseFirst;
  const events = [];
  const firstBlocked = new Promise(resolve => { releaseFirst = resolve; });
  const limiter = __testables.createHostLimiter({
    minDelayMs: 100,
    now: () => now,
    sleepFn: async ms => { now += ms; },
  });
  const first = limiter.schedule("https://four.meme/a", async () => {
    events.push("first-start");
    await firstBlocked;
    events.push("first-end");
  });
  const second = limiter.schedule("https://four.meme/b", async () => {
    events.push("second-start");
    return "second";
  });

  assert.equal(await second, "second");
  assert.deepEqual(events, ["first-start", "second-start"]);
  releaseFirst();
  await first;
  assert.deepEqual(events, ["first-start", "second-start", "first-end"]);
});

test("overdue module scheduling skips expired ticks without changing the configured interval", () => {
  assert.equal(__testables.calculateNextModuleDueAt(1_000, 2_000, 2_500), 3_000);
  assert.equal(__testables.calculateNextModuleDueAt(1_000, 2_000, 7_500), 9_000);
});

test('background i18n confirmation rotates bounded work without dropping pending items', async () => {
  const state = { _globalI18nResourceWatch: Object.fromEntries(Array.from({length: 9}, (_, i) => [String(i), { status: 'pending', changes: [{type: 'added', key: 'common.new'+i, value: 'unreleased '+i}], namespaces: ['common'] }])) };
  const first = await __testables.confirmGlobalI18nResourceWatchesAsync(state, {}, { maxItems: 4 });
  assert.equal(first.notifications.length, 0);
  assert.equal(Object.values(state._globalI18nResourceWatch).filter(x => x.lastCheckedAt).length, 4);
  await __testables.confirmGlobalI18nResourceWatchesAsync(state, {}, { maxItems: 4 });
  await __testables.confirmGlobalI18nResourceWatchesAsync(state, {}, { maxItems: 4 });
  assert.equal(Object.values(state._globalI18nResourceWatch).filter(x => x.lastCheckedAt).length, 9);
});

test('snapshot serialization reuses stable frontend sections and includes new transactional revisions', () => {
  const first = { frontendPages: { page: { text: 'old' } }, chainActorMonitor: { cursor: 1 }, skipped: undefined };
  assert.deepEqual(JSON.parse(__testables.serializeMonitorSnapshot(first)), JSON.parse(JSON.stringify(first)));
  const next = { ...first, chainActorMonitor: { cursor: 2 } };
  assert.equal(JSON.parse(__testables.serializeMonitorSnapshot(next)).chainActorMonitor.cursor, 2);
  next.frontendPages = { page: { text: 'new' } };
  assert.equal(JSON.parse(__testables.serializeMonitorSnapshot(next)).frontendPages.page.text, 'new');
});


test('creator discovery streams bounded blocks and reads only deployment receipts', async () => {
  const address = '0x' + 'ab'.repeat(20), creator = '0x' + 'cd'.repeat(20), txHash = '0x' + 'ef'.repeat(32);
  const requests = [];
  const rpc = async calls => {
    requests.push(calls);
    return calls.map(call => call.method === 'eth_getBlockByNumber'
      ? { number: call.params[0], transactions: Number(call.params[0]) === 12 ? [{ to: null, from: creator, hash: txHash }] : [{ to: address, from: creator, hash: txHash }] }
      : { contractAddress: address });
  };
  const found = await __testables.findCreatorsInRange(1, 30, [address], rpc);
  assert.equal(found[address].creator, creator);
  assert.ok(requests.every(batch => batch.length <= 8));
  assert.equal(requests.flat().filter(call => call.method === 'eth_getTransactionReceipt').length, 1);
  assert.equal(requests.flat().some(call => call.method === 'eth_getBlockReceipts'), false);
  await assert.rejects(__testables.findCreatorsInRange(1, 2, [address], async () => [null, null]), /保留历史游标/);
});
