import test from 'node:test';
import assert from 'node:assert/strict';
import { OWNER_CATALOG, CORE_PERMISSION_OWNERS, OWNER_MANAGEMENT_CONTRACT as manager, NESTED_OWNER_SAFE, annotateOwners } from './owner-catalog.mjs';
import { observationAddresses, RELATED_SAFES } from './early-signal-catalog.mjs';
import { extractFlapProposalActions, buildSafeProposalContent } from './safe-proposal-monitor.mjs';
import { observeAddressTransaction, establishObservationCoverage } from './address-observation.mjs';
import { createEarlySignalState, watchedWallets, earlyLogFilters, buildEarlySignalContent } from './early-signal-monitor.mjs';
import { createContractIntegrityState, runContractIntegrityStateScan, contractIntegritySubscriptionAddresses } from './contract-integrity-monitor.mjs';

const word = n => BigInt(n).toString(16).padStart(64, '0');
const addr = a => a.slice(2).padStart(64, '0');
const factory = '0x8e097e40cd5fc5c32d4231a64b50e10e5dce9791';
// Same ABI payload as Safe nonce 190 (0x7e6ff4...a4d3), without signatures.
const batch = inner => '0x69cdc163' + [word(96), word(160), word(224), word(1), addr(factory), word(1), word(0), word(1), word(32), word((inner.length - 2) / 2), inner.slice(2).padEnd(Math.ceil((inner.length - 2) / 64) * 64, '0')].join('');

test('owner coverage: 14 core, 3 enhanced, 6 nested; never promote liquidity trust', () => {
  assert.equal(CORE_PERMISSION_OWNERS.length, 14);
  assert.equal(Object.values(OWNER_CATALOG).filter(o => o.priority === 'enhanced').length, 3);
  assert.equal(Object.values(OWNER_CATALOG).filter(o => o.priority === 'nested').length, 6);
  for (const a of Object.keys(OWNER_CATALOG)) assert.ok(observationAddresses().includes(a));
  assert.ok(RELATED_SAFES.some(a => a.toLowerCase() === NESTED_OWNER_SAFE));
  assert.equal(RELATED_SAFES.find(a => a.toLowerCase() === NESTED_OWNER_SAFE), '0x1d60bBBEF79Fb9540D271Dbb01925380323A8f66');
  assert.ok(!watchedWallets().includes(manager));
  assert.ok(!watchedWallets().includes(NESTED_OWNER_SAFE));
  assert.ok(earlyLogFilters(createEarlySignalState()).some(f => f.address === manager && !f.topics));
});

test('manager nonce 190 expands address-bound batch; malformed and foreign calls remain unknown', () => {
  const decode = tx => extractFlapProposalActions(tx, { includeOperations: true });
  const action = decode({ to: manager, data: batch('0x59f0115e') });
  assert.equal(action.length, 1);
  assert.equal(action[0].kind, 'vaultCreationEnable');
  assert.equal(action[0].to, factory);
  assert.equal(action[0].callPath, '0.manager.0');
  assert.equal(decode({ to: manager, data: batch('0xdeadbeef') })[0].kind, 'unknown');
  assert.equal(decode({ to: factory, data: batch('0x59f0115e') })[0].kind, 'unknown');
  assert.equal(decode({ to: manager, data: batch('0x59f0115e'), operation: 1 })[0].kind, 'unknown');
  for (const bad of ['0x69cdc163', batch('0x59f0115e').slice(0, -64), '0x69cdc163' + word(0).repeat(3)])
    assert.equal(decode({ to: manager, data: bad })[0].kind, 'unknown');
  const mismatched = batch('0x59f0115e');
  assert.equal(decode({ to: manager, data: mismatched.slice(0, 10 + 160 * 2) + word(2) + mismatched.slice(10 + 192 * 2) })[0].kind, 'unknown');
});

test('third-party zero-value owner calls and failures are observable, without official attribution', () => {
  const state = createEarlySignalState(); establishObservationCoverage(state, {}, 1);
  const hash = '0x' + 'a'.repeat(64), blockHash = '0x' + 'b'.repeat(64);
  const tx = { from: '0x' + 'c'.repeat(40), to: manager, value: '0x0', hash, blockHash, blockNumber: '0x2', input: batch('0x59f0115e') };
  const receipt = { transactionHash: hash, blockHash, blockNumber: '0x2', status: '0x1', logs: [] };
  const events = observeAddressTransaction(receipt, tx, state, {}, new Set());
  assert.equal(events.length, 1); assert.equal(events[0].observationOnly, true);
  assert.match(events[0].detail, /开启信号奖励金库创建/);
  assert.equal(observeAddressTransaction({ ...receipt, status: '0x0' }, tx, state, {}, new Set())[0].safeExecutionStatus, 'failed');
  assert.equal(observeAddressTransaction(receipt, { ...tx, input: '0x' }, state, {}, new Set()).length, 0);
  const card = buildEarlySignalContent([{ ...events[0], id: 'x' }], state);
  assert.match(card, /业务 Safe 合约 owner/);
});

test('owner card labels preserve links, deduplicate, and label unknown owners', () => {
  const content = `[${manager}](https://bscscan.com/address/${manager})`;
  const marked = annotateOwners(content);
  assert.ok(marked.startsWith(content)); assert.equal(annotateOwners(marked), marked);
  assert.equal(marked, `${content}（${OWNER_CATALOG[manager].label}）`);
  assert.doesNotMatch(marked, /Owner 标注/);
  const unknown = '0x' + 'd'.repeat(40);
  const card = buildSafeProposalContent([{ type: 'ready', safe: NESTED_OWNER_SAFE, confirmationOwners: [unknown],
    actions: [{ kind: 'safeOwner', action: '新增', account: manager, threshold: '1' }], confirmations: 1, required: 1 }]);
  assert.match(card, /核心权限/); assert.match(card, /角色待核验/); assert.doesNotMatch(card, /官方 owner/);
});

test('Safe proposal roles stay next to signer and Safe links through repeated delivery formatting', () => {
  const signer = '0x949ab4eeef712770861eaaa956d4e3a26ba9a8cf';
  const card = buildSafeProposalContent([{ type: 'proposed', safe: NESTED_OWNER_SAFE,
    confirmationOwners: [signer], actions: [], confirmations: 1, required: 3, nonce: 388 }]);
  for (const a of [signer, NESTED_OWNER_SAFE]) {
    const label = `（${OWNER_CATALOG[a].label}）`;
    assert.equal(card.split(label).length - 1, 1);
    assert.ok(card.includes(`)${label}`));
  }
  assert.doesNotMatch(card, /Owner 标注/);
  assert.equal(annotateOwners(annotateOwners(card)), card);
});

test('queued legacy legends are removed without deleting following content or duplicating existing roles', () => {
  const link = `[${manager}](https://bscscan.com/address/${manager})`;
  const label = `（${OWNER_CATALOG[manager].label}）`;
  const legacy = `${link}${label}${label}\n\nOwner 标注（权限关系，不代表官方身份）：\n• ${link}：${OWNER_CATALOG[manager].label}\n\n后续交易信息`;
  const formatted = annotateOwners(legacy);
  assert.equal(formatted, `${link}${label}\n\n后续交易信息`);
  assert.equal(annotateOwners(formatted), formatted);
  assert.doesNotMatch(formatted, /Owner 标注|• /);
});

test('role annotation leaves URLs, transaction hashes and unknown addresses intact', () => {
  const url = `https://bscscan.com/address/${manager}`;
  const hash = manager + 'a'.repeat(24);
  const unrelated = `原链接 ${url}\n[查看地址](${url})\nSafeTxHash：${hash}\n0x${'f'.repeat(40)}`;
  assert.equal(annotateOwners(unrelated), unrelated);
  const plain = `管理入口：${manager.toUpperCase().replace('0X', '0x')}`;
  assert.equal(annotateOwners(plain), `${plain}（${OWNER_CATALOG[manager].label}）`);
});

test('owner integrity detects 7702 removal, proxy implementation and nested threshold changes', async () => {
  const state = createContractIntegrityState();
  const eoa = CORE_PERMISSION_OWNERS[0];
  state.catalog = Object.fromEntries([eoa, manager, NESTED_OWNER_SAFE].map(a => [a, state.catalog[a]]));
  assert.ok(contractIntegritySubscriptionAddresses(state).includes(manager));
  let phase = 0;
  const result = c => {
    if (c.method === 'eth_getCode') return c.params[0] === eoa ? phase ? '0x' : '0xef0100' + '1'.repeat(40) : '0x6000';
    if (c.method === 'eth_getStorageAt') return '0x' + addr(phase ? '0x' + '3'.repeat(40) : '0x' + '2'.repeat(40));
    const d = c.params[0].data;
    if (d === '0xe75235b8') return '0x' + word(phase ? 2 : 3);
    if (d === '0xa0e67e2b') return '0x' + word(32) + word(1) + addr(eoa);
    if (d.startsWith('0xcc2f8452')) return '0x' + word(64) + word(1) + word(0);
    return '0x' + addr('0x' + '4'.repeat(40));
  };
  const opts = { state, extended: true, rpcCall: async m => m === 'eth_chainId' ? '0x38' : phase ? '0x65' : '0x64', rpcBatch: async cs => cs.map(result) };
  await runContractIntegrityStateScan(opts); assert.equal(state.pendingChanges.length, 0);
  phase = 1; await runContractIntegrityStateScan(opts);
  assert.ok(state.pendingChanges.some(c => c.field === 'EIP-7702 委托目标' && c.current === ''));
  assert.ok(state.pendingChanges.some(c => c.address === manager && c.field === 'implementation'));
  assert.ok(state.pendingChanges.some(c => c.address === NESTED_OWNER_SAFE && c.field === 'threshold'));
  assert.ok(!state.trackedAssets[eoa]);
});
