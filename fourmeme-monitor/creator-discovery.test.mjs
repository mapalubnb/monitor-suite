import test from "node:test";
import assert from "node:assert/strict";
import { discoverCreators, verifyCreatorCandidate } from "./creator-discovery.mjs";

const contract = "0x" + "1".repeat(40);
const creator = "0x" + "2".repeat(40);
const txHash = "0x" + "3".repeat(64);
const blockHash = "0x" + "4".repeat(64);
function fixture() {
  const transaction = { hash: txHash, from: creator, to: null, blockHash, blockNumber: "0x10" };
  const receipt = { transactionHash: txHash, from: creator, contractAddress: contract, status: "0x1", blockHash, blockNumber: "0x10" };
  const block = { hash: blockHash, number: "0x10", transactions: [txHash] };
  const rpc = async calls => calls.map(call => call.method === "eth_getTransactionByHash" ? transaction : call.method === "eth_getTransactionReceipt" ? receipt : block);
  const candidate = { creator, txHash, source: "test" };
  const lookup = async (targets, local) => { local.creators[contract] = candidate; };
  return { transaction, receipt, block, rpc, candidate, lookup, contracts: [{ address: contract, labels: ["implementation"] }] };
}

test("创建者必须由匹配的直接创建回执和区块成员关系核验", async () => {
  const context = fixture();
  const result = await verifyCreatorCandidate(contract, context.candidate, context.rpc);
  assert.equal(result.creator, creator);
  assert.equal(result.evidence, "direct_creation_receipt");
  assert.equal(result.blockNumber, 16);
});

for (const [name, mutate] of [
  ["交易哈希", context => { context.receipt.transactionHash = "0x" + "5".repeat(64); }],
  ["区块哈希", context => { context.receipt.blockHash = "0x" + "5".repeat(64); }],
  ["失败回执", context => { context.receipt.status = "0x0"; }],
  ["创建地址", context => { context.receipt.contractAddress = creator; }],
  ["创建者", context => { context.transaction.from = contract; }],
  ["工厂内部创建", context => { context.transaction.to = creator; }],
  ["区块成员", context => { context.block.transactions = []; }],
]) test(`创建者拒绝未经验证的${name}`, async () => {
  const context = fixture();
  mutate(context);
  await assert.rejects(verifyCreatorCandidate(contract, context.candidate, context.rpc));
});

test("独立补全不需要历史游标或历史扫描成功", async () => {
  const context = fixture();
  const result = await discoverCreators({ ...context, now: () => 1000 });
  assert.equal(result.missingCount, 0);
  assert.equal(result.creators[contract].creator, creator);
  assert.equal(result.historyEndBlock, undefined);
});

test("来源 403 时持久化缺失原因，不伪造覆盖", async () => {
  const context = fixture();
  const result = await discoverCreators({ ...context, lookup: async () => { throw new Error("HTTP 403"); }, now: () => 1000 });
  assert.equal(result.missingCount, 1);
  assert.deepEqual(result.creators, {});
  assert.equal(result.pending[contract].lastError, "HTTP 403");
  assert.equal(result.pending[contract].nextRetryAt, 31000);
});

test("回执暂缺的候选重启后重试成功，冷却期间不请求", async () => {
  const context = fixture();
  let state = await discoverCreators({ ...context, rpc: async () => [null, null], now: () => 1000 });
  assert.equal(state.pending[contract].candidate.txHash, txHash);
  state = await discoverCreators({ ...context, previous: JSON.parse(JSON.stringify(state)), lookup: async () => assert.fail("冷却中不得查询"), rpc: async () => assert.fail("冷却中不得查询"), now: () => 2000 });
  state = await discoverCreators({ ...context, previous: state, now: () => 32000 });
  assert.equal(state.missingCount, 0);
});

test("已缓存创建者不重复查询，新补全不覆盖旧缓存", async () => {
  const context = fixture();
  const known = { [contract]: { creator } };
  const result = await discoverCreators({ ...context, known, lookup: async () => assert.fail("已知地址不查询") });
  assert.equal(result.missingCount, 0);
  assert.deepEqual(known, { [contract]: { creator } });
});

test("失败候选不发布，错误创建地址会丢弃候选重新找来源", async () => {
  const context = fixture();
  context.receipt.contractAddress = creator;
  const result = await discoverCreators({ ...context, now: () => 1000 });
  assert.equal(result.creators[contract], undefined);
  assert.equal(result.pending[contract].candidate, undefined);
  assert.match(result.pending[contract].lastError, /非目标/);
});

test("每轮最多核验两项，持久化候选轮转不会饿死后续地址", async () => {
  const context = fixture();
  const contracts = [1, 2, 3].map(value => ({ address: "0x" + String(value).repeat(40) }));
  const lookup = async (targets, local) => { for (const item of targets) local.creators[item.address] = context.candidate; };
  const result = await discoverCreators({ ...context, contracts, lookup, rpc: async () => [null, null], now: () => 1000 });
  assert.deepEqual(Object.values(result.pending).map(item => item.attempts), [1, 1, 0]);
  const next = await discoverCreators({ ...context, contracts, lookup, previous: result, rpc: async () => [null, null], now: () => 2000 });
  assert.equal(next.pending[contracts[2].address].attempts, 1);
  assert.equal(result.pending[contracts[2].address].attempts, 0);
});
