import test from 'node:test';
import assert from 'node:assert/strict';
import { contractIdentity, prepareContractObservations, contractObservationTargets, reconcileContractObservations } from './contract-observation.mjs';
import { createTransactionalOutbox } from '../shared/transactional-outbox.mjs';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.FOURMEME_MONITOR_TEST = '1';
const { __testables: api } = await import('./monitor.mjs');
const A = '0x2b6e6e4def77583229299cf386438a227e683b28';
const B = '0xee5617402708bc9560772f753213ddae852c38ed';
const C = '0x3333333333333333333333333333333333333333';
const D = '0x4444444444444444444444444444444444444444';
const fp = (address, extra = {}) => ({ address, codeHash: address, codeSize: address === A ? 7280 : 170, source: 'public_address', networkCode: 'BSC', ...extra });
const selected = (address, extra = {}) => [{ label: 'REBATE_KEEPER', addr: address, source: 'public_address', ...extra }];
function fixture(initial = { REBATE_KEEPER: fp(A) }) {
  let previous, oldFp = initial, last;
  return {
    run(address, now, extra = {}, samples) {
      const state = prepareContractObservations(previous, oldFp);
      const targets = address ? selected(address, extra) : [];
      const sampled = samples || Object.fromEntries(contractObservationTargets(targets, state).map(t => [contractIdentity(t), state.fingerprints[contractIdentity(t)] || fp(t.addr)]));
      last = reconcileContractObservations({ previous, oldFp, selected: targets, sampled, now, diff: api.diffContractFingerprints });
      previous = last.state; oldFp = last.selectedFp; return last;
    },
    restart() { previous = JSON.parse(JSON.stringify(previous)); oldFp = JSON.parse(JSON.stringify(oldFp)); },
    state: () => last.state,
  };
}
test('跨地址只报告地址变化，不将不同代码和实现当成升级', () => {
  const changes = api.diffContractFingerprints({ K: fp(A, { implAddress: C, implCodeHash: 'old' }) }, { K: fp(B, { implAddress: D, implCodeHash: 'new' }) });
  assert.deepEqual(changes.map(c => c.type), ['合约地址变更']);
});
test('80次往返只产生候选和来源不稳定两项，两个地址始终纳入检查', () => {
  const f = fixture(), events = [];
  for (let i = 0; i < 80; i++) {
    const result = f.run(i % 2 ? A : B, i * 1000); events.push(...result.changes);
    assert.equal(Object.keys(result.state.fingerprints).length, 2);
    assert.equal(contractObservationTargets(selected(A), result.state).length, 2);
  }
  assert.deepEqual(events.map(c => c.type), ['发现合约候选地址', '合约地址来源不稳定']);
});
test('真实新地址首次立即提醒，30秒连续观测后确认一次', () => {
  const f = fixture(); assert.equal(f.run(B, 0).changes[0].type, '发现合约候选地址');
  const events = []; for (let i = 1; i <= 65; i++) events.push(...f.run(B, i * 1000).changes);
  assert.deepEqual(events.map(c => c.type), ['合约地址变更（稳定确认）']);
  assert.equal(f.state().labels.REBATE_KEEPER.confirmed, contractIdentity(fp(B)));
  assert.equal(Object.keys(f.state().fingerprints).length, 2);
});
test('第三个候选不被合并吞掉，稳定后的真实回切重新通知', () => {
  const f = fixture(); f.run(B, 0); f.run(A, 1000);
  assert.equal(f.run(C, 2000).changes[0].type, '发现合约候选地址');
  for (let i = 3; i <= 32; i++) f.run(C, i * 1000);
  assert.equal(f.run(A, 33000).changes[0].type, '发现合约候选地址');
});
test('候选撤回恢复原地址有一次恢复通知，仍检查候选', () => {
  const f = fixture(); f.run(B, 0); f.run(A, 1000);
  const events = []; for (let i = 2; i <= 40; i++) events.push(...f.run(A, i * 1000).changes);
  assert.deepEqual(events.map(c => c.type), ['合约地址来源恢复稳定']);
  assert.equal(contractObservationTargets(selected(A), f.state()).length, 2);
});
test('候选、旧地址真实升级不等待稳定；回切不重复报代码', () => {
  const f = fixture(); f.run(B, 0); f.run(A, 1000);
  const samples = { [contractIdentity(fp(A))]: fp(A, { codeHash: 'changed' }), [contractIdentity(fp(B))]: fp(B, { implAddress: C, implCodeHash: 'impl' }) };
  const events = f.run(A, 2000, {}, samples).changes;
  assert.deepEqual(events.map(c => c.type), ['Bytecode 变更', '代理升级（Implementation 变更）']);
  assert.equal(events[1].address, B);
  assert.deepEqual(f.run(B, 3000, {}, samples).changes, []);
});
test('同地址代理升级、清零和同实现代码变化都保留', () => {
  assert.equal(api.diffContractFingerprints({ K: fp(A, { implAddress: B }) }, { K: fp(A, { implAddress: C }) })[0].newImpl, C);
  assert.equal(api.diffContractFingerprints({ K: fp(A, { implAddress: B }) }, { K: fp(A) })[0].newImpl, '0x' + '0'.repeat(40));
  assert.equal(api.diffContractFingerprints({ K: fp(A, { implAddress: B, implCodeHash: 'one' }) }, { K: fp(A, { implAddress: B, implCodeHash: 'two' }) })[0].type, 'Implementation Bytecode 变更');
});
test('重启保留去重、观察窗口和候选；缓存回退不算稳定证据', () => {
  const f = fixture(); f.run(B, 0); f.run(A, 1000); f.restart();
  assert.deepEqual(f.run(B, 2000).changes, []);
  for (let i = 3; i < 50; i++) assert.deepEqual(f.run(B, i * 1000, { cached: true }).changes, []);
  assert.equal(f.state().labels.REBATE_KEEPER.confirmed, contractIdentity(fp(A)));
  assert.deepEqual(f.run(B, 50000).changes, []);
  for (let i = 51; i < 80; i++) f.run(B, i * 1000);
  assert.equal(f.run(B, 80000).changes[0].type, '合约地址变更（稳定确认）');
});
test('少量样本跨长故障不能确认；缺失指纹失败不改旧状态', () => {
  const f = fixture(); f.run(B, 0); f.run(B, 1000);
  assert.deepEqual(f.run(B, 100000).changes, []);
  const previous = structuredClone(f.state());
  assert.throws(() => f.run(B, 101000, {}, {}), /未取得指纹/);
  assert.deepEqual(f.state(), previous);
});
test('首次安装静默建基线，旧快照迁移首轮不丢真实代码变化', () => {
  assert.deepEqual(reconcileContractObservations({ oldFp: undefined, selected: selected(A), sampled: { [contractIdentity(fp(A))]: fp(A) }, now: 0, diff: api.diffContractFingerprints }).changes, []);
  const previous = { K: fp(A) };
  const state = prepareContractObservations(undefined, previous);
  assert.deepEqual(state.fingerprints[contractIdentity(fp(A))], previous.K);
  const f = fixture();
  assert.equal(f.run(A, 0, {}, { [contractIdentity(fp(A))]: fp(A, { codeHash: 'new' }) }).changes[0].type, 'Bytecode 变更');
});
test('来源列表消失不丢链上基线，恢复可见仍检查旧候选', () => {
  const f = fixture(); f.run(B, 0);
  assert.equal(f.run(null, 1000).changes[0].type, '合约从来源列表消失');
  assert.deepEqual(f.run(null, 2000).changes, []);
  assert.equal(contractObservationTargets([], f.state()).length, 2);
  assert.equal(f.run(B, 3000).changes[0].type, '合约地址重新出现');
});
test('链上来源地址切换即时报告，无公共接口确认延迟；按链地址去重', () => {
  const f = fixture(); assert.equal(f.run(B, 0, { source: 'onchain' }).changes[0].type, '合约地址变更');
  assert.notEqual(contractIdentity(fp(A)), contractIdentity(fp(A, { networkCode: 'ETH' })));
  assert.equal(contractObservationTargets([...selected(A), ...selected(A, { label: 'Other' })], prepareContractObservations()).length, 1);
});
test('公共接口种子来源同样确认稳定，缓存种子不能确认', () => {
  const f = fixture(); assert.equal(f.run(B, 0, { source: 'public_address_seed' }).changes[0].type, '发现合约候选地址');
  for (let i = 1; i <= 40; i++) assert.deepEqual(f.run(B, i * 1000, { source: 'snapshot_seed' }).changes, []);
  assert.equal(f.state().labels.REBATE_KEEPER.confirmed, contractIdentity(fp(A)));
});
test('写盘失败观察与outbox一起回滚，重试重启不吞提醒且旧队列保留', async () => {
  let fail = true, disk; const initial = { contractFingerprints: { REBATE_KEEPER: fp(A) }, _notificationOutbox: [{ id: 'existing', payload: {} }], actorNotificationLedger: { kept: 1 } };
  const store = createTransactionalOutbox({ initial: structuredClone(initial), persist: state => { if (fail) throw Error('disk'); disk = structuredClone(state); }, deliver: async () => { throw Error('offline'); } });
  const run = () => store.transaction(async () => {
    const result = reconcileContractObservations({ previous: store.state.contractObservations, oldFp: store.state.contractFingerprints, selected: selected(B), sampled: { [contractIdentity(fp(A))]: fp(A), [contractIdentity(fp(B))]: fp(B) }, now: 0, diff: api.diffContractFingerprints });
    store.state.contractObservations = result.state; store.state.contractFingerprints = result.selectedFp;
    if (result.changes.length) await store.enqueue({ changes: result.changes });
  });
  await assert.rejects(run(), /disk/); assert.deepEqual(store.state.contractFingerprints, initial.contractFingerprints); assert.equal(store.state.contractObservations, undefined);
  fail = false; await run(); await run();
  assert.equal(disk._notificationOutbox.length, 2); assert.equal(disk._notificationOutbox[0].id, 'existing'); assert.deepEqual(disk.actorNotificationLedger, { kept: 1 });
  const restart = prepareContractObservations(disk.contractObservations, disk.contractFingerprints); assert.equal(restart.labels.REBATE_KEEPER.announced.length, 2);
});
test('选择器卡片明确候选和ABI边界，不声称接口不变或确定新增功能', () => {
  const text = api.formatContractChanges([{ type: 'Bytecode 变更', label: 'K', address: A, selectorDiff: { added: ['0xa9059cbb', '0x4300081d'], removed: [] } }]);
  assert.match(text, /未验证 ABI/); assert.match(text, /常量或元数据/); assert.doesNotMatch(text, /\*\*新增功能：/);
  const same = api.formatContractChanges([{ type: 'Bytecode 变更', label: 'K', address: A, selectorDiff: { added: [], removed: [] } }]);
  assert.doesNotMatch(same, /仅内部逻辑修改/);
});

test('生产合约入口在原事务中保存候选和通知，重启不重复且RPC失败保留所有基线', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'four-contract-integration-'));
  const original = api.CONFIG.snapshotFile;
  try {
    api.CONFIG.snapshotFile = join(directory, 'snapshot.json');
    const initial = { contractFingerprints: { REBATE_KEEPER: fp(A) }, githubSha: 'preserve', actorNotificationLedger: { entries: { kept: true } } };
    let state = api.setSnapshotForTests(initial), now = 0, address = B, fail = false;
    const queried = [];
    const runner = api.createModuleRunner('contract', () => api.runContractCheck({
      buildTargets: async () => selected(address), now: () => now, history: () => {},
      fetchFingerprints: async targets => { queried.push(targets.map(t => t.addr)); if (fail) throw Error('RPC fixture unavailable'); return Object.fromEntries(targets.map(t => [t.label, fp(t.addr)])); },
    }), 1000);
    await runner.run();
    let disk = JSON.parse(readFileSync(api.CONFIG.snapshotFile, 'utf8'));
    assert.equal(disk._notificationOutbox.length, 1);
    assert.match(disk._notificationOutbox[0].payload.content, /发现合约候选地址/);
    assert.doesNotMatch(disk._notificationOutbox[0].payload.content, /Bytecode 变更/);
    state = api.setSnapshotForTests(disk); now = 1000; await runner.run();
    assert.equal(state._notificationOutbox.length, 1);
    address = A; now = 2000; await runner.run();
    assert.equal(state._notificationOutbox.length, 2);
    const before = structuredClone(state.contractObservations);
    fail = true; now = 3000; await runner.run();
    assert.deepEqual(state.contractObservations, before);
    assert.equal(state._notificationOutbox.length, 2);
    assert.equal(state.githubSha, 'preserve');
    assert.deepEqual(state.actorNotificationLedger, initial.actorNotificationLedger);
    assert.ok(queried.every(targets => targets.includes(A) && targets.includes(B)));
  } finally { api.CONFIG.snapshotFile = original; api.setSnapshotForTests({}); }
});
