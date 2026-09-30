import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeCowTrades, cowGroupUid, selectCowNotification, COW_TRADE_TOPIC } from './cow-notifications.mjs';
import { createEarlySignalState, decodeEarlyReceipt, ingestCowOrders, acknowledgeEarlySignals, earlyAssetStage, rewindEarlySignals } from './early-signal-monitor.mjs';
import { selectEarlyNotification } from './early-signal-notifications.mjs';
import { COW_SETTLEMENT, COW_VAULT_RELAYER, EXECUTION_WALLETS } from './early-signal-catalog.mjs';
import { TOPICS } from './early-signal-topics.mjs';

const receipt = JSON.parse(readFileSync(new URL('./fixtures/cow-settlement.json', import.meta.url), 'utf8'));
const owner = EXECUTION_WALLETS[0].toLowerCase();
const sell = '0x4902c5ebc598265ed2212b559b042de8a5eeec3f';
const buy = '0x55d398326f99059ff775485246999027b3197955';
const uid = '0xa47ffb36c363b5ca5ce4d315508277842154cb95357f6cbdf8cb082e8b83448f81459cd6b1bdf55d01a824350a79a0c2015309926ae31126';
const now = Date.parse('2026-09-29T10:42:00Z');
const allowanceFills = JSON.parse(readFileSync(new URL('./fixtures/cow-allowance-fills.json', import.meta.url), 'utf8'));
function allowanceState() {
  const state = createEarlySignalState();
  const firstTx = allowanceFills.events[0].transactionHash;
  state.pendingChanges = structuredClone(allowanceFills.events.filter(e => e.transactionHash === firstTx));
  const baseline = structuredClone(allowanceFills.baselineApproval);
  state.events = Object.fromEntries([baseline, ...state.pendingChanges].map(e => [e.id, e]));
  state.tokens = structuredClone(allowanceFills.tokens);
  return state;
}
const order = { uid, owner, receiver: owner, sellToken: sell, buyToken: buy, sellAmount: '100000000000000000000',
  executedSellAmount: '0', executedBuyAmount: '0', kind: 'sell', status: 'open', creationDate: new Date(now).toISOString(), validTo: now / 1000 + 3600 };
function finish(state, selection) {
  state.cowNotifications ||= {};
  state.cowNotifications[selection.cowUid] = { ...selection.cowRecord, messageId: 'card-1' };
  acknowledgeEarlySignals(state, selection.changes.map(e => e.id));
}

test('真实 CoW 回执用 UID 和两边准确金额关联转账，不增加 RPC 查询', () => {
  const state = createEarlySignalState();
  decodeEarlyReceipt(receipt, state, { nowMs: now });
  assert.equal(state.pendingChanges.length, 3);
  assert.equal(cowGroupUid(state.pendingChanges), uid);
  assert.equal(state.pendingChanges.filter(e => e.cowOrderUid === uid).length, 2);
  assert.equal(selectEarlyNotification(state, now), null);
  const selection = selectCowNotification(state, now);
  assert.equal(selection.mode, 'cow-notice');
  assert.match(selection.content, /卖出回笼资金/);
  assert.doesNotMatch(selection.content, /疑似备货|4059971207817960984/);
  assert.equal(earlyAssetStage(state, buy), 'observation');
  decodeEarlyReceipt(receipt, state, { nowMs: now + 1 });
  assert.equal(state.pendingChanges.length, 3);
});

test('伪造结算地址、UID owner、截断 ABI 均不能吞掉资金提醒', () => {
  for (const mutation of ['address', 'uidOwner', 'truncated']) {
    const copy = structuredClone(receipt);
    const log = copy.logs.find(l => l.topics[0] === COW_TRADE_TOPIC);
    if (mutation === 'address') log.address = buy;
    if (mutation === 'uidOwner') log.data = log.data.replace(owner.slice(2), '11'.repeat(20));
    if (mutation === 'truncated') log.data = log.data.slice(0, -64);
    const state = createEarlySignalState();
    decodeEarlyReceipt(copy, state, { nowMs: now });
    assert.ok(selectEarlyNotification(state, now), mutation);
    assert.ok(state.pendingChanges.every(e => !e.cowOrderUid), mutation);
  }
});

test('金额不符、同币额外转出、陌生收款方和多笔同币订单保留普通提醒', () => {
  for (const mutation of ['amount', 'extra', 'receiver', 'ambiguous']) {
    const copy = structuredClone(receipt);
    const outgoing = copy.logs.find(l => l.address === sell && l.topics[0] === TOPICS.Transfer && l.topics[1].endsWith(owner.slice(2)));
    if (mutation === 'amount') outgoing.data = '0x' + '1'.padStart(64, '0');
    if (mutation === 'receiver') outgoing.topics[2] = '0x' + '11'.repeat(20).padStart(64, '0');
    if (mutation === 'extra') copy.logs.push({ ...outgoing, logIndex: '0xffff' });
    if (mutation === 'ambiguous') copy.logs.push({ ...copy.logs.find(l => l.topics[0] === COW_TRADE_TOPIC), logIndex: '0xffff' });
    const state = createEarlySignalState();
    decodeEarlyReceipt(copy, state, { nowMs: now });
    assert.ok(selectEarlyNotification(state, now), mutation);
  }
});

test('历史 API 状态与链上事件冲突时不合并', () => {
  assert.equal(decodeCowTrades(receipt.logs, new Set([owner]), { [uid]: { ...order, buyToken: sell } }).length, 0);
});

test('同笔结算有加池或权限操作时仍保留整笔即时提醒', () => {
  for (const kind of ['liquidityAdded', 'liquidityRemoved', 'authority', 'decodeError', 'wrap']) {
    const state = createEarlySignalState();
    decodeEarlyReceipt(receipt, state, { nowMs: now });
    state.pendingChanges.push({ id: kind, kind, transactionHash: receipt.transactionHash, detail: kind });
    assert.equal(selectEarlyNotification(state, now).changes.length, 4);
    assert.equal(selectCowNotification(state, now), null);
  }
});

test('新订单、首次成交单独通知；后续成交与 API 更新原卡并保留所有原始事件', () => {
  const state = createEarlySignalState();
  state.tokens[sell] = { symbol: 'BNCB', decimals: 18 };
  ingestCowOrders(state, owner, [order], { nowMs: now });
  let selection = selectCowNotification(state, now);
  assert.match(selection.content, /发现订单/); finish(state, selection);
  decodeEarlyReceipt(receipt, state, { nowMs: now + 1 });
  selection = selectCowNotification(state, now + 1);
  assert.match(selection.content, /首次成交/);
  assert.equal(selection.mode, 'cow-notice'); finish(state, selection);
  ingestCowOrders(state, owner, [{ ...order, executedSellAmount: '4000000000000000000', executedBuyAmount: '23000000000000000000' }], { nowMs: now + 2 });
  selection = selectCowNotification(state, now + 2);
  assert.equal(selection.mode, 'cow-patch');
  assert.match(selection.content, /累计卖出：4\n/);
  assert.match(selection.content, /累计收到：23\n/);
  assert.match(selection.content, /卖出进度：4%/);
  finish(state, selection);
  assert.equal(state.pendingChanges.length, 0);
  assert.equal(Object.keys(state.events).length, 5);
  assert.equal(selectCowNotification(JSON.parse(JSON.stringify(state)), now + 3), null);
});

test('同订单积压的取消及重新开放不会被合并掉，完成和过期仍通知', () => {
  for (const terminal of ['cancelled', 'fulfilled', 'expired']) {
    const state = createEarlySignalState();
    ingestCowOrders(state, owner, [order], { nowMs: now });
    finish(state, selectCowNotification(state, now));
    ingestCowOrders(state, owner, [{ ...order, status: terminal }], { nowMs: now + 1 });
    ingestCowOrders(state, owner, [order], { nowMs: now + 2 });
    let selection = selectCowNotification(state, now + 3);
    assert.equal(selection.cowRecord.status, terminal);
    assert.equal(selection.mode, 'cow-notice'); finish(state, selection);
    selection = selectCowNotification(state, now + 4);
    assert.equal(selection.cowRecord.status, 'open');
    assert.equal(selection.mode, 'cow-notice');
  }
});

test('API 先报成交，迟到链上回执只更新原卡；买入新资产仍是备货', () => {
  const state = createEarlySignalState();
  ingestCowOrders(state, owner, [{ ...order, executedSellAmount: '100', executedBuyAmount: '200' }], { nowMs: now });
  finish(state, selectCowNotification(state, now));
  decodeEarlyReceipt(receipt, state, { nowMs: now + 1 });
  assert.equal(selectCowNotification(state, now + 1).mode, 'cow-patch');
  const buying = createEarlySignalState();
  ingestCowOrders(buying, owner, [{ ...order, sellToken: buy, buyToken: sell }], { nowMs: now });
  assert.equal(earlyAssetStage(buying, sell), 'stocking');
  assert.match(selectCowNotification(buying, now).content, /资产采购/);
});

test('补充精度前不猜测代币单位，重组仍立即警示', () => {
  const state = createEarlySignalState();
  decodeEarlyReceipt(receipt, state, { nowMs: now });
  assert.match(selectCowNotification(state, now).content, /数量待精度核验/);
  rewindEarlySignals(state, Number(receipt.blockNumber), now + 1);
  assert.ok(selectEarlyNotification(state, now + 1).changes.some(e => e.kind === 'reorg'));
  assert.ok(!state.pendingChanges.some(e => e.kind === 'cowTrade'));
});

test('单订单卡片更新失败退避不阻挡其他订单与终态提醒', () => {
  const state = createEarlySignalState();
  ingestCowOrders(state, owner, [order], { nowMs: now });
  finish(state, selectCowNotification(state, now));
  ingestCowOrders(state, owner, [{ ...order, executedSellAmount: '1' }], { nowMs: now + 1 });
  finish(state, selectCowNotification(state, now + 1));
  ingestCowOrders(state, owner, [{ ...order, executedSellAmount: '2' }], { nowMs: now + 2 });
  state.cowNotifications[uid].nextAttemptAtMs = now + 60000;
  assert.equal(selectCowNotification(state, now + 3), null);
  ingestCowOrders(state, owner, [{ ...order, status: 'fulfilled', executedSellAmount: '100' }], { nowMs: now + 4 });
  assert.equal(selectCowNotification(state, now + 4).mode, 'cow-notice');
});

test('生产九笔分批成交的额度消耗均合并原订单卡，重启后仍保留原始事件', () => {
  let state = allowanceState();
  state.pendingChanges = [];
  state.events = { [allowanceFills.baselineApproval.id]: structuredClone(allowanceFills.baselineApproval) };
  const transactions = [...new Set(allowanceFills.events.map(e => e.transactionHash))];
  assert.equal(transactions.length, 9);
  for (const [index, tx] of transactions.entries()) {
    state.pendingChanges = structuredClone(allowanceFills.events.filter(e => e.transactionHash === tx));
    for (const e of state.pendingChanges) state.events[e.id] = e;
    assert.equal(selectEarlyNotification(state, now), null);
    const selection = selectCowNotification(state, now);
    assert.equal(selection.cowUid, allowanceFills.uid);
    assert.equal(selection.mode, index === 0 ? 'cow-notice' : 'cow-patch');
    assert.equal(selection.changes.length, 4);
    finish(state, selection);
    state = JSON.parse(JSON.stringify(state));
  }
  assert.equal(Object.keys(state.events).length, 37);
  assert.equal(state.pendingChanges.length, 0);
});

test('CoW 降噪不合并未知授权、额度增加、不匹配、缺失历史、未来或异分叉证据', () => {
  for (const mutation of ['spender', 'increase', 'mismatch', 'missing', 'future', 'fork', 'duplicate', 'transferFork', 'standalone']) {
    const state = allowanceState();
    const approval = state.pendingChanges.find(e => e.kind === 'approval');
    const previous = state.events[allowanceFills.baselineApproval.id];
    if (mutation === 'spender') approval.to = buy;
    if (mutation === 'increase') approval.amount = (BigInt(previous.amount) + 1n).toString();
    if (mutation === 'mismatch') approval.amount = (BigInt(approval.amount) + 1n).toString();
    if (mutation === 'missing') delete state.events[previous.id];
    if (mutation === 'future') previous.blockNumber = approval.blockNumber + 1;
    if (mutation === 'fork') { previous.blockNumber = approval.blockNumber; previous.logIndex = approval.logIndex - 1; }
    if (mutation === 'duplicate') state.pendingChanges.push({ ...approval, id: 'duplicate' });
    if (mutation === 'transferFork') state.pendingChanges.find(e => e.kind === 'transfer').blockHash = previous.blockHash;
    if (mutation === 'standalone') state.pendingChanges = [approval];
    assert.ok(selectEarlyNotification(state, now), mutation);
    assert.equal(selectCowNotification(state, now), null, mutation);
  }
});

test('额度消耗同笔存在加池、撤池或其他权限变更时仍立即通知', () => {
  for (const kind of ['liquidityAdded', 'liquidityRemoved', 'authority', 'decodeError']) {
    const state = allowanceState();
    state.pendingChanges.push({ id: kind, kind, transactionHash: state.pendingChanges[0].transactionHash, detail: kind });
    assert.equal(selectEarlyNotification(state, now).changes.length, 5);
    assert.equal(selectCowNotification(state, now), null);
  }
});

test('零额度授权不丢弃：撤销立即提醒，核验的最后一笔成交额度消耗可合并', () => {
  const state = createEarlySignalState();
  const copy = structuredClone(receipt);
  copy.logs = [{ ...copy.logs[0], address: sell, logIndex: '0xffff',
    topics: [TOPICS.Approval, '0x' + owner.slice(2).padStart(64, '0'), '0x' + COW_VAULT_RELAYER.slice(2).padStart(64, '0')],
    data: '0x' + '0'.repeat(64) }];
  decodeEarlyReceipt(copy, state, { nowMs: now });
  assert.equal(state.pendingChanges.length, 1);
  assert.equal(state.pendingChanges[0].kind, 'approval');
  assert.equal(state.pendingChanges[0].amount, '0');
  assert.ok(selectEarlyNotification(state, now));
  const fill = allowanceState();
  fill.pendingChanges.find(e => e.kind === 'approval').amount = '0';
  fill.events[allowanceFills.baselineApproval.id].amount = fill.pendingChanges.find(e => e.kind === 'cowTrade').sellAmount;
  assert.equal(selectEarlyNotification(fill, now), null);
  assert.ok(selectCowNotification(fill, now));
});

test('重组移除额度历史后不沿用旧消耗证据', () => {
  const state = allowanceState();
  const changes = structuredClone(state.pendingChanges);
  rewindEarlySignals(state, allowanceFills.baselineApproval.blockNumber, now);
  state.pendingChanges = changes;
  for (const e of changes) state.events[e.id] = e;
  assert.ok(selectEarlyNotification(state, now));
  assert.equal(selectCowNotification(state, now), null);
});
