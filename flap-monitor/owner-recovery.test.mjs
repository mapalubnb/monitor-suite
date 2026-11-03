import test from 'node:test';
import assert from 'node:assert/strict';
import { safeApiAddress } from './safe-api-address.mjs';
import { createEarlySignalState, decodeEarlyReceipt, scanAddressDiscovery } from './early-signal-monitor.mjs';
import { establishObservationCoverage } from './address-observation.mjs';
import { OWNER_MANAGEMENT_CONTRACT, CORE_PERMISSION_OWNERS } from './owner-catalog.mjs';
import { reconcileOperationObservations, OPERATION_KEY } from './pending-operations.mjs';

test('EIP-55 官方向量和实际 owner，拒绝畸形地址', () => {
  for (const a of ['0x52908400098527886E0F7030069857D2E4169EE7',
    '0xde709f2102306220921060314715629080e2fb77',
    '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    '0x25D1BE80daaE074D3FAF7987fb21bdfe791E2BBc']) assert.equal(safeApiAddress(a.toLowerCase()), a);
  assert.throws(() => safeApiAddress('0x123'), /地址无效/);
});

test('真实解码入口保留失败观察，不解码成功效果；重试去重且身份不符拒绝', () => {
  const state = createEarlySignalState(); establishObservationCoverage(state, {}, 1);
  const transaction = { hash: '0x' + 'a'.repeat(64), blockHash: '0x' + 'b'.repeat(64),
    blockNumber: '0x2', from: '0x' + 'c'.repeat(40), to: OWNER_MANAGEMENT_CONTRACT, value: '0x0', input: '0x69cdc163' };
  const receipt = { transactionHash: transaction.hash, blockHash: transaction.blockHash, blockNumber: '0x2', status: '0x0', logs: [] };
  const events = decodeEarlyReceipt(receipt, state, { transaction });
  assert.equal(events.length, 1); assert.equal(events[0].safeExecutionStatus, 'failed');
  assert.equal(decodeEarlyReceipt(receipt, state, { transaction }).length, 0);
  assert.equal(decodeEarlyReceipt(receipt, createEarlySignalState(), { transaction: { ...transaction, blockHash: '0x' + 'd'.repeat(64) } }).length, 0);
  const r = { operationPreview: true, mode: 'live', status: 'pending' };
  reconcileOperationObservations(state, { pendingRegistrations: { [`${transaction.hash}:${OPERATION_KEY}`]: r } });
  assert.equal(r.status, 'failed');
});

test('发现轮询按校验和请求和去重，恢复旧小写进度不重复请求', async () => {
  const state = createEarlySignalState(); const safe = '0x1d60bbbef79fb9540d271dbb01925380323a8f66';
  state.discoveryProgress = { safes: [], owners: [CORE_PERMISSION_OWNERS[0]] };
  const calls = [];
  await scanAddressDiscovery(state, { safes: [safe, safeApiAddress(safe)], relatedSafes: [safe] }, async url => {
    const path = new URL(url).pathname; const m = path.match(/\/(safes|owners)\/(0x[0-9a-fA-F]{40})\//);
    assert.ok(m); assert.equal(m[2], safeApiAddress(m[2])); calls.push(path);
    return new Response(JSON.stringify(m[1] === 'safes' ? { address: m[2], owners: [safeApiAddress(CORE_PERMISSION_OWNERS[0])], modules: [], threshold: 1 } : { safes: [] }), { status: 200 });
  }, Date.now());
  assert.equal(calls.filter(p => p.includes('/safes/' + safeApiAddress(safe) + '/')).length, 1);
  assert.ok(!calls.some(p => p.includes('/owners/' + safeApiAddress(CORE_PERMISSION_OWNERS[0]) + '/')));
  assert.equal(state.discoveryProgress, undefined); assert.ok(state.lastDiscoveryAt);
});
