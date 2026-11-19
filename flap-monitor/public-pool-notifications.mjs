import { POOL_KINDS } from './pool-relevance.mjs';
import { formatBeijingTime } from '../shared/display-format.cjs';

export const isPublicPoolEvent = e => POOL_KINDS.has(e.kind) && e.poolRelevance === 'public';
const assetName = (state, token) => String(state.tokens?.[token]?.name || state.tokens?.[token]?.symbol || token)
  .replace(/[\`*_\[\]<>\r\n]/g, '');

export function expiredPublicPoolMessage(error) {
  return Number(error?.response?.data?.code ?? error?.code) === 230031
    || /\bcode\s*=\s*230031\b/.test(error?.message || '');
}

export function archivePublicPoolBacklog(state, nowMs = Date.now()) {
  if (state.publicPoolArchive) return null;
  const groups = new Map();
  for (const event of state.pendingChanges) {
    const key = event.transactionHash || event.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(event);
  }
  const plan = state.notificationDelivery;
  // An interrupted send must keep its original plan and receipt, including
  // other records from the same transaction. A failed edit has no sent parts.
  const editing = plan?.mode === 'public-patch' && !plan.sentParts?.length;
  const protectedIds = new Set(editing ? [] : plan?.ids);
  const entries = [...groups.values()].filter(group => group.every(isPublicPoolEvent)
    && !group.some(event => protectedIds.has(event.id))).flat();
  const events = Object.fromEntries(entries.map(event => [event.id, event]));
  const publicPoolArchive = { archivedAt: new Date(nowMs).toISOString(), events };
  const next = { ...state, publicPoolArchive, pendingChanges: state.pendingChanges.filter(event => !Object.hasOwn(events, event.id)) };
  if (editing && plan.ids.every(id => Object.hasOwn(events, id))) delete next.notificationDelivery;
  return next;
}

export function buildPublicPoolBacklogSummary(state) {
  const rows = Object.values(state.publicPoolArchive?.events || {}).filter(event => !event.revertedAt);
  if (!rows.length) return null;
  const assets = new Set(rows.map(event => event.token));
  const groups = new Map(), monitored = new Map();
  for (const event of rows) {
    if (event.poolAddress && event.transactionHash) {
      const key = [event.token, event.poolAddress, event.transactionHash].join('|');
      const group = groups.get(key) || {};
      group[event.kind] = event;
      groups.set(key, group);
    }
    if (state.pools[event.poolAddress]?.officialOperation) {
      const entry = monitored.get(event.poolAddress) || { token: event.token, count: 0 };
      entry.count++;
      monitored.set(event.poolAddress, entry);
    }
  }
  const launches = [...groups.values()].filter(group => group.poolCreated && group.liquidityAdded)
    .map(group => group.poolCreated).sort((a, b) => b.blockNumber - a.blockNumber || b.logIndex - a.logIndex);
  const newestByAsset = new Map();
  for (const row of launches) if (!newestByAsset.has(row.token)) newestByAsset.set(row.token, row);
  const recentLaunches = [...newestByAsset.values()].slice(0, 6);
  const poolEntries = [...monitored.values()].sort((a, b) => b.count - a.count);
  const count = kind => rows.filter(event => event.kind === kind).length;
  const content = [
    '以下为历史公共池观察，原始事件与去重已保留。',
    `归档 ${rows.length} 条｜${assets.size} 个资产｜建池 ${count('poolCreated')}｜加池 ${count('liquidityAdded')}｜撤池 ${count('liquidityRemoved')}`,
    `同笔建池并加池 ${launches.length} 组，最近样本：`,
    ...recentLaunches.map(e => `[${assetName(state, e.token)}](https://bscscan.com/tx/${e.transactionHash})｜区块 ${e.blockNumber}`),
    `曾观测到监控钱包参与的池子 ${poolEntries.length} 个，相关历史公共记录：`,
    ...poolEntries.slice(0, 6).map(e => `[${assetName(state, e.token)}](https://bscscan.com/address/${e.token})｜${e.count} 条`),
    '归档记录未发现该笔交易有监控钱包参与。它们属于公共池活动观察，开放状态以链上配置为准。',
    `归档时间 ${formatBeijingTime(state.publicPoolArchive.archivedAt)}`,
  ].join('\n');
  return { title: 'Flap 公共池历史重点摘要', content, template: 'grey' };
}

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
    const name = assetName(state, token);
    const patchMessageId = previous.messageId && previous.messageId !== previous.expiredMessageId ? previous.messageId : null;
    const content = ['🌐 公共池活动｜未发现监控钱包参与证据',
      `资产：[${name}](https://bscscan.com/address/${token})`, `合约：${token}`,
      '这些活动不代表 Flap 官方加池、撤池或开放底池。',
      `保留记录：建池 ${count('poolCreated')}｜加池 ${count('liquidityAdded')}｜撤池 ${count('liquidityRemoved')}`,
      '后续活动更新本卡，监控钱包的重要操作另行即时提醒。',
      `[最近交易](https://bscscan.com/tx/${latest.transactionHash})｜区块 ${latest.blockNumber}`,
      `🕒 ${latest.observedAt}`].join('\n');
    return { changes, title: 'Flap 公共池观察', template: 'grey', content,
      mode: patchMessageId ? 'public-patch' : 'public-notice',
      publicToken: token, patchMessageId };
  }
  return null;
}
