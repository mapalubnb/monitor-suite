/**
 * 飞书交互机器人 — 远程 Shell
 * 通过飞书消息执行服务器命令，同时提供监控快捷指令
 *
 * 前置条件：
 *   1. 飞书开放平台创建自建应用，拿到 App ID / App Secret
 *   2. 开启「机器人」能力
 *   3. 事件订阅地址填 http://<你的IP>:3001/feishu/event
 *   4. 订阅事件：im.message.receive_v1
 *   5. 发布应用版本
 *
 * 启动：node feishu-bot.mjs  或  pm2 start feishu-bot.mjs --name feishu-bot
 */

import { createServer } from "node:http";
import { createHmac, createDecipheriv } from "node:crypto";
import { exec as execCb } from "node:child_process";
import { readFileSync, writeFileSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  sendCard as _sdkSendCard, sendText as _sdkSendText,
  replyText as _sdkReplyText, replyCard as _sdkReplyCard,
  replyFile as _sdkReplyFile, uploadFile as _sdkUploadFile, sendFile as _sdkSendFile,
  getClient, getChatId,
} from "../shared/feishu-client.mjs";

const execAsync = promisify(execCb);
const __dirname = dirname(fileURLToPath(import.meta.url));

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

/* ══════════════════════════════════════════
   配置（从环境变量读取，部署前请配置 .env）
   ══════════════════════════════════════════ */
const CONFIG = {
  port: 3001,

  // 飞书自建应用凭证
  feishuAppId: process.env.FEISHU_APP_ID || "",
  feishuAppSecret: process.env.FEISHU_APP_SECRET || "",

  // 飞书事件订阅配置
  feishuEncryptKey: "",   // 事件加密 Key，留空表示不加密

  // 监控脚本目录（snapshot.json 所在位置）
  monitorDir: __dirname,

  // exec 命令超时（毫秒）
  execTimeout: 30_000,


  // 飞书消息最大长度（超出截断）
  maxReplyLen: 3500,

  // 允许的发送者（open_id）白名单
  allowedSenders: (process.env.FEISHU_ALLOWED_SENDERS || "").split(",").filter(Boolean),
};

/* ══════════════════════════════════════════
   工具函数
   ══════════════════════════════════════════ */
const ts = () => new Date().toLocaleString("zh-CN", { hour12: false });
const log = (msg) => console.log(`[${ts()}] ${msg}`);

const rateLimiter = { counts: new Map(), windowMs: 60_000, maxPerWindow: 20 };

function checkRateLimit(senderId) {
  const now = Date.now();
  const entry = rateLimiter.counts.get(senderId) || { count: 0, windowStart: now };
  if (now - entry.windowStart > rateLimiter.windowMs) {
    entry.count = 0;
    entry.windowStart = now;
  }
  entry.count++;
  rateLimiter.counts.set(senderId, entry);
  // Cleanup old entries
  if (rateLimiter.counts.size > 200) {
    for (const [k, v] of rateLimiter.counts) {
      if (now - v.windowStart > rateLimiter.windowMs) rateLimiter.counts.delete(k);
    }
  }
  return entry.count <= rateLimiter.maxPerWindow;
}

/** 发送飞书卡片消息到群聊（通过 SDK） */
async function sendWebhookCard(title, content, template = "blue") {
  await _sdkSendCard(title, content, template);
}

// 事件去重缓存（message_id -> timestamp）
const eventCache = new Map();
const EVENT_CACHE_TTL = 300_000; // 5 分钟

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of eventCache) {
    if (now - v > EVENT_CACHE_TTL) eventCache.delete(k);
  }
}, 60_000);

function isDuplicate(eventId) {
  if (!eventId) return false;
  if (eventCache.has(eventId)) return true;
  eventCache.set(eventId, Date.now());
  return false;
}

/* ── 飞书 API：使用 SDK 自动管理 token ── */
// getTenantToken 不再需要，SDK 内部自动处理

/* ══════════════════════════════════════════
   飞书 API：回复消息
   ══════════════════════════════════════════ */
async function replyText(messageId, text) {
  try {
    await _sdkReplyText(messageId, text);
  } catch (err) {
    log(`回复失败：${err.message}`);
  }
}

async function replyCard(messageId, title, content, color = "blue") {
  try {
    await _sdkReplyCard(messageId, title, content, color);
  } catch (err) {
    log(`回复卡片失败：${err.message}`);
  }
}

/* ══════════════════════════════════════════
   飞书 API：上传文件 & 回复文件消息
   ══════════════════════════════════════════ */

/** 上传文件到飞书，返回 file_key */
async function uploadFileToFeishu(fileName, content) {
  return _sdkUploadFile(fileName, content);
}

/** 回复文件消息 */
async function replyFile(messageId, fileKey) {
  try {
    await _sdkReplyFile(messageId, fileKey);
  } catch (err) {
    log(`文件回复失败：${err.message}`);
  }
}

/* ══════════════════════════════════════════
   事件解密（如果配置了 Encrypt Key）
   ══════════════════════════════════════════ */
function decryptEvent(encrypted) {
  const key = CONFIG.feishuEncryptKey;
  if (!key) return null;
  const keyHash = createHmac("sha256", "").update(key).digest();
  const enc = Buffer.from(encrypted, "base64");
  const iv = enc.subarray(0, 16);
  const data = enc.subarray(16);
  const decipher = createDecipheriv("aes-256-cbc", keyHash, iv);
  let decrypted = decipher.update(data, undefined, "utf8");
  decrypted += decipher.final("utf8");
  return JSON.parse(decrypted);
}

/* ══════════════════════════════════════════
   AI 对话（共享 ai-client，多模型热切换）
   ══════════════════════════════════════════ */

import { AI, chatCompletion, listProviders, switchProvider } from "../shared/ai-client.mjs";

const AI_CONFIG = {
  get apiUrl() { return AI.apiUrl; },
  get apiKey() { return AI.apiKey; },
  get model() { return AI.model; },
  get providerName() { return AI.providerName; },
  get enabled() { return AI.enabled; },
  timeoutMs: 60_000,
  maxSnapshotLen: 12000,
};

const AI_BOT_SYSTEM_PROMPT = `你是 Four.meme 和 Flap.sh 的监控助手。根据提供的监控快照数据回答用户问题，简洁专业，引用具体数值，中文回答，不超过 500 字。`;

/**
 * 从快照文件构建监控上下文摘要（给 AI 参考）
 */
function buildMonitorContext() {
  const parts = [];

  // fourmeme 快照
  const fmSnapPath = join(CONFIG.monitorDir, "snapshot.json");
  if (existsSync(fmSnapPath)) {
    try {
      const stat = statSync(fmSnapPath);
      const snap = JSON.parse(readFileSync(fmSnapPath, "utf-8"));
      parts.push("=== Four.meme 监控快照 ===");
      parts.push(`更新时间: ${stat.mtime.toLocaleString("zh-CN", { hour12: false })}`);

      // 底池
      const pools = (snap.poolConfig || []).filter(p => p.networkCode === "BSC");
      parts.push(`\n底池(BSC): ${pools.length} 个`);
      for (const p of pools) {
        parts.push(`  ${p.symbol || "?"}: buyFee=${p.buyFee || "-"} sellFee=${p.sellFee || "-"} b0=${p.b0Amount || "-"} total=${p.totalBAmount || "-"} status=${p.status || "-"}`);
      }

      // 前端
      const pages = Object.keys(snap.frontendPages || {});
      parts.push(`\n前端页面: ${pages.length} 个`);

      // API
      const apis = Object.keys(snap.apiStructure || {});
      parts.push(`API端点: ${apis.length} 个 (${apis.join(", ")})`);

      // GitHub
      parts.push(`GitHub SHA: ${(snap.githubSha || "").slice(0, 8) || "N/A"}`);

      // 合约
      const contracts = snap.contractFingerprints || {};
      parts.push(`\n智能合约:`);
      for (const [label, data] of Object.entries(contracts)) {
        let line = `  ${label}: code=${(data.codeHash || "").slice(0, 8)}`;
        if (data.implAddress) line += ` impl=${data.implAddress.slice(0, 12)}...`;
        parts.push(line);
      }

      // 链上
      const op = snap.onchainParams || {};
      parts.push(`\nAgent NFT: ${op.agentNftCount ?? "N/A"} 个`);
      if (op.agentNfts?.length > 0) {
        for (const nft of op.agentNfts.slice(0, 5)) parts.push(`  ${nft}`);
        if (op.agentNfts.length > 5) parts.push(`  ... 及其余 ${op.agentNfts.length - 5} 个`);
      }
    } catch (err) {
      parts.push(`Four.meme 快照读取失败: ${err.message}`);
    }
  }

  // flap 快照
  const flSnapPath = "/opt/flap-monitor/snapshot.json";
  if (existsSync(flSnapPath)) {
    try {
      const snap = JSON.parse(readFileSync(flSnapPath, "utf-8"));
      parts.push("\n=== Flap.sh 监控快照 ===");
      parts.push(`最后检测: ${snap.lastCheck || "N/A"}`);
      const pages = snap.pages || {};
      parts.push(`页面: ${Object.keys(pages).length} 个`);
      for (const [key, data] of Object.entries(pages)) {
        const url = data.originalUrl || key;
        const assets = data.assetFiles?.length || Object.keys(data.assetContents || {}).length || 0;
        parts.push(`  ${url}: ${assets} 个资源文件`);
      }
    } catch { /* ignore */ }
  }

  // 最近变更历史
  const recent = readRecentHistory(10);
  if (recent.length > 0) {
    parts.push("\n=== 最近变更历史 ===");
    for (const r of recent) {
      const time = new Date(r.ts).toLocaleString("zh-CN", { hour12: false });
      parts.push(`${time} [${r.module}] ${r.title}`);
      if (r.summary) parts.push(`  ${r.summary.slice(0, 500)}`);
    }
  }

  let context = parts.join("\n");
  if (context.length > AI_CONFIG.maxSnapshotLen) {
    context = context.slice(0, AI_CONFIG.maxSnapshotLen) + "\n... (数据已截断)";
  }
  return context;
}

/**
 * 读取变更历史记录（最近 N 条）
 */
function readRecentHistory(n = 20) {
  const historyFiles = [
    join(CONFIG.monitorDir, "history.jsonl"),
    "/opt/flap-monitor/history.jsonl",
  ];
  const allRecords = [];
  for (const f of historyFiles) {
    if (!existsSync(f)) continue;
    try {
      const lines = readFileSync(f, "utf-8").split("\n").filter(Boolean);
      for (const line of lines) {
        try { allRecords.push(JSON.parse(line)); } catch { /* skip */ }
      }
    } catch { /* ignore */ }
  }
  // 按时间排序，取最近 N 条
  allRecords.sort((a, b) => (b.ts || "").localeCompare(a.ts || ""));
  return allRecords.slice(0, n);
}

/**
 * 调用 AI 对聚合后的变更摘要做日报总结
 */
async function aiDailySummary(aggregatedText) {
  if (!aggregatedText || !AI_CONFIG.enabled) return null;

  const systemPrompt = `你是 Four.meme 和 Flap.sh 的监控日报分析师。

根据以下 24h 变更摘要，输出一段 2-4 句话的总结，要求：
- 第一句：整体判定（平静/常规构建更新/有实质变更/有重大变更）
- 如有实质变更（底池参数、合约代码、费率、新功能、路由变化），逐条说明具体改了什么
- 纯构建噪音（前端 hash 轮换、部署 ID、变量重命名）直接标注"常规构建更新"，不展开
- 中文，不超过 200 字`;

  const text = await chatCompletion({
    systemPrompt,
    userMessage: `以下是过去 24 小时的变更聚合摘要：\n\n${aggregatedText}`,
    temperature: 0.3,
    maxTokens: 500,
    timeoutMs: AI_CONFIG.timeoutMs,
    retries: 1,
  });

  if (text) log(`[日报AI] 总结生成成功（${text.length} 字）`);
  else log(`[日报AI] 总结生成失败`);
  return text;
}

/**
 * 预处理变更记录：按模块聚合、去重、提取实质事件
 */
function aggregateChanges(todayChanges) {
  // 按模块分组计数
  const byModule = {};
  for (const r of todayChanges) {
    if (!byModule[r.module]) byModule[r.module] = { count: 0, items: [] };
    byModule[r.module].count++;
    byModule[r.module].items.push(r);
  }

  // 去重：相同 title 只保留一条 + 次数
  const deduped = {};
  for (const [mod, data] of Object.entries(byModule)) {
    const titleMap = new Map();
    for (const r of data.items) {
      const key = r.title || "(无标题)";
      if (!titleMap.has(key)) {
        titleMap.set(key, { record: r, count: 1 });
      } else {
        titleMap.get(key).count++;
      }
    }
    deduped[mod] = { total: data.count, titles: titleMap };
  }

  // 构建聚合文本（给 AI 的输入）
  const lines = [];
  for (const [mod, data] of Object.entries(deduped)) {
    lines.push(`[${mod}] 共 ${data.total} 次变更：`);
    for (const [title, info] of data.titles) {
      const countStr = info.count > 1 ? ` (×${info.count})` : "";
      const summary = info.record.summary
        ? info.record.summary.slice(0, 200)
        : "";
      lines.push(`  - ${title}${countStr}${summary ? "：" + summary : ""}`);
    }
  }

  // 提取实质事件（非前端构建噪音）
  const substantive = todayChanges.filter(r => {
    if (!r.summary) return false;
    if (/常规构建|无实质|hash.*轮换|纯噪音|minifier|部署 ID/i.test(r.summary)) return false;
    if (r.module === "frontend" && !/费率|fee|vault|dividend|staking|enabled|新增|移除|路由/i.test(r.summary)) return false;
    return true;
  });

  // 实质事件去重
  const seenSummary = new Set();
  const uniqueSubstantive = [];
  for (const r of substantive) {
    const key = (r.summary || "").slice(0, 100);
    if (seenSummary.has(key)) continue;
    seenSummary.add(key);
    uniqueSubstantive.push(r);
  }

  return {
    byModule: deduped,
    aggregatedText: lines.join("\n"),
    substantiveEvents: uniqueSubstantive.slice(0, 5),
    totalCount: todayChanges.length,
    moduleStats: Object.entries(deduped).map(([mod, d]) => `${mod} ${d.total}`).join(", "),
  };
}

/**
 * 生成每日报告内容（三板块结构）
 */
async function buildDailyReport() {
  const parts = [];
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 3600 * 1000);
  const yStr = yesterday.toISOString();

  const dateStr = now.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });

  // ── 获取 24h 变更 ──
  const allHistory = readRecentHistory(200);
  const todayChanges = allHistory.filter(r => r.ts >= yStr);

  // ═══ 板块一：AI 总结 ═══
  if (todayChanges.length === 0) {
    parts.push("**总结：** 过去 24 小时无任何变更，一切平静。");
  } else {
    const agg = aggregateChanges(todayChanges);

    // AI 总结（输入为聚合后的精简文本）
    const aiSummary = await aiDailySummary(agg.aggregatedText);
    if (aiSummary) {
      parts.push(`**总结：** ${aiSummary}`);
    } else {
      // Fallback：无 AI 时用一行统计代替
      parts.push(`**总结：** 过去 24h 共 ${agg.totalCount} 次变更（${agg.moduleStats}），AI 分析不可用。`);
    }

    // ═══ 板块二：今日数据 ═══
    parts.push("");
    parts.push("---");
    parts.push("");
    parts.push(`**今日数据**`);
    parts.push(`变更：共 ${agg.totalCount} 次（${agg.moduleStats}）`);

    // 系统状态
    try {
      const { stdout: pm2Out } = await execAsync("pm2 jlist 2>/dev/null", { timeout: 5000 });
      const list = JSON.parse(pm2Out);
      const services = ["fourmeme-monitor", "flap-monitor", "feishu-bot"];
      const online = services.filter(n => list.find(x => x.name === n)?.pm2_env?.status === "online");
      const totalRestarts = services.reduce((sum, n) => {
        const p = list.find(x => x.name === n);
        return sum + (p?.pm2_env?.restart_time ?? 0);
      }, 0);
      const statusText = online.length === services.length
        ? `${online.length} 进程正常`
        : `${online.length}/${services.length} 进程在线`;
      parts.push(`系统：${statusText}${totalRestarts > 0 ? "，累计重启 " + totalRestarts + " 次" : ""}`);
    } catch {
      parts.push("系统：无法获取状态");
    }

    // 快照指标
    const fmSnapPath = join(CONFIG.monitorDir, "snapshot.json");
    if (existsSync(fmSnapPath)) {
      try {
        const snap = JSON.parse(readFileSync(fmSnapPath, "utf-8"));
        const pools = (snap.poolConfig || []).filter(p => p.networkCode === "BSC").length;
        const contracts = Object.keys(snap.contractFingerprints || {}).length;
        const sha = (snap.githubSha || "").slice(0, 8) || "-";
        const nfts = snap.onchainParams?.agentNftCount ?? "-";
        parts.push(`Four.meme：底池${pools} | 合约${contracts} | NFT${nfts} | SHA:\`${sha}\``);
      } catch { /* ignore */ }
    }

    // ═══ 板块三：重点事件（仅有实质变更时出现）═══
    if (agg.substantiveEvents.length > 0) {
      parts.push("");
      parts.push("---");
      parts.push("");
      parts.push("**重点事件**");
      for (const r of agg.substantiveEvents) {
        const time = new Date(r.ts).toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" });
        const summary = (r.summary || r.title || "").slice(0, 150);
        parts.push(`${time} [${r.module}] ${summary}`);
      }
    }
  }

  return parts.join("\n");
}

/**
 * 发送每日报告到飞书群聊（通过飞书 SDK）
 */
async function sendDailyReport() {
  log("[日报] 开始生成每日报告...");
  try {
    const content = await buildDailyReport();
    await sendWebhookCard("📊 监控日报", content, "indigo");
    log("[日报] 推送成功");
  } catch (err) {
    log(`[日报] 生成/推送异常：${err.message}`);
  }
}

/**
 * 读取 fourmeme-monitor 的 .env 配置，判断日报是否开启
 */
function isDailyReportEnabled() {
  const envFile = join(CONFIG.monitorDir, ".env");
  try {
    if (existsSync(envFile)) {
      const content = readFileSync(envFile, "utf-8");
      const match = content.match(/^DAILY_REPORT=(.+)$/m);
      if (match) return match[1].trim() === "true";
    }
  } catch {}
  // 也检查进程环境变量
  if (process.env.DAILY_REPORT) return process.env.DAILY_REPORT === "true";
  // 默认关闭
  return false;
}

// 每日报告定时器：每天早上 9:00（UTC+8 = UTC 01:00）
function scheduleDailyReport() {
  // ── 持久化上次发送日期，防止重启后漏发或重复发 ──
  const stateFile = join(CONFIG.monitorDir, ".daily-report-state.json");

  let lastReportDate = "";
  try {
    if (existsSync(stateFile)) {
      const saved = JSON.parse(readFileSync(stateFile, "utf-8"));
      lastReportDate = saved.lastReportDate || "";
      log(`[日报] 恢复上次发送日期：${lastReportDate}`);
    }
  } catch {}

  function saveLastDate(dateStr) {
    lastReportDate = dateStr;
    try { writeFileSync(stateFile, JSON.stringify({ lastReportDate: dateStr }), "utf-8"); } catch {}
  }

  // ── 启动补发：如果今天日报未发且在补发窗口内（UTC 01:00~03:59 / 北京 09:00~11:59），立即补发 ──
  const startupCatchUp = async () => {
    try {
      if (!isDailyReportEnabled()) {
        log("[日报] 日报未开启（DAILY_REPORT!=true），跳过补发");
        return;
      }
      const now = new Date();
      const todayStr = now.toISOString().slice(0, 10);
      const utcHour = now.getUTCHours();
      if (lastReportDate !== todayStr && utcHour >= 1 && utcHour < 4) {
        log("[日报] 检测到今日日报未发送，立即补发...");
        saveLastDate(todayStr);
        await sendDailyReport();
      }
    } catch (err) {
      log(`[日报] 启动补发异常：${err.message}`);
    }
  };
  setTimeout(startupCatchUp, 10_000); // 启动 10s 后检查

  // ── 定时检查：UTC 01:00~01:04（北京 09:00~09:04）──
  setInterval(async () => {
    try {
      if (!isDailyReportEnabled()) return;

      const now = new Date();
      const utcHour = now.getUTCHours();
      const utcMinute = now.getUTCMinutes();
      const todayStr = now.toISOString().slice(0, 10);

      if (utcHour === 1 && utcMinute < 5 && lastReportDate !== todayStr) {
        saveLastDate(todayStr);
        await sendDailyReport();
      }
    } catch (err) {
      log(`[日报] 定时检查异常：${err.message}`);
    }
  }, 30_000); // 每 30 秒检查一次

  log(`[日报] 定时检查已启动（目标 UTC 01:00 / 北京 09:00，补发窗口至 11:59）当前状态：${isDailyReportEnabled() ? "开启" : "关闭"}`);
}

/**
 * AI 对话：将用户问题 + 监控上下文发给豆包
 */
async function cmdAi(question) {
  if (!question.trim()) return "请输入你的问题，例如：`ai 当前底池费率有异常吗？`";

  const context = buildMonitorContext();
  const userMessage = context
    ? `当前监控数据：\n${context}\n\n用户问题：${question}`
    : `（当前无监控快照数据）\n\n用户问题：${question}`;

  const text = await chatCompletion({
    systemPrompt: AI_BOT_SYSTEM_PROMPT,
    userMessage,
    temperature: 0.5,
    maxTokens: 1000,
    timeoutMs: AI_CONFIG.timeoutMs,
    retries: 1,
  });

  if (text) {
    log(`[AI] 回复生成成功（${text.length} 字）`);
    return text;
  }
  return "AI 返回了空响应，请稍后重试";
}

/**
 * AI 模型管理子命令
 */
function cmdAiModel(subCmd, args) {
  switch (subCmd) {
    case "model":
    case "模型":
    case "": {
      const { current, providers } = listProviders();
      const lines = [`**当前模型：** ${current} (${AI_CONFIG.model})`, ""];
      lines.push("**可用模型：**");
      for (const p of providers) {
        const icon = p.name === current ? "●" : "○";
        const keyStatus = p.hasKey ? "" : " ⚠无Key";
        lines.push(`  ${icon} \`${p.name}\`　${p.label}　\`${p.model}\`${keyStatus}`);
      }
      return lines.join("\n");
    }
    case "switch":
    case "切换": {
      const name = args[0];
      const modelOverride = args[1];
      if (!name) return "用法：`ai switch <模型名> [model名称]`";
      const result = switchProvider(name, modelOverride);
      return result.message;
    }
    case "list":
    case "列表": {
      const { providers } = listProviders();
      return providers.map(p => `\`${p.name}\` — ${p.label} (${p.model})`).join("\n");
    }
    default:
      return null; // 非模型管理指令，当作普通 AI 问题处理
  }
}

/* ══════════════════════════════════════════
   指令处理器
   ══════════════════════════════════════════ */

// 危险命令检测
const DANGEROUS_PATTERNS = [
  /rm\s+(-[a-z]*f[a-z]*\s+)?\/($|\s)/i,
  /mkfs\b/i,
  /dd\s+if=/i,
  /:\(\)\s*\{/,                           // fork bomb
  />\s*\/dev\/sd/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\binit\s+0\b/i,
  /chmod\s+(777|a\+rwx)\s+\//i,
  /\|\s*(ba)?sh\b/i,                      // pipe to shell
  /\beval\b/i,
  /\bexec\b.*<\(/i,                       // process substitution exec
  /\bnc\s+(-[a-z]*\s+)*-[a-z]*[le]/i,    // netcat listen/exec
  /\bpython[23]?\s+-c\b/i,               // python one-liner
  /\bnode\s+-e\b/i,                       // node one-liner
  /\bnode\s+--eval\b/i,                   // node --eval
  /\bperl\s+-e\b/i,                       // perl one-liner
  /\bcurl\b.*\|\s*(ba)?sh/i,             // curl pipe to shell
  /\bwget\b.*\|\s*(ba)?sh/i,
  />\s*\/etc\//i,                          // overwrite system files
  /\bpasswd\b/i,
  /\buseradd\b/i,
  /\buserdel\b/i,
  /\bcrontab\s+-r\b/i,                    // remove all crontabs
  /\biptables\s+-F\b/i,                   // flush firewall
];

function isDangerous(cmd) {
  return DANGEROUS_PATTERNS.some((p) => p.test(cmd));
}

// ── help ──
function cmdHelp() {
  return [
    "**内置指令：**",
    "`help`　　　　显示此帮助",
    "`ai <问题>`　 AI 助手（别名：问、ask）",
    "`ai model`　　查看当前 AI 模型",
    "`ai switch <名称>` 切换 AI 模型",
    "`ai list`　　 列出所有可用模型",
    "`history [N]` 最近变更记录（默认 10）",
    "`report`　　　生成并发送日报",
    "",
    "**Shell 命令：**",
    "直接输入任意命令执行，如 `fm-status`、`fl-status`、`mon-status`",
    "输入 `mon-help` 查看所有快捷命令",
    "",
    "**日志下载：**",
    "执行 `fm-log`、`fl-log`、`bot-log`、`mon-log` 时",
    "自动附带可下载的完整日志文件",
  ].join("\n");
}

// 去除 ANSI 转义序列（pm2 等工具会输出颜色码）
const stripAnsi = (s) => s.replace(/\x1B\[[0-9;]*[A-Za-z]/g, "");

// 清理 shell 脚本中的装饰性边框（卡片 header 已承担标题职责）
function cleanShellOutput(text) {
  return text
    .replace(/^[═=─╔╗╚╝║│┌┐└┘├┤┬┴┼▓░▒█▀▄─\s]*$/gm, "")  // 纯边框行
    .replace(/\n{3,}/g, "\n\n")                              // 压缩连续空行
    .trim();
}

// 日志命令检测：匹配 fm-log / fl-log / bot-log / mon-log
const LOG_CMD_RE = /^(fm|fl|bot|mon)-log(\s|$)/;

// PM2 日志文件路径映射
const LOG_PM2_FILES = {
  "fm-log":  ["fourmeme-monitor-out.log", "fourmeme-monitor-error.log"],
  "fl-log":  ["flap-monitor-out.log", "flap-monitor-error.log"],
  "bot-log": ["feishu-bot-out.log", "feishu-bot-error.log"],
};
const LOG_FILE_NAMES = {
  "fm-log": "fourmeme-monitor",
  "fl-log": "flap-monitor",
  "bot-log": "feishu-bot",
  "mon-log": "all-monitors",
};

/**
 * 读取 PM2 完整日志文件内容
 * @returns {string} 完整日志文本
 */
function readFullPm2Log(command) {
  const bin = command.trim().split(/\s+/)[0];
  const pm2Home = process.env.PM2_HOME || "/root/.pm2";
  const logDir = join(pm2Home, "logs");

  if (bin === "mon-log") {
    // 全局日志：合并所有进程的日志
    const allFiles = Object.values(LOG_PM2_FILES).flat();
    const parts = [];
    for (const f of allFiles) {
      const filePath = join(logDir, f);
      if (existsSync(filePath)) {
        try {
          const content = readFileSync(filePath, "utf-8");
          if (content.trim()) parts.push(`=== ${f} ===\n${content}`);
        } catch {}
      }
    }
    return parts.join("\n\n") || "";
  }

  const files = LOG_PM2_FILES[bin];
  if (!files) return "";
  const parts = [];
  for (const f of files) {
    const filePath = join(logDir, f);
    if (existsSync(filePath)) {
      try {
        const content = readFileSync(filePath, "utf-8");
        if (content.trim()) {
          const label = f.endsWith("error.log") ? "ERROR LOG" : "STDOUT LOG";
          parts.push(`=== ${label}: ${f} ===\n${content}`);
        }
      } catch {}
    }
  }
  return parts.join("\n\n") || "";
}

/** 为日志命令上传完整日志文件 */
async function sendLogFile(messageId, command) {
  try {
    const fullLog = readFullPm2Log(command);
    if (!fullLog || fullLog.length < 50) {
      await replyText(messageId, "日志文件为空或过短，跳过附件");
      return;
    }
    const bin = command.trim().split(/\s+/)[0];
    const prefix = LOG_FILE_NAMES[bin] || bin;
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
    const fileName = `${prefix}_full_${dateStr}.log`;
    const sizeKB = (fullLog.length / 1024).toFixed(0);
    const fileKey = await uploadFileToFeishu(fileName, fullLog);
    await replyFile(messageId, fileKey);
    log(`[日志下载] 完整日志已发送: ${fileName} (${sizeKB} KB)`);
  } catch (err) {
    log(`[日志下载] 文件上传失败：${err.message}`);
    try { await replyText(messageId, `📎 日志文件上传失败：${err.message}\n提示：请确保飞书应用已开启「上传文件」权限（im:resource）`); } catch {}
  }
}

// 根据命令名推断卡片标题和颜色
const CMD_CARD_MAP = [
  { re: /^(fm-status|mon-status)$/,  title: "状态总览",   color: "green",  markdown: true },
  { re: /^fl-status$/,               title: "Flap 状态",  color: "green",  markdown: true },
  { re: /^bot-status$/,              title: "Bot 状态",   color: "green",  markdown: true },
  { re: /^(fm|fl|bot|mon)-log$/,     title: "日志",       color: "indigo", markdown: false },
  { re: /^(fm|fl|bot|mon)-restart$/, title: "重启",       color: "yellow", markdown: true },
  { re: /^(fm|fl|bot|mon)-stop$/,    title: "停止",       color: "red",    markdown: true },
  { re: /^(fm|fl)-check/,            title: "触发检查",   color: "orange", markdown: true },
  { re: /^mon-help$/,                title: "快捷命令",   color: "blue",   markdown: true },
];

function inferCard(command) {
  const bin = command.split(/\s+/)[0];
  for (const m of CMD_CARD_MAP) {
    if (m.re.test(bin)) return { title: m.title, color: m.color, markdown: m.markdown };
  }
  return { title: `$ ${bin}`, color: "grey", markdown: false };
}

/** 将 exec 结果格式化为卡片正文 */
function formatExecBody(result, card) {
  if (!result.ok) {
    const errBody = result.code != null
      ? `**退出码：${result.code}**\n\`\`\`\n${result.text}\n\`\`\``
      : result.text;
    return errBody;
  }
  // 已知监控命令：直接输出文本（shell 脚本已格式化好），用 markdown 渲染
  if (card.markdown) return result.text;
  // 通用命令：包裹在代码块里
  return `\`\`\`\n${result.text}\n\`\`\``;
}

// ── exec（执行任意命令）──

// 会导致 feishu-bot 自身重启的命令模式
const SELF_RESTART_PATTERNS = [
  /\bmon-restart\b/,
  /\bbot-restart\b/,
  /\bpm2\s+restart\s+(all|feishu-bot)\b/,
  /\bpm2\s+reload\s+(all|feishu-bot)\b/,
  /\bmon-stop\b/,
  /\bbot-stop\b/,
  /\bpm2\s+stop\s+(all|feishu-bot)\b/,
  /\bpm2\s+delete\s+(all|feishu-bot)\b/,
];

function willRestartSelf(command) {
  return SELF_RESTART_PATTERNS.some(p => p.test(command));
}

async function cmdExec(command) {
  if (!command.trim()) return { ok: false, text: "请输入要执行的命令" };
  if (isDangerous(command)) {
    return {
      ok: false,
      text: `**危险命令已拦截**\n\`${command}\`\n\n该命令可能造成不可逆损害，已被安全规则阻止。`,
    };
  }

  try {
    const { stdout, stderr } = await execAsync(command, {
      timeout: CONFIG.execTimeout,
      maxBuffer: 1024 * 1024,
      cwd: CONFIG.monitorDir,
      env: { ...process.env, PATH: `/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ""}` },
    });
    let result = "";
    if (stdout.trim()) result += stdout;
    if (stderr.trim()) result += (result ? "\n\n" : "") + "STDERR:\n" + stderr;
    if (!result.trim()) result = "(命令已执行，无输出)";
    return { ok: true, text: cleanShellOutput(stripAnsi(result)) };
  } catch (err) {
    const output = cleanShellOutput(stripAnsi((err.stdout || "") + (err.stderr || "")));
    return {
      ok: false,
      text: output || err.message,
      code: err.code,
    };
  }
}

/* ══════════════════════════════════════════
   消息路由
   ══════════════════════════════════════════ */
async function handleMessage(messageId, rawText) {
  // 去除 @机器人 的 mention 标记
  const text = rawText.replace(/@_user_\d+/g, "").trim();
  if (!text) return;

  log(`收到指令：${text}`);

  const parts = text.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1);

  try {
    let reply;
    switch (cmd) {
      case "help":
      case "帮助":
        reply = cmdHelp();
        await replyCard(messageId, "帮助", reply, "blue");
        return;

      case "ai":
      case "问":
      case "ask": {
        // 检查是否为模型管理子命令
        const aiSubCmd = (args[0] || "").toLowerCase();
        if (["model", "模型", "switch", "切换", "list", "列表"].includes(aiSubCmd)) {
          reply = cmdAiModel(aiSubCmd, args.slice(1));
          await replyCard(messageId, "AI 模型", reply, "purple");
          return;
        }
        reply = await cmdAi(args.join(" "));
        await replyCard(messageId, "AI 助手", reply, "blue");
        return;
      }

      case "history":
      case "历史": {
        const n = Math.min(parseInt(args[0]) || 10, 50);
        const records = readRecentHistory(n);
        if (records.length === 0) {
          reply = "暂无变更记录";
        } else {
          const lines = [`**最近 ${records.length} 条变更记录：**`, ""];
          for (const r of records) {
            const time = new Date(r.ts).toLocaleString("zh-CN", { hour12: false });
            lines.push(`\`${time}\` **[${r.module}]** ${r.title}`);
          }
          reply = lines.join("\n");
        }
        await replyCard(messageId, "变更历史", reply, "purple");
        return;
      }

      case "report":
      case "日报": {
        await replyText(messageId, "正在生成日报...");
        await sendDailyReport();
        await replyText(messageId, "日报已推送到群聊");
        return;
      }

      case "exec":
      case "$": {
        const command = args.join(" ");
        if (willRestartSelf(command)) {
          await replyCard(messageId, "重启", `即将执行：\`${command}\`\n机器人将短暂离线...`, "yellow");
          setTimeout(() => { execAsync(command, { timeout: CONFIG.execTimeout, cwd: CONFIG.monitorDir, env: { ...process.env, PATH: `/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ""}` } }).catch(() => {}); }, 1_000);
          return;
        }
        const result = await cmdExec(command);
        const card = inferCard(command);
        await replyCard(messageId, card.title, formatExecBody(result, card), result.ok ? card.color : "red");
        // 日志命令：追加完整日志文件下载
        if (result.ok && LOG_CMD_RE.test(command.trim())) {
          await sendLogFile(messageId, command);
        }
        return;
      }

      default: {
        if (willRestartSelf(text)) {
          await replyCard(messageId, "重启", `即将执行：\`${text}\`\n机器人将短暂离线...`, "yellow");
          setTimeout(() => { execAsync(text, { timeout: CONFIG.execTimeout, cwd: CONFIG.monitorDir, env: { ...process.env, PATH: `/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ""}` } }).catch(() => {}); }, 1_000);
          return;
        }
        const result = await cmdExec(text);
        const card = inferCard(text);
        await replyCard(messageId, card.title, formatExecBody(result, card), result.ok ? card.color : "red");
        // 日志命令：追加完整日志文件下载
        if (result.ok && LOG_CMD_RE.test(text.trim())) {
          await sendLogFile(messageId, text);
        }
        return;
      }
    }
  } catch (err) {
    log(`指令处理异常：${err.message}`);
    try { await replyText(messageId, `处理异常：${err.message}`); } catch {}
  }
}

/* ══════════════════════════════════════════
   HTTP Server
   ══════════════════════════════════════════ */
function parseBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalLen = 0;
    let destroyed = false;
    req.on("data", (c) => {
      if (destroyed) return;
      totalLen += c.length;
      if (totalLen > maxBytes) {
        destroyed = true;
        req.destroy();
        reject(new Error(`请求体超过 ${maxBytes} 字节限制`));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (destroyed) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", (e) => {
      if (!destroyed) reject(e);
    });
  });
}

const server = createServer(async (req, res) => {
  // ── 健康检查 ──
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", uptime: process.uptime() }));
    return;
  }

  // ── 飞书卡片交互回调（按钮点击） ──
  if (req.method === "POST" && req.url === "/feishu/card") {
    try {
      const body = await parseBody(req);

      // URL 验证（配置卡片请求地址时飞书会发 challenge）
      if (body.type === "url_verification") {
        log("[卡片回调] 收到 URL 验证请求");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ challenge: body.challenge }));
        return;
      }

      const action = body.action;
      const value = action?.value;
      if (value?.action === "download_diff" && value?.file) {
        // 快速响应 200，防止飞书超时
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({}));
        // 异步上传文件并发送到群聊
        (async () => {
          try {
            const filePath = value.file;
            // 安全校验：只允许访问 diffs 目录
            const allowedDirs = ["/opt/fourmeme-monitor/diffs/", "/opt/flap-monitor/diffs/"];
            const resolved = join("/", filePath);
            if (!allowedDirs.some(d => resolved.startsWith(d))) {
              log(`[卡片回调] 路径不合法: ${resolved}`);
              return;
            }
            if (!existsSync(resolved)) {
              log(`[卡片回调] 文件不存在: ${resolved}`);
              try {
                const chatId = getChatId() || body.open_chat_id;
                if (chatId) {
                    await _sdkSendText("Diff 文件已过期或不存在（文件保留 7 天）", { chatId });
                }
              } catch (_) {}
              return;
            }
            const fileContent = readFileSync(resolved, "utf-8");
            const fileName = resolved.split("/").pop();
            const fileKey = await _sdkUploadFile(fileName, fileContent);
            const chatId = getChatId() || body.open_chat_id;
            if (chatId) await _sdkSendFile(fileKey, { chatId });
            log(`[卡片回调] diff 文件已发送: ${fileName}`);
          } catch (err) {
            log(`[卡片回调] 发送失败: ${err.message}`);
          }
        })();
        return;
      }
      // 未知按钮，返回空
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({}));
      return;
    } catch (err) {
      log(`[卡片回调] 异常: ${err.message}`);
      if (!res.headersSent) { res.writeHead(200); res.end("{}"); }
      return;
    }
  }

  // ── 飞书事件回调 ──
  if (req.method === "POST" && req.url === "/feishu/event") {
    try {
      let body = await parseBody(req);

      // 如果启用了加密
      if (body.encrypt && CONFIG.feishuEncryptKey) {
        body = decryptEvent(body.encrypt);
      }

      // URL 验证（首次配置事件订阅时飞书会发）
      if (body.type === "url_verification") {
        log("收到 URL 验证请求");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ challenge: body.challenge }));
        return;
      }

      // v2.0 事件格式
      if (body.header && body.header.event_type === "im.message.receive_v1") {
        const eventId = body.header.event_id;
        // 快速响应 200，防止飞书重试
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ok");

        // 去重
        if (isDuplicate(eventId)) {
          log(`重复事件，跳过：${eventId}`);
          return;
        }

        const event = body.event;
        const message = event?.message;
        if (!message || message.message_type !== "text") {
          log(`非文本消息，忽略（类型：${message?.message_type}）`);
          return;
        }

        // 解析消息内容
        let content;
        try {
          content = JSON.parse(message.content);
        } catch {
          log(`消息内容解析失败：${message.content}`);
          return;
        }

        const text = content.text || "";
        const messageId = message.message_id;

        // 发送者鉴权
        const senderId = event?.sender?.sender_id?.open_id || "";
        if (CONFIG.allowedSenders.length > 0 && !CONFIG.allowedSenders.includes(senderId)) {
          log(`未授权用户：${senderId}`);
          // Don't reply to avoid leaking info, just ignore
          return;
        }

        // 速率限制
        if (!checkRateLimit(senderId || "anonymous")) {
          log(`速率限制：${senderId}`);
          try { await replyText(message.message_id, "操作过于频繁，请稍后再试"); } catch {}
          return;
        }

        // 异步处理命令（不阻塞 HTTP 响应）
        handleMessage(messageId, text).catch((err) => {
          log(`消息处理失败：${err.message}`);
        });
        return;
      }

      // 其他事件
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
    } catch (err) {
      log(`请求处理异常：${err.message}`);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end("error");
      }
    }
    return;
  }

  // 404
  res.writeHead(404);
  res.end("Not Found");
});

server.timeout = 30_000;
server.requestTimeout = 10_000;
server.maxConnections = 100;

/* ══════════════════════════════════════════
   启动
   ══════════════════════════════════════════ */
server.listen(CONFIG.port, () => {
  log(`飞书交互机器人已启动，监听端口 ${CONFIG.port}`);
  log(`事件回调地址：http://0.0.0.0:${CONFIG.port}/feishu/event`);
  log(`卡片回调地址：http://0.0.0.0:${CONFIG.port}/feishu/card`);
  log(`健康检查地址：http://0.0.0.0:${CONFIG.port}/health`);
  if (!getClient()) {
    log("⚠ 警告：飞书 SDK 未初始化，无法回复消息！");
  }
  // 启动每日报告定时器
  scheduleDailyReport();
});

process.on("unhandledRejection", (err) => {
  log(`[未捕获异常] ${err?.message || err}`);
});
