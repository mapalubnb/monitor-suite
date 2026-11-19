import { createHash } from 'node:crypto';
import { RENDER_URLS } from './frontend-render.mjs';

// Resource URLs identify a deployed frontend build without hashing volatile
// market data, CSP nonces or hydration payloads. Same-URL content changes are
// also covered by the existing static channel and the periodic DOM audit.
export function renderSourceFingerprint(html, url) {
  if (/verify you are human|access denied|<title[^>]*>[^<]*captcha/i.test(html)) throw Error('轻量探测被源站拦截');
  const resources = [];
  for (const match of html.matchAll(/<(?:script|link)\b[^>]*>/gi)) {
    const tag = match[0];
    if (/^<link/i.test(tag) && !/\brel\s*=\s*["'](?:stylesheet|modulepreload|preload)["']/i.test(tag)) continue;
    const value = tag.match(/\b(?:src|href)\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!value) continue;
    const target = new URL(value.replaceAll('&amp;', '&'), url);
    if (target.origin === 'https://four.meme' && /\.(?:js|css)(?:$|\?)/i.test(target.pathname + target.search) && !target.pathname.startsWith('/cdn-cgi/')) resources.push(target.href);
  }
  if (!resources.some(v => /\.js(?:$|\?)/.test(v))) throw Error('轻量探测缺少前端脚本，保留旧指纹');
  return createHash('sha256').update([...new Set(resources)].sort().join('\n')).digest('hex');
}

export async function probeRenderSource(url, previous = {}, { fetchFn = fetch, timeoutMs = 3500 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(Error('前端轻量探测超时')), timeoutMs);
  try {
    const headers = { 'User-Agent': 'FourMeme-Monitor/1.0', Accept: 'text/html' };
    if (previous.etag) headers['If-None-Match'] = previous.etag;
    if (previous.modified) headers['If-Modified-Since'] = previous.modified;
    const response = await fetchFn(url, { headers, signal: controller.signal, redirect: 'error' });
    if (response.status === 304 && previous.fingerprint) { await response.body?.cancel(); return { fingerprint: previous.fingerprint, etag: previous.etag, modified: previous.modified }; }
    if (!response.ok) { await response.body?.cancel(); throw Error(`前端轻量HTTP ${response.status}`); }
    let bytes = 0; const chunks = [];
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) { controller.abort(); throw Error('前端轻量HTML超过2MiB'); }
      chunks.push(chunk);
    }
    return { fingerprint: renderSourceFingerprint(Buffer.concat(chunks).toString('utf8'), url), etag: response.headers.get('etag') || '', modified: response.headers.get('last-modified') || '' };
  } finally { clearTimeout(timer); }
}

// Owns only _frontendRenderSchedule; the renderer owns _frontendRendered.
// All queue mutations are short serialized transactions, never spanning I/O.
export function createRenderScheduler({ store, renderer, urls = RENDER_URLS, probe = probeRenderSource,
  now = Date.now, fallbackMs = 60000, minGapMs = 1500, stopped = () => false, log = () => {}, wake = () => {},
  staticFingerprint = () => '', autoRun = true }) {
  let checking = false, running = false, closed = false, timer, writes = Promise.resolve();
  let lastCheckAt = 0, lastCheckDurationMs = 0, checkCount = 0, lastError = '', nextStartAt = 0;
  const read = () => store.state._frontendRenderSchedule || { pages: {} };
  const mutate = fn => {
    const work = writes.then(() => store.transaction(async () => {
      if (closed || stopped()) return;
      const state = structuredClone(read()); state.pages ||= {}; await fn(state);
      store.state._frontendRenderSchedule = state;
    }));
    writes = work.catch(() => {}); return work;
  };
  const arm = () => {
    if (!autoRun || closed || stopped() || timer || running) return;
    timer = setTimeout(() => { timer = null; void runNext().catch(e => { lastError = e.message; log(`[前端渲染队列] ${e.message}`); }); }, Math.max(0, nextStartAt - now()));
    timer.unref?.();
  };
  async function poll() {
    if (checking || closed || stopped()) return false;
    checking = true; const start = now();
    try {
      const results = await Promise.all(urls.map(async url => {
        try { return { url, result: await probe(url, read().pages[url] || {}), staticHash: staticFingerprint(url) }; }
        catch (e) { return { url, error: e.message }; }
      }));
      if (closed || stopped()) return false;
      await mutate(async state => {
        for (const { url, result, error, staticHash } of results) {
          const old = state.pages[url] || {};
          const dom = store.state._frontendRendered?.pages[url];
          const sourceChanged = result && old.fingerprint && (old.fingerprint !== result.fingerprint || (old.staticHash && staticHash && old.staticHash !== staticHash));
          // Startup audit is staggered; retained DOM baselines are never reset.
          const nextAuditAt = old.nextAuditAt ?? (dom?.hash ? start + urls.indexOf(url) * fallbackMs / urls.length : start);
          const due = !dom?.hash || dom.candidateHash || dom.lastError || start >= nextAuditAt;
          const item = { ...old, ...(result || {}), staticHash: staticHash || old.staticHash || '', nextAuditAt, probeError: error || '', probeFailureAt: error ? old.probeFailureAt || start : 0 };
          if (sourceChanged || (due && !old.pending)) {
            item.revision = (old.revision || 0) + 1;
            item.pending = true; item.reason = sourceChanged ? 'source-change' : dom?.candidateHash ? 'confirm-removal' : dom?.lastError ? 'retry' : 'audit';
            item.queuedAt = old.pending ? old.queuedAt : start;
            item.detectedAt = sourceChanged ? start : old.detectedAt || 0;
            if (sourceChanged) item.retryAt = 0;
          }
          state.pages[url] = item;
        }
        const errors = Object.entries(state.pages).filter(([, p]) => p.probeError);
        state.health ||= {};
        const health = state.health;
        let title = '';
        if (errors.length) {
          health.healthySince = 0;
          if (!health.alerted && errors.some(([, p]) => now() - p.probeFailureAt >= 60000)) {
            health.alerted = true; title = 'Four.meme 前端轻量检测异常';
          }
        } else if (health.alerted) {
          health.healthySince ||= now();
          if (now() - health.healthySince >= 30000) { health.alerted = false; title = 'Four.meme 前端轻量检测恢复'; }
        }
        if (title) await store.enqueue({ title, content: errors.length ? errors.map(([url, p]) => `${new URL(url).pathname}：${p.probeError}`).join('\n') + '\n旧基线、待核验任务保留，独立渲染兜底继续。' : '轻量检测已连续正常30秒，按需核验继续。', template: errors.length ? 'yellow' : 'green', skipAi: true, moduleContext: 'Four.meme 前端轻量检测' });
      });
      lastCheckAt = now(); lastCheckDurationMs = now() - start; checkCount++;
      lastError = results.filter(x => x.error).map(x => `${new URL(x.url).pathname}: ${x.error}`).join('；');
      wake(); arm(); return true;
    } finally { checking = false; }
  }
  async function runNext() {
    if (running || closed || stopped() || now() < nextStartAt) return false;
    const priority = p => p.reason === 'source-change' ? 0 : p.reason === 'confirm-removal' ? 1 : 2;
    const job = Object.entries(read().pages).filter(([url, p]) => urls.includes(url) && p.pending && !(p.retryAt > now()))
      .sort((a, b) => priority(a[1]) - priority(b[1]) || a[1].queuedAt - b[1].queuedAt)[0];
    if (!job) return false;
    running = true; const [url, request] = job; const startedAt = now();
    try {
      await renderer.poll([url]);
      if (closed || stopped()) return false;
      const dom = store.state._frontendRendered?.pages[url];
      if (!dom?.hash || dom.lastError) throw Error(dom?.lastError || '渲染未产生有效结果');
      await mutate(state => {
        const item = state.pages[url];
        item.lastRenderAt = now(); item.lastQueueDelayMs = startedAt - request.queuedAt;
        item.lastRenderDurationMs = now() - startedAt; item.lastError = '';
        item.nextAuditAt = now() + fallbackMs;
        // An observation made during this render must survive its completion.
        if (item.revision === request.revision) {
          item.pending = !!dom.candidateHash; item.retryAt = 0;
          if (item.pending) { item.reason = 'confirm-removal'; item.queuedAt = now(); }
        }
      });
      return true;
    } catch (error) {
      await mutate(state => { const item = state.pages[url]; item.lastError = error.message; item.retryAt = now() + 10000; });
      log(`[前端渲染队列] ${new URL(url).pathname}：${error.message}`);
      return false;
    } finally {
      running = false; nextStartAt = now() + minGapMs;
      if (Object.values(read().pages).some(p => p.pending && !(p.retryAt > now()))) arm();
    }
  }
  return { poll, runNext, close() { closed = true; clearTimeout(timer); renderer.close(); },
    summary() {
      const pages = Object.values(read().pages);
      const rendered = renderer.summary();
      return { ...rendered, running, checking, mode: 'on-demand', fallbackMs, minGapMs, lastCheckAt, lastCheckDurationMs, checkCount,
        probeError: lastError, pendingPages: pages.filter(p => p.pending).length,
        oldestQueuedAt: pages.some(p => p.pending) ? Math.min(...pages.filter(p => p.pending).map(p => p.queuedAt)) : 0,
        maxQueueDelayMs: Math.max(0, ...pages.map(p => p.lastQueueDelayMs || 0)),
        pages: Object.fromEntries(urls.map(url => [url, { ...rendered.pages[url], ...read().pages[url] }])) };
    } };
}
