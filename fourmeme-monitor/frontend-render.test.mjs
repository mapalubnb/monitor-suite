import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { parseHTML } from 'linkedom';
import vm from 'node:vm';
import { collectRenderedDom, normalizeRenderedDom, pageContentQuality, isInfrastructureRoute, createRenderClient, createFrontendRenderMonitor } from './frontend-render.mjs';
import { createTransactionalOutbox } from '../shared/transactional-outbox.mjs';

const url = 'https://four.meme/zh-TW/create-token';
const stock = 'https://four.meme/zh-TW/4stock';
const raw = (patch = {}) => ({ url, mainText: '發行你的代幣 代幣名稱 反狙擊 啟用稅收 CRYPTO MEME RWA PREIPO',
  headings: ['發行你的代幣', '代幣身分'], tabs: ['經典模式', '開放模式'], labels: ['代幣名稱', '描述'],
  buttons: ['創建代幣', 'BNB BNB 17.1', 'USDT 10,000'], fields: ['input|text|', 'input|text|', 'textarea||'], switches: 2,
  navigation: [{ text: '首頁', href: '/zh-TW' }, { text: '4Stock', href: '/zh-TW/4stock' }], ...patch });

test('新版创建页SSR壳不冒充内容完整，完整表单可识别', () => {
  assert.equal(pageContentQuality(url, '創建代幣 載入中 免責聲明'), 'shell');
  assert.equal(pageContentQuality(url, raw().mainText), 'complete');
});
test('提取可见表单与导航，不读取输入值和账户区', () => {
  const { document } = parseHTML('<html><body><header>Wallet 9999</header><nav><a href="/zh-TW/4stock">4Stock</a></nav><main><h1>發行你的代幣</h1><p>代幣名稱</p><input value="secret"><button hidden>hidden</button><button>創建代幣</button></main></body></html>');
  const data = vm.runInNewContext(`(${collectRenderedDom.toString()})()`, { document, location: { href: url } });
  assert.deepEqual([...data.buttons], ['創建代幣']);
  assert.ok(data.labels.includes('代幣名稱'));
  assert.ok(!JSON.stringify(data).includes('9999'));
  assert.ok(!JSON.stringify(data).includes('secret'));
});
test('稳定DOM指纹排除价格余额和动态代币列表', () => {
  const a = normalizeRenderedDom(raw(), url);
  const b = normalizeRenderedDom(raw({ buttons: ['創建代幣', 'NEW NEW 33', 'Wallet 900', 'Active Orders 3'], mainText: raw().mainText + ' price $5 Wallet 99' }), url);
  assert.equal(a.hash, b.hash);
  assert.ok(a.signals.includes('导航：4Stock → /zh-TW/4stock'));
  assert.ok(a.signals.includes('选项卡：開放模式'));
});
test('4Stock兑换按钮变化被保留，价格不参与比较', () => {
  const r = raw({ url: stock, buttons: ['鑄造', '贖回', '1 RYDE ≈ $1.1'], fields: ['input|text|'] });
  const a = normalizeRenderedDom(r, stock);
  const b = normalizeRenderedDom({ ...r, buttons: ['鑄造', '贖回', '兌換', '1 RYDE ≈ $2.1'] }, stock);
  assert.notEqual(a.hash, b.hash);
  assert.ok(b.signals.includes('按钮：兌換'));
});
test('壳、风控、跨域和重定向拒绝写入有效基线', () => {
  for (const patch of [{ fields: [] }, { mainText: 'verify you are human' }, { url: 'https://example.com/zh-TW/create-token' }, { url: 'https://four.meme/en' }]) assert.throws(() => normalizeRenderedDom(raw(patch), url));
});
test('排除基础设施伪路由，保留真实4Stock入口', () => {
  for (const route of ['/cdn-cgi/content', '/zh-TW/cdn-cgi/content', '/images/ui-redesign', '/en/images/ui-redesign']) assert.equal(isInfrastructureRoute(route), true);
  assert.equal(isInfrastructureRoute('/zh-TW/4stock'), false);
});

function harness() {
  let time = 1000, results = [{ url, data: raw() }], failPersist = false;
  const store = createTransactionalOutbox({ initial: { keep: { history: [1, 2], dedupe: ['old'] } }, persist: () => { if (failPersist) throw Error('disk fail'); }, deliver: async () => 'id' });
  const client = { scan: async () => results, close() {} };
  const monitor = createFrontendRenderMonitor({ store, client, urls: [url], now: () => time });
  return { store, monitor, client, result: value => { results = value; }, time: value => { time = value; }, persistFailure: value => { failPersist = value; }, notices: () => store.state._notificationOutbox || [] };
}
test('首次基线一次说明，重启不重复，其他状态保留', async () => {
  const h = harness(); await h.monitor.poll(); await h.monitor.poll();
  assert.equal(h.notices().length, 1);
  const again = createFrontendRenderMonitor({ store: h.store, client: h.client, urls: [url] }); await again.poll();
  assert.equal(h.notices().length, 1);
  assert.deepEqual(h.store.state.keep, { history: [1, 2], dedupe: ['old'] });
  assert.equal(h.notices()[0].payload.skipAi, true);
});
test('真实功能新增立即入队，删除需两次连续成功确认', async () => {
  const h = harness(); await h.monitor.poll();
  h.result([{ url, data: raw({ tabs: ['經典模式', '開放模式', '新模式'] }) }]); await h.monitor.poll();
  assert.equal(h.notices().length, 2);
  h.result([{ url, data: raw() }]); await h.monitor.poll(); assert.equal(h.notices().length, 2);
  await h.monitor.poll(); assert.equal(h.notices().length, 3);
  assert.match(h.notices()[2].payload.content, /新模式/);
});
test('渲染失败保留有效基线并打断删除确认，不污染静态快照', async () => {
  const h = harness(); await h.monitor.poll(); const original = h.store.state._frontendRendered.pages[url].hash;
  h.result([{ url, data: raw({ tabs: ['經典模式'] }) }]); await h.monitor.poll();
  h.result([{ url, error: 'timeout' }]); await h.monitor.poll();
  assert.equal(h.store.state._frontendRendered.pages[url].hash, original);
  h.result([{ url, data: raw({ tabs: ['經典模式'] }) }]); await h.monitor.poll();
  assert.equal(h.notices().length, 1); await h.monitor.poll(); assert.equal(h.notices().length, 2);
});
test('持续失败只告警一次，稳定30秒恢复一次', async () => {
  const h = harness(); await h.monitor.poll(); h.result([{ url, error: '503' }]); await h.monitor.poll();
  h.time(61001); await h.monitor.poll(); await h.monitor.poll(); assert.equal(h.notices().length, 2);
  h.result([{ url, data: raw() }]); h.time(62000); await h.monitor.poll(); assert.equal(h.notices().length, 2);
  h.time(92001); await h.monitor.poll(); await h.monitor.poll(); assert.equal(h.notices().length, 3);
});
test('落盘失败不确认基线和通知，下轮可恢复', async () => {
  const h = harness(); h.persistFailure(true); await assert.rejects(h.monitor.poll(), /disk fail/);
  assert.equal(h.store.state._frontendRendered, undefined); assert.equal(h.notices().length, 0);
  h.persistFailure(false); await h.monitor.poll(); assert.equal(h.notices().length, 1);
});
test('停机后的迟到结果不写状态、不入队', async () => {
  const h = harness(); let complete; h.client.scan = () => new Promise(resolve => { complete = resolve; });
  const work = h.monitor.poll(); h.monitor.close(); complete([{ url, data: raw() }]); await work;
  assert.equal(h.store.state._frontendRendered, undefined);
});
test('客户端整轮硬超时杀旧工作器，下一轮重建并隔离迟到IPC', async () => {
  const children = [];
  const client = createRenderClient({ timeoutMs: 15, forkFn: () => {
    const child = new EventEmitter(); child.send = msg => { child.message = msg; }; child.kill = () => { child.killed = true; };
    children.push(child); return child;
  } });
  await assert.rejects(client.scan([url]), /超过/); assert.equal(children[0].killed, true);
  const work = client.scan([url]);
  children[0].emit('message', { id: 1, results: ['bad'] });
  children[1].emit('message', { id: 2, results: [{ url, data: raw() }] });
  assert.equal((await work)[0].url, url); client.close();
});
test('整轮超时保留已收到页面，未完成目标显示失败', async () => {
  const h = harness(); h.client.scan = async () => { const e = Error('deadline'); e.results = [{ url, data: raw() }]; throw e; };
  await h.monitor.poll(); assert.equal(h.store.state._frontendRendered.health.completePages, 1);
});
