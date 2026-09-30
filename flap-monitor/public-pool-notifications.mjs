import { POOL_KINDS } from './pool-relevance.mjs';

export const isPublicPoolEvent = e => POOL_KINDS.has(e.kind) && e.poolRelevance === 'public';
export function selectPublicPoolNotification(state, nowMs = Date.now()) {
  const groups = new Map();
  for (const e of state.pendingChanges || []) {
    const key = e.transactionHash || e.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  const available = [...groups.values()].filter(g => g.every(isPublicPoolEvent)).flat();
  for (const token of new Set(available.map(e => e.token))) {
    const previous = state.publicPoolNotifications?.[token] || {};
    if (previous.nextAttemptAtMs > nowMs) continue;
    const changes = available.filter(e => e.token === token);
    const selectedIds = new Set(changes.map(e => e.id));
    // Counts describe retained evidence, not lifetime totals; reorg removal is reflected.
    const rows = Object.values(state.events || {}).filter(e => e.token === token && isPublicPoolEvent(e)
      && (selectedIds.has(e.id) || e.notificationDisposition?.startsWith('public-')));
    const count = kind => rows.filter(e => e.kind === kind).length;
    const latest = [...rows].sort((a,b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex).at(-1) || changes.at(-1);
    const name = String(state.tokens?.[token]?.name || state.tokens?.[token]?.symbol || token).replace(/[\\`*_[\]<>\r\n]/g, '');
    const content = ['🌐 公共池活动｜未发现监控钱包参与证据',
      `资产：[${name}](https://bscscan.com/address/${token})`, `合约：${token}`,
      '这些活动不代表 Flap 官方加池、撤池或开放底池。',
      `保留记录：建池 ${count('poolCreated')}｜加池 ${count('liquidityAdded')}｜撤池 ${count('liquidityRemoved')}`,
      '后续活动更新本卡，监控钱包的重要操作另行即时提醒。',
      `[最近交易](https://bscscan.com/tx/${latest.transactionHash})｜区块 ${latest.blockNumber}`,
      `🕒 ${latest.observedAt}`].join('\n');
    return { changes, title: 'Flap 公共池观察', template: 'grey', content,
      mode: previous.messageId ? 'public-patch' : 'public-notice',
      publicToken: token, patchMessageId: previous.messageId || null };
  }
  return null;
}
