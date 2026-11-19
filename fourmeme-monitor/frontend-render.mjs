import { createHash } from 'node:crypto';
import { fork, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { formatBeijingTime } from '../shared/display-format.cjs';
import { cardStatus, cardTime } from './card-style.mjs';

export const RENDER_URLS = ['zh-TW', 'en'].flatMap(locale =>
  ['create-token', 'advanced', '4stock', ''].map(path => `https://four.meme/${locale}${path ? '/' + path : ''}`));
export const PUBLIC_RENDER_URLS = ['zh-TW', 'en'].flatMap(locale =>
  ['contract', 'agentic', 'campaign', 'announcement', 'bridge'].map(path => `https://four.meme/${locale}/${path}`));
export const ADVANCED_PANEL = '.no-scrollbar > .flex-h > .glass-panel';
export const ADVANCED_FILTER = /^(?:篩選|筛选|Filters?)$/i;
export const CREATE_OPEN_MODE = /^(?:開放模式|开放模式|Open(?: Mode)?)$/i;

const profileFor = pathname => pathname.split('/').filter(Boolean)[1] || 'home';
const pageNames = {
  home: '首页', advanced: 'Advanced', 'create-token': '创建代币', '4stock': '4Stock',
  contract: 'Open Four', agentic: 'Agentic', campaign: '活动', announcement: '公告', bridge: '跨链桥',
};

export function isInfrastructureRoute(route) {
  return /^\/(?:en\/|zh-TW\/)?(?:cdn-cgi|images|assets|fonts)(?:\/|$)/i.test(route);
}

export function pageContentQuality(url, text = '') {
  const path = new URL(url).pathname;
  if (/\/create-token$/.test(path)) {
    return /(?:代幣名稱|Token Name|Token name)/.test(text) && /(?:啟用稅收|Enable Tax|Launch options|發射選項)/i.test(text) ? 'complete' : 'shell';
  }
  if (/\/advanced$/.test(path)) return /(?:Loading|載入中)/i.test(text) && text.length < 1500 ? 'shell' : 'unverified';
  return 'unverified';
}

// This function is serialized into an anonymous browser context. It only reads
// visible public DOM; no wallet, account, storage, framework internals or trades.
export function collectRenderedDom({ panelSelector, layer, timeoutMs } = {}) {
  const visible = el => !!el && !el.closest('[hidden],[aria-hidden="true"]')
    && (typeof el.getClientRects !== 'function' || el.getClientRects().length > 0);
  const text = el => (el.innerText || el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim();
  const main = document.querySelector('main');
  const read = selector => [...(main?.querySelectorAll(selector) || [])].filter(el => visible(el)
    // This overview and the amount/tax extensions depend on which template
    // the site selected. Compare the shared form under the create-page URL.
    && (layer !== 'open-form' || !el.closest('section[class*="_overview"],.space-y-5[class*="empty"]')));
  const path = location.pathname || location.href.replace(/^https?:\/\/[^/]+/, '').split(/[?#]/)[0];
  const advanced = /\/advanced\/?$/.test(path);
  const stock = /\/4stock\/?$/.test(path);
  const home = /^\/(?:en|zh-TW)\/?$/.test(path);
  const headings = 'h1,h2,h3,h4';
  const inputSelector = 'input:not([type="hidden"]),textarea,select,[role="combobox"]';
  const controlLabel = el => el.getAttribute('aria-label') || el.getAttribute('title') || text(el);
  const fields = els => els.map(el => ({
    type: el.getAttribute('type') || el.getAttribute('role') || el.tagName.toLowerCase(),
    name: el.getAttribute('name') || '',
    label: el.labels?.[0] ? text(el.labels[0]) : el.getAttribute('aria-label') || el.getAttribute('placeholder') || '',
  }));
  const readFilter = filterId => {
    // The button's aria-controls points to the filter portal outside <main>.
    const popover = filterId && document.getElementById(filterId);
    if (!popover || popover.closest('[hidden],[aria-hidden="true"]')) return null;
    const scope = selector => [...popover.querySelectorAll(selector)].filter(visible);
    const data = { labels: scope(headings + ',label,legend').map(text), fields: fields(scope(inputSelector)), controls: scope('button').map(controlLabel) };
    return data.labels.length || data.fields.length || data.controls.length ? data : null;
  };
  const panels = advanced ? read(panelSelector || '.no-scrollbar > .flex-h > .glass-panel').filter(panel => visible(panel.firstElementChild)) : [];
  // The quick-buy input renders before the asynchronous market columns.
  // Verify the panel structure independently of its names and controls.
  const advancedBoardReady = panels.some(panel => panel.children.length >= 2);
  const columns = panels.map(panel => {
    const header = panel.firstElementChild;
    return { label: text(header.querySelector(headings) || header).slice(0, 100),
      controls: [...header.querySelectorAll('button')].filter(visible).map(controlLabel) };
  });
  if (layer === 'advanced-filters') {
    // The browser updates Headless UI state asynchronously. Work against the
    // same verified header elements and use their ARIA-owned popup containers
    // so off-screen columns do not wait on pointer actionability or scrolling.
    return (async () => {
      const end = Date.now() + timeoutMs;
      const toggle = (button, probe, until) => {
        return new Promise(resolve => {
          const finish = value => {
            observer.disconnect();
            clearTimeout(timer);
            resolve(value || null);
          };
          const check = () => {
            const value = probe();
            if (value) finish(value);
          };
          const observer = new MutationObserver(check);
          const timer = setTimeout(() => finish(probe()), Math.max(1, until - Date.now()));
          observer.observe(button, { attributes: true, attributeFilter: ['aria-expanded', 'aria-controls'] });
          const portalRoot = document.getElementById('headlessui-portal-root');
          if (portalRoot) observer.observe(portalRoot, { childList: true, subtree: true });
          button.click();
          check();
        });
      };
      const filterButton = /^(?:篩選|筛选|Filters?)$/i;
      for (const [index, panel] of panels.entries()) {
        const column = columns[index];
        if (!column) continue;
        const button = [...panel.firstElementChild.querySelectorAll('button[aria-expanded]')]
          .find(el => visible(el) && filterButton.test(controlLabel(el)));
        if (!button) continue;
        const until = Math.min(end, Date.now() + 2500);
        if (Date.now() >= until) break;
        const opened = () => button.getAttribute('aria-expanded') === 'true' && readFilter(button.getAttribute('aria-controls'));
        column.filter = opened() || await toggle(button, opened, until);
        if (button.getAttribute('aria-expanded') === 'true') {
          await toggle(button, () => button.getAttribute('aria-expanded') === 'false', until);
        }
      }
      return { columns, labelsAfter: read(panelSelector || '.no-scrollbar > .flex-h > .glass-panel')
        .filter(panel => visible(panel.firstElementChild))
        .map(panel => text(panel.firstElementChild.querySelector(headings) || panel.firstElementChild).slice(0, 100)) };
    })();
  }
  const stockSelector = stock && read('button[id^="headlessui-popover-button"]').find(el => el.hasAttribute('aria-expanded'));
  const buttons = read('button');
  return {
    url: location.href,
    mainText: main ? text(main).slice(0, 20000) : '',
    ...(advanced ? { advancedBoardReady } : {}),
    ...(advanced ? { columns } : {}),
    ...(stock ? { stockReady: !!stockSelector && !/(?:loading|載入|加载)/i.test(text(stockSelector)) && /[\p{L}\p{N}]/u.test(text(stockSelector)) } : {}),
    ...(home ? { homeReady: read('.segmented.min-w-max,.icon-pill-group').length > 0, homeControls: buttons.map(controlLabel) } : {}),
    headings: read(headings).map(text),
    tabs: read('[role="tab"]').map(text),
    labels: read('label,legend,p').map(text),
    buttons: buttons.map(text),
    fields: read(inputSelector).map(el =>
      [el.tagName.toLowerCase(), el.getAttribute('type') || '', el.getAttribute('aria-label') || el.getAttribute('placeholder') || ''].join('|')),
    detailFields: fields(read(inputSelector)),
    selectedTab: read('[role="tab"][aria-selected="true"]').map(text)[0] || '',
    navigation: [...document.querySelectorAll('nav a[href]')].filter(visible).map(el => ({ text: text(el), href: el.getAttribute('href') })),
    switches: read('[role="switch"],input[type="checkbox"]').length,
    ...(/\/(?:contract|agentic|campaign|announcement|bridge)\/?$/.test(path) ? {
      links: read('a[href]').slice(0, 150).map(el => ({ href: el.getAttribute('href'), text: text(el).slice(0, 180) })),
      frames: read('iframe[src]').map(el => el.getAttribute('src')),
      articles: /\/announcement\/?$/.test(path) ? read('button').filter(el => /^(?:Learn More|Read More|瞭解更多|了解更多)$/i.test(text(el)))
        .map(el => text(el.parentElement.parentElement).split(/(?:Learn More|Read More|瞭解更多|了解更多)/i).join(' ').replace(/\s+/g, ' ').trim()).slice(0, 30) : [],
    } : {}),
  };
}

function stableLabel(value, allowNumbers = false) {
  const s = String(value || '').replace(/\s+/g, ' ').trim();
  // Market/asset buttons contain ticker amounts, percentages or prices. A
  // number-only normalization would still leak changing ticker inventories.
  if (!s || /(?:0x[a-f\d]{4}|錢包|Wallet|Orders|訂單|Loading|載入|Connect Wallet|連接錢包|登入|Log.?in)/i.test(s)
    || (!allowNumbers && /\$|\d/.test(s))) return '';
  return s.slice(0, 200);
}

const transientSignal = signal => /^按钮：(打開聊天|關閉聊天|打开聊天|关闭聊天|Open chat|Close chat)$/i.test(signal);
const signalHash = signals => createHash('sha256').update(JSON.stringify(signals)).digest('hex');
const detailSignal = /^(?:页面控件|栏目控件|筛选字段|筛选控件|模式结构|表单字段|面板字段)：/;
const isColumnFilterSignal = (column, signal) => signal.startsWith(`筛选字段：${column} / `) || signal.startsWith(`筛选控件：${column} / `);
const publicProfile = /^(?:contract|agentic|campaign|announcement|bridge)$/;
const knownAdvancedButton = /^(?:Filters?|篩選|筛选|Pause updates|Resume updates|暫停更新|繼續更新|暂停更新|继续更新|Drag to reorder|拖曳排序|拖动排序)$/i;
const dragOrPause = /(?:Pause updates|Resume updates|暫停更新|繼續更新|暂停更新|继续更新)/i;
const displayControl = value => dragOrPause.test(value) ? '暂停/继续更新' : /^drag to reorder$|拖曳排序|拖动排序/i.test(value) ? '拖曳排序' : ADVANCED_FILTER.test(value) ? '筛选' : value;
const marketNames = new Map([
  ['Newly Created', '新發行'], ['About to Launch', '即將發射'], ['Trading Volume', '交易量'], ['Graduated', '已發射'], ['Hot', '熱度'],
]);
const filterLabels = new Map([
  ['Market Cap(USD)', '市值(USD)'], ['Volume(USD)', '交易量(USD)'], ['Number of Holders', '持有者數量'],
]);

function addFields(out, prefix, fields = []) {
  for (const [index, field] of fields.entries()) {
    const name = /^[\w.:[\]-]{1,80}$/.test(field.name) ? field.name : '';
    const label = stableLabel(field.label, true) || (prefix === '面板字段：' ? `输入 ${index + 1}` : '');
    if (name || label) out.push(`${prefix}${[label || name, name && name !== label ? `[${name}]` : '', field.type].filter(Boolean).join(' ')}`);
  }
}

function comparableSignal(signal) {
  const normalized = signal.replace(/\/(?:en|zh-TW)(?=\/|$)/g, '')
    .replace(/^((?:标题|栏目控件|筛选字段|筛选控件)：)(.+?)(?= \/ |$)/, (_, start, label) => start + (marketNames.get(label) || label))
    .replace(/^(筛选字段：.+? \/ )(.+)$/, (_, start, label) => start + (filterLabels.get(label) || label));
  return normalized
    .replace(/^按钮：(篩選|Filters?)$/i, '按钮：筛选')
    .replace(/(\d)(?:上午|早上)/g, '$1am').replace(/(\d)(?:下午|晚上)/g, '$1pm');
}

function groupRenderedChanges(changes) {
  const groups = new Map();
  for (const change of changes) {
    const page = new URL(change.url);
    const signature = JSON.stringify([profileFor(page.pathname),
      change.added.map(comparableSignal).sort(), change.removed.map(comparableSignal).sort()]);
    const group = groups.get(signature) || [];
    group.push(change);
    groups.set(signature, group);
  }
  return [...groups.values()];
}

function formatRenderedChanges(changes) {
  const link = (url, label) => `[${label}](${url})`;
  const locale = url => new URL(url).pathname.split('/')[1] === 'zh-TW' ? '繁中' : '英文';
  const sections = groupRenderedChanges(changes).map(group => {
    const change = group[0];
    const path = new URL(change.url).pathname;
    const profile = profileFor(path);
    const name = pageNames[profile] || path;
    const heading = group.length === 1
      ? link(change.url, `${name} · ${locale(change.url)}`)
      : `${name} · ${group.map(p => link(p.url, locale(p.url))).join(' / ')}`;
    const format = (list, removed, urls) => {
      if (!list.length) return '';
      const rows = [], sameType = new Map();
      for (const value of list) {
        const target = urls?.[value];
        const label = value.match(/^(标题|选项卡|按钮|功能)：(.+)$/);
        if (!target && label) {
          const type = label[1] === '标题' && profile === 'advanced' ? '栏目' : label[1];
          if (!sameType.has(type)) {
            const names = [];
            sameType.set(type, names);
            rows.push({ type, names });
          }
          sameType.get(type).push(label[2]);
        } else {
          rows.push(target ? `${value} · ${link(target, '详情')}` : value);
        }
      }
      const status = removed ? `🔴 移除 ${list.length} · 两次确认` : `🟢 新增 ${list.length}`;
      return [`<font color="${removed ? 'red' : 'green'}">${status}</font>`,
        ...rows.map(row => typeof row === 'string' ? row : `${row.type} · ${row.names.join(' / ')}`)].join('\n');
    };
    const localizedDetails = group.slice(1).flatMap(peer =>
      [...new Set([...peer.added.map(value => peer.addedUrls?.[value]), ...peer.removed.map(value => peer.removedUrls?.[value])].filter(Boolean))]);
    return [
      `## 📍 ${heading}`,
      format(change.added, false, change.addedUrls),
      format(change.removed, true, change.removedUrls),
      localizedDetails.length ? `详情 · ${localizedDetails.map(target => link(target, locale(target))).join(' / ')}` : '',
    ].filter(Boolean).join('\n');
  });
  const first = changes[0];
  const details = [...new Set([...first.added.map(value => first.addedUrls?.[value]), ...first.removed.map(value => first.removedUrls?.[value])].filter(Boolean))];
  const onlyDetailChanged = first.added.length + first.removed.length > 0
    && [...first.added, ...first.removed].every(value => first.addedUrls?.[value] || first.removedUrls?.[value]);
  return { content: sections.join('\n\n'), url: onlyDetailChanged && details.length === 1 ? details[0] : first.url };
}

function publicPageSignals(raw, url, kind) {
  const signals = [], signalUrls = {};
  const add = (key, value, target) => {
    const label = stableLabel(value, true);
    if (!label) return;
    const signal = `${key}：${label}`;
    signals.push(signal);
    if (target) signalUrls[signal] = target;
  };
  if (kind === 'bridge') {
    for (const source of raw.frames || []) {
      try {
        const frame = new URL(source, url);
        if (frame.protocol === 'https:') add('嵌入服务', frame.origin + frame.pathname);
      } catch {}
    }
  }
  if (kind === 'contract' || kind === 'agentic') {
    for (const [key, labels] of [['标题', kind === 'contract' ? raw.headings?.slice(0, 1) : raw.headings], ['选项卡', raw.tabs]]) {
      for (const label of labels || []) add(key, label);
    }
    for (const link of raw.links || []) {
      try {
        const u = new URL(link.href, url);
        if (u.protocol !== 'https:' || /\/(?:contract\/(?:\d+|profile|collection)|token|user)(?:\/|$)/i.test(u.pathname)) continue;
        add('页面链接', `${link.text} → ${u.origin === url.origin ? u.pathname : u.origin + u.pathname}`);
      } catch {}
    }
  }
  if (kind === 'campaign') {
    for (const label of raw.buttons || []) {
      if (/^(?:Project List|Credits|項目列表|積分)$/i.test(label)) add('选项卡', label);
    }
    for (const link of raw.links || []) {
      try {
        const u = new URL(link.href, url);
        if (u.protocol !== 'https:' || !link.text) continue;
        const object = u.origin === url.origin && u.pathname.match(/^\/(?:(?:en|zh-TW)\/)?((?:presale|competition)\/\d+)\/?$/);
        if (u.origin === url.origin && !object) continue;
        // Campaign cards link to the language-neutral route, then the site
        // resolves it to the active locale. Retain the event ID across locales.
        const title = link.text.replace(/^(?:ENDED|LIVE|UPCOMING|已[結结]束|進行中|即[將将][開开]始)\s*/i, '');
        const locale = u.pathname.match(/^\/(en|zh-TW)\//)?.[1] || url.pathname.split('/')[1];
        const target = object ? `${url.origin}/${locale}/${object[1]}` : '';
        add('活动', `${title} · ${object ? '/' + object[1] : u.origin + u.pathname}`, target);
      } catch {}
    }
  }
  if (kind === 'announcement') for (const article of raw.articles || []) add('公告', article);
  const content = kind === 'campaign' ? signals.some(s => s.startsWith('活动：')) : signals.length > 0;
  if (!content) throw Error('公开页面主体未完成核验，保留旧基线');
  const sorted = [...new Set(signals)].sort();
  return { url: url.href, kind, signals: sorted, signalUrls, hash: signalHash(sorted) };
}

const advancedLegacyControls = {
  en: new Set(['标题：About to Launch', '标题：Graduated', '标题：Hot', '标题：Newly Created', '标题：Trading Volume']),
  'zh-TW': new Set(['按钮：篩選', '标题：交易量', '标题：即將發射', '标题：已發射', '标题：新發行', '标题：熱度']),
};

export function normalizeRenderedDom(raw, url) {
  const requested = new URL(url);
  const actual = new URL(raw.url || url);
  if (requested.origin !== 'https://four.meme' || actual.origin !== requested.origin || actual.pathname.replace(/\/$/, '') !== requested.pathname.replace(/\/$/, '')) throw Error('渲染页面发生非预期跳转');
  const profile = profileFor(requested.pathname);
  if (profile === 'bridge') return publicPageSignals(raw, requested, profile);
  if (!raw.mainText || /(?:verify you are human|access denied|current location.*restricted|captcha)/i.test(raw.mainText)) throw Error('渲染页面未就绪或被源站拦截');
  if (publicProfile.test(profile)) return publicPageSignals(raw, requested, profile);
  const type = /\/create-token$/.test(requested.pathname) ? 'create' : /\/4stock$/.test(requested.pathname) ? 'stock' : /\/advanced$/.test(requested.pathname) ? 'advanced' : 'home';
  if (type === 'create' && (raw.fields?.length < 3 || !raw.headings?.length || raw.switches < 1)) throw Error('创建表单未完整渲染，保留旧基线');
  if (type === 'stock' && !(raw.stockReady === true && raw.fields?.length >= 1)) throw Error('4Stock资产选择器尚未就绪，保留旧基线');
  if (['home', 'advanced'].includes(type) && (raw.navigation?.length < 4 || !raw.buttons?.length || /^(?:Loading|載入中)[.\s…]*$/i.test(raw.mainText))) throw Error('页面核心区域未完整渲染，保留旧基线');
  if (type === 'home' && raw.homeReady === false) throw Error('首页功能工具栏未就绪，保留旧基线');
  if (type === 'advanced' && (raw.advancedBoardReady !== true || !raw.fields?.length)) throw Error('Advanced 市场栏目或核心控件尚未渲染，保留旧基线');
  const signals = [];
  for (const [key, label] of [['headings', '标题'], ['tabs', '选项卡'], ['labels', '字段']]) {
    if (type === 'home') continue; // Home coverage is navigation, not the live token feed.
    if (key === 'labels' && !['create', 'stock'].includes(type)) continue;
    for (const v of raw[key] || []) { const s = stableLabel(v, true); if (s) signals.push(`${label}：${s}`); }
  }
  // Only stable functional buttons, not token cards or dynamic market filters.
  const buttons = type === 'home' ? [] : type === 'create' || type === 'stock' ? raw.buttons || [] : (raw.buttons || []).filter(x => /^(?:搜尋|Search|篩選|Filters?|Refresh token list|Clear|全部代幣|普通代幣|Tax 代幣|Open Four|All Tokens|Normal Tokens|Tax Tokens)$/i.test(x));
  for (const v of buttons) { const s = stableLabel(v); if (s) signals.push(`按钮：${s}`); }
  for (const v of type === 'home' ? [] : raw.fields || []) { if (!/搜尋更多.*(?:MEME|RWA)|Search more/i.test(v)) signals.push(`输入框：${v.slice(0, 180)}`); }
  if (type === 'create') {
    signals.push(`开关数量：${raw.switches}`);
    for (const label of ['CRYPTO', 'MEME', 'RWA', 'PREIPO', '反狙擊', '啟用稅收', 'Anti-sniper', 'Enable Tax']) {
      if (raw.mainText.includes(label)) signals.push(`功能：${label}`);
    }
    const mode = raw.selectedTab || '';
    if (mode) addFields(signals, `表单字段：${mode} / `, raw.detailFields);
    if (raw.openMode) {
      const { headings, tabs, detailFields, switches, labels, buttons } = raw.openMode;
      const openLabel = raw.openMode.selectedTab;
      for (const value of [...headings, ...labels]) {
        const label = stableLabel(value, true);
        if (label) signals.push(`模式结构：${openLabel} / ${label}`);
      }
      for (const value of buttons) {
        const label = stableLabel(value);
        if (label && !transientSignal(`按钮：${label}`)) signals.push(`模式结构：${openLabel} / 按钮 ${label}`);
      }
      if (tabs.length) signals.push(`模式结构：${openLabel} / 开关数量 ${switches}`);
      addFields(signals, `表单字段：${openLabel} / `, detailFields);
    }
  }
  if (type === 'stock') {
    addFields(signals, '面板字段：', raw.detailFields);
  }
  if (type === 'home') {
    for (const label of raw.homeControls || raw.buttons || []) {
      if (/^(?:搜尋|Search|篩選|Filters?|Refresh token list|Toggle sort direction|Grid layout|List layout|全部代幣|普通代幣|Tax 代幣|Open Four|All Tokens?|Normal Tokens?|Tax Tokens?|精選|Featured)$/i.test(label)) signals.push(`页面控件：${label}`);
    }
  }
  if (type === 'advanced') {
    for (const column of raw.columns || []) {
      if (!column.label) continue;
      for (const control of column.controls.filter(x => knownAdvancedButton.test(x) || stableLabel(x))) signals.push(`栏目控件：${column.label} / ${displayControl(control)}`);
      if (!column.filter) continue;
      for (const value of column.filter.labels) {
        const label = stableLabel(value, true);
        if (label) signals.push(`筛选字段：${column.label} / ${label}`);
      }
      addFields(signals, `筛选字段：${column.label} / `, column.filter.fields);
      for (const control of column.filter.controls) {
        const label = stableLabel(control);
        if (label) signals.push(`筛选控件：${column.label} / ${label}`);
      }
    }
  }
  for (const link of raw.navigation || []) {
    try {
      const u = new URL(link.href, requested);
      if (u.origin === requested.origin && !isInfrastructureRoute(u.pathname) && !/\/(?:token|contract)\/[^/]+/.test(u.pathname)) signals.push(`导航：${link.text.slice(0, 80)} → ${u.pathname}`);
    } catch {}
  }
  const normalized = [...new Set(signals)].filter(s => !transientSignal(s)).sort();
  if (normalized.length < 5) throw Error('渲染结构信息不足，保留旧基线');
  return { url, signals: normalized, hash: signalHash(normalized), kind: type,
    ...(raw.filterUnverified?.length ? { filterUnverified: raw.filterUnverified } : {}),
    ...(raw.captureVersion === 2 ? { captureVersion: 2 } : {}),
    ...(type === 'advanced' ? { advancedBoardVerified: true } : {}) };
}

// Only this dedicated subprocess owns Chromium. Deadline kills its browser
// process group, discards the IPC generation, and recreates it on the next poll.
export function createRenderClient({ timeoutMs = 30000, workerFile = fileURLToPath(new URL('./frontend-render-worker.mjs', import.meta.url)), forkFn = fork } = {}) {
  let child, browserPid, pending, sequence = 0;
  function kill() {
    const old = child, pid = browserPid;
    child = null; browserPid = null;
    if (old) {
      old.removeAllListeners();
      old.on('error', () => {});
      old.kill('SIGTERM');
      const timer = setTimeout(() => old.kill('SIGKILL'), 1000); timer.unref?.();
    }
    if (Number.isSafeInteger(pid) && pid > 1) {
      if (process.platform === 'win32') execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
      else { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch {} } }
    }
  }
  function finish(error, result) {
    if (!pending) return;
    const p = pending; pending = null; clearTimeout(p.timer);
    if (error) { error.results = p.results; kill(); p.reject(error); } else p.resolve(result);
  }
  function start() {
    const env = Object.fromEntries(['PATH', 'Path', 'HOME', 'USER', 'TMP', 'TEMP', 'TMPDIR', 'SystemRoot', 'WINDIR', 'XDG_RUNTIME_DIR', 'FOURMEME_CHROMIUM_PATH'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
    child = forkFn(workerFile, [], { env, execArgv: ['--max-old-space-size=128'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
    const current = child;
    child.on('message', msg => {
      if (child !== current) return;
      if (msg.type === 'browser') { browserPid = msg.pid; return; }
      if (msg.id !== pending?.id) return;
      if (msg.type === 'page') { pending.results.push(msg.result); return; }
      finish(msg.error ? Error(msg.error) : null, msg.results);
    });
    child.on('error', error => finish(error));
    child.on('exit', () => { if (child === current) { if (pending) finish(Error('渲染工作器退出')); else kill(); } });
  }
  return {
    scan(urls) {
      if (pending) return Promise.reject(Error('渲染工作器忙碌'));
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        pending = { id, resolve, reject, results: [], timer: setTimeout(() => finish(Error(`页面渲染超过${timeoutMs}ms，已隔离并重建工作器`)), timeoutMs) };
        try { if (!child) start(); child.send({ id, urls }, error => { if (error && pending?.id === id) finish(error); }); }
        catch (error) { finish(error); }
      });
    },
    close() { if (pending) finish(Error('渲染工作器停止')); else kill(); },
  };
}

export function createFrontendRenderMonitor({ store, client, now = Date.now, urls = RENDER_URLS, optionalUrls = [], stopped = () => false, wake = () => {}, log = () => {} }) {
  let running = false, closed = false, cursor = 0;
  const read = () => store.state._frontendRendered || { pages: {}, health: {} };
  const notice = (title, content, template = 'orange', url = 'https://four.meme') => ({ title, content, template, skipAi: true, moduleContext: 'Four.meme 前端渲染核验', url });
  async function poll(targets = urls) {
    if (running || closed || stopped() || !targets.length) return false;
    running = true;
    const startedAt = now();
    try {
      let results;
      try {
        const ordered = [...targets.slice(cursor % targets.length), ...targets.slice(0, cursor % targets.length)];
        cursor = (cursor + 2) % targets.length;
        results = await client.scan(ordered);
      }
      catch (error) { const partial = error.results || []; results = [...partial, ...targets.filter(url => !partial.some(r => r.url === url)).map(url => ({ url, error: error.message }))]; }
      if (closed || stopped()) return false;
      const byUrl = new Map((results || []).map(r => [r.url, r]));
      const notices = [];
      await store.transaction(async () => {
        const state = structuredClone(read());
        state.pages ||= {}; state.health ||= {};
        const changes = [], initialized = [], errors = [];
        for (const url of targets) {
          const result = byUrl.get(url);
          let old = state.pages[url];
          if (!result || result.error || !result.data) {
            const error = result?.error || '未收到页面结果';
            state.pages[url] = { ...old, lastAttemptAt: startedAt, lastError: error };
            errors.push(`${new URL(url).pathname}：${error}`); continue;
          }
          let data;
          try { data = normalizeRenderedDom(result.data, url); }
          catch (error) { state.pages[url] = { ...old, lastAttemptAt: startedAt, lastError: error.message }; errors.push(`${new URL(url).pathname}：${error.message}`); continue; }
          if (old?.signals && data.filterUnverified?.length) {
            const retained = old.signals.filter(signal => data.filterUnverified.some(column => isColumnFilterSignal(column, signal)));
            data.signals = [...new Set([...data.signals, ...retained])].sort();
            data.hash = signalHash(data.signals);
          }
          // Migrate only an observed valid page. A support widget appearing late
          // is not a launch feature; don't emit a removal for old widget labels.
          if (old?.signals?.some(transientSignal)) {
            const signals = old.signals.filter(s => !transientSignal(s));
            old = { ...old, signals, hash: signalHash(signals) };
          }
          if (old?.hash && data.advancedBoardVerified && !old.advancedBoardVerified) {
            // Older snapshots may have accepted the toolbar-only shell. Adopt
            // only the known controls present in this verified board silently.
            const known = advancedLegacyControls[new URL(url).pathname.split('/')[1]];
            const signals = [...new Set([...old.signals, ...data.signals.filter(signal => known?.has(signal))])].sort();
            old = { ...old, signals, hash: signalHash(signals), candidateHash: undefined };
          }
          if (old?.hash && data.captureVersion === 2 && old.captureVersion !== 2) {
            // Backfill only the newly observed profile dimensions. Existing
            // production signals and any real changes remain comparable.
            const signals = [...new Set([...old.signals, ...data.signals.filter(signal =>
              detailSignal.test(signal) || (data.kind === 'advanced' && signal === '按钮：Filters'))])].sort();
            old = { ...old, signals, hash: signalHash(signals), candidateHash: undefined };
          }
          if (old?.hash && old.filterUnverified?.length) {
            const uninitialized = old.filterUnverified.filter(column => !old.signals.some(signal => isColumnFilterSignal(column, signal)));
            const backfill = data.signals.filter(signal => uninitialized.some(column => isColumnFilterSignal(column, signal)));
            if (backfill.length) {
              const signals = [...new Set([...old.signals, ...backfill])].sort();
              old = { ...old, signals, hash: signalHash(signals), candidateHash: undefined };
            }
          }
          if (!old?.hash) {
            if (!optionalUrls.includes(url)) initialized.push(data);
          } else if (old.hash !== data.hash) {
            const added = data.signals.filter(x => !old.signals.includes(x));
            const removed = old.signals.filter(x => !data.signals.includes(x));
            // Removal/partial rendering needs consecutive confirmation. Pure
            // additions are useful immediately; failed scans reset candidates.
            if (removed.length && (old.candidateHash !== data.hash || old.lastError)) {
              state.pages[url] = { ...old, candidateHash: data.hash, lastAttemptAt: startedAt, lastSuccessAt: now(), lastError: '' }; continue;
            }
            changes.push({ url, added, removed, addedUrls: data.signalUrls, removedUrls: old.signalUrls });
          }
          state.pages[url] = { ...data, lastAttemptAt: startedAt, lastSuccessAt: now(), lastError: '' };
        }
        if (initialized.length) notices.push({
          ...notice('Four.meme 页面渲染覆盖已补齐', [
            cardStatus('healthy', `建立 ${initialized.length} 个页面基线`),
            '本卡记录首次基线，功能变更将在后续比较时报告。',
            ...initialized.map(p => {
              const path = new URL(p.url).pathname;
              const summary = p.signals.filter(s => /标题：|选项卡：|功能：|按钮：(?:鑄造|贖回|兌換|Mint|Redeem|Convert)/.test(s)).slice(0, 10);
              return `[${path}](${p.url}) · ${summary.join(' / ') || '导航与功能控件'}`;
            }),
            cardTime(now()),
          ].join('\n'), 'green'),
          cardOpts: { showDetailLink: false },
        });
        if (changes.length) {
          const { content, url } = formatRenderedChanges(changes);
          const template = changes.some(change => change.removed.length) ? 'orange' : 'green';
          notices.push({
            ...notice('Four.meme 页面可见功能变更', `${content}\n更新时间：${formatBeijingTime(now())}`, template, url),
            cardOpts: { showDetailLink: false },
          });
        }
        const health = state.health;
        // A partial scan must not declare unvisited failed pages recovered.
        errors.length = 0;
        for (const url of urls) if (state.pages[url]?.lastError || !state.pages[url]?.hash) errors.push(`${new URL(url).pathname}：${state.pages[url]?.lastError || '等待首次采集'}`);
        health.lastAttemptAt = startedAt; health.lastDurationMs = now() - startedAt;
        health.failedPages = errors.length; health.completePages = urls.length - errors.length;
        health.lastError = errors.join('；').slice(0, 2500);
        if (errors.length) {
          health.firstFailureAt ??= startedAt; health.healthySince = 0;
          if (now() - health.firstFailureAt >= 60000 && !health.alerted) {
            health.alerted = true;
            notices.push(notice('Four.meme 页面渲染核验异常', `${cardStatus('warning', `渲染核验异常 / 影响 ${errors.length} 页`)}\n${health.lastError}\n保留旧基线，静态抓取和渲染重试继续。\n${cardTime(now())}`, 'yellow'));
          }
        } else {
          health.lastSuccessAt = now(); health.firstFailureAt = null;
          if (health.alerted) {
            health.healthySince ||= now();
            if (now() - health.healthySince >= 30000) {
              health.alerted = false;
              notices.push(notice('Four.meme 页面渲染核验恢复', `${cardStatus('healthy', '核心页面已持续完整采集30秒')}\n继续比较旧基线。\n${cardTime(now())}`, 'green'));
            }
          }
        }
        store.state._frontendRendered = state;
        for (const n of notices) await store.enqueue(n);
      });
      for (const n of notices) log(`[前端渲染] ${n.title}`);
      wake();
      return true;
    } finally { running = false; }
  }
  return { poll, close: () => { closed = true; client.close(); }, summary: () => {
    const state = read();
    const pages = [...urls, ...optionalUrls].map(url => {
      const item = state.pages[url];
      return [url, { lastSuccessAt: item?.lastSuccessAt || 0, lastError: item?.lastError || '',
        initialized: !!item?.hash, ...(item?.filterUnverified?.length ? { filterUnverified: item.filterUnverified } : {}) }];
    });
    return { ...state.health, running, targetPages: urls.length, pages: Object.fromEntries(pages) };
  } };
}
