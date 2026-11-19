import { createHash } from 'node:crypto';
import { fork, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { formatBeijingTime } from '../shared/display-format.cjs';

export const RENDER_URLS = ['zh-TW', 'en'].flatMap(locale =>
  ['create-token', 'advanced', '4stock', ''].map(path => `https://four.meme/${locale}${path ? '/' + path : ''}`));

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
export function collectRenderedDom() {
  const visible = el => !!el && !el.closest('[hidden],[aria-hidden="true"]')
    && (typeof el.getClientRects !== 'function' || el.getClientRects().length > 0);
  const text = el => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  const main = document.querySelector('main');
  const read = selector => [...(main?.querySelectorAll(selector) || [])].filter(visible);
  return {
    url: location.href,
    mainText: main ? text(main).slice(0, 20000) : '',
    headings: read('h1,h2,h3,h4').map(text),
    tabs: read('[role="tab"]').map(text),
    labels: read('label,legend,p').map(text),
    buttons: read('button').map(text),
    fields: read('input:not([type="hidden"]),textarea,select,[role="combobox"]').map(el =>
      [el.tagName.toLowerCase(), el.getAttribute('type') || '', el.getAttribute('aria-label') || el.getAttribute('placeholder') || ''].join('|')),
    navigation: [...document.querySelectorAll('nav a[href]')].filter(visible).map(el => ({ text: text(el), href: el.getAttribute('href') })),
    switches: read('[role="switch"],input[type="checkbox"]').length,
  };
}

function stableLabel(value) {
  const s = String(value || '').replace(/\s+/g, ' ').trim();
  // Market/asset buttons contain ticker amounts, percentages or prices. A
  // number-only normalization would still leak changing ticker inventories.
  if (!s || /(?:0x[a-f\d]{4}|\$|\d|錢包|Wallet|Orders|訂單|Loading|載入|Connect Wallet|連接錢包|登入|Log.?in)/i.test(s)) return '';
  return s.slice(0, 200);
}

export function normalizeRenderedDom(raw, url) {
  const requested = new URL(url);
  const actual = new URL(raw.url || url);
  if (requested.origin !== 'https://four.meme' || actual.origin !== requested.origin || actual.pathname.replace(/\/$/, '') !== requested.pathname.replace(/\/$/, '')) throw Error('渲染页面发生非预期跳转');
  if (!raw.mainText || /(?:verify you are human|access denied|current location.*restricted|captcha)/i.test(raw.mainText)) throw Error('渲染页面未就绪或被源站拦截');
  const type = /\/create-token$/.test(requested.pathname) ? 'create' : /\/4stock$/.test(requested.pathname) ? 'stock' : /\/advanced$/.test(requested.pathname) ? 'advanced' : 'home';
  if (type === 'create' && (raw.fields?.length < 3 || !raw.headings?.length || raw.switches < 1)) throw Error('创建表单未完整渲染，保留旧基线');
  if (type === 'stock' && !(raw.buttons?.some(x => /鑄造|Mint/i.test(x)) && raw.buttons?.some(x => /贖回|Redeem/i.test(x)) && raw.fields?.length >= 1)) throw Error('4Stock核心控件未完整渲染，保留旧基线');
  if (['home', 'advanced'].includes(type) && (raw.navigation?.length < 4 || !raw.buttons?.length || /^(?:Loading|載入中)[.\s…]*$/i.test(raw.mainText))) throw Error('页面核心区域未完整渲染，保留旧基线');
  if (type === 'home' && !raw.fields?.some(s => /搜尋|Search/i.test(s))) throw Error('首页搜索与列表控件尚未渲染，保留旧基线');
  if (type === 'advanced' && !raw.fields?.length) throw Error('Advanced核心控件尚未渲染，保留旧基线');
  const signals = [];
  for (const [key, label] of [['headings', '标题'], ['tabs', '选项卡'], ['labels', '字段']]) {
    if (key === 'labels' && !['create', 'stock'].includes(type)) continue;
    for (const v of raw[key] || []) { const s = stableLabel(v); if (s) signals.push(`${label}：${s}`); }
  }
  // Only stable functional buttons, not token cards or dynamic market filters.
  const buttons = type === 'create' || type === 'stock' ? raw.buttons || [] : (raw.buttons || []).filter(x => /^(?:搜尋|Search|篩選|Filter|Refresh token list|Clear|全部代幣|普通代幣|Tax 代幣|Open Four|All Tokens|Normal Tokens|Tax Tokens)$/i.test(x));
  for (const v of buttons) { const s = stableLabel(v); if (s) signals.push(`按钮：${s}`); }
  for (const v of raw.fields || []) { if (!/搜尋更多.*(?:MEME|RWA)|Search more/i.test(v)) signals.push(`输入框：${v.slice(0, 180)}`); }
  if (type === 'create') {
    signals.push(`开关数量：${raw.switches}`);
    for (const label of ['CRYPTO', 'MEME', 'RWA', 'PREIPO', '反狙擊', '啟用稅收', 'Anti-sniper', 'Enable Tax']) {
      if (raw.mainText.includes(label)) signals.push(`功能：${label}`);
    }
  }
  for (const link of raw.navigation || []) {
    try {
      const u = new URL(link.href, requested);
      if (u.origin === requested.origin && !isInfrastructureRoute(u.pathname) && !/\/(?:token|contract)\/[^/]+/.test(u.pathname)) signals.push(`导航：${link.text.slice(0, 80)} → ${u.pathname}`);
    } catch {}
  }
  const normalized = [...new Set(signals)].sort();
  if (normalized.length < 5) throw Error('渲染结构信息不足，保留旧基线');
  return { url, signals: normalized, hash: createHash('sha256').update(JSON.stringify(normalized)).digest('hex'), kind: type };
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

export function createFrontendRenderMonitor({ store, client, now = Date.now, urls = RENDER_URLS, stopped = () => false, wake = () => {}, log = () => {} }) {
  let running = false, closed = false, cursor = 0;
  const read = () => store.state._frontendRendered || { pages: {}, health: {} };
  const notice = (title, content, template = 'orange') => ({ title, content, template, skipAi: true, moduleContext: 'Four.meme 前端渲染核验', url: 'https://four.meme' });
  async function poll() {
    if (running || closed || stopped()) return false;
    running = true;
    const startedAt = now();
    try {
      let results;
      try {
        const ordered = [...urls.slice(cursor), ...urls.slice(0, cursor)];
        cursor = (cursor + 2) % urls.length;
        results = await client.scan(ordered);
      }
      catch (error) { const partial = error.results || []; results = [...partial, ...urls.filter(url => !partial.some(r => r.url === url)).map(url => ({ url, error: error.message }))]; }
      if (closed || stopped()) return false;
      const byUrl = new Map((results || []).map(r => [r.url, r]));
      const notices = [];
      await store.transaction(async () => {
        const state = structuredClone(read());
        state.pages ||= {}; state.health ||= {};
        const changes = [], initialized = [], errors = [];
        for (const url of urls) {
          const result = byUrl.get(url);
          const old = state.pages[url];
          if (!result || result.error || !result.data) {
            const error = result?.error || '未收到页面结果';
            state.pages[url] = { ...old, lastAttemptAt: startedAt, lastError: error };
            errors.push(`${new URL(url).pathname}：${error}`); continue;
          }
          let data;
          try { data = normalizeRenderedDom(result.data, url); }
          catch (error) { state.pages[url] = { ...old, lastAttemptAt: startedAt, lastError: error.message }; errors.push(`${new URL(url).pathname}：${error.message}`); continue; }
          if (!old?.hash) initialized.push(data);
          else if (old.hash !== data.hash) {
            const added = data.signals.filter(x => !old.signals.includes(x));
            const removed = old.signals.filter(x => !data.signals.includes(x));
            // Removal/partial rendering needs consecutive confirmation. Pure
            // additions are useful immediately; failed scans reset candidates.
            if (removed.length && (old.candidateHash !== data.hash || old.lastError)) {
              state.pages[url] = { ...old, candidateHash: data.hash, lastAttemptAt: startedAt, lastSuccessAt: now(), lastError: '' }; continue;
            }
            changes.push({ url, added, removed });
          }
          state.pages[url] = { ...data, lastAttemptAt: startedAt, lastSuccessAt: now(), lastError: '' };
        }
        if (initialized.length) notices.push(notice('Four.meme 页面渲染覆盖已补齐', `首次建立以下页面的渲染基线（不代表这些功能刚刚上线）：\n${initialized.map(p => `${new URL(p.url).pathname}：${p.signals.filter(s => /标题：|选项卡：|功能：|按钮：(?:鑄造|贖回|兌換|Mint|Redeem|Convert)/.test(s)).slice(0, 10).join('；') || '导航与功能控件'}`).join('\n')}\n时间：${formatBeijingTime(now())}`));
        if (changes.length) notices.push(notice('Four.meme 页面可见功能变更', changes.map(c => `[${new URL(c.url).pathname}](${c.url})\n${c.added.length ? '新增：\n' + c.added.map(x => '＋ ' + x).join('\n') : ''}\n${c.removed.length ? '移除（连续两次确认）：\n' + c.removed.map(x => '－ ' + x).join('\n') : ''}`).join('\n\n') + `\n时间：${formatBeijingTime(now())}`));
        const health = state.health;
        health.lastAttemptAt = startedAt; health.lastDurationMs = now() - startedAt;
        health.failedPages = errors.length; health.completePages = urls.length - errors.length;
        health.lastError = errors.join('；').slice(0, 2500);
        if (errors.length) {
          health.firstFailureAt ??= startedAt; health.healthySince = 0;
          if (now() - health.firstFailureAt >= 60000 && !health.alerted) {
            health.alerted = true;
            notices.push(notice('Four.meme 页面渲染核验异常', `${health.lastError}\n旧有效基线保留；静态抓取继续，渲染工作器按原调度重试。`, 'yellow'));
          }
        } else {
          health.lastSuccessAt = now(); health.firstFailureAt = null;
          if (health.alerted) {
            health.healthySince ||= now();
            if (now() - health.healthySince >= 30000) { health.alerted = false; notices.push(notice('Four.meme 页面渲染核验恢复', '核心页面已持续完整采集30秒，继续比较旧基线。', 'green')); }
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
  return { poll, close: () => { closed = true; client.close(); }, summary: () => ({ ...read().health, running, targetPages: urls.length, pages: Object.fromEntries(urls.map(url => [url, { lastSuccessAt: read().pages[url]?.lastSuccessAt || 0, lastError: read().pages[url]?.lastError || '', initialized: !!read().pages[url]?.hash }])) }) };
}
