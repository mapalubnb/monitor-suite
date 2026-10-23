import { createHash } from 'node:crypto';
import { parseHTML } from 'linkedom';
import { createTransactionalOutbox } from '../shared/transactional-outbox.mjs';
import { formatBeijingTime, formatDisplayText } from '../shared/display-format.cjs';

export const APPS_URL = 'https://flap.sh/apps?lang=zh';
export function appConfigDiff(before, after, path = '') {
  if (stable(before) === stable(after)) return [];
  if (before && after && typeof before === 'object' && typeof after === 'object' && !Array.isArray(before) && !Array.isArray(after))
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().flatMap(key => appConfigDiff(before[key], after[key], path ? `${path}.${key}` : key));
  return [`${path}：${stable(before) ?? '(无)'} → ${stable(after) ?? '(移除)'}`];
}
const address = value => /^0x[0-9a-f]{40}$/i.test(value || '');
const zero = '0x' + '0'.repeat(40);
const hash = value => createHash('sha256').update(value).digest('hex');
const word = value => BigInt(value).toString(16).padStart(64, '0');
const stable = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);

// Decode serialized Flight data, never execute scripts or downloaded components.
export function flightObjects(html) {
  const { document } = parseHTML(html);
  let data = '';
  for (const script of document.querySelectorAll('script')) {
    for (const match of script.textContent.matchAll(/self\.__next_f\.push\((\[1,"(?:[^"\\]|\\.)*"\])\)/g)) {
      data += JSON.parse(match[1])[1];
    }
  }
  const objects = [];
  function visit(v) {
    if (!v || typeof v !== 'object') return;
    if (!Array.isArray(v)) objects.push(v);
    for (const child of Object.values(v)) visit(child);
  }
  for (const line of data.split('\n')) {
    const start = line.indexOf(':');
    if (start < 0) continue;
    try { visit(JSON.parse(line.slice(start + 1))); } catch { /* Non-JSON Flight records. */ }
  }
  return objects;
}

export function parseAppList(html) {
  const rows = flightObjects(html).find(v => Array.isArray(v.apps))?.apps;
  if (!rows || rows.length > 128) throw Error('小程序目录结构缺失或超限，保留基线');
  const seen = new Set();
  for (const row of rows) {
    if (!/^[a-z0-9][a-z0-9-]{0,100}$/.test(row.slug || '') || !row.appId || seen.has(row.slug))
      throw Error('小程序目录身份无效或重复');
    seen.add(row.slug);
  }
  return rows.map(({ appId, slug, name, displayTitle, category }) => ({ appId, slug, name, displayTitle, category }));
}

export function parseRegistration(html, app) {
  const registration = flightObjects(html).find(v => v.registration)?.registration;
  if (!registration || registration.slug !== app.slug || registration.appId !== app.appId)
    throw Error('小程序注册身份不匹配');
  return registration;
}

export function parseTemplateDetail(html) {
  const { document } = parseHTML(html), heading = document.querySelector('h1');
  const name = heading?.textContent.trim();
  const description = [...(heading?.parentElement?.querySelectorAll('p:not([role="status"])') || [])]
    .map(p => p.textContent.trim()).filter(Boolean).join('\n');
  if (!name || !description || /not found|access denied|出错|不存在/i.test(name)) throw Error('机制模板详情不完整，保留旧基线');
  // Exclude launched-token lists, prices, risk-loading placeholders and wallet UI.
  return { name, description };
}

function artifactUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !/^[a-z0-9]+\.public\.blob\.vercel-storage\.com$/.test(url.hostname) || !url.pathname.startsWith('/vault-ui/'))
    throw Error('小程序资源来源未覆盖，保留基线');
  return url.href;
}

export async function readAppArtifact(registration, fetchText, cache = new Map()) {
  const artifact = registration.artifact;
  if (!artifact?.assets || !artifact.assetHashes) throw Error('小程序资源清单不完整');
  const key = stable(artifact);
  if (cache.has(key)) return cache.get(key);
  const texts = {};
  for (const name of ['manifest', 'metadata', 'i18n', 'component']) {
    const digest = artifact.assetHashes[name + 'Sha256'];
    if (!/^[a-f0-9]{64}$/.test(digest || '')) throw Error('小程序资源缺少 SHA256');
    const text = await fetchText(artifactUrl(artifact.assets[name + 'Url']));
    if (Buffer.byteLength(text) > 2_000_000 || hash(text) !== digest) throw Error('小程序资源大小或 SHA256 不匹配');
    texts[name] = text;
  }
  const manifest = JSON.parse(texts.manifest);
  if (manifest.mode !== 'mini-app' || manifest.slug !== registration.slug || manifest.artifactId !== registration.appId)
    throw Error('小程序 manifest 身份不匹配');
  const result = { manifest, metadata: JSON.parse(texts.metadata), i18n: JSON.parse(texts.i18n),
    componentSha256: artifact.assetHashes.componentSha256, version: artifact.version };
  cache.set(key, result);
  while (cache.size > 32) cache.delete(cache.keys().next().value);
  return result;
}

// Strict ABI decoder for the four observed Reader/Factory read methods.
function abi(hex) {
  if (!/^0x(?:[0-9a-f]{64})*$/i.test(hex || '')) throw Error('市场 ABI 响应无效');
  const data = Buffer.from(hex.slice(2), 'hex');
  const uint = offset => {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset % 32 || offset + 32 > data.length) throw Error('市场 ABI 越界');
    return BigInt('0x' + data.subarray(offset, offset + 32).toString('hex'));
  };
  const number = offset => { const n = uint(offset); if (n > 1_000_000n) throw Error('市场 ABI 数值超限'); return Number(n); };
  const addr = offset => { const n = uint(offset); if (n >> 160n) throw Error('市场地址填充无效'); return '0x' + n.toString(16).padStart(40, '0'); };
  const str = offset => {
    const length = number(offset);
    if (length > 4096 || offset + 32 + length > data.length) throw Error('市场字符串越界');
    return data.subarray(offset + 32, offset + 32 + length).toString('utf8');
  };
  return { uint, number, addr, str };
}

export function decodeMarketPage(hex, cursor, limit) {
  const a = abi(hex), start = a.number(0), next = a.number(32), total = a.number(64), length = a.number(start);
  if (start !== 96 || length !== Math.min(limit, total - cursor) || next !== cursor + length || next > total)
    throw Error('市场分页不完整或游标不连续');
  const markets = Array.from({ length }, (_, i) => a.addr(start + 32 + i * 32));
  if (markets.some(v => v === zero) || new Set(markets).size !== markets.length) throw Error('市场分页地址无效');
  return { markets, next, total };
}

export function decodeMarketCards(hex, expected) {
  const a = abi(hex), start = a.number(0), length = a.number(start), base = start + 32;
  if (start !== 32 || length !== expected.length) throw Error('市场卡片不完整');
  return expected.map((market, i) => {
    const offset = base + a.number(base + i * 32), phase = a.number(offset + 8 * 32);
    if (a.addr(offset) !== market || ![1, 2, 3].includes(phase) || a.uint(offset + 10 * 32) === 0n)
      throw Error('市场身份、阶段或阈值无效');
    const row = { market, quoteToken: a.addr(offset + 32), name: a.str(offset + a.number(offset + 64)),
      symbol: a.str(offset + a.number(offset + 96)), meta: a.str(offset + a.number(offset + 128)),
      predictedToken: a.addr(offset + 160), token: a.addr(offset + 192), pair: a.addr(offset + 224), phase };
    if (phase === 3 && (row.token === zero || row.pair === zero)) throw Error('毕业市场缺少代币或交易对');
    return row;
  });
}

export async function scanAgentMarkets(previous, manifest, rpc) {
  const reader = manifest.walletContracts?.find(v => v.id === 'reader');
  const factory = manifest.walletContracts?.find(v => v.id === 'factory');
  if (reader?.chainId !== 56 || factory?.chainId !== 56 || !address(reader.address) || !address(factory.address))
    throw Error('Agent 市场 Reader/Factory 配置无效');
  for (const signature of [
    'function factory() view returns (address)',
    'function marketCards(address[] markets) view returns ((address market,address quoteToken,string name,string symbol,string meta,address predictedToken,address token,address pair,uint8 phase,uint256 poolRaw,uint256 capRaw,uint256 progressBps,uint256 buyCount,uint256 sellCount,uint256 curveH,uint256 curveK)[] cards)',
    'function marketPage(uint256 cursor,uint256 limit) view returns (address[] marketAddresses,uint256 nextCursor,uint256 total)',
  ]) if (!reader.read?.includes(signature)) throw Error('Agent Reader ABI 已变化，暂停解码');
  if (!factory.read?.includes('function marketCount() view returns (uint256)')) throw Error('Agent Factory ABI 已变化，暂停解码');
  const block = await rpc('eth_getBlockByNumber', ['latest', false]);
  if (!/^0x[0-9a-f]+$/i.test(block?.number || '') || !/^0x[0-9a-f]{64}$/i.test(block?.hash || '')) throw Error('市场区块无效');
  const call = (to, data) => rpc('eth_call', [{ to, data }, block.number]);
  if (abi(await call(reader.address, '0xc45a0155')).addr(0) !== factory.address.toLowerCase()) throw Error('Reader Factory 绑定不匹配');
  const count = abi(await call(factory.address, '0xec979082')).number(0);
  const identity = factory.address.toLowerCase();
  let prior = previous?.factory === identity ? previous : undefined;
  let reorganized = false;
  if (prior?.block) {
    if (BigInt(block.number) < BigInt(prior.block.number)) throw Error('市场节点高度落后，保留状态');
    const anchor = await rpc('eth_getBlockByNumber', [prior.block.number, false]);
    if (!anchor?.hash) throw Error('市场旧采样区块不可读');
    if (anchor.hash !== prior.block.hash) { reorganized = true; prior = undefined; }
  }
  const state = structuredClone(prior || { factory: identity, baselineCount: count, discovered: 0, cursor: 0, markets: {} });
  if (count < state.discovered) throw Error('市场数量回退，保留游标等待规范链恢复');
  const cursor = state.discovered < count ? state.discovered : state.cursor % Math.max(count, 1);
  const page = decodeMarketPage(await call(reader.address, '0x8f82e165' + word(cursor) + word(16)), cursor, 16);
  if (page.total !== count) throw Error('市场总量不一致');
  const cards = page.markets.length ? decodeMarketCards(await call(reader.address,
    '0x304a170b' + word(32) + word(page.markets.length) + page.markets.map(v => v.slice(2).padStart(64, '0')).join('')), page.markets) : [];
  const check = await rpc('eth_getBlockByNumber', [block.number, false]);
  if (check?.hash !== block.hash) throw Error('市场采样发生重组，保留旧状态');
  const events = [];
  cards.forEach((row, i) => {
    const old = state.markets[row.market];
    if (!old && cursor + i >= state.baselineCount) events.push({ type: '新增市场', row });
    else if (old && old.phase !== row.phase) events.push({ type: row.phase === 3 ? '市场毕业' : '市场阶段变更', row, previousPhase: old.phase });
    state.markets[row.market] = row;
  });
  state.discovered = Math.max(state.discovered, page.next);
  state.cursor = page.next === count ? 0 : page.next;
  state.block = { number: block.number, hash: block.hash };
  return { state, events, block, reorganized };
}

export function createMiniAppMonitor({ initial = {}, persist, fetchText, rpc, deliver, log = () => {} }) {
  const cache = new Map();
  const box = createTransactionalOutbox({ initial, persist, deliver, onError: e => log(`小程序投递失败：${e.message}`) });
  let flight, templates = [], templateCursor = 0;
  const notify = (title, content) => box.enqueue({ title: `${title.startsWith("机制模板") ? "Flap" : "Flap 小程序"}｜${title}`, content: formatDisplayText(content), template: 'orange' });
  async function pass() {
    await box.drain();
    try {
      const rows = parseAppList(await fetchText(APPS_URL));
      await box.transaction(async () => {
        const old = box.state.catalog;
        if (old) {
          for (const row of rows) if (!old.some(v => v.appId === row.appId)) await notify('新增应用', `${row.displayTitle?.zh || row.name}\nhttps://flap.sh/apps/${row.slug}`);
          for (const row of old) if (!rows.some(v => v.appId === row.appId)) await notify('应用目录移除', `${row.name}\n${APPS_URL}\n仅表示目录未再列出，不代表链上停用。`);
        }
        box.state.catalog = rows;
      });
      for (const row of rows) {
        try {
          const registration = parseRegistration(await fetchText(`https://flap.sh/apps/${row.slug}?lang=zh`), row);
          const artifact = await readAppArtifact(registration, fetchText, cache);
          await box.transaction(async () => {
            const apps = box.state.apps ||= {};
            const old = apps[row.appId];
            const config = { ...artifact, enabled: registration.enabled, artifactEnabled: registration.artifact.enabled, catalog: row };
            if (old && stable(old.config) !== stable(config)) await notify('描述、资源或配置变更', `${row.name}\nhttps://flap.sh/apps/${row.slug}\n${appConfigDiff(old.config, config).join('\n')}`);
            apps[row.appId] = { ...old, config, lastSuccess: formatBeijingTime(new Date()), lastError: '' };
          });
          if (row.slug === 'agent-bonding-curve' && registration.enabled && registration.artifact.enabled) {
            const result = await scanAgentMarkets(box.state.apps[row.appId]?.markets, artifact.manifest, rpc);
            await box.transaction(async () => {
              box.state.apps[row.appId].markets = result.state;
              if (result.reorganized) await notify('市场采样重组', `${row.name}\n先前采样区块已不在规范链，旧市场判断需重新核对。当前重新建立市场基线，不补发历史市场。\nhttps://flap.sh/apps/${row.slug}`);
              for (const event of result.events) {
                const m = event.row;
                await notify(event.type, `${m.name} (${m.symbol})\n市场：${m.market}\n底池币种：${m.quoteToken}\n阶段：${m.phase === 3 ? '已毕业' : m.phase === 2 ? '发射中' : '曲线阶段'}\n${m.phase === 3 ? "代币" : "预测代币（未确认部署）"}：${m.phase === 3 ? m.token : m.predictedToken}\n交易对：${m.pair}\n采样区块：${result.block.number} (${result.block.hash})\n发现时间：${formatBeijingTime(new Date())}\nhttps://flap.sh/apps/${row.slug}\n按规范区块的公开 Reader 状态识别，不代表官方背书。`);
              }
            });
          }
        } catch (e) {
          await box.transaction(async () => {
            const errors = box.state.errors ||= {}, failures = (errors[row.appId]?.failures || 0) + 1;
            errors[row.appId] = { message: e.message, failures, at: formatBeijingTime(new Date()) };
            if (failures === 1 || failures === 3) log(`${row.slug}：${e.message}`);
            if (failures === 3) await notify('采集失败', `${row.name}\n连续 3 次失败：${e.message}\n保留旧基线和队列。`);
          });
          continue;
        }
        await box.transaction(() => { if (box.state.errors) delete box.state.errors[row.appId]; });
      }
      await box.transaction(() => { box.state.lastSuccess = formatBeijingTime(new Date()); box.state.lastError = ''; box.state.failures = 0; });
    } catch (e) {
      await box.transaction(async () => {
        box.state.lastError = e.message;
        box.state.failures = (box.state.failures || 0) + 1;
        if (box.state.failures === 1 || box.state.failures === 3) log(`小程序目录：${e.message}`);
        if (box.state.failures === 3) await notify('目录采集失败', `连续 3 次失败：${e.message}\n保留旧基线和队列。`);
      });
    }
    if (templates.length) {
      const template = templates[templateCursor++ % templates.length];
      try {
        const detail = parseTemplateDetail(await fetchText(template.sourceUrl));
        await box.transaction(async () => {
          const details = box.state.templateDetails ||= {}, key = template.factory.toLowerCase();
          if (details[key] && stable(details[key]) !== stable(detail)) await notify('机制模板详情变更', `${template.sourceUrl}\n${appConfigDiff(details[key], detail).join('\n')}`);
          details[key] = detail;
          if (box.state.detailErrors) delete box.state.detailErrors[key];
        });
      } catch (error) {
        await box.transaction(() => { (box.state.detailErrors ||= {})[template.factory.toLowerCase()] = error.message; });
      }
    }
    await box.drain();
  }
  return { run: () => flight ||= pass().finally(() => { flight = null; }), wait: () => flight,
    setTemplates: rows => { templates = rows.filter(row => address(row.factory) && row.sourceUrl === `https://flap.sh/bnb/CAstore/vault/${row.factory}?lang=zh`); },
    status: () => ({ lastSuccess: box.state.lastSuccess, lastError: box.state.lastError, errors: box.state.errors || {}, detailErrors: box.state.detailErrors || {}, templateDetails: Object.keys(box.state.templateDetails || {}).length, apps: Object.keys(box.state.apps || {}).length, pending: (box.state._notificationOutbox || []).length }) };
}
