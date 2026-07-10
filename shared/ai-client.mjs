/**
 * 共享 AI 客户端 — 统一的多模型调用层
 *
 * 功能：
 *   1. 从 ai-models.json 加载模型配置（热加载，5s 缓存）
 *   2. 支持 OpenAI 兼容格式 + Anthropic (Claude) 格式
 *   3. ENV:XXX 语法自动从环境变量解析 API Key
 *   4. 仅展示已配置 API Key 的可用提供商
 *   5. 支持从 API 动态获取模型列表（listRemoteModels）
 *   6. 提供 chatCompletion / switchProvider / listProviders 等公共 API
 *
 * 用法：
 *   import { AI, aiSummarize, chatCompletion, switchProvider, listProviders, listRemoteModels } from "../shared/ai-client.mjs";
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/* ── 配置路径 ── */
const MODELS_FILE = join(__dirname, "..", "ai-models.json");
const ENV_FILE = join(__dirname, "..", ".env");

/* ── 日志 ── */
const ts = () => new Date().toLocaleString("zh-CN", { hour12: false });
const log = (msg) => console.log(`[${ts()}] ${msg}`);

/* ── .env 加载（简易实现，不依赖 dotenv） ── */
function loadEnvFile() {
  if (!existsSync(ENV_FILE)) return;
  try {
    for (const line of readFileSync(ENV_FILE, "utf-8").split("\n")) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && !(m[1] in process.env)) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    }
  } catch {}
}
loadEnvFile();

/* ── 模型配置热加载 ── */
let _configCache = { data: null, ts: 0 };
const CACHE_TTL = 5_000;

function loadModelsConfig() {
  const now = Date.now();
  if (_configCache.data && now - _configCache.ts < CACHE_TTL) {
    return _configCache.data;
  }
  try {
    if (existsSync(MODELS_FILE)) {
      const data = JSON.parse(readFileSync(MODELS_FILE, "utf-8"));
      _configCache = { data, ts: now };
      return data;
    }
  } catch (err) {
    log(`[AI] ai-models.json 加载失败：${err.message}`);
  }
  // fallback: 空配置
  const fallback = { current: "", providers: {} };
  _configCache = { data: fallback, ts: now };
  return fallback;
}

/**
 * 解析 API Key：支持 "ENV:VAR_NAME" 语法
 */
function resolveApiKey(raw) {
  if (!raw) return "";
  if (raw.startsWith("ENV:")) {
    const envName = raw.slice(4);
    return process.env[envName] || "";
  }
  return raw;
}

/**
 * 获取当前生效的 provider 配置
 */
function getCurrentProvider() {
  const config = loadModelsConfig();
  let name = config.current || "";

  // 如果当前选中的 provider 没有有效 key，自动切换到第一个有 key 的
  if (name) {
    const provider = config.providers[name];
    if (!provider || !resolveApiKey(provider.apiKey)) {
      name = "";
    }
  }
  if (!name) {
    // 找第一个有有效 key 的 provider
    for (const [n, p] of Object.entries(config.providers || {})) {
      if (resolveApiKey(p.apiKey)) {
        name = n;
        break;
      }
    }
  }

  const provider = config.providers[name];
  if (!provider) {
    return { name: "", apiUrl: "", apiKey: "", model: "", label: "", format: "openai" };
  }
  return {
    name,
    apiUrl: provider.apiUrl || "",
    apiKey: resolveApiKey(provider.apiKey),
    model: provider.model || "",
    label: provider.label || name,
    format: provider.format || "openai",
    timeoutMs: provider.timeoutMs || 30_000,
    maxInputLen: provider.maxInputLen || 8000,
  };
}

/* ── 公共 AI 配置对象（兼容旧代码的 AI_CONFIG 接口）── */
export const AI = {
  get enabled() {
    const p = getCurrentProvider();
    return !!(p.apiUrl && p.apiKey);
  },
  get apiUrl() { return getCurrentProvider().apiUrl; },
  get apiKey() { return getCurrentProvider().apiKey; },
  get model() { return getCurrentProvider().model; },
  get providerName() { return getCurrentProvider().name; },
  get label() { return getCurrentProvider().label; },
  get format() { return getCurrentProvider().format; },
  get timeoutMs() { return getCurrentProvider().timeoutMs; },
  get maxInputLen() { return getCurrentProvider().maxInputLen; },
};

/**
 * 列出所有可用模型（仅返回已配置 API Key 的提供商）
 * @returns {{ current: string, providers: Array<{name, label, model, format, models}> }}
 */
export function listProviders() {
  const config = loadModelsConfig();
  const providers = Object.entries(config.providers || {})
    .filter(([, p]) => !!resolveApiKey(p.apiKey))
    .map(([name, p]) => ({
      name,
      label: p.label || name,
      model: p.model || "",
      format: p.format || "openai",
      models: p.models || [p.model || ""],
      hasKey: true,
    }));
  return { current: config.current || "", providers };
}

/**
 * 列出所有提供商（含无 key 的，用于管理界面展示完整列表）
 * @returns {{ current: string, providers: Array<{name, label, model, format, hasKey, models}> }}
 */
export function listAllProviders() {
  const config = loadModelsConfig();
  const providers = Object.entries(config.providers || {}).map(([name, p]) => ({
    name,
    label: p.label || name,
    model: p.model || "",
    format: p.format || "openai",
    models: p.models || [p.model || ""],
    hasKey: !!resolveApiKey(p.apiKey),
  }));
  return { current: config.current || "", providers };
}

/**
 * 从 API 远程获取可用模型列表
 * @param {string} [providerName] - 提供商名称（默认当前）
 * @returns {Promise<{ok: boolean, models?: string[], message?: string}>}
 */
export async function listRemoteModels(providerName) {
  const config = loadModelsConfig();
  const name = providerName || config.current || "";
  const provider = config.providers[name];
  if (!provider) return { ok: false, message: `未知提供商: ${name}` };

  const apiKey = resolveApiKey(provider.apiKey);
  if (!apiKey) return { ok: false, message: `${name} 未配置 API Key` };

  // 确定模型列表 URL
  let modelsUrl = provider.modelsUrl || "";
  if (!modelsUrl) {
    // 尝试从 apiUrl 推断（OpenAI 兼容格式：替换 /chat/completions 为 /models）
    if (provider.apiUrl?.includes("/chat/completions")) {
      modelsUrl = provider.apiUrl.replace("/chat/completions", "/models");
    }
  }
  if (!modelsUrl) {
    // 无法获取远程列表，返回本地配置的 models
    return { ok: true, models: provider.models || [provider.model], source: "local" };
  }

  let timer;
  try {
    const ctrl = new AbortController();
    timer = setTimeout(() => ctrl.abort(), 10_000);

    const headers = { "Content-Type": "application/json" };
    // Anthropic 没有 list models API
    if (provider.format === "anthropic") {
      return { ok: true, models: provider.models || [provider.model], source: "local" };
    }
    // Gemini 使用 query param key
    if (modelsUrl.includes("generativelanguage.googleapis.com")) {
      const separator = modelsUrl.includes("?") ? "&" : "?";
      modelsUrl = `${modelsUrl}${separator}key=${apiKey}`;
    } else {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const res = await fetch(modelsUrl, { headers, signal: ctrl.signal });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      return { ok: false, message: `HTTP ${res.status}: ${errText.slice(0, 100)}` };
    }

    const json = await res.json();

    // 解析模型列表（不同 API 返回格式略有不同）
    let models = [];
    if (Array.isArray(json.data)) {
      // OpenAI / DeepSeek / Qwen / Mistral / Groq 格式
      models = json.data
        .map(m => m.id || m.name || "")
        .filter(id => id && !id.includes("embedding") && !id.includes("tts") && !id.includes("whisper") && !id.includes("dall-e"));
    } else if (Array.isArray(json.models)) {
      // Gemini 格式
      models = json.models
        .map(m => (m.name || "").replace("models/", ""))
        .filter(id => id && !id.includes("embedding"));
    } else if (Array.isArray(json)) {
      models = json.map(m => m.id || m.name || "").filter(Boolean);
    }

    // 过滤只保留 chat 相关模型（排除纯 embedding/audio/image 模型）
    models = models.filter(id =>
      !id.includes("embed") && !id.includes("tts") && !id.includes("whisper") &&
      !id.includes("dall-e") && !id.includes("audio") && !id.includes("image") &&
      !id.includes("moderation")
    );

    if (models.length === 0) {
      return { ok: true, models: provider.models || [provider.model], source: "local" };
    }

    // 排序：优先显示本地配置中的模型
    const localModels = new Set(provider.models || []);
    models.sort((a, b) => {
      const aLocal = localModels.has(a) ? 0 : 1;
      const bLocal = localModels.has(b) ? 0 : 1;
      if (aLocal !== bLocal) return aLocal - bLocal;
      return a.localeCompare(b);
    });

    return { ok: true, models, source: "remote" };
  } catch (err) {
    if (err.name === "AbortError") {
      return { ok: false, message: "请求超时（10s）" };
    }
    return { ok: false, message: err.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 切换当前 AI 提供商和/或模型
 * @param {string} providerName - provider 名称
 * @param {string} [modelOverride] - 可选：覆盖 model 名称
 * @returns {{ ok: boolean, message: string }}
 */
export function switchProvider(providerName, modelOverride) {
  const config = loadModelsConfig();
  if (!config.providers[providerName]) {
    // 尝试模糊匹配（忽略大小写）
    const match = Object.keys(config.providers).find(k => k.toLowerCase() === providerName.toLowerCase());
    if (match) {
      providerName = match;
    } else {
      const available = Object.keys(config.providers)
        .filter(k => !!resolveApiKey(config.providers[k].apiKey))
        .join(", ");
      return { ok: false, message: `未知提供商: ${providerName}\n可用: ${available || "(无，请先配置 API Key)"}` };
    }
  }

  // 检查是否有有效 key
  const provider = config.providers[providerName];
  if (!resolveApiKey(provider.apiKey)) {
    return { ok: false, message: `${providerName} 未配置 API Key，无法切换` };
  }

  config.current = providerName;
  if (modelOverride) {
    config.providers[providerName].model = modelOverride;
  }
  try {
    writeFileSync(MODELS_FILE, JSON.stringify(config, null, 2), "utf-8");
    // 清除缓存使立即生效
    _configCache = { data: config, ts: Date.now() };
    const model = modelOverride || provider.model;
    log(`[AI] 模型已切换为: ${providerName} (${model})`);
    return { ok: true, message: `已切换为 ${provider.label || providerName} (${model})` };
  } catch (err) {
    return { ok: false, message: `写入配置失败: ${err.message}` };
  }
}

/* ══════════════════════════════════════════
   核心调用函数
   ══════════════════════════════════════════ */

/**
 * 通用 Chat Completion 调用
 * 自动识别 OpenAI 兼容 / Anthropic 格式
 *
 * @param {Object} opts
 * @param {string} opts.systemPrompt - 系统提示词
 * @param {string} opts.userMessage - 用户消息
 * @param {number} [opts.temperature=0.3]
 * @param {number} [opts.maxTokens=800]
 * @param {number} [opts.timeoutMs] - 超时（默认从配置读取）
 * @param {number} [opts.retries=1] - 重试次数
 * @returns {Promise<string|null>} AI 回复文本，失败返回 null
 */
export async function chatCompletion({
  systemPrompt,
  userMessage,
  temperature = 0.3,
  maxTokens = 800,
  timeoutMs,
  retries = 1,
} = {}) {
  const provider = getCurrentProvider();
  if (!provider.apiUrl || !provider.apiKey) {
    log("[AI] 未配置 API Key，跳过");
    return null;
  }

  const timeout = timeoutMs || provider.timeoutMs || 30_000;
  const isAnthropic = provider.format === "anthropic";

  // Gemini OpenAI 兼容模式需要在 URL 中追加 key 参数
  let apiUrl = provider.apiUrl;
  let authHeaders;
  if (apiUrl.includes("generativelanguage.googleapis.com")) {
    const separator = apiUrl.includes("?") ? "&" : "?";
    apiUrl = `${apiUrl}${separator}key=${provider.apiKey}`;
    authHeaders = { "Content-Type": "application/json" };
  } else if (isAnthropic) {
    authHeaders = {
      "Content-Type": "application/json",
      "x-api-key": provider.apiKey,
      "anthropic-version": "2023-06-01",
    };
  } else {
    authHeaders = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${provider.apiKey}`,
    };
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      log(`[AI] 第 ${attempt + 1} 次重试...`);
      await sleep(2_000 * attempt);
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);

    try {
      let res;
      if (isAnthropic) {
        res = await fetch(apiUrl, {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({
            model: provider.model,
            system: systemPrompt,
            messages: [{ role: "user", content: userMessage }],
            max_tokens: maxTokens,
            temperature,
          }),
          signal: ctrl.signal,
        });
      } else {
        // OpenAI 兼容格式（豆包/DeepSeek/千问/智谱/OpenAI/Gemini/Mistral/Groq/...）
        res = await fetch(apiUrl, {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({
            model: provider.model,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userMessage },
            ],
            temperature,
            max_tokens: maxTokens,
          }),
          signal: ctrl.signal,
        });
      }

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        log(`[AI] 请求失败 HTTP ${res.status}: ${errText.slice(0, 200)}`);
        continue;
      }

      const json = await res.json();

      // 解析响应
      let text;
      if (isAnthropic) {
        text = json.content?.[0]?.text?.trim();
      } else {
        text = json.choices?.[0]?.message?.content?.trim();
      }

      if (text) {
        log(`[AI] 回复成功（${text.length} 字, ${provider.name}/${provider.model}）`);
        return text;
      }

      const reason = isAnthropic
        ? json.stop_reason || "未知"
        : json.choices?.[0]?.finish_reason || "未知";
      log(`[AI] 响应中无有效内容（原因=${reason}，模型=${provider.model}）`);
      if (reason === "content_filter") {
        log("[AI] 内容被安全过滤，跳过重试");
        return null;
      }
      continue;
    } catch (err) {
      if (err.name === "AbortError") log(`[AI] 请求超时（${timeout}ms）`);
      else log(`[AI] 调用异常：${err.message}`);
      continue;
    } finally {
      clearTimeout(timer);
    }
  }
  log(`[AI] 最终失败（已重试 ${retries} 次）`);
  return null;
}

/**
 * Diff 总结专用 — 清洗输入 + 截断 + 调用 chatCompletion
 *
 * @param {string} diffContent - diff 文本
 * @param {string} systemPrompt - 系统提示词（由各模块自定义）
 * @param {string} [moduleContext] - 模块上下文描述
 * @param {Object} [opts] - 额外选项（temperature, maxTokens, retries）
 * @returns {Promise<string|null>}
 */
export async function aiSummarize(diffContent, systemPrompt, moduleContext = "", opts = {}) {
  if (!AI.enabled) return null;

  // 清洗 JS hex 转义 \xNN → 对应字符
  const sanitized = diffContent
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\x[0-9a-fA-F]?/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");

  const maxLen = AI.maxInputLen;
  const truncated = sanitized.length > maxLen
    ? sanitized.slice(0, maxLen) + "\n\n... (diff 内容已截断)"
    : sanitized;

  const userMessage = moduleContext
    ? `以下是「${moduleContext}」的变更 diff，请分析并总结：\n\n${truncated}`
    : `以下是变更 diff，请分析并总结：\n\n${truncated}`;

  return chatCompletion({
    systemPrompt,
    userMessage,
    temperature: opts.temperature ?? 0.3,
    maxTokens: opts.maxTokens ?? 800,
    retries: opts.retries ?? 1,
  });
}

/* ── 工具 ── */
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/* ── 启动日志 ── */
const p = getCurrentProvider();
if (p.name) {
  log(`[AI] 初始模型：${p.name} / ${p.model}（${p.label}）热加载自 ${MODELS_FILE}`);
} else {
  log(`[AI] 警告：未找到有效的 AI 模型配置（无已配置 Key 的提供商），请检查 .env`);
}
