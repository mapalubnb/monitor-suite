import { activateHistoryGap } from '../shared/scan-recovery.mjs';

// Serialize only the short actor commits. RPC collection never holds a transaction.
export function createActorStateCoordinator({ store, ensureLedger, rememberNotifications, buildNotification, isStopping = () => false }) {
  let pending = Promise.resolve();
  const commitTask = fn => {
    const task = pending.then(() => store.transaction(() => {
      if (isStopping()) throw new Error('创建者监听正在停止，保留游标');
      return fn();
    }));
    pending = task.catch(() => {});
    return task;
  };
  const lane = (target, realtime) => realtime ? target.chainActorMonitor.realtime : target.chainActorHistory;
  // Only history handoff may change the live gap queue during a live scan.
  const revision = (state, realtime) => JSON.stringify(realtime ? { ...state, realtimeGaps: undefined } : state);
  return {
    prepare(realtime, now = Date.now()) {
      return commitTask(() => {
        const target = store.state;
        const root = target.chainActorMonitor ||= {};
        root.creators ||= {};
        root.seenTxs ||= [];
        root.actors ||= {};
        if (realtime) root.realtime ||= { creators: root.creators, creatorLookup: root.creatorLookup || {}, seenTxs: [] };
        else {
          if (root.historyEndBlock == null) return null;
          const history = target.chainActorHistory ||= { ...structuredClone(root), realtime: undefined };
          history.historyEndBlock ??= root.historyEndBlock;
          if (activateHistoryGap(history, root.realtime || {}, 'lastBlock', 'historyEndBlock')) history.lastBlockHash = '';
          if (now < (history.historyNextAt || 0)) return null;
        }
        ensureLedger(target);
        return {
          realtime, base: revision(lane(target, realtime), realtime), addedGaps: [], batches: [],
          snapshot: structuredClone({ chainActorMonitor: root, chainActorHistory: target.chainActorHistory,
            creatorDiscovery: target.creatorDiscovery, actorNotificationLedger: target.actorNotificationLedger }),
        };
      });
    },
    commit(work) {
      return commitTask(async () => {
        const target = store.state;
        const current = lane(target, work.realtime);
        if (revision(current, work.realtime) !== work.base) throw new Error('创建者扫描基线已变化，保留当前游标并重新采集');
        const next = structuredClone(lane(work.snapshot, work.realtime));
        if (work.realtime) {
          const ranges = [...(current.realtimeGaps || []), ...work.addedGaps].sort((a, b) => a.from - b.from);
          next.realtimeGaps = [];
          for (const range of ranges) {
            const last = next.realtimeGaps.at(-1);
            if (last && range.from <= last.to + 1) last.to = Math.max(last.to, range.to);
            else next.realtimeGaps.push({ ...range });
          }
          target.chainActorMonitor.realtime = next;
          target.chainActorMonitor.historyEndBlock ??= work.snapshot.chainActorMonitor.historyEndBlock;
        } else target.chainActorHistory = next;
        const ledger = ensureLedger(target);
        const notifications = [];
        for (const batch of work.batches) {
          // Recheck the committed ledger: the other lane may have delivered this
          // transaction while the RPC request was in flight. Preserve reorg keys.
          const actions = batch.actions.filter(a => !(a.hash in ledger.entries) && !(`${a.hash}:${a.blockHash}` in ledger.entries));
          if (!actions.length) continue;
          rememberNotifications(target, actions);
          const payload = buildNotification(actions, work.realtime, batch.toBlock);
          await store.enqueue(payload);
          notifications.push(payload);
        }
        rememberNotifications(target, []);
        return notifications;
      });
    },
  };
}
