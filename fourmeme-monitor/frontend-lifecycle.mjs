import { AsyncLocalStorage } from 'node:async_hooks';
import { withAbortSignal } from '../shared/request-deadline.mjs';

const context = new AsyncLocalStorage();
export function frontendSignal() { return context.getStore()?.signal; }
export function assertFrontendActive() {
  const scope = context.getStore();
  if (scope && !scope.closed && scope.now() - scope.health.startedAt >= scope.timeoutMs) scope.expire();
  scope?.signal.throwIfAborted();
  if (scope?.closed) throw new Error('前端轮次已结束，拒绝迟到操作');
}
export function frontendStage(stage) {
  assertFrontendActive();
  const scope = context.getStore();
  if (scope) { scope.health.stage = stage; scope.health.lastProgressAt = Date.now(); }
}
export function frontendRequest(url) {
  assertFrontendActive();
  const scope = context.getStore();
  if (!scope) return () => {};
  const u = new URL(url), id = ++scope.requestId;
  const item = { url: u.origin + u.pathname, stage: 'queue', startedAt: Date.now() };
  scope.requests.set(id, item);
  return stage => {
    if (!stage) { scope.requests.delete(id); return; }
    assertFrontendActive();
    item.stage = stage;
    scope.health.lastProgressAt = Date.now();
  };
}

// Only the frontend opts into this lifecycle. The independent health timer can
// abort a stale round even when its caller/scheduler is still waiting for it.
export function createFrontendGuard({ timeoutMs = 180_000, now = Date.now, notify = () => {}, changed = () => {}, isSuccessful = () => true, initiallyAlerted = false } = {}) {
  const health = { running: false, startedAt: 0, finishedAt: 0, lastSuccessAt: 0,
    lastProgressAt: 0, stage: 'idle', timeouts: 0, lastError: '', lastFailure: null };
  let active, alerted = initiallyAlerted;
  const emit = event => { try { Promise.resolve(notify(event)).catch(() => {}); } catch {} };
  function timeout() {
    if (!active || active.signal.aborted) return;
    const failure = { stage: health.stage, startedAt: health.startedAt,
      requests: [...active.requests.values()].slice(0, 20) };
    const error = new Error(`前端整轮超过截止时间 ${timeoutMs}ms；阶段 ${health.stage}`);
    error.code = 'FRONTEND_DEADLINE';
    health.lastFailure = failure;
    health.timeouts++;
    active.controller.abort(error);
  }
  function check() {
    if (active && now() - health.startedAt >= timeoutMs) timeout();
    changed();
  }
  async function run(fn) {
    if (active) throw new Error('前端轮次重复运行');
    const controller = new AbortController();
    const scope = { controller, signal: controller.signal, closed: false, health, requests: new Map(), requestId: 0, now, timeoutMs, expire: timeout };
    active = scope;
    Object.assign(health, { running: true, startedAt: now(), stage: 'start', lastProgressAt: now() });
    const timer = setTimeout(timeout, timeoutMs);
    changed();
    try {
      const value = await withAbortSignal(() => context.run(scope, () => fn(scope.signal)), scope.signal);
      if (isSuccessful(value)) {
        health.lastSuccessAt = now();
        health.lastError = '';
        if (alerted) { alerted = false; emit({ type: 'recovered', ...health }); }
      }
      return value;
    } catch (error) {
      health.lastError = error.message;
      if (error.code === 'FRONTEND_DEADLINE' && !alerted) {
        alerted = true;
        emit({ type: 'stalled', ...health });
      }
      throw error;
    } finally {
      clearTimeout(timer);
      scope.closed = true;
      scope.requests.clear();
      active = null;
      health.running = false;
      health.finishedAt = now();
      health.stage = 'idle';
      changed();
    }
  }
  return { run, check, snapshot: () => ({ ...health, timeoutMs,
    activeRequests: [...(active?.requests.values() || [])].slice(0, 20) }) };
}
