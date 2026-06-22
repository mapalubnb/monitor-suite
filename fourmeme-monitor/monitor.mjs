/**
 * Four.meme 全面监控脚本 v2 — 高频并行版
 *
 * 优化要点：
 *   1. 各模块独立定时器，互不阻塞
 *   2. BSC RPC batch 请求（模块 6/7 提速 ~10x）
 *   3. 前端/API 并行抓取（模块 2/3 提速 ~3-4x）
 *   4. 全面反风控：UA 轮换、按域名自适应退避、请求抖动、GitHub 认证限速
 *
 * 模块与频率：
 *   模块1: 底池配置   — 每 3s（纯 API，轻量，退避保护）
 *   模块2: 前端代码   — 每 10s（统一页面池，含文案 diff、__NEXT_DATA__、i18n、路由/端点发现）
 *   模块3: API 结构    — 每 15s（多端点并行，含结构+值 diff）
 *   模块4: OpenFour模板 — 每 3s（新增模板 / 状态变化）
 *   模块5: GitHub     — 有 token 每 30s / 无 token 每 90s（账号仓库列表每 5min）
 *   模块6: 智能合约   — 每 3s（RPC batch，单次请求）
 *   模块7: 链上参数   — 每 3s（RPC batch，单次请求）
 *   模块8: 创建者动作 — WebSocket 新区块驱动 + HTTP 兜底（只监听创建者/手动配置地址发起的交易）
 *
 * 用法：node monitor.mjs
 * 信号：kill -USR1 <PID>  立即触发全量检测
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, appendFileSync, renameSync, mkdirSync, readdirSync, unlinkSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { parseHTML } from "linkedom";

import { sendCard, sendCardQueued, sendHeartbeatQueued, patchCard, waitQueueDrain } from "../shared/feishu-client.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const IS_TEST_MODE = process.env.FOURMEME_MONITOR_TEST === "1";

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

function readNonNegativeIntEnv(name, fallback) {
  const n = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function readClampedSecondsEnv(name, fallbackSeconds, minSeconds) {
  const n = readPositiveIntEnv(name, fallbackSeconds);
  return Math.max(n, minSeconds) * 1000;
}

function readBoolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  return !["0", "false", "no", "off"].includes(String(raw).trim().toLowerCase());
}

function earlyLog(msg) {
  const stamp = new Date().toLocaleString("zh-CN", { hour12: false });
  console.log(`[${stamp}] ${msg}`);
}

async function setupHttpKeepAlive() {
  try {
    const { Agent, setGlobalDispatcher } = await import("undici");
    setGlobalDispatcher(new Agent({
      connections: readPositiveIntEnv("HTTP_KEEPALIVE_CONNECTIONS", 16),
      keepAliveTimeout: readPositiveIntEnv("HTTP_KEEPALIVE_TIMEOUT_MS", 30_000),
      keepAliveMaxTimeout: readPositiveIntEnv("HTTP_KEEPALIVE_MAX_TIMEOUT_MS", 120_000),
    }));
    earlyLog("[HTTP] undici keep-alive dispatcher 已启用");
  } catch (err) {
    earlyLog(`[HTTP] undici keep-alive 不可用，降级为 Node 内置 fetch：${err.message}`);
  }
}

await setupHttpKeepAlive();

const HAS_GITHUB_TOKEN = Boolean((process.env.GITHUB_TOKEN || "").trim());
const GITHUB_INTERVAL_FALLBACK_SECONDS = HAS_GITHUB_TOKEN ? 30 : 90;
const GITHUB_INTERVAL_MIN_SECONDS = HAS_GITHUB_TOKEN ? 30 : 90;

const CONFIG = {
  // Four.meme
  apiBase: "https://four.meme/meme-api",
  siteUrl: "https://four.meme",
  monitorUrls: [
    "https://four.meme/en/create-token",
    "https://four.meme/en/advanced",
    "https://four.meme/zh-TW/create-token",
    "https://four.meme/zh-TW/advanced",
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
  frontendDiscoverySeedUrls: [
    "https://four.meme/en",
    "https://four.meme/zh-TW",
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
    frontend: readClampedSecondsEnv("FOURMEME_FRONTEND_INTERVAL_SECONDS", 10, 10), // 模块2: 前端代码（默认/最低 10s）
    api:      readClampedSecondsEnv("FOURMEME_API_INTERVAL_SECONDS", 15, 15),      // 模块3: API 结构（默认/最低 15s）
    openfourTemplates: readClampedSecondsEnv("OPENFOUR_TEMPLATE_INTERVAL_SECONDS", 3, 3),
    github:   readClampedSecondsEnv("GITHUB_INTERVAL_SECONDS", GITHUB_INTERVAL_FALLBACK_SECONDS, GITHUB_INTERVAL_MIN_SECONDS),
    contract: 3_000,   // 模块6: 智能合约
    onchain:  3_000,   // 模块7: 链上参数
    actor:    3_000,   // 模块8: 合约创建者动作
  },
  githubRepoListIntervalMs: readClampedSecondsEnv("GITHUB_REPO_LIST_INTERVAL_SECONDS", 300, 300),

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
  frontendRouteDecisionsFile: join(__dirname, "frontend-route-decisions.json"),

  // ── 反风控 ──
  // 每次请求随机抖动范围（毫秒），叠加到间隔上
  jitterMs: readNonNegativeIntEnv("FOURMEME_MODULE_JITTER_MS", 200),
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
  apiProbeStaggerMs: readNonNegativeIntEnv("FOURMEME_API_PROBE_STAGGER_MS", 200),

  // ── BSC RPC ──
  bscRpcUrls: [
    "https://bsc.publicnode.com",
    "https://bsc-dataseed.binance.org/",
    "https://bsc-dataseed1.defibit.io/",
    "https://bsc-dataseed2.defibit.io/",
  ],
  bscWsUrls: (process.env.BSC_WS_URLS || process.env.FOURMEME_BSC_WS_URLS || "wss://bsc-rpc.publicnode.com")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean),
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
    wsEnabled: readBoolEnv("FOURMEME_ACTOR_WS_ENABLED", true),
    httpFallbackMs: readPositiveIntEnv("FOURMEME_ACTOR_HTTP_FALLBACK_MS", 10_000),
    confirmations: readPositiveIntEnv("FOURMEME_ACTOR_CONFIRMATIONS", 1),
    maxBlocksPerRun: readPositiveIntEnv("FOURMEME_ACTOR_MAX_BLOCKS", 80),
    catchupMaxBlocksPerRun: readPositiveIntEnv("FOURMEME_ACTOR_CATCHUP_MAX_BLOCKS", 800),
    maxRunMs: readPositiveIntEnv("FOURMEME_ACTOR_MAX_RUN_MS", 45_000),
    lagWarnBlocks: readPositiveIntEnv("FOURMEME_ACTOR_LAG_WARN_BLOCKS", 120),
    catchupLogIntervalMs: readPositiveIntEnv("FOURMEME_ACTOR_CATCHUP_LOG_MINUTES", 5) * 60_000,
    catchupLogMinDeltaBlocks: readPositiveIntEnv("FOURMEME_ACTOR_CATCHUP_LOG_DELTA_BLOCKS", 5_000),
    bootstrapLookbackBlocks: readPositiveIntEnv("FOURMEME_ACTOR_BOOTSTRAP_BLOCKS", 20),
    extraActors: parseEnvAddressList(`${process.env.FOURMEME_WATCH_ACTORS || ""},${process.env.FOURMEME_WATCH_CREATORS || ""}`),
    creatorChainLookupEnabled: readBoolEnv("FOURMEME_CREATOR_CHAIN_LOOKUP", true),
    creatorChainLookbackBlocks: readPositiveIntEnv("FOURMEME_CREATOR_CHAIN_LOOKBACK_BLOCKS", 30000),
    creatorChainMaxBlocksPerRun: readPositiveIntEnv("FOURMEME_CREATOR_CHAIN_MAX_BLOCKS_PER_RUN", 120),
    creatorPageLookupEnabled: readBoolEnv("FOURMEME_CREATOR_PAGE_LOOKUP", true),
    creatorPageMaxPerRun: readPositiveIntEnv("FOURMEME_CREATOR_PAGE_MAX_PER_RUN", 2),
    creatorLookupCooldownMs: readPositiveIntEnv("FOURMEME_CREATOR_LOOKUP_COOLDOWN_MINUTES", 30) * 60_000,
    creatorLookupEnabled: process.env.FOURMEME_CREATOR_LOOKUP === "true",
    explorerApiKey: process.env.ETHERSCAN_V2_API_KEY || process.env.ETHERSCAN_API_KEY || process.env.BSCSCAN_API_KEY || "",
    explorerApiBase: process.env.ETHERSCAN_API_BASE || "https://api.etherscan.io/v2/api",
    explorerPageBase: (process.env.BSCSCAN_WEB_BASE || "https://bscscan.com").replace(/\/+$/, ""),
  },
  openFourRegistryLogMonitor: {
    enabled: readBoolEnv("OPENFOUR_REGISTRY_LOG_MONITOR", true),
    discoveryDebounceMs: readPositiveIntEnv("OPENFOUR_REGISTRY_DISCOVERY_DEBOUNCE_MS", 3_000),
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

function currentBackoffState(domain) {
  const b = domainBackoff.get(domain);
  if (!b) return null;
  const remainingMs = Math.max(0, b.delayMs - (Date.now() - b.lastFail));
  return remainingMs > 0 ? { ...b, remainingMs } : null;
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
  b.lastStatusCode = statusCode || 0;
  b.failCount = (b.failCount || 0) + 1;
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

function classifyFetchFailure(err) {
  const msg = err?.message || String(err || "");
  if (msg.includes("[退避中]")) return "backoff";
  if (/HTTP\s+(?:403|429)|风控|captcha|Cloudflare|verify you are human|access denied/i.test(msg)) return "rate_limited";
  if (/地区限制|restricted/i.test(msg)) return "restricted";
  if (/超时|timeout/i.test(msg)) return "timeout";
  return "error";
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
const CURRENT_SCHEMA_VERSION = 7;
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
  if (data._frontendDiscoveredUrls) {
    delete data._frontendDiscoveredUrls;
    changed = true;
  }

  for (const [key, page] of Object.entries(data.frontendPages)) {
    const canonical = page?.originalUrl ? canonicalFrontendUrl(page.originalUrl) : "";
    if (!canonical || REMOVED_FRONTEND_URLS.has(canonical) || !isDiscoverableFrontendUrl(canonical)) {
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
    if (data._frontendAssetPending) delete data._frontendAssetPending;
    log("[快照迁移] v3 → v4：清理旧资源待确认缓存");
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
  if (ver < 7) {
    log("[快照迁移] v6 → v7：补充前端新路由确认状态字段");
  }
  ensureFrontendRouteState(data);
  if (!data._frontendDiscoveredHistory) data._frontendDiscoveredHistory = {};
  if (!data._frontendNotifyDedupe) data._frontendNotifyDedupe = {};
  if (!data._frontendWarmup) data._frontendWarmup = {};
  data._schemaVersion = CURRENT_SCHEMA_VERSION;
  return data;
}

function ensureFrontendRouteState(data) {
  if (!data || typeof data !== "object") return data;
  if (!data._frontendDiscoveredHistory) data._frontendDiscoveredHistory = {};
  if (!data._frontendPendingRoutes) data._frontendPendingRoutes = {};
  if (!data._frontendRouteApprovals) data._frontendRouteApprovals = {};
  if (!data._frontendIgnoredRoutes) data._frontendIgnoredRoutes = {};
  return data;
}

function routeDecisionTs(item = {}) {
  return Number(item.updatedAt || item.approvedAt || item.ignoredAt || item.notifiedAt || item.lastSeenAt || item.firstSeenAt || 0);
}

function mergeRouteDecisionMap(target, source) {
  if (!source || typeof source !== "object") return false;
  let changed = false;
  for (const [rawUrl, sourceValue] of Object.entries(source)) {
    const canonical = canonicalFrontendUrl(sourceValue?.url || rawUrl);
    if (!canonical || !sourceValue || typeof sourceValue !== "object") continue;
    const targetValue = target[canonical];
    if (!targetValue || routeDecisionTs(sourceValue) >= routeDecisionTs(targetValue)) {
      target[canonical] = { ...targetValue, ...sourceValue, url: canonical };
      changed = true;
    }
  }
  return changed;
}

function mergeExternalFrontendRouteStateFromFile(data, filePath) {
  if (!data || !filePath || !existsSync(filePath)) return false;
  let external;
  try {
    external = JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return false;
  }
  ensureFrontendRouteState(data);
  ensureFrontendRouteState(external);
  let changed = false;
  changed = mergeRouteDecisionMap(data._frontendPendingRoutes, external._frontendPendingRoutes) || changed;
  changed = mergeRouteDecisionMap(data._frontendRouteApprovals, external._frontendRouteApprovals) || changed;
  changed = mergeRouteDecisionMap(data._frontendIgnoredRoutes, external._frontendIgnoredRoutes) || changed;
  changed = mergeRouteDecisionMap(data._frontendDiscoveredHistory, external._frontendDiscoveredHistory) || changed;
  return changed;
}

function mergeExternalFrontendRouteState(data = snapshot) {
  if (!data) return false;
  let changed = false;
  changed = mergeExternalFrontendRouteStateFromFile(data, CONFIG.snapshotFile) || changed;
  changed = mergeExternalFrontendRouteStateFromFile(data, CONFIG.frontendRouteDecisionsFile) || changed;
  return changed;
}

function saveSnapshot(data) {
  snapshotWriteQueue = snapshotWriteQueue.then(() => {
    try {
      mergeExternalFrontendRouteState(data);
      data._schemaVersion = CURRENT_SCHEMA_VERSION;
      data.lastCheck = ts();
      // 紧凑且延后序列化，避免写队列堆积多份大快照字符串。
      const serialized = JSON.stringify(data);
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
      const messageId = await sendCardQueued(title, content, template);
      if (!messageId) throw new Error("飞书队列发送返回空 message_id");
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
async function sendCardViaApi(title, content, template = "red", diffFilePath, retries = 2, cardOpts = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await sendCard(title, content, template, { ...cardOpts, diffFilePath });
    } catch (err) {
      log(`[IM API] 发送失败（第${attempt + 1}次）：${err.message}`);
      if (attempt < retries) await sleep(2_000 * (attempt + 1));
    }
  }
  return null;
}

async function sendStartupCard(title, content, template = "blue") {
  let messageId = await sendCardViaApi(title, content, template, undefined, 2);
  if (messageId) return messageId;
  log(`[启动通知] 即时通道失败，切换队列兜底：${title}`);
  messageId = await sendCardQueued(title, content, template);
  if (!messageId) log(`[启动通知] 发送失败：${title}`);
  return messageId;
}

async function patchStartupCard(messageId, title, content, template = "blue") {
  if (!messageId) return false;
  try {
    await patchCardViaApi(messageId, title, content, template);
    return true;
  } catch (err) {
    log(`[启动通知] 更新启动卡片失败：${err.message}`);
    return false;
  }
}

/**
 * 编辑已发送的卡片消息（用于补充 AI 摘要）
 */
async function patchCardViaApi(messageId, title, content, template = "red", diffFilePath, cardOpts = {}) {
  await patchCard(messageId, title, content, template, { ...cardOpts, diffFilePath });
}

/**
 * 先推裸 diff（秒级送达），AI 摘要完成后自动编辑原消息补充分析
 * @param {string} [url] - 监控目标网址，展示在卡片最上方
 */
async function sendThenEnrichWithAi(title, content, template, moduleContext, aiInput, enrichFn, diffFilePath, url, cardOpts = {}) {
  // 卡片最上方加入监控目标网址
  const urlLine = url ? `🔗 [${url}](${url})\n\n` : "";
  // 1. 立即推送裸 diff（秒级送达）
  let messageId = await sendCardViaApi(title, urlLine + content, template, diffFilePath, 2, cardOpts);
  if (!messageId) {
    log(`[推送] 即时通道失败，切换队列兜底：${title}`);
    messageId = await sendCardQueued(title, urlLine + content, template, { ...cardOpts, diffFilePath });
  }

  // 2. 异步调用 AI → 编辑原消息补充摘要（不阻塞调用方）
  if (AI_CONFIG.enabled && AI_CONFIG.apiKey) {
    summarizeWithRetry(aiInput || content, moduleContext).then(async (summary) => {
      if (!summary) return;
      const enriched = enrichFn
        ? enrichFn(summary)
        : `**🤖 AI 分析：**\n${summary}\n\n---\n\n${content}`;
      if (messageId) {
        try {
          await patchCardViaApi(messageId, title, urlLine + enriched, template, diffFilePath, cardOpts);
          log(`[AI→更新] ${title} 已补充 AI 摘要`);
        } catch (err) {
          log(`[AI→更新] 编辑失败(${err.message})，进入重试队列`);
          scheduleAiPatchRetry({ messageId, title, content: urlLine + enriched, template, diffFilePath, cardOpts, summary });
        }
      } else {
        await sendFeishu(`🤖 ${title}`, `**AI 分析：**\n${summary}`, "blue");
      }
    }).catch(err => log(`[AI] 异步摘要异常：${err.message}`));
  }
}

async function summarizeWithRetry(input, moduleContext) {
  const maxAttempts = readPositiveIntEnv("AI_SUMMARY_RETRY_ATTEMPTS", 2);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const summary = await aiSummarize(input, moduleContext, 1);
      if (summary) return summary;
    } catch (err) {
      if (attempt >= maxAttempts) throw err;
    }
    if (attempt < maxAttempts) await sleep(1_500 * attempt);
  }
  return "";
}

function scheduleAiPatchRetry({ messageId, title, content, template, diffFilePath, cardOpts = {}, summary, attempt = 1 }) {
  const maxAttempts = readPositiveIntEnv("AI_PATCH_RETRY_ATTEMPTS", 2);
  const delayMs = Math.min(30_000, 2_000 * attempt);
  setTimeout(async () => {
    try {
      await patchCardViaApi(messageId, title, content, template, diffFilePath, cardOpts);
      log(`[AI→更新] ${title} 重试补充 AI 摘要成功`);
    } catch (err) {
      if (attempt < maxAttempts) {
        log(`[AI→更新] 重试 ${attempt}/${maxAttempts} 失败(${err.message})，继续排队`);
        scheduleAiPatchRetry({ messageId, title, content, template, diffFilePath, cardOpts, summary, attempt: attempt + 1 });
      } else {
        log(`[AI→更新] 重试失败，追加发送 AI 摘要：${err.message}`);
        await sendFeishu(`🤖 ${title}`, `**AI 分析：**\n${summary}`, "blue");
      }
    }
  }, delayMs);
}

function shouldUseAiForNotification({ title = "", content = "", moduleContext = "", aiInput = "", skipAi = false } = {}) {
  if (skipAi) return false;
  const text = `${title}\n${moduleContext}\n${aiInput || content}`;

  // 明确噪音/状态类：不需要 AI。
  if (/抓取受限|页面不可达|请求失败|处理失败|模块异常|模块恢复|退避恢复|基线已修复|心跳|状态总览|监控日报/i.test(text)) return false;
  if (/仅检测到构建产物|压缩变量噪音|无实质|常规构建|hash\s*轮换|部署 ID|sourceMappingURL/i.test(text)) return false;

  // 用户明确需要页面内容解释的新路由。
  if (/前端新路由|新路由发现/.test(text)) return true;

  // 高价值安全/链上/合约/底池业务变更保留 AI。
  if (/合约变更|智能合约|OpenFour|底池变更|费率|buyFee|sellFee|tradeFee|vault|dividend|staking|权限|黑白名单|whitelist|blacklist/i.test(text)) return true;

  // 创建者动作：高/中风险或批量动作需要解释，单条低风险交易不需要。
  if (/链上创建者动作/.test(text)) {
    return /高风险|中风险|🚨|⚠️|新合约|权限|owner|admin|upgrade|transferOwnership/i.test(text)
      || /链上创建者动作（(?:[2-9]|\d{2,})项）/.test(title);
  }

  // 前端：可见文案、页面级 i18n、路由/端点变化需要解释；全局资源未命中 DOM 默认跳过。
  const isFrontendI18nResourceTitle = /前端 i18n 资源变更/.test(title);
  const hasPageVisibleI18nSignal = /前端文案变更|页面文案变更|i18n 国际化字符串|页面级附加变更|可见 DOM/i.test(text);
  if (/全局 i18n 资源变更/.test(text) || (isFrontendI18nResourceTitle && !hasPageVisibleI18nSignal)) return false;
  if (/前端文案变更|页面文案变更|i18n 国际化字符串|前端路由\/端点变更|页面级附加变更|创建页重点文案|功能信号/i.test(text)) return true;
  if (/前端变更/.test(title)) {
    return /费率|fee|tax|vault|dividend|staking|enabled|新增路由|移除路由|API 端点|按钮|文案|可见/i.test(text);
  }

  // API：结构新增/删除/字段类型变化需要解释；普通值变化只在关键字段时调用。
  if (/API 变更/.test(title)) {
    if (/API (?:新接口结构|结构变更)|新端点响应值/.test(text)) return true;
    return /fee|tax|rate|status|enabled|contract|address|vault|staking|dividend|limit|threshold|cap|whitelist|blacklist/i.test(text);
  }

  // GitHub：提交保留 AI；账号仓库列表只有新增/移除仓库需要。
  if (/GitHub 新提交/.test(title)) return true;
  if (/GitHub 项目变更/.test(title)) return /新增仓库|移除仓库/.test(text);

  // 链上参数：新增/移除合约需要；单纯数量变化可由卡片说明覆盖。
  if (/链上参数变更/.test(title)) return /新增 Agent NFT 合约|移除 Agent NFT 合约/.test(text);

  return true;
}

async function sendNotificationMaybeAi({ title, content, template = "red", moduleContext = "", aiInput, enrichFn, diffFilePath, url, cardOpts = {}, skipAi = false }) {
  if (!shouldUseAiForNotification({ title, content, moduleContext, aiInput, skipAi })) {
    const urlLine = url ? `🔗 [${url}](${url})\n\n` : "";
    let messageId = await sendCardViaApi(title, urlLine + content, template, diffFilePath, 2, cardOpts || {});
    if (!messageId) {
      log(`[推送] AI 已跳过，立即通道失败，切换队列兜底：${title}`);
      await sendCardQueued(title, urlLine + content, template, { ...(cardOpts || {}), diffFilePath });
    } else {
      log(`[AI] 已跳过：${title}`);
    }
    return messageId;
  }
  return sendThenEnrichWithAi(title, content, template, moduleContext, aiInput, enrichFn, diffFilePath, url, cardOpts);
}

/**
 * 保存 diff 详情到本地文件（不再直接发送到飞书群，改为卡片按钮触发下载）
 * @param {string} title - 通知标题（用于文件名）
 * @param {string} diffText - 完整 diff 文本内容
 * @returns {string|null} 本地文件路径（供卡片按钮引用），内容过短时返回 null
 */
function saveDiffLocally(title, diffText) {
  if (!diffText || diffText.length < 50) return null;
  if (!hasMeaningfulFrontendDiffBody(diffText)) return null;
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
  const backoffState = currentBackoffState(domain);
  if (backoffState) {
    const statusText = backoffState.lastStatusCode ? `，上次状态: ${backoffState.lastStatusCode}` : "";
    throw new Error(`[退避中] ${domain}，剩余 ${Math.ceil(backoffState.remainingMs / 1000)}s${statusText}`);
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
  const backoffState = currentBackoffState(domain);
  if (backoffState) {
    const statusText = backoffState.lastStatusCode ? `，上次状态: ${backoffState.lastStatusCode}` : "";
    throw new Error(`[退避中] ${domain}，剩余 ${Math.ceil(backoffState.remainingMs / 1000)}s${statusText}`);
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
function decodeUintArray(hex) {
  if (!hex || hex === "0x") return [];
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length < 128) return [];
  const offset = Number(BigInt("0x" + clean.slice(0, 64)));
  const lengthStart = offset * 2;
  if (clean.length < lengthStart + 64) return [];
  const length = Number(BigInt("0x" + clean.slice(lengthStart, lengthStart + 64)));
  const values = [];
  for (let i = 0; i < length; i++) {
    const start = lengthStart + 64 + i * 64;
    const chunk = clean.slice(start, start + 64);
    if (chunk.length === 64) values.push(BigInt("0x" + chunk).toString());
  }
  return values;
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
    if (!["http:", "https:"].includes(u.protocol)) return "";
    if (u.protocol === "http:" && u.port === "80") u.port = "";
    if (u.protocol === "https:" && u.port === "443") u.port = "";
    u.hash = "";
    if (u.pathname !== "/" && u.pathname.endsWith("/")) u.pathname = u.pathname.replace(/\/+$/, "");
    const params = [...u.searchParams.entries()]
      .filter(([key]) => !/^utm_/i.test(key) && !["fbclid", "gclid", "_t", "_ts", "timestamp", "cacheBust"].includes(key))
      .sort(([ak, av], [bk, bv]) => ak === bk ? av.localeCompare(bv) : ak.localeCompare(bk));
    const search = params.length
      ? "?" + params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")
      : "";
    return u.origin + (u.pathname === "/" ? "" : u.pathname) + search;
  } catch {
    return url;
  }
}

function getFrontendMonitorUrls() {
  const configured = CONFIG.monitorUrls
    .map(canonicalFrontendUrl)
    .filter(isConfiguredFrontendUrl);
  const configuredSet = new Set(configured);
  const discovered = Object.values(snapshot?.frontendPages || {})
    .map(page => page?.originalUrl)
    .filter(Boolean)
    .map(canonicalFrontendUrl)
    .filter(url => !configuredSet.has(url))
    .filter(isDiscoverableFrontendUrl);
  const approved = Object.entries(snapshot?._frontendRouteApprovals || {})
    .filter(([, item]) => item?.status === "approved")
    .map(([url, item]) => canonicalFrontendUrl(item.url || url))
    .filter(url => !configuredSet.has(url))
    .filter(isDiscoverableFrontendUrl);
  return [...new Set([...configured, ...approved, ...discovered])];
}

function getFrontendRouteDecision(url) {
  const canonical = canonicalFrontendUrl(url);
  if (!canonical) return "unknown";
  if (snapshot?._frontendRouteApprovals?.[canonical]?.status === "approved") return "approved";
  if (snapshot?._frontendIgnoredRoutes?.[canonical]?.status === "ignored") return "ignored";
  if (snapshot?._frontendPendingRoutes?.[canonical]?.status === "pending") return "pending";
  return "new";
}

function shouldSkipDiscoveredFrontendUrl(url) {
  const decision = getFrontendRouteDecision(url);
  return decision === "approved" || decision === "ignored" || decision === "pending";
}

function isConfiguredFrontendUrl(url) {
  const canonical = canonicalFrontendUrl(url);
  if (!canonical || REMOVED_FRONTEND_URLS.has(canonical)) return false;
  try {
    const u = new URL(canonical);
    if (u.origin !== CONFIG.siteUrl) return false;
    const route = normalizeRouteString(canonical).split("?")[0].replace(/\/+$/, "") || "/";
    if (isApiOrEndpointRoute(route)) return false;
    if (route.startsWith("/_next/") || route.startsWith("/static/")) return false;
    return true;
  } catch {
    return false;
  }
}

function isDiscoverableFrontendUrl(url) {
  const canonical = canonicalFrontendUrl(url);
  if (!canonical || REMOVED_FRONTEND_URLS.has(canonical)) return false;
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
  if (isPlaceholderFrontendRoute(route)) return false;
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

function isPlaceholderFrontendRoute(route) {
  const path = normalizeRouteString(route).split("?")[0].replace(/\/+$/, "");
  return /\/(?:null|undefined)(?:\/|$)/i.test(path);
}

function isUnsupportedLocalePrefixedRoute(route) {
  const path = (route || "").split("?")[0];
  return /^\/[a-z]{2}(?:-[a-z]{2})?(?:\/|$)/i.test(path) && !/^\/(?:en|zh-TW)(?:\/|$)/i.test(path);
}

function isDynamicFrontendRoute(route) {
  const path = normalizeRouteString(route).split("?")[0].replace(/\/+$/, "");
  return /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?token\/0x[a-f0-9]{40}$/i.test(path)
    || /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?token\/undefined$/i.test(path)
    || /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?contract\/\d+$/i.test(path)
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

function isSuppressedDiscoveredFrontendUrl(url) {
  const canonical = canonicalFrontendUrl(url);
  const state = snapshot?._frontendDiscoveredHistory?.[canonical];
  if (!state?.failedDiscoveryAt) return false;
  const cooldownMs = readPositiveIntEnv("FOURMEME_FRONTEND_DISCOVERY_FAIL_COOLDOWN_MINUTES", 360) * 60_000;
  return Date.now() - state.failedDiscoveryAt < cooldownMs;
}

function recordFailedDiscoveredFrontendUrls(failedUrls = [], failedDetails = []) {
  if (!failedUrls.length) return false;
  if (!snapshot) snapshot = {};
  if (!snapshot._frontendDiscoveredHistory) snapshot._frontendDiscoveredHistory = {};
  const detailByUrl = new Map(
    (failedDetails || [])
      .filter(item => item?.url)
      .map(item => [canonicalFrontendUrl(item.url), item])
  );
  const now = Date.now();
  let changed = false;
  for (const url of failedUrls) {
    const canonical = canonicalFrontendUrl(url);
    if (!canonical) continue;
    const prev = snapshot._frontendDiscoveredHistory[canonical] || {};
    const detail = detailByUrl.get(canonical) || {};
    snapshot._frontendDiscoveredHistory[canonical] = {
      ...prev,
      failedDiscoveryAt: now,
      failedDiscoveryCount: (prev.failedDiscoveryCount || 0) + 1,
      lastFailureReason: detail.reason || prev.lastFailureReason || "error",
      lastFailureMessage: detail.message || prev.lastFailureMessage || "",
      lastFailureStatus: detail.status || detail.statusCode || prev.lastFailureStatus || "",
    };
    changed = true;
  }
  return changed;
}

function discoverFrontendUrlsFromPages(pages, knownUrls = []) {
  const known = new Set(knownUrls.map(canonicalFrontendUrl));
  const discovered = [];
  for (const page of Object.values(pages || {})) {
    for (const route of page.routes || []) {
      const url = routeToFrontendUrl(route);
      if (!url || known.has(url)) continue;
      if (shouldSkipDiscoveredFrontendUrl(url)) {
        known.add(url);
        continue;
      }
      if (isSuppressedDiscoveredFrontendUrl(url)) {
        known.add(url);
        continue;
      }
      known.add(url);
      discovered.push(url);
      if (discovered.length >= CONFIG.frontendDiscovery.maxDiscoveredPages) return discovered;
    }
  }
  return discovered;
}

function extractTextContent(html) {
  const raw = String(html || "");
  const fallback = () => stripHtmlTagsPreservingQuotedGt(raw
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, " "))
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
  try {
    const { document } = parseHTML(raw);
    for (const node of document.querySelectorAll("script,style,noscript,template,svg,canvas")) {
      node.remove();
    }
    const root = document.body || document.documentElement || document;
    const texts = [];
    const visit = (node) => {
      if (!node) return;
      if (node.nodeType === 3) {
        const text = String(node.nodeValue || "").replace(/\s+/g, " ").trim();
        if (text) texts.push(text);
        return;
      }
      for (const child of node.childNodes || []) visit(child);
    };
    visit(root);
    const parsed = texts.join(" ").replace(/\s+/g, " ").trim();
    return parsed || fallback();
  } catch {
    return fallback();
  }
}

function stripHtmlTagsPreservingQuotedGt(input) {
  const text = String(input || "");
  let out = "";
  let inTag = false;
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inTag) {
      if (quote) {
        if (ch === quote) quote = "";
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }
      if (ch === ">") {
        inTag = false;
        out += " ";
      }
      continue;
    }
    if (ch === "<") {
      inTag = true;
      quote = "";
      out += " ";
      continue;
    }
    out += ch;
  }
  return out;
}

function extractHrefRoutesFromHtml(html) {
  const routes = [];
  const raw = String(html || "");
  const maxLinks = readPositiveIntEnv("FOURMEME_FRONTEND_MAX_HREFS", 500);
  try {
    const { document } = parseHTML(raw);
    for (const a of document.querySelectorAll("a[href]")) {
      if (routes.length >= maxLinks) break;
      const href = a.getAttribute("href");
      if (href) routes.push(href);
    }
    return routes;
  } catch {
    const hrefRe = /<a\b[^>]*\bhref=["']([^"']+)["']/gi;
    let m;
    while ((m = hrefRe.exec(raw)) !== null && routes.length < maxLinks) routes.push(m[1]);
    return routes;
  }
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

function isMinifierValue(val) {
  const s = String(val || "").trim();
  if (!s) return true;
  if (/^[a-zA-Z_$]$/.test(s)) return true;
  if (/^[a-zA-Z_$]{2}$/.test(s)) return true;
  if (/^[a-zA-Z_$]\.[\w$]{1,16}$/.test(s)) return true;
  if (/^[a-zA-Z_$][\w$]?\?\.[\w$]+$/.test(s)) return true;
  if (/^(void\s+0|null|undefined)$/.test(s)) return true;
  return false;
}

function isConcreteConfigValue(val) {
  const s = String(val || "").trim();
  if (!s || isMinifierValue(s)) return false;
  if (/[{}]/.test(s)) {
    const hasConcreteObjectValue = /:\s*(?:["']|0x[a-fA-F0-9]{40}\b|-?\d+(?:\.\d+)?\b|true\b|false\b|![01]\b)/.test(s);
    if (!hasConcreteObjectValue) return false;
    return /(fee|tax|burn|liquidity|recipient|holder|founder|vault|dividend|staking|router|manager|address|rate|amount)/i.test(s)
      && !/[`$]/.test(s);
  }
  return /^["'][^"']{2,}["']$/.test(s)
    || /^0x[a-fA-F0-9]{40}$/.test(s)
    || /^-?\d+(?:\.\d+)?$/.test(s)
    || /^(true|false|![01]|[01])$/.test(s)
    || /^[A-Z_]{3,32}$/.test(s);
}

function isReadableFrontendSignalString(value) {
  const s = String(value || "").replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).trim();
  if (s.length > 240) return false;
  if (/[\u4e00-\u9fff]/.test(s) && s.length <= 2) return true;
  if (/^(AI|OK|ON|OFF|APY|APR|TVL|KYC)$/i.test(s)) return true;
  if (/^(Tax|Fee|Buy|Sell|Swap|Burn|Claim|Create|Launch|Token|Agent|Vault|Pool|User|Team|Status)$/i.test(s)) return true;
  if (s.length < 3) return false;
  if (isNoiseString(s)) return false;
  if (/^static\/chunks\//i.test(s) || /\/_next\/static\//i.test(s) || /\.(?:js|css|map|png|svg|webp|woff2?)$/i.test(s)) return false;
  if (/webpack|turbopack|__next_f|loadableGenerated|prototype|constructor|children:|className:|onClick|function|=>/.test(s)) return false;
  if (/^[\w$.[\]{}(),:;'"`+\-*/%!<>=?\\|&\s]+$/.test(s) && !/[A-Za-z]{3,}\s+[A-Za-z]{2,}/.test(s) && !/[\u4e00-\u9fff]/.test(s)) return false;
  const punct = (s.match(/[{}()[\];,:`=<>|\\]/g) || []).length;
  if (punct / Math.max(s.length, 1) > 0.22 && !/[\u4e00-\u9fff]/.test(s)) return false;
  return /[\u4e00-\u9fff]/.test(s) || /[A-Za-z][A-Za-z\s'’&/.-]{2,}/.test(s);
}

function isBusinessConfigDiff(cd) {
  if (!cd || !CONFIG_BUSINESS_KEYS.has(cd.field)) return false;
  if (!isConcreteConfigValue(cd.oldVal) && cd.oldVal !== "(无)" && cd.oldVal !== "(新增)") return false;
  if (!isConcreteConfigValue(cd.newVal)) return false;
  if (String(cd.oldVal).includes("`") || String(cd.newVal).includes("`")) return false;
  return true;
}

function frontendDisplaySnippet(value, max = 120) {
  const s = String(value || "").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max) + "..." : s;
}

/* ── 配置参数结构化提取（移植自 flap-monitor，按 four.meme 业务调整） ── */
const CONFIG_BUSINESS_KEYS = new Set([
  // 费率 / 底池
  "enabled", "fee", "feeRate", "feeBps", "buyFee", "sellFee", "tradeFee", "commission",
  "tax", "enableTax", "taxEnabled", "taxFee", "taxFeeSell", "feeBurn", "buyTax", "sellTax",
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
          const item = { field: key, oldVal, newVal };
          if (isBusinessConfigDiff(item)) configDiffs.push(item);
        }
      }
      for (const [key, val] of newTokens) {
        if (!oldTokens.has(key) && CONFIG_BUSINESS_KEYS.has(key)) {
          const item = { field: key, oldVal: "(新增)", newVal: val };
          if (isBusinessConfigDiff(item)) configDiffs.push(item);
        }
      }
      if (configDiffs.length > 0) break;
    }
  }
  return configDiffs;
}

const CRITICAL_FRONTEND_STRING_PATTERNS = [
  /\bEnable\s+Tax\b/i,
  /\bToken\s+Tax(?:es)?\b/i,
  /\bTax\b/i,
  /\btax(?:Fee|FeeSell|Enabled)?\b/i,
  /\benableTax\b/i,
  /\b(?:buyFee|sellFee|feeRate|feeBps|tradeFee|commission|feeBurn)\b/i,
  /\bCreate\s+Token\b/i,
  /\bLaunch\s+Token\b/i,
  /create-token/i,
];

function isCriticalFrontendString(s) {
  return CRITICAL_FRONTEND_STRING_PATTERNS.some(re => re.test(String(s || "")));
}

function prioritizeFrontendStrings(strings, limit = 240) {
  const unique = [...new Set(strings || [])];
  const critical = unique.filter(isCriticalFrontendString);
  const rest = unique.filter(s => !isCriticalFrontendString(s));
  return [...critical.sort(), ...rest.sort()].slice(0, limit);
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
    const re = /(?:"((?:[^"\\]|\\.){2,})")|(?:'((?:[^'\\]|\\.){2,})')/g;
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
      if (s.length < 6 && !isReadableFrontendSignalString(s) && !isCriticalFrontendString(s)) continue;
      strings.add(s.length > 200 ? s.slice(0, 200) : s);
    }
    const criticalKeyRe = /\b(?:enableTax|taxEnabled|taxFee|taxFeeSell|feeBurn|buyFee|sellFee|feeRate|feeBps|tradeFee|commission|create-token)\b/g;
    while ((m = criticalKeyRe.exec(content)) !== null) strings.add(m[0]);
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
  const BATCH = readPositiveIntEnv("FOURMEME_FRONTEND_ASSET_CONCURRENCY", 6);
  const STAGGER = 80;     // 批内请求间隔 ms
  const entries = [...assetUrls.entries()]; // [[filename, url], ...]

  async function fetchAsset(assetKey, asset) {
    const url = typeof asset === "string" ? asset : asset.url;
    const previous = typeof asset === "object" ? asset.previous : null;
    if (sharedCache?.has(url)) {
      const cached = await sharedCache.get(url).catch(() => null);
      return cached ? { ...cached, filename: assetKey } : null;
    }

    const promise = (async () => {
      try {
        const headers = { ...browserHeaders(), "Accept": "*/*" };
        if (previous?.etag) headers["If-None-Match"] = previous.etag;
        if (previous?.lastModified) headers["If-Modified-Since"] = previous.lastModified;
        const res = await fetchSafe(url, {
          headers,
        }, 8_000);
        if (res.status === 304 && previous) {
          return {
            ...previous,
            fromCache: true,
          };
        }
        if (!res.ok) return null;
        const content = await res.text();
        const ext = assetKey.endsWith(".css") ? "css" : "js";
        const strings = prioritizeFrontendStrings(extractStrings(content, ext));
        return {
          contentHash: md5(content),
          size: content.length,
          strings,
          ext,
          etag: res.headers.get("etag") || "",
          lastModified: res.headers.get("last-modified") || "",
        };
      } catch {
        return null;
      }
    })().catch(() => null);

    if (sharedCache) sharedCache.set(url, promise);
    const data = await promise;
    return data ? { ...data, filename: assetKey } : null;
  }

  for (let i = 0; i < entries.length; i += BATCH) {
    const batch = entries.slice(i, i + BATCH);
    const tasks = batch.map(([assetKey, asset], idx) =>
      sleep(idx * STAGGER).then(() => fetchAsset(assetKey, asset))
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

function frontendAssetContentsHash(assetContents) {
  const items = Object.entries(assetContents || {})
    .map(([file, data]) => `${file}:${data?.contentHash || ""}:${data?.size || 0}`)
    .sort();
  return items.length ? md5(items.join("\n")) : null;
}

function isCreateTokenFrontendUrl(url) {
  try {
    const path = new URL(url, CONFIG.siteUrl).pathname.replace(/\/+$/, "");
    return /^\/(?:en|zh-TW)\/(?:create-token|advanced)$/i.test(path);
  } catch {
    return false;
  }
}

function normalizeFrontendSignalSnippet(text, index = 0, length = 0) {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  if (!raw) return "";
  const start = Math.max(0, index - 60);
  const end = Math.min(raw.length, index + Math.max(length, 1) + 80);
  return raw.slice(start, end).trim();
}

function normalizeFrontendSignalText(value) {
  return String(value || "")
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\"/g, "\"")
    .replace(/\\'/g, "'")
    .replace(/\\n|\\r|\\t/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripFrontendSignalSourcePrefix(value) {
  let s = normalizeFrontendSignalText(value);
  for (let i = 0; i < 2; i++) {
    const m = s.match(/^((?:page|nextData|i18n|asset)|(?:static\/chunks\/)?[^:\s]{1,120}\.(?:js|css)):\s*(.+)$/i);
    if (!m) break;
    s = m[2].trim();
  }
  return s;
}

function isCodeLikeFrontendSignalSnippet(value) {
  const s = stripFrontendSignalSourcePrefix(value);
  if (!s) return true;
  if (/^(?:字段|文案键|文案|路由):\s*/.test(s)) return false;
  if (/^tax\.[A-Za-z][A-Za-z0-9 &'()\/.+-]{0,90}$/.test(s)) return false;
  if (/^(?:enableTax|taxEnabled|taxFee|taxFeeSell|feeBurn|buyFee|sellFee|feeRateSell|feeRate|feeBps|tradeFee|commission)$/.test(s)) return false;
  if (/(?:\?\.|===|!==|=>|\(0,|function\b|useAtom|className|onClick|children:|webpack|turbopack|__next_f)/.test(s)) return true;
  const punct = (s.match(/[{}()[\];,`=<>|\\]/g) || []).length;
  if (punct >= 3 && punct / Math.max(s.length, 1) > 0.08) return true;
  if (s.length > 180 && !isReadableFrontendSignalString(s)) return true;
  return false;
}

function addFrontendSignal(out, kind, value) {
  if (!out || out.size >= 160) return;
  const clean = normalizeFrontendSignalText(value).replace(/\s+([:,.])/g, "$1").trim();
  if (!clean) return;
  out.add(`${kind}: ${frontendDisplaySnippet(clean, 160)}`);
}

function collectNormalizedFrontendSignalsFromSnippet(snippet, source, out) {
  const clean = stripFrontendSignalSourcePrefix(snippet);
  if (!clean || out.size >= 160) return;

  const typed = clean.match(/^(字段|文案键|文案|路由):\s*(.+)$/);
  if (typed) {
    addFrontendSignal(out, typed[1] === "文案键" ? "文案" : typed[1], typed[2]);
    return;
  }

  const pair = clean.match(/^([A-Za-z][\w.-]{1,80})\s*:\s*(.{1,180})$/);
  if (pair && (source === "i18n" || isCriticalFrontendString(pair[1]) || isCriticalFrontendString(pair[2]))) {
    const key = pair[1].trim();
    const value = normalizeFrontendSignalText(pair[2]);
    if (value && !isCodeLikeFrontendSignalSnippet(value)) addFrontendSignal(out, "文案", `${key} = ${value}`);
    else addFrontendSignal(out, "文案键", key);
  }

  const textKeyRe = /\b(?:tax|fee|token|createToken|launchToken|common)\.[A-Za-z][A-Za-z0-9 &'()\/.+-]{0,90}/g;
  let m;
  while ((m = textKeyRe.exec(clean)) !== null && out.size < 160) {
    const key = m[0].replace(/[.,;:)\]}]+$/g, "").trim();
    if (key && isCriticalFrontendString(key)) addFrontendSignal(out, "文案", key);
  }

  if (!/^(?:tax|fee|token|createToken|launchToken|common)\./.test(clean)
    && !isCodeLikeFrontendSignalSnippet(clean)
    && isReadableFrontendSignalString(clean)
    && isCriticalFrontendString(clean)) {
    addFrontendSignal(out, "文案", clean);
  }

  const fieldRe = /\b(?:enableTax|taxEnabled|taxFee|taxFeeSell|feeBurn|buyFee|sellFee|feeRateSell|feeRate|feeBps|tradeFee|commission)\b/g;
  while ((m = fieldRe.exec(clean)) !== null && out.size < 160) addFrontendSignal(out, "字段", m[0]);

  if (/\bcreate-token\b/i.test(clean) && !isCodeLikeFrontendSignalSnippet(clean)) addFrontendSignal(out, "路由", "create-token");
}

function canonicalFrontendSignal(value) {
  const s = stripFrontendSignalSourcePrefix(value);
  const normalized = s.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  const typed = normalized.match(/^(字段|文案键|文案|路由):\s*(.+)$/);
  if (typed) {
    const kind = typed[1] === "文案键" ? "文案" : typed[1];
    return `${kind}:${typed[2].trim()}`;
  }

  const signals = new Set();
  collectNormalizedFrontendSignalsFromSnippet(normalized, "snapshot", signals);
  if (signals.size === 1) return canonicalFrontendSignal([...signals][0]);
  if (signals.size > 1) return "";
  if (isCodeLikeFrontendSignalSnippet(normalized)) return "";
  if (!isCriticalFrontendString(normalized)) return "";
  if (isReadableFrontendSignalString(normalized)) return `文案:${normalized}`;
  return "";
}

function normalizeFrontendSignalsForDiff(signals) {
  const map = new Map();
  for (const raw of signals || []) {
    const expanded = new Set();
    collectNormalizedFrontendSignalsFromSnippet(raw, "snapshot", expanded);
    if (expanded.size === 0) {
      const canonical = canonicalFrontendSignal(raw);
      if (canonical && !map.has(canonical)) map.set(canonical, stripFrontendSignalSourcePrefix(raw));
      continue;
    }
    for (const display of expanded) {
      const canonical = canonicalFrontendSignal(display);
      if (canonical && !map.has(canonical)) map.set(canonical, display);
    }
  }
  return map;
}

function collectCriticalFrontendSignals(text, source, out) {
  const raw = String(text || "");
  if (!raw) return;
  for (const re of CRITICAL_FRONTEND_STRING_PATTERNS) {
    if (out.size >= 160) return;
    const flags = re.flags.includes("g") ? re.flags : re.flags + "g";
    const scan = new RegExp(re.source, flags);
    let match;
    let matchedForPattern = 0;
    while ((match = scan.exec(raw)) !== null) {
      const snippet = normalizeFrontendSignalSnippet(raw, match.index, match[0].length);
      collectNormalizedFrontendSignalsFromSnippet(snippet, source, out);
      matchedForPattern++;
      if (matchedForPattern >= 20 || out.size >= 160) break;
      if (match.index === scan.lastIndex) scan.lastIndex++;
    }
  }
}

function extractCreateTokenSignals(features, url) {
  if (!isCreateTokenFrontendUrl(url)) return null;
  const signals = new Set();
  collectCriticalFrontendSignals(features.textContent, "page", signals);
  if (features.nextData) collectCriticalFrontendSignals(JSON.stringify(features.nextData), "nextData", signals);
  for (const [key, value] of Object.entries(features.i18nStrings || {})) {
    collectCriticalFrontendSignals(`${key}: ${value}`, "i18n", signals);
  }
  return [...signals].sort();
}

function diffFrontendSignals(oldSignals, newSignals) {
  const oldMap = normalizeFrontendSignalsForDiff(oldSignals);
  const newMap = normalizeFrontendSignalsForDiff(newSignals);
  return {
    added: [...newMap.entries()].filter(([key]) => !oldMap.has(key)).map(([, value]) => value).sort(),
    removed: [...oldMap.entries()].filter(([key]) => !newMap.has(key)).map(([, value]) => value).sort(),
  };
}

function formatFrontendSignalChanges(diff, label = "关键业务指纹") {
  const added = diff?.added || [];
  const removed = diff?.removed || [];
  if (added.length === 0 && removed.length === 0) return "";
  const lines = [`**🔎 ${label}变化：**`, "```"];
  for (const s of removed.slice(0, 20)) lines.push(`- ${s.length > 160 ? s.slice(0, 160) + "..." : s}`);
  if (removed.length > 20) lines.push(`  ... 还有 ${removed.length - 20} 项移除`);
  for (const s of added.slice(0, 20)) lines.push(`+ ${s.length > 160 ? s.slice(0, 160) + "..." : s}`);
  if (added.length > 20) lines.push(`  ... 还有 ${added.length - 20} 项新增`);
  lines.push("```");
  return lines.join("\n");
}

/* ── __NEXT_DATA__ 提取与对比 ── */

function extractNextData(html) {
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) return null;
  try {
    const data = JSON.parse(match[1]);
    return stableNextData({
      props: data.props || {},
      page: data.page || "",
      query: data.query || {},
      buildId: data.buildId || "",
      runtimeConfig: data.runtimeConfig || data.publicRuntimeConfig || null,
      locale: data.locale || null,
      locales: data.locales || null,
    });
  } catch { return null; }
}

const NEXT_DATA_REDACT_KEY_RE = /(?:nonce|timestamp|requestId|traceId|buildTimestamp|serverTime|currentTime|random|sessionId)$/i;

function stableObject(value, depth = 0) {
  if (depth > 12) return "[depth]";
  if (value === null || value === undefined) return value ?? null;
  if (Array.isArray(value)) return value.map(item => stableObject(item, depth + 1));
  if (typeof value !== "object") return value;
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (NEXT_DATA_REDACT_KEY_RE.test(key)) continue;
    out[key] = stableObject(value[key], depth + 1);
  }
  return out;
}

function stableJsonHash(value) {
  return md5(JSON.stringify(stableObject(value)));
}

function stableNextData(data) {
  if (!data || typeof data !== "object") return data;
  return {
    props: stableObject(data.props || {}),
    page: data.page || "",
    query: stableObject(data.query || {}),
    buildId: data.buildId || "",
    runtimeConfig: stableObject(data.runtimeConfig || null),
    locale: stableObject(data.locale || null),
    locales: stableObject(data.locales || null),
  };
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

const i18nParseLogState = new Map();
const frontendInfoLogState = new Map();

function shouldLogI18nExtraction(oldFeatures, i18nResult) {
  if (!i18nResult?.i18nHash) return false;
  return !oldFeatures?.i18nHash || oldFeatures.i18nHash !== i18nResult.i18nHash;
}

function i18nExtractionReason(oldFeatures) {
  return oldFeatures?.i18nHash ? "hash 变化" : "首次";
}

function logI18nExtractionResult(oldFeatures, i18nResult, source = "streaming HTML") {
  if (!shouldLogI18nExtraction(oldFeatures, i18nResult)) return;
  const count = Object.keys(i18nResult.i18nStrings || {}).length;
  const key = `i18n-extract:${oldFeatures?.i18nHash || "none"}:${i18nResult.i18nHash}:${count}`;
  logFrontendInfoRateLimited(
    key,
    `  [i18n] 从 ${source} 提取到 ${count} 个翻译字符串（${i18nExtractionReason(oldFeatures)}）`
  );
}

function logFrontendInfoRateLimited(key, message, cooldownSeconds = readPositiveIntEnv("FOURMEME_FRONTEND_INFO_LOG_COOLDOWN_SECONDS", 300)) {
  const now = Date.now();
  const cooldownMs = Math.max(1, cooldownSeconds) * 1000;
  const state = frontendInfoLogState.get(key) || { lastLogAt: 0, suppressed: 0 };
  if (!state.lastLogAt || now - state.lastLogAt >= cooldownMs) {
    const suffix = state.suppressed > 0 ? `（已抑制 ${state.suppressed} 条同类日志）` : "";
    log(message + suffix);
    state.lastLogAt = now;
    state.suppressed = 0;
  } else {
    state.suppressed++;
  }
  frontendInfoLogState.set(key, state);
}

/**
 * 从 Next.js streaming HTML 中提取 i18n 翻译（适配 four.meme App Router 架构）
 * 匹配 self.__next_f.push 中的 "resources":{"common":{...},...} 结构
 * 返回 { i18nStrings: {flatKey: value}, i18nHash: string } 或 null
 */
function extractI18nFromStreamingHtml(html) {
  const chunks = extractNextFlightPushPayloads(html);
  const candidates = [];
  for (const payload of chunks) {
    try {
      const parsed = JSON.parse(payload);
      for (const item of parsed) {
        if (typeof item === "string" && item.includes("resources")) candidates.push({ text: item, decode: false });
      }
    } catch {
      if (payload.includes('\\"resources\\"') || payload.includes('"resources"')) candidates.push({ text: payload, decode: true });
    }
  }
  if (candidates.length === 0) return null;

  let best = null;
  for (const candidate of candidates) {
    const result = parseI18nResourcesCandidate(candidate.text, { decode: candidate.decode });
    if (result && (!best || Object.keys(result.i18nStrings).length > Object.keys(best.i18nStrings).length)) {
      best = result;
    }
  }
  if (best) return best;

  // Last-resort fallback: combine chunks, but do not let one truncated chunk spam logs.
  return parseI18nResourcesCandidate(candidates.map(item => item.text).join(""), { logFailure: true, decode: true });
}

function extractNextFlightPushPayloads(html) {
  const text = String(html || "");
  const marker = "self.__next_f.push(";
  const payloads = [];
  let searchFrom = 0;
  while (true) {
    const markerIdx = text.indexOf(marker, searchFrom);
    if (markerIdx === -1) break;
    const start = markerIdx + marker.length;
    const end = findBalancedExpressionEnd(text, start, "(", ")");
    if (end > start) payloads.push(text.slice(start, end));
    searchFrom = (end > start ? end : start) + 1;
  }
  return payloads;
}

function findBalancedExpressionEnd(text, start, open = "(", close = ")") {
  let depth = 1;
  let quote = "";
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function parseI18nResourcesCandidate(rawCandidate, { logFailure = false, decode = false } = {}) {
  const original = String(rawCandidate || "");
  const variants = [decode ? decodeJsStringFragment(original) : original];
  if (!decode && !original.includes('"resources":{') && original.includes('\\"resources\\"')) {
    variants.push(decodeJsStringFragment(original));
  }

  for (const unescaped of variants) {
  let searchFrom = 0;
  while (true) {
    const resIdx = unescaped.indexOf('"resources":{', searchFrom);
    if (resIdx === -1) break;
    const objStart = resIdx + '"resources":'.length;
    const objEnd = findJsonObjectEnd(unescaped, objStart);
    if (objEnd <= objStart) {
      searchFrom = objStart + 1;
      continue;
    }
    const resourcesJson = unescaped.slice(objStart, objEnd);
    try {
      const sanitized = resourcesJson.replace(/[\x00-\x1f]/g, (ch) => {
        const map = {'\n': '\\n', '\r': '\\r', '\t': '\\t', '\b': '\\b', '\f': '\\f'};
        return map[ch] || `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
      });
      const resources = JSON.parse(sanitized);
      const allStrings = {};
      for (const [namespace, content] of Object.entries(resources)) {
        if (typeof content === "object" && content !== null) {
          Object.assign(allStrings, flattenI18n(content, namespace));
        }
      }
      if (Object.keys(allStrings).length < 20) return null;
      return { i18nStrings: allStrings, i18nHash: stableI18nHash(allStrings) };
    } catch (err) {
      if (logFailure) logI18nParseFailure(err, resourcesJson);
      searchFrom = objEnd;
    }
  }
  }
  return null;
}

function logI18nParseFailure(err, sample) {
  const key = md5(`${err.message}:${String(sample || "").slice(0, 256)}`);
  const state = i18nParseLogState.get(key) || { count: 0, lastLogAt: 0 };
  state.count++;
  const now = Date.now();
  if (state.count === 1 || now - state.lastLogAt > 300_000) {
    log(`  [i18n] streaming 解析失败（同类第 ${state.count} 次）：${err.message}`);
    state.lastLogAt = now;
  }
  i18nParseLogState.set(key, state);
}

function decodeJsStringFragment(raw) {
  const wrapped = `"${String(raw || "").replace(/"/g, '\\"')}"`;
  try {
    return JSON.parse(wrapped);
  } catch {
    return String(raw || "")
      .replace(/\\\\/g, "\\")
      .replace(/\\"/g, '"')
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t");
  }
}

function findJsonObjectEnd(text, start) {
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

function stableI18nHash(strings) {
  const sortedKeys = Object.keys(strings || {}).sort();
  const sortedObj = {};
  for (const k of sortedKeys) sortedObj[k] = normalizeI18nValue(strings[k]);
  return md5(JSON.stringify(sortedObj));
}

function applyI18nResult(features, i18nResult, oldFeatures = null) {
  if (i18nResult) {
    features.i18nStrings = i18nResult.i18nStrings;
    features.i18nHash = i18nResult.i18nHash;
    features.i18nMissCount = 0;
    return true;
  }
  const missCount = (oldFeatures?.i18nMissCount || 0) + 1;
  features.i18nMissCount = missCount;
  if (oldFeatures?.i18nHash && missCount < readPositiveIntEnv("FOURMEME_I18N_REUSE_MAX_MISSES", 3)) {
    features.i18nStrings = oldFeatures.i18nStrings;
    features.i18nHash = oldFeatures.i18nHash;
    return false;
  }
  return false;
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
      return { i18nStrings: strings, i18nHash: stableI18nHash(strings), i18nChunk: url };
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

function normalizeI18nSearchText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function i18nValueIsSearchable(value) {
  const normalized = normalizeI18nSearchText(value);
  if (!normalized) return false;
  if (/[\u4e00-\u9fff]/.test(normalized)) return normalized.length >= 2;
  return normalized.length >= 4;
}

function pageTextContainsI18nValue(pageText, value) {
  if (!i18nValueIsSearchable(value)) return false;
  return normalizeI18nSearchText(pageText).includes(normalizeI18nSearchText(value));
}

function isI18nChangeVisibleOnPage(change, oldText = "", newText = "") {
  if (!change) return false;
  if (change.type === "added") return pageTextContainsI18nValue(newText, change.value);
  if (change.type === "removed") return pageTextContainsI18nValue(oldText, change.value);
  if (change.type === "modified") {
    return pageTextContainsI18nValue(oldText, change.oldValue)
      || pageTextContainsI18nValue(newText, change.newValue);
  }
  return false;
}

function partitionI18nChangesByPageVisibility(changes, oldText = "", newText = "") {
  const visible = [];
  const resourceOnly = [];
  for (const change of changes || []) {
    if (isI18nChangeVisibleOnPage(change, oldText, newText)) visible.push(change);
    else resourceOnly.push(change);
  }
  return { visible, resourceOnly };
}

function i18nChangeSignature(changes) {
  const payload = (changes || []).map(c => ({
    type: c.type,
    key: c.key,
    oldValue: c.oldValue ?? c.value ?? "",
    newValue: c.newValue ?? c.value ?? "",
  })).sort((a, b) => `${a.type}:${a.key}`.localeCompare(`${b.type}:${b.key}`));
  return md5(JSON.stringify(payload));
}

function i18nChangeTypeCounts(changes) {
  return {
    added: (changes || []).filter(c => c.type === "added").length,
    modified: (changes || []).filter(c => c.type === "modified").length,
    removed: (changes || []).filter(c => c.type === "removed").length,
  };
}

function isLikelyTransientI18nRemoval(changes, oldStrings, newStrings) {
  const counts = i18nChangeTypeCounts(changes);
  if (counts.removed === 0 || counts.added > 0 || counts.modified > 0) return false;
  const oldCount = Object.keys(oldStrings || {}).length;
  const newCount = Object.keys(newStrings || {}).length;
  if (!oldCount || newCount >= oldCount) return false;
  const maxRemoved = readPositiveIntEnv("FOURMEME_I18N_REMOVAL_JITTER_MAX_KEYS", 5);
  const maxRatio = Number(process.env.FOURMEME_I18N_REMOVAL_JITTER_MAX_RATIO || "0.02");
  const ratio = counts.removed / oldCount;
  return counts.removed <= maxRemoved || ratio <= maxRatio;
}

function shouldConfirmI18nRemoval(snapshotState, pageKey, changes, oldStrings, newStrings) {
  if (!isLikelyTransientI18nRemoval(changes, oldStrings, newStrings)) {
    if (snapshotState?._frontendI18nPendingRemovals) delete snapshotState._frontendI18nPendingRemovals[pageKey];
    return true;
  }
  if (!snapshotState._frontendI18nPendingRemovals) snapshotState._frontendI18nPendingRemovals = {};
  const signature = i18nChangeSignature(changes);
  const prev = snapshotState._frontendI18nPendingRemovals[pageKey] || {};
  const count = prev.signature === signature ? (prev.count || 0) + 1 : 1;
  snapshotState._frontendI18nPendingRemovals[pageKey] = {
    signature,
    count,
    firstSeenAt: prev.signature === signature ? (prev.firstSeenAt || Date.now()) : Date.now(),
    lastSeenAt: Date.now(),
  };
  return count >= readPositiveIntEnv("FOURMEME_I18N_REMOVAL_CONFIRM_RUNS", 3);
}

function preserveOldI18nSnapshot(newData, oldData) {
  newData.i18nStrings = oldData.i18nStrings;
  newData.i18nHash = oldData.i18nHash;
  newData.i18nMissCount = oldData.i18nMissCount || 0;
}

function addGlobalI18nResourceChange(groups, page, changes) {
  if (!changes?.length) return;
  const signature = i18nChangeSignature(changes);
  if (!signature) return;
  let group = groups.get(signature);
  if (!group) {
    group = { signature, changes, pages: [] };
    groups.set(signature, group);
  }
  const url = page?.originalUrl || "";
  const pageKey = canonicalFrontendUrl(url) || url || urlLabel(url);
  if (!group.pages.some(p => p.key === pageKey)) {
    group.pages.push({
      key: pageKey,
      label: url ? urlLabel(url) : "未知页面",
      url,
    });
  }
}

function formatI18nChangesForFullDiff(changes, title = "i18n 国际化字符串变更") {
  if (!changes?.length) return "";
  const added = changes.filter(c => c.type === "added");
  const modified = changes.filter(c => c.type === "modified");
  const removed = changes.filter(c => c.type === "removed");
  const lines = [
    `[ ${title} ]`,
    `  统计: 新增 ${added.length} | 修改 ${modified.length} | 删除 ${removed.length}`,
  ];

  if (added.length > 0) {
    lines.push("");
    lines.push("--- 新增翻译 ---");
    for (const c of added) lines.push(`  + ${c.key}: ${c.value}`);
  }
  if (modified.length > 0) {
    lines.push("");
    lines.push("--- 修改翻译 ---");
    for (const c of modified) {
      lines.push(`  ~ ${c.key}`);
      lines.push(`    - ${c.oldValue}`);
      lines.push(`    + ${c.newValue}`);
    }
  }
  if (removed.length > 0) {
    lines.push("");
    lines.push("--- 删除翻译 ---");
    for (const c of removed) lines.push(`  - ${c.key}: ${c.value}`);
  }
  return lines.join("\n");
}

function buildGlobalI18nResourceNotification(group) {
  const pages = compactFrontendUrlList(group.pages || []);
  const pageCount = pages.length;
  const title = pageCount > 1
    ? `前端 i18n 资源变更（影响 ${pageCount} 页）`
    : `前端 i18n 资源变更：${pages[0]?.label || "全局资源"}`;
  const lines = [
    "**类型：全局 i18n 资源变更**",
    "这些翻译只在 Next streaming resources 中变化，未匹配到具体页面可见 DOM；本轮按全局资源汇总，避免误报为每个页面新增文案。",
    "",
  ];
  if (pageCount > 0) {
    lines.push(`**关联页面：** ${pageCount} 个`);
    for (const p of pages.slice(0, 20)) lines.push(`- ${p.label}${p.url ? `：${p.url}` : ""}`);
    if (pageCount > 20) lines.push(`- ... 还有 ${pageCount - 20} 个页面`);
    lines.push("");
  }
  lines.push(formatI18nChanges(group.changes));

  const fullDiff = buildFullDiffText(
    "全局 i18n 资源",
    null,
    null,
    null,
    null,
    [],
    null,
    null,
    CONFIG.siteUrl,
    group.changes,
    { i18nTitle: "全局 i18n 资源变更", affectedPages: pages },
  );

  return {
    title,
    content: lines.join("\n"),
    template: "orange",
    fullDiff,
    url: CONFIG.siteUrl,
    pageLabel: "全局 i18n 资源",
    dedupeKey: `frontend:i18n-resource:${group.signature}`,
  };
}

function frontendRouteActionToken(url) {
  return md5(`${canonicalFrontendUrl(url)}:${process.env.FEISHU_APP_SECRET || process.env.FEISHU_APP_ID || "fourmeme"}`).slice(0, 16);
}

function buildFrontendRouteActionButtons(url) {
  const canonical = canonicalFrontendUrl(url);
  const token = frontendRouteActionToken(canonical);
  return [
    {
      tag: "button",
      text: { tag: "plain_text", content: "加入监控" },
      type: "primary",
      value: { action: "frontend_add_route", url: canonical, token },
    },
    {
      tag: "button",
      text: { tag: "plain_text", content: "忽略" },
      type: "default",
      value: { action: "frontend_ignore_route", url: canonical, token },
    },
  ];
}

function buildFrontendNewPageAiInput(page) {
  const label = urlLabel(page.originalUrl);
  const text = frontendDisplaySnippet(page.textContent || "", 1200);
  const routes = (page.routes || []).filter(r => !isApiOrEndpointRoute(r)).slice(0, 20).join("\n");
  const i18nSamples = Object.entries(page.i18nStrings || {})
    .slice(0, 30)
    .map(([k, v]) => `${k}: ${frontendDisplaySnippet(v, 120)}`)
    .join("\n");
  return [
    `Four.meme 发现新的前端路由：${label}`,
    `URL: ${page.originalUrl}`,
    "",
    "请判断这个页面大概是什么功能、是否像活动/预售/业务页面，并用中文输出 2-4 句话。",
    "",
    "页面可见文案：",
    text || "(未提取到明显可见文案)",
    "",
    routes ? `页面内路由信号：\n${routes}` : "",
    i18nSamples ? `i18n 样例：\n${i18nSamples}` : "",
  ].filter(Boolean).join("\n");
}

function buildFrontendNewPageNotification(page) {
  const label = urlLabel(page.originalUrl);
  const fileCount = (page.assetFiles || []).length;
  const textLen = (page.textContent || "").length;
  const i18nCount = page.i18nStrings ? Object.keys(page.i18nStrings).length : 0;
  const routeCount = (page.routes || []).length;
  const lines = [
    `**页面：${label}**`,
    `URL: ${page.originalUrl}`,
    "",
    "**类型：前端新路由发现**",
    `已抓取页面结构，但尚未加入前端监控池。请在卡片下方选择“加入监控”或“忽略”。`,
    `确认加入后，脚本会在下一轮前端检查建立基线，并按每 ${CONFIG.intervals.frontend / 1000}s 检查页面变化。`,
    "",
    `资源文件：${fileCount} 个`,
    `页面文案：${textLen} 字`,
    `i18n：${i18nCount} 条`,
    `路由/端点：${routeCount} 个`,
  ];
  const preview = frontendDisplaySnippet(page.textContent || "", 240);
  if (preview) {
    lines.push("");
    lines.push("**页面文案预览：**");
    lines.push(preview);
  }
  return {
    title: `前端新路由发现：${label}`,
    content: lines.join("\n"),
    template: "orange",
    url: page.originalUrl,
    pageLabel: label,
    dedupeKey: `frontend:new-page:${canonicalFrontendUrl(page.originalUrl)}`,
    aiInput: buildFrontendNewPageAiInput(page),
    cardOpts: { actions: buildFrontendRouteActionButtons(page.originalUrl) },
  };
}

/* ── 路由/端点发现 ── */

function extractRouteSignals(html, assetContents, nextData) {
  const pageRoutes = new Set();
  const apiEndpoints = new Set();

  // 1. 从已解析的 __NEXT_DATA__ 中提取页面路由和 manifest
  if (nextData) {
    if (nextData.page) {
      const pageRoute = normalizeRouteString(nextData.page).split("?")[0];
      if (isTrackableRouteString(pageRoute)) pageRoutes.add(pageRoute);
    }
    if (nextData.props?.pageProps?.pages) {
      for (const p of nextData.props.pageProps.pages) {
        const pageRoute = normalizeRouteString(p).split("?")[0];
        if (isTrackableRouteString(pageRoute)) pageRoutes.add(pageRoute);
      }
    }
  }

  // 2. 从 HTML 中提取内部链接（排除静态资源路径）
  for (const href of extractHrefRoutesFromHtml(html)) {
    const path = normalizeRouteString(href).split("?")[0];
    if (isTrackableRouteString(path)) {
      pageRoutes.add(path);
    }
  }

  // 3. 从 JS 资源字符串中提取路由模式和 API 端点
  if (assetContents) {
    for (const [, data] of Object.entries(assetContents)) {
      if (!data.strings) continue;
      for (const s of data.strings) {
        const normalized = normalizeRouteString(s);
        if (!normalized) continue;
        // API 端点: /api/xxx, /meme-api/xxx, /mapi/xxx, /v1/xxx, /blog/v1/xxx
        if (isApiOrEndpointRoute(normalized) && normalized.length < 220) {
          apiEndpoints.add(normalized);
          continue;
        }
        // Next.js 页面路由: /xxx or /xxx/[param]
        if (/^\/[a-zA-Z][\w-]*(\/[\w[\]-]*)*$/.test(normalized) && normalized.length < 100 && isTrackableRouteString(normalized)) {
          pageRoutes.add(normalized);
        }
      }
    }
  }

  const routes = [...pageRoutes].sort();
  const endpoints = [...apiEndpoints].sort();
  return {
    routes,
    endpoints,
    combined: [...new Set([...routes, ...endpoints])].sort(),
  };
}

function extractRoutes(html, assetContents, nextData) {
  return extractRouteSignals(html, assetContents, nextData).combined;
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
  if (features.nextData) features.nextDataHash = stableJsonHash(features.nextData);

  // 资源文件列表（从 HTML 标签提取，支持 _next/static 和 CDN 路径）
  const assetMatches = html.matchAll(/(?:src|href)=["']((?:https?:\/\/[^"']*?)?\/\_next\/static\/[^"']+\.(?:js|css)(?:\?[^"']*)?)["']/g);
  const pathSet = new Set();
  for (const m of assetMatches) {
    const raw = m[1];
    const fullUrl = raw.startsWith("http") ? raw : baseUrl + raw;
    const cleanUrl = fullUrl.split("?")[0];
    const parsed = new URL(cleanUrl);
    const path = parsed.pathname;
    pathSet.add(path);
    features.assetUrlMap.set(path, cleanUrl);
  }
  features.assetFiles = [...pathSet].sort();
  features.assetHash = md5(features.assetFiles.join("\n"));

  // 页面文案
  features.textContent = extractTextContent(html);
  features.contentHash = md5(features.textContent);

  return features;
}

function validateFrontendPageFeatures(url, html, features) {
  const text = features?.textContent || "";
  if (/Due to your current location,\s*access to our services is restricted/i.test(text)) {
    const err = new Error("页面返回地区限制提示，拒绝更新前端快照");
    err.transient = true;
    throw err;
  }
  if (/(access denied|forbidden|cf-ray|captcha|verify you are human)/i.test(text) && (features?.assetFiles || []).length === 0) {
    const err = new Error("页面疑似风控/拦截页，拒绝更新前端快照");
    err.transient = true;
    throw err;
  }
  if ((features?.assetFiles || []).length < 5) {
    const err = new Error(`页面资源数量异常(${(features?.assetFiles || []).length})，可能不是正常 Next.js 页面`);
    err.transient = true;
    throw err;
  }
  if (html.length < 1000) {
    const err = new Error(`响应过短(${html.length} 字节)，拒绝更新前端快照`);
    err.transient = true;
    throw err;
  }
}

function isAssetDownloadComplete(assetUrlMap, assetContents, oldFeatures = null) {
  const expected = assetUrlMap?.size || 0;
  const downloaded = Object.keys(assetContents || {}).length;
  if (expected === 0) return false;
  const ratio = downloaded / expected;
  const hadGoodBaseline = oldFeatures?.assetContents && Object.keys(oldFeatures.assetContents).length >= Math.max(5, Math.floor(expected * 0.5));
  if (hadGoodBaseline) return ratio >= 0.85;
  return ratio >= 0.7 && downloaded >= 5;
}

function attachPreviousAssets(assetUrlMap, oldFeatures = null) {
  const map = new Map();
  for (const [assetKey, url] of assetUrlMap || []) {
    map.set(assetKey, { url, previous: oldFeatures?.assetContents?.[assetKey] || null });
  }
  return map;
}

async function runLimited(taskFactories, limit) {
  const results = new Array(taskFactories.length);
  let next = 0;
  async function worker() {
    while (next < taskFactories.length) {
      const idx = next++;
      try {
        results[idx] = { status: "fulfilled", value: await taskFactories[idx]() };
      } catch (reason) {
        results[idx] = { status: "rejected", reason };
      }
    }
  }
  const workers = Array.from({ length: Math.max(1, Math.min(limit, taskFactories.length)) }, worker);
  await Promise.all(workers);
  return results;
}

function frontendPageQuality(page) {
  if (!page) return -1;
  return (page.assetFiles?.length || 0)
    + Object.keys(page.assetContents || {}).length
    + (page.i18nStrings ? Math.min(20, Object.keys(page.i18nStrings).length / 20) : 0)
    + (page.routes?.length || 0) / 10
    + ((page.textContent || "").length > 100 ? 5 : 0);
}

function chooseBetterFrontendPage(existing, candidate) {
  if (!existing) return candidate;
  if (!candidate) return existing;
  if (frontendPageQuality(candidate) > frontendPageQuality(existing)) return candidate;
  log(`[前端] 同一 canonical key 重复抓取，保留质量更高的结果：${urlLabel(existing.originalUrl || candidate.originalUrl)}`);
  return existing;
}

/**
 * 抓取单个页面：HTML 解析 + 按需下载资源。
 * oldFeatures: 上一轮的快照数据（用于 assetHash 比对决定是否跳过下载）
 */
async function fetchFrontendData(url, oldFeatures = null, assetCache = null) {
  let features = null;
  const startedAt = Date.now();
  try {
    const headers = browserHeaders();
    if (oldFeatures?.htmlEtag) headers["If-None-Match"] = oldFeatures.htmlEtag;
    if (oldFeatures?.htmlLastModified) headers["If-Modified-Since"] = oldFeatures.htmlLastModified;
    const res = await fetchSafe(url, { headers });
    if (res.status === 304 && oldFeatures) {
      return {
        data: {
          ...oldFeatures,
          fetchMeta: { status: 304, durationMs: Date.now() - startedAt, reused: true },
        },
        error: null,
      };
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const html = await res.text();
    if (html.length < 1000) throw new Error(`响应过短（${html.length} 字节），可能被拦截`);

    // 第一层：纯解析
    features = extractPageFeatures(html, url);
    features.htmlEtag = res.headers.get("etag") || "";
    features.htmlLastModified = res.headers.get("last-modified") || "";
    features.fetchMeta = { status: res.status, durationMs: Date.now() - startedAt };
    validateFrontendPageFeatures(url, html, features);
  } catch (err) {
    log(`  [${urlLabel(url)}] HTML 抓取失败：${err.message}`);
    return { data: null, error: { url, reason: classifyFetchFailure(err), message: err.message || String(err), durationMs: Date.now() - startedAt } };
  }

  // 第二层：按需下载资源（仅当 assetHash 变化时）
  const baseUrl = new URL(url).origin;
  const refreshAssetContents = isCreateTokenFrontendUrl(url);
  if (oldFeatures && oldFeatures.assetHash === features.assetHash && oldFeatures.assetContents && !refreshAssetContents) {
    // assetHash 未变 → 复用缓存，跳过下载
    features.assetContents = oldFeatures.assetContents;
    // i18n: 每次都从 streaming HTML 重新提取，因为 i18n 可能随 SSR 内容变化而非静态资源变化
    try {
      let i18nResult = extractI18nFromStreamingHtml(features.html);
      if (!i18nResult && (!oldFeatures.i18nHash || (oldFeatures.i18nMissCount || 0) + 1 >= readPositiveIntEnv("FOURMEME_I18N_REUSE_MAX_MISSES", 3))) {
        i18nResult = await fetchI18nStrings(features.assetUrlMap, baseUrl);
      }
      const freshI18n = applyI18nResult(features, i18nResult, oldFeatures);
      if (freshI18n) {
        logI18nExtractionResult(oldFeatures, i18nResult);
      } else if (features.i18nMissCount >= readPositiveIntEnv("FOURMEME_I18N_REUSE_MAX_MISSES", 3)) {
        log(`  [i18n] 连续 ${features.i18nMissCount} 次未提取到 i18n，不再无限复用旧缓存`);
      }
    } catch (err) { log(`  [i18n] 提取异常（非致命）：${err.message}`); }
  } else {
    // assetHash 变了（或首次）→ 下载资源
    try {
      features.assetContents = await downloadAssetContents(attachPreviousAssets(features.assetUrlMap, oldFeatures), assetCache);
      if (!isAssetDownloadComplete(features.assetUrlMap, features.assetContents, oldFeatures)) {
        const expected = features.assetUrlMap?.size || 0;
        const downloaded = Object.keys(features.assetContents || {}).length;
        if (oldFeatures?.assetContents && Object.keys(oldFeatures.assetContents).length > 0) {
          log(`  [${urlLabel(url)}] 资源下载不完整 ${downloaded}/${expected}，沿用上一轮资源内容，避免半包误报`);
          features.assetContents = oldFeatures.assetContents;
          features.assetContentHash = oldFeatures.assetContentHash || frontendAssetContentsHash(oldFeatures.assetContents);
          features.assetHash = oldFeatures.assetHash || features.assetHash;
          features.assetFiles = oldFeatures.assetFiles || features.assetFiles;
        } else {
          throw new Error(`资源下载不完整 ${downloaded}/${expected}`);
        }
      }
    } catch (err) {
      features.assetContents = null;
      log(`  [${urlLabel(url)}] 资源下载异常：${err.message}`);
      return { data: null, error: { url, reason: classifyFetchFailure(err), message: err.message || String(err), durationMs: Date.now() - startedAt } };
    }
    // 提取 i18n（优先从 streaming HTML 中直接获取中文翻译）
    try {
      let i18nResult = extractI18nFromStreamingHtml(features.html);
      if (!i18nResult) {
        // fallback: 尝试从 JS chunk 中提取
        i18nResult = await fetchI18nStrings(features.assetUrlMap, baseUrl);
      }
      if (applyI18nResult(features, i18nResult, oldFeatures)) {
        logI18nExtractionResult(oldFeatures, i18nResult);
      }
    } catch (err) { log(`  [i18n] 提取异常（非致命）：${err.message}`); }
  }

  // 提取路由/端点（利用 HTML + nextData，assetContents 为可选增强）
  const routeSignals = extractRouteSignals(features.html, features.assetContents, features.nextData);
  features.pageRoutes = routeSignals.routes;
  features.apiEndpoints = routeSignals.endpoints;
  features.routes = routeSignals.combined;
  features.assetContentHash = frontendAssetContentsHash(features.assetContents);
  const createTokenSignals = extractCreateTokenSignals(features, url);
  if (createTokenSignals) {
    features.createTokenSignals = createTokenSignals;
    features.createTokenSignalHash = md5(JSON.stringify(createTokenSignals));
  }

  // 清除不需要持久化的大字段
  delete features.html;
  delete features.assetUrlMap; // Map 不可序列化

  return { data: features, error: null };
}

/**
 * 并行扫描所有监控页面（加随机延迟错开请求，降低同一 IP 并发触发风控的风险）
 * oldPages: 上一轮的快照（用于 assetHash 缓存决策）
 */
async function fetchAllFrontendData(oldPages = {}, urls = getFrontendMonitorUrls(), assetCache = null) {
  const pages = {};
  const failedUrls = [];
  const failedDetails = [];
  const limit = readPositiveIntEnv("FOURMEME_FRONTEND_HTML_CONCURRENCY", 6);
  const tasks = urls.map((url, i) => async () => {
    await sleep((i % limit) * 300);
      const key = urlToKey(url);
      const oldFeatures = oldPages[key] || null;
      const { data, error } = await fetchFrontendData(url, oldFeatures, assetCache);
      if (!data) {
        failedUrls.push(url);
        failedDetails.push(error || { url, reason: "error", message: "unknown" });
        return { key, data: null };
      }
      return { key, data: { ...data, originalUrl: url } };
  });
  const results = await runLimited(tasks, limit);
  for (const r of results) {
    if (r.status === "fulfilled" && r.value.data) {
      pages[r.value.key] = chooseBetterFrontendPage(pages[r.value.key], r.value.data);
    }
  }
  return { pages, failedUrls, failedDetails };
}

async function fetchFrontendDiscoverySeedPages(urls = []) {
  const pages = {};
  if (!urls.length) return pages;
  const limit = readPositiveIntEnv("FOURMEME_FRONTEND_DISCOVERY_SEED_CONCURRENCY", 2);
  const tasks = urls.map((url, i) => async () => {
    await sleep((i % limit) * 250);
    const startedAt = Date.now();
    try {
      const res = await fetchSafe(url, { headers: browserHeaders() });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const html = await res.text();
      if (html.length < 1000) throw new Error(`响应过短（${html.length} 字节），可能被拦截`);
      const features = extractPageFeatures(html, url);
      validateFrontendPageFeatures(url, html, features);
      const routeSignals = extractRouteSignals(features.html, null, features.nextData);
      features.pageRoutes = routeSignals.routes;
      features.apiEndpoints = routeSignals.endpoints;
      features.routes = routeSignals.combined;
      features.fetchMeta = { status: res.status, durationMs: Date.now() - startedAt, discoverySeed: true };
      delete features.html;
      delete features.assetUrlMap;
      return { key: urlToKey(url), data: { ...features, originalUrl: url } };
    } catch (err) {
      logFrontendInfoRateLimited(
        `discovery-seed-fail:${canonicalFrontendUrl(url)}`,
        `[前端] 发现入口抓取失败：${urlLabel(url)} ${err.message}`
      );
      return { key: urlToKey(url), data: null };
    }
  });
  const results = await runLimited(tasks, limit);
  for (const r of results) {
    if (r.status === "fulfilled" && r.value.data) {
      pages[r.value.key] = r.value.data;
    }
  }
  return pages;
}

async function fetchFrontendDataWithDiscovery(oldPages = {}) {
  const assetCache = new Map();
  const baseUrls = getFrontendMonitorUrls();
  const baseUrlSet = new Set(baseUrls.map(canonicalFrontendUrl));
  const seedUrls = (CONFIG.frontendDiscoverySeedUrls || [])
    .map(canonicalFrontendUrl)
    .filter(url => url && !baseUrlSet.has(url));
  const result = await fetchAllFrontendData(oldPages, baseUrls, assetCache);
  const discoveryPages = {
    ...result.pages,
    ...(await fetchFrontendDiscoverySeedPages(seedUrls)),
  };
  const knownUrls = new Set([
    ...baseUrls,
    ...seedUrls,
    ...Object.values(discoveryPages).map(p => p.originalUrl),
  ].map(canonicalFrontendUrl));
  const pendingRoutePages = [];
  const allDiscoveredUrls = [];

  for (let depth = 0; depth < 2; depth++) {
    const discoveredUrls = discoverFrontendUrlsFromPages(discoveryPages, [...knownUrls]);
    if (discoveredUrls.length === 0) break;
    log(`[前端] 从路由发现 ${discoveredUrls.length} 个新页面，发送待确认通知：${discoveredUrls.map(urlLabel).join(", ")}`);
    for (const url of discoveredUrls) knownUrls.add(canonicalFrontendUrl(url));
    const extra = await fetchAllFrontendData(oldPages, discoveredUrls, assetCache);
    for (const [key, page] of Object.entries(extra.pages)) {
      discoveryPages[key] = chooseBetterFrontendPage(discoveryPages[key], page);
      pendingRoutePages.push(discoveryPages[key]);
    }
    if (extra.failedUrls.length > 0) {
      log(`[前端] 路由发现候选页抓取失败，暂不通知：${extra.failedUrls.map(urlLabel).join(", ")}`);
      if (recordFailedDiscoveredFrontendUrls(extra.failedUrls, extra.failedDetails || [])) {
        result.discoveryHistoryChanged = true;
      }
    }
    result.failedDetails = [...(result.failedDetails || []), ...(extra.failedDetails || [])];
    allDiscoveredUrls.push(...discoveredUrls.filter(url => extra.pages[urlToKey(url)]));
  }

  result.discoveredUrls = allDiscoveredUrls;
  result.pendingRoutePages = pendingRoutePages;
  return result;
}

/**
 * 计算两个字符串数组的 Jaccard 相似度 (0~1)
 */
function jaccard(a, b) {
  if (!a.length && !b.length) return 1;
  if (Math.abs(a.length - b.length) > Math.max(a.length, b.length) * 0.8) return 0;
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
        const oldSize = Number(oldData.size || 0);
        const newSize = Number(newData.size || 0);
        if (oldSize && newSize && Math.abs(oldSize - newSize) / Math.max(oldSize, newSize) > 0.7) continue;
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
  const maxParts = readPositiveIntEnv("FOURMEME_TEXT_DIFF_MAX_PARTS", 100);
  if (oldParts.length > maxParts || newParts.length > maxParts) {
    return {
      changes: [
        { type: "modified", oldText: `文案段落 ${oldParts.length} 段`, newText: `文案段落 ${newParts.length} 段，已超过详细 diff 上限` },
      ],
      reordered: false,
    };
  }
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

function frontendRoutePath(url) {
  try {
    return new URL(url, CONFIG.siteUrl).pathname.replace(/\/+$/, "") || "/";
  } catch {
    return "";
  }
}

function isTaxOrCreateScopedAssetString(value) {
  const s = String(value || "").trim();
  return /^tax\.[A-Za-z][A-Za-z0-9 &'()\/.+-]{0,90}$/.test(s)
    || /^(?:Enable Tax|Token Tax(?:es)?|Tax Rate|Tax Token Info|Tax Allocation & Basic Info)$/i.test(s)
    || /^(?:enableTax|taxEnabled|taxFee|taxFeeSell|feeBurn|buyFee|sellFee|feeRateSell|feeRate|feeBps|tradeFee|commission)$/.test(s)
    || /\bcreate-token\b/i.test(s);
}

function isTaxOrCreateScopedConfigField(field) {
  return /^(?:fee|feeRate|feeBps|buyFee|sellFee|tradeFee|commission|tax|enableTax|taxEnabled|taxFee|taxFeeSell|feeBurn|buyTax|sellTax)$/i.test(String(field || ""));
}

function isTaxOrCreateScopedRoute(url) {
  const path = frontendRoutePath(url);
  return /^\/(?:en|zh-TW)\/(?:create-token|advanced)$/i.test(path);
}

function frontendAssetStats(assetDiff) {
  const parts = [];
  if (assetDiff?.unchanged) parts.push(`不变 ${assetDiff.unchanged}`);
  if (assetDiff?.renamed) parts.push(`重命名 ${assetDiff.renamed}`);
  if (assetDiff?.matched?.length) parts.push(`内容变化 ${assetDiff.matched.length}`);
  if (assetDiff?.added?.length) parts.push(`新增 ${assetDiff.added.length}`);
  if (assetDiff?.removed?.length) parts.push(`移除 ${assetDiff.removed.length}`);
  return parts.join(" | ") || "无资源变化";
}

function analyzeFrontendAssetDiff(assetDiff, oldAssets = {}, newAssets = {}, pageUrl = "") {
  const summary = {
    stats: frontendAssetStats(assetDiff),
    configDiffs: [],
    noisyStringChanges: 0,
    fileOnlyChanges: (assetDiff?.added?.length || 0) + (assetDiff?.removed?.length || 0),
  };
  const suppressTaxScopedAssetStrings = pageUrl && !isTaxOrCreateScopedRoute(pageUrl);

  for (const m of assetDiff?.matched || []) {
    const added = m.addedStrings || [];
    const removed = m.removedStrings || [];
    const configDiffs = extractConfigDiffs(removed, added).filter(isBusinessConfigDiff);
    for (const cd of configDiffs) {
      if (suppressTaxScopedAssetStrings && isTaxOrCreateScopedConfigField(cd.field)) {
        summary.noisyStringChanges++;
        continue;
      }
      summary.configDiffs.push({ ...cd, file: m.newFile || m.oldFile });
    }
    for (const s of added) {
      if (suppressTaxScopedAssetStrings && isTaxOrCreateScopedAssetString(s)) {
        summary.noisyStringChanges++;
        continue;
      }
      summary.noisyStringChanges++;
    }
    for (const s of removed) {
      if (suppressTaxScopedAssetStrings && isTaxOrCreateScopedAssetString(s)) {
        summary.noisyStringChanges++;
        continue;
      }
      summary.noisyStringChanges++;
    }
  }

  if (assetDiff?.added?.length || assetDiff?.removed?.length) {
    const oldGlobalStrings = new Set();
    const newGlobalStrings = new Set();
    for (const data of Object.values(oldAssets || {})) for (const s of data?.strings || []) oldGlobalStrings.add(s);
    for (const data of Object.values(newAssets || {})) for (const s of data?.strings || []) newGlobalStrings.add(s);
    for (const s of [...newGlobalStrings].filter(v => !oldGlobalStrings.has(v))) {
      if (suppressTaxScopedAssetStrings && isTaxOrCreateScopedAssetString(s)) continue;
      summary.noisyStringChanges++;
    }
    for (const s of [...oldGlobalStrings].filter(v => !newGlobalStrings.has(v))) {
      if (suppressTaxScopedAssetStrings && isTaxOrCreateScopedAssetString(s)) continue;
      summary.noisyStringChanges++;
    }
  }

  return summary;
}

function hasMeaningfulFrontendAssetChange(assetSummary) {
  if (!assetSummary) return false;
  return assetSummary.configDiffs.length > 0;
}

function formatFrontendAssetBrief(assetSummary) {
  if (!assetSummary) return "";
  const lines = [`**资源变化：** ${assetSummary.stats}`];

  if (assetSummary.configDiffs.length > 0) {
    lines.push("");
    lines.push("**功能/配置变化：**");
    for (const cd of assetSummary.configDiffs.slice(0, 12)) {
      lines.push(`- ${cd.field}: ${frontendDisplaySnippet(cd.oldVal, 60)} -> ${frontendDisplaySnippet(cd.newVal, 60)}`);
    }
    if (assetSummary.configDiffs.length > 12) lines.push(`- 还有 ${assetSummary.configDiffs.length - 12} 项配置变化，见 diff 附件`);
  }

  if (assetSummary.noisyStringChanges > 0 || assetSummary.fileOnlyChanges > 0) {
    lines.push("");
    lines.push(`构建产物变化已收敛：压缩/框架噪音 ${assetSummary.noisyStringChanges} 处，文件增删 ${assetSummary.fileOnlyChanges} 个。`);
  }
  return lines.join("\n");
}

function normalizeFrontendNotificationTitle(title, fallbackUrl = "") {
  const raw = String(title || "");
  if (/^前端(?:文案|路由\/端点)?变更：/.test(raw) || /^前端 i18n 资源变更/.test(raw) || /^前端新路由发现：/.test(raw) || /^⚠️ 前端(?:抓取受限|页面不可达)：/.test(raw)) return raw;
  const m = raw.match(/\/(?:en|zh-TW)\/[A-Za-z0-9/_-]+/);
  const label = m?.[0] || (fallbackUrl ? urlLabel(fallbackUrl) : "未知页面");
  return `前端变更：${label}`;
}

function frontendNotificationTitle(label, { textDiff = null, i18nChanged = false, routeChanged = false } = {}) {
  if (i18nChanged || (textDiff && !textDiff.reordered && textDiff.changes?.length > 0)) {
    return `前端文案变更：${label}`;
  }
  if (routeChanged) return `前端路由/端点变更：${label}`;
  return `前端变更：${label}`;
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
  const { data: fresh } = await fetchFrontendData(newData.originalUrl, oldData);
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

      if (totalReal > 0 || totalNoise > 0) {
        noiseOnlyFiles.push({
          label: m.oldFile === m.newFile ? m.newFile : `${m.oldFile} → ${m.newFile}`,
          noise: totalReal + totalNoise,
        });
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

    // ── 构建产物汇总（一行带过） ──
    if (noiseOnlyFiles.length > 0) {
      const totalNoise = noiseOnlyFiles.reduce((s, f) => s + f.noise, 0);
      lines.push(`\n🔇 构建产物变化：${noiseOnlyFiles.length} 文件 ${totalNoise} 处字符串差异（已收敛，不作为业务文案变更推送）`);
    }

    // ── 新增/移除文件：全局字符串池对比 ──
    if (assetDiff.added.length > 0 || assetDiff.removed.length > 0) {
      const oldGlobalStrings = new Set();
      const newGlobalStrings = new Set();
      for (const data of Object.values(oldAssets || {})) {
        for (const s of (data.strings || [])) oldGlobalStrings.add(s);
      }
      for (const data of Object.values(newAssets || {})) {
        for (const s of (data.strings || [])) newGlobalStrings.add(s);
      }
      const globallyAdded = [...newGlobalStrings].filter(s => !oldGlobalStrings.has(s) && !isNoiseString(s));
      const globallyRemoved = [...oldGlobalStrings].filter(s => !newGlobalStrings.has(s) && !isNoiseString(s));

      if (globallyAdded.length > 0 || globallyRemoved.length > 0) {
        lines.push(`📊 全局资源字符串池：新增 ${globallyAdded.length} | 移除 ${globallyRemoved.length}（构建产物变化，已收敛）`);
      }

      if (assetDiff.added.length > 0 || assetDiff.removed.length > 0) {
        const fileParts = [];
        if (assetDiff.added.length > 0) fileParts.push(`新增 ${assetDiff.added.length} 文件`);
        if (assetDiff.removed.length > 0) fileParts.push(`移除 ${assetDiff.removed.length} 文件`);
        lines.push(`📦 ${fileParts.join("、")}（chunk 重组/构建产物变化，已收敛）`);
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

function hasFrontendAssetChanges(assetDiff) {
  return Boolean(assetDiff)
    && ((assetDiff.matched || []).length > 0
      || (assetDiff.added || []).length > 0
      || (assetDiff.removed || []).length > 0);
}

function frontendAssetChangeSignature(assetDiff, oldAssets, newAssets) {
  if (!hasFrontendAssetChanges(assetDiff)) return "";
  const contentHash = (assets, file) => assets?.[file]?.contentHash || "";
  const matched = (assetDiff.matched || [])
    .map(m => ({
      oldFile: m.oldFile || "",
      newFile: m.newFile || "",
      oldHash: contentHash(oldAssets, m.oldFile),
      newHash: contentHash(newAssets, m.newFile),
      removedStrings: [...(m.removedStrings || [])].sort(),
      addedStrings: [...(m.addedStrings || [])].sort(),
    }))
    .sort((a, b) => `${a.oldFile}->${a.newFile}`.localeCompare(`${b.oldFile}->${b.newFile}`));
  return md5(JSON.stringify({
    matched,
    added: [...(assetDiff.added || [])].sort(),
    removed: [...(assetDiff.removed || [])].sort(),
  }));
}

function frontendSemanticChangeSignature({ assetSummary = null, businessSignalDiff = null, i18nChanges = null, textDiff = null, routeDiff = null } = {}) {
  const payload = {};
  if (assetSummary && hasMeaningfulFrontendAssetChange(assetSummary)) {
    payload.asset = {
      configDiffs: assetSummary.configDiffs.map(({ field, oldVal, newVal }) => ({ field, oldVal, newVal })).sort((a, b) => a.field.localeCompare(b.field)),
    };
  }
  if (businessSignalDiff && ((businessSignalDiff.added || []).length || (businessSignalDiff.removed || []).length)) {
    payload.signals = {
      added: [...(businessSignalDiff.added || [])].sort(),
      removed: [...(businessSignalDiff.removed || [])].sort(),
    };
  }
  if (i18nChanges?.length) {
    payload.i18n = i18nChanges.map(c => ({
      type: c.type,
      key: c.key,
      oldValue: c.oldValue ?? c.value ?? "",
      newValue: c.newValue ?? c.value ?? "",
    })).sort((a, b) => `${a.type}:${a.key}`.localeCompare(`${b.type}:${b.key}`));
  }
  if (textDiff && !textDiff.reordered && textDiff.changes?.length) {
    payload.text = textDiff.changes.map(c => ({
      type: c.type,
      text: c.text || "",
      oldText: c.oldText || "",
      newText: c.newText || "",
    }));
  }
  if (routeDiff && ((routeDiff.added || []).length || (routeDiff.removed || []).length)) {
    payload.routes = {
      added: [...(routeDiff.added || [])].sort(),
      removed: [...(routeDiff.removed || [])].sort(),
    };
  }
  return Object.keys(payload).length ? md5(JSON.stringify(payload)) : "";
}

function compactFrontendUrlList(pages) {
  const seen = new Set();
  const result = [];
  for (const p of pages || []) {
    const url = p?.url || "";
    const label = p?.label || (url ? urlLabel(url) : "未知页面");
    const key = url || label;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push({ label, url });
  }
  return result;
}

function buildMergedFrontendAssetNotification(group) {
  const pages = compactFrontendUrlList(group.pages);
  const pageCount = pages.length;
  const title = pageCount > 1
    ? `前端变更（影响 ${pageCount} 页）`
    : `前端变更：${pages[0]?.label || "未知页面"}`;
  const lines = [];
  if (pageCount > 1) {
    lines.push(`**📄 影响页面：${pageCount} 个**`);
    for (const p of pages) lines.push(`- ${p.label}${p.url ? `：${p.url}` : ""}`);
    lines.push("");
  } else if (pages[0]) {
    lines.push(`**📄 ${pages[0].label}**`);
    if (pages[0].url) lines.push(`URL: ${pages[0].url}`);
    lines.push("");
  }
  if (group.assetContent) lines.push(group.assetContent);

  const pageSpecific = group.items.filter(n => n.pageContent);
  if (pageSpecific.length > 0) {
    lines.push("");
    lines.push("---");
    lines.push("**📌 页面级附加变更：**");
    for (const n of pageSpecific) {
      lines.push("");
      lines.push(`**${n.pageLabel || urlLabel(n.url)}**${n.url ? `：${n.url}` : ""}`);
      lines.push(n.pageContent);
    }
  }

  return {
    title,
    content: lines.join("\n"),
    template: group.template || "orange",
    fullDiff: group.fullDiffs.filter(Boolean).join("\n\n"),
    url: pages[0]?.url || CONFIG.siteUrl,
    dedupeKey: group.signature ? `frontend:asset:${group.signature}` : undefined,
  };
}

function mergeFrontendNotifications(notifications) {
  const merged = [];
  const assetGroups = new Map();
  const contentGroups = new Map();

  for (const n of notifications || []) {
    if (n.assetSignature) {
      let group = assetGroups.get(n.assetSignature);
      if (!group) {
        group = {
          signature: n.assetSignature,
          assetContent: n.assetContent || "",
          template: n.template,
          pages: [],
          items: [],
          fullDiffs: [],
        };
        assetGroups.set(n.assetSignature, group);
        merged.push({ type: "asset", group });
      }
      group.pages.push({ label: n.pageLabel, url: n.url });
      group.items.push(n);
      if (n.fullDiff) group.fullDiffs.push(n.fullDiff);
      log(`[前端] 同轮资源合并：${n.pageLabel || urlLabel(n.url)} → ${n.assetSignature.slice(0, 8)}`);
      continue;
    }

    const contentHash = md5(n.content || "");
    if (contentGroups.has(contentHash)) {
      const existing = contentGroups.get(contentHash);
      const existingLabel = existing.title.replace("前端变更：", "");
      const newLabel = n.title.replace("前端变更：", "");
      if (!existing.title.includes(newLabel)) {
        existing.mergedPages = existing.mergedPages || [existingLabel];
        existing.mergedPages.push(newLabel);
        existing.title = `前端变更：${existing.mergedPages.join("、")}`;
      }
      if (n.fullDiff) existing.fullDiff = (existing.fullDiff || "") + "\n\n" + n.fullDiff;
      log(`[前端] 同轮内容合并：${newLabel} → 已合并到 ${existingLabel}`);
      continue;
    }
    contentGroups.set(contentHash, n);
    merged.push({ type: "single", notification: n });
  }

  return merged.map(item => item.type === "asset"
    ? buildMergedFrontendAssetNotification(item.group)
    : item.notification);
}

function frontendNotificationDedupeKey(n) {
  if (n.dedupeKey) return n.dedupeKey;
  if (n.assetSignature) return `frontend:asset:${n.assetSignature}`;
  return md5(JSON.stringify({
    title: n.title || "",
    url: canonicalFrontendUrl(n.url || ""),
    content: md5(n.content || ""),
  }));
}

function filterFrontendDedupe(notifications, state, windowMs = readPositiveIntEnv("FOURMEME_FRONTEND_DEDUPE_MINUTES", 30) * 60_000) {
  const now = Date.now();
  const dedupe = state._frontendNotifyDedupe || {};
  for (const [key, tsVal] of Object.entries(dedupe)) {
    if (now - Number(tsVal || 0) > windowMs * 4) delete dedupe[key];
  }
  const out = [];
  for (const n of notifications || []) {
    const key = frontendNotificationDedupeKey(n);
    if (dedupe[key] && now - dedupe[key] < windowMs) {
      frontendMetrics.suppressed++;
      log(`[前端] 去重窗口内抑制重复通知：${n.title}`);
      continue;
    }
    dedupe[key] = now;
    out.push(n);
  }
  state._frontendNotifyDedupe = dedupe;
  return out;
}

function buildFrontendFailureNotifications(failedUrls = [], state = snapshot) {
  const groups = new Map();
  const FAIL_THRESHOLD = 3;
  for (const url of failedUrls) {
    const key = urlToKey(url);
    const failState = state?._frontendFailCounts?.[key] || {};
    const count = typeof failState === "object" ? (failState.count || 0) : failState;
    const reason = typeof failState === "object" ? failState.reason : "error";
    const isBackoffLike = ["backoff", "rate_limited", "restricted"].includes(reason);
    const threshold = isBackoffLike ? FAIL_THRESHOLD * 2 : FAIL_THRESHOLD;
    if (!(count > 0 && count % threshold === 0)) continue;

    const domain = getDomain(url);
    const groupKey = isBackoffLike ? `${domain}:${reason}` : `${domain}:${reason}:${count}`;
    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        domain,
        reason,
        isBackoffLike,
        count,
        messages: new Set(),
        urls: [],
      });
    }
    const group = groups.get(groupKey);
    group.count = Math.max(group.count, count);
    if (failState.message) group.messages.add(failState.message);
    group.urls.push(url);
  }

  return [...groups.values()].map(group => {
    const backoffState = currentBackoffState(group.domain);
    const lines = [
      `站点 ${group.domain} 前端抓取已连续失败 ${group.count} 轮，影响 ${group.urls.length} 个页面。`,
      `原因: ${group.reason}`,
    ];
    if (backoffState) {
      lines.push(`当前退避: 剩余 ${Math.ceil(backoffState.remainingMs / 1000)}s${backoffState.lastStatusCode ? `，上次状态 ${backoffState.lastStatusCode}` : ""}`);
    }
    const latestMessages = [...group.messages].slice(0, 3);
    if (latestMessages.length) {
      lines.push(`最近错误: ${latestMessages.join(" | ")}`);
    }
    lines.push("");
    lines.push("影响页面:");
    for (const url of group.urls.slice(0, 12)) {
      lines.push(`- ${urlLabel(url)} (${url})`);
    }
    if (group.urls.length > 12) lines.push(`- ... 还有 ${group.urls.length - 12} 个页面`);
    return {
      title: group.isBackoffLike ? `⚠️ 前端抓取受限：${group.domain}` : `⚠️ 前端页面不可达：${group.domain}`,
      content: lines.join("\n"),
      template: "red",
      url: CONFIG.siteUrl,
      skipAi: true,
      dedupeKey: `frontend:failure:${group.domain}:${group.reason}:${group.count}`,
    };
  });
}

/**
 * 构建完整 diff 详情文本（用于文件附件）
 * 资产内容只展示结构化配置和汇总，页面文案/i18n/路由仍完整展示。
 */
function hasMeaningfulFrontendDiffBody(diffText) {
  if (!diffText) return false;
  const bodyLines = String(diffText).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  return bodyLines.some(line => {
    if (/^=+$/.test(line)) return false;
    if (/^-+$/.test(line)) return false;
    if (/^时间:/.test(line)) return false;
    if (/^前端变更详细 Diff/.test(line)) return false;
    return true;
  });
}

function buildFullDiffText(label, assetDiff, textDiff, routeDiff, businessSignalDiff, recoveredAssets, oldAssets, newAssets, pageUrl = "", i18nChanges = null, options = {}) {
  const lines = [];
  lines.push("=".repeat(60));
  lines.push(`前端变更详细 Diff — ${label}`);
  lines.push(`时间: ${ts()}`);
  lines.push("=".repeat(60));

  if (options.affectedPages?.length > 0) {
    lines.push("");
    lines.push("[ 影响页面 ]");
    for (const p of options.affectedPages) lines.push(`  - ${p.label}${p.url ? `：${p.url}` : ""}`);
  }

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

    // 修改文件：只输出结构化配置，压缩代码字符串统一收敛为统计。
    if (assetDiff.matched?.length > 0) {
      lines.push("");
      lines.push("--- 修改文件详情 ---");
      for (const m of assetDiff.matched) {
        const totalChanges = (m.addedStrings?.length || 0) + (m.removedStrings?.length || 0);
        if (totalChanges === 0) continue;
        const fname = m.oldFile === m.newFile ? m.newFile : `${m.oldFile} → ${m.newFile}`;
        const configDiffs = extractConfigDiffs(m.removedStrings || [], m.addedStrings || [])
          .filter(cd => !(pageUrl && !isTaxOrCreateScopedRoute(pageUrl) && isTaxOrCreateScopedConfigField(cd.field)));
        lines.push("");
        lines.push(`  [${fname}] (${totalChanges} 处资源字符串差异，已收敛为构建产物变化)`);
        for (const cd of configDiffs.slice(0, 20)) {
          lines.push(`    * ${cd.field}: ${frontendDisplaySnippet(cd.oldVal, 80)} -> ${frontendDisplaySnippet(cd.newVal, 80)}`);
        }
        if (configDiffs.length > 20) lines.push(`    ... 还有 ${configDiffs.length - 20} 项结构化配置变化`);
      }
    }

    // 新增文件：只列文件名和字符串数量，不展开压缩内容。
    if (assetDiff.added?.length > 0) {
      lines.push("");
      lines.push("--- 新增文件 ---");
      for (const f of assetDiff.added) {
        const assetData = newAssets?.[f];
        const strCount = (assetData?.strings || []).length;
        lines.push(`  + ${f}  (${strCount} 个字符串)`);
      }
    }

    // 移除文件：只列文件名和字符串数量，不展开压缩内容。
    if (assetDiff.removed?.length > 0) {
      lines.push("");
      lines.push("--- 移除文件 ---");
      for (const f of assetDiff.removed) {
        const assetData = oldAssets?.[f];
        const strCount = (assetData?.strings || []).length;
        lines.push(`  - ${f}  (${strCount} 个字符串)`);
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

  // ── 关键业务指纹 ──
  if ((businessSignalDiff?.added || []).length > 0 || (businessSignalDiff?.removed || []).length > 0) {
    lines.push("");
    lines.push("[ 关键业务指纹变更 ]");
    for (const s of businessSignalDiff.removed || []) lines.push(`  - ${s}`);
    for (const s of businessSignalDiff.added || []) lines.push(`  + ${s}`);
  }

  if (i18nChanges?.length > 0) {
    lines.push("");
    lines.push(formatI18nChangesForFullDiff(i18nChanges, options.i18nTitle || "i18n 国际化字符串变更"));
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
   模块 3：多端点 API 结构监控（并行探测）
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

/* ── OpenFour 业务模板监控（新模板 / 状态变化）── */

const OPENFOUR_TEMPLATE_STABLE_FIELDS = [
  "id",
  "name",
  "tag",
  "userAddress",
  "userImg",
  "codeType",
  "amount",
  "descr",
  "status",
  "time",
  "imgUrl",
];

function normalizeOpenFourTemplate(item) {
  const id = item?.id == null ? "" : String(item.id);
  if (!id) return null;
  const out = { id };
  for (const key of OPENFOUR_TEMPLATE_STABLE_FIELDS) {
    if (key === "id") continue;
    const value = item?.[key];
    out[key] = value == null ? "" : String(value);
  }
  return out;
}

function normalizeOpenFourTemplates(items) {
  const map = {};
  const normalizedItems = (items || [])
    .map(item => normalizeOpenFourTemplate(item))
    .filter(Boolean)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  for (const item of normalizedItems) {
    map[item.id] = item;
  }
  return map;
}

async function fetchOpenFourTemplates() {
  const url = `${CONFIG.apiBase}/v1/public/token_template/search`;
  const res = await fetchProbe(url, {
    method: "POST",
    headers: {
      "Accept": "application/json, text/plain, */*",
      "Content-Type": "application/json",
      "Origin": CONFIG.siteUrl,
      "Referer": `${CONFIG.siteUrl}/`,
      "User-Agent": nextUA(),
    },
    body: JSON.stringify({ sort: "LAST" }),
  }, 10_000);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json?.code !== 0 && json?.code !== "0") {
    throw new Error(`API code=${json?.code}: ${json?.message || json?.msg || ""}`);
  }
  if (!Array.isArray(json.data)) throw new Error("template search data is not an array");
  return normalizeOpenFourTemplates(json.data);
}

function diffOpenFourTemplates(oldMap = {}, newMap = {}) {
  const added = [];
  const statusChanged = [];
  for (const [id, item] of Object.entries(newMap)) {
    const old = oldMap[id];
    if (!old) {
      added.push(item);
      continue;
    }
    const oldStatus = String(old.status || "");
    const newStatus = String(item.status || "");
    if (oldStatus !== newStatus) statusChanged.push({ old, item, oldStatus, newStatus });
  }
  return { added, statusChanged };
}

function formatOpenFourTemplate(item) {
  const lines = [];
  lines.push(`id: ${item.id}`);
  lines.push(`name: ${item.name || "未知"}`);
  lines.push(`status: ${item.status || "未知"}`);
  if (item.tag) lines.push(`tag: ${item.tag}`);
  if (item.codeType) lines.push(`codeType: ${item.codeType}`);
  if (item.amount) lines.push(`amount: ${item.amount}`);
  if (item.userAddress) lines.push(`author: ${item.userAddress}`);
  if (item.time) lines.push(`time: ${item.time}`);
  if (item.imgUrl) lines.push(`imgUrl: ${item.imgUrl}`);
  if (item.descr) {
    const descr = item.descr.length > 300 ? item.descr.slice(0, 300) + "..." : item.descr;
    lines.push(`descr: ${descr}`);
  }
  return lines.join("\n");
}

function formatOpenFourTemplateChanges(changes) {
  const lines = [];
  lines.push(`**接口：** \`POST /v1/public/token_template/search\``);
  lines.push(`**新增模板：** ${changes.added.length} 个`);
  lines.push(`**状态变化：** ${changes.statusChanged.length} 个`);
  lines.push("---");

  for (const item of changes.added) {
    const marker = String(item.status).toUpperCase() === "PUBLISHED" ? "🆕 新模板上线" : "🆕 新模板";
    lines.push(`**${marker}：${item.name || item.id}**`);
    lines.push("```");
    lines.push(formatOpenFourTemplate(item));
    lines.push("```");
    lines.push("---");
  }

  for (const c of changes.statusChanged) {
    const marker = String(c.newStatus).toUpperCase() === "PUBLISHED" ? "🚀 模板已发布" : "🔄 模板状态变化";
    lines.push(`**${marker}：${c.item.name || c.item.id}**`);
    lines.push("```");
    lines.push(`id: ${c.item.id}`);
    lines.push(`status: ${c.oldStatus || "空"} -> ${c.newStatus || "空"}`);
    if (c.item.tag) lines.push(`tag: ${c.item.tag}`);
    if (c.item.userAddress) lines.push(`author: ${c.item.userAddress}`);
    lines.push("```");
    lines.push("---");
  }

  return lines.join("\n");
}

async function runOpenFourTemplateCheck() {
  const templates = await fetchOpenFourTemplates();
  if (!snapshot) snapshot = {};
  if (!snapshot.openFourTemplates) {
    snapshot.openFourTemplates = templates;
    snapshot.openFourTemplatesLastPollAt = new Date().toISOString();
    await saveSnapshot(snapshot);
    log(`[OpenFour模板] 首次记录：${Object.keys(templates).length} 个模板`);
    return;
  }

  const changes = diffOpenFourTemplates(snapshot.openFourTemplates, templates);
  const hasChanges = changes.added.length > 0 || changes.statusChanged.length > 0;
  const snapshotChanged = !jsonEqual(snapshot.openFourTemplates, templates);
  snapshot.openFourTemplates = templates;
  snapshot.openFourTemplatesLastPollAt = new Date().toISOString();

  if (hasChanges) {
    const count = changes.added.length + changes.statusChanged.length;
    log(`[OpenFour模板] 检测到 ${count} 项变化（新增 ${changes.added.length}，状态 ${changes.statusChanged.length}）`);
    const title = `OpenFour 模板变更（${count}项）`;
    const content = formatOpenFourTemplateChanges(changes);
    await saveSnapshot(snapshot);
    appendHistory("openfour", title, content.slice(0, 300), content);
    await sendNotificationMaybeAi({ title, content, template: "orange", moduleContext: "Four.meme OpenFour 业务模板变更", url: `${CONFIG.siteUrl}/zh-TW/contract/create` });
  } else if (snapshotChanged) {
    await saveSnapshot(snapshot);
  }
}

/* ── OpenFour Registry 日志触发的新模块发现 ── */

const OPEN_FOUR_REGISTRY_SELECTORS = {
  getPresetIdsCount: "0x40f985a9",
  getPresetIdsByBatch: "0x35a9d950",
  resolvePresetImplementations: "0x6c512d72",
  getPresetTokenImpl: "0x07632308",
};

const OPEN_FOUR_MODULE_ROLES = [
  "tokenModule",
  "vaultModule",
  "curveModule",
  "tradeModule",
  "migrateModule",
  "customDataModule",
];

function openFourRegistryCallData(selector, ...uintArgs) {
  return selector + uintArgs.map(arg => encodeUint256(arg)).join("");
}

function nonZeroAddress(addr) {
  const normalized = normalizeAddress(addr);
  return normalized && normalized !== ZERO_ADDRESS ? normalized : "";
}

async function fetchOpenFourPresetIds() {
  const registry = normalizeAddress(CONFIG.contracts.openFourRegistry);
  if (!registry) return [];
  const [countHex] = await bscRpcBatch([{
    method: "eth_call",
    params: [{ to: registry, data: OPEN_FOUR_REGISTRY_SELECTORS.getPresetIdsCount }, "latest"],
  }]);
  const count = Number(decodeUint256(countHex || "0x0"));
  if (!Number.isFinite(count) || count <= 0) return [];

  const calls = [];
  const batchSize = 50;
  for (let index = 0; index < count; index += batchSize) {
    calls.push({
      method: "eth_call",
      params: [{
        to: registry,
        data: openFourRegistryCallData(
          OPEN_FOUR_REGISTRY_SELECTORS.getPresetIdsByBatch,
          index,
          Math.min(batchSize, count - index)
        ),
      }, "latest"],
    });
  }
  const results = await bscRpcBatch(calls);
  return [...new Set(results.flatMap(r => decodeUintArray(r || "0x")))].sort((a, b) => {
    const ai = BigInt(a), bi = BigInt(b);
    return ai < bi ? -1 : ai > bi ? 1 : 0;
  });
}

function addOpenFourModuleEntry(map, address, role, presetId) {
  const addr = nonZeroAddress(address);
  if (!addr) return;
  if (!map[addr]) map[addr] = { address: addr, roles: [], presetIds: [] };
  if (!map[addr].roles.includes(role)) map[addr].roles.push(role);
  const preset = String(presetId);
  if (!map[addr].presetIds.includes(preset)) map[addr].presetIds.push(preset);
}

function decodeOpenFourResolvedModules(hex) {
  if (!hex || hex === "0x") return {};
  const out = {};
  for (let i = 0; i < OPEN_FOUR_MODULE_ROLES.length; i++) {
    const addr = nonZeroAddress(decodeAddress(hex, i + 1));
    if (addr) out[OPEN_FOUR_MODULE_ROLES[i]] = addr;
  }
  return out;
}

async function fetchOpenFourDiscoveredModules() {
  const registry = normalizeAddress(CONFIG.contracts.openFourRegistry);
  const presetIds = await fetchOpenFourPresetIds();
  const byAddress = {};
  if (!registry || presetIds.length === 0) {
    return { registry, presetIds, byAddress };
  }

  const calls = [];
  const callMeta = [];
  for (const presetId of presetIds) {
    calls.push({
      method: "eth_call",
      params: [{ to: registry, data: openFourRegistryCallData(OPEN_FOUR_REGISTRY_SELECTORS.resolvePresetImplementations, presetId) }, "latest"],
    });
    callMeta.push({ presetId, type: "modules" });
    calls.push({
      method: "eth_call",
      params: [{ to: registry, data: openFourRegistryCallData(OPEN_FOUR_REGISTRY_SELECTORS.getPresetTokenImpl, presetId) }, "latest"],
    });
    callMeta.push({ presetId, type: "tokenImpl" });
  }

  const results = await bscRpcBatch(calls);
  for (let i = 0; i < results.length; i++) {
    const hex = results[i];
    if (!hex) continue;
    const meta = callMeta[i];
    if (meta.type === "tokenImpl") {
      addOpenFourModuleEntry(byAddress, decodeAddress(hex, 0), "tokenImpl", meta.presetId);
      continue;
    }
    const modules = decodeOpenFourResolvedModules(hex);
    for (const [role, address] of Object.entries(modules)) {
      addOpenFourModuleEntry(byAddress, address, role, meta.presetId);
    }
  }

  for (const item of Object.values(byAddress)) {
    item.roles.sort();
    item.presetIds.sort((a, b) => {
      const ai = BigInt(a), bi = BigInt(b);
      return ai < bi ? -1 : ai > bi ? 1 : 0;
    });
  }

  return { registry, presetIds, byAddress };
}

function diffOpenFourModules(oldState, newState) {
  const oldMap = oldState?.byAddress || {};
  const newModules = [];
  for (const [address, item] of Object.entries(newState.byAddress || {})) {
    if (!oldMap[address]) newModules.push(item);
  }
  return newModules.sort((a, b) => a.address.localeCompare(b.address));
}

function formatOpenFourNewModules(newModules, context = {}) {
  const lines = [];
  lines.push(`**Registry：** [${CONFIG.contracts.openFourRegistry}](https://bscscan.com/address/${CONFIG.contracts.openFourRegistry})`);
  lines.push(`**新增模块实现：** ${newModules.length} 个`);
  if (context.reason) lines.push(`**触发：** ${context.reason}`);
  if (context.blockNumber) lines.push(`**区块：** [${context.blockNumber}](https://bscscan.com/block/${context.blockNumber})`);
  if (context.txHash) lines.push(`**交易：** [${context.txHash.slice(0, 10)}...](https://bscscan.com/tx/${context.txHash})`);
  lines.push("---");

  for (const item of newModules) {
    lines.push(`**${item.address}**`);
    lines.push("```");
    lines.push(`roles: ${item.roles.join(", ") || "unknown"}`);
    lines.push(`presetIds: ${item.presetIds.join(", ") || "unknown"}`);
    lines.push("```");
    lines.push(`[BscScan](https://bscscan.com/address/${item.address})`);
    lines.push("---");
  }

  return lines.join("\n");
}

async function runOpenFourModuleDiscoveryCheck(context = {}) {
  const discovered = await fetchOpenFourDiscoveredModules();
  if (!snapshot) snapshot = {};
  const oldState = snapshot.openFourModules || null;
  const newModules = oldState ? diffOpenFourModules(oldState, discovered) : [];
  const moduleSnapshotChanged = !oldState || !jsonEqual(
    { registry: oldState.registry, presetIds: oldState.presetIds, byAddress: oldState.byAddress },
    { registry: discovered.registry, presetIds: discovered.presetIds, byAddress: discovered.byAddress }
  );
  snapshot.openFourModules = {
    registry: discovered.registry,
    presetIds: discovered.presetIds,
    byAddress: discovered.byAddress,
    lastPollAt: new Date().toISOString(),
  };

  if (!oldState) {
    await saveSnapshot(snapshot);
    log(`[OpenFour模块] 首次记录：${Object.keys(discovered.byAddress).length} 个模块实现，${discovered.presetIds.length} 个 preset`);
    return;
  }

  if (newModules.length > 0) {
    log(`[OpenFour模块] 发现 ${newModules.length} 个新模块实现`);
    const title = `OpenFour 新模块发现（${newModules.length}个）`;
    const content = formatOpenFourNewModules(newModules, context);
    await saveSnapshot(snapshot);
    appendHistory("openfour", title, content.slice(0, 300), content);
    await sendNotificationMaybeAi({ title, content, template: "orange", moduleContext: "Four.meme OpenFour Registry 新模块发现", url: `https://bscscan.com/address/${CONFIG.contracts.openFourRegistry}` });
  } else if (moduleSnapshotChanged) {
    await saveSnapshot(snapshot);
  }
}

const GITHUB_API = "https://api.github.com";
// githubETag 从 snapshot 恢复，避免重启后浪费 rate limit
let githubETag = "";
let githubReposETag = "";
const GITHUB_COMMIT_DETAIL_LIMIT = 30;

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

  const res = await fetchSafe(url, { headers }, 10_000);

  if (!res.ok) throw new Error(`GitHub API HTTP ${res.status}`);

  // 提交监控每轮都按 SHA 主动确认，避免条件缓存 304 导致真实提交延迟到缓存失效后才推送。
  // 这里仍记录 ETag 仅用于诊断/快照兼容，不再用于 commits 条件请求。
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
    // updated_at 会被 star/watch/fork 等非代码事件刷新，容易造成“仓库更新但无 diff”的误报。
    // 这里仅通知会影响代码/项目形态的字段；代码提交以 pushed_at 和主仓库 commit diff 为准。
    for (const key of ["pushed_at", "default_branch", "description", "archived", "disabled"]) {
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
        let patchBudget = 6000; // 卡片内展示摘要；完整 patch 另存为 diff 文件
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
    } else {
      lines.push("  文件详情：未获取到 commit detail，已在日志记录失败原因。");
    }
    lines.push("---");
  }
  return lines.join("\n");
}

function buildGithubFullDiff(newCommits) {
  const lines = [];
  lines.push(`GitHub 提交完整 diff`);
  lines.push(`仓库: https://github.com/${CONFIG.githubRepo}`);
  lines.push(`分支: ${CONFIG.githubApiBranch}`);
  lines.push(`生成时间: ${ts()}`);
  lines.push(`提交数: ${newCommits.length}`);
  lines.push("");

  for (const c of newCommits) {
    const sha = c.sha || "";
    const commitUrl = `https://github.com/${CONFIG.githubRepo}/commit/${sha}`;
    const msg = c.commit?.message?.trim() || "";
    const author = c.commit?.author?.name || "未知";
    const date = c.commit?.author?.date || "";
    lines.push("=".repeat(80));
    lines.push(`commit ${sha}`);
    lines.push(`url: ${commitUrl}`);
    lines.push(`author: ${author}`);
    lines.push(`date: ${date}`);
    lines.push("");
    lines.push(msg);
    lines.push("");

    if (!c.files || c.files.length === 0) {
      lines.push("(未获取到文件级 diff，可能是 GitHub 未返回 patch 或详情请求失败)");
      lines.push("");
      continue;
    }

    const totalAdditions = c.files.reduce((sum, f) => sum + (f.additions || 0), 0);
    const totalDeletions = c.files.reduce((sum, f) => sum + (f.deletions || 0), 0);
    lines.push(`files: ${c.files.length}, +${totalAdditions} -${totalDeletions}`);
    for (const f of c.files) {
      lines.push("");
      lines.push(`--- ${f.status || "changed"} ${f.filename} (+${f.additions || 0} -${f.deletions || 0})`);
      if (f.previous_filename) lines.push(`previous: ${f.previous_filename}`);
      if (f.patch) {
        lines.push("```diff");
        lines.push(f.patch);
        lines.push("```");
      } else {
        lines.push("(GitHub 未返回该文件 patch，通常是二进制文件、文件过大或 diff 被折叠)");
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

async function checkGithub(lastSha) {
  const commits = await fetchLatestCommits(30);
  if (!commits || commits.length === 0) return { newSha: lastSha, newCommits: [] };
  const latestSha = commits[0].sha;
  if (latestSha === lastSha) return { newSha: lastSha, newCommits: [] };

  const newCommits = [];
  for (const c of commits) {
    if (c.sha === lastSha) break;
    newCommits.push(c);
  }

  // 获取尽量完整的提交详情，确保通知和 diff 文件包含 files/patch。
  // GitHub commit list 本身不带 patch，必须逐个请求 commit detail。
  const detailed = [];
  const detailLimit = Math.min(newCommits.length, GITHUB_COMMIT_DETAIL_LIMIT);
  const detailTasks = newCommits.slice(0, detailLimit).map((c, i) => {
    return sleep(i * 250).then(async () => {
      try {
        return await fetchCommitDetail(c.sha);
      } catch (err) {
        log(`[GitHub] 获取提交详情失败 ${c.sha.slice(0, 8)}：${err.message}`);
        return c;
      }
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

async function fetchContractCreatorActors(contractEntries, state, options = {}) {
  if (contractEntries.length === 0) return cachedCreatorMap(state);
  if (options.refresh === false) return cachedCreatorMap(state);

  const lookupState = state.creatorLookup || (state.creatorLookup = {});
  let missing = missingCreatorAddresses(contractEntries, state);
  await fetchCreatorsViaBscScanPages(missing, state, lookupState, Date.now());

  missing = missingCreatorAddresses(contractEntries, state);
  await fetchCreatorsViaRecentChain(missing, state, lookupState, Date.now());

  missing = missingCreatorAddresses(contractEntries, state);
  await fetchCreatorsViaExplorerApi(missing, state, lookupState, Date.now());

  return cachedCreatorMap(state);
}

async function fetchActorContext(contractEntries, state, options = {}) {
  const actorMap = new Map();
  const contractMap = new Map();
  for (const c of contractEntries) addContractEntry(contractMap, c.labels?.[0] || "", c.address, c.sources?.[0] || "");
  for (const addr of CONFIG.actorMonitor.extraActors) addActorRole(actorMap, addr, "manual", "FOURMEME_WATCH_ACTORS", "env");

  const creatorMap = await fetchContractCreatorActors(contractEntries, state, options);
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

const openFourRegistryLogState = {
  enabled: CONFIG.openFourRegistryLogMonitor.enabled,
  connected: false,
  urlIndex: 0,
  reconnectAttempts: 0,
  lastLogAt: 0,
  lastLogBlock: 0,
  lastTxHash: "",
  lastError: "",
  subscriptionId: "",
  ws: null,
  reconnectTimer: null,
  discoveryTimer: null,
  discoveryRunning: false,
  pendingContext: null,
  stopping: false,
};

function scheduleOpenFourRegistryReconnect(reason) {
  if (openFourRegistryLogState.stopping || !openFourRegistryLogState.enabled) return;
  if (openFourRegistryLogState.reconnectTimer) return;
  const delay = Math.min(60_000, 2_000 * Math.max(1, ++openFourRegistryLogState.reconnectAttempts));
  openFourRegistryLogState.lastError = reason || "";
  log(`[OpenFourRegistry] WebSocket 将在 ${delay / 1000}s 后重连：${reason || "unknown"}`);
  openFourRegistryLogState.reconnectTimer = setTimeout(() => {
    openFourRegistryLogState.reconnectTimer = null;
    connectOpenFourRegistryLogFeed();
  }, delay);
}

function stopOpenFourRegistryLogFeed() {
  openFourRegistryLogState.stopping = true;
  if (openFourRegistryLogState.reconnectTimer) clearTimeout(openFourRegistryLogState.reconnectTimer);
  if (openFourRegistryLogState.discoveryTimer) clearTimeout(openFourRegistryLogState.discoveryTimer);
  openFourRegistryLogState.reconnectTimer = null;
  openFourRegistryLogState.discoveryTimer = null;
  try { openFourRegistryLogState.ws?.close(); } catch {}
  openFourRegistryLogState.ws = null;
}

function scheduleOpenFourModuleDiscovery(context) {
  openFourRegistryLogState.pendingContext = context;
  if (openFourRegistryLogState.discoveryTimer || openFourRegistryLogState.discoveryRunning) return;
  openFourRegistryLogState.discoveryTimer = setTimeout(async () => {
    openFourRegistryLogState.discoveryTimer = null;
    openFourRegistryLogState.discoveryRunning = true;
    const pending = openFourRegistryLogState.pendingContext || { reason: "OpenFourRegistry log" };
    openFourRegistryLogState.pendingContext = null;
    try {
      await runOpenFourModuleDiscoveryCheck(pending);
    } catch (err) {
      openFourRegistryLogState.lastError = err.message || String(err);
      log(`[OpenFourRegistry] 新模块发现检查失败：${openFourRegistryLogState.lastError}`);
    } finally {
      openFourRegistryLogState.discoveryRunning = false;
      if (openFourRegistryLogState.pendingContext) scheduleOpenFourModuleDiscovery(openFourRegistryLogState.pendingContext);
    }
  }, CONFIG.openFourRegistryLogMonitor.discoveryDebounceMs);
}

function handleOpenFourRegistryLogMessage(raw) {
  let msg;
  try { msg = JSON.parse(String(raw)); } catch { return; }
  if (msg.id === 1 && msg.result) {
    openFourRegistryLogState.subscriptionId = msg.result;
    openFourRegistryLogState.connected = true;
    openFourRegistryLogState.reconnectAttempts = 0;
    log(`[OpenFourRegistry] 已订阅 Registry logs：${msg.result}`);
    return;
  }
  const event = msg.params?.result;
  if (!event) return;
  const blockNumber = hexToNumber(event.blockNumber || "0x0");
  openFourRegistryLogState.lastLogAt = Date.now();
  openFourRegistryLogState.lastLogBlock = blockNumber;
  openFourRegistryLogState.lastTxHash = event.transactionHash || "";
  log(`[OpenFourRegistry] 捕获 Registry 日志，触发新模块发现检查：block=${blockNumber}`);
  scheduleOpenFourModuleDiscovery({
    reason: "OpenFourRegistry 链上日志",
    blockNumber,
    txHash: event.transactionHash || "",
  });
}

function connectOpenFourRegistryLogFeed() {
  if (!openFourRegistryLogState.enabled || openFourRegistryLogState.stopping) return;
  const registry = normalizeAddress(CONFIG.contracts.openFourRegistry);
  if (!registry) {
    log("[OpenFourRegistry] 未配置 Registry 地址，跳过链上日志监听");
    return;
  }
  const urls = CONFIG.bscWsUrls || [];
  if (urls.length === 0) {
    log("[OpenFourRegistry] 未配置 BSC WebSocket URL，跳过 Registry 日志监听");
    return;
  }

  const url = urls[openFourRegistryLogState.urlIndex % urls.length];
  openFourRegistryLogState.urlIndex++;
  openFourRegistryLogState.lastError = "";
  log(`[OpenFourRegistry] 正在连接 WebSocket 日志订阅：${url.replace(/\/\/[^/@]+@/, "//***@")}`);

  const ws = new WebSocket(url, { handshakeTimeout: 10_000 });
  openFourRegistryLogState.ws = ws;

  ws.on("open", () => {
    openFourRegistryLogState.connected = true;
    openFourRegistryLogState.lastError = "";
    ws.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_subscribe",
      params: ["logs", { address: registry }],
    }));
  });

  ws.on("message", handleOpenFourRegistryLogMessage);

  ws.on("close", (code, reason) => {
    if (openFourRegistryLogState.ws === ws) openFourRegistryLogState.ws = null;
    openFourRegistryLogState.connected = false;
    openFourRegistryLogState.subscriptionId = "";
    scheduleOpenFourRegistryReconnect(`close ${code}${reason ? ` ${reason}` : ""}`);
  });

  ws.on("error", (err) => {
    openFourRegistryLogState.lastError = err.message || String(err);
    log(`[OpenFourRegistry] WebSocket 日志订阅异常：${openFourRegistryLogState.lastError}`);
  });
}

function startOpenFourRegistryLogFeed() {
  openFourRegistryLogState.stopping = false;
  connectOpenFourRegistryLogFeed();
  const healthTimer = setInterval(() => {
    const ws = openFourRegistryLogState.ws;
    if (ws?.readyState === WebSocket.OPEN) {
      try { ws.ping(); } catch {}
    }
  }, 30_000);
  return { stop: stopOpenFourRegistryLogFeed, healthTimer };
}

const actorBlockFeedState = {
  enabled: CONFIG.actorMonitor.wsEnabled,
  connected: false,
  urlIndex: 0,
  reconnectAttempts: 0,
  latestHeadBlock: 0,
  lastHeadAt: 0,
  lastError: "",
  subscriptionId: "",
  ws: null,
  reconnectTimer: null,
  stopping: false,
};

function actorBlockFeedMode() {
  if (!CONFIG.actorMonitor.wsEnabled) return "http_fallback";
  if (actorBlockFeedState.connected && Date.now() - actorBlockFeedState.lastHeadAt < 120_000) return "websocket";
  return "http_fallback";
}

function actorBlockFeedSnapshot() {
  return {
    enabled: CONFIG.actorMonitor.wsEnabled,
    mode: actorBlockFeedMode(),
    connected: actorBlockFeedState.connected,
    latestHeadBlock: actorBlockFeedState.latestHeadBlock || 0,
    lastHeadAt: actorBlockFeedState.lastHeadAt ? new Date(actorBlockFeedState.lastHeadAt).toISOString() : "",
    lastError: actorBlockFeedState.lastError || "",
    subscriptionId: actorBlockFeedState.subscriptionId || "",
  };
}

async function fetchLatestBlockForActorCheck() {
  if (actorBlockFeedMode() === "websocket" && actorBlockFeedState.latestHeadBlock > 0) {
    return actorBlockFeedState.latestHeadBlock;
  }
  const latestHex = await bscRpcCall("eth_blockNumber", []);
  return hexToNumber(latestHex);
}

function shouldLogActorCatchup(state, lagBefore, lagAfter) {
  if (lagBefore < CONFIG.actorMonitor.lagWarnBlocks && lagAfter < CONFIG.actorMonitor.lagWarnBlocks) {
    if (state.catchupLog?.active) {
      state.catchupLog = { active: false, lastLogAt: Date.now(), lastLagBlocks: lagAfter };
      return { ok: true, reason: "done" };
    }
    return { ok: false, reason: "" };
  }

  const now = Date.now();
  const prev = state.catchupLog || {};
  const first = !prev.active;
  const elapsed = now - (prev.lastLogAt || 0);
  const delta = Math.max(0, (prev.lastLagBlocks ?? lagBefore) - lagAfter);
  const ok = first
    || elapsed >= CONFIG.actorMonitor.catchupLogIntervalMs
    || delta >= CONFIG.actorMonitor.catchupLogMinDeltaBlocks
    || lagAfter <= CONFIG.actorMonitor.maxBlocksPerRun;
  if (ok) {
    state.catchupLog = { active: true, lastLogAt: now, lastLagBlocks: lagAfter };
  }
  return { ok, reason: first ? "start" : "progress" };
}

async function runActorCheck() {
  if (!CONFIG.actorMonitor.enabled) return;
  const state = ensureActorMonitorState();
  const stateBefore = JSON.stringify(state);
  let persistedActorStateSignature = stateBefore;
  const contractEntries = buildWatchedContractEntries();
  if (contractEntries.length === 0) {
    log("[创建者] 尚无合约指纹，等待合约模块建立基线");
    return;
  }

  const latest = await fetchLatestBlockForActorCheck();
  const safeLatest = Math.max(0, latest - CONFIG.actorMonitor.confirmations);
  if (!state.lastBlock) {
    state.lastBlock = Math.max(0, safeLatest - CONFIG.actorMonitor.bootstrapLookbackBlocks);
    log(`[创建者] 初始化区块游标：${state.lastBlock}（最新块=${latest}，确认块=${safeLatest}）`);
  }

  state.latestBlock = latest;
  state.safeLatestBlock = safeLatest;
  state.actorLagBlocks = Math.max(0, safeLatest - state.lastBlock);
  state.actorLagSecondsApprox = state.actorLagBlocks * 3;
  state.contractCount = contractEntries.length;
  state.creatorChainLookupEnabled = CONFIG.actorMonitor.creatorChainLookupEnabled;
  state.creatorPageLookupEnabled = CONFIG.actorMonitor.creatorPageLookupEnabled;
  state.creatorApiLookupEnabled = CONFIG.actorMonitor.creatorLookupEnabled;
  state.creatorLookupEnabled = CONFIG.actorMonitor.creatorChainLookupEnabled || CONFIG.actorMonitor.creatorPageLookupEnabled || CONFIG.actorMonitor.creatorLookupEnabled;
  state.blockFeed = actorBlockFeedSnapshot();

  const cachedCreatorCount = Object.keys(cachedCreatorMap(state)).length;
  const bootstrapCreatorRefresh = cachedCreatorCount === 0 && CONFIG.actorMonitor.extraActors.length === 0;
  if (bootstrapCreatorRefresh) {
    log("[创建者] 尚无创建者缓存，先执行一次创建者补全以建立监听地址");
  }

  let context = await fetchActorContext(contractEntries, state, { refresh: bootstrapCreatorRefresh });
  let actorList = formatActorWatchList(context);
  state.actors = Object.fromEntries(actorList.map(actor => [actor.address, actor]));
  state.actionActorCount = actorList.filter(actor => actor.actionWatched).length;

  const lagBefore = Math.max(0, safeLatest - state.lastBlock);

  const runStart = Date.now();
  const maxBlocksThisRun = lagBefore > CONFIG.actorMonitor.maxBlocksPerRun
    ? CONFIG.actorMonitor.catchupMaxBlocksPerRun
    : CONFIG.actorMonitor.maxBlocksPerRun;
  let remainingBlocks = maxBlocksThisRun;
  let scannedBlocks = 0;
  let scannedBatches = 0;
  let anyActions = false;
  let lastActorProgressSaveAt = Date.now();

  while (state.lastBlock < safeLatest && remainingBlocks > 0) {
    const fromBlock = state.lastBlock + 1;
    const batchSize = Math.min(
      CONFIG.actorMonitor.maxBlocksPerRun,
      remainingBlocks,
      safeLatest - state.lastBlock
    );
    const toBlock = fromBlock + batchSize - 1;
    const actions = await fetchActorBlockActions(fromBlock, toBlock, context, state);

    state.lastBlock = toBlock;
    state.lastBlockAt = ts();
    state.actorLagBlocks = Math.max(0, safeLatest - state.lastBlock);
    state.actorLagSecondsApprox = state.actorLagBlocks * 3;
    state.lastRunScannedBlocks = scannedBlocks + batchSize;
    state.lastRunBatches = scannedBatches + 1;
    state.lastRunAt = ts();
    rememberActorTxs(state, actions);

    scannedBlocks += batchSize;
    scannedBatches++;
    remainingBlocks -= batchSize;
    const shouldPersistProgress = actions.length > 0
      || Date.now() - lastActorProgressSaveAt >= 10_000;
    if (shouldPersistProgress) {
      await saveSnapshot(snapshot);
      persistedActorStateSignature = JSON.stringify(state);
      lastActorProgressSaveAt = Date.now();
    }

    if (actions.length > 0) {
      anyActions = true;
      const highCount = actions.filter(a => a.risk === "high").length;
      log(`[创建者] 捕获 ${actions.length} 条创建者动作（高风险 ${highCount} 条），区块 ${fromBlock}-${toBlock}`);
      const content = formatActorActions(actions);
      appendHistory("actor", `链上创建者动作（${actions.length}项）`, content.slice(0, 300), content);
      const color = highCount > 0 ? "red" : "yellow";
      await sendNotificationMaybeAi({ title: `链上创建者动作（${actions.length}项）`, content, template: color, moduleContext: "Four.meme 合约创建者动作", url: `https://bscscan.com/block/${toBlock}` });
    }

    if (Date.now() - runStart >= CONFIG.actorMonitor.maxRunMs && state.lastBlock < safeLatest) {
      log(`[创建者] 本轮已扫描 ${scannedBlocks} 块，用时接近上限，剩余延迟 ${safeLatest - state.lastBlock} 块留待下一轮继续追赶`);
      break;
    }
  }

  state.actorLagBlocks = Math.max(0, safeLatest - state.lastBlock);
  state.actorLagSecondsApprox = state.actorLagBlocks * 3;
  state.lastRunScannedBlocks = scannedBlocks;
  state.lastRunBatches = scannedBatches;
  state.lastRunAt = ts();

  const catchupLog = shouldLogActorCatchup(state, lagBefore, state.actorLagBlocks);
  if (catchupLog.ok) {
    if (catchupLog.reason === "done") {
      log(`[创建者] 追块完成：当前延迟 ${state.actorLagBlocks} 块，恢复创建者补全`);
    } else {
      log(`[创建者] 追块${catchupLog.reason === "start" ? "启动" : "进度"}：延迟 ${lagBefore} → ${state.actorLagBlocks} 块，本轮 ${scannedBatches} 批 / ${scannedBlocks} 块，模式 ${state.blockFeed?.mode || "unknown"}`);
    }
  }

  if (state.actorLagBlocks <= CONFIG.actorMonitor.maxBlocksPerRun) {
    const beforeCreators = JSON.stringify(state.creators || {});
    await fetchContractCreatorActors(contractEntries, state, { refresh: true });
    if (beforeCreators !== JSON.stringify(state.creators || {})) {
      context = await fetchActorContext(contractEntries, state, { refresh: false });
      actorList = formatActorWatchList(context);
      state.actors = Object.fromEntries(actorList.map(actor => [actor.address, actor]));
      state.actionActorCount = actorList.filter(actor => actor.actionWatched).length;
    }
  } else {
    // 追块期间创建者补全会拖慢实时扫链；进度日志由 shouldLogActorCatchup 节流输出。
  }

  const finalActorStateSignature = JSON.stringify(state);
  if (persistedActorStateSignature !== finalActorStateSignature) await saveSnapshot(snapshot);

  if (anyActions) {
    try {
      log("[创建者] 创建者动作已触发，立即复查合约状态");
      await runContractCheck();
    } catch (err) {
      log(`[创建者] 触发合约复查失败：${err.message}`);
    }
  }
}

function stopActorBlockFeed() {
  actorBlockFeedState.stopping = true;
  if (actorBlockFeedState.reconnectTimer) {
    clearTimeout(actorBlockFeedState.reconnectTimer);
    actorBlockFeedState.reconnectTimer = null;
  }
  if (actorBlockFeedState.ws) {
    try { actorBlockFeedState.ws.close(); } catch {}
    actorBlockFeedState.ws = null;
  }
  actorBlockFeedState.connected = false;
}

function scheduleActorBlockFeedReconnect(actorRunner, reason) {
  if (!CONFIG.actorMonitor.wsEnabled || actorBlockFeedState.stopping || actorBlockFeedState.reconnectTimer) return;
  actorBlockFeedState.connected = false;
  actorBlockFeedState.lastError = reason || "";
  const delay = Math.min(60_000, 1_000 * (2 ** Math.min(actorBlockFeedState.reconnectAttempts, 6)));
  actorBlockFeedState.reconnectAttempts++;
  log(`[创建者] WebSocket 新区块订阅将在 ${Math.round(delay / 1000)}s 后重连${reason ? `：${reason}` : ""}`);
  actorBlockFeedState.reconnectTimer = setTimeout(() => {
    actorBlockFeedState.reconnectTimer = null;
    connectActorBlockFeed(actorRunner);
  }, delay);
}

function handleActorBlockFeedMessage(actorRunner, raw) {
  let msg;
  try {
    msg = JSON.parse(String(raw));
  } catch {
    return;
  }
  if (msg.id === 1 && msg.result) {
    actorBlockFeedState.subscriptionId = String(msg.result);
    log(`[创建者] WebSocket 新区块订阅已建立：${actorBlockFeedState.subscriptionId}`);
    return;
  }
  const headHex = msg?.params?.result?.number;
  if (!headHex) return;
  const headBlock = hexToNumber(headHex);
  if (!headBlock || headBlock <= actorBlockFeedState.latestHeadBlock) return;

  actorBlockFeedState.latestHeadBlock = headBlock;
  actorBlockFeedState.lastHeadAt = Date.now();
  actorBlockFeedState.reconnectAttempts = 0;
  actorRunner.run().catch(err => {
    log(`[创建者] WebSocket 触发检测异常：${err.message}`);
  });
}

function connectActorBlockFeed(actorRunner) {
  const urls = CONFIG.bscWsUrls || [];
  if (!CONFIG.actorMonitor.wsEnabled) {
    log("[创建者] WebSocket 新区块订阅已关闭（FOURMEME_ACTOR_WS_ENABLED=false）");
    return;
  }
  if (urls.length === 0) {
    log("[创建者] 未配置 BSC WebSocket URL，创建者动作使用 HTTP 轮询兜底");
    return;
  }

  const url = urls[actorBlockFeedState.urlIndex % urls.length];
  actorBlockFeedState.urlIndex++;
  actorBlockFeedState.lastError = "";
  log(`[创建者] 正在连接 WebSocket 新区块订阅：${url.replace(/\/\/[^/@]+@/, "//***@")}`);

  const ws = new WebSocket(url, { handshakeTimeout: 10_000 });
  actorBlockFeedState.ws = ws;

  ws.on("open", () => {
    actorBlockFeedState.connected = true;
    actorBlockFeedState.lastError = "";
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_subscribe", params: ["newHeads"] }));
  });

  ws.on("message", (raw) => handleActorBlockFeedMessage(actorRunner, raw));

  ws.on("close", (code, reason) => {
    if (actorBlockFeedState.ws === ws) actorBlockFeedState.ws = null;
    actorBlockFeedState.connected = false;
    actorBlockFeedState.subscriptionId = "";
    scheduleActorBlockFeedReconnect(actorRunner, `close ${code}${reason ? ` ${reason}` : ""}`);
  });

  ws.on("error", (err) => {
    actorBlockFeedState.lastError = err.message || String(err);
    log(`[创建者] WebSocket 新区块订阅异常：${actorBlockFeedState.lastError}`);
  });

  ws.on("pong", () => {
    actorBlockFeedState.lastPongAt = Date.now();
  });
}

function startActorBlockFeed(actorRunner) {
  actorBlockFeedState.stopping = false;
  connectActorBlockFeed(actorRunner);
  const healthTimer = setInterval(() => {
    const ws = actorBlockFeedState.ws;
    if (ws?.readyState === WebSocket.OPEN) {
      try { ws.ping(); } catch {}
    }
    if (actorBlockFeedState.connected && actorBlockFeedState.lastHeadAt && Date.now() - actorBlockFeedState.lastHeadAt > 180_000) {
      actorBlockFeedState.lastError = "180s 内未收到新区块事件";
      log("[创建者] WebSocket 新区块订阅长时间无事件，切换连接");
      try { ws?.terminate(); } catch {}
    }
  }, 30_000);
  return { stop: stopActorBlockFeed, healthTimer };
}

/* ══════════════════════════════════════════
   模块运行器（独立定时器 + 防重入）
   ══════════════════════════════════════════ */

/* ── 全局状态 ── */
let snapshot = loadSnapshot();
let startTime = Date.now();
let modulePollCounts = { pool: 0, frontend: 0, api: 0, openfourTemplates: 0, github: 0, contract: 0, onchain: 0, actor: 0 };
const apiEmptyArrayLogState = new Map();
const frontendMetrics = {
  lastRunAt: 0,
  success: 0,
  failed: 0,
  suppressed: 0,
  notifications: 0,
  pages: {},
};

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
      await sendNotificationMaybeAi({ title: `底池移除（${expired.length}项）`, content, template: "red", moduleContext: "Four.meme 底池配置变更", url: CONFIG.siteUrl });
    }
  } finally {
    snapshotMutex.release();
  }
}

// 定期刷新过期移除缓存
if (!IS_TEST_MODE) {
  setInterval(() => { flushExpiredPoolRemovals().catch(e => log(`[底池] 移除缓存刷新异常：${e.message}`)); }, 120_000);
}

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
  let pending = false;
  let backoffSkips = 0;
  const run = async () => {
    if (running) {
      pending = true;
      return;
    }
    running = true;
    try {
      do {
        pending = false;
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
        }
      } while (pending);
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
    await sendNotificationMaybeAi({ title: `底池变更（${poolChanges.length}项）`, content, template: "red", moduleContext: "Four.meme 底池配置变更", url: CONFIG.siteUrl });
  } else {
    if (!jsonEqual(snapshot.poolConfig, poolData)) {
      snapshot.poolConfig = poolData;
      await saveSnapshot(snapshot);
    }
  }
}

async function runFrontendCheck() {
  if (!snapshot) snapshot = {};
  if (!snapshot._frontendFailCounts) snapshot._frontendFailCounts = {};
  ensureFrontendRouteState(snapshot);
  if (mergeExternalFrontendRouteState(snapshot)) {
    log("[前端] 已合并飞书交互产生的新路由确认状态");
  }
  if (!snapshot._frontendNotifyDedupe) snapshot._frontendNotifyDedupe = {};
  if (!snapshot._frontendWarmup) snapshot._frontendWarmup = {};
  frontendMetrics.lastRunAt = Date.now();
  const prunedBeforeRun = pruneFrontendSnapshot(snapshot);
  const oldPages = snapshot.frontendPages || {};
  const { pages: newPages, failedUrls, failedDetails = [], discoveryHistoryChanged = false, pendingRoutePages = [] } = await fetchFrontendDataWithDiscovery(oldPages);
  frontendMetrics.success = Object.keys(newPages).length;
  frontendMetrics.failed = failedUrls.length;

  // 页面抓取失败告警：连续失败计数
  let failCountChanged = false;
  const failedByUrl = new Map(failedDetails.map(item => [item.url, item]));
  for (const url of failedUrls) {
    const detail = failedByUrl.get(url) || { reason: "error", message: "" };
    const key = urlToKey(url);
    const prev = snapshot._frontendFailCounts[key];
    const count = typeof prev === "object" ? (prev.count || 0) : (prev || 0);
    snapshot._frontendFailCounts[key] = {
      count: count + 1,
      reason: detail.reason,
      message: detail.message,
      lastFailAt: Date.now(),
    };
    failCountChanged = true;
  }
  // 重置成功页面的失败计数
  for (const key of Object.keys(newPages)) {
    if (snapshot._frontendFailCounts[key]) {
      delete snapshot._frontendFailCounts[key];
      failCountChanged = true;
    }
    frontendMetrics.pages[key] = {
      lastSuccessAt: Date.now(),
      durationMs: newPages[key]?.fetchMeta?.durationMs || 0,
      status: newPages[key]?.fetchMeta?.status || 200,
    };
  }

  if (!snapshot.frontendPages) {
    const configuredKeys = new Set(CONFIG.monitorUrls.map(url => urlToKey(canonicalFrontendUrl(url))));
    const configuredSuccess = Object.keys(newPages).filter(key => configuredKeys.has(key)).length;
    const minSuccessRatio = Number(process.env.FOURMEME_FRONTEND_BASELINE_MIN_SUCCESS_RATIO || "0.8");
    const successRatio = CONFIG.monitorUrls.length ? configuredSuccess / CONFIG.monitorUrls.length : 1;
    if (successRatio < minSuccessRatio) {
      log(`[前端] 首次基线成功率不足：固定入口 ${configuredSuccess}/${CONFIG.monitorUrls.length}，暂不保存基线`);
      await saveSnapshot(snapshot);
      return;
    }
    snapshot.frontendPages = newPages;
    for (const page of Object.values(newPages)) {
      snapshot._frontendDiscoveredHistory[canonicalFrontendUrl(page.originalUrl)] = { firstSeenAt: Date.now(), baselineOnly: true };
    }
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
  const routeDiscoveryNotifications = [];
  const globalI18nResourceGroups = new Map();
  let snapshotDirty = prunedBeforeRun || discoveryHistoryChanged;

  for (const page of pendingRoutePages) {
    const canonical = canonicalFrontendUrl(page.originalUrl);
    if (!canonical || getFrontendRouteDecision(canonical) !== "new") continue;
    const now = Date.now();
    snapshot._frontendPendingRoutes[canonical] = {
      url: canonical,
      status: "pending",
      token: frontendRouteActionToken(canonical),
      firstSeenAt: now,
      lastSeenAt: now,
      notifiedAt: now,
      updatedAt: now,
      title: page.nextData?.page || urlLabel(canonical),
      textPreview: frontendDisplaySnippet(page.textContent || "", 500),
      assetCount: (page.assetFiles || []).length,
      i18nCount: page.i18nStrings ? Object.keys(page.i18nStrings).length : 0,
      routeCount: (page.routes || []).length,
    };
    snapshot._frontendDiscoveredHistory[canonical] = {
      ...(snapshot._frontendDiscoveredHistory[canonical] || {}),
      firstSeenAt: snapshot._frontendDiscoveredHistory[canonical]?.firstSeenAt || now,
      lastSeenAt: now,
      pendingApproval: true,
    };
    routeDiscoveryNotifications.push(buildFrontendNewPageNotification(page));
    snapshotDirty = true;
  }

  if (routeDiscoveryNotifications.length > 0) {
    const dedupedRouteNotifications = filterFrontendDedupe(routeDiscoveryNotifications, snapshot);
    frontendMetrics.notifications += dedupedRouteNotifications.length;
    await saveSnapshot(snapshot);
    for (const n of dedupedRouteNotifications) {
      n.title = normalizeFrontendNotificationTitle(n.title, n.url);
      appendHistory("frontend", n.title, n.content.slice(0, 300), n.content);
      await sendNotificationMaybeAi({ title: n.title, content: n.content, template: n.template, moduleContext: `Four.meme 前端新路由 ${n.title}`, aiInput: n.aiInput, url: n.url, cardOpts: n.cardOpts || {} });
    }
  }

  const failureNotifications = buildFrontendFailureNotifications(failedUrls, snapshot);
  if (failureNotifications.length > 0) {
    notifications.push(...failureNotifications);
    snapshotDirty = true;
  }

  for (const [key, newData] of Object.entries(newPages)) {
    const oldData = oldPages[key];
    if (!oldData) {
      const label = urlLabel(newData.originalUrl);
      const fileCount = (newData.assetFiles || []).length;
      const routeCount = (newData.routes || []).length;
      log(`[前端] 新增监控页面 warm-up 基线：${label}（资源 ${fileCount} 个，路由/端点 ${routeCount} 个）`);
      snapshot._frontendDiscoveredHistory[canonicalFrontendUrl(newData.originalUrl)] = {
        firstSeenAt: Date.now(),
        lastSeenAt: Date.now(),
        baselineOnly: true,
      };
      snapshot._frontendWarmup[key] = { stableRuns: 1, firstSeenAt: Date.now() };
      snapshot.frontendPages[key] = newData;
      snapshotDirty = true;
      continue;
    }
    const canonicalPageUrl = canonicalFrontendUrl(newData.originalUrl);
    if (snapshot._frontendDiscoveredHistory[canonicalPageUrl]) {
      snapshot._frontendDiscoveredHistory[canonicalPageUrl].lastSeenAt = Date.now();
    }
    if (snapshot._frontendWarmup[key]) {
      const stableRuns = (snapshot._frontendWarmup[key].stableRuns || 0) + 1;
      if (stableRuns < readPositiveIntEnv("FOURMEME_FRONTEND_WARMUP_STABLE_RUNS", 1)) {
        snapshot._frontendWarmup[key] = { ...snapshot._frontendWarmup[key], stableRuns };
        snapshot.frontendPages[key] = newData;
        snapshotDirty = true;
        continue;
      }
      delete snapshot._frontendWarmup[key];
      log(`[前端] ${urlLabel(newData.originalUrl)} warm-up 完成，后续变更将正常告警`);
    }

    const contentParts = [];
    const assetContentParts = [];
    const pageContentParts = [];
    let hasNonAssetChange = false;
    let cachedAssetDiff = null; // 缓存资源 diff 结果，避免重复计算
    let businessSignalDiff = null;
    let i18nChanges = null;
    let pageI18nChanges = null;
    let i18nChanged = false;
    let routeChanged = false;

    // ── 1. 资源文件 diff（独立于下载成功与否）──
    // assetHash 监控文件列表；assetContentHash 补充监控创建页资源原地替换。
    const oldAssetContentHash = oldData.assetContentHash || frontendAssetContentsHash(oldData.assetContents);
    const newAssetContentHash = newData.assetContentHash || frontendAssetContentsHash(newData.assetContents);
    const assetListChanged = oldData.assetHash && newData.assetHash && oldData.assetHash !== newData.assetHash;
    const assetContentChanged = oldAssetContentHash && newAssetContentHash && oldAssetContentHash !== newAssetContentHash;
    if (assetListChanged || assetContentChanged) {
      const hasOldContents = oldData.assetContents && Object.keys(oldData.assetContents).length > 0;
      const hasNewContents = newData.assetContents && Object.keys(newData.assetContents).length > 0;

      if (hasOldContents && hasNewContents) {
        // 深度 diff：基于下载的资源内容
        cachedAssetDiff = diffFrontendAssets(oldData.assetContents, newData.assetContents);
        const hasAssetChange = cachedAssetDiff.matched.length > 0 || cachedAssetDiff.added.length > 0 || cachedAssetDiff.removed.length > 0;
        if (hasAssetChange) {
          const assetSummary = analyzeFrontendAssetDiff(cachedAssetDiff, oldData.assetContents, newData.assetContents, newData.originalUrl);
          const assetContent = formatFrontendAssetBrief(assetSummary);
          if (hasMeaningfulFrontendAssetChange(assetSummary) && assetContent) {
            contentParts.push(assetContent);
            assetContentParts.push(assetContent);
          } else {
            logFrontendInfoRateLimited(
              `asset-noise:${canonicalFrontendUrl(newData.originalUrl)}`,
              `[前端] ${urlLabel(newData.originalUrl)} 仅检测到构建产物/压缩变量噪音，更新快照但不推送`
            );
          }
        }
      } else {
        // 内容不完整时不推送文件列表 diff，避免 CDN/风控/短暂下载失败造成 chunk 噪声反复报警。
        const oldSet = new Set(oldData.assetFiles || []);
        const newSet = new Set(newData.assetFiles || []);
        const added = [...newSet].filter(f => !oldSet.has(f));
        const removed = [...oldSet].filter(f => !newSet.has(f));
        cachedAssetDiff = { matched: [], added, removed, unchanged: 0, renamed: 0 };
        log(`[前端] ${urlLabel(newData.originalUrl)} 资源内容下载不完整，已跳过文件列表变更推送（新增 ${added.length}，移除 ${removed.length}）`);
      }
    }

    // ── 1.5 创建页关键业务指纹 diff（税收按钮/费率开关/创建表单配置）──
    const isCreateTokenPage = isCreateTokenFrontendUrl(newData.originalUrl);
    if (isCreateTokenPage && (newData.createTokenSignals || oldData.createTokenSignals)) {
      businessSignalDiff = diffFrontendSignals(oldData.createTokenSignals, newData.createTokenSignals);
      const signalContent = formatFrontendSignalChanges(businessSignalDiff, "创建页重点文案/功能信号");
      if (signalContent) {
        contentParts.push(signalContent);
        pageContentParts.push(signalContent);
        hasNonAssetChange = true;
      }
    } else if (isCreateTokenPage && newData.createTokenSignalHash) {
      const signalContent = `**🔎 创建页重点文案/功能信号首次建立：** ${(newData.createTokenSignals || []).length} 项`;
      contentParts.push(signalContent);
      pageContentParts.push(signalContent);
      hasNonAssetChange = true;
    } else if (!isCreateTokenPage && oldData.createTokenSignals) {
      delete newData.createTokenSignals;
      delete newData.createTokenSignalHash;
      log(`[前端] ${urlLabel(newData.originalUrl)} 清理历史创建页业务指纹快照，不推送`);
    }

    // ── 2. i18n diff（优先展示，中文内容最具可读性）──
    if (oldData.i18nHash && newData.i18nHash && oldData.i18nHash !== newData.i18nHash) {
      i18nChanges = diffI18nStrings(oldData.i18nStrings, newData.i18nStrings);
      if (!shouldConfirmI18nRemoval(snapshot, key, i18nChanges, oldData.i18nStrings, newData.i18nStrings)) {
        const counts = i18nChangeTypeCounts(i18nChanges);
        logFrontendInfoRateLimited(
          `i18n-removal-jitter:${key}:${i18nChangeSignature(i18nChanges)}`,
          `[前端] ${urlLabel(newData.originalUrl)} 检测到疑似 i18n 资源集短暂缺 key（删除 ${counts.removed}），等待连续确认，暂不推送`
        );
        preserveOldI18nSnapshot(newData, oldData);
        i18nChanges = null;
      } else if (snapshot._frontendI18nPendingRemovals) {
        delete snapshot._frontendI18nPendingRemovals[key];
      }
    }

    if (i18nChanges?.length) {
      const { visible, resourceOnly } = partitionI18nChangesByPageVisibility(
        i18nChanges,
        oldData.textContent || "",
        newData.textContent || "",
      );
      pageI18nChanges = visible;
      addGlobalI18nResourceChange(globalI18nResourceGroups, newData, resourceOnly);
      const i18nFormatted = formatI18nChanges(visible);
      if (i18nFormatted) {
        contentParts.push(i18nFormatted);
        pageContentParts.push(i18nFormatted);
        hasNonAssetChange = true;
        i18nChanged = true;
      } else if (resourceOnly.length > 0) {
        logFrontendInfoRateLimited(
          `i18n-resource-only:${i18nChangeSignature(resourceOnly)}`,
          `[前端] 检测到 ${resourceOnly.length} 条 i18n 资源变更，未匹配到页面可见 DOM，改为全局汇总`
        );
      }
    } else if (!oldData.i18nHash && newData.i18nHash && newData.i18nStrings) {
      // 首次出现 i18n 数据
      const keyCount = Object.keys(newData.i18nStrings).length;
      const pageContent = `**📝 i18n 国际化字符串首次检测到：** ${keyCount} 条翻译`;
      contentParts.push(pageContent);
      pageContentParts.push(pageContent);
      hasNonAssetChange = true;
      i18nChanged = true;
    } else if (oldData.i18nHash && !newData.i18nHash) {
      const pageContent = "**📝 i18n 国际化字符串被移除**";
      contentParts.push(pageContent);
      pageContentParts.push(pageContent);
      hasNonAssetChange = true;
      i18nChanged = true;
    }

    // ── 3. 页面文案 diff（独立，不依赖资源下载）──
    let textDiff = null;
    if (oldData.contentHash && newData.contentHash && oldData.contentHash !== newData.contentHash) {
      textDiff = diffTextContent(oldData.textContent, newData.textContent);
      if (textDiff) {
        if (textDiff.reordered) {
          const pageContent = "**📝 页面文案顺序调整（内容不变）**";
          contentParts.push(pageContent);
          pageContentParts.push(pageContent);
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
          const pageContent = lines.join("\n");
          contentParts.push(pageContent);
          pageContentParts.push(pageContent);
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
        pageContentParts.push(nextDataFormatted);
        hasNonAssetChange = true;
      }
    } else if (oldData.nextDataHash && !newData.nextDataHash) {
      const pageContent = "**📋 __NEXT_DATA__ 被移除**";
      contentParts.push(pageContent);
      pageContentParts.push(pageContent);
      hasNonAssetChange = true;
    } else if (!oldData.nextDataHash && newData.nextDataHash) {
      const pageContent = "**📋 __NEXT_DATA__ 新出现**";
      contentParts.push(pageContent);
      pageContentParts.push(pageContent);
      hasNonAssetChange = true;
    }

    // ── 5. 路由/端点 diff（独立）──
    const routeDiff = diffRoutes(oldData.routes, newData.routes);
    if (routeDiff.added.length > 0 || routeDiff.removed.length > 0) {
      const routeFormatted = formatRouteChanges(routeDiff);
      if (routeFormatted) {
        contentParts.push(routeFormatted);
        pageContentParts.push(routeFormatted);
        hasNonAssetChange = true;
        routeChanged = true;
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

      // 构建详细 diff 文件（复用已计算的 assetDiff）
      const fullDiff = buildFullDiffText(label, cachedAssetDiff, textDiff, routeDiff, businessSignalDiff, [], oldData.assetContents, newData.assetContents, newData.originalUrl, pageI18nChanges);
      const assetSummary = cachedAssetDiff ? analyzeFrontendAssetDiff(cachedAssetDiff, oldData.assetContents, newData.assetContents, newData.originalUrl) : null;
      const semanticSignature = frontendSemanticChangeSignature({ assetSummary, businessSignalDiff, i18nChanges: pageI18nChanges, textDiff, routeDiff });
      const contentV2 = [
        `**页面：${label}**`,
        `URL: ${newData.originalUrl}`,
        "",
        contentParts.join("\n\n"),
      ].join("\n");

      notifications.push({
        title: frontendNotificationTitle(label, { textDiff, i18nChanged, routeChanged }),
        content: contentV2,
        template: "orange",
        fullDiff,
        url: newData.originalUrl,
        pageLabel: label,
        assetSignature: semanticSignature || frontendAssetChangeSignature(cachedAssetDiff, oldData.assetContents, newData.assetContents),
        assetContent: assetContentParts.join("\n\n"),
        pageContent: pageContentParts.join("\n\n"),
      });
    }

    // 在所有 diff 完成后更新快照
    snapshot.frontendPages[key] = newData;
    snapshotDirty = true;
  }

  for (const group of globalI18nResourceGroups.values()) {
    notifications.push(buildGlobalI18nResourceNotification(group));
  }

  if (notifications.length > 0) {
    const dedupedNotifications = filterFrontendDedupe(mergeFrontendNotifications(notifications), snapshot);
    frontendMetrics.notifications += dedupedNotifications.length;

    await saveSnapshot(snapshot);
    for (const n of dedupedNotifications) {
      n.title = normalizeFrontendNotificationTitle(n.title, n.url);
      appendHistory("frontend", n.title, n.content.slice(0, 300), n.content);
      const diffFilePath = n.fullDiff ? saveDiffLocally(n.title, n.fullDiff) : null;
      await sendNotificationMaybeAi({ title: n.title, content: n.content, template: n.template, moduleContext: `Four.meme 前端变更 ${n.title}`, aiInput: n.aiInput, diffFilePath, url: n.url, cardOpts: n.cardOpts || {}, skipAi: n.skipAi });
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
  let apiSnapshotChanged = prunedApiKeys.length > 0;
  for (const [key, val] of Object.entries(newStruct)) {
    if (!jsonEqual(snapshot.apiStructure[key], val)) {
      snapshot.apiStructure[key] = val;
      apiSnapshotChanged = true;
    }
  }
  for (const [key, val] of Object.entries(newValues)) {
    const stableValues = stableApiValuesForSnapshot(key, val);
    if (stableValues !== null && !jsonEqual(snapshot.apiValues[key], stableValues)) {
      snapshot.apiValues[key] = stableValues;
      apiSnapshotChanged = true;
    }
  }

  if (notifications.length > 0) {
    const content = notifications.join("\n\n");
    await saveSnapshot(snapshot);
    appendHistory("api", "API 变更", content.slice(0, 300), content);
    await sendNotificationMaybeAi({ title: "API 变更", content, template: "purple", moduleContext: "Four.meme API 变更", url: CONFIG.apiBase });
  } else if (apiSnapshotChanged) {
    await saveSnapshot(snapshot);
  }
}

async function runGithubCheck() {
  if (!snapshot) snapshot = {};
  // 从快照恢复 ETag（避免重启后浪费 rate limit）
  if (!githubETag && snapshot.githubETag) githubETag = snapshot.githubETag;
  if (!githubReposETag && snapshot.githubReposETag) githubReposETag = snapshot.githubReposETag;
  let githubSnapshotDirty = false;

  const now = Date.now();
  const lastRepoPoll = Date.parse(snapshot.githubReposLastPollAt || "") || 0;
  const shouldCheckRepos = !snapshot.githubRepos || now - lastRepoPoll >= CONFIG.githubRepoListIntervalMs;
  if (shouldCheckRepos) {
    try {
      const { repoMap, changes: repoChanges } = await checkGithubRepos(
        snapshot.githubRepos || null,
        Boolean(snapshot.githubSha)
      );
      snapshot.githubReposLastPollAt = new Date(now).toISOString();
      if (githubReposETag && snapshot.githubReposETag !== githubReposETag) {
        snapshot.githubReposETag = githubReposETag;
        githubSnapshotDirty = true;
      }
      if (repoMap && !jsonEqual(snapshot.githubRepos, repoMap)) {
        snapshot.githubRepos = repoMap;
        githubSnapshotDirty = true;
      }
      if (repoChanges) {
        const count = (repoChanges.added?.length || 0) + (repoChanges.removed?.length || 0) + (repoChanges.changed?.length || 0);
        log(`[GitHub] 检测到 ${count} 项账号仓库/项目变更！`);
        const content = formatGithubRepoChanges(repoChanges);
        await saveSnapshot(snapshot);
        githubSnapshotDirty = false;
        appendHistory("github", `GitHub 项目变更（${count}项）`, content.slice(0, 300), content);
        await sendNotificationMaybeAi({ title: `GitHub 项目变更（${count}项）`, content, template: "turquoise", moduleContext: "Four.meme GitHub 项目变更", url: `https://github.com/${CONFIG.githubOwner}` });
      }
    } catch (err) {
      log(`[GitHub] 账号仓库列表检查失败，继续检查主仓库提交：${err.message}`);
    }
  }

  const { newSha, newCommits } = await checkGithub(snapshot.githubSha || "");
  // 持久化 ETag
  if (githubETag && snapshot.githubETag !== githubETag) {
    snapshot.githubETag = githubETag;
    githubSnapshotDirty = true;
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
    const title = `GitHub 新提交（${newCommits.length}个）`;
    const fullDiff = buildGithubFullDiff(newCommits);
    const diffFilePath = saveDiffLocally(title, fullDiff);
    snapshot.githubSha = newSha;
    snapshot.githubLastPollAt = new Date().toISOString();
    snapshot.githubLastCommitCount = newCommits.length;
    await saveSnapshot(snapshot);
    appendHistory("github", title, content.slice(0, 300), content);
    await sendNotificationMaybeAi({ title, content, template: "turquoise", moduleContext: "Four.meme GitHub 仓库新提交", aiInput: fullDiff, diffFilePath, url: `https://github.com/${CONFIG.githubRepo}` });
  } else {
    snapshot.githubLastPollAt = new Date().toISOString();
    if (githubSnapshotDirty) await saveSnapshot(snapshot);
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
    await sendNotificationMaybeAi({ title: `合约变更（${contractChanges.length}项）`, content, template: "red", moduleContext: "Four.meme 智能合约变更", url: CONFIG.siteUrl });
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
    await sendNotificationMaybeAi({ title: `链上参数变更（${paramChanges.length}项）`, content, template: "yellow", moduleContext: "Four.meme 链上参数变更", url: CONFIG.siteUrl });
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
  createModuleRunner("openfourTemplates", runOpenFourTemplateCheck, CONFIG.intervals.openfourTemplates),
  createModuleRunner("github",   runGithubCheck,    CONFIG.intervals.github),
  createModuleRunner("contract", runContractCheck,  CONFIG.intervals.contract),
  createModuleRunner("onchain",  runOnchainCheck,   CONFIG.intervals.onchain),
  createModuleRunner("actor",    runActorCheck,     CONFIG.actorMonitor.wsEnabled ? CONFIG.actorMonitor.httpFallbackMs : CONFIG.intervals.actor),
];
const actorRunner = modules.find(m => m.name === "actor");

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

function buildStartupProgressContent() {
  const pageCount = Object.keys(snapshot?.frontendPages || {}).length;
  return [
    `**状态:** 进程已启动，正在建立/刷新首轮基线`,
    `**前端监控:** 当前快照 ${pageCount} 个页面 — 每 ${CONFIG.intervals.frontend / 1000}s`,
    `**API监控:** 每 ${CONFIG.intervals.api / 1000}s`,
    `**提示:** 首轮检查完成后会更新本卡片为已启动状态`,
  ].join("\n");
}

function buildStartupReadyContent() {
  const poolCount = buildPoolMap(snapshot?.poolConfig).size;
  const pageCount = Object.keys(snapshot?.frontendPages || {}).length;
  const entryPageCount = CONFIG.monitorUrls.length;
  const contractCount = Object.keys(snapshot?.contractFingerprints || {}).length;
  const githubRepoCount = Object.keys(snapshot?.githubRepos || {}).length;
  const openFourTemplateCount = Object.keys(snapshot?.openFourTemplates || {}).length;
  const openFourModuleCount = Object.keys(snapshot?.openFourModules?.byAddress || {}).length;
  const actorCount = snapshot?.chainActorMonitor?.actionActorCount
    ?? Object.values(snapshot?.chainActorMonitor?.actors || {}).filter(actor => actor.actionWatched).length;
  return [
    `**状态:** 首轮基线检查完成，定时器已启动`,
    `**架构:** 独立定时器 + RPC Batch + 并行抓取`,
    `**底池监控:** BSC ${poolCount} 个 — 每 ${CONFIG.intervals.pool / 1000}s`,
    `**前端监控:** ${pageCount} 个页面（固定入口 ${entryPageCount}，路由发现页面纳入同一监控池）— 每 ${CONFIG.intervals.frontend / 1000}s`,
    `  含 __NEXT_DATA__ / i18n / 路由与端点发现 / 新页面同层纳入`,
    `  HTML 并发 ${readPositiveIntEnv("FOURMEME_FRONTEND_HTML_CONCURRENCY", 6)} / 资源并发 ${readPositiveIntEnv("FOURMEME_FRONTEND_ASSET_CONCURRENCY", 6)} / 资源小抖动 ${CONFIG.frontendAssetJitter.quickConfirmDelayMs}ms 快速复抓确认`,
    `  ${getFrontendMonitorUrls().map(u => "- " + u).join("\n  ")}`,
    `**API监控:** ${Object.keys(snapshot?.apiStructure || {}).length} 个端点（结构+值） — 每 ${CONFIG.intervals.api / 1000}s`,
    `**OpenFour模板:** ${openFourTemplateCount} 个业务模板（新增/状态变化）— 每 ${CONFIG.intervals.openfourTemplates / 1000}s`,
    `**OpenFour模块:** ${openFourModuleCount} 个实现地址 — Registry logs ${CONFIG.openFourRegistryLogMonitor.enabled ? "实时触发" : "关闭"}`,
    `**GitHub:** ${CONFIG.githubOwner} 账号 ${githubRepoCount} 个仓库，主仓库 ${CONFIG.githubRepo} (${(snapshot?.githubSha || "").slice(0, 8) || "未知"}) — 每 ${CONFIG.intervals.github / 1000}s`,
    `**合约监控:** ${contractCount} 个 — 每 ${CONFIG.intervals.contract / 1000}s（RPC 批量 + OpenFour 链上发现）`,
    `**链上参数:** AgentNFT ${snapshot?.onchainParams?.agentNftCount ?? "未知"} 个 — 每 ${CONFIG.intervals.onchain / 1000}s（RPC 批量）`,
    `**创建者动作:** ${actorCount} 个地址 — WebSocket 新区块驱动 + 每 ${actorRunner?.intervalMs / 1000}s HTTP 兜底（只过滤交易发起地址 tx.from，命中后合约复查）`,
    `**反风控:** UA轮换 + 按域名自适应退避 + 请求抖动`,
    `**心跳:** ${CONFIG.heartbeatEnabled ? `每 ${Math.round(CONFIG.heartbeatMs / 60000)} 分钟（低优先级，队列空闲时推送）` : "关闭"} | **日报:** ${CONFIG.dailyReport.enabled ? `开启（每日 ${CONFIG.dailyReport.hour}:00）` : "关闭"}`,
  ].join("\n");
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

  const startupMessageId = await sendStartupCard(
    "Four.meme 全面监控 v2 启动中",
    buildStartupProgressContent(),
    "blue"
  );

  // 首次启动：所有模块依次执行一次（建立基线）
  for (const m of modules) {
    await m.run();
    await sleep(500); // 各模块间隔 500ms，避免同时大量请求
  }
  if (CONFIG.openFourRegistryLogMonitor.enabled) {
    try {
      await runOpenFourModuleDiscoveryCheck({ reason: "startup" });
    } catch (err) {
      log(`[OpenFour模块] 启动基线建立失败：${err.message}`);
    }
  }

  const startupReadyContent = buildStartupReadyContent();
  const startupPatched = await patchStartupCard(
    startupMessageId,
    "Four.meme 全面监控 v2 已启动",
    startupReadyContent,
    "green"
  );
  if (!startupPatched) {
    await sendStartupCard("Four.meme 全面监控 v2 已启动", startupReadyContent, "green");
  }

  // WebSocket 新区块订阅只负责触发创建者动作检测；HTTP 定时器继续作为断线/漏事件兜底。
  if (actorRunner && CONFIG.actorMonitor.enabled) {
    global.__actorBlockFeed = startActorBlockFeed(actorRunner);
  }
  if (CONFIG.openFourRegistryLogMonitor.enabled) {
    global.__openFourRegistryLogFeed = startOpenFourRegistryLogFeed();
  }

  // 启动各模块独立定时器（递归 setTimeout 实现 per-tick 抖动）
  const moduleTimers = []; // 存储定时器 ID，供优雅退出时清理
  for (const m of modules) {
    const initialDelay = Math.random() * Math.min(m.intervalMs, 2_000);
    let nextDueAt = Date.now() + m.intervalMs + initialDelay;
    function upsertModuleTimer(timerId) {
      const idx = moduleTimers.findIndex(t => t.name === m.name);
      if (idx >= 0) moduleTimers[idx].timerId = timerId;
      else moduleTimers.push({ name: m.name, timerId });
    }
    function scheduleModule(delayMs = 0) {
      const timerId = setTimeout(async () => {
        await m.run();
        nextDueAt += m.intervalMs;
        if (nextDueAt <= Date.now()) nextDueAt = Date.now();
        const jitter = CONFIG.jitterMs > 0 ? Math.random() * CONFIG.jitterMs : 0;
        scheduleModule(Math.max(0, nextDueAt - Date.now()) + jitter);
      }, delayMs);
      upsertModuleTimer(timerId);
    }
    // 初始延迟的 timer 也要跟踪，防止退出时遗漏
    scheduleModule(m.intervalMs + initialDelay);
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
        `前端页面池：**${Object.keys(snapshot?.frontendPages || {}).length}** 个，待确认新路由 **${Object.values(snapshot?._frontendPendingRoutes || {}).filter(r => r?.status === "pending").length}** 个，最近一轮成功 ${frontendMetrics.success} / 失败 ${frontendMetrics.failed}，累计推送 ${frontendMetrics.notifications}，抑制 ${frontendMetrics.suppressed}`,
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

if (!IS_TEST_MODE) {
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

  startAllModules().catch(err => {
    log(`启动异常：${err.message}`);
    log(`[启动异常详情]\n${err?.stack || err}`);
    process.exit(1);
  });
}

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
  if (global.__actorBlockFeed) {
    clearInterval(global.__actorBlockFeed.healthTimer);
    global.__actorBlockFeed.stop();
    log("已停止创建者 WebSocket 新区块订阅");
  }
  if (global.__openFourRegistryLogFeed) {
    clearInterval(global.__openFourRegistryLogFeed.healthTimer);
    global.__openFourRegistryLogFeed.stop();
    log("已停止 OpenFourRegistry WebSocket 日志订阅");
  }
  // 等待消息队列排空（最多等 30s）
  await waitQueueDrain(30_000);
  // 保存最终快照
  try { await saveSnapshot(snapshot); } catch {}
  process.exit(0);
}
if (!IS_TEST_MODE) {
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
}

function setSnapshotForTests(value) {
  if (!IS_TEST_MODE) return snapshot;
  snapshot = migrateSnapshot(value || {});
  return snapshot;
}

export const __testables = {
  CONFIG,
  urlToKey,
  canonicalFrontendUrl,
  getFrontendMonitorUrls,
  isConfiguredFrontendUrl,
  isDiscoverableFrontendUrl,
  isSuppressedDiscoveredFrontendUrl,
  recordFailedDiscoveredFrontendUrls,
  getFrontendRouteDecision,
  setSnapshotForTests,
  discoverFrontendUrlsFromPages,
  extractTextContent,
  extractHrefRoutesFromHtml,
  extractNextData,
  stableJsonHash,
  extractI18nFromStreamingHtml,
  shouldLogI18nExtraction,
  extractRouteSignals,
  diffI18nStrings,
  partitionI18nChangesByPageVisibility,
  i18nChangeSignature,
  i18nChangeTypeCounts,
  shouldConfirmI18nRemoval,
  frontendNotificationDedupeKey,
  shouldUseAiForNotification,
  buildFrontendFailureNotifications,
  buildFrontendNewPageNotification,
  buildFrontendRouteActionButtons,
  buildFrontendNewPageAiInput,
  formatI18nChangesForFullDiff,
  buildFullDiffText,
  hasMeaningfulFrontendDiffBody,
  diffRoutes,
  frontendAssetChangeSignature,
  classifyFetchFailure,
  buildStartupProgressContent,
  buildStartupReadyContent,
};

if (!IS_TEST_MODE) {
  process.on("unhandledRejection", (err) => {
    log(`[未捕获异常] ${err?.message || err}`);
  });
}
