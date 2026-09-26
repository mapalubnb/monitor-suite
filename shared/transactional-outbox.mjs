import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

// Each scan sees isolated root fields. Only changed fields are merged at commit;
// snapshot and notifications are persisted by one atomic rename before delivery.
export function createTransactionalOutbox({ initial = {}, persist, deliver, onError = () => {} }) {
  let root = initial;
  let draining = false;
  const context = new AsyncLocalStorage();
  const encode = value => JSON.stringify(value);
  const scope = () => { const tx = context.getStore(); return tx?.active ? tx : undefined; };
  function field(key) {
    const tx = scope();
    if (!tx) return root[key];
    if (!tx.values.has(key)) {
      tx.before.set(key, encode(root[key]));
      tx.values.set(key, structuredClone(root[key]));
    }
    return tx.values.get(key);
  }
  const state = new Proxy({}, {
    get: (_, key) => field(key),
    set: (_, key, value) => {
      if (scope()) { field(key); scope().values.set(key, value); }
      else root[key] = value;
      return true;
    },
    deleteProperty: (_, key) => {
      if (scope()) { field(key); scope().values.set(key, undefined); }
      else delete root[key];
      return true;
    },
    ownKeys: () => [...new Set([...Object.keys(root), ...(scope()?.values.keys() || [])])],
    getOwnPropertyDescriptor: (_, key) => field(key) === undefined ? undefined : { enumerable: true, configurable: true },
    has: (_, key) => field(key) !== undefined,
  });
  function write(next) { persist(next); root = next; }
  async function transaction(fn) {
    if (scope()) return fn();
    const tx = { active: true, before: new Map(), values: new Map(), notifications: [] };
    try {
      const result = await context.run(tx, fn);
      const next = { ...root };
      let dirty = false;
      for (const [key, value] of tx.values) {
        const encoded = encode(value);
        if (encoded === tx.before.get(key)) continue;
        if (encode(root[key]) !== tx.before.get(key)) {
          throw new Error(`并发快照字段冲突：${String(key)}，下轮重试`);
        }
        if (value === undefined) delete next[key];
        else next[key] = value;
        dirty = true;
      }
      if (tx.notifications.length) {
        next._notificationOutbox = [...(root._notificationOutbox || []), ...tx.notifications];
        dirty = true;
      }
      if (dirty) write(next);
      return result;
    } finally {
      // Timers/requests created inside a scan inherit AsyncLocalStorage. Release
      // large cloned snapshots even when those async resources outlive the scan.
      tx.active = false;
      tx.before.clear();
      tx.values.clear();
      tx.notifications.length = 0;
    }
  }
  async function enqueue(payload) {
    if (!scope()) return transaction(() => enqueue(payload));
    const entry = { id: randomUUID(), payload: JSON.parse(JSON.stringify(payload)), createdAt: Date.now(), attempts: 0, nextAttemptAt: 0, parts: [] };
    scope().notifications.push(entry);
    return entry.id;
  }
  async function drain(now = Date.now()) {
    if (draining) return;
    draining = true;
    try {
      // A failed alert must not starve unrelated newer alerts.
      for (const candidate of [...(root._notificationOutbox || [])]) {
        if (candidate.nextAttemptAt > now) continue;
        const update = patch => {
          const entries = (root._notificationOutbox || []).map(entry => entry.id === candidate.id ? { ...entry, ...patch } : entry);
          write({ ...root, _notificationOutbox: entries });
        };
        try {
          const id = await deliver(candidate.payload, {
            deliveryId: candidate.id, sentParts: candidate.parts,
            cardParts: candidate.cardParts,
            onPlan: async cardParts => update({ cardParts: structuredClone(cardParts) }),
            onPartSent: async parts => update({ parts: [...parts] }),
          });
          if (!id) throw new Error('通知未返回 message_id');
          write({ ...root, _notificationOutbox: (root._notificationOutbox || []).filter(entry => entry.id !== candidate.id) });
        } catch (error) {
          const attempts = candidate.attempts + 1;
          update({ attempts, nextAttemptAt: Date.now() + Math.min(300_000, 2_000 * 2 ** Math.min(attempts, 8)), lastError: error.message });
          onError(error);
        }
      }
    } finally { draining = false; }
  }
  return { state, transaction, enqueue, drain, inTransaction: () => !!scope(), flush: () => { if (!scope()) write({ ...root }); }, replace: value => { root = value; } };
}
