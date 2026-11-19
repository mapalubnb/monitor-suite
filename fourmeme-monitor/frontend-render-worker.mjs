import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
import { collectRenderedDom, normalizeRenderedDom, RENDER_URLS } from './frontend-render.mjs';

let server, browser, busy = false;
async function launch() {
  if (browser?.isConnected()) return;
  const executablePath = process.env.FOURMEME_CHROMIUM_PATH || ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'].find(existsSync);
  server = await chromium.launchServer({ executablePath, headless: true, host: '127.0.0.1', timeout: 12000,
    args: ['--disable-dev-shm-usage'], });
  process.send?.({ type: 'browser', pid: server.process().pid });
  browser = await chromium.connect(server.wsEndpoint(), { timeout: 5000 });
}

async function scan(urls, id) {
  if (urls.some(url => !RENDER_URLS.includes(url))) throw Error('拒绝非公开监控目标');
  await launch();
  const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  // Images/fonts/media are unnecessary for semantic DOM. Keep public API calls
  // used by the app, but never inject credentials or interact with transactions.
  await context.route('**/*', route => ['image', 'font', 'media'].includes(route.request().resourceType()) ? route.abort() : route.continue());
  const results = [], queue = [...urls];
  try {
    await Promise.all(Array.from({ length: 2 }, async () => {
      while (queue.length) {
        const url = queue.shift();
        const page = await context.newPage();
        try {
          const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 8000 });
          if (!response?.ok()) throw Error(`页面HTTP ${response?.status() || 0}`);
          const deadline = Date.now() + 4000;
          let data, error;
          do {
            data = await page.evaluate(collectRenderedDom);
            try { normalizeRenderedDom(data, url); error = null; break; } catch (e) { error = e; }
            await new Promise(resolve => setTimeout(resolve, 200));
          } while (Date.now() < deadline);
          if (error) throw error;
          results.push({ url, data });
        } catch (error) { results.push({ url, error: error.message.split('\n')[0].slice(0, 300) }); }
        finally {
          const result = results.find(r => r.url === url);
          if (result) process.send?.({ id, type: 'page', result });
          await page.close();
        }
      }
    }));
    return results;
  } finally { await context.close(); }
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
