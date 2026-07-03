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

import { createHash, createHmac } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, readdirSync, unlinkSync, statSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sendCard, sendCardQueued, patchCard, pinMessage, waitQueueDrain } from "../shared/feishu-client.mjs";

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

/* ── 配置 ── */
const CONFIG = {
  urls: [
    "https://flap.sh/bnb/CAstore",
    "https://flap.sh/launch",
    "https://flap.sh/create",
  ],
  // 飞书 API（用于发送 diff 文件附件）
  feishuAppId: process.env.FEISHU_APP_ID || "",
  feishuAppSecret: process.env.FEISHU_APP_SECRET || "",
  feishuChatId: process.env.FEISHU_CHAT_ID || "",

  // 轮询间隔（毫秒）
  pollIntervalMs: 1_500,

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

  // 心跳推送开关；默认关闭，只影响周期性状态心跳，不影响页面变更/异常告警
  heartbeatEnabled: process.env.HEARTBEAT_ENABLED === "true",
  // 心跳间隔（毫秒）— 支持环境变量 HEARTBEAT_MINUTES 覆盖（单位：分钟）
  heartbeatMs: process.env.HEARTBEAT_MINUTES
    ? parseInt(process.env.HEARTBEAT_MINUTES, 10) * 60_000
    : 14_400_000, // 默认 240 分钟（4 小时），与 fourmeme-monitor 保持一致

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
    caStoreVaultDiffs: [],
    nextDataChanged: false,
    fullDiffLines: [],
  };
}

/* ── 快照读写 ── */
const CURRENT_SCHEMA_VERSION = 5;
const CA_STORE_VAULT_SCHEMA_VERSION = 2;

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

/**
 * 带重试的卡片发送（兼容旧接口 sendFeishu）
 */
async function sendFeishu(title, content, template = "red", _retries = 2) {
  for (let attempt = 0; attempt <= _retries; attempt++) {
    try {
      const messageId = await sendCardQueued(title, content, template);
      if (!messageId) throw new Error("队列发送未返回 message_id");
      return true;
    } catch (err) {
      log(`飞书推送异常（第${attempt + 1}次）：${err.message}`);
      if (attempt < _retries) {
        await sleep(3_000 * (attempt + 1));
      }
    }
  }
  log(`飞书推送最终失败（已重试 ${_retries} 次）`);
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
async function sendCardViaApi(title, content, template = "red", diffFilePath) {
  const maxAttempts = 2;
  let lastError = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await sendCard(title, content, template, { diffFilePath });
    } catch (err) {
      lastError = err;
      log(`[飞书 IM API] 直接发送失败（第 ${attempt + 1}/${maxAttempts} 次）：${err.message}`);
      if (attempt < maxAttempts - 1) await sleep(800 * (attempt + 1));
    }
  }

  log("[飞书 IM API] 直接发送失败，转入队列兜底补发");
  const queuedMessageId = await sendCardQueued(title, content, template, { diffFilePath });
  if (queuedMessageId) return queuedMessageId;
  throw new Error(`飞书卡片发送失败：${lastError?.message || "队列补发失败"}`);
}

/**
 * 编辑已发送的卡片消息
 */
async function patchCardViaApi(messageId, title, content, template = "red", diffFilePath) {
  await patchCard(messageId, title, content, template, { diffFilePath });
}

const FEISHU_CARD_PATCH_SAFE_LIMIT = (() => {
  const n = Number(process.env.FEISHU_CARD_CHUNK_LIMIT || 3500);
  return Number.isFinite(n) && n >= 500 ? Math.floor(n) : 3500;
})();

function isTooLongForSingleCard(content) {
  return String(content ?? "").length > FEISHU_CARD_PATCH_SAFE_LIMIT;
}

/**
 * 先推裸 diff（秒级送达），AI 摘要完成后自动编辑原消息补充分析
 * @param {string} [url] - 监控目标网址，展示在卡片最上方
 */
async function sendThenEnrichWithAi(title, content, template, moduleContext, aiInput, enrichFn, diffFilePath, url, summarizeFn = aiSummarize) {
  const initialContent = buildCardUrlPrefix(url, content) + content;
  const messageId = await sendCardViaApi(title, initialContent, template, diffFilePath);

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
            await patchCardViaApi(messageId, title, enrichedContent, template, diffFilePath);
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
  if (/请求失败|处理失败|退避恢复|基线已修复|页面样本无效|模块异常|模块恢复|心跳|状态/i.test(text)) return false;
  if (/全站前端资源变更|Flap\.sh 全站前端资源变更|Flap 全站前端资源变更/i.test(text)) return true;
  if (/仅检测到构建产物|压缩变量噪音|hash\s*轮换|sourceMappingURL|无实质|常规构建/i.test(text)) return false;
  return /重点变更|页面变更|文案|i18n|CAstore|金库|Vault|Factory|fee|rate|route|api|contract|address|enabled|staking|dividend/i.test(text);
}

async function sendNotificationMaybeAi({ title, content, template = "red", moduleContext = "", aiInput, enrichFn, diffFilePath, url, skipAi = false }) {
  if (!shouldUseAiForNotification({ title, content, moduleContext, aiInput, skipAi })) {
    const cardContent = buildCardUrlPrefix(url, content) + content;
    const messageId = await sendCardViaApi(title, cardContent, template, diffFilePath);
    if (!messageId) await sendFeishu(title, cardContent, template);
    else log(`[AI] 已跳过：${title}`);
    return messageId;
  }
  return sendThenEnrichWithAi(title, content, template, moduleContext, aiInput, enrichFn, diffFilePath, url);
}

function hasItems(value) {
  return Array.isArray(value) && value.length > 0;
}

function isFlapAssetOnlyNotification(notification) {
  if (!notification || notification.isRecoveryNotice || notification.content) return false;
  const meta = notification.meta || {};
  const assetStats = meta.assetStats;
  if (!assetStats) return false;
  if (hasPageSpecificAssetChange(notification)) return false;
  if ((meta.textChangeCount || 0) > 0 || hasItems(meta.textChanges)) return false;
  if ((meta.i18nChangeCount || 0) > 0 || hasItems(meta.i18nDiffs)) return false;
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

function classifyAssetFileName(filename) {
  return classifyAssetPath(filename).kind;
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

function buildResourceSemanticSummary(assetStats, notifications = []) {
  const files = uniqueStrings([
    ...(assetStats?.substantiveAssetPaths || []),
    ...(assetStats?.substantiveFileNames || []),
    ...notifications.flatMap(n => extractAssetFileNamesFromChanges(n.changes)),
  ]);
  const profile = assetStats?.semanticProfile || buildAssetSemanticProfile(files, assetStats);
  const businessSignals = summarizeBusinessSignals(assetStats);
  const lines = [];
  if (profile.runtime.length > 0) {
    lines.push(`- webpack runtime/bootstrap: ${profile.runtime.length} 文件，运行时代码或 chunk 加载器更新；原始 minified 片段已移入下载 Diff。`);
  }
  if (profile.appShell.length > 0) {
    const labels = uniqueStrings(profile.appShell.map(item => item.kind));
    lines.push(`- 全站 app shell: ${profile.appShell.length} 文件（${labels.join(", ")}），可能影响布局、加载、错误页或兜底页面。`);
  }
  if (profile.shared.length > 0) {
    lines.push(`- 共享应用 chunk: ${profile.shared.length} 文件，已完成业务文案/配置提取。`);
  }
  if (profile.page.length > 0) {
    lines.push(`- 页面专属 chunk: ${profile.page.length} 文件（${profile.pageRoutes.join(", ")}），按对应页面优先判断。`);
  }
  if (profile.script.length > 0) {
    lines.push(`- 页面/业务脚本 chunk: ${profile.script.length} 文件，已完成结构化信号提取。`);
  }
  if (profile.style.length > 0) {
    lines.push(`- 样式资源: ${profile.style.length} 文件。`);
  }
  const intent = buildResourceIntentSummary(assetStats);
  lines.push(`- 意图判断: ${intent.verdict}；${intent.intent}；置信度 ${intent.confidence}。`);
  lines.push(businessSignals.length > 0
    ? `- 结构化业务信号: ${businessSignals.join("、")}。`
    : "- 结构化业务信号: 当前提取未发现 UI 文案、业务配置、Vault/Factory 或合约相关变化。");
  return lines;
}

function summarizePageAssetChange(notification) {
  const assetStats = notification.meta?.assetStats || {};
  const files = uniqueStrings([
    ...(assetStats.substantiveAssetPaths || []),
    ...(assetStats.substantiveFileNames || []),
    ...extractAssetFileNamesFromChanges(notification.changes),
  ]);
  const profile = assetStats.semanticProfile || buildAssetSemanticProfile(files, assetStats);
  const parts = [];
  if (profile.page.length > 0) parts.push(`页面专属 chunk ${profile.pageRoutes.join(", ")}：优先按对应页面推送`);
  if (profile.runtime.length > 0) parts.push(`webpack runtime/bootstrap ${profile.runtime.map(i => assetPathToFilename(i.file)).join(", ")}：运行时代码更新，原始片段已隐藏`);
  if (profile.appShell.length > 0) parts.push(`app shell ${profile.appShell.map(i => assetPathToFilename(i.file)).join(", ")}：布局/加载/错误页相关`);
  if (profile.shared.length > 0) parts.push(`共享应用 chunk ${profile.shared.map(i => assetPathToFilename(i.file)).join(", ")}：已做业务信号提取`);
  if (profile.script.length > 0) parts.push(`页面/业务脚本 ${profile.script.map(i => assetPathToFilename(i.file)).join(", ")}：已做结构化信号提取`);
  if (profile.style.length > 0) parts.push(`样式资源 ${profile.style.map(i => assetPathToFilename(i.file)).join(", ")}`);
  const signals = summarizeBusinessSignals(assetStats);
  const intent = buildResourceIntentSummary(assetStats);
  parts.push(signals.length > 0 ? `业务信号 ${signals.join("、")}` : "未发现结构化业务信号");
  parts.push(`意图判断 ${intent.verdict}，置信度 ${intent.confidence}`);
  return `${notification.url}: ${parts.join("；")}`;
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
  const compactUiSignalLines = uiSignalLines.slice(0, 6);
  if (uiSignalLines.length > compactUiSignalLines.length) compactUiSignalLines.push(`- 还有 ${uiSignalLines.length - compactUiSignalLines.length} 类 UI/样式信号，见 Diff 详情`);
  const compactCodeIntentLines = codeIntentLines.slice(0, 6);
  if (codeIntentLines.length > compactCodeIntentLines.length) compactCodeIntentLines.push(`- 还有 ${codeIntentLines.length - compactCodeIntentLines.length} 类实现意图信号，见 Diff 详情`);
  const hasLocalSignals = hasBusinessResourceDiffs || compactUiSignalLines.length > 0 || compactCodeIntentLines.length > 0;
  const assetStats = {
    unchanged: maxStat(assetOnlyNotifications, "unchanged"),
    renamed: maxStat(assetOnlyNotifications, "renamed"),
    modified: substantiveFileNames.length || maxStat(assetOnlyNotifications, "modified"),
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
  const localSignalSummary = hasBusinessResourceDiffs
    ? [
        jsTextDiffs.length > 0 ? `功能文案 ${jsTextDiffs.length} 处` : "",
        businessConfigDiffs.length > 0 ? `业务配置 ${businessConfigDiffs.length} 项` : "",
        vaultDiffs.length > 0 ? `Vault 配置 ${vaultDiffs.length} 项` : "",
        codeIntentDiffs.length > 0 ? `实现意图信号 ${codeIntentDiffs.length} 处` : "",
        uiStyleDiffs.length > 0 ? `UI/样式信号 ${uiStyleDiffs.length} 处` : "",
      ].filter(Boolean).join("；")
    : (codeIntentDiffs.length > 0 || uiStyleDiffs.length > 0
        ? [
            codeIntentDiffs.length > 0 ? `实现意图信号 ${codeIntentDiffs.length} 处` : "",
            uiStyleDiffs.length > 0 ? `UI/样式信号 ${uiStyleDiffs.length} 处` : "",
          ].filter(Boolean).join("；")
        : "未提取到 UI 文案、业务配置、Vault/Factory 或合约相关变化");
  const compactAffectedUrls = affectedUrls.length > 6
    ? [...affectedUrls.slice(0, 6), `... 还有 ${affectedUrls.length - 6} 个页面`]
    : affectedUrls;
  const localSignalLines = hasLocalSignals
    ? [
        ...jsTextDiffs.map(d => {
          const label = d.type === "removed" ? "移除文案" : d.type === "added" ? "新增文案" : "文案变更";
          const line = d.type === "removed" ? formatRemovedLine(label, d.text) : formatAddedLine(label, d.text);
          return `${line}${d.file ? `  ← ${cardText(d.file)}` : ""}`;
        }),
        ...businessConfigDiffs.map(cd => `${formatValueChangeLine(cd.field, cd.oldVal, cd.newVal)}${cd.file ? `  ← ${cardText(cd.file)}` : ""}`),
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
        ...compactCodeIntentLines,
        ...compactUiSignalLines,
      ]
    : ["- 本地结构化提取未发现业务信号。"];

  const changes = [
    `📦 Flap 全站前端资源变更：影响页面 ${affectedUrls.length} 个，修改资源 ${assetStats.modified} 个`,
    `本地初筛：${localSignalSummary}`,
    `意图判断：${intentSummary.verdict}；${intentSummary.intent}；置信度 ${intentSummary.confidence}`,
    `资源范围：${resourceScope}`,
    "",
    "受影响页面：",
    ...affectedUrls.map(url => `- ${url}`),
    hasLocalSignals ? "" : "",
    hasLocalSignals ? "本地信号：" : "",
    ...localSignalLines,
  ].filter(Boolean);

  const contentLines = [
    "**结论摘要**",
    hasLocalSignals
      ? `- 本地初筛: 检测到 ${localSignalSummary}。`
      : "- 本地初筛: 未发现结构化业务变更。",
    `- 意图判断: ${intentSummary.verdict}；${intentSummary.intent}；置信度 ${intentSummary.confidence}`,
    `- 影响页面: ${affectedUrls.length} 个`,
    `- 资源范围: ${resourceScope}`,
    "",
    "**AI 分析**",
    "AI 分析异步生成中，变更已先推送。",
    "",
    "**影响页面**",
    ...compactAffectedUrls.map(url => url.startsWith("...") ? `- ${url}` : `- [${url}](${url})`),
    "",
    "**本地信号**",
    ...localSignalLines,
  ];

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

  const content = contentLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();

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
  const aiInput = n.useFullDiffForAi ? fullDiff : briefingInput;
  await sendNotificationMaybeAi({ title: n.title, content: cardContent, template: n.template, moduleContext: n.moduleContext || moduleContext, aiInput, enrichFn: (summary) => {
    if (n.content) return enrichExistingCardContentWithAi(n.content, summary);
    return buildCardBriefing(n.url, summary, n.meta.assetStats, n.meta.textChangeCount, n.meta.i18nChangeCount, n.meta.i18nDiffs, n.meta.textChanges, n.meta.caStoreVaultDiffs);
  }, diffFilePath, url: n.url, skipAi: n.skipAi });
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

const AI_SYSTEM_PROMPT = `你是 Flap.sh 变更监控分析师。判断 diff 是构建噪音还是业务变化。
重点看：Vault/fee/dividend/constraints/enabled、UI/i18n 文案、功能逻辑、链上参数、路由。
中文输出，不超过 160 字：
**判定:** 纯构建噪音/有业务变化/新增功能
**要点:** 1-3 条；纯噪音写“无业务影响”。`;

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

function countBusinessConfigDiffs(assetStats) {
  return (assetStats?.configDiffs || []).filter(isBusinessConfigDiff).length;
}

function buildChangeSummaryLines(assetStats, textChangeCount, i18nChangeCount, i18nDiffs, textChanges, caStoreVaultDiffs) {
  const summary = [];
  if (caStoreVaultDiffs.length > 0) summary.push(`CAstore 金库 ${caStoreVaultDiffs.length} 项`);
  if (assetStats?.vaultDiffs?.length > 0) summary.push(`Vault 配置 ${assetStats.vaultDiffs.length} 项`);
  if ((textChanges?.length || textChangeCount || 0) > 0) summary.push(`页面文案 ${textChanges?.length || textChangeCount} 处`);
  if ((i18nDiffs?.length || i18nChangeCount || 0) > 0) summary.push(`i18n 文案 ${i18nDiffs?.length || i18nChangeCount} 处`);
  if (assetStats?.jsTextDiffs?.length > 0) summary.push(`功能文案 ${assetStats.jsTextDiffs.length} 处`);
  const configCount = countBusinessConfigDiffs(assetStats);
  if (configCount > 0) summary.push(`业务配置 ${configCount} 项`);
  const uiSignalCount = (assetStats?.uiStyleDiffs || []).length;
  if (uiSignalCount > 0) summary.push(`UI/样式信号 ${uiSignalCount} 处`);
  if (summary.length === 0 && assetStats) summary.push("未提取到结构化业务变更，仅有资源层变化");
  if (summary.length === 0) summary.push("检测到页面变化");
  return summary;
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
  return `🔗 [${url}](${url})\n\n`;
}

function compactTextDiffItems(items = [], max = 12) {
  const arr = Array.isArray(items) ? items : [];
  const visible = arr.slice(0, max);
  const hidden = Math.max(0, arr.length - visible.length);
  return { visible, hidden };
}

function splitDiffPairText(text) {
  const m = String(text || "").match(/^(.*?):\s*(.*?)\s*→\s*(.*)$/);
  if (!m) return null;
  return { key: m[1].trim(), oldVal: m[2].trim(), newVal: m[3].trim() };
}

function pushDiffPairLines(lines, key, oldVal, newVal, indent = "  ") {
  lines.push(`${indent}${formatValueChangeLine(key, oldVal, newVal)}`);
}

/**
 * 构建飞书卡片简报内容。
 * 展示优先级：结论摘要 → 重点变更 → AI/资源/详情。
 */
function buildCardBriefing(url, aiSummary, assetStats, textChangeCount, i18nChangeCount, i18nDiffs, textChanges, caStoreVaultDiffs = []) {
  const lines = [];

  const summary = buildChangeSummaryLines(assetStats, textChangeCount, i18nChangeCount, i18nDiffs, textChanges, caStoreVaultDiffs);
  const hasBusinessChange = summary.some(s => !s.includes("未提取到结构化业务变更"));
  const intentSummary = buildResourceIntentSummary(assetStats || {});

  lines.push("**结论摘要**");
  lines.push(`- 监控页面: [${url}](${url})`);
  lines.push(`- 结论: ${hasBusinessChange ? `发现 ${summary.join("、")}` : summary[0]}`);
  if (assetStats) lines.push(`- 意图判断: ${intentSummary.verdict}；${intentSummary.intent}；置信度 ${intentSummary.confidence}`);
  lines.push("");
  lines.push("**重点变更**");
  lines.push("");

  let hasStructuredChange = false;

  if (caStoreVaultDiffs.length > 0) {
    hasStructuredChange = true;
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
    hasStructuredChange = true;
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
    hasStructuredChange = true;
    const modified = textChanges.filter(c => c.type === "modified");
    const added = textChanges.filter(c => c.type === "added");
    const removed = textChanges.filter(c => c.type === "removed");
    lines.push(`**✏️ 页面文案变更（${textChanges.length} 处）：**`);
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
    hasStructuredChange = true;
    lines.push(`**✏️ 文案变更：** ${textChangeCount} 处`);
    lines.push("");
  }

  // ═══ 3. UI 文案变更（i18n）— 直接展示中文文案 ═══
  if (i18nDiffs && i18nDiffs.length > 0) {
    hasStructuredChange = true;
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
    hasStructuredChange = true;
    lines.push(`**📝 i18n 变更：** ${i18nChangeCount} 处`);
    lines.push("");
  }

  // ═══ 4. JS 文件中的业务文案变更（Vault 描述、功能文案等）═══
  if (assetStats?.jsTextDiffs?.length > 0) {
    hasStructuredChange = true;
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
      hasStructuredChange = true;
      lines.push(`**🔧 配置变更（${businessDiffs.length} 项）：**`);
      for (const cd of businessDiffs) {
        pushDiffPairLines(lines, cd.field, cd.oldVal, cd.newVal, "  ");
      }
      lines.push("");
    }
  }

  const uiSignalLines = buildUiStyleSignalLines(intentSummary.uiSignals);
  if (uiSignalLines.length > 0) {
    hasStructuredChange = true;
    const compactUiLines = uiSignalLines.slice(0, 12);
    lines.push(`**🎨 UI/样式信号（${assetStats.uiStyleDiffs.length} 处）：**`);
    lines.push(...compactUiLines);
    if (uiSignalLines.length > compactUiLines.length) lines.push(`- 还有 ${uiSignalLines.length - compactUiLines.length} 类 UI/样式信号，见 Diff 详情`);
    lines.push("");
  }

  const codeIntentLines = buildCodeIntentSignalLines(intentSummary.codeSignals);
  if (codeIntentLines.length > 0) {
    hasStructuredChange = true;
    const totalCodeSignals = assetStats.codeIntentDiffs?.length || intentSummary.codeSignals.reduce((sum, s) => sum + s.total, 0);
    const compactCodeLines = codeIntentLines.slice(0, 8);
    lines.push(`**🧭 实现意图信号（${totalCodeSignals} 处）：**`);
    lines.push(...compactCodeLines);
    if (codeIntentLines.length > compactCodeLines.length) lines.push(`- 还有 ${codeIntentLines.length - compactCodeLines.length} 类实现意图信号，见 Diff 详情`);
    lines.push("");
  }

  if (!hasStructuredChange) {
    lines.push("未提取到结构化文案/金库/配置变更。");
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push("**AI 分析:**");
  lines.push(aiSummary || "AI 分析异步生成中，变更已先推送。");
  lines.push("");

  return lines.join("\n");
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
      strings.add(s.length > 200 ? s.slice(0, 200) : s);
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
  return uniqueStrings([...business, ...ordinary]).slice(0, CONFIG.assetStringLimit);
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
function extractVaultFactories(jsContent) {
  const marker = /vaultTypes\s*:\s*\[/g;
  const markerMatch = marker.exec(jsContent);
  if (!markerMatch) return null;

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

  const readStringField = (block, field) => {
    const re = new RegExp(`${field}\\s*:\\s*["']([^"']+)["']`);
    return block.match(re)?.[1] || null;
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
    factories.push({
      name: readStringField(block, "name") || readStringField(block, "title") || readStringField(block, "label") || "(未知金库工厂)",
      factory,
      enabled: readBoolField(block, "enabled"),
      showInCAStore: readBoolField(block, "showInCAStore"),
      ai: readBoolField(block, "ai"),
      constraints: readConstraints(block),
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
    map[f.factory] = f;
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
  const map = extractVaultFactoryMapFromFeatures(features);
  if (map) roundEntries.push({ url, map });
  return map;
}

async function sendRoundVaultFactoryChange({ snapshot, roundVaultFactoryEntries, titlePrefix = "", linkUrl = "https://flap.sh/bnb/CAstore", sendCardFn = sendCardViaApi } = {}) {
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
  const vfMsgId = await sendCardFn(vfTitle, `🔗 [${linkUrl}](${linkUrl})\n\n${vfContent}${conflictNote}`, vfTemplate);
  if (vfChanges.added.length > 0 && vfMsgId) {
    await pinMessage(vfMsgId);
  }
  snapshot.vaultFactories = currentVFMap;
  saveSnapshot(snapshot);
  return { sent: Boolean(vfMsgId), changed: true, changes: vfChanges };
}

function buildOperationalNoticeContent({ status, url, severity = "orange", reason = "", consecutiveFailures = 0, skipped = 0, detail = "" } = {}) {
  const lines = [
    `**状态:** ${status || "Flap 监控状态变化"}`,
    url ? `**影响页面:** [${url}](${url})` : "",
    consecutiveFailures ? `**连续失败:** ${consecutiveFailures} 次` : "",
    skipped ? `**跳过检测:** ${skipped} 次` : "",
    reason ? `**原因:** ${reason}` : "",
    severity ? `**级别:** ${severity}` : "",
    detail ? "" : "",
    detail || "",
  ];
  return lines.filter(line => line !== "").join("\n");
}

/**
 * 格式化 vault factory 变更为飞书卡片内容
 */
function formatVaultFactoryChanges(changes) {
  const lines = [
    "**结论摘要**",
    `- 新增 ${changes.added.length} 个 / 移除 ${changes.removed.length} 个 / 修改 ${changes.modified.length} 个`,
    "",
  ];
  if (changes.added.length > 0) {
    lines.push("**🆕 新增金库工厂:**");
    for (const v of changes.added) {
      const flags = [];
      if (v.showInCAStore) flags.push("前端可见");
      else flags.push("隐藏");
      if (v.ai) flags.push("AI");
      if (v.enabled) flags.push("已启用");
      else flags.push("已禁用");
      if (v.constraints) flags.push(`约束:${JSON.stringify(v.constraints)}`);
      lines.push(`  ${formatAddedLine(v.name)}`);
      lines.push(`    \`${v.factory}\``);
      lines.push(`    ${flags.join(" | ")}`);
      lines.push(`    🔗 [金库页面](https://flap.sh/launch?vaultfactory=${v.factory})`);
    }
    lines.push("");
  }
  if (changes.removed.length > 0) {
    lines.push("**❌ 移除金库工厂:**");
    for (const v of changes.removed) {
      lines.push(`  ${formatRemovedLine(v.name)}`);
      lines.push(`    \`${v.factory}\``);
    }
    lines.push("");
  }
  if (changes.modified.length > 0) {
    lines.push("**✏️ 金库工厂配置变更:**");
    for (const v of changes.modified) {
      lines.push(`  ${changedText(v.name)}`);
      lines.push(`    \`${v.factory}\``);
      for (const d of v.diffs) {
        const pair = splitDiffPairText(d);
        if (pair) pushDiffPairLines(lines, pair.key, pair.oldVal, pair.newVal, "    ");
        else lines.push(`    ${d}`);
      }
    }
  }
  return lines.filter(Boolean).join("\n");
}

function buildVaultFactoryChangeTitle(changes, prefix = "") {
  const visibleAdded = changes.added.filter(v => v.showInCAStore);
  const hiddenAdded = changes.added.filter(v => !v.showInCAStore);
  const names = changes.added.map(v => v.name).join(", ");
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
  const reusedContents = {};
  const reuseFilenames = [];
  const toDownload = [];

  for (const path of newFeatures?.assetFiles || []) {
    const filename = assetPathToFilename(path);
    if (oldAssetFiles.has(path) && oldContents[filename]) {
      reusedContents[filename] = oldContents[filename];
      reuseFilenames.push(filename);
    } else {
      toDownload.push(path);
    }
  }

  return { reusedContents, reuseFilenames: reuseFilenames.sort(), toDownload };
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
  if (oldFeatures?.assetContents && oldFeatures.assetHash === features.assetHash) {
    features.assetContents = oldFeatures.assetContents;
    return { downloaded: 0, reused: Object.keys(features.assetContents || {}).length };
  }
  const plan = planAssetContentDownload(oldFeatures, features);
  const downloaded = await downloadAssetContents(plan.toDownload, "https://flap.sh", options);
  features.assetContents = { ...plan.reusedContents, ...downloaded };
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
  if (/^(hot vaults|热门金库|熱門金庫|ca store|home|store|ai oracle|rank|profile|create|search|support|docs|debox)$/i.test(t)) return false;
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

function extractCaStoreVaultSections(html) {
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
    const factory = extractVaultFactoryAddress(rawSectionHtml);
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
      signature: md5(`${h.name}\n${description}`),
    });
  }

  return sections;
}

function extractPageFeatures(html) {
  const features = { fullHash: md5(html), nextData: null, nextDataHash: null, assetFiles: [], assetHash: null, contentHash: null, caStoreVaults: [], caStoreVaultHash: null, caStoreVaultSchemaVersion: CA_STORE_VAULT_SCHEMA_VERSION };

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
  features.caStoreVaults = extractCaStoreVaultSections(html);
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
      changes.push({ type: "added", name: nv.name, area: nv.area, newDescription: nv.description, factory: nv.factory || null });
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
      });
    }
  }

  for (const [key, ov] of oldMap) {
    if (!newMap.has(key)) {
      changes.push({ type: "removed", name: ov.name, area: ov.area, oldDescription: ov.description || "", factory: ov.factory || null });
    }
  }

  return changes;
}

function shouldRefreshDerivedFeatureBaseline(oldFeatures, newFeatures) {
  if (!oldFeatures || !newFeatures) return false;
  if (!newFeatures.caStoreVaultHash) return false;
  return !oldFeatures.caStoreVaultHash
    || oldFeatures.caStoreVaultSchemaVersion !== CA_STORE_VAULT_SCHEMA_VERSION;
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

function buildVaultLaunchUrl(factory) {
  return isValidFactoryAddress(factory)
    ? `https://flap.sh/launch?vaultfactory=${factory}`
    : "";
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
  const launchUrl = buildVaultLaunchUrl(factory);
  const typeLabel = caStoreVaultChangeLabel(change?.type);
  const contentLines = [
    `**金库名字**`,
    name,
    "",
    `**变更类型**`,
    change?.type === "removed"
      ? removedText(typeLabel)
      : change?.type === "added"
        ? addedText(typeLabel)
        : changedText(typeLabel),
    "",
    `**文案**`,
    copy,
    "",
    `**金库地址**`,
    launchUrl ? `🔗 [打开金库页面](${launchUrl})` : "未匹配到 vault factory 地址。",
    factory ? `Factory: \`${factory}\`` : "",
    "",
    `**AI 介绍**`,
    "AI 分析异步生成中，变更已先推送。",
  ];
  const content = contentLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();

  return {
    title: `${titlePrefix}CAstore 金库变更：${name}`,
    content,
    template: change?.type === "removed" ? "orange" : "red",
    url: launchUrl || "https://flap.sh/bnb/CAstore",
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
  );
  if (messageId) await pinMessage(messageId);
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

  if (/\/bnb\/CAstore/i.test(url) && !/Vault|CA STORE|STORE|Connect Wallet/i.test(text)) {
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
  const meta = { assetStats: null, textChangeCount: 0, textChanges: [], i18nChangeCount: 0, i18nDiffs: [], caStoreVaultDiffs: [], nextDataChanged: false, fullDiffLines: [] };

  if (oldF.nextDataHash && newF.nextDataHash && oldF.nextDataHash !== newF.nextDataHash) {
    meta.nextDataChanged = true;
    changes.push("页面数据（__NEXT_DATA__）变更");
    if (oldF.nextData?.props && newF.nextData?.props) {
      const oldKeys = Object.keys(flattenKeys(oldF.nextData.props));
      const newKeys = Object.keys(flattenKeys(newF.nextData.props));
      const added = newKeys.filter(k => !oldKeys.includes(k));
      const removed = oldKeys.filter(k => !newKeys.includes(k));
      if (added.length) changes.push(`  新增字段：${added.slice(0, 10).join(", ")}`);
      if (removed.length) changes.push(`  移除字段：${removed.slice(0, 10).join(", ")}`);
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
            for (const fc of vd.fieldChanges.slice(0, 15)) {
              changes.push(`    ${fc.key}: ${fc.oldVal} → ${fc.newVal}`);
            }
          } else if (vd.type === "added") {
            changes.push(`  🆕 新增: ${vd.name} (${Object.keys(vd.fields).length} 字段)`);
          }
        }
      }

      for (const m of substantiveFiles.slice(0, 8)) {
        const label = m.oldFile === m.newFile ? m.newFile : `${m.oldFile} → ${m.newFile}`;
        const total = m.realAdded.length + m.realRemoved.length;
        const noiseNote = m.totalNoise > 0 ? ` + ${m.totalNoise} 噪音已过滤` : "";
        if (total === 0) continue;
        changes.push(`📝 ${label} (${total} 处实质变更${noiseNote})`);
        const readableRemoved = m.realRemoved.filter(isReadableBusinessText);
        const readableAdded = m.realAdded.filter(isReadableBusinessText);
        for (const s of readableRemoved.slice(0, 4)) changes.push(`  - ${s}`);
        if (readableRemoved.length > 4) changes.push(`  ... 还有 ${readableRemoved.length - 4} 处可读移除，见 Diff 详情`);
        for (const s of readableAdded.slice(0, 4)) changes.push(`  + ${s}`);
        if (readableAdded.length > 4) changes.push(`  ... 还有 ${readableAdded.length - 4} 处可读新增，见 Diff 详情`);
        const hiddenCount = total - readableRemoved.length - readableAdded.length;
        if (hiddenCount > 0) changes.push(`  · ${hiddenCount} 处不可读实现片段已折叠到 Diff 详情`);
      }

      if (noiseOnlyFiles.length > 0) {
        const totalNoise = noiseOnlyFiles.reduce((s, f) => s + f.noise, 0);
        const names = noiseOnlyFiles.map(f => f.label.split("/").pop().split(" → ").pop());
        changes.push(`🔇 构建噪音： ${noiseOnlyFiles.length} 文件 ${totalNoise} 处 (${names.slice(0, 4).join(", ")})`);
      }
      if (assetDiff.added.length > 0) changes.push(`🆕 新增文件： ${assetDiff.added.slice(0, 10).join(", ")}`);
      if (assetDiff.removed.length > 0) changes.push(`🗑️ 移除文件： ${assetDiff.removed.slice(0, 10).join(", ")}`);
    } else {
      changes.push("前端代码（JS/CSS 资源）更新");
      const oldSet = new Set(oldF.assetFiles || []), newSet = new Set(newF.assetFiles || []);
      const added = [...newSet].filter(f => !oldSet.has(f));
      const removed = [...oldSet].filter(f => !newSet.has(f));
      if (added.length) changes.push(`  新增：${added.slice(0, 5).map(f => f.split("/").pop()).join(", ")}`);
      if (removed.length) changes.push(`  移除：${removed.slice(0, 5).map(f => f.split("/").pop()).join(", ")}`);
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
        const truncSeg = (s, max = 120) => s && s.length > max ? s.slice(0, max) + "…" : s;
        for (const c of textDiff.changes.slice(0, 20)) {
          const ctx = c.ctxBefore ? `  上文: ${truncSeg(c.ctxBefore, 60)}` : "";
          if (c.type === "modified") {
            changes.push(`✏️ 文案修改：`);
            changes.push(`  旧: ${truncSeg(c.oldText)}`);
            changes.push(`  新: ${truncSeg(c.newText)}`);
            if (ctx) changes.push(ctx);
          } else if (c.type === "added") {
            changes.push(`🟢 新增文案： ${truncSeg(c.text)}`);
            if (ctx) changes.push(ctx);
          } else if (c.type === "removed") {
            changes.push(`🔴 删除文案： ${truncSeg(c.text)}`);
            if (ctx) changes.push(ctx);
          }
        }
        if (textDiff.changes.length > 20) changes.push(`... 还有 ${textDiff.changes.length - 20} 处变更`);
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
      for (const c of i18nDiff.slice(0, 30)) {
        if (c.type === "modified") { changes.push(`  ✏️ ${c.key}: "${(c.oldValue.length > 60 ? c.oldValue.slice(0, 60) + "…" : c.oldValue)}" → "${(c.newValue.length > 60 ? c.newValue.slice(0, 60) + "…" : c.newValue)}"`); }
        else if (c.type === "added") { changes.push(`  🟢 新增 ${c.key}: "${(c.value.length > 80 ? c.value.slice(0, 80) + "…" : c.value)}"`); }
        else if (c.type === "removed") { changes.push(`  🔴 删除 ${c.key}: "${(c.value.length > 80 ? c.value.slice(0, 80) + "…" : c.value)}"`); }
      }
      if (i18nDiff.length > 30) changes.push(`  ... 还有 ${i18nDiff.length - 30} 处 i18n 变更`);
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
      const features = extractPageFeatures(html);
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
          title: "手动检测 — 页面变更",
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

async function startMonitor() {
  let snapshot = loadSnapshot() || { pages: {}, vaultFactories: {} };
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
      const features = extractPageFeatures(html);
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

  await sendFeishu(
    "Flap 监控 v2 已启动",
    `**监控目标:**\n${CONFIG.urls.map(u => `- ${u}`).join("\n")}\n\n**轮询间隔:** ${CONFIG.pollIntervalMs}ms\n**反风控:** UA 轮换 + 按页面/资源路径自适应退避 + 请求抖动\n**服务器:** ${(await import("node:os")).hostname()}`,
    "blue"
  );

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
          const features = extractPageFeatures(html);
          features.originalUrl = url;
          assertValidFlapPage(url, html, features);

          const oldFeatures = snapshot.pages[key];
          const oldQuality = oldFeatures ? getStoredFeatureQuality(url, oldFeatures) : null;

          // 仅当 assetHash 未变且旧数据完整时才复用缓存（节省带宽）
          if (oldQuality?.valid && oldFeatures.assetContents && oldFeatures.assetHash === features.assetHash) {
            features.assetContents = oldFeatures.assetContents;
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
              title: `Flap 页面变更`,
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

  // 独立心跳定时器（不受轮询耗时影响）
  // 不再直接发送卡片，改为写入共享文件，由 fourmeme-monitor 合并推送
  if (CONFIG.heartbeatEnabled) {
    const HEARTBEAT_FILE = join(__dirname, "..", ".flap-heartbeat.json");
    setInterval(async () => {
    log(`运行正常，已轮询 ${pollCount} 次`);
    cleanOldSnapshots();

    const lines = [`已轮询 **${pollCount}** 次`];

    // 汇总近一个心跳周期内的页面错误
    const twoHoursAgo = Date.now() - CONFIG.heartbeatMs;
    const errorLines = [];
    for (const [key, fc] of Object.entries(failCounts)) {
      // 清理超过一个心跳周期的错误记录
      fc.hourlyErrors = (fc.hourlyErrors || []).filter(t => t > twoHoursAgo);
      const recentCount = fc.hourlyErrors.length;
      if (recentCount === 0 && fc.count === 0) continue;

      // 从 key 还原可读 URL
      const page = snapshot.pages?.[key];
      const label = page?.originalUrl || key;

      const periodLabel = `${Math.round(CONFIG.heartbeatMs / 3_600_000)}h`;
      let line = `  ${label}: `;
      if (fc.count > 0) {
        line += `连续失败 ${fc.count} 次`;
        if (recentCount > fc.count) line += `（${periodLabel} 内共 ${recentCount} 次）`;
      } else if (recentCount > 0) {
        line += `${periodLabel} 内失败 ${recentCount} 次（已恢复）`;
      }
      line += `\n    → ${fc.lastMsg}`;
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
      lines.push(`**⚠ 近 ${Math.round(CONFIG.heartbeatMs / 3_600_000)}h 异常:**`);
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
      lines.push("✅ 全部页面监控正常");
    }

    // 写入共享心跳文件，供 fourmeme-monitor 合并推送
    try {
      writeFileSync(HEARTBEAT_FILE, JSON.stringify({
        ts: Date.now(),
        content: lines.join("\n"),
        color,
        pollCount,
      }), "utf-8");
      log("[心跳] 已写入共享心跳文件，等待合并推送");
    } catch (err) {
      log(`[心跳] 写入共享心跳文件失败：${err.message}`);
    }
    }, CONFIG.heartbeatMs);
    log(`[心跳] 间隔 ${Math.round(CONFIG.heartbeatMs / 60000)} 分钟，写入共享心跳文件`);
  } else {
    log("[心跳] 已关闭（HEARTBEAT_ENABLED=false）");
  }
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
  buildAssetSemanticProfile,
  classifyAssetPath,
  buildBriefingInput,
  buildCardBriefing,
  buildOperationalNoticeContent,
  buildCaStoreVaultChangeNotification,
  getStandaloneCaStoreVaultDiffs,
  shouldSuppressCaStoreOnlyPageNotification,
  omitStandaloneCaStoreVaultDiffs,
  formatVaultFactoryChanges,
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
