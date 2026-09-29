import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeCowTrades, cowGroupUid, selectCowNotification, COW_TRADE_TOPIC } from './cow-notifications.mjs';
import { createEarlySignalState, decodeEarlyReceipt, ingestCowOrders, acknowledgeEarlySignals, earlyAssetStage, rewindEarlySignals } from './early-signal-monitor.mjs';
import { selectEarlyNotification } from './early-signal-notifications.mjs';
import { COW_SETTLEMENT, EXECUTION_WALLETS } from './early-signal-catalog.mjs';
import { TOPICS } from './early-signal-topics.mjs';

const receipt = JSON.parse(readFileSync(new URL('./fixtures/cow-settlement.json', import.meta.url), 'utf8'));
const owner = EXECUTION_WALLETS[0].toLowerCase();
const sell = '0x4902c5ebc598265ed2212b559b042de8a5eeec3f';
const buy = '0x55d398326f99059ff775485246999027b3197955';
const uid = '0xa47ffb36c363b5ca5ce4d315508277842154cb95357f6cbdf8cb082e8b83448f81459cd6b1bdf55d01a824350a79a0c2015309926ae31126';
const now = Date.parse('2026-09-29T10:42:00Z');
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
