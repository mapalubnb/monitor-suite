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
const ENV_FILE = join(__dirname, "..", ".env");

/* ── .env 加载（与 ai-client.mjs 一致） ── */
if (existsSync(ENV_FILE)) {
  try {
    for (const line of readFileSync(ENV_FILE, "utf-8").split("\n")) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && !(m[1] in process.env)) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    }
  } catch { /* ignore */ }
}

const ts = () => new Date().toLocaleString("zh-CN", { hour12: false });
const log = (msg) => console.log(`[${ts()}] ${msg}`);

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
      log(`[飞书SDK] token 已刷新（有效期 ${json.expire}s）`);
      return _tenantToken;
    }
    log(`[飞书SDK] token 获取失败: code=${json.code} msg=${json.msg}`);
    return "";
  } catch (err) {
    log(`[飞书SDK] token 获取网络异常: ${err.message}`);
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
    log("[飞书SDK] 警告：FEISHU_APP_ID / FEISHU_APP_SECRET 未配置");
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
  log("[飞书SDK] Client 已初始化（手动 token 管理模式）");
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
    log(`[飞书SDK] 凭证验证通过 ✓`);
  } else {
    log(`[飞书SDK] ⚠ 凭证验证失败，请检查 FEISHU_APP_ID(${APP_ID.slice(0,8)}...) 和 FEISHU_APP_SECRET`);
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
export function buildCardJson(title, content, template, diffFilePath) {
  const elements = [
    { tag: "markdown", content },
  ];
  if (diffFilePath) {
    elements.push({
      tag: "action",
      actions: [{
        tag: "button",
        text: { tag: "plain_text", content: "📎 下载 Diff 详情" },
        type: "default",
        value: { action: "download_diff", file: diffFilePath },
      }],
    });
  }
  elements.push({
    tag: "note",
    elements: [{ tag: "plain_text", content: `监控时间：${ts()}` }],
  });
  return JSON.stringify({
    header: { title: { tag: "plain_text", content: title }, template },
    elements,
  });
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

  const cardJson = buildCardJson(title, content, template, opts.diffFilePath);
  const tokenOpt = await withToken();
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
  log(`[飞书SDK] 卡片已发送 → ${messageId}`);
  return messageId;
}

/**
 * 发送文本消息到群聊
 */
export async function sendText(text, opts = {}) {
  const client = getClient();
  if (!client) throw new Error("飞书 SDK 未初始化");
  const targetChatId = opts.chatId || CHAT_ID;
  if (!targetChatId) throw new Error("FEISHU_CHAT_ID 未配置");

  const tokenOpt = await withToken();
  const res = await client.im.message.create({
    params: { receive_id_type: "chat_id" },
    data: {
      receive_id: targetChatId,
      content: JSON.stringify({ text }),
      msg_type: "text",
    },
  }, tokenOpt);
  if (res.code !== 0) throw new Error(`code=${res.code}: ${res.msg}`);
  return res.data?.message_id;
}

/**
 * 回复文本消息
 */
export async function replyText(messageId, text) {
  const client = getClient();
  if (!client) throw new Error("飞书 SDK 未初始化");
  const maxLen = 3500;
  const truncated = text.length > maxLen
    ? text.slice(0, maxLen) + "\n\n... (输出已截断)"
    : text;
  const tokenOpt = await withToken();
  const res = await client.im.message.reply({
    path: { message_id: messageId },
    data: {
      content: JSON.stringify({ text: truncated }),
      msg_type: "text",
    },
  }, tokenOpt);
  if (res.code !== 0) {
    log(`[飞书SDK] 回复失败 code=${res.code}: ${res.msg}`);
  }
  return res;
}

/**
 * 回复卡片消息
 */
export async function replyCard(messageId, title, content, color = "blue") {
  const client = getClient();
  if (!client) throw new Error("飞书 SDK 未初始化");
  const maxLen = 3500;
  const truncated = content.length > maxLen
    ? content.slice(0, maxLen) + "\n\n... (输出已截断，完整日志见下方文件)"
    : content;
  const card = JSON.stringify({
    header: { title: { tag: "plain_text", content: title }, template: color },
    elements: [
      { tag: "markdown", content: truncated },
      { tag: "note", elements: [{ tag: "plain_text", content: ts() }] },
    ],
  });
  const tokenOpt = await withToken();
  const res = await client.im.message.reply({
    path: { message_id: messageId },
    data: {
      content: card,
      msg_type: "interactive",
    },
  }, tokenOpt);
  if (res.code !== 0) {
    log(`[飞书SDK] 回复卡片失败 code=${res.code}: ${res.msg}`);
  }
  return res;
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
      content: buildCardJson(title, content, template, opts.diffFilePath),
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
  const tokenOpt = await withToken();
  const res = await client.im.file.create({
    data: {
      file_type: "stream",
      file_name: fileName,
      file: buf,
    },
  }, tokenOpt);
  if (res.code !== 0) throw new Error(`文件上传失败: ${res.msg}`);
  return res.data?.file_key;
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
    log(`[飞书SDK] 文件回复失败 code=${res.code}: ${res.msg}`);
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
      log(`[Pin] 置顶失败 code=${res.code}: ${res.msg}`);
      return;
    }
    log(`[Pin] 消息已置顶 → ${messageId}`);
  } catch (err) {
    log(`[Pin] 置顶异常：${err.message}`);
  }
}

/* ══════════════════════════════════════════
   节流器（IM API 限制：同群 5 QPS）
   ══════════════════════════════════════════ */
const messageThrottle = {
  timestamps: [],        // 最近 1s 内的发送时间戳
  maxPerSecond: 4,       // 预留 1 条余量（飞书限 5 QPS）
  queue: [],
  maxQueueSize: 100,
  processing: false,
  pendingHeartbeat: null,
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
    // 队列已空，处理低优先级心跳
    if (messageThrottle.pendingHeartbeat) {
      const heartbeatTask = messageThrottle.pendingHeartbeat;
      messageThrottle.pendingHeartbeat = null;
      const now = Date.now();
      messageThrottle.timestamps = messageThrottle.timestamps.filter(t => now - t < 1_000);
      if (messageThrottle.timestamps.length < messageThrottle.maxPerSecond) {
        messageThrottle.timestamps.push(Date.now());
        try {
          await heartbeatTask();
          log("[心跳] 队列空闲，心跳已推送");
        } catch (err) {
          log(`[心跳] 推送失败：${err.message}`);
        }
      } else {
        messageThrottle.pendingHeartbeat = heartbeatTask;
      }
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
    if (messageThrottle.queue.length >= messageThrottle.maxQueueSize) {
      messageThrottle.queue.shift();
      log(`[飞书] 队列已满（${messageThrottle.maxQueueSize}），丢弃最早一条通知`);
    }
    messageThrottle.queue.push(async () => {
      try {
        const msgId = await sendCard(title, content, template, opts);
        resolve(msgId);
      } catch (err) {
        log(`[飞书] 发送失败：${err.message}`);
        resolve(null);
      }
    });
    processQueue().catch(err => {
      log(`[飞书] processQueue 异常：${err.message}`);
    });
  });
}

/**
 * 低优先级心跳消息 — 队列空闲时推送，新心跳覆盖旧心跳
 */
export function sendHeartbeatQueued(title, content, template = "green") {
  messageThrottle.pendingHeartbeat = async () => {
    await sendCard(title, content, template);
  };
  log(`[心跳] 已挂起，等待队列空闲（当前队列: ${messageThrottle.queue.length} 条）`);
  if (messageThrottle.queue.length === 0) {
    processQueue().catch(err => {
      log(`[心跳] processQueue 异常：${err.message}`);
    });
  }
}

/**
 * 等待消息队列排空
 * @param {number} [timeoutMs=30000]
 */
export async function waitQueueDrain(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (messageThrottle.queue.length > 0 && Date.now() < deadline) {
    log(`等待 ${messageThrottle.queue.length} 条通知发送完成...`);
    await new Promise(r => setTimeout(r, 2_000));
  }
  messageThrottle.pendingHeartbeat = null;
  if (messageThrottle.queue.length > 0) {
    log(`超时退出，${messageThrottle.queue.length} 条通知未发送`);
  }
}

/* ── 启动日志 ── */
if (APP_ID) {
  log(`[飞书SDK] 应用: ${APP_ID}  群聊: ${CHAT_ID || "(未配置)"}`);
} else {
  log("[飞书SDK] 警告：FEISHU_APP_ID 未配置，飞书通知不可用");
}
