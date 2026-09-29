import { BASE_ASSETS } from './early-signal-catalog.mjs';
import { cowGroupUid } from './cow-notifications.mjs';

const SMALL_DEBIT_WEI = 100_000_000_000_000n; // 0.0001 BNB; record silently; retain raw evidence.

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
  if (cowGroupUid(events)) return 'cow';
  if (events.every(e => e.kind === 'nativeBalance')) {
    return events.every(e => {
      const delta = nativeBalanceDelta(e);
      return delta !== null && delta < 0n && delta >= -SMALL_DEBIT_WEI;
    }) ? 'silent' : 'immediate';
  }
  if (events.every(e => e.kind === 'transfer' && e.passiveIncoming === true)) return 'silent';
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
  return tokens.every(freshOpened) ? 'silent' : 'immediate';
}

// Retire the old digest plan, but reclassify its events rather than losing a
// deposit or another important event that used to be classified differently.
export function archiveRoutineEarlySignals(state, nowMs = Date.now()) {
  let changed = false;
  if (state.notificationDelivery?.mode === 'digest') {
    delete state.notificationDelivery;
    changed = true;
  }
  const protectedIds = new Set(state.notificationDelivery?.ids || []);
  const quiet = earlyTransactionGroups(state.pendingChanges || []).filter(group =>
    !group.some(e => protectedIds.has(e.id)) && earlyNotificationPriority(group, state, nowMs) === 'silent').flat();
  if (quiet.length) {
    const ids = new Set(quiet.map(e => e.id));
    state.events ||= {};
    for (const event of quiet) state.events[event.id] = { ...(state.events[event.id] || event),
      notificationDisposition: 'silent', notificationHandledAt: new Date(nowMs).toISOString() };
    state.pendingChanges = state.pendingChanges.filter(e => !ids.has(e.id));
    state.notificationStats = { ...state.notificationStats,
      silentEvents: (state.notificationStats?.silentEvents || 0) + quiet.length };
    changed = true;
  }
  return { changed, archived: quiet.length };
}

export function selectEarlyNotification(state, nowMs = Date.now()) {
  const selected = earlyTransactionGroups(state.pendingChanges || [])
    .filter(group => earlyNotificationPriority(group, state, nowMs) === 'immediate').slice(0, 8);
  if (!selected.length) return null;
  const title = selected.every(group => group.some(e => e.kind === 'liquidityRemoved')) ? 'Flap 流动性撤出提醒'
    : selected.every(group => group.every(e => ['nativeBalance', 'nativeTransfer'].includes(e.kind))) ? 'Flap 资金变动提醒'
    : 'Flap 底池提前信号';
  return { changes: selected.flat(), mode: 'immediate', title, template: 'orange' };
}
