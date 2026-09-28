import test from 'node:test';
import assert from 'node:assert/strict';
import { archiveRoutineEarlySignals, selectEarlyNotification, earlyNotificationPriority } from './early-signal-notifications.mjs';
import { createEarlySignalState, decodeEarlyReceipt, buildEarlySignalContent as buildEarlyNotificationContent } from './early-signal-monitor.mjs';
import { DEX, EXECUTION_WALLETS } from './early-signal-catalog.mjs';
import { TOPICS } from './early-signal-topics.mjs';

const NOW = Date.parse('2026-09-28T02:30:00Z');
const TOKEN = '0x' + '11'.repeat(20), POOL = '0x' + '22'.repeat(20);
const event = (kind, extra = {}) => ({ id: kind, kind, observedAt: new Date(NOW).toISOString(), detail: kind, ...extra });
const stateFor = changes => ({ pendingChanges: changes, events: {}, health: {}, tokens: {
  [TOKEN]: { name: '测试资产', effectiveEnabled: true, configurationCheckedAt: new Date(NOW).toISOString() },
} });
const approval = () => event('approval', { token: TOKEN, enabledAtObservation: true, knownLiquiditySpender: true });

test('small debits leave the notification queue but retain raw evidence across restart', () => {
  const changes = Array.from({ length: 32 }, (_, i) => event('nativeBalance', { id: 'b' + i, deltaWei: '-14933150000000' }));
  const state = stateFor(changes);
  assert.equal(archiveRoutineEarlySignals(state, NOW).archived, 32);
  const restarted = JSON.parse(JSON.stringify(state));
  assert.equal(selectEarlyNotification(restarted, NOW + 86400000), null);
  assert.equal(restarted.pendingChanges.length, 0);
  assert.equal(Object.keys(restarted.events).length, 32);
  assert.equal(restarted.events.b0.deltaWei, '-14933150000000');
  assert.equal(restarted.events.b0.notificationDisposition, 'silent');
  assert.equal(archiveRoutineEarlySignals(restarted, NOW + 1).archived, 0);
});

test('incoming, large, unknown or malformed balance changes remain immediate', () => {
  for (const deltaWei of ['1', '-100000000000001', 'invalid', undefined]) {
    const state = stateFor([event('nativeBalance', { deltaWei })]);
    assert.equal(selectEarlyNotification(state, NOW).mode, 'immediate');
  }
});

test('every deposit, withdrawal, purchase, wrap, proposal, config and unrecognized event stays immediate', () => {
  for (const kind of ['liquidityAdded', 'liquidityRemoved', 'order', 'wrap', 'redeem', 'proposal', 'configuration', 'nativeTransfer', 'authority', 'safeOperation', 'allowance', 'reorg', 'decodeError', 'futureKind']) {
    const important = event(kind, { token: TOKEN, transactionHash: 'tx' });
    const accompanying = { ...approval(), id: 'a', transactionHash: 'tx' };
    const state = stateFor([important, accompanying]);
    const plan = selectEarlyNotification(state, NOW);
    assert.equal(plan.mode, 'immediate', kind);
    assert.deepEqual(plan.changes, [important, accompanying]);
  }
});

test('only fresh, already-open, known-manager approvals are routine', () => {
  const state = stateFor([approval()]);
  assert.equal(earlyNotificationPriority(state.pendingChanges, state, NOW), 'silent');
  for (const enabledAtObservation of [false, undefined]) {
    assert.equal(earlyNotificationPriority([{ ...approval(), enabledAtObservation }], state, NOW), 'immediate');
  }
  assert.equal(earlyNotificationPriority([{ ...approval(), knownLiquiditySpender: false }], state, NOW), 'immediate');
  assert.equal(earlyNotificationPriority(state.pendingChanges, state, NOW + 120001), 'immediate');
  state.health.assets = { lastError: 'timeout' };
  assert.equal(earlyNotificationPriority(state.pendingChanges, state, NOW), 'immediate');
});

test('already-open deposits notify immediately with only the liquidity action while retaining ancillary evidence', () => {
  const common = { token: TOKEN, enabledAtObservation: true, transactionHash: 'tx' };
  const changes = [event('liquidityAdded', { ...common, raw: { address: POOL } }),
    event('transfer', { ...common, to: POOL }), event('positionTransfer', { transactionHash: 'tx', from: '0x' + '0'.repeat(40) }),
    { ...approval(), transactionHash: 'tx' }];
  const state = stateFor(changes);
  const plan = selectEarlyNotification(state, NOW);
  assert.equal(plan.mode, 'immediate');
  assert.deepEqual(plan.changes, changes);
  const content = buildEarlyNotificationContent(plan.changes, state, plan.mode);
  assert.match(content, /liquidityAdded/);
  assert.doesNotMatch(content, /• transfer|• approval|• positionTransfer/);
  assert.equal(state.pendingChanges.length, 4);
  changes.push(event('transfer', { ...common, id: 'unexpected', to: TOKEN }));
  assert.equal(selectEarlyNotification(state, NOW).mode, 'immediate');
});

test('deposit presentation never hides withdrawal, authority or proposal evidence in a mixed transaction', () => {
  const changes = ['liquidityAdded', 'liquidityRemoved', 'authority', 'proposal', 'transfer'].map(kind => event(kind, { transactionHash: 'mixed' }));
  const state = stateFor(changes);
  const content = buildEarlyNotificationContent(changes, state, 'immediate');
  for (const kind of ['liquidityAdded', 'liquidityRemoved', 'authority', 'proposal']) assert.ok(content.includes(kind));
  assert.match(content, /• 加池 · liquidityAdded/);
  assert.match(content, /• 撤池 · liquidityRemoved/);
  assert.doesNotMatch(content, /• transfer/);
});

test('passive receipts remain silent but first active transfer is immediate, regardless of amount', () => {
  const state = createEarlySignalState();
  const owner = EXECUTION_WALLETS[0].toLowerCase(), stranger = '0x' + '33'.repeat(20);
  const topic = a => '0x' + a.slice(2).padStart(64, '0');
  const make = (from, to, tx) => ({ status: '0x1', from, transactionHash: tx, blockNumber: '0x1', blockHash: 'bh',
    logs: [{ address: TOKEN, topics: [TOPICS.Transfer, topic(from), topic(to)], data: '0x' + '1'.padStart(64, '0'), logIndex: '0x0', transactionHash: tx, blockHash: 'bh' }] });
  decodeEarlyReceipt(make(stranger, owner, 'passive'), state, { nowMs: NOW });
  assert.equal(state.pendingChanges[0].passiveIncoming, true);
  assert.equal(selectEarlyNotification(state, NOW), null);
  assert.match(buildEarlyNotificationContent(state.pendingChanges, state, 'silent'), /尚无主动采购证据/);
  decodeEarlyReceipt(make(owner, stranger, 'active'), state, { nowMs: NOW + 1 });
  assert.equal(selectEarlyNotification(state, NOW + 1).changes[0].transactionHash, 'active');
  assert.equal(Object.keys(state.events).length, 2);
});

test('a receipt larger than eight logs is never cut; transaction link and observation occur once', () => {
  const changes = Array.from({ length: 15 }, (_, i) => event('transfer', {
    id: 't' + i, token: TOKEN, detail: '完整证据' + i, transactionHash: '0xtx', blockNumber: 100,
  }));
  const state = stateFor(changes), plan = selectEarlyNotification(state, NOW);
  assert.equal(plan.changes.length, 15);
  const content = buildEarlyNotificationContent(plan.changes, state, plan.mode);
  assert.equal(content.match(/https:\/\/bscscan.com\/tx\//g).length, 1);
  assert.equal(content.match(/🕒/g).length, 1);
  for (let i = 0; i < 15; i++) assert.ok(content.includes('完整证据' + i));
});

test('retiring a legacy digest preserves newly important events and protects active immediate deliveries', () => {
  const small = event('nativeBalance', { deltaWei: '-1' });
  const deposit = event('liquidityAdded');
  const state = stateFor([small, deposit]);
  state.notificationDelivery = { mode: 'digest', ids: [small.id, deposit.id], sentParts: ['old-part'] };
  assert.equal(archiveRoutineEarlySignals(state, NOW).archived, 1);
  assert.equal(state.notificationDelivery, undefined);
  assert.deepEqual(selectEarlyNotification(state, NOW).changes, [deposit]);
  state.pendingChanges.push(approval());
  state.notificationDelivery = { mode: 'immediate', ids: ['approval'] };
  assert.equal(archiveRoutineEarlySignals(state, NOW).archived, 0);
  assert.ok(state.pendingChanges.some(e => e.id === 'approval'));
});

test('known liquidity approval is annotated from actual receipt decoding', () => {
  const state = createEarlySignalState();
  const owner = EXECUTION_WALLETS[0].toLowerCase();
  const topic = a => '0x' + a.slice(2).padStart(64, '0');
  decodeEarlyReceipt({ status: '0x1', from: owner, transactionHash: 'tx', blockNumber: '0x1', blockHash: 'bh',
    logs: [{ address: TOKEN, topics: [TOPICS.Approval, topic(owner), topic(DEX.v3Positions)], data: '0x' + 'f'.repeat(64), logIndex: '0x0' }] }, state, { nowMs: NOW });
  assert.equal(state.pendingChanges[0].knownLiquiditySpender, true);
  // First observation must not be hidden by a later positive getter response.
  state.tokens[TOKEN].effectiveEnabled = true;
  state.tokens[TOKEN].configurationCheckedAt = new Date(NOW).toISOString();
  assert.equal(selectEarlyNotification(state, NOW).mode, 'immediate');
});

test('compact withdrawal keeps linked asset/pool/transaction and removes ancillary noise', () => {
  const tx = '0x' + 'ab'.repeat(32);
  const changes = [event('liquidityRemoved', { token: TOKEN, transactionHash: tx, blockNumber: 123,
    detail: `V3 减少流动性｜${POOL}` }),
    event('transfer', { token: TOKEN, transactionHash: tx, from: POOL, to: TOKEN,
      amount: '166013371841196491859', detail: '代币收支｜原始数量 166013371841196491859' }),
    event('transfer', { id: 'usdt', token: '0x55d398326f99059ff775485246999027b3197955', transactionHash: tx,
      detail: 'USDT 转账' })];
  const state = stateFor(changes);
  const content = buildEarlyNotificationContent(changes, state);
  assert.ok(content.includes(`[测试资产](https://bscscan.com/address/${TOKEN})`));
  assert.ok(content.includes(`https://bscscan.com/address/${POOL}`));
  assert.ok(content.includes(`https://bscscan.com/tx/${tx}`));
  assert.doesNotMatch(content, /原始数量|166013371841196491859|保留即时提醒|链上状态最后复核|USDT|代币收支/);
  assert.equal(state.pendingChanges.length, 3);
});

test('compact operation amounts omit raw token integers but preserve status and readable BNB', () => {
  const state = stateFor([]);
  const order = event('order', { detail: 'CoW fulfilled｜原始卖出数量 99999999｜累计成交原始数量：卖出 111 / 买入 222｜有效期 2026-09-28T10:00:00Z' });
  assert.match(buildEarlyNotificationContent([order], state), /fulfilled.*有效期/);
  assert.doesNotMatch(buildEarlyNotificationContent([order], state), /原始.*数量|99999999|111|222/);
  const balance = event('nativeBalance', { address: TOKEN, deltaWei: '-1500000000000000000' });
  assert.match(buildEarlyNotificationContent([balance], state), /-1\.5 BNB/);
});
