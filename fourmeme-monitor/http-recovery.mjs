// Four.meme HTTP restrictions are separate from BSC RPC health.
export function isFourmemeHttp(url) {
  try { const h = new URL(url).hostname; return h === 'four.meme' || h.endsWith('.four.meme'); }
  catch { return false; }
}

export function httpScope(url) {
  const u = new URL(url);
  const family = u.pathname.startsWith('/meme-api/') ? 'api'
    : u.pathname.startsWith('/_next/') || u.hostname.startsWith('static.') ? 'static' : 'pages';
  return { host: u.origin, key: `${u.origin}:${family}`, family, path: u.pathname };
}

export function retryAfterMs(value, now = Date.now()) {
  if (!value) return 0;
  if (/^\d+(?:\.\d+)?$/.test(value.trim())) return Number(value) * 1000;
  return Math.max(0, (Date.parse(value) || 0) - now);
}

export function createHttpRecovery({ now = Date.now, onRestriction = () => {}, initial = {} } = {}) {
  const states = new Map(Object.entries(initial.states || {}).filter(([, s]) =>
    Number.isFinite(s?.until) && Number.isFinite(s?.lastFailureAt) && (s.until > now() || now() - s.lastFailureAt < 86400_000))
    .map(([k, s]) => [k, { ...s, probing: false, healthySince: 0, successes: 0 }]));
  const flights = new Map();
  const counters = { requests: 0, reused: 0, skipped: 0, denied: 0, rateLimited: 0, serverErrors: 0 };

  function blocked(url) {
    const scope = httpScope(url);
    return [states.get(scope.host), states.get(scope.key)].find(s => s && (now() < s.until || s.probing));
  }
  function assertAvailable(url) {
    const s = blocked(url);
    if (!s) return;
    counters.skipped++;
    const e = new Error(`[退避中] ${s.scope}，剩余 ${Math.max(1, Math.ceil((s.until - now()) / 1000))}s，上次状态: ${s.status}；来源 ${s.path}`);
    e.code = 'HTTP_COOLDOWN';
    e.retryAt = s.until;
    throw e;
  }
  function fail(url, response, body) {
    const at = now(), scope = httpScope(url);
    // A 403 alone does not prove an IP-wide limit. Independent families failing
    // within a minute are evidence to promote the restriction to the host.
    const crossFamily = response.status === 403 && [...states.values()].some(s =>
      [403, 429].includes(s.status) && s.host === scope.host && s.scope !== scope.key && at - s.lastFailureAt < 60_000);
    const key = response.status === 429 || crossFamily ? scope.host : scope.key;
    const previous = states.get(key);
    const cooling = previous && at < previous.until;
    const delayMs = cooling ? previous.delayMs : Math.min(300_000, response.status >= 500
      ? (previous?.delayMs || 0) + 5000 : Math.max(30_000, (previous?.delayMs || 0) * 2));
    const retryMs = retryAfterMs(response.headers.get('retry-after'), at);
    const headers = Object.fromEntries(['server', 'content-type', 'retry-after', 'cf-ray', 'cf-mitigated']
      .map(k => [k, response.headers.get(k)]).filter(([, v]) => v));
    const preview = body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240);
    const state = { scope: key, host: scope.host, path: scope.path, status: response.status,
      delayMs, until: Math.max(previous?.until || 0, at + (cooling ? 0 : delayMs), at + retryMs),
      lastFailureAt: at, healthySince: 0, successes: 0, probing: false, headers, preview };
    states.set(key, state);
    if (response.status === 429) counters.rateLimited++;
    else if (response.status >= 500) counters.serverErrors++;
    else counters.denied++;
    onRestriction(state);
    const reason = response.status >= 500 ? '服务端错误' : response.status === 429 ? '请求限流' : '访问被拒绝';
    const e = new Error(`HTTP ${response.status} (${reason})；${scope.path}；冷却 ${Math.ceil((state.until - at) / 1000)}s`);
    e.code = 'HTTP_RESTRICTED';
    e.diagnostic = state;
    throw e;
  }
  function success(url, startedAt) {
    const scope = httpScope(url);
    for (const key of [scope.host, scope.key]) {
      const s = states.get(key);
      // Requests already in flight when a rejection arrives cannot end cooldown.
      if (!s || startedAt < s.until || startedAt <= s.lastFailureAt) continue;
      s.healthySince ||= now();
      s.successes++;
      if (s.successes >= 3 && now() - s.healthySince >= 60_000) states.delete(key);
    }
  }
  async function execute(url, opts, dispatch) {
    assertAvailable(url);
    const scope = httpScope(url);
    const probing = [states.get(scope.host), states.get(scope.key)].filter(Boolean);
    probing.forEach(s => { s.probing = true; });
    const startedAt = now();
    try {
      counters.requests++;
      const response = await dispatch();
      if ([403, 429].includes(response.status)) fail(url, response, await response.text());
      if (response.ok || response.status === 304) success(url, startedAt);
      else for (const s of probing) { s.healthySince = 0; s.successes = 0; }
      return response;
    } catch (error) {
      for (const s of probing) { s.healthySince = 0; s.successes = 0; }
      throw error;
    } finally { probing.forEach(s => { s.probing = false; }); }
  }
  async function request(url, opts = {}, schedule, dispatch, timeoutMs) {
    const method = (opts.method || 'GET').toUpperCase();
    // Share only identical, simultaneous, uncancelled GETs. No stale TTL cache.
    const key = method === 'GET' && !opts.signal && !opts.body
      ? JSON.stringify([url, [...new Headers(opts.headers)].sort(), opts.credentials, opts.redirect, timeoutMs]) : null;
    let flight = key && flights.get(key);
    if (flight) counters.reused++;
    else {
      assertAvailable(url);
      flight = schedule(() => execute(url, opts, dispatch));
      if (key) {
        flights.set(key, flight);
        void flight.finally(() => { if (flights.get(key) === flight) flights.delete(key); }).catch(() => {});
      }
    }
    return (await flight).clone();
  }
  return { request, blocked, assertAvailable, recordFailure: fail, snapshot: () => ({
    counters: { ...counters }, states: Object.fromEntries([...states].map(([k, s]) => [k, { ...s, probing: false }])),
  }) };
}
