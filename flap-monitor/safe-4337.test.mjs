import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeHandleOps, decodeSafeUserOperation, userOperationResult, ENTRY_POINT_V07, USER_OPERATION_EVENT, operationKey4337 } from './erc4337-codec.mjs';
import { createEarlySignalState, decodeEarlyReceipt, earlyLogFilters, watchedWallets, rewindEarlySignals, processEarlyReceiptHints, scanEarlyChain, buildEarlySignalContent } from './early-signal-monitor.mjs';
import { establishObservationCoverage } from './address-observation.mjs';
import { observedSafeConfig, safeDiscoveryCandidates, verifySafeDiscoveries, verifyApiObservedSafe, SAFE_PROXY_RUNTIME, mergeObservedSafes } from './safe-observation.mjs';
import { decodePendingOperation, checkPendingOperation, reconcileOperationObservations } from './pending-operations.mjs';
import { ingestPendingRegistration } from './pending-registry.mjs';
import { earlyNotificationPriority } from './early-signal-notifications.mjs';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/safe-4337-20261021.json', import.meta.url), 'utf8').replace(/^\uFEFF/, ''));
const { transaction: tx, receipt } = fixture;
const safe = '0xdfee42acb3fce076033edcf2084687340b8f2fab';
const owner = '0x0806d3920dafd50e8ceb189c82d2d3a217e2a045';
const singleton = '0x41675c099f32341bf84bfc5382af534df5c7461a';
const alternate = '0x2222222222222222222222222222222222222222';
const now = Date.parse('2026-10-21T08:51:00Z');
const word = x => (typeof x === 'string' && x.startsWith('0x') ? x.slice(2) : BigInt(x).toString(16)).padStart(64, '0');
const bytes = h => word((h.length - 2) / 2) + h.slice(2).padEnd(Math.ceil((h.length - 2) / 64) * 64, '0');
const topic = x => '0x' + word(x);
const pendingTx = t => ({ ...t, blockHash: null, blockNumber: null });
const realOp = decodeHandleOps(tx)[0];
function batch(ops) {
  const tuples = ops.map(op => {
    const c = bytes(op.callData);
    return word(op.sender) + word(op.userOpNonce) + word(288) + word(320) + word(0) + word(0) + word(0)
      + word(320 + c.length / 2) + word(352 + c.length / 2) + word(0) + c + word(0) + word(0);
  });
  let offset = ops.length * 32;
  const offsets = tuples.map(t => { const o = word(offset); offset += t.length / 2; return o; });
  return { ...tx, input: '0x765e827f' + word(64) + word(tx.from) + word(ops.length) + offsets.join('') + tuples.join('') };
}
const stateWithCoverage = () => { const s = createEarlySignalState(); establishObservationCoverage(s, {}, Number(receipt.blockNumber)); return s; };

test('真实 ERC4337 回放：授权与模块结果可见，不变成官方或底池准备', () => {
  const s = stateWithCoverage();
  const events = decodeEarlyReceipt(receipt, s, { transaction: tx, nowMs: now });
  const e = events.find(e => e.via4337);
  assert.equal(e.actor, safe); assert.equal(e.safeExecutionStatus, 'executed');
  assert.equal(e.userOpHash, '0x4b3b1eeaa75f4109343072dec98a24001d5b099acf8c3b59e086834e67695d90');
  assert.match(e.detail, /无限额度/); assert.match(e.detail, /000000000022d473030f116ddee9f6b43ac78ba3/);
  assert.match(e.detail, /不代表官方/); assert.equal(earlyNotificationPriority(events, s, now), 'immediate');
  assert.deepEqual(s.stages, {}); assert.deepEqual(s.positions, {}); assert.equal(watchedWallets().includes(safe), false);
  assert.ok(JSON.stringify(earlyLogFilters(s)).includes(safe));
  assert.equal(decodeEarlyReceipt(receipt, s, { transaction: tx }).length, 0);
  assert.match(buildEarlySignalContent(events, s), /无限额度/);
});

test('ERC4337 pending 保存每个操作身份且不保存可执行签名', () => {
  const p = decodePendingOperation(pendingTx(tx)); assert.equal(p.length, 1);
  assert.equal(p[0].vault, operationKey4337(realOp)); assert.equal(p[0].data, undefined);
  assert.equal(p[0].actions[0].kind, 'approval'); assert.equal(p[0].actions[0].rawData, undefined);
  const state = {}; assert.equal(ingestPendingRegistration(state, p, { now }), 1);
  assert.equal(ingestPendingRegistration(state, p, { now }), 0);
});

test('批量 UserOperation 隔离账户/nonce：一笔失败不冒用另一笔成功', () => {
  const second = { ...realOp, sender: alternate, userOpNonce: '2' };
  const b = batch([realOp, second]); const parsed = decodeHandleOps(b); assert.equal(parsed.length, 2);
  const r = structuredClone(receipt), last = structuredClone(r.logs.at(-1));
  last.topics[2] = topic(alternate); last.topics[1] = '0x' + '22'.repeat(32);
  last.data = '0x' + word(2) + word(0) + word(0) + word(0); last.logIndex = '0xe3'; r.logs.push(last);
  assert.equal(userOperationResult(r, parsed[0]).status, 'executed');
  assert.equal(userOperationResult(r, parsed[1]).status, 'failed');
  assert.equal(decodePendingOperation(pendingTx(b)).length, 1);
  const both = decodePendingOperation(pendingTx(b), { relatedSafes: [safe, alternate] });
  assert.equal(both.length, 2); assert.notEqual(both[0].vault, both[1].vault);
  const s = stateWithCoverage(); s.observationCoverage[alternate] = 0;
  const es = decodeEarlyReceipt(r, s, { transaction: b, config: { relatedSafes: [safe, alternate] } }).filter(e => e.via4337);
  assert.equal(es.length, 2); assert.notEqual(es[0].id, es[1].id);
  assert.match(es[1].detail, /拟执行调用/);
});

test('拒绝伪 EntryPoint、重叠 ABI、超限和重复身份，未知调用仍有观察提醒', () => {
  assert.deepEqual(decodeHandleOps({ ...tx, to: alternate }), []);
  assert.throws(() => decodeHandleOps({ ...tx, input: tx.input.slice(0, 90) }));
  assert.throws(() => decodeHandleOps(batch([realOp, realOp])));
  assert.throws(() => decodeHandleOps(batch(Array.from({ length: 65 }, (_, i) => ({ ...realOp, userOpNonce: String(i) })))));
  const unknown = batch([{ ...realOp, callData: '0xdeadbeef' }]);
  assert.equal(decodeSafeUserOperation(decodeHandleOps(unknown)[0])[0].kind, 'unknown');
  assert.equal(decodePendingOperation(pendingTx(unknown)).length, 1);
  assert.match(decodeEarlyReceipt(receipt, stateWithCoverage(), { transaction: unknown }).find(e => e.via4337).detail, /模块操作待解析/);
});

test('模块预付 gas 成功、缺失/伪造/重复 UserOperationEvent 不得确认执行', () => {
  for (const mutate of [
    r => { r.logs = r.logs.filter(l => l.topics[0] !== USER_OPERATION_EVENT); },
    r => { r.logs.at(-1).address = alternate; },
    r => { r.logs.push(structuredClone(r.logs.at(-1))); },
    r => { r.logs.find(l => l.logIndex === '0xe1').logIndex = '0xde'; },
  ]) { const r = structuredClone(receipt); mutate(r); assert.equal(userOperationResult(r, realOp).status, 'unverified'); }
  assert.equal(userOperationResult({ ...receipt, status: '0x0', logs: [] }, realOp).status, 'failed');
});

test('ERC4337 回执更新独立预警；外层模拟不声称单笔成功，重组撤回', async () => {
  const r = { ...decodePendingOperation(pendingTx(tx))[0], status: 'checking', firstSeenAt: new Date(now).toISOString() };
  const block = { number: receipt.blockNumber, hash: receipt.blockHash, timestamp: '0x6ad79c0f' };
  let reorg = false;
  const rpc = async method => ({ eth_getTransactionByHash: tx, eth_call: '0x', eth_getTransactionReceipt: receipt,
    eth_getBlockByNumber: { ...block, hash: reorg ? '0x' + 'ff'.repeat(32) : block.hash } })[method];
  await checkPendingOperation(r, {}, { rpc, now: () => now, persist() {} });
  assert.equal(r.status, 'unverified'); assert.notEqual(r.simulationStatus, 'passed');
  await checkPendingOperation(r, {}, { rpc, now: () => now + 10000, persist() {} });
  assert.equal(r.status, 'executed'); assert.equal(r.data, undefined);
  reorg = true;
  await checkPendingOperation(r, {}, { rpc, now: () => now + 20000, persist() {} });
  assert.equal(r.status, 'withdrawn');
});

test('ERC4337 确认归并匹配 UserOperation，不能串到普通 Safe pending', () => {
  const s = stateWithCoverage(); decodeEarlyReceipt(receipt, s, { transaction: tx });
  const pending = {}; const [p] = decodePendingOperation(pendingTx(tx)); ingestPendingRegistration(pending, [p], { now });
  const ordinary = { operationPreview: true, mode: 'live', status: 'checking' };
  pending.pendingRegistrations[`${tx.hash}:@operation`] = ordinary;
  const result = reconcileOperationObservations(s, pending);
  assert.equal(result.heldIds.size, 1);
  assert.equal(pending.pendingRegistrations[`${tx.hash}:${p.vault}`].status, 'executed');
  assert.equal(ordinary.status, 'checking');
});

test('ERC4337 缺失或歧义结果保持待核验，完整回执到达后才确认', async () => {
  for (const mutate of [
    r => { r.logs = r.logs.filter(l => l.topics[0] !== USER_OPERATION_EVENT); },
    r => { r.logs.push(structuredClone(r.logs.at(-1))); },
  ]) {
    const r = { ...decodePendingOperation(pendingTx(tx))[0], status: 'unverified', firstSeenAt: new Date(now).toISOString() };
    let currentReceipt = structuredClone(receipt), persisted;
    mutate(currentReceipt);
    const rpc = async method => ({ eth_getTransactionReceipt: currentReceipt,
      eth_getBlockByNumber: { number: receipt.blockNumber, hash: receipt.blockHash, timestamp: '0x6ad79c0f' } })[method];
    const persist = () => { persisted = structuredClone(r); };
    await checkPendingOperation(r, {}, { rpc, now: () => now, persist });
    assert.equal(r.status, 'unverified');
    assert.equal(r.confirmedBlockHash, undefined);
    assert.ok(r.lastError); assert.equal(persisted.status, 'unverified');
    currentReceipt = receipt;
    await checkPendingOperation(r, {}, { rpc, now: () => now + 10000, persist });
    assert.equal(persisted.status, 'executed'); assert.equal(r.lastError, '');
    assert.equal(r.confirmedBlockHash, receipt.blockHash);
  }
});

const ownerResult = '0x' + word(32) + word(1) + word(owner);
const mockVerify = async calls => calls.map(c => c.method === 'eth_getStorageAt' ? topic(singleton)
  : c.method === 'eth_getCode' ? SAFE_PROXY_RUNTIME : c.params[0].data === '0xa0e67e2b' ? ownerResult : topic(1));

test('真实创建回执：可信工厂+初始化关联+区块 getter 三者核验后启用观察', async () => {
  const s = createEarlySignalState(); assert.equal(safeDiscoveryCandidates(receipt, s).length, 1);
  const es = await verifySafeDiscoveries(receipt, s, {}, mockVerify, now, Date.parse('2026-10-20T16:51:27Z'));
  assert.equal(es.length, 1); assert.equal(s.observationCoverage[safe], Number(receipt.blockNumber));
  assert.match(es[0].detail, /2026\/10\/21 00:51:27/);
  assert.equal(s.observedSafes[safe].observationOnly, true);
  const restored = JSON.parse(JSON.stringify(s));
  assert.ok(observedSafeConfig(restored).relatedSafes.includes(safe));
  assert.equal((await verifySafeDiscoveries(receipt, s, {}, mockVerify, now)).length, 0);
  rewindEarlySignals(s, Number(receipt.blockNumber)); assert.equal(s.observedSafes[safe], undefined);
});

test('伪造工厂/实现/owner 以及链上 owner 不匹配，不能扩展持续观察', async () => {
  const r = structuredClone(receipt); r.logs.find(l => l.topics[0].startsWith('0x4f51')).address = alternate;
  assert.equal(safeDiscoveryCandidates(r, createEarlySignalState()).length, 0);
  const badOwner = async calls => (await mockVerify(calls)).map((v, i) => calls[i].params[0]?.data === '0xa0e67e2b' ? '0x' + word(32) + word(1) + word(alternate) : v);
  const s = createEarlySignalState(); assert.equal((await verifySafeDiscoveries(receipt, s, {}, badOwner, now)).length, 0);
  assert.equal(s.observedSafes, undefined);
});

test('新 Safe 快速通道同笔发现并解析授权，重启/HTTP 重放不重复', async () => {
  const f = JSON.parse(JSON.stringify(fixture).replaceAll(safe.slice(2), alternate.slice(2)));
  const s = createEarlySignalState(); s.chainBaselineAt = new Date(now).toISOString(); s.cursor = Number(receipt.blockNumber) - 1;
  const block = { number: receipt.blockNumber, hash: receipt.blockHash, timestamp: '0x6ad79c0f' };
  const rpc = async calls => Promise.all(calls.map(async c => {
    if (c.method === 'eth_chainId') return '0x38';
    if (c.method === 'eth_blockNumber') return receipt.blockNumber;
    if (c.method === 'eth_getBlockByNumber') return block;
    if (c.method === 'eth_getTransactionReceipt') return f.receipt;
    if (c.method === 'eth_getTransactionByHash') return f.transaction;
    return (await mockVerify([c]))[0];
  }));
  await processEarlyReceiptHints(s, [{ transactionHash: tx.hash, blockHash: receipt.blockHash, blockNumber: receipt.blockNumber }], {}, rpc, now);
  assert.ok(s.pendingChanges.some(e => e.kind === 'safeDiscovery'));
  assert.ok(s.pendingChanges.some(e => e.via4337 && /无限额度/.test(e.detail)));
  assert.ok(JSON.stringify(earlyLogFilters(s)).includes(alternate));
  assert.equal(watchedWallets(observedSafeConfig(s)).includes(alternate), false);
  const restored = JSON.parse(JSON.stringify(s));
  assert.equal(decodeEarlyReceipt(f.receipt, restored, { transaction: f.transaction }).length, 0);
});

test('API 补漏必须验证真实 Safe runtime，失败不加入名单', async () => {
  const block = { number: receipt.blockNumber, hash: receipt.blockHash };
  const rpc = async calls => Promise.all(calls.map(async c => c.method === 'eth_getBlockByNumber' ? block : (await mockVerify([c]))[0]));
  const s = createEarlySignalState(); assert.ok(await verifyApiObservedSafe(alternate, s, rpc, now));
  const spoof = async calls => Promise.all(calls.map(async c => c.method === 'eth_getCode' ? '0x1234' : (await rpc([c]))[0]));
  const bad = createEarlySignalState(); assert.equal(await verifyApiObservedSafe(alternate, bad, spoof, now), null);
  assert.equal(bad.observedSafes, undefined);
});

test('未知 bundle 与超限输入保留链上 UserOperation 待解析提醒', () => {
  for (const input of ['0x12345678', '0x765e827f' + '00'.repeat(131073)]) {
    const events = decodeEarlyReceipt(receipt, stateWithCoverage(), { transaction: { ...tx, input } });
    const event = events.find(e => e.via4337);
    assert.ok(event); assert.match(event.detail, /待解析/); assert.equal(event.actor, safe);
  }
});

test('API 核验跨 await 不覆盖快速发现，也不提交重组前的观察名单', async () => {
  const block = { number: receipt.blockNumber, hash: receipt.blockHash };
  for (const reorg of [false, true]) {
    const s = createEarlySignalState();
    const earlier = { blockNumber: Number(receipt.blockNumber) - 5, replayFrom: Number(receipt.blockNumber) - 5 };
    const rpc = async calls => {
      if (calls[0].method === 'eth_getBlockByNumber') {
        if (calls[0].params[0] !== 'latest') {
          if (reorg) rewindEarlySignals(s, Number(receipt.blockNumber));
          else { s.observedSafes = { [alternate]: earlier }; s.observationCoverage[alternate] = earlier.blockNumber; }
        }
        return [block];
      }
      return mockVerify(calls);
    };
    s.observationCoverage ||= {};
    if (reorg) {
      await assert.rejects(verifyApiObservedSafe(alternate, s, rpc, now), /重组/);
      assert.equal(s.observedSafes?.[alternate], undefined);
    } else {
      assert.equal(await verifyApiObservedSafe(alternate, s, rpc, now), null);
      assert.equal(s.observedSafes[alternate], earlier);
      assert.equal(s.observationCoverage[alternate], earlier.blockNumber);
    }
  }
});

test('并发发现合并不覆盖已推进的补扫位置或较新的根 owner', () => {
  const s = { observedSafes: { [safe]: { replayFrom: 100 } }, ownerRelations: { [safe]: { blockNumber: 20, owners: [owner] } } };
  mergeObservedSafes(s, { observedSafes: { [safe]: { replayFrom: 80 }, [alternate]: { replayFrom: 90 } }, observationCoverage: { [alternate]: 90 },
    ownerRelations: { [safe]: { blockNumber: 10, owners: [] } } });
  assert.equal(s.observedSafes[safe].replayFrom, 100);
  assert.equal(s.observedSafes[alternate].replayFrom, 90);
  assert.deepEqual(s.ownerRelations[safe].owners, [owner]);
});

test('创建后同窗口下一笔操作由持久补扫捕获，不倒退主游标', async () => {
  const f = JSON.parse(JSON.stringify(fixture).replaceAll(safe.slice(2), alternate.slice(2)));
  const nextHash = '0x' + '99'.repeat(32);
  const r2 = { ...f.receipt, transactionHash: nextHash, transactionIndex: '0x2', logs: f.receipt.logs.filter(l => Number(l.logIndex) >= 223)
    .map(l => ({ ...l, transactionHash: nextHash })) };
  const t2 = { ...f.transaction, hash: nextHash, transactionIndex: '0x2' };
  const n = Number(receipt.blockNumber), s = createEarlySignalState();
  s.chainBaselineAt = new Date(now).toISOString(); s.realtimeCursor = n - 1;
  const rpc = async calls => Promise.all(calls.map(async c => {
    if (c.method === 'eth_chainId') return '0x38';
    if (c.method === 'eth_blockNumber') return '0x' + (n + 8).toString(16);
    if (c.method === 'eth_getBlockByNumber') return { number: c.params[0], hash: receipt.blockHash, timestamp: '0x6ad79c0f', transactions: c.params[0] === receipt.blockNumber ? [f.transaction, t2] : [] };
    if (c.method === 'eth_getLogs') {
      if (JSON.stringify(c.params[0]).includes('4f51faf6')) return [f.receipt.logs.find(l => l.topics[0].includes('4f51faf6'))];
      if (JSON.stringify(c.params[0]).includes(alternate.slice(2))) return [r2.logs.at(-1)];
      return [];
    }
    if (c.method === 'eth_getTransactionReceipt') return c.params[0] === nextHash ? r2 : f.receipt;
    return (await mockVerify([c]))[0];
  }));
  await scanEarlyChain(s, { realtime: true }, rpc, now);
  assert.equal(s.observedSafes[alternate].replayFrom, n);
  assert.equal(s.realtimeCursor, n + 8);
  const restored = JSON.parse(JSON.stringify(s));
  await scanEarlyChain(restored, { realtime: true }, rpc, now + 1000);
  assert.equal(restored.realtimeCursor, n + 8);
  assert.equal(restored.observedSafes[alternate].replayFrom, undefined);
  assert.ok(Object.values(restored.events).some(e => e.via4337 && e.transactionHash === nextHash));
});

test('经外层路由器进入 EntryPoint 的操作保留事件提醒', () => {
  const events = decodeEarlyReceipt(receipt, stateWithCoverage(), { transaction: { ...tx, to: alternate, input: '0x12345678' } });
  assert.ok(events.some(e => e.via4337 && /待解析/.test(e.detail)));
});
