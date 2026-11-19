import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderScheduler, renderSourceFingerprint, probeRenderSource } from './frontend-render-scheduler.mjs';
import { createTransactionalOutbox } from '../shared/transactional-outbox.mjs';
import { createFrontendRenderMonitor } from './frontend-render.mjs';

const urls = ['https://four.meme/en/create-token', 'https://four.meme/en/4stock'];
const html = '<script src="/_next/static/a.js"></script><link rel="stylesheet" href="/b.css">';
test('轻量指纹忽略行情、nonce和资源顺序，但捕获部署资源变化', () => {
  const a = renderSourceFingerprint(html + '<p>price 1</p>', urls[0]);
  assert.equal(a, renderSourceFingerprint('<p nonce="123">price 999</p>' + html, urls[0]));
  assert.equal(a, renderSourceFingerprint(html + '<script>const translations={BasicAccessControlDenied:"Access denied"}</script>', urls[0]));
  assert.throws(() => renderSourceFingerprint('<title>Access denied</title>' + html, urls[0]));
  assert.notEqual(a, renderSourceFingerprint(html.replace('a.js', 'c.js'), urls[0]));
  assert.throws(() => renderSourceFingerprint('Access denied', urls[0]));
  assert.throws(() => renderSourceFingerprint('<html>Loading</html>', urls[0]));
});
test('轻量请求支持条件304，HTTP错误和超大响应不能确认新基线', async () => {
  const old = { fingerprint: 'old', etag: 'tag' };
  const result = await probeRenderSource(urls[0], old, { fetchFn: async (_, o) => {
    assert.equal(o.headers['If-None-Match'], 'tag'); return new Response(null, { status: 304 });
  } });
  assert.equal(result.fingerprint, 'old');
  await assert.rejects(probeRenderSource(urls[0], old, { fetchFn: async () => new Response('bad', { status: 503 }) }), /503/);
  await assert.rejects(probeRenderSource(urls[0], old, { fetchFn: async () => new Response('x'.repeat(2097153)) }), /2MiB/);
  const good = await probeRenderSource(urls[0], {}, { fetchFn: async () => new Response(html, { headers: { etag: 'new' } }) });
  assert.equal(good.etag, 'new'); assert.ok(good.fingerprint);
});
function harness() {
  let time = 1000, failure = '', hash = 'a', staticHash = 's', diskFail = false;
  const pages = Object.fromEntries(urls.map(url => [url, { hash: 'dom', lastSuccessAt: time }]));
  const store = createTransactionalOutbox({ initial: { _frontendRendered: { pages }, history: { gaps: [1], dedupe: ['old'] } }, persist() { if (diskFail) throw Error('disk'); }, deliver: async () => 'message' });
  const calls = [];
  const renderer = { async poll(targets) { calls.push(targets); await store.transaction(() => { for (const url of targets) store.state._frontendRendered.pages[url] = { hash: 'dom', lastSuccessAt: time, lastError: failure }; }); }, close() {}, summary() { return { pages: store.state._frontendRendered.pages }; } };
  const options = { store, renderer, urls, now: () => time, autoRun: false, minGapMs: 0, staticFingerprint: () => staticHash, probe: async () => ({ fingerprint: hash }) };
  const scheduler = createRenderScheduler(options);
  return { store, renderer, scheduler, options, calls, time: t => time = t, hash: h => hash = h, static: h => staticHash = h, failure: s => failure = s, disk: b => diskFail = b };
}
test('响应体不响应取消时释放探测，保留旧指纹并在下轮继续', { timeout: 1500 }, async () => {
  const h = harness();
  let stall = false, cancelled = false;
  const s = createRenderScheduler({ ...h.options, urls: [urls[0]], probe: (url, old) =>
    probeRenderSource(url, old, { timeoutMs: 30, fetchFn: async () => stall
      ? new Response(new ReadableStream({ cancel() { cancelled = true; return new Promise(() => {}); } }))
      : new Response(html) }) });
  await s.poll();
  const before = h.store.state._frontendRenderSchedule.pages[urls[0]].fingerprint;
  stall = true;
  await s.poll();
  assert.equal(s.summary().checking, false);
  assert.equal(cancelled, true);
  assert.match(s.summary().probeError, /轻量探测超时/);
  assert.equal(h.store.state._frontendRenderSchedule.pages[urls[0]].fingerprint, before);

  stall = false;
  await s.poll();
  assert.equal(s.summary().checkCount, 3);
  assert.equal(s.summary().probeError, '');
  assert.equal(h.store.state._frontendRenderSchedule.pages[urls[0]].fingerprint, before);
});
test('5秒未变化探测不重复渲染，60秒兜底按页面错开', async () => {
  const h = harness(); await h.scheduler.poll(); await h.scheduler.runNext();
  assert.deepEqual(h.calls, [[urls[0]]]);
  for (const t of [6000, 11000, 16000, 21000, 26000]) { h.time(t); await h.scheduler.poll(); await h.scheduler.runNext(); }
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.scheduler.summary().recentChecks.map(p => p.startedAt), [1000, 6000, 11000, 16000, 21000, 26000]);
  h.time(31000); await h.scheduler.poll(); await h.scheduler.runNext(); assert.deepEqual(h.calls[1], [urls[1]]);
  h.time(61000); await h.scheduler.poll(); await h.scheduler.runNext(); assert.deepEqual(h.calls[2], [urls[0]]);
  assert.deepEqual(h.store.state.history, { gaps: [1], dedupe: ['old'] });
});
test('静态资源内容变化触发优先核验，多次相同探测合并为一个任务', async () => {
  const h = harness(); await h.scheduler.poll(); await h.scheduler.runNext(); h.static('new');
  await h.scheduler.poll(); await h.scheduler.poll(); await h.scheduler.poll();
  assert.equal(h.scheduler.summary().pendingPages, 2);
  await h.scheduler.runNext(); await h.scheduler.runNext(); assert.equal(h.scheduler.summary().pendingPages, 0);
  assert.equal(h.calls.length, 3);
});
test('单页资源变化只调度受影响页面', async () => {
  const h = harness(); let version = 'a';
  const s = createRenderScheduler({ ...h.options, probe: async url => ({ fingerprint: url === urls[0] ? version : 'a' }) });
  await s.poll(); await s.runNext(); version = 'b'; await s.poll(); await s.runNext();
  assert.deepEqual(h.calls, [[urls[0]], [urls[0]]]);
});

test('补充公开页面复用静态指纹，核心页面优先，活动到期复核', async () => {
  const h = harness();
  const campaign = 'https://four.meme/en/campaign', bridge = 'https://four.meme/en/bridge';
  const core = urls[0];
  const probes = [];
  let version = 'first';
  const s = createRenderScheduler({ ...h.options, urls: [core], optionalUrls: [campaign, bridge], optionalFallbackUrls: [campaign],
    probe: async url => { probes.push(url); return { fingerprint: 'core' }; },
    staticFingerprint: url => url === bridge ? version : 'first' });
  await s.poll();
  await s.runNext();
  await s.runNext();
  await s.runNext();
  assert.deepEqual(h.calls, [[core], [campaign], [bridge]]);
  h.time(61000); await s.poll(); await s.runNext(); await s.runNext();
  assert.deepEqual(h.calls.slice(3), [[core], [campaign]]);
  assert.deepEqual(probes, [core, core]);
  version = 'second'; await s.poll(); await s.runNext();
  assert.deepEqual(h.calls.at(-1), [bridge]);
  assert.equal(s.summary().optionalPendingPages, 0);
});

test('已经同时排队的双语资源变更同批验证，一页失败只保留该页任务', async () => {
  const h = harness();
  const zh = 'https://four.meme/zh-TW/create-token', en = urls[0];
  h.store.state._frontendRendered.pages[zh] = { hash: 'dom', lastSuccessAt: 1000 };
  const s = createRenderScheduler({ ...h.options, urls: [en, zh] });
  const poll = h.renderer.poll;
  h.renderer.poll = async targets => {
    await poll(targets);
    if (targets.length === 2) h.store.state._frontendRendered.pages[zh].lastError = 'offline';
  };
  await s.poll(); await s.runNext();
  h.hash('new');
  await s.poll(); await s.runNext();
  assert.deepEqual(h.calls.at(-1), [en, zh]);
  assert.equal(s.summary().pages[en].pending, false);
  assert.equal(s.summary().pages[zh].pending, true);
});
test('渲染中继续轻量探测，新版本不能被旧任务完成确认', async () => {
  const h = harness(); let release;
  const original = h.renderer.poll;
  h.renderer.poll = async targets => { await new Promise(r => release = r); return original(targets); };
  await h.scheduler.poll(); const active = h.scheduler.runNext();
  h.hash('b'); h.time(6000); await h.scheduler.poll();
  assert.equal(await h.scheduler.runNext(), false);
  release(); await active;
  assert.equal(h.store.state._frontendRenderSchedule.pages[urls[0]].pending, true);
  h.renderer.poll = original; await h.scheduler.runNext();
  assert.equal(h.store.state._frontendRenderSchedule.pages[urls[0]].pending, false);
});
test('失败任务持久保留，重启重试不清历史，落盘失败不确认任务', async () => {
  const h = harness(); h.failure('timeout'); await h.scheduler.poll(); await h.scheduler.runNext();
  assert.equal(h.store.state._frontendRenderSchedule.pages[urls[0]].pending, true);
  const s = createRenderScheduler(h.options); assert.equal(await s.runNext(), false);
  h.time(12000); h.failure(''); await s.runNext(); assert.equal(s.summary().pendingPages, 0);
  h.disk(true); h.hash('new'); await assert.rejects(s.poll(), /disk/);
  assert.equal(h.store.state._frontendRenderSchedule.pages[urls[0]].fingerprint, 'a');
});
test('资源预算不允许并发，完成后必须留出最小空闲窗口', async () => {
  const h = harness(); const s = createRenderScheduler({ ...h.options, minGapMs: 1500 });
  await s.poll(); await s.runNext(); h.hash('b'); await s.poll();
  assert.equal(await s.runNext(), false); h.time(2500); assert.equal(await s.runNext(), true);
});
test('单页核验不错误恢复其他失败页面', async () => {
  const h = harness(); h.store.state._frontendRendered.pages[urls[1]].lastError = 'offline';
  const raw = { url: urls[0], mainText: 'Token Name Enable Tax', headings: ['Create'], tabs: ['Classic'], labels: ['Name'], buttons: ['Create'], fields: ['a', 'b', 'c'], switches: 1, navigation: [] };
  h.store.state._frontendRendered.pages[urls[0]].signals = [];
  const m = createFrontendRenderMonitor({ store: h.store, urls, client: { scan: async () => [{ url: urls[0], data: raw }], close() {} } });
  await m.poll([urls[0]]); assert.equal(m.summary().failedPages, 1); assert.match(m.summary().lastError, /offline/);
});
test('停机后迟到探测不得创建队列', async () => {
  const h = harness(); let release;
  const s = createRenderScheduler({ ...h.options, urls: [urls[0]], probe: () => new Promise(r => release = r) });
  const p = s.poll(); s.close(); release({ fingerprint: 'late' }); await p;
  assert.equal(h.store.state._frontendRenderSchedule, undefined);
});
test('轻量异常持续60秒只告警一次，重启保留事件且稳定恢复后通知', async () => {
  const h = harness(); let broken = true;
  const options = { ...h.options, probe: async () => { if (broken) throw Error('503'); return { fingerprint: 'a' }; } };
  const s = createRenderScheduler(options); await s.poll(); h.time(61001); await s.poll(); await s.poll();
  assert.equal(h.store.state._notificationOutbox.length, 1);
  const restarted = createRenderScheduler(options); await restarted.poll();
  assert.equal(h.store.state._notificationOutbox.length, 1);
  broken = false; h.time(62000); await restarted.poll(); h.time(92001); await restarted.poll();
  assert.equal(h.store.state._notificationOutbox.length, 2);
  assert.equal(h.store.state._notificationOutbox[1].payload.skipAi, true);
});
