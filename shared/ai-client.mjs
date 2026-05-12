/**
 * 共享 AI 客户端 — 统一的多模型调用层
 *
 * 功能：
 *   1. 从 ai-models.json 加载模型配置（热加载，5s 缓存）
 *   2. 支持 OpenAI 兼容格式 + Anthropic (Claude) 格式
 *   3. ENV:XXX 语法自动从环境变量解析 API Key
 *   4. 提供 chatCompletion / switchProvider / listProviders 等公共 API
 *
 * 用法：
 *   import { AI, aiSummarize, chatCompletion, switchProvider, listProviders } from "../shared/ai-client.mjs";
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
  const name = config.current || Object.keys(config.providers)[0] || "";
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
 * 列出所有可用模型
 * @returns {{ current: string, providers: Array<{name, label, model, format}> }}
 */
export function listProviders() {
  const config = loadModelsConfig();
  const providers = Object.entries(config.providers || {}).map(([name, p]) => ({
    name,
    label: p.label || name,
    model: p.model || "",
    format: p.format || "openai",
    hasKey: !!resolveApiKey(p.apiKey),
  }));
  return { current: config.current || "", providers };
}

/**
 * 切换当前 AI 模型
 * @param {string} providerName - provider 名称
 * @param {string} [modelOverride] - 可选：覆盖 model 名称
 * @returns {{ ok: boolean, message: string }}
 */
export function switchProvider(providerName, modelOverride) {
  const config = loadModelsConfig();
  if (!config.providers[providerName]) {
    const available = Object.keys(config.providers).join(", ");
    return { ok: false, message: `未知模型: ${providerName}\n可用: ${available}` };
  }
  config.current = providerName;
  if (modelOverride) {
    config.providers[providerName].model = modelOverride;
  }
  try {
    writeFileSync(MODELS_FILE, JSON.stringify(config, null, 2), "utf-8");
    // 清除缓存使立即生效
    _configCache = { data: config, ts: Date.now() };
    const p = config.providers[providerName];
    const model = modelOverride || p.model;
    log(`[AI] 模型已切换为: ${providerName} (${model})`);
    return { ok: true, message: `已切换为 ${p.label || providerName} (${model})` };
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
        res = await fetch(provider.apiUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": provider.apiKey,
            "anthropic-version": "2023-06-01",
          },
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
        // OpenAI 兼容格式（豆包/DeepSeek/千问/智谱/OpenAI/...）
        res = await fetch(provider.apiUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${provider.apiKey}`,
          },
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
        ? json.stop_reason || "unknown"
        : json.choices?.[0]?.finish_reason || "unknown";
      log(`[AI] 响应中无有效内容 (reason=${reason}, model=${provider.model})`);
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
  log(`[AI] 警告：未找到有效的 AI 模型配置，请检查 ${MODELS_FILE}`);
}
