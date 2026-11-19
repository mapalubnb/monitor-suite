import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
import { setPriority } from 'node:os';
import { ADVANCED_FILTER, ADVANCED_PANEL, CREATE_OPEN_MODE, collectRenderedDom, normalizeRenderedDom, PUBLIC_RENDER_URLS, RENDER_URLS } from './frontend-render.mjs';

let server, browser, context, page, busy = false;
// Lower priority only for this worker and its subsequently spawned browser.
try { setPriority(0, 5); } catch {}
async function launch() {
  if (browser?.isConnected()) return;
  const executablePath = process.env.FOURMEME_CHROMIUM_PATH || ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'].find(existsSync);
  server = await chromium.launchServer({ executablePath, headless: true, host: '127.0.0.1', timeout: 20000,
    args: ['--disable-dev-shm-usage', '--blink-settings=imagesEnabled=false'], });
  process.send?.({ type: 'browser', pid: server.process().pid });
  browser = await chromium.connect(server.wsEndpoint(), { timeout: 5000 });
  context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
}

async function readInteractiveDetails(page, data, url, deadline) {
  const timeLeft = () => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw Error('公开控件核验超过页面时限');
    return { timeout: remaining };
  };
  if (/\/create-token$/.test(url) && data.tabs.some(name => CREATE_OPEN_MODE.test(name))) {
    const tab = page.locator('main').getByRole('tab', { name: CREATE_OPEN_MODE });
    await tab.dispatchEvent('click', {}, timeLeft());
    await tab.and(page.locator('[aria-selected="true"]')).waitFor(timeLeft());
    const openMode = await page.evaluate(collectRenderedDom);
    if (!CREATE_OPEN_MODE.test(openMode.selectedTab) || openMode.detailFields.length < 3 || !openMode.headings.length) {
      throw Error('创建页开放模式尚未完整渲染');
    }
    const { selectedTab, headings, tabs, labels, buttons, detailFields, switches } = openMode;
    data.openMode = { selectedTab, headings, tabs, labels, buttons, detailFields, switches };
  }
  if (/\/advanced$/.test(url)) {
    const panels = page.locator(`${ADVANCED_PANEL}:visible`);
    for (const [index, column] of data.columns.entries()) {
      if (!column.controls.some(name => ADVANCED_FILTER.test(name))) continue;
      const filter = panels.nth(index).getByRole('button', { name: ADVANCED_FILTER });
      // The column can be outside the horizontal viewport. Only open the
      // verified filters popover, without altering its settings or inputs.
      await filter.dispatchEvent('click', {}, timeLeft());
      const open = filter.and(page.locator('[aria-expanded="true"]'));
      await open.waitFor(timeLeft());
      const filterId = await open.getAttribute('aria-controls', timeLeft());
      column.filter = await page.evaluate(collectRenderedDom, { layer: 'filter', filterId });
      if (!column.filter) throw Error(`Advanced 筛选面板未完成渲染：${column.label}`);
      await open.dispatchEvent('click', {}, timeLeft());
      await filter.and(page.locator('[aria-expanded="false"]')).waitFor(timeLeft());
    }
    const verified = await page.evaluate(collectRenderedDom, { layer: 'columns' });
    if (data.columns.map(column => column.label).join('\n') !== verified.join('\n')) throw Error('Advanced 市场栏目仍在加载');
  }
  data.captureVersion = 2;
}

async function scan(urls, id) {
  if (urls.some(url => !RENDER_URLS.includes(url) && !PUBLIC_RENDER_URLS.includes(url))) throw Error('拒绝非公开监控目标');
  await launch();
  // Reuse only this worker's anonymous context and normal HTTP cache. Routing
  // every request disables Chromium's cache and repeatedly cold-loads ~50 JS
  // chunks/page. HTML/API freshness remains controlled by the origin.
  const results = [], queue = [...urls];
  while (queue.length) {
    const url = queue.shift();
    if (!page || page.isClosed()) page = await context.newPage();
    try {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 8000 });
      if (!response?.ok()) throw Error(`页面HTTP ${response?.status() || 0}`);
      const deadline = Date.now() + 10000;
      let data, error;
      do {
        data = await page.evaluate(collectRenderedDom);
        try { normalizeRenderedDom(data, url); error = null; break; } catch (e) { error = e; }
        await new Promise(resolve => setTimeout(resolve, 200));
      } while (Date.now() < deadline);
      if (error) throw error;
      await readInteractiveDetails(page, data, url, deadline);
      results.push({ url, data });
    } catch (error) { results.push({ url, error: error.message.split('\n')[0].slice(0, 300) }); }
    finally {
      const result = results.find(r => r.url === url);
      if (result) process.send?.({ id, type: 'page', result });
      // Stop market timers/WebSockets between jobs without discarding HTTP cache.
      await page.goto('about:blank', { timeout: 2000 }).catch(async () => { await page.close().catch(() => {}); });
    }
  }
  return results;
}

process.on('message', async ({ id, urls }) => {
  if (busy) { process.send?.({ id, error: '渲染工作器忙碌' }); return; }
  busy = true;
  try { process.send?.({ id, results: await scan(urls, id) }); }
  catch (error) { process.send?.({ id, error: error.message.split('\n')[0].slice(0, 300) }); }
  finally { busy = false; }
});
const close = async () => { try { await server?.close(); } finally { process.exit(0); } };
process.on('disconnect', close);
process.on('SIGTERM', close);
