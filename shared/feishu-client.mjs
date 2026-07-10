/**
 * 共享飞书 SDK 客户端 — 统一消息通道
 *
 * 使用 @larksuiteoapi/node-sdk 替代所有 Webhook 调用，
 * 通过 client.im.message.create() 统一发送消息到同一个群。
 *
 * 用法：
 *   import { sendCard, sendText, replyText, replyCard, patchCard,
 *            uploadFile, sendFile, replyFile, pinMessage,
 *            getClient, lark } from "../shared/feishu-client.mjs";
 */

import * as lark from "@larksuiteoapi/node-sdk";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const ts = () => new Date().toLocaleString("zh-CN", { hour12: false });
const log = (msg) => console.log(`[${ts()}] ${msg}`);

/* ── .env 加载（多路径搜索，确保各种部署方式下都能正确加载）── */
const ENV_PATHS = [
  join(__dirname, "..", ".env"),           // 相对路径（跟随 __dirname 解析）
  "/root/monitor-suite/.env",             // 源码/部署目录
  "/opt/monitor-suite/.env",              // 兼容旧的 /opt 部署
];

for (const envPath of ENV_PATHS) {
  if (existsSync(envPath)) {
    try {
      for (const line of readFileSync(envPath, "utf-8").split("\n")) {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (m) {
          // 始终从文件加载（覆盖可能错误的已有值）
          const val = m[2].replace(/^["']|["']$/g, "").trim();
          if (val) process.env[m[1]] = val;
        }
      }
      log(`[环境 ENV] 已加载：${envPath}`);
    } catch { /* ignore */ }
    break; // 找到第一个存在的 .env 就停止
  }
}

const APP_ID = process.env.FEISHU_APP_ID || "";
const APP_SECRET = process.env.FEISHU_APP_SECRET || "";
const CHAT_ID = process.env.FEISHU_CHAT_ID || "";

/* ══════════════════════════════════════════
   SDK Client 单例
   ══════════════════════════════════════════ */
let _client = null;

/* ── 手动 Token 管理（绕过 SDK 内部 tokenManager 的兼容性问题）── */
let _tenantToken = "";
let _tokenExpireAt = 0;

/**
 * 手动获取 tenant_access_token
 * 某些版本的 SDK 内部 token manager 存在兼容问题，
 * 此方法直接调用飞书 API 获取 token，确保稳定性。
 */
async function ensureTenantToken() {
  const now = Date.now();
  // token 有效期内直接复用（提前 5 分钟刷新）
  if (_tenantToken && now < _tokenExpireAt - 300_000) {
    return _tenantToken;
  }
  try {
    const res = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
    });
    const json = await res.json();
    if (json.code === 0 && json.tenant_access_token) {
      _tenantToken = json.tenant_access_token;
      _tokenExpireAt = now + json.expire * 1000;
      log(`[飞书 SDK] token 已刷新（有效期 ${json.expire}s）`);
      return _tenantToken;
    }
    log(`[飞书 SDK] token 获取失败：code=${json.code} msg=${json.msg}`);
    return "";
  } catch (err) {
    log(`[飞书 SDK] token 获取网络异常：${err.message}`);
    return "";
  }
}

/**
 * 获取飞书 SDK Client 单例
 * @returns {lark.Client|null}
 */
export function getClient() {
  if (_client) return _client;
  if (!APP_ID || !APP_SECRET) {
    log("[飞书 SDK] 警告：FEISHU_APP_ID / FEISHU_APP_SECRET 未配置");
    return null;
  }
  _client = new lark.Client({
    appId: APP_ID,
    appSecret: APP_SECRET,
    appType: lark.AppType.SelfBuild,
    domain: lark.Domain.Feishu,
    disableTokenCache: true,  // 禁用 SDK 内部 token 缓存，使用我们自己的管理
    loggerLevel: lark.LoggerLevel.error,
  });
  log("[飞书 SDK] Client 已初始化（手动 token 管理模式）");
  return _client;
}

/**
 * 获取 SDK 调用时的 token 选项
 * 使用 lark.withTenantToken 将手动获取的 token 注入请求
 */
async function withToken() {
  const token = await ensureTenantToken();
  if (!token) throw new Error("无法获取 tenant_access_token，请检查飞书凭证");
  return lark.withTenantToken(token);
}

/**
 * 启动时主动验证飞书凭证
 */
async function verifyCredentials() {
  if (!APP_ID || !APP_SECRET) return;
  const token = await ensureTenantToken();
  if (token) {
    log(`[飞书 SDK] 凭证验证通过 ✓`);
  } else {
    log(`[飞书 SDK] ⚠ 凭证验证失败，请检查 FEISHU_APP_ID(${APP_ID.slice(0,8)}...) 和 FEISHU_APP_SECRET`);
  }
}

// 启动时异步验证（不阻塞模块加载）
verifyCredentials();

export { lark };

export function getChatId() {
  return CHAT_ID;
}

/* ══════════════════════════════════════════
   卡片 JSON 构建
   ══════════════════════════════════════════ */
function normalizeCardOptions(diffFilePathOrOpts) {
  if (diffFilePathOrOpts && typeof diffFilePathOrOpts === "object" && !Array.isArray(diffFilePathOrOpts)) {
    return diffFilePathOrOpts;
  }
  return { diffFilePath: diffFilePathOrOpts };
}

function buildCardActions(opts = {}) {
  const actions = [];
  if (opts.diffFilePath) {
    actions.push({
      tag: "button",
      text: { tag: "plain_text", content: opts.diffButtonText || "查看详情" },
      type: "default",
      value: { action: "download_diff", file: opts.diffFilePath },
    });
  }
  for (const action of opts.actions || []) {
    if (!action || action.tag !== "button" || !action.text?.content) continue;
    const item = {
      tag: "button",
      text: { tag: "plain_text", content: String(action.text.content).slice(0, 30) },
      type: action.type || "default",
    };
    if (action.url) item.url = action.url;
    if (action.value?.action) item.value = action.value;
    if (!item.url && !item.value) continue;
    actions.push(item);
  }
  return actions;
}

function buildCardFooterElements(opts = {}) {
  const parts = [`更新时间：${ts()}`];
  if (opts.footerText) parts.unshift(String(opts.footerText).slice(0, 80));
  return [{ tag: "plain_text", content: parts.join("｜") }];
}

export function buildCardJson(title, content, template, diffFilePathOrOpts) {
  const opts = normalizeCardOptions(diffFilePathOrOpts);
  const elements = [
    { tag: "markdown", content: String(content || "").trim() || "-" },
  ];
  const actions = buildCardActions(opts);
  if (actions.length > 0) {
    elements.push({ tag: "hr" });
    elements.push({ tag: "markdown", content: "**操作**" });
    elements.push({
      tag: "action",
      actions,
    });
  }
  elements.push({ tag: "hr" });
  elements.push({
    tag: "note",
    elements: buildCardFooterElements(opts),
  });
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: { title: { tag: "plain_text", content: title }, template },
    elements,
  });
}

const FEISHU_TEXT_CHUNK_LIMIT = normalizeChunkLimit(process.env.FEISHU_TEXT_CHUNK_LIMIT, 3500);
const FEISHU_CARD_CHUNK_LIMIT = normalizeChunkLimit(process.env.FEISHU_CARD_CHUNK_LIMIT, 3500);

function normalizeChunkLimit(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 500 ? Math.floor(n) : fallback;
}

export function splitMessageContent(value, limit) {
  const text = String(value ?? "");
  if (text.length <= limit) return [text];

  const chunks = [];
  let current = "";
  const pushCurrent = () => {
    if (current !== "") chunks.push(current);
    current = "";
  };
  const appendPiece = (piece, separator = "") => {
    const next = current ? `${current}${separator}${piece}` : piece;
    if (next.length <= limit) {
      current = next;
      return;
    }
    pushCurrent();
    if (piece.length <= limit) {
      current = piece;
      return;
    }
    let rest = piece;
    while (rest.length > limit) {
      let splitAt = Math.max(
        rest.lastIndexOf(" ", limit),
        rest.lastIndexOf("，", limit),
        rest.lastIndexOf("。", limit),
        rest.lastIndexOf("；", limit),
        rest.lastIndexOf("、", limit),
      );
      if (splitAt < Math.floor(limit * 0.6)) splitAt = limit;
      else splitAt += 1;
      chunks.push(rest.slice(0, splitAt));
      rest = rest.slice(splitAt);
    }
    current = rest;
  };

  const paragraphs = text.split(/(\n{2,})/);
  for (const paragraph of paragraphs) {
    if (!paragraph) continue;
    if (/^\n{2,}$/.test(paragraph)) {
      appendPiece(paragraph);
      continue;
    }
    if (paragraph.length <= limit) {
      appendPiece(paragraph);
      continue;
    }
    const lines = paragraph.split(/(\n)/);
    for (const line of lines) {
      if (line === "") continue;
      appendPiece(line);
    }
  }
  pushCurrent();
  if (chunks.length === 0) chunks.push("");
  const merged = [];
  let pendingWhitespace = "";
  for (const chunk of chunks) {
    if (/^\s+$/.test(chunk)) {
      pendingWhitespace += chunk;
      continue;
    }
    if (pendingWhitespace) {
      if (merged.length > 0 && merged[merged.length - 1].length + pendingWhitespace.length <= limit) {
        merged[merged.length - 1] += pendingWhitespace;
      } else {
        const available = Math.max(0, limit - pendingWhitespace.length);
        merged.push(pendingWhitespace + chunk.slice(0, available));
        if (chunk.length > available) merged.push(chunk.slice(available));
        pendingWhitespace = "";
        continue;
      }
      pendingWhitespace = "";
    }
    merged.push(chunk);
  }
  if (pendingWhitespace) {
    if (merged.length > 0) merged[merged.length - 1] += pendingWhitespace;
    else merged.push(pendingWhitespace);
  }
  return merged;
}

export function balanceCardFontTags(chunks) {
  let activeTag = "";
  return chunks.map(chunk => {
    let content = activeTag ? `${activeTag}${chunk}` : chunk;
    const tokens = chunk.match(/<font\b[^>]*>|<\/font>/gi) || [];
    for (const token of tokens) {
      if (/^<\/font/i.test(token)) activeTag = "";
      else activeTag = token;
    }
    if (activeTag) content += "</font>";
    return content;
  });
}

function partTitle(title, index, total) {
  return total > 1 ? `${title} (${index}/${total})` : title;
}

function partText(text, index, total) {
  return total > 1 ? `(${index}/${total})\n${text}` : text;
}

async function pauseBetweenChunks(index, total) {
  if (total > 1 && index < total) {
    await new Promise(resolve => setTimeout(resolve, 260));
  }
}

/* ══════════════════════════════════════════
   消息发送 API
   ══════════════════════════════════════════ */

/**
 * 发送卡片消息到群聊，返回 message_id
 *
 * @param {string} title - 卡片标题
 * @param {string} content - 卡片 markdown 内容
 * @param {string} [template="red"] - 卡片颜色
 * @param {Object} [opts] - 选项
 * @param {string} [opts.chatId] - 目标群聊 ID（默认 FEISHU_CHAT_ID）
 * @param {string} [opts.diffFilePath] - Diff 文件路径（卡片内嵌下载按钮）
 * @returns {Promise<string>} message_id
 */
export async function sendCard(title, content, template = "red", opts = {}) {
  const client = getClient();
  if (!client) throw new Error("飞书 SDK 未初始化");
  const targetChatId = opts.chatId || CHAT_ID;
  if (!targetChatId) throw new Error("FEISHU_CHAT_ID 未配置");

  const chunks = balanceCardFontTags(splitMessageContent(content, FEISHU_CARD_CHUNK_LIMIT - 40));
  const tokenOpt = await withToken();
  let firstMessageId = "";
  for (let i = 0; i < chunks.length; i++) {
    const cardJson = buildCardJson(
      partTitle(title, i + 1, chunks.length),
      chunks[i],
      template,
      opts,
    );
    const res = await client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: targetChatId,
        content: cardJson,
        msg_type: "interactive",
      },
    }, tokenOpt);
    if (res.code !== 0) throw new Error(`code=${res.code}: ${res.msg}`);
    const messageId = res.data?.message_id;
    if (!firstMessageId) firstMessageId = messageId;
    log(`[飞书 SDK] 卡片已发送${chunks.length > 1 ? ` (${i + 1}/${chunks.length})` : ""} → ${messageId}`);
    await pauseBetweenChunks(i + 1, chunks.length);
  }
  return firstMessageId;
}

/**
 * 发送文本消息到群聊
 */
export async function sendText(text, opts = {}) {
  const client = getClient();
  if (!client) throw new Error("飞书 SDK 未初始化");
  const targetChatId = opts.chatId || CHAT_ID;
  if (!targetChatId) throw new Error("FEISHU_CHAT_ID 未配置");

  const chunks = splitMessageContent(text, FEISHU_TEXT_CHUNK_LIMIT);
  const tokenOpt = await withToken();
  let firstMessageId = "";
  for (let i = 0; i < chunks.length; i++) {
    const res = await client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: targetChatId,
        content: JSON.stringify({ text: partText(chunks[i], i + 1, chunks.length) }),
        msg_type: "text",
      },
    }, tokenOpt);
    if (res.code !== 0) throw new Error(`code=${res.code}: ${res.msg}`);
    if (!firstMessageId) firstMessageId = res.data?.message_id;
    await pauseBetweenChunks(i + 1, chunks.length);
  }
  return firstMessageId;
}

/**
 * 回复文本消息
 */
export async function replyText(messageId, text) {
  const client = getClient();
  if (!client) throw new Error("飞书 SDK 未初始化");
  const chunks = splitMessageContent(text, FEISHU_TEXT_CHUNK_LIMIT);
  const tokenOpt = await withToken();
  let firstRes = null;
  for (let i = 0; i < chunks.length; i++) {
    const res = await client.im.message.reply({
      path: { message_id: messageId },
      data: {
        content: JSON.stringify({ text: partText(chunks[i], i + 1, chunks.length) }),
        msg_type: "text",
      },
    }, tokenOpt);
    if (!firstRes) firstRes = res;
    if (res.code !== 0) {
      log(`[飞书 SDK] 回复失败：code=${res.code}: ${res.msg}`);
    }
    await pauseBetweenChunks(i + 1, chunks.length);
  }
  return firstRes;
}

/**
 * 回复卡片消息
 */
export async function replyCard(messageId, title, content, color = "blue") {
  const client = getClient();
  if (!client) throw new Error("飞书 SDK 未初始化");
  const chunks = balanceCardFontTags(splitMessageContent(content, FEISHU_CARD_CHUNK_LIMIT - 40));
  const tokenOpt = await withToken();
  let firstRes = null;
  for (let i = 0; i < chunks.length; i++) {
    const card = buildCardJson(partTitle(title, i + 1, chunks.length), chunks[i], color);
    const res = await client.im.message.reply({
      path: { message_id: messageId },
      data: {
        content: card,
        msg_type: "interactive",
      },
    }, tokenOpt);
    if (!firstRes) firstRes = res;
    if (res.code !== 0) {
      log(`[飞书 SDK] 回复卡片失败：code=${res.code}: ${res.msg}`);
    }
    await pauseBetweenChunks(i + 1, chunks.length);
  }
  return firstRes;
}

/**
 * 编辑已发送的卡片消息（用于补充 AI 摘要）
 */
export async function patchCard(messageId, title, content, template = "red", opts = {}) {
  const client = getClient();
  if (!client) throw new Error("飞书 SDK 未初始化");
  const tokenOpt = await withToken();
  const res = await client.im.message.patch({
    path: { message_id: messageId },
    data: {
      content: buildCardJson(title, content, template, opts),
    },
  }, tokenOpt);
  if (res.code !== 0) throw new Error(`code=${res.code}: ${res.msg}`);
}

/**
 * 上传文件到飞书，返回 file_key
 */
export async function uploadFile(fileName, content) {
  const client = getClient();
  if (!client) throw new Error("飞书 SDK 未初始化");
  const buf = typeof content === "string" ? Buffer.from(content, "utf-8") : content;
  // 飞书 SDK 要求 file 字段为 ReadableStream，不能直接传 Buffer
  const { Readable } = await import("node:stream");
  const stream = Readable.from(buf);
  const tokenOpt = await withToken();
  const res = await client.im.file.create({
    data: {
      file_type: "stream",
      file_name: fileName,
      file: stream,
    },
  }, tokenOpt);
  // 飞书 SDK im.file.create 返回结构不统一：
  // 成功时可能直接返回 { file_key: "..." } 或 { code: 0, data: { file_key: "..." } }
  const fileKey = res.file_key || res.data?.file_key;
  if (fileKey) return fileKey;
  // 有明确错误码的情况
  if (res.code !== undefined && res.code !== 0) {
    const errMsg = res.msg || res.message || JSON.stringify(res).slice(0, 200);
    throw new Error(`文件上传失败 code=${res.code}: ${errMsg}`);
  }
  // 兜底：无 file_key 也无错误码
  log(`[飞书 SDK] 文件上传响应异常：${JSON.stringify(res).slice(0, 300)}`);
  throw new Error("文件上传失败：响应中无 file_key");
}

/**
 * 发送文件消息到群聊
 */
export async function sendFile(fileKey, opts = {}) {
  const client = getClient();
  if (!client) throw new Error("飞书 SDK 未初始化");
  const targetChatId = opts.chatId || CHAT_ID;
  if (!targetChatId) throw new Error("FEISHU_CHAT_ID 未配置");

  const tokenOpt = await withToken();
  const res = await client.im.message.create({
    params: { receive_id_type: "chat_id" },
    data: {
      receive_id: targetChatId,
      content: JSON.stringify({ file_key: fileKey }),
      msg_type: "file",
    },
  }, tokenOpt);
  if (res.code !== 0) throw new Error(`发送文件消息失败: ${res.msg}`);
  return res.data?.message_id;
}

/**
 * 回复文件消息
 */
export async function replyFile(messageId, fileKey) {
  const client = getClient();
  if (!client) throw new Error("飞书 SDK 未初始化");
  const tokenOpt = await withToken();
  const res = await client.im.message.reply({
    path: { message_id: messageId },
    data: {
      content: JSON.stringify({ file_key: fileKey }),
      msg_type: "file",
    },
  }, tokenOpt);
  if (res.code !== 0) {
    log(`[飞书 SDK] 文件回复失败：code=${res.code}: ${res.msg}`);
  }
  return res;
}

/**
 * 置顶消息（Pin）
 */
export async function pinMessage(messageId) {
  if (!messageId) return;
  const client = getClient();
  if (!client) return;
  try {
    const tokenOpt = await withToken();
    const res = await client.im.pin.create({
      data: { message_id: messageId },
    }, tokenOpt);
    if (res.code !== 0) {
      log(`[置顶 Pin] 置顶失败：code=${res.code}: ${res.msg}`);
      return;
    }
    log(`[置顶 Pin] 消息已置顶 → ${messageId}`);
  } catch (err) {
    log(`[置顶 Pin] 置顶异常：${err.message}`);
  }
}

/* ══════════════════════════════════════════
   节流器（IM API 限制：同群 5 QPS）
   ══════════════════════════════════════════ */
const messageThrottle = {
  timestamps: [],        // 最近 1s 内的发送时间戳
  maxPerSecond: 4,       // 预留 1 条余量（飞书限 5 QPS）
  queue: [],
  processing: false,
};

let _processingPromise = null;

async function processQueue() {
  if (_processingPromise) return _processingPromise;
  _processingPromise = _doProcessQueue();
  return _processingPromise;
}

async function _doProcessQueue() {
  try {
    while (messageThrottle.queue.length > 0) {
      const now = Date.now();
      messageThrottle.timestamps = messageThrottle.timestamps.filter(t => now - t < 1_000);
      if (messageThrottle.timestamps.length >= messageThrottle.maxPerSecond) {
        const waitMs = 1_000 - (now - messageThrottle.timestamps[0]) + 100;
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      const task = messageThrottle.queue.shift();
      messageThrottle.timestamps.push(Date.now());
      await task();
    }
  } finally {
    _processingPromise = null;
  }
}

/**
 * 带节流的卡片发送（排队机制，防止突发超限）
 * @returns {Promise<string|null>} message_id 或 null
 */
export async function sendCardQueued(title, content, template = "red", opts = {}) {
  return new Promise((resolve) => {
    const task = async () => {
      try {
        const msgId = await sendCard(title, content, template, opts);
        resolve(msgId);
      } catch (err) {
        log(`[飞书] 发送失败：${err.message}`);
        resolve(null);
      }
    };
    messageThrottle.queue.push(task);
    processQueue().catch(err => {
      log(`[飞书] 消息队列处理异常：${err.message}`);
    });
  });
}

/**
 * 等待消息队列排空
 * @param {number} [timeoutMs=30000]
 */
export async function waitQueueDrain(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while ((messageThrottle.queue.length > 0 || _processingPromise) && Date.now() < deadline) {
    log(`等待通知发送完成（排队 ${messageThrottle.queue.length} 条${_processingPromise ? "，发送中" : ""}）……`);
    await new Promise(r => setTimeout(r, 200));
  }
  if (messageThrottle.queue.length > 0 || _processingPromise) {
    log(`超时退出，仍有 ${messageThrottle.queue.length} 条排队通知或正在发送的任务`);
  }
}

/* ── 启动日志 ── */
if (APP_ID) {
  log(`[飞书 SDK] 应用：${APP_ID}  群聊：${CHAT_ID || "(未配置)"}`);
} else {
  log("[飞书 SDK] 警告：FEISHU_APP_ID 未配置，飞书通知不可用");
}
