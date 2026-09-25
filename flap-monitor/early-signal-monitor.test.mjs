import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEarlySignalState, decodeEarlyReceipt, ingestCowOrders, earlyAssetStage, syncEarlyProposals,
  rewindEarlySignals, scanEarlyChain, refreshEarlyAssets, buildEarlySignalContent, loadEarlySignalState,
  saveEarlySignalState, acknowledgeEarlySignals, runEarlySignalScan, earlyLogFilters } from "./early-signal-monitor.mjs";
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
