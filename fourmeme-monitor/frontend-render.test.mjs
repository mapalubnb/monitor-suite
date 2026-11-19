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
  const r = raw({ url: stock, stockReady: true, buttons: ['鑄造', '贖回', '1 RYDE ≈ $1.1'], fields: ['input|text|'] });
  const a = normalizeRenderedDom(r, stock);
  const b = normalizeRenderedDom({ ...r, buttons: ['鑄造', '贖回', '兌換', '1 RYDE ≈ $2.1'] }, stock);
  assert.notEqual(a.hash, b.hash);
  assert.ok(b.signals.includes('按钮：兌換'));
  assert.throws(() => normalizeRenderedDom({ ...r, stockReady: false }, stock), /资产选择器尚未就绪/);
  assert.ok(!normalizeRenderedDom({ ...r, buttons: ['贖回'] }, stock).signals.includes('按钮：鑄造'));
});
test('静态业务阈值和费用说明中的数字不因行情降噪被过滤', () => {
  const a = normalizeRenderedDom(raw({ labels: ['市值超過 200 萬美元後，將自動作為基礎代幣上架。'] }), url);
  const b = normalizeRenderedDom(raw({ labels: ['市值超過 300 萬美元後，將自動作為基礎代幣上架。'] }), url);
  assert.notEqual(a.hash, b.hash);
  assert.ok(a.signals.some(s => s.includes('200 萬')));
});
test('壳、风控、跨域和重定向拒绝写入有效基线', () => {
  for (const patch of [{ fields: [] }, { mainText: 'verify you are human' }, { url: 'https://example.com/zh-TW/create-token' }, { url: 'https://four.meme/en' }]) assert.throws(() => normalizeRenderedDom(raw(patch), url));
});
test('排除基础设施伪路由，保留真实4Stock入口', () => {
  for (const route of ['/cdn-cgi/content', '/zh-TW/cdn-cgi/content', '/images/ui-redesign', '/en/images/ui-redesign']) assert.equal(isInfrastructureRoute(route), true);
  assert.equal(isInfrastructureRoute('/zh-TW/4stock'), false);
});
test('首页比较导航与稳定控件，动态市场卡片和价格不改变指纹', () => {
  const u = 'https://four.meme/zh-TW';
  const navigation = ['/', '/4stock', '/contract', '/advanced', '/agentic', '/campaign'].map(p => ({ text: p, href: '/zh-TW' + p }));
  const a = normalizeRenderedDom(raw({ url: u, mainText: 'Four.meme Fair Launch', navigation, fields: [], buttons: ['它如何運作?'] }), u);
  const b = normalizeRenderedDom(raw({ url: u, mainText: 'Four.meme Fair Launch TOKEN 999', navigation, headings: ['Dynamic Token'], fields: ['input|text|Search'], buttons: ['Token 99'] }), u);
  assert.equal(a.hash, b.hash);
  const controls = normalizeRenderedDom(raw({ url: u, navigation, buttons: ['Search', 'All Token'] }), u);
  assert.ok(controls.signals.includes('页面控件：Search'));
  assert.ok(controls.signals.includes('页面控件：All Token'));
});

function harness(target = url, data = raw()) {
  let time = 1000, results = [{ url: target, data }], failPersist = false;
  const store = createTransactionalOutbox({ initial: { keep: { history: [1, 2], dedupe: ['old'] } }, persist: () => { if (failPersist) throw Error('disk fail'); }, deliver: async () => 'id' });
  const client = { scan: async () => results, close() {} };
  const monitor = createFrontendRenderMonitor({ store, client, urls: [target], now: () => time });
  return { store, monitor, client, result: value => { results = value; }, time: value => { time = value; }, persistFailure: value => { failPersist = value; }, notices: () => store.state._notificationOutbox || [] };
}

test('Advanced 快速购买先加载时不接受采集，市场栏目就绪独立于栏目名字', () => {
  const u = 'https://four.meme/en/advanced';
  const nav = '<nav>' + ['advanced', 'contract', 'ranking', '4stock'].map(p => `<a href="/en/${p}">${p}</a>`).join('') + '</nav>';
  const toolbar = '<input type="text" placeholder="Quick Buy (BNB)"><button>Open Four</button>';
  const board = '<div class="no-scrollbar"><div class="flex-h"><section class="glass-panel"><header><h2>Verified Market</h2></header><div></div></section></div></div>';
  const capture = content => {
    const { document } = parseHTML(`<html><body>${nav}<main>${toolbar}${content}</main></body></html>`);
    return vm.runInNewContext(`(${collectRenderedDom.toString()})()`, { document, location: { href: u, pathname: '/en/advanced' } });
  };
  const partial = capture('');
  assert.equal(partial.fields.length, 1);
  assert.throws(() => normalizeRenderedDom(partial, u), /市场栏目/);
  assert.throws(() => normalizeRenderedDom(capture(board.replace('class="glass-panel"', 'class="glass-panel" hidden')), u), /市场栏目/);
  assert.ok(normalizeRenderedDom(capture(board), u).signals.includes('标题：Verified Market'));
  assert.equal(normalizeRenderedDom(capture(board.replace('<h2>Verified Market</h2>', '')), u).advancedBoardVerified, true);
});

test('中英文 Advanced 旧残缺基线静默补齐，真正新增和连续确认的移除仍及时通知', async () => {
  for (const [lang, headings, button] of [
    ['en', ['Newly Created', 'About to Launch', 'Trading Volume', 'Graduated', 'Hot'], ''],
    ['zh-TW', ['新發行', '即將發射', '交易量', '已發射', '熱度'], '篩選'],
  ]) {
    const u = `https://four.meme/${lang}/advanced`;
    const navigation = ['advanced', 'contract', 'ranking', '4stock'].map(p => ({ text: p, href: `/${lang}/${p}` }));
    const data = raw({ url: u, advancedBoardReady: true, mainText: 'Market Dashboard', headings, tabs: [], navigation,
      buttons: ['Open Four', ...(button ? [button] : [])], fields: ['input|text|Quick buy'] });
    const current = normalizeRenderedDom(data, u);
    const h = harness(u, data);
    const { advancedBoardVerified, ...legacy } = current;
    legacy.signals = current.signals.filter(signal => !signal.startsWith('标题：') && signal !== '按钮：篩選');
    legacy.hash = 'legacy-toolbar';
    h.store.state._frontendRendered = { pages: { [u]: legacy } };

    h.result([{ url: u, data: { ...data, advancedBoardReady: false, headings: [] } }]);
    await h.monitor.poll();
    assert.equal(h.store.state._frontendRendered.pages[u].hash, 'legacy-toolbar');
    h.result([{ url: u, data }]);
    await h.monitor.poll();
    await h.monitor.poll();
    assert.equal(h.notices().length, 0);
    assert.equal(h.store.state._frontendRendered.pages[u].hash, current.hash);
    assert.equal(h.store.state._frontendRendered.pages[u].advancedBoardVerified, true);
    assert.ok(h.store.state._frontendRendered.pages[u].signals.includes(`标题：${headings[0]}`));

    h.result([{ url: u, data: { ...data, headings: [...headings, 'New Feature'] } }]);
    await h.monitor.poll();
    assert.equal(h.notices().length, 1);
    assert.match(h.notices()[0].payload.content, /New Feature/);
    h.result([{ url: u, data: { ...data, headings: [...headings.slice(1), 'New Feature'] } }]);
    await h.monitor.poll();
    assert.equal(h.notices().length, 1);
    await h.monitor.poll();
    assert.equal(h.notices().length, 2);
    assert.ok(h.notices()[1].payload.content.includes(headings[0]));
  }
});
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
  assert.equal(h.notices()[1].payload.url, url);
  h.result([{ url, data: raw() }]); await h.monitor.poll(); assert.equal(h.notices().length, 2);
  await h.monitor.poll(); assert.equal(h.notices().length, 3);
  assert.match(h.notices()[2].payload.content, /新模式/);
});

test('升级只补齐已知结构维度，两个创建模式与同名字段各自保留', async () => {
  const base = raw();
  const h = harness(url, base);
  await h.monitor.poll();
  const classicFields = [
    { name: 'name', label: '', type: 'text' },
    { name: 'shortName', label: '', type: 'text' },
    { name: 'webUrl', label: '選填', type: 'text' },
    { name: 'twitterUrl', label: '選填', type: 'text' },
  ];
  const updated = raw({ captureVersion: 2, selectedTab: '經典模式', detailFields: classicFields,
    openMode: raw({ selectedTab: '開放模式', headings: ['選擇認證合約'], detailFields: classicFields }),
    headings: [...base.headings, '真实新增'] });
  h.result([{ url, data: updated }]);
  await h.monitor.poll();
  const stored = h.store.state._frontendRendered.pages[url];
  for (const mode of ['經典模式', '開放模式']) {
    assert.ok(stored.signals.includes(`表单字段：${mode} / 選填 [webUrl] text`));
    assert.ok(stored.signals.includes(`表单字段：${mode} / 選填 [twitterUrl] text`));
  }
  assert.match(h.notices()[1].payload.content, /真实新增/);
  assert.doesNotMatch(h.notices()[1].payload.content, /選擇認證合約|\[webUrl\]/);
});

test('同批双语栏目匹配为一个变更，两页入口都保留', async () => {
  const en = 'https://four.meme/en/advanced';
  const zh = 'https://four.meme/zh-TW/advanced';
  const page = (url, button, label, controls = []) => raw({ url, advancedBoardReady: true,
    headings: [label], buttons: [button], columns: [{ label, controls }],
    navigation: ['4stock', 'advanced', 'contract', 'agentic'].map(path => ({ text: path, href: new URL(path, url).pathname })) });
  const first = [page(en, 'Filters', 'Hot'), page(zh, '篩選', '熱度')];
  const h = harness();
  const monitor = createFrontendRenderMonitor({ store: h.store, client: h.client, urls: [en, zh] });
  h.result(first.map(data => ({ url: data.url, data })));
  await monitor.poll();
  assert.ok(h.store.state._frontendRendered.pages[en].signals.includes('按钮：Filters'));
  h.result(first.map((data, i) => ({ url: data.url, data: { ...data,
    columns: [{ ...data.columns[0], controls: [i ? '暫停更新' : 'Pause updates'] }] } })));
  await monitor.poll();
  const event = h.notices()[1].payload;
  assert.ok(event.content.includes(en) && event.content.includes(zh));
  assert.equal((event.content.match(/暂停\/继续更新/g) || []).length, 1);
});

test('筛选面板超时独立保留字段，栏目其他变化仍然入队', async () => {
  const u = 'https://four.meme/en/advanced';
  const columns = [{ label: 'Hot', controls: ['Filters'], filter: { labels: ['Market Cap(USD)'], controls: [], fields: [] } }];
  const data = raw({ url: u, captureVersion: 2, advancedBoardReady: true, headings: ['Hot'], columns,
    navigation: ['4stock', 'advanced', 'contract', 'agentic'].map(path => ({ text: path, href: `/en/${path}` })) });
  const h = harness(u, data);
  await h.monitor.poll();
  h.result([{ url: u, data: { ...data, headings: ['Hot', 'New layout'], filterUnverified: ['Hot'],
    columns: [{ label: 'Hot', controls: ['Filters'] }] } }]);
  await h.monitor.poll();
  await h.monitor.poll();
  assert.equal(h.notices().length, 2);
  assert.match(h.notices()[1].payload.content, /New layout/);
  assert.ok(h.store.state._frontendRendered.pages[u].signals.includes('筛选字段：Hot / Market Cap(USD)'));
  assert.deepEqual(h.monitor.summary().pages[u].filterUnverified, ['Hot']);
  h.result([{ url: u, data: { ...data, headings: ['Hot', 'New layout'],
    columns: [{ ...columns[0], filter: { ...columns[0].filter, labels: ['Liquidity'] } }] } }]);
  await h.monitor.poll();
  await h.monitor.poll();
  assert.equal(h.notices().length, 3);
  assert.match(h.notices()[2].payload.content, /Liquidity/);
});

test('活动基线静默建立，详情按实际语言路由跳转，公告保留列表地址', async () => {
  const target = 'https://four.meme/zh-TW/campaign';
  const detail = 'https://four.meme/zh-TW/presale/102364633';
  const page = ids => raw({ url: target, links: ids.map(id => ({ href: `/presale/${id}`, text: `已結束 Main Event ${id}` })) });
  const h = harness(target, page([1]));
  const monitor = createFrontendRenderMonitor({ store: h.store, client: h.client, urls: [], optionalUrls: [target] });
  await monitor.poll([target]);
  assert.equal(h.notices().length, 0);
  h.result([{ url: target, data: page([1, 102364633]) }]);
  await monitor.poll([target]);
  assert.equal(h.notices()[0].payload.url, detail);
  assert.match(h.notices()[0].payload.content, /\/zh-TW\/presale\/102364633/);
  const announcement = 'https://four.meme/en/announcement';
  assert.deepEqual(normalizeRenderedDom(raw({ url: announcement, articles: ['Four.meme Change 2026.11.19'] }), announcement).signalUrls, {});
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
test('附属聊天开关显示波动不改变功能指纹，核心功能仍保留', () => {
  const a = normalizeRenderedDom(raw(), url);
  const b = normalizeRenderedDom(raw({ buttons: [...raw().buttons, '打開聊天', 'Open chat'] }), url);
  assert.equal(a.hash, b.hash);
  assert.notEqual(a.hash, normalizeRenderedDom(raw({ buttons: [...raw().buttons, '新增功能'] }), url).hash);
});
test('旧聊天控件基线成功核验后静默迁移，不发移除卡且失败时保留原值', async () => {
  const h = harness(); await h.monitor.poll();
  const old = h.store.state._frontendRendered.pages[url]; old.signals.push('按钮：打開聊天'); old.hash = 'legacy-chat';
  h.result([{ url, error: 'offline' }]); await h.monitor.poll();
  assert.equal(h.store.state._frontendRendered.pages[url].hash, 'legacy-chat');
  h.result([{ url, data: raw() }]); await h.monitor.poll();
  assert.equal(h.store.state._frontendRendered.pages[url].hash, normalizeRenderedDom(raw(), url).hash);
  assert.equal(h.notices().length, 1);
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
