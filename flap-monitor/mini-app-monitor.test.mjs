import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseAppList, parseRegistration, parseTemplateDetail, readAppArtifact, scanAgentMarkets, decodeMarketCards, createMiniAppMonitor } from './mini-app-monitor.mjs';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/mini-app-20261023.json', import.meta.url)));
const flight = object => `<script>self.__next_f.push(${JSON.stringify([1, '7:' + JSON.stringify(['$', '$L1', null, object]) + '\n'])})</script>`;
const word = v => BigInt(v).toString(16).padStart(64, '0');
const addr = n => '0x' + n.toString(16).padStart(40, '0');
const block = { number: '0x100', hash: '0x' + 'a'.repeat(64) };
const reader = fixture.manifest.walletContracts.find(v => v.id === 'reader').address;
const factory = fixture.manifest.walletContracts.find(v => v.id === 'factory').address;
function cards(rows) {
  const tuples = rows.map(row => {
    const strings = [row.name || 'Market', 'MKT', 'ipfs://metadata'].map(s => word(Buffer.byteLength(s)) + Buffer.from(s).toString('hex').padEnd(Math.ceil(Buffer.byteLength(s) / 32) * 64, '0'));
    const offsets = [512, 512 + strings[0].length / 2, 512 + (strings[0].length + strings[1].length) / 2];
    return [row.market, addr(20), ...offsets, addr(30), addr(30), addr(40), row.phase, row.pool || 0, 100, 0, 0, 0, 1, 1].map(word).join('') + strings.join('');
  });
  let offset = rows.length * 32;
  const offsets = tuples.map(t => { const o = word(offset); offset += t.length / 2; return o; });
  return '0x' + word(32) + word(rows.length) + offsets.join('') + tuples.join('');
}
function rpcFor(rows, { fail = false, reorg = false } = {}) {
  return async (method, params) => {
    if (method === 'eth_getBlockByNumber') return { ...block, hash: reorg && params[0] !== 'latest' ? '0x' + 'b'.repeat(64) : block.hash };
    assert.equal(params[1], block.number);
    const { to, data } = params[0];
    if (data === '0xc45a0155') { assert.equal(to, reader); return '0x' + word(factory); }
    if (data === '0xec979082') return '0x' + word(rows.length);
    if (data.startsWith('0x8f82e165')) {
      if (fail) throw Error('timeout');
      const cursor = Number(BigInt('0x' + data.slice(10, 74))), part = rows.slice(cursor, cursor + 16);
      return '0x' + [96, cursor + part.length, rows.length, part.length, ...part.map(r => r.market)].map(word).join('');
    }
    if (data.startsWith('0x304a170b')) {
      const addresses = data.slice(138).match(/.{64}/g).map(w => '0x' + w.slice(24));
      return cards(addresses.map(a => rows.find(r => r.market === a)));
    }
    throw Error('unexpected RPC');
  };
}

test('真实官网 Flight 注册、manifest 和链上第一页回放：不发送历史市场', async () => {
  assert.equal(parseAppList(flight({ apps: fixture.catalog })).length, 1);
  assert.equal(parseRegistration(flight({ registration: fixture.registration }), fixture.catalog[0]).slug, 'agent-bonding-curve');
  const result = await scanAgentMarkets(undefined, fixture.manifest, async (method, params) => {
    const item = fixture.calls.find(c => c.method === method && JSON.stringify(c.params) === JSON.stringify(params));
    assert(item, method); return item.result;
  });
  assert.equal(result.state.discovered, 16); assert.equal(result.state.baselineCount, 49);
  assert.equal(result.events.length, 0); assert.equal(Object.keys(result.state.markets).length, 16);
});

test('市场新增、毕业和重启去重；价格和进度不产生通知', async () => {
  const rows = [{ market: addr(1), phase: 1 }];
  let result = await scanAgentMarkets(undefined, fixture.manifest, rpcFor(rows));
  rows[0].pool = 50;
  result = await scanAgentMarkets(result.state, fixture.manifest, rpcFor(rows));
  assert.equal(result.events.length, 0);
  rows.push({ market: addr(2), phase: 1 });
  result = await scanAgentMarkets(result.state, fixture.manifest, rpcFor(rows));
  assert.deepEqual(result.events.map(e => e.type), ['新增市场']);
  rows[0].phase = 3;
  result = await scanAgentMarkets(JSON.parse(JSON.stringify(result.state)), fixture.manifest, rpcFor(rows));
  assert.deepEqual(result.events.map(e => e.type), ['市场毕业']);
  result = await scanAgentMarkets(result.state, fixture.manifest, rpcFor(rows));
  assert.equal(result.events.length, 0);
});

test('首次超过一页分批基线不补发历史，失败和重组不推进状态', async () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ market: addr(i + 1), phase: 3 }));
  const first = await scanAgentMarkets(undefined, fixture.manifest, rpcFor(rows));
  const before = JSON.stringify(first.state);
  await assert.rejects(scanAgentMarkets(first.state, fixture.manifest, rpcFor(rows, { fail: true })), /timeout/);
  await assert.rejects(scanAgentMarkets(first.state, fixture.manifest, rpcFor(rows, { reorg: true })), /重组/);
  assert.equal(JSON.stringify(first.state), before);
  const second = await scanAgentMarkets(first.state, fixture.manifest, rpcFor(rows));
  assert.equal(second.state.discovered, 20); assert.equal(second.events.length, 0);
  await assert.rejects(scanAgentMarkets(second.state, fixture.manifest, rpcFor(rows.slice(0, 16))), /回退/);
});

test('拒绝不完整页面、错身份与畸形 ABI', async () => {
  assert.throws(() => parseAppList('<h1>Loading</h1>'), /结构缺失/);
  assert.throws(() => parseAppList(flight({ apps: [...fixture.catalog, ...fixture.catalog] })), /重复/);
  assert.throws(() => parseRegistration(flight({ registration: fixture.registration }), { ...fixture.catalog[0], appId: 'wrong' }), /身份/);
  assert.throws(() => decodeMarketCards(cards([{ market: addr(1), phase: 4 }]), [addr(1)]), /阶段/);
  assert.throws(() => decodeMarketCards('0x01', []), /ABI/);
  const changed = structuredClone(fixture.manifest);
  changed.walletContracts.find(v => v.id === 'reader').read = ['function marketCards(address[] markets) view returns (uint256)'];
  await assert.rejects(scanAgentMarkets(undefined, changed, async () => { throw Error('不应读取'); }), /ABI 已变化/);
});

test('模板详情只读取名称和说明，忽略风险加载占位、代币行情；失败保留基线', async () => {
  const html = '<div><h1>模板</h1><p role="status">正在加载</p><p>说明</p></div><section>Token price 123</section>';
  assert.deepEqual(parseTemplateDetail(html), { name: '模板', description: '说明' });
  assert.deepEqual(parseTemplateDetail(html.replace('123', '999')), parseTemplateDetail(html));
  assert.throws(() => parseTemplateDetail('<h1>Loading</h1>'), /不完整/);
  let saved = {}, current = html, sent = [];
  const monitor = createMiniAppMonitor({ persist: state => { saved = structuredClone(state); },
    fetchText: async url => url.includes('/apps?') ? flight({ apps: [] }) : current,
    deliver: async p => { sent.push(p); return 'id'; } });
  monitor.setTemplates([{ factory: addr(1), sourceUrl: `https://flap.sh/bnb/CAstore/vault/${addr(1)}?lang=zh` }]);
  await monitor.run(); assert.equal(sent.length, 0);
  current = '<h1>Loading</h1>'; await monitor.run();
  assert.equal(saved.templateDetails[addr(1)].description, '说明');
  current = html.replace('说明', '新版说明'); await monitor.run();
  assert.equal(sent.length, 1); assert.match(sent[0].content, /新版说明/);
});

test('已保存采样锚点重组后明确标记并静默重建，不把旧市场再报新增', async () => {
  const rows = [{ market: addr(1), phase: 3 }], rpc = rpcFor(rows);
  const previous = (await scanAgentMarkets(undefined, fixture.manifest, rpc)).state;
  previous.block.hash = '0x' + 'c'.repeat(64);
  const result = await scanAgentMarkets(previous, fixture.manifest, rpc);
  assert.equal(result.reorganized, true); assert.equal(result.events.length, 0);
});

test('资源哈希校验、成功缓存，不执行组件；拒绝非公开资源域名', async () => {
  const registration = structuredClone(fixture.registration), texts = { manifest: JSON.stringify(fixture.manifest), metadata: '{}', i18n: '{"zh":{}}', component: 'throw new Error("must never execute")' };
  let calls = 0;
  for (const name of Object.keys(texts)) registration.artifact.assetHashes[name + 'Sha256'] = createHash('sha256').update(texts[name]).digest('hex');
  const fetchText = async url => { calls++; return texts[url.split('/').at(-1).split('.')[0]]; };
  const cache = new Map();
  await readAppArtifact(registration, fetchText, cache); await readAppArtifact(registration, fetchText, cache);
  assert.equal(calls, 4);
  await assert.rejects(readAppArtifact(registration, async () => '{}'), /SHA256/);
  registration.artifact.assets.manifestUrl = 'http://127.0.0.1/secret';
  await assert.rejects(readAppArtifact(registration, fetchText), /来源/);
});

test('小程序目录新建、发送失败持久化、重启重投，坏页面不移除应用', async () => {
  let saved = {}, rows = [{ appId: 'other-app', slug: 'other-app', name: 'Other' }], sends = 0;
  const fetchText = async url => url.includes('/apps?') ? flight({ apps: rows }) : '<h1>incomplete</h1>';
  const make = deliver => createMiniAppMonitor({ initial: saved, persist: s => { saved = structuredClone(s); }, fetchText, rpc: async () => { throw Error('not reached'); }, deliver });
  let monitor = make(async () => { sends++; throw Error('delivery failed'); });
  await monitor.run(); assert.equal(sends, 0);
  rows = [...rows, { appId: 'new-app', slug: 'new-app', name: 'New' }];
  await monitor.run(); assert.equal(saved._notificationOutbox.length, 1);
  assert.equal(saved.catalog.length, 2);
  saved._notificationOutbox[0].nextAttemptAt = 0;
  monitor = make(async (p, options) => { if (p.title.includes('新增应用')) sends++; assert(options.deliveryId); return 'message-id'; });
  await monitor.run(); assert.equal(saved._notificationOutbox.length, 0);
  const before = sends; await monitor.run(); assert.equal(sends, before);
  const broken = createMiniAppMonitor({ initial: saved, persist: s => { saved = structuredClone(s); }, fetchText: async () => '<h1>Error</h1>', deliver: async () => { throw Error('must not send'); } });
  await broken.run(); assert.equal(saved.catalog.length, 2); assert.match(saved.lastError, /结构缺失/);
});

test('停用 Agent Curve：旧队列先归档，目录失败或重启均不补发，不查询页面和链上', async () => {
  const app = fixture.catalog[0];
  const entry = (id, content) => ({ id, payload: { title: 'Flap 小程序｜市场毕业', content }, nextAttemptAt: 0, attempts: 0, parts: [] });
  let saved = { catalog: [app], apps: { [app.appId]: { config: { catalog: app }, markets: { cursor: 16 } } },
    errors: { [app.appId]: { failures: 3 } }, _notificationOutbox: [
      entry('market', '市场\nhttps://flap.sh/apps/agent-bonding-curve'),
      entry('error', 'ID AGENT CURVE\n连续 3 次失败'),
      entry('other', '另一个应用\nhttps://flap.sh/apps/other') ] };
  const delivered = [], requests = [];
  let broken = true;
  const make = () => createMiniAppMonitor({ initial: saved, persist: s => { saved = structuredClone(s); },
    fetchText: async url => { requests.push(url); assert.match(url, /\/apps\?/); return broken ? '<h1>Error</h1>' : flight({ apps: [app] }); },
    rpc: async () => assert.fail('停用市场不得查询 RPC'), deliver: async p => { delivered.push(p); return 'ok'; } });
  await make().run();
  assert.equal(delivered.length, 1); assert.match(delivered[0].content, /另一个应用/);
  assert.equal(saved.disabledAppNotifications.length, 2);
  assert.equal(saved.disabledApps[app.appId].markets.cursor, 16);
  assert.deepEqual(saved.apps, {}); assert.deepEqual(saved.errors, {});
  broken = false;
  const monitor = make(); await monitor.run(); await monitor.run();
  assert.equal(delivered.length, 1); assert.equal(saved.disabledAppNotifications.length, 2);
  assert.deepEqual(saved.catalog, []); assert.equal(monitor.status().apps, 0);
  assert.equal(requests.length, 3); assert.equal(monitor.status().pending, 0);
});
