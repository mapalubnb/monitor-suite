import { createHash } from "node:crypto";
import { buildVaultFactoryLaunchUrl } from "./vault-links.mjs";
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";

import {
  FLAP_FACTORY_PROXY,
  QUOTE_CONFIG_SELECTOR,
  QUOTE_TOKEN_CREATION_DISABLED_SELECTOR,
} from "./factory-pool-monitor.mjs";
import { SET_QUOTE_CONFIG_SELECTOR, SET_QUOTE_ROUTE_SELECTOR, decodeQuoteConfigurationCall, decodeQuoteRoute, formatQuoteRoute } from "./quote-token-codec.mjs";

import { CORE_SAFES } from "./early-signal-catalog.mjs";
import { abiBytes, abiAddress, hexWords, decodeOperationalCall, describeOperationalAction } from "./operational-call-codec.mjs";

export const SAFE_PROPOSAL_SCHEMA_VERSION = 4;
export const VAULT_PORTAL = "0x90497450f2a706f1951b5bdda52b4e5d16f34c06";
export const REGISTER_VAULT_FACTORY_SELECTOR = "0x4809625b";
export const REGISTER_VAULT_FACTORY_CATEGORY_SELECTOR = "0xefa7595a";
export const SAFE_NONCE_SELECTOR = "0xaffed0e0";
export const SAFE_MULTISEND_SELECTOR = "0x8d80ff0a";
export const SET_QUOTE_TOKEN_CREATION_DISABLED_SELECTOR = "0x8f9047e7";
export const DEFAULT_SAFE_API_BASE_URL = "https://api.safe.global/tx-service/bnb/api/v1";
export const DEFAULT_FLAP_ADMIN_SAFES = CORE_SAFES.map(([address]) => address);

const MAX_PROPOSAL_RECORDS = 500;
const MAX_PENDING_CHANGES = 2000;
const MAX_MULTISEND_DEPTH = 4;
const SAFE_API_STAGGER_MS = 350;
const MULTISEND_ADDRESSES = new Set([
  "0x9641d764fc13c8b624c04430c7356c1c7c8102e2",
  "0x40a2accbd92bca938b02010e17a5b8929b49130d",
]);
const ACTIVE_STATUSES = ["pending", "ready", "confirming"];

function nowIso(nowMs = Date.now()) {
  return new Date(nowMs).toISOString();
}

function hashText(value) {
  return createHash("sha256").update(String(value || "")).digest("hex");
}

export function normalizeAddress(value) {
  const match = String(value || "").trim().toLowerCase().match(/^0x[a-f0-9]{40}$/);
  return match ? match[0] : "";
}

function normalizeHash(value) {
  const match = String(value || "").trim().toLowerCase().match(/^0x[a-f0-9]{64}$/);
  return match ? match[0] : "";
}

function stripHex(value) {
  const hex = String(value || "").replace(/^0x/i, "");
  return /^[a-fA-F0-9]*$/.test(hex) && hex.length % 2 === 0 ? hex.toLowerCase() : "";
}

function decodeUintWord(value) {
  const hex = stripHex(value);
  if (!hex || hex.length < 64) throw new Error("uint256 返回值无效");
  const decoded = BigInt(`0x${hex.slice(0, 64)}`);
  if (decoded > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("uint256 超出安全整数范围");
  return Number(decoded);
}

function addressFromWord(word) {
  const hex = stripHex(word);
  if (hex.length !== 64 || !/^0{24}[a-f0-9]{40}$/.test(hex)) return "";
  return normalizeAddress(`0x${hex.slice(24)}`);
}

function booleanFromWord(word) {
  const hex = stripHex(word);
  if (hex.length !== 64) throw new Error("bool 参数长度无效");
  return BigInt(`0x${hex}`) !== 0n;
}

function decodeDynamicBytesCall(data) {
  const hex = stripHex(data);
  if (hex.length < 8 + 128) throw new Error("MultiSend calldata 长度不足");
  const body = hex.slice(8);
  const offset = decodeUintWord(body.slice(0, 64));
  const lengthOffset = offset * 2;
  if (lengthOffset + 64 > body.length) throw new Error("MultiSend bytes offset 越界");
  const length = decodeUintWord(body.slice(lengthOffset, lengthOffset + 64));
  const dataOffset = lengthOffset + 64;
  if (dataOffset + length * 2 > body.length) throw new Error("MultiSend bytes 长度越界");
  return body.slice(dataOffset, dataOffset + length * 2);
}

export function decodeMultiSendTransactions(data) {
  const payload = decodeDynamicBytesCall(data);
  const transactions = [];
  let cursor = 0;
  while (cursor < payload.length) {
    if (cursor + 2 + 40 + 64 + 64 > payload.length) throw new Error("MultiSend 内层交易头部不完整");
    const operation = Number.parseInt(payload.slice(cursor, cursor + 2), 16);
    cursor += 2;
    const to = normalizeAddress(`0x${payload.slice(cursor, cursor + 40)}`);
    cursor += 40;
    const value = BigInt(`0x${payload.slice(cursor, cursor + 64)}`).toString();
    cursor += 64;
    const dataLength = decodeUintWord(payload.slice(cursor, cursor + 64));
    cursor += 64;
    const dataEnd = cursor + dataLength * 2;
    if (!to || dataEnd > payload.length) throw new Error("MultiSend 内层交易数据不完整");
    transactions.push({ operation, to, value, data: `0x${payload.slice(cursor, dataEnd)}` });
    cursor = dataEnd;
  }
  return transactions;
}

export function extractFlapEnableTargets(transaction, options = {}) {
  return [...new Set(extractFlapProposalActions(transaction, options)
    .filter(action => action.kind === "creation" && !action.disabled).map(action => action.quoteToken))];
}

export function extractFlapProposalActions(transaction, { factoryAddress = FLAP_FACTORY_PROXY, depth = 0, path = "0", includeOperations = false, safeAddresses = DEFAULT_FLAP_ADMIN_SAFES } = {}) {
  const to = normalizeAddress(transaction?.to);
  const data = `0x${stripHex(transaction?.data)}`;
  const selector = data.slice(0, 10);
  const operation = Number(transaction?.operation ?? 0);
  if (!to) return [];
  if (to === VAULT_PORTAL && [REGISTER_VAULT_FACTORY_SELECTOR, REGISTER_VAULT_FACTORY_CATEGORY_SELECTOR].includes(selector)) {
    const base = { to, selector, operation, callPath: path, quoteToken: "" };
    try {
      if (operation !== 0) throw new Error("Vault Portal 非 CALL 操作");
      const hasCategory = selector === REGISTER_VAULT_FACTORY_CATEGORY_SELECTOR;
      const argumentLength = (hasCategory ? 5 : 4) * 64;
      const body = data.slice(10);
      const words = body.slice(0, argumentLength).match(/.{1,64}/g) || [];
      const vaultFactory = addressFromWord(words[0]);
      if (words.length !== (hasCategory ? 5 : 4) || words.some(word => word.length !== 64) || !vaultFactory
        || !/^0{63}[01]$/.test(words[1]) || !/^0{63}[01]$/.test(words[2])
        || words.slice(3).some(word => !/^0{62}[a-f0-9]{2}$/.test(word))) throw new Error("Vault Factory 注册参数无效");
      return [{ ...base, kind: "vaultFactory", vaultFactory, enabled: booleanFromWord(words[1]),
        official: booleanFromWord(words[2]), riskLevel: decodeUintWord(words[3]),
        category: hasCategory ? decodeUintWord(words[4]) : null,
        extraData: body.length > argumentLength ? `0x${body.slice(argumentLength)}` : "" }];
    } catch (error) {
      return [{ ...base, kind: "unknown", reason: error.message }];
    }
  }
  if (to === normalizeAddress(factoryAddress)) {
    const base = { to, selector, operation, callPath: path, rawData: data };
    try {
      if (operation !== 0) throw new Error("Factory 非 CALL 操作，不能按普通管理调用解释");
      if (selector === SET_QUOTE_CONFIG_SELECTOR) return [{ ...base, kind: "configuration", ...decodeQuoteConfigurationCall(data.slice(10)) }];
      if (selector === SET_QUOTE_ROUTE_SELECTOR) return [{ ...base, kind: "route", ...decodeQuoteRoute(data.slice(10)) }];
      if (selector === SET_QUOTE_TOKEN_CREATION_DISABLED_SELECTOR) {
        const body = data.slice(10);
        const quoteToken = addressFromWord(body.slice(0, 64));
        if (body.length !== 128 || !quoteToken || !/^0{63}[01]$/.test(body.slice(64))) throw new Error("创建开关参数无效");
        return [{ ...base, kind: "creation", quoteToken, disabled: booleanFromWord(body.slice(64)) }];
      }
      return [{ ...base, kind: "unknown", quoteToken: "", reason: "未覆盖的 Factory 管理调用" }];
    } catch (error) {
      return [{ ...base, kind: "unknown", quoteToken: "", reason: error.message }];
    }
  }
  if (includeOperations && selector === "0x6a761202" && safeAddresses.some(address => normalizeAddress(address) === to) && operation === 0) {
    if (depth >= MAX_MULTISEND_DEPTH) throw new Error("Safe 嵌套超过解析上限");
    const w = hexWords(data.slice(10));
    return extractFlapProposalActions({ to: abiAddress(w[0]), value: BigInt("0x" + w[1]).toString(),
      data: abiBytes(data.slice(10), 2), operation: Number(BigInt("0x" + w[3])) },
    { factoryAddress, depth: depth + 1, path: path + ".safe", includeOperations, safeAddresses });
  }
  if (selector !== SAFE_MULTISEND_SELECTOR || operation !== 1 || !MULTISEND_ADDRESSES.has(to)) {
    return includeOperations ? [decodeOperationalCall(transaction, path)] : [];
  }
  if (depth >= MAX_MULTISEND_DEPTH) throw new Error("MultiSend 嵌套超过解析上限");
  return decodeMultiSendTransactions(data).flatMap((nested, index) => extractFlapProposalActions(nested, {
    factoryAddress, depth: depth + 1, path: `${path}.${index}`, includeOperations, safeAddresses,
  }));
}

function createSafeStatus(address) {
  return {
    address,
    baselineEstablished: false,
    currentNonce: null,
    lastNonceAt: "",
    lastPollAt: "",
    lastSuccessAt: "",
    lastError: "",
    consecutiveFailures: 0,
    nextAttemptAtMs: 0,
  };
}

function normalizeSafeEntries(safes) {
  const entries = [];
  const seen = new Set();
  for (const rawSafe of safes) {
    const address = normalizeAddress(rawSafe);
    if (!address || seen.has(address)) continue;
    seen.add(address);
    entries.push({ address, apiAddress: DEFAULT_FLAP_ADMIN_SAFES.find(safe => normalizeAddress(safe) === address) || String(rawSafe).trim() });
  }
  return entries;
}

export function createSafeProposalState(safes = DEFAULT_FLAP_ADMIN_SAFES) {
  const normalizedSafes = normalizeSafeEntries(safes).map(entry => entry.address);
  return {
    schemaVersion: SAFE_PROPOSAL_SCHEMA_VERSION,
    safes: Object.fromEntries(normalizedSafes.map(address => [address, createSafeStatus(address)])),
    proposals: {},
    pendingChanges: [],
    executionCursor: 0,
    lastRunAt: "",
    lastSuccessAt: "",
    lastError: "",
  };
}

export function migrateSafeProposalState(raw, safes = DEFAULT_FLAP_ADMIN_SAFES) {
  const base = createSafeProposalState(safes);
  const state = raw && typeof raw === "object" ? { ...base, ...raw } : base;
  state.schemaVersion = SAFE_PROPOSAL_SCHEMA_VERSION;
  state.safes = state.safes && typeof state.safes === "object" ? state.safes : {};
  for (const address of Object.keys(base.safes)) {
    state.safes[address] = { ...createSafeStatus(address), ...(state.safes[address] || {}), address };
  }
  state.proposals = state.proposals && typeof state.proposals === "object" ? state.proposals : {};
  for (const record of Object.values(state.proposals)) {
    if (!Array.isArray(record.actions)) record.actions = record.quoteToken
      ? [{ kind: "creation", quoteToken: record.quoteToken, disabled: false, legacy: true }] : [];
  }
  state.pendingChanges = Array.isArray(state.pendingChanges) ? state.pendingChanges : [];
  for (const change of state.pendingChanges) {
    if (!Array.isArray(change.actions)) change.actions = state.proposals[change.key]?.actions || [];
  }
  return state;
}

export function loadSafeProposalState(path, safes = DEFAULT_FLAP_ADMIN_SAFES) {
  if (!existsSync(path)) return createSafeProposalState(safes);
  if (statSync(path).size > 16 * 1024 * 1024) throw new Error("Safe 提案状态文件超过 16MB");
  try {
    return migrateSafeProposalState(JSON.parse(readFileSync(path, "utf8")), safes);
  } catch (error) {
    throw new Error(`Safe 提案状态文件解析失败：${error.message}`);
  }
}

export function saveSafeProposalState(path, state) {
  state.schemaVersion = SAFE_PROPOSAL_SCHEMA_VERSION;
  const temporaryPath = `${path}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(state, null, 2), "utf8");
  renameSync(temporaryPath, path);
}

function safeProposalKey(safeTxHash, quoteToken) {
  return `${normalizeHash(safeTxHash)}:${normalizeAddress(quoteToken)}`;
}

function changeId(type, record) {
  return hashText([type, record.safeTxHash, record.vaultFactory ? `vault:${record.vaultFactory}` : record.quoteToken,
    record.confirmations, record.required, Boolean(record.nonceBlocked), record.executionCheck?.status || ""].join(":"));
}

function appendPendingChange(state, type, record, detectedAt) {
  const change = { ...record, type, detectedAt };
  change.id = changeId(type, change);
  if (!state.pendingChanges.some(item => item.id === change.id)) state.pendingChanges.push(change);
  return change;
}

export function acknowledgeSafeProposalChanges(state, ids = []) {
  const acknowledged = new Set(ids);
  state.pendingChanges = (state.pendingChanges || []).filter(change => !acknowledged.has(change.id));
}

function confirmationCount(proposal) {
  return new Set((proposal?.confirmations || []).map(item => normalizeAddress(item?.owner)).filter(Boolean)).size;
}

// Read-only simulation. Contract signatures and approved-hash signatures need a different
// signer context; leave them unverified rather than constructing a misleading transaction.
export function encodeSafeExecutionSimulation(proposal) {
  const confirmations = [...(proposal.confirmations || [])].sort((a, b) => normalizeAddress(a.owner).localeCompare(normalizeAddress(b.owner)));
  if (!confirmations.length || confirmations.some(c => !/^0x[a-f0-9]{130}$/i.test(c.signature || "")
    || ![27, 28, 31, 32].includes(parseInt(c.signature.slice(-2), 16)))) return null;
  const word = value => {
    const n = BigInt(value || 0);
    if (n < 0n || n >= 1n << 256n) throw new Error("Safe 参数越界");
    return n.toString(16).padStart(64, "0");
  };
  const address = value => {
    const a = normalizeAddress(value || "0x" + "0".repeat(40));
    if (!a) throw new Error("Safe 模拟地址无效");
    return a.slice(2).padStart(64, "0");
  };
  const bytes = value => {
    const h = stripHex(value);
    return word(h.length / 2) + h.padEnd(Math.ceil(h.length / 64) * 64, "0");
  };
  const data = bytes(proposal.data);
  const signatures = bytes("0x" + confirmations.map(c => c.signature.slice(2)).join(""));
  return "0x6a761202" + [address(proposal.to), word(proposal.value), word(320), word(proposal.operation),
    word(proposal.safeTxGas), word(proposal.baseGas), word(proposal.gasPrice), address(proposal.gasToken),
    address(proposal.refundReceiver), word(320 + data.length / 2)].join("") + data + signatures;
}

function normalizeProposal(proposal, safe, quoteToken, nowText) {
  const confirmations = confirmationCount(proposal);
  const threshold = Number(proposal?.confirmationsRequired);
  const required = Number.isInteger(threshold) && threshold > 0 ? threshold : 0;
  return {
    key: safeProposalKey(proposal?.safeTxHash, quoteToken),
    safeTxHash: normalizeHash(proposal?.safeTxHash),
    safe,
    nonce: Number(proposal?.nonce),
    quoteToken,
    proposer: normalizeAddress(proposal?.proposer),
    submissionDate: proposal?.submissionDate || "",
    confirmations,
    required,
    actions: [],
    status: required > 0 && confirmations >= required ? "ready" : "pending",
    firstSeenAt: nowText,
    lastSeenAt: nowText,
    invalidatedAt: "",
  };
}

function buildSafeApiUrl(apiBaseUrl, safe, nonce) {
  const base = String(apiBaseUrl || DEFAULT_SAFE_API_BASE_URL).replace(/\/+$/, "");
  const query = new URLSearchParams({
    executed: "false",
    trusted: "true",
    nonce__gte: String(nonce),
    limit: "100",
  });
  return `${base}/safes/${safe}/multisig-transactions/?${query}`;
}

function retryAfterMilliseconds(response) {
  const raw = response?.headers?.get?.("retry-after");
  if (!raw) return 0;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}

export async function fetchSafeProposals({
  safe,
  nonce,
  apiBaseUrl = DEFAULT_SAFE_API_BASE_URL,
  apiKey = "",
  timeoutMs = 5_000,
  fetchFn = globalThis.fetch,
} = {}) {
  const results = [];
  const firstUrl = buildSafeApiUrl(apiBaseUrl, safe, nonce);
  let url = firstUrl;
  const visited = new Set();
  while (url) {
    if (visited.has(url) || visited.size >= 10) throw new Error("Safe API 分页超过上限或循环");
    const parsed = new URL(url, firstUrl);
    if (parsed.origin !== new URL(firstUrl).origin || parsed.pathname !== new URL(firstUrl).pathname) throw new Error("Safe API 分页地址无效");
    for (const [key, value] of new URL(firstUrl).searchParams) parsed.searchParams.set(key, value);
    visited.add(url);
    if (visited.size > 1) await new Promise(resolve => setTimeout(resolve, SAFE_API_STAGGER_MS));
    const json = await fetchSafeJson(parsed.href, { apiKey, timeoutMs, fetchFn });
    if (!Array.isArray(json?.results)) throw new Error("Safe API results 格式无效");
    results.push(...json.results);
    url = json.next || "";
  }
  return results;
}

async function fetchSafeJson(url, { apiKey, timeoutMs, fetchFn }) {
  await fetchFn.waitForTurn?.();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(url, {
      headers: {
        Accept: "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      signal: controller.signal,
    });
    if (!response?.ok) {
      const status = response?.status || "unknown";
      const suffix = status === 422 ? "（Safe 地址必须使用 EIP-55 校验和格式）" : "";
      const quotaExhausted = response?.headers?.get?.('x-ratelimit-remaining') === '0';
      const error = new Error(`Safe API HTTP ${status}${suffix}${quotaExhausted ? '（账户月度额度已耗尽）' : ''}`);
      error.retryAfterMs = retryAfterMilliseconds(response);
      throw error;
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

export function createSafeRateLimitedFetch(state, fetchFn, { intervalMs = 5000, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const guarded = async (...args) => {
    const response = await fetchFn(...args);
    const headerNumber = key => {
      const raw = response.headers?.get?.(key);
      return raw !== null && raw !== undefined && Number.isFinite(Number(raw)) ? Number(raw) : null;
    };
    const remaining = headerNumber('x-ratelimit-remaining'), resetSeconds = headerNumber('x-ratelimit-reset');
    if (remaining !== null && resetSeconds !== null) {
      state.apiQuota = {limit: headerNumber('x-ratelimit-limit'), remaining, resetsAt: now() + resetSeconds * 1000};
      if (remaining > 0) state.apiRequestNextAt = Math.max(state.apiRequestNextAt || 0,
        now() + Math.ceil(resetSeconds * 1000 / remaining));
    }
    if (response.status === 429) {
      state.apiRateLimitFailures = (state.apiRateLimitFailures || 0) + 1;
      const delay = Math.max(retryAfterMilliseconds(response), Math.min(300_000, 60_000 * 2 ** Math.min(3, state.apiRateLimitFailures - 1)));
      state.apiNextAttemptAtMs = Math.max(now() + delay, remaining === 0 && resetSeconds > 0 ? now() + resetSeconds * 1000 : 0);
    } else if (response.ok) {
      state.apiRateLimitFailures = 0;
      state.apiNextAttemptAtMs = 0;
    }
    return response;
  };
  guarded.waitForTurn = async () => {
    const check = () => {
      if (state.apiNextAttemptAtMs > now()) {
        const error = new Error('Safe API 共享冷却中');
        error.retryAfterMs = state.apiNextAttemptAtMs - now();
        throw error;
      }
    };
    check();
    const slot = Math.max(now(), state.apiRequestNextAt || 0);
    if (slot - now() > intervalMs) {
      const error = new Error('Safe API 额度预算等待');
      error.retryAfterMs = slot - now();
      throw error;
    }
    state.apiRequestNextAt = slot + intervalMs;
    if (slot > now()) await sleep(slot - now());
    check();
  };
  return guarded;
}

function safeNonceCalls(safes) {
  return safes.map(safe => ({
    method: "eth_call",
    params: [{ to: safe, data: SAFE_NONCE_SELECTOR }, "latest"],
  }));
}

function factoryStatusCalls(records, factoryAddress) {
  return records.flatMap(record => [
    {
      method: "eth_call",
      params: [{
        to: factoryAddress,
        data: `${QUOTE_CONFIG_SELECTOR}${record.quoteToken.slice(2).padStart(64, "0")}`,
      }, "latest"],
    },
    {
      method: "eth_call",
      params: [{
        to: factoryAddress,
        data: `${QUOTE_TOKEN_CREATION_DISABLED_SELECTOR}${record.quoteToken.slice(2).padStart(64, "0")}`,
      }, "latest"],
    },
  ]);
}

function pruneProposalRecords(state) {
  const entries = Object.entries(state.proposals || {});
  if (entries.length <= MAX_PROPOSAL_RECORDS) return;
  const protectedKeys = new Set((state.pendingChanges || []).map(change => change.key));
  const sorted = entries.sort((left, right) => {
    const leftActive = ACTIVE_STATUSES.includes(left[1]?.status) || protectedKeys.has(left[0]);
    const rightActive = ACTIVE_STATUSES.includes(right[1]?.status) || protectedKeys.has(right[0]);
    if (leftActive !== rightActive) return leftActive ? -1 : 1;
    return Date.parse(right[1]?.lastSeenAt || right[1]?.invalidatedAt || "")
      - Date.parse(left[1]?.lastSeenAt || left[1]?.invalidatedAt || "");
  });
  state.proposals = Object.fromEntries(sorted.slice(0, MAX_PROPOSAL_RECORDS));
}

export async function runSafeProposalScan({
  state,
  safes = DEFAULT_FLAP_ADMIN_SAFES,
  factoryAddress = FLAP_FACTORY_PROXY,
  rpcBatch,
  fetchFn = globalThis.fetch,
  apiBaseUrl = DEFAULT_SAFE_API_BASE_URL,
  apiKey = "",
  timeoutMs = 5_000,
  baseBackoffMs = 5_000,
  maxBackoffMs = 300_000,
  suppressNotifications = false,
  includeOperations = true,
  maxSafesPerRun = Infinity,
  requestIntervalMs = 0,
  nowMs = Date.now(),
} = {}) {
  if (!state || typeof state !== "object") throw new Error("缺少 Safe 提案状态");
  if (typeof rpcBatch !== "function") throw new Error("缺少 Safe 提案 RPC 批量读取函数");
  if (state.pendingChanges?.length >= MAX_PENDING_CHANGES) {
    state.lastError = "Safe 通知积压达到上限，等待投递后恢复扫描";
    return { changed: false, changes: [], state, successfulSafes: 0, configuredSafes: safes.length, errors: [state.lastError] };
  }
  const safeEntries = normalizeSafeEntries(safes);
  const normalizedSafes = safeEntries.map(entry => entry.address);
  const apiAddressBySafe = new Map(safeEntries.map(entry => [entry.address, entry.apiAddress]));
  const factory = normalizeAddress(factoryAddress);
  if (normalizedSafes.length === 0) throw new Error("未配置有效的 Flap 管理 Safe");
  if (!factory) throw new Error("Flap Factory 地址无效");

  const migrated = migrateSafeProposalState(state, normalizedSafes);
  Object.assign(state, migrated);
  const credentialId = hashText(`${apiBaseUrl}|${apiKey}`);
  if (state.apiCredentialId && state.apiCredentialId !== credentialId) {
    state.apiNextAttemptAtMs = 0;
    state.apiRequestNextAt = 0;
    state.apiRateLimitFailures = 0;
    delete state.apiQuota;
    for (const health of Object.values(state.safes)) { health.nextAttemptAtMs = 0; health.consecutiveFailures = 0; }
  }
  state.apiCredentialId = credentialId;
  if (requestIntervalMs > 0) fetchFn = createSafeRateLimitedFetch(state, fetchFn, {intervalMs: requestIntervalMs});
  const runAt = nowIso(nowMs);
  const nonceResults = await rpcBatch(safeNonceCalls(normalizedSafes));
  const currentNonces = new Map(normalizedSafes.map((safe, index) => {
    try { return [safe, decodeUintWord(nonceResults[index])]; } catch { return [safe, null]; }
  }));
  const changes = [];
  const errors = [];
  let successfulSafes = 0;
  const start = (state.pollCursor || 0) % normalizedSafes.length;
  const eligible = [...normalizedSafes.slice(start), ...normalizedSafes.slice(0, start)]
    .filter(safe => !(state.safes[safe]?.nextAttemptAtMs > nowMs));
  const selected = new Set(state.apiNextAttemptAtMs > nowMs || state.apiRequestNextAt > nowMs ? [] : eligible.slice(0, maxSafesPerRun));
  const lastSelected = [...selected].at(-1);
  if (lastSelected) state.pollCursor = (normalizedSafes.indexOf(lastSelected) + 1) % normalizedSafes.length;

  const settled = await Promise.allSettled(normalizedSafes.map(async (safe, index) => {
    const safeState = state.safes[safe] || createSafeStatus(safe);
    state.safes[safe] = safeState;
    const currentNonce = currentNonces.get(safe);
    if (currentNonce === null) throw new Error("Safe nonce 读取失败，保留该 Safe 的上次快照");
    safeState.currentNonce = currentNonce;
    safeState.lastNonceAt = runAt;
    if (!selected.has(safe) || state.apiNextAttemptAtMs > nowMs || state.apiRequestNextAt > nowMs) return { safe, skipped: true, currentNonce };
    if (Number(safeState.nextAttemptAtMs) > nowMs) return { safe, skipped: true, currentNonce };
    // 错开同一轮多个 Safe 请求，降低出口 IP 触发 Safe API 限流的概率。
    if (index > 0) await new Promise(resolve => setTimeout(resolve, index * SAFE_API_STAGGER_MS));
    const proposals = await fetchSafeProposals({
      safe: apiAddressBySafe.get(safe),
      nonce: currentNonce,
      apiBaseUrl,
      apiKey,
      timeoutMs,
      fetchFn,
    });
    return { safe, currentNonce, proposals, baselineWasEstablished: safeState.baselineEstablished === true };
  }));

  for (let index = 0; index < settled.length; index++) {
    const safe = normalizedSafes[index];
    const safeState = state.safes[safe];
    const outcome = settled[index];
    if (outcome.status === 'rejected' || !outcome.value.skipped) safeState.lastPollAt = runAt;
    if (outcome.status === "rejected") {
      safeState.consecutiveFailures = (Number(safeState.consecutiveFailures) || 0) + 1;
      const retryAfterMs = Number(outcome.reason?.retryAfterMs) || 0;
      const backoffMs = Math.max(retryAfterMs, Math.min(maxBackoffMs,
        baseBackoffMs * (2 ** Math.min(9, safeState.consecutiveFailures - 1))));
      safeState.nextAttemptAtMs = nowMs + backoffMs;
      safeState.lastError = outcome.reason?.message || "Safe API 请求失败";
      errors.push(`${safe}: ${safeState.lastError}`);
      continue;
    }
    if (outcome.value.skipped) continue;

    successfulSafes++;
    safeState.baselineEstablished = true;
    safeState.lastSuccessAt = runAt;
    safeState.lastError = "";
    safeState.consecutiveFailures = 0;
    safeState.nextAttemptAtMs = 0;
    const suppressForSafe = suppressNotifications;

    for (const proposal of outcome.value.proposals) {
      const safeTxHash = normalizeHash(proposal?.safeTxHash);
      const proposalNonce = Number(proposal?.nonce);
      if (!safeTxHash || !Number.isInteger(proposalNonce) || proposalNonce < outcome.value.currentNonce || proposal.isExecuted
        || normalizeAddress(proposal.safe) !== safe) continue;
      let actions = [];
      try {
        actions = extractFlapProposalActions(proposal, { factoryAddress: factory, includeOperations, safeAddresses: safes });
      } catch (error) {
        errors.push(`${safe}: SafeTx ${safeTxHash} 解析失败：${error.message}`);
        actions = [{ kind: "unknown", quoteToken: "", to: normalizeAddress(proposal.to), selector: String(proposal.data || "0x").slice(0, 10),
          rawData: proposal.data, reason: error.message, callPath: "0" }];
      }
      const actionTarget = action => action.vaultFactory ? `vault:${action.vaultFactory}` : action.quoteToken || "";
      let executionCheck = null;
      for (const target of new Set(actions.map(actionTarget))) {
        const vaultFactory = target.startsWith("vault:") ? target.slice(6) : "";
        const quoteToken = vaultFactory ? "" : target;
        const next = normalizeProposal(proposal, safe, quoteToken, runAt);
        if (vaultFactory) {
          next.vaultFactory = vaultFactory;
          next.key = `${safeTxHash}:vault:${vaultFactory}`;
        }
        next.currentNonce = outcome.value.currentNonce;
        next.nonceBlocked = next.nonce > next.currentNonce;
        next.executionCheck = { status: next.nonceBlocked ? "blocked" : "unverified", checkedAt: runAt };
        if (executionCheck) next.executionCheck = { ...executionCheck };
        else if (next.status === "ready" && !next.nonceBlocked) {
          try {
            const data = actions.some(action => action.callPath?.includes(".safe")) ? null : encodeSafeExecutionSimulation(proposal);
            if (data) {
              const [result] = await rpcBatch([{ method: "eth_call", params: [{ to: safe, data }, "latest"] }]);
              next.executionCheck.status = /^0x0{63}1$/i.test(result || "") ? "passed" : "unverified";
            }
          } catch { /* A failed RPC/simulation is not evidence that the proposal was cancelled. */ }
        }
        executionCheck = { ...next.executionCheck };
        next.actions = actions.filter(action => actionTarget(action) === target);
        const previous = state.proposals[next.key];
        if (previous) next.firstSeenAt = previous.firstSeenAt || next.firstSeenAt;
        state.proposals[next.key] = next;
        if (suppressForSafe) continue;
        if (!previous) {
          changes.push(appendPendingChange(state, !outcome.value.baselineWasEstablished ? "existing" : next.status === "ready" ? "ready" : "proposed", next, runAt));
        } else if (next.required > 0 && (previous.status !== "ready" || Boolean(previous.nonceBlocked) !== next.nonceBlocked
          || previous.executionCheck?.status !== "passed" && next.executionCheck.status === "passed") && next.confirmations >= next.required) {
          changes.push(appendPendingChange(state, "ready", next, runAt));
        } else if (previous.confirmations !== next.confirmations || previous.required !== next.required) {
          changes.push(appendPendingChange(state, "signatures", next, runAt));
        }
      }
    }
  }

  const staleRecords = Object.values(state.proposals || {}).filter(record =>
    ACTIVE_STATUSES.includes(record?.status)
    && Number.isInteger(currentNonces.get(record.safe))
    && record.nonce < currentNonces.get(record.safe));
  const allStaleHashes = [...new Set(staleRecords.map(record => record.safeTxHash))];
  const cursor = Math.max(0, Number(state.executionCursor) || 0) % Math.max(1, allStaleHashes.length);
  const staleHashes = [...allStaleHashes.slice(cursor), ...allStaleHashes.slice(0, cursor)].slice(0, Number.isFinite(maxSafesPerRun) ? 1 : 10);
  state.executionCursor = (cursor + staleHashes.length) % Math.max(1, allStaleHashes.length);
  for (const safeTxHash of staleHashes) {
    const records = staleRecords.filter(record => record.safeTxHash === safeTxHash);
    const first = records[0];
    const health = state.safes[first.safe];
    for (const record of records) record.status = "confirming";
    state.pendingChanges = state.pendingChanges.filter(change => !records.some(record => record.key === change.key));
    if (Number(health.nextAttemptAtMs) > nowMs) continue;
    try {
      await new Promise(resolve => setTimeout(resolve, SAFE_API_STAGGER_MS));
      const options = { apiKey, timeoutMs, fetchFn };
      const base = String(apiBaseUrl).replace(/\/+$/, "");
      let detail = await fetchSafeJson(base + "/multisig-transactions/" + safeTxHash + "/", options);
      if (normalizeHash(detail?.safeTxHash) !== safeTxHash || normalizeAddress(detail?.safe) !== first.safe
        || Number(detail?.nonce) !== first.nonce) throw new Error("Safe 提案详情与请求不匹配");
      if (!detail.isExecuted) {
        // A consumed nonce alone cannot distinguish replacement from indexer lag.
        const query = new URLSearchParams({ executed: "true", nonce: String(first.nonce), limit: "100" });
        await new Promise(resolve => setTimeout(resolve, SAFE_API_STAGGER_MS));
        const history = await fetchSafeJson(base + "/safes/" + apiAddressBySafe.get(first.safe) + "/multisig-transactions/?" + query, options);
        const winner = history.results?.find(item => item.isExecuted && Number(item.nonce) === first.nonce
          && normalizeAddress(item.safe) === first.safe && normalizeHash(item.transactionHash));
        if (!winner) continue;
        detail = winner;
      }
      const winnerHash = normalizeHash(detail.safeTxHash);
      const transactionHash = normalizeHash(detail.transactionHash);
      if (!winnerHash || !transactionHash || (detail.isSuccessful !== true && detail.isSuccessful !== false)) continue;
      health.executionFailures = 0;
      const status = winnerHash !== safeTxHash ? "invalidated" : detail.isSuccessful ? "executed" : "failed";
      for (const record of records) {
        record.status = status;
        record.transactionHash = transactionHash;
        record.resolvedBySafeTxHash = winnerHash;
        record.lastSeenAt = runAt;
        record.invalidatedAt = status === "invalidated" ? runAt : "";
        record.chainVerification = "未复核";
        if (status === "executed" && record.quoteToken) {
          try {
            const values = await rpcBatch(factoryStatusCalls([record], factory), { requireAllResults: true });
            record.currentConfiguration = values[0];
            record.currentCreationDisabled = decodeUintWord(values[1]) !== 0;
            const config = record.actions?.filter(action => action.kind === "configuration").at(-1)?.config;
            const creation = record.actions?.filter(action => action.kind === "creation").at(-1);
            const expected = config && Object.values(config).map(value => BigInt(value).toString(16).padStart(64, "0")).join("");
            const matches = (!config || String(values[0]).slice(2).toLowerCase() === expected)
              && (!creation || record.currentCreationDisabled === creation.disabled);
            record.chainVerification = matches ? "配置 getter 已复核（路径以交易事件为准）" : "当前配置与提案不同，可能已有后续变更";
          } catch (error) { record.chainVerification = "执行已确认，当前配置复核失败：" + error.message; }
        }
        // Do not deliver a stale 'waiting for signatures' alert after resolution.
        state.pendingChanges = state.pendingChanges.filter(change => change.key !== record.key);
        if (!suppressNotifications) changes.push(appendPendingChange(state, status, record, runAt));
      }
    } catch (error) {
      health.executionFailures = (Number(health.executionFailures) || 0) + 1;
      health.nextAttemptAtMs = nowMs + Math.min(maxBackoffMs, Math.max(Number(error.retryAfterMs) || 0,
        baseBackoffMs * 2 ** Math.min(6, health.executionFailures - 1)));
      health.lastError = "执行结果待确认：" + error.message;
      errors.push(health.lastError);
    }
  }

  state.lastRunAt = runAt;
  if (successfulSafes > 0) state.lastSuccessAt = runAt;
  const safeErrors = normalizedSafes
    .map(safe => state.safes[safe]?.lastError ? `${safe}: ${state.safes[safe].lastError}` : "")
    .filter(Boolean);
  state.lastError = [...new Set([...errors, ...safeErrors])].join("；");
  pruneProposalRecords(state);
  return {
    changed: changes.length > 0,
    changes,
    state,
    successfulSafes,
    configuredSafes: normalizedSafes.length,
    errors,
  };
}

function formatDate(value) {
  const timestamp = Date.parse(value || "");
  if (!Number.isFinite(timestamp)) return "未知";
  return new Date(timestamp).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" });
}

export function buildSafeProposalContent(changes = [], factoryAssets = {}) {
  const lines = [];
  for (const change of changes) {
    const asset = factoryAssets?.[change.quoteToken] || {};
    const name = change.vaultFactory ? "Vault Factory 注册／配置更新" : asset.symbol || asset.name || (change.quoteToken ? "计价代币" : "资金／权限／管理操作");
    const status = ({ ready: "签名已满足，等待执行", existing: "当前待执行提案", proposed: "发现管理提案", signatures: "签名进度更新",
      invalidated: "已被同 nonce 交易替换", failed: "Safe 内层执行失败", executed: "Safe 执行成功" })[change.type] || "等待执行确认";
    const color = ["failed", "invalidated"].includes(change.type) ? "red" : change.type === "executed" ? "green" : "orange";
    const icon = color === "red" ? "🔴" : color === "green" ? "🟢" : "🟠";
    const escapedName = String(name).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    lines.push(`**${escapedName}**`, `<font color='${color}'>${icon} ${status}</font>`);
    if (change.quoteToken) lines.push("计价代币：[" + change.quoteToken + "](https://bscscan.com/address/" + change.quoteToken + ")");
    if (change.vaultFactory) lines.push("Vault Factory：[" + change.vaultFactory + "](https://bscscan.com/address/" + change.vaultFactory + ")");
    const launchUrl = buildVaultFactoryLaunchUrl(change.vaultFactory);
    if (launchUrl) lines.push(`🏦 金库链接：[打开金库](${launchUrl})`);
    for (const action of change.actions || []) {
      if (action.kind === "vaultFactory") {
        const risks = ["未验证", "低风险", "中低风险", "中风险", "高风险"];
        const categories = ["无分类", "AI Oracle 驱动"];
        lines.push("提案参数：" + (action.enabled ? "启用" : "停用") + "｜官方标识：" + (action.official ? "是" : "否"));
        lines.push("拟设风险等级：" + (risks[action.riskLevel] || "未知等级") + "（" + action.riskLevel + "）");
        lines.push("拟设分类：" + (action.category === null ? "未提供（四参数版本）" : (categories[action.category] || "未知分类") + "（" + action.category + "）"));
        lines.push("调用合约：[Vault Portal](https://bscscan.com/address/" + action.to + ")");
        if (action.extraData) lines.push("附加调用数据：" + (action.extraData.length - 2) / 2 + " 字节（已保留，未解释）");
      } else if (action.kind === "configuration") {
        const c = action.config;
        lines.push("拟设置配置：enabled=" + c.enabled + "｜默认曲线 " + c.defaultCurve + "｜备用曲线 " + c.alternativeCurve
          + "｜兑换类型 " + c.nativeToQuoteSwapType + "｜DEX ID " + c.dexId);
      } else if (action.kind === "route") lines.push(...formatQuoteRoute(action.hops));
      else if (action.kind === "creation") lines.push("创建开关：" + (action.disabled ? "暂停创建" : "解除暂停创建"));
      else lines.push(describeOperationalAction(action));
    }
    if (change.nonceBlocked) lines.push("⏳ 前序 nonce 未执行");
    if (change.executionCheck?.status === "passed") lines.push("✅ 只读执行模拟通过｜" + formatDate(change.executionCheck.checkedAt));
    else if (change.status === "ready") lines.push("⏳ 执行条件未核实");
    lines.push("首次观测：" + formatDate(change.firstSeenAt));
    lines.push("确认进度：" + change.confirmations + "/" + (change.required || "未知") + "｜Safe nonce：" + change.nonce);
    lines.push("管理 Safe：[" + change.safe + "](https://app.safe.global/transactions/queue?safe=bnb:" + change.safe + ")");
    lines.push("SafeTxHash：" + change.safeTxHash);
    lines.push("提案时间：" + formatDate(change.submissionDate));
    if (change.transactionHash) lines.push("执行交易：[" + change.transactionHash + "](https://bscscan.com/tx/" + change.transactionHash + ")");
    if (change.chainVerification) lines.push(change.chainVerification);
    lines.push("");
  }
  return lines.join("\n");
}
