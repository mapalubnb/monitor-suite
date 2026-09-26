import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export function rpcProvider(url) {
  const parsed = new URL(url);
  if (parsed.hostname.endsWith('.publicnode.com')) return 'bsc.publicnode.com';
  if (/^bsc-dataseed.*\.(bnbchain|binance)\.org$/.test(parsed.hostname)) return 'bsc-dataseed.bnbchain.org';
  return parsed.hostname;
}

// Shared by local monitor processes. A lease is charged before the HTTP request;
// queued work never consumes an HTTP timeout or silently bypasses the budget.
export function createRpcBudget({ directory, limits = {}, now = Date.now, maxWaitMs = 1000 } = {}) {
  const metrics = { budgetWaits: 0, budgetRejected: 0, budgetWaitMs: 0 };
  const alive = pid => { if (!Number.isInteger(pid) || pid < 1) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };
  function settings(url) {
    const host = rpcProvider(url), policy = limits[host] || {};
    const identity = policy.group || (new URL(url).pathname === '/' ? host : host + new URL(url).pathname + new URL(url).search);
    return { host, policy, file: join(directory, createHash('sha256').update(identity).digest('hex') + '.budget.json') };
  }
  function pressure(url, { cost = 1, history = false, critical = false } = {}) {
    if (!directory) return 0;
    const { policy, file } = settings(url);
    try {
      const state = JSON.parse(readFileSync(file, 'utf8'));
      const rate = Number(policy.rps ?? 20), burst = Number(policy.burst ?? 40), limit = Number(policy.concurrency ?? 4);
      const leases = (state.leases || []).filter(lease => lease.until > now() && alive(lease.pid));
      const tokens = Math.min(burst, (state.tokens ?? burst) + Math.max(0, now() - (state.at ?? now())) * rate / 1000);
      const reserve = Math.min(Math.max(0, burst - cost), history ? Number(policy.liveReserve ?? 8) : critical ? 0 : Number(policy.criticalReserve ?? 8));
      return leases.length / limit + Math.max(0, cost + reserve - tokens) / rate + (history && leases.some(lease => lease.history) ? 2 : 0);
    } catch (error) { return error.code === 'ENOENT' ? 0 : 4; }
  }
  async function mutate(file, operation, deadline, signal) {
    const lock = file + '.lock';
    for (;;) {
      signal?.throwIfAborted();
      let held = false;
      try {
        writeFileSync(lock, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 }); held = true;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        // Serialize stale-owner recovery, and re-read after acquiring the guard.
        // Otherwise two reclaimers could delete a new owner's lock.
        const recovery = lock + '.recovery'; let recovering = false;
        try {
          writeFileSync(recovery, '', { flag: 'wx' }); recovering = true;
          try {
            const owner = JSON.parse(readFileSync(lock, 'utf8'));
            if (!alive(owner.pid)) unlinkSync(lock);
          } catch (e) {
            if (e instanceof SyntaxError) {
              try { if (now() - statSync(lock).mtimeMs > 30_000) unlinkSync(lock); } catch (gone) { if (gone.code !== 'ENOENT') throw gone; }
            } else if (e.code !== 'ENOENT') throw e;
          }
        } catch (e) { if (e.code !== 'EEXIST') throw e; }
        finally { if (recovering) unlinkSync(recovery); }
      }
      if (held) {
        try {
          let state = {};
          try { state = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
          const result = operation(state);
          if (result.changed) {
            const tmp = file + '.' + randomUUID() + '.tmp';
            writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 }); renameSync(tmp, file);
          }
          return result;
        } finally { unlinkSync(lock); }
      }
      if (now() >= deadline) throw Object.assign(new Error('RPC 配额锁等待超时'), { rpcBudget: true });
      await delay(10, undefined, { signal });
    }
  }
  async function acquire(url, { cost = 1, history = false, speculative = false, critical = false, signal } = {}) {
    if (!directory) return async () => {};
    const { host, policy, file } = settings(url);
    const rate = Number(policy.rps ?? 20), burst = Number(policy.burst ?? 40), concurrency = Number(policy.concurrency ?? 4);
    if (!(rate > 0 && burst >= 1 && concurrency >= 1)) throw new Error('RPC 配额配置无效：' + host);
    // Public aliases share a budget; private credentials remain isolated unless
    // an explicit group combines endpoints belonging to the same account.
    mkdirSync(directory, { recursive: true });
    const id = randomUUID(), started = now(), deadline = started + (speculative ? 0 : critical ? Math.max(maxWaitMs, 1500) : maxWaitMs);
    cost = Math.max(1, Number(cost) || 1);
    if (cost > burst) { metrics.budgetRejected++; throw Object.assign(new Error('RPC 批次超过节点请求预算'), { rpcBudget: true }); }
    for (;;) {
      const result = await mutate(file, state => {
        const time = now();
        state.leases = (state.leases || []).filter(lease => lease.until > time && alive(lease.pid));
        const tokens = Math.min(burst, (state.tokens ?? burst) + Math.max(0, time - (state.at ?? time)) * rate / 1000);
        const reserve = Math.min(Math.max(0, burst - cost), history || speculative ? Number(policy.liveReserve ?? 8) : critical ? 0 : Number(policy.criticalReserve ?? 8));
        const busy = state.leases.length >= concurrency
          || ((history || speculative) && state.leases.length >= Math.max(1, concurrency - 1))
          || (history && state.leases.some(lease => lease.history));
        if (busy || tokens < cost + reserve) return { changed: false, wait: busy ? 25 : Math.ceil((cost + reserve - tokens) * 1000 / rate) };
        state.tokens = tokens - cost; state.at = time;
        state.leases.push({ id, pid: process.pid, history, until: time + 120_000 });
        return { changed: true, granted: true };
      }, deadline, signal);
      if (result.granted) break;
      if (now() + result.wait > deadline) {
        metrics.budgetRejected++;
        throw Object.assign(new Error('RPC 节点预算暂满，切换备用节点'), { rpcBudget: true, retryAfterMs: result.wait });
      }
      metrics.budgetWaits++;
      await delay(Math.max(1, result.wait), undefined, { signal });
    }
    metrics.budgetWaitMs += now() - started;
    let released = false;
    return async () => {
      if (released) return; released = true;
      await mutate(file, state => { state.leases = (state.leases || []).filter(lease => lease.id !== id); return { changed: true }; }, now() + 2000);
    };
  }
  return { acquire, pressure, metrics };
}
