#!/usr/bin/env node
/**
 * Read page HTML from a user-verified Chrome session via CDP.
 *
 * This helper does not solve or click Cloudflare challenges. Start Chrome with
 * a persistent profile, pass Cloudflare manually once, then let the monitor
 * reuse that browser session for read-only page HTML capture.
 */

const targetUrl = process.argv.at(-1);
if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) {
  console.error("Usage: node browser-session-fetch.mjs <url>");
  process.exit(2);
}

const cdpBase = process.env.FOURMEME_BROWSER_CDP_URL || "http://127.0.0.1:9222";
const timeoutMs = Number.parseInt(process.env.FOURMEME_BROWSER_FETCH_TIMEOUT_MS || "20000", 10);
const waitMs = Number.parseInt(process.env.FOURMEME_BROWSER_FETCH_WAIT_MS || "3500", 10);
const includeAssets = !["0", "false", "no", "off"].includes(String(process.env.FOURMEME_BROWSER_FETCH_ASSETS || "true").toLowerCase());
const maxAssets = Number.parseInt(process.env.FOURMEME_BROWSER_FETCH_MAX_ASSETS || "80", 10);
const maxAssetBytes = Number.parseInt(process.env.FOURMEME_BROWSER_FETCH_MAX_ASSET_BYTES || "1000000", 10);
const challengeRe = /cloudflare|cf-ray|cf-chl|challenge-platform|checking your browser|verify you are human|just a moment|turnstile|captcha/i;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchJson(url, opts = {}) {
  let res;
  try {
    res = await fetch(url, opts);
  } catch {
    throw new Error(`无法连接 Chrome DevTools：${url}（请确认 Chrome 已用 --remote-debugging-port 启动）`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}: ${url}`);
  return res.json();
}

async function send(ws, id, method, params = {}) {
  ws.send(JSON.stringify({ id, method, params }));
}

async function main() {
  const version = await fetchJson(`${cdpBase.replace(/\/+$/, "")}/json/version`);
  const wsUrl = version.webSocketDebuggerUrl;
  if (!wsUrl) throw new Error("Chrome DevTools endpoint missing webSocketDebuggerUrl");

  const WebSocket = (await import("ws")).default;
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  const deadline = Date.now() + timeoutMs;

  ws.on("message", raw => {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (!msg.id || !pending.has(msg.id)) return;
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
    else resolve(msg.result);
  });

  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
    setTimeout(() => reject(new Error("CDP WebSocket connect timeout")), timeoutMs).unref?.();
  });

  function call(method, params = {}, sessionId = undefined) {
    const id = nextId++;
    const wait = Math.max(1000, deadline - Date.now());
    const promise = new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`CDP command timeout: ${method}`));
      }, wait).unref?.();
    });
    ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    return promise;
  }

  try {
    const { targetId } = await call("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await call("Target.attachToTarget", { targetId, flatten: true });
    const scoped = (method, params = {}) => call(method, params, sessionId);

    await scoped("Page.enable");
    await scoped("Runtime.enable");
    await scoped("Page.navigate", { url: targetUrl });
    await sleep(waitMs);

    const expression = `
      (async () => {
        const html = document.documentElement.outerHTML || "";
        const result = { html, assets: {} };
        if (!${JSON.stringify(includeAssets)}) return JSON.stringify(result);
        const rawUrls = [
          ...Array.from(document.querySelectorAll("script[src]"), el => el.src),
          ...Array.from(document.querySelectorAll("link[rel='stylesheet'][href]"), el => el.href),
        ];
        const urls = Array.from(new Set(rawUrls))
          .filter(url => /\\/_next\\/static\\/.+\\.(?:js|css)(?:\\?|$)/i.test(url))
          .slice(0, ${JSON.stringify(Math.max(1, maxAssets))});
        for (const url of urls) {
          try {
            const response = await fetch(url, { credentials: "include", cache: "no-cache" });
            if (!response.ok) continue;
            let content = await response.text();
            const truncated = content.length > ${JSON.stringify(Math.max(1000, maxAssetBytes))};
            if (truncated) content = content.slice(0, ${JSON.stringify(Math.max(1000, maxAssetBytes))});
            const path = new URL(url, location.href).pathname;
            result.assets[path] = { url, content, truncated };
          } catch {}
        }
        return JSON.stringify(result);
      })()
    `;

    const evaluated = await scoped("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    const payloadText = evaluated?.result?.value || "";
    let payload;
    try {
      payload = JSON.parse(payloadText);
    } catch {
      payload = { html: payloadText, assets: {} };
    }
    const html = payload.html || "";
    await call("Target.closeTarget", { targetId }).catch(() => {});

    if (challengeRe.test(html)) {
      console.error("Current browser session is still on Cloudflare challenge; pass it manually first.");
      process.exit(3);
    }
    process.stdout.write(JSON.stringify(payload));
  } finally {
    try { ws.close(); } catch {}
  }
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
