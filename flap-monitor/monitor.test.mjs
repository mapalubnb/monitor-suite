import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

process.env.FLAP_MONITOR_TEST = "1";

const { __testables } = await import("./monitor.mjs");
const {
  BNB_QUOTE_TOKEN,
  FACTORY_POOL_STATE_EVENT_TOPICS,
  FLAP_FACTORY_PROXY,
  QUOTE_TOKEN_CONFIGURATION_V2_EVENT_TOPIC,
  QUOTE_TOKEN_CONFIGURATION_EVENT_TOPIC,
  QUOTE_TOKEN_CREATION_DISABLED_EVENT_TOPIC,
  QUOTE_TOKEN_CREATION_DISABLED_SELECTOR,
  UPGRADED_EVENT_TOPIC,
  buildQuoteTokenCreationDisabledCall,
  buildQuoteTokenConfigurationCall,
  classifyFactoryPoolChange,
  createFactoryPoolState,
  decodeBooleanResult,
  decodeQuoteTokenConfiguration,
  extractBytecodeSelectors,
  extractFactoryLogCandidates,
  factoryPoolEventKey,
  ingestFactoryPoolEvent,
  mergePendingFactoryPoolChanges,
  migrateFactoryPoolState,
  loadFactoryPoolState,
  runFactoryPoolScan,
} = await import("./factory-pool-monitor.mjs");
const { compactFactoryPoolStateFile } = await import("./compact-factory-pool-state.mjs");

const BOOLEAN_FALSE_RESULT = `0x${"0".repeat(64)}`;
const BOOLEAN_TRUE_RESULT = `0x${"0".repeat(63)}1`;

function factoryGetterResult(method, params, configurationResult, creationDisabledResult = BOOLEAN_FALSE_RESULT) {
  if (method !== "eth_call") return null;
  return String(params[0]?.data || "").startsWith(QUOTE_TOKEN_CREATION_DISABLED_SELECTOR)
    ? creationDisabledResult
    : configurationResult;
}

test("default Flap polling interval remains fast and configurable", () => {
  assert.equal(__testables.CONFIG.pollIntervalMs, 1_000);
  assert.equal(__testables.CONFIG.factoryPoolMonitor.intervalMs, 1_000);
  assert.equal(__testables.CONFIG.factoryPoolMonitor.confirmations, 0);
  assert.equal(__testables.CONFIG.factoryPoolMonitor.catchupIntervalMs, 1_000);
  assert.equal(__testables.CONFIG.factoryPoolMonitor.catchupMaxBlocksPerRun, 2_000);
  assert.equal("historyConfigEventChunkBlocks" in __testables.CONFIG.factoryPoolMonitor, false);
  assert.deepEqual(__testables.FACTORY_BACKGROUND_TASK_ORDER, ["catchup", "assets"]);
  assert.equal(__testables.CONFIG.factoryPoolMonitor.wsEnabled, true);
  assert.deepEqual(__testables.CONFIG.factoryPoolMonitor.wsUrls, [
    "wss://bsc-rpc.publicnode.com",
    "wss://bsc.publicnode.com",
  ]);
  assert.equal(__testables.CONFIG.factoryPoolMonitor.wsBackfillBlocks, 10_000);
});

test("Factory RPC hedging uses the first valid low-latency node", async () => {
  const originalFetch = globalThis.fetch;
  const originalUrls = __testables.CONFIG.bscRpcUrls;
  const originalHedgeDelay = __testables.CONFIG.factoryPoolMonitor.rpcHedgeDelayMs;
  __testables.CONFIG.bscRpcUrls = ["https://slow.rpc", "https://fast.rpc"];
  __testables.CONFIG.factoryPoolMonitor.rpcHedgeDelayMs = 50;
  __testables.resetBscRpcHealth();
  globalThis.fetch = async url => {
    const slow = String(url).includes("slow");
    await new Promise(resolve => setTimeout(resolve, slow ? 200 : 5));
    return {
      ok: true,
      status: 200,
      json: async () => ({ jsonrpc: "2.0", id: 1, result: slow ? "0x1" : "0x2" }),
    };
  };
  try {
    const startedAt = Date.now();
    const result = await __testables.bscRpcCall("eth_blockNumber", [], { requireResult: true });
    assert.equal(result, "0x2");
    assert.ok(Date.now() - startedAt < 180);
  } finally {
    globalThis.fetch = originalFetch;
    __testables.CONFIG.bscRpcUrls = originalUrls;
    __testables.CONFIG.factoryPoolMonitor.rpcHedgeDelayMs = originalHedgeDelay;
    __testables.resetBscRpcHealth();
  }
});

test("Factory eth_getLogs ignores one empty RPC when another returns logs", async () => {
  const originalFetch = globalThis.fetch;
  const originalUrls = __testables.CONFIG.bscRpcUrls;
  const originalHedgeDelay = __testables.CONFIG.factoryPoolMonitor.rpcHedgeDelayMs;
  const txHash = `0x${"ab".repeat(32)}`;
  __testables.CONFIG.bscRpcUrls = ["https://empty.rpc", "https://logs.rpc"];
  __testables.CONFIG.factoryPoolMonitor.rpcHedgeDelayMs = 50;
  __testables.resetBscRpcHealth();
  globalThis.fetch = async url => ({
    ok: true,
    status: 200,
    json: async () => ({
      jsonrpc: "2.0",
      id: 1,
      result: String(url).includes("empty") ? [] : [{
        transactionHash: txHash,
        logIndex: "0x0",
        blockNumber: "0x64",
        transactionIndex: "0x0",
      }],
    }),
  });
  try {
    const result = await __testables.executeBscGetLogsRequest([{ fromBlock: "0x64", toBlock: "0x64" }]);
    assert.equal(result.length, 1);
    assert.equal(result[0].transactionHash, txHash);
  } finally {
    globalThis.fetch = originalFetch;
    __testables.CONFIG.bscRpcUrls = originalUrls;
    __testables.CONFIG.factoryPoolMonitor.rpcHedgeDelayMs = originalHedgeDelay;
    __testables.resetBscRpcHealth();
  }
});

test("Flap startup card is complete and uses no emoji or bullet list markers", () => {
  const content = __testables.buildFlapStartupContent({
    pages: Object.fromEntries(__testables.CONFIG.urls.map((url, index) => [url, {
      originalUrl: url,
      assetFiles: [`asset-${index}.js`],
      i18nStrings: { title: `页面 ${index}` },
    }])),
    vaultFactories: {
      first: { name: "完整金库", factory: "0x0000000000000000000000000000000000000001", enabled: true, showInCAStore: true },
      hidden: { name: "隐藏金库", factory: "0x0000000000000000000000000000000000000002", enabled: true, showInCAStore: false },
    },
    registryMonitor: { lastBlock: 100, safeLatestBlock: 105, latestBlock: 110, knownVaults: { one: {} } },
  }, "monitor-host", {
    proxy: FLAP_FACTORY_PROXY,
    currentImplementation: "0x150103da235bc6caef37a7ca31373bbdf40ccd2e",
    deploymentBlock: 39980228,
    headLastScannedBlock: 105,
    lastScannedBlock: 100,
    safeLatestBlock: 105,
    latestBlock: 105,
    wssHealth: {
      enabled: true,
      configuredCount: 2,
      subscribedCount: 2,
      status: "healthy",
      lastSubscribedAt: "2026-08-10T01:01:03.000Z",
      lastEventAt: "2026-08-10T01:02:03.000Z",
      backfill: { status: "completed", fromBlock: 95, toBlock: 105, eventCount: 1 },
    },
    historyLastScannedBlock: 90,
    assets: {
      [BNB_QUOTE_TOKEN]: { quoteToken: BNB_QUOTE_TOKEN, configured: true, creationDisabled: false, effectiveEnabled: true, values: ["1", "2", "3", "4", "5"] },
      "0x21caef8a43163eea865baee23b9c2e327696a3bf": {
        quoteToken: "0x21caef8a43163eea865baee23b9c2e327696a3bf",
        name: "Tether Gold",
        symbol: "XAUt",
        configured: true,
        creationDisabled: true,
        effectiveEnabled: false,
      },
    },
  });
  for (const url of __testables.CONFIG.urls) assert.match(content, new RegExp(url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  for (const url of __testables.CONFIG.bscRpcUrls) assert.match(content, new RegExp(url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(content, /0x0000000000000000000000000000000000000001/);
  assert.match(content, /https:\/\/flap\.sh\/launch\?vaultfactory=0x0000000000000000000000000000000000000001/);
  assert.doesNotMatch(content, /隐藏金库|0x0000000000000000000000000000000000000002/);
  assert.match(content, /展示数量：1/);
  assert.match(content, /\*\*04｜Robinhood CAStore\*\*/);
  assert.match(content, /https:\/\/flap\.sh\/robinhood\/CAstore\?lang=zh/);
  assert.match(content, /币股（IndexVault）｜状态 监控中/);
  assert.match(content, /0xe6ca297D1d963b6F00d5b216986123CAeB883AF6/);
  assert.match(content, /https:\/\/flap\.sh\/launch\?vaultfactory=0xe6ca297D1d963b6F00d5b216986123CAeB883AF6&chain=robinhood&lang=zh/);
  assert.match(content, /\*\*05｜Factory 底池资产\*\*/);
  assert.match(content, /监控状态：运行正常/);
  assert.match(content, /实时通道：运行正常｜已订阅 2\/2｜最后订阅 .*｜最后事件/);
  assert.match(content, /HTTP 兜底：已扫 105｜最新 105｜延迟 0 块/);
  assert.match(content, /短窗口回扫：已完成/);
  assert.match(content, /资产数量：2｜支持创建 1｜暂停创建 1｜已停用 0/);
  assert.match(content, new RegExp(BNB_QUOTE_TOKEN));
  assert.match(content, /Tether Gold \(XAUt\)｜状态 暂停创建｜地址/);
  assert.match(content, /0x21caef8a43163eea865baee23b9c2e327696a3bf/);
  assert.doesNotMatch(content, /字段 [1-5]：/);
  assert.doesNotMatch(content, /操作入口|更新时间：|CAStore 展示/);
  assert.doesNotMatch(content, /[\p{Extended_Pictographic}]/u);
  assert.doesNotMatch(content, /(^|\n)-\s/m);
});

test("Factory getter call and five-word response preserve complete values", () => {
  const token = "0x1111111111111111111111111111111111111111";
  assert.equal(buildQuoteTokenConfigurationCall(token), `0x26ef20d5${"0".repeat(24)}${token.slice(2)}`);
  assert.equal(buildQuoteTokenCreationDisabledCall(token), `0x80718181${"0".repeat(24)}${token.slice(2)}`);
  const words = [1n, 2n, 3n, 4n, (1n << 255n) + 9n].map(value => value.toString(16).padStart(64, "0"));
  const decoded = decodeQuoteTokenConfiguration(`0x${words.join("")}`);
  assert.equal(decoded.configured, true);
  assert.equal(decoded.configurationPresent, true);
  assert.deepEqual(decoded.values, ["1", "2", "3", "4", ((1n << 255n) + 9n).toString()]);
  assert.equal(decoded.fields.length, 5);
  assert.equal(decodeBooleanResult(BOOLEAN_TRUE_RESULT), true);
  assert.equal(decodeBooleanResult(BOOLEAN_FALSE_RESULT), false);
  assert.equal(UPGRADED_EVENT_TOPIC, "0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b");
});

test("Factory implementation selector extraction ignores PUSH4 data constants", () => {
  assert.deepEqual(extractBytecodeSelectors("0x806326ef20d51461010063deadbeef00"), ["0x26ef20d5"]);
});

test("Factory ignores unknown events even when numeric words look like addresses", () => {
  const token = "0x2222222222222222222222222222222222222222";
  const candidates = extractFactoryLogCandidates({
    address: FLAP_FACTORY_PROXY,
    topics: [`0x${"99".repeat(32)}`, `0x${"0".repeat(60)}0120`],
    data: `0x${"0".repeat(24)}${token.slice(2)}`,
    transactionHash: `0x${"ab".repeat(32)}`,
    blockNumber: "0x64",
    logIndex: "0x0",
  });
  assert.deepEqual(candidates, []);
});

test("Factory pool change card keeps only readable asset status and full address", () => {
  const txHash = `0x${"12".repeat(32)}`;
  const implementation = "0x150103da235bc6caef37a7ca31373bbdf40ccd2e";
  const content = __testables.buildFactoryPoolMonitorContent({
    state: {
      proxy: FLAP_FACTORY_PROXY,
      currentImplementation: implementation,
      lastScannedBlock: 105,
      safeLatestBlock: 105,
      assets: { [BNB_QUOTE_TOKEN]: { configured: true, creationDisabled: false, effectiveEnabled: true } },
    },
    changes: [{
      type: "added",
      current: { quoteToken: BNB_QUOTE_TOKEN, name: "BNB", symbol: "BNB", configured: true, creationDisabled: false, effectiveEnabled: true, values: ["1", "20", "20", "0", "0"], lastTxHash: txHash, lastSeenBlock: 104 },
    }],
    implementationChange: null,
  });
  assert.match(content, /新增支持：BNB/);
  assert.match(content, /状态：支持创建/);
  assert.match(content, new RegExp(BNB_QUOTE_TOKEN));
  assert.doesNotMatch(content, new RegExp(FLAP_FACTORY_PROXY));
  assert.doesNotMatch(content, new RegExp(implementation));
  assert.doesNotMatch(content, new RegExp(txHash));
  assert.doesNotMatch(content, /区块|交易|Implementation|选择器/);
  assert.doesNotMatch(content, /字段 [1-5]:/);
  assert.doesNotMatch(content, /(^|\n)-\s/m);
  assert.doesNotMatch(content, /[\p{Extended_Pictographic}]/u);
});

test("Factory pool change card sends immediately with full address while name is syncing", () => {
  const token = "0x5555555555555555555555555555555555555555";
  const content = __testables.buildFactoryPoolMonitorContent({
    state: {
      proxy: FLAP_FACTORY_PROXY,
      currentImplementation: "0x150103da235bc6caef37a7ca31373bbdf40ccd2e",
      headLastScannedBlock: 200,
      safeLatestBlock: 200,
      assets: { [token]: { quoteToken: token, configured: true, creationDisabled: true, effectiveEnabled: false } },
    },
    changes: [{ type: "added", current: { quoteToken: token, configured: true, creationDisabled: true, effectiveEnabled: false, lastSeenBlock: 199 } }],
    implementationChange: null,
  });
  assert.match(content, /新增支持：名称同步中/);
  assert.match(content, /状态：暂停创建/);
  assert.match(content, new RegExp(token));
});

test("Factory metadata enrichment patches the original card after first delivery", async () => {
  const token = "0x6666666666666666666666666666666666666666";
  const state = {
    proxy: FLAP_FACTORY_PROXY,
    currentImplementation: "0x150103da235bc6caef37a7ca31373bbdf40ccd2e",
    headLastScannedBlock: 300,
    safeLatestBlock: 300,
    assets: { [token]: { quoteToken: token, configured: true, creationDisabled: false, effectiveEnabled: true } },
  };
  const result = {
    state,
    changes: [{ type: "added", current: state.assets[token] }],
    implementationChange: null,
  };
  let patched = null;
  let saved = false;
  const outcome = await __testables.enrichFactoryPoolMetadataAfterSend({
    state,
    result,
    messageId: "om_test",
    title: "Flap Factory 底池资产链上变更",
    initialContent: "名称同步中",
    enrichFn: async targetState => {
      targetState.assets[token].name = "Fast Pool";
      targetState.assets[token].symbol = "FAST";
      targetState.assets[token].metadataSource = "onchain";
    },
    patchFn: async (...args) => { patched = args; },
    saveFn: () => { saved = true; },
  });
  assert.equal(outcome.patched, true);
  assert.equal(saved, true);
  assert.equal(patched[0], "om_test");
  assert.match(patched[2], /Fast Pool \(FAST\)/);
  assert.match(patched[2], new RegExp(token));
  assert.doesNotMatch(patched[2], /名称同步中/);
});

test("Factory asynchronous metadata failure does not patch or reject delivery flow", async () => {
  const token = "0x7777777777777777777777777777777777777777";
  const state = { assets: { [token]: { quoteToken: token, configured: true, creationDisabled: false, effectiveEnabled: true } } };
  let patchCalls = 0;
  const outcome = await __testables.scheduleFactoryPoolMetadataEnrichment({
    state,
    result: { state, changes: [{ type: "added", current: state.assets[token] }] },
    messageId: "om_test",
    title: "test",
    enrichFn: async () => { throw new Error("metadata unavailable"); },
    patchFn: async () => { patchCalls++; },
    saveFn: () => {},
  });
  assert.equal(outcome.patched, false);
  assert.equal(outcome.error.message, "metadata unavailable");
  assert.equal(patchCalls, 0);
});

test("Factory metadata enrichment skips completed assets without queue work or state writes", async () => {
  const token = "0x7979797979797979797979797979797979797979";
  const state = { assets: { [token]: { quoteToken: token, name: "Ready Pool", symbol: "READY", decimals: 18, configured: true, creationDisabled: false, effectiveEnabled: true } } };
  let enrichCalls = 0;
  let saveCalls = 0;
  const outcome = await __testables.scheduleFactoryPoolMetadataEnrichment({
    state,
    result: { state, changes: [] },
    enrichFn: async () => { enrichCalls++; },
    saveFn: () => { saveCalls++; },
  });
  assert.deepEqual(outcome, { patched: false, metadataChanged: false });
  assert.equal(enrichCalls, 0);
  assert.equal(saveCalls, 0);
});

test("Factory first delivery does not await metadata enrichment", async () => {
  const token = "0x8888888888888888888888888888888888888888";
  const asset = { quoteToken: token, configured: true, creationDisabled: false, effectiveEnabled: true, lastSeenBlock: 400 };
  const state = {
    proxy: FLAP_FACTORY_PROXY,
    currentImplementation: "0x150103da235bc6caef37a7ca31373bbdf40ccd2e",
    headLastScannedBlock: 400,
    safeLatestBlock: 400,
    assets: { [token]: asset },
    pendingChanges: [],
    pendingImplementationChange: null,
  };
  let metadataScheduled = false;
  const deliveryOrder = [];
  const delivery = __testables.checkFlapFactoryPools(state, {
    scanFn: async () => ({
      changed: true,
      changes: [{ type: "added", current: asset }],
      implementationChange: null,
      state,
    }),
    sendCardFn: async (_title, content) => {
      deliveryOrder.push("send");
      assert.match(content, /名称同步中/);
      assert.match(content, new RegExp(token));
      return "om_fast";
    },
    saveStateFn: () => { deliveryOrder.push("save"); },
    pinFn: async () => {},
    scheduleMetadataFn: () => {
      metadataScheduled = true;
      return new Promise(() => {});
    },
  });
  const outcome = await Promise.race([
    delivery,
    new Promise((_, reject) => setTimeout(() => reject(new Error("首发等待了名称任务")), 50)),
  ]);
  assert.equal(outcome.sent, true);
  assert.equal(metadataScheduled, true);
  assert.deepEqual(deliveryOrder, ["save", "save", "send", "save"]);
});

test("Factory token metadata uses the free GoPlus API response", async () => {
  const token = "0x3333333333333333333333333333333333333333";
  const result = await __testables.resolveFactoryPoolTokenMetadata([token], {
    apiUrl: "https://metadata.example/token",
    fetchFn: async url => {
      assert.match(String(url), new RegExp(token));
      return {
        ok: true,
        json: async () => ({ result: { [token]: { token_name: "USD Pool", token_symbol: "USDP" } } }),
      };
    },
    rpcBatchFn: async () => { throw new Error("并行链上结果不可用"); },
  });
  assert.deepEqual(result.metadata[token], { name: "USD Pool", symbol: "USDP", source: "goplus" });
});

test("Factory token metadata falls back to read-only ERC20 calls", async () => {
  const token = "0x4444444444444444444444444444444444444444";
  const encodeDynamicText = text => {
    const value = Buffer.from(text, "utf8").toString("hex");
    return `0x${32n.toString(16).padStart(64, "0")}${BigInt(value.length / 2).toString(16).padStart(64, "0")}${value.padEnd(64, "0")}`;
  };
  const result = await __testables.resolveFactoryPoolTokenMetadata([token], {
    apiUrl: "https://metadata.example/token",
    fetchFn: async () => ({ ok: false, status: 503 }),
    rpcBatchFn: async calls => {
      assert.equal(calls.length, 3);
      return [
        encodeDynamicText("Chain Pool"),
        `0x${Buffer.from("CHAIN").toString("hex").padEnd(64, "0")}`,
        `0x${18n.toString(16).padStart(64, "0")}`,
      ];
    },
  });
  assert.deepEqual(result.metadata[token], { name: "Chain Pool", symbol: "CHAIN", decimals: 18, source: "onchain" });
  assert.match(result.errors[0], /GoPlus: HTTP 503/);
});

test("Factory pending notification queue keeps unsent changes and deduplicates by address", () => {
  const token = "0x6666666666666666666666666666666666666666";
  const added = { type: "added", previous: null, current: { quoteToken: token, fingerprint: "first", configured: true, creationDisabled: false, effectiveEnabled: true } };
  const modified = { type: "modified", previous: added.current, current: { quoteToken: token, fingerprint: "second", configured: true, creationDisabled: false, effectiveEnabled: true } };
  const pending = mergePendingFactoryPoolChanges([added], [modified]);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].type, "added");
  assert.equal(pending[0].current.fingerprint, "second");
  assert.equal(pending[0].previous, null);
});

test("Factory pending notification queue preserves pause and resume transitions", () => {
  const token = "0x6666666666666666666666666666666666666666";
  const active = { quoteToken: token, fingerprint: "active", configured: true, creationDisabled: false, effectiveEnabled: true };
  const paused = { ...active, fingerprint: "paused", creationDisabled: true, effectiveEnabled: false };
  const pending = mergePendingFactoryPoolChanges(
    [{ type: "paused", previous: active, current: paused }],
    [{ type: "resumed", previous: paused, current: active }],
  );
  assert.deepEqual(pending.map(change => change.type), ["paused", "resumed"]);
});

test("Factory realtime scan does not wait for Feishu delivery", async () => {
  const token = "0x6767676767676767676767676767676767676767";
  const asset = {
    quoteToken: token,
    fingerprint: "active",
    configured: true,
    creationDisabled: false,
    effectiveEnabled: true,
  };
  const state = {
    proxy: FLAP_FACTORY_PROXY,
    assets: { [token]: asset },
    pendingChanges: [],
    pendingImplementationChange: null,
  };
  let finishDelivery;
  const outcome = await __testables.checkFlapFactoryPools(state, {
    scanFn: async () => ({
      changed: true,
      changes: [{ type: "added", previous: null, current: asset }],
      implementationChange: null,
      state,
    }),
    sendCardFn: () => new Promise(resolve => { finishDelivery = resolve; }),
    saveStateFn: () => {},
    pinFn: async () => {},
    scheduleMetadataFn: async () => ({ patched: false }),
    awaitDelivery: false,
  });
  assert.equal(outcome.deliveryQueued, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.pendingChanges.length + state.sendingChanges.length, 1);
  finishDelivery("om_async");
  await new Promise(resolve => setImmediate(resolve));
});

test("Factory invalid Feishu credentials defer delivery without duplicating queue work", async () => {
  const token = "0x6868686868686868686868686868686868686868";
  const asset = {
    quoteToken: token,
    fingerprint: "active",
    configured: true,
    creationDisabled: false,
    effectiveEnabled: true,
  };
  const state = {
    proxy: FLAP_FACTORY_PROXY,
    assets: { [token]: asset },
    pendingChanges: [],
    pendingImplementationChange: null,
    sendingChanges: [],
    sendingImplementationChange: null,
  };
  const originalCredentials = [
    __testables.CONFIG.feishuAppId,
    __testables.CONFIG.feishuAppSecret,
    __testables.CONFIG.feishuChatId,
  ];
  __testables.CONFIG.feishuAppId = "cli_xxxx";
  __testables.CONFIG.feishuAppSecret = "your_app_secret_here";
  __testables.CONFIG.feishuChatId = "oc_xxxx";
  const scanFn = async () => ({
    changed: true,
    changes: [{ type: "added", previous: null, current: asset }],
    implementationChange: null,
    state,
  });
  try {
    const first = await __testables.checkFlapFactoryPools(state, { scanFn, saveStateFn: () => {} });
    const second = await __testables.checkFlapFactoryPools(state, { scanFn, saveStateFn: () => {} });
    assert.equal(first.deliveryDeferred, true);
    assert.equal(second.deliveryDeferred, true);
    assert.equal(state.pendingChanges.length, 1);
    assert.equal(state.pendingChanges[0].current.quoteToken, token);
    assert.deepEqual(state.sendingChanges, []);
  } finally {
    [
      __testables.CONFIG.feishuAppId,
      __testables.CONFIG.feishuAppSecret,
      __testables.CONFIG.feishuChatId,
    ] = originalCredentials;
  }
});

test("Factory configuration event extracts the complete quote token address", () => {
  const token = "0x21caef8a43163eea865baee23b9c2e327696a3bf";
  const candidates = extractFactoryLogCandidates({
    address: FLAP_FACTORY_PROXY,
    topics: [QUOTE_TOKEN_CONFIGURATION_EVENT_TOPIC],
    data: `0x${token.slice(2).padStart(64, "0")}${1n.toString(16).padStart(64, "0")}`,
    transactionHash: `0x${"12".repeat(32)}`,
    blockNumber: "0x6b616fa",
    logIndex: "0x1",
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].quoteToken, token);
  assert.equal(candidates[0].topic0, QUOTE_TOKEN_CONFIGURATION_EVENT_TOPIC);
});

test("Factory v2 configuration and creation-disabled events extract the complete address", () => {
  const token = "0x205812cdbed920aff76c6580abd681a46d11efc7";
  const base = {
    address: FLAP_FACTORY_PROXY,
    transactionHash: `0x${"98".repeat(32)}`,
    blockNumber: "0x6b616fa",
    logIndex: "0x1",
  };
  const configuration = extractFactoryLogCandidates({
    ...base,
    topics: [QUOTE_TOKEN_CONFIGURATION_V2_EVENT_TOPIC],
    data: `0x${token.slice(2).padStart(64, "0")}${[1n, 35n, 35n, 7n, 0n].map(value => value.toString(16).padStart(64, "0")).join("")}`,
  });
  const paused = extractFactoryLogCandidates({
    ...base,
    topics: [QUOTE_TOKEN_CREATION_DISABLED_EVENT_TOPIC, `0x${token.slice(2).padStart(64, "0")}`],
    data: BOOLEAN_TRUE_RESULT,
  });
  assert.equal(configuration[0].quoteToken, token);
  assert.deepEqual({
    enabled: configuration[0].eventConfiguration.enabled,
    defaultCurve: configuration[0].eventConfiguration.defaultCurve,
    alternativeCurve: configuration[0].eventConfiguration.alternativeCurve,
    nativeToQuoteSwapType: configuration[0].eventConfiguration.nativeToQuoteSwapType,
    dexId: configuration[0].eventConfiguration.dexId,
  }, { enabled: 1, defaultCurve: 35, alternativeCurve: 35, nativeToQuoteSwapType: 7, dexId: 0 });
  assert.equal(paused[0].quoteToken, token);
  assert.equal(paused[0].selector, QUOTE_TOKEN_CREATION_DISABLED_SELECTOR);
  assert.equal(paused[0].eventDisabled, true);
});

test("Factory WSS event persists a complete candidate before getter verification", async () => {
  const token = "0x1212121212121212121212121212121212121212";
  const txHash = `0x${"ab".repeat(32)}`;
  const values = [1n, 35n, 34n, 7n, 2n];
  const getterResult = `0x${values.map(value => value.toString(16).padStart(64, "0")).join("")}`;
  const event = {
    address: FLAP_FACTORY_PROXY,
    topics: [QUOTE_TOKEN_CONFIGURATION_V2_EVENT_TOPIC],
    data: `0x${token.slice(2).padStart(64, "0")}${getterResult.slice(2)}`,
    transactionHash: txHash,
    blockNumber: "0x64",
    logIndex: "0x2",
  };
  const state = createFactoryPoolState();
  const lifecycle = [];
  let rpcCalls = 0;
  const result = await ingestFactoryPoolEvent({
    state,
    logEntry: event,
    source: "factory-wss",
    persistState: async persisted => {
      lifecycle.push("persist");
      const candidate = persisted.candidates[token];
      assert.equal(candidate.transactionHash, txHash);
      assert.equal(candidate.logIndex, 2);
      assert.equal(candidate.enabled, 1);
      assert.equal(candidate.defaultCurve, 35);
      assert.equal(candidate.alternativeCurve, 34);
      assert.equal(candidate.nativeToQuoteSwapType, 7);
      assert.equal(candidate.dexId, 2);
      assert.equal(candidate.source, "factory-wss");
      assert.ok(candidate.firstSeenAt);
      assert.ok(candidate.lastSeenAt);
    },
    rpcCall: async (method, params) => {
      rpcCalls++;
      lifecycle.push("eth_call");
      return factoryGetterResult(method, params, getterResult, BOOLEAN_FALSE_RESULT);
    },
  });
  assert.equal(lifecycle[0], "persist");
  assert.equal(result.processed, true);
  assert.equal(result.changes[0].type, "added");
  assert.equal(state.assets[token].enabled, 1);
  assert.equal(state.assets[token].disabled, false);
  assert.equal(state.assets[token].effectiveEnabled, true);
  assert.equal(state.assets[token].transactionHash, txHash);
  assert.equal(state.assets[token].logIndex, 2);
  assert.equal(state.assets[token].source, "factory-wss");
  assert.equal(factoryPoolEventKey(event), `${txHash}:2`);

  const duplicate = await ingestFactoryPoolEvent({
    state,
    logEntry: event,
    rpcCall: async () => { rpcCalls++; },
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(rpcCalls, 2);
});

test("Factory WSS disabled=false event marks a watched asset as resumed", async () => {
  const token = "0x3434343434343434343434343434343434343434";
  const values = [1n, 35n, 35n, 7n, 0n];
  const getterResult = `0x${values.map(value => value.toString(16).padStart(64, "0")).join("")}`;
  const state = createFactoryPoolState();
  state.assets[token] = {
    quoteToken: token,
    configured: true,
    enabled: 1,
    creationDisabled: true,
    disabled: true,
    effectiveEnabled: false,
    fields: values.map(value => `0x${value.toString(16).padStart(64, "0")}`),
    values: values.map(String),
    configurationFingerprint: "before",
    fingerprint: "paused",
  };
  const event = {
    address: FLAP_FACTORY_PROXY,
    topics: [QUOTE_TOKEN_CREATION_DISABLED_EVENT_TOPIC, `0x${token.slice(2).padStart(64, "0")}`],
    data: BOOLEAN_FALSE_RESULT,
    transactionHash: `0x${"cd".repeat(32)}`,
    blockNumber: "0x65",
    logIndex: "0x0",
  };
  const result = await ingestFactoryPoolEvent({
    state,
    logEntry: event,
    rpcCall: async (method, params) => factoryGetterResult(method, params, getterResult, BOOLEAN_FALSE_RESULT),
    persistState: async () => {},
  });
  assert.equal(result.item.eventDisabled, false);
  assert.equal(result.changes[0].type, "resumed");
  assert.equal(state.assets[token].disabled, false);
  assert.equal(state.assets[token].effectiveEnabled, true);
});

test("Factory WSS candidate remains pending while HTTP getter is behind the event", async () => {
  const token = "0x5656565656565656565656565656565656565656";
  const eventValues = [1n, 35n, 35n, 7n, 0n];
  const staleValues = [0n, 0n, 0n, 0n, 0n];
  const event = {
    address: FLAP_FACTORY_PROXY,
    topics: [QUOTE_TOKEN_CONFIGURATION_V2_EVENT_TOPIC],
    data: `0x${token.slice(2).padStart(64, "0")}${eventValues.map(value => value.toString(16).padStart(64, "0")).join("")}`,
    transactionHash: `0x${"56".repeat(32)}`,
    blockNumber: "0x66",
    logIndex: "0x0",
  };
  const state = createFactoryPoolState();
  const result = await ingestFactoryPoolEvent({
    state,
    logEntry: event,
    rpcCall: async (method, params) => factoryGetterResult(
      method,
      params,
      `0x${staleValues.map(value => value.toString(16).padStart(64, "0")).join("")}`,
      BOOLEAN_FALSE_RESULT,
    ),
    persistState: async () => {},
  });
  assert.equal(result.changes.length, 0);
  assert.equal(state.assets[token], undefined);
  assert.equal(state.candidates[token].pendingVerification, true);
  assert.match(state.candidates[token].lastVerifyError, /尚未同步/);
  assert.equal(state.candidates[token].enabled, 1);
});

test("parallel Factory WSS feeds subscribe together and queue duplicate logs once", async () => {
  class FakeWebSocket extends EventEmitter {
    static OPEN = 1;
    static instances = [];
    constructor(url) {
      super();
      this.url = url;
      this.readyState = FakeWebSocket.OPEN;
      this.sent = [];
      FakeWebSocket.instances.push(this);
    }
    send(value) { this.sent.push(JSON.parse(value)); }
    ping() {}
    close() { this.readyState = 3; this.emit("close", 1000, "test"); }
  }
  const event = {
    address: FLAP_FACTORY_PROXY,
    topics: [QUOTE_TOKEN_CONFIGURATION_V2_EVENT_TOPIC],
    data: "0x",
    transactionHash: `0x${"ef".repeat(32)}`,
    blockNumber: "0x66",
    logIndex: "0x1",
  };
  let processed = 0;
  const healthSnapshots = [];
  const queue = __testables.createFactoryPoolEventQueue({}, async () => {
    processed++;
    await new Promise(resolve => setImmediate(resolve));
    return { processed: true };
  });
  const feed = __testables.createFactoryPoolWsFeed({
    urls: ["wss://one.test", "wss://two.test"],
    proxy: FLAP_FACTORY_PROXY,
    topics: FACTORY_POOL_STATE_EVENT_TOPICS,
    onEvent: logEntry => queue.enqueue(logEntry, "factory-wss"),
    onStatus: health => healthSnapshots.push(health),
    WebSocketImpl: FakeWebSocket,
    logFn: () => {},
    reconnectBaseMs: 1,
  }).start();
  assert.equal(FakeWebSocket.instances.length, 2);
  for (const socket of FakeWebSocket.instances) {
    socket.emit("open");
    assert.deepEqual(socket.sent[0].params, ["logs", {
      address: FLAP_FACTORY_PROXY,
      topics: [FACTORY_POOL_STATE_EVENT_TOPICS],
    }]);
    socket.emit("message", JSON.stringify({ id: 1, result: `subscription-${socket.url}` }));
    socket.emit("message", JSON.stringify({ params: { result: event } }));
  }
  await queue.drain();
  assert.equal(processed, 1);
  assert.equal(healthSnapshots.at(-1).subscribedCount, 2);
  assert.equal(healthSnapshots.at(-1).status, "healthy");
  assert.ok(healthSnapshots.at(-1).lastEventAt);
  FakeWebSocket.instances[0].emit("close", 1006, "lost");
  assert.equal(healthSnapshots.at(-1).status, "degraded");
  assert.equal(healthSnapshots.at(-1).subscribedCount, 1);
  FakeWebSocket.instances[1].emit("close", 1006, "lost");
  assert.equal(healthSnapshots.at(-1).status, "reconnecting");
  assert.equal(healthSnapshots.at(-1).subscribedCount, 0);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(FakeWebSocket.instances.length, 4);
  feed.stop();
});

test("Factory WSS startup backfill scans the configured short window in RPC-safe chunks", async () => {
  const calls = [];
  const events = [{
    address: FLAP_FACTORY_PROXY,
    topics: [QUOTE_TOKEN_CONFIGURATION_V2_EVENT_TOPIC],
    data: "0x",
    transactionHash: `0x${"12".repeat(32)}`,
    blockNumber: "0x2710",
    logIndex: "0x0",
  }];
  const queued = [];
  const result = await __testables.backfillFactoryPoolFeedEvents({
    enqueue: async (event, source) => queued.push({ event, source }),
  }, 5_000, async (method, params) => {
    calls.push({ method, params });
    if (method === "eth_blockNumber") return "0x2710";
    if (method === "eth_getLogs") return events;
    throw new Error(method);
  }, FLAP_FACTORY_PROXY);
  assert.equal(result.fromBlock, 5_001);
  assert.equal(result.latest, 10_000);
  assert.equal(result.eventCount, 1);
  assert.equal(result.chunkCount, 3);
  assert.deepEqual(calls.slice(1).map(call => [call.params[0].fromBlock, call.params[0].toBlock]), [
    ["0x1389", "0x1b58"],
    ["0x1b59", "0x2328"],
    ["0x2329", "0x2710"],
  ]);
  for (const call of calls.slice(1)) {
    assert.equal(call.params[0].address, FLAP_FACTORY_PROXY);
    assert.deepEqual(call.params[0].topics, [FACTORY_POOL_STATE_EVENT_TOPICS]);
  }
  assert.equal(queued[0].source, "factory-wss-backfill");
});

test("Factory WSS startup backfill automatically splits an RPC-limited range", async () => {
  const ranges = [];
  const result = await __testables.backfillFactoryPoolFeedEvents({ enqueue: async () => {} }, 1_000, async (method, params) => {
    if (method === "eth_blockNumber") return "0x3e8";
    const from = Number.parseInt(params[0].fromBlock, 16);
    const to = Number.parseInt(params[0].toBlock, 16);
    ranges.push([from, to]);
    if (to - from + 1 > 250) throw new Error("exceed maximum block range: 250");
    return [];
  }, FLAP_FACTORY_PROXY, 1_000);
  assert.equal(result.fromBlock, 1);
  assert.equal(result.latest, 1_000);
  assert.equal(result.chunkCount, 4);
  assert.deepEqual(ranges.filter(([from, to]) => to - from + 1 <= 250), [
    [1, 250], [251, 500], [501, 750], [751, 1_000],
  ]);
});

test("Factory change classifier distinguishes all five business states", () => {
  const active = { configured: true, creationDisabled: false, effectiveEnabled: true };
  const paused = { configured: true, creationDisabled: true, effectiveEnabled: false };
  const disabled = { configured: false, creationDisabled: false, effectiveEnabled: false };
  assert.equal(classifyFactoryPoolChange(null, active), "added");
  assert.equal(classifyFactoryPoolChange(active, { ...active, configurationFingerprint: "new" }), "modified");
  assert.equal(classifyFactoryPoolChange(active, paused), "paused");
  assert.equal(classifyFactoryPoolChange(paused, active), "resumed");
  assert.equal(classifyFactoryPoolChange(active, disabled), "disabled");
  assert.equal(classifyFactoryPoolChange(null, disabled), "disabled");
});

test("Factory schema migration removes historical state and preserves assets", () => {
  const token = "0x205812cdbed920aff76c6580abd681a46d11efc7";
  const migrated = migrateFactoryPoolState({
    schemaVersion: 6,
    headLastScannedBlock: 100,
    historyStateEventCursor: 1,
    historyConfigEventCursor: 1,
    sendingChanges: [{
      type: "added",
      previous: null,
      current: { quoteToken: token, fingerprint: "legacy", configured: true },
    }],
    assets: {
      [token]: {
        quoteToken: token,
        enabled: true,
        configured: true,
        values: ["1", "35", "35", "7", "0"],
        fields: [1n, 35n, 35n, 7n, 0n].map(value => `0x${value.toString(16).padStart(64, "0")}`),
        fingerprint: "legacy",
      },
    },
  });
  assert.equal(migrated.schemaVersion, 11);
  assert.equal("historyStateEventCursor" in migrated, false);
  assert.equal("historyConfigEventCursor" in migrated, false);
  assert.equal(migrated.pendingChanges.length, 1);
  assert.deepEqual(migrated.sendingChanges, []);
  assert.equal(migrated.assets[token].configured, true);
  assert.equal(migrated.assets[token].creationDisabled, false);
  assert.equal(migrated.assets[token].effectiveEnabled, true);
  assert.equal(migrated.assets[token].enabled, 1);
  assert.equal(migrated.assets[token].defaultCurve, 35);
  assert.equal(migrated.assets[token].disabled, false);
  assert.deepEqual(migrated.recentEvents, {});
  assert.equal(migrated.wssHealth.status, "disabled");
  assert.equal(migrated.wssHealth.backfill.status, "idle");
});

test("Factory state compactor streams away exploded candidates and keeps assets and cursors", async () => {
  const directory = mkdtempSync(join(tmpdir(), "flap-factory-state-"));
  const input = join(directory, "oversized.json");
  const output = join(directory, "factory-pool-state.json");
  const token = "0x3333333333333333333333333333333333333333";
  const candidates = {};
  for (let index = 0; index < 5_000; index++) {
    const address = `0x${index.toString(16).padStart(40, "0")}`;
    candidates[address] = {
      quoteToken: address,
      pendingVerification: true,
      sources: [{ source: "transaction", selector: "0x12345678" }],
    };
  }
  writeFileSync(input, JSON.stringify({
    schemaVersion: 8,
    proxy: FLAP_FACTORY_PROXY,
    latestBlock: 200,
    safeLatestBlock: 200,
    headLastScannedBlock: 199,
    lastScannedBlock: 198,
    historyBackwardLogCursor: 1,
    candidates,
    relatedSelectors: { "0x12345678": { quoteTokens: Object.keys(candidates) } },
    assets: {
      [token]: {
        quoteToken: token,
        configured: true,
        creationDisabled: false,
        effectiveEnabled: true,
        values: ["1", "37", "37", "7", "0"],
      },
    },
    pendingImplementationChange: { previous: "0x1111111111111111111111111111111111111111", current: "0x2222222222222222222222222222222222222222" },
  }), "utf-8");
  try {
    const result = await compactFactoryPoolStateFile(input, output);
    const compacted = JSON.parse(readFileSync(output, "utf-8"));
    assert.equal(result.assets, 1);
    assert.equal(result.candidates, 1);
    assert.ok(result.outputBytes < result.inputBytes / 10);
    assert.equal(compacted.headLastScannedBlock, 199);
    assert.equal(compacted.lastScannedBlock, 198);
    assert.ok(compacted.assets[token]);
    assert.ok(compacted.candidates[token]);
    assert.equal("historyBackwardLogCursor" in compacted, false);
    assert.equal("relatedSelectors" in compacted, false);
    assert.ok(compacted.pendingImplementationChange);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Factory state loader rejects oversized files before JSON parsing", () => {
  const directory = mkdtempSync(join(tmpdir(), "flap-factory-guard-"));
  const input = join(directory, "factory-pool-state.json");
  try {
    writeFileSync(input, "{}");
    truncateSync(input, 17 * 1024 * 1024);
    assert.equal(statSync(input).size, 17 * 1024 * 1024);
    assert.throws(() => loadFactoryPoolState(input), /状态文件过大/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Factory scanner resumes from its cursor, verifies event assets and stays idempotent", async () => {
  const token = "0x3333333333333333333333333333333333333333";
  const txHash = `0x${"cd".repeat(32)}`;
  const implementation = "0x150103da235bc6caef37a7ca31373bbdf40ccd2e";
  const state = createFactoryPoolState();
  Object.assign(state, {
    deploymentBlock: 100,
    deploymentDetection: "test",
    deploymentTxChecked: true,
    lastScannedBlock: 104,
  });
  const getterResult = `0x${[1n, 2n, 3n, 4n, 5n].map(value => value.toString(16).padStart(64, "0")).join("")}`;
  const rpcCall = async (method, params) => {
    if (method === "eth_chainId") return "0x38";
    if (method === "eth_blockNumber") return "0x70";
    if (method === "eth_getStorageAt") return `0x${"0".repeat(24)}${implementation.slice(2)}`;
    if (method === "eth_getCode") return "0x8063aabbccdd146100";
    if (method === "eth_getLogs") {
      const filter = params[0];
      const from = Number.parseInt(filter.fromBlock, 16);
      const to = Number.parseInt(filter.toBlock, 16);
      return from <= 105 && to >= 105 ? [{
        address: FLAP_FACTORY_PROXY,
        topics: [QUOTE_TOKEN_CONFIGURATION_V2_EVENT_TOPIC],
        data: `0x${token.slice(2).padStart(64, "0")}${[1n, 2n, 3n, 4n, 5n].map(value => value.toString(16).padStart(64, "0")).join("")}`,
        transactionHash: txHash,
        blockNumber: "0x69",
        logIndex: "0x0",
      }] : [];
    }
    if (method === "eth_call") return factoryGetterResult(method, params, getterResult);
    throw new Error(`unexpected RPC method ${method}`);
  };
  const config = { confirmations: 5, realtimeMaxBlocksPerRun: 20, assetRefreshPerRun: 10 };
  const first = await runFactoryPoolScan({ state, rpcCall, config });
  assert.equal(state.lastScannedBlock, 107);
  assert.equal(state.assets[token].configured, true);
  assert.equal(state.assets[token].creationDisabled, false);
  assert.equal(state.assets[token].effectiveEnabled, true);
  assert.deepEqual(state.assets[token].values, ["1", "2", "3", "4", "5"]);
  assert.equal(first.changes.length, 1);
  state.assets[token].name = "Test Pool";
  state.assets[token].symbol = "TEST";
  state.assets[token].metadataSource = "goplus";
  const second = await runFactoryPoolScan({ state, rpcCall, config });
  assert.equal(second.changes.length, 0);
  assert.equal(state.assets[token].name, "Test Pool");
  assert.equal(state.assets[token].symbol, "TEST");
  assert.equal(state.assets[token].metadataSource, "goplus");
  assert.equal("processedTransactions" in state, false);
  assert.ok(state.candidates[token].sources.length >= 1);
  assert.equal("relatedSelectors" in state, false);
});

test("Factory scanner locates deployment block and creation transaction automatically", async () => {
  const state = createFactoryPoolState();
  const creationHash = `0x${"ef".repeat(32)}`;
  const deployer = "0x4444444444444444444444444444444444444444";
  const implementation = "0x5555555555555555555555555555555555555555";
  const rpcCall = async (method, params) => {
    if (method === "eth_chainId") return "0x38";
    if (method === "eth_blockNumber") return "0x70";
    if (method === "eth_getCode") {
      if (params[0].toLowerCase() === implementation) return "0x8063aabbccdd146100";
      return Number.parseInt(params[1], 16) >= 100 ? "0x6000" : "0x";
    }
    if (method === "eth_getStorageAt") return `0x${"0".repeat(24)}${implementation.slice(2)}`;
    if (method === "eth_getLogs") return [];
    if (method === "eth_getBlockByNumber") {
      const blockNumber = Number.parseInt(params[0], 16);
      return {
        hash: `0x${blockNumber.toString(16).padStart(64, "0")}`,
        transactions: params[1] && blockNumber === 100 ? [{ hash: creationHash, from: deployer, to: null, input: "0x" }] : [],
      };
    }
    if (method === "eth_getTransactionReceipt") return { contractAddress: FLAP_FACTORY_PROXY };
    if (method === "eth_getTransactionByHash") return null;
    throw new Error(`unexpected RPC method ${method}`);
  };
  await runFactoryPoolScan({
    state,
    rpcCall,
    config: { confirmations: 5, deepHistoryBlockScan: false, historyLogChunkBlocks: 20, assetRefreshPerRun: 1 },
  });
  assert.equal(state.deploymentBlock, 100);
  assert.equal(state.deploymentDetection, "eth_getCode-binary-search");
  assert.equal(state.deploymentTxHash, creationHash);
  assert.equal(state.deployer, deployer);
});

test("Factory realtime fast path scans configuration events without full blocks or transactions", async () => {
  const token = "0x7777777777777777777777777777777777777777";
  const implementation = "0x8888888888888888888888888888888888888888";
  const state = createFactoryPoolState();
  Object.assign(state, {
    deploymentBlock: 1,
    deploymentTxChecked: true,
    deploymentDetection: "test",
    currentImplementation: implementation,
    lastScannedBlock: 100,
  });
  const requestedBlocks = [];
  const getterResult = `0x${[1n, 9n, 8n, 7n, 6n].map(value => value.toString(16).padStart(64, "0")).join("")}`;
  const rpcCall = async (method, params) => {
    if (method === "eth_chainId") return "0x38";
    if (method === "eth_blockNumber") return "0x3ed";
    if (method === "eth_getStorageAt") return `0x${"0".repeat(24)}${implementation.slice(2)}`;
    if (method === "eth_getLogs") {
      assert.deepEqual(params[0].topics, [FACTORY_POOL_STATE_EVENT_TOPICS]);
      return [{
        address: FLAP_FACTORY_PROXY,
        topics: [QUOTE_TOKEN_CONFIGURATION_EVENT_TOPIC],
        data: `0x${token.slice(2).padStart(64, "0")}${1n.toString(16).padStart(64, "0")}`,
        transactionHash: `0x${"34".repeat(32)}`,
        blockNumber: "0x3e8",
        logIndex: "0x0",
      }];
    }
    if (method === "eth_call") return factoryGetterResult(method, params, getterResult);
    if (method === "eth_getBlockByNumber") {
      requestedBlocks.push(Number.parseInt(params[0], 16));
      throw new Error("实时快通道不应读取完整区块");
    }
    if (method === "eth_getTransactionByHash") throw new Error("实时快通道不应读取关联交易");
    throw new Error(`unexpected RPC method ${method}`);
  };
  const result = await runFactoryPoolScan({
    state,
    rpcCall,
    config: { confirmations: 5, scanRealtime: true, scanCatchup: false, scanHistory: false, realtimeMaxBlocksPerRun: 20, assetRefreshPerRun: 1 },
  });
  assert.equal(state.headLastScannedBlock, 1000);
  assert.equal(state.lastScannedBlock, 100);
  assert.equal(state.assets[token].effectiveEnabled, true);
  assert.equal(result.changes.length, 1);
  assert.deepEqual(requestedBlocks, []);
});

test("Factory realtime fast path rescans the latest blocks without duplicate changes", async () => {
  const implementation = "0x8888888888888888888888888888888888888888";
  const state = createFactoryPoolState();
  Object.assign(state, {
    deploymentBlock: 1,
    deploymentTxChecked: true,
    deploymentDetection: "test",
    currentImplementation: implementation,
    headLastScannedBlock: 1000,
    lastScannedBlock: 1000,
  });
  const logRanges = [];
  const rpcCall = async (method, params) => {
    if (method === "eth_chainId") return "0x38";
    if (method === "eth_blockNumber") return "0x3e8";
    if (method === "eth_getStorageAt") return `0x${"0".repeat(24)}${implementation.slice(2)}`;
    if (method === "eth_getLogs") {
      logRanges.push({
        from: Number.parseInt(params[0].fromBlock, 16),
        to: Number.parseInt(params[0].toBlock, 16),
      });
      return [];
    }
    throw new Error(`unexpected RPC method ${method}`);
  };
  const result = await runFactoryPoolScan({
    state,
    rpcCall,
    config: {
      confirmations: 0,
      scanRealtime: true,
      scanFallback: false,
      scanCatchup: false,
      scanHistory: false,
      realtimeMaxBlocksPerRun: 20,
      realtimeRescanBlocks: 5,
      assetRefreshPerRun: 0,
    },
  });
  assert.deepEqual(logRanges, [{ from: 996, to: 1000 }]);
  assert.equal(state.headLastScannedBlock, 1000);
  assert.deepEqual(result.changes, []);
  assert.equal(result.changed, false);
});

test("Factory pending candidate survives a failed getter and succeeds on the next realtime scan", async () => {
  const token = "0x4545454545454545454545454545454545454545";
  const implementation = "0x150103da235bc6caef37a7ca31373bbdf40ccd2e";
  const txHash = `0x${"45".repeat(32)}`;
  const state = createFactoryPoolState();
  Object.assign(state, {
    deploymentBlock: 1,
    deploymentTxChecked: true,
    deploymentDetection: "test",
    currentImplementation: implementation,
    headLastScannedBlock: 99,
    lastScannedBlock: 99,
  });
  const getterResult = `0x${[1n, 35n, 35n, 7n, 0n].map(value => value.toString(16).padStart(64, "0")).join("")}`;
  let latestBlock = 100;
  let failGetter = true;
  const lifecycle = [];
  const rpcCall = async (method, params) => {
    if (method === "eth_chainId") return "0x38";
    if (method === "eth_blockNumber") return `0x${latestBlock.toString(16)}`;
    if (method === "eth_getStorageAt") return `0x${"0".repeat(24)}${implementation.slice(2)}`;
    if (method === "eth_getCode") return "0x8063aabbccdd146100";
    if (method === "eth_getLogs") {
      if (latestBlock > 100) return [];
      return [{
        address: FLAP_FACTORY_PROXY,
        topics: [QUOTE_TOKEN_CONFIGURATION_V2_EVENT_TOPIC],
        data: `0x${token.slice(2).padStart(64, "0")}${[1n, 35n, 35n, 7n, 0n].map(value => value.toString(16).padStart(64, "0")).join("")}`,
        transactionHash: txHash,
        blockNumber: "0x64",
        logIndex: "0x0",
      }];
    }
    if (method === "eth_call") {
      lifecycle.push("eth_call");
      if (failGetter) throw new Error("temporary getter failure");
      return factoryGetterResult(method, params, getterResult, BOOLEAN_FALSE_RESULT);
    }
    throw new Error(`unexpected RPC method ${method}`);
  };
  const config = {
    confirmations: 0,
    scanRealtime: true,
    scanCatchup: false,
    scanHistory: false,
    assetRefreshPerRun: 0,
  };
  const first = await runFactoryPoolScan({
    state,
    rpcCall,
    config,
    persistState: async persistedState => {
      lifecycle.push("persist");
      assert.equal(persistedState.candidates[token].lastTxHash, txHash);
      assert.equal(persistedState.candidates[token].lastSourceBlock, 100);
    },
  });
  assert.equal(lifecycle[0], "persist");
  assert.equal(first.changes.length, 0);
  assert.equal(state.headLastScannedBlock, 100);
  assert.equal(state.candidates[token].pendingVerification, true);
  assert.match(state.candidates[token].lastVerifyError, /temporary getter failure/);
  assert.equal(state.verificationHealth.failingCount, 1);
  assert.match(state.lastError, /候选复核失败/);

  failGetter = false;
  latestBlock = 101;
  const second = await runFactoryPoolScan({ state, rpcCall, config, persistState: async () => {} });
  assert.equal(second.changes.length, 1);
  assert.equal(second.changes[0].type, "added");
  assert.equal(state.candidates[token].pendingVerification, false);
  assert.equal(state.candidates[token].lastVerifyError, "");
  assert.equal(state.verificationHealth.failingCount, 0);
  assert.equal(state.lastError, "");
});

test("Factory realtime and asset refresh scans merge cursors assets and notifications", async () => {
  const realtimeToken = "0x1111111111111111111111111111111111111111";
  const backgroundToken = "0x2222222222222222222222222222222222222222";
  const state = createFactoryPoolState();
  state.latestBlock = 100;
  state.headLastScannedBlock = 100;
  const sentContents = [];
  let realtimeEntered;
  let backgroundEntered;
  const realtimeReady = new Promise(resolve => { realtimeEntered = resolve; });
  const backgroundReady = new Promise(resolve => { backgroundEntered = resolve; });
  const scanFn = async ({ state: working, config }) => {
    const realtime = config.scanRealtime;
    if (realtime) {
      realtimeEntered();
      await backgroundReady;
    } else {
      backgroundEntered();
      await realtimeReady;
    }
    const token = realtime ? realtimeToken : backgroundToken;
    const asset = {
      quoteToken: token,
      configured: true,
      creationDisabled: false,
      effectiveEnabled: true,
      fingerprint: realtime ? "realtime" : "background",
      lastVerifiedAtMs: realtime ? 200 : 150,
    };
    working.assets[token] = asset;
    working.candidates[token] = {
      quoteToken: token,
      pendingVerification: false,
      lastVerifyAttemptAtMs: asset.lastVerifiedAtMs,
      sources: [],
    };
    if (realtime) {
      working.latestBlock = 200;
      working.headLastScannedBlock = 200;
    } else {
      working.lastScannedBlock = 150;
    }
    return {
      changed: true,
      changes: [{ type: "added", previous: null, current: asset }],
      implementationChange: null,
      state: working,
    };
  };
  const common = {
    scanFn,
    sendCardFn: async (_title, content) => {
      sentContents.push(content);
      return `om_${sentContents.length}`;
    },
    saveStateFn: () => {},
    pinFn: async () => {},
    scheduleMetadataFn: async () => ({ patched: false }),
  };
  await Promise.all([
    __testables.checkFlapFactoryPools(state, { ...common, scanConfig: { scanRealtime: true, scanAssets: false } }),
    __testables.checkFlapFactoryPools(state, { ...common, scanConfig: { scanRealtime: false, scanAssets: true } }),
  ]);
  assert.equal(state.headLastScannedBlock, 200);
  assert.equal(state.lastScannedBlock, 150);
  assert.ok(state.assets[realtimeToken]);
  assert.ok(state.assets[backgroundToken]);
  assert.ok(sentContents.length >= 1);
  const delivered = sentContents.join("\n");
  assert.match(delivered, new RegExp(realtimeToken));
  assert.match(delivered, new RegExp(backgroundToken));
});

test("Factory state merge prefers newer chain data and never regresses cursors", () => {
  const token = "0x3333333333333333333333333333333333333333";
  const target = createFactoryPoolState();
  Object.assign(target, {
    latestBlock: 200,
    headLastScannedBlock: 200,
    lastScannedBlock: 200,
    assets: {
      [token]: { quoteToken: token, fingerprint: "new", lastVerifiedBlock: 200, lastVerifiedAtMs: 100 },
    },
  });
  const stale = structuredClone(target);
  stale.assets[token] = { quoteToken: token, fingerprint: "stale", lastVerifiedBlock: 199, lastVerifiedAtMs: 999 };
  __testables.mergeFactoryPoolScanState(target, stale);
  assert.equal(target.assets[token].fingerprint, "new");

  const staleCursor = structuredClone(target);
  staleCursor.headLastScannedBlock = 199;
  staleCursor.lastScannedBlock = 199;
  __testables.mergeFactoryPoolScanState(target, staleCursor);
  assert.equal(target.headLastScannedBlock, 200);
  assert.equal(target.lastScannedBlock, 200);
});

test("Factory realtime state event discovers paused QQQB with its current on-chain configuration", async () => {
  const token = "0x205812cdbed920aff76c6580abd681a46d11efc7";
  const implementation = "0x150103da235bc6caef37a7ca31373bbdf40ccd2e";
  const state = createFactoryPoolState();
  Object.assign(state, {
    deploymentBlock: 1,
    deploymentTxChecked: true,
    deploymentDetection: "test",
    currentImplementation: implementation,
    headLastScannedBlock: 999,
    lastScannedBlock: 999,
  });
  const getterResult = `0x${[1n, 35n, 35n, 7n, 0n].map(value => value.toString(16).padStart(64, "0")).join("")}`;
  const rpcCall = async (method, params) => {
    if (method === "eth_chainId") return "0x38";
    if (method === "eth_blockNumber") return "0x3ed";
    if (method === "eth_getStorageAt") return `0x${"0".repeat(24)}${implementation.slice(2)}`;
    if (method === "eth_getCode") return "0x8063aabbccdd146100";
    if (method === "eth_getLogs") {
      assert.deepEqual(params[0].topics, [FACTORY_POOL_STATE_EVENT_TOPICS]);
      return [{
        address: FLAP_FACTORY_PROXY,
        topics: [QUOTE_TOKEN_CREATION_DISABLED_EVENT_TOPIC, `0x${token.slice(2).padStart(64, "0")}`],
        data: BOOLEAN_TRUE_RESULT,
        transactionHash: `0x${"78".repeat(32)}`,
        blockNumber: "0x3e8",
        logIndex: "0x0",
      }];
    }
    if (method === "eth_call") return factoryGetterResult(method, params, getterResult, BOOLEAN_TRUE_RESULT);
    if (method === "eth_getBlockByNumber") throw new Error("实时状态事件快通道不应读取完整区块");
    if (method === "eth_getTransactionByHash") throw new Error("实时状态事件快通道不应读取关联交易");
    throw new Error(`unexpected RPC method ${method}`);
  };
  const result = await runFactoryPoolScan({
    state,
    rpcCall,
    config: { confirmations: 5, scanRealtime: true, scanCatchup: false, scanHistory: false, assetRefreshPerRun: 0 },
  });
  assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0].type, "added");
  assert.deepEqual(state.assets[token].values, ["1", "35", "35", "7", "0"]);
  assert.equal(state.assets[token].configured, true);
  assert.equal(state.assets[token].creationDisabled, true);
  assert.equal(state.assets[token].effectiveEnabled, false);
});

test("Factory realtime path preserves rapid pause and resume events", async () => {
  const token = "0x7070707070707070707070707070707070707070";
  const implementation = "0x150103da235bc6caef37a7ca31373bbdf40ccd2e";
  const state = createFactoryPoolState();
  const fields = [1n, 20n, 20n, 0n, 0n].map(value => `0x${value.toString(16).padStart(64, "0")}`);
  const configurationFingerprint = createHash("sha256").update(fields.join(":")).digest("hex");
  const activeFingerprint = createHash("sha256").update(`${configurationFingerprint}:0`).digest("hex");
  state.assets[token] = {
    quoteToken: token,
    configured: true,
    configurationPresent: true,
    creationDisabled: false,
    effectiveEnabled: true,
    fields,
    values: ["1", "20", "20", "0", "0"],
    configurationFingerprint,
    fingerprint: activeFingerprint,
  };
  Object.assign(state, {
    deploymentBlock: 1,
    deploymentTxChecked: true,
    deploymentDetection: "test",
    currentImplementation: implementation,
    headLastScannedBlock: 999,
    lastScannedBlock: 999,
  });
  const getterResult = `0x${[1n, 20n, 20n, 0n, 0n].map(value => value.toString(16).padStart(64, "0")).join("")}`;
  const rpcCall = async (method, params) => {
    if (method === "eth_chainId") return "0x38";
    if (method === "eth_blockNumber") return "0x3e8";
    if (method === "eth_getStorageAt") return `0x${"0".repeat(24)}${implementation.slice(2)}`;
    if (method === "eth_getLogs") return [BOOLEAN_TRUE_RESULT, BOOLEAN_FALSE_RESULT].map((data, index) => ({
      address: FLAP_FACTORY_PROXY,
      topics: [QUOTE_TOKEN_CREATION_DISABLED_EVENT_TOPIC, `0x${token.slice(2).padStart(64, "0")}`],
      data,
      transactionHash: `0x${"72".repeat(32)}`,
      transactionIndex: "0x1",
      blockNumber: "0x3e8",
      logIndex: `0x${index.toString(16)}`,
    }));
    if (method === "eth_call") return factoryGetterResult(method, params, getterResult, BOOLEAN_FALSE_RESULT);
    throw new Error(`unexpected RPC method ${method}`);
  };
  const result = await runFactoryPoolScan({
    state,
    rpcCall,
    config: { confirmations: 0, scanRealtime: true, scanCatchup: false, scanHistory: false, assetRefreshPerRun: 0 },
  });
  assert.deepEqual(result.changes.map(change => change.type), ["paused", "resumed"]);
  assert.equal(state.assets[token].effectiveEnabled, true);
});

test("Factory real TSLAB event fixture preserves configuration and resume evidence", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/factory-pool-events.json", import.meta.url), "utf-8")).tslab;
  const token = fixture.quoteToken.toLowerCase();
  const configuration = extractFactoryLogCandidates({
    address: FLAP_FACTORY_PROXY,
    topics: [fixture.configuration.topic0],
    data: `0x${token.slice(2).padStart(64, "0")}${fixture.configuration.values
      .map(value => BigInt(value).toString(16).padStart(64, "0")).join("")}`,
    transactionHash: fixture.configuration.transactionHash,
    blockNumber: `0x${fixture.configuration.blockNumber.toString(16)}`,
    logIndex: "0x0",
  });
  const resumed = extractFactoryLogCandidates({
    address: FLAP_FACTORY_PROXY,
    topics: [fixture.creationResumed.topic0, `0x${token.slice(2).padStart(64, "0")}`],
    data: BOOLEAN_FALSE_RESULT,
    transactionHash: fixture.creationResumed.transactionHash,
    blockNumber: `0x${fixture.creationResumed.blockNumber.toString(16)}`,
    logIndex: "0x1",
  });
  assert.equal(configuration[0].quoteToken, token);
  assert.equal(configuration[0].txHash, fixture.configuration.transactionHash);
  assert.equal(configuration[0].blockNumber, fixture.configuration.blockNumber);
  assert.equal(resumed[0].quoteToken, token);
  assert.equal(resumed[0].txHash, fixture.creationResumed.transactionHash);
  assert.equal(resumed[0].blockNumber, fixture.creationResumed.blockNumber);
});

test("Factory asset refresh detects a paused asset resuming without scanning blocks", async () => {
  const token = "0x431a3bee82e2ca41e49895cbece5bb0f76a89b7a";
  const state = createFactoryPoolState();
  Object.assign(state, {
    deploymentBlock: 1,
    deploymentTxChecked: true,
    deploymentDetection: "test",
    headLastScannedBlock: 1000,
    lastScannedBlock: 1000,
    assets: {
      [token]: {
        quoteToken: token,
        configured: true,
        creationDisabled: true,
        effectiveEnabled: false,
        values: ["1", "34", "34", "7", "0"],
        configurationFingerprint: "apple-config",
        fingerprint: "paused",
      },
    },
  });
  const getterResult = `0x${[1n, 34n, 34n, 7n, 0n].map(value => value.toString(16).padStart(64, "0")).join("")}`;
  const rpcCall = async (method, params) => {
    if (method === "eth_chainId") return "0x38";
    if (method === "eth_blockNumber") return "0x3e8";
    if (method === "eth_call") return factoryGetterResult(method, params, getterResult, BOOLEAN_FALSE_RESULT);
    if (method === "eth_getLogs" || method === "eth_getBlockByNumber") throw new Error("资产复核不应扫描区块");
    throw new Error(`unexpected RPC method ${method}`);
  };
  const result = await runFactoryPoolScan({
    state,
    rpcCall,
    config: {
      confirmations: 0,
      scanRealtime: false,
      scanCatchup: false,
      scanAssets: true,
      assetRefreshPerRun: 1,
    },
  });
  assert.equal(result.changes[0].type, "resumed");
  assert.equal(state.assets[token].creationDisabled, false);
  assert.equal(state.assets[token].effectiveEnabled, true);
});

test("Factory partial scan failure preserves and later sends an Apple resume notification", async () => {
  const token = "0x431a3bee82e2ca41e49895cbece5bb0f76a89b7a";
  const paused = {
    quoteToken: token,
    configured: true,
    creationDisabled: true,
    effectiveEnabled: false,
    values: ["1", "34", "34", "7", "0"],
  };
  const resumed = { ...paused, creationDisabled: false, effectiveEnabled: true };
  const state = {
    ...createFactoryPoolState(),
    assets: { [token]: paused },
    pendingChanges: [],
    pendingImplementationChange: null,
  };
  let saveCalls = 0;
  await assert.rejects(__testables.checkFlapFactoryPools(state, {
    scanFn: async ({ state: targetState }) => {
      targetState.assets[token] = resumed;
      throw new Error("later fallback failed");
    },
    saveStateFn: () => { saveCalls++; },
    scheduleMetadataFn: async () => ({ patched: false }),
  }), /later fallback failed/);
  assert.equal(saveCalls, 1);
  assert.equal(state.pendingChanges.length, 1);
  assert.equal(state.pendingChanges[0].type, "resumed");

  let sentContent = "";
  const result = await __testables.checkFlapFactoryPools(state, {
    scanFn: async () => ({ changed: false, changes: [], implementationChange: null, state }),
    sendCardFn: async (_title, content) => {
      sentContent = content;
      return "om_apple_resume";
    },
    saveStateFn: () => { saveCalls++; },
    pinFn: async () => {},
    scheduleMetadataFn: async () => ({ patched: false }),
  });
  assert.equal(result.sent, true);
  assert.match(sentContent, /恢复创建：名称同步中/);
  assert.match(sentContent, /状态：支持创建/);
  assert.match(sentContent, new RegExp(token));
  assert.deepEqual(state.pendingChanges, []);
});

test("Factory catchup advances with only configuration events and no full blocks", async () => {
  const state = createFactoryPoolState();
  Object.assign(state, {
    deploymentBlock: 1,
    deploymentTxChecked: true,
    deploymentDetection: "test",
    headLastScannedBlock: 1000,
    lastScannedBlock: 100,
    historyStateEventCursor: 1,
  });
  const logRanges = [];
  let fullBlockRequests = 0;
  const rpcCall = async (method, params) => {
    if (method === "eth_chainId") return "0x38";
    if (method === "eth_blockNumber") return "0x3ed";
    if (method === "eth_getLogs") {
      logRanges.push({
        from: Number.parseInt(params[0].fromBlock, 16),
        to: Number.parseInt(params[0].toBlock, 16),
        topics: params[0].topics,
      });
      return [];
    }
    if (method === "eth_getBlockByNumber") {
      fullBlockRequests++;
      throw new Error("配置事件连续补扫不应读取完整区块");
    }
    throw new Error(`unexpected RPC method ${method}`);
  };
  await runFactoryPoolScan({
    state,
    rpcCall,
    config: {
      confirmations: 5,
      scanRealtime: false,
      scanCatchup: true,
      scanHistory: false,
      catchupMaxBlocksPerRun: 200,
    },
  });
  assert.equal(state.lastScannedBlock, 300);
  assert.deepEqual(logRanges, [{ from: 101, to: 300, topics: [FACTORY_POOL_STATE_EVENT_TOPICS] }]);
  assert.equal(fullBlockRequests, 0);
  assert.ok(state.lastCatchupRunAt);
});

test("shared Flap asset-only page changes are summarized into one site-wide notification", () => {
  const notifications = [
    {
      url: "https://flap.sh/bnb/CAstore",
      title: "Flap 页面变更",
      template: "red",
      changes: [
        "📦 前端资源变更： 不变 28 | 修改 2",
        "🔇 构建噪音： 1 文件 4 处 (webpack-3790dbebac76c2a6.js)",
      ],
      meta: {
        assetStats: { unchanged: 28, renamed: 0, modified: 2, added: 0, removed: 0, noiseFiles: 1, noiseCount: 4, substantiveFiles: 1, substantiveCount: 2, substantiveFileNames: ["webpack-3790dbebac76c2a6.js"] },
        textChangeCount: 0,
        textChanges: [],
        i18nChangeCount: 0,
        i18nDiffs: [],
        caStoreVaultDiffs: [],
      },
      snapshotUpdate: { key: "castore", features: { marker: "castore" } },
    },
    {
      url: "https://flap.sh/launch",
      title: "Flap 页面变更",
      template: "red",
      changes: [
        "📦 前端资源变更： 不变 20 | 修改 2",
        "🔇 构建噪音： 1 文件 4 处 (webpack-3790dbebac76c2a6.js)",
      ],
      meta: {
        assetStats: { unchanged: 20, renamed: 0, modified: 2, added: 0, removed: 0, noiseFiles: 1, noiseCount: 4, substantiveFiles: 1, substantiveCount: 2, substantiveFileNames: ["webpack-3790dbebac76c2a6.js"] },
        textChangeCount: 0,
        textChanges: [],
        i18nChangeCount: 0,
        i18nDiffs: [],
        caStoreVaultDiffs: [],
      },
      snapshotUpdate: { key: "launch", features: { marker: "launch" } },
    },
  ];

  const grouped = __testables.coalesceFlapNotifications(notifications);

  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].title, "Flap 全站前端资源变更");
  assert.equal(grouped[0].url, "https://flap.sh");
  assert.match(grouped[0].changes.join("\n"), /影响页面 2 个/);
  assert.match(grouped[0].changes.join("\n"), /https:\/\/flap\.sh\/bnb\/CAstore/);
  assert.match(grouped[0].changes.join("\n"), /https:\/\/flap\.sh\/launch/);
  assert.match(grouped[0].content, /\[\/bnb\/CAstore\]\(https:\/\/flap\.sh\/bnb\/CAstore\)/);
  assert.equal(grouped[0].skipAi, false);
  assert.equal(grouped[0].useFullDiffForAi, true);
  assert.equal(grouped[0].snapshotUpdates.length, 2);
});

test("specific Flap page content changes remain page-level notifications", () => {
  const notifications = [
    {
      url: "https://flap.sh/bnb/CAstore",
      title: "Flap 页面变更",
      template: "red",
      changes: ["🏦 CAstore 金库内容变更：", "  🟢 新增金库: Gift Vault"],
      meta: {
        assetStats: null,
        textChangeCount: 0,
        textChanges: [],
        i18nChangeCount: 0,
        i18nDiffs: [],
        caStoreVaultDiffs: [{ type: "added", name: "Gift Vault" }],
      },
      snapshotUpdate: { key: "castore", features: { marker: "castore" } },
    },
    {
      url: "https://flap.sh/launch",
      title: "Flap 页面变更",
      template: "red",
      changes: ["📦 前端资源变更： 不变 20 | 修改 2"],
      meta: {
        assetStats: { unchanged: 20, renamed: 0, modified: 2, added: 0, removed: 0, noiseFiles: 0, noiseCount: 0, substantiveFiles: 1, substantiveCount: 1, substantiveFileNames: ["webpack-3790dbebac76c2a6.js"] },
        textChangeCount: 0,
        textChanges: [],
        i18nChangeCount: 0,
        i18nDiffs: [],
        caStoreVaultDiffs: [],
      },
      snapshotUpdate: { key: "launch", features: { marker: "launch" } },
    },
  ];

  const grouped = __testables.coalesceFlapNotifications(notifications);

  assert.equal(grouped.length, 2);
  assert.equal(grouped[0].title, "Flap 页面变更");
  assert.equal(grouped[0].url, "https://flap.sh/bnb/CAstore");
  assert.equal(grouped[1].title, "Flap 全站前端资源变更");
});

test("shared resource diffs are extracted and coalesced even when one page has CAstore changes", () => {
  const sharedMeta = {
    assetStats: {
      unchanged: 20,
      modified: 2,
      renamed: 1,
      substantiveFileNames: ["1094-58c02e471cdb0fcb.js", "webpack-41b2e37c796e2aae.js"],
      substantiveAssetPaths: ["/_next/static/chunks/1094-58c02e471cdb0fcb.js", "/_next/static/chunks/webpack-41b2e37c796e2aae.js"],
      semanticProfile: __testables.buildAssetSemanticProfile([
        "/_next/static/chunks/1094-58c02e471cdb0fcb.js",
        "/_next/static/chunks/webpack-41b2e37c796e2aae.js",
      ]),
      configDiffs: [
        { field: "enabled", oldVal: "(新增)", newVal: "!0", file: "1094-58c02e471cdb0fcb.js" },
        { field: "showInCAStore", oldVal: "(新增)", newVal: "!1", file: "1094-58c02e471cdb0fcb.js" },
      ],
      jsTextDiffs: [
        { type: "added", text: "you can still view its tax info while indexing.", file: "1094-58c02e471cdb0fcb.js" },
      ],
      vaultDiffs: [],
    },
    textChangeCount: 0,
    textChanges: [],
    i18nChangeCount: 0,
    i18nDiffs: [],
    caStoreVaultDiffs: [],
  };
  const notifications = [
    {
      url: "https://flap.sh/bnb/CAstore",
      title: "Flap 页面变更",
      template: "red",
      changes: ["🏦 CAstore 金库内容变更：", "  🔴 移除金库: Hot Vaults / Perpetual Short Vault", "📦 前端资源变更：修改 2", "🔧 配置参数变更："],
      meta: {
        ...JSON.parse(JSON.stringify(sharedMeta)),
        caStoreVaultDiffs: [{ type: "removed", area: "Hot Vaults", name: "Perpetual Short Vault", oldDescription: "A BNB-margin short-only vault." }],
      },
      snapshotUpdate: { key: "castore", features: {} },
    },
    ...["https://flap.sh/create", "https://flap.sh/launch"].map((url, i) => ({
      url,
      title: "Flap 页面变更",
      template: "red",
      changes: ["📦 前端资源变更：修改 2", "🔧 配置参数变更："],
      meta: JSON.parse(JSON.stringify(sharedMeta)),
      snapshotUpdate: { key: `p${i}`, features: {} },
    })),
  ];

  const grouped = __testables.coalesceFlapNotifications(notifications);

  assert.equal(grouped.length, 2);
  assert.equal(grouped[0].url, "https://flap.sh/bnb/CAstore");
  assert.equal(grouped[0].meta.assetStats, null);
  assert.equal(grouped[0].meta.caStoreVaultDiffs.length, 1);
  assert.equal(grouped[1].title, "Flap 全站前端资源变更");
  assert.equal(grouped[1].url, "https://flap.sh");
  assert.equal(grouped[1].snapshotUpdates.length, 3);
});

test("asset notifications containing business keywords stay page-level", () => {
  const notifications = [
    {
      url: "https://flap.sh/bnb/CAstore",
      title: "Flap 页面变更",
      template: "red",
      changes: [
        "📦 前端资源变更： 不变 28 | 修改 2",
        "📝 vault-page.js (2 处实质变更)",
        "  + New Vault fee rate",
      ],
      meta: {
        assetStats: {
          unchanged: 28,
          renamed: 0,
          modified: 2,
          added: 0,
          removed: 0,
          noiseFiles: 0,
          noiseCount: 0,
          substantiveFiles: 1,
          substantiveCount: 2,
          substantiveFileNames: ["vault-page.js"],
          configDiffs: [],
          vaultDiffs: [],
          jsTextDiffs: [],
        },
        textChangeCount: 0,
        textChanges: [],
        i18nChangeCount: 0,
        i18nDiffs: [],
        caStoreVaultDiffs: [],
      },
      snapshotUpdate: { key: "castore", features: { marker: "castore" } },
    },
  ];

  const grouped = __testables.coalesceFlapNotifications(notifications);

  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].title, "Flap 页面变更");
  assert.equal(grouped[0].url, "https://flap.sh/bnb/CAstore");
});

test("shared business resource diffs across pages are coalesced into one site-wide notification", () => {
  const sharedMeta = {
    assetStats: {
      unchanged: 28,
      renamed: 2,
      modified: 2,
      added: 0,
      removed: 0,
      noiseFiles: 0,
      noiseCount: 0,
      substantiveFiles: 2,
      substantiveCount: 10,
      substantiveFileNames: ["8101-025ad0379fc93d08.js", "webpack-fcd3cb604bdd2e6d.js"],
      configDiffs: [
        { field: "fees", oldVal: "(新增)", newVal: "void", file: "8101-025ad0379fc93d08.js" },
        { field: "maxFeePerGas", oldVal: "(新增)", newVal: "void", file: "8101-025ad0379fc93d08.js" },
      ],
      vaultDiffs: [],
      jsTextDiffs: [
        { type: "added", text: "Create an account and generate a wallet", file: "8101-025ad0379fc93d08.js" },
      ],
    },
    textChangeCount: 0,
    textChanges: [],
    i18nChangeCount: 0,
    i18nDiffs: [],
    caStoreVaultDiffs: [],
  };
  const notifications = ["https://flap.sh/bnb/CAstore", "https://flap.sh/create", "https://flap.sh/launch"].map((url, i) => ({
    url,
    title: "Flap 页面变更",
    template: "red",
    changes: ["📦 前端资源变更： 不变 28 | 重命名 2 | 修改 2", "🔧 配置参数变更：", "  fees: (新增) → void"],
    meta: JSON.parse(JSON.stringify(sharedMeta)),
    snapshotUpdate: { key: `p${i}`, features: { marker: i } },
  }));

  const grouped = __testables.coalesceFlapNotifications(notifications);

  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].title, "Flap 全站前端资源变更");
  assert.equal(grouped[0].url, "https://flap.sh");
  assert.doesNotMatch(grouped[0].content, /结论摘要|证据详情|本地初筛/);
  assert.match(grouped[0].content, /\*\*资源统计\*\*[\s\S]*不变 28 \/ 重命名 2 \/ 修改 2 \/ 新增 0 \/ 移除 0/);
  assert.match(grouped[0].content, /<font color="green">新增文案<\/font>: <font color="green">Create an account and generate a wallet<\/font>/);
  assert.match(grouped[0].content, /Create an account and generate a wallet/);
  assert.match(grouped[0].content, /fees：<font color="red">\(新增\)<\/font> → <font color="green">void<\/font>/);
  assert.doesNotMatch(grouped[0].content, /8101-025ad0379fc93d08\.js/);
  assert.match(grouped[0].content, /\*\*🤖 AI 分析\*\*/);
  assert.equal(grouped[0].skipBusinessPriorityTitle, true);
  assert.equal(grouped[0].skipAi, false);
  assert.equal(grouped[0].useFullDiffForAi, true);
  assert.equal(grouped[0].snapshotUpdates.length, 3);
});

test("Flap asset extraction explains SVG paths Tailwind utilities and style pseudo configs as UI signals", () => {
  const oldFeatures = {
    assetHash: "old-assets",
    assetContents: {
      "8625-aaa.js": {
        path: "/_next/static/chunks/8625-aaa.js",
        contentHash: "old",
        strings: ["stable shared copy for diff matching"],
      },
    },
  };
  const newFeatures = {
    assetHash: "new-assets",
    assetContents: {
      "8625-aaa.js": {
        path: "/_next/static/chunks/8625-aaa.js",
        contentHash: "new",
        strings: [
          "stable shared copy for diff matching",
          "M7 0.583984L11.9587 2.28634C12.2356 2.38143 12.4212 2.64208 12.4212 2.93497V6.99935C12.4212 9.18164 11.2444 11.1949 9.3413 12.2654L7 13.583Z",
          "absolute bottom-2 left-1/2 -translate-x-1/2",
          "absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none",
          "disabled:pointer-events-none",
          "peer-disabled:cursor-not-allowed peer-disabled:opacity-70 text-[12px] font-medium leading-[18px] text-white/80",
          "group-hover/nav-dropdown:visible group-focus-within/nav-dropdown:opacity-100 max-[375px]:hidden min-[1400px]:flex",
          "[--ui20-chamfer-bg:#000000] hover:[--ui20-chamfer-bg:#D0FF00]",
          "[&_[data-radix-scroll-area-viewport]>div]:!block [&_[data-radix-scroll-area-viewport]>div]:!min-w-0",
        ],
      },
    },
  };

  const { changes, meta } = __testables.diffFeatures(oldFeatures, newFeatures);
  const payload = JSON.stringify({ changes, meta });

  assert.deepEqual(meta.assetStats.configDiffs, []);
  assert.deepEqual(meta.assetStats.jsTextDiffs, []);
  assert.equal(meta.assetStats.substantiveFiles, 0);
  assert.equal(meta.assetStats.noiseFiles, 1);
  assert(meta.assetStats.uiStyleDiffs.length > 0);
  assert(meta.assetStats.uiStyleDiffs.some(d => d.category === "icon"));
  assert(meta.assetStats.uiStyleDiffs.some(d => d.category === "disabled"));
  assert(meta.assetStats.uiStyleDiffs.some(d => d.category === "responsive"));
  assert(meta.assetStats.uiStyleDiffs.some(d => d.category === "component"));
  assert(meta.assetStats.uiStyleDiffs.some(d => d.contextLabel === "顶部导航/下拉菜单"));
  assert(meta.assetStats.uiStyleDiffs.some(d => d.contextLabel === "代币创建表单控件"));
  assert(meta.assetStats.uiStyleDiffs.some(d => d.contextLabel === "弹窗/下拉层/滚动区"));

  const content = __testables.buildCardBriefing(
    "https://flap.sh/create",
    null,
    meta.assetStats,
    0,
    0,
    [],
    [],
    [],
  );

  assert.doesNotMatch(content, /UI\/样式信号/);
  assert.doesNotMatch(content, /禁用态交互|图标\/矢量|响应式布局|组件样式变量/);
  assert.match(content, /\*\*资源统计\*\*[\s\S]*修改 1/);
  assert.doesNotMatch(content, /完整资源\/UI\/实现信号见 Diff 详情/);
  assert.doesNotMatch(content, /意图判断/);
  assert.doesNotMatch(content, /M7 0\.583984/);
  assert.doesNotMatch(content, /absolute bottom-2/);
  assert.doesNotMatch(content, /disabled:pointer-events-none/);
});

test("minified code fragments are folded into intent signals instead of readable copy", () => {
  const oldFeatures = {
    assetHash: "old-assets",
    assetContents: {
      "8625.js": {
        path: "/_next/static/chunks/8625.js",
        contentHash: "old",
        strings: [
          "stable shared copy for diff matching",
          "),n}}},provides:function(n){n.generateAbstractMask=function(n){var t,a,e,i,o,s,f,c,l=n.children,u=n.attributes,m=n.main,d=n.mask,b=n.maskId,p=n.transform,v=m.width,g=m.icon",
          ")&&e.USE_PROFILES,eA=!1!==e.ALLOW_ARIA_ATTR,ex=!1!==e.ALLOW_DATA_ATTR,eS=e.ALLOW_UNKNOWN_PROTOCOLS||!1,eC=!1!==e.ALLOW_SELF_CLOSE_IN_ATTR,eP=e.SAFE_FOR_TEMPLATES||!1",
          "!==e.toLowerCase(),R=e=>!!(e&&(z(e.vault)||z(e.vaultFactory))),H=e=>e.tax?",
          ",X(t.change))})]})})(),t.showTaxInfo&&o&&(0,r.jsxs)(",
          ",label:V(t.dividendBps,Z(e.dividendBadge,",
          "{swapOpacity:undefined}",
        ],
      },
    },
  };
  const newFeatures = {
    assetHash: "new-assets",
    assetContents: {
      "8625.js": {
        path: "/_next/static/chunks/8625.js",
        contentHash: "new",
        strings: [
          "stable shared copy for diff matching",
          "),n}}},provides:function(n){n.generateAbstractMask=function(n){var t,a,e,i,o,s,f,c,l=n.children,u=n.attributes,m=n.main,d=n.mask,p=n.maskId,b=n.transform,v=m.width,g=m.icon",
          ")&&e.USE_PROFILES,eA=!1!==e.ALLOW_ARIA_ATTR,ex=!1!==e.ALLOW_DATA_ATTR,eS=e.ALLOW_UNKNOWN_PROTOCOLS||!1,eP=!1!==e.ALLOW_SELF_CLOSE_IN_ATTR,eC=e.SAFE_FOR_TEMPLATES||!1",
          "!==e.toLowerCase(),H=e=>!!(e&&(V(e.vault)||V(e.vaultFactory))),R=e=>e.tax?",
          ",Q(t.change))})]})})(),t.showTaxInfo&&o&&(0,r.jsxs)(",
          ",label:z(t.dividendBps,Z(e.dividendBadge,",
          "{swapOpacity:!1}",
          "you can still view its tax info while indexing.",
        ],
      },
    },
  };

  const { changes, meta } = __testables.diffFeatures(oldFeatures, newFeatures);
  const content = __testables.buildCardBriefing(
    "https://flap.sh/create",
    null,
    meta.assetStats,
    0,
    0,
    [],
    [],
    [],
  );
  const payload = JSON.stringify({ changes, meta, content });

  assert.equal(meta.assetStats.jsTextDiffs.length, 1);
  assert.equal(meta.assetStats.jsTextDiffs[0].text, "you can still view its tax info while indexing.");
  assert(meta.assetStats.codeIntentDiffs.length > 0);
  assert.deepEqual(meta.assetStats.configDiffs.filter(d => d.field === "swapOpacity"), []);
  assert.doesNotMatch(content, /实现意图信号/);
  assert.doesNotMatch(content, /税费\/税务信息|Vault\/金库判定|分红参数|安全\/富文本白名单/);
  assert.match(content, /you can still view its tax info while indexing\./);
  assert.doesNotMatch(payload, /generateAbstractMask/);
  assert.doesNotMatch(content, /USE_PROFILES|showTaxInfo&&o|dividendBps,Z|!==e\.toLowerCase|generateAbstractMask/);
  assert.doesNotMatch(content, /swapOpacity/);
});

test("structured shared resource diffs coalesce even when semantic page routes differ", () => {
  const configDiffs = [
    { field: "dividendBps", oldVal: "100", newVal: "200", file: "8625-3a0e67b3310b1e9a.js" },
  ];
  const jsTextDiffs = [
    { type: "added", text: "you can still view its tax info while indexing.", file: "8625-3a0e67b3310b1e9a.js" },
  ];
  const makeNotification = (url, route, key) => {
    const paths = [
      "/_next/static/chunks/8625-3a0e67b3310b1e9a.js",
      `/_next/static/chunks/app/${route}/page-${key}.js`,
    ];
    return {
      url,
      title: "Flap 页面变更",
      template: "red",
      changes: ["📦 前端资源变更：修改 2", "🔧 配置参数变更：1"],
      meta: {
        assetStats: {
          unchanged: 20,
          renamed: 0,
          modified: 2,
          added: 0,
          removed: 0,
          noiseFiles: 0,
          noiseCount: 0,
          substantiveFiles: 2,
          substantiveCount: 2,
          substantiveFileNames: ["8625-3a0e67b3310b1e9a.js", `page-${key}.js`],
          substantiveAssetPaths: paths,
          semanticProfile: __testables.buildAssetSemanticProfile(paths, { configDiffs, jsTextDiffs, vaultDiffs: [] }),
          configDiffs,
          vaultDiffs: [],
          jsTextDiffs,
        },
        textChangeCount: 0,
        textChanges: [],
        i18nChangeCount: 0,
        i18nDiffs: [],
        caStoreVaultDiffs: [],
      },
      snapshotUpdate: { key, features: {} },
    };
  };

  const grouped = __testables.coalesceFlapNotifications([
    makeNotification("https://flap.sh/bnb/CAstore", "[chain]/CAstore", "castore"),
    makeNotification("https://flap.sh/launch", "launch", "launch"),
    makeNotification("https://flap.sh/create", "create", "create"),
  ]);

  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].title, "Flap 全站前端资源变更");
  assert.equal(grouped[0].url, "https://flap.sh");
  assert.equal(grouped[0].snapshotUpdates.length, 3);
});

test("same Flap business change coalesces even when page chunks and UI impact differ", () => {
  const jsTextDiffs = [
    { type: "added", text: ", you can still view its fee info while indexing.", file: "page-placeholder.js" },
    { type: "removed", text: "DiamondPulse Tail-Cut Vault", file: "page-placeholder.js" },
  ];
  const codeIntentDiffs = [
    { type: "added", key: "dividend", label: "分红参数", intent: "可能调整 dividendBps、分红徽标或分红展示逻辑", evidence: "dividendBps / dividendBadge", file: "main-app-c72dc75351f84185.js" },
    { type: "added", key: "dividend", label: "分红参数", intent: "可能调整 dividendBps、分红徽标或分红展示逻辑", evidence: "dividendBps / dividendBadge", file: "main-app-c72dc75351f84185.js" },
    { type: "removed", key: "dividend", label: "分红参数", intent: "可能调整 dividendBps、分红徽标或分红展示逻辑", evidence: "dividendBps / dividendBadge", file: "main-app-4a134b52bf8b81e0.js" },
    { type: "removed", key: "dividend", label: "分红参数", intent: "可能调整 dividendBps、分红徽标或分红展示逻辑", evidence: "dividendBps / dividendBadge", file: "main-app-4a134b52bf8b81e0.js" },
  ];
  const makeUiDiffs = (count, files) => Array.from({ length: count }, (_, i) => ({
    type: i % 2 ? "removed" : "added",
    category: "layout",
    label: "布局定位",
    intent: "调整组件位置、对齐或层级",
    evidence: "absolute / top / right / bottom / translate",
    contextKey: i >= 2 ? "wallet-connect" : "unknown",
    contextLabel: i >= 2 ? "钱包连接控件" : "未定位具体组件",
    contextConfidence: i >= 2 ? "高" : "低",
    file: files[i % files.length],
  }));
  const makeNotification = ({ url, key, pageRoute, pageFile, uiCount, uiFiles }) => {
    const assetPaths = [
      "/_next/static/chunks/3092-8887ce94f4aa5d3e.js",
      "/_next/static/chunks/5437-ad8495d6a7676030.js",
      `/_next/static/chunks/app/${pageRoute}/${pageFile}`,
      "/_next/static/css/2dfb716651435e0a.css",
      "/_next/static/chunks/main-app-4a134b52bf8b81e0.js",
      "/_next/static/chunks/webpack-597e0b49301a2e1a.js",
    ];
    const pageJsTextDiffs = jsTextDiffs.map(d => ({ ...d, file: pageFile }));
    const uiStyleDiffs = makeUiDiffs(uiCount, uiFiles);
    const assetStats = {
      unchanged: 28,
      renamed: 1,
      modified: 8,
      added: 0,
      removed: 0,
      noiseFiles: 2,
      noiseCount: 6,
      substantiveFiles: 6,
      substantiveCount: 8,
      substantiveFileNames: ["3092-8887ce94f4aa5d3e.js", "5437-ad8495d6a7676030.js", pageFile, "2dfb716651435e0a.css", "main-app-4a134b52bf8b81e0.js", "webpack-597e0b49301a2e1a.js"],
      substantiveAssetPaths: assetPaths,
      semanticProfile: __testables.buildAssetSemanticProfile(assetPaths, { configDiffs: [], vaultDiffs: [], jsTextDiffs: pageJsTextDiffs, uiStyleDiffs, codeIntentDiffs }),
      configDiffs: [],
      vaultDiffs: [],
      jsTextDiffs: pageJsTextDiffs,
      uiStyleDiffs,
      codeIntentDiffs,
    };
    return {
      url,
      title: "Flap 页面变更",
      template: "red",
      changes: ["📦 前端资源变更：修改 8 | 重命名 1"],
      meta: {
        assetStats,
        textChangeCount: 0,
        textChanges: [],
        i18nChangeCount: 0,
        i18nDiffs: [],
        caStoreVaultDiffs: [],
      },
      snapshotUpdate: { key, features: {} },
    };
  };

  const grouped = __testables.coalesceFlapNotifications([
    makeNotification({ url: "https://flap.sh/create", key: "create", pageRoute: "create", pageFile: "page-62ecac793de5f41d.js", uiCount: 2, uiFiles: ["407-7088d032298ec180.js", "4643-7d9eda7b083f9d52.js"] }),
    makeNotification({ url: "https://flap.sh/bnb/CAstore", key: "castore", pageRoute: "[chain]/CAstore", pageFile: "page-50dce0de0e0c111a.js", uiCount: 8, uiFiles: ["6055-d674eedd435ff478.js", "1946-b696c7945cec7add.js", "407-7088d032298ec180.js", "4643-7d9eda7b083f9d52.js"] }),
    makeNotification({ url: "https://flap.sh/launch", key: "launch", pageRoute: "launch", pageFile: "page-d53a27e3a7a1ff1e.js", uiCount: 2, uiFiles: ["407-7088d032298ec180.js", "4643-7d9eda7b083f9d52.js"] }),
  ]);

  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].title, "Flap 全站前端资源变更");
  assert.equal(grouped[0].url, "https://flap.sh");
  assert.equal(grouped[0].snapshotUpdates.length, 3);
  assert.equal((grouped[0].content.match(/https:\/\/flap\.sh\/create/g) || []).length, 1);
  assert.equal((grouped[0].content.match(/https:\/\/flap\.sh\/bnb\/CAstore/g) || []).length, 1);
  assert.equal((grouped[0].content.match(/https:\/\/flap\.sh\/launch/g) || []).length, 1);
  assert.match(grouped[0].content, /\*\*资源统计\*\*[\s\S]*不变 28 \/ 重命名 1 \/ 修改 8 \/ 新增 0 \/ 移除 0/);
  assert.doesNotMatch(grouped[0].content, /实现意图信号/);
  assert.doesNotMatch(grouped[0].content, /UI\/样式信号/);
  assert.match(grouped[0].content, /DiamondPulse Tail-Cut Vault/);
  assert.match(grouped[0].content, /you can still view its fee info while indexing/);
  assert.doesNotMatch(grouped[0].content, /钱包连接控件/);
  assert.doesNotMatch(grouped[0].title, /重点变更/);
});

test("shared minified implementation signals are coalesced without raw code in the card", () => {
  const codeIntentDiffs = [
    { type: "removed", key: "tax", label: "税费/税务信息", intent: "可能调整税费读取、税务信息展示或索引期查看逻辑", evidence: "showTaxInfo / taxInfo / tax", file: "8625-old.js" },
    { type: "added", key: "tax", label: "税费/税务信息", intent: "可能调整税费读取、税务信息展示或索引期查看逻辑", evidence: "showTaxInfo / taxInfo / tax", file: "8625-new.js" },
    { type: "added", key: "dividend", label: "分红参数", intent: "可能调整 dividendBps、分红徽标或分红展示逻辑", evidence: "dividendBps / dividendBadge", file: "8625-new.js" },
  ];
  const makeNotification = (url, key) => ({
    url,
    title: "Flap 页面变更",
    template: "red",
    changes: [
      "📦 前端资源变更：修改 1",
      "📝 8625-old.js → 8625-new.js (3 处实质变更)",
      "  · 3 处不可读实现片段已折叠到 Diff 详情",
    ],
    meta: {
      assetStats: {
        unchanged: 20,
        renamed: 1,
        modified: 1,
        added: 0,
        removed: 0,
        noiseFiles: 1,
        noiseCount: 3,
        substantiveFiles: 0,
        substantiveCount: 0,
        substantiveFileNames: ["8625-new.js"],
        substantiveAssetPaths: ["/_next/static/chunks/8625-new.js"],
        configDiffs: [],
        vaultDiffs: [],
        jsTextDiffs: [],
        uiStyleDiffs: [],
        codeIntentDiffs,
      },
      textChangeCount: 0,
      textChanges: [],
      i18nChangeCount: 0,
      i18nDiffs: [],
      caStoreVaultDiffs: [],
    },
    snapshotUpdate: { key, features: {} },
  });

  const grouped = __testables.coalesceFlapNotifications([
    makeNotification("https://flap.sh/bnb/CAstore", "castore"),
    makeNotification("https://flap.sh/launch", "launch"),
    makeNotification("https://flap.sh/create", "create"),
  ]);

  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].title, "Flap 全站前端资源变更");
  assert.equal(grouped[0].url, "https://flap.sh");
  assert.doesNotMatch(grouped[0].content, /实现意图信号/);
  assert.doesNotMatch(grouped[0].content, /税费\/税务信息/);
  assert.doesNotMatch(grouped[0].content, /分红参数/);
  assert.match(grouped[0].content, /\*\*资源统计\*\*[\s\S]*修改 1/);
  assert.doesNotMatch(grouped[0].content, /完整资源\/UI\/实现信号见 Diff 详情/);
  assert.doesNotMatch(grouped[0].content, /showTaxInfo&&o|dividendBps,Z|function\(|generateAbstractMask/);
  assert.equal(grouped[0].snapshotUpdates.length, 3);
});

test("shared UI style signals coalesce into one explanatory site-wide notification", () => {
  const uiStyleDiffs = [
    { type: "added", category: "disabled", label: "禁用态交互", intent: "调整禁用状态下的点击或交互反馈", evidence: "disabled / pointer-events", contextKey: "wallet-connect", contextLabel: "钱包连接控件", contextConfidence: "高", file: "8625-3a0e67b3310b1e9a.js" },
    { type: "added", category: "interaction", label: "交互反馈", intent: "调整 hover/focus/active 或过渡反馈", evidence: "hover / focus / transition / ring", contextKey: "navigation-menu", contextLabel: "顶部导航/下拉菜单", contextConfidence: "高", file: "8625-3a0e67b3310b1e9a.js" },
  ];
  const makeNotification = (url, key) => ({
    url,
    title: "Flap 页面变更",
    template: "red",
    changes: ["📦 前端资源变更：修改 1"],
    meta: {
      assetStats: {
        unchanged: 20,
        renamed: 0,
        modified: 1,
        added: 0,
        removed: 0,
        noiseFiles: 1,
        noiseCount: 2,
        substantiveFiles: 0,
        substantiveCount: 0,
        substantiveFileNames: [],
        substantiveAssetPaths: [],
        configDiffs: [],
        vaultDiffs: [],
        jsTextDiffs: [],
        uiStyleDiffs,
      },
      textChangeCount: 0,
      textChanges: [],
      i18nChangeCount: 0,
      i18nDiffs: [],
      caStoreVaultDiffs: [],
    },
    snapshotUpdate: { key, features: {} },
  });

  const grouped = __testables.coalesceFlapNotifications([
    makeNotification("https://flap.sh/launch", "launch"),
    makeNotification("https://flap.sh/create", "create"),
  ]);

  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].title, "Flap 全站前端资源变更");
  assert.doesNotMatch(grouped[0].content, /UI\/样式信号/);
  assert.doesNotMatch(grouped[0].content, /禁用态交互|钱包连接控件|顶部导航\/下拉菜单/);
  assert.match(grouped[0].content, /\*\*资源统计\*\*[\s\S]*修改 1/);
  assert.doesNotMatch(grouped[0].content, /完整资源\/UI\/实现信号见 Diff 详情/);
  assert.equal(grouped[0].snapshotUpdates.length, 2);
});

test("Flap UI style context inference maps real Tailwind patterns to concrete components", () => {
  const cases = [
    {
      text: "group-hover/nav-dropdown:visible group-focus-within/nav-dropdown:opacity-100",
      context: "顶部导航/下拉菜单",
    },
    {
      text: "ui20-connect-chamfer [--ui20-chamfer-bg:#000000] hover:[--ui20-chamfer-bg:#D0FF00]",
      context: "钱包连接控件",
    },
    {
      text: "peer-disabled:cursor-not-allowed peer-disabled:opacity-70 text-[12px] font-medium",
      context: "代币创建表单控件",
    },
    {
      text: "[&_[data-radix-scroll-area-viewport]>div]:!block [&_[data-radix-scroll-area-viewport]>div]:!min-w-0",
      context: "弹窗/下拉层/滚动区",
    },
  ];

  for (const item of cases) {
    assert.equal(__testables.inferUiComponentContext(item.text).label, item.context);
  }

  assert.equal(
    __testables.inferUiComponentContext("rounded-[4px] border object-cover", "page-59769a4a66f32125.js", "/_next/static/chunks/app/[chain]/CAstore/page-59769a4a66f32125.js").label,
    "CAstore 金库卡片/模板列表",
  );
});

test("CAstore Chinese vault headings are extracted as structured vault sections", () => {
  const html = `
    <main>
      <h2>热门金库</h2>
      <h3>禮物稅收金庫</h3>
      <p>指定一個 X 帳戶作為禮物擁有者，可以將交易費用分配給任何 EVM 地址。</p>
      <a href="/launch?vaultfactory=0x08E41a61C5D25420E3cb314Bc513EC99B2841003">Open</a>
      <h3>LP质押分红金库</h3>
      <p>将你的 LP 代币质押进金库，获得 BNB 分红奖励。</p>
      <h3>黑洞排行榜燃烧分红金库</h3>
      <p>税收分为两个池：燃烧分红池按燃烧价值权重分配给用户。</p>
    </main>
  `;

  const features = __testables.extractPageFeatures(html);

  assert.deepEqual(features.caStoreVaults.map(v => v.name), [
    "禮物稅收金庫",
    "LP质押分红金库",
    "黑洞排行榜燃烧分红金库",
  ]);
  assert.equal(features.caStoreVaults[0].area, "热门金库");
  assert.equal(features.caStoreVaults[0].factory, "0x08E41a61C5D25420E3cb314Bc513EC99B2841003");
  assert.match(features.caStoreVaults[1].description, /LP 代币质押进金库/);
});

test("Robinhood CAstore extracts IndexVault without treating the unlisted template heading as a vault", () => {
  const html = `
    <main>
      <h2>热门金库</h2>
      <h3>未上架的税收模板</h3>
      <p>输入任何税收金库模板合约地址来使用。</p>
      <h3>币股</h3>
      <img alt="IndexVault" src="/stocks-vault-logo.svg">
      <p>税收 ETH 会预留给代币化股票资产购买。Keeper 向金库出售受支持的 RWA 资产，持有人可以领取 RWA 分红。</p>
    </main>
  `;

  const features = __testables.extractPageFeatures(html, {
    url: "https://flap.sh/robinhood/CAstore?lang=zh",
  });

  assert.deepEqual(features.caStoreVaults.map(v => v.name), ["币股"]);
  assert.equal(features.caStoreVaults[0].area, "热门金库");
  assert.equal(features.caStoreVaults[0].chain, "robinhood");
  assert.equal(features.caStoreVaults[0].sourceUrl, "https://flap.sh/robinhood/CAstore?lang=zh");
  assert.equal(features.caStoreVaults[0].factory, "0xe6ca297D1d963b6F00d5b216986123CAeB883AF6");
  assert.match(features.caStoreVaults[0].description, /持有人可以领取 RWA 分红/);
});

test("Robinhood CAstore card uses the complete chain-specific vault link", () => {
  const notification = __testables.buildCaStoreVaultChangeNotification({
    type: "added",
    area: "热门金库",
    name: "币股",
    newDescription: "持有人可以领取 RWA 分红。",
    factory: "0xe6ca297D1d963b6F00d5b216986123CAeB883AF6",
    chain: "robinhood",
    sourceUrl: "https://flap.sh/robinhood/CAstore?lang=zh",
  }, {});

  const expected = "https://flap.sh/launch?vaultfactory=0xe6ca297D1d963b6F00d5b216986123CAeB883AF6&chain=robinhood&lang=zh";
  assert.equal(notification.title, "Robinhood CAstore 金库变更：币股");
  assert.equal(notification.launchUrl, expected);
  assert.equal(notification.url, expected);
  assert.match(notification.content, new RegExp(expected.replace(/[?&]/g, "\\$&")));
});

test("CAstore vault change notification is simple, linked, AI-ready and suppresses duplicate page card", () => {
  const diff = {
    type: "added",
    area: "热门金库",
    name: "禮物稅收金庫",
    newDescription: "指定一個 X 帳戶作為禮物擁有者，可以將交易費用分配給任何 EVM 地址。",
    factory: "0x08E41a61C5D25420E3cb314Bc513EC99B2841003",
  };
  const notification = __testables.buildCaStoreVaultChangeNotification(diff, {});

  assert.equal(notification.title, "CAstore 金库变更：禮物稅收金庫");
  assert.match(notification.content, /金库:/);
  assert.match(notification.content, /禮物稅收金庫/);
  assert.match(notification.content, /指定一個 X 帳戶/);
  assert.match(notification.content, /<font color="green">新增金库<\/font>/);
  assert.equal(notification.launchUrl, "https://flap.sh/launch?vaultfactory=0x08E41a61C5D25420E3cb314Bc513EC99B2841003");
  assert.match(notification.content, /金库链接: \[打开金库\]\(https:\/\/flap\.sh\/launch\?vaultfactory=0x08E41a61C5D25420E3cb314Bc513EC99B2841003\)/);
  assert.match(notification.content, /AI 分析异步生成中/);
  assert.match(notification.aiInput, /金库名字: 禮物稅收金庫/);

  const pageNotification = {
    changes: ["🏦 CAstore 金库内容变更：", "  🟢 新增金库: 热门金库 / 禮物稅收金庫"],
    meta: {
      assetStats: null,
      textChangeCount: 0,
      i18nChangeCount: 0,
      caStoreVaultDiffs: [diff],
    },
  };
  assert.equal(__testables.getStandaloneCaStoreVaultDiffs(pageNotification).length, 1);
  assert.equal(__testables.shouldSuppressCaStoreOnlyPageNotification(pageNotification), true);
});

test("standalone CAstore vault card can be omitted from mixed page card", () => {
  const notification = {
    url: "https://flap.sh/bnb/CAstore",
    changes: [
      "🏦 CAstore 金库内容变更：",
      "  🔴 移除金库: Hot Vaults / Perpetual Short Vault",
      "✏️ 文案修改：",
    ],
    meta: {
      assetStats: null,
      textChangeCount: 1,
      textChanges: [{ type: "removed", text: "Perpetual Short Vault" }],
      i18nChangeCount: 0,
      i18nDiffs: [],
      caStoreVaultDiffs: [{ type: "removed", area: "Hot Vaults", name: "Perpetual Short Vault" }],
      fullDiffLines: ["🏦 CAstore 金库内容变更：", "✏️ 页面文案完整 Diff"],
    },
  };

  const stripped = __testables.omitStandaloneCaStoreVaultDiffs(notification);

  assert.equal(stripped.meta.caStoreVaultDiffs.length, 0);
  assert(stripped.changes.every(line => !line.includes("CAstore 金库")));
  assert.equal(stripped.meta.textChanges.length, 1);
  assert.equal(__testables.shouldSuppressCaStoreOnlyPageNotification(notification), false);
});

test("asset string extraction keeps business strings beyond the ordinary cap", () => {
  const ordinaryStrings = Array.from({ length: 260 }, (_, i) => `"ordinary string ${String(i).padStart(3, "0")} with enough words"`);
  const businessString = `"新增金库费率配置 New Vault fee rate affects CAstore templates"`;
  const content = `${ordinaryStrings.join(";")};${businessString};`;

  const strings = __testables.extractStrings(content, "js");

  assert(strings.length <= __testables.CONFIG.assetStringLimit);
  assert(strings.some(s => s.includes("新增金库费率配置")));
});

test("round asset cache reuses shared chunks across pages", async () => {
  const roundAssetCache = new Map();
  let fetchCount = 0;
  const fetchAsset = async (url) => {
    fetchCount++;
    return { ok: true, text: async () => `const label = "asset ${url} business words";` };
  };

  const [first, second] = await Promise.all([
    __testables.downloadAssetContents(
      ["/_next/static/chunks/8101-a.js", "/_next/static/chunks/webpack-a.js"],
      "https://flap.sh",
      { roundAssetCache, fetchAsset },
    ),
    __testables.downloadAssetContents(
      ["/_next/static/chunks/8101-a.js", "/_next/static/chunks/app/launch/page-a.js"],
      "https://flap.sh",
      { roundAssetCache, fetchAsset },
    ),
  ]);

  assert.equal(fetchCount, 3);
  assert.equal(first["8101-a.js"].contentHash, second["8101-a.js"].contentHash);
});

test("asset download plan reuses unchanged assets and fetches only new paths", () => {
  const oldFeatures = {
    assetFiles: ["/_next/static/chunks/webpack-a.js", "/_next/static/chunks/8101-a.js"],
    assetContents: {
      "webpack-a.js": { filename: "webpack-a.js", path: "/_next/static/chunks/webpack-a.js", contentHash: "runtime" },
      "8101-a.js": { filename: "8101-a.js", path: "/_next/static/chunks/8101-a.js", contentHash: "shared" },
    },
  };
  const newFeatures = {
    assetFiles: ["/_next/static/chunks/webpack-a.js", "/_next/static/chunks/app/launch/page-b.js"],
  };

  const plan = __testables.planAssetContentDownload(oldFeatures, newFeatures);

  assert.deepEqual(plan.reuseFilenames, ["webpack-a.js"]);
  assert.deepEqual(plan.toDownload, ["/_next/static/chunks/app/launch/page-b.js"]);
  assert.equal(plan.reusedContents["webpack-a.js"].contentHash, "runtime");
});

test("asset semantic profile classifies page chunks and shared runtime chunks", () => {
  const profile = __testables.buildAssetSemanticProfile([
    "/_next/static/chunks/webpack-167217394b1418fd.js",
    "/_next/static/chunks/8101-706af7c3a9ce2627.js",
    "/_next/static/chunks/app/launch/page-58c52ba25a5f0aae.js",
    "/_next/static/chunks/app/layout-dc8bafd06bb8b592.js",
  ]);

  assert(profile.runtime.some(item => item.file.includes("webpack-167217394b1418fd.js")));
  assert(profile.shared.some(item => item.file.includes("8101-706af7c3a9ce2627.js")));
  assert.deepEqual(profile.pageRoutes, ["launch"]);
  assert(profile.appShell.some(item => item.kind === "layout"));
});

test("page-specific chunk changes remain page-level notifications", () => {
  const notifications = [
    {
      url: "https://flap.sh/launch",
      title: "Flap 页面变更",
      template: "red",
      changes: ["📦 前端资源变更： 修改 1"],
      meta: {
        assetStats: {
          unchanged: 28,
          modified: 1,
          substantiveFileNames: ["page-58c52ba25a5f0aae.js"],
          substantiveAssetPaths: ["/_next/static/chunks/app/launch/page-58c52ba25a5f0aae.js"],
          semanticProfile: __testables.buildAssetSemanticProfile(["/_next/static/chunks/app/launch/page-58c52ba25a5f0aae.js"]),
          configDiffs: [],
          vaultDiffs: [],
          jsTextDiffs: [],
        },
        textChangeCount: 0,
        textChanges: [],
        i18nChangeCount: 0,
        i18nDiffs: [],
        caStoreVaultDiffs: [],
      },
      snapshotUpdate: { key: "launch", features: {} },
    },
    {
      url: "https://flap.sh/create",
      title: "Flap 页面变更",
      template: "red",
      changes: ["📦 前端资源变更： 修改 1"],
      meta: {
        assetStats: {
          unchanged: 28,
          modified: 1,
          substantiveFileNames: ["page-314a5953cbeca095.js"],
          substantiveAssetPaths: ["/_next/static/chunks/app/create/page-314a5953cbeca095.js"],
          semanticProfile: __testables.buildAssetSemanticProfile(["/_next/static/chunks/app/create/page-314a5953cbeca095.js"]),
          configDiffs: [],
          vaultDiffs: [],
          jsTextDiffs: [],
        },
        textChangeCount: 0,
        textChanges: [],
        i18nChangeCount: 0,
        i18nDiffs: [],
        caStoreVaultDiffs: [],
      },
      snapshotUpdate: { key: "create", features: {} },
    },
  ];

  const grouped = __testables.coalesceFlapNotifications(notifications);

  assert.equal(grouped.length, 2);
  assert.equal(grouped[0].url, "https://flap.sh/launch");
  assert.equal(grouped[1].url, "https://flap.sh/create");
});

test("manual Flap check can reuse the same notification coalescing path", () => {
  const notifications = [
    {
      url: "https://flap.sh/bnb/CAstore",
      title: "手动检测 — 页面变更",
      template: "red",
      changes: ["📦 前端资源变更： 不变 28 | 修改 2"],
      meta: {
        assetStats: { unchanged: 28, renamed: 0, modified: 2, added: 0, removed: 0, noiseFiles: 0, noiseCount: 0, substantiveFiles: 1, substantiveCount: 1, substantiveFileNames: ["webpack-3790dbebac76c2a6.js"] },
        textChangeCount: 0,
        textChanges: [],
        i18nChangeCount: 0,
        i18nDiffs: [],
        caStoreVaultDiffs: [],
      },
      snapshotUpdate: { key: "castore", features: { marker: "castore" } },
    },
    {
      url: "https://flap.sh/launch",
      title: "手动检测 — 页面变更",
      template: "red",
      changes: ["📦 前端资源变更： 不变 20 | 修改 2"],
      meta: {
        assetStats: { unchanged: 20, renamed: 0, modified: 2, added: 0, removed: 0, noiseFiles: 0, noiseCount: 0, substantiveFiles: 1, substantiveCount: 1, substantiveFileNames: ["webpack-3790dbebac76c2a6.js"] },
        textChangeCount: 0,
        textChanges: [],
        i18nChangeCount: 0,
        i18nDiffs: [],
        caStoreVaultDiffs: [],
      },
      snapshotUpdate: { key: "launch", features: { marker: "launch" } },
    },
  ];

  const grouped = __testables.coalesceFlapNotifications(notifications, { titlePrefix: "手动检测 — " });

  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].title, "手动检测 — Flap 全站前端资源变更");
});

test("business priority title can preserve manual check source prefix", () => {
  const notification = {
    title: "手动检测 — 页面变更",
    template: "red",
    changes: ["🏦 CAstore 金库内容变更：", "  🟢 新增金库: Gift Vault"],
  };

  __testables.applyBusinessPriorityTitle(notification, { titlePrefix: "手动检测 — " });

  assert.equal(notification.title, "手动检测 — ⚡ 重点变更：金库/Vault");
  assert.equal(notification.template, "red");
});

test("page change card puts concrete page link and important copy before ai analysis", () => {
  const longOldText = "旧手续费 " + "旧配置说明 ".repeat(40).trim();
  const longNewText = "新手续费 " + "新配置说明 ".repeat(40).trim();
  const content = __testables.buildCardBriefing(
    "https://flap.sh/bnb/CAstore",
    null,
    {
      unchanged: 28,
      renamed: 0,
      modified: 2,
      added: 0,
      removed: 0,
      noiseFiles: 1,
      noiseCount: 4,
      substantiveFiles: 1,
      substantiveCount: 2,
      substantiveFileNames: ["vault-page.js"],
      configDiffs: [{ field: "feeRate", oldVal: "1", newVal: "2", file: "vault-page.js" }],
      vaultDiffs: [],
      jsTextDiffs: [{ type: "added", text: "New Vault fee rate enabled", file: "vault-page.js" }],
    },
    1,
    1,
    [{ type: "added", key: "castore.giftVault", value: "禮物稅收金庫" }],
    [{ type: "modified", oldText: longOldText, newText: longNewText, ctxBefore: "CAstore" }],
    [{ type: "added", area: "热门金库", name: "禮物稅收金庫", newDescription: "指定账户收取礼物税收" }],
  );

  assert(content.startsWith("**🌐 影响页面**"));
  assert.match(content, /- 页面: \[\/bnb\/CAstore\]\(https:\/\/flap\.sh\/bnb\/CAstore\)/);
  assert(content.indexOf("**🎯 重点变更**") < content.indexOf("**🤖 AI 分析**"));
  assert.match(content, /\*\*资源统计\*\*[\s\S]*不变 28 \/ 重命名 0 \/ 修改 2 \/ 新增 0 \/ 移除 0/);
  assert.doesNotMatch(content, /结论摘要|证据详情|打开页面|卡片仅展示|完整旧\/新文本/);
  assert.doesNotMatch(content, /- 概览: 修改/);
  assert.doesNotMatch(content, /建议动作/);
  assert.match(content, /- 原：<font color="red">旧手续费 旧配置说明/);
  assert.match(content, /  新：<font color="green">新手续费 新配置说明/);
  assert.match(content, /旧配置说明 旧配置说明 旧配置说明/);
  assert.match(content, /新配置说明 新配置说明 新配置说明/);
  assert.doesNotMatch(content, /\.\.\.|…/);
  assert.match(content, /AI 分析异步生成中，变更已先推送/);
});

test("launch text card summarizes anti-farmer duration changes and keeps full source copy", () => {
  const cssNoise = `span:first-child]:h-1 [&>span:first-child]:rounded-none [&[role=slider]]:h-3 style="--radix-slider-thumb-transform:translateX(-50%)"`;
  const addedDescription = "This feature ensures that trades occur primarily in the tax liquidity pool during the protection period, improving the stability of token tax revenue.";
  const content = __testables.buildCardBriefing(
    "https://flap.sh/launch",
    null,
    null,
    8,
    0,
    [],
    [
      {
        type: "modified",
        oldText: `Payment token * BNB USDT USD1 ASTER U 币安人生 Token Setting Buy Tax Rate ${cssNoise} Anti-Farmer Protection Duration 3 day(s) During the anti-farmer protection period, users will not be able to add liquidity to some V3 pools. Set 0 days to disable the protection period. Min: 0 days · Max: 1 year (365 days) · Default: 3 days Tax Allocation Total allocation must be 100%`,
        newText: `Payment token * BNB USDT USD1 ASTER U 币安人生 Token Setting Buy Tax Rate ${cssNoise} Anti-Farmer Protection Duration 30 day(s) During the anti-farmer protection period, users will not be able to add liquidity to some V3 pools. ${addedDescription} Set 0 days to disable the protection period. Min: 0 days · Max: 1 year (365 days) · Default: 30 days Tax Allocation Total allocation must be 100%`,
        ctxBefore: "Create Tax Token Create Token Reserve Your Token CA",
      },
      {
        type: "added",
        text: addedDescription,
        ctxBefore: "During the anti-farmer protection period, users will not be able to add liquidity to some V3 pools.",
      },
    ],
    [],
  );

  assert.match(content, /页面文案变更（归纳 \+ 完整原文，共 2 处）/);
  assert.match(content, /防巨鲸薅币保护周期（Anti-Farmer Protection Duration）/);
  assert.match(content, /默认时长/);
  assert.match(content, /<font color="red">3 天<\/font> → <font color="green">30 天<\/font>/);
  assert.match(content, /取值区间：最小值 0 天 \/ 最大值 365 天（1 年），区间规则未改动/);
  assert.match(content, /新增说明/);
  assert.match(content, /开关提示未改/);
  assert.match(content, /radix-slider/);
  assert.match(content, /Payment token \* BNB/);
  assert.match(content, new RegExp(addedDescription.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("site-wide asset card keeps only page scope resource stats and ai", () => {
  const notification = __testables.buildSiteWideAssetNotification([
    {
      url: "https://flap.sh/bnb/CAstore",
      changes: ["📦 前端资源变更： 不变 28 | 修改 2", "🔇 构建噪音： 1 文件 4 处 (webpack.js)"],
      meta: {
        assetStats: { unchanged: 28, renamed: 0, modified: 2, added: 0, removed: 0, noiseFiles: 1, noiseCount: 4, substantiveFiles: 1, substantiveCount: 2, substantiveFileNames: ["webpack.js"] },
      },
      snapshotUpdate: { key: "castore", features: {} },
    },
  ]);

  assert(notification.content.startsWith("**🌐 影响页面**"));
  assert(notification.content.indexOf("**🌐 影响页面**") < notification.content.indexOf("**资源统计**"));
  assert(notification.content.indexOf("**资源统计**") < notification.content.indexOf("**🤖 AI 分析**"));
  assert.match(notification.content, /\[\/bnb\/CAstore\]\(https:\/\/flap\.sh\/bnb\/CAstore\)/);
  assert.match(notification.content, /不变 28 \/ 重命名 0 \/ 修改 2 \/ 新增 0 \/ 移除 0/);
  assert.doesNotMatch(notification.content, /结论摘要|证据详情|本地初筛|重点变更/);
  assert.doesNotMatch(notification.content, /完整资源 Diff/);
  assert.equal(notification.skipAi, false);
  assert.equal(notification.useFullDiffForAi, true);
});

test("site-wide asset-only notification is not promoted by negative business words", () => {
  const notification = __testables.buildSiteWideAssetNotification([
    {
      url: "https://flap.sh/bnb/CAstore",
      changes: ["📦 前端资源变更： 不变 28 | 修改 2"],
      meta: {
        assetStats: { unchanged: 28, renamed: 0, modified: 2, added: 0, removed: 0, noiseFiles: 0, noiseCount: 0, substantiveFiles: 1, substantiveCount: 2, substantiveFileNames: ["webpack-167217394b1418fd.js"] },
      },
      snapshotUpdate: { key: "castore", features: {} },
    },
  ]);

  assert.equal(notification.skipBusinessPriorityTitle, true);
  __testables.applyBusinessPriorityTitle(notification);

  assert.equal(notification.title, "Flap 全站前端资源变更");
  assert.equal(notification.template, "orange");
});

test("site-wide asset card summarizes runtime resources without raw webpack fragments", () => {
  const notification = __testables.buildSiteWideAssetNotification([
    {
      url: "https://flap.sh/bnb/CAstore",
      changes: [
        "📦 前端资源变更： 不变 28 | 修改 2",
        "📝 webpack-fcd3cb604bdd2e6d.js → webpack-167217394b1418fd.js (46 处实质变更 + 4 噪音已过滤)",
        "  - !=typeof trustedTypes&&trustedTypes.createPolicy&&(d=trustedTypes.createPolicy(",
        "  - ),t=0;t",
      ],
      meta: {
        assetStats: { unchanged: 28, renamed: 0, modified: 2, added: 0, removed: 0, noiseFiles: 0, noiseCount: 0, substantiveFiles: 2, substantiveCount: 46, substantiveFileNames: ["8101-706af7c3a9ce2627.js", "webpack-167217394b1418fd.js"] },
      },
      snapshotUpdate: { key: "castore", features: {} },
    },
    {
      url: "https://flap.sh/launch",
      changes: [
        "📦 前端资源变更： 不变 28 | 修改 2",
        "📝 webpack-fcd3cb604bdd2e6d.js → webpack-167217394b1418fd.js (46 处实质变更 + 4 噪音已过滤)",
        "  - !=typeof trustedTypes&&trustedTypes.createPolicy&&(d=trustedTypes.createPolicy(",
      ],
      meta: {
        assetStats: { unchanged: 28, renamed: 0, modified: 2, added: 0, removed: 0, noiseFiles: 0, noiseCount: 0, substantiveFiles: 2, substantiveCount: 46, substantiveFileNames: ["8101-706af7c3a9ce2627.js", "webpack-167217394b1418fd.js"] },
      },
      snapshotUpdate: { key: "launch", features: {} },
    },
  ]);

  assert.doesNotMatch(notification.content, /资源范围/);
  assert.doesNotMatch(notification.content, /runtime/);
  assert.doesNotMatch(notification.content, /共享 chunk/);
  assert.match(notification.content, /\*\*资源统计\*\*[\s\S]*修改 2/);
  assert.doesNotMatch(notification.content, /完整资源\/UI\/实现信号见 Diff 详情/);
  assert.doesNotMatch(notification.content, /trustedTypes|t=0;t/);
  assert.doesNotMatch(notification.content, /!=typeof/);
});

test("vault factory card summarizes counts before details", () => {
  const addedFactory = "0x0000000000000000000000000000000000000001";
  const modifiedFactory = "0x0000000000000000000000000000000000000002";
  const content = __testables.formatVaultFactoryChanges({
    added: [{ name: "Gift Vault", factory: addedFactory, showInCAStore: true, ai: false, enabled: true, constraints: { min: 1 } }],
    removed: [],
    modified: [{ name: "Old Vault", factory: modifiedFactory, diffs: ["enabled: true → false"] }],
  });

  assert(content.startsWith("- 新增 1 个 / 移除 0 个 / 修改 1 个"));
  assert.doesNotMatch(content, /结论摘要|证据详情/);
  assert(content.indexOf("新增 1") < content.indexOf("Gift Vault"));
  assert(content.indexOf("Gift Vault") < content.indexOf("Old Vault"));
  assert.match(content, /enabled：<font color="red">true<\/font> → <font color="green">false<\/font>/);
  assert.match(content, new RegExp(`https://flap\\.sh/launch\\?vaultfactory=${addedFactory}`));
  assert.match(content, new RegExp(`https://flap\\.sh/launch\\?vaultfactory=${modifiedFactory}`));
});

test("hidden new vault factory also includes its Flap launch link", () => {
  const factory = "0x0000000000000000000000000000000000000003";
  const content = __testables.formatVaultFactoryChanges({
    added: [{ name: "Hidden Vault", factory, showInCAStore: false, ai: false, enabled: true }],
    removed: [],
    modified: [],
  });
  assert.match(content, /新增隐藏金库工厂/);
  assert.match(content, new RegExp(`https://flap\\.sh/launch\\?vaultfactory=${factory}`));
});

test("round vault factory aggregation stabilizes conflicting page snapshots", () => {
  const factory = "0xD5f57C8FbFFE993ca7c73858DEBE18f79ff4a3F8";
  const entries = [
    {
      url: "https://flap.sh/bnb/CAstore",
      map: { [factory]: { name: "ShortOnlyVaultOracle", factory, enabled: true, showInCAStore: false, ai: false, constraints: null } },
    },
    {
      url: "https://flap.sh/launch",
      map: { [factory]: { name: "ShortOnlyVaultOracle", factory, enabled: true, showInCAStore: true, ai: false, constraints: null } },
    },
    {
      url: "https://flap.sh/create",
      map: { [factory]: { name: "ShortOnlyVaultOracle", factory, enabled: true, showInCAStore: false, ai: false, constraints: null } },
    },
  ];

  const { map, conflicts } = __testables.mergeRoundVaultFactoryMaps(entries);
  const diff = __testables.diffVaultFactories({
    [factory]: { name: "ShortOnlyVaultOracle", factory, enabled: true, showInCAStore: true, ai: false, constraints: null },
  }, map);

  assert.equal(map[factory].showInCAStore, false);
  assert(conflicts.some(c => c.field === "showInCAStore"));
  assert.equal(diff.modified.length, 1);
  assert.deepEqual(diff.modified[0].diffs, ["showInCAStore: true → false"]);
});

test("vault factory extraction resolves webpack aliases for visible CAStore vault changes", () => {
  const chunk = `
  (self.webpackChunk_N_E=self.webpackChunk_N_E||[]).push([[1],{
    78770:function(e,t,a){"use strict";a.d(t,{JY:function(){return d},ON:function(){return l}});let l="IndexVault",d="0x5418f7e8fF90354DB0eCD48c8b710219244Eb3C5";},
    56704:function(e,t,a){"use strict";a.d(t,{KB:function(){return s},Fn:function(){return d},vg:function(){return r}});let r="StocksVault",s="0x40a9a2FDa017E0923EA0B403F2f063f9E51168Fb",d=["0xf8aC088F06D155f3C3F531f1Ef80B14f1604530a"];}
  }]);
  var r=a(78770),i=a(56704);
  const config={taxVaults:{vaultTypes:[
    {name:r.ON,factory:r.JY,enabled:!0,showInCAStore:!0,constraints:{minDividendBps:0,maxDividendBps:0},descriptionI18nKey:"vaults.IndexVault.description",shortDescriptionI18nKey:"vaults.IndexVault.shortDescription",logo:"/stocks-vault-logo.svg"},
    {name:i.vg,factory:i.KB,enabled:!0,showInCAStore:!1,constraints:{minDividendBps:0,maxDividendBps:0},extra:{legacyFactories:i.Fn.join(",")},descriptionI18nKey:"vaults.StocksVault.description",shortDescriptionI18nKey:"vaults.StocksVault.shortDescription",logo:"/stocks-vault-logo.svg"}
  ]}};
  `;

  const vf = __testables.extractVaultFactories(chunk);
  const map = Object.fromEntries(vf.factories.map(v => [v.factory.toLowerCase(), v]));
  const index = map["0x5418f7e8ff90354db0ecd48c8b710219244eb3c5"];
  const stocks = map["0x40a9a2fda017e0923ea0b403f2f063f9e51168fb"];

  assert.equal(index.name, "IndexVault");
  assert.equal(index.showInCAStore, true);
  assert.equal(index.descriptionI18nKey, "vaults.IndexVault.description");
  assert.equal(stocks.name, "StocksVault");
  assert.equal(stocks.showInCAStore, false);
  assert.equal(stocks.legacyFactories, "0xf8aC088F06D155f3C3F531f1Ef80B14f1604530a");

  const diff = __testables.diffVaultFactories({
    "0x40a9a2FDa017E0923EA0B403F2f063f9E51168Fb": { ...stocks, showInCAStore: true },
  }, __testables.mergeRoundVaultFactoryMaps([{ url: "https://flap.sh/bnb/CAstore", map: __testables.factoryListToMap(vf.factories) }]).map);
  const content = __testables.formatVaultFactoryChanges(diff);
  const title = __testables.buildVaultFactoryChangeTitle(diff, "🏦 ");

  assert.equal(diff.added.length, 1);
  assert.equal(diff.modified.length, 1);
  assert.match(title, /新增可见 1 \/ 下架 1/);
  assert.match(content, /IndexVault/);
  assert.match(content, /0x5418f7e8fF90354DB0eCD48c8b710219244Eb3C5/);
  assert.match(content, /https:\/\/flap\.sh\/launch\?vaultfactory=0x5418f7e8fF90354DB0eCD48c8b710219244Eb3C5/);
  assert.match(content, /StocksVault/);
  assert.match(content, /https:\/\/flap\.sh\/launch\?vaultfactory=0x40a9a2FDa017E0923EA0B403F2f063f9E51168Fb/);
  assert.match(content, /https:\/\/flap\.sh\/launch\?vaultfactory=0xf8aC088F06D155f3C3F531f1Ef80B14f1604530a/);
  assert.match(content, /showInCAStore/);
});

test("registry log extraction detects on-chain registered vault address", () => {
  const log = {
    address: "0x90497450f2a706f1951b5bdda52b4e5d16f34c06",
    topics: ["0xd8cf270eb9827992a063745f0afaa72431f8c63fc46736f8b484862dcc709787"],
    data: "0x0000000000000000000000005418f7e8ff90354db0ecd48c8b710219244eb3c50000000000000000000000000000000000000000000000000000000000000001",
    blockNumber: "0x66c7754",
    transactionHash: "0x9e239cd0483e66d8f077f786fd5bfdee4036e838c0dedf680f63eabbd2614e68",
  };

  const addresses = __testables.extractRegistryVaultAddressesFromLog(log);
  const content = __testables.buildRegistryMonitorContent([{
    vault: addresses[0],
    txHash: log.transactionHash,
    blockNumber: Number.parseInt(log.blockNumber, 16),
    topic0: log.topics[0],
  }], { fromBlock: 107771732, toBlock: 107771732 });

  assert.deepEqual(addresses, ["0x5418f7e8ff90354db0ecd48c8b710219244eb3c5"]);
  assert.match(content, /链上注册中心发现新金库 1 个/);
  assert.match(content, /注册中心:/);
  assert.doesNotMatch(content, /证据详情/);
  assert.match(content, /0x5418f7e8ff90354db0ecd48c8b710219244eb3c5/);
  assert.match(content, /金库链接: \[打开金库\]\(https:\/\/flap\.sh\/launch\?vaultfactory=0x5418f7e8ff90354db0ecd48c8b710219244eb3c5\)/);
  assert.match(content, /0x9e239cd0/);
  assert.equal(
    __testables.buildVaultFactoryLaunchUrl(addresses[0]),
    "https://flap.sh/launch?vaultfactory=0x5418f7e8ff90354db0ecd48c8b710219244eb3c5",
  );
});

test("operational notice card is readable and action oriented", () => {
  const content = __testables.buildOperationalNoticeContent({
    status: "页面请求失败",
    url: "https://flap.sh/launch",
    severity: "orange",
    reason: "HTTP 403",
    consecutiveFailures: 3,
  });

  assert(content.startsWith("- 状态: 页面请求失败"));
  assert.match(content, /- 状态: 页面请求失败/);
  assert.match(content, /- 连续失败: 3 次/);
  assert.match(content, /- 页面: \[\/launch\]\(https:\/\/flap\.sh\/launch\)/);
  assert.doesNotMatch(content, /结论摘要|证据详情|打开页面/);
  assert.doesNotMatch(content, /建议动作/);
  assert.match(content, /HTTP 403/);
});

test("full diff uses detailed lines without summary truncation", () => {
  const diff = __testables.buildFlapFullDiff({
    diffTitle: "=== Flap.sh 详细 Diff ===",
    url: "https://flap.sh",
    changes: ["📝 chunk.js (20 处实质变更)", "  ... 还有 12 处新增"],
    meta: {
      fullDiffLines: [
        "【前端资源完整 Diff】",
        "文件: chunk.js",
        "+ long added string 001",
        "+ long added string 020",
      ],
    },
  });

  assert.match(diff, /long added string 001/);
  assert.match(diff, /long added string 020/);
  assert.doesNotMatch(diff, /\.\.\. 还有 12 处新增/);
});

test("flap cards keep every readable copy change without truncation", () => {
  const longOld = `旧文案-${"完整内容".repeat(80)}`;
  const longNew = `新文案-${"完整内容".repeat(80)}`;
  const textChanges = Array.from({ length: 15 }, (_, i) => ({
    type: "modified",
    oldText: `${longOld}-${i}`,
    newText: `${longNew}-${i}`,
  }));
  const content = __testables.buildCardBriefing(
    "https://flap.sh/create",
    null,
    null,
    textChanges.length,
    0,
    [],
    textChanges,
  );
  assert.match(content, new RegExp(`${longOld}-14`));
  assert.match(content, new RegExp(`${longNew}-14`));
  assert.doesNotMatch(content, /完整内容\.\.\.|完整内容…|还有 \d+ 处修改/);
});
