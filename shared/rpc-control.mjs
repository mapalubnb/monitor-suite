import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRpcBudget } from './rpc-budget.mjs';

export const RPC_BATCH_SIZE = 8;

// Only provider-wide failures are shared. Archive/range errors stay with the
// caller's range-specific policy and cannot quarantine recent reads.
export function createRpcControl({ directory = '', now = Date.now, concurrency = 2, limits = JSON.parse(process.env.RPC_PROVIDER_LIMITS || '{}') } = {}) {
  const budget = createRpcBudget({ directory, limits, now });
  const cooldowns = new Map(), checked = new Map(), active = new Map(), waiters = new Map(), inflight = new Map(), cache = new Map();
  const metrics = { requested: 0, reused: 0, cooled: 0, failures: 0 };
  function key(url) {
    const parsed = new URL(url);
    if (parsed.hostname.endsWith('.publicnode.com')) parsed.hostname = 'publicnode.com';
    return createHash('sha256').update(parsed.href).digest('hex');
  }
  function cooldown(url) {
    const id = key(url);
    if (directory && now() - (checked.get(id) || 0) >= 1000) {
      checked.set(id, now());
      try {
        const saved = JSON.parse(readFileSync(join(directory, id + '.json'), 'utf8'));
        if (Number.isFinite(saved.until) && saved.until > (cooldowns.get(id)?.until || 0)) cooldowns.set(id, saved);
      } catch { /* Other processes may not have observed a failure. */ }
    }
    const entry = cooldowns.get(id);
    return entry?.until > now() ? entry : null;
  }
  function failure(url, error, response) {
    const status = Number(response?.status || error?.status);
    const message = String(error?.message || '');
    const quota = status === 429 || /HTTP 429|compute units|rate.?limit|usage limit|too many requests/i.test(message);
    const denied = [401, 403].includes(status) || /HTTP (401|403)/.test(message);
    if (!quota && !denied) return;
    const retry = response?.headers?.get?.('retry-after');
    const retryMs = retry ? (/^\d+(\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - now()) : 0;
    const id = key(url);
    const entry = { until: Math.max(cooldown(url)?.until || 0, now() + Math.max(retryMs || 0, denied ? 300_000 : 30_000)), reason: quota ? 'RPC 限流' : 'RPC 访问被拒绝' };
    cooldowns.set(id, entry);
    metrics.failures++;
    if (directory) {
      try {
        mkdirSync(directory, { recursive: true });
        const file = join(directory, id + '.json'), tmp = file + '.' + randomUUID() + '.tmp';
        writeFileSync(tmp, JSON.stringify(entry));
        renameSync(tmp, file);
      } catch { /* In-memory cooldown still protects this process. */ }
    }
  }
  function assertAvailable(url) {
    const entry = cooldown(url);
    if (!entry) return;
    metrics.cooled++;
    const error = new Error(`${new URL(url).hostname}: ${entry.reason}，等待恢复`);
    error.retryAfterMs = entry.until - now();
    error.rpcCooldown = true;
    throw error;
  }
  async function withEndpoint(url, operation, signal, request = {}) {
    assertAvailable(url);
    const id = key(url);
    if ((active.get(id) || 0) >= concurrency) await new Promise((resolve, reject) => {
      const queue = waiters.get(id) || [];
      const item = { resolve: () => { signal?.removeEventListener('abort', abort); resolve(); } };
      const abort = () => { const index = queue.indexOf(item); if (index >= 0) queue.splice(index, 1); reject(signal.reason || new Error('RPC 已取消')); };
      queue.push(item); waiters.set(id, queue);
      if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    });
    else active.set(id, (active.get(id) || 0) + 1);
    let release;
    try {
      signal?.throwIfAborted(); assertAvailable(url);
      release = directory ? await budget.acquire(url, { ...request, signal }) : null;
      signal?.throwIfAborted(); assertAvailable(url); metrics.requested++;
      return await operation();
    }
    finally {
      try { if (release) await release(); }
      finally {
        const next = waiters.get(id)?.shift();
        if (next) next.resolve(); // Transfer the occupied slot to the waiter.
        else active.set(id, Math.max(0, (active.get(id) || 1) - 1));
      }
    }
  }
  async function coalesce(id, operation, ttlMs = 0) {
    const cached = cache.get(id);
    if (cached?.until > now()) { metrics.reused++; return structuredClone(cached.value); }
    if (inflight.has(id)) { metrics.reused++; return structuredClone(await inflight.get(id)); }
    const request = Promise.resolve().then(operation);
    inflight.set(id, request);
    try {
      const value = await request;
      if (ttlMs && value != null) {
        cache.set(id, { value: structuredClone(value), until: now() + ttlMs });
        if (cache.size > 256) cache.delete(cache.keys().next().value);
      }
      return value;
    } finally { inflight.delete(id); }
  }
  return { cooldown, failure, withEndpoint, coalesce, metrics,
    reset() { cooldowns.clear(); checked.clear(); cache.clear(); },
    summary: () => ({ ...metrics, ...budget.metrics, inFlight: inflight.size, queued: [...waiters.values()].reduce((n, q) => n + q.length, 0) }),
  };
}

// Keep full block/receipt reads and reorg checks fresh. Only cheap network
// identity and a sub-poll head sample are reused after completion.
export function rpcCacheTtl(payload) {
  if (Array.isArray(payload)) return 0;
  return payload.method === 'eth_chainId' ? 60_000 : payload.method === 'eth_blockNumber' ? 100 : 0;
}

export function rpcReadLane(payload) {
  const blockMethods = new Set(['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getTransactionByHash', 'eth_getTransactionReceipt']);
  return (Array.isArray(payload) ? payload : [payload]).every(item => blockMethods.has(item.method)) ? 'block' : 'read';
}

export function createRpcErrorLogger(write, { now = Date.now, intervalMs = 30_000 } = {}) {
  const recent = new Map();
  return message => {
    if (!/eth_getLogs|所有.*RPC|RPC.*冷却/.test(message)) { write(message); return; }
    const entry = recent.get(message);
    if (entry && now() - entry.at < intervalMs) { entry.skipped++; return; }
    write(message + (entry?.skipped ? `（已合并 ${entry.skipped} 条同类日志）` : ''));
    recent.set(message, { at: now(), skipped: 0 });
    if (recent.size > 256) recent.delete(recent.keys().next().value);
  };
}
