import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodePendingRegistration, ingestPendingRegistration, checkPendingRegistrations,
  observePendingReplacement, pendingRegistryContent } from './pending-registry.mjs';
import { ingestRegistryLog, drainRegistryNotifications, REGISTRY_TOPIC } from './registry-notifications.mjs';
import { DEFAULT_FLAP_ADMIN_SAFES, VAULT_PORTAL as portal } from './safe-proposal-monitor.mjs';
const a = digit => '0x' + digit.repeat(40), h = digit => '0x' + digit.repeat(64);
const word = value => BigInt(value).toString(16).padStart(64, '0');
const data = '0x4809625b' + word(a('1')) + word(1) + word(0) + word(1);
const tx = { hash: h('a'), from: a('2'), to: portal, input: data, nonce: '0x1', value: '0x0', chainId: '0x38', blockNumber: null, blockHash: null };
const safe = DEFAULT_FLAP_ADMIN_SAFES[1].toLowerCase();
const bytes = data => word((data.length - 2) / 2) + data.slice(2).padEnd(Math.ceil((data.length - 2) / 64) * 64, '0');
function safeCall(to, data, operation = 0) {
  const body = bytes(data);
  return '0x6a761202' + word(to) + word(0) + word(320) + word(operation) + word(0).repeat(3)
    + word(a('0')).repeat(2) + word(320 + body.length / 2) + body + bytes('0x' + '11'.repeat(65));
}
const event = { address: portal, topics: [REGISTRY_TOPIC], data: '0x' + word(a('1')) + word(1) + word(0) + word(1),
  blockNumber: '0x10', logIndex: '0x1', transactionHash: tx.hash, blockHash: h('b') };
function setup(mode = 'live') {
  const state = {};
  ingestPendingRegistration(state, decodePendingRegistration(tx), { now: 1000, mode });
  return { state, record: Object.values(state.pendingRegistrations)[0] };
}
const ingest = state => log => ingestRegistryLog(state, log, { portal, now: 1200 });

test('真实 Safe 金库注册交易回放，提取的工厂与链上通知一致', () => {
  const real = JSON.parse(readFileSync(new URL('./fixtures/registry-safe-execution.json', import.meta.url), 'utf8'));
  assert.deepEqual(decodePendingRegistration(real), []);
  const decoded = decodePendingRegistration({ ...real, blockNumber: null, blockHash: null });
  assert.equal(decoded.length, 1);
  assert.equal(decoded[0].vault, '0x8cff9ae6ae8c403654765f8695b0b73cd38cf4c5');
  assert.equal(decoded[0].viaSafe, true);
});

test('pending 只接受目标链、完整未打包交易和精确注册 ABI，支持 Safe 与 MultiSend', () => {
  assert.equal(decodePendingRegistration(tx)[0].vault, a('1'));
  const stx = { ...tx, to: safe, input: safeCall(portal, data) };
  assert.equal(decodePendingRegistration(stx)[0].viaSafe, true);
  const packed = '0x00' + portal.slice(2) + word(0) + word((data.length - 2) / 2) + data.slice(2);
  const multi = '0x8d80ff0a' + word(32) + bytes(packed);
  assert.equal(decodePendingRegistration({ ...stx, input: safeCall('0x40a2accbd92bca938b02010e17a5b8929b49130d', multi, 1) })[0].vault, a('1'));
  for (const patch of [{ to: a('3') }, { blockNumber: '0x1' }, { chainId: '0x1' }, { input: data + 'ff' },
    { input: '0x4809625b' + word(a('1')) + word(0) + word(0) + word(1) }, { hash: '0x' }, { nonce: 'invalid' },
    { to: safe, input: safeCall(portal, data, 1) }, { input: '0x' + 'a'.repeat(66000) }]) assert.deepEqual(decodePendingRegistration({ ...tx, ...patch }), []);
  assert.deepEqual(decodePendingRegistration(h('a')), []);
});

test('known factory 和重复交易不发预警，队列容量有界', () => {
  const { state } = setup();
  assert.equal(ingestPendingRegistration(state, decodePendingRegistration(tx)), 0);
  assert.equal(ingestPendingRegistration({ knownVaults: { [a('1')]: {} } }, decodePendingRegistration(tx)), 0);
  const full = { pendingRegistrations: Object.fromEntries(Array.from({ length: 256 }, (_, i) => [i, {}])) };
  assert.equal(ingestPendingRegistration(full, decodePendingRegistration(tx)), 0);
  assert.ok(full.pendingCapacityReachedAt);
});

test('只读模拟后预警，链上确认更新同一卡片且记录提前量', async () => {
  const { state, record } = setup();
  await checkPendingRegistrations(state, { now: () => 1100, rpc: async () => '0x', ingestLog: ingest(state) });
  assert.equal(record.status, 'pending');
  let sends = 0; const patches = [];
  await drainRegistryNotifications(state, { now: () => 1100, sendPending: async () => { sends++; return 'preview'; } });
  ingest(state)(event);
  await drainRegistryNotifications(state, { now: () => 1300, send: () => assert.fail('duplicate'), patch: async (r, version) => patches.push([r.messageId, version]) });
  assert.equal(sends, 1); assert.deepEqual(patches, [['preview', 'registered']]);
  assert.equal(record.pendingLeadMs, 200);
  assert.equal(Object.values(state.notifications)[0].messageId, 'preview');
});

test('日志先于模拟返回时只发确认卡；预警发送期间日志到达不重复', async () => {
  const first = setup();
  await checkPendingRegistrations(first.state, { now: () => 1100, rpc: async () => { ingest(first.state)(event); return '0x'; }, ingestLog: ingest(first.state) });
  assert.equal(first.record.status, 'registered');
  let sends = 0;
  await drainRegistryNotifications(first.state, { send: async () => { sends++; return 'mined'; }, sendPending: () => assert.fail('late preview') });
  assert.equal(sends, 1);
  const { state, record } = setup(); record.status = 'pending';
  await drainRegistryNotifications(state, { sendPending: async () => { ingest(state)(event); return 'inflight'; } });
  await drainRegistryNotifications(state, { send: () => assert.fail('duplicate'), patch: async r => assert.equal(r.messageId, 'inflight') });
  assert.equal(Object.values(state.notifications)[0].messageId, 'inflight');
});

test('预警失败持久重试，重启后成功上链不会重复新建卡片', async () => {
  const { state, record } = setup(); record.status = 'pending';
  let id;
  await drainRegistryNotifications(state, { now: () => 1000, sendPending: async (_r, key) => { id = key; throw Error('offline'); } });
  const restored = JSON.parse(JSON.stringify(state));
  await drainRegistryNotifications(restored, { now: () => 4000, sendPending: async (_r, key) => { assert.equal(key, id); return 'retry'; } });
  ingest(restored)(event);
  await drainRegistryNotifications(restored, { now: () => 5000, patch: async r => assert.equal(r.messageId, 'retry'), send: () => assert.fail('duplicate') });
});

test('模拟失败不发预警，查不到回执只记待核验，observe 模式不发预警', async () => {
  const { state, record } = setup();
  await checkPendingRegistrations(state, { now: () => 1100, rpc: async () => { throw Error('bad signature'); } });
  assert.equal(record.status, 'checking');
  await drainRegistryNotifications(state, { sendPending: () => assert.fail('unverified') });
  record.status = 'pending'; record.simulatedAt = 'date'; record.nextCheckAt = 0;
  await checkPendingRegistrations(state, { now: () => 62000, rpc: async () => null });
  assert.equal(record.status, 'unverified'); assert.doesNotMatch(pendingRegistryContent(record), /执行失败|已取消/);
  const observe = setup('observe'); observe.record.status = 'pending';
  await drainRegistryNotifications(observe.state, { sendPending: () => assert.fail('observe') });
});

test('失败、无注册与替换以当前链回执为据，匹配 nonce 的 pending 本身不判替换', async () => {
  for (const status of [0, 1]) {
    const { state, record } = setup(); Object.assign(record, { status: 'pending', simulatedAt: 'yes' });
    await checkPendingRegistrations(state, { now: () => 1100, ingestLog: ingest(state), rpc: async method => method === 'eth_getTransactionReceipt'
      ? { transactionHash: tx.hash, blockHash: h('b'), blockNumber: '0x10', status, logs: [] } : { hash: h('b') } });
    assert.equal(record.status, status ? 'noRegistration' : 'failed');
  }
  const { state, record } = setup(); Object.assign(record, { status: 'pending', simulatedAt: 'yes' });
  observePendingReplacement(state, { from: tx.from, nonce: 1, hash: h('c') });
  assert.equal(record.status, 'pending');
  await checkPendingRegistrations(state, { now: () => 1100, rpc: async (method, params) => method === 'eth_getBlockByNumber' ? { hash: h('b') }
    : params[0] === tx.hash ? null : { transactionHash: h('c'), blockHash: h('b'), blockNumber: '0x10' } });
  assert.equal(record.status, 'replaced');
});

test('receipt 补漏保留原注册事件去重，确认卡片重组仍正确撤回', async () => {
  const { state, record } = setup(); Object.assign(record, { status: 'pending', simulatedAt: 'yes', messageId: 'preview' });
  await checkPendingRegistrations(state, { now: () => 1100, ingestLog: ingest(state), rpc: async method => method === 'eth_getTransactionReceipt'
    ? { transactionHash: tx.hash, blockHash: h('b'), blockNumber: '0x10', status: 1, logs: [event] } : { hash: h('b') } });
  assert.equal(record.status, 'registered');
  await drainRegistryNotifications(state, { patch: async () => {} });
  ingest(state)({ ...event, removed: true });
  const versions = [];
  await drainRegistryNotifications(state, { patch: async (_r, version) => versions.push(version) });
  assert.deepEqual(versions, ['revoked']);
});

test('确认卡片尚未编辑时发生重组，原 pending 卡片仍得到纠正', async () => {
  const { state, record } = setup(); Object.assign(record, { status: 'pending', messageId: 'preview', patchedStatus: 'pending' });
  ingest(state)(event);
  ingest(state)({ ...event, removed: true });
  assert.equal(record.status, 'withdrawn');
  await drainRegistryNotifications(state, { send: () => assert.fail('orphan'), patchPending: async r => {
    assert.equal(r.messageId, 'preview'); assert.match(pendingRegistryContent(r), /区块重组撤回/);
  } });
  assert.equal(record.patchedStatus, 'withdrawn');
});
