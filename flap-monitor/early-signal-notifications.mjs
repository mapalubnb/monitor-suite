import { BASE_ASSETS } from './early-signal-catalog.mjs';
import { buildEarlySignalContent } from './early-signal-monitor.mjs';

export const EARLY_DIGEST_MS = 5 * 60_000;
const SMALL_DEBIT_WEI = 100_000_000_000_000n; // 0.0001 BNB; defer, never discard.

export function earlyTransactionGroups(changes) {
  const groups = new Map();
  for (const event of changes) {
    const key = event.transactionHash || event.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(event);
  }
  return [...groups.values()];
}

export function nativeBalanceDelta(event) {
  const raw = event.deltaWei ?? event.detail?.match(/wei (-?\d+)/)?.[1];
  try { return raw == null ? null : BigInt(raw); } catch { return null; }
}

// Default to immediate delivery. Unknown/old state is never evidence that an
// operation is routine. No raw event is dropped by the notification policy.
export function earlyNotificationPriority(events, state, nowMs) {
  if (events.every(e => e.kind === 'nativeBalance')) {
    return events.every(e => {
      const delta = nativeBalanceDelta(e);
      return delta !== null && delta < 0n && delta >= -SMALL_DEBIT_WEI;
    }) ? 'digest' : 'immediate';
  }
  if (events.every(e => e.kind === 'transfer' && e.passiveIncoming === true)) return 'digest';
  // Every deposit, withdrawal, proposal, status change, purchase, wrap, native transfer,
  // authority change, reorg and unknown kind remains immediate.
  // Only standalone approvals can qualify below. A deposit selects its entire
  // receipt for immediate acknowledgement; presentation omits ancillary logs.
  if (!events.every(e => e.kind === 'approval')) return 'immediate';
  const tokens = [...new Set(events.map(e => e.token).filter(t => t && !BASE_ASSETS.has(t)))];
  if (!tokens.length) return 'immediate';
  if (events.some(e => e.token && !BASE_ASSETS.has(e.token) && e.enabledAtObservation !== true)) return 'immediate';
  const freshOpened = token => {
    const meta = state.tokens?.[token];
    const age = nowMs - Date.parse(meta?.configurationCheckedAt || '');
    return meta?.effectiveEnabled === true && age >= 0 && age <= 120_000 && !state.health?.assets?.lastError;
  };
  // Only known LP-manager approvals qualify. Arbitrary spender changes remain urgent.
  if (events.some(e => e.kind === 'approval' && !e.knownLiquiditySpender)) return 'immediate';
  return tokens.every(freshOpened) ? 'digest' : 'immediate';
}

export function selectEarlyNotification(state, nowMs = Date.now()) {
  const groups = earlyTransactionGroups(state.pendingChanges || []);
  const immediate = [], deferred = [];
  for (const group of groups) (earlyNotificationPriority(group, state, nowMs) === 'immediate' ? immediate : deferred).push(group);
  const oldest = deferred.length ? Math.min(...deferred.flat().map(e => Date.parse(e.observedAt) || 0)) : Infinity;
  const due = nowMs - oldest >= EARLY_DIGEST_MS;
  // At most eight transactions, never eight logs cut through the same receipt.
  // Overdue digests get a turn even during continuous urgent traffic.
  const digest = due && (!immediate.length || state.notificationStats?.lastMode === 'immediate');
  const selected = digest ? deferred.slice(0, 32) : immediate.slice(0, 8);
  if (!selected.length) return null;
  const title = digest ? 'Flap 日常操作汇总'
    : selected.every(group => group.some(e => e.kind === 'liquidityRemoved')) ? 'Flap 流动性撤出提醒'
    : selected.every(group => group.every(e => ['nativeBalance', 'nativeTransfer'].includes(e.kind))) ? 'Flap 资金变动提醒'
    : 'Flap 底池提前信号';
  return { changes: selected.flat(), mode: digest ? 'digest' : 'immediate',
    title, template: digest ? 'blue' : 'orange' };
}

function bnb(wei) {
  const sign = wei < 0n ? '-' : '';
  const n = wei < 0n ? -wei : wei;
  return sign + n / 10n ** 18n + '.' + (n % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '').padEnd(1, '0');
}

export function buildEarlyNotificationContent(changes, state, mode) {
  if (mode !== 'digest') return buildEarlySignalContent(changes, state);
  const lines = ['📋 日常操作汇总｜采集频率不变，以下记录合并通知'];
  const balances = new Map();
  for (const event of changes.filter(e => e.kind === 'nativeBalance')) {
    const address = event.address || event.detail?.match(/0x[a-fA-F0-9]{40}/)?.[0] || '未知地址';
    if (!balances.has(address)) balances.set(address, []);
    balances.get(address).push(event);
  }
  for (const [address, events] of balances) {
    const deltas = events.map(nativeBalanceDelta);
    // Malformed legacy values must be shown verbatim, not silently coalesced.
    if (deltas.some(d => d === null)) { lines.push(...events.map(e => `${e.observedAt}｜${e.detail}`)); continue; }
    const sorted = events.map(e => e.observedAt).sort();
    lines.push(`⛽ [钱包](${`https://bscscan.com/address/${address}`})｜${events.length} 次小额 BNB 扣减，合计 ${bnb(deltas.reduce((a, b) => a + b, 0n))} BNB`,
      `时间：${sorted[0]} — ${sorted.at(-1)}`, '含 Gas／内部转账影响；未仅凭金额认定为 Gas，逐次记录保留。');
  }
  const other = changes.filter(e => e.kind !== 'nativeBalance');
  if (other.length) lines.push(buildEarlySignalContent(other, state));
  return lines.join('\n');
}
