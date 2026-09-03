/**
 * Flap.sh 页面监控脚本 v2 — 高频并行版
 *
 * 优化要点：
 *   1. 页面并行抓取（加错开延迟避免风控）
 *   2. i18n chunk 并行下载
 *   3. UA 轮换 + 按页面/资源路径自适应退避
 *   4. 独立模块定时器
 *
 * 用法：
 *   node monitor.mjs          持续监控（守护进程模式）
 *   node monitor.mjs check    手动触发一次检测
 *
 * 信号：
 *   SIGUSR1  立即触发一次检测
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, readdirSync, unlinkSync, statSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { sendCard, sendCardQueued, patchCard, waitQueueDrain } from "../shared/feishu-client.mjs";
import {
  BNB_QUOTE_TOKEN,
  FACTORY_POOL_STATE_EVENT_TOPICS,
  FLAP_FACTORY_PROXY,
  classifyFactoryPoolChange,
  createFactoryPoolState,
  createFactoryPoolWsHealth,
  loadFactoryPoolState,
  factoryPoolEventKey,
  ingestFactoryPoolEvent,
  mergePendingFactoryPoolChanges,
  runFactoryPoolScan,
  saveFactoryPoolState,
} from "./factory-pool-monitor.mjs";
import {
  CONTRACT_INTEGRITY_FACTORY_EVENT_TOPICS,
  acknowledgeContractIntegrityChanges,
  buildContractIntegrityContent,
  contractIntegritySubscriptionAddresses,
  ingestContractIntegrityEvent,
  loadContractIntegrityState,
  runContractIntegrityStateScan,
  saveContractIntegrityState,
  scanContractIntegrityEvents,
  syncContractIntegrityCatalog,
} from "./contract-integrity-monitor.mjs";
import {
  DEFAULT_FLAP_ADMIN_SAFES,
  acknowledgeSafeProposalChanges,
  buildSafeProposalContent,
  createSafeProposalState,
  loadSafeProposalState,
  runSafeProposalScan,
  saveSafeProposalState,
} from "./safe-proposal-monitor.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const IS_TEST_MODE = process.env.FLAP_MONITOR_TEST === "1";

// 加载 .env 文件（共享配置 + 本地配置）
for (const envPath of [join(__dirname, "..", ".env"), join(__dirname, ".env")]) {
  if (existsSync(envPath)) {
    try {
      for (const line of readFileSync(envPath, "utf-8").split("\n")) {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    } catch {}
  }
}

function readPositiveIntEnv(name, fallback, min = 1) {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(value) && value >= min ? value : fallback;
}

/* ── 配置 ── */
const CONFIG = {
  urls: [
    "https://flap.sh/bnb/CAstore",
    "https://flap.sh/robinhood/CAstore?lang=zh",
    "https://flap.sh/launch",
    "https://flap.sh/create",
  ],
  // 飞书 API（用于发送 diff 文件附件）
  feishuAppId: process.env.FEISHU_APP_ID || "",
  feishuAppSecret: process.env.FEISHU_APP_SECRET || "",
  feishuChatId: process.env.FEISHU_CHAT_ID || "",
  feishuMentionOpenId: String(process.env.FEISHU_MENTION_OPEN_ID || "").trim(),

  // 轮询间隔（毫秒）
  pollIntervalMs: readPositiveIntEnv("FLAP_POLL_INTERVAL_MS", 1_000, 500),

  fetchTimeoutMs: 8_000,
  failThreshold: 3,
  snapshotFile: join(__dirname, "snapshot.json"),
  snapshotDir: join(__dirname, "snapshots"),
  pageQuality: {
    minHtmlLength: 1_000,
    minTextLength: 20,
    minAssetFiles: 2,
  },
  assetStringLimit: 300,
  bscRpcUrls: [...new Set((process.env.FLAP_BSC_RPC_URLS || process.env.BSC_RPC_URLS || "https://rpc.48.club,https://bsc.rpc.blxrbdn.com,https://bsc.publicnode.com,https://bsc-dataseed.binance.org/")
    .split(",").map(s => s.trim()).filter(Boolean)
    .concat(process.env.FLAP_FACTORY_ARCHIVE_RPC_URL || "https://bsc-mainnet.public.blastapi.io"))],
  registryMonitor: {
    enabled: process.env.FLAP_REGISTRY_MONITOR !== "false",
    address: (process.env.FLAP_REGISTRY_ADDRESS || "0x90497450f2a706f1951b5bdda52b4e5d16f34c06").toLowerCase(),
    confirmations: Number.parseInt(process.env.FLAP_REGISTRY_CONFIRMATIONS || "5", 10),
    bootstrapLookbackBlocks: Number.parseInt(process.env.FLAP_REGISTRY_BOOTSTRAP_LOOKBACK_BLOCKS || "20", 10),
    maxBlocksPerRun: Number.parseInt(process.env.FLAP_REGISTRY_MAX_BLOCKS_PER_RUN || "3000", 10),
    watchedEventTopics: new Set([
      "0xd8cf270eb9827992a063745f0afaa72431f8c63fc46736f8b484862dcc709787",
      "0x566b7414cab715cde3c8bcc93daec35325367d6c648327d19a1867d1006af3b3",
    ]),
  },
  factoryPoolMonitor: {
    enabled: process.env.FLAP_FACTORY_POOL_MONITOR !== "false",
    proxy: (process.env.FLAP_FACTORY_PROXY || FLAP_FACTORY_PROXY).toLowerCase(),
    stateFile: join(__dirname, "factory-pool-state.json"),
    intervalMs: readPositiveIntEnv("FLAP_FACTORY_POOL_INTERVAL_MS", 1_000, 500),
    catchupIntervalMs: readPositiveIntEnv("FLAP_FACTORY_CATCHUP_INTERVAL_MS", 1_000, 500),
    confirmations: 0,
    deploymentBlock: Number.parseInt(process.env.FLAP_FACTORY_DEPLOYMENT_BLOCK || "0", 10),
    realtimeBootstrapBlocks: readPositiveIntEnv("FLAP_FACTORY_REALTIME_BOOTSTRAP_BLOCKS", 20, 1),
    realtimeMaxBlocksPerRun: readPositiveIntEnv("FLAP_FACTORY_REALTIME_MAX_BLOCKS", 20, 1),
    catchupMaxBlocksPerRun: readPositiveIntEnv("FLAP_FACTORY_CATCHUP_MAX_BLOCKS", 2_000, 1),
    assetRefreshPerRun: readPositiveIntEnv("FLAP_FACTORY_ASSET_REFRESH_PER_RUN", 10, 1),
    tokenMetadataApiUrl: process.env.FLAP_FACTORY_TOKEN_METADATA_API_URL || "https://api.gopluslabs.io/api/v1/token_security/56",
    tokenMetadataTimeoutMs: readPositiveIntEnv("FLAP_FACTORY_TOKEN_METADATA_TIMEOUT_MS", 800, 300),
    tokenMetadataRetryMs: readPositiveIntEnv("FLAP_FACTORY_TOKEN_METADATA_RETRY_MS", 300_000, 10_000),
    rpcTimeoutMs: readPositiveIntEnv("FLAP_FACTORY_RPC_TIMEOUT_MS", 2_000, 500),
    rpcCatchupTimeoutMs: readPositiveIntEnv("FLAP_FACTORY_RPC_CATCHUP_TIMEOUT_MS", 8_000, 1_000),
    rpcHedgeDelayMs: readPositiveIntEnv("FLAP_FACTORY_RPC_HEDGE_DELAY_MS", 120, 50),
    wsEnabled: process.env.FLAP_FACTORY_WS_ENABLED !== "false",
    wsUrls: [...new Set((process.env.FLAP_FACTORY_WS_URLS || "wss://bsc-rpc.publicnode.com,wss://bsc.publicnode.com")
      .split(",").map(value => value.trim()).filter(Boolean))],
    wsBackfillBlocks: Math.min(20_000, readPositiveIntEnv("FLAP_FACTORY_WS_BACKFILL_BLOCKS", 10_000, 5_000)),
    wsBackfillChunkBlocks: Math.min(5_000, readPositiveIntEnv("FLAP_FACTORY_WS_BACKFILL_CHUNK_BLOCKS", 2_000, 100)),
  },
  contractIntegrityMonitor: {
    enabled: process.env.FLAP_CONTRACT_INTEGRITY_MONITOR !== "false",
    stateFile: join(__dirname, "contract-integrity-state.json"),
    coreIntervalMs: readPositiveIntEnv("FLAP_CONTRACT_CORE_INTERVAL_MS", 10_000, 5_000),
    extendedIntervalMs: readPositiveIntEnv("FLAP_CONTRACT_EXTENDED_INTERVAL_MS", 60_000, 30_000),
    codeAuditIntervalMs: readPositiveIntEnv("FLAP_CONTRACT_CODE_AUDIT_INTERVAL_MS", 600_000, 60_000),
    eventMaxBlocksPerRun: readPositiveIntEnv("FLAP_CONTRACT_EVENT_MAX_BLOCKS", 2_000, 100),
    trackedAssetLimit: readPositiveIntEnv("FLAP_CONTRACT_TRACKED_ASSETS_PER_RUN", 20, 1),
    wsEnabled: process.env.FLAP_CONTRACT_WS_ENABLED !== "false",
    wsUrls: [...new Set((process.env.FLAP_CONTRACT_WS_URLS || process.env.FLAP_FACTORY_WS_URLS || "wss://bsc-rpc.publicnode.com,wss://bsc.publicnode.com")
      .split(",").map(value => value.trim()).filter(Boolean))],
  },
  safeProposalMonitor: {
    enabled: process.env.FLAP_SAFE_PROPOSAL_MONITOR !== "false",
    stateFile: join(__dirname, "safe-proposal-state.json"),
    intervalMs: readPositiveIntEnv("FLAP_SAFE_PROPOSAL_INTERVAL_MS", 120_000, 30_000),
    activeIntervalMs: readPositiveIntEnv("FLAP_SAFE_PROPOSAL_ACTIVE_INTERVAL_MS", 30_000, 10_000),
    requestTimeoutMs: readPositiveIntEnv("FLAP_SAFE_PROPOSAL_TIMEOUT_MS", 5_000, 500),
    apiBaseUrl: process.env.FLAP_SAFE_API_BASE_URL || "https://api.safe.global/tx-service/bnb/api/v1",
    apiKey: String(process.env.FLAP_SAFE_API_KEY || "").trim(),
    safes: [...new Set((process.env.FLAP_ADMIN_SAFE_ADDRESSES || DEFAULT_FLAP_ADMIN_SAFES.join(","))
      .split(",").map(value => value.trim()).filter(value => /^0x[a-fA-F0-9]{40}$/.test(value)))],
  },

  // 反风控
  jitterMs: 500,
  backoff: { initialMs: 30_000, maxMs: 300_000, decayFactor: 0.5 },
};

/* ══════════════════════════════════════════
   业务关键词 & 噪音过滤
   ══════════════════════════════════════════ */

/**
 * 高优先级业务关键词 — 命中时通知升级为重点告警
 * 每个条目: { pattern: RegExp, label: string }
 */
const BUSINESS_KEYWORDS = [
  { pattern: /金库|金庫/i,         label: "金库" },
  { pattern: /Vault/i,            label: "Vault" },
  { pattern: /Dividend/i,         label: "Dividend(分红)" },
  { pattern: /DividendBps/i,      label: "DividendBps" },
  { pattern: /constraints/i,      label: "Constraints(约束)" },
  { pattern: /enabled\s*[:=]/i,   label: "Enabled(开关)" },
  { pattern: /showInCAStore/i,    label: "CAStore展示" },
  { pattern: /quickAmounts/i,     label: "QuickAmounts" },
  { pattern: /usePermit/i,        label: "UsePermit" },
  { pattern: /fee[sS]?[\s:=]/i,  label: "Fee(费率)" },
  { pattern: /Staking/i,          label: "Staking" },
  { pattern: /Lista/i,            label: "Lista" },
];

/**
 * 构建噪音模式 — 匹配的字符串变更视为噪音
 */
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
];

/**
 * 判断一条字符串变更是否为构建噪音
 */
function isNoiseString(s) {
  return NOISE_PATTERNS.some(p => p.test(s));
}

function isSvgPathLikeString(value) {
  const s = String(value || "").trim();
  if (!s || !/^[Mm][\d\s.,+\-A-Za-z]+$/.test(s)) return false;
  const nonPathLetters = s.replace(/[MmLlHhVvCcSsQqTtAaZz]/g, "").match(/[A-Za-z]/);
  if (nonPathLetters) return false;
  const commandCount = (s.match(/[MmLlHhVvCcSsQqTtAaZz]/g) || []).length;
  const numberCount = (s.match(/-?\d+(?:\.\d+)?/g) || []).length;
  return commandCount >= 1 && numberCount >= 2;
}

function isTailwindUtilityToken(token) {
  let t = String(token || "").trim();
  if (!t) return false;
  t = t.replace(/^!/, "");
  if (/^\[[^\]]+\]$/.test(t)) return true;
  t = t.replace(/^(?:(?:[a-z0-9-]+(?:\/[a-z0-9_-]+)?|\[[^\]]+\]):)+/i, "").replace(/^!/, "");
  if (/^\[[^\]]+\]$/.test(t)) return true;
  if (/^lucide(?:-[\w-]+)?$/i.test(t)) return true;
  return /^-?(?:absolute|relative|fixed|sticky|inset|top|right|bottom|left|z|m|mx|my|mt|mr|mb|ml|p|px|py|pt|pr|pb|pl|w|h|min|max|size|flex|grid|block|inline|hidden|visible|invisible|items|justify|gap|space|shrink|grow|basis|rounded|border|bg|text|font|leading|tracking|opacity|shadow|ring|outline|focus|hover|active|disabled|transition|duration|ease|object|overflow|translate|rotate|scale|clip|cursor|pointer|select|container|aspect|origin|transform|backdrop|fill|stroke|sr-only|file|placeholder|peer|group|mask|notranslate|lucide|ui20)(?:[-:/\[\]#%.!_a-zA-Z0-9]+)?$/.test(t);
}

function isTailwindClassLikeString(value) {
  const s = String(value || "").trim();
  if (!s || s.length < 8) return false;
  const tokens = s.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return false;
  const classLike = tokens.filter(isTailwindUtilityToken).length;
  return classLike / tokens.length >= 0.75;
}

function isCssUtilityFragment(value) {
  const s = String(value || "").trim();
  if (!s) return false;
  return /(?:^|\s)(?:hover|focus|focus-visible|focus-within|active|disabled|peer-disabled|group-hover(?:\/[\w-]+)?|group-focus(?:-visible|-within)?(?:\/[\w-]+)?|group-focus-within(?:\/[\w-]+)?|aria-\w+|data-\[[^\]]+\]|sm|md|lg|xl|2xl|min-\[[^\]]+\]|max-\[[^\]]+\]):[^\s]+/.test(s)
    || /\[[^\]]*(?:--|data-|mask|clip-path|&_|webkit)[^\]]*\]/.test(s)
    || /\b(?:lucide|clip-path|object-cover|ring-offset|pointer-events|cursor-not-allowed|rounded-full|translate-x|opacity-\d+|border-\[|bg-\[|text-\[)\b/.test(s);
}

function codeSyntaxRatio(value) {
  const s = String(value || "");
  if (!s) return 0;
  const syntaxChars = (s.match(/[{}()[\]=>;?:,&|!]/g) || []).length;
  return syntaxChars / s.length;
}

function isMinifiedCodeFragment(value) {
  const s = String(value || "").trim();
  if (!s || s.length < 8) return false;
  if (isSvgPathLikeString(s) || isTailwindClassLikeString(s) || isCssUtilityFragment(s)) return false;

  const syntaxRatio = codeSyntaxRatio(s);
  const startsLikeCode = /^[),;:\]}]/.test(s);
  const endsLikeOpenCode = /[({[:,]$/.test(s);
  const compactMemberAccess = /(?:^|[^A-Za-z])[$A-Za-z_]\w*\.[A-Za-z_$]\w*/.test(s);
  const compactKeyValue = /(?:^|[,{])[$A-Za-z_]\w{2,}\s*:\s*(?:[$A-Za-z_]\w*|!?[01]|\{|\[|\()/g;
  const keyValueCount = (s.match(compactKeyValue) || []).length;
  const codePatternHits = [
    /\b(?:function|return|throw|async|await|let|const|var)\b/.test(s) && /[{}();=>]/.test(s),
    /=>|!==|===|&&|\|\||\?\?|\.\.\./.test(s),
    /\b(?:jsx|jsxs|children|className|props|prototype|Symbol|Object\.assign|filter\(Boolean\)|toLowerCase)\b/.test(s),
    /\b(?:nonceManager|authorizationList|accessList|maxFeePerGas|maxPriorityFeePerGas|factoryData|generateAbstractMask)\b/.test(s),
    /(?:^|[,(])0,[A-Za-z_$]\w*|[A-Za-z_$]\w*\([^)]*\)\s*=>/.test(s),
    keyValueCount >= 2,
    compactMemberAccess && /[{}()[\];,:]/.test(s),
  ].filter(Boolean).length;

  if (codePatternHits >= 2) return true;
  if (codePatternHits >= 1 && syntaxRatio > 0.045) return true;
  if ((startsLikeCode || endsLikeOpenCode) && syntaxRatio > 0.08) return true;
  if (!/\s/.test(s) && s.length > 24 && syntaxRatio > 0.08 && /[{}()[\];,:]|[$A-Za-z_]\w*\./.test(s)) return true;
  if (syntaxRatio > 0.18 && /[{}()[\]=>;]/.test(s)) return true;
  return false;
}

function isReadableBusinessText(value) {
  const s = String(value || "").trim();
  if (!s || s.length < 4) return false;
  if (isSvgPathLikeString(s) || isTailwindClassLikeString(s) || isCssUtilityFragment(s) || isMinifiedCodeFragment(s)) return false;
  if (codeSyntaxRatio(s) > 0.12 && /[{}()[\]=>;]/.test(s)) return false;
  if (/[\u4e00-\u9fff]/.test(s)) return true;
  const words = s.split(/\s+/).filter(w => /[a-zA-Z]{2,}/.test(w));
  if (/[{}()=>;]/.test(s) || /^[a-z]\.\w/.test(s)) return false;
  if (BUSINESS_STRING_RE.test(s)) {
    if (words.length >= 2 && /\s/.test(s)) return true;
    return false;
  }
  if (words.length < 3) return false;
  const utilityWords = words.filter(w => /^(absolute|relative|bottom|left|right|top|rounded|border|object|hover|focus|disabled|opacity|ring|transition|translate|pointer|events|background|foreground)$/i.test(w)).length;
  if (utilityWords / words.length > 0.4) return false;
  return true;
}

function isAssetStringDiffNoise(value) {
  return isNoiseString(value)
    || isMinifiedCodeFragment(value)
    || isSvgPathLikeString(value)
    || isTailwindClassLikeString(value)
    || isCssUtilityFragment(value);
}

const UI_STYLE_CATEGORY_META = {
  icon: {
    label: "图标/矢量",
    intent: "更新图标或矢量绘制资源",
    evidence: "SVG path",
  },
  disabled: {
    label: "禁用态交互",
    intent: "调整禁用状态下的点击或交互反馈",
    evidence: "disabled / pointer-events",
  },
  interaction: {
    label: "交互反馈",
    intent: "调整 hover/focus/active 或过渡反馈",
    evidence: "hover / focus / transition / ring",
  },
  layout: {
    label: "布局定位",
    intent: "调整组件位置、对齐或层级",
    evidence: "absolute / top / right / bottom / translate",
  },
  visual: {
    label: "视觉样式",
    intent: "调整圆角、边框、透明度、背景或图片裁切",
    evidence: "rounded / border / opacity / bg / object",
  },
  responsive: {
    label: "响应式布局",
    intent: "调整不同屏幕尺寸下的布局或显示规则",
    evidence: "sm / md / min-[...] / max-[...]",
  },
  component: {
    label: "组件样式变量",
    intent: "调整组件内部选择器、遮罩或主题变量",
    evidence: "arbitrary selector / CSS variable / mask",
  },
  utility: {
    label: "样式工具类",
    intent: "调整 CSS utility 样式组合",
    evidence: "CSS utility",
  },
};

const FACTORY_BACKGROUND_TASK_ORDER = Object.freeze(["catchup", "assets"]);

const ROBINHOOD_INDEX_VAULT_FACTORY = "0xe6ca297D1d963b6F00d5b216986123CAeB883AF6";

function classifyUiStyleString(value) {
  const s = String(value || "").trim();
  if (!s) return [];
  const categories = new Set();
  const lower = s.toLowerCase();

  if (isSvgPathLikeString(s) || /\blucide(?:\s|[-_])/.test(lower)) categories.add("icon");
  if (/(?:^|\s)(?:disabled|peer-disabled):/.test(s) || /pointer-events|cursor-not-allowed/.test(lower)) categories.add("disabled");
  if (/(?:^|\s)(?:hover|focus|focus-visible|focus-within|active|group-hover(?:\/[\w-]+)?|group-focus(?:-visible|-within)?(?:\/[\w-]+)?|group-focus-within(?:\/[\w-]+)?|peer-disabled|aria-\w+|data-\[[^\]]+\]):/.test(s)
    || /\b(?:transition|duration|ease|ring|outline|opacity-\d+)\b/.test(lower)) {
    categories.add("interaction");
  }
  if (/(?:^|\s)(?:sm|md|lg|xl|2xl|min-\[[^\]]+\]|max-\[[^\]]+\]):/.test(s)) categories.add("responsive");
  if (/\[[^\]]*(?:--|data-|mask|clip-path|&_|webkit)[^\]]*\]|ui20-/.test(s)) categories.add("component");
  if (/\b(?:absolute|relative|fixed|sticky|inset|top|right|bottom|left|z-|translate|rotate|scale|origin|transform)\b/.test(lower)) {
    categories.add("layout");
  }
  if (/\b(?:rounded|border|bg-|text-|shadow|opacity|object-|clip-path|fill-|stroke-|backdrop)\b/.test(lower)) {
    categories.add("visual");
  }
  if (categories.size === 0 && (isTailwindClassLikeString(s) || isCssUtilityFragment(s))) categories.add("utility");

  return [...categories].map(category => ({
    category,
    label: UI_STYLE_CATEGORY_META[category]?.label || "样式信号",
    intent: UI_STYLE_CATEGORY_META[category]?.intent || "调整前端样式",
    evidence: UI_STYLE_CATEGORY_META[category]?.evidence || "CSS utility",
  }));
}

function inferUiComponentContext(value, file = "", assetPath = "") {
  const text = `${value || ""} ${file || ""} ${assetPath || ""}`;
  const lower = text.toLowerCase();
  const route = getPageRouteFromAssetPath(assetPath || file);

  if (/castore|vault|gift|reserve|staking|lista|stock|burn|buyback|snow|lucky|buffet|flapixel/.test(lower) || route === "CAstore") {
    return { key: "castore-vault-card", label: "CAstore 金库卡片/模板列表", confidence: route === "CAstore" ? "高" : "中" };
  }
  if (/group\/nav-dropdown|nav-dropdown|group-hover\/item|group-focus-visible\/item|border-b border-\[#303236\]|\/bnb\/board|docs\.flap|token-social|lucide-arrow-up-right/.test(lower)) {
    return { key: "navigation-menu", label: "顶部导航/下拉菜单", confidence: "高" };
  }
  if (/connect|wallet|ui20-connect|chamfer|连接钱包|connect wallet/.test(lower)) {
    return { key: "wallet-connect", label: "钱包连接控件", confidence: "高" };
  }
  if (/lucide-search|搜索|search/.test(lower)) {
    return { key: "search-control", label: "搜索控件", confidence: "高" };
  }
  if (/lucide-globe|language|语言|zh|locale/.test(lower)) {
    return { key: "language-control", label: "语言选择控件", confidence: "高" };
  }
  if (/\bbsc\b|chain|network|區塊鏈|区块链|chevron-down/.test(lower)) {
    return { key: "network-selector", label: "链/网络选择控件", confidence: "中" };
  }
  if (/peer-disabled|placeholder|file:border|file:bg|border-input|ring-offset-background|input|textarea|select|form|label|radix-select|token|代幣|税收|稅收/.test(lower) || route === "launch" || route === "create") {
    return { key: "token-form", label: "代币创建表单控件", confidence: route === "launch" || route === "create" ? "高" : "中" };
  }
  if (/lucide-menu|lucide-x|max-\[\d+px\]|min-\[\d+px\]|mobile|drawer|sheet|translate-x-full/.test(lower)) {
    return { key: "mobile-navigation", label: "移动端导航/响应式布局", confidence: "中" };
  }
  if (/radix|data-radix|scroll-area|dialog|popover|dropdown|modal|absolute right-4 top-4/.test(lower)) {
    return { key: "overlay-popover", label: "弹窗/下拉层/滚动区", confidence: "中" };
  }
  if (/lucide|svg|path|mask|icon/.test(lower) || isSvgPathLikeString(value)) {
    return { key: "iconography", label: "图标资源", confidence: "中" };
  }
  return { key: "unknown", label: "未定位具体组件", confidence: "低" };
}

function collectUiStyleDiffsFromStrings(strings = [], type, file, assetPath) {
  const out = [];
  for (const value of strings || []) {
    const classified = classifyUiStyleString(value);
    const context = inferUiComponentContext(value, file, assetPath);
    for (const item of classified) {
      out.push({ type, ...item, contextKey: context.key, contextLabel: context.label, contextConfidence: context.confidence, file, assetPath });
    }
  }
  return out;
}

const CODE_INTENT_RULES = [
  {
    key: "tax",
    label: "税费/税务信息",
    intent: "可能调整税费读取、税务信息展示或索引期查看逻辑",
    evidence: /showTaxInfo|taxInfo|buyTaxBps|sellTaxBps|\btax\b/i,
    evidenceLabel: "showTaxInfo / taxInfo / tax",
  },
  {
    key: "vault",
    label: "Vault/金库判定",
    intent: "可能调整 Vault、vaultFactory 判定、链接生成或展示映射逻辑",
    evidence: /vaultFactory|\bvault\b|Vault/i,
    evidenceLabel: "vault / vaultFactory",
  },
  {
    key: "dividend",
    label: "分红参数",
    intent: "可能调整 dividendBps、分红徽标或分红展示逻辑",
    evidence: /dividendBps|dividendBadge|Dividend/i,
    evidenceLabel: "dividendBps / dividendBadge",
  },
  {
    key: "transaction",
    label: "交易参数",
    intent: "可能调整账户、gas、nonce 或链上交易参数组装逻辑",
    evidence: /nonceManager|authorizationList|accessList|maxFeePerGas|maxPriorityFeePerGas|maxFeePerBlobGas|gasPrice|account/i,
    evidenceLabel: "nonce / gas / account",
  },
  {
    key: "sanitizer",
    label: "安全/富文本白名单",
    intent: "可能调整 HTML、ARIA、Data 属性或安全模板过滤策略",
    evidence: /USE_PROFILES|ALLOW_ARIA_ATTR|ALLOW_DATA_ATTR|ALLOW_UNKNOWN_PROTOCOLS|ALLOW_SELF_CLOSE_IN_ATTR|SAFE_FOR_TEMPLATES|WHOLE_DOCUMENT/i,
    evidenceLabel: "ALLOW_* / SAFE_FOR_TEMPLATES",
  },
  {
    key: "factory",
    label: "工厂/部署调用",
    intent: "可能调整 factoryData、deployless 或工厂调用相关实现",
    evidence: /factoryData|deployless|\bfactory\b/i,
    evidenceLabel: "factory / factoryData / deployless",
  },
];

function collectCodeIntentDiffsFromStrings(strings = [], type, file, assetPath) {
  const out = [];
  for (const value of strings || []) {
    const s = String(value || "");
    if (!s || isReadableBusinessText(s)) continue;
    if (!isMinifiedCodeFragment(s)) continue;
    for (const rule of CODE_INTENT_RULES) {
      if (!rule.evidence.test(s)) continue;
      out.push({
        type,
        key: rule.key,
        label: rule.label,
        intent: rule.intent,
        evidence: rule.evidenceLabel,
        file,
        assetPath,
      });
    }
  }
  return out;
}

const BUSINESS_STRING_RE = /[\u4e00-\u9fff]|Vault|金库|金庫|CAstore|CA Store|fee|rate|tax|税|稅|dividend|staking|质押|質押|燃烧|燃燒|回购|回購|factory|template/i;

function isBusinessAssetString(s) {
  return BUSINESS_STRING_RE.test(String(s || ""));
}

/**
 * 从字符串 diff 列表中提取业务配置变更
 * 只提取包含业务关键词的配置字段，忽略单字母变量和框架内部属性
 */
const CONFIG_BUSINESS_KEYS = new Set([
  "enabled", "showInCAStore", "constraints", "minDividendBps", "maxDividendBps",
  "dividendBps", "buyFee", "sellFee", "fee", "feeRate", "feeBps",
  "quickAmounts", "usePermit", "supportSubscription", "supportSub",
  "networkCode", "chainId", "rpcUrl", "contractAddress",
  "Vault", "vault", "staking", "lista", "Lista",
  "descriptionI18nKey", "nameI18nKey", "status", "symbol",
  "b0Amount", "totalBAmount", "totalAmount", "minAmount", "maxAmount",
]);

// 排除的框架噪音 key（单字母、React/Next 内部）
const CONFIG_NOISE_KEYS = /^([a-z]|[A-Z]{1,2}|prototype|constructor|Component|Fragment|Profiler|StrictMode|children|className|ref|displayName|props|isPureReactComponent|enqueue\w+|default|mounted|isMounted)$/;
const STYLE_CONFIG_FIELD_RE = /(?:^|_|\b)(?:className|style|css|opacity|swapOpacity|color|background|bg|foreground|width|height|size|radius|rounded|border|shadow|ring|outline|layout|position|absolute|relative|fixed|sticky|zIndex|left|right|top|bottom|margin|padding|gap|font|lineHeight|leading|tracking|display|flex|grid|align|justify|translate|rotate|scale|clip|object|pointerEvents|cursor|transition|duration|ease|hover|focus|active)(?:$|_|\b)/i;

/**
 * 判断一个值是否为 minifier 压缩变量（单字母/双字母标识符、X.Y 属性访问）
 * 如 W, K, V, B, q, J.objectFit, X.sizes 等
 */
function isMinifierValue(val) {
  if (!val) return false;
  // 单字符变量（含 _ 和 $）
  if (/^[a-zA-Z_$]$/.test(val)) return true;
  // 双字符变量
  if (/^[a-zA-Z_$]{2}$/.test(val)) return true;
  // X.prop 形式（minifier 属性访问）
  if (/^[a-zA-Z_$]\.\w{1,12}$/.test(val)) return true;
  // void + 单字母（如 void 0 → c）
  if (/^void\s/.test(val)) return true;
  return false;
}

/**
 * 判断一条 configDiff 是否为真实业务变更（用于卡片展示和 AI 输入的二次过滤）
 * 规则：
 *   1. key 在 CONFIG_BUSINESS_KEYS 白名单 → 通过
 *   2. 值含引号字符串（"foo"）或 0x 地址 → 通过
 *   3. 值为布尔（!0/!1）→ 仅当 key 名称暗示业务含义时通过
 */
const BUSINESS_FIELD_HINTS = /fee|permit|enabled|show|hide|support|stake|vault|dividend|amount|constraint|sugar|subscription/i;

function isBusinessConfigDiff(cd) {
  if (isStylePseudoConfigDiff(cd)) return false;
  // 前置过滤：如果新旧值都是 minifier 变量，直接拒绝（无论 key 是什么）
  if (isMinifierValue(cd.oldVal) && isMinifierValue(cd.newVal)) return false;
  // 如果任一值是 minifier 变量，另一方也不是具体业务值，拒绝
  if (isMinifierValue(cd.oldVal) || isMinifierValue(cd.newVal)) {
    const otherVal = isMinifierValue(cd.oldVal) ? cd.newVal : cd.oldVal;
    const isConcrete = /^["']/.test(otherVal) || /^0x[0-9a-fA-F]{4,}/.test(otherVal) || /^\d+(\.\d+)?$/.test(otherVal) || /^!?[01]$/.test(otherVal) || /^(null|true|false)$/.test(otherVal);
    if (!isConcrete) return false;
  }
  // 白名单直接通过
  if (CONFIG_BUSINESS_KEYS.has(cd.field)) return true;
  // 引号字符串值 → 业务标签/名称
  if (cd.oldVal.startsWith('"') || cd.newVal.startsWith('"')) return true;
  if (cd.oldVal.startsWith("'") || cd.newVal.startsWith("'")) return true;
  // 0x 地址 → 合约地址
  if (cd.oldVal.startsWith("0x") || cd.newVal.startsWith("0x")) return true;
  // 布尔值 → 只有字段名暗示业务含义时才通过
  if (/^!?[01]$/.test(cd.oldVal) || /^!?[01]$/.test(cd.newVal)) {
    return BUSINESS_FIELD_HINTS.test(cd.field);
  }
  // 新增配置（oldVal 为标记值）→ 字段名匹配业务关键词则通过
  if (cd.oldVal === "(新增)" || cd.oldVal === "(无)") {
    return BUSINESS_FIELD_HINTS.test(cd.field);
  }
  return false;
}

function extractConfigDiffs(removedStrings, addedStrings) {
  const configDiffs = [];
  const configRe = /(\w+)\s*:\s*(\{[^}]+\}|![01]|"[^"]*"|'[^']*'|[\w.]+)/g;

  function pushConfigDiff(item) {
    if (!isBusinessConfigDiff(item)) return false;
    configDiffs.push(item);
    return true;
  }

  function parseConfigTokens(str) {
    const map = new Map();
    let m;
    const re = new RegExp(configRe.source, "g");
    while ((m = re.exec(str)) !== null) {
      const key = m[1];
      // 只保留业务相关的 key
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
          // 双方都是 minifier 变量 → 跳过（即使 key 在业务白名单中，值为单字母变量名也不是真实变更）
          if (isMinifierValue(oldVal) && isMinifierValue(newVal)) continue;
          // 一方是 minifier 变量、另一方也是 → 跳过（如 "l" → "n.chainId"）
          if (isMinifierValue(oldVal) || isMinifierValue(newVal)) {
            // 仅当另一方是具体业务值（数字、字符串、地址、布尔）时才保留
            const otherVal = isMinifierValue(oldVal) ? newVal : oldVal;
            const isConcrete = /^["']/.test(otherVal) || /^0x[0-9a-fA-F]{4,}/.test(otherVal) || /^\d+(\.\d+)?$/.test(otherVal) || /^!?[01]$/.test(otherVal) || /^null$/.test(otherVal) || /^(true|false)$/.test(otherVal);
            if (!isConcrete) continue;
          }
          pushConfigDiff({ field: key, oldVal, newVal });
        }
      }
      for (const [key, val] of newTokens) {
        if (!oldTokens.has(key)) {
          // 新出现的 key：白名单内直接通过，或匹配业务关键词模式也通过
          const isBusinessKey = CONFIG_BUSINESS_KEYS.has(key) || BUSINESS_FIELD_HINTS.test(key);
          if (isBusinessKey && !isMinifierValue(val)) {
            pushConfigDiff({ field: key, oldVal: "(无)", newVal: val });
          }
        }
      }
      if (configDiffs.length > 0) break;
    }
  }

  // ── 第二遍：扫描纯新增字符串中的业务配置（不依赖 removed 配对）──
  // 用于捕获全新功能模块的 config（如 enablePancakeInfinityNonTax:!0）
  const seenFields = new Set(configDiffs.map(cd => cd.field));
  for (const added of addedStrings) {
    const tokens = parseConfigTokens(added);
    for (const [key, val] of tokens) {
      if (seenFields.has(key)) continue;
      const isBusinessKey = CONFIG_BUSINESS_KEYS.has(key) || BUSINESS_FIELD_HINTS.test(key);
      if (!isBusinessKey) continue;
      if (isMinifierValue(val)) continue;
      // 确认这个 key 在所有 removed 字符串中都不存在（真正的新增）
      let existsInOld = false;
      for (const removed of removedStrings) {
        if (removed.includes(key + ":") || removed.includes(key + " :")) {
          existsInOld = true;
          break;
        }
      }
      if (!existsInOld) {
        if (pushConfigDiff({ field: key, oldVal: "(新增)", newVal: val })) {
          seenFields.add(key);
        }
      }
    }
  }
  return configDiffs;
}

/**
 * 检测变更列表中是否命中业务关键词
 * 返回 { hit: boolean, keywords: string[], priority: "critical"|"normal" }
 */
function detectBusinessPriority(changes) {
  const hitKeywords = new Set();
  const text = changes.join("\n");
  for (const kw of BUSINESS_KEYWORDS) {
    if (kw.pattern.test(text)) hitKeywords.add(kw.label);
  }
  return {
    hit: hitKeywords.size > 0,
    keywords: [...hitKeywords],
    priority: hitKeywords.size > 0 ? "critical" : "normal",
  };
}

/* ══════════════════════════════════════════
   反风控基础设施
   ══════════════════════════════════════════ */

const UA_POOL = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:126.0) Gecko/20100101 Firefox/126.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
];
let uaIdx = 0;
function nextUA() { return UA_POOL[uaIdx++ % UA_POOL.length]; }

function browserHeaders() {
  return {
    "User-Agent": nextUA(),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
  };
}

// 按具体页面/资源路径自适应退避，避免一个页面风控连坐所有 flap.sh 目标
const domainBackoff = new Map();
function getBackoffKey(url) {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}`;
  } catch {
    return url;
  }
}

function shouldBackoff(domain) {
  const b = domainBackoff.get(domain);
  if (!b) return false;
  return Date.now() - b.lastFail < b.delayMs;
}

function recordFail(domain, statusCode) {
  const b = domainBackoff.get(domain) || { delayMs: 0, lastFail: 0 };
  if (statusCode === 429 || statusCode === 403) {
    b.delayMs = Math.min(Math.max(b.delayMs * 2, CONFIG.backoff.initialMs), CONFIG.backoff.maxMs);
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
  if (b.delayMs < 2_000) domainBackoff.delete(domain);
  else domainBackoff.set(domain, b);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ── 工具函数 ── */
const ts = () => new Date().toLocaleString("zh-CN", { hour12: false });
const log = (msg) => console.log(`[${ts()}] ${msg}`);
const md5 = (str) => createHash("md5").update(str).digest("hex");

function emptyFlapChangeMeta() {
  return {
    assetStats: null,
    textChangeCount: 0,
    textChanges: [],
    i18nChangeCount: 0,
    i18nDiffs: [],
    metadataSchemaDiffs: [],
    caStoreVaultDiffs: [],
    nextDataChanged: false,
    fullDiffLines: [],
  };
}

/* ── 快照读写 ── */
const CURRENT_SCHEMA_VERSION = 6;
const CA_STORE_VAULT_SCHEMA_VERSION = 3;
const ASSET_ANALYSIS_SCHEMA_VERSION = 2;
const METADATA_SCHEMA_FIELDS = Object.freeze([
  "creator", "description", "website", "telegram", "twitter", "github", "youtube", "debox", "buy",
  "name", "symbol", "image", "sell",
]);
const METADATA_INPUT_FIELDS = new Set(["creator", "description", "website", "telegram", "twitter", "github", "youtube", "debox", "buy"]);
const METADATA_OUTPUT_FIELDS = new Set(["name", "symbol", "description", "image", "website", "twitter", "telegram", "github", "youtube", "debox", "buy", "sell", "creator"]);

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
 * 快照版本迁移
 */
function migrateSnapshot(data) {
  const ver = data._schemaVersion || 1;
  if (ver < 2) {
    // v1 → v2: 页面缺少 assetContents 字段
    if (data.pages) {
      for (const [key, page] of Object.entries(data.pages)) {
        if (!page.assetContents) page.assetContents = {};
      }
    }
    log("[快照迁移] v1 → v2：补充 assetContents 字段");
  }
  if (ver < 3) {
    // v2 → v3: 无额外迁移，仅升级版本号
    log("[快照迁移] v2 → v3");
  }
  if (ver < 4) {
    // v3 → v4: 新增 vaultFactories 顶层字段
    if (!data.vaultFactories) data.vaultFactories = {};
    log("[快照迁移] v3 → v4：新增 vaultFactories 字段");
  }
  if (ver < 5) {
    log("[快照迁移] v4 → v5：CAstore 金库实例保留重复项");
  }
  if (ver < 6) log("[快照迁移] v5 → v6：新增 Flap Vault Portal 链上监控字段");
  if (!data.registryMonitor) data.registryMonitor = {};
  data._schemaVersion = CURRENT_SCHEMA_VERSION;
  return data;
}

function saveSnapshot(data) {
  data.lastCheck = ts();
  data._schemaVersion = CURRENT_SCHEMA_VERSION;
  try {
    const tmpFile = CONFIG.snapshotFile + ".tmp";
    writeFileSync(tmpFile, JSON.stringify(data, null, 2), "utf-8");
    renameSync(tmpFile, CONFIG.snapshotFile);
  } catch (err) {
    log(`[快照] 写入失败：${err.message}`);
  }
}

/* ── 飞书消息（SDK 统一通道） ── */

const feishuDeliveryCircuit = {
  authFailures: 0,
  nextAttemptAt: 0,
  lastWarningAt: 0,
};

function isPlaceholderCredential(value) {
  return !value || /(?:xxxx|your[_-]|example|placeholder|\.\.\.)/i.test(String(value));
}

function hasUsableFeishuCredentials() {
  return !isPlaceholderCredential(CONFIG.feishuAppId)
    && !isPlaceholderCredential(CONFIG.feishuAppSecret)
    && !isPlaceholderCredential(CONFIG.feishuChatId);
}

function isFeishuAuthError(error) {
  return /tenant_access_token|invalid param|code[=：:]?\s*10003|飞书凭证|app[_ ]?(?:id|secret)/i
    .test(String(error?.message || error || ""));
}

function canAttemptFeishuDelivery() {
  if (!hasUsableFeishuCredentials()) return false;
  return Date.now() >= feishuDeliveryCircuit.nextAttemptAt;
}

function warnFeishuUnavailable(message) {
  if (Date.now() - feishuDeliveryCircuit.lastWarningAt < 60_000) return;
  feishuDeliveryCircuit.lastWarningAt = Date.now();
  log(`[飞书] ${message}`);
}

function openFeishuAuthCircuit(error) {
  feishuDeliveryCircuit.authFailures++;
  const delayMs = Math.min(3_600_000, 300_000 * (2 ** Math.min(3, feishuDeliveryCircuit.authFailures - 1)));
  feishuDeliveryCircuit.nextAttemptAt = Date.now() + delayMs;
  warnFeishuUnavailable(`凭证认证失败，暂停推送 ${Math.round(delayMs / 60_000)} 分钟：${error.message}`);
}

function closeFeishuAuthCircuit() {
  feishuDeliveryCircuit.authFailures = 0;
  feishuDeliveryCircuit.nextAttemptAt = 0;
}

/**
 * 带重试的卡片发送（兼容旧接口 sendFeishu）
 */
async function sendFeishu(title, content, template = "red", _retries = 2) {
  if (!canAttemptFeishuDelivery()) {
    warnFeishuUnavailable(hasUsableFeishuCredentials()
      ? "凭证认证熔断中，本次推送保留等待后续重试"
      : "凭证缺失或仍为占位值，已停止推送重试");
    return false;
  }
  const opts = _retries && typeof _retries === "object" ? _retries : {};
  const retryCount = _retries && typeof _retries === "object" ? 2 : _retries;
  for (let attempt = 0; attempt <= retryCount; attempt++) {
    try {
      const messageId = await sendCardQueued(title, content, template, opts);
      if (!messageId) throw new Error("队列发送未返回 message_id");
      closeFeishuAuthCircuit();
      return true;
    } catch (err) {
      if (isFeishuAuthError(err)) {
        openFeishuAuthCircuit(err);
        return false;
      }
      log(`飞书推送异常（第${attempt + 1}次）：${err.message}`);
      if (attempt < retryCount) {
        await sleep(3_000 * (attempt + 1));
      }
    }
  }
  log(`飞书推送最终失败（已重试 ${retryCount} 次）`);
  return false;
}

function isStylePseudoConfigDiff(cd = {}) {
  const field = String(cd.field || "");
  const oldVal = String(cd.oldVal ?? "");
  const newVal = String(cd.newVal ?? "");
  if (STYLE_CONFIG_FIELD_RE.test(field)) return true;
  if (/^(?:hover|focus|active|disabled|group-hover|aria|data)$/i.test(field)) return true;
  if (/^(?:pointer|pointer-events|opacity|ring|outline|translate|rounded|border|bg|object|clip|absolute|relative|none|auto|hidden|visible)$/i.test(newVal)) return true;
  if (isTailwindClassLikeString(`${field}:${newVal}`) || isCssUtilityFragment(`${field}:${newVal}`)) return true;
  if ((oldVal === "(新增)" || oldVal === "(无)") && /^(?:pointer|none|auto|opacity|ring|outline)$/i.test(newVal)) return true;
  return false;
}

/**
 * 通过 IM API 发送卡片消息到群聊，返回 message_id
 */
async function sendCardViaApi(title, content, template = "red", diffFilePath, cardOpts = {}) {
  if (!canAttemptFeishuDelivery()) {
    const reason = hasUsableFeishuCredentials() ? "飞书凭证认证熔断中" : "飞书凭证缺失或仍为占位值";
    warnFeishuUnavailable(`${reason}，跳过本次发送`);
    throw new Error(reason);
  }
  const maxAttempts = 2;
  let lastError = null;
  const opts = { ...cardOpts, diffFilePath };
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const messageId = await sendCard(title, content, template, opts);
      closeFeishuAuthCircuit();
      return messageId;
    } catch (err) {
      lastError = err;
      log(`[飞书 IM API] 直接发送失败（第 ${attempt + 1}/${maxAttempts} 次）：${err.message}`);
      if (isFeishuAuthError(err)) {
        openFeishuAuthCircuit(err);
        throw err;
      }
      if (attempt < maxAttempts - 1) await sleep(800 * (attempt + 1));
    }
  }

  log("[飞书 IM API] 直接发送失败，转入队列兜底补发");
  const queuedMessageId = await sendCardQueued(title, content, template, opts);
  if (queuedMessageId) return queuedMessageId;
  throw new Error(`飞书卡片发送失败：${lastError?.message || "队列补发失败"}`);
}

/**
 * 编辑已发送的卡片消息
 */
async function patchCardViaApi(messageId, title, content, template = "red", diffFilePath, cardOpts = {}) {
  await patchCard(messageId, title, content, template, { ...cardOpts, diffFilePath });
}

function alertMentionCardOptions() {
  return CONFIG.feishuMentionOpenId ? { mentionOpenId: CONFIG.feishuMentionOpenId } : {};
}

function sendAlertCard(sendCardFn, title, content, template) {
  return sendCardFn(title, content, template, undefined, alertMentionCardOptions());
}

const FEISHU_CARD_PATCH_SAFE_LIMIT = (() => {
  const n = Number(process.env.FEISHU_CARD_CHUNK_LIMIT || 3500);
  return Number.isFinite(n) && n >= 500 ? Math.floor(n) - 40 : 3460;
})();

function isTooLongForSingleCard(content) {
  return String(content ?? "").length > FEISHU_CARD_PATCH_SAFE_LIMIT;
}

/**
 * 先推裸 diff（秒级送达），AI 摘要完成后自动编辑原消息补充分析
 * @param {string} [url] - 监控目标网址，展示在卡片最上方
 */
async function sendThenEnrichWithAi(title, content, template, moduleContext, aiInput, enrichFn, diffFilePath, url, summarizeFn = aiSummarize, cardOpts = {}) {
  const initialContent = buildCardUrlPrefix(url, content) + content;
  const messageId = await sendCardViaApi(title, initialContent, template, diffFilePath, cardOpts);

  if (AI_CONFIG.enabled && AI_CONFIG.apiKey) {
    const summarize = summarizeFn || aiSummarize;
    summarize(aiInput || initialContent, moduleContext).then(async (summary) => {
      if (!summary) return;
      const enriched = enrichFn
        ? enrichFn(summary)
        : `**🤖 AI 分析：**\n${summary}\n\n---\n\n${content}`;
      const enrichedContent = buildCardUrlPrefix(url, enriched) + enriched;
      if (messageId) {
        try {
          if (isTooLongForSingleCard(initialContent) || isTooLongForSingleCard(enrichedContent)) {
            log(`[AI 摘要] ${title} 正文较长，保留完整变更卡片，另发 AI 摘要卡片`);
            await sendFeishu(`🤖 ${title}`, `**AI 分析：**\n${summary}`, "blue");
          } else {
            await patchCardViaApi(messageId, title, enrichedContent, template, diffFilePath, cardOpts);
            log(`[AI 摘要→卡片更新] ${title} 已补充 AI 摘要`);
          }
        } catch (err) {
          log(`[AI 摘要→卡片更新] 编辑失败(${err.message})，追加发送`);
          await sendFeishu(`🤖 ${title}`, `**AI 分析：**\n${summary}`, "blue");
        }
      } else {
        await sendFeishu(`🤖 ${title}`, `**AI 分析：**\n${summary}`, "blue");
      }
    }).catch(err => log(`[AI 摘要] 异步摘要异常：${err.message}`));
  }
  return messageId;
}

function shouldUseAiForNotification({ title = "", content = "", moduleContext = "", aiInput = "", skipAi = false } = {}) {
  if (skipAi) return false;
  const text = `${title}\n${moduleContext}\n${aiInput || content}`;
  if (/请求失败|处理失败|退避恢复|基线已修复|页面样本无效|模块异常|模块恢复|状态/i.test(text)) return false;
  if (/全站前端资源变更|Flap\.sh 全站前端资源变更|Flap 全站前端资源变更/i.test(text)) return true;
  if (/仅检测到构建产物|压缩变量噪音|hash\s*轮换|sourceMappingURL|无实质|常规构建/i.test(text)) return false;
  return /重点变更|页面变更|文案|i18n|CAstore|金库|Vault|Factory|fee|rate|route|api|contract|address|enabled|staking|dividend/i.test(text);
}

async function sendNotificationMaybeAi({ title, content, template = "red", moduleContext = "", aiInput, enrichFn, diffFilePath, url, skipAi = false, cardOpts = {} }) {
  if (!shouldUseAiForNotification({ title, content, moduleContext, aiInput, skipAi })) {
    const cardContent = buildCardUrlPrefix(url, content) + content;
    const messageId = await sendCardViaApi(title, cardContent, template, diffFilePath, cardOpts);
    if (!messageId) await sendFeishu(title, cardContent, template, cardOpts);
    else log(`[AI] 已跳过：${title}`);
    return messageId;
  }
  return sendThenEnrichWithAi(title, content, template, moduleContext, aiInput, enrichFn, diffFilePath, url, aiSummarize, cardOpts);
}

function hasItems(value) {
  return Array.isArray(value) && value.length > 0;
}

function flapLink(label, url) {
  return url ? `[${label}](${url})` : label;
}

function flapPageLabel(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname || "/"}${parsed.search || ""}`;
  } catch {
    return String(url || "页面");
  }
}

function flapPageLink(url) {
  return flapLink(flapPageLabel(url), url);
}

function formatFlapResourceStats(assetStats) {
  if (!assetStats) return "";
  return `- 不变 ${assetStats.unchanged || 0} / 重命名 ${assetStats.renamed || 0} / 修改 ${assetStats.modified || 0} / 新增 ${assetStats.added || 0} / 移除 ${assetStats.removed || 0}`;
}

function shortHash(value, head = 8, tail = 4) {
  const text = String(value || "");
  return text || "-";
}

function addressLink(address, type = "address") {
  const value = String(address || "");
  if (!/^0x[a-fA-F0-9]{40}$/.test(value)) return value || "-";
  const path = type === "tx" ? "tx" : "address";
  return flapLink(value, `https://bscscan.com/${path}/${value}`);
}

function txLink(txHash) {
  const value = String(txHash || "");
  if (!/^0x[a-fA-F0-9]{64}$/.test(value)) return value || "-";
  return flapLink(value, `https://bscscan.com/tx/${value}`);
}

function blockLink(blockNumber) {
  if (!blockNumber && blockNumber !== 0) return "-";
  return flapLink(String(blockNumber), `https://bscscan.com/block/${blockNumber}`);
}

function formatFlapSection(title, lines = []) {
  const body = (lines || []).filter(line => line !== "" && line != null);
  if (body.length === 0) return [];
  const icons = {
    "重点信息": "🎯",
    "重点变更": "🎯",
    "影响页面": "🌐",
    "影响范围": "🌐",
    "AI 分析": "🤖",
    "链上新金库注册": "⛓️",
    "金库文案": "🏦",
  };
  const icon = icons[title] ? `${icons[title]} ` : "";
  return [`**${icon}${title}**`, ...body, ""];
}

function buildFlapCardContent({ summary = [], primaryTitle = "重点信息", primary = [], scope = [], details = [], detailsTitle = "详情", ai = "" } = {}) {
  const summaryBody = (summary || []).filter(line => line !== "" && line != null);
  const lines = [
    ...summaryBody,
    ...(summaryBody.length > 0 ? [""] : []),
    ...formatFlapSection("影响页面", scope),
    ...formatFlapSection(primaryTitle, primary),
    ...formatFlapSection(detailsTitle, details),
    ...(ai ? formatFlapSection("AI 分析", [ai]) : []),
  ];
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function isFlapAssetOnlyNotification(notification) {
  if (!notification || notification.isRecoveryNotice || notification.content) return false;
  const meta = notification.meta || {};
  const assetStats = meta.assetStats;
  if (!assetStats) return false;
  if (hasPageSpecificAssetChange(notification)) return false;
  if ((meta.textChangeCount || 0) > 0 || hasItems(meta.textChanges)) return false;
  if ((meta.i18nChangeCount || 0) > 0 || hasItems(meta.i18nDiffs)) return false;
  if (hasItems(meta.metadataSchemaDiffs)) return false;
  if (hasItems(meta.caStoreVaultDiffs)) return false;
  if (hasItems(assetStats.configDiffs)) return false;
  if (hasItems(assetStats.vaultDiffs)) return false;
  if (hasItems(assetStats.jsTextDiffs)) return false;
  if (hasItems(assetStats.uiStyleDiffs)) return false;
  if (detectBusinessPriority(notification.changes || []).hit) return false;
  return true;
}

function hasFlapPageLevelChange(notification) {
  const meta = notification?.meta || {};
  if ((meta.textChangeCount || 0) > 0 || hasItems(meta.textChanges)) return true;
  if ((meta.i18nChangeCount || 0) > 0 || hasItems(meta.i18nDiffs)) return true;
  if (hasItems(meta.metadataSchemaDiffs)) return true;
  if (hasItems(meta.caStoreVaultDiffs)) return true;
  return false;
}

function isSharedResourceChangeCandidate(notification) {
  if (!notification || notification.isRecoveryNotice || notification.content) return false;
  const assetStats = notification.meta?.assetStats;
  if (!assetStats || hasFlapPageLevelChange(notification)) return false;
  if (hasItems(assetStats.configDiffs)) return true;
  if (hasItems(assetStats.vaultDiffs)) return true;
  if (hasItems(assetStats.jsTextDiffs)) return true;
  if (hasItems(assetStats.uiStyleDiffs)) return true;
  if (hasItems(assetStats.codeIntentDiffs)) return true;
  if (hasPageSpecificAssetChange(notification)) return false;
  return detectBusinessPriority(notification.changes || []).hit;
}

function hasStructuredSharedAssetStats(assetStats) {
  if (!assetStats) return false;
  if (hasItems(assetStats.configDiffs)) return true;
  if (hasItems(assetStats.vaultDiffs)) return true;
  if (hasItems(assetStats.jsTextDiffs)) return true;
  if (hasItems(assetStats.uiStyleDiffs)) return true;
  if (hasItems(assetStats.codeIntentDiffs)) return true;
  return false;
}

function hasExtractableSharedResourceChange(notification) {
  if (!notification || notification.isRecoveryNotice || notification.content) return false;
  const assetStats = notification.meta?.assetStats;
  if (!assetStats || !hasFlapPageLevelChange(notification)) return false;
  return hasStructuredSharedAssetStats(assetStats);
}

function extractSharedResourceNotification(notification) {
  const meta = notification.meta || {};
  const assetStats = meta.assetStats || {};
  return {
    ...notification,
    meta: { ...emptyFlapChangeMeta(), assetStats, fullDiffLines: meta.fullDiffLines || [] },
    snapshotUpdates: [
      ...(notification.snapshotUpdates || []),
      ...(notification.snapshotUpdate ? [notification.snapshotUpdate] : []),
    ],
    snapshotUpdate: undefined,
  };
}

function stripSharedResourceNotification(notification) {
  if (!hasExtractableSharedResourceChange(notification)) return notification;
  const meta = { ...(notification.meta || {}) };
  meta.assetStats = null;
  meta.fullDiffLines = (meta.fullDiffLines || []).filter(line => {
    const text = String(line || "");
    return !/前端资源|配置参数|Vault 配置/.test(text);
  });
  const changes = (notification.changes || []).filter(line => {
    const text = String(line || "");
    return !/前端资源变更|配置参数变更|Vault 配置变更/.test(text);
  });
  return { ...notification, changes, meta, sharedResourceStripped: true };
}

function hasNotificationPayload(notification) {
  if (!notification) return false;
  if (notification.content) return true;
  const meta = notification.meta || {};
  if (!notification.sharedResourceStripped && (notification.changes || []).length > 0) return true;
  if ((meta.textChangeCount || 0) > 0 || hasItems(meta.textChanges)) return true;
  if ((meta.i18nChangeCount || 0) > 0 || hasItems(meta.i18nDiffs)) return true;
  if (hasItems(meta.metadataSchemaDiffs)) return true;
  if (hasItems(meta.caStoreVaultDiffs)) return true;
  if (meta.assetStats) return true;
  return false;
}

function stableForCompare(value) {
  if (Array.isArray(value)) {
    return value.map(stableForCompare).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = stableForCompare(value[key]);
    return out;
  }
  return value;
}

function stableKey(value) {
  return JSON.stringify(stableForCompare(value));
}

function uniqueRecords(records = []) {
  const seen = new Set();
  const out = [];
  for (const record of records || []) {
    const key = stableKey(record);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(record);
  }
  return out;
}

function mergeJsTextDiffsForSiteWide(records = []) {
  const grouped = new Map();
  for (const diff of records || []) {
    const text = normalizeDiffText(diff.text);
    if (!text) continue;
    const type = diff.type || "";
    const key = stableKey({ type, text });
    const current = grouped.get(key) || { type, text, files: new Set() };
    if (diff.file) current.files.add(diff.file);
    grouped.set(key, current);
  }
  return [...grouped.values()].map(item => ({
    type: item.type,
    text: item.text,
    file: uniqueStrings([...item.files]).join(", "),
  }));
}

function summarizeUiStyleDiffs(uiStyleDiffs = []) {
  const grouped = new Map();
  for (const diff of uiStyleDiffs || []) {
    const category = diff.category || "utility";
    const contextKey = diff.contextKey || "unknown";
    const key = `${category}:${contextKey}`;
    const current = grouped.get(key) || {
      category,
      contextKey,
      label: diff.label || UI_STYLE_CATEGORY_META[category]?.label || "样式信号",
      intent: diff.intent || UI_STYLE_CATEGORY_META[category]?.intent || "调整前端样式",
      evidence: diff.evidence || UI_STYLE_CATEGORY_META[category]?.evidence || "CSS utility",
      contextLabel: diff.contextLabel || "未定位具体组件",
      contextConfidence: diff.contextConfidence || "低",
      added: 0,
      removed: 0,
      files: new Set(),
      assetPaths: new Set(),
    };
    if (diff.type === "removed") current.removed += 1;
    else current.added += 1;
    if (diff.file) current.files.add(diff.file);
    if (diff.assetPath) current.assetPaths.add(diff.assetPath);
    grouped.set(key, current);
  }
  return [...grouped.values()]
    .map(item => ({
      ...item,
      files: uniqueStrings([...item.files]),
      assetPaths: uniqueStrings([...item.assetPaths]),
      total: item.added + item.removed,
    }))
    .sort((a, b) => b.total - a.total || a.contextLabel.localeCompare(b.contextLabel) || a.label.localeCompare(b.label));
}

function summarizeCodeIntentDiffs(codeIntentDiffs = []) {
  const grouped = new Map();
  for (const diff of codeIntentDiffs || []) {
    const key = diff.key || diff.label || "code";
    const current = grouped.get(key) || {
      key,
      label: diff.label || "实现逻辑信号",
      intent: diff.intent || "可能调整前端实现逻辑",
      evidence: diff.evidence || "代码字段",
      added: 0,
      removed: 0,
      files: new Set(),
      assetPaths: new Set(),
    };
    if (diff.type === "removed") current.removed += 1;
    else current.added += 1;
    if (diff.file) current.files.add(diff.file);
    if (diff.assetPath) current.assetPaths.add(diff.assetPath);
    grouped.set(key, current);
  }
  return [...grouped.values()]
    .map(item => ({
      ...item,
      files: uniqueStrings([...item.files]),
      assetPaths: uniqueStrings([...item.assetPaths]),
      total: item.added + item.removed,
    }))
    .sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));
}

function buildResourceIntentSummary(assetStats = {}) {
  const configCount = (assetStats.configDiffs || []).filter(isBusinessConfigDiff).length;
  const textCount = assetStats.jsTextDiffs?.length || 0;
  const vaultCount = assetStats.vaultDiffs?.length || 0;
  const uiSignals = summarizeUiStyleDiffs(assetStats.uiStyleDiffs || []);
  const codeSignals = summarizeCodeIntentDiffs(assetStats.codeIntentDiffs || []);
  if (vaultCount > 0 || configCount > 0 || textCount > 0) {
    const parts = [];
    if (vaultCount > 0) parts.push(`Vault 配置 ${vaultCount} 项`);
    if (configCount > 0) parts.push(`业务配置 ${configCount} 项`);
    if (textCount > 0) parts.push(`功能文案 ${textCount} 处`);
    if (codeSignals.length > 0) parts.push(`实现意图信号 ${codeSignals.reduce((sum, s) => sum + s.total, 0)} 处`);
    return {
      verdict: "发现业务层信号",
      intent: `可能涉及 ${parts.join("、")} 调整`,
      confidence: "高",
      uiSignals,
      codeSignals,
    };
  }
  if (codeSignals.length > 0) {
    const labels = codeSignals.slice(0, 4).map(s => s.label).join("、");
    return {
      verdict: "发现实现层业务信号",
      intent: `代码片段不可直接作为文案展示，但字段透露可能涉及 ${labels} 调整`,
      confidence: "中",
      uiSignals,
      codeSignals,
    };
  }
  if (uiSignals.length > 0) {
    const contexts = uniqueStrings(uiSignals.map(s => s.contextLabel).filter(label => label && label !== "未定位具体组件")).slice(0, 3);
    const contextSuffix = contexts.length > 0 ? `；影响范围：${contexts.join("、")}` : "";
    return {
      verdict: "未发现明确业务配置变化",
      intent: `主要是 UI/样式层调整，可能意图：${uiSignals.slice(0, 3).map(s => s.intent).join("；")}${contextSuffix}`,
      confidence: "中",
      uiSignals,
      codeSignals,
    };
  }
  if (assetStats) {
    return {
      verdict: "未发现明确业务信号",
      intent: "主要是资源构建或运行时代码变化，需结合下载 Diff 追查",
      confidence: "低",
      uiSignals: [],
      codeSignals: [],
    };
  }
  return {
    verdict: "检测到页面变化",
    intent: "未提取到资源层意图",
    confidence: "低",
    uiSignals: [],
    codeSignals: [],
  };
}

function buildUiStyleSignalLines(uiSignals = []) {
  if (!uiSignals.length) return [];
  const lines = [];
  for (const signal of uiSignals) {
    const countParts = [];
    if (signal.added) countParts.push(`新增 ${signal.added}`);
    if (signal.removed) countParts.push(`删除 ${signal.removed}`);
    const files = signal.files?.length ? `；文件：${signal.files.slice(0, 3).map(cardText).join(", ")}${signal.files.length > 3 ? ` 等 ${signal.files.length} 个` : ""}` : "";
    const context = signal.contextLabel && signal.contextLabel !== "未定位具体组件"
      ? `；范围：${cardText(signal.contextLabel)}（${cardText(signal.contextConfidence)}）`
      : "";
    lines.push(`- ${changedText(signal.label)}：${countParts.join(" / ") || `${signal.total} 处`}${context}；可能意图：${cardText(signal.intent)}；证据：${cardText(signal.evidence)}${files}`);
  }
  return lines;
}

function buildCodeIntentSignalLines(codeSignals = []) {
  if (!codeSignals.length) return [];
  return codeSignals.map(signal => {
    const countParts = [];
    if (signal.added) countParts.push(`新增 ${signal.added}`);
    if (signal.removed) countParts.push(`删除 ${signal.removed}`);
    const files = signal.files?.length ? `；文件：${signal.files.slice(0, 3).map(cardText).join(", ")}${signal.files.length > 3 ? ` 等 ${signal.files.length} 个` : ""}` : "";
    return `- ${changedText(signal.label)}：${countParts.join(" / ") || `${signal.total} 处`}；可能意图：${cardText(signal.intent)}；证据：${cardText(signal.evidence)}${files}`;
  });
}

function normalizeDiffText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeConfigDiffForCore(cd = {}) {
  return {
    field: cd.field || "",
    oldVal: String(cd.oldVal ?? ""),
    newVal: String(cd.newVal ?? ""),
  };
}

function normalizeCodeIntentForCore(signal = {}) {
  return {
    key: signal.key || signal.label || "",
    label: signal.label || "",
    evidence: signal.evidence || "",
    added: Number(signal.added || 0),
    removed: Number(signal.removed || 0),
  };
}

function normalizeVaultDiffForCore(diff = {}) {
  if (diff.type === "modified") {
    return {
      type: diff.type,
      name: diff.name || "",
      fieldChanges: (diff.fieldChanges || []).map(fc => ({
        key: fc.key || "",
        oldVal: String(fc.oldVal ?? ""),
        newVal: String(fc.newVal ?? ""),
      })),
    };
  }
  return {
    type: diff.type || "",
    name: diff.name || "",
    fields: diff.fields || null,
  };
}

function resourceCoreBusinessFingerprint(notification) {
  const assetStats = notification?.meta?.assetStats || {};
  const businessConfigDiffs = (assetStats.configDiffs || []).filter(isBusinessConfigDiff).map(normalizeConfigDiffForCore);
  const vaultDiffs = (assetStats.vaultDiffs || []).map(normalizeVaultDiffForCore);
  const jsTextDiffs = (assetStats.jsTextDiffs || []).map(d => ({
    type: d.type || "",
    text: normalizeDiffText(d.text),
  })).filter(d => d.text);
  const codeIntentSummary = summarizeCodeIntentDiffs(assetStats.codeIntentDiffs || []).map(normalizeCodeIntentForCore);
  const hasCoreSignals = businessConfigDiffs.length > 0 || vaultDiffs.length > 0 || jsTextDiffs.length > 0 || codeIntentSummary.length > 0;
  if (!hasCoreSignals) return "";
  return stableKey({
    configDiffs: businessConfigDiffs,
    vaultDiffs,
    jsTextDiffs,
    codeIntentSummary,
  });
}

function resourceChangeFingerprint(notification) {
  const assetStats = notification.meta?.assetStats || {};
  const hasStructuredResourceDiff = hasItems(assetStats.configDiffs) || hasItems(assetStats.vaultDiffs) || hasItems(assetStats.jsTextDiffs) || hasItems(assetStats.uiStyleDiffs) || hasItems(assetStats.codeIntentDiffs);
  const detailLines = (notification.changes || [])
    .map(line => String(line || "").trim())
    .filter(line => line && !line.startsWith("📦 前端资源变更") && !line.startsWith("🔇 构建噪音"));
  const structuredFiles = uniqueStrings([
    ...(assetStats.configDiffs || []).map(d => d.file),
    ...(assetStats.jsTextDiffs || []).map(d => d.file),
    ...(assetStats.uiStyleDiffs || []).map(d => d.file),
    ...(assetStats.codeIntentDiffs || []).map(d => d.file),
  ]);
  return stableKey({
    files: hasStructuredResourceDiff ? structuredFiles : (assetStats.substantiveFileNames || []),
    semanticProfile: hasStructuredResourceDiff ? null : (assetStats.semanticProfile || null),
    configDiffs: assetStats.configDiffs || [],
    vaultDiffs: assetStats.vaultDiffs || [],
    jsTextDiffs: assetStats.jsTextDiffs || [],
    uiStyleSummary: summarizeUiStyleDiffs(assetStats.uiStyleDiffs || []),
    codeIntentSummary: summarizeCodeIntentDiffs(assetStats.codeIntentDiffs || []),
    fallbackDetails: hasStructuredResourceDiff ? [] : detailLines,
  });
}

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean).map(String))];
}

function parseNoiseFileNames(changes = []) {
  const names = [];
  for (const line of changes) {
    const m = String(line).match(/构建噪音：.*?\(([^)]+)\)/);
    if (!m) continue;
    for (const name of m[1].split(/\s*,\s*/)) names.push(name.trim());
  }
  return names;
}

function maxStat(notifications, field) {
  return Math.max(0, ...notifications.map(n => Number(n.meta?.assetStats?.[field] || 0)));
}

function assetPathToFilename(path) {
  return String(path || "").split("?")[0].split("/").pop();
}

function extractAssetFileNamesFromChanges(changes = []) {
  const names = [];
  const fileRe = /[\w.-]+\.(?:js|css)\b/g;
  for (const line of changes || []) {
    for (const match of String(line || "").matchAll(fileRe)) names.push(match[0]);
  }
  return uniqueStrings(names);
}

function getPageRouteFromAssetPath(path) {
  const clean = String(path || "").split("?")[0];
  const m = clean.match(/\/_next\/static\/chunks\/app\/(.+?)\/page-[^/]+\.js$/);
  if (!m) return "";
  const route = decodeURIComponent(m[1]).replace(/\[(chain)\]/g, ":$1");
  if (route === "launch") return "launch";
  if (route === "create") return "create";
  if (/CAstore$/i.test(route)) return "CAstore";
  return route;
}

function classifyAssetPath(path) {
  const clean = String(path || "").split("?")[0];
  const name = assetPathToFilename(clean);
  const route = getPageRouteFromAssetPath(clean);
  if (route) return { kind: "page", route, file: clean || name };
  if (/\/_next\/static\/chunks\/app\/layout-/i.test(clean)) return { kind: "layout", file: clean || name };
  if (/\/_next\/static\/chunks\/app\/(?:loading|error|not-found)-/i.test(clean)) return { kind: "system", file: clean || name };
  if (!name) return { kind: "other", file: "" };
  if (/^webpack-[a-f0-9]+\.js$/i.test(name)) return { kind: "runtime", file: clean || name };
  if (/^(framework|main|main-app|polyfills|app|runtime)-/i.test(name)) return { kind: "runtime", file: clean || name };
  if (/\.css$/i.test(name)) return { kind: "style", file: clean || name };
  if (/^\d+-[a-f0-9]+\.js$/i.test(name)) return { kind: "shared", file: clean || name };
  if (/\.js$/i.test(name)) return { kind: "script", file: clean || name };
  return { kind: "other", file: clean || name };
}

function buildAssetSemanticProfile(assetPaths = [], assetStats = {}) {
  const profile = {
    runtime: [],
    shared: [],
    page: [],
    pageRoutes: [],
    appShell: [],
    style: [],
    script: [],
    other: [],
    businessSignals: summarizeBusinessSignals(assetStats),
  };
  for (const assetPath of uniqueStrings(assetPaths)) {
    const classified = classifyAssetPath(assetPath);
    if (classified.kind === "page") {
      profile.page.push(classified);
      if (classified.route && !profile.pageRoutes.includes(classified.route)) profile.pageRoutes.push(classified.route);
    } else if (classified.kind === "layout" || classified.kind === "system") {
      profile.appShell.push(classified);
    } else if (profile[classified.kind]) {
      profile[classified.kind].push(classified);
    } else {
      profile.other.push(classified);
    }
  }
  profile.pageRoutes.sort();
  return profile;
}

function hasPageSpecificAssetChange(notification) {
  const profile = notification?.meta?.assetStats?.semanticProfile;
  const assetStats = notification?.meta?.assetStats || {};
  if (hasItems(assetStats.configDiffs) || hasItems(assetStats.vaultDiffs) || hasItems(assetStats.jsTextDiffs) || hasItems(assetStats.uiStyleDiffs) || hasItems(assetStats.codeIntentDiffs)) {
    return false;
  }
  return Array.isArray(profile?.pageRoutes) && profile.pageRoutes.length > 0;
}

function summarizeBusinessSignals(assetStats = {}) {
  const parts = [];
  const configCount = (assetStats.configDiffs || []).filter(isBusinessConfigDiff).length;
  if ((assetStats.jsTextDiffs || []).length > 0) parts.push(`功能文案 ${assetStats.jsTextDiffs.length} 处`);
  if (configCount > 0) parts.push(`业务配置 ${configCount} 项`);
  if ((assetStats.vaultDiffs || []).length > 0) parts.push(`Vault 配置 ${assetStats.vaultDiffs.length} 项`);
  const codeSignals = summarizeCodeIntentDiffs(assetStats.codeIntentDiffs || []);
  if (codeSignals.length > 0) parts.push(`实现意图信号 ${codeSignals.reduce((sum, s) => sum + s.total, 0)} 处`);
  const uiSignals = summarizeUiStyleDiffs(assetStats.uiStyleDiffs || []);
  if (uiSignals.length > 0) parts.push(`UI/样式信号 ${uiSignals.reduce((sum, s) => sum + s.total, 0)} 处`);
  return parts;
}

function buildSiteWideAssetNotification(assetOnlyNotifications, options = {}) {
  const titlePrefix = options.titlePrefix || "";
  const affectedUrls = uniqueStrings(assetOnlyNotifications.map(n => n.url));
  const substantiveFileNames = uniqueStrings(assetOnlyNotifications.flatMap(n => n.meta?.assetStats?.substantiveFileNames || []));
  const noiseFileNames = uniqueStrings(assetOnlyNotifications.flatMap(n => parseNoiseFileNames(n.changes)));
  const configDiffs = uniqueRecords(assetOnlyNotifications.flatMap(n => n.meta?.assetStats?.configDiffs || []));
  const vaultDiffs = uniqueRecords(assetOnlyNotifications.flatMap(n => n.meta?.assetStats?.vaultDiffs || []));
  const jsTextDiffs = mergeJsTextDiffsForSiteWide(assetOnlyNotifications.flatMap(n => n.meta?.assetStats?.jsTextDiffs || []));
  const uiStyleDiffs = uniqueRecords(assetOnlyNotifications.flatMap(n => n.meta?.assetStats?.uiStyleDiffs || []));
  const codeIntentDiffs = uniqueRecords(assetOnlyNotifications.flatMap(n => n.meta?.assetStats?.codeIntentDiffs || []));
  const businessConfigDiffs = configDiffs.filter(isBusinessConfigDiff);
  const hasBusinessResourceDiffs = businessConfigDiffs.length > 0 || vaultDiffs.length > 0 || jsTextDiffs.length > 0;
  const intentSummary = buildResourceIntentSummary({ configDiffs, vaultDiffs, jsTextDiffs, uiStyleDiffs, codeIntentDiffs });
  const uiSignalLines = buildUiStyleSignalLines(intentSummary.uiSignals);
  const codeIntentLines = buildCodeIntentSignalLines(intentSummary.codeSignals);
  const hasCardSignals = hasBusinessResourceDiffs;
  const assetStats = {
    unchanged: maxStat(assetOnlyNotifications, "unchanged"),
    renamed: maxStat(assetOnlyNotifications, "renamed"),
    modified: Math.max(substantiveFileNames.length, maxStat(assetOnlyNotifications, "modified")),
    added: maxStat(assetOnlyNotifications, "added"),
    removed: maxStat(assetOnlyNotifications, "removed"),
    noiseFiles: noiseFileNames.length || maxStat(assetOnlyNotifications, "noiseFiles"),
    noiseCount: maxStat(assetOnlyNotifications, "noiseCount"),
    substantiveFiles: substantiveFileNames.length || maxStat(assetOnlyNotifications, "substantiveFiles"),
    substantiveCount: maxStat(assetOnlyNotifications, "substantiveCount"),
    substantiveFileNames,
    configDiffs,
    vaultDiffs,
    jsTextDiffs,
    uiStyleDiffs,
    codeIntentDiffs,
  };
  const semanticFiles = uniqueStrings([
    ...substantiveFileNames,
    ...assetOnlyNotifications.flatMap(n => n.meta?.assetStats?.substantiveAssetPaths || []),
    ...assetOnlyNotifications.flatMap(n => extractAssetFileNamesFromChanges(n.changes)),
  ]);
  const semanticProfile = buildAssetSemanticProfile(semanticFiles, assetStats);
  const resourceScopeParts = [
    semanticProfile.runtime.length ? `runtime ${semanticProfile.runtime.length}` : "",
    semanticProfile.appShell.length ? `app shell ${semanticProfile.appShell.length}` : "",
    semanticProfile.shared.length ? `共享 chunk ${semanticProfile.shared.length}` : "",
    semanticProfile.page.length ? `页面 chunk ${semanticProfile.page.length}` : "",
    semanticProfile.script.length ? `业务脚本 ${semanticProfile.script.length}` : "",
    semanticProfile.style.length ? `样式 ${semanticProfile.style.length}` : "",
  ].filter(Boolean);
  const resourceScope = resourceScopeParts.length > 0 ? resourceScopeParts.join(" / ") : "未识别资源类型";
  const localSignalSummary = hasCardSignals
    ? [
        jsTextDiffs.length > 0 ? `功能文案 ${jsTextDiffs.length} 处` : "",
        businessConfigDiffs.length > 0 ? `业务配置 ${businessConfigDiffs.length} 项` : "",
        vaultDiffs.length > 0 ? `Vault 配置 ${vaultDiffs.length} 项` : "",
      ].filter(Boolean).join("；")
    : "未发现需卡片展示的文案或重要参数变更";
  const affectedPageLinks = affectedUrls.map(url => {
    return flapLink(new URL(url).pathname || "首页", url);
  }).join(" ｜ ");
  const cardSignalLines = hasCardSignals
    ? [
        ...jsTextDiffs.map(d => {
          const label = d.type === "removed" ? "移除文案" : d.type === "added" ? "新增文案" : "文案变更";
          return d.type === "removed" ? formatRemovedLine(label, d.text) : formatAddedLine(label, d.text);
        }),
        ...businessConfigDiffs.map(cd => formatValueChangeLine(cd.field, cd.oldVal, cd.newVal)),
        ...vaultDiffs.flatMap(vd => {
          if (vd.type === "modified") {
            return [
              `- ${changedText(`Vault ${vd.name || JSON.stringify(vd)}`)}`,
              ...(vd.fieldChanges || []).map(fc => `  ${formatValueChangeLine(fc.key, fc.oldVal, fc.newVal)}`),
            ];
          }
          if (vd.type === "added") {
            return [
              `- ${addedText(`Vault ${vd.name || JSON.stringify(vd)}`)}`,
              ...(vd.fields ? Object.entries(vd.fields).map(([key, value]) => `  ${formatAddedLine(key, value)}`) : []),
            ];
          }
          if (vd.type === "removed") return [`- ${removedText(`Vault ${vd.name || JSON.stringify(vd)}`)}`];
          return [`- ${changedText(`Vault ${vd.name || JSON.stringify(vd)}`)}`];
        }),
      ].filter(Boolean)
    : [];

  const changes = [
    `📦 Flap 全站前端资源变更：影响页面 ${affectedUrls.length} 个，修改资源 ${assetStats.modified} 个`,
    `本地初筛：${localSignalSummary}`,
    `意图判断：${intentSummary.verdict}；${intentSummary.intent}；置信度 ${intentSummary.confidence}`,
    `资源范围：${resourceScope}`,
    "",
    "受影响页面：",
    ...affectedUrls.map(url => `- ${url}`),
    hasCardSignals ? "" : "",
    hasCardSignals ? "卡片展示信号：" : "",
    ...cardSignalLines,
    uiSignalLines.length || codeIntentLines.length ? "" : "",
    uiSignalLines.length || codeIntentLines.length ? "UI/实现信号（仅 Diff）:" : "",
    ...codeIntentLines,
    ...uiSignalLines,
  ].filter(Boolean);

  const content = buildFlapCardContent({
    primaryTitle: "重点变更",
    primary: cardSignalLines,
    scope: [affectedPageLinks],
    detailsTitle: "资源统计",
    details: [formatFlapResourceStats(assetStats)],
    ai: "AI 分析异步生成中，变更已先推送。",
  });

  const fullDiffLines = [
    "【Flap 全站前端资源变更】",
    `影响页面: ${affectedUrls.length} 个`,
    ...affectedUrls.map(url => `- ${url}`),
    "",
    substantiveFileNames.length ? `资源文件: ${substantiveFileNames.join(", ")}` : "资源文件: 未提取到明确文件名",
    noiseFileNames.length ? `构建噪音文件: ${noiseFileNames.join(", ")}` : "",
    "",
    ...assetOnlyNotifications.flatMap((n) => {
      const lines = [`【页面明细】${n.url}`];
      if (n.meta?.fullDiffLines?.length) lines.push(...n.meta.fullDiffLines);
      else lines.push(...(n.changes || []));
      return lines.concat("");
    }),
  ].filter(line => line !== "");

  return {
    url: "https://flap.sh",
    title: `${titlePrefix}Flap 全站前端资源变更`,
    template: "orange",
    changes,
    content,
    meta: { ...emptyFlapChangeMeta(), assetStats, fullDiffLines },
    moduleContext: "Flap.sh 全站前端资源变更",
    skipAi: false,
    useFullDiffForAi: true,
    skipBusinessPriorityTitle: true,
    snapshotUpdates: assetOnlyNotifications.flatMap(n => n.snapshotUpdates || (n.snapshotUpdate ? [n.snapshotUpdate] : [])),
  };
}

function coalesceFlapNotifications(notifications, options = {}) {
  const result = [];
  const assetOnly = [];
  const sharedResourceGroups = new Map();
  for (const notification of notifications || []) {
    if (isFlapAssetOnlyNotification(notification)) {
      assetOnly.push(notification);
    } else if (isSharedResourceChangeCandidate(notification)) {
      const key = resourceCoreBusinessFingerprint(notification) || resourceChangeFingerprint(notification);
      if (!sharedResourceGroups.has(key)) sharedResourceGroups.set(key, []);
      sharedResourceGroups.get(key).push(notification);
    } else if (hasExtractableSharedResourceChange(notification)) {
      const sharedNotification = extractSharedResourceNotification(notification);
      const key = resourceCoreBusinessFingerprint(sharedNotification) || resourceChangeFingerprint(sharedNotification);
      if (!sharedResourceGroups.has(key)) sharedResourceGroups.set(key, []);
      sharedResourceGroups.get(key).push(sharedNotification);
      const pageNotification = stripSharedResourceNotification(notification);
      if (hasNotificationPayload(pageNotification)) result.push(pageNotification);
    } else {
      result.push(notification);
    }
  }
  for (const group of sharedResourceGroups.values()) {
    if (group.length > 1) result.push(buildSiteWideAssetNotification(group, options));
    else result.push(...group);
  }
  if (assetOnly.length > 0) result.push(buildSiteWideAssetNotification(assetOnly, options));
  return result;
}

function applyBusinessPriorityTitle(notification, { titlePrefix = "" } = {}) {
  if (notification.skipBusinessPriorityTitle) return notification;
  const biz = detectBusinessPriority(notification.changes || []);
  if (biz.hit) {
    notification.title = `${titlePrefix}⚡ 重点变更：${biz.keywords.slice(0, 3).join("/")}`;
    notification.template = "red";
  }
  return notification;
}

function enrichExistingCardContentWithAi(content, summary) {
  const placeholder = "AI 分析异步生成中，变更已先推送。";
  if (String(content || "").includes(placeholder)) {
    return String(content).replace(placeholder, summary);
  }
  return `${content}\n\n---\n\n**AI 分析:**\n${summary}`;
}

function buildFlapFullDiff({ diffTitle = "=== Flap.sh 详细 Diff ===", url = "", changes = [], meta = {} } = {}) {
  const detailLines = Array.isArray(meta?.fullDiffLines) && meta.fullDiffLines.length > 0
    ? meta.fullDiffLines
    : changes;
  return [
    diffTitle,
    `URL: ${url}`,
    `时间: ${ts()}`,
    "=".repeat(50),
    "",
    ...(detailLines || []),
  ].join("\n");
}

async function sendFlapChangeNotification(notification, { moduleContext = "Flap.sh 页面变更", diffTitle = "=== Flap.sh 详细 Diff ===", titlePrefix = "" } = {}) {
  const n = applyBusinessPriorityTitle(notification, { titlePrefix });
  if (n.meta.assetStats && n.meta.i18nDiffs) n.meta.assetStats.i18nDiffs = n.meta.i18nDiffs;
  const briefingInput = buildBriefingInput(n.url, n.changes, n.meta.assetStats, n.meta.caStoreVaultDiffs);
  const cardContent = n.content || buildCardBriefing(n.url, null, n.meta.assetStats, n.meta.textChangeCount, n.meta.i18nChangeCount, n.meta.i18nDiffs, n.meta.textChanges, n.meta.caStoreVaultDiffs);
  appendHistory("flap-page", n.title, cardContent.slice(0, 300), n.changes.join("\n"));
  const fullDiff = buildFlapFullDiff({ diffTitle, url: n.url, changes: n.changes, meta: n.meta });
  const diffFilePath = saveDiffLocally(n.title, fullDiff);
  const aiInput = n.skipAi ? briefingInput : fullDiff;
  const cardOpts = { diffButtonText: "下载完整 DIFF" };
  await sendNotificationMaybeAi({ title: n.title, content: cardContent, template: n.template, moduleContext: n.moduleContext || moduleContext, aiInput, enrichFn: (summary) => {
    if (n.content) return enrichExistingCardContentWithAi(n.content, summary);
    return buildCardBriefing(n.url, summary, n.meta.assetStats, n.meta.textChangeCount, n.meta.i18nChangeCount, n.meta.i18nDiffs, n.meta.textChanges, n.meta.caStoreVaultDiffs);
  }, diffFilePath, url: n.url, skipAi: n.skipAi, cardOpts });
  return n;
}

/**
 * 保存 diff 详情到本地文件（不直接展开在飞书卡片正文中）
 * @param {string} title - 通知标题（用于文件名）
 * @param {string} diffText - 完整 diff 文本内容
 * @returns {string|null} 本地文件路径，内容过短时返回 null
 */
function classifyFlapDiffFilePrefix(title = "") {
  const text = String(title || "");
  if (/手动检测/.test(text)) return "flap_manual";
  if (/全站|资源/.test(text)) return "flap_site";
  if (/金库|Vault|CAstore|Factory/i.test(text)) return "flap_vault";
  return "flap_page";
}

function saveDiffLocally(title, diffText) {
  if (!diffText || diffText.length < 50) return null;
  try {
    const diffDir = join(__dirname, "diffs");
    if (!existsSync(diffDir)) mkdirSync(diffDir, { recursive: true });
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
    const fileName = `${classifyFlapDiffFilePrefix(title)}_${dateStr}.txt`;
    const filePath = join(diffDir, fileName);
    writeFileSync(filePath, diffText, "utf-8");
    log(`[Diff 文件] 已保存: ${filePath} (${diffText.length} 字)`);
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
    log(`[Diff 文件] 保存失败：${err.message}`);
    return null;
  }
}

/* ══════════════════════════════════════════
   AI 总结（共享 ai-client，多模型热切换）
   ══════════════════════════════════════════ */

import { AI, aiSummarize as _aiSummarizeBase } from "../shared/ai-client.mjs";

const AI_CONFIG = AI; // 兼容旧代码引用

const AI_SYSTEM_PROMPT = `你是 Flap.sh 变更监控分析师。输入通常是详细 diff，可能包含大量未变化页面上下文、CSS class、构建 hash 和资源噪音。
任务：只根据 diff 中旧值/新值、新增/删除行，提炼真实业务变化；不要把上下文里同时存在的内容误判为变化。
重点看：Vault/fee/dividend/constraints/enabled、税率/时长/默认值/取值区间、UI/i18n 文案、功能逻辑、链上参数、路由。
输出中文，不超过 260 字：
**判定:** 纯构建噪音/有业务变化/新增功能
**核心变化:** 用 1-3 条写清“改前 → 改后”；如取值区间、开关提示等未变，请明确写“未变化”。
**影响:** 1 句说明可能影响；纯噪音写“无业务影响”。
禁止编造 diff 中不存在的字段、数值、功能或链上结果。`;

const CA_STORE_VAULT_AI_PROMPT = `根据金库名字、文案和链接，用中文介绍用途和注意点。
不要编造收益率、TVL、链上数据或未给出的参数。不超过 90 字。`;

const AI_BRIEFING_INPUT_LIMIT = 6000; // 给 AI 的输入上限（提升以容纳完整 i18n 文案列表）

async function aiSummarize(diffContent, moduleContext = "", _retries = 1) {
  return _aiSummarizeBase(diffContent, AI_SYSTEM_PROMPT, moduleContext, { retries: _retries, maxTokens: 320 });
}

async function aiIntroduceCaStoreVault(input, moduleContext = "", _retries = 1) {
  return _aiSummarizeBase(input, CA_STORE_VAULT_AI_PROMPT, moduleContext, { retries: _retries, maxTokens: 180 });
}

/**
 * 构建极简 AI 简报输入 — 只提取结构化统计，不喂原始字符串 diff
 */
function buildBriefingInput(url, changes, assetStats, caStoreVaultDiffs = []) {
  const lines = [];
  lines.push(`URL: ${url}`);
  lines.push(`时间: ${ts()}`);
  lines.push("");

  // 资源统计
  if (assetStats) {
    lines.push(`资源变更: 不变 ${assetStats.unchanged} | 重命名 ${assetStats.renamed} | 修改 ${assetStats.modified} | 新增 ${assetStats.added} | 移除 ${assetStats.removed}`);
    lines.push(`噪音文件: ${assetStats.noiseFiles} 个 (${assetStats.noiseCount} 处变量重命名/部署ID轮换)`);
    lines.push(`实质变更文件: ${assetStats.substantiveFiles} 个 (${assetStats.substantiveCount} 处)`);
    const intent = buildResourceIntentSummary(assetStats);
    lines.push(`意图判断: ${intent.verdict}；${intent.intent}；置信度 ${intent.confidence}`);
  }

  if (caStoreVaultDiffs.length > 0) {
    lines.push("");
    lines.push("CAstore 金库变更:");
    for (const d of caStoreVaultDiffs) {
      const label = d.area ? `${d.area} / ${d.name}` : d.name;
      if (d.type === "reordered") {
        lines.push("  排序变化:");
        lines.push(`    旧顺序: ${(d.oldOrder || []).join(" → ")}`);
        lines.push(`    新顺序: ${(d.newOrder || []).join(" → ")}`);
      } else if (d.type === "modified") {
        lines.push(`  修改: ${label}`);
        lines.push(`    旧文案: ${d.oldDescription || "(空)"}`);
        lines.push(`    新文案: ${d.newDescription || "(空)"}`);
      } else if (d.type === "added") {
        lines.push(`  新增: ${label} — ${d.newDescription || "(空)"}`);
      } else if (d.type === "removed") {
        lines.push(`  删除: ${label} — ${d.oldDescription || "(空)"}`);
      }
    }
  }

  // 配置变更（过滤 minifier 噪音后再给 AI）
  if (assetStats?.configDiffs?.length > 0) {
    const businessDiffs = assetStats.configDiffs.filter(isBusinessConfigDiff);
    if (businessDiffs.length > 0) {
      lines.push("");
      lines.push("配置参数变更:");
      for (const cd of businessDiffs) {
        lines.push(`  ${cd.field}: ${cd.oldVal} → ${cd.newVal} (${cd.file})`);
      }
    }
  }

  // Vault 变更
  if (assetStats?.vaultDiffs?.length > 0) {
    lines.push("");
    lines.push("Vault 配置变更:");
    for (const vd of assetStats.vaultDiffs) {
      if (vd.type === "modified") {
        lines.push(`  ${vd.name}: ${vd.fieldChanges.map(fc => `${fc.key}: ${fc.oldVal} → ${fc.newVal}`).join(", ")}`);
      } else {
        lines.push(`  新增: ${vd.name}`);
      }
    }
  }

  const uiSignals = summarizeUiStyleDiffs(assetStats?.uiStyleDiffs || []);
  if (uiSignals.length > 0) {
    lines.push("");
    lines.push("UI/样式信号:");
    for (const signal of uiSignals.slice(0, 12)) {
      lines.push(`  ${signal.label}: ${signal.added} 新增 / ${signal.removed} 删除；范围: ${signal.contextLabel}(${signal.contextConfidence})；可能意图: ${signal.intent}；证据: ${signal.evidence}；文件: ${signal.files.slice(0, 4).join(", ")}`);
    }
  }

  const codeSignals = summarizeCodeIntentDiffs(assetStats?.codeIntentDiffs || []);
  if (codeSignals.length > 0) {
    lines.push("");
    lines.push("实现意图信号（不可读代码片段已折叠）:");
    for (const signal of codeSignals.slice(0, 12)) {
      lines.push(`  ${signal.label}: ${signal.added} 新增 / ${signal.removed} 删除；可能意图: ${signal.intent}；证据: ${signal.evidence}；文件: ${signal.files.slice(0, 4).join(", ")}`);
    }
  }

  // 文案变更
  const textChanges = changes.filter(c => c.includes("文案"));
  if (textChanges.length > 0) {
    lines.push("");
    lines.push("文案变更:");
    for (const tc of textChanges.slice(0, 10)) {
      lines.push(`  ${tc}`);
    }
  }

  // i18n UI 文案变更（完整 key+value 详情，给 AI 做功能归纳）
  if (assetStats?.i18nDiffs && assetStats.i18nDiffs.length > 0) {
    const i18nDiffs = assetStats.i18nDiffs;
    const added = i18nDiffs.filter(d => d.type === "added");
    const modified = i18nDiffs.filter(d => d.type === "modified");
    const removed = i18nDiffs.filter(d => d.type === "removed");
    lines.push("");
    lines.push("i18n UI 文案变更（中文）:");
    if (added.length > 0) {
      lines.push(`  新增 ${added.length} 条:`);
      for (const d of added.slice(0, 40)) {
        lines.push(`    + ${d.key}: "${d.value}"`);
      }
      if (added.length > 40) lines.push(`    ... 还有 ${added.length - 40} 条`);
    }
    if (modified.length > 0) {
      lines.push(`  修改 ${modified.length} 条:`);
      for (const d of modified.slice(0, 20)) {
        lines.push(`    ~ ${d.key}: "${d.oldValue}" → "${d.newValue}"`);
      }
    }
    if (removed.length > 0) {
      lines.push(`  删除 ${removed.length} 条:`);
      for (const d of removed.slice(0, 10)) {
        lines.push(`    - ${d.key}: "${d.value}"`);
      }
    }
  }

  // 实质变更的文件名列表
  if (assetStats?.substantiveFileNames?.length > 0) {
    lines.push("");
    lines.push("实质变更文件: " + assetStats.substantiveFileNames.join(", "));
  }

  // JS 文件中的业务文案变更（给 AI 分析功能变化）
  if (assetStats?.jsTextDiffs?.length > 0) {
    const added = assetStats.jsTextDiffs.filter(d => d.type === "added");
    const removed = assetStats.jsTextDiffs.filter(d => d.type === "removed");
    lines.push("");
    lines.push("JS 文件中的业务文案变更:");
    if (removed.length > 0) {
      lines.push(`  移除 ${removed.length} 条:`);
      for (const d of removed.slice(0, 20)) {
        const truncText = d.text.length > 100 ? d.text.slice(0, 100) + "…" : d.text;
        lines.push(`    - ${truncText}`);
      }
    }
    if (added.length > 0) {
      lines.push(`  新增 ${added.length} 条:`);
      for (const d of added.slice(0, 20)) {
        const truncText = d.text.length > 100 ? d.text.slice(0, 100) + "…" : d.text;
        lines.push(`    + ${truncText}`);
      }
    }
  }

  let result = lines.join("\n");
  if (result.length > AI_BRIEFING_INPUT_LIMIT) {
    result = result.slice(0, AI_BRIEFING_INPUT_LIMIT) + "\n\n... (已截断)";
  }
  return result;
}

/**
 * 保存详细 diff 到文件，返回文件路径
 */
function saveDetailedDiff(url, changes) {
  try {
    mkdirSync(CONFIG.snapshotDir, { recursive: true });
    const safeName = url.replace(/[^a-zA-Z0-9]/g, "_");
    const time = new Date().toISOString().replace(/[:.]/g, "-");
    const file = join(CONFIG.snapshotDir, `${safeName}_${time}_diff.txt`);
    const content = [
      `=== 详细变更记录 ===`,
      `URL: ${url}`,
      `时间: ${ts()}`,
      ``,
      ...changes,
    ].join("\n");
    writeFileSync(file, content, "utf-8");
    log(`[详细 Diff] 已保存: ${file} (${content.length} 字)`);
    return file;
  } catch (err) {
    log(`[详细 Diff] 保存失败：${err.message}`);
    return null;
  }
}

function normalizeCardText(value) {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\n+$/, "");
}

function cardValueOrEmpty(value) {
  const text = normalizeCardText(value);
  return text === "" ? "(空)" : text;
}

function escapeCardText(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function cardText(value) {
  return escapeCardText(cardValueOrEmpty(value));
}

function colorCardText(value, color) {
  return `<font color="${color}">${escapeCardText(cardValueOrEmpty(value))}</font>`;
}

function addedText(value) {
  return colorCardText(value, "green");
}

function removedText(value) {
  return colorCardText(value, "red");
}

function changedText(value) {
  return colorCardText(value, "orange");
}

function indentCardText(value, indent = "    ", color = "") {
  return normalizeCardText(value)
    .split("\n")
    .map(line => `${indent}${color ? colorCardText(line, color) : line}`)
    .join("\n");
}

function formatAddedLine(label, value = "") {
  const suffix = value === "" || value === undefined || value === null ? "" : `: ${addedText(value)}`;
  return `- ${addedText(label)}${suffix}`;
}

function formatRemovedLine(label, value = "") {
  const suffix = value === "" || value === undefined || value === null ? "" : `: ${removedText(value)}`;
  return `- ${removedText(label)}${suffix}`;
}

function formatValueChangeLine(label, oldValue, newValue) {
  return `- ${cardText(label)}：${removedText(oldValue)} → ${addedText(newValue)}`;
}

function buildCardUrlPrefix(url, content) {
  if (!url) return "";
  const text = String(content || "");
  if (text.includes(url)) return "";
  return `- 页面: ${flapPageLink(url)}\n\n`;
}

function compactTextDiffItems(items = [], max = 12) {
  const arr = Array.isArray(items) ? items : [];
  return { visible: arr, hidden: 0 };
}

function splitDiffPairText(text) {
  const m = String(text || "").match(/^(.*?):\s*(.*?)\s*→\s*(.*)$/);
  if (!m) return null;
  return { key: m[1].trim(), oldVal: m[2].trim(), newVal: m[3].trim() };
}

function pushDiffPairLines(lines, key, oldVal, newVal, indent = "  ") {
  lines.push(`${indent}${formatValueChangeLine(key, oldVal, newVal)}`);
}

function normalizeInsightText(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\[[^\]]+\]:[^\s]+/g, " ")
    .replace(/\b(?:flex|grid|rounded|border|bg|text|font|leading|transition|opacity|shadow|ring|focus|hover|data|span|style|class|button|type|role|slider|radix)[-\w:[\]#%.!/>="'()]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function textChangeCorpus(textChanges = [], side = "new") {
  const parts = [];
  for (const c of textChanges || []) {
    if (!c) continue;
    if (side === "old") {
      if (c.oldText) parts.push(c.oldText);
      if (c.type === "removed" && c.text) parts.push(c.text);
      if (c.ctxBefore) parts.push(c.ctxBefore);
      if (c.ctxAfter) parts.push(c.ctxAfter);
    } else {
      if (c.newText) parts.push(c.newText);
      if (c.type === "added" && c.text) parts.push(c.text);
      if (c.ctxBefore) parts.push(c.ctxBefore);
      if (c.ctxAfter) parts.push(c.ctxAfter);
    }
  }
  return normalizeInsightText(parts.join(" "));
}

function parseDurationDays(text) {
  const patterns = [
    /Anti-Farmer Protection Duration\s+(\d+)\s*day\(s\)/i,
    /Default:\s*(\d+)\s*days?/i,
  ];
  for (const pattern of patterns) {
    const m = String(text || "").match(pattern);
    if (m) return Number.parseInt(m[1], 10);
  }
  return null;
}

function parseProtectionRange(text) {
  const s = String(text || "");
  const m = s.match(/Min:\s*(\d+)\s*days?\s*·\s*Max:\s*(?:1\s*year\s*)?\(?(\d+)\s*days?\)?/i);
  if (!m) return "";
  return `最小值 ${m[1]} 天 / 最大值 ${m[2]} 天（1 年）`;
}

function extractAntiFarmerDurationInsight(textChanges = []) {
  const oldText = textChangeCorpus(textChanges, "old");
  const newText = textChangeCorpus(textChanges, "new");
  const combined = `${oldText} ${newText}`;
  if (!/Anti-Farmer Protection Duration/i.test(combined)) return null;

  const oldDays = parseDurationDays(oldText);
  const newDays = parseDurationDays(newText);
  const addedDescription = "This feature ensures that trades occur primarily in the tax liquidity pool during the protection period, improving the stability of token tax revenue.";
  const disableHint = "Set 0 days to disable the protection period.";
  const rangeOld = parseProtectionRange(oldText);
  const rangeNew = parseProtectionRange(newText);
  const range = rangeNew || rangeOld;

  if (oldDays == null && newDays == null && !newText.includes(addedDescription)) return null;

  return {
    title: "防巨鲸薅币保护周期（Anti-Farmer Protection Duration）",
    oldDays,
    newDays,
    range,
    rangeChanged: Boolean(rangeOld && rangeNew && rangeOld !== rangeNew),
    addedDescription: !oldText.includes(addedDescription) && newText.includes(addedDescription) ? addedDescription : "",
    disableHintUnchanged: oldText.includes(disableHint) && newText.includes(disableHint),
  };
}

function extractTextChangeInsights(textChanges = []) {
  return [extractAntiFarmerDurationInsight(textChanges)].filter(Boolean);
}

function formatTextChangeInsights(lines, insights = []) {
  for (const insight of insights) {
    lines.push(`- **${cardText(insight.title)}**`);
    if (insight.oldDays != null && insight.newDays != null && insight.oldDays !== insight.newDays) {
      lines.push(`  ${formatValueChangeLine("默认时长", `${insight.oldDays} 天`, `${insight.newDays} 天`)}`);
    } else if (insight.newDays != null) {
      lines.push(`  - 默认时长：${cardText(`${insight.newDays} 天`)}`);
    }
    if (insight.range) {
      const suffix = insight.rangeChanged ? "" : "，区间规则未改动";
      lines.push(`  - 取值区间：${cardText(insight.range + suffix)}`);
    }
    if (insight.addedDescription) {
      lines.push(`  ${formatAddedLine("新增说明", insight.addedDescription)}`);
    }
    if (insight.disableHintUnchanged) {
      lines.push(`  - 开关提示未改：${cardText("Set 0 days to disable the protection period.")}`);
    }
  }
}

/**
 * 构建飞书卡片简报内容。
 * 展示优先级：页面 → 重点变更 → 资源统计 → AI。
 */
function buildCardBriefing(url, aiSummary, assetStats, textChangeCount, i18nChangeCount, i18nDiffs, textChanges, caStoreVaultDiffs = []) {
  const lines = [];

  const scopeLines = [
    url ? `- 页面: ${flapPageLink(url)}` : "",
  ];
  const detailLines = [
    formatFlapResourceStats(assetStats),
  ];

  if (caStoreVaultDiffs.length > 0) {
    lines.push(`**🏦 CAstore 金库变更（${caStoreVaultDiffs.length} 项）：**`);
    for (const d of caStoreVaultDiffs) {
      const label = d.area ? `${d.area} / ${d.name}` : d.name;
      if (d.type === "reordered") {
        lines.push("  🔀 **金库排序变化**");
        lines.push(`  旧顺序: ${(d.oldOrder || []).join(" → ")}`);
        lines.push(`  新顺序: ${(d.newOrder || []).join(" → ")}`);
      } else if (d.type === "modified") {
        lines.push(`  ✏️ **${label}**`);
        if (d.oldName && d.newName && d.oldName !== d.newName) lines.push(`  名称: ${d.oldName} → ${d.newName}`);
        lines.push(`  ${formatValueChangeLine("文案", d.oldDescription, d.newDescription)}`);
      } else if (d.type === "added") {
        lines.push(`  ${formatAddedLine(`新增金库: ${label}`, d.newDescription)}`);
      } else if (d.type === "removed") {
        lines.push(`  ${formatRemovedLine(`移除金库: ${label}`, d.oldDescription)}`);
      }
    }
    lines.push("");
  }

  // ═══ 1. Vault 变更（最高优先级）═══
  if (assetStats?.vaultDiffs?.length > 0) {
    lines.push(`**🏦 Vault 配置变更（${assetStats.vaultDiffs.length} 项）：**`);
    for (const vd of assetStats.vaultDiffs) {
      if (vd.type === "modified") {
        lines.push(`  ✏️ **${vd.name}**`);
        for (const fc of vd.fieldChanges) {
          pushDiffPairLines(lines, fc.key, fc.oldVal, fc.newVal, "    ");
        }
      } else if (vd.type === "added") {
        lines.push(`  ${formatAddedLine(`新增: ${vd.name}`)}`);
        for (const [key, value] of Object.entries(vd.fields || {})) {
          lines.push(`    ${formatAddedLine(key, value)}`);
        }
      }
    }
    lines.push("");
  }

  // ═══ 2. 页面文案变更（提升优先级，展示实际内容）═══
  if (textChanges && textChanges.length > 0) {
    const textInsights = extractTextChangeInsights(textChanges);
    const modified = textChanges.filter(c => c.type === "modified");
    const added = textChanges.filter(c => c.type === "added");
    const removed = textChanges.filter(c => c.type === "removed");
    if (textInsights.length > 0) {
      lines.push(`**✏️ 页面文案变更（归纳 + 完整原文，共 ${textChanges.length} 处）：**`);
      formatTextChangeInsights(lines, textInsights);
      lines.push("");
    } else {
      lines.push(`**✏️ 页面文案变更（${textChanges.length} 处）：**`);
    }
    if (modified.length > 0) {
      lines.push("");
      lines.push("**修改：**");
      for (const c of modified) {
        lines.push(`- 原：${removedText(c.oldText)}`);
        lines.push(`  新：${addedText(c.newText)}`);
        if (c.ctxBefore) lines.push(`  上文：${cardText(c.ctxBefore)}`);
      }
    }
    if (added.length > 0) {
      lines.push("");
      lines.push("**新增：**");
      for (const c of added) {
        lines.push(formatAddedLine(c.text));
        if (c.ctxBefore) lines.push(`  上文：${cardText(c.ctxBefore)}`);
      }
    }
    if (removed.length > 0) {
      lines.push("");
      lines.push("**移除：**");
      for (const c of removed) {
        lines.push(formatRemovedLine(c.text));
        if (c.ctxBefore) lines.push(`  上文：${cardText(c.ctxBefore)}`);
      }
    }
    lines.push("");
  } else if (textChangeCount > 0) {
    lines.push(`**✏️ 文案变更：** ${textChangeCount} 处`);
    lines.push("");
  }

  // ═══ 3. UI 文案变更（i18n）— 直接展示中文文案 ═══
  if (i18nDiffs && i18nDiffs.length > 0) {
    const added = i18nDiffs.filter(d => d.type === "added");
    const modified = i18nDiffs.filter(d => d.type === "modified");
    const removed = i18nDiffs.filter(d => d.type === "removed");

    lines.push(`**📝 UI 文案变更（i18n，共 ${i18nDiffs.length} 处）：**`);
    if (added.length > 0) {
      lines.push(`  **新增 ${added.length} 条：**`);
      for (const d of added) {
        lines.push(`  ${formatAddedLine(d.key, d.value)}`);
      }
    }
    if (modified.length > 0) {
      lines.push(`  **修改 ${modified.length} 条：**`);
      for (const d of modified) {
        lines.push(`  ${formatValueChangeLine(d.key, d.oldValue, d.newValue)}`);
      }
    }
    if (removed.length > 0) {
      lines.push(`  **删除 ${removed.length} 条：**`);
      for (const d of removed) {
        lines.push(`  ${formatRemovedLine(d.key, d.value)}`);
      }
    }
    lines.push("");
  } else if (i18nChangeCount > 0) {
    lines.push(`**📝 i18n 变更：** ${i18nChangeCount} 处`);
    lines.push("");
  }

  // ═══ 4. JS 文件中的业务文案变更（Vault 描述、功能文案等）═══
  if (assetStats?.jsTextDiffs?.length > 0) {
    const added = assetStats.jsTextDiffs.filter(d => d.type === "added");
    const removed = assetStats.jsTextDiffs.filter(d => d.type === "removed");
    // 尝试配对：removed 和 added 中相似的文案（可能是修改）
    const paired = [];
    const unpairedAdded = [];
    const usedRemoved = new Set();
    for (const a of added) {
      let bestIdx = -1, bestScore = 0;
      for (let i = 0; i < removed.length; i++) {
        if (usedRemoved.has(i)) continue;
        // 简单相似度：共同词占比
        const aWords = new Set(a.text.split(/\s+/).map(w => w.toLowerCase()));
        const rWords = removed[i].text.split(/\s+/).map(w => w.toLowerCase());
        const common = rWords.filter(w => aWords.has(w)).length;
        const score = common / Math.max(aWords.size, rWords.length);
        if (score > bestScore && score > 0.3) { bestScore = score; bestIdx = i; }
      }
      if (bestIdx >= 0) {
        usedRemoved.add(bestIdx);
        paired.push({ oldText: removed[bestIdx].text, newText: a.text });
      } else {
        unpairedAdded.push(a);
      }
    }
    const unpairedRemoved = removed.filter((_, i) => !usedRemoved.has(i));

    const totalItems = paired.length + unpairedAdded.length + unpairedRemoved.length;
    if (totalItems > 0) {
      lines.push(`**💬 功能文案变更（${totalItems} 处）：**`);
      if (paired.length > 0) {
        const { visible, hidden } = compactTextDiffItems(paired, 8);
        lines.push("");
        lines.push("**修改：**");
        for (const p of visible) {
          lines.push(`- 原：${removedText(p.oldText)}`);
          lines.push(`  新：${addedText(p.newText)}`);
        }
        if (hidden) lines.push(`- 还有 ${hidden} 处修改，见 Diff 详情`);
      }
      if (unpairedAdded.length > 0) {
        const { visible, hidden } = compactTextDiffItems(unpairedAdded, 8);
        lines.push("");
        lines.push("**新增：**");
        for (const a of visible) lines.push(formatAddedLine(a.text));
        if (hidden) lines.push(`- 还有 ${hidden} 处新增，见 Diff 详情`);
      }
      if (unpairedRemoved.length > 0) {
        const { visible, hidden } = compactTextDiffItems(unpairedRemoved, 8);
        lines.push("");
        lines.push("**移除：**");
        for (const r of visible) lines.push(formatRemovedLine(r.text));
        if (hidden) lines.push(`- 还有 ${hidden} 处移除，见 Diff 详情`);
      }
      lines.push("");
    }
  }

  // ═══ 5. 业务配置变更（过滤 minifier 噪音后）═══
  if (assetStats?.configDiffs?.length > 0) {
    // 二次过滤：卡片层面只展示真实业务字段
    const businessDiffs = assetStats.configDiffs.filter(isBusinessConfigDiff);
    if (businessDiffs.length > 0) {
      lines.push(`**🔧 配置变更（${businessDiffs.length} 项）：**`);
      for (const cd of businessDiffs) {
        pushDiffPairLines(lines, cd.field, cd.oldVal, cd.newVal, "  ");
      }
      lines.push("");
    }
  }

  return buildFlapCardContent({
    primaryTitle: "重点变更",
    primary: lines,
    scope: scopeLines,
    detailsTitle: "资源统计",
    details: detailLines,
    ai: aiSummary || "AI 分析异步生成中，变更已先推送。",
  });
}

/* ══════════════════════════════════════════
   变更历史记录（history.jsonl）
   ══════════════════════════════════════════ */

const HISTORY_FILE = join(__dirname, "history.jsonl");
const HISTORY_MAX_LINES = 500;

let historyWriteQueue = Promise.resolve();
let historyLineCount = -1; // -1 = 未初始化

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

/* ── HTTP 请求（含反风控 + 5xx 静默重试）── */
async function fetchSafe(url, opts = {}) {
  const backoffKey = getBackoffKey(url);
  if (shouldBackoff(backoffKey)) throw new Error(`[退避中] ${backoffKey}`);
  const maxRetries = 2;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CONFIG.fetchTimeoutMs);
    try {
      const res = await fetch(url, { ...opts, signal: ctrl.signal });
      if (res.status === 429 || res.status === 403) {
        try { await res.text(); } catch {}
        recordFail(backoffKey, res.status);
        throw new Error(`HTTP ${res.status} (风控)`);
      }
      if (res.status >= 500) {
        try { await res.text(); } catch {}
        if (attempt < maxRetries) {
          await sleep(1_000 * (attempt + 1));
          continue;
        }
        recordFail(backoffKey, res.status);
        throw new Error(`HTTP ${res.status} (服务端错误，重试${maxRetries}次仍失败)`);
      }
      if (res.ok) recordSuccess(backoffKey);
      return res;
    } catch (err) {
      if (err.name === "AbortError") {
        if (attempt < maxRetries) {
          await sleep(1_000 * (attempt + 1));
          continue;
        }
        throw new Error(`请求超时 (重试${maxRetries}次): ${url}`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

async function fetchPage(url) {
  const res = await fetchSafe(url, { headers: browserHeaders() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

/**
 * 从 JS/CSS 文件内容中提取有意义的字符串（用于内容级 diff）
 */
function normalizeAddress(value) {
  const m = String(value || "").match(/0x[a-fA-F0-9]{40}/);
  return m ? m[0].toLowerCase() : "";
}

function hexToNumber(value) {
  if (!value) return 0;
  return Number.parseInt(String(value), 16);
}

function numberToHex(value) {
  return `0x${Math.max(0, Number(value) || 0).toString(16)}`;
}

const preferredBscRpcIndexByKey = new Map();
const bscRpcHealthByKey = new Map();

function bscRpcPreferenceKey(method, params = []) {
  if (method === "eth_call") return "eth_call";
  if (method === "eth_getLogs") {
    const filter = params[0] || {};
    const from = hexToNumber(filter.fromBlock);
    const to = hexToNumber(filter.toBlock);
    return from > 0 && to > 0 && to - from > 100 ? "eth_getLogs:history" : "eth_getLogs:realtime";
  }
  if (method === "eth_getBlockByNumber" || method === "eth_getTransactionByHash" || method === "eth_getTransactionReceipt") return "block_data";
  if (method === "eth_getCode" || method === "eth_getStorageAt") return "contract_state";
  return method || "default";
}

function bscRpcBatchPreferenceKey(calls = []) {
  const methods = [...new Set(calls.map(call => call?.method || "unknown"))].sort();
  return `batch:${methods.join("+") || "empty"}`;
}

function bscRpcTimeoutMs(method, params = []) {
  if (method === "eth_getLogs") {
    const filter = params[0] || {};
    const from = hexToNumber(filter.fromBlock);
    const to = hexToNumber(filter.toBlock);
    if (from > 0 && to > 0 && to - from > 100) return CONFIG.factoryPoolMonitor.rpcCatchupTimeoutMs;
  }
  if (method === "eth_getBlockByNumber" && params[1]) return CONFIG.factoryPoolMonitor.rpcCatchupTimeoutMs;
  return CONFIG.factoryPoolMonitor.rpcTimeoutMs;
}

function orderedBscRpcIndexes(preferenceKey) {
  const health = bscRpcHealthByKey.get(preferenceKey) || new Map();
  const preferredIndex = preferredBscRpcIndexByKey.get(preferenceKey);
  return CONFIG.bscRpcUrls.map((_, index) => index).sort((left, right) => {
    const leftHealth = health.get(left);
    const rightHealth = health.get(right);
    const leftLatency = leftHealth?.failedAt && Date.now() - leftHealth.failedAt > 60_000 ? null : leftHealth?.latencyMs;
    const rightLatency = rightHealth?.failedAt && Date.now() - rightHealth.failedAt > 60_000 ? null : rightHealth?.latencyMs;
    const leftScore = leftLatency ?? (left === preferredIndex ? 250 : 1_000 + left * 10);
    const rightScore = rightLatency ?? (right === preferredIndex ? 250 : 1_000 + right * 10);
    return leftScore - rightScore;
  });
}

function updateBscRpcHealth(preferenceKey, index, latencyMs, failed = false) {
  const health = bscRpcHealthByKey.get(preferenceKey) || new Map();
  const previous = health.get(index) || {};
  health.set(index, failed
    ? {
        ...previous,
        failures: (previous.failures || 0) + 1,
        failedAt: Date.now(),
        latencyMs: Math.max(previous.latencyMs || 0, 5_000),
      }
    : {
        failures: 0,
        failedAt: 0,
        latencyMs: previous.latencyMs == null ? latencyMs : Math.round(previous.latencyMs * 0.7 + latencyMs * 0.3),
      });
  bscRpcHealthByKey.set(preferenceKey, health);
}

function resetBscRpcHealth() {
  preferredBscRpcIndexByKey.clear();
  bscRpcHealthByKey.clear();
}

function dedupeBscLogs(logs = []) {
  const unique = new Map();
  for (const logEntry of logs) {
    const key = `${String(logEntry?.transactionHash || "").toLowerCase()}:${String(logEntry?.logIndex || "").toLowerCase()}`;
    if (key === ":") continue;
    if (!unique.has(key)) unique.set(key, logEntry);
  }
  return [...unique.values()].sort((left, right) =>
    hexToNumber(left.blockNumber) - hexToNumber(right.blockNumber)
    || hexToNumber(left.transactionIndex) - hexToNumber(right.transactionIndex)
    || hexToNumber(left.logIndex) - hexToNumber(right.logIndex));
}

async function executeBscGetLogsRequest(params, options = {}) {
  const preferenceKey = bscRpcPreferenceKey("eth_getLogs", params);
  const indexes = orderedBscRpcIndexes(preferenceKey);
  const timeoutMs = bscRpcTimeoutMs("eth_getLogs", params);
  const controllers = [];
  let settled = false;
  let emptyVotes = 0;
  let finished = 0;
  const errors = [];
  const payload = { jsonrpc: "2.0", id: 1, method: "eth_getLogs", params };

  return await new Promise((resolve, reject) => {
    const finish = (value, index, latencyMs) => {
      if (settled) return;
      settled = true;
      preferredBscRpcIndexByKey.set(preferenceKey, index);
      updateBscRpcHealth(preferenceKey, index, latencyMs);
      for (const controller of controllers) controller.abort();
      resolve(value);
    };
    const maybeReject = () => {
      if (settled || finished < indexes.length) return;
      settled = true;
      const errorSummary = [...new Set(errors.map(error => error?.message).filter(Boolean))].join("；");
      const message = emptyVotes === 1
        ? `eth_getLogs 仅一个节点返回空结果，未达到双节点一致${errorSummary ? `；其他节点：${errorSummary}` : ""}`
        : errors.at(-1)?.message || "所有 BSC RPC 节点均不可用";
      const error = new Error(message);
      error.rpcErrors = errors.map(item => item?.message).filter(Boolean);
      reject(error);
    };

    indexes.forEach((index, position) => {
      void (async () => {
        if (position > 0) await sleep(CONFIG.factoryPoolMonitor.rpcHedgeDelayMs * position);
        if (settled) return;
        const controller = new AbortController();
        controllers.push(controller);
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const startedAt = Date.now();
        try {
          const response = await fetch(CONFIG.bscRpcUrls[index], {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            signal: controller.signal,
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const json = await response.json();
          if (json?.error) throw new Error(json.error.message || JSON.stringify(json.error));
          if (!Array.isArray(json?.result)) throw new Error("eth_getLogs 返回非数组");
          const latencyMs = Math.max(1, Date.now() - startedAt);
          const logs = dedupeBscLogs(json.result);
          if (logs.length > 0) {
            finish(logs, index, latencyMs);
            return;
          }
          emptyVotes++;
          updateBscRpcHealth(preferenceKey, index, latencyMs);
          if (emptyVotes >= 2) finish([], index, latencyMs);
        } catch (error) {
          if (!settled) {
            errors.push(error);
            updateBscRpcHealth(preferenceKey, index, Date.now() - startedAt, true);
          }
        } finally {
          clearTimeout(timer);
          finished++;
          maybeReject();
        }
      })();
    });
  });
}

async function executeBscRpcRequest(payload, preferenceKey, timeoutMs, validateResponse = null) {
  const indexes = orderedBscRpcIndexes(preferenceKey);
  const controllers = [];
  let settled = false;
  const attempts = indexes.map((index, position) => (async () => {
    if (position > 0) await sleep(CONFIG.factoryPoolMonitor.rpcHedgeDelayMs * position);
    if (settled) throw new Error("RPC 请求已由更快节点完成");
    const controller = new AbortController();
    controllers.push(controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();
    try {
      const response = await fetch(CONFIG.bscRpcUrls[index], {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const json = await response.json();
      if (!Array.isArray(json) && json?.error) throw new Error(json.error.message || JSON.stringify(json.error));
      if (validateResponse) validateResponse(json);
      if (settled) throw new Error("RPC 请求已由更快节点完成");
      settled = true;
      const latencyMs = Math.max(1, Date.now() - startedAt);
      preferredBscRpcIndexByKey.set(preferenceKey, index);
      updateBscRpcHealth(preferenceKey, index, latencyMs);
      for (const other of controllers) if (other !== controller) other.abort();
      return json;
    } catch (error) {
      if (!settled) updateBscRpcHealth(preferenceKey, index, Date.now() - startedAt, true);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  })());
  try {
    return await Promise.any(attempts);
  } catch (error) {
    const messages = (error?.errors || []).map(item => item?.message).filter(message => message && !message.includes("更快节点完成"));
    throw new Error(messages.at(-1) || error?.message || "所有 BSC RPC 节点均不可用");
  } finally {
    settled = true;
    for (const controller of controllers) controller.abort();
  }
}

async function bscRpcCall(method, params = [], options = {}) {
  if (method === "eth_getLogs") {
    const logs = await executeBscGetLogsRequest(params, options);
    if (options.requireResult && logs == null) throw new Error("eth_getLogs 返回空结果");
    return logs;
  }
  const preferenceKey = bscRpcPreferenceKey(method, params);
  const json = await executeBscRpcRequest(
    { jsonrpc: "2.0", id: 1, method, params },
    preferenceKey,
    bscRpcTimeoutMs(method, params),
    json => {
      if (json?.error) throw new Error(json.error.message || JSON.stringify(json.error));
      if (options.requireResult && json?.result == null) throw new Error(`${method} 返回空结果`);
    },
  );
  return json.result;
}

async function bscRpcBatch(calls = [], options = {}) {
  if (calls.length === 0) return [];
  if (calls.length === 1) return [await bscRpcCall(calls[0].method, calls[0].params, { requireResult: options.requireAllResults })];
  const payload = calls.map((call, i) => ({ jsonrpc: "2.0", id: i + 1, method: call.method, params: call.params || [] }));
  const preferenceKey = bscRpcBatchPreferenceKey(calls);
  const timeoutMs = Math.max(...calls.map(call => bscRpcTimeoutMs(call.method, call.params || [])));
  const json = await executeBscRpcRequest(payload, preferenceKey, timeoutMs, response => {
    if (!Array.isArray(response)) throw new Error("Batch RPC 返回非数组");
    if (!options.requireAllResults) return;
    const byId = new Map(response.map(item => [item.id, item]));
    if (payload.some(item => !byId.get(item.id) || byId.get(item.id).error || byId.get(item.id).result == null)) {
      throw new Error("Batch RPC 存在空结果");
    }
  });
  if (!Array.isArray(json)) throw new Error("Batch RPC 返回非数组");
  const byId = new Map(json.map(item => [item.id, item]));
  const results = payload.map(item => {
    const result = byId.get(item.id);
    if (!result || result.error) return null;
    return result.result;
  });
  if (options.requireAllResults && results.some(result => result == null)) throw new Error("Batch RPC 存在空结果");
  return results;
}

const ERC20_NAME_SELECTOR = "0x06fdde03";
const ERC20_SYMBOL_SELECTOR = "0x95d89b41";
const ERC20_DECIMALS_SELECTOR = "0x313ce567";

function cleanTokenMetadataText(value) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
}

function decodeErc20MetadataText(value) {
  const hex = String(value || "").replace(/^0x/i, "");
  if (!/^[a-fA-F0-9]{64,}$/.test(hex)) return "";
  let dataHex = hex.slice(0, 64);
  try {
    const offset = Number(BigInt(`0x${hex.slice(0, 64)}`));
    const lengthOffset = offset * 2;
    if (Number.isSafeInteger(offset) && offset >= 0 && lengthOffset + 64 <= hex.length) {
      const length = Number(BigInt(`0x${hex.slice(lengthOffset, lengthOffset + 64)}`));
      const dataOffset = lengthOffset + 64;
      if (Number.isSafeInteger(length) && length >= 0 && dataOffset + length * 2 <= hex.length) {
        dataHex = hex.slice(dataOffset, dataOffset + length * 2);
      }
    }
    const bytes = Uint8Array.from(dataHex.match(/.{2}/g) || [], byte => Number.parseInt(byte, 16));
    return cleanTokenMetadataText(new TextDecoder().decode(bytes).replace(/\0+$/g, ""));
  } catch {
    return "";
  }
}

function decodeErc20Decimals(value) {
  const hex = String(value || "").replace(/^0x/i, "");
  if (!/^[a-fA-F0-9]{64,}$/.test(hex)) return null;
  try {
    const decimals = Number(BigInt(`0x${hex.slice(0, 64)}`));
    return Number.isInteger(decimals) && decimals >= 0 && decimals <= 255 ? decimals : null;
  } catch {
    return null;
  }
}

function parseGoPlusTokenMetadata(payload, addresses = []) {
  const result = payload?.result && typeof payload.result === "object" ? payload.result : {};
  const metadata = {};
  for (const address of addresses) {
    const key = normalizeAddress(address);
    const item = result[key] || result[address] || {};
    const name = cleanTokenMetadataText(item.token_name);
    const symbol = cleanTokenMetadataText(item.token_symbol);
    if (name || symbol) metadata[key] = { name, symbol, source: "goplus" };
  }
  return metadata;
}

async function resolveErc20MetadataViaRpc(tokens, rpcBatchFn) {
  const calls = tokens.flatMap(address => [
    { method: "eth_call", params: [{ to: address, data: ERC20_NAME_SELECTOR }, "latest"] },
    { method: "eth_call", params: [{ to: address, data: ERC20_SYMBOL_SELECTOR }, "latest"] },
    { method: "eth_call", params: [{ to: address, data: ERC20_DECIMALS_SELECTOR }, "latest"] },
  ]);
  const values = await rpcBatchFn(calls);
  const metadata = {};
  tokens.forEach((address, index) => {
    const name = decodeErc20MetadataText(values[index * 3]);
    const symbol = decodeErc20MetadataText(values[index * 3 + 1]);
    const decimals = decodeErc20Decimals(values[index * 3 + 2]);
    if (name || symbol || decimals != null) metadata[address] = { name, symbol, decimals, source: "onchain" };
  });
  return metadata;
}

async function resolveFactoryPoolTokenMetadata(addresses, options = {}) {
  const normalized = [...new Set(addresses.map(normalizeAddress).filter(Boolean))];
  const metadata = {};
  if (normalized.includes(BNB_QUOTE_TOKEN)) {
    metadata[BNB_QUOTE_TOKEN] = { name: "BNB", symbol: "BNB", decimals: 18, source: "native" };
  }
  const tokens = normalized.filter(address => address !== BNB_QUOTE_TOKEN);
  if (tokens.length === 0) return { metadata, errors: [] };

  const errors = [];
  const fetchFn = options.fetchFn || fetch;
  const rpcBatchFn = options.rpcBatchFn || (calls => bscRpcBatch(calls));
  const apiUrl = options.apiUrl || CONFIG.factoryPoolMonitor.tokenMetadataApiUrl;
  const timeoutMs = options.timeoutMs || CONFIG.factoryPoolMonitor.tokenMetadataTimeoutMs;
  const onchainPromise = resolveErc20MetadataViaRpc(tokens, rpcBatchFn)
    .then(value => ({ value, error: null }))
    .catch(error => ({ value: {}, error }));
  if (!options.onchainOnly) {
    try {
      const url = new URL(apiUrl);
      url.searchParams.set("contract_addresses", tokens.join(","));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchFn(url, { headers: { Accept: "application/json" }, signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        Object.assign(metadata, parseGoPlusTokenMetadata(await response.json(), tokens));
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      errors.push(`GoPlus: ${error.name === "AbortError" ? `超时 ${timeoutMs}ms` : error.message}`);
    }
  }

  const onchain = await onchainPromise;
  if (onchain.error) {
    errors.push(`链上元数据: ${onchain.error.message}`);
  } else {
    for (const address of tokens) {
      const fallback = onchain.value[address];
      if (!fallback) continue;
      const current = metadata[address] || { name: "", symbol: "", decimals: null, source: "" };
      metadata[address] = {
        name: current.name || fallback.name,
        symbol: current.symbol || fallback.symbol,
        decimals: fallback.decimals,
        source: current.source ? `${current.source}+onchain` : "onchain",
      };
    }
  }
  return { metadata, errors };
}

async function enrichFactoryPoolTokenMetadata(state, preferredAddresses = []) {
  const now = Date.now();
  const addresses = getFactoryPoolMetadataWorkAddresses(state, preferredAddresses);
  if (addresses.length === 0) return;
  const result = await resolveFactoryPoolTokenMetadata(addresses);
  const updatedAt = new Date().toISOString();
  const nextRetryAt = new Date(now + CONFIG.factoryPoolMonitor.tokenMetadataRetryMs).toISOString();
  for (const address of addresses) {
    const asset = state.assets[address];
    if (!asset) continue;
    const item = result.metadata[address];
    if (item) {
      asset.name = item.name || asset.name || "";
      asset.symbol = item.symbol || asset.symbol || "";
      if (Number.isInteger(item.decimals)) asset.decimals = item.decimals;
      asset.metadataSource = item.source;
      asset.metadataUpdatedAt = updatedAt;
      const metadataComplete = asset.name && asset.symbol && Number.isInteger(asset.decimals);
      asset.metadataNextRetryAt = metadataComplete ? "" : nextRetryAt;
      asset.metadataError = metadataComplete ? "" : result.errors.join("｜") || "ERC20 元数据不完整";
      const candidate = state.candidates?.[address];
      if (candidate) {
        candidate.name = asset.name;
        candidate.symbol = asset.symbol;
        candidate.decimals = asset.decimals;
      }
    } else {
      asset.metadataNextRetryAt = nextRetryAt;
      asset.metadataError = result.errors.join("｜") || "免费 API 与链上调用均未返回名称";
    }
  }
}

function extractRegistryVaultAddressesFromLog(logEntry) {
  const registry = CONFIG.registryMonitor.address;
  if (normalizeAddress(logEntry?.address) !== registry) return [];
  const topic0 = String(logEntry?.topics?.[0] || "").toLowerCase();
  if (CONFIG.registryMonitor.watchedEventTopics.size > 0 && !CONFIG.registryMonitor.watchedEventTopics.has(topic0)) return [];
  const data = String(logEntry?.data || "");
  const found = [];
  for (const m of data.matchAll(/000000000000000000000000([a-fA-F0-9]{40})/g)) {
    const addr = `0x${m[1]}`.toLowerCase();
    if (addr !== "0x0000000000000000000000000000000000000000"
      && !/^0x0{24,}/.test(addr)) {
      found.push(addr);
    }
  }
  return uniqueStrings(found);
}

async function filterContractAddresses(addresses) {
  const unique = uniqueStrings(addresses.map(normalizeAddress).filter(Boolean));
  if (unique.length === 0) return [];
  const codes = await bscRpcBatch(unique.map(addr => ({ method: "eth_getCode", params: [addr, "latest"] })));
  return unique.filter((addr, i) => codes[i] && codes[i] !== "0x");
}

function buildRegistryMonitorContent(events, { fromBlock, toBlock } = {}) {
  const primaryLines = [];
  for (const event of events) {
    primaryLines.push(`- Vault: ${addressLink(event.vault)}`);
    const launchUrl = buildVaultFactoryLaunchUrl(event.vault);
    if (launchUrl) primaryLines.push(`  金库链接: ${flapLink("打开金库", launchUrl)}`);
    primaryLines.push(`  交易: ${txLink(event.txHash)} / 区块: ${blockLink(event.blockNumber)}`);
    primaryLines.push("  状态: 链上已注册");
  }
  const content = buildFlapCardContent({
    summary: [
      `- Vault Portal 发现新金库 ${events.length} 个`,
      `- Vault Portal: ${addressLink(CONFIG.registryMonitor.address)}`,
      `- 扫描区块: ${fromBlock} → ${toBlock}`,
    ],
    primaryTitle: "链上新金库注册",
    primary: primaryLines,
  });
  return content;
}

function buildVaultFactoryLaunchUrl(factory, options = {}) {
  if (!/^0x[a-fA-F0-9]{40}$/.test(String(factory || ""))) return "";
  const chain = options.chain === "robinhood" ? "robinhood" : "bnb";
  return `https://flap.sh/launch?vaultfactory=${factory}&chain=${chain}&lang=zh`;
}

function vaultLaunchLink(factory, label = "打开金库") {
  const url = buildVaultFactoryLaunchUrl(factory);
  return url ? flapLink(label, url) : "";
}

function formatVaultContractLinks(value) {
  return uniqueStrings(String(value || "").split(",").map(item => item.trim()).filter(Boolean))
    .map((address) => {
      const launch = vaultLaunchLink(address);
      return launch ? `${addressLink(address)} / ${launch}` : addressLink(address);
    })
    .join(", ");
}

async function checkFlapRegistryLogs(snapshot, { sendCardFn = sendCardViaApi, titlePrefix = "" } = {}) {
  if (!CONFIG.registryMonitor.enabled) return { changed: false, sent: false };
  const state = snapshot.registryMonitor || (snapshot.registryMonitor = {});
  const latest = hexToNumber(await bscRpcCall("eth_blockNumber", []));
  const safeLatest = Math.max(0, latest - CONFIG.registryMonitor.confirmations);
  state.latestBlock = latest;
  state.safeLatestBlock = safeLatest;

  if (!state.lastBlock) {
    state.lastBlock = Math.max(0, safeLatest - CONFIG.registryMonitor.bootstrapLookbackBlocks);
    state.knownVaults = state.knownVaults || {};
    log(`[Flap Vault Portal] 初始化区块游标：${state.lastBlock}（确认块=${safeLatest}）`);
    return { changed: true, sent: false, initialized: true };
  }
  if (state.lastBlock >= safeLatest) return { changed: false, sent: false };

  const fromBlock = state.lastBlock + 1;
  const toBlock = Math.min(safeLatest, state.lastBlock + CONFIG.registryMonitor.maxBlocksPerRun);
  const logs = await bscRpcCall("eth_getLogs", [{
    address: CONFIG.registryMonitor.address,
    fromBlock: numberToHex(fromBlock),
    toBlock: numberToHex(toBlock),
  }]);

  const candidates = [];
  for (const item of logs || []) {
    for (const addr of extractRegistryVaultAddressesFromLog(item)) {
      candidates.push({
        vault: addr,
        txHash: String(item.transactionHash || "").toLowerCase(),
        blockNumber: hexToNumber(item.blockNumber),
        logIndex: hexToNumber(item.logIndex),
        topic0: String(item.topics?.[0] || "").toLowerCase(),
      });
    }
  }

  const contractSet = new Set(await filterContractAddresses(candidates.map(c => c.vault)));
  state.knownVaults = state.knownVaults || {};
  const newEvents = [];
  for (const event of candidates) {
    if (!contractSet.has(event.vault)) continue;
    if (state.knownVaults[event.vault]) continue;
    state.knownVaults[event.vault] = {
      firstSeenAt: ts(),
      txHash: event.txHash,
      blockNumber: event.blockNumber,
      topic0: event.topic0,
    };
    newEvents.push(event);
  }

  state.lastBlock = toBlock;
  state.lastBlockAt = ts();
  state.lagBlocks = Math.max(0, safeLatest - state.lastBlock);
  if (newEvents.length === 0) return { changed: true, sent: false, events: [] };

  const content = buildRegistryMonitorContent(newEvents, { fromBlock, toBlock });
  const title = `${titlePrefix}Flap 链上金库注册变更`;
  const messageId = await sendAlertCard(sendCardFn, title, content, "red");
  return { changed: true, sent: Boolean(messageId), events: newEvents };
}

function formatFactoryPoolAssetName(asset = {}) {
  const name = asset.quoteToken === BNB_QUOTE_TOKEN ? "BNB" : asset.name || asset.symbol || "名称同步中";
  return asset.symbol && asset.symbol !== name ? `${name} (${asset.symbol})` : name;
}

function formatFactoryPoolAssetStatus(asset = {}) {
  if (!asset.configured) return "已停用";
  if (asset.creationDisabled) return "暂停创建";
  return "支持创建";
}

function snapshotFactoryPoolAssets(state) {
  return new Map(Object.entries(state.assets || {}));
}

function factoryPoolAssetStateFingerprint(asset = {}) {
  if (asset.fingerprint) return asset.fingerprint;
  return JSON.stringify({
    configured: Boolean(asset.configured),
    creationDisabled: Boolean(asset.creationDisabled),
    configurationFingerprint: asset.configurationFingerprint || "",
    values: asset.values || [],
  });
}

function collectFactoryPoolStateChanges(previousAssets, state) {
  const changes = [];
  for (const [quoteToken, current] of Object.entries(state.assets || {})) {
    const previous = previousAssets.get(quoteToken);
    if (previous && factoryPoolAssetStateFingerprint(previous) === factoryPoolAssetStateFingerprint(current)) continue;
    changes.push({
      type: classifyFactoryPoolChange(previous, current),
      previous: previous || null,
      current,
    });
  }
  return changes;
}

function buildFactoryPoolMonitorContent(result) {
  const state = result.state || {};
  const assets = Object.values(state.assets || {});
  const enabledCount = assets.filter(item => item?.effectiveEnabled).length;
  const pausedCount = assets.filter(item => item?.configured && item?.creationDisabled).length;
  const disabledCount = assets.filter(item => item && !item.configured).length;
  const changeCounts = { added: 0, modified: 0, paused: 0, resumed: 0, disabled: 0 };
  for (const change of result.changes || []) changeCounts[change.type] = (changeCounts[change.type] || 0) + 1;
  const summary = [
    `本次变更：新增支持 ${changeCounts.added} 个｜配置修改 ${changeCounts.modified} 个｜暂停 ${changeCounts.paused} 个｜恢复 ${changeCounts.resumed} 个｜停用 ${changeCounts.disabled} 个`,
    `当前资产：支持创建 ${enabledCount} 个｜暂停创建 ${pausedCount} 个｜已停用 ${disabledCount} 个`,
  ];
  const primary = [];
  for (const change of result.changes) {
    const item = change.current;
    const label = {
      added: "新增支持",
      modified: "配置修改",
      paused: "暂停创建",
      resumed: "恢复创建",
      disabled: "停用",
    }[change.type] || "配置修改";
    primary.push(`${label}：${formatFactoryPoolAssetName(item)}`);
    primary.push(`状态：${formatFactoryPoolAssetStatus(item)}`);
    primary.push(`地址：${addressLink(item.quoteToken)}`);
  }
  if (result.implementationChange?.previous) {
    const upgrade = result.implementationChange;
    primary.push("Factory 已升级");
    primary.push(`原地址：${addressLink(upgrade.previous)}`);
    primary.push(`新地址：${addressLink(upgrade.current)}`);
  }
  return buildFlapCardContent({
    summary,
    primaryTitle: "Factory 底池资产链上变更",
    primary,
  });
}

let factoryPoolDeliveryQueue = Promise.resolve();
let factoryPoolDeliveryQueued = false;
let factoryPoolMetadataQueue = Promise.resolve();
let factoryPoolStateWriteQueue = Promise.resolve();

function withFactoryPoolStateWrite(operation) {
  const job = factoryPoolStateWriteQueue.then(operation, operation);
  factoryPoolStateWriteQueue = job.catch(() => undefined);
  return job;
}

async function recordFactoryPoolWsHealth(state, snapshot, saveStateFn = saveFactoryPoolState) {
  if (!state || !snapshot) return;
  await withFactoryPoolStateWrite(() => {
    const previous = state.wssHealth && typeof state.wssHealth === "object"
      ? state.wssHealth
      : createFactoryPoolWsHealth();
    state.wssHealth = {
      ...previous,
      ...snapshot,
      endpoints: snapshot.endpoints || previous.endpoints || {},
      backfill: previous.backfill || createFactoryPoolWsHealth().backfill,
    };
    saveStateFn(CONFIG.factoryPoolMonitor.stateFile, state);
  });
}

async function recordFactoryPoolWsBackfill(state, patch, saveStateFn = saveFactoryPoolState) {
  await withFactoryPoolStateWrite(() => {
    const health = state.wssHealth && typeof state.wssHealth === "object"
      ? state.wssHealth
      : createFactoryPoolWsHealth();
    health.backfill = { ...createFactoryPoolWsHealth().backfill, ...(health.backfill || {}), ...patch };
    state.wssHealth = health;
    saveStateFn(CONFIG.factoryPoolMonitor.stateFile, state);
  });
}

function cloneFactoryPoolState(state) {
  return structuredClone(state);
}

function mergeUniqueFactoryPoolRecords(current = [], incoming = [], keyFn = item => JSON.stringify(item)) {
  const merged = new Map();
  for (const item of [...current, ...incoming]) merged.set(keyFn(item), item);
  return [...merged.values()];
}

function mergeFactoryPoolCandidate(current = {}, incoming = {}) {
  const currentBlock = Number(current.lastVerifyBlock) || 0;
  const incomingBlock = Number(incoming.lastVerifyBlock) || 0;
  const currentAttempt = Number(current.lastVerifyAttemptAtMs) || 0;
  const incomingAttempt = Number(incoming.lastVerifyAttemptAtMs) || 0;
  const latest = incomingBlock > currentBlock || (incomingBlock === currentBlock && incomingAttempt >= currentAttempt)
    ? incoming
    : current;
  const firstSeenBlocks = [current.firstSeenBlock, incoming.firstSeenBlock].filter(Number.isFinite);
  const lastSeenBlocks = [current.lastSeenBlock, incoming.lastSeenBlock].filter(Number.isFinite);
  return {
    ...current,
    ...latest,
    firstSeenBlock: firstSeenBlocks.length > 0 ? Math.min(...firstSeenBlocks) : null,
    lastSeenBlock: lastSeenBlocks.length > 0 ? Math.max(...lastSeenBlocks) : null,
    sources: mergeUniqueFactoryPoolRecords(current.sources, incoming.sources, source => source.key),
  };
}

function mergeFactoryPoolVerificationHealth(state) {
  const candidates = Object.values(state.candidates || {});
  const pending = candidates.filter(candidate => candidate?.pendingVerification);
  const failing = pending.filter(candidate => candidate?.lastVerifyError);
  const latestFailure = [...failing].sort((left, right) =>
    (right.lastVerifyAttemptAtMs || 0) - (left.lastVerifyAttemptAtMs || 0))[0];
  const previous = state.verificationHealth || {};
  state.verificationHealth = {
    pendingCount: pending.length,
    failingCount: failing.length,
    consecutiveFailures: failing.reduce((total, candidate) => total + (candidate.consecutiveVerifyFailures || 0), 0),
    lastError: latestFailure?.lastVerifyError || "",
    lastFailureAt: latestFailure?.lastVerifyFailureAt || previous.lastFailureAt || "",
    lastSuccessAt: failing.length === 0 ? (previous.lastSuccessAt || ts()) : (previous.lastSuccessAt || ""),
  };
  state.lastError = failing.length > 0
    ? `候选复核失败 ${failing.length} 个：${latestFailure.quoteToken}｜${latestFailure.lastVerifyError}`
    : "";
}

function mergeFactoryPoolScanState(target, incoming) {
  if (!incoming || incoming === target) return target;
  const targetLatestBlock = Number(target.latestBlock) || 0;
  const incomingLatestBlock = Number(incoming.latestBlock) || 0;
  const maxFields = [
    "latestBlock", "safeLatestBlock", "headLastScannedBlock", "lastScannedBlock",
  ];
  const copyFields = [
    "schemaVersion", "chainId", "proxy", "deploymentBlock", "deploymentTxHash", "deployer",
    "deploymentTxChecked", "deploymentDetection", "implementationSelectors",
    "assetRefreshCursor", "lastRealtimeRunAt", "lastCatchupRunAt", "lastRunAt",
  ];
  for (const field of copyFields) {
    if (incoming[field] !== undefined && incoming[field] !== null && incoming[field] !== "") target[field] = incoming[field];
  }
  if (incoming.currentImplementation && incomingLatestBlock >= targetLatestBlock) {
    target.currentImplementation = incoming.currentImplementation;
  }
  for (const field of maxFields) {
    const values = [target[field], incoming[field]].filter(Number.isFinite);
    if (values.length > 0) target[field] = Math.max(...values);
  }
  target.candidates ||= {};
  for (const [address, candidate] of Object.entries(incoming.candidates || {})) {
    target.candidates[address] = mergeFactoryPoolCandidate(target.candidates[address], candidate);
  }
  target.assets ||= {};
  for (const [address, asset] of Object.entries(incoming.assets || {})) {
    const current = target.assets[address];
    const currentBlock = Number(current?.lastVerifiedBlock) || 0;
    const incomingBlock = Number(asset?.lastVerifiedBlock) || 0;
    const currentVersion = Number(current?.lastVerifiedAtMs) || 0;
    const incomingVersion = Number(asset?.lastVerifiedAtMs) || 0;
    if (!current || incomingBlock > currentBlock || (incomingBlock === currentBlock && incomingVersion >= currentVersion)) {
      target.assets[address] = asset;
    }
  }
  target.recentEvents = Object.fromEntries(mergeUniqueFactoryPoolRecords(
    Object.entries(target.recentEvents || {}).map(([key, event]) => ({ key, ...event })),
    Object.entries(incoming.recentEvents || {}).map(([key, event]) => ({ key, ...event })),
    item => item.key,
  ).sort((left, right) => (right.blockNumber || 0) - (left.blockNumber || 0))
    .slice(0, 20_000)
    .map(({ key, ...event }) => [key, event]));
  target.implementationHistory = mergeUniqueFactoryPoolRecords(
    target.implementationHistory,
    incoming.implementationHistory,
    item => `${item?.blockNumber || ""}:${item?.previous || ""}:${item?.current || ""}`,
  );
  mergeFactoryPoolVerificationHealth(target);
  return target;
}

async function commitFactoryPoolScanState(target, incoming, saveStateFn = saveFactoryPoolState) {
  return await withFactoryPoolStateWrite(() => {
    mergeFactoryPoolScanState(target, incoming);
    saveStateFn(CONFIG.factoryPoolMonitor.stateFile, target);
    return target;
  });
}

async function recordFactoryPoolScanError(state, error, saveStateFn = saveFactoryPoolState) {
  await withFactoryPoolStateWrite(() => {
    state.lastError = error.message;
    state.lastRunAt = ts();
    saveStateFn(CONFIG.factoryPoolMonitor.stateFile, state);
  });
}

function factoryPoolMetadataFingerprint(asset = {}) {
  return `${asset.name || ""}\u0000${asset.symbol || ""}\u0000${asset.decimals ?? ""}\u0000${asset.metadataSource || ""}`;
}

function factoryPoolMetadataStateFingerprint(asset = {}) {
  return [
    factoryPoolMetadataFingerprint(asset),
    asset.metadataUpdatedAt || "",
    asset.metadataNextRetryAt || "",
    asset.metadataError || "",
  ].join("\u0000");
}

function getFactoryPoolMetadataWorkAddresses(state, preferredAddresses = []) {
  const now = Date.now();
  const preferred = preferredAddresses.map(normalizeAddress).filter(Boolean);
  return [...new Set([...preferred, ...Object.keys(state.assets || {}).sort()])]
    .filter(address => {
      const asset = state.assets?.[address];
      if (!asset || (asset.name && asset.symbol && Number.isInteger(asset.decimals))) return false;
      const retryAt = Date.parse(asset.metadataNextRetryAt || "");
      return !Number.isFinite(retryAt) || retryAt <= now;
    })
    .slice(0, 30);
}

async function enrichFactoryPoolMetadataAfterSend({
  state,
  result,
  messageId = "",
  title = "",
  template = "red",
  initialContent = "",
  cardOpts = alertMentionCardOptions(),
  enrichFn = enrichFactoryPoolTokenMetadata,
  patchFn = patchCardViaApi,
  saveFn = saveFactoryPoolState,
  stateFile = CONFIG.factoryPoolMonitor.stateFile,
} = {}) {
  const changes = result?.changes || [];
  const addresses = [...new Set(changes.map(change => normalizeAddress(change.current?.quoteToken)).filter(Boolean))];
  const workAddresses = getFactoryPoolMetadataWorkAddresses(state, addresses);
  if (workAddresses.length === 0) return { patched: false, metadataChanged: false };
  const workingState = cloneFactoryPoolState(state);
  const before = new Map(workAddresses.map(address => [address, factoryPoolMetadataStateFingerprint(state.assets?.[address])]));
  const beforeCard = new Map(addresses.map(address => [address, factoryPoolMetadataFingerprint(state.assets?.[address])]));
  await enrichFn(workingState, workAddresses);
  const stateChanged = workAddresses.some(address =>
    before.get(address) !== factoryPoolMetadataStateFingerprint(workingState.assets?.[address]));
  if (stateChanged) {
    await withFactoryPoolStateWrite(() => {
      for (const address of workAddresses) {
        const metadata = workingState.assets?.[address];
        const current = state.assets?.[address];
        if (!metadata || !current) continue;
        for (const field of ["name", "symbol", "metadataSource", "metadataUpdatedAt", "metadataNextRetryAt", "metadataError"]) {
          current[field] = metadata[field] || "";
        }
        if (Number.isInteger(metadata.decimals)) current.decimals = metadata.decimals;
      }
      saveFn(stateFile, state);
    });
  }

  const metadataChanged = addresses.some(address =>
    beforeCard.get(address) !== factoryPoolMetadataFingerprint(state.assets?.[address]));
  if (!messageId || !metadataChanged) return { patched: false, metadataChanged };

  const enrichedResult = {
    ...result,
    state,
    changes: changes.map(change => ({
      ...change,
      current: state.assets?.[change.current.quoteToken] || change.current,
    })),
  };
  const enrichedContent = buildFactoryPoolMonitorContent(enrichedResult);
  if (isTooLongForSingleCard(initialContent) || isTooLongForSingleCard(enrichedContent)) {
    log(`[Flap Factory 名称] ${title} 为分段卡片，仅更新名称缓存`);
    return { patched: false, metadataChanged };
  }
  await patchFn(messageId, title, enrichedContent, template, undefined, cardOpts);
  log(`[Flap Factory 名称] 已更新原卡片 ${messageId}`);
  return { patched: true, metadataChanged };
}

function scheduleFactoryPoolMetadataEnrichment(options) {
  const preferred = (options?.result?.changes || []).map(change => change.current?.quoteToken);
  if (getFactoryPoolMetadataWorkAddresses(options?.state || {}, preferred).length === 0) {
    return Promise.resolve({ patched: false, metadataChanged: false });
  }
  const job = factoryPoolMetadataQueue.then(
    () => enrichFactoryPoolMetadataAfterSend(options),
    () => enrichFactoryPoolMetadataAfterSend(options),
  );
  const handled = job.catch(error => {
    log(`[Flap Factory 名称] 异步同步失败：${error.message}`);
    return { patched: false, metadataChanged: false, error };
  });
  factoryPoolMetadataQueue = handled.then(() => undefined);
  return handled;
}

async function checkFlapFactoryPools(factoryPoolState, {
  sendCardFn = sendCardViaApi,
  titlePrefix = "",
  suppressNotifications = false,
  scanConfig = {},
  scanFn = runFactoryPoolScan,
  saveStateFn = saveFactoryPoolState,
  scheduleMetadataFn = scheduleFactoryPoolMetadataEnrichment,
  awaitDelivery = true,
} = {}) {
  if (!CONFIG.factoryPoolMonitor.enabled) return { changed: false, sent: false, state: factoryPoolState };
  const workingState = cloneFactoryPoolState(factoryPoolState);
  const previousAssets = snapshotFactoryPoolAssets(workingState);
  const previousImplementation = workingState.currentImplementation || "";
  let result;
  try {
    result = await scanFn({
      state: workingState,
      rpcCall: bscRpcCall,
      persistState: async candidateState => {
        await commitFactoryPoolScanState(factoryPoolState, candidateState, saveStateFn);
      },
      config: { ...CONFIG.factoryPoolMonitor, ...scanConfig },
      log,
    });
  } catch (error) {
    const partialChanges = collectFactoryPoolStateChanges(previousAssets, workingState);
    await withFactoryPoolStateWrite(() => {
      mergeFactoryPoolScanState(factoryPoolState, workingState);
      factoryPoolState.lastError = error.message;
      if (!suppressNotifications) {
        factoryPoolState.pendingChanges = mergePendingFactoryPoolChanges(factoryPoolState.pendingChanges, partialChanges);
        if (previousImplementation && workingState.currentImplementation !== previousImplementation) {
          factoryPoolState.pendingImplementationChange = [...(workingState.implementationHistory || [])].reverse()
            .find(change => change.previous === previousImplementation && change.current === workingState.currentImplementation)
            || { previous: previousImplementation, current: workingState.currentImplementation };
        }
      }
      saveStateFn(CONFIG.factoryPoolMonitor.stateFile, factoryPoolState);
      if (!suppressNotifications && (partialChanges.length > 0 || factoryPoolState.pendingImplementationChange)) {
        log(`[Flap Factory] 扫描后续步骤失败，已保留 ${partialChanges.length} 个待发送状态变更`);
      }
    });
    throw error;
  }
  result = { ...result, state: factoryPoolState };
  if (suppressNotifications) {
    await commitFactoryPoolScanState(factoryPoolState, workingState, saveStateFn);
    void scheduleMetadataFn({ state: factoryPoolState, result });
    return { ...result, sent: false };
  }

  await withFactoryPoolStateWrite(() => {
    mergeFactoryPoolScanState(factoryPoolState, workingState);
    factoryPoolState.pendingChanges = mergePendingFactoryPoolChanges(factoryPoolState.pendingChanges, result.changes);
    if (result.implementationChange?.previous) factoryPoolState.pendingImplementationChange = result.implementationChange;
    saveStateFn(CONFIG.factoryPoolMonitor.stateFile, factoryPoolState);
  });
  if (sendCardFn === sendCardViaApi && !canAttemptFeishuDelivery()) {
    return { ...result, sent: false, deliveryDeferred: true };
  }

  const changeDeliveryKey = change => [
    change.current?.quoteToken || "",
    change.type || "",
    change.previous?.fingerprint || "",
    change.current?.fingerprint || "",
  ].join(":");
  const deliver = async () => {
    const deliveryState = await withFactoryPoolStateWrite(() => {
      const changesToSend = [...factoryPoolState.pendingChanges];
      const implementationToSend = factoryPoolState.pendingImplementationChange;
      const sendingKeys = new Set(changesToSend.map(changeDeliveryKey));
      factoryPoolState.sendingChanges = changesToSend;
      factoryPoolState.sendingImplementationChange = implementationToSend;
      factoryPoolState.pendingChanges = factoryPoolState.pendingChanges
        .filter(change => !sendingKeys.has(changeDeliveryKey(change)));
      if (factoryPoolState.pendingImplementationChange?.previous === implementationToSend?.previous
        && factoryPoolState.pendingImplementationChange?.current === implementationToSend?.current) {
        factoryPoolState.pendingImplementationChange = null;
      }
      saveStateFn(CONFIG.factoryPoolMonitor.stateFile, factoryPoolState);
      return { changesToSend, implementationToSend };
    });
    const { changesToSend, implementationToSend } = deliveryState;
    const shouldNotify = changesToSend.length > 0 || Boolean(implementationToSend?.previous);
    if (!shouldNotify) {
      void scheduleMetadataFn({ state: factoryPoolState, result });
      return { ...result, sent: false };
    }
    const pendingResult = {
      ...result,
      changes: changesToSend,
      implementationChange: implementationToSend,
    };
    const title = `${titlePrefix}Flap Factory 底池资产链上变更`;
    const initialContent = buildFactoryPoolMonitorContent(pendingResult);
    let messageId;
    try {
      messageId = await sendAlertCard(sendCardFn, title, initialContent, "red");
    } catch (error) {
      await withFactoryPoolStateWrite(() => {
        factoryPoolState.pendingChanges = mergePendingFactoryPoolChanges(changesToSend, factoryPoolState.pendingChanges);
        if (!factoryPoolState.pendingImplementationChange?.previous) factoryPoolState.pendingImplementationChange = implementationToSend;
        factoryPoolState.sendingChanges = [];
        factoryPoolState.sendingImplementationChange = null;
        saveStateFn(CONFIG.factoryPoolMonitor.stateFile, factoryPoolState);
      });
      throw error;
    }
    if (!messageId) {
      await withFactoryPoolStateWrite(() => {
        factoryPoolState.pendingChanges = mergePendingFactoryPoolChanges(changesToSend, factoryPoolState.pendingChanges);
        if (!factoryPoolState.pendingImplementationChange?.previous) factoryPoolState.pendingImplementationChange = implementationToSend;
        factoryPoolState.sendingChanges = [];
        factoryPoolState.sendingImplementationChange = null;
        saveStateFn(CONFIG.factoryPoolMonitor.stateFile, factoryPoolState);
      });
      void scheduleMetadataFn({ state: factoryPoolState, result: pendingResult });
      return { ...result, sent: false };
    }
    await withFactoryPoolStateWrite(() => {
      factoryPoolState.sendingChanges = [];
      factoryPoolState.sendingImplementationChange = null;
      saveStateFn(CONFIG.factoryPoolMonitor.stateFile, factoryPoolState);
    });
    void scheduleMetadataFn({
      state: factoryPoolState,
      result: pendingResult,
      messageId,
      title,
      initialContent,
      cardOpts: alertMentionCardOptions(),
    });
    return { ...result, sent: true };
  };
  if (factoryPoolDeliveryQueued) return { ...result, sent: false, deliveryQueued: true };
  factoryPoolDeliveryQueued = true;
  const delivery = factoryPoolDeliveryQueue.then(deliver, deliver);
  factoryPoolDeliveryQueue = delivery.catch(error => {
    log(`[Flap Factory] 待发送通知保留，异步发送失败：${error.message}`);
  }).finally(() => { factoryPoolDeliveryQueued = false; });
  if (awaitDelivery) return await delivery;
  return { ...result, sent: false, deliveryQueued: true };
}

function createFactoryPoolWsFeed({
  urls,
  proxy,
  topics,
  label = "Flap Factory WSS",
  onEvent,
  onSubscribed,
  onStatus,
  logFn = log,
  WebSocketImpl = WebSocket,
  reconnectBaseMs = 1_000,
  reconnectMaxMs = 30_000,
} = {}) {
  const endpoints = (urls || []).map((url, index) => ({
    url,
    index,
    ws: null,
    subscriptionId: "",
    reconnectAttempts: 0,
    reconnectTimer: null,
    awaitingPong: false,
    stopped: false,
    status: "idle",
    connectedAt: "",
    subscribedAt: "",
    lastEventAt: "",
    lastDisconnectedAt: "",
    lastError: "",
    lastErrorAt: "",
  }));
  let heartbeatTimer = null;
  let stopped = false;

  const safeUrl = url => String(url || "").replace(/\/\/[^/@]+@/, "//***@");
  const nowIso = () => new Date().toISOString();

  function snapshot() {
    const endpointStates = Object.fromEntries(endpoints.map(endpoint => [safeUrl(endpoint.url), {
      status: endpoint.status,
      subscribed: Boolean(endpoint.subscriptionId),
      reconnectAttempts: endpoint.reconnectAttempts,
      connectedAt: endpoint.connectedAt,
      subscribedAt: endpoint.subscribedAt,
      lastEventAt: endpoint.lastEventAt,
      lastDisconnectedAt: endpoint.lastDisconnectedAt,
      lastError: endpoint.lastError,
      lastErrorAt: endpoint.lastErrorAt,
    }]));
    const subscribedCount = endpoints.filter(endpoint => endpoint.subscriptionId).length;
    let status = "connecting";
    if (stopped) status = "stopped";
    else if (endpoints.length === 0) status = "disabled";
    else if (subscribedCount === endpoints.length) status = "healthy";
    else if (subscribedCount > 0) status = "degraded";
    else if (endpoints.some(endpoint => endpoint.status === "error" || endpoint.status === "reconnecting")) status = "reconnecting";
    return {
      enabled: endpoints.length > 0,
      configuredCount: endpoints.length,
      subscribedCount,
      status,
      endpoints: endpointStates,
      lastSubscribedAt: endpoints.map(endpoint => endpoint.subscribedAt).filter(Boolean).sort().at(-1) || "",
      lastEventAt: endpoints.map(endpoint => endpoint.lastEventAt).filter(Boolean).sort().at(-1) || "",
      lastDisconnectedAt: endpoints.map(endpoint => endpoint.lastDisconnectedAt).filter(Boolean).sort().at(-1) || "",
      lastError: endpoints.map(endpoint => endpoint.lastError).filter(Boolean).at(-1) || "",
      lastErrorAt: endpoints.map(endpoint => endpoint.lastErrorAt).filter(Boolean).sort().at(-1) || "",
    };
  }

  function emitStatus() {
    void Promise.resolve(onStatus?.(snapshot())).catch(error => {
      logFn(`[${label}] 状态保存失败：${error.message}`);
    });
  }

  function scheduleReconnect(endpoint, reason) {
    if (stopped || endpoint.stopped || endpoint.reconnectTimer) return;
    const delay = Math.min(reconnectMaxMs, reconnectBaseMs * (2 ** Math.min(endpoint.reconnectAttempts, 5)));
    endpoint.reconnectAttempts++;
    endpoint.status = "reconnecting";
    endpoint.lastError = reason || "连接关闭";
    endpoint.lastErrorAt = nowIso();
    emitStatus();
    logFn(`[${label}] ${safeUrl(endpoint.url)} 将在 ${Math.round(delay / 1000)}s 后重连：${reason || "连接关闭"}`);
    endpoint.reconnectTimer = setTimeout(() => {
      endpoint.reconnectTimer = null;
      connect(endpoint);
    }, delay);
  }

  function connect(endpoint) {
    if (stopped || endpoint.stopped) return;
    logFn(`[${label}] 正在连接：${safeUrl(endpoint.url)}`);
    endpoint.status = "connecting";
    emitStatus();
    const ws = new WebSocketImpl(endpoint.url, { handshakeTimeout: 10_000 });
    endpoint.ws = ws;
    endpoint.subscriptionId = "";
    ws.on("open", () => {
      endpoint.awaitingPong = false;
      endpoint.status = "subscribing";
      endpoint.connectedAt = nowIso();
      emitStatus();
      const filter = { address: proxy };
      if (Array.isArray(topics) && topics.length > 0) filter.topics = [topics];
      ws.send(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_subscribe",
        params: ["logs", filter],
      }));
    });
    ws.on("message", raw => {
      endpoint.awaitingPong = false;
      let message;
      try { message = JSON.parse(String(raw)); } catch {
        endpoint.lastError = "消息解析失败";
        endpoint.lastErrorAt = nowIso();
        emitStatus();
        logFn(`[${label}] ${safeUrl(endpoint.url)} 消息解析失败`);
        return;
      }
      if (message.id === 1) {
        if (message.error) {
          endpoint.status = "error";
          endpoint.lastError = message.error.message || JSON.stringify(message.error);
          endpoint.lastErrorAt = nowIso();
          emitStatus();
          logFn(`[${label}] ${safeUrl(endpoint.url)} 订阅失败：${message.error.message || JSON.stringify(message.error)}`);
          try { ws.close(); } catch {}
          return;
        }
        if (message.result) {
          endpoint.subscriptionId = message.result;
          endpoint.reconnectAttempts = 0;
          endpoint.status = "subscribed";
          endpoint.subscribedAt = nowIso();
          endpoint.lastError = "";
          emitStatus();
          logFn(`[${label}] 已订阅 ${safeUrl(endpoint.url)}：${message.result}`);
          void Promise.resolve(onSubscribed?.(endpoint.url)).catch(error => {
            logFn(`[${label}] 启动回扫失败：${error.message}`);
          });
        }
        return;
      }
      const event = message.params?.result;
      if (!event || event.removed) return;
      endpoint.lastEventAt = nowIso();
      emitStatus();
      void Promise.resolve(onEvent?.(event, endpoint.url)).catch(error => {
        logFn(`[${label}] 事件处理失败：${error.message}`);
      });
    });
    ws.on("close", (code, reason) => {
      if (endpoint.ws === ws) endpoint.ws = null;
      endpoint.subscriptionId = "";
      endpoint.status = "reconnecting";
      endpoint.lastDisconnectedAt = nowIso();
      scheduleReconnect(endpoint, `close ${code}${reason ? ` ${reason}` : ""}`);
    });
    ws.on("error", error => {
      endpoint.status = "error";
      endpoint.lastError = error.message;
      endpoint.lastErrorAt = nowIso();
      emitStatus();
      logFn(`[${label}] ${safeUrl(endpoint.url)} 异常：${error.message}`);
      try { ws.terminate(); } catch { try { ws.close(); } catch {} }
    });
    ws.on("pong", () => { endpoint.awaitingPong = false; });
  }

  function start() {
    stopped = false;
    for (const endpoint of endpoints) {
      endpoint.stopped = false;
      connect(endpoint);
    }
    heartbeatTimer = setInterval(() => {
      for (const endpoint of endpoints) {
        if (endpoint.ws?.readyState === WebSocketImpl.OPEN) {
          if (endpoint.awaitingPong) {
            logFn(`[${label}] ${safeUrl(endpoint.url)} 心跳超时，主动重连`);
            endpoint.lastError = "心跳超时";
            endpoint.lastErrorAt = nowIso();
            emitStatus();
            try { endpoint.ws.terminate(); } catch { try { endpoint.ws.close(); } catch {} }
            continue;
          }
          endpoint.awaitingPong = true;
          try { endpoint.ws.ping(); } catch {}
        }
      }
    }, 30_000);
    return api;
  }

  function stop() {
    stopped = true;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    for (const endpoint of endpoints) {
      endpoint.stopped = true;
      if (endpoint.reconnectTimer) clearTimeout(endpoint.reconnectTimer);
      endpoint.reconnectTimer = null;
      try { endpoint.ws?.close(); } catch {}
      endpoint.ws = null;
      endpoint.subscriptionId = "";
      endpoint.awaitingPong = false;
      endpoint.status = "stopped";
    }
    emitStatus();
  }

  const api = {
    start,
    stop,
    snapshot,
  };
  return api;
}

async function processFactoryPoolFeedEvent(factoryPoolState, logEntry, source = "factory-wss") {
  const result = await checkFlapFactoryPools(factoryPoolState, {
    awaitDelivery: false,
    scanFn: async ({ state, rpcCall, persistState, log: scanLog }) => {
      const ingested = await ingestFactoryPoolEvent({
        state,
        logEntry,
        rpcCall,
        persistState,
        source,
        log: scanLog,
      });
      if (!ingested.processed) {
        return { changed: false, changes: [], implementationChange: null, state, ...ingested };
      }
      const quoteToken = ingested.item.quoteToken;
      const asset = state.assets?.[quoteToken];
      if (asset?.configured) {
        const metadataResult = await resolveFactoryPoolTokenMetadata([quoteToken], { onchainOnly: true });
        const metadata = metadataResult.metadata[quoteToken];
        if (metadata) {
          asset.name = metadata.name || asset.name || "";
          asset.symbol = metadata.symbol || asset.symbol || "";
          if (Number.isInteger(metadata.decimals)) asset.decimals = metadata.decimals;
          asset.metadataSource = metadata.source || asset.metadataSource || "";
          asset.metadataUpdatedAt = new Date().toISOString();
          asset.metadataError = metadataResult.errors.join("｜");
          const candidate = state.candidates?.[quoteToken];
          if (candidate) {
            candidate.name = asset.name;
            candidate.symbol = asset.symbol;
            candidate.decimals = asset.decimals;
          }
        }
      }
      const current = state.assets?.[quoteToken];
      const eventConfig = ingested.item.eventConfiguration;
      if (eventConfig) {
        const configText = [
          `enabled=${eventConfig.enabled}`,
          `defaultCurve=${eventConfig.defaultCurve}`,
          `alternativeCurve=${eventConfig.alternativeCurve}`,
          `nativeToQuoteSwapType=${eventConfig.nativeToQuoteSwapType}`,
          `dexId=${eventConfig.dexId}`,
        ].join(", ");
        const eventLabel = eventConfig.enabled === 1 ? "发现新底池" : "底池配置变更";
        log(`[Flap Factory WSS] ${eventLabel}：symbol=${current?.symbol || "未知"}｜name=${current?.name || "未知"}｜address=${quoteToken}｜config={${configText}}｜disabled=${current?.creationDisabled ?? "未知"}｜tx=${ingested.item.txHash}`);
      }
      if (typeof ingested.item.eventDisabled === "boolean") {
        log(`[Flap Factory WSS] 底池状态：symbol=${current?.symbol || "未知"}｜address=${quoteToken}｜disabled=${current?.creationDisabled ?? ingested.item.eventDisabled}｜tx=${ingested.item.txHash}`);
        if (ingested.item.eventDisabled === false) {
          log(`[Flap Factory WSS] 底池开放：symbol=${current?.symbol || "未知"}｜address=${quoteToken}｜tx=${ingested.item.txHash}`);
        }
      }
      const changes = ingested.changes.map(change => ({
        ...change,
        current: state.assets?.[change.current.quoteToken] || change.current,
      }));
      return { ...ingested, changed: changes.length > 0, changes, implementationChange: null, state };
    },
  });
  return result;
}

function createFactoryPoolEventQueue(factoryPoolState, processor = processFactoryPoolFeedEvent) {
  let tail = Promise.resolve();
  const queuedKeys = new Set();
  function enqueue(logEntry, source) {
    const key = factoryPoolEventKey(logEntry);
    if (!key || queuedKeys.has(key)) return Promise.resolve({ duplicate: true });
    queuedKeys.add(key);
    const job = tail.then(() => processor(factoryPoolState, logEntry, source));
    tail = job.catch(error => {
      log(`[Flap Factory WSS] 事件 ${key} 处理失败：${error.message}`);
    }).finally(() => queuedKeys.delete(key));
    return job;
  }
  return { enqueue, drain: () => tail };
}

async function backfillFactoryPoolFeedEvents(
  eventQueue,
  blocks = CONFIG.factoryPoolMonitor.wsBackfillBlocks,
  rpcCall = bscRpcCall,
  proxy = CONFIG.factoryPoolMonitor.proxy,
  chunkBlocks = CONFIG.factoryPoolMonitor.wsBackfillChunkBlocks,
) {
  const latest = hexToNumber(await rpcCall("eth_blockNumber", []));
  const fromBlock = Math.max(0, latest - Math.max(1, blocks) + 1);
  const initialChunkSize = Math.max(100, Math.min(5_000, Number(chunkBlocks) || 2_000));
  const allEvents = [];
  let completedChunks = 0;
  const rangeLimitPattern = /maximum block range|exceed(?:ed)? maximum block range|limit exceeded|block range (?:is )?too (?:large|wide)|query exceeds|too many blocks/i;

  async function readRange(rangeFrom, rangeTo) {
    try {
      const events = await rpcCall("eth_getLogs", [{
        address: proxy,
        fromBlock: numberToHex(rangeFrom),
        toBlock: numberToHex(rangeTo),
        topics: [FACTORY_POOL_STATE_EVENT_TOPICS],
      }]);
      completedChunks++;
      return events || [];
    } catch (error) {
      const rangeSize = rangeTo - rangeFrom + 1;
      const details = [error.message, ...(error.rpcErrors || [])].join("｜");
      if (rangeSize <= 100 || !rangeLimitPattern.test(details)) throw error;
      const middle = Math.floor((rangeFrom + rangeTo) / 2);
      log(`[Flap Factory WSS] 回扫范围受限，自动拆分：${rangeFrom} → ${rangeTo}`);
      const left = await readRange(rangeFrom, middle);
      const right = await readRange(middle + 1, rangeTo);
      return [...left, ...right];
    }
  }

  log(`[Flap Factory WSS] 启动短窗口回扫：${fromBlock} → ${latest}｜分块 ${initialChunkSize}`);
  for (let rangeFrom = fromBlock; rangeFrom <= latest; rangeFrom += initialChunkSize) {
    const rangeTo = Math.min(latest, rangeFrom + initialChunkSize - 1);
    allEvents.push(...await readRange(rangeFrom, rangeTo));
  }
  const ordered = dedupeBscLogs(allEvents).sort((left, right) =>
    hexToNumber(left.blockNumber) - hexToNumber(right.blockNumber)
    || hexToNumber(left.transactionIndex) - hexToNumber(right.transactionIndex)
    || hexToNumber(left.logIndex) - hexToNumber(right.logIndex));
  for (const event of ordered) await eventQueue.enqueue(event, "factory-wss-backfill");
  log(`[Flap Factory WSS] 短窗口回扫完成：${completedChunks} 个分块｜读取 ${ordered.length} 条事件`);
  return { fromBlock, latest, eventCount: ordered.length, chunkCount: completedChunks };
}

function extractStrings(content, ext) {
  const strings = new Set();
  if (ext === "js") {
    const re = /(?:"((?:[^"\\]|\\.){6,})")|(?:'((?:[^'\\]|\\.){6,})')/g;
    let m;
    while ((m = re.exec(content)) !== null) {
      const s = (m[1] || m[2] || "").trim();
      if (!s) continue;
      if (/^[a-f0-9]{20,}$/i.test(s)) continue;
      if (/^[\d.eE+\-\s,]+$/.test(s)) continue;
      if (/^data:/.test(s)) continue;
      if (/\.map$/.test(s)) continue;
      if (/^webpack/.test(s)) continue;
      strings.add(s);
    }
  } else if (ext === "css") {
    const propRe = /--[\w-]{4,}/g;
    let m;
    while ((m = propRe.exec(content)) !== null) strings.add(m[0]);
    const selRe = /([.#][\w-]{6,})/g;
    while ((m = selRe.exec(content)) !== null) strings.add(m[0]);
  }
  const sorted = [...strings].sort();
  const business = sorted.filter(isBusinessAssetString);
  const ordinary = sorted.filter(s => !isBusinessAssetString(s));
  return uniqueStrings([
    ...business,
    ...ordinary.slice(0, Math.max(0, CONFIG.assetStringLimit - business.length)),
  ]);
}

/**
 * 从 JS 内容中提取 Vault/链配置对象
 * 匹配包含 enabled/constraints/showInCAStore 等关键属性的对象字面量
 * 返回 [{ name?, id?, fields: {key: value} }]
 */
function extractVaultConfigs(content) {
  const configs = [];
  // 匹配形如 {id:"xxx",...,enabled:!0,...,constraints:{...},...} 的对象
  // 策略：找 enabled 附近的完整大括号块
  const re = /\{[^{}]*(?:enabled\s*:[^{}]*(?:constraints\s*:\s*\{[^}]*\})?[^{}]*|constraints\s*:\s*\{[^}]*\}[^{}]*enabled\s*:[^{}]*)\}/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const block = m[0];
    const fields = {};
    // 提取 key:value 对
    const kvRe = /(\w+)\s*:\s*(\{[^}]*\}|!?[01]|"[^"]*"|'[^']*'|[\w.]+)/g;
    let kv;
    while ((kv = kvRe.exec(block)) !== null) {
      fields[kv[1]] = kv[2];
    }
    if (Object.keys(fields).length < 3) continue;
    // 尝试提取名称标识
    const name = fields.descriptionI18nKey || fields.id || fields.name || null;
    configs.push({ name, fields });
  }
  // 去重：相同字段集合只保留一个
  const seen = new Set();
  return configs.filter(c => {
    const sig = JSON.stringify(c.fields);
    if (seen.has(sig)) return false;
    seen.add(sig);
    return true;
  });
}

/**
 * 对比两组 Vault 配置，返回结构化变更
 */
function diffVaultConfigs(oldConfigs, newConfigs) {
  if (!oldConfigs?.length || !newConfigs?.length) return [];
  const changes = [];

  // 按 fields 的 key 集合做匹配（忽略值，只看结构相似度）
  const matchedNew = new Set();
  for (const oldC of oldConfigs) {
    const oldKeys = Object.keys(oldC.fields);
    let bestMatch = null, bestScore = 0;
    for (let ni = 0; ni < newConfigs.length; ni++) {
      if (matchedNew.has(ni)) continue;
      const newC = newConfigs[ni];
      const newKeys = Object.keys(newC.fields);
      const common = oldKeys.filter(k => newKeys.includes(k)).length;
      const score = common / Math.max(oldKeys.length, newKeys.length);
      if (score > bestScore && score > 0.5) { bestScore = score; bestMatch = ni; }
    }
    if (bestMatch !== null) {
      matchedNew.add(bestMatch);
      const newC = newConfigs[bestMatch];
      const fieldChanges = [];
      const allKeys = new Set([...Object.keys(oldC.fields), ...Object.keys(newC.fields)]);
      for (const key of allKeys) {
        const oldVal = oldC.fields[key];
        const newVal = newC.fields[key];
        if (oldVal !== newVal) {
          fieldChanges.push({
            key,
            oldVal: oldVal === undefined ? "(无)" : oldVal,
            newVal: newVal === undefined ? "(已删除)" : newVal,
          });
        }
      }
      if (fieldChanges.length > 0) {
        changes.push({
          type: "modified",
          name: newC.name || oldC.name || "(未知配置)",
          fieldChanges,
        });
      }
    }
  }
  // 全新的配置
  for (let ni = 0; ni < newConfigs.length; ni++) {
    if (!matchedNew.has(ni)) {
      changes.push({ type: "added", name: newConfigs[ni].name || "(未知配置)", fields: newConfigs[ni].fields });
    }
  }
  return changes;
}

/* ══════════════════════════════════════════
   Vault Factory 注册监控
   ══════════════════════════════════════════ */

/**
 * 从 JS chunk 内容中提取 vaultTypes 配置数组
 * 匹配 taxVaults:{vaultPortal:"0x...",vaultTypes:[...]} 结构
 * 返回 { vaultPortal: string, factories: [{ name, factory, enabled, showInCAStore, ai, constraints }] }
 */
function findMatchingBracket(content, start, openChar, closeChar) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let i = start; i < content.length; i++) {
    const ch = content[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === openChar) depth++;
    else if (ch === closeChar) depth--;
    if (depth === 0) return i;
  }
  return -1;
}

function parseWebpackExportAliases(jsContent) {
  const aliases = new Map();
  const moduleRe = /(\d+):function\([^)]*\)\{/g;
  let moduleMatch;
  while ((moduleMatch = moduleRe.exec(jsContent)) !== null) {
    const bodyStart = jsContent.indexOf("{", moduleMatch.index);
    const bodyEnd = findMatchingBracket(jsContent, bodyStart, "{", "}");
    if (bodyEnd === -1) continue;
    const body = jsContent.slice(bodyStart + 1, bodyEnd);
    moduleRe.lastIndex = bodyEnd + 1;

    const exportMatch = body.match(/\.d\([^,]+,\s*\{([\s\S]*?)\}\)/);
    if (!exportMatch) continue;
    const exportToLocal = new Map();
    const exportRe = /(\w+)\s*:\s*function\(\)\s*\{\s*return\s+(\w+)\s*\}/g;
    let exportItem;
    while ((exportItem = exportRe.exec(exportMatch[1])) !== null) {
      exportToLocal.set(exportItem[1], exportItem[2]);
    }
    if (exportToLocal.size === 0) continue;

    const localValues = new Map();
    const letRe = /\blet\s+([\s\S]*?);/g;
    let letMatch;
    while ((letMatch = letRe.exec(body)) !== null) {
      const assignRe = /(\w+)\s*=\s*(["'])(.*?)\2/g;
      let assign;
      while ((assign = assignRe.exec(letMatch[1])) !== null) {
        localValues.set(assign[1], assign[3]);
      }
      const arrayAssignRe = /(\w+)\s*=\s*\[((?:(["'])[^"']*\3\s*,?\s*)+)\]/g;
      let arrayAssign;
      while ((arrayAssign = arrayAssignRe.exec(letMatch[1])) !== null) {
        const values = [];
        const stringRe = /(["'])(.*?)\1/g;
        let stringItem;
        while ((stringItem = stringRe.exec(arrayAssign[2])) !== null) values.push(stringItem[2]);
        if (values.length > 0) localValues.set(arrayAssign[1], values.join(","));
      }
    }

    for (const [exportName, localName] of exportToLocal) {
      if (localValues.has(localName)) {
        aliases.set(`${moduleMatch[1]}.${exportName}`, localValues.get(localName));
      }
    }
  }
  return aliases;
}

function extractVaultFactories(jsContent) {
  const marker = /vaultTypes\s*:\s*\[/g;
  const markerMatch = marker.exec(jsContent);
  if (!markerMatch) return null;
  const exportAliases = parseWebpackExportAliases(jsContent);
  const importAliases = new Map();
  const varDeclStart = jsContent.lastIndexOf("var ", markerMatch.index);
  const varDeclEnd = jsContent.indexOf(";", varDeclStart);
  if (varDeclStart !== -1 && varDeclEnd !== -1 && varDeclEnd < markerMatch.index) {
    const decl = jsContent.slice(varDeclStart, varDeclEnd);
    const importRe = /(\w+)\s*=\s*a\((\d+)\)/g;
    let importMatch;
    while ((importMatch = importRe.exec(decl)) !== null) {
      importAliases.set(importMatch[1], importMatch[2]);
    }
  }

  // 找到匹配的 ] 闭合
  let depth = 0;
  const arrStart = markerMatch.index + markerMatch[0].lastIndexOf("[");
  let arrEnd = arrStart;
  let quote = null;
  let escaped = false;
  for (let i = arrStart; i < jsContent.length; i++) {
    const ch = jsContent[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "[") depth++;
    if (ch === "]") depth--;
    if (depth === 0) { arrEnd = i + 1; break; }
  }
  const arrStr = jsContent.substring(arrStart, arrEnd);

  // 提取 vaultPortal 地址
  let vaultPortal = null;
  const vpMatch = jsContent
    .substring(Math.max(0, markerMatch.index - 500), markerMatch.index)
    .match(/vaultPortal\s*:\s*["'](0x[a-fA-F0-9]{40})["']/);
  if (vpMatch) vaultPortal = vpMatch[1];

  const resolveExpression = (expr) => {
    if (!expr) return null;
    const trimmed = expr.trim();
    const quoted = trimmed.match(/^["']([^"']*)["']$/);
    if (quoted) return quoted[1];
    const alias = trimmed.match(/^(\w+)\.(\w+)$/);
    if (alias) {
      const moduleId = importAliases.get(alias[1]);
      if (moduleId) return exportAliases.get(`${moduleId}.${alias[2]}`) || null;
    }
    return null;
  };
  const readFieldExpression = (block, field) => {
    const re = new RegExp(`${field}\\s*:\\s*([^,}]+)`);
    return block.match(re)?.[1]?.trim() || null;
  };
  const readStringField = (block, field) => {
    return resolveExpression(readFieldExpression(block, field));
  };
  const readBoolField = (block, field) => {
    const re = new RegExp(`${field}\\s*:\\s*(!0|!1|true|false)`);
    const value = block.match(re)?.[1];
    if (value == null) return false;
    return value === "!0" || value === "true";
  };
  const readConstraints = (block) => {
    const idx = block.search(/constraints\s*:\s*\{/);
    if (idx === -1) return null;
    const start = block.indexOf("{", idx);
    let localDepth = 0;
    let end = start;
    for (let i = start; i < block.length; i++) {
      if (block[i] === "{") localDepth++;
      else if (block[i] === "}") localDepth--;
      if (localDepth === 0) { end = i + 1; break; }
    }
    const objText = block.slice(start + 1, end - 1);
    const obj = {};
    const kvRe = /(\w+)\s*:\s*(\d+)/g;
    let kv;
    while ((kv = kvRe.exec(objText)) !== null) obj[kv[1]] = parseInt(kv[2], 10);
    return Object.keys(obj).length > 0 ? obj : null;
  };
  const readExtraLegacyFactories = (block) => {
    const extraIdx = block.search(/extra\s*:\s*\{/);
    if (extraIdx === -1) return "";
    const start = block.indexOf("{", extraIdx);
    const end = findMatchingBracket(block, start, "{", "}");
    if (end === -1) return "";
    const extra = block.slice(start + 1, end);
    const literal = extra.match(/legacyFactories\s*:\s*["']([^"']+)["']/);
    if (literal) return literal[1];
    const joined = extra.match(/legacyFactories\s*:\s*(\w+)\.(\w+)\.join\(["']([^"']*)["']\)/);
    if (joined) {
      const moduleId = importAliases.get(joined[1]);
      const value = moduleId ? exportAliases.get(`${moduleId}.${joined[2]}`) : null;
      return value || "";
    }
    return "";
  };

  const objectBlocks = [];
  let objStart = -1;
  depth = 0;
  quote = null;
  escaped = false;
  for (let i = 0; i < arrStr.length; i++) {
    const ch = arrStr[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) objStart = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && objStart >= 0) {
        objectBlocks.push(arrStr.slice(objStart, i + 1));
        objStart = -1;
      }
    }
  }

  const factories = [];
  for (const block of objectBlocks) {
    const factory = readStringField(block, "factory");
    if (!factory || !/^0x[a-fA-F0-9]{40}$/.test(factory)) continue;
    const name = readStringField(block, "name") || readStringField(block, "title") || readStringField(block, "label") || "(未知金库工厂)";
    const descriptionI18nKey = readStringField(block, "descriptionI18nKey");
    const shortDescriptionI18nKey = readStringField(block, "shortDescriptionI18nKey");
    const logo = readStringField(block, "logo");
    const legacyFactories = readExtraLegacyFactories(block);
    factories.push({
      name,
      factory,
      enabled: readBoolField(block, "enabled"),
      showInCAStore: readBoolField(block, "showInCAStore"),
      ai: readBoolField(block, "ai"),
      constraints: readConstraints(block),
      descriptionI18nKey,
      shortDescriptionI18nKey,
      logo,
      legacyFactories,
    });
  }

  if (factories.length === 0) return null;
  return { vaultPortal, factories };
}

/**
 * 对比新旧 vault factory 列表，返回变更
 * oldMap/newMap: { factoryAddress -> { name, enabled, showInCAStore, ai, constraints } }
 */
function diffVaultFactories(oldMap, newMap) {
  const changes = { added: [], removed: [], modified: [] };

  for (const [addr, nv] of Object.entries(newMap)) {
    if (!oldMap[addr]) {
      changes.added.push(nv);
    } else {
      const ov = oldMap[addr];
      const diffs = [];
      if (ov.name !== nv.name) diffs.push(`name: "${ov.name}" → "${nv.name}"`);
      if (ov.enabled !== nv.enabled) diffs.push(`enabled: ${ov.enabled} → ${nv.enabled}`);
      if (ov.showInCAStore !== nv.showInCAStore) diffs.push(`showInCAStore: ${ov.showInCAStore} → ${nv.showInCAStore}`);
      if (ov.ai !== nv.ai) diffs.push(`ai: ${ov.ai} → ${nv.ai}`);
      if (ov.descriptionI18nKey !== nv.descriptionI18nKey) diffs.push(`descriptionI18nKey: ${ov.descriptionI18nKey || ""} → ${nv.descriptionI18nKey || ""}`);
      if (ov.logo !== nv.logo) diffs.push(`logo: ${ov.logo || ""} → ${nv.logo || ""}`);
      if (ov.legacyFactories !== nv.legacyFactories) diffs.push(`legacyFactories: ${ov.legacyFactories || ""} → ${nv.legacyFactories || ""}`);
      if (JSON.stringify(ov.constraints) !== JSON.stringify(nv.constraints)) {
        diffs.push(`constraints: ${JSON.stringify(ov.constraints)} → ${JSON.stringify(nv.constraints)}`);
      }
      if (diffs.length > 0) {
        changes.modified.push({ ...nv, diffs });
      }
    }
  }

  for (const [addr, ov] of Object.entries(oldMap)) {
    if (!newMap[addr]) changes.removed.push(ov);
  }

  return changes;
}

/**
 * 将 factory 列表转换为以地址为 key 的 map（用于持久化和 diff）
 */
function factoryListToMap(factories) {
  const map = {};
  for (const f of factories) {
    if (f.factory === "0x0000000000000000000000000000000000000000") continue;
    map[f.factory] = { ...f, key: f.factory };
  }
  return map;
}

function extractVaultFactoryMapFromFeatures(features) {
  for (const entry of Object.values(features?.assetContents || {})) {
    if (entry.vaultFactories && entry.vaultFactories.factories.length > 0) {
      return factoryListToMap(entry.vaultFactories.factories);
    }
  }
  return null;
}

function pageVaultFactoryWeight(url) {
  if (/\/bnb\/CAstore\b/i.test(url)) return 3;
  if (/\/launch\b/i.test(url)) return 2;
  if (/\/create\b/i.test(url)) return 1;
  return 0;
}

function mergeRoundVaultFactoryMaps(entries = []) {
  const grouped = new Map();
  for (const entry of entries) {
    const map = entry?.map || {};
    for (const [addr, factory] of Object.entries(map)) {
      if (!grouped.has(addr)) grouped.set(addr, []);
      grouped.get(addr).push({
        url: entry.url || "",
        weight: pageVaultFactoryWeight(entry.url || ""),
        factory,
      });
    }
  }

  const merged = {};
  const conflicts = [];
  for (const [addr, items] of grouped) {
    const base = { ...items.slice().sort((a, b) => b.weight - a.weight)[0].factory };
    for (const field of ["name", "enabled", "showInCAStore", "ai"]) {
      const byValue = new Map();
      for (const item of items) {
        const key = JSON.stringify(item.factory[field]);
        const current = byValue.get(key) || { score: 0, urls: [], value: item.factory[field] };
        current.score += Math.max(1, item.weight);
        current.urls.push(item.url);
        byValue.set(key, current);
      }
      const ranked = [...byValue.values()].sort((a, b) => b.score - a.score);
      base[field] = ranked[0].value;
      if (ranked.length > 1) {
        conflicts.push({ factory: addr, name: base.name, field, values: ranked });
      }
    }
    const constraintSource = items
      .filter(item => item.factory.constraints)
      .sort((a, b) => b.weight - a.weight)[0];
    base.constraints = constraintSource?.factory.constraints || null;
    merged[addr] = base;
  }
  return { map: merged, conflicts };
}

function collectRoundVaultFactory(roundEntries, url, features) {
  // Robinhood currently shares frontend chunks with BNB. Do not merge those
  // chain-specific values into the BSC factory state.
  if (/\/robinhood\//i.test(url)) return null;
  const map = extractVaultFactoryMapFromFeatures(features);
  if (map) roundEntries.push({ url, map });
  return map;
}

async function sendRoundVaultFactoryChange({ snapshot, roundVaultFactoryEntries, titlePrefix = "", sendCardFn = sendCardViaApi } = {}) {
  if (!roundVaultFactoryEntries?.length) return { sent: false, changed: false };
  const { map: currentVFMap, conflicts } = mergeRoundVaultFactoryMaps(roundVaultFactoryEntries);
  const oldVFMap = snapshot.vaultFactories || {};
  const hasOldData = Object.keys(oldVFMap).length > 0;
  if (!hasOldData) {
    snapshot.vaultFactories = currentVFMap;
    log(`[金库工厂 VaultFactory] 首次记录 ${Object.keys(currentVFMap).length} 个金库工厂`);
    return { sent: false, changed: true, initialized: true };
  }

  const vfChanges = diffVaultFactories(oldVFMap, currentVFMap);
  const hasVFChanges = vfChanges.added.length > 0 || vfChanges.removed.length > 0 || vfChanges.modified.length > 0;
  if (!hasVFChanges) {
    if (conflicts.length > 0) {
      log(`[金库工厂 VaultFactory] 本轮 ${conflicts.length} 个字段跨页面提取不一致，已按页面优先级稳定合并，未发现最终变更`);
    }
    return { sent: false, changed: false };
  }

  log(`[金库工厂 VaultFactory] 检测到变更：新增 ${vfChanges.added.length}，移除 ${vfChanges.removed.length}，修改 ${vfChanges.modified.length}`);
  const vfContent = formatVaultFactoryChanges(vfChanges);
  const conflictNote = conflicts.length > 0
    ? `\n\n**提取说明**\n- 本轮 ${conflicts.length} 个字段在不同页面资源中不一致，已按 CAstore > launch > create 优先级合并后推送，避免重复震荡。`
    : "";
  const vfTitle = buildVaultFactoryChangeTitle(vfChanges, `🏦 ${titlePrefix}`);
  appendHistory("vault-factory", vfTitle, vfContent.slice(0, 500));
  const vfTemplate = vfChanges.added.length > 0 ? "red" : "orange";
  const vfMsgId = vfChanges.added.length > 0
    ? await sendAlertCard(sendCardFn, vfTitle, `${vfContent}${conflictNote}`, vfTemplate)
    : await sendCardFn(vfTitle, `${vfContent}${conflictNote}`, vfTemplate);
  snapshot.vaultFactories = currentVFMap;
  saveSnapshot(snapshot);
  return { sent: Boolean(vfMsgId), changed: true, changes: vfChanges };
}

function buildOperationalNoticeContent({ status, url, severity = "orange", reason = "", consecutiveFailures = 0, skipped = 0, detail = "" } = {}) {
  return buildFlapCardContent({
    summary: [
      `- 状态: ${status || "Flap 监控状态变化"}`,
      severity ? `- 级别: ${severity}` : "",
      consecutiveFailures ? `- 连续失败: ${consecutiveFailures} 次` : "",
      skipped ? `- 跳过检测: ${skipped} 次` : "",
    ],
    scope: [
      url ? `- 页面: ${flapPageLink(url)}` : "",
    ],
    details: [
      reason ? `- 原因: ${cardText(reason)}` : "",
      detail ? `- 详情:\n${indentCardText(detail, "  ")}` : "",
    ],
  });
}

/**
 * 格式化 vault factory 变更为飞书卡片内容
 */
function formatVaultFactoryChanges(changes) {
  const visibleAdded = changes.added.filter(v => v.showInCAStore);
  const hiddenAdded = changes.added.filter(v => !v.showInCAStore);
  const hiddenModified = changes.modified.filter(v => v.diffs?.some(d => /showInCAStore:\s*true\s*→\s*false/.test(d)));
  const visibleModified = changes.modified.filter(v => v.diffs?.some(d => /showInCAStore:\s*false\s*→\s*true/.test(d)));
  const summary = [
    `- 新增 ${changes.added.length} 个 / 移除 ${changes.removed.length} 个 / 修改 ${changes.modified.length} 个`,
    visibleAdded.length ? `- 新增可见金库 ${visibleAdded.length} 个：${visibleAdded.map(v => v.name).join(", ")}` : "",
    hiddenModified.length ? `- CAStore 下架/隐藏 ${hiddenModified.length} 个：${hiddenModified.map(v => v.name).join(", ")}` : "",
    visibleModified.length ? `- CAStore 上架/可见 ${visibleModified.length} 个：${visibleModified.map(v => v.name).join(", ")}` : "",
  ];
  const primary = [];
  const details = [];
  if (visibleAdded.length > 0) {
    primary.push("- 新玩法/可见金库上线");
    for (const v of visibleAdded) {
      const flags = [];
      flags.push("前端可见");
      if (v.ai) flags.push("AI");
      if (v.enabled) flags.push("已启用");
      else flags.push("已禁用");
      if (v.constraints) flags.push(`约束:${JSON.stringify(v.constraints)}`);
      primary.push(`- ${formatAddedLine(v.name).replace(/^- /, "")}`);
      primary.push(`  Factory: ${addressLink(v.factory)}`);
      if (vaultLaunchLink(v.factory)) primary.push(`  金库链接: ${vaultLaunchLink(v.factory)}`);
      if (v.descriptionI18nKey) primary.push(`  描述键: ${cardText(v.descriptionI18nKey)}`);
      primary.push(`  状态: ${flags.join(" / ")}`);
    }
  }
  if (hiddenAdded.length > 0) {
    details.push("- 新增隐藏金库工厂");
    for (const v of hiddenAdded) {
      const flags = [];
      flags.push("隐藏");
      if (v.ai) flags.push("AI");
      if (v.enabled) flags.push("已启用");
      else flags.push("已禁用");
      if (v.constraints) flags.push(`约束:${JSON.stringify(v.constraints)}`);
      details.push(`  ${formatAddedLine(v.name).replace(/^- /, "")}`);
      details.push(`    Factory: ${addressLink(v.factory)}`);
      if (vaultLaunchLink(v.factory)) details.push(`    金库链接: ${vaultLaunchLink(v.factory)}`);
      if (v.descriptionI18nKey) details.push(`    描述键: ${cardText(v.descriptionI18nKey)}`);
      details.push(`    状态: ${flags.join(" / ")}`);
    }
  }
  if (changes.removed.length > 0) {
    primary.push("- 移除金库工厂");
    for (const v of changes.removed) {
      primary.push(`  ${formatRemovedLine(v.name).replace(/^- /, "")}`);
      primary.push(`    Factory: ${addressLink(v.factory)}`);
    }
  }
  if (changes.modified.length > 0) {
    primary.push("- 金库工厂配置变更");
    for (const v of changes.modified) {
      primary.push(`  ${changedText(v.name)}`);
      primary.push(`    Factory: ${addressLink(v.factory)}`);
      if (vaultLaunchLink(v.factory)) primary.push(`    金库链接: ${vaultLaunchLink(v.factory)}`);
      if (v.descriptionI18nKey) primary.push(`    描述键: ${cardText(v.descriptionI18nKey)}`);
      for (const d of v.diffs) {
        const pair = splitDiffPairText(d);
        if (pair) pushDiffPairLines(primary, pair.key, pair.oldVal, pair.newVal, "    ");
        else primary.push(`    ${d}`);
      }
      if (v.legacyFactories) primary.push(`    legacy: ${formatVaultContractLinks(v.legacyFactories)}`);
    }
  }
  return buildFlapCardContent({
    summary,
    primaryTitle: "重点变更",
    primary: primary.length ? primary : ["- 未发现可见金库上下架，仅有配置或隐藏项变化。"],
    details,
  });
}

function buildVaultFactoryChangeTitle(changes, prefix = "") {
  const visibleAdded = changes.added.filter(v => v.showInCAStore);
  const hiddenAdded = changes.added.filter(v => !v.showInCAStore);
  const hiddenModified = changes.modified.filter(v => v.diffs?.some(d => /showInCAStore:\s*true\s*→\s*false/.test(d)));
  const visibleModified = changes.modified.filter(v => v.diffs?.some(d => /showInCAStore:\s*false\s*→\s*true/.test(d)));
  const names = changes.added.map(v => v.name).join(", ");
  if (visibleAdded.length > 0 && hiddenModified.length > 0) {
    return `${prefix}CAStore 金库变更：新增可见 ${visibleAdded.length} / 下架 ${hiddenModified.length} (${visibleAdded.map(v => v.name).join(", ")})`;
  }
  if (visibleAdded.length > 0) {
    return `${prefix}新增可见金库 (${visibleAdded.map(v => v.name).join(", ")})`;
  }
  if (hiddenModified.length > 0) {
    return `${prefix}CAStore 金库下架 (${hiddenModified.map(v => v.name).join(", ")})`;
  }
  if (visibleModified.length > 0) {
    return `${prefix}CAStore 金库上架 (${visibleModified.map(v => v.name).join(", ")})`;
  }
  if (visibleAdded.length > 0 && hiddenAdded.length > 0) {
    return `${prefix}新增金库工厂：可见 ${visibleAdded.length} 个 / 隐藏 ${hiddenAdded.length} 个 (${names})`;
  }
  if (hiddenAdded.length > 0) {
    return `${prefix}新增隐藏金库工厂 (${hiddenAdded.map(v => v.name).join(", ")})`;
  }
  if (visibleAdded.length > 0) {
    return `${prefix}新增可见金库工厂 (${visibleAdded.map(v => v.name).join(", ")})`;
  }
  return `${prefix}金库工厂配置变更`;
}

/**
 * 批量下载资源文件内容（带并发控制和错开延迟）
 * @param {string[]} assetPaths - 资源路径数组（如 /_next/static/...）
 * @param {string} baseUrl
 * @returns {{ [filename]: { contentHash, size, strings, ext, vaultConfigs? } }}
 */
function planAssetContentDownload(oldFeatures, newFeatures) {
  const oldContents = oldFeatures?.assetContents || {};
  const oldAssetFiles = new Set(oldFeatures?.assetFiles || []);
  const forceJsAnalysis = oldFeatures?.assetAnalysisSchemaVersion !== ASSET_ANALYSIS_SCHEMA_VERSION;
  const reusedContents = {};
  const reuseFilenames = [];
  const toDownload = [];

  for (const path of newFeatures?.assetFiles || []) {
    const filename = assetPathToFilename(path);
    const isJs = filename.endsWith(".js");
    if (oldAssetFiles.has(path) && oldContents[filename] && !(forceJsAnalysis && isJs)) {
      reusedContents[filename] = oldContents[filename];
      reuseFilenames.push(filename);
    } else {
      toDownload.push(path);
    }
  }

  return { reusedContents, reuseFilenames: reuseFilenames.sort(), toDownload };
}

function extractMetadataFieldRuns(content) {
  const fieldPattern = METADATA_SCHEMA_FIELDS.join("|");
  const re = new RegExp(`(?:^|[,{])\\s*["']?(${fieldPattern})["']?\\s*:`, "g");
  const matches = [];
  let match;
  while ((match = re.exec(String(content || ""))) !== null) {
    matches.push({ field: match[1], index: match.index, objectStart: match[0].includes("{") });
  }
  const runs = [];
  let current = [];
  for (const item of matches) {
    const previous = current.at(-1);
    if (previous && (item.objectStart || item.index - previous.index > 900 || current.some(value => value.field === item.field))) {
      if (current.length >= 4) runs.push(current);
      current = [];
    }
    current.push(item);
  }
  if (current.length >= 4) runs.push(current);
  return runs.map(run => run.map(item => item.field));
}

function scoreMetadataSchema(fields, kind) {
  const set = new Set(fields);
  const expected = kind === "output" ? METADATA_OUTPUT_FIELDS : METADATA_INPUT_FIELDS;
  let score = fields.filter(field => expected.has(field)).length * 10;
  if (kind === "output") score += ["name", "symbol", "image"].filter(field => set.has(field)).length * 20;
  else score += ["creator", "description"].filter(field => set.has(field)).length * 20;
  return score;
}

function extractMetadataSchemasFromAsset(content, filename = "") {
  const runs = extractMetadataFieldRuns(content);
  const candidates = [];
  for (const fields of runs) {
    const set = new Set(fields);
    if (set.has("name") && set.has("symbol") && set.has("image")) {
      candidates.push({ kind: "output", orderedFields: fields.filter(field => METADATA_OUTPUT_FIELDS.has(field)), source: filename });
    }
    if (set.has("creator") && set.has("description") && !set.has("image")) {
      candidates.push({ kind: "input", orderedFields: fields.filter(field => METADATA_INPUT_FIELDS.has(field)), source: filename });
    }
  }
  const best = {};
  for (const candidate of candidates) {
    if (candidate.orderedFields.length < 4) continue;
    if (!best[candidate.kind] || scoreMetadataSchema(candidate.orderedFields, candidate.kind) > scoreMetadataSchema(best[candidate.kind].orderedFields, candidate.kind)) {
      best[candidate.kind] = candidate;
    }
  }
  return Object.values(best).sort((left, right) => left.kind.localeCompare(right.kind));
}

function extractContractHintsFromAsset(content, filename = "") {
  const source = String(content || "");
  const hints = [];
  const classifiers = [
    { kind: "swapRegistry", label: "Flap SwapRegistry（前端配置）", proxy: true, key: "swapRegistry|swap_registry" },
    { kind: "vaultPortal", label: "Flap Vault Portal（前端配置）", proxy: true, key: "vaultPortal|vault_portal" },
    { kind: "vaultFactory", label: "Flap Vault Factory（前端配置）", key: "vaultFactory|vault_factory" },
    { kind: "tokenImplementation", label: "Flap 税币实现（前端配置）", key: "tax(?:ed)?TokenImpl|tax_token_impl" },
    { kind: "tokenImplementation", label: "Flap 代币实现（前端配置）", key: "standardTokenImpl|tokenImplV?3|token_implementation" },
    { kind: "factory", label: "Flap Factory（前端配置）", proxy: true, key: "factory" },
  ];
  for (const classifier of classifiers) {
    const assignment = new RegExp(
      `(?:^|[,{;])\\s*(?:[A-Za-z_$][\\w$]*\\.)?["']?(?:${classifier.key})["']?\\s*[:=]\\s*["']?(0x[a-fA-F0-9]{40})`,
      "gi",
    );
    let match;
    while ((match = assignment.exec(source)) !== null) {
      hints.push({
        index: match.index,
        address: match[1].toLowerCase(),
        kind: classifier.kind,
        label: classifier.label,
        proxy: classifier.proxy,
        source: filename,
      });
    }
  }
  return [...new Map(hints.sort((left, right) => left.index - right.index)
    .map(({ index, ...hint }) => [`${hint.kind}:${hint.address}`, hint])).values()];
}

function applyFrontendAssetAnalysis(features) {
  const schemaCandidates = [];
  const contractHints = [];
  for (const entry of Object.values(features?.assetContents || {})) {
    schemaCandidates.push(...(entry.metadataSchemas || []));
    contractHints.push(...(entry.contractHints || []));
  }
  const bestSchemas = {};
  for (const schema of schemaCandidates) {
    const current = bestSchemas[schema.kind];
    const score = scoreMetadataSchema(schema.orderedFields || [], schema.kind);
    if (!current || score > scoreMetadataSchema(current.orderedFields || [], current.kind)
      || (score === scoreMetadataSchema(current.orderedFields || [], current.kind) && String(schema.source).localeCompare(String(current.source)) < 0)) {
      bestSchemas[schema.kind] = schema;
    }
  }
  features.assetAnalysisSchemaVersion = ASSET_ANALYSIS_SCHEMA_VERSION;
  features.metadataSchemas = Object.values(bestSchemas).sort((left, right) => left.kind.localeCompare(right.kind));
  features.metadataSchemaFingerprint = md5(JSON.stringify(features.metadataSchemas.map(schema => [schema.kind, schema.orderedFields])));
  features.contractHints = [...new Map(contractHints.map(hint => [`${hint.kind}:${hint.address}`, hint])).values()]
    .sort((left, right) => `${left.kind}:${left.address}`.localeCompare(`${right.kind}:${right.address}`));
  features.contractHintsFingerprint = md5(JSON.stringify(features.contractHints.map(hint => [hint.kind, hint.address, hint.proxy])));
  return features;
}

function diffMetadataSchemas(oldFeatures, newFeatures) {
  if (oldFeatures?.assetAnalysisSchemaVersion !== ASSET_ANALYSIS_SCHEMA_VERSION
    || newFeatures?.assetAnalysisSchemaVersion !== ASSET_ANALYSIS_SCHEMA_VERSION) return [];
  const oldMap = new Map((oldFeatures.metadataSchemas || []).map(schema => [schema.kind, schema]));
  const newMap = new Map((newFeatures.metadataSchemas || []).map(schema => [schema.kind, schema]));
  const diffs = [];
  for (const kind of new Set([...oldMap.keys(), ...newMap.keys()])) {
    const previous = oldMap.get(kind)?.orderedFields || [];
    const current = newMap.get(kind)?.orderedFields || [];
    if (JSON.stringify(previous) === JSON.stringify(current)) continue;
    diffs.push({
      kind,
      previous,
      current,
      added: current.filter(field => !previous.includes(field)),
      removed: previous.filter(field => !current.includes(field)),
      reordered: previous.length === current.length
        && previous.every(field => current.includes(field))
        && JSON.stringify(previous) !== JSON.stringify(current),
      source: newMap.get(kind)?.source || oldMap.get(kind)?.source || "",
    });
  }
  return diffs;
}

function formatMetadataSchemaDiffs(diffs) {
  const lines = ["Flap 前端 metadata schema 变更："];
  for (const diff of diffs) {
    const label = diff.kind === "input" ? "提交字段" : "输出字段";
    lines.push(`  ${label}${diff.source ? `（${diff.source}）` : ""}`);
    if (diff.added.length) lines.push(`    新增：${diff.added.join(", ")}`);
    if (diff.removed.length) lines.push(`    删除：${diff.removed.join(", ")}`);
    if (diff.reordered) lines.push(`    顺序：${diff.previous.join(" -> ")} => ${diff.current.join(" -> ")}`);
    if (!diff.added.length && !diff.removed.length && !diff.reordered) lines.push(`    ${diff.previous.join(" -> ")} => ${diff.current.join(" -> ")}`);
  }
  return lines;
}

function buildMetadataSchemaWarningContent(url, diffs) {
  return buildFlapCardContent({
    summary: [
      `- 页面: [${url}](${url})`,
      `- metadata schema 变化: ${diffs.length} 组`,
      "- 监控范围: 仅前端字段结构，不执行任何链上操作",
    ],
    primaryTitle: "字段结构变化",
    primary: formatMetadataSchemaDiffs(diffs).slice(1),
    detailsTitle: "处理建议",
    details: ["核对 metadata 构造与官方 pin 返回字段后，再更新发射插件兼容逻辑。"],
  });
}

async function downloadAssetContents(assetPaths, baseUrl = "https://flap.sh", options = {}) {
  const results = {};
  const BATCH = 6;
  const STAGGER = 80;
  const roundAssetCache = options.roundAssetCache || null;
  const fetchAsset = options.fetchAsset || ((url, fetchOptions) => fetchSafe(url, fetchOptions));
  for (let i = 0; i < assetPaths.length; i += BATCH) {
    const batch = assetPaths.slice(i, i + BATCH);
    const tasks = batch.map((path, idx) =>
      sleep(idx * STAGGER).then(async () => {
        try {
          const url = baseUrl + path;
          const cacheKey = url.split("?")[0];
          if (roundAssetCache?.has(cacheKey)) return await roundAssetCache.get(cacheKey);
          const loadPromise = (async () => {
            const res = await fetchAsset(url, {
              headers: { ...browserHeaders(), "Accept": "*/*" },
            });
            if (!res.ok) return null;
            const content = await res.text();
            const filename = assetPathToFilename(path);
            const ext = filename.endsWith(".css") ? "css" : "js";
            const entry = {
              filename,
              path: path.split("?")[0],
              contentHash: md5(content),
              size: content.length,
              strings: extractStrings(content, ext),
              ext,
            };
            if (ext === "js") {
              entry.metadataSchemas = extractMetadataSchemasFromAsset(content, filename);
              entry.contractHints = extractContractHintsFromAsset(content, filename);
              entry.analysisSchemaVersion = ASSET_ANALYSIS_SCHEMA_VERSION;
            }
            // 对含 Vault 关键词的 JS 文件提取结构化配置
            if (ext === "js" && /(?:Vault|enabled.*constraints|constraints.*enabled|DividendBps)/i.test(content)) {
              entry.vaultConfigs = extractVaultConfigs(content);
              if (entry.vaultConfigs.length > 0) {
                log(`  [金库 Vault] ${filename}: 提取到 ${entry.vaultConfigs.length} 个配置对象`);
              }
            }
            // 提取 vaultTypes 金库工厂注册列表
            if (ext === "js" && content.includes("vaultTypes:[")) {
              const vf = extractVaultFactories(content);
              if (vf && vf.factories.length > 0) {
                entry.vaultFactories = vf;
                log(`  [金库工厂 VaultFactory] ${filename}: 提取到 ${vf.factories.length} 个工厂 (vaultPortal: ${vf.vaultPortal || "N/A"})`);
              }
            }
            return entry;
          })();
          if (roundAssetCache) roundAssetCache.set(cacheKey, loadPromise);
          const entry = await loadPromise;
          if (roundAssetCache) roundAssetCache.set(cacheKey, entry);
          return entry;
        } catch { return null; }
      })
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

async function hydrateAssetContents(features, oldFeatures = null, options = {}) {
  if (oldFeatures?.assetContents && oldFeatures.assetHash === features.assetHash
    && oldFeatures.assetAnalysisSchemaVersion === ASSET_ANALYSIS_SCHEMA_VERSION) {
    features.assetContents = oldFeatures.assetContents;
    features.assetAnalysisSchemaVersion = oldFeatures.assetAnalysisSchemaVersion;
    features.metadataSchemas = oldFeatures.metadataSchemas || [];
    features.metadataSchemaFingerprint = oldFeatures.metadataSchemaFingerprint || "";
    features.contractHints = oldFeatures.contractHints || [];
    features.contractHintsFingerprint = oldFeatures.contractHintsFingerprint || "";
    return { downloaded: 0, reused: Object.keys(features.assetContents || {}).length };
  }
  const plan = planAssetContentDownload(oldFeatures, features);
  const downloaded = await downloadAssetContents(plan.toDownload, "https://flap.sh", options);
  features.assetContents = { ...plan.reusedContents, ...downloaded };
  applyFrontendAssetAnalysis(features);
  return { downloaded: Object.keys(downloaded).length, reused: plan.reuseFilenames.length };
}

/* ── i18n 语言包提取 ── */

function findI18nChunkCandidates(assetFiles) {
  return assetFiles.filter(f => /\/chunks\/\d+-[a-f0-9]+\.js$/.test(f));
}

/**
 * 从 JS chunk 中提取 i18n 语言包
 * 优先提取中文包（包含中文字符的那个），fallback 取最后一个块
 * 排除 ABI 数组和非 i18n 结构
 */
function parseI18nFromChunk(jsContent) {
  // 提取所有 JSON.parse('...') 块
  const blocks = [];
  let searchFrom = 0;
  while (true) {
    const idx = jsContent.indexOf("JSON.parse('", searchFrom);
    if (idx === -1) break;
    const start = idx + 12; // skip "JSON.parse('"
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

  // 优先选包含中文字符的块（中文语言包）
  // 注意：中文可能是原始 UTF-8 字符，也可能是 \uXXXX 转义形式
  const hasChinese = (raw) => {
    // 检查原始 UTF-8 中文字符
    if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(raw.slice(0, 3000))) return true;
    // 检查 \uXXXX 转义形式的中文（CJK Unified Ideographs: 4E00-9FFF）
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
        log(`  [国际化 i18n] 命中中文语言包（${blocks.indexOf(raw) + 1}/${blocks.length}）`);
        return parsed;
      }
    }
  }
  // fallback: 取最后一个有效 i18n 对象（通常中文在英文后面）
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
  // 排除数组（ABI 合约定义是 [{type, name, inputs, outputs, ...}] 格式）
  if (Array.isArray(parsed)) return false;
  const keys = Object.keys(parsed);
  if (keys.length < 10) return false;
  // 排除纯数字 key 的对象（Array-like，可能来自 Object.entries 处理的数组）
  const numericKeyRatio = keys.filter(k => /^\d+$/.test(k)).length / keys.length;
  if (numericKeyRatio > 0.5) return false;
  // 合法 i18n 对象的 value 应该大部分是 string 或嵌套 object（命名空间）
  let stringOrObjCount = 0;
  for (const v of Object.values(parsed).slice(0, 20)) {
    if (typeof v === "string" || (typeof v === "object" && v !== null && !Array.isArray(v))) stringOrObjCount++;
  }
  return stringOrObjCount / Math.min(keys.length, 20) > 0.5;
}

/** 解析 JS 字符串转义后的 JSON 原始文本 */
function _parseRawI18nString(raw) {
  raw = raw.replace(/\\'/g, "'");
  raw = raw.replace(/\\\\"/g, '\\"');
  raw = raw.replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  raw = raw.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  try { return JSON.parse(raw); } catch {
    try {
      raw = raw.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\r/g, "\r");
      return JSON.parse(raw);
    } catch { return null; }
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

/**
 * 并行下载 i18n chunk 候选，找到第一个有效的
 */
async function fetchI18nStrings(assetFiles, baseUrl = "https://flap.sh") {
  const candidates = findI18nChunkCandidates(assetFiles);
  if (candidates.length === 0) return null;

  // 并行下载所有候选 chunk
  const tasks = candidates.map(async (chunkPath, idx) => {
    await sleep(idx * 100);
    try {
      const url = baseUrl + chunkPath;
      const res = await fetchSafe(url, { headers: browserHeaders() });
      if (!res.ok) return null;
      const jsContent = await res.text();
      if (!jsContent.includes("JSON.parse('")) return null;
      const data = parseI18nFromChunk(jsContent);
      if (!data || typeof data !== "object") return null;
      const strings = flattenI18n(data, "");
      if (Object.keys(strings).length < 50) return null;
      return { i18nStrings: strings, i18nHash: md5(JSON.stringify(strings)), i18nChunk: chunkPath };
    } catch { return null; }
  });

  const results = await Promise.allSettled(tasks);
  for (const r of results) {
    if (r.status === "fulfilled" && r.value) {
      log(`  [国际化 i18n] 从 ${r.value.i18nChunk.split("/").pop()} 提取到 ${Object.keys(r.value.i18nStrings).length} 个 UI 字符串`);
      return r.value;
    }
  }
  return null;
}

function diffI18nStrings(oldStrings, newStrings) {
  if (!oldStrings || !newStrings) return [];
  const changes = [];
  const oldKeys = new Set(Object.keys(oldStrings));
  const newKeys = new Set(Object.keys(newStrings));
  for (const key of oldKeys) {
    if (newKeys.has(key) && oldStrings[key] !== newStrings[key]) {
      changes.push({ type: "modified", key, oldValue: oldStrings[key], newValue: newStrings[key] });
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

/* ── 页面解析与特征提取 ── */

function decodeHtmlEntities(input) {
  return String(input || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function htmlFragmentToText(fragment) {
  return decodeHtmlEntities(fragment)
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeVaultName(name) {
  return String(name || "")
    .replace(/\s+/g, " ")
    .replace(/[.。]+$/g, "")
    .trim()
    .toLowerCase();
}

function isCaStoreVaultHeading(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (/^(hot vaults|热门金库|熱門金庫|未上架的税收模板|未上架的稅收模板|ca store|home|store|ai oracle|rank|profile|create|search|support|docs|debox)$/i.test(t)) return false;
  if (/^(币股|幣股)$/i.test(t)) return true;
  return /vault|金库|金庫|stocks|lista|custom vault factory|split|分红|分紅|质押|質押|燃烧|燃燒|回购|回購|稅收|税收/i.test(t);
}

function isCaStoreAreaHeading(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (isCaStoreVaultHeading(t)) return false;
  if (/^(home|store|rank|profile|create|search|support|docs|debox)$/i.test(t)) return false;
  return /vaults|store|featured|official|popular|hot|热门金库|熱門金庫/i.test(t);
}

function cleanVaultDescription(text) {
  return String(text || "")
    .replace(/\s+(Support|Docs|DeBox)(?:\s+.*)?$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractVaultFactoryAddress(text) {
  const raw = String(text || "");
  const linkMatch = raw.match(/vaultfactory=(0x[a-fA-F0-9]{40})/i);
  if (linkMatch) return linkMatch[1];
  const fieldMatch = raw.match(/(?:factory|vaultFactory)\s*[:=]\s*["']?(0x[a-fA-F0-9]{40})["']?/i);
  if (fieldMatch) return fieldMatch[1];
  return null;
}

function extractCaStoreVaultSections(html, options = {}) {
  const sourceUrl = String(options.url || "");
  const chain = /\/robinhood\//i.test(sourceUrl) ? "robinhood" : /\/bnb\//i.test(sourceUrl) ? "bnb" : "";
  const headings = [];
  const headingRe = /<h([1-4])[^>]*>([\s\S]*?)<\/h\1>/gi;
  let m;
  while ((m = headingRe.exec(html)) !== null) {
    const name = htmlFragmentToText(m[2]);
    headings.push({ level: Number(m[1]), name, start: m.index, end: headingRe.lastIndex });
  }

  const sections = [];
  const occurrenceByBase = new Map();
  let currentArea = "Featured Vaults";
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    if (!isCaStoreVaultHeading(h.name)) {
      if (isCaStoreAreaHeading(h.name)) currentArea = h.name;
      continue;
    }
    const next = headings[i + 1];
    const rawSectionHtml = html.slice(h.end, next ? next.start : html.length);
    const rawDescription = htmlFragmentToText(rawSectionHtml);
    const description = cleanVaultDescription(rawDescription);
    if (!description && !/custom vault factory/i.test(h.name)) continue;
    const factory = extractVaultFactoryAddress(rawSectionHtml)
      || (chain === "robinhood" && /^(币股|幣股)$/i.test(h.name) ? ROBINHOOD_INDEX_VAULT_FACTORY : null);
    const areaKey = normalizeVaultName(currentArea || "Featured Vaults");
    const nameKey = normalizeVaultName(h.name);
    const baseKey = `${areaKey}::${nameKey}`;
    const occurrence = (occurrenceByBase.get(baseKey) || 0) + 1;
    occurrenceByBase.set(baseKey, occurrence);
    sections.push({
      name: h.name,
      area: currentArea,
      areaKey,
      nameKey,
      occurrence,
      position: sections.length + 1,
      key: `${baseKey}#${occurrence}`,
      description,
      factory,
      chain,
      sourceUrl,
      signature: md5(`${h.name}\n${description}`),
    });
  }

  return sections;
}

function extractPageFeatures(html, options = {}) {
  const features = { fullHash: md5(html), nextData: null, nextDataHash: null, assetFiles: [], assetHash: null, contentHash: null, caStoreVaults: [], caStoreVaultHash: null, caStoreVaultSchemaVersion: CA_STORE_VAULT_SCHEMA_VERSION, originalUrl: options.url || "" };

  const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (nextDataMatch) {
    try {
      const data = JSON.parse(nextDataMatch[1]);
      const stableData = { props: data.props, page: data.page, query: data.query };
      features.nextData = stableData;
      features.nextDataHash = md5(JSON.stringify(stableData));
    } catch {
      features.nextDataHash = md5(nextDataMatch[1]);
    }
  }

  const assetMatches = html.matchAll(/(?:src|href)=["'](\/\_next\/static\/[^"']+\.(?:js|css)(?:\?[^"']*)?)["']/g);
  const assetSet = new Set();
  for (const m of assetMatches) assetSet.add(m[1].split("?")[0]);
  features.assetFiles = [...assetSet].sort();
  features.assetHash = md5(features.assetFiles.join("\n"));

  const textContent = htmlFragmentToText(html);
  features.contentHash = md5(textContent);
  features.textContent = textContent;
  features.caStoreVaults = extractCaStoreVaultSections(html, options);
  if (features.caStoreVaults.length > 0) {
    features.caStoreVaultHash = md5(JSON.stringify(features.caStoreVaults.map(v => [v.key, v.signature])));
  }
  return features;
}

function diffCaStoreVaultSections(oldSections = [], newSections = []) {
  if (!Array.isArray(oldSections) || !Array.isArray(newSections)) return [];
  if (oldSections.length === 0 || newSections.length === 0) return [];

  const oldMap = new Map(oldSections.map(v => [v.key || normalizeVaultName(v.name), v]));
  const newMap = new Map(newSections.map(v => [v.key || normalizeVaultName(v.name), v]));
  const changes = [];

  const oldOrder = oldSections.map(v => v.key || normalizeVaultName(v.name));
  const newOrder = newSections.map(v => v.key || normalizeVaultName(v.name));
  const oldCommonOrder = oldOrder.filter(k => newMap.has(k));
  const newCommonOrder = newOrder.filter(k => oldMap.has(k));
  if (oldCommonOrder.length > 1 && oldCommonOrder.join("\n") !== newCommonOrder.join("\n")) {
    changes.push({
      type: "reordered",
      oldOrder: oldSections.map(v => v.area ? `${v.area} / ${v.name}` : v.name),
      newOrder: newSections.map(v => v.area ? `${v.area} / ${v.name}` : v.name),
    });
  }

  for (const [key, nv] of newMap) {
    const ov = oldMap.get(key);
    if (!ov) {
      changes.push({ type: "added", name: nv.name, area: nv.area, newDescription: nv.description, factory: nv.factory || null, chain: nv.chain || "", sourceUrl: nv.sourceUrl || "" });
      continue;
    }
    if ((ov.signature || md5(`${ov.name}\n${ov.description || ""}`)) !== (nv.signature || md5(`${nv.name}\n${nv.description || ""}`))) {
      changes.push({
        type: "modified",
        name: nv.name || ov.name,
        area: nv.area || ov.area,
        oldName: ov.name,
        newName: nv.name,
        oldDescription: ov.description || "",
        newDescription: nv.description || "",
        oldFactory: ov.factory || null,
        newFactory: nv.factory || null,
        factory: nv.factory || ov.factory || null,
        chain: nv.chain || ov.chain || "",
        sourceUrl: nv.sourceUrl || ov.sourceUrl || "",
      });
    }
  }

  for (const [key, ov] of oldMap) {
    if (!newMap.has(key)) {
      changes.push({ type: "removed", name: ov.name, area: ov.area, oldDescription: ov.description || "", factory: ov.factory || null, chain: ov.chain || "", sourceUrl: ov.sourceUrl || "" });
    }
  }

  return changes;
}

function shouldRefreshDerivedFeatureBaseline(oldFeatures, newFeatures) {
  if (!oldFeatures || !newFeatures) return false;
  const caStoreBaselineMissing = Boolean(newFeatures.caStoreVaultHash) && (
    !oldFeatures.caStoreVaultHash
    || oldFeatures.caStoreVaultSchemaVersion !== CA_STORE_VAULT_SCHEMA_VERSION
  );
  const assetAnalysisBaselineMissing = newFeatures.assetAnalysisSchemaVersion === ASSET_ANALYSIS_SCHEMA_VERSION
    && oldFeatures.assetAnalysisSchemaVersion !== ASSET_ANALYSIS_SCHEMA_VERSION;
  return caStoreBaselineMissing || assetAnalysisBaselineMissing;
}

function formatCaStoreVaultDiffsForChanges(diffs) {
  const lines = ["🏦 CAstore 金库内容变更："];
  for (const d of diffs) {
    const label = d.area ? `${d.area} / ${d.name}` : d.name;
    if (d.type === "reordered") {
      lines.push("  🔀 金库排序变化");
      lines.push(`    旧顺序: ${(d.oldOrder || []).join(" → ")}`);
      lines.push(`    新顺序: ${(d.newOrder || []).join(" → ")}`);
    } else if (d.type === "modified") {
      lines.push(`  ✏️ ${label}`);
      if (d.oldName && d.newName && d.oldName !== d.newName) lines.push(`    名称: ${d.oldName} → ${d.newName}`);
      lines.push(`    旧文案: ${d.oldDescription || "(空)"}`);
      lines.push(`    新文案: ${d.newDescription || "(空)"}`);
    } else if (d.type === "added") {
      lines.push(`  🟢 新增金库: ${label}`);
      lines.push(`    文案: ${d.newDescription || "(空)"}`);
    } else if (d.type === "removed") {
      lines.push(`  🔴 移除金库: ${label}`);
      lines.push(`    原文案: ${d.oldDescription || "(空)"}`);
    }
  }
  return lines;
}

function isValidFactoryAddress(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(value || ""));
}

function resolveCaStoreVaultFactory(change, vaultFactoryMap = {}) {
  const direct = change?.factory || change?.newFactory || change?.oldFactory;
  if (isValidFactoryAddress(direct)) return direct;

  const candidateNames = [
    change?.name,
    change?.newName,
    change?.oldName,
  ].map(normalizeVaultName).filter(Boolean);
  if (candidateNames.length === 0) return null;

  const factories = Object.values(vaultFactoryMap || {});
  for (const wanted of candidateNames) {
    const exact = factories.find(f => normalizeVaultName(f?.name) === wanted);
    if (exact?.factory && isValidFactoryAddress(exact.factory)) return exact.factory;
  }
  for (const wanted of candidateNames) {
    const fuzzy = factories.find((f) => {
      const name = normalizeVaultName(f?.name);
      return name && (name.includes(wanted) || wanted.includes(name));
    });
    if (fuzzy?.factory && isValidFactoryAddress(fuzzy.factory)) return fuzzy.factory;
  }
  return null;
}

function caStoreVaultChangeLabel(type) {
  if (type === "added") return "新增金库";
  if (type === "modified") return "金库文案更新";
  if (type === "removed") return "移除金库";
  return "金库变更";
}

function getCaStoreVaultDisplayName(change) {
  return change?.name || change?.newName || change?.oldName || "未知金库";
}

function getCaStoreVaultCopy(change) {
  if (change?.type === "removed") return change.oldDescription || "(空)";
  return change?.newDescription || change?.oldDescription || "(空)";
}

function buildCaStoreVaultAiInput(change, factory, launchUrl) {
  return [
    "用中文介绍该 CAstore 金库用途和注意点，不编造数据。",
    "",
    `变更类型: ${caStoreVaultChangeLabel(change?.type)}`,
    `金库名字: ${getCaStoreVaultDisplayName(change)}`,
    `金库文案: ${getCaStoreVaultCopy(change)}`,
    factory ? `Vault Factory: ${factory}` : "Vault Factory: 未匹配到",
    launchUrl ? `金库链接: ${launchUrl}` : "金库链接: 未匹配到",
  ].join("\n");
}

function buildCaStoreVaultChangeNotification(change, vaultFactoryMap = {}, options = {}) {
  const titlePrefix = options.titlePrefix || "";
  const name = getCaStoreVaultDisplayName(change);
  const copy = getCaStoreVaultCopy(change);
  const factory = resolveCaStoreVaultFactory(change, vaultFactoryMap);
  const launchUrl = buildVaultFactoryLaunchUrl(factory, { chain: change?.chain });
  const typeLabel = caStoreVaultChangeLabel(change?.type);
  const typeText = change?.type === "removed"
    ? removedText(typeLabel)
    : change?.type === "added"
      ? addedText(typeLabel)
      : changedText(typeLabel);
  const content = buildFlapCardContent({
    summary: [
      `- 金库: ${cardText(name)}`,
      `- 类型: ${typeText}`,
      factory ? `- Factory: ${addressLink(factory)}` : "- Factory: 未匹配到",
      launchUrl ? `- 金库链接: ${flapLink("打开金库", launchUrl)}` : "",
    ],
    primaryTitle: "金库文案",
    primary: [`- ${cardText(copy)}`],
    ai: "AI 分析异步生成中，变更已先推送。",
  });

  return {
    title: `${titlePrefix}${change?.chain === "robinhood" ? "Robinhood " : ""}CAstore 金库变更：${name}`,
    content,
    template: change?.type === "removed" ? "orange" : "red",
    url: launchUrl || change?.sourceUrl || "https://flap.sh/bnb/CAstore",
    moduleContext: "Flap.sh CAstore 金库内容介绍",
    aiInput: buildCaStoreVaultAiInput(change, factory, launchUrl),
    factory,
    launchUrl,
    change,
  };
}

function getStandaloneCaStoreVaultDiffs(notification) {
  return (notification?.meta?.caStoreVaultDiffs || [])
    .filter(d => ["added", "modified", "removed"].includes(d.type));
}

function shouldSuppressCaStoreOnlyPageNotification(notification) {
  const meta = notification?.meta || {};
  const standaloneCount = getStandaloneCaStoreVaultDiffs(notification).length;
  return standaloneCount > 0
    && standaloneCount === (meta.caStoreVaultDiffs || []).length
    && !meta.assetStats
    && !meta.nextDataChanged
    && (meta.textChangeCount || 0) === 0
    && (meta.i18nChangeCount || 0) === 0;
}

function omitStandaloneCaStoreVaultDiffs(notification) {
  const standaloneDiffs = getStandaloneCaStoreVaultDiffs(notification);
  if (standaloneDiffs.length === 0) return notification;
  const standaloneKeys = new Set(standaloneDiffs.map(stableKey));
  const meta = { ...(notification.meta || {}) };
  meta.caStoreVaultDiffs = (meta.caStoreVaultDiffs || []).filter(diff => !standaloneKeys.has(stableKey(diff)));
  meta.fullDiffLines = (meta.fullDiffLines || []).filter(line => !/^🏦 CAstore 金库/.test(String(line || "")));
  const changes = (notification.changes || []).filter(line => !/^🏦 CAstore 金库/.test(String(line || "")) && !/^  [🟢🔴✏️]/.test(String(line || "")));
  return {
    ...notification,
    changes,
    meta,
    caStoreStandaloneSent: true,
  };
}

async function sendCaStoreVaultChangeNotification(notification) {
  appendHistory("castore-vault", notification.title, notification.content.slice(0, 500), notification.aiInput || "");
  const messageId = await sendThenEnrichWithAi(
    notification.title,
    notification.content,
    notification.template,
    notification.moduleContext,
    notification.aiInput,
    (summary) => enrichExistingCardContentWithAi(notification.content, summary),
    null,
    notification.url,
    aiIntroduceCaStoreVault,
    alertMentionCardOptions(),
  );
  return messageId;
}

const FLAP_ERROR_PAGE_PATTERNS = [
  /Service Unavailable/i,
  /not available in your region/i,
  /Access Denied/i,
  /Just a moment/i,
  /enable JavaScript and cookies/i,
  /Application error/i,
  /server-side exception/i,
  /Rate limit/i,
];

function getFlapPageQuality(url, html, features) {
  const reasons = [];
  const warnings = [];
  const htmlText = html == null ? "" : String(html);
  const text = String(features?.textContent || "");
  const assetCount = (features?.assetFiles || []).length;

  if (!features) {
    reasons.push("features 为空");
  }
  if (html != null && htmlText.length < CONFIG.pageQuality.minHtmlLength) {
    reasons.push(`HTML 过短(${htmlText.length})`);
  }
  if (text.length < CONFIG.pageQuality.minTextLength) {
    reasons.push(`正文过短(${text.length})`);
  }
  if (assetCount < CONFIG.pageQuality.minAssetFiles) {
    const hasNextData = !!features?.nextDataHash;
    if (!hasNextData && text.length < 300) {
      reasons.push(`Next 静态资源过少(${assetCount})且正文不足以作为有效页面`);
    } else {
      warnings.push(`Next 静态资源过少(${assetCount})`);
    }
  }

  const markerText = `${htmlText.slice(0, 4000)}\n${text.slice(0, 4000)}`;
  const matchedError = FLAP_ERROR_PAGE_PATTERNS.find(p => p.test(markerText));
  if (matchedError) {
    reasons.push(`疑似错误页(${matchedError.source})`);
  }

  if (/\/(?:bnb|robinhood)\/CAstore/i.test(url) && !/Vault|金库|金庫|CA STORE|STORE|Connect Wallet/i.test(text)) {
    warnings.push("CAstore 关键文案缺失");
  } else if (/\/(?:launch|create)(?:$|\?)/i.test(url) && !/Create|Token|Connect Wallet/i.test(text)) {
    warnings.push("创建页关键文案缺失");
  }

  return { valid: reasons.length === 0, reasons, warnings };
}

function assertValidFlapPage(url, html, features) {
  const quality = getFlapPageQuality(url, html, features);
  if (!quality.valid) {
    const err = new Error(`页面样本无效：${quality.reasons.join("; ")}`);
    err.pageQuality = quality;
    throw err;
  }
  if (quality.warnings.length > 0) {
    log(`[质量] ${url} 警告：${quality.warnings.join("; ")}`);
  }
  return quality;
}

function getStoredFeatureQuality(url, features) {
  return getFlapPageQuality(url, null, features);
}

function formatQualityIssue(url, quality) {
  return [
    `**URL:** ${url}`,
    `**原因:** ${(quality?.reasons || []).join("; ") || "未知"}`,
    quality?.warnings?.length ? `**警告:** ${quality.warnings.join("; ")}` : "",
  ].filter(Boolean).join("\n");
}

/* ── Diff 工具 ── */

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
 * 内容级前端资源 diff（四阶段匹配）
 */
function diffFrontendAssets(oldAssets, newAssets) {
  oldAssets = oldAssets || {};
  newAssets = newAssets || {};
  const result = { matched: [], added: [], removed: [], unchanged: 0, renamed: 0 };

  const unmatchedOld = new Map();
  const unmatchedNew = new Map();

  // Phase 1: 同名文件
  for (const [file, newData] of Object.entries(newAssets)) {
    if (file in oldAssets) {
      if (oldAssets[file].contentHash === newData.contentHash) {
        result.unchanged++;
      } else {
        const oldStrSet = new Set(oldAssets[file].strings || []);
        const newStrSet = new Set(newData.strings || []);
        result.matched.push({
          oldFile: file, newFile: file,
          oldPath: oldAssets[file].path || file,
          newPath: newData.path || file,
          addedStrings: (newData.strings || []).filter(s => !oldStrSet.has(s)),
          removedStrings: (oldAssets[file].strings || []).filter(s => !newStrSet.has(s)),
        });
      }
    } else {
      unmatchedNew.set(file, newData);
    }
  }
  for (const [file, oldData] of Object.entries(oldAssets)) {
    if (!(file in newAssets)) unmatchedOld.set(file, oldData);
  }

  // Phase 2: contentHash 精确匹配（同内容换文件名）
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
  if (unmatchedOld.size > 0 && unmatchedNew.size > 0) {
    const chunkIdRe = /^(\d+)-[a-f0-9]+\.(js|css)$/;
    const oldByChunk = new Map();
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
      if (oldData.contentHash === newData.contentHash) {
        result.renamed++;
      } else {
        const oldStrSet = new Set(oldData.strings || []);
        const newStrSet = new Set(newData.strings || []);
        result.matched.push({
          oldFile, newFile,
          oldPath: oldData.path || oldFile,
          newPath: newData.path || newFile,
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
        const newExt = newFile.endsWith(".css") ? "css" : "js";
        const oldExt = oldFile.endsWith(".css") ? "css" : "js";
        if (newExt !== oldExt) continue;
        const sim = jaccard(oldData.strings || [], newData.strings || []);
        if (sim > 0.4) pairs.push({ oldFile, newFile, sim });
      }
    }
    pairs.sort((a, b) => b.sim - a.sim);
    const usedOld = new Set(), usedNew = new Set();
    for (const p of pairs) {
      if (usedOld.has(p.oldFile) || usedNew.has(p.newFile)) continue;
      usedOld.add(p.oldFile);
      usedNew.add(p.newFile);
      const oldData = unmatchedOld.get(p.oldFile);
      const newData = unmatchedNew.get(p.newFile);
      const oldStrSet = new Set(oldData.strings || []);
      const newStrSet = new Set(newData.strings || []);
      result.matched.push({
        oldFile: p.oldFile, newFile: p.newFile,
        oldPath: oldData.path || p.oldFile,
        newPath: newData.path || p.newFile,
        addedStrings: (newData.strings || []).filter(s => !oldStrSet.has(s)),
        removedStrings: (oldData.strings || []).filter(s => !newStrSet.has(s)),
      });
      unmatchedOld.delete(p.oldFile);
      unmatchedNew.delete(p.newFile);
    }
  }

  // Phase 4: 剩余
  result.added = [...unmatchedNew.keys()];
  result.removed = [...unmatchedOld.keys()];
  return result;
}

/**
 * 文案 diff — 有序段落比较 + 上下文
 * 返回 { changes: [...], reordered: boolean }
 *
 * 改进点：
 *   - 有序匹配（保留位置信息）而非集合差
 *   - 归一化匹配（忽略末尾标点差异）
 *   - 每条变更附带前后上下文
 */
function diffTextContent(oldText, newText) {
  if (!oldText || !newText || oldText === newText) return null;

  // 拆段：按句末标点或连续空白分割
  const split = (text) => {
    const segs = text.split(/(?<=[.!?。！？])\s+/).map(s => s.trim()).filter(s => s.length > 0);
    if (segs.length <= 1) {
      // 无句末标点时按多空格分段
      return text.split(/\s{2,}/).map(s => s.trim()).filter(s => s.length > 0);
    }
    return segs;
  };

  const oldSegs = split(oldText);
  const newSegs = split(newText);

  // 归一化函数：用于匹配时忽略末尾标点和大小写差异
  const normalize = (s) => s.replace(/[.!?。！？\s]+$/g, "").toLowerCase();

  // 构建新段落的归一化索引，支持 O(1) 查找
  const newNormMap = new Map(); // normStr -> [indices]
  for (let i = 0; i < newSegs.length; i++) {
    const n = normalize(newSegs[i]);
    if (!newNormMap.has(n)) newNormMap.set(n, []);
    newNormMap.get(n).push(i);
  }

  // LCS（最长公共子序列）— 用于有序匹配
  // 对于中等规模段落列表（< 500），O(n*m) 可接受
  const maxLen = 500;
  const oLen = Math.min(oldSegs.length, maxLen);
  const nLen = Math.min(newSegs.length, maxLen);
  const dp = Array.from({ length: oLen + 1 }, () => new Uint16Array(nLen + 1));
  for (let i = 1; i <= oLen; i++) {
    const on = normalize(oldSegs[i - 1]);
    for (let j = 1; j <= nLen; j++) {
      if (on === normalize(newSegs[j - 1])) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // 回溯 LCS，标记匹配对
  const matchedOld = new Set();
  const matchedNew = new Set();
  let oi = oLen, ni = nLen;
  while (oi > 0 && ni > 0) {
    if (normalize(oldSegs[oi - 1]) === normalize(newSegs[ni - 1])) {
      matchedOld.add(oi - 1);
      matchedNew.add(ni - 1);
      oi--; ni--;
    } else if (dp[oi - 1][ni] >= dp[oi][ni - 1]) {
      oi--;
    } else {
      ni--;
    }
  }

  // 收集未匹配的段落（即变更）
  const removedIndices = [];
  for (let i = 0; i < oldSegs.length; i++) {
    if (!matchedOld.has(i)) removedIndices.push(i);
  }
  const addedIndices = [];
  for (let i = 0; i < newSegs.length; i++) {
    if (!matchedNew.has(i)) addedIndices.push(i);
  }

  if (removedIndices.length === 0 && addedIndices.length === 0) {
    // 归一化后完全相同，但原始文本不同 → 标点/格式变化
    return { changes: [], reordered: true };
  }

  // 尝试配对 removed 和 added（按归一化的词级相似度）
  const changes = [];
  const pairedAdded = new Set();

  for (const ri of removedIndices) {
    const oldSeg = oldSegs[ri];
    const oldWords = oldSeg.split(/\s+/);
    let bestIdx = -1, bestScore = 0;
    for (const ai of addedIndices) {
      if (pairedAdded.has(ai)) continue;
      const newWords = newSegs[ai].split(/\s+/);
      const oldWordSet = new Set(oldWords.map(w => w.toLowerCase()));
      const common = newWords.filter(w => oldWordSet.has(w.toLowerCase())).length;
      const score = common / Math.max(oldWords.length, newWords.length);
      if (score > bestScore && score > 0.3) { bestScore = score; bestIdx = ai; }
    }

    // 获取上下文（前后各 1 个匹配的段落）
    const ctxBefore = ri > 0 ? oldSegs[ri - 1] : null;
    const ctxAfter = ri < oldSegs.length - 1 ? oldSegs[ri + 1] : null;

    if (bestIdx >= 0) {
      pairedAdded.add(bestIdx);
      changes.push({
        type: "modified",
        oldText: oldSeg,
        newText: newSegs[bestIdx],
        oldPos: ri,
        newPos: bestIdx,
        ctxBefore,
        ctxAfter,
      });
    } else {
      changes.push({
        type: "removed",
        text: oldSeg,
        pos: ri,
        ctxBefore,
        ctxAfter,
      });
    }
  }

  for (const ai of addedIndices) {
    if (pairedAdded.has(ai)) continue;
    const ctxBefore = ai > 0 ? newSegs[ai - 1] : null;
    const ctxAfter = ai < newSegs.length - 1 ? newSegs[ai + 1] : null;
    changes.push({
      type: "added",
      text: newSegs[ai],
      pos: ai,
      ctxBefore,
      ctxAfter,
    });
  }

  // 按原始位置排序
  changes.sort((a, b) => (a.oldPos ?? a.pos ?? a.newPos ?? 0) - (b.oldPos ?? b.pos ?? b.newPos ?? 0));

  return { changes, reordered: false };
}

function buildAssetFullDiffLines({ assetDiff, substantiveFiles, noiseOnlyFiles, allConfigDiffs, vaultDiffs, uiStyleDiffs = [], codeIntentDiffs = [] }) {
  const lines = ["【前端资源完整 Diff】"];
  const statParts = [];
  if (assetDiff.unchanged) statParts.push(`不变 ${assetDiff.unchanged}`);
  if (assetDiff.renamed) statParts.push(`重命名 ${assetDiff.renamed}`);
  if (assetDiff.matched.length) statParts.push(`修改 ${assetDiff.matched.length}`);
  if (assetDiff.added.length) statParts.push(`新增 ${assetDiff.added.length}`);
  if (assetDiff.removed.length) statParts.push(`移除 ${assetDiff.removed.length}`);
  lines.push(`资源统计: ${statParts.join(" | ") || "无变化"}`);

  if (allConfigDiffs.length > 0) {
    lines.push("");
    lines.push("【配置参数完整变更】");
    for (const cd of allConfigDiffs) lines.push(`${cd.field}: ${cd.oldVal} → ${cd.newVal} (${cd.file || "unknown"})`);
  }

  if (vaultDiffs.length > 0) {
    lines.push("");
    lines.push("【Vault 配置完整变更】");
    for (const vd of vaultDiffs) {
      if (vd.type === "modified") {
        lines.push(`${vd.name} - 修改 ${vd.fieldChanges.length} 个字段`);
        for (const fc of vd.fieldChanges) lines.push(`  ${fc.key}: ${fc.oldVal} → ${fc.newVal}`);
      } else if (vd.type === "added") {
        lines.push(`${vd.name} - 新增`);
        for (const [key, value] of Object.entries(vd.fields || {})) lines.push(`  ${key}: ${value}`);
      } else {
        lines.push(`${vd.type || "changed"}: ${vd.name || JSON.stringify(vd)}`);
      }
    }
  }

  const uiSignals = summarizeUiStyleDiffs(uiStyleDiffs);
  if (uiSignals.length > 0) {
    lines.push("");
    lines.push("【UI/样式信号摘要】");
    for (const signal of uiSignals) {
      const counts = `${signal.added} 新增 / ${signal.removed} 删除`;
      const files = signal.files.length ? `；文件: ${signal.files.join(", ")}` : "";
      lines.push(`${signal.label}: ${counts}；范围: ${signal.contextLabel}(${signal.contextConfidence})；可能意图: ${signal.intent}；证据: ${signal.evidence}${files}`);
    }
  }

  const codeSignals = summarizeCodeIntentDiffs(codeIntentDiffs);
  if (codeSignals.length > 0) {
    lines.push("");
    lines.push("【实现意图信号摘要】");
    for (const signal of codeSignals) {
      const counts = `${signal.added} 新增 / ${signal.removed} 删除`;
      const files = signal.files.length ? `；文件 ${signal.files.join(", ")}` : "";
      lines.push(`${signal.label}: ${counts}；可能意图: ${signal.intent}；证据: ${signal.evidence}${files}`);
    }
  }

  if (substantiveFiles.length > 0) {
    lines.push("");
    lines.push("【资源字符串完整变更】");
    for (const m of substantiveFiles) {
      const label = m.oldFile === m.newFile ? m.newFile : `${m.oldFile} → ${m.newFile}`;
      lines.push(`文件: ${label}`);
      if (m.totalNoise > 0) lines.push(`噪音过滤: ${m.totalNoise} 处`);
      for (const s of m.realRemoved) lines.push(`  - ${s}`);
      for (const s of m.realAdded) lines.push(`  + ${s}`);
      lines.push("");
    }
  }

  if (noiseOnlyFiles.length > 0) {
    lines.push("【构建噪音】");
    for (const f of noiseOnlyFiles) lines.push(`${f.label}: ${f.noise} 处`);
  }
  if (assetDiff.added.length > 0) {
    lines.push("");
    lines.push("【新增资源文件】");
    for (const f of assetDiff.added) lines.push(`+ ${f}`);
  }
  if (assetDiff.removed.length > 0) {
    lines.push("");
    lines.push("【移除资源文件】");
    for (const f of assetDiff.removed) lines.push(`- ${f}`);
  }
  return lines.filter(line => line !== "");
}

function appendTextFullDiffLines(target, textDiff) {
  target.push("【页面文案完整 Diff】");
  if (textDiff.reordered) {
    target.push("页面文案顺序/标点调整，内容未发生实质变更");
    return;
  }
  for (const c of textDiff.changes || []) {
    if (c.type === "modified") {
      target.push("修改:");
      target.push(`  旧: ${c.oldText}`);
      target.push(`  新: ${c.newText}`);
    } else if (c.type === "added") {
      target.push(`新增: ${c.text}`);
    } else if (c.type === "removed") {
      target.push(`删除: ${c.text}`);
    }
    if (c.ctxBefore) target.push(`  上文: ${c.ctxBefore}`);
    if (c.ctxAfter) target.push(`  下文: ${c.ctxAfter}`);
  }
}

function appendI18nFullDiffLines(target, i18nDiff) {
  target.push("【UI 文案 i18n 完整 Diff】");
  for (const c of i18nDiff || []) {
    if (c.type === "modified") target.push(`${c.key}: "${c.oldValue}" → "${c.newValue}"`);
    else if (c.type === "added") target.push(`新增 ${c.key}: "${c.value}"`);
    else if (c.type === "removed") target.push(`删除 ${c.key}: "${c.value}"`);
  }
}

function flattenKeys(obj, prefix = "", result = {}) {
  if (obj === null || obj === undefined) return result;
  if (typeof obj !== "object") { result[prefix] = typeof obj; return result; }
  if (Array.isArray(obj)) { result[prefix + "[]"] = "array"; if (obj.length > 0) flattenKeys(obj[0], prefix + "[0].", result); return result; }
  for (const [k, v] of Object.entries(obj)) flattenKeys(v, prefix ? `${prefix}.${k}` : k, result);
  return result;
}

function diffFeatures(oldF, newF) {
  const changes = [];
  const meta = { assetStats: null, textChangeCount: 0, textChanges: [], i18nChangeCount: 0, i18nDiffs: [], metadataSchemaDiffs: [], caStoreVaultDiffs: [], nextDataChanged: false, fullDiffLines: [] };

  const metadataSchemaDiffs = diffMetadataSchemas(oldF, newF);
  if (metadataSchemaDiffs.length > 0) {
    const metadataLines = formatMetadataSchemaDiffs(metadataSchemaDiffs);
    meta.metadataSchemaDiffs = metadataSchemaDiffs;
    changes.push(...metadataLines);
    meta.fullDiffLines.push("【Flap metadata schema 完整 Diff】", ...metadataLines);
  }

  if (oldF.nextDataHash && newF.nextDataHash && oldF.nextDataHash !== newF.nextDataHash) {
    meta.nextDataChanged = true;
    changes.push("页面数据（__NEXT_DATA__）变更");
    if (oldF.nextData?.props && newF.nextData?.props) {
      const oldKeys = Object.keys(flattenKeys(oldF.nextData.props));
      const newKeys = Object.keys(flattenKeys(newF.nextData.props));
      const added = newKeys.filter(k => !oldKeys.includes(k));
      const removed = oldKeys.filter(k => !newKeys.includes(k));
      if (added.length) changes.push(`  新增字段：${added.join(", ")}`);
      if (removed.length) changes.push(`  移除字段：${removed.join(", ")}`);
      meta.fullDiffLines.push("【页面数据 __NEXT_DATA__ 完整 Diff】");
      for (const key of added) meta.fullDiffLines.push(`+ ${key}`);
      for (const key of removed) meta.fullDiffLines.push(`- ${key}`);
    }
  }

  if (oldF.caStoreVaultSchemaVersion === CA_STORE_VAULT_SCHEMA_VERSION
    && newF.caStoreVaultSchemaVersion === CA_STORE_VAULT_SCHEMA_VERSION) {
    const caStoreVaultDiffs = diffCaStoreVaultSections(oldF.caStoreVaults || [], newF.caStoreVaults || []);
    if (caStoreVaultDiffs.length > 0) {
      meta.caStoreVaultDiffs = caStoreVaultDiffs;
      changes.push(...formatCaStoreVaultDiffsForChanges(caStoreVaultDiffs));
      meta.fullDiffLines.push("【CAstore 金库完整 Diff】");
      meta.fullDiffLines.push(...formatCaStoreVaultDiffsForChanges(caStoreVaultDiffs));
    }
  }

  if (oldF.assetHash && newF.assetHash && oldF.assetHash !== newF.assetHash) {
    const hasAssetContents = oldF.assetContents && Object.keys(oldF.assetContents).length > 0
      && newF.assetContents && Object.keys(newF.assetContents).length > 0;

    if (hasAssetContents) {
      const assetDiff = diffFrontendAssets(oldF.assetContents, newF.assetContents);

      // ── 分离实质变更与噪音 ──
      const substantiveFiles = [];
      const noiseOnlyFiles = [];
      const allConfigDiffs = [];
      const allUiStyleDiffs = [];
      const allCodeIntentDiffs = [];

      for (const m of assetDiff.matched) {
        const realAdded = (m.addedStrings || []).filter(s => !isAssetStringDiffNoise(s));
        const realRemoved = (m.removedStrings || []).filter(s => !isAssetStringDiffNoise(s));
        const totalNoise = (m.addedStrings.length - realAdded.length) + (m.removedStrings.length - realRemoved.length);
        const totalReal = realAdded.length + realRemoved.length;

        const configDiffs = extractConfigDiffs(m.removedStrings, m.addedStrings);
        if (configDiffs.length > 0) {
          for (const cd of configDiffs) {
            allConfigDiffs.push({ ...cd, file: m.newFile || m.oldFile });
          }
        }

        allUiStyleDiffs.push(
          ...collectUiStyleDiffsFromStrings(m.removedStrings || [], "removed", m.oldFile || m.newFile, m.oldPath || m.newPath),
          ...collectUiStyleDiffsFromStrings(m.addedStrings || [], "added", m.newFile || m.oldFile, m.newPath || m.oldPath),
        );

        allCodeIntentDiffs.push(
          ...collectCodeIntentDiffsFromStrings(m.removedStrings || [], "removed", m.oldFile || m.newFile, m.oldPath || m.newPath),
          ...collectCodeIntentDiffsFromStrings(m.addedStrings || [], "added", m.newFile || m.oldFile, m.newPath || m.oldPath),
        );

        if (totalReal === 0 && totalNoise > 0) {
          noiseOnlyFiles.push({ label: m.oldFile === m.newFile ? m.newFile : `${m.oldFile} → ${m.newFile}`, noise: totalNoise });
        } else {
          substantiveFiles.push({ ...m, realAdded, realRemoved, totalNoise, configDiffs });
        }
      }
      const substantiveAssetPaths = uniqueStrings(substantiveFiles.map(f => f.newPath || f.oldPath || f.newFile || f.oldFile));

      // ── 提取 JS 字符串 diff 中的业务文案（中文文案、Vault 描述等）──
      const jsTextDiffs = [];

      for (const sf of substantiveFiles) {
        for (const s of sf.realRemoved) {
          if (isReadableBusinessText(s)) {
            jsTextDiffs.push({ type: "removed", text: s, file: sf.oldFile || sf.newFile });
          }
        }
        for (const s of sf.realAdded) {
          if (isReadableBusinessText(s)) {
            jsTextDiffs.push({ type: "added", text: s, file: sf.newFile || sf.oldFile });
          }
        }
      }

      // Vault 结构化对比
      const oldVaults = [], newVaults = [];
      for (const data of Object.values(oldF.assetContents)) {
        if (data.vaultConfigs?.length) oldVaults.push(...data.vaultConfigs);
      }
      for (const data of Object.values(newF.assetContents)) {
        if (data.vaultConfigs?.length) newVaults.push(...data.vaultConfigs);
      }
      const vaultDiffs = (oldVaults.length > 0 || newVaults.length > 0) ? diffVaultConfigs(oldVaults, newVaults) : [];

      // 构建 meta
      meta.assetStats = {
        unchanged: assetDiff.unchanged,
        renamed: assetDiff.renamed,
        modified: assetDiff.matched.length,
        added: assetDiff.added.length,
        removed: assetDiff.removed.length,
        noiseFiles: noiseOnlyFiles.length,
        noiseCount: noiseOnlyFiles.reduce((s, f) => s + f.noise, 0),
        substantiveFiles: substantiveFiles.length,
        substantiveCount: substantiveFiles.reduce((s, f) => s + f.realAdded.length + f.realRemoved.length, 0),
        substantiveFileNames: substantiveFiles.map(f => f.newFile || f.oldFile),
        substantiveAssetPaths,
        semanticProfile: buildAssetSemanticProfile(substantiveAssetPaths, { configDiffs: allConfigDiffs, vaultDiffs, jsTextDiffs, uiStyleDiffs: allUiStyleDiffs, codeIntentDiffs: allCodeIntentDiffs }),
        configDiffs: allConfigDiffs,
        vaultDiffs,
        jsTextDiffs,
        uiStyleDiffs: allUiStyleDiffs,
        codeIntentDiffs: allCodeIntentDiffs,
      };
      meta.fullDiffLines.push(...buildAssetFullDiffLines({
        assetDiff,
        substantiveFiles,
        noiseOnlyFiles,
        allConfigDiffs,
        vaultDiffs,
        uiStyleDiffs: allUiStyleDiffs,
        codeIntentDiffs: allCodeIntentDiffs,
      }));

      // ── 详细 diff 输出（存文件用）──
      const statParts = [];
      if (assetDiff.unchanged) statParts.push(`不变 ${assetDiff.unchanged}`);
      if (assetDiff.renamed) statParts.push(`重命名 ${assetDiff.renamed}`);
      if (assetDiff.matched.length) statParts.push(`修改 ${assetDiff.matched.length}`);
      if (assetDiff.added.length) statParts.push(`新增 ${assetDiff.added.length}`);
      if (assetDiff.removed.length) statParts.push(`移除 ${assetDiff.removed.length}`);
      changes.push(`📦 前端资源变更： ${statParts.join(" | ")}`);

      if (allConfigDiffs.length > 0) {
        const businessConfigChanges = allConfigDiffs.filter(isBusinessConfigDiff);
        if (businessConfigChanges.length > 0) {
          changes.push("");
          changes.push("🔧 配置参数变更：");
        }
        for (const cd of businessConfigChanges) {
          changes.push(`  ${cd.field}: ${cd.oldVal} → ${cd.newVal}  (${cd.file})`);
        }
      }

      if (vaultDiffs.length > 0) {
        changes.push("");
        changes.push("🏦 Vault 配置变更：");
        for (const vd of vaultDiffs) {
          if (vd.type === "modified") {
            changes.push(`  ${vd.name} — ${vd.fieldChanges.length} 个字段:`);
            for (const fc of vd.fieldChanges) {
              changes.push(`    ${fc.key}: ${fc.oldVal} → ${fc.newVal}`);
            }
          } else if (vd.type === "added") {
            changes.push(`  🆕 新增: ${vd.name} (${Object.keys(vd.fields).length} 字段)`);
          }
        }
      }

      for (const m of substantiveFiles) {
        const label = m.oldFile === m.newFile ? m.newFile : `${m.oldFile} → ${m.newFile}`;
        const total = m.realAdded.length + m.realRemoved.length;
        const noiseNote = m.totalNoise > 0 ? ` + ${m.totalNoise} 噪音已过滤` : "";
        if (total === 0) continue;
        changes.push(`📝 ${label} (${total} 处实质变更${noiseNote})`);
        const readableRemoved = m.realRemoved.filter(isReadableBusinessText);
        const readableAdded = m.realAdded.filter(isReadableBusinessText);
        for (const s of readableRemoved) changes.push(`  - ${s}`);
        for (const s of readableAdded) changes.push(`  + ${s}`);
        const hiddenCount = total - readableRemoved.length - readableAdded.length;
        if (hiddenCount > 0) changes.push(`  · ${hiddenCount} 处不可读实现片段已折叠到 Diff 详情`);
      }

      if (noiseOnlyFiles.length > 0) {
        const totalNoise = noiseOnlyFiles.reduce((s, f) => s + f.noise, 0);
        const names = noiseOnlyFiles.map(f => f.label.split("/").pop().split(" → ").pop());
        changes.push(`🔇 构建噪音： ${noiseOnlyFiles.length} 文件 ${totalNoise} 处 (${names.slice(0, 4).join(", ")})`);
      }
      if (assetDiff.added.length > 0) changes.push(`🆕 新增文件： ${assetDiff.added.join(", ")}`);
      if (assetDiff.removed.length > 0) changes.push(`🗑️ 移除文件： ${assetDiff.removed.join(", ")}`);
    } else {
      changes.push("前端代码（JS/CSS 资源）更新");
      const oldSet = new Set(oldF.assetFiles || []), newSet = new Set(newF.assetFiles || []);
      const added = [...newSet].filter(f => !oldSet.has(f));
      const removed = [...oldSet].filter(f => !newSet.has(f));
      if (added.length) changes.push(`  新增：${added.map(f => f.split("/").pop()).join(", ")}`);
      if (removed.length) changes.push(`  移除：${removed.map(f => f.split("/").pop()).join(", ")}`);
      meta.fullDiffLines.push("【前端资源文件完整 Diff】");
      for (const f of added) meta.fullDiffLines.push(`+ ${f}`);
      for (const f of removed) meta.fullDiffLines.push(`- ${f}`);
    }
  }
  if (oldF.contentHash && newF.contentHash && oldF.contentHash !== newF.contentHash) {
    const textDiff = diffTextContent(oldF.textContent, newF.textContent);
    if (textDiff) {
      if (textDiff.reordered) {
        changes.push("页面文案顺序/标点调整（内容不变）");
        appendTextFullDiffLines(meta.fullDiffLines, textDiff);
      }
      else {
        meta.textChangeCount = textDiff.changes.length;
        meta.textChanges = textDiff.changes;
        appendTextFullDiffLines(meta.fullDiffLines, textDiff);
        for (const c of textDiff.changes) {
          const ctx = c.ctxBefore ? `  上文: ${c.ctxBefore}` : "";
          if (c.type === "modified") {
            changes.push(`✏️ 文案修改：`);
            changes.push(`  旧: ${c.oldText}`);
            changes.push(`  新: ${c.newText}`);
            if (ctx) changes.push(ctx);
          } else if (c.type === "added") {
            changes.push(`🟢 新增文案： ${c.text}`);
            if (ctx) changes.push(ctx);
          } else if (c.type === "removed") {
            changes.push(`🔴 删除文案： ${c.text}`);
            if (ctx) changes.push(ctx);
          }
        }
      }
    } else { changes.push("页面文本内容变更"); }
  }
  if (oldF.i18nHash && newF.i18nHash && oldF.i18nHash !== newF.i18nHash) {
    const i18nDiff = diffI18nStrings(oldF.i18nStrings, newF.i18nStrings);
    if (i18nDiff.length > 0) {
      meta.i18nChangeCount = i18nDiff.length;
      meta.i18nDiffs = i18nDiff;
      appendI18nFullDiffLines(meta.fullDiffLines, i18nDiff);
      changes.push("📝 UI 文案（i18n）变更：");
      for (const c of i18nDiff) {
        if (c.type === "modified") { changes.push(`  ✏️ ${c.key}: "${c.oldValue}" → "${c.newValue}"`); }
        else if (c.type === "added") { changes.push(`  🟢 新增 ${c.key}: "${c.value}"`); }
        else if (c.type === "removed") { changes.push(`  🔴 删除 ${c.key}: "${c.value}"`); }
      }
    }
  } else if (!oldF.i18nHash && newF.i18nHash && newF.i18nStrings) {
    // 首次检测到 i18n 数据
    const keyCount = Object.keys(newF.i18nStrings).length;
    meta.i18nChangeCount = keyCount;
    changes.push(`📝 i18n 国际化字符串首次检测到：${keyCount} 条翻译`);
    meta.fullDiffLines.push("【UI 文案 i18n 首次检测】");
    for (const [key, value] of Object.entries(newF.i18nStrings)) meta.fullDiffLines.push(`${key}: ${value}`);
  }
  return { changes, meta };
}

/* ── HTML 快照保存 ── */
function saveHtmlSnapshot(url, html) {
  mkdirSync(CONFIG.snapshotDir, { recursive: true });
  const safeName = url.replace(/[^a-zA-Z0-9]/g, "_");
  const time = new Date().toISOString().replace(/[:.]/g, "-");
  const file = join(CONFIG.snapshotDir, `${safeName}_${time}.html`);
  writeFileSync(file, html, "utf-8");
  return file;
}

/**
 * 保存变更前的旧版文案和关键数据，供事后查阅
 * 写入 snapshots/<url>_<time>_old.txt
 */
function saveOldTextContent(url, oldFeatures) {
  try {
    mkdirSync(CONFIG.snapshotDir, { recursive: true });
    const safeName = url.replace(/[^a-zA-Z0-9]/g, "_");
    const time = new Date().toISOString().replace(/[:.]/g, "-");
    const file = join(CONFIG.snapshotDir, `${safeName}_${time}_old.txt`);
    const parts = [];
    parts.push(`=== 旧版快照 ===`);
    parts.push(`URL: ${url}`);
    parts.push(`保存时间: ${ts()}`);
    parts.push(`Content Hash: ${oldFeatures.contentHash || "N/A"}`);
    parts.push(`Asset Hash: ${oldFeatures.assetHash || "N/A"}`);
    parts.push("");
    parts.push("=== 页面文案 ===");
    parts.push(oldFeatures.textContent || "(空)");
    parts.push("");
    // Vault 配置
    if (oldFeatures.assetContents) {
      for (const [filename, data] of Object.entries(oldFeatures.assetContents)) {
        if (data.vaultConfigs?.length) {
          parts.push(`=== Vault 配置 (${filename}) ===`);
          parts.push(JSON.stringify(data.vaultConfigs, null, 2));
          parts.push("");
        }
      }
    }
    // i18n
    if (oldFeatures.i18nStrings) {
      const keys = Object.keys(oldFeatures.i18nStrings);
      parts.push(`=== i18n (${keys.length} keys) ===`);
      // 只保存 Vault 相关的 i18n 条目
      const vaultKeys = keys.filter(k => /vault|dividend|staking|lista/i.test(k));
      if (vaultKeys.length > 0) {
        for (const k of vaultKeys) {
          parts.push(`${k}: ${oldFeatures.i18nStrings[k]}`);
        }
      } else {
        parts.push("(无 Vault 相关 i18n 条目)");
      }
    }
    writeFileSync(file, parts.join("\n"), "utf-8");
    log(`[旧版保存] ${file}`);
  } catch (err) {
    log(`[旧版保存] 失败：${err.message}`);
  }
}

function cleanOldSnapshots(maxFiles = 100) {
  try {
    if (!existsSync(CONFIG.snapshotDir)) return;
    const files = readdirSync(CONFIG.snapshotDir)
      .filter(f => f.endsWith(".html"))
      .map(f => ({ name: f, time: statSync(join(CONFIG.snapshotDir, f)).mtimeMs }))
      .sort((a, b) => b.time - a.time);
    if (files.length > maxFiles) {
      for (const f of files.slice(maxFiles)) {
        unlinkSync(join(CONFIG.snapshotDir, f.name));
      }
      log(`[清理] 删除 ${files.length - maxFiles} 个旧快照文件`);
    }
  } catch (err) {
    log(`[清理] 快照清理失败：${err.message}`);
  }
}

function urlToKey(url) { return url.replace(/[^a-zA-Z0-9]/g, "_"); }

function collectSnapshotContractHints(snapshot = {}) {
  const hints = [];
  for (const page of Object.values(snapshot.pages || {})) hints.push(...(page?.contractHints || []));
  return [...new Map(hints.map(hint => [`${hint.kind}:${hint.address}`, hint])).values()];
}

function syncFlapContractIntegrityCatalog(state, snapshot = {}, factoryPoolState = {}) {
  return syncContractIntegrityCatalog(state, {
    vaultFactories: snapshot.vaultFactories || {},
    contractHints: collectSnapshotContractHints(snapshot),
    factoryAssets: factoryPoolState.assets || {},
  });
}

async function runFlapContractIntegrityPass(state, {
  snapshot = {},
  factoryPoolState = {},
  extended = false,
  forceCodeAudit = false,
  suppressNotifications = false,
  saveStateFn = saveContractIntegrityState,
} = {}) {
  if (!CONFIG.contractIntegrityMonitor.enabled) return { changed: false, changes: [], state };
  syncFlapContractIntegrityCatalog(state, snapshot, factoryPoolState);
  const stateResult = await runContractIntegrityStateScan({
    state,
    rpcCall: bscRpcCall,
    rpcBatch: calls => bscRpcBatch(calls),
    extended,
    forceCodeAudit,
    trackedAssetLimit: CONFIG.contractIntegrityMonitor.trackedAssetLimit,
    suppressFactoryImplementationChange: CONFIG.factoryPoolMonitor.enabled,
  });
  const eventResult = await scanContractIntegrityEvents({
    state,
    rpcCall: bscRpcCall,
    latestBlock: state.latestBlock,
    maxBlocks: CONFIG.contractIntegrityMonitor.eventMaxBlocksPerRun,
    suppressFactoryUpgrade: CONFIG.factoryPoolMonitor.enabled,
  });
  if (suppressNotifications && state.pendingChanges.length > 0) {
    acknowledgeContractIntegrityChanges(state, state.pendingChanges.map(change => change.id));
  }
  saveStateFn(CONFIG.contractIntegrityMonitor.stateFile, state);
  return {
    changed: stateResult.changed || eventResult.changed,
    changes: [...stateResult.changes, ...eventResult.changes],
    state,
    eventResult,
  };
}

async function deliverFlapContractIntegrityChanges(state, {
  titlePrefix = "",
  sendCardFn = sendCardViaApi,
  saveStateFn = saveContractIntegrityState,
  acknowledgeFn = acknowledgeContractIntegrityChanges,
} = {}) {
  const changes = [...(state.pendingChanges || [])];
  if (changes.length === 0) return { sent: false, changes: [] };
  const messageId = await sendAlertCard(
    sendCardFn,
    `${titlePrefix}Flap 合约与配置完整性变更`,
    buildContractIntegrityContent(changes, state),
    "red",
  );
  if (!messageId) return { sent: false, changes };
  acknowledgeFn(state, changes.map(change => change.id));
  saveStateFn(CONFIG.contractIntegrityMonitor.stateFile, state);
  return { sent: true, changes, messageId };
}

async function deliverFlapSafeProposalChanges(state, factoryPoolState, {
  titlePrefix = "",
  sendCardFn = sendCardViaApi,
  saveStateFn = saveSafeProposalState,
  acknowledgeFn = acknowledgeSafeProposalChanges,
} = {}) {
  const pending = [...(state.pendingChanges || [])];
  if (pending.length === 0) return { sent: false, changes: [] };
  const groups = [
    pending.filter(change => change.type !== "invalidated"),
    pending.filter(change => change.type === "invalidated"),
  ].filter(group => group.length > 0);
  const delivered = [];
  const messageIds = [];
  for (const changes of groups) {
    const invalidated = changes.every(change => change.type === "invalidated");
    const ready = changes.some(change => change.type === "ready");
    const title = invalidated
      ? `${titlePrefix}Flap 底池开放提案已失效`
      : ready
        ? `${titlePrefix}Flap 新底池即将开放`
        : `${titlePrefix}Flap 新底池准备开放`;
    const content = buildSafeProposalContent(changes, factoryPoolState?.assets || {});
    const messageId = invalidated
      ? await sendCardFn(title, content, "yellow")
      : await sendAlertCard(sendCardFn, title, content, "red");
    if (!messageId) continue;
    acknowledgeFn(state, changes.map(change => change.id));
    saveStateFn(CONFIG.safeProposalMonitor.stateFile, state);
    delivered.push(...changes);
    messageIds.push(messageId);
  }
  return { sent: delivered.length > 0, changes: delivered, messageIds };
}

/* ══════════════════════════════════════════
   单次检测模式（node monitor.mjs check）
   ══════════════════════════════════════════ */

async function runCheck() {
  log("=== 手动触发检测 ===");
  let snapshot = loadSnapshot() || { pages: {}, vaultFactories: {} };
  let hasDetectedChange = false;
  let hasNotifiedChange = false;
  const notifications = [];
  const roundAssetCache = new Map();
  const roundVaultFactoryEntries = [];

  // 并行抓取所有页面
  const tasks = CONFIG.urls.map((url, i) => sleep(i * 300).then(async () => {
    const html = await fetchPage(url);
    return { url, html };
  }));
  const pageResults = await Promise.allSettled(tasks);

  for (const r of pageResults) {
    if (r.status !== "fulfilled") { log(`  [失败] ${r.reason?.message}`); continue; }
    const { url, html } = r.value;
    const key = urlToKey(url);
    try {
      const features = extractPageFeatures(html, { url });
      assertValidFlapPage(url, html, features);
      const i18n = await fetchI18nStrings(features.assetFiles);
      if (i18n) { features.i18nStrings = i18n.i18nStrings; features.i18nHash = i18n.i18nHash; features.i18nChunk = i18n.i18nChunk; }
      const oldForAssets = snapshot.pages[key];
      const oldAssetQuality = oldForAssets ? getStoredFeatureQuality(url, oldForAssets) : null;
      await hydrateAssetContents(features, oldAssetQuality?.valid ? oldForAssets : null, { roundAssetCache });

      collectRoundVaultFactory(roundVaultFactoryEntries, url, features);

      if (!snapshot.pages[key]) {
        log(`  [初始化] ${url} — 首次记录`);
        snapshot.pages[key] = features;
        snapshot.pages[key].originalUrl = url;
        continue;
      }
      const oldFeatures = snapshot.pages[key];
      const oldQuality = getStoredFeatureQuality(url, oldFeatures);
      if (!oldQuality.valid) {
        log(`  [基线修复 Baseline Repair] ${url} — 旧快照无效，已用当前有效页面重建基线：${oldQuality.reasons.join("; ")}`);
        hasDetectedChange = true;
        const sent = await sendFeishu(
          "Flap 基线已修复",
          buildOperationalNoticeContent({
            status: "Flap 基线已修复",
            url,
            severity: "yellow",
            reason: oldQuality.reasons.join("; "),
            detail: formatQualityIssue(url, oldQuality),
          }),
          "yellow"
        );
        if (sent) {
          hasNotifiedChange = true;
          snapshot.pages[key] = features;
          snapshot.pages[key].originalUrl = url;
        }
        continue;
      }
      const { changes, meta } = diffFeatures(oldFeatures, features);
      if (changes.length > 0) {
        log(`  [变更] ${url}`);
        for (const c of changes) log(`    ${c}`);
        hasDetectedChange = true;
        saveHtmlSnapshot(url, html);
        // 保存详细 diff 到文件
        saveDetailedDiff(url, changes);
        notifications.push({
          url,
          changes,
          meta,
          title: meta.metadataSchemaDiffs?.length ? "手动检测 — Flap metadata schema 变更" : "手动检测 — 页面变更",
          content: meta.metadataSchemaDiffs?.length ? buildMetadataSchemaWarningContent(url, meta.metadataSchemaDiffs) : undefined,
          template: "red",
          snapshotUpdate: { key, features: { ...features, originalUrl: url } },
        });
      } else {
        if (shouldRefreshDerivedFeatureBaseline(oldFeatures, features)) {
          snapshot.pages[key] = features;
          snapshot.pages[key].originalUrl = url;
          log(`  [基线补全] ${url} — 已保存 CAstore 金库结构，未发现业务变更`);
        } else {
          log(`  [正常] ${url} — 无变化`);
        }
      }
    } catch (err) { log(`  [失败] ${url} — ${err.message}`); }
  }
  const vfResult = await sendRoundVaultFactoryChange({
    snapshot,
    roundVaultFactoryEntries,
    titlePrefix: "手动检测 — ",
  });
  if (vfResult.changed) hasDetectedChange = true;
  if (vfResult.sent) hasNotifiedChange = true;
  try {
    const registryResult = await checkFlapRegistryLogs(snapshot, { titlePrefix: "手动检测 — " });
    if (registryResult.changed) hasDetectedChange = true;
    if (registryResult.sent) hasNotifiedChange = true;
  } catch (err) {
    log(`[Flap Vault Portal] 手动检测失败：${err.message}`);
  }
  try {
    const factoryPoolState = loadFactoryPoolState(CONFIG.factoryPoolMonitor.stateFile, CONFIG.factoryPoolMonitor.proxy);
    const factoryResult = await checkFlapFactoryPools(factoryPoolState, { titlePrefix: "手动检测 — " });
    if (factoryResult.changed) hasDetectedChange = true;
    if (factoryResult.sent) hasNotifiedChange = true;
  } catch (err) {
    log(`[Flap Factory] 手动检测失败：${err.message}`);
  }
  try {
    if (CONFIG.safeProposalMonitor.enabled) {
      const factoryPoolState = loadFactoryPoolState(CONFIG.factoryPoolMonitor.stateFile, CONFIG.factoryPoolMonitor.proxy);
      const safeProposalState = loadSafeProposalState(
        CONFIG.safeProposalMonitor.stateFile,
        CONFIG.safeProposalMonitor.safes,
      );
      const safeResult = await runSafeProposalScan({
        state: safeProposalState,
        safes: CONFIG.safeProposalMonitor.safes,
        factoryAddress: CONFIG.factoryPoolMonitor.proxy,
        rpcBatch: bscRpcBatch,
        apiBaseUrl: CONFIG.safeProposalMonitor.apiBaseUrl,
        apiKey: CONFIG.safeProposalMonitor.apiKey,
        timeoutMs: CONFIG.safeProposalMonitor.requestTimeoutMs,
      });
      saveSafeProposalState(CONFIG.safeProposalMonitor.stateFile, safeProposalState);
      if (safeResult.changed) hasDetectedChange = true;
      if (safeProposalState.pendingChanges.length > 0) {
        const delivery = await deliverFlapSafeProposalChanges(safeProposalState, factoryPoolState, {
          titlePrefix: "手动检测 — ",
        });
        if (delivery.sent) hasNotifiedChange = true;
      }
    }
  } catch (err) {
    log(`[Flap Safe 提案] 手动检测失败：${err.message}`);
  }
  try {
    const factoryPoolState = loadFactoryPoolState(CONFIG.factoryPoolMonitor.stateFile, CONFIG.factoryPoolMonitor.proxy);
    const integrityState = loadContractIntegrityState(CONFIG.contractIntegrityMonitor.stateFile);
    const hasBaseline = Object.keys(integrityState.contracts || {}).length > 0;
    const integrityResult = await runFlapContractIntegrityPass(integrityState, {
      snapshot,
      factoryPoolState,
      extended: true,
      forceCodeAudit: true,
      suppressNotifications: !hasBaseline,
    });
    if (integrityResult.changed) hasDetectedChange = true;
    if (hasBaseline) {
      const delivery = await deliverFlapContractIntegrityChanges(integrityState, { titlePrefix: "手动检测 — " });
      if (delivery.sent) hasNotifiedChange = true;
    }
  } catch (err) {
    log(`[Flap 合约完整性] 手动检测失败：${err.message}`);
  }

  for (const n of coalesceFlapNotifications(notifications, { titlePrefix: "手动检测 — " })) {
    for (const diff of getStandaloneCaStoreVaultDiffs(n)) {
      const card = buildCaStoreVaultChangeNotification(diff, snapshot.vaultFactories || {}, { titlePrefix: "手动检测 — " });
      await sendCaStoreVaultChangeNotification(card);
    }
    const pageNotification = omitStandaloneCaStoreVaultDiffs(n);
    if (!shouldSuppressCaStoreOnlyPageNotification(n) && hasNotificationPayload(pageNotification)) {
      await sendFlapChangeNotification(pageNotification, { moduleContext: `Flap.sh 手动检测 ${n.url}`, diffTitle: "=== Flap.sh 手动检测详细 Diff ===", titlePrefix: "手动检测 — " });
    }
    const updates = [
      ...(n.snapshotUpdates || []),
      ...(n.snapshotUpdate ? [n.snapshotUpdate] : []),
    ];
    for (const update of updates) {
      snapshot.pages[update.key] = update.features;
    }
    hasNotifiedChange = true;
  }
  saveSnapshot(snapshot);
  if (hasDetectedChange) {
    log(hasNotifiedChange ? "=== 检测完成：发现变更（已通知飞书）===" : "=== 检测完成：发现变更，但通知未成功 ===");
  } else {
    log("=== 检测完成：无变更 ===");
  }
}

/* ══════════════════════════════════════════
   持续监控模式（主循环）
   ══════════════════════════════════════════ */

function factoryPoolWssDisplay(state = {}) {
  const health = state.wssHealth;
  if (!health || health.enabled !== true) {
    return { status: "未启用", statusCode: "disabled", subscribed: "0/0", backfill: "未启用", backfillStatus: "disabled", lastSubscribed: "暂无", lastEvent: "暂无", wssError: "", backfillError: "" };
  }
  const statusMap = { healthy: "运行正常", degraded: "部分可用", connecting: "连接中", reconnecting: "重连中", stopped: "已停止", disabled: "未启用" };
  const backfillStatus = health.backfill?.status || "idle";
  const backfillMap = { idle: "等待", running: "进行中", completed: "已完成", failed: "失败" };
  const backfillLabel = backfillMap[backfillStatus] || backfillStatus;
  const backfill = backfillStatus === "completed" && Number.isFinite(Number(health.backfill?.fromBlock))
    ? `${backfillLabel}｜范围 ${health.backfill.fromBlock} → ${health.backfill.toBlock}｜事件 ${Number(health.backfill.eventCount) || 0} 条`
    : backfillLabel;
  return {
    status: statusMap[health.status] || health.status || "未知",
    statusCode: health.status || "unknown",
    subscribed: `${Number(health.subscribedCount) || 0}/${Number(health.configuredCount) || 0}`,
    backfill,
    backfillStatus,
    lastSubscribed: health.lastSubscribedAt ? new Date(health.lastSubscribedAt).toLocaleString("zh-CN", { hour12: false }) : "暂无",
    lastEvent: health.lastEventAt ? new Date(health.lastEventAt).toLocaleString("zh-CN", { hour12: false }) : "暂无",
    wssError: health.lastError || "",
    backfillError: health.backfill?.lastError || "",
  };
}

function safeProposalDisplay(state = {}) {
  const safeStates = Object.values(state.safes || {});
  const active = Object.values(state.proposals || {}).filter(proposal => ["pending", "ready"].includes(proposal?.status));
  const healthyCount = safeStates.filter(item => item?.baselineEstablished && !item?.lastError).length;
  const status = !CONFIG.safeProposalMonitor.enabled
    ? "未启用"
    : safeStates.some(item => item?.lastError)
      ? "部分异常"
      : safeStates.every(item => item?.baselineEstablished)
        ? "运行正常"
        : "正在建立基线";
  const retryAt = safeStates
    .map(item => Number(item?.nextAttemptAtMs) || 0)
    .filter(value => value > Date.now())
    .sort((a, b) => a - b)[0] || 0;
  return {
    status,
    safeStates,
    healthyCount,
    active,
    lastSuccess: state.lastSuccessAt
      ? new Date(state.lastSuccessAt).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" })
      : "暂无",
    retryAt: retryAt ? new Date(retryAt).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" }) : "暂无",
    usingCache: safeStates.some(item => item?.lastError && item?.lastSuccessAt),
  };
}

function buildFlapStartupContent(
  snapshot = {},
  hostname = "未知",
  factoryPoolState = createFactoryPoolState(CONFIG.factoryPoolMonitor.proxy),
  contractIntegrityState = {},
  safeProposalState = createSafeProposalState(CONFIG.safeProposalMonitor.safes),
) {
  const pages = Object.values(snapshot.pages || {});
  const factories = Object.values(snapshot.vaultFactories || {}).filter(factory => factory?.showInCAStore === true);
  const registry = snapshot.registryMonitor || {};
  const pageLines = CONFIG.urls.map((url, index) => {
    const page = pages.find(item => item?.originalUrl === url) || {};
    const assets = page.assetFiles?.length || 0;
    const i18n = Object.keys(page.i18nStrings || {}).length;
    return `${String(index + 1).padStart(2, "0")}　[${url}](${url})｜资源 ${assets} 个｜i18n ${i18n} 条`;
  });
  const factoryLines = factories.length > 0
    ? factories.map((factory, index) => {
        const name = factory.name || factory.id || "未命名金库";
        const address = factory.factory || factory.address || "无地址";
        const launch = vaultLaunchLink(address, "打开金库");
        return `${String(index + 1).padStart(2, "0")}　${name}｜状态 ${factory.enabled ? "已启用" : "未启用"}｜地址 ${addressLink(address)}${launch ? `｜金库 ${launch}` : ""}`;
      })
    : ["当前没有配置为 CAStore 展示的金库"];
  const robinhoodLaunchUrl = buildVaultFactoryLaunchUrl(ROBINHOOD_INDEX_VAULT_FACTORY, { chain: "robinhood" });
  const poolAssets = Object.values(factoryPoolState.assets || {}).sort((a, b) => a.quoteToken.localeCompare(b.quoteToken));
  const factoryRealtimeLag = Math.max(0, (factoryPoolState.safeLatestBlock || 0) - (factoryPoolState.headLastScannedBlock || 0));
  const factoryWss = factoryPoolWssDisplay(factoryPoolState);
  const factoryStatus = factoryPoolState.lastError
    ? "需要关注"
    : factoryWss.statusCode === "reconnecting" || factoryWss.statusCode === "stopped" || factoryWss.backfillStatus === "failed"
      ? "需要关注"
      : factoryWss.statusCode === "connecting"
        ? "连接中"
        : factoryWss.statusCode === "degraded"
          ? "部分可用"
          : factoryRealtimeLag > CONFIG.factoryPoolMonitor.realtimeMaxBlocksPerRun ? "存在延迟" : "运行正常";
  const poolAssetLines = poolAssets.length > 0
    ? poolAssets.map((asset, index) =>
        `${String(index + 1).padStart(2, "0")}　${formatFactoryPoolAssetName(asset)}｜状态 ${formatFactoryPoolAssetStatus(asset)}｜地址 ${addressLink(asset.quoteToken)}`)
    : ["尚未发现已配置的 Factory 底池资产"];
  const safeProposal = safeProposalDisplay(safeProposalState);
  const safeLines = safeProposal.safeStates.length > 0
    ? safeProposal.safeStates.map((item, index) =>
        `${String(index + 1).padStart(2, "0")}　Safe ${addressLink(item.address)}｜nonce ${item.currentNonce ?? "未知"}｜${item.lastError ? "异常" : item.baselineEstablished ? "基线完成" : "等待基线"}`)
    : ["尚未配置 Flap 管理 Safe"];
  return [
    "**01｜运行状态**",
    "状态：监控运行中",
    `服务器：${hostname}`,
    `轮询间隔：${CONFIG.pollIntervalMs}ms｜请求抖动 ±${CONFIG.jitterMs}ms｜请求超时 ${CONFIG.fetchTimeoutMs}ms`,
    `连续失败告警阈值：${CONFIG.failThreshold} 次`,
    "",
    "**02｜页面监控**",
    ...pageLines,
    "",
    "**03｜CAStore 金库**",
    `展示数量：${factories.length}`,
    ...factoryLines,
    "",
    "**04｜Robinhood CAStore**",
    `页面：[https://flap.sh/robinhood/CAstore?lang=zh](https://flap.sh/robinhood/CAstore?lang=zh)`,
    "模板：币股（IndexVault）｜状态 监控中",
    `Factory：${flapLink(ROBINHOOD_INDEX_VAULT_FACTORY, robinhoodLaunchUrl)}`,
    `金库入口：${flapLink(robinhoodLaunchUrl, robinhoodLaunchUrl)}`,
    "",
    "**05｜Factory 底池资产**",
    `Factory Proxy：${addressLink(factoryPoolState.proxy || CONFIG.factoryPoolMonitor.proxy)}`,
    `监控状态：${factoryStatus}`,
    `实时通道：${factoryWss.status}｜已订阅 ${factoryWss.subscribed}｜最后订阅 ${factoryWss.lastSubscribed}｜最后事件 ${factoryWss.lastEvent}`,
    `HTTP 兜底：已扫 ${factoryPoolState.headLastScannedBlock ?? "尚未建立"}｜最新 ${factoryPoolState.latestBlock ?? factoryPoolState.safeLatestBlock ?? "尚未建立"}｜延迟 ${factoryRealtimeLag} 块`,
    `短窗口回扫：${factoryWss.backfill}`,
    ...(factoryWss.wssError ? [`实时通道异常：${factoryWss.wssError}`] : []),
    ...(factoryWss.backfillError ? [`短窗口回扫异常：${factoryWss.backfillError}`] : []),
    `资产数量：${poolAssets.length}｜支持创建 ${poolAssets.filter(asset => asset.effectiveEnabled).length}｜暂停创建 ${poolAssets.filter(asset => asset.configured && asset.creationDisabled).length}｜已停用 ${poolAssets.filter(asset => !asset.configured).length}`,
    ...poolAssetLines,
    "",
    "**06｜Vault Portal 链上注册**",
    `Vault Portal：${addressLink(CONFIG.registryMonitor.address)}`,
    `确认块：${CONFIG.registryMonitor.confirmations}`,
    `启动回溯：${CONFIG.registryMonitor.bootstrapLookbackBlocks} 块`,
    `单轮最大扫描：${CONFIG.registryMonitor.maxBlocksPerRun} 块`,
    `已扫描区块：${registry.lastBlock ?? "尚未建立"}｜安全区块 ${registry.safeLatestBlock ?? "尚未建立"}｜最新区块 ${registry.latestBlock ?? "尚未建立"}`,
    `已知链上金库：${Object.keys(registry.knownVaults || {}).length} 个`,
    "",
    "**07｜合约与配置完整性**",
    `监控状态：${CONFIG.contractIntegrityMonitor.enabled ? (contractIntegrityState.lastError ? "需要关注" : "运行正常") : "未启用"}`,
    `合约目录：${Object.keys(contractIntegrityState.catalog || {}).length} 个｜已知资产：${Object.keys(contractIntegrityState.trackedAssets || {}).length} 个`,
    `核心批量校验：${CONFIG.contractIntegrityMonitor.coreIntervalMs / 1000} 秒｜扩展轮转：${CONFIG.contractIntegrityMonitor.extendedIntervalMs / 1000} 秒｜代码审计：${CONFIG.contractIntegrityMonitor.codeAuditIntervalMs / 1000} 秒`,
    `事件通道：精准地址 WSS + ${CONFIG.contractIntegrityMonitor.coreIntervalMs / 1000} 秒 HTTP 日志兜底`,
    "",
    "**08｜Safe 开放提案预警**",
    `监控状态：${safeProposal.status}`,
    `轮询间隔：空闲 ${CONFIG.safeProposalMonitor.intervalMs / 1000} 秒｜活跃 ${CONFIG.safeProposalMonitor.activeIntervalMs / 1000} 秒｜健康 Safe ${safeProposal.healthyCount}/${safeProposal.safeStates.length}｜最后成功 ${safeProposal.lastSuccess}`,
    `有效待执行目标：${safeProposal.active.length} 个`,
    ...(safeProposal.usingCache ? [`数据状态：Safe API 限流，沿用最后成功快照｜下次重试 ${safeProposal.retryAt}`] : []),
    ...safeLines,
    ...(safeProposalState.lastError ? [`最近异常：${safeProposalState.lastError}`] : []),
    "",
    "**09｜RPC 节点**",
    ...CONFIG.bscRpcUrls.map((url, index) => `${String(index + 1).padStart(2, "0")}　[${url}](${url})`),
  ].join("\n");
}

async function startMonitor() {
  let snapshot = loadSnapshot() || { pages: {}, vaultFactories: {} };
  const factoryPoolState = loadFactoryPoolState(CONFIG.factoryPoolMonitor.stateFile, CONFIG.factoryPoolMonitor.proxy);
  const contractIntegrityState = loadContractIntegrityState(CONFIG.contractIntegrityMonitor.stateFile);
  const safeProposalState = loadSafeProposalState(
    CONFIG.safeProposalMonitor.stateFile,
    CONFIG.safeProposalMonitor.safes,
  );
  let contractIntegrityMutationQueue = Promise.resolve();
  let contractIntegrityDeliveryPromise = null;
  let contractIntegrityWsFeed = null;
  let contractIntegrityWsFingerprint = "";

  function enqueueContractIntegrityMutation(operation) {
    const job = contractIntegrityMutationQueue.then(operation, operation);
    contractIntegrityMutationQueue = job.catch(() => undefined);
    return job;
  }

  function scheduleContractIntegrityDelivery(titlePrefix = "") {
    if (!CONFIG.contractIntegrityMonitor.enabled || contractIntegrityDeliveryPromise) return contractIntegrityDeliveryPromise;
    contractIntegrityDeliveryPromise = (async () => {
      const pendingCount = await enqueueContractIntegrityMutation(() => contractIntegrityState.pendingChanges.length);
      if (pendingCount === 0) return { sent: false };
      if (!canAttemptFeishuDelivery()) return { sent: false, deliveryDeferred: true };
      try {
        const changes = await enqueueContractIntegrityMutation(() => [...contractIntegrityState.pendingChanges]);
        const messageId = await sendAlertCard(
          sendCardViaApi,
          `${titlePrefix}Flap 合约与配置完整性变更`,
          buildContractIntegrityContent(changes, contractIntegrityState),
          "red",
        );
        if (!messageId) return { sent: false };
        await enqueueContractIntegrityMutation(() => {
          acknowledgeContractIntegrityChanges(contractIntegrityState, changes.map(change => change.id));
          saveContractIntegrityState(CONFIG.contractIntegrityMonitor.stateFile, contractIntegrityState);
        });
        return { sent: true };
      } catch (error) {
        log(`[Flap 合约完整性] 待发送变更已保留：${error.message}`);
        return { sent: false, error };
      }
    })().finally(() => { contractIntegrityDeliveryPromise = null; });
    return contractIntegrityDeliveryPromise;
  }

  async function refreshContractIntegrityWsFeed() {
    if (!CONFIG.contractIntegrityMonitor.enabled || !CONFIG.contractIntegrityMonitor.wsEnabled
      || CONFIG.contractIntegrityMonitor.wsUrls.length === 0) return;
    const addresses = contractIntegritySubscriptionAddresses(contractIntegrityState);
    const fingerprint = addresses.join(",");
    if (fingerprint === contractIntegrityWsFingerprint) return;
    contractIntegrityWsFingerprint = fingerprint;
    contractIntegrityWsFeed?.stop();
    contractIntegrityWsFeed = null;
    if (addresses.length === 0) return;
    contractIntegrityWsFeed = createFactoryPoolWsFeed({
      urls: CONFIG.contractIntegrityMonitor.wsUrls,
      proxy: addresses,
      topics: [],
      label: "Flap 合约完整性 WSS",
      onEvent: event => processContractIntegrityEvent(event, "integrity-wss"),
      onStatus: health => enqueueContractIntegrityMutation(() => {
        contractIntegrityState.wssHealth = { ...(contractIntegrityState.wssHealth || {}), contracts: health };
        saveContractIntegrityState(CONFIG.contractIntegrityMonitor.stateFile, contractIntegrityState);
      }),
    }).start();
    global.__contractIntegrityWsFeed = contractIntegrityWsFeed;
  }

  async function processContractIntegrityEvent(event, source) {
    const subscriptionFingerprintBefore = contractIntegritySubscriptionAddresses(contractIntegrityState).join(",");
    const result = await enqueueContractIntegrityMutation(() => {
      const outcome = ingestContractIntegrityEvent(contractIntegrityState, event, source, {
        suppressFactoryUpgrade: CONFIG.factoryPoolMonitor.enabled,
      });
      if (outcome.processed) saveContractIntegrityState(CONFIG.contractIntegrityMonitor.stateFile, contractIntegrityState);
      return outcome;
    });
    if (contractIntegritySubscriptionAddresses(contractIntegrityState).join(",") !== subscriptionFingerprintBefore) {
      await refreshContractIntegrityWsFeed();
    }
    if (result.change) void scheduleContractIntegrityDelivery();
    return result;
  }

  async function contractIntegrityPoll({ suppressNotifications = false, forceExtended = false, forceCodeAudit = false } = {}) {
    if (!CONFIG.contractIntegrityMonitor.enabled) return;
    const now = Date.now();
    const extendedDue = forceExtended || now - (Date.parse(contractIntegrityState.lastExtendedScanAt || "") || 0) >= CONFIG.contractIntegrityMonitor.extendedIntervalMs;
    const codeAuditDue = forceCodeAudit || now - (Date.parse(contractIntegrityState.lastCodeAuditAt || "") || 0) >= CONFIG.contractIntegrityMonitor.codeAuditIntervalMs;
    try {
      await enqueueContractIntegrityMutation(() => runFlapContractIntegrityPass(contractIntegrityState, {
        snapshot,
        factoryPoolState,
        extended: extendedDue,
        forceCodeAudit: codeAuditDue,
        suppressNotifications,
      }));
      await refreshContractIntegrityWsFeed();
      if (!suppressNotifications) void scheduleContractIntegrityDelivery();
    } catch (error) {
      await enqueueContractIntegrityMutation(() => {
        contractIntegrityState.lastError = error.message;
        saveContractIntegrityState(CONFIG.contractIntegrityMonitor.stateFile, contractIntegrityState);
      });
      log(`[Flap 合约完整性] 检测失败：${error.message}`);
    }
  }

  global.__contractIntegrityMutationDrain = () => contractIntegrityMutationQueue;
  global.__contractIntegrityDeliveryDrain = async () => {
    if (contractIntegrityDeliveryPromise) await contractIntegrityDeliveryPromise;
  };
  let safeProposalPollPromise = null;
  let safeProposalDeliveryPromise = null;

  function scheduleSafeProposalDelivery(titlePrefix = "") {
    if (!CONFIG.safeProposalMonitor.enabled || safeProposalDeliveryPromise) return safeProposalDeliveryPromise;
    if (safeProposalState.pendingChanges.length === 0 || !canAttemptFeishuDelivery()) return null;
    safeProposalDeliveryPromise = deliverFlapSafeProposalChanges(safeProposalState, factoryPoolState, { titlePrefix })
      .catch(error => {
        log(`[Flap Safe 提案] 待发送变更已保留：${error.message}`);
        return { sent: false, error };
      })
      .finally(() => { safeProposalDeliveryPromise = null; });
    return safeProposalDeliveryPromise;
  }

  async function safeProposalPoll({ suppressNotifications = false, titlePrefix = "" } = {}) {
    if (!CONFIG.safeProposalMonitor.enabled) return { changed: false, skipped: true };
    if (safeProposalPollPromise) return await safeProposalPollPromise;
    safeProposalPollPromise = (async () => {
      const previousError = safeProposalState.lastError || "";
      try {
        const result = await runSafeProposalScan({
          state: safeProposalState,
          safes: CONFIG.safeProposalMonitor.safes,
          factoryAddress: CONFIG.factoryPoolMonitor.proxy,
          rpcBatch: bscRpcBatch,
          apiBaseUrl: CONFIG.safeProposalMonitor.apiBaseUrl,
          apiKey: CONFIG.safeProposalMonitor.apiKey,
          timeoutMs: CONFIG.safeProposalMonitor.requestTimeoutMs,
          suppressNotifications,
        });
        saveSafeProposalState(CONFIG.safeProposalMonitor.stateFile, safeProposalState);
        for (const change of result.changes) {
          log(`[Flap Safe 提案] ${change.type}｜${change.quoteToken}｜确认 ${change.confirmations}/${change.required}｜nonce ${change.nonce}`);
        }
        if (safeProposalState.lastError && safeProposalState.lastError !== previousError) {
          log(`[Flap Safe 提案] 部分检测异常：${safeProposalState.lastError}`);
        } else if (!safeProposalState.lastError && previousError) {
          log("[Flap Safe 提案] 检测已恢复");
        }
        if (!suppressNotifications) void scheduleSafeProposalDelivery(titlePrefix);
        return result;
      } catch (error) {
        safeProposalState.lastRunAt = ts();
        safeProposalState.lastError = error.message;
        saveSafeProposalState(CONFIG.safeProposalMonitor.stateFile, safeProposalState);
        throw error;
      }
    })().finally(() => { safeProposalPollPromise = null; });
    return await safeProposalPollPromise;
  }

  global.__safeProposalDrain = async () => {
    if (safeProposalPollPromise) await safeProposalPollPromise;
    if (safeProposalDeliveryPromise) await safeProposalDeliveryPromise;
  };
  // failCounts 改为对象结构，记录失败次数、最近错误信息和时间
  const failCounts = {};  // key -> { count, lastMsg, lastFailTime, hourlyErrors }
  const backoffSkips = {};  // key -> number of polls skipped due to domain backoff
  let pollCount = 0;
  let isPolling = false;

  log("=== Flap 监控 v2 启动 ===");
  log(`轮询间隔: ${CONFIG.pollIntervalMs}ms + 抖动 ±${CONFIG.jitterMs}ms`);
  log(`反风控：UA 轮换（${UA_POOL.length} 个）+ 按页面/资源路径自适应退避`);
  log("监控目标:");
  for (const url of CONFIG.urls) log(`  - ${url}`);

  // 初始化基线（并行抓取）
  let needsInit = false;
  for (const url of CONFIG.urls) {
    const key = urlToKey(url);
    failCounts[key] = { count: 0, lastMsg: "", lastFailTime: 0, hourlyErrors: [] };
    if (!snapshot.pages[key]) needsInit = true;
  }

  if (needsInit) {
    log("首次运行，正在并行建立基线……");
    const initAssetCache = new Map();
    const tasks = CONFIG.urls.map((url, i) => sleep(i * 300).then(async () => {
      const key = urlToKey(url);
      const html = await fetchPage(url);
      const features = extractPageFeatures(html, { url });
      features.originalUrl = url;
      assertValidFlapPage(url, html, features);
      const i18n = await fetchI18nStrings(features.assetFiles);
      if (i18n) { features.i18nStrings = i18n.i18nStrings; features.i18nHash = i18n.i18nHash; features.i18nChunk = i18n.i18nChunk; }
      // 下载资源内容用于内容级 diff
      const hydrateStats = await hydrateAssetContents(features, null, { roundAssetCache: initAssetCache });
      const dlCount = hydrateStats.downloaded;
      return { key, features, i18n, dlCount };
    }));
    const results = await Promise.allSettled(tasks);
    const initVaultFactoryEntries = [];
    for (const r of results) {
      if (r.status === "fulfilled") {
        const { key, features, i18n, dlCount } = r.value;
        snapshot.pages[key] = features;
        const url = features.originalUrl;
        log(`  ${url} — 正常（资源 ${features.assetFiles.length} 个，已下载 ${dlCount} 个，Next 数据: ${features.nextDataHash ? "有" : "无"}，国际化 i18n: ${i18n ? Object.keys(i18n.i18nStrings).length + " 条" : "无"}）`);
        collectRoundVaultFactory(initVaultFactoryEntries, url, features);
      } else {
        log(`  基线获取失败：${r.reason?.message}`);
      }
    }
    if (initVaultFactoryEntries.length > 0) {
      const { map } = mergeRoundVaultFactoryMaps(initVaultFactoryEntries);
      snapshot.vaultFactories = map;
      log(`  [金库工厂 VaultFactory] 基线记录 ${Object.keys(snapshot.vaultFactories).length} 个金库工厂`);
    }
    saveSnapshot(snapshot);
  }

  if (CONFIG.factoryPoolMonitor.enabled) {
    try {
      const hasFactoryBaseline = Number.isFinite(factoryPoolState.headLastScannedBlock)
        || Number.isFinite(factoryPoolState.lastScannedBlock);
      await checkFlapFactoryPools(factoryPoolState, {
        suppressNotifications: !hasFactoryBaseline,
        scanConfig: { scanRealtime: true, scanCatchup: false, scanAssets: false },
      });
    } catch (err) {
      try { await recordFactoryPoolScanError(factoryPoolState, err); } catch {}
      log(`[Flap Factory] 启动检测失败：${err.message}`);
    }
  }

  if (CONFIG.contractIntegrityMonitor.enabled) {
    const hasIntegrityBaseline = Object.keys(contractIntegrityState.contracts || {}).length > 0;
    await contractIntegrityPoll({
      suppressNotifications: !hasIntegrityBaseline,
      forceExtended: true,
      forceCodeAudit: true,
    });
    if (hasIntegrityBaseline) void scheduleContractIntegrityDelivery();
  }

  if (CONFIG.safeProposalMonitor.enabled) {
    try {
      await safeProposalPoll();
    } catch (error) {
      log(`[Flap Safe 提案] 启动检测失败：${error.message}`);
    }
  }

  const factoryPoolEventQueue = createFactoryPoolEventQueue(factoryPoolState);
  global.__factoryPoolEventQueueDrain = factoryPoolEventQueue.drain;
  let firstFactoryWsSubscription = Promise.resolve();
  if (CONFIG.factoryPoolMonitor.enabled && CONFIG.factoryPoolMonitor.wsEnabled && CONFIG.factoryPoolMonitor.wsUrls.length > 0) {
    let backfillStarted = false;
    let resolveFirstFactoryWsSubscription;
    firstFactoryWsSubscription = new Promise(resolve => { resolveFirstFactoryWsSubscription = resolve; });
    const factoryPoolTopics = [...new Set([
      ...FACTORY_POOL_STATE_EVENT_TOPICS,
      ...(CONFIG.contractIntegrityMonitor.enabled ? CONTRACT_INTEGRITY_FACTORY_EVENT_TOPICS : []),
    ])];
    const factoryPoolTopicSet = new Set(FACTORY_POOL_STATE_EVENT_TOPICS);
    const integrityFactoryTopicSet = new Set(CONTRACT_INTEGRITY_FACTORY_EVENT_TOPICS);
    const factoryPoolWsFeed = createFactoryPoolWsFeed({
      urls: CONFIG.factoryPoolMonitor.wsUrls,
      proxy: CONFIG.factoryPoolMonitor.proxy,
      topics: factoryPoolTopics,
      onEvent: event => {
        const topic0 = String(event?.topics?.[0] || "").toLowerCase();
        if (factoryPoolTopicSet.has(topic0)) void factoryPoolEventQueue.enqueue(event, "factory-wss");
        if (CONFIG.contractIntegrityMonitor.enabled && integrityFactoryTopicSet.has(topic0)) void processContractIntegrityEvent(event, "factory-wss");
      },
      onStatus: health => recordFactoryPoolWsHealth(factoryPoolState, health),
      onSubscribed: async () => {
        await recordFactoryPoolWsHealth(factoryPoolState, factoryPoolWsFeed.snapshot());
        resolveFirstFactoryWsSubscription();
        if (backfillStarted) return;
        backfillStarted = true;
        await recordFactoryPoolWsBackfill(factoryPoolState, {
          status: "running",
          startedAt: new Date().toISOString(),
          completedAt: "",
          lastError: "",
        });
        try {
          const backfill = await backfillFactoryPoolFeedEvents(factoryPoolEventQueue);
          await recordFactoryPoolWsBackfill(factoryPoolState, {
            status: "completed",
            fromBlock: backfill.fromBlock,
            toBlock: backfill.latest,
            eventCount: backfill.eventCount,
            completedAt: new Date().toISOString(),
            lastError: "",
          });
        } catch (error) {
          backfillStarted = false;
          await recordFactoryPoolWsBackfill(factoryPoolState, {
            status: "failed",
            completedAt: new Date().toISOString(),
            lastError: error.message,
          });
          throw error;
        }
      },
    });
    global.__factoryPoolWsFeed = factoryPoolWsFeed.start();
  } else {
    await recordFactoryPoolWsHealth(factoryPoolState, createFactoryPoolWsHealth());
    log("[Flap Factory WSS] 未启用或未配置节点，继续使用 1 秒 HTTP 扫描");
  }
  await refreshContractIntegrityWsFeed();

  await Promise.race([firstFactoryWsSubscription, sleep(2_500)]);

  await sendFeishu(
    "Flap 监控 v2 已启动",
    buildFlapStartupContent(
      snapshot,
      (await import("node:os")).hostname(),
      factoryPoolState,
      contractIntegrityState,
      safeProposalState,
    ),
    "blue"
  );

  let isFactoryRealtimeScanning = false;
  let isFactoryCatchupScanning = false;
  let isFactoryAssetScanning = false;
  let isFactoryBackgroundScanning = false;
  function getFactoryRealtimeLag() {
    const latest = Number(factoryPoolState.latestBlock);
    const scanned = Number(factoryPoolState.headLastScannedBlock);
    return Number.isFinite(latest) && Number.isFinite(scanned) ? Math.max(0, latest - scanned) : 0;
  }
  function shouldDeferFactoryBackgroundScan() {
    return isFactoryRealtimeScanning || getFactoryRealtimeLag() > CONFIG.factoryPoolMonitor.realtimeMaxBlocksPerRun;
  }
  async function factoryPoolRealtimePoll() {
    if (!CONFIG.factoryPoolMonitor.enabled || isFactoryRealtimeScanning) return;
    isFactoryRealtimeScanning = true;
    try {
      await checkFlapFactoryPools(factoryPoolState, {
        scanConfig: { scanRealtime: true, scanCatchup: false, scanAssets: false },
        awaitDelivery: false,
      });
    } catch (err) {
      try { await recordFactoryPoolScanError(factoryPoolState, err); } catch {}
      log(`[Flap Factory 实时] 检测失败：${err.message}`);
    } finally {
      isFactoryRealtimeScanning = false;
    }
  }

  async function factoryPoolAssetPoll() {
    if (!CONFIG.factoryPoolMonitor.enabled || isFactoryAssetScanning || isFactoryBackgroundScanning || shouldDeferFactoryBackgroundScan()) return;
    isFactoryAssetScanning = true;
    isFactoryBackgroundScanning = true;
    try {
      await checkFlapFactoryPools(factoryPoolState, {
        scanConfig: { scanRealtime: false, scanCatchup: false, scanAssets: true },
        awaitDelivery: false,
      });
    } catch (err) {
      try { await recordFactoryPoolScanError(factoryPoolState, err); } catch {}
      log(`[Flap Factory 资产复核] 检测失败：${err.message}`);
    } finally {
      isFactoryAssetScanning = false;
      isFactoryBackgroundScanning = false;
    }
  }

  async function factoryPoolCatchupPoll() {
    if (!CONFIG.factoryPoolMonitor.enabled || isFactoryCatchupScanning || isFactoryBackgroundScanning || shouldDeferFactoryBackgroundScan()) return;
    isFactoryCatchupScanning = true;
    isFactoryBackgroundScanning = true;
    try {
      await checkFlapFactoryPools(factoryPoolState, {
        scanConfig: { scanRealtime: false, scanCatchup: true, scanAssets: false },
        awaitDelivery: false,
      });
    } catch (err) {
      try { await recordFactoryPoolScanError(factoryPoolState, err); } catch {}
      log(`[Flap Factory 补扫] 检测失败：${err.message}`);
    } finally {
      isFactoryCatchupScanning = false;
      isFactoryBackgroundScanning = false;
    }
  }

  function scheduleFactoryRealtimeNext(delayMs = CONFIG.factoryPoolMonitor.intervalMs) {
    setTimeout(async () => {
      const startedAt = Date.now();
      await factoryPoolRealtimePoll();
      const elapsed = Date.now() - startedAt;
      scheduleFactoryRealtimeNext(Math.max(0, CONFIG.factoryPoolMonitor.intervalMs - elapsed));
    }, delayMs);
  }

  const factoryBackgroundTasks = {
    catchup: factoryPoolCatchupPoll,
    assets: factoryPoolAssetPoll,
  };
  let factoryBackgroundTaskIndex = 0;
  const factoryBackgroundTickMs = Math.max(250, Math.floor(Math.min(
    CONFIG.factoryPoolMonitor.intervalMs,
    CONFIG.factoryPoolMonitor.catchupIntervalMs,
  ) / 2));
  async function factoryPoolBackgroundPoll() {
    if (!CONFIG.factoryPoolMonitor.enabled || isFactoryBackgroundScanning || shouldDeferFactoryBackgroundScan()) return;
    const taskName = FACTORY_BACKGROUND_TASK_ORDER[factoryBackgroundTaskIndex];
    const task = factoryBackgroundTasks[taskName];
    factoryBackgroundTaskIndex = (factoryBackgroundTaskIndex + 1) % FACTORY_BACKGROUND_TASK_ORDER.length;
    await task();
  }
  function scheduleFactoryBackgroundNext() {
    setTimeout(async () => {
      await factoryPoolBackgroundPoll();
      scheduleFactoryBackgroundNext();
    }, factoryBackgroundTickMs);
  }
  scheduleFactoryRealtimeNext();
  scheduleFactoryBackgroundNext();

  function scheduleContractIntegrityNext(delayMs = CONFIG.contractIntegrityMonitor.coreIntervalMs) {
    if (!CONFIG.contractIntegrityMonitor.enabled) return;
    setTimeout(async () => {
      const startedAt = Date.now();
      await contractIntegrityPoll();
      scheduleContractIntegrityNext(Math.max(250, CONFIG.contractIntegrityMonitor.coreIntervalMs - (Date.now() - startedAt)));
    }, delayMs);
  }
  scheduleContractIntegrityNext();

  function scheduleSafeProposalNext(delayMs = CONFIG.safeProposalMonitor.intervalMs) {
    if (!CONFIG.safeProposalMonitor.enabled) return;
    setTimeout(async () => {
      const startedAt = Date.now();
      try {
        await safeProposalPoll();
      } catch (error) {
        log(`[Flap Safe 提案] 检测失败：${error.message}`);
      }
      const hasActiveProposal = Object.values(safeProposalState.proposals || {})
        .some(proposal => ["pending", "ready"].includes(proposal?.status));
      const intervalMs = hasActiveProposal
        ? CONFIG.safeProposalMonitor.activeIntervalMs
        : CONFIG.safeProposalMonitor.intervalMs;
      scheduleSafeProposalNext(Math.max(250, intervalMs - (Date.now() - startedAt)));
    }, delayMs);
  }
  scheduleSafeProposalNext();

  // 轮询函数：并行检测所有页面
  let pendingPoll = false;
  async function poll() {
    if (isPolling) {
      pendingPoll = true;  // 记录有待执行的轮询
      return;
    }
    isPolling = true;
    pollCount++;

    try {
      const notifications = [];
      const roundAssetCache = new Map();
      const roundVaultFactoryEntries = [];

      const applyNotificationSnapshotUpdate = (notification) => {
        const updates = [
          ...(notification?.snapshotUpdates || []),
          ...(notification?.snapshotUpdate ? [notification.snapshotUpdate] : []),
        ];
        let changed = false;
        for (const update of updates) {
          if (!update) continue;
          const { key, features } = update;
          snapshot.pages[key] = features;
          changed = true;
        }
        if (changed) saveSnapshot(snapshot);
        return changed;
      };

      // 并行抓取所有页面（加错开延迟），每个 task 携带自身 url/key，确保失败时也能归因
      const tasks = CONFIG.urls.map((url, i) => sleep(i * 200).then(async () => {
        const key = urlToKey(url);
        try {
          const html = await fetchPage(url);
          return { url, key, html, error: null };
        } catch (err) {
          return { url, key, html: null, error: err };
        }
      }));

      const pageResults = await Promise.all(tasks);

      for (const { url, key, html, error } of pageResults) {
        if (error) {
          if (!failCounts[key]) failCounts[key] = { count: 0, lastMsg: "", lastFailTime: 0, hourlyErrors: [] };
          const fc = failCounts[key];
          fc.count++;
          fc.lastMsg = error.message;
          fc.lastFailTime = Date.now();
          fc.hourlyErrors.push(Date.now());
          // 追踪退避跳过次数
          if (error.message?.includes("退避") || error.message?.includes("429") || error.message?.includes("403")) {
            backoffSkips[key] = (backoffSkips[key] || 0) + 1;
          }
          if (fc.count === CONFIG.failThreshold) {
            log(`[错误] ${url} 连续 ${fc.count} 次失败：${error.message}`);
            notifications.push({
              title: "页面请求失败",
              content: buildOperationalNoticeContent({
                status: "页面请求失败",
                url,
                severity: "orange",
                reason: error.message,
                consecutiveFailures: fc.count,
              }),
              template: "orange",
              isRecoveryNotice: true,
            });
          }
          continue;
        }
        try {
          const features = extractPageFeatures(html, { url });
          features.originalUrl = url;
          assertValidFlapPage(url, html, features);

          const oldFeatures = snapshot.pages[key];
          const oldQuality = oldFeatures ? getStoredFeatureQuality(url, oldFeatures) : null;

          // 仅当 assetHash 未变且旧数据完整时才复用缓存（节省带宽）
          if (oldQuality?.valid && oldFeatures.assetContents && oldFeatures.assetHash === features.assetHash
            && oldFeatures.assetAnalysisSchemaVersion === ASSET_ANALYSIS_SCHEMA_VERSION) {
            features.assetContents = oldFeatures.assetContents;
            features.assetAnalysisSchemaVersion = oldFeatures.assetAnalysisSchemaVersion;
            features.metadataSchemas = oldFeatures.metadataSchemas || [];
            features.metadataSchemaFingerprint = oldFeatures.metadataSchemaFingerprint || "";
            features.contractHints = oldFeatures.contractHints || [];
            features.contractHintsFingerprint = oldFeatures.contractHintsFingerprint || "";
            // i18n: 仅当之前成功提取过才复用，否则按衰减频率重试
            if (oldFeatures.i18nHash) {
              features.i18nStrings = oldFeatures.i18nStrings;
              features.i18nHash = oldFeatures.i18nHash;
              features.i18nChunk = oldFeatures.i18nChunk;
            } else if (pollCount % 100 === 0) {
              // 每 100 次轮询重试一次 i18n 提取，避免频繁无效请求
              const i18n = await fetchI18nStrings(features.assetFiles);
              if (i18n) { features.i18nStrings = i18n.i18nStrings; features.i18nHash = i18n.i18nHash; features.i18nChunk = i18n.i18nChunk; }
            }
          } else {
            const i18n = await fetchI18nStrings(features.assetFiles);
            if (i18n) { features.i18nStrings = i18n.i18nStrings; features.i18nHash = i18n.i18nHash; features.i18nChunk = i18n.i18nChunk; }
            // 下载资源内容用于内容级 diff
            await hydrateAssetContents(features, oldQuality?.valid ? oldFeatures : null, { roundAssetCache });
          }

          if (failCounts[key]) failCounts[key].count = 0;
          // 退避恢复警告
          if (backoffSkips[key] > 0) {
            const skipped = backoffSkips[key];
            backoffSkips[key] = 0;
            log(`[恢复] ${url} 退避恢复，此前跳过 ${skipped} 次检测，本轮已完成全量比对`);
            notifications.push({
              url,
              changes: [`退避恢复：此前因风控跳过 ${skipped} 次检测，退避期间的中间状态变更可能未被捕获`],
              meta: { assetStats: null, textChangeCount: 0, textChanges: [], i18nChangeCount: 0, i18nDiffs: [] },
              title: `⚠ 退避恢复：${url}`,
              content: buildOperationalNoticeContent({
                status: "退避恢复",
                url,
                severity: "yellow",
                skipped,
                reason: "此前触发 403/429/退避，本轮已完成全量比对。",
              }),
              template: "yellow",
              isRecoveryNotice: true,
            });
          }

          collectRoundVaultFactory(roundVaultFactoryEntries, url, features);

          if (!oldFeatures) {
            snapshot.pages[key] = features;
            saveSnapshot(snapshot);
            continue;
          }

          if (!oldQuality.valid) {
            log(`[基线修复] ${url} 旧快照无效，当前样本有效，已重建基线：${oldQuality.reasons.join("; ")}`);
            notifications.push({
              url,
              changes: [
                formatQualityIssue(url, oldQuality),
                "",
                "当前抓取样本有效，已重建基线；本次不按页面文案变更推送，避免旧坏快照造成误报。",
              ],
              meta: { assetStats: null, textChangeCount: 0, textChanges: [], i18nChangeCount: 0, i18nDiffs: [] },
              title: "Flap 基线已修复",
              content: buildOperationalNoticeContent({
                status: "Flap 基线已修复",
                url,
                severity: "yellow",
                reason: oldQuality.reasons.join("; "),
                detail: formatQualityIssue(url, oldQuality),
              }),
              template: "yellow",
              isRecoveryNotice: true,
              snapshotUpdate: { key, features },
            });
            continue;
          }

          const { changes, meta } = diffFeatures(oldFeatures, features);
          if (changes.length > 0) {
            log(`[变更] ${url}`);
            for (const c of changes) log(`  ${c}`);
            saveHtmlSnapshot(url, html);
            // 保存旧版文案到文件，供事后查阅
            saveOldTextContent(url, oldFeatures);
            // 保存详细 diff 到文件
            saveDetailedDiff(url, changes);
            notifications.push({
              url,
              changes,
              meta,
              title: meta.metadataSchemaDiffs?.length ? "Flap metadata schema 变更" : "Flap 页面变更",
              content: meta.metadataSchemaDiffs?.length ? buildMetadataSchemaWarningContent(url, meta.metadataSchemaDiffs) : undefined,
              template: "red",
              snapshotUpdate: { key, features },
            });
          } else if (shouldRefreshDerivedFeatureBaseline(oldFeatures, features)) {
            snapshot.pages[key] = features;
            saveSnapshot(snapshot);
            log(`[基线补全] ${url} 已保存 CAstore 金库结构，未发现业务变更`);
          }
        } catch (err) {
          if (!failCounts[key]) failCounts[key] = { count: 0, lastMsg: "", lastFailTime: 0, hourlyErrors: [] };
          const fc = failCounts[key];
          fc.count++;
          fc.lastMsg = err.message;
          fc.lastFailTime = Date.now();
          fc.hourlyErrors.push(Date.now());
          if (fc.count === CONFIG.failThreshold) {
            log(`[错误] ${url} 处理失败 ${fc.count} 次：${err.message}`);
            notifications.push({
              title: err.pageQuality ? "页面样本无效" : "页面处理失败",
              content: buildOperationalNoticeContent({
                status: err.pageQuality ? "页面样本无效" : "页面处理失败",
                url,
                severity: "orange",
                reason: err.message,
                consecutiveFailures: fc.count,
              }),
              template: "orange",
              isRecoveryNotice: true,
            });
          }
        }
      }

      await sendRoundVaultFactoryChange({ snapshot, roundVaultFactoryEntries });
      try {
        const registryResult = await checkFlapRegistryLogs(snapshot);
        if (registryResult.changed) saveSnapshot(snapshot);
      } catch (err) {
        log(`[Flap Vault Portal] 检测失败：${err.message}`);
      }

      const notificationsToSend = coalesceFlapNotifications(notifications);
      if (notificationsToSend.length > 0) {
        for (let ni = 0; ni < notificationsToSend.length; ni++) {
          const n = notificationsToSend[ni];

          // 退避恢复通知直接发送，不需要 AI 分析
          if (n.isRecoveryNotice) {
            const sent = await sendFeishu(n.title, n.content || n.changes.join("\n"), n.template);
            if (!sent) throw new Error(`飞书通知发送失败：${n.title}`);
            applyNotificationSnapshotUpdate(n);
            continue;
          }

          for (const diff of getStandaloneCaStoreVaultDiffs(n)) {
            const card = buildCaStoreVaultChangeNotification(diff, snapshot.vaultFactories || {});
            await sendCaStoreVaultChangeNotification(card);
          }
          const pageNotification = omitStandaloneCaStoreVaultDiffs(n);
          if (!shouldSuppressCaStoreOnlyPageNotification(n) && hasNotificationPayload(pageNotification)) {
            await sendFlapChangeNotification(pageNotification);
          }
          applyNotificationSnapshotUpdate(n);
        }
      }

      // 记录最后检测时间
      try { writeFileSync(join(__dirname, "lastpoll.txt"), ts(), "utf-8"); } catch (_) {}

      // 定期清理旧快照文件（每 1000 次轮询 ≈ 25 分钟）
      if (pollCount % 1000 === 0) {
        cleanOldSnapshots();
      }
    } catch (err) {
      log(`轮询异常：${err.message}`);
    } finally {
      isPolling = false;
      // 如果在轮询期间有新的检测请求，立即执行一次
      if (pendingPoll) {
        pendingPoll = false;
        log(`[轮询] 上一轮耗时较长，立即执行排队的检测`);
        // 用 setImmediate 避免递归栈溢出
        setImmediate(() => poll().catch(err => log(`[轮询] 排队检测异常：${err.message}`)));
      }
    }
  }

  // SIGUSR1 信号
  process.on("SIGUSR1", () => {
    factoryPoolRealtimePoll().catch(err => log(`[SIGUSR1] Factory 实时检测异常：${err.message}`));
    factoryPoolBackgroundPoll().catch(err => log(`[SIGUSR1] Factory 后台检测异常：${err.message}`));
    contractIntegrityPoll({ forceExtended: true, forceCodeAudit: true }).catch(err => log(`[SIGUSR1] 合约完整性检测异常：${err.message}`));
    safeProposalPoll().catch(err => log(`[SIGUSR1] Safe 提案检测异常：${err.message}`));
    if (isPolling) {
      pendingPoll = true;  // 利用 pendingPoll 机制，当前轮询结束后自动触发
      log("收到 SIGUSR1，当前正在轮询，将在本轮结束后立即执行");
      return;
    }
    log("收到 SIGUSR1，立即触发检测……");
    poll().catch(err => log(`[SIGUSR1] 检测异常：${err.message}`));
  });

  // 带抖动的定时轮询
  function scheduleNext() {
    const interval = CONFIG.pollIntervalMs + (Math.random() - 0.5) * 2 * CONFIG.jitterMs;
    setTimeout(async () => {
      try { await poll(); }
      catch (err) { log(`[轮询异常] ${err.message}`); }
      finally { scheduleNext(); }
    }, interval);
  }

  await poll();
  scheduleNext();

}

/* ══════════════════════════════════════════
   入口
   ══════════════════════════════════════════ */

const command = process.argv[2];

if (!IS_TEST_MODE) {
  if (command === "check") {
    runCheck().then(() => process.exit(0)).catch((err) => { log(`检测异常：${err.message}`); process.exit(1); });
  } else if (command === "help" || command === "-h" || command === "--help") {
    console.log(`用法:
  node monitor.mjs          启动持续监控（守护进程模式）
  node monitor.mjs check    手动触发一次检测
  node monitor.mjs help     显示帮助

信号:
  kill -USR1 <PID>           立即触发一次检测`);
  } else {
    startMonitor().catch(err => {
      log(`监控启动异常：${err.message}`);
      process.exit(1);
    });
  }
}

// ── 优雅退出：等待通知队列排空 ──
let isShuttingDown = false;
async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log(`收到 ${signal}，正在优雅退出……`);
  if (global.__factoryPoolWsFeed) {
    global.__factoryPoolWsFeed.stop();
    log("已停止 Flap Factory WebSocket 订阅");
  }
  if (global.__factoryPoolEventQueueDrain) {
    try { await global.__factoryPoolEventQueueDrain(); } catch {}
  }
  if (global.__contractIntegrityWsFeed) {
    global.__contractIntegrityWsFeed.stop();
    log("已停止 Flap 合约完整性 WebSocket 订阅");
  }
  if (global.__contractIntegrityMutationDrain) {
    try { await global.__contractIntegrityMutationDrain(); } catch {}
  }
  // 先收完已入队的链上事件，再等待由这些事件触发的通知及确认写盘。
  await Promise.resolve();
  if (global.__contractIntegrityDeliveryDrain) {
    try { await global.__contractIntegrityDeliveryDrain(); } catch {}
  }
  if (global.__contractIntegrityMutationDrain) {
    try { await global.__contractIntegrityMutationDrain(); } catch {}
  }
  if (global.__safeProposalDrain) {
    try { await global.__safeProposalDrain(); } catch {}
  }
  // 等待消息队列排空（最多等 30s）
  await waitQueueDrain(30_000);
  try { saveSnapshot(loadSnapshot() || {}); } catch {}
  process.exit(0);
}
if (!IS_TEST_MODE) {
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
}

export const __testables = {
  CONFIG,
  ASSET_ANALYSIS_SCHEMA_VERSION,
  FACTORY_BACKGROUND_TASK_ORDER,
  emptyFlapChangeMeta,
  isFlapAssetOnlyNotification,
  buildSiteWideAssetNotification,
  coalesceFlapNotifications,
  applyBusinessPriorityTitle,
  diffFeatures,
  diffFrontendAssets,
  extractPageFeatures,
  extractStrings,
  downloadAssetContents,
  planAssetContentDownload,
  applyFrontendAssetAnalysis,
  diffMetadataSchemas,
  extractContractHintsFromAsset,
  extractMetadataSchemasFromAsset,
  formatMetadataSchemaDiffs,
  buildMetadataSchemaWarningContent,
  buildAssetSemanticProfile,
  classifyAssetPath,
  buildBriefingInput,
  buildCardBriefing,
  buildOperationalNoticeContent,
  buildFlapStartupContent,
  safeProposalDisplay,
  collectSnapshotContractHints,
  syncFlapContractIntegrityCatalog,
  runFlapContractIntegrityPass,
  deliverFlapContractIntegrityChanges,
  deliverFlapSafeProposalChanges,
  buildCaStoreVaultChangeNotification,
  getStandaloneCaStoreVaultDiffs,
  shouldSuppressCaStoreOnlyPageNotification,
  omitStandaloneCaStoreVaultDiffs,
  normalizeAddress,
  extractRegistryVaultAddressesFromLog,
  buildRegistryMonitorContent,
  buildFactoryPoolMonitorContent,
  checkFlapFactoryPools,
  enrichFactoryPoolMetadataAfterSend,
  scheduleFactoryPoolMetadataEnrichment,
  decodeErc20MetadataText,
  decodeErc20Decimals,
  parseGoPlusTokenMetadata,
  resolveFactoryPoolTokenMetadata,
  bscRpcCall,
  bscRpcBatch,
  executeBscGetLogsRequest,
  mergeFactoryPoolScanState,
  createFactoryPoolWsFeed,
  createFactoryPoolEventQueue,
  processFactoryPoolFeedEvent,
  backfillFactoryPoolFeedEvents,
  resetBscRpcHealth,
  buildVaultFactoryLaunchUrl,
  parseWebpackExportAliases,
  extractVaultFactories,
  factoryListToMap,
  formatVaultFactoryChanges,
  buildVaultFactoryChangeTitle,
  mergeRoundVaultFactoryMaps,
  diffVaultFactories,
  buildFlapFullDiff,
  classifyUiStyleString,
  inferUiComponentContext,
  summarizeUiStyleDiffs,
  collectCodeIntentDiffsFromStrings,
  summarizeCodeIntentDiffs,
  isReadableBusinessText,
};

if (!IS_TEST_MODE) {
  process.on("unhandledRejection", (err) => {
    log(`[未捕获异常] ${err?.message || err}`);
  });
}
