/**
 * Four.meme 全面监控脚本 v2 — 高频并行版
 *
 * 优化要点：
 *   1. 各模块独立定时器，互不阻塞
 *   2. BSC RPC batch 请求（模块 6/7 提速 ~10x）
 *   3. 前端/API 并行抓取（模块 2/3/5 提速 ~3-4x）
 *   4. 全面反风控：UA 轮换、按域名自适应退避、请求抖动、GitHub 条件请求
 *
 * 模块与频率：
 *   模块1: 底池配置   — 每 3s（纯 API，轻量，退避保护）
 *   模块2: 前端代码   — 每 15s（基础页面 + 自动发现页面，含文案 diff、__NEXT_DATA__、i18n、路由/端点发现）
 *   模块3/5: API 结构  — 每 30s（多端点并行，含结构+值 diff）
 *   模块4: GitHub     — 每 5min（条件请求，自带 ETag 缓存）
 *   模块6: 智能合约   — 每 3s（RPC batch，单次请求）
 *   模块7: 链上参数   — 每 3s（RPC batch，单次请求）
 *   模块8: 创建者动作 — 每 3s（扫新区块，只监听创建者/手动配置地址发起的交易）
 *
 * 用法：node monitor.mjs
 * 信号：kill -USR1 <PID>  立即触发全量检测
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, appendFileSync, renameSync, mkdirSync, readdirSync, unlinkSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { sendCard, sendCardQueued, sendHeartbeatQueued, patchCard, waitQueueDrain } from "../shared/feishu-client.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// 加载共享 .env + 本地 .env（兼容统一部署和独立部署）
for (const envPath of [join(__dirname, "..", ".env"), join(__dirname, ".env")]) {
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf-8").split("\n")) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

/* ══════════════════════════════════════════
   配置
   ══════════════════════════════════════════ */

function parseEnvAddressList(value) {
  return String(value || "")
    .split(/[,\s]+/)
    .map(v => v.trim().toLowerCase())
    .filter(v => /^0x[a-f0-9]{40}$/.test(v));
}

function readPositiveIntEnv(name, fallback) {
  const n = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function readBoolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  return !["0", "false", "no", "off"].includes(String(raw).trim().toLowerCase());
}

const CONFIG = {
  // Four.meme
  apiBase: "https://four.meme/meme-api",
  siteUrl: "https://four.meme",
  monitorUrls: [
    "https://four.meme/zh-TW/create-token",
    "https://four.meme/zh-TW/agentic",
    "https://four.meme/zh-TW/contract",
    "https://four.meme/zh-TW/contract/collection",
    "https://four.meme/zh-TW/contract/create",
    "https://four.meme/zh-TW/contract/profile",
    "https://four.meme/zh-TW/announcement",
    "https://four.meme/en/contract",
    "https://four.meme/en/contract/collection",
    "https://four.meme/en/contract/create",
    "https://four.meme/en/contract/profile",
  ],
  networkCode: "BSC",

  // GitHub 仓库监控
  githubOwner: "four-meme-community",
  githubRepo: "four-meme-community/four-meme-ai",
  githubApiBranch: "main",
  githubToken: process.env.GITHUB_TOKEN || "",  // 可选：填入 PAT 提升 rate limit 至 5000/h

  // 飞书 API（SDK 统一发送，只需 App 凭证 + Chat ID）
  feishuAppId: process.env.FEISHU_APP_ID || "",
  feishuAppSecret: process.env.FEISHU_APP_SECRET || "",
  feishuChatId: process.env.FEISHU_CHAT_ID || "",

  // ── 各模块独立间隔（毫秒）──
  intervals: {
    pool:     3_000,   // 模块1: 底池配置（3s，退避机制自动保护源站）
    frontend: 15_000,  // 模块2: 前端代码（15s，assetHash 缓存避免无变化时重复下载）
    api:      30_000,  // 模块3/5: API 结构（30s，降低同域并发压力）
    github:   300_000, // 模块4: GitHub（5min，未认证限额 60/h）
    contract: 3_000,   // 模块6: 智能合约
    onchain:  3_000,   // 模块7: 链上参数
    actor:    3_000,   // 模块8: 合约创建者动作
  },

  // 心跳推送开关；默认关闭，只影响周期性状态心跳，不影响变更/异常告警
  heartbeatEnabled: process.env.HEARTBEAT_ENABLED === "true",
  // 心跳间隔（毫秒）— 支持环境变量 HEARTBEAT_MINUTES 覆盖（单位：分钟）
  heartbeatMs: process.env.HEARTBEAT_MINUTES
    ? parseInt(process.env.HEARTBEAT_MINUTES, 10) * 60_000
    : 14_400_000, // 默认 240 分钟（4 小时）

  // 日报配置 — DAILY_REPORT=true 开启，DAILY_REPORT_HOUR 设置发送时间（0-23，默认 9 点）
  dailyReport: {
    enabled: process.env.DAILY_REPORT === "true",
    hour: parseInt(process.env.DAILY_REPORT_HOUR || "9", 10),
  },

  // 快照文件
  snapshotFile: join(__dirname, "snapshot.json"),

  // ── 反风控 ──
  // 每次请求随机抖动范围（毫秒），叠加到间隔上
  jitterMs: 1_000,
  // 默认 HTTP 超时
  defaultTimeoutMs: 10_000,
  // 退避：初始、最大、衰减因子
  backoff: {
    initialMs: 30_000,
    maxMs: 300_000,
    decayFactor: 0.5,  // 成功后退避时间 ×0.5
  },
  frontendAssetJitter: {
    maxFiles: 2,        // 少量 chunk 单独消失/恢复通常是 CDN/SSR 抖动
    quickConfirmDelayMs: 2_500, // 同轮快速复抓确认，避免真实变更等到下一轮
  },
  frontendDiscovery: {
    enabled: true,
    locale: "zh-TW",
    maxDiscoveredPages: 20,
    excludeRoutes: [
      /^\/(?:api|meme-api|mapi|v\d+)\//i,
      /^\/docs\//i,
      /^\/a\/i$/i,
      /^\/v\d+\/resolve-ens$/i,
    ],
  },
  apiProbeStaggerMs: 350,

  // ── BSC RPC ──
  bscRpcUrls: [
    "https://bsc.publicnode.com",
    "https://bsc-dataseed.binance.org/",
    "https://bsc-dataseed1.defibit.io/",
    "https://bsc-dataseed2.defibit.io/",
  ],
  contracts: {
    tokenManagerV1:  "0xEC4549caDcE5DA21Df6E6422d448034B5233bFbC",
    tokenManagerV2:  "0x5c952063c7fc8610FFDB798152D69F0B9550762b",
    helper3BSC:      "0xF251F83e40a78868FcfA3FA4599Dad6494E46034",
    agentIdentifier: "0x09B44A633de9F9EBF6FB9Bdd5b5629d3DD2cef13",
    openFourRegistry:"0x912cef0c3ae9ab6eb3ec87cab69371cfb317ab94",
  },
  helper3Cross: {
    ArbitrumOne: "0x02287dc3CcA964a025DAaB1111135A46C10D3A57",
    Base:        "0x1172FABbAc4Fe05f5a5Cebd8EBBC593A76c42399",
  },
  apiProbeEndpoints: [
    {
      key: "public_config",
      label: "/v1/public/config",
      url: "https://four.meme/meme-api/v1/public/config",
      method: "GET",
    },
    {
      key: "public_address",
      label: "/v1/public/address",
      url: "https://four.meme/meme-api/v1/public/address",
      method: "GET",
    },
    {
      key: "public_file_host",
      label: "/v1/public/file/host",
      url: "https://four.meme/meme-api/v1/public/file/host",
      method: "GET",
    },
    {
      key: "kol_teams",
      label: "/v1/public/kol/teams",
      url: "https://four.meme/meme-api/v1/public/kol/teams?tcs=fm25",
      method: "GET",
      sampleArrayItems: 2,
    },
    {
      key: "kol_traders",
      label: "/v1/public/kol/traders",
      url: "https://four.meme/meme-api/v1/public/kol/traders?tcs=fm25",
      method: "GET",
      sampleArrayItems: 1,
    },
    {
      key: "token_ranking_cap",
      label: "/v1/public/token/ranking CAP",
      url: "https://four.meme/meme-api/v1/public/token/ranking",
      method: "POST",
      body: { type: "CAP" },
    },
    {
      key: "token_ranking_binance",
      label: "/v1/public/token/ranking BINANCE",
      url: "https://four.meme/meme-api/v1/public/token/ranking",
      method: "POST",
      body: { rankingKind: "BINANCE", type: "VOL" },
    },
    {
      key: "token_search_new",
      label: "/v1/public/token/search NEW",
      url: "https://four.meme/meme-api/v1/public/token/search",
      method: "POST",
      body: { pageIndex: 1, pageSize: 20, type: "NEW" },
      sampleArrayItems: 10,
    },
    {
      key: "token_search_cap",
      label: "/v1/public/token/search CAP",
      url: "https://four.meme/meme-api/v1/public/token/search",
      method: "POST",
      body: { pageIndex: 1, pageSize: 20, type: "CAP", sort: "DESC", keyword: "BNB" },
      sampleArrayItems: 10,
    },
  ],
  eip1967Slot: "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
  eip1967AdminSlot: "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103",
  actorMonitor: {
    enabled: process.env.FOURMEME_ACTOR_MONITOR !== "false",
    confirmations: readPositiveIntEnv("FOURMEME_ACTOR_CONFIRMATIONS", 2),
    maxBlocksPerRun: readPositiveIntEnv("FOURMEME_ACTOR_MAX_BLOCKS", 8),
    bootstrapLookbackBlocks: readPositiveIntEnv("FOURMEME_ACTOR_BOOTSTRAP_BLOCKS", 6),
    extraActors: parseEnvAddressList(`${process.env.FOURMEME_WATCH_ACTORS || ""},${process.env.FOURMEME_WATCH_CREATORS || ""}`),
    creatorChainLookupEnabled: readBoolEnv("FOURMEME_CREATOR_CHAIN_LOOKUP", true),
    creatorChainLookbackBlocks: readPositiveIntEnv("FOURMEME_CREATOR_CHAIN_LOOKBACK_BLOCKS", 30000),
    creatorChainMaxBlocksPerRun: readPositiveIntEnv("FOURMEME_CREATOR_CHAIN_MAX_BLOCKS_PER_RUN", 120),
    creatorPageLookupEnabled: readBoolEnv("FOURMEME_CREATOR_PAGE_LOOKUP", true),
    creatorPageMaxPerRun: readPositiveIntEnv("FOURMEME_CREATOR_PAGE_MAX_PER_RUN", 8),
    creatorLookupCooldownMs: readPositiveIntEnv("FOURMEME_CREATOR_LOOKUP_COOLDOWN_MINUTES", 30) * 60_000,
    creatorLookupEnabled: process.env.FOURMEME_CREATOR_LOOKUP === "true",
    explorerApiKey: process.env.ETHERSCAN_V2_API_KEY || process.env.ETHERSCAN_API_KEY || process.env.BSCSCAN_API_KEY || "",
    explorerApiBase: process.env.ETHERSCAN_API_BASE || "https://api.etherscan.io/v2/api",
    explorerPageBase: (process.env.BSCSCAN_WEB_BASE || "https://bscscan.com").replace(/\/+$/, ""),
  },
};

/* ══════════════════════════════════════════
   反风控基础设施
   ══════════════════════════════════════════ */

// --- UA 轮换池 ---
const UA_POOL = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:126.0) Gecko/20100101 Firefox/126.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 Edg/123.0.0.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
];
let uaIndex = 0;
function nextUA() {
  const ua = UA_POOL[uaIndex];
  uaIndex = (uaIndex + 1) % UA_POOL.length;
  return ua;
}

function browserHeaders() {
  return {
    "User-Agent": nextUA(),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
  };
}

// --- Per-domain 自适应退避 ---
const domainBackoff = new Map(); // domain -> { delayMs, lastFail }

function getDomain(url) {
  try { return new URL(url).hostname; } catch { return url; }
}

function shouldBackoff(domain) {
  const b = domainBackoff.get(domain);
  if (!b) return false;
  return Date.now() - b.lastFail < b.delayMs;
}

function recordFail(domain, statusCode) {
  const b = domainBackoff.get(domain) || { delayMs: 0, lastFail: 0 };
  if (statusCode === 429 || statusCode === 403) {
    b.delayMs = Math.min(
      Math.max(b.delayMs * 2, CONFIG.backoff.initialMs),
      CONFIG.backoff.maxMs
    );
  } else {
    b.delayMs = Math.min(b.delayMs + 5_000, CONFIG.backoff.maxMs);
  }
  b.lastFail = Date.now();
  domainBackoff.set(domain, b);
  log(`[退避] ${domain} → ${(b.delayMs / 1000).toFixed(0)}s`);
}

function recordSuccess(domain) {
  const b = domainBackoff.get(domain);
  if (!b || b.delayMs === 0) return;
  b.delayMs = Math.floor(b.delayMs * CONFIG.backoff.decayFactor);
  if (b.delayMs < 2_000) {
    domainBackoff.delete(domain);
  } else {
    domainBackoff.set(domain, b);
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/* ══════════════════════════════════════════
   工具函数
   ══════════════════════════════════════════ */
const ts = () => new Date().toLocaleString("zh-CN", { hour12: false });
const log = (msg) => console.log(`[${ts()}] ${msg}`);
const md5 = (str) => createHash("md5").update(str).digest("hex");
const jsonEqual = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/* ── 快照读写（带异步互斥锁防并发读写冲突）── */
const CURRENT_SCHEMA_VERSION = 6;
let snapshotWriteQueue = Promise.resolve();

const REMOVED_FRONTEND_URLS = new Set([
  "https://four.meme",
  "https://four.meme/en",
  "https://four.meme/zh-TW",
  "https://four.meme/en/ranking",
  "https://four.meme/zh-TW/ranking",
  "https://four.meme/zh-TW/create-token?entry=X-mode",
  "https://four.meme/zh-TW/ja",
  "https://four.meme/zh-TW/vi",
].map(canonicalFrontendUrl));

/**
 * 简易异步互斥锁：保护 snapshot 的 read-mutate-save 周期，
 * 防止多个并发模块在 await 间隙互相覆盖数据。
 */
const snapshotMutex = {
  _locked: false,
  _queue: [],
  async acquire() {
    if (!this._locked) {
      this._locked = true;
      return;
    }
    await new Promise(resolve => this._queue.push(resolve));
  },
  release() {
    if (this._queue.length > 0) {
      this._queue.shift()();
    } else {
      this._locked = false;
    }
  },
};

function loadSnapshot() {
  try {
    if (existsSync(CONFIG.snapshotFile)) {
      const data = JSON.parse(readFileSync(CONFIG.snapshotFile, "utf-8"));
      return migrateSnapshot(data);
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * 快照版本迁移：确保旧快照兼容新代码
 */
function pruneFrontendSnapshot(data) {
  if (!data || !data.frontendPages) return false;

  let changed = false;
  const monitorUrls = new Set(CONFIG.monitorUrls.map(canonicalFrontendUrl));
  const discoveredUrls = (Array.isArray(data._frontendDiscoveredUrls) ? data._frontendDiscoveredUrls : [])
    .map(canonicalFrontendUrl)
    .filter(url => isDiscoverableFrontendUrl(url));
  const allowedUrls = new Set([...monitorUrls, ...discoveredUrls]);

  if (discoveredUrls.length !== (data._frontendDiscoveredUrls || []).length) {
    data._frontendDiscoveredUrls = discoveredUrls;
    changed = true;
  }

  for (const [key, page] of Object.entries(data.frontendPages)) {
    const canonical = page?.originalUrl ? canonicalFrontendUrl(page.originalUrl) : "";
    if (!canonical || REMOVED_FRONTEND_URLS.has(canonical) || isDynamicFrontendRoute(canonical) || !allowedUrls.has(canonical)) {
      delete data.frontendPages[key];
      if (data._frontendFailCounts) delete data._frontendFailCounts[key];
      changed = true;
    }
  }

  return changed;
}

function migrateSnapshot(data) {
  const ver = data._schemaVersion || 1;
  if (ver < 2) {
    // v1 → v2: 前端页面缺少 assets/routes 字段
    if (data.frontendPages) {
      for (const [key, page] of Object.entries(data.frontendPages)) {
        if (!page.assets) page.assets = {};
        if (!page.routes) page.routes = [];
      }
    }
    log("[快照迁移] v1 → v2：补充前端 assets/routes 字段");
  }
  if (ver < 3) {
    // v2 → v3: 新增 githubETag、moduleErrors 持久化
    if (!data.githubETag) data.githubETag = "";
    if (!data.apiValues) data.apiValues = {};
    log("[快照迁移] v2 → v3：补充 githubETag/apiValues 字段");
  }
  if (ver < 4) {
    if (!Array.isArray(data._frontendDiscoveredUrls)) data._frontendDiscoveredUrls = [];
    if (data._frontendAssetPending) delete data._frontendAssetPending;
    log("[快照迁移] v3 → v4：补充前端自动发现页面字段，清理旧资源待确认缓存");
  }
  if (ver < 5) {
    if (pruneFrontendSnapshot(data)) {
      log("[快照迁移] v4 → v5：清理过期前端页面");
    }
  } else {
    pruneFrontendSnapshot(data);
  }
  if (ver < 6) {
    if (!data.chainActorMonitor) data.chainActorMonitor = {};
    if (!data.chainActorMonitor.creators) data.chainActorMonitor.creators = {};
    if (!Array.isArray(data.chainActorMonitor.seenTxs)) data.chainActorMonitor.seenTxs = [];
    log("[快照迁移] v5 → v6：补充合约创建者动作监听字段");
  }
  data._schemaVersion = CURRENT_SCHEMA_VERSION;
  return data;
}

function saveSnapshot(data) {
  data._schemaVersion = CURRENT_SCHEMA_VERSION;
  data.lastCheck = ts();
  const serialized = JSON.stringify(data, null, 2);
  snapshotWriteQueue = snapshotWriteQueue.then(() => {
    try {
      const tmpFile = CONFIG.snapshotFile + ".tmp";
      writeFileSync(tmpFile, serialized, "utf-8");
      renameSync(tmpFile, CONFIG.snapshotFile);
    } catch (err) {
      log(`[快照] 写入失败：${err.message}`);
    }
  });
  return snapshotWriteQueue;
}

/* ── 飞书消息（SDK 统一通道） ── */

/**
 * 带重试的卡片发送（兼容旧接口 sendFeishu）
 */
async function sendFeishu(title, content, template = "red", _retries = 2) {
  for (let attempt = 0; attempt <= _retries; attempt++) {
    try {
      await sendCardQueued(title, content, template);
      return;
    } catch (err) {
      log(`飞书推送异常（第${attempt + 1}次）：${err.message}`);
      if (attempt < _retries) {
        await sleep(3_000 * (attempt + 1));
      }
    }
  }
  log(`飞书推送最终失败（已重试 ${_retries} 次）`);
}

/**
 * 提交低优先级心跳消息
 */
function sendHeartbeat(title, content, template = "green") {
  sendHeartbeatQueued(title, content, template);
}

/**
 * 通过 IM API 发送卡片消息到群聊，返回 message_id
 */
async function sendCardViaApi(title, content, template = "red", diffFilePath) {
  try {
    return await sendCard(title, content, template, { diffFilePath });
  } catch (err) {
    log(`[IM API] 发送失败：${err.message}`);
    return null;
  }
}

/**
 * 编辑已发送的卡片消息（用于补充 AI 摘要）
 */
async function patchCardViaApi(messageId, title, content, template = "red", diffFilePath) {
  await patchCard(messageId, title, content, template, { diffFilePath });
}

/**
 * 先推裸 diff（秒级送达），AI 摘要完成后自动编辑原消息补充分析
 * @param {string} [url] - 监控目标网址，展示在卡片最上方
 */
async function sendThenEnrichWithAi(title, content, template, moduleContext, aiInput, enrichFn, diffFilePath, url) {
  // 卡片最上方加入监控目标网址
  const urlLine = url ? `🔗 [${url}](${url})\n\n` : "";
  // 1. 立即推送裸 diff（秒级送达）
  const messageId = await sendCardViaApi(title, urlLine + content, template, diffFilePath);

  // 2. 异步调用 AI → 编辑原消息补充摘要（不阻塞调用方）
  if (AI_CONFIG.enabled && AI_CONFIG.apiKey) {
    aiSummarize(aiInput || content, moduleContext).then(async (summary) => {
      if (!summary) return;
      const enriched = enrichFn
        ? enrichFn(summary)
        : `**🤖 AI 分析：**\n${summary}\n\n---\n\n${content}`;
      if (messageId) {
        try {
          await patchCardViaApi(messageId, title, urlLine + enriched, template, diffFilePath);
          log(`[AI→更新] ${title} 已补充 AI 摘要`);
        } catch (err) {
          log(`[AI→更新] 编辑失败(${err.message})，追加发送`);
          await sendFeishu(`🤖 ${title}`, `**AI 分析：**\n${summary}`, "blue");
        }
      } else {
        await sendFeishu(`🤖 ${title}`, `**AI 分析：**\n${summary}`, "blue");
      }
    }).catch(err => log(`[AI] 异步摘要异常：${err.message}`));
  }
}

/**
 * 保存 diff 详情到本地文件（不再直接发送到飞书群，改为卡片按钮触发下载）
 * @param {string} title - 通知标题（用于文件名）
 * @param {string} diffText - 完整 diff 文本内容
 * @returns {string|null} 本地文件路径（供卡片按钮引用），内容过短时返回 null
 */
function saveDiffLocally(title, diffText) {
  if (!diffText || diffText.length < 50) return null;
  try {
    const diffDir = join(__dirname, "diffs");
    if (!existsSync(diffDir)) mkdirSync(diffDir, { recursive: true });
    const safeName = title.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, "_").slice(0, 40);
    const now = new Date();
    const dateStr = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
      "_",
      String(now.getHours()).padStart(2, "0"),
      String(now.getMinutes()).padStart(2, "0"),
      String(now.getSeconds()).padStart(2, "0"),
    ].join("");
    const fileName = `diff_${safeName}_${dateStr}.txt`;
    const filePath = join(diffDir, fileName);
    writeFileSync(filePath, diffText, "utf-8");
    log(`[diff文件] 已保存: ${filePath} (${diffText.length} 字)`);
    // 清理超过 7 天的旧 diff 文件
    try {
      const cutoff = Date.now() - 7 * 24 * 3600_000;
      for (const f of readdirSync(diffDir)) {
        const fp = join(diffDir, f);
        try { if (statSync(fp).mtimeMs < cutoff) unlinkSync(fp); } catch (_) {}
      }
    } catch (_) {}
    return filePath;
  } catch (err) {
    log(`[diff文件] 保存失败：${err.message}`);
    return null;
  }
}

/* ══════════════════════════════════════════
   AI 总结（共享 ai-client，多模型热切换）
   ══════════════════════════════════════════ */

import { AI, aiSummarize as _aiSummarizeBase } from "../shared/ai-client.mjs";

const AI_CONFIG = AI; // 兼容旧代码引用

const AI_SYSTEM_PROMPT = `你是 Four.meme（BSC 链 Meme 代币发射平台）的变更监控分析师。

监控覆盖：底池配置、前端代码/i18n/路由、API 接口、GitHub 仓库、智能合约 bytecode、链上参数（Agent NFT）。

分析 diff 时：
1. 区分构建噪音（hash 轮换、变量重命名、部署 ID、minifier 差异）和实质变更。
2. 对 i18n/文案变更，重点关注中文内容的业务含义，按功能分类（如代币创建、交易、分红、NFT 等），标注对用户操作的影响。
3. 对配置/参数变更，说明具体改了什么值、业务影响。
4. 对合约/链上变更，评估安全性影响。

输出：一句话概括 + 2-5 条要点（• 开头）。纯噪音则直接标注"常规构建更新，无实质变化"。中文，不超过 400 字。`;

/**
 * 调用 AI 对 diff 内容进行总结
 */
async function aiSummarize(diffContent, moduleContext = "", _retries = 1) {
  return _aiSummarizeBase(diffContent, AI_SYSTEM_PROMPT, moduleContext, { retries: _retries });
}

/* ══════════════════════════════════════════
   变更历史记录（history.jsonl）
   ══════════════════════════════════════════ */

const HISTORY_FILE = join(__dirname, "history.jsonl");
const HISTORY_MAX_LINES = 500; // 保留最近 500 条
let historyWriteQueue = Promise.resolve();
let historyLineCount = -1; // -1 = 未初始化，首次写入时统计

function appendHistory(module, title, summary, diffSnippet = "") {
  const record = {
    ts: new Date().toISOString(),
    module,
    title,
    summary: (summary || "").slice(0, 500),
    diff: (diffSnippet || "").slice(0, 1000),
  };
  historyWriteQueue = historyWriteQueue.then(() => {
    try {
      appendFileSync(HISTORY_FILE, JSON.stringify(record) + "\n", "utf-8");
      // 首次写入时统计行数，后续用计数器追踪
      if (historyLineCount < 0) {
        historyLineCount = readFileSync(HISTORY_FILE, "utf-8").split("\n").filter(Boolean).length;
      } else {
        historyLineCount++;
      }
      if (historyLineCount > HISTORY_MAX_LINES) {
        const lines = readFileSync(HISTORY_FILE, "utf-8").split("\n").filter(Boolean);
        const keep = lines.slice(-Math.floor(HISTORY_MAX_LINES / 2));
        writeFileSync(HISTORY_FILE, keep.join("\n") + "\n", "utf-8");
        historyLineCount = keep.length;
        log(`[历史] 已截断至 ${keep.length} 条`);
      }
    } catch (err) {
      log(`[历史] 写入失败：${err.message}`);
    }
  });
}

/* ── HTTP 请求工具（含反风控 + 5xx 静默重试）── */
async function fetchSafe(url, opts = {}, timeoutMs = CONFIG.defaultTimeoutMs) {
  const domain = getDomain(url);
  if (shouldBackoff(domain)) {
    throw new Error(`[退避中] ${domain}`);
  }
  const maxRetries = 2; // 5xx 最多重试 2 次（共 3 次尝试）
  let lastStatus = 0;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...opts, signal: ctrl.signal });
      if (res.status === 429 || res.status === 403) {
        try { await res.text(); } catch {}
        recordFail(domain, res.status);
        throw new Error(`HTTP ${res.status} (风控)`);
      }
      if (res.status >= 500) {
        try { await res.text(); } catch {}
        lastStatus = res.status;
        if (attempt < maxRetries) {
          await sleep(1_000 * (attempt + 1));
          continue;
        }
        recordFail(domain, res.status);
        throw new Error(`HTTP ${res.status} (服务端错误，重试${maxRetries}次仍失败)`);
      }
      if (res.status === 304) {
        try { await res.text(); } catch {}
        return res;
      }
      if (res.ok) recordSuccess(domain);
      return res;
    } catch (err) {
      if (err.name === "AbortError") {
        lastStatus = -1;
        if (attempt < maxRetries) {
          await sleep(1_000 * (attempt + 1));
          continue;
        }
        throw new Error(`请求超时 ${timeoutMs}ms (重试${maxRetries}次): ${url}`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * API 探测专用 fetch — 不触发域级退避
 * 用于用非法参数探测 API 结构的场景，4xx/5xx 是预期行为，
 * 不应影响同域其他模块（前端、底池）的正常请求。
 * 仅对 429/403（真正的风控）触发退避。
 */
async function fetchProbe(url, opts = {}, timeoutMs = CONFIG.defaultTimeoutMs) {
  const domain = getDomain(url);
  if (shouldBackoff(domain)) {
    throw new Error(`[退避中] ${domain}`);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    if (res.status === 429 || res.status === 403) {
      try { await res.text(); } catch {}
      recordFail(domain, res.status);
      throw new Error(`HTTP ${res.status} (风控)`);
    }
    // 对非风控错误码：直接返回响应，不触发退避，让调用方决定如何处理
    if (res.ok || res.status < 500) recordSuccess(domain);
    return res;
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`请求超时 ${timeoutMs}ms: ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/* ══════════════════════════════════════════
   BSC JSON-RPC 工具（含 Batch）
   ══════════════════════════════════════════ */

// --- 单次 RPC（保留作为 fallback）---
async function bscRpcCall(method, params) {
  let lastErr;
  for (const rpcUrl of CONFIG.bscRpcUrls) {
    try {
      const res = await fetchSafe(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      }, 8_000);
      const json = await res.json();
      if (json.error) throw new Error(`RPC error: ${json.error.message || JSON.stringify(json.error)}`);
      return json.result;
    } catch (err) {
      lastErr = err;
      // 429/403 对单个节点的限流不应终止整个调用，继续尝试下一个节点
      continue;
    }
  }
  throw lastErr || new Error("所有 BSC RPC 节点均不可用");
}

const rpcItemErrorLogState = new Map();
const RPC_ITEM_ERROR_LOG_COOLDOWN_MS = 30 * 60_000;

function formatRpcCallSample(call) {
  const method = call?.method || "未知方法";
  const params = Array.isArray(call?.params) ? call.params.slice(0, 2).join(",") : "";
  return params ? `${method} ${params}` : method;
}

function shouldLogRpcItemError(call, message) {
  const key = `${call?.method || "未知方法"}:${message}`;
  const now = Date.now();
  const state = rpcItemErrorLogState.get(key) || { lastLogAt: 0, suppressed: 0 };
  const shouldLog = !state.lastLogAt || now - state.lastLogAt >= RPC_ITEM_ERROR_LOG_COOLDOWN_MS;
  if (shouldLog) {
    const suppressed = state.suppressed;
    rpcItemErrorLogState.set(key, { lastLogAt: now, suppressed: 0 });
    if (rpcItemErrorLogState.size > 200) {
      const oldest = rpcItemErrorLogState.keys().next().value;
      if (oldest) rpcItemErrorLogState.delete(oldest);
    }
    return { shouldLog: true, suppressed };
  }
  state.suppressed++;
  rpcItemErrorLogState.set(key, state);
  return { shouldLog: false, suppressed: state.suppressed };
}

// --- Batch RPC：一次 HTTP 调用执行多个 RPC ---
async function bscRpcBatch(calls) {
  if (calls.length === 0) return [];
  // 单条也走 batch 逻辑，保持统一的错误语义（失败返回 null 而非抛异常）
  if (calls.length === 1) {
    try {
      const result = await bscRpcCall(calls[0].method, calls[0].params);
      return [result];
    } catch (err) {
      const info = shouldLogRpcItemError(calls[0], err.message);
      if (info.shouldLog) {
        const suffix = info.suppressed ? `（已合并 ${info.suppressed} 条同类错误）` : "";
        log(`[RPC] 单次调用 ${formatRpcCallSample(calls[0])} 失败：${err.message}${suffix}`);
      }
      return [null];
    }
  }
  const payload = calls.map((c, i) => ({
    jsonrpc: "2.0",
    id: i + 1,
    method: c.method,
    params: c.params,
  }));

  let lastErr;
  for (const rpcUrl of CONFIG.bscRpcUrls) {
    try {
      const res = await fetchSafe(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }, 15_000);
      const results = await res.json();
      if (!Array.isArray(results)) {
        throw new Error("Batch RPC 返回非数组: " + JSON.stringify(results).slice(0, 200));
      }
      // 按 id 排序后提取 result
      results.sort((a, b) => a.id - b.id);
      return results.map(r => {
        if (r.error) {
          const call = calls[r.id - 1];
          const message = r.error.message || JSON.stringify(r.error);
          const info = shouldLogRpcItemError(call, message);
          if (info.shouldLog) {
            const suffix = info.suppressed ? `（已合并 ${info.suppressed} 条同类错误）` : "";
            log(`[RPC] 批量第 ${r.id} 项 ${formatRpcCallSample(call)} 失败：${message}${suffix}`);
          }
          return null;
        }
        return r.result;
      });
    } catch (err) {
      lastErr = err;
      // 429/403 对单个节点的限流不应终止整个调用，继续尝试下一个节点
      continue;
    }
  }
  throw lastErr || new Error("所有 BSC RPC 节点 batch 均不可用");
}

/* ── ABI 编解码辅助 ── */
function encodeAddress(addr) {
  return addr.toLowerCase().replace("0x", "").padStart(64, "0");
}
function encodeUint256(n) {
  return BigInt(n).toString(16).padStart(64, "0");
}
function decodeUint256(hex, offset = 0) {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const chunk = clean.slice(offset * 64, offset * 64 + 64);
  if (!chunk || chunk.length === 0) return 0n;
  return BigInt("0x" + chunk);
}
function decodeAddress(hex, offset = 0) {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  return "0x" + clean.slice(offset * 64 + 24, offset * 64 + 64);
}

const SEL = {
  nftCount:       "0x0af2c6ca",
  nftAt:          "0x496c3079",
  isAgent:        "0x1ffbb064",
  getTokenInfo:   "0x1f69565f",
  _tokenInfos:    "0xe684626b",
  _tokenInfoEx1s: "0x9f266331",
  templates:      "0xbc525652",
};

/* ══════════════════════════════════════════
   模块 1：底池配置监控
   ══════════════════════════════════════════ */

async function fetchPoolConfig() {
  const res = await fetchSafe(`${CONFIG.apiBase}/v1/public/config`, {
    headers: { "User-Agent": nextUA(), "Accept": "application/json" },
  }, 15_000);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json?.code !== 0 && json?.code !== "0") {
    throw new Error(`API code=${json?.code}：${json?.message || json?.msg}`);
  }
  return json.data;
}

function buildPoolMap(list) {
  const map = new Map();
  if (!Array.isArray(list)) return map;
  for (const item of list) {
    if (item?.networkCode === CONFIG.networkCode) {
      // 优先用 symbolAddress 做 key；仅在无 address 时 fallback 到 symbol
      const addr = (item.symbolAddress || "").toLowerCase();
      const key = addr || (item.symbol || "").toLowerCase();
      if (key) map.set(key, item);
    }
  }
  return map;
}

const WATCH_FIELDS = [
  "symbol", "nativeSymbol", "status", "deployCost", "buyFee", "sellFee",
  "b0Amount", "totalBAmount", "totalAmount", "saleRate", "reservedNumber",
  "tradeLevel", "minTradeFee",
];

function diffPoolConfigs(oldList, newList) {
  const oldMap = buildPoolMap(oldList);
  const newMap = buildPoolMap(newList);
  const changes = [];
  for (const [key, item] of newMap) {
    if (!oldMap.has(key)) {
      changes.push({ type: "新增底池", symbol: item.symbol || item.nativeSymbol || key, address: item.symbolAddress || "", status: item.status || "", details: item });
    }
  }
  for (const [key, item] of oldMap) {
    if (!newMap.has(key)) {
      changes.push({ type: "移除底池", symbol: item.symbol || item.nativeSymbol || key, address: item.symbolAddress || "", details: item });
    }
  }
  for (const [key, newItem] of newMap) {
    const oldItem = oldMap.get(key);
    if (!oldItem) continue;
    const fc = [];
    for (const f of WATCH_FIELDS) {
      const ov = JSON.stringify(oldItem[f] ?? "");
      const nv = JSON.stringify(newItem[f] ?? "");
      if (ov !== nv) fc.push(`${f}: ${ov} → ${nv}`);
    }
    if (fc.length > 0) {
      changes.push({ type: "参数变更", symbol: newItem.symbol || newItem.nativeSymbol || key, address: newItem.symbolAddress || "", fieldChanges: fc });
    }
  }
  return changes;
}

// 底池字段的中文语义注释，帮助 AI 和人类理解参数含义
const POOL_FIELD_LABELS = {
  symbol:         "交易对符号",
  nativeSymbol:   "原生代币符号",
  status:         "上线状态（PUBLISH=已上线）",
  deployCost:     "部署费用",
  buyFee:         "买入手续费率",
  sellFee:        "卖出手续费率",
  b0Amount:       "初始底池金额",
  totalBAmount:   "目标募集总量（满池阈值）",
  totalAmount:    "代币总供应量",
  saleRate:       "公售比例",
  reservedNumber: "团队预留数量",
  tradeLevel:     "交易等级/层级",
  minTradeFee:    "最小交易手续费",
  networkCode:    "所在链",
  symbolAddress:  "代币合约地址",
};

function annotateField(fieldName) {
  return POOL_FIELD_LABELS[fieldName] || "";
}

function formatPoolChanges(changes) {
  const lines = [];
  for (const c of changes) {
    if (c.type === "新增底池") {
      lines.push(`**🟢 新增底池：${c.symbol}**`);
      lines.push("```");
      lines.push(`+ 地址:     ${c.address}`);
      lines.push(`+ 状态:     ${c.status}`);
      // 输出所有 WATCH_FIELDS 中有值的字段，附带中文注释
      const d = c.details || {};
      for (const f of WATCH_FIELDS) {
        if (f === "symbol" || f === "status") continue; // 已在上面输出
        const val = d[f];
        if (val === undefined || val === null || val === "") continue;
        const label = annotateField(f);
        lines.push(`+ ${f}: ${val}${label ? "  ← " + label : ""}`);
      }
      // 输出 WATCH_FIELDS 之外的额外字段（如未来 API 新增的字段）
      const watchSet = new Set(WATCH_FIELDS);
      const extraFields = Object.entries(d).filter(([k]) =>
        !watchSet.has(k) && k !== "symbolAddress" && k !== "networkCode"
        && typeof d[k] !== "object"
      );
      for (const [k, v] of extraFields.slice(0, 10)) {
        if (v === undefined || v === null || v === "") continue;
        lines.push(`+ ${k}: ${v}`);
      }
      lines.push("```");
      lines.push("---");
    } else if (c.type === "移除底池") {
      lines.push(`**🔴 移除底池：${c.symbol}**`);
      lines.push("```");
      lines.push(`- 地址: ${c.address}`);
      if (c.details) {
        for (const f of ["buyFee", "sellFee", "b0Amount", "totalBAmount", "status"]) {
          if (c.details[f] !== undefined) lines.push(`- ${f}: ${c.details[f]}${annotateField(f) ? "  ← " + annotateField(f) : ""}`);
        }
      }
      lines.push("```");
      lines.push("---");
    } else if (c.type === "参数变更") {
      lines.push(`**🟡 参数变更：${c.symbol}**`);
      lines.push("```");
      for (const fc of c.fieldChanges) {
        // fc 格式: "buyFee: "0.01" → "0.02""
        const fieldName = fc.split(":")[0].trim();
        const label = annotateField(fieldName);
        lines.push(`~ ${fc}${label ? "  ← " + label : ""}`);
      }
      lines.push("```");
      lines.push("---");
    }
  }
  return lines.join("\n");
}

function printPoolList(list) {
  const map = buildPoolMap(list);
  log(`── 当前 BSC 底池（共 ${map.size} 个）──`);
  let i = 1;
  for (const [, item] of map) {
    const status = item.status === "PUBLISH" ? "✓" : item.status || "?";
    console.log(`  ${String(i++).padStart(2)}. ${(item.symbol || "?").padEnd(8)} [${status}]  底池余额=${item.b0Amount || "-"}  总量=${item.totalBAmount || "-"}  手续费=${item.buyFee || "-"}/${item.sellFee || "-"}  地址=${(item.symbolAddress || "").slice(0, 10)}...`);
  }
  log(`────────────────────────`);
}

/* ══════════════════════════════════════════
   模块 2：前端代码监控（并行抓取）
   ══════════════════════════════════════════ */

function urlToKey(url) {
  return url.replace(/[^a-zA-Z0-9]/g, "_");
}

function urlLabel(url) {
  try {
    const u = new URL(url);
    const path = u.pathname === "/" ? "首页" : u.pathname;
    return u.search ? path + u.search : path;
  } catch { return url; }
}

function canonicalFrontendUrl(url) {
  try {
    const u = new URL(url, CONFIG.siteUrl);
    u.hash = "";
    if (u.pathname !== "/" && u.pathname.endsWith("/")) u.pathname = u.pathname.replace(/\/+$/, "");
    return u.origin + (u.pathname === "/" ? "" : u.pathname) + u.search;
  } catch {
    return url;
  }
}

function getFrontendMonitorUrls() {
  const urls = [
    ...CONFIG.monitorUrls,
    ...(snapshot?._frontendDiscoveredUrls || []).filter(url => isDiscoverableFrontendUrl(url)),
  ];
  return [...new Set(urls.map(canonicalFrontendUrl))];
}

function isConfiguredFrontendUrl(url) {
  const canonical = canonicalFrontendUrl(url);
  return CONFIG.monitorUrls.map(canonicalFrontendUrl).includes(canonical);
}

function isDiscoverableFrontendUrl(url) {
  const canonical = canonicalFrontendUrl(url);
  if (!canonical || isConfiguredFrontendUrl(canonical) || REMOVED_FRONTEND_URLS.has(canonical)) return false;
  const route = normalizeRouteString(canonical).split("?")[0].replace(/\/+$/, "") || "/";
  if (!isTrackableRouteString(route)) return false;
  if (isApiOrEndpointRoute(route)) return false;
  if (isUnsupportedLocalePrefixedRoute(route)) return false;
  if (CONFIG.frontendDiscovery.excludeRoutes.some(re => re.test(route))) return false;
  return true;
}

function normalizeRouteString(raw) {
  if (typeof raw !== "string") return "";
  const s = raw.trim();
  if (!s || s.includes("${") || s.includes("[object")) return "";
  try {
    if (/^https?:\/\//i.test(s)) {
      const u = new URL(s);
      if (u.origin !== CONFIG.siteUrl) return "";
      return u.pathname + u.search;
    }
  } catch {
    return "";
  }
  return s.split("#")[0];
}

function isTrackableRouteString(route) {
  if (!route || route[0] !== "/") return false;
  if (route === "/") return false;
  if (route.startsWith("//")) return false;
  if (route.startsWith("/_next/") || route.startsWith("/static/")) return false;
  if (/\.(js|css|png|svg|ico|jpg|jpeg|gif|webp|woff2?|ttf|eot|map)$/i.test(route.split("?")[0])) return false;
  if (isLocaleRootRoute(route)) return false;
  if (isDynamicFrontendRoute(route)) return false;
  if (/^\/docs(?:\/|$)/i.test(route) || /^\/a\/i$/i.test(route) || /^\/v\d+\/resolve-ens$/i.test(route)) return false;
  return true;
}

function isApiOrEndpointRoute(route) {
  return /^\/(?:api|meme-api|mapi|v\d+|blog\/v\d+)\//i.test(route);
}

function isLocaleRootRoute(route) {
  return /^\/[a-z]{2}(?:-[a-z]{2})?$/i.test((route || "").split("?")[0].replace(/\/+$/, ""));
}

function isUnsupportedLocalePrefixedRoute(route) {
  const path = (route || "").split("?")[0];
  return /^\/[a-z]{2}(?:-[a-z]{2})?(?:\/|$)/i.test(path) && !/^\/(?:en|zh-TW)(?:\/|$)/i.test(path);
}

function isDynamicFrontendRoute(route) {
  const path = normalizeRouteString(route).split("?")[0].replace(/\/+$/, "");
  return /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?token\/0x[a-f0-9]{40}$/i.test(path)
    || /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?presale\/\d+$/i.test(path)
    || /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?competition\/[^/?#]+$/i.test(path);
}

function routeToFrontendUrl(route) {
  if (!CONFIG.frontendDiscovery.enabled) return null;
  const normalized = normalizeRouteString(route).split("?")[0].replace(/\/+$/, "") || "/";
  if (!isTrackableRouteString(normalized)) return null;
  if (isApiOrEndpointRoute(normalized)) return null;
  if (isUnsupportedLocalePrefixedRoute(normalized)) return null;
  if (CONFIG.frontendDiscovery.excludeRoutes.some(re => re.test(normalized))) return null;
  let candidate;
  if (/^\/(?:en|zh-TW)(?:\/|$)/i.test(normalized)) {
    candidate = canonicalFrontendUrl(CONFIG.siteUrl + normalized);
  } else {
    candidate = canonicalFrontendUrl(`${CONFIG.siteUrl}/${CONFIG.frontendDiscovery.locale}${normalized}`);
  }
  return isDiscoverableFrontendUrl(candidate) ? candidate : null;
}

function discoverFrontendUrlsFromPages(pages, knownUrls = []) {
  const known = new Set(knownUrls.map(canonicalFrontendUrl));
  const discovered = [];
  for (const page of Object.values(pages || {})) {
    for (const route of page.routes || []) {
      const url = routeToFrontendUrl(route);
      if (!url || known.has(url)) continue;
      known.add(url);
      discovered.push(url);
      if (discovered.length >= CONFIG.frontendDiscovery.maxDiscoveredPages) return discovered;
    }
  }
  return discovered;
}

function extractTextContent(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

/* ── 构建噪音过滤（移植自 flap-monitor） ── */
const NOISE_PATTERNS = [
  /^dpl_[A-Za-z0-9]+$/,                        // Vercel 部署 ID
  /^[a-f0-9]{16,}$/i,                          // 纯 hex hash
  /^\),\w+=Symbol\./,                           // React 内部符号
  /^\.prototype\.\w+=function/,                 // prototype 方法赋值
  /^[)}],\w\.prototype=/,                       // prototype 赋值
  /^\+[a-z]\.key\)\.replace\(/,                 // React key 处理
  /^\+[a-z]\.key\),[a-z]\)/,                    // React key 处理
  /^[)}][a-z]\?[a-z]\.enqueue\(/,              // React enqueue 调用
  /enqueueForceUpdate/,                         // React updater
  /\.Component=[a-z],.*\.Fragment=/,            // React exports
  /^&dpl=dpl_/,                                 // 内联部署 ID 参数
  /^\)',[A-Z$]=\w+\?\{backgroundSize/,         // Next/Image 样式
  /^\)\)&&\(\w+=!0,\w+=!1\)/,                  // 布尔赋值链
  /^;let \w+=\w+\(\w+\),\w+=Object\.assign/,   // Object.assign 模式
  /^;let \w+=\w+\.loader\|\|/,                  // loader fallback
  /getImageBlurSvg/,                            // Next/Image blur 处理
  /blurWidth.*blurHeight.*blurData/,            // Next/Image blur 参数
  /^[+),]src:\w+\(\{config:\w+,src:\w+/,       // Next/Image src 构造
  /^__turbopack_/,                              // Turbopack 内部标识
  /^webpack[/\\]/,                              // Webpack 内部路径
  /^\(self\.__next_f=/,                         // Next.js flight 数据
];

function isNoiseString(s) {
  return NOISE_PATTERNS.some(p => p.test(s));
}

/* ── 配置参数结构化提取（移植自 flap-monitor，按 four.meme 业务调整） ── */
const CONFIG_BUSINESS_KEYS = new Set([
  // 费率 / 底池
  "enabled", "fee", "feeRate", "feeBps", "buyFee", "sellFee", "tradeFee", "commission",
  "b0Amount", "totalBAmount", "totalAmount", "minAmount", "maxAmount",
  // 代币创建
  "quickAmounts", "usePermit", "constraints", "showInCAStore",
  // 功能开关
  "supportSubscription", "supportSub", "status", "symbol",
  // 网络 / 合约
  "networkCode", "chainId", "rpcUrl", "contractAddress",
  // Agentic / 代理
  "agentNft", "agentIdentifier",
  // Vault / Dividend
  "Vault", "vault", "Dividend", "dividendBps", "minDividendBps", "maxDividendBps",
  "Staking", "staking", "Lista", "lista",
  // 路由
  "descriptionI18nKey", "nameI18nKey",
]);

const CONFIG_NOISE_KEYS = /^([a-z]|[A-Z]{1,2}|prototype|constructor|Component|Fragment|Profiler|StrictMode|children|className|ref|displayName|props|isPureReactComponent|enqueue\w+|default|mounted|isMounted)$/;

function extractConfigDiffs(removedStrings, addedStrings) {
  const configDiffs = [];
  const configRe = /(\w+)\s*:\s*(\{[^}]+\}|![01]|"[^"]*"|'[^']*'|[\w.]+)/g;

  function parseConfigTokens(str) {
    const map = new Map();
    let m;
    const re = new RegExp(configRe.source, "g");
    while ((m = re.exec(str)) !== null) {
      const key = m[1];
      if (CONFIG_NOISE_KEYS.test(key)) continue;
      if (!CONFIG_BUSINESS_KEYS.has(key) && key.length < 4) continue;
      map.set(key, m[2]);
    }
    return map;
  }

  for (const removed of removedStrings) {
    const oldTokens = parseConfigTokens(removed);
    if (oldTokens.size === 0) continue;
    for (const added of addedStrings) {
      const newTokens = parseConfigTokens(added);
      if (newTokens.size === 0) continue;
      const commonKeys = [...oldTokens.keys()].filter(k => newTokens.has(k));
      if (commonKeys.length === 0) continue;
      for (const key of commonKeys) {
        const oldVal = oldTokens.get(key);
        const newVal = newTokens.get(key);
        if (oldVal !== newVal) {
          configDiffs.push({ field: key, oldVal, newVal });
        }
      }
      for (const [key, val] of newTokens) {
        if (!oldTokens.has(key) && CONFIG_BUSINESS_KEYS.has(key)) {
          configDiffs.push({ field: key, oldVal: "(无)", newVal: val });
        }
      }
      if (configDiffs.length > 0) break;
    }
  }
  return configDiffs;
}

/**
 * 从 JS/CSS 文件内容中提取有意义的字符串（用于内容级 diff）
 * - JS: 提取 >= 6 字符的字符串字面量（过滤纯 hex/数字/代码噪音）
 * - CSS: 提取自定义属性名 + 长选择器
 */
function extractStrings(content, ext) {
  const strings = new Set();
  if (ext === "js") {
    // 提取双引号和单引号字符串 >= 6 字符
    const re = /(?:"((?:[^"\\]|\\.){6,})")|(?:'((?:[^'\\]|\\.){6,})')/g;
    let m;
    while ((m = re.exec(content)) !== null) {
      const s = (m[1] || m[2] || "").trim();
      if (!s) continue;
      // 过滤纯 hex hash、纯数字、base64-like、sourcemap、webpack 内部路径
      if (/^[a-f0-9]{20,}$/i.test(s)) continue;
      if (/^[\d.eE+\-\s,]+$/.test(s)) continue;
      if (/^data:/.test(s)) continue;
      if (/\.map$/.test(s)) continue;
      if (/^webpack/.test(s)) continue;
      strings.add(s.length > 200 ? s.slice(0, 200) : s);
    }
  } else if (ext === "css") {
    // CSS 自定义属性
    const propRe = /--[\w-]{4,}/g;
    let m;
    while ((m = propRe.exec(content)) !== null) strings.add(m[0]);
    // 长选择器
    const selRe = /([.#][\w-]{6,})/g;
    while ((m = selRe.exec(content)) !== null) strings.add(m[0]);
  }
  return [...strings].sort();
}

/**
 * 批量下载资源文件内容（带并发控制和错开延迟）
 * 返回: { [filename]: { contentHash, size, strings, ext } }
 */
async function downloadAssetContents(assetUrls, sharedCache = null) {
  const results = {};
  const BATCH = 6;        // 每批并发数
  const STAGGER = 80;     // 批内请求间隔 ms
  const entries = [...assetUrls.entries()]; // [[filename, url], ...]

  async function fetchAsset(filename, url) {
    if (sharedCache?.has(url)) {
      const cached = await sharedCache.get(url);
      return cached ? { ...cached, filename } : null;
    }

    const promise = (async () => {
      try {
        const res = await fetchSafe(url, {
          headers: { ...browserHeaders(), "Accept": "*/*" },
        }, 8_000);
        if (!res.ok) return null;
        const content = await res.text();
        const ext = filename.endsWith(".css") ? "css" : "js";
        return {
          contentHash: md5(content),
          size: content.length,
          strings: extractStrings(content, ext).slice(0, 200),
          ext,
        };
      } catch {
        return null;
      }
    })();

    if (sharedCache) sharedCache.set(url, promise);
    const data = await promise;
    return data ? { ...data, filename } : null;
  }

  for (let i = 0; i < entries.length; i += BATCH) {
    const batch = entries.slice(i, i + BATCH);
    const tasks = batch.map(([filename, url], idx) =>
      sleep(idx * STAGGER).then(() => fetchAsset(filename, url))
    );
    const batchResults = await Promise.allSettled(tasks);
    for (const r of batchResults) {
      if (r.status === "fulfilled" && r.value) {
        results[r.value.filename] = r.value;
      }
    }
  }
  return results;
}

/* ── __NEXT_DATA__ 提取与对比 ── */

function extractNextData(html) {
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) return null;
  try {
    const data = JSON.parse(match[1]);
    return {
      props: data.props || {},
      page: data.page || "",
      query: data.query || {},
      buildId: data.buildId || "",
      runtimeConfig: data.runtimeConfig || data.publicRuntimeConfig || null,
      locale: data.locale || null,
      locales: data.locales || null,
    };
  } catch { return null; }
}

function flattenObject(obj, prefix = "", depth = 0) {
  const result = {};
  if (depth > 10) return result;
  if (obj === null || obj === undefined) return result;
  if (typeof obj !== "object") { result[prefix] = obj; return result; }
  if (Array.isArray(obj)) {
    result[prefix] = JSON.stringify(obj);
    return result;
  }
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      Object.assign(result, flattenObject(v, path, depth + 1));
    } else {
      result[path] = typeof v === "object" ? JSON.stringify(v) : v;
    }
  }
  return result;
}

function diffNextData(oldData, newData) {
  if (!oldData || !newData) return [];
  const changes = [];

  if (oldData.buildId && newData.buildId && oldData.buildId !== newData.buildId) {
    changes.push({ type: "buildId", old: oldData.buildId, new: newData.buildId });
  }
  if (oldData.page !== newData.page) {
    changes.push({ type: "page", old: oldData.page, new: newData.page });
  }
  if (JSON.stringify(oldData.locale) !== JSON.stringify(newData.locale)) {
    changes.push({ type: "locale", old: oldData.locale, new: newData.locale });
  }
  if (JSON.stringify(oldData.locales) !== JSON.stringify(newData.locales)) {
    changes.push({ type: "locales", old: oldData.locales, new: newData.locales });
  }

  // runtimeConfig 逐字段对比
  if (oldData.runtimeConfig && newData.runtimeConfig) {
    const oldFlat = flattenObject(oldData.runtimeConfig, "runtimeConfig");
    const newFlat = flattenObject(newData.runtimeConfig, "runtimeConfig");
    for (const [k, v] of Object.entries(newFlat)) {
      if (!(k in oldFlat)) changes.push({ type: "runtimeConfig.added", key: k, value: v });
      else if (String(oldFlat[k]) !== String(v)) changes.push({ type: "runtimeConfig.changed", key: k, old: oldFlat[k], new: v });
    }
    for (const k of Object.keys(oldFlat)) {
      if (!(k in newFlat)) changes.push({ type: "runtimeConfig.removed", key: k, value: oldFlat[k] });
    }
  }

  // props 结构 + 值变更（关注 pageProps 下的 feature flags 等）
  const oldProps = flattenObject(oldData.props, "props");
  const newProps = flattenObject(newData.props, "props");
  for (const [k, v] of Object.entries(newProps)) {
    if (!(k in oldProps)) changes.push({ type: "props.added", key: k, value: String(v).slice(0, 200) });
    else if (String(oldProps[k]) !== String(v)) {
      // 超长值通常是序列化的大数据块，跳过以减少噪音
      if (String(v).length > 500 || String(oldProps[k]).length > 500) continue;
      changes.push({ type: "props.changed", key: k, old: String(oldProps[k]).slice(0, 200), new: String(v).slice(0, 200) });
    }
  }
  for (const k of Object.keys(oldProps)) {
    if (!(k in newProps)) changes.push({ type: "props.removed", key: k, value: String(oldProps[k]).slice(0, 200) });
  }

  return changes;
}

function formatNextDataChanges(changes) {
  if (changes.length === 0) return "";
  const lines = ["**📋 __NEXT_DATA__ 变更：**"];
  for (const c of changes.slice(0, 30)) {
    switch (c.type) {
      case "buildId":
        lines.push(`  🔄 Build ID: \`${c.old}\` → \`${c.new}\``); break;
      case "page":
        lines.push(`  📄 路由: \`${c.old}\` → \`${c.new}\``); break;
      case "locale":
        lines.push(`  🌐 locale: ${JSON.stringify(c.old)} → ${JSON.stringify(c.new)}`); break;
      case "locales":
        lines.push(`  🌐 locales: ${JSON.stringify(c.old)} → ${JSON.stringify(c.new)}`); break;
      case "runtimeConfig.added":
        lines.push(`  🟢 配置新增 \`${c.key}\`: ${c.value}`); break;
      case "runtimeConfig.changed":
        lines.push(`  ✏️ 配置变更 \`${c.key}\`: ${c.old} → ${c.new}`); break;
      case "runtimeConfig.removed":
        lines.push(`  🔴 配置移除 \`${c.key}\`: ${c.value}`); break;
      case "props.added":
        lines.push(`  🟢 新增 \`${c.key}\`: ${c.value}`); break;
      case "props.changed":
        lines.push(`  ✏️ 变更 \`${c.key}\`: ${c.old} → ${c.new}`); break;
      case "props.removed":
        lines.push(`  🔴 移除 \`${c.key}\`: ${c.value}`); break;
    }
  }
  if (changes.length > 30) lines.push(`  ... 还有 ${changes.length - 30} 处变更`);
  return lines.join("\n");
}

/* ── i18n 国际化监控 ── */

/**
 * 从 JS chunk 中提取 i18n 语言包（兼容双语言包格式）
 * 优先提取中文包（包含中文字符的那个），fallback 取最后一个块
 */
function parseI18nFromChunk(jsContent) {
  // 提取所有 JSON.parse('...') 块
  const blocks = [];
  let searchFrom = 0;
  while (true) {
    const idx = jsContent.indexOf("JSON.parse('", searchFrom);
    if (idx === -1) break;
    const start = idx + 12;
    let end = start;
    let escaped = false;
    for (let i = start; i < jsContent.length; i++) {
      if (escaped) { escaped = false; continue; }
      if (jsContent[i] === "\\") { escaped = true; continue; }
      if (jsContent[i] === "'") { end = i; break; }
    }
    if (end > start) {
      blocks.push(jsContent.slice(start, end));
    }
    searchFrom = end + 1;
  }
  if (blocks.length === 0) return null;

  // 优先选包含中文字符的块
  // 注意：中文可能是原始 UTF-8 字符，也可能是 \uXXXX 转义形式
  const hasChinese = (raw) => {
    if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(raw.slice(0, 3000))) return true;
    const escapeMatch = raw.slice(0, 5000).match(/\\u([0-9a-fA-F]{4})/g);
    if (escapeMatch) {
      for (const m of escapeMatch.slice(0, 50)) {
        const code = parseInt(m.slice(2), 16);
        if (code >= 0x4e00 && code <= 0x9fff) return true;
      }
    }
    return false;
  };
  for (const raw of blocks) {
    if (hasChinese(raw)) {
      const parsed = _parseRawI18nString(raw);
      if (_isValidI18nObject(parsed)) {
        return parsed;
      }
    }
  }
  // fallback: 从后往前找有效 i18n 对象
  for (let i = blocks.length - 1; i >= 0; i--) {
    const parsed = _parseRawI18nString(blocks[i]);
    if (_isValidI18nObject(parsed)) {
      return parsed;
    }
  }
  return null;
}

/**
 * 验证解析结果是否为合法的 i18n 对象（排除 ABI 数组、合约数据等）
 */
function _isValidI18nObject(parsed) {
  if (!parsed || typeof parsed !== "object") return false;
  if (Array.isArray(parsed)) return false;
  const keys = Object.keys(parsed);
  if (keys.length < 10) return false;
  const numericKeyRatio = keys.filter(k => /^\d+$/.test(k)).length / keys.length;
  if (numericKeyRatio > 0.5) return false;
  let stringOrObjCount = 0;
  for (const v of Object.values(parsed).slice(0, 20)) {
    if (typeof v === "string" || (typeof v === "object" && v !== null && !Array.isArray(v))) stringOrObjCount++;
  }
  return stringOrObjCount / Math.min(keys.length, 20) > 0.5;
}

/** 解析 JS 字符串转义后的 JSON 原始文本 */
function _parseRawI18nString(raw) {
  // raw 是 JS 单引号字符串内容，需转为合法 JSON
  // 处理顺序：先处理 \\\\ → PLACEHOLDER → 处理其他 → 还原为 \\
  // 这样 \\" 不会被错误处理
  const BACKSLASH_PLACEHOLDER = "\x00BS\x00";
  raw = raw.replace(/\\\\/g, BACKSLASH_PLACEHOLDER);
  raw = raw.replace(/\\'/g, "'");
  raw = raw.replace(/\\"/g, '"');
  raw = raw.replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  raw = raw.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  // 还原占位符为 JSON 合法的转义反斜杠
  raw = raw.replace(/\x00BS\x00/g, "\\\\");
  try { return JSON.parse(raw); } catch {
    try {
      raw = raw.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\r/g, "\r");
      return JSON.parse(raw);
    } catch { return null; }
  }
}

/**
 * 从 Next.js streaming HTML 中提取 i18n 翻译（适配 four.meme App Router 架构）
 * 匹配 self.__next_f.push 中的 "resources":{"common":{...},...} 结构
 * 返回 { i18nStrings: {flatKey: value}, i18nHash: string } 或 null
 */
function extractI18nFromStreamingHtml(html) {
  // 策略：在所有 self.__next_f.push 数据中搜索 "resources" 对象
  // 数据格式：self.__next_f.push([1,"...\"resources\":{\"common\":{...}}..."])
  const pushPattern = /self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g;
  let combinedData = "";
  let m;
  while ((m = pushPattern.exec(html)) !== null) {
    const chunk = m[1];
    // 只处理包含 resources 的 chunk
    if (chunk.includes('\\"resources\\"') || chunk.includes('"resources"')) {
      combinedData += chunk;
    }
  }
  if (!combinedData) return null;

  // 解转义（注意：\\\\ 必须最先处理，否则 \\" 会被错误匹配）
  // 不转换 \n \t 为实际控制字符，JSON.parse 原生支持这些转义序列
  let unescaped = combinedData
    .replace(/\\\\/g, "\\")
    .replace(/\\"/g, '"');

  // 提取 "resources":{...} 对象
  const resIdx = unescaped.indexOf('"resources":{');
  if (resIdx === -1) return null;

  // 从 "resources":{ 开始找到匹配的 } 闭合
  const objStart = resIdx + '"resources":'.length;
  let depth = 0;
  let objEnd = objStart;
  for (let i = objStart; i < unescaped.length; i++) {
    if (unescaped[i] === "{") depth++;
    if (unescaped[i] === "}") {
      depth--;
      if (depth === 0) { objEnd = i + 1; break; }
    }
    // 跳过字符串内容
    if (unescaped[i] === '"') {
      i++;
      while (i < unescaped.length && unescaped[i] !== '"') {
        if (unescaped[i] === "\\") i++;
        i++;
      }
    }
  }
  if (depth !== 0) return null;

  const resourcesJson = unescaped.slice(objStart, objEnd);
  try {
    // 防御：将可能残留的控制字符重新转义为 JSON 合法形式
    const sanitized = resourcesJson.replace(/[\x00-\x1f]/g, (ch) => {
      const map = {'\n': '\\n', '\r': '\\r', '\t': '\\t', '\b': '\\b', '\f': '\\f'};
      return map[ch] || `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
    });
    const resources = JSON.parse(sanitized);
    // resources 结构：{ common: {...}, detail: {...}, create: {...}, ... }
    // 展平所有 namespace
    const allStrings = {};
    for (const [namespace, content] of Object.entries(resources)) {
      if (typeof content === "object" && content !== null) {
        const flat = flattenI18n(content, namespace);
        Object.assign(allStrings, flat);
      }
    }
    if (Object.keys(allStrings).length < 20) return null;
    // 日志移至调用方，仅在 hash 变化时输出，避免每轮重复刷屏
    // 排序 keys 后再生成 hash，避免 namespace 遍历顺序变化导致假阳性
    // 使用归一化值计算 hash，过滤 RSC 指针编号抖动
    const sortedKeys = Object.keys(allStrings).sort();
    const sortedObj = {};
    for (const k of sortedKeys) sortedObj[k] = normalizeI18nValue(allStrings[k]);
    return { i18nStrings: allStrings, i18nHash: md5(JSON.stringify(sortedObj)) };
  } catch (err) {
    log(`  [i18n] streaming 解析失败：${err.message}`);
    return null;
  }
}

function flattenI18n(obj, prefix) {
  const result = {};
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return result;
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? prefix + "." + k : k;
    if (typeof v === "string") result[path] = v;
    else if (typeof v === "object" && v !== null && !Array.isArray(v)) Object.assign(result, flattenI18n(v, path));
  }
  return result;
}

async function fetchI18nStrings(assetUrlMap, baseUrl = "https://four.meme") {
  // 注意：i18n 解析需要原始 JS 源码（搜索 JSON.parse('...')），
  // 而 downloadAssetContents 只保留了提取后的 strings/hash，无法复用。
  // 因此这里需要单独下载 chunk 候选文件。
  const candidateUrls = [];
  if (assetUrlMap instanceof Map) {
    for (const [, url] of assetUrlMap) {
      if (/\/chunks\/\d+-[a-f0-9]+\.js$/i.test(url)) candidateUrls.push(url);
    }
  }
  if (candidateUrls.length === 0) return null;

  const tasks = candidateUrls.map(async (url, idx) => {
    await sleep(idx * 100);  // stagger
    try {
      const res = await fetchSafe(url, { headers: browserHeaders() }, 8_000);
      if (!res.ok) return null;
      const jsContent = await res.text();
      if (!jsContent.includes("JSON.parse('")) return null;
      const data = parseI18nFromChunk(jsContent);
      if (!data || typeof data !== "object") return null;
      const strings = flattenI18n(data, "");
      if (Object.keys(strings).length < 20) return null;
      // 排序 keys 确保 hash 确定性，归一化值过滤 RSC 指针抖动
      const sortedKeys = Object.keys(strings).sort();
      const sortedObj = {};
      for (const k of sortedKeys) sortedObj[k] = normalizeI18nValue(strings[k]);
      return { i18nStrings: strings, i18nHash: md5(JSON.stringify(sortedObj)), i18nChunk: url };
    } catch { return null; }
  });

  const results = await Promise.allSettled(tasks);
  // 选择包含最多翻译键的结果（而非第一个），避免返回不完整的子集
  let best = null;
  for (const r of results) {
    if (r.status === "fulfilled" && r.value) {
      if (!best || Object.keys(r.value.i18nStrings).length > Object.keys(best.i18nStrings).length) {
        best = r.value;
      }
    }
  }
  if (best) {
    const chunkName = best.i18nChunk.split("/").pop();
    log(`  [i18n] 从 ${chunkName} 提取到 ${Object.keys(best.i18nStrings).length} 个 UI 字符串`);
    return best;
  }
  return null;
}

/**
 * 归一化 i18n 值：将 React Server Components 内部序列化指针 ($11, $L12, $Sreact.suspense 等)
 * 替换为统一占位符，避免 SSR 渲染时指针编号抖动产生假阳性 diff。
 * 只归一化 $+数字 和 $L+数字 形式（RSC 引用指针），保留 $100 这种可能是真实金额的模式。
 * 判断依据：如果 $ 后跟 1-3 位数字且前后无其他数字/字母上下文，视为 RSC 指针。
 */
function normalizeI18nValue(value) {
  if (typeof value !== "string") return value;
  // $L11, $L12 等 RSC lazy 引用 → $L_REF
  // $11, $12 等 RSC chunk 引用（仅匹配独立出现的，如 "$11" 或 "...$11..."，排除 "$100.00" 这种金额）
  return value
    .replace(/\$L\d{1,4}/g, "$L_REF")
    .replace(/\$S[a-z][a-z0-9.]+/g, "$S_REF")
    .replace(/(?<![0-9.])\$(\d{1,3})(?!\d|\.?\d)/g, "$_REF");
}

function diffI18nStrings(oldStrings, newStrings) {
  if (!oldStrings || !newStrings) return [];
  const changes = [];
  const oldKeys = new Set(Object.keys(oldStrings));
  const newKeys = new Set(Object.keys(newStrings));
  for (const key of oldKeys) {
    if (newKeys.has(key) && oldStrings[key] !== newStrings[key]) {
      // 归一化后再比较：过滤 RSC 指针编号抖动
      const oldNorm = normalizeI18nValue(oldStrings[key]);
      const newNorm = normalizeI18nValue(newStrings[key]);
      if (oldNorm !== newNorm) {
        changes.push({ type: "modified", key, oldValue: oldStrings[key], newValue: newStrings[key] });
      }
    }
  }
  for (const key of newKeys) {
    if (!oldKeys.has(key)) changes.push({ type: "added", key, value: newStrings[key] });
  }
  for (const key of oldKeys) {
    if (!newKeys.has(key)) changes.push({ type: "removed", key, value: oldStrings[key] });
  }
  return changes;
}

function formatI18nChanges(changes) {
  if (changes.length === 0) return "";
  const added = changes.filter(c => c.type === "added");
  const modified = changes.filter(c => c.type === "modified");
  const removed = changes.filter(c => c.type === "removed");

  const lines = [`**📝 UI 文案（i18n）变更：** 新增 ${added.length} | 修改 ${modified.length} | 删除 ${removed.length}`];

  // 提取短 key（取最后两段）
  const shortKey = (key) => {
    const parts = key.split(".");
    return parts.length > 2 ? parts.slice(-2).join(".") : key;
  };
  // 截断值
  const clip = (s, max = 60) => s && s.length > max ? s.slice(0, max) + "…" : (s || "");

  if (added.length > 0) {
    lines.push("");
    for (const c of added.slice(0, 20)) {
      lines.push(`  🟢 \`${shortKey(c.key)}\` ${clip(c.value, 70)}`);
    }
    if (added.length > 20) lines.push(`  ... 还有 ${added.length - 20} 条新增`);
  }
  if (modified.length > 0) {
    lines.push("");
    for (const c of modified.slice(0, 10)) {
      lines.push(`  ✏️ \`${shortKey(c.key)}\` ${clip(c.oldValue, 30)} → ${clip(c.newValue, 30)}`);
    }
    if (modified.length > 10) lines.push(`  ... 还有 ${modified.length - 10} 条修改`);
  }
  if (removed.length > 0) {
    lines.push("");
    for (const c of removed.slice(0, 10)) {
      lines.push(`  🔴 \`${shortKey(c.key)}\` ${clip(c.value, 50)}`);
    }
    if (removed.length > 10) lines.push(`  ... 还有 ${removed.length - 10} 条删除`);
  }
  return lines.join("\n");
}

/* ── 路由/端点发现 ── */

function extractRoutes(html, assetContents, nextData) {
  const routes = new Set();

  // 1. 从已解析的 __NEXT_DATA__ 中提取页面路由和 manifest
  if (nextData) {
    if (nextData.page) {
      const pageRoute = normalizeRouteString(nextData.page).split("?")[0];
      if (isTrackableRouteString(pageRoute)) routes.add(pageRoute);
    }
    if (nextData.props?.pageProps?.pages) {
      for (const p of nextData.props.pageProps.pages) {
        const pageRoute = normalizeRouteString(p).split("?")[0];
        if (isTrackableRouteString(pageRoute)) routes.add(pageRoute);
      }
    }
  }

  // 2. 从 HTML 中提取内部链接（排除静态资源路径）
  const hrefRe = /\bhref=["']([^"']+)["']/g;
  let m;
  while ((m = hrefRe.exec(html)) !== null) {
    const path = normalizeRouteString(m[1]).split("?")[0];
    if (isTrackableRouteString(path)) {
      routes.add(path);
    }
  }

  // 3. 从 JS 资源字符串中提取路由模式和 API 端点
  if (assetContents) {
    for (const [, data] of Object.entries(assetContents)) {
      if (!data.strings) continue;
      for (const s of data.strings) {
        const normalized = normalizeRouteString(s);
        if (!normalized) continue;
        // Next.js 页面路由: /xxx or /xxx/[param]
        if (/^\/[a-zA-Z][\w-]*(\/[\w[\]-]*)*$/.test(normalized) && normalized.length < 100 && isTrackableRouteString(normalized)) {
          routes.add(normalized);
        }
        // API 端点: /api/xxx, /meme-api/xxx, /mapi/xxx, /v1/xxx, /blog/v1/xxx
        if (isApiOrEndpointRoute(normalized) && normalized.length < 220) {
          routes.add(normalized);
        }
      }
    }
  }

  return [...routes].sort();
}

function diffRoutes(oldRoutes, newRoutes) {
  const cleanOldRoutes = sanitizeRouteListForDiff(oldRoutes);
  const cleanNewRoutes = sanitizeRouteListForDiff(newRoutes);
  if (!cleanNewRoutes.length) return { added: [], removed: [] };
  if (!cleanOldRoutes.length) return { added: cleanNewRoutes, removed: [] };
  const oldSet = new Set(cleanOldRoutes);
  const newSet = new Set(cleanNewRoutes);
  const added = cleanNewRoutes.filter(r => !oldSet.has(r));
  let removed = cleanOldRoutes.filter(r => !newSet.has(r));
  // SSR 抖动保护：如果路由只有移除、没有新增，且移除数量较少（≤3），
  // 很可能是 SSR/CDN 边缘节点返回了不完整的 HTML 导致部分 href 未被渲染。
  // 此时忽略移除，避免假阳性。真实的路由删除通常伴随新路由的新增（重构）
  // 或大批量移除（下线功能），不会只少 1-2 个。
  if (removed.length > 0 && removed.length <= 3 && added.length === 0) {
    log(`[路由] 忽略疑似 SSR 抖动：${removed.length} 个路由短暂消失 (${removed.join(", ")})`);
    removed = [];
  }
  return { added, removed };
}

function sanitizeRouteListForDiff(routes) {
  return [...new Set((routes || [])
    .map(route => normalizeRouteString(route).split("?")[0].replace(/\/+$/, "") || "/")
    .filter(route => isApiOrEndpointRoute(route) || isTrackableRouteString(route))
  )].sort();
}

function formatRouteChanges(routeDiff) {
  const hasChanges = (routeDiff.added?.length > 0) || (routeDiff.removed?.length > 0);
  if (!hasChanges) return "";
  const lines = ["**🗺️ 路由/端点变更：**"];
  for (const r of (routeDiff.added || []).slice(0, 20)) {
    lines.push(`  🟢 新增: \`${r}\``);
  }
  if ((routeDiff.added || []).length > 20) lines.push(`  ... 还有 ${routeDiff.added.length - 20} 个新增`);
  for (const r of (routeDiff.removed || []).slice(0, 20)) {
    lines.push(`  🔴 移除: \`${r}\``);
  }
  if ((routeDiff.removed || []).length > 20) lines.push(`  ... 还有 ${routeDiff.removed.length - 20} 个移除`);
  return lines.join("\n");
}

/**
 * 第一层：纯 HTML 解析，零网络请求。
 * 从 HTML 中提取所有可离线分析的特征（资源文件列表、文案、nextData 等）。
 * 类似 Flap 的 extractPageFeatures()。
 */
function extractPageFeatures(html, url) {
  const baseUrl = new URL(url).origin;
  const features = {
    assetFiles: [],   // 排序后的资源路径列表（不含 query）
    assetHash: null,  // 资源路径列表的 md5（轻量级变更检测）
    assetUrlMap: new Map(), // filename -> full url（供后续下载用）
    contentHash: null,
    textContent: null,
    nextData: null,
    nextDataHash: null,
    html,             // 保留原始 HTML 供路由提取等用
  };

  // __NEXT_DATA__
  features.nextData = extractNextData(html);
  if (features.nextData) features.nextDataHash = md5(JSON.stringify(features.nextData));

  // 资源文件列表（从 HTML 标签提取，支持 _next/static 和 CDN 路径）
  const assetMatches = html.matchAll(/(?:src|href)=["']((?:https?:\/\/[^"']*?)?\/\_next\/static\/[^"']+\.(?:js|css)(?:\?[^"']*)?)["']/g);
  const pathSet = new Set();
  for (const m of assetMatches) {
    const raw = m[1];
    const fullUrl = raw.startsWith("http") ? raw : baseUrl + raw;
    const cleanUrl = fullUrl.split("?")[0];
    const path = cleanUrl.replace(baseUrl, "");
    pathSet.add(path);
    const filename = cleanUrl.split("/").pop();
    features.assetUrlMap.set(filename, cleanUrl);
  }
  features.assetFiles = [...pathSet].sort();
  features.assetHash = md5(features.assetFiles.join("\n"));

  // 页面文案
  features.textContent = extractTextContent(html);
  features.contentHash = md5(features.textContent);

  return features;
}

/**
 * 抓取单个页面：HTML 解析 + 按需下载资源。
 * oldFeatures: 上一轮的快照数据（用于 assetHash 比对决定是否跳过下载）
 */
async function fetchFrontendData(url, oldFeatures = null, assetCache = null) {
  let features = null;
  try {
    const res = await fetchSafe(url, { headers: browserHeaders() });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const html = await res.text();
    if (html.length < 1000) throw new Error(`响应过短（${html.length} 字节），可能被拦截`);

    // 第一层：纯解析
    features = extractPageFeatures(html, url);
  } catch (err) {
    log(`  [${urlLabel(url)}] HTML 抓取失败：${err.message}`);
    return null; // 明确返回 null 表示抓取失败
  }

  // 第二层：按需下载资源（仅当 assetHash 变化时）
  const baseUrl = new URL(url).origin;
  if (oldFeatures && oldFeatures.assetHash === features.assetHash && oldFeatures.assetContents) {
    // assetHash 未变 → 复用缓存，跳过下载
    features.assetContents = oldFeatures.assetContents;
    // i18n: 每次都从 streaming HTML 重新提取，因为 i18n 可能随 SSR 内容变化而非静态资源变化
    try {
      let i18nResult = extractI18nFromStreamingHtml(features.html);
      if (!i18nResult) {
        // 仅当 streaming HTML 未提取到时才 fallback 到旧缓存或重新从 chunk 获取
        if (oldFeatures.i18nHash) {
          features.i18nStrings = oldFeatures.i18nStrings;
          features.i18nHash = oldFeatures.i18nHash;
        } else {
          i18nResult = await fetchI18nStrings(features.assetUrlMap, baseUrl);
        }
      }
      if (i18nResult) {
        features.i18nStrings = i18nResult.i18nStrings;
        features.i18nHash = i18nResult.i18nHash;
        // 仅在 hash 变化或首次提取时输出日志
        if (!oldFeatures.i18nHash || oldFeatures.i18nHash !== i18nResult.i18nHash) {
          log(`  [i18n] 从 streaming HTML 提取到 ${Object.keys(i18nResult.i18nStrings).length} 个翻译字符串（${!oldFeatures.i18nHash ? '首次' : 'hash 变化'}）`);
        }
      }
    } catch (err) { log(`  [i18n] 提取异常（非致命）：${err.message}`); }
  } else {
    // assetHash 变了（或首次）→ 下载资源
    try {
      features.assetContents = await downloadAssetContents(features.assetUrlMap, assetCache);
    } catch (err) {
      features.assetContents = null;
      log(`  [${urlLabel(url)}] 资源下载异常：${err.message}`);
    }
    // 提取 i18n（优先从 streaming HTML 中直接获取中文翻译）
    try {
      let i18nResult = extractI18nFromStreamingHtml(features.html);
      if (!i18nResult) {
        // fallback: 尝试从 JS chunk 中提取
        i18nResult = await fetchI18nStrings(features.assetUrlMap, baseUrl);
      }
      if (i18nResult) {
        features.i18nStrings = i18nResult.i18nStrings;
        features.i18nHash = i18nResult.i18nHash;
        log(`  [i18n] 从 streaming HTML 提取到 ${Object.keys(i18nResult.i18nStrings).length} 个翻译字符串（资源更新/首次）`);
      }
    } catch (err) { log(`  [i18n] 提取异常（非致命）：${err.message}`); }
  }

  // 提取路由/端点（利用 HTML + nextData，assetContents 为可选增强）
  features.routes = extractRoutes(features.html, features.assetContents, features.nextData);

  // 清除不需要持久化的大字段
  delete features.html;
  delete features.assetUrlMap; // Map 不可序列化

  return features;
}

/**
 * 并行扫描所有监控页面（加随机延迟错开请求，降低同一 IP 并发触发风控的风险）
 * oldPages: 上一轮的快照（用于 assetHash 缓存决策）
 */
async function fetchAllFrontendData(oldPages = {}, urls = getFrontendMonitorUrls(), assetCache = null) {
  const pages = {};
  const failedUrls = [];
  const tasks = urls.map((url, i) => {
    return sleep(i * 300).then(async () => {  // 每个页面错开 300ms
      const key = urlToKey(url);
      const oldFeatures = oldPages[key] || null;
      const data = await fetchFrontendData(url, oldFeatures, assetCache);
      if (!data) { failedUrls.push(url); return { key, data: null }; } // HTML 抓取失败
      return { key, data: { ...data, originalUrl: url } };
    });
  });
  const results = await Promise.allSettled(tasks);
  for (const r of results) {
    if (r.status === "fulfilled" && r.value.data) {
      pages[r.value.key] = r.value.data;
    }
  }
  return { pages, failedUrls };
}

async function fetchFrontendDataWithDiscovery(oldPages = {}) {
  const assetCache = new Map();
  const baseUrls = getFrontendMonitorUrls();
  const result = await fetchAllFrontendData(oldPages, baseUrls, assetCache);
  const knownUrls = new Set([
    ...baseUrls,
    ...Object.values(result.pages).map(p => p.originalUrl),
  ].map(canonicalFrontendUrl));
  const allDiscoveredUrls = [];

  for (let depth = 0; depth < 2; depth++) {
    const discoveredUrls = discoverFrontendUrlsFromPages(result.pages, [...knownUrls]);
    if (discoveredUrls.length === 0) break;
    log(`[前端] 自动发现 ${discoveredUrls.length} 个新页面，立即纳入本轮抓取：${discoveredUrls.map(urlLabel).join(", ")}`);
    for (const url of discoveredUrls) knownUrls.add(canonicalFrontendUrl(url));
    const extra = await fetchAllFrontendData(oldPages, discoveredUrls, assetCache);
    Object.assign(result.pages, extra.pages);
    if (extra.failedUrls.length > 0) {
      log(`[前端] 自动发现候选页抓取失败，未纳入监控：${extra.failedUrls.map(urlLabel).join(", ")}`);
    }
    allDiscoveredUrls.push(...discoveredUrls.filter(url => extra.pages[urlToKey(url)]));
  }

  result.discoveredUrls = allDiscoveredUrls;
  return result;
}

/**
 * 计算两个字符串数组的 Jaccard 相似度 (0~1)
 */
function jaccard(a, b) {
  if (!a.length && !b.length) return 1;
  const setA = new Set(a);
  const setB = new Set(b);
  let inter = 0;
  for (const s of setA) if (setB.has(s)) inter++;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 1 : inter / union;
}

/**
 * 内容级前端资源 diff
 *
 * 匹配策略：
 *   1. 文件名相同且 contentHash 相同 → 无变化（跳过）
 *   2. 文件名相同但 contentHash 不同 → 直接配对为「修改」
 *   3. 剩余文件按 contentHash 精确匹配 → 同内容重命名（跳过）
 *   4. 剩余文件按 strings Jaccard > 0.4 最优匹配 → 配对为「修改」
 *   5. 未匹配 → 新增 / 移除
 *
 * 返回: { matched, added, removed, unchanged, renamed }
 *   matched: [{ oldFile, newFile, addedStrings, removedStrings }]
 */
function diffFrontendAssets(oldAssets, newAssets) {
  oldAssets = oldAssets || {};
  newAssets = newAssets || {};
  const result = { matched: [], added: [], removed: [], unchanged: 0, renamed: 0 };

  const unmatchedOld = new Map(); // filename -> asset data
  const unmatchedNew = new Map();

  // Phase 1: 同名文件
  for (const [file, newData] of Object.entries(newAssets)) {
    if (file in oldAssets) {
      if (oldAssets[file].contentHash === newData.contentHash) {
        result.unchanged++;
      } else {
        // 同名但内容变了
        const oldStrSet = new Set(oldAssets[file].strings || []);
        const newStrSet = new Set(newData.strings || []);
        const addedStrings = (newData.strings || []).filter(s => !oldStrSet.has(s));
        const removedStrings = (oldAssets[file].strings || []).filter(s => !newStrSet.has(s));
        result.matched.push({ oldFile: file, newFile: file, addedStrings, removedStrings });
      }
    } else {
      unmatchedNew.set(file, newData);
    }
  }
  for (const [file, oldData] of Object.entries(oldAssets)) {
    if (!(file in newAssets)) {
      unmatchedOld.set(file, oldData);
    }
  }

  // Phase 2: contentHash 精确匹配（同内容换了文件名）
  const oldByHash = new Map();
  for (const [file, data] of unmatchedOld) {
    if (data.contentHash) {
      if (!oldByHash.has(data.contentHash)) oldByHash.set(data.contentHash, []);
      oldByHash.get(data.contentHash).push(file);
    }
  }
  for (const [newFile, newData] of [...unmatchedNew]) {
    if (newData.contentHash && oldByHash.has(newData.contentHash)) {
      const candidates = oldByHash.get(newData.contentHash);
      if (candidates.length > 0) {
        const oldFile = candidates.shift();
        unmatchedOld.delete(oldFile);
        unmatchedNew.delete(newFile);
        result.renamed++;
        if (candidates.length === 0) oldByHash.delete(newData.contentHash);
      }
    }
  }

  // Phase 2.5: webpack chunk ID 前缀匹配（如 6538-xxx.js → 6538-yyy.js）
  // 同一 chunk ID 的文件即使内容差异大（Jaccard < 0.4）也应配对
  if (unmatchedOld.size > 0 && unmatchedNew.size > 0) {
    const chunkIdRe = /^(\d+)-[a-f0-9]+\.(js|css)$/;
    // 按 chunk ID 分组旧文件
    const oldByChunk = new Map(); // "chunkId.ext" -> [filename]
    for (const [file] of unmatchedOld) {
      const m = chunkIdRe.exec(file);
      if (m) {
        const key = m[1] + "." + m[2];
        if (!oldByChunk.has(key)) oldByChunk.set(key, []);
        oldByChunk.get(key).push(file);
      }
    }
    for (const [newFile, newData] of [...unmatchedNew]) {
      const m = chunkIdRe.exec(newFile);
      if (!m) continue;
      const key = m[1] + "." + m[2];
      const candidates = oldByChunk.get(key);
      if (!candidates || candidates.length === 0) continue;
      const oldFile = candidates.shift();
      if (candidates.length === 0) oldByChunk.delete(key);
      const oldData = unmatchedOld.get(oldFile);
      // contentHash 相同 → 仅重命名
      if (oldData.contentHash === newData.contentHash) {
        result.renamed++;
      } else {
        const oldStrSet = new Set(oldData.strings || []);
        const newStrSet = new Set(newData.strings || []);
        result.matched.push({
          oldFile, newFile,
          addedStrings: (newData.strings || []).filter(s => !oldStrSet.has(s)),
          removedStrings: (oldData.strings || []).filter(s => !newStrSet.has(s)),
        });
      }
      unmatchedOld.delete(oldFile);
      unmatchedNew.delete(newFile);
    }
  }

  // Phase 3: strings Jaccard 最优匹配
  if (unmatchedOld.size > 0 && unmatchedNew.size > 0) {
    const pairs = [];
    for (const [newFile, newData] of unmatchedNew) {
      for (const [oldFile, oldData] of unmatchedOld) {
        // 只匹配同类型文件
        const newExt = newFile.endsWith(".css") ? "css" : "js";
        const oldExt = oldFile.endsWith(".css") ? "css" : "js";
        if (newExt !== oldExt) continue;
        const sim = jaccard(oldData.strings || [], newData.strings || []);
        if (sim > 0.4) pairs.push({ oldFile, newFile, sim });
      }
    }
    // 贪心匹配：按相似度降序
    pairs.sort((a, b) => b.sim - a.sim);
    const usedOld = new Set();
    const usedNew = new Set();
    for (const p of pairs) {
      if (usedOld.has(p.oldFile) || usedNew.has(p.newFile)) continue;
      usedOld.add(p.oldFile);
      usedNew.add(p.newFile);
      const oldData = unmatchedOld.get(p.oldFile);
      const newData = unmatchedNew.get(p.newFile);
      const oldStrSet = new Set(oldData.strings || []);
      const newStrSet = new Set(newData.strings || []);
      const addedStrings = (newData.strings || []).filter(s => !oldStrSet.has(s));
      const removedStrings = (oldData.strings || []).filter(s => !newStrSet.has(s));
      result.matched.push({ oldFile: p.oldFile, newFile: p.newFile, addedStrings, removedStrings });
      unmatchedOld.delete(p.oldFile);
      unmatchedNew.delete(p.newFile);
    }
  }

  // Phase 4: 剩余 → 新增 / 移除
  result.added = [...unmatchedNew.keys()];
  result.removed = [...unmatchedOld.keys()];

  return result;
}

function diffTextContent(oldText, newText) {
  if (!oldText || !newText) return null;
  if (oldText === newText) return null;
  const split = (text) => {
    const segments = text.split(/(?<=[.!?。！？])\s+/).map(s => s.trim()).filter(s => s.length > 0);
    if (segments.length <= 1) return text.split(/\s+/).filter(s => s.length > 0);
    return segments;
  };
  const oldParts = split(oldText);
  const newParts = split(newText);
  const oldSet = new Set(oldParts);
  const newSet = new Set(newParts);
  const rawAdded = newParts.filter(s => !oldSet.has(s));
  const rawRemoved = oldParts.filter(s => !newSet.has(s));
  if (rawAdded.length === 0 && rawRemoved.length === 0) return { changes: [], reordered: true };
  const changes = [];
  const matchedAdded = new Set();
  const matchedRemoved = new Set();
  for (let ri = 0; ri < rawRemoved.length; ri++) {
    const rWords = rawRemoved[ri].split(/\s+/);
    let bestMatch = -1, bestScore = 0;
    for (let ai = 0; ai < rawAdded.length; ai++) {
      if (matchedAdded.has(ai)) continue;
      const aWords = rawAdded[ai].split(/\s+/);
      const rSet = new Set(rWords);
      const common = aWords.filter(w => rSet.has(w)).length;
      const score = common / Math.max(rWords.length, aWords.length);
      if (score > bestScore && score > 0.6) { bestScore = score; bestMatch = ai; }
    }
    if (bestMatch >= 0) {
      const aWords = rawAdded[bestMatch].split(/\s+/);
      const rSet = new Set(rWords);
      const aSet = new Set(aWords);
      changes.push({
        type: "modified",
        summary: `"${rWords.filter(w => !aSet.has(w)).join(" ")}" → "${aWords.filter(w => !rSet.has(w)).join(" ")}"`,
        oldText: rawRemoved[ri].length > 80 ? rawRemoved[ri].slice(0, 80) + "..." : rawRemoved[ri],
        newText: rawAdded[bestMatch].length > 80 ? rawAdded[bestMatch].slice(0, 80) + "..." : rawAdded[bestMatch],
      });
      matchedAdded.add(bestMatch);
      matchedRemoved.add(ri);
    }
  }
  for (let ai = 0; ai < rawAdded.length; ai++) {
    if (!matchedAdded.has(ai)) changes.push({ type: "added", text: rawAdded[ai] });
  }
  for (let ri = 0; ri < rawRemoved.length; ri++) {
    if (!matchedRemoved.has(ri)) changes.push({ type: "removed", text: rawRemoved[ri] });
  }
  return { changes, reordered: false };
}

// ── 业务关键词检测器（用于字符串和文件分类） ──
const BUSINESS_MATCHERS = [
  { pattern: /Vault/i,            label: "Vault" },
  { pattern: /Dividend/i,         label: "Dividend" },
  { pattern: /DividendBps/i,      label: "DividendBps" },
  { pattern: /constraints/i,      label: "Constraints" },
  { pattern: /enabled\s*[:=]/i,   label: "Enabled" },
  { pattern: /showInCAStore/i,    label: "CAStore展示" },
  { pattern: /quickAmounts/i,     label: "QuickAmounts" },
  { pattern: /usePermit/i,        label: "UsePermit" },
  { pattern: /fee[sS]?[\s:=]/i,  label: "Fee(费率)" },
  { pattern: /Staking/i,          label: "Staking" },
  { pattern: /Lista/i,            label: "Lista" },
  { pattern: /SwapRouter/i,       label: "SwapRouter" },
  { pattern: /TokenManager/i,     label: "TokenManager" },
  { pattern: /create-token/i,     label: "创建代币" },
  { pattern: /agentic/i,          label: "Agentic" },
  { pattern: /announcement/i,     label: "公告" },
  { pattern: /\/v1\//i,           label: "API端点" },
  { pattern: /\/docs\//i,         label: "文档路由" },
];

function matchBusinessKeywords(text) {
  const hits = new Set();
  for (const m of BUSINESS_MATCHERS) {
    if (m.pattern.test(text)) hits.add(m.label);
  }
  return [...hits];
}

function assetDiffSignature(assetDiff) {
  if (!assetDiff) return "";
  const normalize = (list) => [...(list || [])].sort();
  const matched = (assetDiff.matched || [])
    .map(m => `${m.oldFile || ""}->${m.newFile || ""}`)
    .sort();
  return JSON.stringify({
    added: normalize(assetDiff.added),
    removed: normalize(assetDiff.removed),
    matched,
  });
}

function isSmallAssetListOnlyDiff(assetDiff) {
  if (!assetDiff) return false;
  const matchedCount = (assetDiff.matched || []).length;
  const addedCount = (assetDiff.added || []).length;
  const removedCount = (assetDiff.removed || []).length;
  const touchedCount = addedCount + removedCount;
  return matchedCount === 0
    && touchedCount > 0
    && touchedCount <= CONFIG.frontendAssetJitter.maxFiles;
}

function computeFrontendAssetDiff(oldData, newData) {
  const hasOldContents = oldData?.assetContents && Object.keys(oldData.assetContents).length > 0;
  const hasNewContents = newData?.assetContents && Object.keys(newData.assetContents).length > 0;
  if (hasOldContents && hasNewContents) {
    return diffFrontendAssets(oldData.assetContents, newData.assetContents);
  }
  const oldSet = new Set(oldData?.assetFiles || []);
  const newSet = new Set(newData?.assetFiles || []);
  return {
    matched: [],
    added: [...newSet].filter(f => !oldSet.has(f)),
    removed: [...oldSet].filter(f => !newSet.has(f)),
    unchanged: 0,
    renamed: 0,
  };
}

async function maybeSuppressTransientAssetJitter(label, oldData, newData, assetDiff, hasNonAssetChange) {
  if (!isSmallAssetListOnlyDiff(assetDiff) || hasNonAssetChange) return { suppress: false };

  const fileSummary = [
    (assetDiff.added || []).length ? `新增 ${(assetDiff.added || []).length}` : "",
    (assetDiff.removed || []).length ? `移除 ${(assetDiff.removed || []).length}` : "",
  ].filter(Boolean).join("、");
  log(`[前端] ${label} 疑似资源列表抖动（${fileSummary}），${CONFIG.frontendAssetJitter.quickConfirmDelayMs}ms 后快速复抓确认`);

  await sleep(CONFIG.frontendAssetJitter.quickConfirmDelayMs);
  const fresh = await fetchFrontendData(newData.originalUrl, oldData);
  if (!fresh) {
    log(`[前端] ${label} 快速复抓失败，为避免漏报仍推送本轮资源变更`);
    return { suppress: false };
  }

  if (oldData.assetHash && fresh.assetHash === oldData.assetHash) {
    log(`[前端] ${label} 资源列表快速复抓已恢复，判定为 CDN/SSR 短暂抖动，静默忽略`);
    return { suppress: true };
  }

  const freshDiff = computeFrontendAssetDiff(oldData, fresh);
  const sameSignature = assetDiffSignature(freshDiff) === assetDiffSignature(assetDiff);
  log(`[前端] ${label} 快速复抓后仍存在资源变化${sameSignature ? "（签名一致）" : "（签名变化）"}，立即推送`);
  return { suppress: false };
}

function formatFrontendChanges(assetDiff, textDiff, pageLabel, oldAssets, newAssets) {
  const lines = [];
  const prefix = pageLabel ? `**📄 ${pageLabel}**` : "";
  if (prefix) lines.push(prefix);

  const hasAssetChanges = assetDiff &&
    (assetDiff.matched.length > 0 || assetDiff.added.length > 0 || assetDiff.removed.length > 0);

  if (hasAssetChanges) {
    // ── 概览统计 ──
    const parts = [];
    if (assetDiff.unchanged) parts.push(`不变 ${assetDiff.unchanged}`);
    if (assetDiff.renamed) parts.push(`重命名 ${assetDiff.renamed}`);
    if (assetDiff.matched.length) parts.push(`修改 ${assetDiff.matched.length}`);
    if (assetDiff.added.length) parts.push(`新增 ${assetDiff.added.length}`);
    if (assetDiff.removed.length) parts.push(`移除 ${assetDiff.removed.length}`);
    lines.push(`**📦 资源文件变更：** ${parts.join(" | ")}`);

    // ── 噪音过滤 + 实质/噪音分离（移植自 flap-monitor） ──
    const substantiveFiles = [];
    const noiseOnlyFiles = [];
    const allConfigDiffs = [];

    for (const m of assetDiff.matched) {
      const realAdded = (m.addedStrings || []).filter(s => !isNoiseString(s));
      const realRemoved = (m.removedStrings || []).filter(s => !isNoiseString(s));
      const totalNoise = (m.addedStrings.length - realAdded.length) + (m.removedStrings.length - realRemoved.length);
      const totalReal = realAdded.length + realRemoved.length;

      // 提取结构化配置变更
      const configDiffs = extractConfigDiffs(m.removedStrings, m.addedStrings);
      if (configDiffs.length > 0) {
        for (const cd of configDiffs) {
          allConfigDiffs.push({ ...cd, file: m.newFile || m.oldFile });
        }
      }

      if (totalReal === 0 && totalNoise > 0) {
        noiseOnlyFiles.push({ label: m.oldFile === m.newFile ? m.newFile : `${m.oldFile} → ${m.newFile}`, noise: totalNoise });
      } else if (totalReal > 0) {
        substantiveFiles.push({ ...m, realAdded, realRemoved, totalNoise, configDiffs });
      }
    }

    // ── 配置参数变更（结构化 key→value） ──
    if (allConfigDiffs.length > 0) {
      lines.push("");
      lines.push("**🔧 配置参数变更：**");
      for (const cd of allConfigDiffs) {
        lines.push(`  ${cd.field}: ${cd.oldVal} → ${cd.newVal}  (${cd.file})`);
      }
    }

    // ── 实质文件变更（过滤噪音后） ──
    let shownCount = 0;
    for (const m of substantiveFiles) {
      const totalReal = m.realAdded.length + m.realRemoved.length;
      if (totalReal === 0) continue;
      if (shownCount >= 8) continue;
      shownCount++;

      const label = m.oldFile === m.newFile ? m.newFile : `${m.oldFile} → ${m.newFile}`;
      const changeText = [...m.realAdded, ...m.realRemoved].join(" ");
      const kws = matchBusinessKeywords(changeText);
      const kwTag = kws.length > 0 ? `含: ${kws.join("、")}` : "";
      const noiseNote = m.totalNoise > 0 ? ` + ${m.totalNoise} 噪音已过滤` : "";
      lines.push("");
      lines.push(`**📝 ${label}** (${totalReal} 处实质变更${noiseNote}${kwTag ? "，" + kwTag : ""})`);
      lines.push("```");
      for (const s of m.realRemoved.slice(0, 8)) {
        lines.push(`- ${s.length > 120 ? s.slice(0, 120) + "..." : s}`);
      }
      if (m.realRemoved.length > 8) lines.push(`  ... 还有 ${m.realRemoved.length - 8} 处移除`);
      for (const s of m.realAdded.slice(0, 8)) {
        lines.push(`+ ${s.length > 120 ? s.slice(0, 120) + "..." : s}`);
      }
      if (m.realAdded.length > 8) lines.push(`  ... 还有 ${m.realAdded.length - 8} 处新增`);
      lines.push("```");
    }

    // ── 噪音汇总（一行带过） ──
    if (noiseOnlyFiles.length > 0) {
      const totalNoise = noiseOnlyFiles.reduce((s, f) => s + f.noise, 0);
      lines.push(`\n🔇 构建噪音：${noiseOnlyFiles.length} 文件 ${totalNoise} 处变更（已过滤）`);
    }

    // ── 新增/移除文件：全局字符串池对比 ──
    // 避免 chunk 重组误报：只有全局维度真正新增/消失的业务字符串才算变更
    if (assetDiff.added.length > 0 || assetDiff.removed.length > 0) {
      // 收集所有旧 chunk 和新 chunk 的全局字符串池
      const oldGlobalStrings = new Set();
      const newGlobalStrings = new Set();
      for (const data of Object.values(oldAssets || {})) {
        for (const s of (data.strings || [])) oldGlobalStrings.add(s);
      }
      for (const data of Object.values(newAssets || {})) {
        for (const s of (data.strings || [])) newGlobalStrings.add(s);
      }
      // 真正新增/消失的字符串（全局维度）
      const globallyAdded = [...newGlobalStrings].filter(s => !oldGlobalStrings.has(s) && !isNoiseString(s));
      const globallyRemoved = [...oldGlobalStrings].filter(s => !newGlobalStrings.has(s) && !isNoiseString(s));

      // 分类业务 vs 非业务
      const bizAdded = globallyAdded.filter(s => matchBusinessKeywords(s).length > 0);
      const bizRemoved = globallyRemoved.filter(s => matchBusinessKeywords(s).length > 0);
      const nonBizAdded = globallyAdded.length - bizAdded.length;
      const nonBizRemoved = globallyRemoved.length - bizRemoved.length;

      if (bizAdded.length > 0 || bizRemoved.length > 0) {
        lines.push("");
        lines.push("**🔍 全局业务字符串变更：**");
        lines.push("```");
        for (const s of bizRemoved.slice(0, 15)) {
          const kws = matchBusinessKeywords(s);
          lines.push(`- ${s.length > 100 ? s.slice(0, 100) + "..." : s}  (${kws.join("、")})`);
        }
        if (bizRemoved.length > 15) lines.push(`  ... 还有 ${bizRemoved.length - 15} 处移除`);
        for (const s of bizAdded.slice(0, 15)) {
          const kws = matchBusinessKeywords(s);
          lines.push(`+ ${s.length > 100 ? s.slice(0, 100) + "..." : s}  (${kws.join("、")})`);
        }
        if (bizAdded.length > 15) lines.push(`  ... 还有 ${bizAdded.length - 15} 处新增`);
        lines.push("```");
      }

      if (nonBizAdded > 0 || nonBizRemoved > 0) {
        lines.push(`📊 非业务字符串：新增 ${nonBizAdded} | 移除 ${nonBizRemoved}（构建产物变更）`);
      }

      // 文件数量概览（不再逐个列出 chunk 名）
      if (assetDiff.added.length > 0 || assetDiff.removed.length > 0) {
        const fileParts = [];
        if (assetDiff.added.length > 0) fileParts.push(`新增 ${assetDiff.added.length} 文件`);
        if (assetDiff.removed.length > 0) fileParts.push(`移除 ${assetDiff.removed.length} 文件`);
        // 只有全局无业务变更时才标注为 chunk 重组
        if (bizAdded.length === 0 && bizRemoved.length === 0) {
          lines.push(`📦 ${fileParts.join("、")}（chunk 重组，无业务影响，详见 diff 附件）`);
        } else {
          lines.push(`📦 ${fileParts.join("、")}（详见 diff 附件）`);
        }
      }
    }
  }

  // 页面文案 diff
  if (textDiff) {
    if (textDiff.reordered) {
      lines.push("**📝 页面文案顺序调整（内容不变）**");
    } else if (textDiff.changes.length > 0) {
      lines.push("**📝 页面文案变更：**");
      lines.push("```");
      for (const c of textDiff.changes.slice(0, 20)) {
        if (c.type === "modified") { lines.push(`- ${c.oldText}`); lines.push(`+ ${c.newText}`); }
        else if (c.type === "added") { lines.push(`+ ${(c.text.length > 120 ? c.text.slice(0, 120) + "..." : c.text)}`); }
        else if (c.type === "removed") { lines.push(`- ${(c.text.length > 120 ? c.text.slice(0, 120) + "..." : c.text)}`); }
      }
      lines.push("```");
      if (textDiff.changes.length > 20) lines.push(`... 还有 ${textDiff.changes.length - 20} 处变更`);
    }
  }
  return lines.join("\n");
}

/**
 * 构建完整 diff 详情文本（用于文件附件，不做任何省略）
 * 包含所有文件名、所有字符串变更、业务分类标注
 */
function buildFullDiffText(label, assetDiff, textDiff, routeDiff, recoveredAssets, oldAssets, newAssets) {
  const lines = [];
  lines.push("=".repeat(60));
  lines.push(`前端变更详细 Diff — ${label}`);
  lines.push(`时间: ${ts()}`);
  lines.push("=".repeat(60));

  // ── 资源变更概览 ──
  if (assetDiff) {
    lines.push("");
    lines.push("[ 资源文件变更 ]");
    const stats = [];
    if (assetDiff.unchanged) stats.push(`不变 ${assetDiff.unchanged}`);
    if (assetDiff.renamed) stats.push(`重命名 ${assetDiff.renamed}`);
    if (assetDiff.matched?.length) stats.push(`修改 ${assetDiff.matched.length}`);
    if (assetDiff.added?.length) stats.push(`新增 ${assetDiff.added.length}`);
    if (assetDiff.removed?.length) stats.push(`移除 ${assetDiff.removed.length}`);
    lines.push(`  统计: ${stats.join(" | ")}`);

    // 修改文件：完整字符串 diff
    if (assetDiff.matched?.length > 0) {
      lines.push("");
      lines.push("--- 修改文件详情 ---");
      for (const m of assetDiff.matched) {
        const totalChanges = m.addedStrings.length + m.removedStrings.length;
        if (totalChanges === 0) continue;
        const fname = m.oldFile === m.newFile ? m.newFile : `${m.oldFile} → ${m.newFile}`;
        lines.push("");
        lines.push(`  [${fname}] (${totalChanges} 处字符串变更)`);
        for (const s of m.removedStrings) {
          lines.push(`    - ${s}`);
        }
        for (const s of m.addedStrings) {
          lines.push(`    + ${s}`);
        }
      }
    }

    // 新增文件：列出所有文件名 + strings 摘要
    if (assetDiff.added?.length > 0) {
      lines.push("");
      lines.push("--- 新增文件 ---");
      for (const f of assetDiff.added) {
        const assetData = newAssets?.[f];
        const strCount = assetData?.strings?.length || 0;
        const sampleStrs = (assetData?.strings || []).slice(0, 5).join(" | ");
        lines.push(`  + ${f}  (${strCount} 个字符串)`);
        if (sampleStrs) lines.push(`    摘要: ${sampleStrs}`);
      }
    }

    // 移除文件：列出所有文件名 + strings 摘要
    if (assetDiff.removed?.length > 0) {
      lines.push("");
      lines.push("--- 移除文件 ---");
      for (const f of assetDiff.removed) {
        const assetData = oldAssets?.[f];
        const strCount = assetData?.strings?.length || 0;
        const sampleStrs = (assetData?.strings || []).slice(0, 5).join(" | ");
        lines.push(`  - ${f}  (${strCount} 个字符串)`);
        if (sampleStrs) lines.push(`    摘要: ${sampleStrs}`);
      }
    }
  }

  // ── 路由变更 ──
  if (routeDiff) {
    const hasRouteChange = routeDiff.added?.length > 0 || routeDiff.removed?.length > 0;
    if (hasRouteChange) {
      lines.push("");
      lines.push("[ 路由/端点变更 ]");
      for (const r of routeDiff.added || []) lines.push(`  + 新增: ${r}`);
      for (const r of routeDiff.removed || []) lines.push(`  - 移除: ${r}`);
    }
  }

  // ── 部署抖动恢复 ──
  if (recoveredAssets?.length > 0) {
    lines.push("");
    lines.push("[ 部署抖动恢复 ]");
    for (const ra of recoveredAssets) {
      const ago = ra.removedSecondsAgo ? `${ra.removedSecondsAgo}s 前` : "稍早前";
      lines.push(`  ${ra.file} — ${ago}被移除，现已恢复${ra.changed ? "（内容有变）" : "（内容不变）"}`);
    }
  }

  // ── 文案变更 ──
  if (textDiff && !textDiff.reordered && textDiff.changes?.length > 0) {
    lines.push("");
    lines.push("[ 页面文案变更 ]");
    for (const c of textDiff.changes) {
      if (c.type === "modified") {
        lines.push(`  - ${c.oldText}`);
        lines.push(`  + ${c.newText}`);
      } else if (c.type === "added") {
        lines.push(`  + ${c.text}`);
      } else if (c.type === "removed") {
        lines.push(`  - ${c.text}`);
      }
    }
  }

  lines.push("");
  lines.push("=".repeat(60));
  return lines.join("\n");
}

/* ══════════════════════════════════════════
   模块 3/5：多端点 API 结构监控（并行探测）
   ══════════════════════════════════════════ */

function extractStructure(obj, prefix = "", endpoint = "") {
  const result = {};
  if (obj === null || obj === undefined) return result;
  if (Array.isArray(obj)) {
    result[prefix + "[]"] = "array";
    for (const item of obj.slice(0, 10)) {
      Object.assign(result, extractStructure(item, prefix + "[0].", endpoint));
    }
  } else if (typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      const path = prefix + k;
      result[path] = normalizeApiStructureValueType(endpoint, path, v);
      if (typeof v === "object" && v !== null && !Array.isArray(v)) {
        Object.assign(result, extractStructure(v, path + ".", endpoint));
      } else if (Array.isArray(v)) {
        Object.assign(result, extractStructure(v, path, endpoint));
      }
    }
  }
  return result;
}

function apiEndpointLabel(endpointKey) {
  const ep = CONFIG.apiProbeEndpoints.find(item => item.key === endpointKey);
  return ep?.label || endpointKey;
}

function apiEndpointUrl(endpointKey) {
  const ep = CONFIG.apiProbeEndpoints.find(item => item.key === endpointKey);
  return ep?.url || "";
}

function apiEndpointLink(endpointKey) {
  const label = apiEndpointLabel(endpointKey);
  const url = apiEndpointUrl(endpointKey);
  return url ? `[${label}](${url})` : label;
}

function activeApiProbeKeys() {
  return new Set(CONFIG.apiProbeEndpoints.map(ep => ep.key));
}

function pruneInactiveApiSnapshots(target) {
  const activeKeys = activeApiProbeKeys();
  const removed = new Set();
  for (const section of ["apiStructure", "apiValues"]) {
    const data = target?.[section];
    if (!data || typeof data !== "object") continue;
    for (const key of Object.keys(data)) {
      if (activeKeys.has(key)) continue;
      delete data[key];
      removed.add(key);
    }
  }
  return [...removed].sort();
}

function tryParseJson(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * 有些 Four.meme API 会把真实列表包在 data 字符串里返回
 * （例如 KOL 排行接口前端会 JSON.parse(response.data)）。
 * 这里递归解析这类 JSON 字符串，确保结构 diff 看到内部字段。
 */
function normalizeApiPayload(payload, depth = 0, sampleArrayItems = 0) {
  if (payload === null || payload === undefined || depth > 4) return payload;
  if (typeof payload === "string") {
    const parsed = tryParseJson(payload);
    return parsed === null ? payload : normalizeApiPayload(parsed, depth + 1, sampleArrayItems);
  }
  if (Array.isArray(payload)) {
    const items = sampleArrayItems > 0 && payload.length > sampleArrayItems
      ? payload.slice(0, sampleArrayItems)
      : payload;
    return items.map(item => normalizeApiPayload(item, depth + 1, sampleArrayItems));
  }
  if (typeof payload === "object") {
    const out = {};
    for (const [k, v] of Object.entries(payload)) {
      out[k] = normalizeApiPayload(v, depth + 1, sampleArrayItems);
    }
    return out;
  }
  return payload;
}

function buildNonJsonApiPayload(res, text) {
  const compact = (text || "").replace(/\s+/g, " ").trim();
  const cloudflareCode = compact.match(/error code:\s*(\d+)/i)?.[1] || "";
  return {
    _http: {
      status: res?.status || 0,
      ok: !!res?.ok,
      contentType: (res?.headers?.get?.("content-type") || "").split(";")[0] || "",
      bodyKind: "non_json",
      errorCode: cloudflareCode || "",
      bodyPreview: cloudflareCode ? `cloudflare_${cloudflareCode}` : compact.slice(0, 120),
    },
  };
}

function buildApiProbeErrorPayload(err) {
  return {
    _probeError: {
      message: (err?.message || String(err)).slice(0, 200),
      name: err?.name || "Error",
    },
  };
}

function hasTransientApiErrorMarkers(obj) {
  if (!obj || typeof obj !== "object") return false;
  const keys = new Set(Object.keys(obj).map(k => normalizeStructureFieldName(k)));
  return keys.has("_probeError.message")
    || keys.has("_probeError.name")
    || keys.has("_http.status")
    || keys.has("_http.errorCode")
    || keys.has("cloudflare_error")
    || keys.has("ray_id")
    || keys.has("error_category")
    || keys.has("owner_action_required")
    || keys.has("retry_after")
    || keys.has("footer");
}

function isTransientApiProbePayload(payload, res) {
  if (!payload || typeof payload !== "object") return true;
  if (payload._probeError) return true;
  const status = Number(res?.status || payload._http?.status || payload.status || payload.error_code || 0);
  if (status === 408 || status === 425 || status === 429 || status >= 500) return true;
  if (payload._http?.bodyKind === "non_json") return true;
  if (payload.cloudflare_error === true) return true;
  if (payload.error_category === "origin" || payload.ray_id) return true;
  if (typeof payload.title === "string" && /^Error\s+\d+:/i.test(payload.title)) return true;
  if (typeof payload.type === "string" && /cloudflare.*5xx|error-\d+/i.test(payload.type)) return true;
  return false;
}

/**
 * 并行探测所有 API 端点（加随机延迟错开，降低同域并发风控风险）
 * 返回 { structures, values } — 结构类型 + 实际响应值
 */
async function fetchApiData() {
  const structures = {};
  const values = {};

  const tasks = CONFIG.apiProbeEndpoints.map((ep, i) => {
    return sleep(i * CONFIG.apiProbeStaggerMs).then(async () => {  // 错开请求，避免同域并发触发风控
      let payload;
      let isSuccess = false;
      let res = null;
      try {
        const opts = {
          method: ep.method || "GET",
          headers: {
            "Accept": "application/json, text/plain, */*",
            "Content-Type": "application/json",
            "Origin": CONFIG.siteUrl,
            "Referer": `${CONFIG.siteUrl}/`,
            "User-Agent": nextUA(),
            ...(ep.headers || {}),
          },
        };
        if (ep.method === "POST" && ep.body) opts.body = JSON.stringify(ep.body);
        res = await fetchProbe(ep.url, opts, 15_000);
        const text = await res.text();
        const json = tryParseJson(text);
        payload = json === null ? buildNonJsonApiPayload(res, text) : normalizeApiPayload(json, 0, ep.sampleArrayItems || 0);
        if (payload?._http?.errorCode === "1015") recordFail(getDomain(ep.url), 429);
        const hasCode = payload && typeof payload === "object" && !Array.isArray(payload) && Object.prototype.hasOwnProperty.call(payload, "code");
        isSuccess = !!payload && (hasCode ? (payload.code === 0 || payload.code === "0") : res.ok);
      } catch (err) {
        payload = buildApiProbeErrorPayload(err);
      }
      // 公共 API 只用成功响应更新结构/值，避免短暂超时、风控页、非 JSON 响应污染快照。
      // 私有探针只记录稳定的业务错误 envelope；Cloudflare/5xx/429/网络异常不污染 API 快照。
      const transientError = !isSuccess && isTransientApiProbePayload(payload, res);
      const shouldRecordErrorStructure = !!ep.recordErrorStructure && !transientError;
      if (ep.recordErrorStructure && transientError) {
        const status = res?.status || payload?._http?.status || payload?.status || payload?.error_code || payload?._probeError?.name || "transient";
        log(`  [API] ${ep.label} 临时错误已忽略，不更新结构快照：${status}`);
      }
      const shouldRecordStructure = isSuccess || shouldRecordErrorStructure;
      const shouldRecordValues = isSuccess || shouldRecordErrorStructure;
      return {
        key: ep.key,
        label: ep.label,
        structure: shouldRecordStructure ? extractStructure(payload, "", ep.key) : null,
        apiValues: shouldRecordValues ? extractApiValues(payload) : null,
        success: isSuccess,
      };
    });
  });

  const results = await Promise.allSettled(tasks);
  for (const r of results) {
    if (r.status === "fulfilled") {
      // 结构：仅成功响应纳入对比，失败时保留上次快照结构
      if (r.value.structure) {
        structures[r.value.key] = r.value.structure;
      }
      if (r.value.apiValues) {
        values[r.value.key] = r.value.apiValues;
      }
    } else {
      log(`  [API] 探测失败：${r.reason?.message || r.reason}`);
    }
  }
  return { structures, values };
}

// 结构不稳定的端点：成功响应的字段集合本身不固定，跳过结构对比
const API_STRUCTURE_SKIP_ENDPOINTS = new Set();

const API_TOKEN_LIST_ENDPOINTS = new Set([
  "token_ranking_cap",
  "token_ranking_binance",
  "token_search_new",
  "token_search_cap",
]);

const API_TOKEN_TEXT_FIELD_RE = /^data\[0\]\.(?:name|shortName|symbol)$/;
const API_NUMERIC_STRING_RE = /^-?(?:\d+|\d*\.\d+)(?:e[+-]?\d+)?$/i;

function isNumericLikeString(value) {
  return typeof value === "string" && API_NUMERIC_STRING_RE.test(value.trim());
}

function normalizeApiStructureFieldType(endpoint, field, type) {
  const name = normalizeStructureFieldName(field);
  if (API_TOKEN_LIST_ENDPOINTS.has(endpoint)) {
    if (API_TOKEN_TEXT_FIELD_RE.test(name) && (type === "string" || type === "number")) return "string";
    if (type === "number" || type === "numeric-string") return "number";
  }
  return type;
}

function normalizeApiStructureValueType(endpoint, field, value) {
  if (Array.isArray(value)) return "array";
  const rawType = typeof value;
  const normalizedType = isNumericLikeString(value) ? "numeric-string" : rawType;
  return normalizeApiStructureFieldType(endpoint, field, normalizedType);
}

const TOKEN_LIST_VOLATILE_FIELD_PATTERNS = [
  /^data\[0\]\.(?:min|min\d+|hour|hour\d+|day\d+)Increase$/,
  /^data\[0\]\.(?:min|min\d+|hour|hour\d+|day\d+)Vol$/,
  /^data\[0\]\.(?:taxFee|taxFeeSell|feeBurn)$/,
];

const API_STRUCTURE_VOLATILE_FIELD_PATTERNS = new Map([
  ["token_ranking_cap", TOKEN_LIST_VOLATILE_FIELD_PATTERNS],
  ["token_ranking_binance", TOKEN_LIST_VOLATILE_FIELD_PATTERNS],
  ["token_search_new", TOKEN_LIST_VOLATILE_FIELD_PATTERNS],
  ["token_search_cap", TOKEN_LIST_VOLATILE_FIELD_PATTERNS],
]);

function normalizeStructureFieldName(field) {
  return String(field || "")
    .replace(/\s*\([^)]*\)$/, "")
    .replace(/:\s*.+$/, "");
}

function isVolatileApiStructureField(endpoint, field) {
  const patterns = API_STRUCTURE_VOLATILE_FIELD_PATTERNS.get(endpoint);
  if (!patterns) return false;
  const name = normalizeStructureFieldName(field);
  return patterns.some(re => re.test(name));
}

function mergeOldArrayItemFieldsForEmptySamples(oldFields, newFields) {
  const merged = { ...newFields };
  const newKeys = Object.keys(newFields || {});
  const oldKeys = Object.keys(oldFields || {});
  const prefixes = [];
  let preserved = 0;

  for (const key of newKeys) {
    if (!key.endsWith("[]")) continue;
    const arrayPrefix = key.slice(0, -2);
    const itemPrefix = `${arrayPrefix}[0].`;
    const oldItemKeys = oldKeys.filter(k => k.startsWith(itemPrefix));
    if (oldItemKeys.length === 0) continue;
    const newHasItemSample = newKeys.some(k => k.startsWith(itemPrefix));
    if (newHasItemSample) continue;
    prefixes.push(arrayPrefix);
    for (const itemKey of oldItemKeys) {
      if (!(itemKey in merged)) {
        merged[itemKey] = oldFields[itemKey];
        preserved++;
      }
    }
  }

  return { fields: merged, preserved, prefixes };
}

function stabilizeApiStructuresForEmptyArrays(oldStruct, newStruct) {
  const structures = {};
  const suppressed = [];
  for (const [endpoint, newFields] of Object.entries(newStruct || {})) {
    const oldFields = oldStruct?.[endpoint];
    if (!oldFields) {
      structures[endpoint] = newFields;
      continue;
    }
    const result = mergeOldArrayItemFieldsForEmptySamples(oldFields, newFields);
    structures[endpoint] = result.fields;
    if (result.preserved > 0) {
      suppressed.push({ endpoint, preserved: result.preserved, prefixes: result.prefixes });
    }
  }
  return { structures, suppressed };
}

function shouldLogApiEmptyArrayPreserve(item) {
  const key = `${item.endpoint}:${(item.prefixes || []).join("/") || "array"}`;
  const now = Date.now();
  const minIntervalMs = Number.parseInt(process.env.API_EMPTY_ARRAY_LOG_INTERVAL_MS || "", 10) || 600_000;
  const last = apiEmptyArrayLogState.get(key) || 0;
  if (now - last < minIntervalMs) return false;
  apiEmptyArrayLogState.set(key, now);
  return true;
}

function diffApiStructures(oldStruct, newStruct) {
  const changes = [];
  if (!oldStruct || !newStruct) return changes;
  for (const [endpoint, newFields] of Object.entries(newStruct)) {
    if (API_STRUCTURE_SKIP_ENDPOINTS.has(endpoint)) continue;
    const oldFields = oldStruct[endpoint];
    if (!oldFields) {
      const allFields = Object.entries(newFields).map(([k, t]) => `${k} (${t})`);
      changes.push({ type: "新接口结构", endpoint, added: allFields, removed: [], changed: [] });
      continue;
    }
    if (hasTransientApiErrorMarkers(oldFields) && !hasTransientApiErrorMarkers(newFields)) {
      log(`  [API] ${apiEndpointLabel(endpoint)} 旧快照为临时错误结构，已静默恢复`);
      continue;
    }
    if (hasTransientApiErrorMarkers(newFields)) {
      log(`  [API] ${apiEndpointLabel(endpoint)} 临时错误结构已忽略`);
      continue;
    }
    const added = [], removed = [], changed = [];
    for (const [key, type] of Object.entries(newFields)) {
      if (isVolatileApiStructureField(endpoint, key)) continue;
      const normalizedNewType = normalizeApiStructureFieldType(endpoint, key, type);
      if (!(key in oldFields)) added.push(`${key} (${type})`);
      else {
        const normalizedOldType = normalizeApiStructureFieldType(endpoint, key, oldFields[key]);
        if (normalizedOldType !== normalizedNewType) changed.push(`${key}: ${oldFields[key]} → ${type}`);
      }
    }
    for (const key of Object.keys(oldFields)) {
      if (isVolatileApiStructureField(endpoint, key)) continue;
      if (!(key in newFields)) removed.push(key);
    }
    if (added.length || removed.length || changed.length) {
      changes.push({ type: "结构变更", endpoint, added, removed, changed });
    }
  }
  return changes;
}

/**
 * 从 API 字段名列表推断端点的业务用途
 * 返回推断描述字符串，无法推断时返回 null
 */
function inferEndpointPurpose(endpoint, fields, values) {
  const allFieldNames = (fields || []).map(f => f.replace(/\s*\(.*$/, "").toLowerCase());
  const allValues = values || {};
  const hints = [];

  // ── 关键词 → 业务语义映射 ──
  const FIELD_SEMANTICS = [
    { keywords: ["fee", "buyFee", "sellFee", "tradeFee", "commission"],        meaning: "交易手续费配置" },
    { keywords: ["pool", "liquidity", "b0Amount", "totalBAmount", "reserve"],  meaning: "底池/流动性参数" },
    { keywords: ["price", "rate", "saleRate", "exchangeRate"],                 meaning: "价格/汇率信息" },
    { keywords: ["token", "symbol", "decimals", "tokenAddress", "mint"],       meaning: "代币信息" },
    { keywords: ["network", "chain", "chainId", "rpc", "networkCode"],         meaning: "链/网络配置" },
    { keywords: ["user", "account", "address", "wallet", "balance"],           meaning: "用户/账户相关" },
    { keywords: ["nft", "agent", "agentNft", "identifier"],                    meaning: "NFT/Agent 相关" },
    { keywords: ["contract", "deploy", "implementation", "proxy"],             meaning: "合约部署相关" },
    { keywords: ["swap", "trade", "order", "buy", "sell"],                     meaning: "交易/兑换功能" },
    { keywords: ["stake", "staking", "reward", "claim", "dividend", "yield"],  meaning: "质押/收益功能" },
    { keywords: ["vault", "lend", "borrow", "collateral", "leverage"],         meaning: "金库/借贷功能" },
    { keywords: ["whitelist", "blacklist", "ban", "restrict", "permission"],   meaning: "权限/黑白名单" },
    { keywords: ["announcement", "notice", "banner", "popup", "campaign"],     meaning: "公告/运营活动" },
    { keywords: ["config", "setting", "param", "option", "flag", "enable"],    meaning: "系统配置/功能开关" },
    { keywords: ["airdrop", "distribute", "allocation"],                       meaning: "空投/分发" },
    { keywords: ["referral", "invite", "inviteCode", "affiliate"],             meaning: "邀请/推荐机制" },
    { keywords: ["level", "tier", "vip", "rank", "grade"],                     meaning: "等级/分层体系" },
    { keywords: ["limit", "max", "min", "threshold", "cap", "ceiling"],        meaning: "限额/阈值设定" },
    { keywords: ["status", "state", "phase", "stage"],                         meaning: "状态/阶段标记" },
    { keywords: ["create", "launch", "deploy", "publish", "issue"],            meaning: "创建/发行流程" },
    { keywords: ["template", "preset", "model"],                               meaning: "模板/预设配置" },
  ];

  const matched = new Set();
  for (const fieldName of allFieldNames) {
    for (const sem of FIELD_SEMANTICS) {
      if (matched.has(sem.meaning)) continue;
      for (const kw of sem.keywords) {
        if (fieldName.includes(kw.toLowerCase())) {
          matched.add(sem.meaning);
          break;
        }
      }
    }
  }
  if (matched.size > 0) hints.push(...matched);

  // ── 从 URL 路径推断 ──
  const URL_HINTS = [
    { re: /config/i,        hint: "平台配置" },
    { re: /user|account/i,  hint: "用户服务" },
    { re: /token/i,         hint: "代币管理" },
    { re: /trade|swap/i,    hint: "交易接口" },
    { re: /nonce|login/i,   hint: "认证/登录" },
    { re: /create|launch/i, hint: "创建/发行" },
    { re: /pool/i,          hint: "底池管理" },
  ];
  for (const uh of URL_HINTS) {
    if (uh.re.test(endpoint) && !hints.includes(uh.hint)) {
      hints.unshift(uh.hint);
    }
  }

  // ── 从实际响应值中提取关键样本 ──
  const sampleLines = [];
  const valueEntries = Object.entries(allValues);
  // 挑选有辨识度的值（布尔、短字符串、小数字），最多展示 15 个
  const meaningful = valueEntries.filter(([k, v]) => {
    if (isDynamicField(k)) return false;
    if (typeof v === "boolean") return true;
    if (typeof v === "number") return true;
    if (typeof v === "string" && v.length > 0 && v.length <= 100 && !v.startsWith("[hash:")) return true;
    return false;
  });
  for (const [k, v] of meaningful.slice(0, 15)) {
    sampleLines.push(`  ${k}: ${v}`);
  }

  if (hints.length === 0 && sampleLines.length === 0) return null;

  const parts = [];
  if (hints.length > 0) {
    parts.push(`**🔍 推断用途：** ${hints.slice(0, 5).join("、")}`);
  }
  if (sampleLines.length > 0) {
    parts.push(`**📎 关键字段样本：**`);
    parts.push("```");
    parts.push(...sampleLines);
    parts.push("```");
    if (meaningful.length > 15) parts.push(`  ... 还有 ${meaningful.length - 15} 个字段`);
  }
  return parts.join("\n");
}

function formatApiChanges(changes, apiValues) {
  const lines = [];
  for (const c of changes) {
    const label = apiEndpointLabel(c.endpoint);
    const link = apiEndpointLink(c.endpoint);
    lines.push(`**📡 API ${c.type}：${link}**`);
    if (label !== c.endpoint) lines.push(`  key: \`${c.endpoint}\``);
    if (c.added?.length || c.removed?.length || c.changed?.length) {
      lines.push("```");
      for (const f of c.added || []) lines.push(`+ ${f}`);
      for (const f of c.removed || []) lines.push(`- ${f}`);
      for (const f of c.changed || []) lines.push(`~ ${f}`);
      lines.push("```");
    }
    // 对新接口 / 有新增字段的变更，尝试推断业务用途
    if (c.type === "新接口结构" || (c.added && c.added.length > 0)) {
      const endpointValues = apiValues?.[c.endpoint] || {};
      const purpose = inferEndpointPurpose(c.endpoint, c.added, endpointValues);
      if (purpose) lines.push(purpose);
    }
    lines.push("---");
  }
  return lines.join("\n");
}

/* ── API 响应值监控（不仅仅是结构） ── */

// 不适合做值对比的端点（每次请求返回不同数据）
const API_VALUE_SKIP_ENDPOINTS = new Set([
  "token_ranking_cap",      // 排行数据高频变化，结构监控即可
  "token_ranking_binance",
  "token_search_new",       // 列表内容高频变化，结构监控即可
  "token_search_cap",
  "kol_teams",              // 活动积分榜高频变化，结构监控即可
  "kol_traders",
]);

// 每次请求可能变化的动态字段名模式（不区分端点的通用过滤）
const DYNAMIC_VALUE_PATTERNS = [
  /nonce/i, /timestamp/i, /(?:create|update|server|request|response|current|login|access)Time$/i,
  /(?:access|refresh|auth|bearer|session|tenant)[_-]?[Tt]oken$/,  // 只匹配认证类 token，不匹配 tokenAddress 等
  /session[_-]?[Ii]d$/i, /requestId/i, /traceId/i,
  /(?:^|_)signature$/i, /^sign$/i,  // 精确匹配 sign/signature，不匹配 design/assign 等
  /expir(?:e[ds]?|ation|y)(?:At|Time|Date)?$/i,  // 只匹配过期时间类字段
  /random/i,
];

function isDynamicField(key) {
  return DYNAMIC_VALUE_PATTERNS.some(re => re.test(key));
}

function stableApiValuesForSnapshot(endpoint, values) {
  if (!values || API_VALUE_SKIP_ENDPOINTS.has(endpoint)) return null;
  const stable = {};
  for (const [key, value] of Object.entries(values)) {
    if (!isDynamicField(key)) stable[key] = value;
  }
  return stable;
}

function stableApiValuesSnapshot(valuesByEndpoint) {
  const result = {};
  for (const [endpoint, values] of Object.entries(valuesByEndpoint || {})) {
    const stableValues = stableApiValuesForSnapshot(endpoint, values);
    if (stableValues !== null) result[endpoint] = stableValues;
  }
  return result;
}

function extractApiValues(obj, prefix = "", depth = 0) {
  const result = {};
  if (obj === null || obj === undefined || depth > 6) return result;
  if (Array.isArray(obj)) {
    if (obj.length <= 10) {
      result[prefix + "[]"] = JSON.stringify(obj);
    } else {
      result[prefix + "[].length"] = obj.length;
    }
    return result;
  }
  if (typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (typeof v === "boolean" || typeof v === "number") {
        result[path] = v;
      } else if (typeof v === "string") {
        result[path] = v.length > 200 ? `[hash:${md5(v).slice(0, 8)}]` : v;
      } else if (Array.isArray(v)) {
        Object.assign(result, extractApiValues(v, path, depth + 1));
      } else if (typeof v === "object" && v !== null) {
        Object.assign(result, extractApiValues(v, path, depth + 1));
      }
    }
  }
  return result;
}

function diffApiValues(oldValues, newValues) {
  if (!oldValues || !newValues) return [];
  const changes = [];
  for (const [endpoint, newVals] of Object.entries(newValues)) {
    // 跳过已知的动态端点
    if (API_VALUE_SKIP_ENDPOINTS.has(endpoint)) continue;
    if (hasTransientApiErrorMarkers(newVals)) {
      log(`  [API] ${apiEndpointLabel(endpoint)} 临时错误响应值已忽略`);
      continue;
    }
    const oldVals = oldValues[endpoint];
    if (!oldVals) { changes.push({ type: "新端点值", endpoint, values: newVals }); continue; }
    if (hasTransientApiErrorMarkers(oldVals) && !hasTransientApiErrorMarkers(newVals)) {
      log(`  [API] ${apiEndpointLabel(endpoint)} 旧响应值为临时错误，已静默恢复`);
      continue;
    }
    const fieldChanges = [];
    for (const [key, val] of Object.entries(newVals)) {
      // 跳过已知的动态字段
      if (isDynamicField(key)) continue;
      if (!(key in oldVals)) {
        fieldChanges.push({ action: "added", key, value: val });
      } else if (String(oldVals[key]) !== String(val)) {
        fieldChanges.push({ action: "changed", key, old: oldVals[key], new: val });
      }
    }
    for (const key of Object.keys(oldVals)) {
      if (isDynamicField(key)) continue;
      if (!(key in newVals)) fieldChanges.push({ action: "removed", key, value: oldVals[key] });
    }
    if (fieldChanges.length > 0) {
      changes.push({ type: "值变更", endpoint, fieldChanges });
    }
  }
  return changes;
}

function formatApiValueChanges(changes) {
  if (changes.length === 0) return "";
  const lines = [];
  for (const c of changes) {
    if (c.type === "新端点值" && c.values) {
      const label = apiEndpointLabel(c.endpoint);
      const link = apiEndpointLink(c.endpoint);
      lines.push(`**📊 API 新端点响应值：${link}**`);
      if (label !== c.endpoint) lines.push(`  key: \`${c.endpoint}\``);
      const entries = Object.entries(c.values).filter(([k]) => !isDynamicField(k));
      if (entries.length > 0) {
        lines.push("```");
        for (const [k, v] of entries.slice(0, 30)) {
          const display = typeof v === "string" && v.length > 100 ? v.slice(0, 100) + "..." : v;
          lines.push(`  ${k}: ${display}`);
        }
        if (entries.length > 30) lines.push(`  ... 还有 ${entries.length - 30} 个字段`);
        lines.push("```");
      }
    } else {
      const label = apiEndpointLabel(c.endpoint);
      const link = apiEndpointLink(c.endpoint);
      lines.push(`**📊 API 响应值变更：${link}**`);
      if (label !== c.endpoint) lines.push(`  key: \`${c.endpoint}\``);
      if (c.fieldChanges) {
        lines.push("```");
        for (const fc of c.fieldChanges.slice(0, 20)) {
          if (fc.action === "added") lines.push(`+ ${fc.key}: ${fc.value}`);
          else if (fc.action === "removed") lines.push(`- ${fc.key}: ${fc.value}`);
          else if (fc.action === "changed") lines.push(`~ ${fc.key}: ${fc.old} → ${fc.new}`);
        }
        if (c.fieldChanges.length > 20) lines.push(`  ... 还有 ${c.fieldChanges.length - 20} 处变更`);
        lines.push("```");
      }
    }
    lines.push("---");
  }
  return lines.join("\n");
}

const GITHUB_API = "https://api.github.com";
// githubETag 从 snapshot 恢复，避免重启后浪费 rate limit
let githubETag = "";
let githubReposETag = "";

function githubHeaders() {
  const h = {
    "Accept": "application/vnd.github.v3+json",
    "User-Agent": "fourmeme-monitor/2.0",
  };
  if (CONFIG.githubToken) h["Authorization"] = `Bearer ${CONFIG.githubToken}`;
  return h;
}

async function fetchLatestCommits(perPage = 30) {
  const url = `${GITHUB_API}/repos/${CONFIG.githubRepo}/commits?sha=${CONFIG.githubApiBranch}&per_page=${perPage}`;
  const headers = githubHeaders();
  if (githubETag) headers["If-None-Match"] = githubETag;

  const res = await fetchSafe(url, { headers }, 10_000);

  // 304 Not Modified — 无新提交，节省 rate limit
  // 注意：fetchSafe 已消费 304 的响应体，可直接返回
  if (res.status === 304) return null;

  if (!res.ok) throw new Error(`GitHub API HTTP ${res.status}`);

  // 记录 ETag 供下次条件请求
  const etag = res.headers.get("etag");
  if (etag) githubETag = etag;

  return await res.json();
}

async function fetchGithubOwnerRepos(perPage = 100) {
  const url = `${GITHUB_API}/users/${CONFIG.githubOwner}/repos?per_page=${perPage}&sort=updated`;
  const headers = githubHeaders();
  if (githubReposETag) headers["If-None-Match"] = githubReposETag;

  const res = await fetchSafe(url, { headers }, 10_000);
  if (res.status === 304) return null;
  if (!res.ok) throw new Error(`GitHub 账号仓库 API HTTP ${res.status}`);

  const etag = res.headers.get("etag");
  if (etag) githubReposETag = etag;

  return await res.json();
}

async function fetchCommitDetail(sha) {
  const url = `${GITHUB_API}/repos/${CONFIG.githubRepo}/commits/${sha}`;
  const res = await fetchSafe(url, { headers: githubHeaders() }, 10_000);
  if (!res.ok) throw new Error(`GitHub API HTTP ${res.status}`);
  return await res.json();
}

function normalizeGithubRepos(repos) {
  const map = {};
  for (const r of repos || []) {
    if (!r?.full_name) continue;
    map[r.full_name] = {
      name: r.name || "",
      full_name: r.full_name,
      html_url: r.html_url || `https://github.com/${r.full_name}`,
      description: r.description || "",
      default_branch: r.default_branch || "",
      created_at: r.created_at || "",
      updated_at: r.updated_at || "",
      pushed_at: r.pushed_at || "",
      archived: Boolean(r.archived),
      disabled: Boolean(r.disabled),
    };
  }
  return map;
}

function diffGithubRepos(oldRepos = {}, newRepos = {}) {
  const added = [];
  const removed = [];
  const changed = [];
  for (const [fullName, repo] of Object.entries(newRepos)) {
    const old = oldRepos[fullName];
    if (!old) {
      added.push(repo);
      continue;
    }
    const fields = [];
    for (const key of ["pushed_at", "updated_at", "default_branch", "description", "archived", "disabled"]) {
      if ((old[key] ?? "") !== (repo[key] ?? "")) {
        fields.push({ key, old: old[key] ?? "", new: repo[key] ?? "" });
      }
    }
    if (fields.length > 0) changed.push({ repo, fields });
  }
  for (const [fullName, repo] of Object.entries(oldRepos)) {
    if (!newRepos[fullName]) removed.push(repo);
  }
  return { added, removed, changed };
}

async function checkGithubRepos(oldRepos, reportExistingNonPrimary = false) {
  const repos = await fetchGithubOwnerRepos(100);
  if (repos === null) return { repoMap: oldRepos || null, changes: null };
  const repoMap = normalizeGithubRepos(repos);
  if (!oldRepos) {
    const added = reportExistingNonPrimary
      ? Object.values(repoMap).filter(r => r.full_name !== CONFIG.githubRepo)
      : [];
    return {
      repoMap,
      changes: added.length > 0 ? { added, removed: [], changed: [] } : null,
    };
  }
  const changes = diffGithubRepos(oldRepos, repoMap);
  const hasChanges = changes.added.length || changes.removed.length || changes.changed.length;
  return { repoMap, changes: hasChanges ? changes : null };
}

function formatGithubRepoChanges(changes) {
  const lines = [];
  lines.push(`**账号：** [${CONFIG.githubOwner}](https://github.com/${CONFIG.githubOwner})`);
  const count = (changes.added?.length || 0) + (changes.removed?.length || 0) + (changes.changed?.length || 0);
  lines.push(`**仓库/项目变更：** ${count} 项`);
  lines.push("---");
  for (const r of changes.added || []) {
    lines.push(`🆕 **新增仓库：** [${r.full_name}](${r.html_url})`);
    if (r.description) lines.push(`  描述：${r.description}`);
    lines.push(`  默认分支：${r.default_branch || "未知"}　创建：${r.created_at || "未知"}　更新：${r.updated_at || "未知"}　推送：${r.pushed_at || "未知"}`);
    lines.push("---");
  }
  for (const c of changes.changed || []) {
    const r = c.repo;
    lines.push(`🔄 **仓库更新：** [${r.full_name}](${r.html_url})`);
    lines.push("```");
    for (const f of c.fields) lines.push(`${f.key}: ${f.old || "空"} → ${f.new || "空"}`);
    lines.push("```");
    lines.push("---");
  }
  for (const r of changes.removed || []) {
    lines.push(`🗑️ **移除仓库：** [${r.full_name}](${r.html_url})`);
    lines.push("---");
  }
  return lines.join("\n");
}

function formatGithubChanges(newCommits) {
  const lines = [];
  lines.push(`**仓库：** [${CONFIG.githubRepo}](https://github.com/${CONFIG.githubRepo})`);
  lines.push(`**新增提交：** ${newCommits.length} 个`);
  lines.push("---");
  for (const c of newCommits) {
    const sha = c.sha.slice(0, 8);
    const author = c.commit.author?.name || "未知";
    const date = c.commit.author?.date || "";
    const msg = c.commit.message.split("\n")[0];
    const fullMsg = c.commit.message.trim();
    lines.push(`**[\`${sha}\`](https://github.com/${CONFIG.githubRepo}/commit/${c.sha})** ${msg}`);
    lines.push(`  作者：${author}　时间：${date}`);
    // 多行 commit message 的正文部分（通常包含变更描述）
    if (fullMsg.includes("\n")) {
      const body = fullMsg.split("\n").slice(1).join("\n").trim();
      if (body) {
        lines.push(`  提交描述：`);
        lines.push("```");
        lines.push(body.length > 500 ? body.slice(0, 500) + "..." : body);
        lines.push("```");
      }
    }
    if (c.files && c.files.length > 0) {
      const added = c.files.filter(f => f.status === "added");
      const modified = c.files.filter(f => f.status === "modified");
      const removed = c.files.filter(f => f.status === "removed");
      const renamed = c.files.filter(f => f.status === "renamed");
      const summary = [];
      if (added.length) summary.push(`新增 ${added.length}`);
      if (modified.length) summary.push(`修改 ${modified.length}`);
      if (removed.length) summary.push(`删除 ${removed.length}`);
      if (renamed.length) summary.push(`重命名 ${renamed.length}`);
      lines.push(`  文件：${summary.join("、")}（共 ${c.files.length} 个）`);
      lines.push("```");
      for (const f of c.files.slice(0, 10)) {
        const prefix = f.status === "added" ? "+" : f.status === "removed" ? "-" : f.status === "renamed" ? ">" : "~";
        lines.push(`${prefix} ${f.filename}  (+${f.additions} -${f.deletions})`);
      }
      lines.push("```");
      if (c.files.length > 10) lines.push(`... 还有 ${c.files.length - 10} 个文件`);

      // 输出关键文件的 patch（实际代码变更内容），帮助 AI 理解具体改了什么
      const patchFiles = c.files
        .filter(f => f.patch && f.patch.length > 0)
        .sort((a, b) => (b.additions + b.deletions) - (a.additions + a.deletions));
      if (patchFiles.length > 0) {
        lines.push("");
        lines.push("**代码变更摘要：**");
        let patchBudget = 2000; // 总 patch 字符预算，避免超出 AI token 限制
        for (const f of patchFiles.slice(0, 5)) {
          if (patchBudget <= 0) break;
          const patch = f.patch.length > patchBudget
            ? f.patch.slice(0, patchBudget) + "\n... (patch 已截断)"
            : f.patch;
          patchBudget -= patch.length;
          lines.push(`\`${f.filename}\``);
          lines.push("```diff");
          lines.push(patch);
          lines.push("```");
        }
        if (patchFiles.length > 5) lines.push(`... 还有 ${patchFiles.length - 5} 个文件有代码变更`);
      }
    }
    lines.push("---");
  }
  return lines.join("\n");
}

async function checkGithub(lastSha) {
  const commits = await fetchLatestCommits(30);
  // null = 304 Not Modified
  if (commits === null) return { newSha: lastSha, newCommits: [] };
  if (!commits || commits.length === 0) return { newSha: lastSha, newCommits: [] };
  const latestSha = commits[0].sha;
  if (latestSha === lastSha) return { newSha: lastSha, newCommits: [] };

  const newCommits = [];
  for (const c of commits) {
    if (c.sha === lastSha) break;
    newCommits.push(c);
  }

  // 并行获取详情（最多 5 个，错开请求避免 rate limit）
  const detailed = [];
  const detailTasks = newCommits.slice(0, 5).map((c, i) => {
    return sleep(i * 500).then(async () => {
      try { return await fetchCommitDetail(c.sha); }
      catch { return c; }
    });
  });
  const detailResults = await Promise.allSettled(detailTasks);
  for (const r of detailResults) {
    detailed.push(r.status === "fulfilled" ? r.value : newCommits[detailed.length]);
  }
  for (const c of newCommits.slice(5)) detailed.push(c);

  return { newSha: latestSha, newCommits: detailed };
}

/* ══════════════════════════════════════════
   模块 6：智能合约代码监控（RPC Batch）
   ══════════════════════════════════════════ */

/**
 * 用 RPC Batch 一次请求获取所有合约的 bytecode + EIP-1967 implementation
 * 将原来 12+ 次串行 RPC 压缩为 1 次 batch
 */
/**
 * 从 bytecode 中提取 4 字节函数选择器 (function selectors)
 * EVM bytecode 中 PUSH4 指令 (0x63) 后的 4 字节通常是函数选择器
 */
function extractSelectors(bytecode) {
  if (!bytecode || bytecode.length < 10) return [];
  const code = bytecode.startsWith("0x") ? bytecode.slice(2) : bytecode;
  const selectors = new Set();
  for (let i = 0; i < code.length - 8; i += 2) {
    // PUSH4 = 0x63
    if (code.slice(i, i + 2) === "63") {
      const sel = "0x" + code.slice(i + 2, i + 10);
      // 过滤掉明显不是选择器的值（全 0、全 f 等）
      if (sel !== "0x00000000" && sel !== "0xffffffff" && !/^0x0{7}/.test(sel)) {
        selectors.add(sel);
      }
    }
  }
  return [...selectors];
}

// 常见 ERC/DeFi 函数选择器 → 可读名称
const KNOWN_SELECTORS = {
  "0xa9059cbb": "transfer(address,uint256)",
  "0x23b872dd": "transferFrom(address,address,uint256)",
  "0x095ea7b3": "approve(address,uint256)",
  "0x70a08231": "balanceOf(address)",
  "0x18160ddd": "totalSupply()",
  "0xdd62ed3e": "allowance(address,address)",
  "0x313ce567": "decimals()",
  "0x06fdde03": "name()",
  "0x95d89b41": "symbol()",
  "0x8da5cb5b": "owner()",
  "0x715018a6": "renounceOwnership()",
  "0xf2fde38b": "transferOwnership(address)",
  "0x3659cfe6": "upgradeTo(address)",
  "0x4f1ef286": "upgradeToAndCall(address,bytes)",
  "0x5c60da1b": "implementation()",
  "0xf851a440": "admin()",
  "0x8f283970": "changeAdmin(address)",
  "0x3ccfd60b": "withdraw()",
  "0xd0e30db0": "deposit()",
  "0x2e1a7d4d": "withdraw(uint256)",
  "0xa694fc3a": "stake(uint256)",
  "0x2e17de78": "unstake(uint256)",
  "0xe9fad8ee": "exit()",
  "0x372500ab": "claimReward()",
  "0x38ed1739": "swapExactTokensForTokens",
  "0x7ff36ab5": "swapExactETHForTokens",
  "0x791ac947": "swapExactTokensForETH",
  "0xe8e33700": "addLiquidity",
  "0xf305d719": "addLiquidityETH",
  "0xbaa2abde": "removeLiquidity",
  "0x02751cec": "removeLiquidityETH",
  "0x40c10f19": "mint(address,uint256)",
  "0x42966c68": "burn(uint256)",
  "0x79cc6790": "burnFrom(address,uint256)",
  "0x5c975abb": "paused()",
  "0x8456cb59": "pause()",
  "0x3f4ba83a": "unpause()",
  "0x01ffc9a7": "supportsInterface(bytes4)",
  "0x6352211e": "ownerOf(uint256)",
  "0x42842e0e": "safeTransferFrom(address,address,uint256)",
  "0xb88d4fde": "safeTransferFrom(address,address,uint256,bytes)",
  [SEL.nftCount.toLowerCase()]:   "nftCount()",
  [SEL.nftAt.toLowerCase()]:      "nftAt(uint256)",
  [SEL.isAgent.toLowerCase()]:    "isAgent(address)",
  [SEL.getTokenInfo.toLowerCase()]:   "getTokenInfo(address)",
  [SEL._tokenInfos.toLowerCase()]:    "_tokenInfos(address)",
  [SEL._tokenInfoEx1s.toLowerCase()]: "_tokenInfoEx1s(address)",
  [SEL.templates.toLowerCase()]:      "templates()",
  "0x7ba9413c": "openFourCore()",
  "0x7b103999": "registry()",
  "0xf29ebf61": "feeRouter()",
  "0xf2f4eb26": "core()",
};

function isValidAddress(addr) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(addr || ""));
}

function normalizeAddress(addr) {
  return isValidAddress(addr) ? String(addr).toLowerCase() : "";
}

const ZERO_ADDRESS = "0x" + "0".repeat(40);
const OPEN_FOUR_LABELS = {
  registry: "OpenFourRegistry",
  core: "OpenFourCore",
  feeRouter: "OpenFourFeeRouter",
  tools: "OpenFourTools",
};
const OPEN_FOUR_SELECTORS = {
  openFourCore: "0x7ba9413c", // openFourCore()
  registry:     "0x7b103999", // registry()
  feeRouter:    "0xf29ebf61", // feeRouter()
  core:         "0xf2f4eb26", // core()
};

function decodeRpcAddress(hex, offset = 0) {
  const clean = typeof hex === "string" && hex.startsWith("0x") ? hex.slice(2) : "";
  const start = offset * 64;
  if (clean.length < start + 64) return "";
  const addr = normalizeAddress("0x" + clean.slice(start + 24, start + 64));
  return addr && addr !== ZERO_ADDRESS ? addr : "";
}

function normalizeContractLabel(name) {
  return String(name || "")
    .trim()
    .replace(/[^\w.-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function staticContractTargets() {
  return [
    { label: "TokenManager_V1",  addr: CONFIG.contracts.tokenManagerV1, source: "static" },
    { label: "TokenManager2_V2", addr: CONFIG.contracts.tokenManagerV2, source: "static" },
    { label: "Helper3_BSC",      addr: CONFIG.contracts.helper3BSC, source: "static" },
    { label: "AgentIdentifier",  addr: CONFIG.contracts.agentIdentifier, source: "static" },
  ].map(c => ({ ...c, addr: normalizeAddress(c.addr) })).filter(c => c.addr);
}

async function fetchPublicAddressContractTargets() {
  const res = await fetchSafe(`${CONFIG.apiBase}/v1/public/address`, {
    headers: { "User-Agent": nextUA(), "Accept": "application/json" },
  }, 3_000);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json?.code !== 0 && json?.code !== "0") {
    throw new Error(`API code=${json?.code}: ${json?.message || json?.msg || ""}`);
  }
  if (!Array.isArray(json.data)) throw new Error("public address data is not an array");

  const targets = [];
  for (const item of json.data) {
    if (item?.networkCode && item.networkCode !== CONFIG.networkCode) continue;
    const addr = normalizeAddress(item?.address);
    const label = normalizeContractLabel(item?.name);
    if (!addr || !label) continue;
    targets.push({
      label,
      addr,
      source: "public_address",
      networkCode: item.networkCode || CONFIG.networkCode,
    });
  }
  return targets;
}

function previousPublicAddressContractTargets() {
  const oldFp = snapshot?.contractFingerprints || {};
  return Object.entries(oldFp)
    .filter(([label, data]) => {
      const source = String(data?.source || "");
      return isValidAddress(data?.address)
        && (source.startsWith("public_address")
          || source.startsWith("onchain")
          || label.startsWith("OpenFour"));
    })
    .map(([label, data]) => ({
      label,
      addr: normalizeAddress(data.address),
      source: data.source || "public_address",
      networkCode: data.networkCode || CONFIG.networkCode,
      cached: true,
    }));
}

function findContractTargetByLabel(targets, label) {
  return targets.find(t => t?.label === label && normalizeAddress(t.addr));
}

function previousContractTargetByLabel(label) {
  const data = snapshot?.contractFingerprints?.[label];
  const addr = normalizeAddress(data?.address);
  if (!addr) return null;
  return {
    label,
    addr,
    source: data.source || "snapshot",
    networkCode: data.networkCode || CONFIG.networkCode,
  };
}

function setContractTarget(targets, target) {
  const addr = normalizeAddress(target?.addr);
  const label = target?.label;
  if (!addr || !label) return;
  const normalized = { ...target, addr, networkCode: target.networkCode || CONFIG.networkCode };
  const idx = targets.findIndex(t => t.label === label);
  if (idx >= 0) targets[idx] = { ...targets[idx], ...normalized };
  else targets.push(normalized);
}

function addUniqueContractTarget(targets, seenLabels, seenAddresses, target) {
  const addr = normalizeAddress(target?.addr);
  const label = target?.label;
  if (!addr || !label) return false;
  if (seenLabels.has(label) || seenAddresses.has(addr)) return false;
  targets.push({ ...target, addr, networkCode: target.networkCode || CONFIG.networkCode });
  seenLabels.add(label);
  seenAddresses.add(addr);
  return true;
}

async function fetchOnchainOpenFourTargets(publicTargets = []) {
  const targets = [];
  const publicRegistry = findContractTargetByLabel(publicTargets, OPEN_FOUR_LABELS.registry);
  const cachedRegistry = previousContractTargetByLabel(OPEN_FOUR_LABELS.registry);
  const configuredRegistry = normalizeAddress(CONFIG.contracts.openFourRegistry);
  const registryAddr = normalizeAddress(publicRegistry?.addr || cachedRegistry?.addr || configuredRegistry);
  if (!registryAddr) return targets;
  const registrySource = publicRegistry ? (publicRegistry.cached ? "snapshot_seed" : "public_address_seed") : (cachedRegistry ? "snapshot_seed" : "configured_registry_seed");
  const registryVia = publicRegistry ? (publicRegistry.cached ? "snapshot seed" : "/v1/public/address seed") : (cachedRegistry ? "snapshot seed" : "CONFIG.contracts.openFourRegistry");

  setContractTarget(targets, {
    label: OPEN_FOUR_LABELS.registry,
    addr: registryAddr,
    source: registrySource,
    discoveredVia: registryVia,
  });

  const fallbackCore = findContractTargetByLabel(publicTargets, OPEN_FOUR_LABELS.core)
    || previousContractTargetByLabel(OPEN_FOUR_LABELS.core);
  const fallbackFeeRouter = findContractTargetByLabel(publicTargets, OPEN_FOUR_LABELS.feeRouter)
    || previousContractTargetByLabel(OPEN_FOUR_LABELS.feeRouter);
  const fallbackTools = findContractTargetByLabel(publicTargets, OPEN_FOUR_LABELS.tools)
    || previousContractTargetByLabel(OPEN_FOUR_LABELS.tools);

  const [coreHex] = await bscRpcBatch([{
    method: "eth_call",
    params: [{ to: registryAddr, data: OPEN_FOUR_SELECTORS.openFourCore }, "latest"],
  }]);
  let coreAddr = decodeRpcAddress(coreHex);
  if (coreAddr) {
    setContractTarget(targets, {
      label: OPEN_FOUR_LABELS.core,
      addr: coreAddr,
      source: "onchain_registry",
      discoveredVia: "OpenFourRegistry.openFourCore()",
      linkedRegistry: registryAddr,
    });
  } else if (fallbackCore?.addr) {
    coreAddr = normalizeAddress(fallbackCore.addr);
    setContractTarget(targets, {
      ...fallbackCore,
      source: `${fallbackCore.source || "public_address"}_fallback`,
      discoveredVia: "fallback: OpenFourRegistry.openFourCore() unavailable",
    });
  }

  let feeRouterAddr = "";
  if (coreAddr) {
    const [coreRegistryHex, feeRouterHex] = await bscRpcBatch([
      { method: "eth_call", params: [{ to: coreAddr, data: OPEN_FOUR_SELECTORS.registry }, "latest"] },
      { method: "eth_call", params: [{ to: coreAddr, data: OPEN_FOUR_SELECTORS.feeRouter }, "latest"] },
    ]);
    const linkedRegistry = decodeRpcAddress(coreRegistryHex);
    feeRouterAddr = decodeRpcAddress(feeRouterHex);
    const coreTarget = findContractTargetByLabel(targets, OPEN_FOUR_LABELS.core);
    if (coreTarget) {
      if (linkedRegistry) coreTarget.linkedRegistry = linkedRegistry;
      if (feeRouterAddr) coreTarget.linkedFeeRouter = feeRouterAddr;
    }

    if (feeRouterAddr) {
      setContractTarget(targets, {
        label: OPEN_FOUR_LABELS.feeRouter,
        addr: feeRouterAddr,
        source: "onchain_core",
        discoveredVia: "OpenFourCore.feeRouter()",
        linkedCore: coreAddr,
        linkedRegistry: linkedRegistry || registryAddr,
      });
    }
  }

  if (!feeRouterAddr && fallbackFeeRouter?.addr) {
    feeRouterAddr = normalizeAddress(fallbackFeeRouter.addr);
    setContractTarget(targets, {
      ...fallbackFeeRouter,
      source: `${fallbackFeeRouter.source || "public_address"}_fallback`,
      discoveredVia: "fallback: OpenFourCore.feeRouter() unavailable",
    });
  }

  if (feeRouterAddr) {
    const [routerCoreHex, routerRegistryHex] = await bscRpcBatch([
      { method: "eth_call", params: [{ to: feeRouterAddr, data: OPEN_FOUR_SELECTORS.core }, "latest"] },
      { method: "eth_call", params: [{ to: feeRouterAddr, data: OPEN_FOUR_SELECTORS.registry }, "latest"] },
    ]);
    const routerCore = decodeRpcAddress(routerCoreHex);
    const routerRegistry = decodeRpcAddress(routerRegistryHex);
    const routerTarget = findContractTargetByLabel(targets, OPEN_FOUR_LABELS.feeRouter);
    if (routerTarget) {
      if (routerCore) routerTarget.linkedCore = routerCore;
      if (routerRegistry) routerTarget.linkedRegistry = routerRegistry;
      if (!routerTarget.source?.startsWith("onchain") && routerCore && coreAddr && routerCore === coreAddr) {
        routerTarget.source = "public_address_onchain_verified";
        routerTarget.discoveredVia = "OpenFourFeeRouter.core() -> OpenFourCore";
      }
    }
  }

  if (fallbackTools?.addr) {
    let toolsCore = "";
    if (coreAddr) {
      const [toolsCoreHex] = await bscRpcBatch([{
        method: "eth_call",
        params: [{ to: normalizeAddress(fallbackTools.addr), data: OPEN_FOUR_SELECTORS.core }, "latest"],
      }]);
      toolsCore = decodeRpcAddress(toolsCoreHex);
    }
    const verified = Boolean(toolsCore && coreAddr && toolsCore === coreAddr);
    setContractTarget(targets, {
      ...fallbackTools,
      source: verified ? "public_address_onchain_verified" : (fallbackTools.source || "public_address"),
      discoveredVia: verified ? "OpenFourTools.core() -> OpenFourCore" : "public address fallback",
      linkedCore: toolsCore || undefined,
    });
  }

  return targets;
}

async function buildContractTargets() {
  const targets = [];
  const seenLabels = new Set();
  const seenAddresses = new Set();
  for (const target of staticContractTargets()) {
    addUniqueContractTarget(targets, seenLabels, seenAddresses, target);
  }
  const cachedPublicTargets = previousPublicAddressContractTargets();
  const publicTargetsPromise = fetchPublicAddressContractTargets().catch(err => {
    log(`[合约] 公共地址接口获取失败，复用 ${cachedPublicTargets.length} 个缓存目标：${err.message}`);
    return cachedPublicTargets;
  });
  let onchainTargets = [];

  try {
    onchainTargets = await fetchOnchainOpenFourTargets(cachedPublicTargets);
  } catch (err) {
    log(`[合约] OpenFour 链上发现失败，改用公共/缓存目标：${err.message}`);
  }

  const publicTargets = await publicTargetsPromise;
  const discoveredRegistry = findContractTargetByLabel(onchainTargets, OPEN_FOUR_LABELS.registry);
  const publicRegistry = findContractTargetByLabel(publicTargets, OPEN_FOUR_LABELS.registry);
  const hasVerifiedTools = Boolean(findContractTargetByLabel(onchainTargets, OPEN_FOUR_LABELS.tools));
  const hasPublicTools = Boolean(findContractTargetByLabel(publicTargets, OPEN_FOUR_LABELS.tools));
  const shouldRefreshFromPublic = (publicRegistry?.addr && publicRegistry.addr !== discoveredRegistry?.addr)
    || (hasPublicTools && !hasVerifiedTools);
  if (shouldRefreshFromPublic) {
    try {
      onchainTargets = await fetchOnchainOpenFourTargets(publicTargets);
    } catch (err) {
      log(`[合约] OpenFour 公共地址补种发现失败，保留缓存/配置发现结果：${err.message}`);
    }
  }

  for (const target of onchainTargets) {
    addUniqueContractTarget(targets, seenLabels, seenAddresses, target);
  }

  for (const target of publicTargets) {
    addUniqueContractTarget(targets, seenLabels, seenAddresses, target);
  }

  return targets;
}

async function fetchContractFingerprints() {
  const result = {};
  const bscContracts = await buildContractTargets();

  // Phase 1: batch 获取所有合约的 code + storage slot
  const calls = [];
  for (const c of bscContracts) {
    calls.push({ method: "eth_getCode", params: [c.addr, "latest"] });
    calls.push({ method: "eth_getStorageAt", params: [c.addr, CONFIG.eip1967Slot, "latest"] });
  }

  const batchResults = await bscRpcBatch(calls);

  // Phase 2: 检查哪些合约有 implementation，收集需要再查 code 的 impl 地址
  const implCalls = [];
  const implMapping = []; // { label, implAddr }
  for (let i = 0; i < bscContracts.length; i++) {
    const c = bscContracts[i];
    const code = batchResults[i * 2] || "0x";
    const rawSlot = batchResults[i * 2 + 1] || "0x" + "0".repeat(64);

    const codeSize = code ? Math.floor((code.length - 2) / 2) : 0;
    result[c.label] = {
      codeHash: md5(code),
      codeSize,
      address: c.addr,
      source: c.source || "static",
      networkCode: c.networkCode || CONFIG.networkCode,
      selectors: extractSelectors(code),
    };
    for (const field of ["discoveredVia", "linkedRegistry", "linkedCore", "linkedFeeRouter"]) {
      if (c[field]) result[c.label][field] = c[field];
    }

    const impl = "0x" + rawSlot.slice(26);
    const isProxy = impl !== "0x0000000000000000000000000000000000000000"
      && rawSlot !== "0x0000000000000000000000000000000000000000000000000000000000000000";

    if (isProxy) {
      result[c.label].implAddress = impl;
      implCalls.push({ method: "eth_getCode", params: [impl, "latest"] });
      implMapping.push({ label: c.label, implAddr: impl });
    }
  }

  // Phase 3: batch 获取所有 implementation 的 code
  if (implCalls.length > 0) {
    const implResults = await bscRpcBatch(implCalls);
    for (let i = 0; i < implMapping.length; i++) {
      const implCode = implResults[i] || "0x";
      const implSize = implCode ? Math.floor((implCode.length - 2) / 2) : 0;
      result[implMapping[i].label].implCodeHash = md5(implCode);
      result[implMapping[i].label].implCodeSize = implSize;
      result[implMapping[i].label].implSelectors = extractSelectors(implCode);
    }
  }

  return result;
}

function diffContractFingerprints(oldFp, newFp) {
  const changes = [];
  if (!oldFp || !newFp) return changes;

  function selectorDiff(oldSels, newSels) {
    const oldSet = new Set(oldSels || []);
    const newSet = new Set(newSels || []);
    return {
      added: (newSels || []).filter(s => !oldSet.has(s)),
      removed: (oldSels || []).filter(s => !newSet.has(s)),
    };
  }
  function withContractMeta(entry, data) {
    for (const field of ["discoveredVia", "linkedRegistry", "linkedCore", "linkedFeeRouter"]) {
      if (data?.[field]) entry[field] = data[field];
    }
    return entry;
  }

  for (const [label, newData] of Object.entries(newFp)) {
    const oldData = oldFp[label];
    if (!oldData) {
      const entry = { type: "新合约", label, address: newData.address };
      // 对新合约也展示其函数选择器，帮助理解用途
      entry.source = newData.source;
      withContractMeta(entry, newData);
      const sels = newData.selectors || newData.implSelectors || [];
      if (sels.length > 0) {
        entry.selectorDiff = { added: sels, removed: [] };
      }
      changes.push(entry);
      continue;
    }
    if (normalizeAddress(oldData.address) !== normalizeAddress(newData.address)) {
      changes.push(withContractMeta({
        type: "合约地址变更", label,
        oldAddress: oldData.address,
        address: newData.address,
        source: newData.source,
      }, newData));
    }
    if (oldData.codeHash !== newData.codeHash) {
      const entry = withContractMeta({
        type: "Bytecode 变更", label, address: newData.address,
        source: newData.source,
        oldHash: oldData.codeHash, newHash: newData.codeHash,
        oldSize: oldData.codeSize, newSize: newData.codeSize,
        selectorDiff: selectorDiff(oldData.selectors, newData.selectors),
      }, newData);
      changes.push(entry);
    }
    if (oldData.implAddress && newData.implAddress && oldData.implAddress !== newData.implAddress) {
      changes.push(withContractMeta({
        type: "代理升级（Implementation 变更）", label, address: newData.address,
        source: newData.source,
        oldImpl: oldData.implAddress, newImpl: newData.implAddress,
        oldSize: oldData.implCodeSize, newSize: newData.implCodeSize,
        selectorDiff: selectorDiff(oldData.implSelectors, newData.implSelectors),
      }, newData));
    }
    if (oldData.implCodeHash && newData.implCodeHash && oldData.implCodeHash !== newData.implCodeHash
        && oldData.implAddress === newData.implAddress) {
      changes.push(withContractMeta({
        type: "Implementation Bytecode 变更", label,
        address: newData.implAddress || newData.address,
        source: newData.source,
        oldHash: oldData.implCodeHash, newHash: newData.implCodeHash,
        oldSize: oldData.implCodeSize, newSize: newData.implCodeSize,
        selectorDiff: selectorDiff(oldData.implSelectors, newData.implSelectors),
      }, newData));
    }

    for (const [field, title] of [
      ["linkedRegistry", "linkedRegistry"],
      ["linkedCore", "linkedCore"],
      ["linkedFeeRouter", "linkedFeeRouter"],
    ]) {
      const oldValue = normalizeAddress(oldData[field]);
      const newValue = normalizeAddress(newData[field]);
      if (oldValue && newValue && oldValue !== newValue) {
        changes.push(withContractMeta({
          type: "链上关系变更",
          label,
          address: newData.address,
          source: newData.source,
          relationField: title,
          oldRelation: oldValue,
          relation: newValue,
        }, newData));
      }
    }
  }
  for (const label of Object.keys(oldFp)) {
    if (!(label in newFp)) changes.push({ type: "合约消失", label, address: oldFp[label].address, source: oldFp[label].source });
  }
  return changes;
}

function formatContractChanges(changes) {
  const lines = [];
  for (const c of changes) {
    lines.push(`**🔧 ${c.type}：${c.label}**`);
    lines.push("```");
    if (c.oldAddress) {
      lines.push(`- address: ${c.oldAddress}`);
      lines.push(`+ address: ${c.address}`);
    } else {
      lines.push(`  address: ${c.address}`);
    }
    if (c.source) lines.push(`  source: ${c.source}`);
    if (c.discoveredVia) lines.push(`  via: ${c.discoveredVia}`);
    if (c.oldRelation && c.relation) {
      lines.push(`- ${c.relationField}: ${c.oldRelation}`);
      lines.push(`+ ${c.relationField}: ${c.relation}`);
    }
    if (c.linkedRegistry) lines.push(`  linkedRegistry: ${c.linkedRegistry}`);
    if (c.linkedCore) lines.push(`  linkedCore: ${c.linkedCore}`);
    if (c.linkedFeeRouter) lines.push(`  linkedFeeRouter: ${c.linkedFeeRouter}`);
    if (c.oldHash && c.newHash) { lines.push(`- codeHash: ${c.oldHash}`); lines.push(`+ codeHash: ${c.newHash}`); }
    if (c.oldImpl && c.newImpl) { lines.push(`- impl: ${c.oldImpl}`); lines.push(`+ impl: ${c.newImpl}`); }
    if (c.oldSize !== undefined && c.newSize !== undefined) {
      const delta = c.newSize - c.oldSize;
      const sign = delta > 0 ? "+" : "";
      lines.push(`  bytecode 大小: ${c.oldSize} → ${c.newSize} bytes (${sign}${delta})`);
    }
    lines.push("```");

    // 函数选择器 diff — 揭示合约接口的增减
    if (c.selectorDiff) {
      const sd = c.selectorDiff;
      if (sd.added.length > 0 || sd.removed.length > 0) {
        lines.push("**接口变更（函数选择器 diff）：**");
        lines.push("```");
        for (const s of sd.added.slice(0, 15)) {
          const name = KNOWN_SELECTORS[s.toLowerCase()];
          lines.push(`+ ${s}${name ? " → " + name : ""}`);
        }
        if (sd.added.length > 15) lines.push(`  ... 还有 ${sd.added.length - 15} 个新增`);
        for (const s of sd.removed.slice(0, 15)) {
          const name = KNOWN_SELECTORS[s.toLowerCase()];
          lines.push(`- ${s}${name ? " → " + name : ""}`);
        }
        if (sd.removed.length > 15) lines.push(`  ... 还有 ${sd.removed.length - 15} 个移除`);
        lines.push("```");
        // 生成可读摘要供 AI 分析
        const addedNames = sd.added.map(s => KNOWN_SELECTORS[s.toLowerCase()]).filter(Boolean);
        const removedNames = sd.removed.map(s => KNOWN_SELECTORS[s.toLowerCase()]).filter(Boolean);
        if (addedNames.length > 0) lines.push(`**新增功能：** ${addedNames.join("、")}`);
        if (removedNames.length > 0) lines.push(`**移除功能：** ${removedNames.join("、")}`);
        if (sd.added.length > addedNames.length) {
          lines.push(`**未识别的新增选择器：** ${sd.added.length - addedNames.length} 个（可能是业务自定义函数）`);
        }
      } else {
        lines.push("接口不变（函数选择器一致），仅内部逻辑修改");
      }
    }
    lines.push("---");
  }
  return lines.join("\n");
}

/* ══════════════════════════════════════════
   模块 7：链上参数监控（RPC Batch）
   ══════════════════════════════════════════ */

/**
 * 用 RPC Batch 读取 AgentIdentifier NFT 列表
 * 第一步 batch 拿 nftCount，第二步 batch 拿所有 nftAt(i)
 */
async function fetchAgentNftList() {
  const ai = CONFIG.contracts.agentIdentifier;

  // Step 1: nftCount
  const countHex = await bscRpcCall("eth_call", [{ to: ai, data: SEL.nftCount }, "latest"]);
  const count = Number(decodeUint256(countHex));

  if (count === 0) return { nftCount: 0, nfts: [] };

  // Step 2: batch nftAt(0..count-1)，上限 50
  const limit = Math.min(count, 50);
  const calls = [];
  for (let i = 0; i < limit; i++) {
    calls.push({
      method: "eth_call",
      params: [{ to: ai, data: SEL.nftAt + encodeUint256(i) }, "latest"],
    });
  }
  const results = await bscRpcBatch(calls);
  const nfts = results.map(r => r ? decodeAddress(r) : "0x" + "0".repeat(40)).filter(a => a !== "0x" + "0".repeat(40));

  return { nftCount: count, nfts };
}

async function fetchOnchainParams() {
  const params = {};
  try {
    const agentData = await fetchAgentNftList();
    params.agentNftCount = agentData.nftCount;
    params.agentNfts = agentData.nfts;
  } catch (err) {
    log(`  [链上] AgentIdentifier 读取失败：${err.message}`);
    params._fetchError = err.message;
  }
  return params;
}

function diffOnchainParams(oldParams, newParams) {
  // 读取失败时不产生变更，避免空通知和快照污染
  if (newParams._fetchError) return [];
  const changes = [];
  if (!oldParams || !newParams) return changes;
  if (oldParams.agentNftCount !== undefined && newParams.agentNftCount !== undefined) {
    if (oldParams.agentNftCount !== newParams.agentNftCount) {
      changes.push({ type: "Agent NFT 数量变更", old: oldParams.agentNftCount, new: newParams.agentNftCount });
    }
    const oldSet = new Set(oldParams.agentNfts || []);
    const newSet = new Set(newParams.agentNfts || []);
    const added = (newParams.agentNfts || []).filter(a => !oldSet.has(a));
    const removed = (oldParams.agentNfts || []).filter(a => !newSet.has(a));
    if (added.length > 0) changes.push({ type: "新增 Agent NFT 合约", addresses: added });
    if (removed.length > 0) changes.push({ type: "移除 Agent NFT 合约", addresses: removed });
  }
  return changes;
}

function formatOnchainChanges(changes) {
  const lines = [];
  for (const c of changes) {
    if (c.type === "Agent NFT 数量变更") {
      const delta = c.new - c.old;
      const sign = delta > 0 ? "+" : "";
      lines.push(`**🤖 ${c.type}**`);
      lines.push("```");
      lines.push(`- nftCount: ${c.old}`);
      lines.push(`+ nftCount: ${c.new}  (${sign}${delta})`);
      lines.push("```");
      if (delta > 0) lines.push(`说明：AgentIdentifier 合约中注册的 Agent NFT 合约数量增加了 ${delta} 个，通常意味着有新的 AI Agent 代币创建流程被注册。`);
      else lines.push(`说明：Agent NFT 合约数量减少了 ${Math.abs(delta)} 个，可能有 Agent 被注销或迁移。`);
      lines.push("---");
    } else if (c.type === "新增 Agent NFT 合约") {
      lines.push(`**🤖 ${c.type}（${c.addresses.length} 个）**`);
      lines.push("```");
      for (const addr of c.addresses) {
        lines.push(`+ ${addr}`);
      }
      lines.push("```");
      lines.push("**BSCscan 链接：**");
      for (const addr of c.addresses.slice(0, 10)) {
        lines.push(`  [${addr.slice(0, 10)}...](https://bscscan.com/address/${addr})`);
      }
      if (c.addresses.length > 10) lines.push(`  ... 还有 ${c.addresses.length - 10} 个`);
      lines.push(`\n说明：这些地址是新注册到 AgentIdentifier(${CONFIG.contracts.agentIdentifier}) 中的 Agent NFT 合约。每个 NFT 合约通常对应一个具有 AI Agent 属性的 Meme 代币项目。`);
      lines.push("---");
    } else if (c.type === "移除 Agent NFT 合约") {
      lines.push(`**🤖 ${c.type}（${c.addresses.length} 个）**`);
      lines.push("```");
      for (const addr of c.addresses) {
        lines.push(`- ${addr}`);
      }
      lines.push("```");
      lines.push("**BSCscan 链接：**");
      for (const addr of c.addresses.slice(0, 10)) {
        lines.push(`  [${addr.slice(0, 10)}...](https://bscscan.com/address/${addr})`);
      }
      lines.push(`\n说明：这些 Agent NFT 合约已从 AgentIdentifier 中移除，相关 AI Agent 代币可能已停止运营或迁移到新合约。`);
      lines.push("---");
    }
  }
  return lines.join("\n");
}

/* ══════════════════════════════════════════
   模块 8：合约创建者动作监听
   ══════════════════════════════════════════ */

const ACTOR_SELECTOR_INFO = {
  "0x3659cfe6": { name: "upgradeTo(address)", risk: "high" },
  "0x4f1ef286": { name: "upgradeToAndCall(address,bytes)", risk: "high" },
  "0x8f283970": { name: "changeAdmin(address)", risk: "high" },
  "0xf2fde38b": { name: "transferOwnership(address)", risk: "high" },
  "0x2f2ff15d": { name: "grantRole(bytes32,address)", risk: "high" },
  "0xd547741f": { name: "revokeRole(bytes32,address)", risk: "high" },
  "0x8456cb59": { name: "pause()", risk: "high" },
  "0x3f4ba83a": { name: "unpause()", risk: "high" },
  "0x6a761202": { name: "Safe.execTransaction(...)", risk: "high" },
  "0x610b5925": { name: "execTransactionFromModule(address,uint256,bytes,uint8)", risk: "high" },
};

function ensureActorMonitorState() {
  if (!snapshot) snapshot = {};
  if (!snapshot.chainActorMonitor) snapshot.chainActorMonitor = {};
  const state = snapshot.chainActorMonitor;
  if (!state.creators) state.creators = {};
  if (!Array.isArray(state.seenTxs)) state.seenTxs = [];
  if (!state.actors) state.actors = {};
  return state;
}

function blockTag(n) {
  return "0x" + BigInt(n).toString(16);
}

function hexToNumber(hex) {
  if (!hex) return 0;
  return Number(BigInt(hex));
}

function txSelector(input) {
  return typeof input === "string" && input.length >= 10 ? input.slice(0, 10).toLowerCase() : "";
}

function addActorRole(actorMap, address, role, label, source = "") {
  const addr = normalizeAddress(address);
  if (!addr) return;
  if (!actorMap.has(addr)) {
    actorMap.set(addr, { address: addr, roles: [], labels: [], sources: [] });
  }
  const actor = actorMap.get(addr);
  if (role && !actor.roles.includes(role)) actor.roles.push(role);
  if (label && !actor.labels.includes(label)) actor.labels.push(label);
  if (source && !actor.sources.includes(source)) actor.sources.push(source);
}

function isCreatorActionActor(actor) {
  return Boolean(actor?.roles?.some(role => role === "creator" || role === "manual"));
}

function addContractEntry(contractMap, label, address, source = "") {
  const addr = normalizeAddress(address);
  if (!addr) return;
  const old = contractMap.get(addr);
  if (old) {
    if (label && !old.labels.includes(label)) old.labels.push(label);
    if (source && !old.sources.includes(source)) old.sources.push(source);
  } else {
    contractMap.set(addr, { address: addr, labels: label ? [label] : [], sources: source ? [source] : [] });
  }
}

function buildWatchedContractEntries() {
  const contracts = new Map();
  for (const c of staticContractTargets()) addContractEntry(contracts, c.label, c.addr, c.source || "static");
  for (const [label, data] of Object.entries(snapshot?.contractFingerprints || {})) {
    addContractEntry(contracts, label, data.address, data.source || "snapshot");
    if (data.implAddress) addContractEntry(contracts, `${label}.implementation`, data.implAddress, "implementation");
    for (const field of ["linkedRegistry", "linkedCore", "linkedFeeRouter"]) {
      if (data[field]) addContractEntry(contracts, `${label}.${field}`, data[field], "linked");
    }
  }
  return [...contracts.values()];
}

function cachedCreatorMap(state) {
  const result = {};
  for (const [contract, data] of Object.entries(state.creators || {})) {
    if (normalizeAddress(data?.creator)) result[contract] = data;
  }
  return result;
}

function missingCreatorAddresses(contractEntries, state) {
  const seen = new Set();
  const missing = [];
  for (const c of contractEntries || []) {
    const addr = normalizeAddress(c.address);
    if (!addr || seen.has(addr)) continue;
    seen.add(addr);
    if (!normalizeAddress(state.creators?.[addr]?.creator)) missing.push(addr);
  }
  return missing;
}

function decodeHtmlEntities(input) {
  return String(input || "").replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity) => {
    const key = String(entity || "").toLowerCase();
    if (key === "amp") return "&";
    if (key === "lt") return "<";
    if (key === "gt") return ">";
    if (key === "quot") return '"';
    if (key === "apos") return "'";
    if (key === "nbsp") return " ";
    if (key.startsWith("#x")) {
      const code = Number.parseInt(key.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (key.startsWith("#")) {
      const code = Number.parseInt(key.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return match;
  });
}

function creatorCandidateFromSnippet(snippet, contractAddress) {
  const contract = normalizeAddress(contractAddress);
  const addresses = [];
  const seen = new Set();
  const addressRe = /(?:\/address\/|address=|data-clipboard-text=["'])(0x[a-fA-F0-9]{40})/gi;
  let match;
  while ((match = addressRe.exec(snippet))) {
    const addr = normalizeAddress(match[1]);
    if (!addr || addr === contract || addr === ZERO_ADDRESS || seen.has(addr)) continue;
    seen.add(addr);
    addresses.push(addr);
  }
  if (addresses.length === 0) {
    const rawAddressRe = /(^|[^a-fA-F0-9])(0x[a-fA-F0-9]{40})(?![a-fA-F0-9])/g;
    while ((match = rawAddressRe.exec(snippet))) {
      const addr = normalizeAddress(match[2]);
      if (!addr || addr === contract || addr === ZERO_ADDRESS || seen.has(addr)) continue;
      seen.add(addr);
      addresses.push(addr);
    }
  }
  if (addresses.length === 0) return null;

  const txMatch = snippet.match(/(?:\/tx\/|txnHash=)(0x[a-fA-F0-9]{64})/i) || snippet.match(/0x[a-fA-F0-9]{64}/);
  return {
    creator: addresses[0],
    txHash: String(txMatch?.[1] || txMatch?.[0] || "").toLowerCase(),
  };
}

function extractCreatorFromBscScanHtml(html, contractAddress) {
  const compact = decodeHtmlEntities(html).replace(/\s+/g, " ");
  const snippets = [];
  const labelRe = /(Contract\s*Creator|Creator\s*Address|Created\s*by)/ig;
  let match;
  while ((match = labelRe.exec(compact)) && snippets.length < 6) {
    snippets.push(compact.slice(match.index, match.index + 6_000));
  }
  if (snippets.length === 0) return null;

  for (const snippet of snippets) {
    const candidate = creatorCandidateFromSnippet(snippet, contractAddress);
    if (candidate?.creator) return candidate;
  }
  return null;
}

async function fetchCreatorViaBscScanPage(contractAddress) {
  const contract = normalizeAddress(contractAddress);
  if (!contract) return null;
  const url = `${CONFIG.actorMonitor.explorerPageBase}/address/${contract}`;
  const res = await fetchSafe(url, { headers: browserHeaders() }, 8_000);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const creator = extractCreatorFromBscScanHtml(html, contract);
  if (!creator?.creator) throw new Error(`creator not found on page ${contract.slice(0, 10)}...`);
  return creator;
}

function logCreatorLookupError(lookupState, scope, message, now) {
  const logMessageKey = `${scope}LastLoggedError`;
  const logAtKey = `${scope}LastLogAt`;
  const cooldownMs = CONFIG.actorMonitor.creatorLookupCooldownMs;
  if (lookupState[logMessageKey] !== message || now - (lookupState[logAtKey] || 0) > cooldownMs) {
    const scopeLabel = { rpc: "RPC 反查", page: "BscScan 页面抓取", api: "Etherscan API" }[scope] || scope;
    log(`[创建者] ${scopeLabel}失败，暂停 ${Math.round(cooldownMs / 60_000)} 分钟：${message}`);
    lookupState[logMessageKey] = message;
    lookupState[logAtKey] = now;
  }
}

function creatorMissingKey(missing) {
  return [...missing].sort().join(",");
}

async function fetchCreatorsViaRecentChain(missing, state, lookupState, now) {
  if (!CONFIG.actorMonitor.creatorChainLookupEnabled || missing.length === 0) return;
  if (lookupState.chainNextRetryAt && now < lookupState.chainNextRetryAt) return;

  const missingKey = creatorMissingKey(missing);
  try {
    const latestHex = await bscRpcCall("eth_blockNumber", []);
    const latest = hexToNumber(latestHex);
    const safeLatest = Math.max(0, latest - CONFIG.actorMonitor.confirmations);
    const lowerBound = Math.max(0, safeLatest - CONFIG.actorMonitor.creatorChainLookbackBlocks + 1);

    if (lookupState.chainMissingKey !== missingKey) {
      lookupState.chainMissingKey = missingKey;
      lookupState.chainCursorBlock = safeLatest;
      lookupState.chainNextRetryAt = 0;
    }

    let cursor = Number.isFinite(lookupState.chainCursorBlock) ? lookupState.chainCursorBlock : safeLatest;
    if (cursor > safeLatest || cursor < lowerBound) cursor = safeLatest;
    const toBlock = cursor;
    const fromBlock = Math.max(lowerBound, toBlock - CONFIG.actorMonitor.creatorChainMaxBlocksPerRun + 1);
    if (toBlock < fromBlock) return;

    const targetSet = new Set(missing);
    const receiptBlockCalls = [];
    for (let n = fromBlock; n <= toBlock; n++) {
      receiptBlockCalls.push({ method: "eth_getBlockReceipts", params: [blockTag(n)] });
    }
    const blockReceipts = await bscRpcBatch(receiptBlockCalls);
    let found = 0;
    let receiptBlockSupported = false;
    for (const receipts of blockReceipts) {
      if (!Array.isArray(receipts)) continue;
      receiptBlockSupported = true;
      for (const receipt of receipts) {
        const contract = normalizeAddress(receipt?.contractAddress);
        if (!contract || !targetSet.has(contract)) continue;
        const creator = normalizeAddress(receipt.from);
        const txHash = String(receipt.transactionHash || "").toLowerCase();
        if (!creator || !txHash) continue;
        state.creators[contract] = {
          creator,
          txHash,
          blockNumber: hexToNumber(receipt.blockNumber),
          source: "rpc_block_receipts",
          updatedAt: ts(),
        };
        found++;
      }
    }

    if (!receiptBlockSupported) {
      const blockCalls = [];
      for (let n = fromBlock; n <= toBlock; n++) {
        blockCalls.push({ method: "eth_getBlockByNumber", params: [blockTag(n), true] });
      }
      const blocks = await bscRpcBatch(blockCalls);
      const creationTxs = [];
      for (const block of blocks) {
        for (const tx of block?.transactions || []) {
          if (tx?.to) continue;
          const hash = String(tx.hash || "").toLowerCase();
          const from = normalizeAddress(tx.from);
          if (hash && from) creationTxs.push({ hash, from, blockNumber: hexToNumber(tx.blockNumber || block.number) });
        }
      }
      const receipts = await bscRpcBatch(creationTxs.map(tx => ({ method: "eth_getTransactionReceipt", params: [tx.hash] })));
      for (let i = 0; i < creationTxs.length; i++) {
        const tx = creationTxs[i];
        const receipt = receipts[i];
        const contract = normalizeAddress(receipt?.contractAddress);
        if (!contract || !targetSet.has(contract)) continue;
        state.creators[contract] = {
          creator: tx.from,
          txHash: tx.hash,
          blockNumber: tx.blockNumber,
          source: "rpc_recent_creation",
          updatedAt: ts(),
        };
        found++;
      }
    }

    if (found > 0) {
      lookupState.chainLastSuccessAt = ts();
      lookupState.chainFoundCount = (lookupState.chainFoundCount || 0) + found;
      log(`[创建者] RPC 反查找到 ${found}/${missing.length} 个创建者，区块 ${fromBlock}-${toBlock}`);
    }
    if (fromBlock <= lowerBound) {
      lookupState.chainCursorBlock = 0;
      lookupState.chainExhaustedAt = ts();
      lookupState.chainNextRetryAt = Date.now() + CONFIG.actorMonitor.creatorLookupCooldownMs;
    } else {
      lookupState.chainCursorBlock = fromBlock - 1;
      lookupState.chainNextRetryAt = 0;
    }
    lookupState.chainLastRange = `${fromBlock}-${toBlock}`;
    lookupState.chainLastError = "";
  } catch (err) {
    const message = err.message || String(err);
    const nextNow = Date.now();
    lookupState.chainLastError = message;
    lookupState.chainLastErrorAt = ts();
    lookupState.chainNextRetryAt = nextNow + CONFIG.actorMonitor.creatorLookupCooldownMs;
    logCreatorLookupError(lookupState, "rpc", message, nextNow);
  }
}

async function fetchCreatorsViaBscScanPages(missing, state, lookupState, now) {
  if (!CONFIG.actorMonitor.creatorPageLookupEnabled || missing.length === 0) return;
  if (lookupState.pageNextRetryAt && now < lookupState.pageNextRetryAt) return;

  const targets = missing.slice(0, CONFIG.actorMonitor.creatorPageMaxPerRun);
  let found = 0;
  let firstError = "";
  for (const contract of targets) {
    try {
      const data = await fetchCreatorViaBscScanPage(contract);
      if (!data?.creator) continue;
      state.creators[contract] = {
        creator: data.creator,
        txHash: data.txHash || "",
        source: "bscscan_page",
        updatedAt: ts(),
      };
      found++;
    } catch (err) {
      firstError ||= err.message || String(err);
    }
    await sleep(250);
  }

  const nextNow = Date.now();
  if (found > 0) {
    lookupState.pageLastSuccessAt = ts();
    lookupState.pageFoundCount = (lookupState.pageFoundCount || 0) + found;
    log(`[创建者] BscScan 页面抓取找到 ${found}/${targets.length} 个创建者`);
  }
  if (firstError) {
    lookupState.pageLastError = firstError;
    lookupState.pageLastErrorAt = ts();
    lookupState.pageNextRetryAt = nextNow + CONFIG.actorMonitor.creatorLookupCooldownMs;
    logCreatorLookupError(lookupState, "page", firstError, nextNow);
  } else if (missing.length > targets.length) {
    lookupState.pageNextRetryAt = nextNow + 60_000;
  } else {
    lookupState.pageNextRetryAt = 0;
    lookupState.pageLastError = "";
  }
}

async function fetchCreatorsViaExplorerApi(missing, state, lookupState, now) {
  const apiKey = CONFIG.actorMonitor.explorerApiKey;
  if (!CONFIG.actorMonitor.creatorLookupEnabled || !apiKey || missing.length === 0) return;
  const nextRetryAt = lookupState.apiNextRetryAt || lookupState.nextRetryAt || 0;
  if (nextRetryAt && now < nextRetryAt) return;

  const chunkSize = 5;
  for (let i = 0; i < missing.length; i += chunkSize) {
    const chunk = missing.slice(i, i + chunkSize);
    try {
      const url = new URL(CONFIG.actorMonitor.explorerApiBase);
      url.searchParams.set("chainid", "56");
      url.searchParams.set("module", "contract");
      url.searchParams.set("action", "getcontractcreation");
      url.searchParams.set("contractaddresses", chunk.join(","));
      url.searchParams.set("apikey", apiKey);
      const res = await fetchSafe(url.toString(), { headers: { "User-Agent": nextUA(), "Accept": "application/json" } }, 5_000);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json?.status === "0" && !Array.isArray(json.result)) {
        const detail = typeof json.result === "string" ? json.result : JSON.stringify(json.result || "");
        throw new Error(`${json?.message || "NOTOK"}${detail ? `: ${detail.slice(0, 160)}` : ""}`);
      }
      for (const item of Array.isArray(json.result) ? json.result : []) {
        const contract = normalizeAddress(item.contractAddress || item.contractaddress);
        const creator = normalizeAddress(item.contractCreator || item.contractCreatorAddress || item.creator);
        if (!contract || !creator) continue;
        state.creators[contract] = {
          creator,
          txHash: String(item.txHash || item.transactionHash || "").toLowerCase(),
          source: "etherscan_v2_api",
          updatedAt: ts(),
        };
      }
    } catch (err) {
      const message = err.message || String(err);
      const nextNow = Date.now();
      lookupState.apiLastError = message;
      lookupState.apiLastErrorAt = ts();
      lookupState.apiNextRetryAt = nextNow + CONFIG.actorMonitor.creatorLookupCooldownMs;
      lookupState.nextRetryAt = lookupState.apiNextRetryAt;
      logCreatorLookupError(lookupState, "api", message, nextNow);
      break;
    }
  }
}

async function fetchContractCreatorActors(contractEntries, state) {
  if (contractEntries.length === 0) return cachedCreatorMap(state);

  const lookupState = state.creatorLookup || (state.creatorLookup = {});
  let missing = missingCreatorAddresses(contractEntries, state);
  await fetchCreatorsViaBscScanPages(missing, state, lookupState, Date.now());

  missing = missingCreatorAddresses(contractEntries, state);
  await fetchCreatorsViaRecentChain(missing, state, lookupState, Date.now());

  missing = missingCreatorAddresses(contractEntries, state);
  await fetchCreatorsViaExplorerApi(missing, state, lookupState, Date.now());

  return cachedCreatorMap(state);
}

async function fetchActorContext(contractEntries, state) {
  const actorMap = new Map();
  const contractMap = new Map();
  for (const c of contractEntries) addContractEntry(contractMap, c.labels?.[0] || "", c.address, c.sources?.[0] || "");
  for (const addr of CONFIG.actorMonitor.extraActors) addActorRole(actorMap, addr, "manual", "FOURMEME_WATCH_ACTORS", "env");

  const creatorMap = await fetchContractCreatorActors(contractEntries, state);
  for (const c of contractEntries) {
    const creator = creatorMap[normalizeAddress(c.address)];
    if (creator?.creator) addActorRole(actorMap, creator.creator, "creator", c.labels.join("/"), "explorer");
  }

  return { actors: actorMap, contracts: contractMap };
}

function decodeSafeExecTransaction(input) {
  if (txSelector(input) !== "0x6a761202") return null;
  const clean = input.startsWith("0x") ? input.slice(2) : input;
  const args = clean.slice(8);
  if (args.length < 64 * 3) return null;
  const word = n => args.slice(n * 64, n * 64 + 64);
  const to = normalizeAddress("0x" + word(0).slice(24));
  let dataOffset;
  try {
    dataOffset = Number(BigInt("0x" + word(2)));
  } catch {
    return { to, selector: "" };
  }
  const lenStart = dataOffset * 2;
  if (args.length < lenStart + 64) return { to, selector: "" };
  let dataLen = 0;
  try {
    dataLen = Number(BigInt("0x" + args.slice(lenStart, lenStart + 64)));
  } catch {
    return { to, selector: "" };
  }
  const dataStart = lenStart + 64;
  const dataHex = args.slice(dataStart, dataStart + dataLen * 2);
  return { to, selector: dataHex.length >= 8 ? "0x" + dataHex.slice(0, 8).toLowerCase() : "" };
}

function classifyActorTx(tx, context) {
  const from = normalizeAddress(tx.from);
  const to = normalizeAddress(tx.to);
  const selector = txSelector(tx.input);
  const fromActor = context.actors.get(from);
  const toContract = context.contracts.get(to);
  if (!isCreatorActionActor(fromActor)) return null;

  const selectorInfo = ACTOR_SELECTOR_INFO[selector] || (selector ? { name: KNOWN_SELECTORS[selector] || selector, risk: "medium" } : null);
  const isDeployment = !to;
  const safeExec = decodeSafeExecTransaction(tx.input || "");
  const safeTarget = safeExec?.to ? context.contracts.get(safeExec.to) : null;
  const safeSelectorInfo = safeExec?.selector ? (ACTOR_SELECTOR_INFO[safeExec.selector] || { name: KNOWN_SELECTORS[safeExec.selector] || safeExec.selector, risk: "medium" }) : null;

  let risk = "low";
  let reason = "";
  if (isDeployment) {
    risk = "high";
    reason = "已监听创建者部署新合约";
  } else if (safeExec && (safeTarget || safeSelectorInfo?.risk === "high")) {
    risk = "high";
    reason = `已监听控制合约执行 execTransaction → ${safeTarget?.labels.join("/") || safeExec.to}`;
  } else if (toContract && fromActor) {
    risk = selectorInfo?.risk === "high" ? "high" : "high";
    reason = `已监听创建者调用受监控合约 ${toContract.labels.join("/")}`;
  } else if (selectorInfo?.risk === "high") {
    risk = "high";
    reason = "已监听创建者使用高风险函数选择器";
  } else if (fromActor && selector) {
    risk = "medium";
    reason = "已监听创建者调用外部合约";
  } else {
    return null;
  }

  return {
    risk,
    reason,
    hash: String(tx.hash || "").toLowerCase(),
    blockNumber: hexToNumber(tx.blockNumber),
    from,
    to: to || "",
    fromActor,
    toContract,
    selector,
    method: selectorInfo?.name || (isDeployment ? "合约创建" : ""),
    safeTarget: safeExec?.to || "",
    safeTargetLabel: safeTarget?.labels.join("/") || "",
    safeSelector: safeExec?.selector || "",
    safeMethod: safeSelectorInfo?.name || "",
    value: tx.value || "0x0",
  };
}

async function fetchActorBlockActions(fromBlock, toBlock, context, state) {
  const blockCalls = [];
  for (let n = fromBlock; n <= toBlock; n++) {
    blockCalls.push({ method: "eth_getBlockByNumber", params: [blockTag(n), true] });
  }
  const blocks = await bscRpcBatch(blockCalls);
  const seen = new Set(state.seenTxs || []);
  const actions = [];
  for (const block of blocks) {
    if (!block?.transactions) continue;
    for (const tx of block.transactions) {
      const hash = String(tx.hash || "").toLowerCase();
      if (!hash || seen.has(hash)) continue;
      const action = classifyActorTx(tx, context);
      if (!action) continue;
      actions.push(action);
      seen.add(hash);
    }
  }

  if (actions.length > 0) {
    const receiptResults = await bscRpcBatch(actions.map(a => ({ method: "eth_getTransactionReceipt", params: [a.hash] })));
    for (let i = 0; i < actions.length; i++) {
      const receipt = receiptResults[i];
      actions[i].status = receipt?.status || "";
      actions[i].contractAddress = normalizeAddress(receipt?.contractAddress);
      actions[i].logsCount = Array.isArray(receipt?.logs) ? receipt.logs.length : 0;
    }
  }
  return actions;
}

function rememberActorTxs(state, actions) {
  const merged = [...(state.seenTxs || []), ...actions.map(a => a.hash).filter(Boolean)];
  state.seenTxs = [...new Set(merged)].slice(-500);
}

function formatActorWatchList(context) {
  return [...context.actors.values()].map(actor => ({
    address: actor.address,
    roles: actor.roles,
    labels: actor.labels.slice(0, 8),
    sources: actor.sources,
    actionWatched: isCreatorActionActor(actor),
  }));
}

function formatActorActions(actions) {
  const riskIcon = { high: "🚨", medium: "⚠️", low: "ℹ️" };
  const riskLabel = { high: "高风险", medium: "中风险", low: "低风险" };
  const lines = [];
  for (const a of actions.slice(0, 12)) {
    lines.push(`**${riskIcon[a.risk] || "⚠️"} ${riskLabel[a.risk] || "未知风险"}：${a.method || "已监听地址交易"}**`);
    lines.push("```");
    lines.push(`区块: ${a.blockNumber}`);
    lines.push(`发起地址: ${a.from}`);
    if (a.fromActor) lines.push(`角色: ${a.fromActor.roles.join(",")} (${a.fromActor.labels.slice(0, 4).join("/")})`);
    if (a.to) lines.push(`目标地址: ${a.to}${a.toContract ? ` (${a.toContract.labels.join("/")})` : ""}`);
    if (a.selector) lines.push(`函数选择器: ${a.selector}`);
    if (a.safeTarget) lines.push(`内部目标: ${a.safeTarget}${a.safeTargetLabel ? ` (${a.safeTargetLabel})` : ""}`);
    if (a.safeSelector) lines.push(`内部选择器: ${a.safeSelector}${a.safeMethod ? ` ${a.safeMethod}` : ""}`);
    if (a.contractAddress) lines.push(`新合约: ${a.contractAddress}`);
    if (a.status) lines.push(`状态: ${a.status === "0x1" ? "成功" : a.status}`);
    lines.push(`原因: ${a.reason}`);
    lines.push("```");
    lines.push(`[交易链接](https://bscscan.com/tx/${a.hash})`);
    if (a.contractAddress) lines.push(`[新合约](https://bscscan.com/address/${a.contractAddress})`);
    lines.push("---");
  }
  if (actions.length > 12) lines.push(`还有 ${actions.length - 12} 条动作未展开。`);
  lines.push(`监控时间：${ts()}`);
  return lines.join("\n");
}

async function runActorCheck() {
  if (!CONFIG.actorMonitor.enabled) return;
  const state = ensureActorMonitorState();
  const stateBefore = JSON.stringify(state);
  const contractEntries = buildWatchedContractEntries();
  if (contractEntries.length === 0) {
    log("[创建者] 尚无合约指纹，等待合约模块建立基线");
    return;
  }

  const context = await fetchActorContext(contractEntries, state);
  const actorList = formatActorWatchList(context);
  state.actors = Object.fromEntries(actorList.map(actor => [actor.address, actor]));
  state.actionActorCount = actorList.filter(actor => actor.actionWatched).length;
  state.contractCount = contractEntries.length;
  state.creatorChainLookupEnabled = CONFIG.actorMonitor.creatorChainLookupEnabled;
  state.creatorPageLookupEnabled = CONFIG.actorMonitor.creatorPageLookupEnabled;
  state.creatorApiLookupEnabled = CONFIG.actorMonitor.creatorLookupEnabled;
  state.creatorLookupEnabled = CONFIG.actorMonitor.creatorChainLookupEnabled || CONFIG.actorMonitor.creatorPageLookupEnabled || CONFIG.actorMonitor.creatorLookupEnabled;

  const latestHex = await bscRpcCall("eth_blockNumber", []);
  const latest = hexToNumber(latestHex);
  const safeLatest = Math.max(0, latest - CONFIG.actorMonitor.confirmations);
  if (!state.lastBlock) {
    state.lastBlock = Math.max(0, safeLatest - CONFIG.actorMonitor.bootstrapLookbackBlocks);
    log(`[创建者] 初始化区块游标：${state.lastBlock}（最新块=${latest}，确认块=${safeLatest}）`);
  }

  if (state.lastBlock >= safeLatest) {
    if (stateBefore !== JSON.stringify(state)) await saveSnapshot(snapshot);
    return;
  }

  const fromBlock = state.lastBlock + 1;
  const toBlock = Math.min(safeLatest, fromBlock + CONFIG.actorMonitor.maxBlocksPerRun - 1);
  const actions = await fetchActorBlockActions(fromBlock, toBlock, context, state);
  state.lastBlock = toBlock;
  state.lastBlockAt = ts();
  rememberActorTxs(state, actions);
  await saveSnapshot(snapshot);

  if (actions.length === 0) return;

  const highCount = actions.filter(a => a.risk === "high").length;
  log(`[创建者] 捕获 ${actions.length} 条创建者动作（高风险 ${highCount} 条），区块 ${fromBlock}-${toBlock}`);
  const content = formatActorActions(actions);
  appendHistory("actor", `链上创建者动作（${actions.length}项）`, content.slice(0, 300), content);
  const color = highCount > 0 ? "red" : "yellow";
  await sendThenEnrichWithAi(`链上创建者动作（${actions.length}项）`, content, color, "Four.meme 合约创建者动作", undefined, undefined, undefined, `https://bscscan.com/block/${toBlock}`);

  try {
    log("[创建者] 创建者动作已触发，立即复查合约状态");
    await runContractCheck();
  } catch (err) {
    log(`[创建者] 触发合约复查失败：${err.message}`);
  }
}

/* ══════════════════════════════════════════
   模块运行器（独立定时器 + 防重入）
   ══════════════════════════════════════════ */

/* ── 全局状态 ── */
let snapshot = loadSnapshot();
let startTime = Date.now();
let modulePollCounts = { pool: 0, frontend: 0, api: 0, github: 0, contract: 0, onchain: 0, actor: 0 };
const apiEmptyArrayLogState = new Map();

/* ── 已移除底池缓存（防止 API 短暂返回不完整数据导致误报）── */
const removedPoolsCache = new Map(); // poolKey -> { data, expireAt }
const REMOVED_POOLS_TTL = 600_000; // 10 分钟

function cacheRemovedPools(removedChanges, oldList) {
  if (!removedChanges || removedChanges.length === 0) return;
  const oldMap = buildPoolMap(oldList);
  for (const c of removedChanges) {
    const key = (c.address || c.symbol || "").toLowerCase();
    if (!key) continue;
    const oldData = oldMap.get(key);
    if (oldData) {
      removedPoolsCache.set(key, { data: oldData, expireAt: Date.now() + REMOVED_POOLS_TTL });
    }
  }
}

function reconcilePoolChanges(changes, oldList) {
  const reconciledChanges = [];
  const deferredRemovals = [];

  for (const c of changes) {
    if (c.type === "新增底池") {
      const key = (c.address || c.symbol || "").toLowerCase();
      const cached = removedPoolsCache.get(key);
      if (cached && Date.now() <= cached.expireAt) {
        // 缓存命中：之前被"移除"的底池重新出现
        removedPoolsCache.delete(key);
        // 检查参数是否有变化
        const fc = [];
        const oldItem = cached.data;
        const newItem = c.details || {};
        for (const f of WATCH_FIELDS) {
          const ov = JSON.stringify(oldItem[f] ?? "");
          const nv = JSON.stringify(newItem[f] ?? "");
          if (ov !== nv) fc.push(`${f}: ${ov} → ${nv}`);
        }
        if (fc.length > 0) {
          // 参数不同，转为"参数变更"
          reconciledChanges.push({ type: "参数变更", symbol: c.symbol, address: c.address, fieldChanges: fc });
          log(`[底池] ${c.symbol} 部署抖动修复：移除→新增 转为参数变更`);
        } else {
          // 参数完全相同，静默忽略
          log(`[底池] ${c.symbol} 部署抖动（内容未变），已忽略`);
        }
      } else {
        reconciledChanges.push(c);
      }
    } else if (c.type === "移除底池") {
      // 移除事件暂不推送，先缓存等待确认
      deferredRemovals.push(c);
    } else {
      reconciledChanges.push(c);
    }
  }

  // 缓存本轮移除的底池
  if (deferredRemovals.length > 0) {
    cacheRemovedPools(deferredRemovals, oldList);
    log(`[底池] ${deferredRemovals.length} 个移除事件已缓存，等待确认`);
  }

  return reconciledChanges;
}

// 定期检查过期的移除缓存（过期意味着真的被移除了）并推送通知
async function flushExpiredPoolRemovals() {
  await snapshotMutex.acquire();
  try {
    const now = Date.now();
    const expired = [];
    for (const [key, entry] of removedPoolsCache) {
      if (now > entry.expireAt) {
        expired.push({ type: "移除底池", symbol: entry.data.symbol || entry.data.nativeSymbol || key, address: entry.data.symbolAddress || key, details: entry.data });
        removedPoolsCache.delete(key);
      }
    }
    if (expired.length > 0) {
      log(`[底池] ${expired.length} 个移除事件已确认（缓存过期）`);
      const content = formatPoolChanges(expired);
      appendHistory("pool", `底池移除（${expired.length}项）`, content.slice(0, 300), content);
      await sendThenEnrichWithAi(`底池移除（${expired.length}项）`, content, "red", "Four.meme 底池配置变更", undefined, undefined, undefined, CONFIG.siteUrl);
    }
  } finally {
    snapshotMutex.release();
  }
}

// 定期刷新过期移除缓存
setInterval(() => { flushExpiredPoolRemovals().catch(e => log(`[底池] 移除缓存刷新异常：${e.message}`)); }, 120_000);

/* ── [已移除] 资源/路由抖动缓存和去重缓存 ──
   重构后采用 Flap 架构：assetHash 轻量检测 + fallback 文件列表 diff，
   不再需要 removedAssetsCache / removedRoutesCache / pendingRemovals / frontendNotifyDedup。
*/

/* ── 模块错误计数与告警 ── */
const moduleErrors = {};  // name -> { consecutive, total, lastMsg, lastFailTime, hourlyErrors, alerted }
const ERROR_ALERT_THRESHOLD = 5;  // 连续失败 N 次后推送告警

function recordModuleError(name, errMsg) {
  if (!moduleErrors[name]) moduleErrors[name] = { consecutive: 0, total: 0, lastMsg: "", lastFailTime: 0, hourlyErrors: [], alerted: false };
  const e = moduleErrors[name];
  e.consecutive++;
  e.total++;
  e.lastMsg = errMsg;
  e.lastFailTime = Date.now();
  // 记录最近 2 小时内的错误时间戳（用于心跳汇总）
  e.hourlyErrors.push(Date.now());
  if (e.consecutive >= ERROR_ALERT_THRESHOLD && !e.alerted) {
    e.alerted = true;
    log(`[告警] 模块 ${name} 连续失败 ${e.consecutive} 次：${errMsg}`);
    sendFeishu(`模块异常告警：${name}`,
      `**模块:** ${name}\n**连续失败:** ${e.consecutive} 次\n**累计失败:** ${e.total} 次\n**最近错误:** ${errMsg}`,
      "red"
    ).catch(err => { log(`[飞书] 模块告警推送失败：${err.message}`); });
  }
}

function clearModuleError(name) {
  if (!moduleErrors[name]) return;
  const e = moduleErrors[name];
  if (e.alerted && e.consecutive >= ERROR_ALERT_THRESHOLD) {
    log(`[恢复] 模块 ${name} 已恢复正常（曾连续失败 ${e.consecutive} 次）`);
    sendFeishu(`模块恢复：${name}`,
      `**模块:** ${name}\n**已恢复正常**\n**曾连续失败:** ${e.consecutive} 次`,
      "green"
    ).catch(err => { log(`[飞书] 模块恢复推送失败：${err.message}`); });
  }
  e.consecutive = 0;
  e.alerted = false;
}

/**
 * 创建防重入的模块运行器
 */
function createModuleRunner(name, fn, intervalMs) {
  let running = false;
  let backoffSkips = 0;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await fn();
      modulePollCounts[name]++;
      // warn if recovering from backoff skips (only notify if significant)
      if (backoffSkips > 0) {
        const skipped = backoffSkips;
        backoffSkips = 0;
        log(`[${name}] 退避恢复：此前因风控跳过 ${skipped} 次检测，本轮已完成全量比对`);
        // 仅连续跳过 3 次以上才推送通知，避免短暂退避（如 5s）产生噪音
        if (skipped >= 3) {
          sendFeishu(
            `模块恢复：${name}`,
            `**模块** ${name} 退避结束，已恢复检测\n**跳过次数：** ${skipped}\n**注意：** 退避期间的中间状态变更可能未被捕获`,
            "yellow"
          ).catch(err => { log(`[飞书] 退避恢复推送失败：${err.message}`); });
        }
      }
      clearModuleError(name);
      try { writeFileSync(join(__dirname, "lastpoll.txt"), ts(), "utf-8"); } catch (_) {}
    } catch (err) {
      if (err.message?.includes("[退避中]")) {
        backoffSkips++;
        if (backoffSkips === 1 || backoffSkips % 10 === 0) {
          log(`[${name}] 退避中，已跳过 ${backoffSkips} 次`);
        }
      } else {
        log(`[${name}] 异常：${err.message}`);
        recordModuleError(name, err.message);
      }
    } finally {
      running = false;
    }
  };
  return { name, run, intervalMs };
}

/* ══════════════════════════════════════════
   各模块检测逻辑
   ══════════════════════════════════════════ */

async function runPoolCheck() {
  const poolData = await fetchPoolConfig();
  if (!snapshot || !snapshot.poolConfig) {
    snapshot = snapshot || {};
    snapshot.poolConfig = poolData;
    await saveSnapshot(snapshot);
    const count = buildPoolMap(poolData).size;
    log(`[底池] 首次记录：${count} 个`);
    printPoolList(poolData);
    return;
  }
  let poolChanges = diffPoolConfigs(snapshot.poolConfig, poolData);

  // 部署抖动修复：移除事件先缓存，新增事件查缓存
  if (poolChanges.length > 0) {
    poolChanges = reconcilePoolChanges(poolChanges, snapshot.poolConfig);
  }

  if (poolChanges.length > 0) {
    log(`[底池] 检测到 ${poolChanges.length} 项变化！`);
    const content = formatPoolChanges(poolChanges);
    console.log(content);
    printPoolList(poolData);
    snapshot.poolConfig = poolData;
    await saveSnapshot(snapshot);
    appendHistory("pool", `底池变更（${poolChanges.length}项）`, content.slice(0, 300), content);
    await sendThenEnrichWithAi(`底池变更（${poolChanges.length}项）`, content, "red", "Four.meme 底池配置变更", undefined, undefined, undefined, CONFIG.siteUrl);
  } else {
    if (!jsonEqual(snapshot.poolConfig, poolData)) {
      snapshot.poolConfig = poolData;
      await saveSnapshot(snapshot);
    }
  }
}

async function runFrontendCheck() {
  if (!snapshot) snapshot = {};
  const prunedBeforeRun = pruneFrontendSnapshot(snapshot);
  const oldPages = snapshot.frontendPages || {};
  const { pages: newPages, failedUrls, discoveredUrls } = await fetchFrontendDataWithDiscovery(oldPages);

  // 页面抓取失败告警：连续失败计数
  if (!snapshot._frontendFailCounts) snapshot._frontendFailCounts = {};
  let failCountChanged = false;
  for (const url of failedUrls) {
    const key = urlToKey(url);
    snapshot._frontendFailCounts[key] = (snapshot._frontendFailCounts[key] || 0) + 1;
    failCountChanged = true;
  }
  // 重置成功页面的失败计数
  for (const key of Object.keys(newPages)) {
    if (snapshot._frontendFailCounts[key]) {
      snapshot._frontendFailCounts[key] = 0;
      failCountChanged = true;
    }
  }

  if (!snapshot.frontendPages) {
    const successfulDiscoveredUrls = (discoveredUrls || []).filter(url => newPages[urlToKey(url)]);
    if (CONFIG.frontendDiscovery.enabled) {
      snapshot._frontendDiscoveredUrls = [...new Set([
        ...(snapshot._frontendDiscoveredUrls || []),
        ...successfulDiscoveredUrls.map(canonicalFrontendUrl),
      ])]
        .filter(url => isDiscoverableFrontendUrl(url))
        .slice(0, CONFIG.frontendDiscovery.maxDiscoveredPages);
    }
    snapshot.frontendPages = newPages;
    await saveSnapshot(snapshot);
    const pageDetails = Object.values(newPages).map(p => {
      const label = urlLabel(p.originalUrl);
      const fileCount = (p.assetFiles || []).length;
      const dlCount = Object.keys(p.assetContents || {}).length;
      const textLen = (p.textContent || "").length;
      const hasNextData = p.nextDataHash ? "yes" : "no";
      const i18nCount = p.i18nStrings ? Object.keys(p.i18nStrings).length : 0;
      const routeCount = (p.routes || []).length;
      return `  ${label}: ${fileCount} 个文件（已下载 ${dlCount}），文案 ${textLen} 字，nextData: ${hasNextData}，i18n: ${i18nCount} 键，路由: ${routeCount} 个`;
    });
    log(`[前端] 首次记录：${Object.keys(newPages).length} 个页面\n${pageDetails.join("\n")}`);
    return;
  }

  const notifications = [];
  let snapshotDirty = prunedBeforeRun;

  if (CONFIG.frontendDiscovery.enabled) {
    const oldDiscovered = new Set(snapshot._frontendDiscoveredUrls || []);
    const mergedDiscovered = [...oldDiscovered];
    const successfulDiscoveredUrls = (discoveredUrls || []).filter(url => newPages[urlToKey(url)]);
    for (const url of successfulDiscoveredUrls) {
      const canonical = canonicalFrontendUrl(url);
      if (!oldDiscovered.has(canonical) && isDiscoverableFrontendUrl(canonical)) {
        mergedDiscovered.push(canonical);
        oldDiscovered.add(canonical);
      }
    }
    const cleanedDiscovered = mergedDiscovered
      .filter(url => isDiscoverableFrontendUrl(url))
      .slice(0, CONFIG.frontendDiscovery.maxDiscoveredPages);
    if (JSON.stringify(cleanedDiscovered) !== JSON.stringify(snapshot._frontendDiscoveredUrls || [])) {
      snapshot._frontendDiscoveredUrls = cleanedDiscovered;
      snapshotDirty = true;
    }
  }

  // 连续 3 次抓取失败的页面发送告警（每 3 的倍数重复提醒）
  const FAIL_THRESHOLD = 3;
  for (const url of failedUrls) {
    const key = urlToKey(url);
    const count = snapshot._frontendFailCounts[key] || 0;
    if (count > 0 && count % FAIL_THRESHOLD === 0) {
      notifications.push({
        title: `⚠️ 前端页面不可达：${urlLabel(url)}`,
        content: `页面 ${url} 已连续 ${count} 次抓取失败，可能宕机或被封禁。`,
        template: "red",
        url
      });
      snapshotDirty = true;
    }
  }

  for (const [key, newData] of Object.entries(newPages)) {
    const oldData = oldPages[key];
    if (!oldData) {
      const label = urlLabel(newData.originalUrl);
      const fileCount = (newData.assetFiles || []).length;
      const routeCount = (newData.routes || []).length;
      if (isConfiguredFrontendUrl(newData.originalUrl)) {
        log(`[前端] 默认监控页面已建立基线：${label}（资源 ${fileCount} 个，路由/端点 ${routeCount} 个）`);
        snapshot.frontendPages[key] = newData;
        snapshotDirty = true;
        continue;
      }
      notifications.push({
        title: `前端新增页面：${label}`,
        content: [
          `**🆕 新增监控页面：${label}**`,
          `URL: ${newData.originalUrl}`,
          `资源文件: ${fileCount} 个`,
          `路由/端点: ${routeCount} 个`,
        ].join("\n"),
        template: "orange",
        url: newData.originalUrl,
      });
      snapshot.frontendPages[key] = newData;
      snapshotDirty = true;
      continue;
    }

    const contentParts = [];
    let hasNonAssetChange = false;
    let cachedAssetDiff = null; // 缓存资源 diff 结果，避免重复计算

    // ── 1. 资源文件 diff（独立于下载成功与否）──
    // 先用 assetHash（文件列表 hash）判断是否有变化
    if (oldData.assetHash && newData.assetHash && oldData.assetHash !== newData.assetHash) {
      const hasOldContents = oldData.assetContents && Object.keys(oldData.assetContents).length > 0;
      const hasNewContents = newData.assetContents && Object.keys(newData.assetContents).length > 0;

      if (hasOldContents && hasNewContents) {
        // 深度 diff：基于下载的资源内容
        cachedAssetDiff = diffFrontendAssets(oldData.assetContents, newData.assetContents);
        const hasAssetChange = cachedAssetDiff.matched.length > 0 || cachedAssetDiff.added.length > 0 || cachedAssetDiff.removed.length > 0;
        if (hasAssetChange) {
          contentParts.push(formatFrontendChanges(cachedAssetDiff, null, null, oldData.assetContents, newData.assetContents));
        }
      } else {
        // 降级 fallback：仅基于文件列表 diff（类似 Flap 的 fallback）
        const oldSet = new Set(oldData.assetFiles || []);
        const newSet = new Set(newData.assetFiles || []);
        const added = [...newSet].filter(f => !oldSet.has(f));
        const removed = [...oldSet].filter(f => !newSet.has(f));
        cachedAssetDiff = { matched: [], added, removed, unchanged: 0, renamed: 0 };
        const lines = ["**📦 前端代码（JS/CSS 资源）更新**"];
        if (added.length > 0) lines.push(`  🟢 新增：${added.slice(0, 10).map(f => f.split("/").pop()).join(", ")}${added.length > 10 ? ` ... 等 ${added.length} 个` : ""}`);
        if (removed.length > 0) lines.push(`  🔴 移除：${removed.slice(0, 10).map(f => f.split("/").pop()).join(", ")}${removed.length > 10 ? ` ... 等 ${removed.length} 个` : ""}`);
        if (!hasOldContents || !hasNewContents) {
          lines.push(`  ⚠️ 资源内容下载不完整，仅展示文件列表变更`);
        }
        contentParts.push(lines.join("\n"));
      }
    }

    // ── 2. i18n diff（优先展示，中文内容最具可读性）──
    if (oldData.i18nHash && newData.i18nHash && oldData.i18nHash !== newData.i18nHash) {
      const i18nChanges = diffI18nStrings(oldData.i18nStrings, newData.i18nStrings);
      const i18nFormatted = formatI18nChanges(i18nChanges);
      if (i18nFormatted) {
        contentParts.push(i18nFormatted);
        hasNonAssetChange = true;
      }
    } else if (!oldData.i18nHash && newData.i18nHash && newData.i18nStrings) {
      // 首次出现 i18n 数据
      const keyCount = Object.keys(newData.i18nStrings).length;
      contentParts.push(`**📝 i18n 国际化字符串首次检测到：** ${keyCount} 条翻译`);
      hasNonAssetChange = true;
    } else if (oldData.i18nHash && !newData.i18nHash) {
      contentParts.push("**📝 i18n 国际化字符串被移除**");
      hasNonAssetChange = true;
    }

    // ── 3. 页面文案 diff（独立，不依赖资源下载）──
    let textDiff = null;
    if (oldData.contentHash && newData.contentHash && oldData.contentHash !== newData.contentHash) {
      textDiff = diffTextContent(oldData.textContent, newData.textContent);
      if (textDiff) {
        if (textDiff.reordered) {
          contentParts.push("**📝 页面文案顺序调整（内容不变）**");
          hasNonAssetChange = true;
        } else if (textDiff.changes.length > 0) {
          const lines = ["**📝 页面文案变更：**", "```"];
          for (const c of textDiff.changes.slice(0, 20)) {
            if (c.type === "modified") { lines.push(`- ${c.oldText}`); lines.push(`+ ${c.newText}`); }
            else if (c.type === "added") { lines.push(`+ ${(c.text.length > 120 ? c.text.slice(0, 120) + "..." : c.text)}`); }
            else if (c.type === "removed") { lines.push(`- ${(c.text.length > 120 ? c.text.slice(0, 120) + "..." : c.text)}`); }
          }
          lines.push("```");
          if (textDiff.changes.length > 20) lines.push(`... 还有 ${textDiff.changes.length - 20} 处变更`);
          contentParts.push(lines.join("\n"));
          hasNonAssetChange = true;
        }
      }
    }

    // ── 4. __NEXT_DATA__ diff（独立）──
    if (oldData.nextDataHash && newData.nextDataHash && oldData.nextDataHash !== newData.nextDataHash) {
      const nextDataChanges = diffNextData(oldData.nextData, newData.nextData);
      const nextDataFormatted = formatNextDataChanges(nextDataChanges);
      if (nextDataFormatted) {
        contentParts.push(nextDataFormatted);
        hasNonAssetChange = true;
      }
    } else if (oldData.nextDataHash && !newData.nextDataHash) {
      contentParts.push("**📋 __NEXT_DATA__ 被移除**");
      hasNonAssetChange = true;
    } else if (!oldData.nextDataHash && newData.nextDataHash) {
      contentParts.push("**📋 __NEXT_DATA__ 新出现**");
      hasNonAssetChange = true;
    }

    // ── 5. 路由/端点 diff（独立）──
    const routeDiff = diffRoutes(oldData.routes, newData.routes);
    if (routeDiff.added.length > 0 || routeDiff.removed.length > 0) {
      const routeFormatted = formatRouteChanges(routeDiff);
      if (routeFormatted) {
        contentParts.push(routeFormatted);
        hasNonAssetChange = true;
      }
    }
    // 路由抖动保护：如果 diffRoutes 内部抑制了移除（removed 被清空），
    // 将旧路由合并回 newData，避免下一轮对比时这些路由"复现"被报为新增
    if (oldData.routes && newData.routes) {
      const cleanNewRoutes = sanitizeRouteListForDiff(newData.routes);
      const newSet = new Set(cleanNewRoutes);
      const suppressed = sanitizeRouteListForDiff(oldData.routes).filter(r => !newSet.has(r));
      if (suppressed.length > 0 && routeDiff.removed.length === 0) {
        newData.routes = [...new Set([...cleanNewRoutes, ...suppressed])].sort();
      } else {
        newData.routes = cleanNewRoutes;
      }
    }

    // ── 汇总：只要有任何变更就推送 ──
    const label = urlLabel(newData.originalUrl);
    const jitterDecision = await maybeSuppressTransientAssetJitter(label, oldData, newData, cachedAssetDiff, hasNonAssetChange);
    if (jitterDecision.suppress) {
      snapshot.frontendPages[key] = oldData;
      continue;
    }

    if (contentParts.length > 0) {
      log(`[前端] ${label} 变化！`);
      const content = `**📄 ${label}**\n${contentParts.join("\n\n")}`;

      // 构建详细 diff 文件（复用已计算的 assetDiff）
      const fullDiff = buildFullDiffText(label, cachedAssetDiff, textDiff, routeDiff, [], oldData.assetContents, newData.assetContents);

      notifications.push({ title: `前端变更：${label}`, content, template: "orange", fullDiff, url: newData.originalUrl });
    }

    // 在所有 diff 完成后更新快照
    snapshot.frontendPages[key] = newData;
    snapshotDirty = true;
  }

  if (notifications.length > 0) {
    // ── 同轮跨页面合并：相同内容只保留第一条 ──
    const dedupedNotifications = [];
    const seenContentHashes = new Map();
    for (const n of notifications) {
      const contentHash = md5(n.content);
      if (seenContentHashes.has(contentHash)) {
        const idx = seenContentHashes.get(contentHash);
        const existing = dedupedNotifications[idx];
        const existingLabel = existing.title.replace("前端变更：", "");
        const newLabel = n.title.replace("前端变更：", "");
        if (!existing.title.includes(newLabel)) {
          existing.mergedPages = existing.mergedPages || [existingLabel];
          existing.mergedPages.push(newLabel);
          existing.title = `前端变更：${existing.mergedPages.join("、")}`;
        }
        if (n.fullDiff) existing.fullDiff = (existing.fullDiff || "") + "\n\n" + n.fullDiff;
        log(`[前端] 同轮合并：${newLabel} → 已合并到 ${existingLabel}`);
      } else {
        seenContentHashes.set(contentHash, dedupedNotifications.length);
        dedupedNotifications.push(n);
      }
    }

    await saveSnapshot(snapshot);
    for (const n of dedupedNotifications) {
      appendHistory("frontend", n.title, n.content.slice(0, 300), n.content);
      const diffFilePath = n.fullDiff ? saveDiffLocally(n.title, n.fullDiff) : null;
      await sendThenEnrichWithAi(n.title, n.content, n.template, `Four.meme 前端变更 ${n.title}`, undefined, undefined, diffFilePath, n.url);
    }
  } else if (snapshotDirty || failCountChanged) {
    await saveSnapshot(snapshot);
  }
}

async function runApiCheck() {
  const { structures: rawNewStruct, values: newValues } = await fetchApiData();
  if (!snapshot) snapshot = {};
  const prunedApiKeys = pruneInactiveApiSnapshots(snapshot);
  if (prunedApiKeys.length > 0) {
    log(`[API] 已清理停用端点快照：${prunedApiKeys.join(", ")}`);
  }
  const { structures: newStruct, suppressed: suppressedEmptyArrayStructs } =
    stabilizeApiStructuresForEmptyArrays(snapshot.apiStructure || {}, rawNewStruct);
  if (suppressedEmptyArrayStructs.length > 0) {
    const loggableEmptyArrayStructs = suppressedEmptyArrayStructs.filter(shouldLogApiEmptyArrayPreserve);
    const summary = loggableEmptyArrayStructs
      .map(item => `${item.endpoint}:${item.prefixes.join("/") || "array"}(${item.preserved})`)
      .join(", ");
    if (summary) log(`[API] 空数组样本保护：已保留上一轮数组项结构 ${summary}`);
  }
  if (!snapshot.apiStructure) {
    snapshot.apiStructure = newStruct;
    snapshot.apiValues = stableApiValuesSnapshot(newValues);
    await saveSnapshot(snapshot);
    const epDetails = Object.entries(newStruct).map(([key, fields]) =>
      `  ${key}: ${Object.keys(fields).length} 个字段，${Object.keys(snapshot.apiValues[key] || {}).length} 个稳定值`
    );
    log(`[API] 首次记录：${Object.keys(newStruct).length} 个端点\n${epDetails.join("\n")}`);
    return;
  }
  const notifications = [];

  // 结构变更检测（即时推送，无延迟）
  const apiChanges = diffApiStructures(snapshot.apiStructure, newStruct);
  if (apiChanges.length > 0) {
    log(`[API] 检测到结构变化！`);
    notifications.push(formatApiChanges(apiChanges, newValues));
  }

  // 响应值变更检测
  const valueChanges = diffApiValues(snapshot.apiValues || {}, newValues);
  if (valueChanges.length > 0) {
    log(`[API] 检测到响应值变化！`);
    notifications.push(formatApiValueChanges(valueChanges));
  }

  // 仅保存稳定结构/稳定值，避免动态字段和高频列表导致快照每轮漂移。
  if (!snapshot.apiStructure) snapshot.apiStructure = {};
  if (!snapshot.apiValues) snapshot.apiValues = {};
  const apiStructureBefore = JSON.stringify(snapshot.apiStructure);
  const apiValuesBefore = JSON.stringify(snapshot.apiValues);
  for (const [key, val] of Object.entries(newStruct)) {
    snapshot.apiStructure[key] = val;
  }
  for (const [key, val] of Object.entries(newValues)) {
    const stableValues = stableApiValuesForSnapshot(key, val);
    if (stableValues !== null) snapshot.apiValues[key] = stableValues;
  }
  const apiSnapshotChanged = prunedApiKeys.length > 0
    || apiStructureBefore !== JSON.stringify(snapshot.apiStructure)
    || apiValuesBefore !== JSON.stringify(snapshot.apiValues);

  if (notifications.length > 0) {
    const content = notifications.join("\n\n");
    await saveSnapshot(snapshot);
    appendHistory("api", "API 变更", content.slice(0, 300), content);
    await sendThenEnrichWithAi("API 变更", content, "purple", "Four.meme API 变更", undefined, undefined, undefined, CONFIG.apiBase);
  } else if (apiSnapshotChanged) {
    await saveSnapshot(snapshot);
  }
}

async function runGithubCheck() {
  if (!snapshot) snapshot = {};
  // 从快照恢复 ETag（避免重启后浪费 rate limit）
  if (!githubETag && snapshot.githubETag) githubETag = snapshot.githubETag;
  if (!githubReposETag && snapshot.githubReposETag) githubReposETag = snapshot.githubReposETag;

  const { repoMap, changes: repoChanges } = await checkGithubRepos(
    snapshot.githubRepos || null,
    Boolean(snapshot.githubSha)
  );
  if (githubReposETag && snapshot.githubReposETag !== githubReposETag) {
    snapshot.githubReposETag = githubReposETag;
  }
  if (repoMap && !jsonEqual(snapshot.githubRepos, repoMap)) {
    snapshot.githubRepos = repoMap;
  }
  if (repoChanges) {
    const count = (repoChanges.added?.length || 0) + (repoChanges.removed?.length || 0) + (repoChanges.changed?.length || 0);
    log(`[GitHub] 检测到 ${count} 项账号仓库/项目变更！`);
    const content = formatGithubRepoChanges(repoChanges);
    await saveSnapshot(snapshot);
    appendHistory("github", `GitHub 项目变更（${count}项）`, content.slice(0, 300), content);
    await sendThenEnrichWithAi(`GitHub 项目变更（${count}项）`, content, "turquoise", "Four.meme GitHub 项目变更", undefined, undefined, undefined, `https://github.com/${CONFIG.githubOwner}`);
  }

  const { newSha, newCommits } = await checkGithub(snapshot.githubSha || "");
  // 持久化 ETag
  if (githubETag && snapshot.githubETag !== githubETag) {
    snapshot.githubETag = githubETag;
  }
  if (!snapshot.githubSha) {
    snapshot.githubSha = newSha;
    await saveSnapshot(snapshot);
    log(`[GitHub] 首次记录：${newSha.slice(0, 8)}`);
    return;
  }
  if (newCommits.length > 0) {
    log(`[GitHub] 检测到 ${newCommits.length} 个新提交！`);
    const content = formatGithubChanges(newCommits);
    snapshot.githubSha = newSha;
    await saveSnapshot(snapshot);
    appendHistory("github", `GitHub 新提交（${newCommits.length}个）`, content.slice(0, 300), content);
    await sendThenEnrichWithAi(`GitHub 新提交（${newCommits.length}个）`, content, "turquoise", "Four.meme GitHub 仓库新提交", undefined, undefined, undefined, `https://github.com/${CONFIG.githubRepo}`);
  } else {
    // ETag 变了也保存（即使无新提交）
    await saveSnapshot(snapshot);
  }
}

async function runContractCheck() {
  const newFp = await fetchContractFingerprints();
  if (!snapshot) snapshot = {};
  if (!snapshot.contractFingerprints) {
    snapshot.contractFingerprints = newFp;
    await saveSnapshot(snapshot);
    const labels = Object.entries(newFp).map(([label, data]) =>
      `  ${label} code=${data.codeHash.slice(0, 8)}${data.implAddress ? ` impl=${data.implAddress.slice(0, 10)}...` : ""}`
    );
    log(`[合约] 首次记录：${Object.keys(newFp).length} 个合约\n${labels.join("\n")}`);
    return;
  }
  const contractChanges = diffContractFingerprints(snapshot.contractFingerprints, newFp);
  if (contractChanges.length > 0) {
    log(`[合约] 检测到 ${contractChanges.length} 项变化！`);
    const content = formatContractChanges(contractChanges);
    snapshot.contractFingerprints = newFp;
    await saveSnapshot(snapshot);
    appendHistory("contract", `合约变更（${contractChanges.length}项）`, content.slice(0, 300), content);
    await sendThenEnrichWithAi(`合约变更（${contractChanges.length}项）`, content, "red", "Four.meme 智能合约变更", undefined, undefined, undefined, CONFIG.siteUrl);
  } else {
    if (!jsonEqual(snapshot.contractFingerprints, newFp)) {
      snapshot.contractFingerprints = newFp;
      await saveSnapshot(snapshot);
    }
  }
}

async function runOnchainCheck() {
  const newParams = await fetchOnchainParams();
  if (!snapshot) snapshot = {};
  // 读取失败时不更新快照，保留上次正常数据
  if (newParams._fetchError) {
    log(`[链上] 读取失败：${newParams._fetchError}（保留旧快照）`);
    return;
  }
  if (!snapshot.onchainParams) {
    snapshot.onchainParams = newParams;
    await saveSnapshot(snapshot);
    log(`[链上] 首次记录：AgentIdentifier ${newParams.agentNftCount ?? 0} 个 NFT 合约`);
    return;
  }
  const paramChanges = diffOnchainParams(snapshot.onchainParams, newParams);
  if (paramChanges.length > 0) {
    log(`[链上] 检测到 ${paramChanges.length} 项参数变化！`);
    const content = formatOnchainChanges(paramChanges);
    snapshot.onchainParams = newParams;
    await saveSnapshot(snapshot);
    appendHistory("onchain", `链上参数变更（${paramChanges.length}项）`, content.slice(0, 300), content);
    await sendThenEnrichWithAi(`链上参数变更（${paramChanges.length}项）`, content, "yellow", "Four.meme 链上参数变更", undefined, undefined, undefined, CONFIG.siteUrl);
  } else {
    if (!jsonEqual(snapshot.onchainParams, newParams)) {
      snapshot.onchainParams = newParams;
      await saveSnapshot(snapshot);
    }
  }
}

/* ══════════════════════════════════════════
   启动 & 信号处理
   ══════════════════════════════════════════ */

const modules = [
  createModuleRunner("pool",     runPoolCheck,     CONFIG.intervals.pool),
  createModuleRunner("frontend", runFrontendCheck,  CONFIG.intervals.frontend),
  createModuleRunner("api",      runApiCheck,       CONFIG.intervals.api),
  createModuleRunner("github",   runGithubCheck,    CONFIG.intervals.github),
  createModuleRunner("contract", runContractCheck,  CONFIG.intervals.contract),
  createModuleRunner("onchain",  runOnchainCheck,   CONFIG.intervals.onchain),
  createModuleRunner("actor",    runActorCheck,     CONFIG.intervals.actor),
];

/**
 * 每日报告：汇总过去 24 小时的变更历史
 */
async function sendDailyReport() {
  try {
    const lines = ["**📊 Four.meme 监控日报**", ""];

    // 读取 history.jsonl，筛选过去 24 小时的记录
    const oneDayAgo = new Date(Date.now() - 86_400_000).toISOString();
    let records = [];
    if (existsSync(HISTORY_FILE)) {
      const raw = readFileSync(HISTORY_FILE, "utf-8").split("\n").filter(Boolean);
      for (const line of raw) {
        try {
          const r = JSON.parse(line);
          if (r.ts >= oneDayAgo) records.push(r);
        } catch { /* skip malformed */ }
      }
    }

    // 按模块分组统计
    const byModule = {};
    for (const r of records) {
      if (!byModule[r.module]) byModule[r.module] = [];
      byModule[r.module].push(r);
    }

    // 运行时统计
    const upSec = Math.floor((Date.now() - startTime) / 1000);
    const h = Math.floor(upSec / 3600), m = Math.floor((upSec % 3600) / 60);
    const total = Object.values(modulePollCounts).reduce((a, b) => a + b, 0);
    lines.push(`**运行时长：** ${h}h${m}m | **总检测次数：** ${total}`);
    lines.push("");

    // 变更汇总
    if (records.length === 0) {
      lines.push("✅ 过去 24 小时无变更检出");
    } else {
      lines.push(`**过去 24 小时共 ${records.length} 条变更：**`);
      for (const [mod, items] of Object.entries(byModule)) {
        lines.push(`  • ${mod}: ${items.length} 条`);
        // 列出最近 3 条标题
        for (const item of items.slice(-3)) {
          const time = new Date(item.ts).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
          lines.push(`    - [${time}] ${item.title}`);
        }
        if (items.length > 3) lines.push(`    ... 还有 ${items.length - 3} 条`);
      }
    }

    // 模块错误汇总
    const errorSummary = [];
    for (const [name, e] of Object.entries(moduleErrors)) {
      const recentCount = (e.hourlyErrors || []).length;
      if (recentCount > 0 || e.consecutive > 0) {
        errorSummary.push(`  • ${name}: ${e.consecutive > 0 ? `当前连续失败 ${e.consecutive} 次` : `已恢复（24h 内失败 ${recentCount} 次）`}`);
      }
    }
    if (errorSummary.length > 0) {
      lines.push("");
      lines.push("**⚠ 异常模块：**");
      lines.push(errorSummary.join("\n"));
    } else {
      lines.push("");
      lines.push("✅ 所有模块运行正常");
    }

    // 底池状态
    const poolCount = buildPoolMap(snapshot?.poolConfig).size;
    if (poolCount > 0) {
      lines.push("");
      lines.push(`**当前底池：** ${poolCount} 个`);
    }

    await sendFeishu("📊 监控日报", lines.join("\n"), "blue");
    log("[日报] 已发送");
  } catch (err) {
    log(`[日报] 发送失败：${err.message}`);
  }
}

async function startAllModules() {
  log("Four.meme 全面监控 v2 启动中...");
  log("模块频率：");
  for (const m of modules) {
    log(`  ${m.name.padEnd(12)} ${(m.intervalMs / 1000).toFixed(0)}s`);
  }

  if (snapshot) {
    const poolCount = buildPoolMap(snapshot.poolConfig).size;
    const pageCount = Object.keys(snapshot.frontendPages || {}).length;
    log(`已加载历史快照（底池 ${poolCount} 个，前端 ${pageCount} 个页面），开始监控...`);
    printPoolList(snapshot.poolConfig);
  }

  // 首次启动：所有模块依次执行一次（建立基线）
  for (const m of modules) {
    await m.run();
    await sleep(500); // 各模块间隔 500ms，避免同时大量请求
  }

  // 发送启动通知
  const poolCount = buildPoolMap(snapshot?.poolConfig).size;
  const pageCount = Object.keys(snapshot?.frontendPages || {}).length;
  const discoveredCount = (snapshot?._frontendDiscoveredUrls || []).length;
  const contractCount = Object.keys(snapshot?.contractFingerprints || {}).length;
  const githubRepoCount = Object.keys(snapshot?.githubRepos || {}).length;
  const actorCount = snapshot?.chainActorMonitor?.actionActorCount
    ?? Object.values(snapshot?.chainActorMonitor?.actors || {}).filter(actor => actor.actionWatched).length;
  await sendFeishu("Four.meme 全面监控 v2 已启动",
    [
      `**架构:** 独立定时器 + RPC Batch + 并行抓取`,
      `**底池监控:** BSC ${poolCount} 个 — 每 ${CONFIG.intervals.pool / 1000}s`,
      `**前端监控:** ${pageCount} 个页面（基础 ${CONFIG.monitorUrls.length} + 自动发现 ${discoveredCount}）— 每 ${CONFIG.intervals.frontend / 1000}s`,
      `  含 __NEXT_DATA__ / i18n / 路由与端点发现 / 新页面自动纳入`,
      `  资源小抖动 ${CONFIG.frontendAssetJitter.quickConfirmDelayMs}ms 快速复抓确认`,
      `  ${getFrontendMonitorUrls().map(u => "- " + u).join("\n  ")}`,
      `**API监控:** ${Object.keys(snapshot?.apiStructure || {}).length} 个端点（结构+值） — 每 ${CONFIG.intervals.api / 1000}s`,
      `**GitHub:** ${CONFIG.githubOwner} 账号 ${githubRepoCount} 个仓库，主仓库 ${CONFIG.githubRepo} (${(snapshot?.githubSha || "").slice(0, 8) || "未知"}) — 每 ${CONFIG.intervals.github / 1000}s`,
      `**合约监控:** ${contractCount} 个 — 每 ${CONFIG.intervals.contract / 1000}s（RPC 批量 + OpenFour 链上发现）`,
      `**链上参数:** AgentNFT ${snapshot?.onchainParams?.agentNftCount ?? "未知"} 个 — 每 ${CONFIG.intervals.onchain / 1000}s（RPC 批量）`,
      `**创建者动作:** ${actorCount} 个地址 — 每 ${CONFIG.intervals.actor / 1000}s（只过滤交易发起地址 tx.from，命中后合约复查）`,
      `**反风控:** UA轮换 + 按域名自适应退避 + 请求抖动`,
      `**心跳:** ${CONFIG.heartbeatEnabled ? `每 ${Math.round(CONFIG.heartbeatMs / 60000)} 分钟（低优先级，队列空闲时推送）` : "关闭"} | **日报:** ${CONFIG.dailyReport.enabled ? `开启（每日 ${CONFIG.dailyReport.hour}:00）` : "关闭"}`,
    ].join("\n"),
    "blue"
  );

  // 启动各模块独立定时器（递归 setTimeout 实现 per-tick 抖动）
  const moduleTimers = []; // 存储定时器 ID，供优雅退出时清理
  for (const m of modules) {
    const initialDelay = Math.random() * Math.min(m.intervalMs, 2_000);
    function scheduleModule() {
      const timerId = setTimeout(async () => {
        await m.run();
        scheduleModule();
      }, m.intervalMs + Math.random() * CONFIG.jitterMs);
      // 替换为最新的 timerId
      const idx = moduleTimers.findIndex(t => t.name === m.name);
      if (idx >= 0) moduleTimers[idx].timerId = timerId;
      else moduleTimers.push({ name: m.name, timerId });
    }
    // 初始延迟的 timer 也要跟踪，防止退出时遗漏
    const initTimerId = setTimeout(scheduleModule, initialDelay);
    moduleTimers.push({ name: m.name, timerId: initTimerId });
  }

  // 暴露给 gracefulShutdown 使用
  global.__moduleTimers = moduleTimers;

  // 心跳定时器（低优先级：仅在队列空闲时推送，避免被变更通知挤掉）
  // 合并 fourmeme + flap 两个监控的心跳到一张卡片
  if (CONFIG.heartbeatEnabled) {
    const FLAP_HEARTBEAT_FILE = join(__dirname, "..", ".flap-heartbeat.json");
    setInterval(() => {
    try {
      const upSec = Math.floor((Date.now() - startTime) / 1000);
      const h = Math.floor(upSec / 3600), m = Math.floor((upSec % 3600) / 60);
      const total = Object.values(modulePollCounts).reduce((a, b) => a + b, 0);
      const poolCount = buildPoolMap(snapshot?.poolConfig).size;
      log(`运行正常，已运行 ${h}h${m}m，总检测 ${total} 次`);

      const lines = [
        `**── Four.meme ──**`,
        `运行 **${h}h${m}m**，总检测 **${total}** 次`,
        Object.entries(modulePollCounts).map(([k, v]) => `  ${k}: ${v}`).join("\n"),
        `当前底池：**${poolCount}** 个`,
      ];

      // 汇总近 2 小时内的模块错误
      const twoHoursAgo = Date.now() - 7_200_000;
      const errorLines = [];
      for (const [name, e] of Object.entries(moduleErrors)) {
        // 清理超过 2 小时的错误记录
        e.hourlyErrors = (e.hourlyErrors || []).filter(t => t > twoHoursAgo);
        const recentCount = e.hourlyErrors.length;
        if (recentCount === 0 && e.consecutive === 0) continue;

        let line = `  ${name}: `;
        if (e.consecutive > 0) {
          line += `连续失败 ${e.consecutive} 次`;
          if (recentCount > e.consecutive) line += `（2h 内共 ${recentCount} 次）`;
        } else if (recentCount > 0) {
          line += `2h 内失败 ${recentCount} 次（已恢复）`;
        }
        line += `\n    → ${e.lastMsg}`;
        errorLines.push(line);
      }

      // 汇总当前退避状态
      const backoffLines = [];
      for (const [domain, b] of domainBackoff) {
        const remaining = Math.max(0, b.delayMs - (Date.now() - b.lastFail));
        if (remaining > 0) {
          backoffLines.push(`  ${domain} ${Math.ceil(remaining / 1000)}s`);
        }
      }

      let color = "green";
      if (errorLines.length > 0) {
        lines.push("");
        lines.push("**⚠ 近 2h 异常:**");
        lines.push(errorLines.join("\n"));
        color = "yellow";
      }
      if (backoffLines.length > 0) {
        lines.push("");
        lines.push("**退避中:**");
        lines.push(backoffLines.join("\n"));
        if (color === "green") color = "yellow";
      }
      if (errorLines.length === 0 && backoffLines.length === 0) {
        lines.push("");
        lines.push("✅ 全部模块运行正常");
      }

      // ── 读取 Flap 心跳数据，合并到同一张卡片 ──
      lines.push("");
      lines.push("---");
      lines.push("");
      lines.push(`**── Flap.sh ──**`);
      try {
        if (existsSync(FLAP_HEARTBEAT_FILE)) {
          const flapData = JSON.parse(readFileSync(FLAP_HEARTBEAT_FILE, "utf-8"));
          // 检查数据是否过期（超过 2 倍心跳周期视为过期）
          const maxAge = CONFIG.heartbeatMs * 2;
          if (Date.now() - flapData.ts > maxAge) {
            lines.push("⚠ Flap 心跳数据已过期，进程可能未运行");
            if (color === "green") color = "yellow";
          } else {
            lines.push(flapData.content);
            if (flapData.color === "yellow" && color === "green") color = "yellow";
          }
        } else {
          lines.push("⚠ Flap 心跳文件不存在，进程可能未启动");
          if (color === "green") color = "yellow";
        }
      } catch (err) {
        lines.push(`⚠ 读取 Flap 心跳失败：${err.message}`);
        if (color === "green") color = "yellow";
      }

      sendHeartbeat("监控心跳", lines.join("\n"), color);
    } catch (err) {
      log(`[心跳] 构建心跳消息异常：${err.message}`);
    }
    }, CONFIG.heartbeatMs);
    log(`[心跳] 间隔 ${Math.round(CONFIG.heartbeatMs / 60000)} 分钟，低优先级（队列空闲时推送）`);
  } else {
    log("[心跳] 已关闭（HEARTBEAT_ENABLED=false）");
  }

  // ── 日报定时器 ──
  if (CONFIG.dailyReport.enabled) {
    const scheduleDaily = () => {
      const now = new Date();
      const target = new Date(now);
      target.setHours(CONFIG.dailyReport.hour, 0, 0, 0);
      if (target <= now) target.setDate(target.getDate() + 1);
      const msUntil = target - now;
      log(`[日报] 已开启，下次发送时间：${target.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}（${Math.round(msUntil / 60000)} 分钟后）`);
      setTimeout(async () => {
        try {
          await sendDailyReport();
        } catch (err) {
          log(`[日报] 定时发送异常：${err.message}`);
        }
        scheduleDaily(); // 递归调度下一天（无论成功失败都继续）
      }, msUntil);
    };
    scheduleDaily();
  } else {
    log("[日报] 未开启（设置 DAILY_REPORT=true 可开启）");
  }

}

// SIGUSR1 信号：立即触发所有模块执行一次
process.on("SIGUSR1", () => {
  log("收到 SIGUSR1，触发全量检测...");
  (async () => {
    for (const m of modules) {
      try { await m.run(); } catch (err) { log(`[SIGUSR1] ${m.name} 异常：${err.message}`); }
    }
    // 检查是否有模块因防重入被跳过（run 内部 running=true 时直接 return）
    // 等待 2s 后重试一次被跳过的模块
    await new Promise(r => setTimeout(r, 2000));
    for (const m of modules) {
      try { await m.run(); } catch (err) { /* 第二次仍失败则放弃 */ }
    }
    log("SIGUSR1 全量检测完成");
  })();
});

// 启动
startAllModules().catch(err => {
  log(`启动异常：${err.message}`);
  log(`[启动异常详情]\n${err?.stack || err}`);
  process.exit(1);
});

let isShuttingDown = false;
async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log(`收到 ${signal}，正在优雅退出...`);
  // 停止所有模块定时器，防止退出期间继续生产新通知
  if (global.__moduleTimers) {
    for (const t of global.__moduleTimers) {
      clearTimeout(t.timerId);
    }
    log(`已停止 ${global.__moduleTimers.length} 个模块定时器`);
  }
  // 等待消息队列排空（最多等 30s）
  await waitQueueDrain(30_000);
  // 保存最终快照
  try { await saveSnapshot(snapshot); } catch {}
  process.exit(0);
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

process.on("unhandledRejection", (err) => {
  log(`[未捕获异常] ${err?.message || err}`);
});
