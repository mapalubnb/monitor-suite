import { BASE_ASSETS, COW_SETTLEMENT, COW_VAULT_RELAYER } from './early-signal-catalog.mjs';

// GPv2Settlement.Trade: owner indexed; sellToken, buyToken, amounts, fee, UID.
// https://github.com/cowprotocol/contracts/blob/main/src/contracts/GPv2Settlement.sol
export const COW_TRADE_TOPIC = '0xa07a543ab8a018198e99ca0184c93fe9050a79400a0a723441f84de1d972cc17';
const lower = x => String(x || '').toLowerCase();
const validUid = x => /^0x[0-9a-f]{112}$/.test(lower(x));
const uint = x => /^\d+$/.test(String(x ?? '')) ? BigInt(x) : 0n;
export const cowDirection = (sell, buy) => BASE_ASSETS.has(lower(buy))
  ? BASE_ASSETS.has(lower(sell)) ? '资金兑换' : '卖出回笼资金' : '资产采购';

export function decodeCowTrades(logs, wallets, orders = {}) {
  const trades = [];
  for (const log of logs) {
    if (lower(log.address) !== COW_SETTLEMENT || lower(log.topics?.[0]) !== COW_TRADE_TOPIC) continue;
    try {
      if (log.topics.length !== 2 || !/^0x0{24}[0-9a-f]{40}$/i.test(log.topics[1])) continue;
      const owner = lower('0x' + log.topics[1].slice(-40));
      if (!wallets.has(owner)) continue;
      const hex = lower(log.data).slice(2);
      if (!/^[0-9a-f]+$/.test(hex) || hex.length % 64) continue;
      const words = hex.match(/.{64}/g);
      if (words.length !== 9 || !words.slice(0, 2).every(w => /^0{24}/.test(w))
        || BigInt('0x' + words[5]) !== 192n || BigInt('0x' + words[6]) !== 56n) continue;
      const uid = '0x' + hex.slice(448, 560);
      if (!validUid(uid) || '0x' + uid.slice(66, 106) !== owner) continue;
      const sellToken = '0x' + words[0].slice(-40), buyToken = '0x' + words[1].slice(-40);
      const order = orders[uid];
      if (order && (lower(order.owner) !== owner || lower(order.sellToken) !== sellToken || lower(order.buyToken) !== buyToken)) continue;
      const sellAmount = BigInt('0x' + words[2]).toString(), buyAmount = BigInt('0x' + words[3]).toString();
      if (uint(sellAmount) === 0n || uint(buyAmount) === 0n) continue;
      trades.push({ log, kind: 'cowTrade', orderUid: uid, owner, sellToken, buyToken,
        receiver: order?.receiver && !/^0x0{40}$/.test(order.receiver) ? lower(order.receiver) : owner,
        sellAmount, buyAmount, feeAmount: BigInt('0x' + words[4]).toString(),
        direction: cowDirection(sellToken, buyToken), token: BASE_ASSETS.has(buyToken) ? sellToken : buyToken,
        stage: BASE_ASSETS.has(buyToken) ? 'observation' : 'stocking', detail: 'CoW 链上成交已核验' });
    } catch { /* Unverifiable receipts retain the ordinary transfer alerts. */ }
  }
  return trades;
}

export function matchCowTransfers(logs, trades, transferTopic) {
  const matches = new Map();
  for (const trade of trades) {
    // Ambiguous batching is deliberately left visible, never matched by counterparty alone.
    if (trades.filter(t => t.owner === trade.owner && t.sellToken === trade.sellToken && t.buyToken === trade.buyToken).length !== 1) continue;
    const rows = logs.filter(l => lower(l.topics?.[0]) === transferTopic && l.topics.length === 3 && /^0x[0-9a-f]{64}$/i.test(l.data));
    const address = t => lower('0x' + String(t).slice(-40));
    const sells = rows.filter(l => lower(l.address) === trade.sellToken && address(l.topics[1]) === trade.owner && address(l.topics[2]) === COW_SETTLEMENT);
    const buys = rows.filter(l => lower(l.address) === trade.buyToken && address(l.topics[1]) === COW_SETTLEMENT && address(l.topics[2]) === trade.receiver);
    const sum = list => list.reduce((n, l) => n + BigInt(l.data), 0n);
    if (!sells.length || !buys.length || sum(sells) !== uint(trade.sellAmount) || sum(buys) !== uint(trade.buyAmount)) continue;
    for (const log of [...sells, ...buys]) matches.set(log, trade.orderUid);
  }
  return matches;
}

function chainPosition(event) {
  return event?.source === 'chain' && event.chainId === 56
    && Number.isSafeInteger(event.blockNumber) && event.blockNumber > 0
    && Number.isSafeInteger(event.logIndex) && event.logIndex >= 0
    && /^0x[0-9a-f]{64}$/.test(event.blockHash || '')
    && /^0x[0-9a-f]{64}$/.test(event.transactionHash || '');
}

// An Approval emitted during transferFrom can report the remaining allowance.
// A known spender alone is never sufficient to silence a permission change.
function cowAllowanceSpendUid(approval, events, state) {
  if (!chainPosition(approval) || approval.to !== COW_VAULT_RELAYER || !/^\d+$/.test(approval.amount || '')) return null;
  const sameAllowance = e => e.kind === 'approval' && e.token === approval.token && e.from === approval.from && e.to === approval.to;
  if (events.filter(sameAllowance).length !== 1) return null;
  const trades = events.filter(e => e.kind === 'cowTrade' && e.owner === approval.from && e.sellToken === approval.token);
  if (trades.length !== 1) return null;
  const trade = trades[0];
  if (!chainPosition(trade) || !validUid(trade.orderUid) || trade.blockHash !== approval.blockHash
    || trade.transactionHash !== approval.transactionHash) return null;
  const transfers = events.filter(e => e.kind === 'transfer' && e.cowOrderUid === trade.orderUid);
  if (transfers.some(e => !chainPosition(e) || e.blockHash !== approval.blockHash
    || e.transactionHash !== approval.transactionHash)) return null;
  const sells = transfers.filter(e => e.token === trade.sellToken && e.from === trade.owner && e.to === COW_SETTLEMENT);
  const buys = transfers.filter(e => e.token === trade.buyToken && e.from === COW_SETTLEMENT && e.to === trade.receiver);
  const sum = rows => rows.reduce((total, e) => total + uint(e.amount), 0n);
  if (!sells.length || !buys.length || uint(trade.sellAmount) === 0n
    || sum(sells) !== uint(trade.sellAmount) || sum(buys) !== uint(trade.buyAmount)) return null;
  const previous = Object.values(state?.events || {}).filter(e => sameAllowance(e) && chainPosition(e)
    && (e.blockNumber < approval.blockNumber || e.blockNumber === approval.blockNumber
      && e.blockHash === approval.blockHash && e.logIndex < approval.logIndex))
    .sort((a, b) => b.blockNumber - a.blockNumber || b.logIndex - a.logIndex)[0];
  // No inference from order size, token type, or a future/out-of-order observation.
  if (!previous || !/^\d+$/.test(previous.amount || '')
    || BigInt(previous.amount) - BigInt(approval.amount) !== BigInt(trade.sellAmount)) return null;
  return trade.orderUid;
}

export function cowGroupUid(events, state) {
  const uids = events.map(e => e.kind === 'approval' ? cowAllowanceSpendUid(e, events, state) : e.kind === 'transfer' ? e.cowOrderUid
    : ['order', 'cowTrade'].includes(e.kind) && e.sellToken && e.buyToken && e.owner ? e.orderUid : null);
  return uids.length && uids.every(uid => validUid(uid) && uid === uids[0]) ? uids[0] : null;
}

const label = value => String(value).replace(/[\\`*_[\]<>\r\n]/g, '');
const link = (address, name) => `[${label(name || `${address.slice(0, 6)}…${address.slice(-4)}`)}](https://bscscan.com/address/${address})`;
const baseNames = { '0x55d398326f99059ff775485246999027b3197955': 'USDT', '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c': 'WBNB', '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': 'USDC' };
function amount(raw, token, state) {
  const decimals = state.tokens?.[token]?.decimals ?? (BASE_ASSETS.has(token) ? 18 : null);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255 || !/^\d+$/.test(String(raw ?? ''))) return '数量待精度核验';
  const value = BigInt(raw), scale = 10n ** BigInt(decimals);
  const fraction = (value % scale).toString().padStart(decimals, '0').slice(0, 6).replace(/0+$/, '');
  if (value > 0n && value < scale && !fraction) return '<0.000001';
  return `${value / scale}${decimals && fraction ? '.' + fraction : ''}`;
}
const statusLabels = { open: '进行中', presignaturePending: '等待预签名', fulfilled: '已完成', cancelled: '已取消', expired: '已过期' };

export function selectCowNotification(state, nowMs) {
  const byTx = new Map();
  for (const event of state.pendingChanges || []) {
    const key = event.transactionHash || event.id;
    if (!byTx.has(key)) byTx.set(key, []);
    byTx.get(key).push(event);
  }
  const byUid = new Map();
  for (const events of byTx.values()) {
    const uid = cowGroupUid(events, state);
    if (!uid) continue;
    if (!byUid.has(uid)) byUid.set(uid, []);
    byUid.get(uid).push(events);
  }
  for (const [uid, groups] of byUid) {
    const previous = state.cowNotifications?.[uid] || {};
    // Preserve each queued lifecycle transition; collapse only intermediate fills.
    const boundary = groups.findIndex(g => g.some(e => e.kind === 'order' && ['new', 'status'].includes(e.orderChange)));
    const changes = (boundary < 0 ? groups : groups.slice(0, boundary + 1)).flat();
    const orders = changes.filter(e => e.kind === 'order');
    const trades = changes.filter(e => e.kind === 'cowTrade');
    const lastOrder = orders.at(-1);
    const data = lastOrder || trades.at(-1);
    if (!data) continue;
    const status = lastOrder?.status || previous.status || 'open';
    const hasFill = Boolean(previous.hasFill || trades.length || orders.some(e => uint(e.executedSellAmount) > 0n || uint(e.executedBuyAmount) > 0n));
    const milestone = !previous.messageId || status !== previous.status || hasFill && !previous.hasFill;
    if (!milestone && previous.nextAttemptAtMs > nowMs) continue;
    const mode = milestone ? 'cow-notice' : 'cow-patch';
    const tokenName = t => state.tokens?.[t]?.symbol || state.tokens?.[t]?.name || baseNames[t];
    const asset = t => link(t, tokenName(t));
    const direction = cowDirection(data.sellToken, data.buyToken);
    const action = !previous.messageId ? (hasFill ? '发现成交' : '发现订单')
      : status !== previous.status ? statusLabels[status] || status : !previous.hasFill && hasFill ? '首次成交' : '成交进度';
    // API amounts are snapshots. Never add receipt fills to these totals (double counting).
    const totals = lastOrder || previous.totals;
    const lines = [`${direction === '资产采购' ? '🛒' : '💱'} ${direction}｜${action}`,
      `卖出资产：${asset(data.sellToken)}`, `合约：${link(data.sellToken, data.sellToken)}`,
      `买入资产：${asset(data.buyToken)}`, `合约：${link(data.buyToken, data.buyToken)}`,
      `订单状态：${statusLabels[status] || label(status)}`];
    if (totals) {
      lines.push(`累计卖出：${amount(totals.executedSellAmount, data.sellToken, state)}`,
        `累计收到：${amount(totals.executedBuyAmount, data.buyToken, state)}`);
      if (uint(totals.sellAmount) > 0n && totals.orderKind === 'sell') lines.push(`卖出进度：${Number(uint(totals.executedSellAmount) * 10000n / uint(totals.sellAmount)) / 100}%`);
      if (totals.observedAt) lines.push(`累计统计时间：${totals.observedAt}`);
    }
    const lastTrade = trades.at(-1) || previous.lastTrade;
    if (lastTrade) lines.push(`本次成交：${amount(lastTrade.sellAmount, data.sellToken, state)} → ${amount(lastTrade.buyAmount, data.buyToken, state)}`,
      `[最近成交](https://bscscan.com/tx/${lastTrade.transactionHash})｜区块 ${lastTrade.blockNumber}`);
    lines.push(`钱包：${link(data.owner)}`, `订单：${uid}`, `🕒 ${changes.at(-1).observedAt || new Date(nowMs).toISOString()}`);
    const nextRecord = { status, hasFill, lastTrade: lastTrade ? { sellAmount: lastTrade.sellAmount,
      buyAmount: lastTrade.buyAmount, transactionHash: lastTrade.transactionHash, blockNumber: lastTrade.blockNumber } : undefined,
      totals: totals ? { executedSellAmount: totals.executedSellAmount,
      executedBuyAmount: totals.executedBuyAmount, sellAmount: totals.sellAmount, orderKind: totals.orderKind,
      observedAt: totals.observedAt } : undefined };
    return { changes, mode, cowUid: uid, cowRecord: nextRecord, patchMessageId: mode === 'cow-patch' ? previous.messageId : null,
      title: `Flap ${direction}：${statusLabels[status] || label(status)}`, content: lines.join('\n'), template: status === 'fulfilled' ? 'green' : 'orange' };
  }
  return null;
}
