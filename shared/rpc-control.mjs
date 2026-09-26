import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRpcBudget } from './rpc-budget.mjs';

export const RPC_BATCH_SIZE = 8;

export function rpcRequestScope({ payload, history = false } = {}) {
  if (!payload) return '';
  const methods = [...new Set((Array.isArray(payload) ? payload : [payload]).map(item => item.method))].sort();
  return methods.join(',') + (methods.includes('eth_getLogs') ? (history ? ':history' : ':realtime') : '');
}

// Only provider-wide failures are shared. Archive/range errors stay with the
// caller's range-specific policy and cannot quarantine recent reads.
export function createRpcControl({ directory = '', now = Date.now, concurrency = 2, limits = JSON.parse(process.env.RPC_PROVIDER_LIMITS || '{}') } = {}) {
  const budget = createRpcBudget({ directory, limits, now });
  const cooldowns = new Map(), checked = new Map(), active = new Map(), activeHistory = new Map(), waiters = new Map(), inflight = new Map(), cache = new Map();
  const metrics = { requested: 0, reused: 0, cooled: 0, failures: 0, upstream429: 0, denied: 0, timeouts: 0, hedgeSkipped: 0 };
  const methods = new Map();
  function key(url, scope = '') {
    const parsed = new URL(url);
    if (parsed.hostname.endsWith('.publicnode.com')) parsed.hostname = 'publicnode.com';
    return createHash('sha256').update('v2:' + parsed.href + ':' + scope).digest('hex');
  }
  function scopedCooldown(url, scope = '') {
    const id = key(url, scope);
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
  function cooldown(url, request = {}) {
    return scopedCooldown(url) || (rpcRequestScope(request) ? scopedCooldown(url, rpcRequestScope(request)) : null);
  }
  function failure(url, error, response, request = {}) {
    const status = Number(response?.status || error?.status);
    const message = String(error?.message || '');
    const quota = status === 429 || /HTTP 429|compute units|rate.?limit|usage limit|too many requests/i.test(message);
    const denied = [401, 403].includes(status) || /HTTP (401|403)/.test(message);
    if (!quota && !denied) return;
    const retry = response?.headers?.get?.('retry-after');
    const retryMs = retry ? (/^\d+(\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - now()) : 0;
    const global = status === 401 || /HTTP 401|compute units|account.*(?:limit|disabled)|invalid.*api.?key/i.test(message);
    const scope = global ? '' : rpcRequestScope(request);
    const id = key(url, scope);
    const entry = { until: Math.max(scopedCooldown(url, scope)?.until || 0, now() + Math.max(retryMs || 0, denied ? 300_000 : 30_000)), reason: quota ? 'RPC 限流' : 'RPC 访问被拒绝', scope };
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
  function assertAvailable(url, request) {
    const entry = cooldown(url, request);
    if (!entry) return;
    metrics.cooled++;
    const error = new Error(`${new URL(url).hostname}: ${entry.reason}，等待恢复`);
    error.retryAfterMs = entry.until - now();
    error.rpcCooldown = true;
    throw error;
  }
  async function withEndpoint(url, operation, signal, request = {}) {
    assertAvailable(url, request);
    const id = key(url);
    const available = () => (active.get(id) || 0) < concurrency && (!request.history || !(activeHistory.get(id) || 0));
    const occupy = () => { active.set(id, (active.get(id) || 0) + 1); if (request.history) activeHistory.set(id, (activeHistory.get(id) || 0) + 1); };
    if (request.speculative && (!available() || waiters.get(id)?.length)) {
      metrics.hedgeSkipped++;
      throw Object.assign(new Error('RPC 备用竞速等待空闲容量'), { rpcBudget: true });
    }
    if (!available()) await new Promise((resolve, reject) => {
      const queue = waiters.get(id) || [];
      const item = { history: request.history, critical: request.critical, resolve: () => { occupy(); signal?.removeEventListener('abort', abort); resolve(); } };
      const abort = () => { const index = queue.indexOf(item); if (index >= 0) queue.splice(index, 1); reject(signal.reason || new Error('RPC 已取消')); };
      queue.push(item); waiters.set(id, queue);
      if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    });
    else occupy();
    let release;
    try {
      signal?.throwIfAborted(); assertAvailable(url, request);
      release = directory ? await budget.acquire(url, { ...request, signal }) : null;
      signal?.throwIfAborted(); assertAvailable(url, request); metrics.requested++;
      const started = now(), methodKey = new URL(url).hostname + ':' + rpcRequestScope(request);
      const stats = methods.get(methodKey) || { ok: 0, failed: 0, totalMs: 0, maxMs: 0 };
      methods.set(methodKey, stats);
      try { const value = await operation(); stats.ok++; return value; }
      catch (error) {
        if (!signal?.aborted) { stats.failed++; if (/429|rate.?limit/i.test(error.message)) metrics.upstream429++; else if (/403|401/.test(error.message)) metrics.denied++; else if (/timeout|timed out/i.test(error.message)) metrics.timeouts++; }
        throw error;
      } finally { stats.lastMs = now() - started; stats.totalMs += stats.lastMs; stats.maxMs = Math.max(stats.maxMs, stats.lastMs); }
    }
    finally {
      try { if (release) await release(); }
      finally {
        active.set(id, Math.max(0, (active.get(id) || 1) - 1));
        if (request.history) activeHistory.set(id, Math.max(0, (activeHistory.get(id) || 1) - 1));
        const queue = waiters.get(id) || [];
        while ((active.get(id) || 0) < concurrency) {
          const eligible = item => !item.history || !(activeHistory.get(id) || 0);
          let index = queue.findIndex(item => eligible(item) && item.critical);
          if (index < 0) index = queue.findIndex(item => eligible(item) && !item.history);
          if (index < 0) index = queue.findIndex(eligible);
          if (index < 0) break;
          queue.splice(index, 1)[0].resolve();
        }
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
    summary: () => ({ ...metrics, ...budget.metrics, methods: Object.fromEntries(methods), inFlight: inflight.size, queued: [...waiters.values()].reduce((n, q) => n + q.length, 0) }),
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
