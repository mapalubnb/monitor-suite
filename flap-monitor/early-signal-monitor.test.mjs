import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEarlySignalState, decodeEarlyReceipt, ingestCowOrders, earlyAssetStage, syncEarlyProposals,
  rewindEarlySignals, scanEarlyChain, refreshEarlyAssets, buildEarlySignalContent, loadEarlySignalState,
  saveEarlySignalState, acknowledgeEarlySignals, runEarlySignalScan, earlyLogFilters,
  processEarlyReceiptHints, shouldPrioritizeEarlyLog } from "./early-signal-monitor.mjs";
import { extractFlapProposalActions, DEFAULT_FLAP_ADMIN_SAFES } from "./safe-proposal-monitor.mjs";
import { DEX, EXECUTION_WALLETS, CORE_SAFES, ALLOWANCE_MODULE } from "./early-signal-catalog.mjs";
import { TOPICS } from "./early-signal-topics.mjs";
import { decodeOperationalCall } from "./operational-call-codec.mjs";

const history = JSON.parse(readFileSync(new URL("./fixtures/early-signal-history.json", import.meta.url)));
const TOKEN = "0x4ebf5fd25b02022afad96e2fa25da54a246fded0";
const OWNER = EXECUTION_WALLETS[0].toLowerCase();
const POOL = "0x8ac8737d04a8cbcb7e86b98235778b6c0906950c";
const nowMs = Date.parse("2026-09-25T02:08:00Z");
const word = x => (typeof x === "string" ? x.replace(/^0x/, "") : BigInt(x).toString(16)).padStart(64, "0");
const topic = x => "0x" + word(x);
const BH = "0x" + "ab".repeat(32);
const TX = "0x" + "cd".repeat(32);
const log = (address, topics, data, index = 0) => ({ address, topics, data, blockNumber: "0x64", blockHash: BH, transactionHash: TX, logIndex: `0x${index.toString(16)}` });
const receipt = logs => ({ status: "0x1", from: OWNER, blockNumber: "0x64", blockHash: BH, transactionHash: TX, logs });

test("fast receipt lane waits for confirmations, deduplicates replay and never advances scan cursor", async () => {
  const state = createEarlySignalState(), r = history.liquidityReceipt;
  const block = Number(r.blockNumber);
  state.cursor = block - 1; state.chainBaselineAt = new Date(nowMs).toISOString();
  const hints = [{ transactionHash: r.transactionHash, blockNumber: r.blockNumber }];
  let latest = block;
  const rpc = async calls => calls.map(c => ({ eth_chainId: "0x38", eth_blockNumber: `0x${latest.toString(16)}`,
    eth_getTransactionReceipt: r, eth_getBlockByNumber: { hash: r.blockHash }, eth_call: "0x", eth_getLogs: r.logs })[c.method]);
  const waiting = await processEarlyReceiptHints(state, hints, { confirmations: 1 }, rpc, nowMs);
  assert.equal(waiting.processed.length, 0);
  assert.equal(state.pendingChanges.length, 0);
  latest++;
  const result = await processEarlyReceiptHints(state, hints, { confirmations: 1 }, rpc, nowMs);
  assert.equal(result.processed.length, 1);
  assert.ok(result.tokens.includes(TOKEN));
  assert.equal(state.cursor, block - 1);
  assert.equal(state.fastBlocks[block], r.blockHash.toLowerCase());
  const count = state.pendingChanges.length;
  await processEarlyReceiptHints(state, hints, { confirmations: 1 }, rpc, nowMs);
  await scanEarlyChain(state, { confirmations: 1, nativeTransactions: false }, rpc, nowMs);
  assert.equal(state.pendingChanges.length, count);
  assert.equal(state.cursor, block);
  assert.equal(Object.keys(state.fastBlocks).length, 0);
});

test("out-of-order HTTP backfill cannot overwrite the latest fast-lane liquidity stage", () => {
  const state = createEarlySignalState();
  state.events.new = { kind: "liquidityRemoved", token: TOKEN, blockNumber: 102, logIndex: 1 };
  state.events.old = { kind: "liquidityAdded", token: TOKEN, blockNumber: 101, logIndex: 3 };
  assert.equal(earlyAssetStage(state, TOKEN), "observation");
});

test("fast receipt anchors detect reorg before HTTP cursor reaches that block", async () => {
  const state = createEarlySignalState(), r = history.liquidityReceipt;
  const block = Number(r.blockNumber);
  state.cursor = block - 1; state.chainBaselineAt = new Date(nowMs).toISOString();
  state.fastBlocks[block] = r.blockHash.toLowerCase();
  decodeEarlyReceipt(r, state, { nowMs });
  const rpc = async calls => calls.map(c => ({ eth_chainId: "0x38", eth_blockNumber: `0x${(block + 1).toString(16)}`,
    eth_getBlockByNumber: { hash: BH } })[c.method]);
  await processEarlyReceiptHints(state, [], { confirmations: 1 }, rpc, nowMs);
  assert.equal(Object.keys(state.fastBlocks).length, 0);
  assert.ok(state.pendingChanges.some(e => e.kind === "reorg"));
  assert.equal(state.pendingChanges.some(e => e.kind === "liquidityAdded"), false);
  assert.equal(state.cursor, block - 1);
});

test("unrelated global pool logs stay off the fast lane until a token becomes relevant", () => {
  const state = createEarlySignalState();
  const event = { topics: [TOPICS.PoolCreated, topic(TOKEN), topic(OWNER)] };
  assert.equal(shouldPrioritizeEarlyLog(event, state), false);
  state.tokens[TOKEN] = {};
  assert.equal(shouldPrioritizeEarlyLog(event, state), true);
  assert.equal(shouldPrioritizeEarlyLog({ topics: [TOPICS.Transfer] }, state), true);
});

test("asset-only external pass never calls the slow CoW or discovery endpoints", async () => {
  const state = createEarlySignalState();
  await runEarlySignalScan({ state, config: { mode: "external", sources: ["assets"] }, nowMs,
    rpcBatch: async () => { throw new Error("no assets need RPC"); },
    fetchFn: async () => { throw new Error("unexpected external request"); } });
  assert.equal(state.health.assets.lastError, "");
  assert.equal(state.health.discovery, undefined);
});

test("unrelated pool discovery never expands recurring log filters", () => {
  const state = createEarlySignalState();
  state.pools[POOL] = { address: POOL, tokens: [TOKEN] };
  assert.equal(earlyLogFilters(state).some(f => Array.isArray(f.address) && f.address.includes(POOL)), false);
  state.tokens[TOKEN] = { address: TOKEN };
  assert.equal(earlyLogFilters(state).some(f => Array.isArray(f.address) && f.address.includes(POOL)), true);
});

test("failed initial chain scan retains null bootstrap cursor", async () => {
  const state = createEarlySignalState();
  const rpc = async calls => {
    if (calls.some(c => c.method === "eth_getLogs")) throw new Error("timeout");
    return calls.map(c => ({ eth_chainId: "0x38", eth_blockNumber: "0x65", eth_getBlockByNumber: { hash: BH, transactions: [] } })[c.method]);
  };
  await assert.rejects(scanEarlyChain(state, { nativeTransactions: false }, rpc, nowMs), /timeout/);
  assert.equal(state.cursor, null);
  assert.equal(state.pendingChanges.length, 0);
});

test("candidate capacity preserves new evidence without blocking receipt processing", () => {
  const state = createEarlySignalState();
  for (let i = 1; i <= 500; i++) state.tokens['0x' + i.toString(16).padStart(40, '0')] = { address: i };
  decodeEarlyReceipt(history.liquidityReceipt, state, { nowMs, transaction: history.liquidityTransaction });
  assert.equal(Object.keys(state.tokens).length, 500);
  assert.ok(state.pendingChanges.some(e => e.token === TOKEN));
  assert.match(state.health.capacity.lastError, /500/);
});

test("CoW cancellation, reopening and expiry each retain their lifecycle event", () => {
  const original = history.orders.find(o => o.creationDate.startsWith("2026-09-25T01:33"));
  const state = createEarlySignalState();
  const order = { ...original, status: "open", validTo: nowMs / 1000 + 600 };
  ingestCowOrders(state, OWNER, [order], { nowMs });
  ingestCowOrders(state, OWNER, [{ ...order, status: "cancelled" }], { nowMs: nowMs + 1 });
  ingestCowOrders(state, OWNER, [order], { nowMs: nowMs + 2 });
  assert.equal(state.pendingChanges.length, 3);
  ingestCowOrders(state, OWNER, [order], { nowMs: nowMs + 601000 });
  assert.equal(state.orders[order.uid].status, "expired");
  assert.equal(earlyAssetStage(state, order.buyToken), "observation");
});

test("real wPOPMTx pool creation/mint is preparation, not opening; replay is idempotent", () => {
  const state = createEarlySignalState();
  decodeEarlyReceipt(history.liquidityReceipt, state, { nowMs, transaction: history.liquidityTransaction });
  assert.deepEqual(state.pools[POOL].tokens, [TOKEN, "0x55d398326f99059ff775485246999027b3197955"]);
  assert.equal(earlyAssetStage(state, TOKEN), "prepared");
  assert.ok(state.pendingChanges.some(x => x.kind === "liquidityAdded" && x.token === TOKEN));
  const count = state.pendingChanges.length;
  decodeEarlyReceipt(history.liquidityReceipt, state, { nowMs });
  assert.equal(state.pendingChanges.length, count);
  assert.match(buildEarlySignalContent(state.pendingChanges, state), /开放未确认/);
});

test("historical LP batch exposes all 58 transfers and allowance proposal identifies delegate", () => {
  const lp = history.proposals.find(x => x.nonce === 73);
  const actions = extractFlapProposalActions(lp, { includeOperations: true });
  assert.equal(actions.filter(x => x.kind === "positionTransfer").length, 58);
  assert.ok(actions.every(x => x.recipient === OWNER));
  const allowance = extractFlapProposalActions(history.proposals.find(x => x.nonce === 147), { includeOperations: true });
  assert.ok(allowance.some(x => x.kind === "module"));
  assert.ok(allowance.some(x => x.kind === "allowance" && x.amount === "200000000000000000000"));
  assert.equal(DEFAULT_FLAP_ADMIN_SAFES.length, 8);
});

test("real CoW order lifecycle discovers buying target before opening without replaying bootstrap history", () => {
  const order = history.orders.find(o => o.creationDate.startsWith("2026-09-25T01:33"));
  const state = createEarlySignalState();
  ingestCowOrders(state, OWNER, [order], { nowMs, bootstrap: true });
  assert.equal(state.pendingChanges.length, 0);
  const active = { ...order, status: "open", executedSellAmount: "0", executedBuyAmount: "0", validTo: nowMs / 1000 + 600 };
  ingestCowOrders(state, OWNER, [active], { nowMs });
  assert.equal(earlyAssetStage(state, active.buyToken), "stocking");
  ingestCowOrders(state, OWNER, [{ ...active, status: "cancelled" }], { nowMs: nowMs + 1 });
  assert.equal(earlyAssetStage(state, active.buyToken), "observation");
  assert.throws(() => ingestCowOrders(state, OWNER, [{ ...active, owner: TOKEN }], { nowMs }), /owner/);
});

test("route alone never signals proposed opening; replacement removes opening expectation", () => {
  const state = createEarlySignalState();
  const p = { key: "p", quoteToken: TOKEN, actions: [{ kind: "route", quoteToken: TOKEN }], status: "ready", confirmations: 2, required: 2, safeTxHash: TX };
  syncEarlyProposals(state, { proposals: { p } }, nowMs);
  assert.equal(earlyAssetStage(state, TOKEN), "observation");
  p.actions.push({ kind: "configuration", quoteToken: TOKEN, config: { enabled: 1 } });
  p.confirmations = 3;
  syncEarlyProposals(state, { proposals: { p } }, nowMs + 1);
  assert.equal(earlyAssetStage(state, TOKEN), "signed");
  p.status = "invalidated";
  syncEarlyProposals(state, { proposals: { p } }, nowMs + 2);
  assert.equal(earlyAssetStage(state, TOKEN), "observation");
});

test("malformed and delegatecall operations retain raw calldata rather than guessing", () => {
  const a = decodeOperationalCall({ to: TOKEN, data: "0xa9059cbb", operation: 1 });
  assert.equal(a.kind, "unknown");
  assert.equal(a.rawData, "0xa9059cbb");
  assert.equal(decodeOperationalCall({ to: TOKEN, data: "0xa9059cbb" }).kind, "unknown");
});

test("V4 and Infinity track poolId and signed removal; arbitrary manager spoof cannot promote", () => {
  for (const [manager, init, initData] of [[DEX.v4Manager, TOPICS.V4Initialize, [3000, 60, 0, 1, 0]], [DEX.clManager, TOPICS.CLInitialize, [0, 3000, 0, 1, 0]]]) {
    const state = createEarlySignalState();
    const logs = [log(manager, [init, TX, topic(TOKEN), topic("0x55d398326f99059ff775485246999027b3197955")], "0x" + initData.map(word).join("")),
      log(manager, [TOPICS.ModifyLiquidity, TX, topic(OWNER)], "0x" + [0, 1, 50, 0].map(word).join(""), 1)];
    decodeEarlyReceipt(receipt(logs), state, { nowMs });
    assert.equal(earlyAssetStage(state, TOKEN), "prepared");
    const burn = log(manager, [TOPICS.ModifyLiquidity, TX, topic(OWNER)], "0x" + [word(0), word(1), "f".repeat(64), word(0)].join(""), 2);
    decodeEarlyReceipt(receipt([burn]), state, { nowMs });
    assert.equal(earlyAssetStage(state, TOKEN), "observation");
    assert.equal(Object.keys(state.pools).length, 1);
  }
  const state = createEarlySignalState();
  decodeEarlyReceipt(receipt([log(TOKEN, [TOPICS.V4Initialize, TX, topic(TOKEN), topic(OWNER)], "0x" + [3000, 60, 0, 1, 0].map(word).join(""))]), state, { nowMs });
  assert.equal(Object.keys(state.pools).length, 0);
});

test("ERC4626 Deposit requires successful asset mapping before stocking classification", async () => {
  const state = createEarlySignalState();
  decodeEarlyReceipt(history.wrapReceipt, state, { nowMs });
  assert.equal(earlyAssetStage(state, TOKEN), "observation");
  const underlying = "0x3a0a47a9c2713a7049d1052cc8ebd39c41570580";
  const rpcBatch = async () => [topic(underlying), "0x" + [0,0,0,0,0].map(word).join(""), topic(0)];
  await refreshEarlyAssets(state, {}, rpcBatch, nowMs);
  assert.equal(state.tokens[TOKEN].underlying, underlying);
  assert.equal(earlyAssetStage(state, TOKEN), "stocking");
  const enabledRpc = async () => [null, "0x" + [1,89,89,7,0].map(word).join(""), topic(0)];
  await refreshEarlyAssets(state, {}, enabledRpc, nowMs + 1);
  assert.equal(earlyAssetStage(state, TOKEN), "opened");
  await assert.rejects(refreshEarlyAssets(state, {}, async () => [null, null, null], nowMs + 2), /配置读取失败/);
  assert.equal(earlyAssetStage(state, TOKEN), "opened");
});

test("module execution captured without a Safe proposal, unrelated module events filtered", () => {
  const state = createEarlySignalState();
  const safe = CORE_SAFES[0][0].toLowerCase();
  decodeEarlyReceipt(receipt([log(safe, [TOPICS.ModuleSuccess, topic(ALLOWANCE_MODULE)], "0x")]), state, { nowMs });
  assert.ok(state.pendingChanges.some(e => e.kind === "safeOperation"));
  assert.ok(earlyLogFilters(state).some(f => f.address === ALLOWANCE_MODULE));
});

test("reorg retracts local signals, pending messages and derived preparation", () => {
  const state = createEarlySignalState();
  decodeEarlyReceipt(history.liquidityReceipt, state, { nowMs });
  const b = Number(history.liquidityReceipt.blockNumber);
  state.cursor = b;
  state.cursorHash = BH;
  rewindEarlySignals(state, b, nowMs);
  assert.equal(earlyAssetStage(state, TOKEN), "observation");
  assert.equal(state.pools[POOL], undefined);
  assert.deepEqual(state.pendingChanges.map(x => x.kind), ["reorg"]);
});

test("failed receipt cannot produce transfers or liquidity preparation", () => {
  const state = createEarlySignalState();
  decodeEarlyReceipt({ ...history.liquidityReceipt, status: "0x0" }, state, { nowMs });
  assert.equal(Object.keys(state.events).length, 0);
});

test("scan commits only complete canonical windows and respects RPC chain identity", async () => {
  const state = createEarlySignalState();
  const rpc = async calls => calls.map(c => ({ eth_chainId: "0x38", eth_blockNumber: "0x65", eth_getBlockByNumber: { hash: BH, transactions: [] }, eth_getLogs: [] })[c.method]);
  await scanEarlyChain(state, { nativeTransactions: false }, rpc, nowMs);
  assert.equal(state.cursor, 100);
  const cursor = state.cursor;
  await assert.rejects(scanEarlyChain(state, {}, async calls => calls.map(c => c.method === "eth_chainId" ? "0x1" : null), nowMs), /不是 BSC/);
  assert.equal(state.cursor, cursor);
  const failedRpc = async calls => { if (calls.some(c => c.method === "eth_getLogs")) throw new Error("timeout"); return calls.map(c => ({ eth_chainId: "0x38", eth_blockNumber: "0x66", eth_getBlockByNumber: { hash: BH } })[c.method]); };
  await assert.rejects(scanEarlyChain(state, {}, failedRpc, nowMs), /timeout/);
  assert.equal(state.cursor, cursor);
});

test("source failures retain queued alerts and independent health with backoff", async () => {
  const state = createEarlySignalState();
  await runEarlySignalScan({ state, config: { mode: "chain" }, nowMs,
    rpcBatch: async () => { throw new Error("node unavailable"); } });
  assert.match(state.health.chain.lastError, /node unavailable/);
  assert.ok(state.health.chain.nextAttemptAtMs > nowMs);
  let called = false;
  await runEarlySignalScan({ state, config: { mode: "chain" }, nowMs: nowMs + 1, rpcBatch: async () => { called = true; } });
  assert.equal(called, false);
});

test("persisted outbox survives restart and acknowledgement is selective", () => {
  const dir = mkdtempSync(join(tmpdir(), "flap-early-test-"));
  try {
    const file = join(dir, "state.json"), state = createEarlySignalState();
    decodeEarlyReceipt(history.liquidityReceipt, state, { nowMs });
    saveEarlySignalState(file, state);
    const loaded = loadEarlySignalState(file), count = loaded.pendingChanges.length;
    acknowledgeEarlySignals(loaded, [loaded.pendingChanges[0].id]);
    assert.equal(loaded.pendingChanges.length, count - 1);
    assert.equal(earlyAssetStage(loaded, TOKEN), "prepared");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("public Flap pair cannot promote its new token or alert for an opened quote", () => {
  const state = createEarlySignalState();
  const quote = '0x205812cdbed920aff76c6580abd681a46d11efc7';
  const meme = '0x418257fbbc9832793d1a043c4311cd4afe407777';
  state.tokens[quote] = { reason: 'Safe 配置提案', effectiveEnabled: true };
  const logs = [log(DEX.v2Factory, [TOPICS.PairCreated, topic(quote), topic(meme)], '0x' + word(POOL) + word(1)),
    log(POOL, [TOPICS.V2Mint, topic(OWNER)], '0x' + word(10) + word(10), 1)];
  const publicReceipt = { ...receipt(logs), from: meme };
  decodeEarlyReceipt(publicReceipt, state, { nowMs });
  assert.equal(state.tokens[meme], undefined);
  assert.equal(state.pendingChanges.length, 0);
  assert.equal(shouldPrioritizeEarlyLog(logs[0], state), false);
  assert.equal(earlyLogFilters(state).some(f => Array.isArray(f.address) && f.address.includes(POOL)), false);
  state.tokens[quote].effectiveEnabled = false;
  decodeEarlyReceipt(publicReceipt, state, { nowMs });
  assert.ok(state.pendingChanges.length > 0);
  assert.ok(state.pendingChanges.every(e => e.token === quote));
  assert.equal(state.tokens[meme], undefined);
});

test("incoming dust to an executor does not turn a public pool into official preparation", () => {
  const state = createEarlySignalState();
  const stranger = '0x418257fbbc9832793d1a043c4311cd4afe407777';
  const logs = [log(DEX.v2Factory, [TOPICS.PairCreated, topic(TOKEN), topic(stranger)], '0x' + word(POOL) + word(1)),
    log(TOKEN, [TOPICS.Transfer, topic(stranger), topic(OWNER)], '0x' + word(1), 1)];
  decodeEarlyReceipt({ ...receipt(logs), from: stranger }, state, { nowMs });
  assert.equal(state.pendingChanges.some(e => e.kind === 'poolCreated'), false);
  assert.equal(state.tokens[stranger], undefined);
});

test("legacy pool-only candidates and queued alerts are removed without deleting independent evidence", () => {
  const dir = mkdtempSync(join(tmpdir(), 'flap-filter-test-'));
  try {
    const file = join(dir, 'state.json'), state = createEarlySignalState();
    state.schemaVersion = 1;
    state.tokens[TOKEN] = { reason: '已核验 DEX 建池' };
    state.tokens[OWNER] = { reason: 'CoW 采购目标' };
    state.events.pool = { id: 'pool', kind: 'poolCreated', token: TOKEN };
    state.events.config = { id: 'config', kind: 'configuration', token: TOKEN };
    state.events.order = { id: 'order', kind: 'order', token: OWNER };
    state.pendingChanges = Object.values(state.events);
    saveEarlySignalState(file, state);
    const loaded = loadEarlySignalState(file);
    assert.equal(loaded.tokens[TOKEN], undefined);
    assert.ok(loaded.tokens[OWNER]);
    assert.deepEqual(loaded.pendingChanges.map(e => e.id), ['order']);
    assert.equal(loaded.schemaVersion, 2);
    saveEarlySignalState(file, loaded);
    assert.deepEqual(loadEarlySignalState(file), loaded);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("early card omits boilerplate and misleading liquidity absence text", () => {
  const state = createEarlySignalState();
  decodeEarlyReceipt(history.liquidityReceipt, state, { nowMs });
  const content = buildEarlySignalContent(state.pendingChanges, state);
  assert.doesNotMatch(content, /准备动作不等于开放|尚未确认有流动性|不代表 Factory 开放/);
});
