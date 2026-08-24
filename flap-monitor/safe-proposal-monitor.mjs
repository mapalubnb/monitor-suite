import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";

import {
  FLAP_FACTORY_PROXY,
  QUOTE_CONFIG_SELECTOR,
  QUOTE_TOKEN_CREATION_DISABLED_SELECTOR,
} from "./factory-pool-monitor.mjs";

export const SAFE_PROPOSAL_SCHEMA_VERSION = 1;
export const SAFE_NONCE_SELECTOR = "0xaffed0e0";
export const SAFE_MULTISEND_SELECTOR = "0x8d80ff0a";
export const SET_QUOTE_TOKEN_CREATION_DISABLED_SELECTOR = "0x8f9047e7";
export const DEFAULT_SAFE_API_BASE_URL = "https://safe-transaction-bsc.safe.global/api/v1";
export const DEFAULT_FLAP_ADMIN_SAFES = [
  "0xc68f29BfE2f6c3D95AdB5685592B9F86680968f2",
  "0xA04Aa4575bA2327D28869cdD5F0E9165a8EC2CF5",
];

const MAX_PROPOSAL_RECORDS = 500;
const MAX_PENDING_CHANGES = 200;
const MAX_MULTISEND_DEPTH = 4;

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

export function extractFlapEnableTargets(transaction, {
  factoryAddress = FLAP_FACTORY_PROXY,
  depth = 0,
} = {}) {
  const to = normalizeAddress(transaction?.to);
  const data = `0x${stripHex(transaction?.data)}`;
  const selector = data.slice(0, 10).toLowerCase();
  const factory = normalizeAddress(factoryAddress);
  if (!to || data === "0x" || !factory) return [];

  if (to === factory && selector === SET_QUOTE_TOKEN_CREATION_DISABLED_SELECTOR) {
    const body = data.slice(10);
    if (body.length < 128) return [];
    const quoteToken = addressFromWord(body.slice(0, 64));
    const disabled = booleanFromWord(body.slice(64, 128));
    return quoteToken && disabled === false ? [quoteToken] : [];
  }

  if (selector !== SAFE_MULTISEND_SELECTOR || Number(transaction?.operation) !== 1 || depth >= MAX_MULTISEND_DEPTH) return [];
  const targets = new Set();
  for (const nested of decodeMultiSendTransactions(data)) {
    for (const quoteToken of extractFlapEnableTargets(nested, { factoryAddress: factory, depth: depth + 1 })) {
      targets.add(quoteToken);
    }
  }
  return [...targets];
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
    entries.push({ address, apiAddress: String(rawSafe).trim() });
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
  state.pendingChanges = Array.isArray(state.pendingChanges) ? state.pendingChanges.slice(-MAX_PENDING_CHANGES) : [];
  return state;
}

export function loadSafeProposalState(path, safes = DEFAULT_FLAP_ADMIN_SAFES) {
  if (!existsSync(path)) return createSafeProposalState(safes);
  if (statSync(path).size > 4 * 1024 * 1024) throw new Error("Safe 提案状态文件超过 4MB");
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
  return hashText([type, record.safeTxHash, record.quoteToken, record.confirmations, record.required].join(":"));
}

function appendPendingChange(state, type, record, detectedAt) {
  const change = { ...record, type, detectedAt };
  change.id = changeId(type, change);
  if (!state.pendingChanges.some(item => item.id === change.id)) state.pendingChanges.push(change);
  state.pendingChanges = state.pendingChanges.slice(-MAX_PENDING_CHANGES);
  return change;
}

export function acknowledgeSafeProposalChanges(state, ids = []) {
  const acknowledged = new Set(ids);
  state.pendingChanges = (state.pendingChanges || []).filter(change => !acknowledged.has(change.id));
}

function confirmationCount(proposal) {
  return new Set((proposal?.confirmations || []).map(item => normalizeAddress(item?.owner)).filter(Boolean)).size;
}

function normalizeProposal(proposal, safe, quoteToken, nowText) {
  const confirmations = confirmationCount(proposal);
  const required = Math.max(1, Number(proposal?.confirmationsRequired) || 1);
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
    status: confirmations >= required ? "ready" : "pending",
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
  timeoutMs = 5_000,
  fetchFn = globalThis.fetch,
} = {}) {
  if (typeof fetchFn !== "function") throw new Error("Safe API fetch 不可用");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(buildSafeApiUrl(apiBaseUrl, safe, nonce), {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response?.ok) {
      const status = response?.status || "unknown";
      const suffix = status === 422 ? "（Safe 地址必须使用 EIP-55 校验和格式）" : "";
      const error = new Error(`Safe API HTTP ${status}${suffix}`);
      error.retryAfterMs = retryAfterMilliseconds(response);
      throw error;
    }
    const json = await response.json();
    if (!Array.isArray(json?.results)) throw new Error("Safe API results 格式无效");
    return json.results;
  } finally {
    clearTimeout(timer);
  }
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
    const leftActive = ["pending", "ready"].includes(left[1]?.status) || protectedKeys.has(left[0]);
    const rightActive = ["pending", "ready"].includes(right[1]?.status) || protectedKeys.has(right[0]);
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
  timeoutMs = 5_000,
  baseBackoffMs = 5_000,
  maxBackoffMs = 300_000,
  suppressNotifications = false,
  nowMs = Date.now(),
} = {}) {
  if (!state || typeof state !== "object") throw new Error("缺少 Safe 提案状态");
  if (typeof rpcBatch !== "function") throw new Error("缺少 Safe 提案 RPC 批量读取函数");
  const safeEntries = normalizeSafeEntries(safes);
  const normalizedSafes = safeEntries.map(entry => entry.address);
  const apiAddressBySafe = new Map(safeEntries.map(entry => [entry.address, entry.apiAddress]));
  const factory = normalizeAddress(factoryAddress);
  if (normalizedSafes.length === 0) throw new Error("未配置有效的 Flap 管理 Safe");
  if (!factory) throw new Error("Flap Factory 地址无效");

  const migrated = migrateSafeProposalState(state, normalizedSafes);
  Object.assign(state, migrated);
  const runAt = nowIso(nowMs);
  const nonceResults = await rpcBatch(safeNonceCalls(normalizedSafes), { requireAllResults: true });
  const currentNonces = new Map(normalizedSafes.map((safe, index) => [safe, decodeUintWord(nonceResults[index])]));
  const changes = [];
  const errors = [];
  let successfulSafes = 0;

  const settled = await Promise.allSettled(normalizedSafes.map(async safe => {
    const safeState = state.safes[safe] || createSafeStatus(safe);
    state.safes[safe] = safeState;
    const currentNonce = currentNonces.get(safe);
    safeState.currentNonce = currentNonce;
    safeState.lastNonceAt = runAt;
    if (Number(safeState.nextAttemptAtMs) > nowMs) return { safe, skipped: true, currentNonce };
    const proposals = await fetchSafeProposals({
      safe: apiAddressBySafe.get(safe),
      nonce: currentNonce,
      apiBaseUrl,
      timeoutMs,
      fetchFn,
    });
    return { safe, currentNonce, proposals, baselineWasEstablished: safeState.baselineEstablished === true };
  }));

  for (let index = 0; index < settled.length; index++) {
    const safe = normalizedSafes[index];
    const safeState = state.safes[safe];
    const outcome = settled[index];
    safeState.lastPollAt = runAt;
    if (outcome.status === "rejected") {
      safeState.consecutiveFailures = (Number(safeState.consecutiveFailures) || 0) + 1;
      const retryAfterMs = Number(outcome.reason?.retryAfterMs) || 0;
      const backoffMs = Math.min(maxBackoffMs, Math.max(
        retryAfterMs,
        baseBackoffMs * (2 ** Math.min(6, safeState.consecutiveFailures - 1)),
      ));
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
    const suppressForSafe = suppressNotifications || !outcome.value.baselineWasEstablished;

    for (const proposal of outcome.value.proposals) {
      const safeTxHash = normalizeHash(proposal?.safeTxHash);
      const proposalNonce = Number(proposal?.nonce);
      if (!safeTxHash || !Number.isInteger(proposalNonce) || proposalNonce < outcome.value.currentNonce) continue;
      let quoteTokens = [];
      try {
        quoteTokens = extractFlapEnableTargets(proposal, { factoryAddress: factory });
      } catch (error) {
        errors.push(`${safe}: SafeTx ${safeTxHash} 解析失败：${error.message}`);
        continue;
      }
      for (const quoteToken of quoteTokens) {
        const next = normalizeProposal(proposal, safe, quoteToken, runAt);
        const previous = state.proposals[next.key];
        if (previous) next.firstSeenAt = previous.firstSeenAt || next.firstSeenAt;
        state.proposals[next.key] = next;
        if (suppressForSafe) continue;
        if (!previous || ["executed", "invalidated"].includes(previous.status)) {
          changes.push(appendPendingChange(state, next.status === "ready" ? "ready" : "proposed", next, runAt));
        } else if (previous.confirmations < next.required && next.confirmations >= next.required) {
          changes.push(appendPendingChange(state, "ready", next, runAt));
        }
      }
    }
  }

  const staleRecords = Object.values(state.proposals || {}).filter(record =>
    ["pending", "ready"].includes(record?.status)
    && Number.isInteger(currentNonces.get(record.safe))
    && record.nonce < currentNonces.get(record.safe));
  if (staleRecords.length > 0) {
    try {
      const statusResults = await rpcBatch(factoryStatusCalls(staleRecords, factory), { requireAllResults: true });
      for (let index = 0; index < staleRecords.length; index++) {
        const record = staleRecords[index];
        const configured = decodeUintWord(statusResults[index * 2]) === 1;
        const creationDisabled = decodeUintWord(statusResults[index * 2 + 1]) !== 0;
        const effectiveEnabled = configured && !creationDisabled;
        record.status = effectiveEnabled ? "executed" : "invalidated";
        record.invalidatedAt = effectiveEnabled ? "" : runAt;
        record.lastSeenAt = runAt;
        const safeWasInitialized = state.safes[record.safe]?.baselineEstablished === true;
        if (!effectiveEnabled && safeWasInitialized && !suppressNotifications) {
          changes.push(appendPendingChange(state, "invalidated", record, runAt));
        }
      }
    } catch (error) {
      errors.push(`失效提案链上复核失败：${error.message}`);
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
    const name = asset.symbol || asset.name || "未知底池";
    const status = change.type === "ready"
      ? "Safe 签名已满足，等待链上执行"
      : change.type === "invalidated"
        ? "Safe nonce 已失效，且底池仍未开放"
        : "Safe 提案已提交，等待其余签名";
    lines.push(`**${name}｜${status}**`);
    lines.push(`- 底池地址: [${change.quoteToken}](https://bscscan.com/address/${change.quoteToken})`);
    lines.push(`- 确认进度: ${change.confirmations}/${change.required}`);
    lines.push(`- Safe nonce: ${change.nonce}`);
    lines.push(`- 管理 Safe: [${change.safe}](https://app.safe.global/transactions/queue?safe=bnb:${change.safe})`);
    lines.push(`- SafeTxHash: ${change.safeTxHash}`);
    lines.push(`- 提案时间: ${formatDate(change.submissionDate)}`);
    lines.push("");
  }
  lines.push("说明：Safe 提案是明确的开放意图，但仍可能取消或替换；以 Flap Factory 链上开放事件为最终依据。");
  return lines.join("\n");
}
