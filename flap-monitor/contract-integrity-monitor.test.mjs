import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { abandonContractHistory, abandonContractHistoryFile } from './abandon-contract-history.mjs';
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CONTRACT_INTEGRITY_FACTORY_EVENT_TOPICS,
  FLAP_CORE_CONTRACTS,
  acknowledgeContractIntegrityChanges,
  buildContractIntegrityContent,
  decodeVaultAuditInfo,
  resolveVaultAuditDetails,
  contractIntegritySubscriptionAddresses,
  createContractIntegrityState,
  decodeContractValue,
  extractBytecodeSelectors,
  ingestContractIntegrityEvent,
  loadContractIntegrityState,
  migrateContractIntegrityState,
  runContractIntegrityStateScan,
  scanContractIntegrityEvents,
  syncContractIntegrityCatalog,
} from "./contract-integrity-monitor.mjs";

const { __testables } = await import("./contract-integrity-monitor.mjs");

const auditFixture = JSON.parse(readFileSync(new URL('./fixtures/vault-audit-stocks.json', import.meta.url), 'utf8'));
test('真实审计事件直接识别代币并使用事件区块，不混淆代币与金库', async () => {
  const state = createContractIntegrityState();
  state.latestBlock = 124543332;
  const { change } = ingestContractIntegrityEvent(state, auditFixture.event);
  assert.equal(change.audit.token, '0x4dfe693e1b9c7c2f99b870adafccfaa6590f7777');
  assert.equal(change.audit.vault, undefined);
  const initial = buildContractIntegrityContent([change], state);
  assert.match(initial, /关联代币/);
  assert.match(initial, /区块 124543350/);
  assert.doesNotMatch(initial, /124543332|vaultfactory=0x4dfe/);
  const queries = [];
  const enriched = await resolveVaultAuditDetails([change, { ...change, id: 'same-subject' }], {
    rpcCall: async (_method, params) => { queries.push(params); return auditFixture.vaultResult; },
    resolveMetadata: async () => ({ metadata: auditFixture.metadata }),
  });
  assert.equal(queries.length, 1);
  assert.equal(queries[0][1], auditFixture.event.blockNumber);
  assert.equal(enriched[0].audit.vault, '0x84731aadbe94a7af4bad60d539a3ac26e73e1a5d');
  const content = buildContractIntegrityContent(enriched.slice(0, 1), state);
  assert.match(content, /\[Stocks\]/);
  assert.match(content, /bbk-v4/);
  assert.match(content, /Portal 登记描述\n\nbbk-v4/);
  assert.match(content, /官方标记：⚪ 否（未标记为官方）/);
  const officialContent = buildContractIntegrityContent([{ ...enriched[0], audit: {
    ...enriched[0].audit, description: '', isOfficial: true,
  } }]);
  assert.match(officialContent, /Portal 登记描述\n\n未填写/);
  assert.match(officialContent, /官方标记：<font color='green'>🟢 是/);
  assert.match(content, /vaultfactory=0xe26a5988e889e0f0467a54b7b6aa1618c647dc26/);
  assert.match(content, /不代表审计通过/);
  assert.equal(change.audit.name, undefined, 'enrichment must not mutate queued records');
});

test('审计映射失败明确降级到当前映射；空值或畸形结果不生成错误金库链接', async () => {
  const { change } = ingestContractIntegrityEvent(createContractIntegrityState(), auditFixture.event);
  const current = await resolveVaultAuditDetails([change], {
    rpcCall: async (_method, params) => {
      if (params[1] !== 'latest') throw Error('missing trie node');
      return auditFixture.vaultResult;
    }, resolveMetadata: async () => { throw Error('API down'); },
  });
  assert.match(buildContractIntegrityContent(current), /金库（当前映射）/);
  const failed = await resolveVaultAuditDetails([change], { rpcCall: async () => '0x' });
  assert.match(buildContractIntegrityContent(failed), /暂未核验/);
  assert.match(buildContractIntegrityContent(failed), /Portal 登记描述\n\n待核验/);
  assert.match(buildContractIntegrityContent(failed), /官方标记：待核验/);
  assert.doesNotMatch(buildContractIntegrityContent(failed), /vaultfactory=/);
  for (const raw of ['0x', '0x' + 'f'.repeat(64), auditFixture.vaultResult.slice(0, -64)]) {
    assert.throws(() => decodeVaultAuditInfo(raw));
  }
});

test('工厂审计直接链接工厂；同名事件来自其他合约时不套用 Portal 解码', () => {
  const state = createContractIntegrityState();
  const factoryTopic = '0x4a8f046a4ca2bbc769fd8fc279ed7147e8a63c3f515ef382d5f53eb723a548bd';
  const event = { ...auditFixture.event, topics: [factoryTopic, auditFixture.event.topics[1]] };
  const { change } = ingestContractIntegrityEvent(state, event);
  assert.equal(change.audit.token, undefined);
  assert.ok(change.audit.factory);
  assert.match(buildContractIntegrityContent([change]), /创建入口/);
  const other = { ...auditFixture.event, address: FLAP_CORE_CONTRACTS.factory };
  assert.equal(ingestContractIntegrityEvent(createContractIntegrityState(), other).change.audit, undefined);
});

test('abandon old history preserves live state and future gap recovery across reload', async () => {
  const state = createContractIntegrityState();
  Object.assign(state, { httpEventLastBlock: 10, eventHistoryEndBlock: 20, httpRealtimeLastBlock: 110,
    realtimeGaps: [{from: 101, to: 105}], historyRangeRetries: {11: 999, 101: 888},
    eventHistoryError: 'header not found', lastError: 'separate live error' });
  state.pendingChanges.push({id: 'pending', type: 'state'});
  assert.equal(abandonContractHistory(state, 11, 20), true);
  assert.equal(state.httpRealtimeLastBlock, 110);
  assert.equal(state.eventHistoryError, '');
  assert.equal(state.lastError, 'separate live error');
  assert.deepEqual(state.historyRangeRetries, {101: 888});
  const restored = migrateContractIntegrityState(JSON.parse(JSON.stringify(state)));
  const filters = [];
  await scanContractIntegrityEvents({ state: restored, latestBlock: 110, rpcCall: async (method, params) => {
    assert.equal(method, 'eth_getLogs'); filters.push(params[0]); return [];
  } });
  assert.equal(restored.httpEventLastBlock, 105);
  assert.equal(restored.eventHistoryEndBlock, 105);
  assert.ok(filters.length > 0);
  assert.ok(filters.every(filter => Number(filter.fromBlock) === 101 && Number(filter.toBlock) === 105));
  assert.equal(restored.historyAbandonments.length, 1);
  assert.equal(restored.pendingChanges[0].id, 'pending');
  const before = JSON.stringify(restored);
  assert.equal(abandonContractHistory(restored, 11, 20), false);
  assert.equal(JSON.stringify(restored), before);
});

test('abandon history rejects changed ranges and overlapping queued work without mutation', () => {
  for (const state of [
    {httpEventLastBlock: 12, eventHistoryEndBlock: 20},
    {httpEventLastBlock: 10, eventHistoryEndBlock: 20, realtimeGaps: [{from: 15, to: 25}]},
  ]) {
    const before = JSON.stringify(state);
    assert.throws(() => abandonContractHistory(state, 11, 20), /未修改状态/);
    assert.equal(JSON.stringify(state), before);
  }
  assert.throws(() => abandonContractHistory({}, NaN, 20), /有效/);
});

test('abandon history file previews without writing and backs up exact original before apply', t => {
  const dir = mkdtempSync(join(tmpdir(), 'flap-abandon-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const path = join(dir, 'state.json');
  const raw = '{"httpEventLastBlock":10,"eventHistoryEndBlock":20,"custom":"preserve"}\n';
  writeFileSync(path, raw);
  assert.equal(abandonContractHistoryFile(path, 11, 20).applied, false);
  assert.equal(readFileSync(path, 'utf8'), raw);
  assert.equal(readdirSync(dir).length, 1);
  const result = abandonContractHistoryFile(path, 11, 20, true);
  assert.equal(result.applied, true);
  assert.equal(readFileSync(result.backup, 'utf8'), raw);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).custom, 'preserve');
  assert.equal(abandonContractHistoryFile(path, 11, 20, true).changed, false);
  assert.equal(readdirSync(dir).length, 2);
});

test('Vault Factory 合约变更附带金库链接，Portal 不误生成链接', () => {
  const factory = '0x15cbf6b763b102acef6b4db9c62ed96fd3c0ab73';
  const portal = FLAP_CORE_CONTRACTS.vaultPortal;
  const content = buildContractIntegrityContent([
    {address: factory, type: 'event', field: '配置更新'},
    {address: portal, type: 'event', field: '权限更新'},
  ], {catalog: {[factory]: {kind: 'vaultFactory'}, [portal]: {kind: 'vaultPortal'}}});
  assert.ok(content.includes(`https://flap.sh/launch?vaultfactory=${factory}&chain=bnb&lang=zh`));
  assert.ok(!content.includes(`vaultfactory=${portal}`));
});

const word = value => String(value || "").replace(/^0x/, "").padStart(64, "0");
const addressWord = address => `0x${word(address)}`;
const uintWord = value => `0x${BigInt(value).toString(16).padStart(64, "0")}`;
const stringResult = value => {
  const body = Buffer.from(value, "utf8").toString("hex");
  return `0x${word("20")}${word(Buffer.byteLength(value).toString(16))}${body.padEnd(Math.ceil(body.length / 64) * 64, "0")}`;
};

test("batch execution revert falls back to individual calls and skips only reverted getters", async () => {
  const calls = [{ id: "ok" }, { id: "revert" }, { id: "ok-2" }];
  const result = await __testables.runBatch(async batch => {
    if (batch.length > 1) throw new Error("execution reverted");
    if (batch[0].id === "revert") throw new Error("execution reverted");
    return [`result:${batch[0].id}`];
  }, calls);
  assert.deepEqual(result, ["result:ok", null, "result:ok-2"]);
});

test("batch fallback still propagates non-revert RPC failures", async () => {
  await assert.rejects(
    () => __testables.runBatch(async () => { throw new Error("network unavailable"); }, [{ id: "x" }]),
    /network unavailable/,
  );
});

function createRpcFixture() {
  const values = {
    block: 100,
    implementation: `0x${"11".repeat(20)}`,
    beacon: "",
    version: "1.0.0",
    feature: false,
    codeByAddress: new Map(),
  };
  values.codeByAddress.set(FLAP_CORE_CONTRACTS.factory, "0x63aabbccdd14");
  values.codeByAddress.set(values.implementation, "0x631122334414");

  const resultFor = call => {
    const [first] = call.params || [];
    if (call.method === "eth_getStorageAt") {
      const slot = call.params[1];
      if (slot.startsWith("0x360894")) return addressWord(values.implementation);
      if (slot.startsWith("0xa3f0ad")) return values.beacon ? addressWord(values.beacon) : `0x${"0".repeat(64)}`;
      return `0x${"0".repeat(64)}`;
    }
    if (call.method === "eth_getCode") return values.codeByAddress.get(String(first).toLowerCase()) || "0x6000";
    if (call.method !== "eth_call") return null;
    const selector = String(first?.data || "").slice(0, 10);
    if (selector === "0x54fd4d50") return stringResult(values.version);
    if (selector === "0xb1aad1e1") return uintWord(values.feature ? 1 : 0);
    if (selector === "0xb22a3410") return addressWord(FLAP_CORE_CONTRACTS.vaultPortal);
    if (["0xb57523b0", "0x3fc8cef3", "0xb4b57c39", "0x952b8901", "0xbf584c4b", "0x0ff754ea", "0x2f567533", "0xf1d2212a", "0xa6f33254", "0xa3482a2f"].includes(selector)) {
      return `0x${"0".repeat(64)}`;
    }
    return uintWord(0);
  };
  return {
    values,
    rpcCall: async method => {
      if (method === "eth_chainId") return "0x38";
      if (method === "eth_blockNumber") return `0x${values.block.toString(16)}`;
      throw new Error(`unexpected ${method}`);
    },
    rpcBatch: async calls => calls.map(resultFor),
  };
}

test("EIP-1967 values and ABI return values decode without losing addresses", () => {
  const address = `0x${"ab".repeat(20)}`;
  assert.equal(decodeContractValue(addressWord(address), "address"), address);
  assert.equal(decodeContractValue(uintWord(1), "bool"), "true");
  assert.equal(decodeContractValue(uintWord(500), "uint"), "500");
  assert.equal(decodeContractValue(stringResult("Flap v7"), "string"), "Flap v7");
});

test("integrity migration preserves backlog beyond the old 500 item limit", () => {
  const original = createContractIntegrityState();
  original.pendingChanges = Array.from({ length: 550 }, (_, i) => ({ id: `pending-${i}`, type: "field" }));
  const migrated = migrateContractIntegrityState(original);
  assert.equal(migrated.pendingChanges.length, 550);
  assert.equal(migrated.pendingChanges[0].id, "pending-0");
});

test("state migration keeps built-in core contract types authoritative", () => {
  const state = migrateContractIntegrityState({
    catalog: {
      [FLAP_CORE_CONTRACTS.vaultPortal]: {
        address: FLAP_CORE_CONTRACTS.vaultPortal,
        kind: "vault-portal",
        source: "onchain-getter",
      },
    },
  });
  assert.equal(state.catalog[FLAP_CORE_CONTRACTS.vaultPortal].kind, "vaultPortal");
  assert.equal(state.catalog[FLAP_CORE_CONTRACTS.vaultPortal].source, "builtin");
  assert.equal(state.catalog[FLAP_CORE_CONTRACTS.vaultPortal].verified, true);
});

test("state migration removes unverified core hints and pending unknown-event noise", () => {
  const wbnb = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
  const legacyVault = "0x5555555555555555555555555555555555555555";
  const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const state = migrateContractIntegrityState({
    catalog: {
      [wbnb]: {
        address: wbnb,
        label: "Flap SwapRegistry（前端配置）",
        kind: "swapRegistry",
        source: "launch.js",
      },
      [legacyVault]: {
        address: legacyVault,
        label: "Vault Portal 注册 Vault Factory",
        kind: "vaultFactory",
        source: "vault-portal-snapshot",
      },
    },
    pendingChanges: [{ id: "noise", type: "event", address: wbnb, topic0: transferTopic }],
  });
  assert.equal(state.catalog[wbnb], undefined);
  assert.equal(state.catalog[legacyVault], undefined);
  assert.equal(state.pendingChanges.length, 0);
  assert.equal(contractIntegritySubscriptionAddresses(state).includes(wbnb), false);
});

test("corrupt integrity state is reported instead of silently discarding pending alerts", () => {
  const dir = mkdtempSync(join(tmpdir(), "flap-integrity-"));
  const path = join(dir, "state.json");
  try {
    writeFileSync(path, "{broken", "utf8");
    assert.throws(() => loadContractIntegrityState(path), /状态文件解析失败/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bytecode selector audit reports only PUSH4 comparison selectors", () => {
  assert.deepEqual(extractBytecodeSelectors("0x600063aabbccdd146311223344005b"), ["0xaabbccdd"]);
});

test("contract state scan establishes a baseline then reports slot getter and selector changes", async () => {
  const state = createContractIntegrityState();
  const fixture = createRpcFixture();
  const baseline = await runContractIntegrityStateScan({ state, ...fixture });
  assert.equal(baseline.changed, false);
  assert.equal(state.contracts[FLAP_CORE_CONTRACTS.factory].slots.implementation, fixture.values.implementation);
  assert.equal(state.catalog[FLAP_CORE_CONTRACTS.vaultPortal].kind, "vaultPortal");
  assert.equal(contractIntegritySubscriptionAddresses(state).length, 3);

  const nextImplementation = `0x${"22".repeat(20)}`;
  fixture.values.block++;
  fixture.values.implementation = nextImplementation;
  fixture.values.beacon = `0x${"23".repeat(20)}`;
  fixture.values.version = "1.1.0";
  fixture.values.codeByAddress.set(nextImplementation, "0x635566778814");
  const changed = await runContractIntegrityStateScan({ state, ...fixture });
  assert.ok(changed.changes.some(change => change.field === "implementation"));
  assert.ok(changed.changes.some(change => change.field === "beacon"));
  assert.ok(changed.changes.some(change => change.field === "version"));

  fixture.values.block++;
  fixture.values.codeByAddress.set(FLAP_CORE_CONTRACTS.factory, "0x63eeff001114");
  const audited = await runContractIntegrityStateScan({ state, ...fixture, forceCodeAudit: true });
  assert.ok(audited.changes.some(change => change.type === "code-hash"));
  assert.ok(audited.changes.some(change => change.type === "selectors" && change.added.includes("0xeeff0011")));
});

test("Factory implementation state change is suppressed only while its dedicated monitor is enabled", async () => {
  const suppressedState = createContractIntegrityState();
  const suppressedFixture = createRpcFixture();
  await runContractIntegrityStateScan({ state: suppressedState, ...suppressedFixture });
  suppressedFixture.values.block++;
  suppressedFixture.values.implementation = `0x${"31".repeat(20)}`;
  suppressedFixture.values.codeByAddress.set(suppressedFixture.values.implementation, "0x631122334414");
  const suppressed = await runContractIntegrityStateScan({
    state: suppressedState,
    ...suppressedFixture,
    suppressFactoryImplementationChange: true,
  });
  assert.equal(suppressed.changes.some(change => (
    change.address === FLAP_CORE_CONTRACTS.factory && change.field === "implementation"
  )), false);
  assert.equal(
    suppressedState.contracts[FLAP_CORE_CONTRACTS.factory].slots.implementation,
    suppressedFixture.values.implementation,
  );

  const fallbackState = createContractIntegrityState();
  const fallbackFixture = createRpcFixture();
  await runContractIntegrityStateScan({ state: fallbackState, ...fallbackFixture });
  fallbackFixture.values.block++;
  fallbackFixture.values.implementation = `0x${"32".repeat(20)}`;
  fallbackFixture.values.codeByAddress.set(fallbackFixture.values.implementation, "0x631122334414");
  const fallback = await runContractIntegrityStateScan({ state: fallbackState, ...fallbackFixture });
  assert.equal(fallback.changes.some(change => (
    change.address === FLAP_CORE_CONTRACTS.factory && change.field === "implementation"
  )), true);
});

test("failed bytecode batch entries never become false code-removal alerts", async () => {
  const state = createContractIntegrityState();
  const fixture = createRpcFixture();
  await runContractIntegrityStateScan({ state, ...fixture });
  const originalBatch = fixture.rpcBatch;
  const result = await runContractIntegrityStateScan({
    state,
    rpcCall: fixture.rpcCall,
    rpcBatch: async calls => calls.every(call => call.method === "eth_getCode")
      ? calls.map(() => null)
      : originalBatch(calls),
    forceCodeAudit: true,
  });
  assert.equal(result.changes.some(change => change.type === "code-hash"), false);
  assert.notEqual(state.contracts[FLAP_CORE_CONTRACTS.factory].codeBytes, 0);
});

test("unchanged derived contracts do not trigger bytecode reads on every core scan", async () => {
  const state = createContractIntegrityState();
  const fixture = createRpcFixture();
  await runContractIntegrityStateScan({ state, ...fixture });
  let codeCalls = 0;
  await runContractIntegrityStateScan({
    state,
    rpcCall: fixture.rpcCall,
    rpcBatch: async calls => {
      codeCalls += calls.filter(call => call.method === "eth_getCode").length;
      return fixture.rpcBatch(calls);
    },
  });
  assert.equal(codeCalls, 0);
});

test("catalog sync keeps frontend hints passive and subscribes only verified Vault Factories", () => {
  const state = createContractIntegrityState();
  const vaultFactory = `0x${"33".repeat(20)}`;
  const implementation = `0x${"44".repeat(20)}`;
  const router = `0x${"45".repeat(20)}`;
  const wbnb = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
  const asset = `0x${"55".repeat(20)}`;
  const changed = syncContractIntegrityCatalog(state, {
    vaultFactories: { [vaultFactory]: { factory: vaultFactory, name: "Index Vault" } },
    contractHints: [
      { address: implementation, kind: "tokenImplementation", label: "Tax Token Impl" },
      { address: router, kind: "swap-router", label: "Swap Router" },
      { address: wbnb, kind: "swapRegistry", label: "Flap SwapRegistry（前端配置）" },
    ],
    factoryAssets: { [asset]: { symbol: "TESTB" } },
  });
  assert.equal(changed, true);
  assert.equal(state.catalog[vaultFactory].kind, "frontendHint");
  assert.equal(state.catalog[vaultFactory].hintedKind, "vaultFactory");
  assert.equal(state.catalog[implementation].kind, "frontendHint");
  assert.equal(state.catalog[implementation].hintedKind, "tokenImplementation");
  assert.equal(state.trackedAssets[asset].label, "TESTB");
  assert.equal(contractIntegritySubscriptionAddresses(state).includes(vaultFactory), false);
  assert.equal(contractIntegritySubscriptionAddresses(state).includes(implementation), false);
  assert.equal(contractIntegritySubscriptionAddresses(state).includes(router), false);
  assert.equal(state.catalog[wbnb].kind, "frontendHint");
  assert.equal(contractIntegritySubscriptionAddresses(state).includes(wbnb), false);
});

test("integrity events deduplicate suppress existing Factory upgrade alerts and discover Vault Factory", () => {
  const state = createContractIntegrityState();
  const adminChange = {
    address: FLAP_CORE_CONTRACTS.factory,
    topics: [CONTRACT_INTEGRITY_FACTORY_EVENT_TOPICS[1]],
    data: "0x",
    transactionHash: `0x${"66".repeat(32)}`,
    blockNumber: "0x64",
    logIndex: "0x1",
  };
  assert.ok(ingestContractIntegrityEvent(state, adminChange, "test").change);
  assert.equal(ingestContractIntegrityEvent(state, adminChange, "test").duplicate, true);

  const upgrade = {
    ...adminChange,
    topics: [CONTRACT_INTEGRITY_FACTORY_EVENT_TOPICS[0]],
    transactionHash: `0x${"67".repeat(32)}`,
  };
  assert.ok(ingestContractIntegrityEvent(state, upgrade, "test").change);
  const duplicateUpgrade = { ...upgrade, transactionHash: `0x${"68".repeat(32)}` };
  assert.equal(ingestContractIntegrityEvent(state, duplicateUpgrade, "test", { suppressFactoryUpgrade: true }).suppressed, true);

  const operational = {
    ...adminChange,
    topics: ["0x504e7f360b2e5fe33cbaaae4c593bc55305328341bf79009e43e0e3b7f699603"],
    transactionHash: `0x${"77".repeat(32)}`,
  };
  assert.equal(ingestContractIntegrityEvent(state, operational, "test").suppressed, true);

  const pendingBeforeUnknown = state.pendingChanges.length;
  const transfer = {
    ...adminChange,
    address: FLAP_CORE_CONTRACTS.swapRegistry,
    topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"],
    transactionHash: `0x${"78".repeat(32)}`,
  };
  const ignoredTransfer = ingestContractIntegrityEvent(state, transfer, "test");
  assert.equal(ignoredTransfer.unknown, true);
  assert.equal(state.pendingChanges.length, pendingBeforeUnknown);

  const vaultFactory = `0x${"88".repeat(20)}`;
  syncContractIntegrityCatalog(state, {
    vaultFactories: { [vaultFactory]: { factory: vaultFactory, name: "Candidate" } },
  });
  assert.equal(contractIntegritySubscriptionAddresses(state).includes(vaultFactory), false);
  const registered = {
    ...adminChange,
    address: FLAP_CORE_CONTRACTS.vaultPortal,
    topics: ["0xd8cf270eb9827992a063745f0afaa72431f8c63fc46736f8b484862dcc709787"],
    data: addressWord(vaultFactory),
    transactionHash: `0x${"99".repeat(32)}`,
  };
  assert.equal(ingestContractIntegrityEvent(state, registered, "test").suppressed, true);
  assert.equal(state.catalog[vaultFactory].kind, "vaultFactory");
  assert.equal(state.catalog[vaultFactory].verified, true);
  assert.equal(contractIntegritySubscriptionAddresses(state).includes(vaultFactory), true);

});

test("HTTP event fallback advances a compact cursor and preserves pending alerts until acknowledged", async () => {
  const state = createContractIntegrityState();
  let latest = 100;
  const rpcCall = async (method, params) => {
    if (method === "eth_blockNumber") return `0x${latest.toString(16)}`;
    if (method === "eth_getLogs") {
      const filter = params[0];
      if (filter.address !== FLAP_CORE_CONTRACTS.factory) return [];
      return [{
        address: FLAP_CORE_CONTRACTS.factory,
        topics: [CONTRACT_INTEGRITY_FACTORY_EVENT_TOPICS[1]],
        data: "0x",
        transactionHash: `0x${"aa".repeat(32)}`,
        blockNumber: "0x65",
        logIndex: "0x0",
      }];
    }
    throw new Error(method);
  };
  const initialized = await scanContractIntegrityEvents({ state, rpcCall });
  assert.equal(initialized.initialized, true);
  assert.equal(state.httpEventLastBlock, 100);
  latest = 102;
  const result = await scanContractIntegrityEvents({ state, rpcCall });
  assert.equal(result.changed, true);
  assert.equal(state.httpEventLastBlock, 102);
  assert.equal(state.pendingChanges.length, 1);
  assert.match(buildContractIntegrityContent(state.pendingChanges, state), /代理管理员变更/);
  acknowledgeContractIntegrityChanges(state, [state.pendingChanges[0].id]);
  assert.equal(state.pendingChanges.length, 0);
});

test('contract live cursor progresses even when archived logs are unavailable', async () => {
  const state = createContractIntegrityState(); state.httpEventLastBlock = 100;
  const rpcCall = async (method, params) => {
    if (method === 'eth_getLogs') {
      if (Number(params[0].fromBlock) < 900) throw new Error('archive unavailable');
      return [];
    }
    throw new Error(method);
  };
  await scanContractIntegrityEvents({ state, rpcCall, latestBlock: 1000, realtime: true, maxBlocks: 50 });
  assert.equal(state.httpRealtimeLastBlock, 1000);
  assert.equal(state.httpEventLastBlock, 100);
  assert.equal(state.eventHistoryEndBlock, 980);
  await assert.rejects(scanContractIntegrityEvents({ state, rpcCall, latestBlock: 1000 }), /archive/);
  assert.equal(state.httpRealtimeLastBlock, 1000);
  assert.equal(state.httpEventLastBlock, 100);
});

test('history cursor commits only after all filters finish and commit gate opens',async()=>{
 const state=createContractIntegrityState();state.httpEventLastBlock=10;state.eventHistoryEndBlock=20;
 let commit;const pending=scanContractIntegrityEvents({state,latestBlock:20,rpcCall:async()=>[],commit:fn=>new Promise(resolve=>{commit=()=>resolve(fn());})});
 await new Promise(r=>setImmediate(r));assert.equal(state.httpEventLastBlock,10);assert.equal(typeof commit,'function');commit();await pending;assert.equal(state.httpEventLastBlock,20);
});

test('batch boundaries yield before issuing the next network chunk',async()=>{
 const steps=[];const result=await __testables.runBatch(async calls=>{steps.push('rpc'+calls.length);return calls;},[1,2,3],2,async()=>steps.push('yield'));
 assert.deepEqual(result,[1,2,3]);assert.deepEqual(steps,['yield','rpc2','yield','rpc1']);
});

test('older extended audit cannot overwrite a newer core code observation',async()=>{
 const state=createContractIntegrityState(),fixture=createRpcFixture();await runContractIntegrityStateScan({state,...fixture});
 const timestamp=state.lastCoreScanAt,address=FLAP_CORE_CONTRACTS.factory;
 await runContractIntegrityStateScan({state,...fixture,extended:true,forceCodeAudit:true,excludeCore:true,beforeBatch:async()=>{
  state.latestBlock=200;state.contracts[address].lastCodeBlock=200;state.contracts[address].codeHash='newer-code';
 }});
 assert.equal(state.lastCoreScanAt,timestamp);assert.equal(state.latestBlock,200);assert.equal(state.contracts[address].codeHash,'newer-code');assert.equal(state.contracts[address].lastCodeBlock,200);
});


test('integrity removed event tombstones replay, persists correction and permits re-inclusion', () => {
  const state = createContractIntegrityState();
  const entry = { ...auditFixture.event, blockHash: '0x' + 'ab'.repeat(32) };
  const first = ingestContractIntegrityEvent(state, entry).change;
  acknowledgeContractIntegrityChanges(state, [first.id]);
  const correction = ingestContractIntegrityEvent(state, { ...entry, removed: true }).change;
  assert.equal(correction.type, 'reorg');
  assert.match(buildContractIntegrityContent([correction], state), /原事件已撤销/);
  assert.equal(ingestContractIntegrityEvent(state, entry).change, null);
  assert.equal(ingestContractIntegrityEvent(state, { ...entry, removed: true }).change, null);
  const restored = migrateContractIntegrityState(JSON.parse(JSON.stringify(state)));
  assert.equal(ingestContractIntegrityEvent(restored, entry).change, null);
  const next = ingestContractIntegrityEvent(restored, { ...entry, blockHash: '0x' + 'ef'.repeat(32) }).change;
  assert.ok(next);
  assert.notEqual(next.id, first.id);
});
