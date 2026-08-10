import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";

export const FACTORY_POOL_SCHEMA_VERSION = 11;
export const BSC_CHAIN_ID = 56;
export const BNB_QUOTE_TOKEN = "0x0000000000000000000000000000000000000000";
export const FLAP_FACTORY_PROXY = "0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0";
export const QUOTE_CONFIG_SELECTOR = "0x26ef20d5";
export const QUOTE_TOKEN_CREATION_DISABLED_SELECTOR = "0x80718181";
export const EIP1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
export const UPGRADED_EVENT_TOPIC = "0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b";
export const QUOTE_TOKEN_CONFIGURATION_EVENT_TOPIC = "0x7c4631d6e19bd6f974dc94a65d6b5e91d7b1b472d5d206bd8c61309aa849d518";
export const QUOTE_TOKEN_CONFIGURATION_V2_EVENT_TOPIC = "0x9a1f38e55c729ebf0c45d240a00b09f0a79a715df7cfd6e8942bd3f8da839199";
export const QUOTE_TOKEN_CREATION_DISABLED_EVENT_TOPIC = "0xe5b8809453111201d2eac9f84326f432b0227317d947894494170516ed3e68b7";
export const FACTORY_POOL_STATE_EVENT_TOPICS = [
  QUOTE_TOKEN_CONFIGURATION_EVENT_TOPIC,
  QUOTE_TOKEN_CONFIGURATION_V2_EVENT_TOPIC,
  QUOTE_TOKEN_CREATION_DISABLED_EVENT_TOPIC,
];
const FACTORY_POOL_STATE_EVENT_TOPIC_SET = new Set(FACTORY_POOL_STATE_EVENT_TOPICS);
const MAX_FACTORY_POOL_CANDIDATES = 5_000;
const MAX_FACTORY_POOL_RECENT_EVENTS = 20_000;
const MAX_FACTORY_POOL_STATE_BYTES = 16 * 1024 * 1024;

const ZERO_WORD = "0".repeat(64);

export function createFactoryPoolWsHealth() {
  return {
    enabled: false,
    configuredCount: 0,
    subscribedCount: 0,
    status: "disabled",
    endpoints: {},
    lastSubscribedAt: "",
    lastEventAt: "",
    lastDisconnectedAt: "",
    lastError: "",
    lastErrorAt: "",
    backfill: {
      status: "idle",
      fromBlock: null,
      toBlock: null,
      eventCount: 0,
      startedAt: "",
      completedAt: "",
      lastError: "",
    },
  };
}

function nowText() {
  return new Date().toLocaleString("zh-CN", { hour12: false });
}

function normalizeAddress(value, { allowZero = true } = {}) {
  const raw = String(value || "").toLowerCase();
  const match = raw.match(/0x[a-f0-9]{40}/);
  if (!match) return "";
  if (!allowZero && match[0] === BNB_QUOTE_TOKEN) return "";
  return match[0];
}

function hexToNumber(value) {
  if (!value) return 0;
  return Number.parseInt(String(value), 16);
}

function numberToHex(value) {
  return `0x${Math.max(0, Number(value) || 0).toString(16)}`;
}

function hashValue(value) {
  return createHash("sha256").update(String(value || "")).digest("hex");
}

function normalizeHexWord(value) {
  return String(value || "").replace(/^0x/i, "").toLowerCase().padStart(64, "0").slice(-64);
}

export function buildQuoteTokenConfigurationCall(quoteToken) {
  const address = normalizeAddress(quoteToken);
  if (!address) throw new Error(`无效 quoteToken 地址：${quoteToken}`);
  return `${QUOTE_CONFIG_SELECTOR}${address.slice(2).padStart(64, "0")}`;
}

export function buildQuoteTokenCreationDisabledCall(quoteToken) {
  const address = normalizeAddress(quoteToken);
  if (!address) throw new Error(`无效 quoteToken 地址：${quoteToken}`);
  return `${QUOTE_TOKEN_CREATION_DISABLED_SELECTOR}${address.slice(2).padStart(64, "0")}`;
}

export function decodeBooleanResult(result) {
  const hex = String(result || "").replace(/^0x/i, "").toLowerCase();
  if (!/^[a-f0-9]{64,}$/.test(hex)) throw new Error(`布尔返回长度无效：${Math.floor(hex.length / 2)} bytes`);
  return BigInt(`0x${hex.slice(0, 64)}`) !== 0n;
}

export function decodeQuoteTokenConfiguration(result) {
  const hex = String(result || "").replace(/^0x/i, "").toLowerCase();
  if (!/^[a-f0-9]{320,}$/.test(hex)) throw new Error(`底池配置返回长度无效：${Math.floor(hex.length / 2)} bytes`);
  const fields = Array.from({ length: 5 }, (_, index) => `0x${hex.slice(index * 64, (index + 1) * 64)}`);
  const values = fields.map(field => BigInt(field).toString());
  const configured = BigInt(fields[0]) === 1n;
  return {
    fields,
    values,
    enabled: Number(values[0]),
    officialCandidate: Number(values[0]) === 1,
    defaultCurve: Number(values[1]),
    alternativeCurve: Number(values[2]),
    nativeToQuoteSwapType: Number(values[3]),
    dexId: Number(values[4]),
    configured,
    configurationPresent: fields.some(field => field !== `0x${ZERO_WORD}`),
    fingerprint: hashValue(fields.join(":")),
  };
}

export function extractAddressWords(data, { includeZero = true } = {}) {
  const hex = String(data || "").replace(/^0x/i, "");
  if (!/^[a-fA-F0-9]+$/.test(hex)) return [];
  const body = hex.length % 64 === 8 ? hex.slice(8) : hex;
  const addresses = new Set();
  for (let offset = 0; offset + 64 <= body.length; offset += 64) {
    const word = body.slice(offset, offset + 64);
    if (!/^0{24}[a-fA-F0-9]{40}$/.test(word)) continue;
    const address = `0x${word.slice(24)}`.toLowerCase();
    if (!includeZero && address === BNB_QUOTE_TOKEN) continue;
    addresses.add(address);
  }
  return [...addresses];
}

export function extractFactoryLogCandidates(logEntry, proxy = FLAP_FACTORY_PROXY) {
  if (normalizeAddress(logEntry?.address) !== normalizeAddress(proxy)) return [];
  const topic0 = String(logEntry?.topics?.[0] || "").toLowerCase();
  if (topic0 === QUOTE_TOKEN_CONFIGURATION_EVENT_TOPIC || topic0 === QUOTE_TOKEN_CONFIGURATION_V2_EVENT_TOPIC) {
    const data = String(logEntry?.data || "").replace(/^0x/i, "");
    const quoteToken = /^[a-fA-F0-9]{64,}$/.test(data)
      ? normalizeAddress(`0x${data.slice(24, 64)}`)
      : "";
    let eventConfiguration = null;
    if (data.length >= 384) {
      try { eventConfiguration = decodeQuoteTokenConfiguration(`0x${data.slice(64, 384)}`); } catch {}
    }
    return quoteToken ? [{
      quoteToken,
      selector: "",
      topic0,
      txHash: String(logEntry?.transactionHash || "").toLowerCase(),
      blockNumber: hexToNumber(logEntry?.blockNumber),
      logIndex: hexToNumber(logEntry?.logIndex),
      source: "event",
      eventConfiguration,
    }] : [];
  }
  if (topic0 === QUOTE_TOKEN_CREATION_DISABLED_EVENT_TOPIC) {
    const quoteToken = extractAddressWords(logEntry?.topics?.[1] || "")[0]
      || extractAddressWords(logEntry?.data || "")[0]
      || "";
    let eventDisabled = null;
    try { eventDisabled = decodeBooleanResult(logEntry?.data || ""); } catch {}
    return quoteToken ? [{
      quoteToken,
      selector: QUOTE_TOKEN_CREATION_DISABLED_SELECTOR,
      topic0,
      txHash: String(logEntry?.transactionHash || "").toLowerCase(),
      blockNumber: hexToNumber(logEntry?.blockNumber),
      logIndex: hexToNumber(logEntry?.logIndex),
      source: "event",
      eventDisabled,
    }] : [];
  }
  return [];
}

export function extractImplementationAddress(storageValue) {
  const hex = String(storageValue || "").replace(/^0x/i, "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hex)) return "";
  return normalizeAddress(`0x${hex.slice(-40)}`, { allowZero: false });
}

export function extractBytecodeSelectors(bytecode) {
  const hex = String(bytecode || "").replace(/^0x/i, "").toLowerCase();
  const selectors = new Set();
  for (let index = 0; index + 10 <= hex.length; index += 2) {
    if (hex.slice(index, index + 2) !== "63") continue;
    if (hex.slice(index + 10, index + 12) !== "14") continue;
    selectors.add(`0x${hex.slice(index + 2, index + 10)}`);
  }
  return [...selectors].sort();
}

function migrateFactoryPoolAsset(asset = {}) {
  const values = Array.isArray(asset.values) ? asset.values.map(String) : [];
  const fields = Array.isArray(asset.fields) ? asset.fields : [];
  const configurationPresent = typeof asset.configurationPresent === "boolean"
    ? asset.configurationPresent
    : values.length > 0
      ? values.some(value => value !== "0")
      : Boolean(asset.configured ?? asset.enabled);
  const configured = values.length > 0 ? values[0] === "1" : Boolean(asset.configured ?? asset.enabled);
  const creationDisabled = Boolean(asset.creationDisabled);
  const configurationFingerprint = asset.configurationFingerprint
    || (fields.length > 0 ? hashValue(fields.join(":")) : asset.fingerprint || "");
  const migrated = {
    ...asset,
    configured,
    configurationPresent,
    creationDisabled,
    effectiveEnabled: configured && !creationDisabled,
    configurationFingerprint,
    fingerprint: hashValue(`${configurationFingerprint}:${creationDisabled ? 1 : 0}`),
    enabled: Number(values[0] ?? asset.enabled ?? (configured ? 1 : 0)),
    officialCandidate: configured,
    defaultCurve: Number(values[1] ?? asset.defaultCurve ?? 0),
    alternativeCurve: Number(values[2] ?? asset.alternativeCurve ?? 0),
    nativeToQuoteSwapType: Number(values[3] ?? asset.nativeToQuoteSwapType ?? 0),
    dexId: Number(values[4] ?? asset.dexId ?? 0),
    disabled: creationDisabled,
    decimals: Number.isFinite(Number(asset.decimals)) ? Number(asset.decimals) : null,
  };
  return migrated;
}

export function createFactoryPoolState(proxy = FLAP_FACTORY_PROXY) {
  return {
    schemaVersion: FACTORY_POOL_SCHEMA_VERSION,
    chainId: BSC_CHAIN_ID,
    proxy: normalizeAddress(proxy),
    deploymentBlock: null,
    deploymentTxHash: "",
    deployer: "",
    deploymentTxChecked: false,
    deploymentDetection: "pending",
    latestBlock: null,
    safeLatestBlock: null,
    headLastScannedBlock: null,
    lastScannedBlock: null,
    currentImplementation: "",
    implementationSelectors: [],
    implementationHistory: [],
    candidates: {},
    assets: {},
    recentEvents: {},
    assetRefreshCursor: 0,
    pendingChanges: [],
    pendingImplementationChange: null,
    sendingChanges: [],
    sendingImplementationChange: null,
    verificationHealth: {
      pendingCount: 0,
      failingCount: 0,
      consecutiveFailures: 0,
      lastError: "",
      lastFailureAt: "",
      lastSuccessAt: "",
    },
    wssHealth: createFactoryPoolWsHealth(),
    lastRealtimeRunAt: "",
    lastCatchupRunAt: "",
    lastRunAt: "",
    lastError: "",
  };
}

export function migrateFactoryPoolState(raw, proxy = FLAP_FACTORY_PROXY) {
  const base = createFactoryPoolState(proxy);
  const state = raw && typeof raw === "object" ? { ...base, ...raw } : base;
  state.schemaVersion = FACTORY_POOL_SCHEMA_VERSION;
  state.chainId = BSC_CHAIN_ID;
  state.proxy = normalizeAddress(proxy);
  const defaultWsHealth = createFactoryPoolWsHealth();
  state.wssHealth = state.wssHealth && typeof state.wssHealth === "object"
    ? { ...defaultWsHealth, ...state.wssHealth }
    : defaultWsHealth;
  state.wssHealth.endpoints = state.wssHealth.endpoints && typeof state.wssHealth.endpoints === "object"
    && !Array.isArray(state.wssHealth.endpoints) ? state.wssHealth.endpoints : {};
  state.wssHealth.backfill = state.wssHealth.backfill && typeof state.wssHealth.backfill === "object"
    ? { ...defaultWsHealth.backfill, ...state.wssHealth.backfill }
    : defaultWsHealth.backfill;
  for (const key of ["candidates", "assets", "recentEvents"]) {
    if (!state[key] || typeof state[key] !== "object" || Array.isArray(state[key])) state[key] = {};
  }
  state.assets = Object.fromEntries(Object.entries(state.assets).map(([address, asset]) => [address, migrateFactoryPoolAsset(asset)]));
  for (const candidate of Object.values(state.candidates)) {
    if (!candidate || typeof candidate !== "object") continue;
    if (!Number.isFinite(Number(candidate.enabled))) candidate.enabled = candidate.configured ? 1 : 0;
    if (typeof candidate.officialCandidate !== "boolean") candidate.officialCandidate = Number(candidate.enabled) === 1;
    if (typeof candidate.disabled !== "boolean") candidate.disabled = Boolean(candidate.creationDisabled);
    if (typeof candidate.creationDisabled !== "boolean") candidate.creationDisabled = false;
    if (typeof candidate.effectiveEnabled !== "boolean") {
      candidate.effectiveEnabled = Boolean(candidate.configured) && !candidate.creationDisabled;
    }
    if (typeof candidate.pendingVerification !== "boolean") {
      candidate.pendingVerification = Boolean(candidate.lastVerifyError) || !candidate.lastVerifiedAt;
    }
    if (!Number.isFinite(candidate.verifyFailureCount)) candidate.verifyFailureCount = 0;
    if (!Number.isFinite(candidate.consecutiveVerifyFailures)) candidate.consecutiveVerifyFailures = 0;
    if (!Number.isFinite(candidate.lastVerifyAttemptAtMs)) candidate.lastVerifyAttemptAtMs = 0;
    if (!Number.isFinite(candidate.lastVerifyBlock)) candidate.lastVerifyBlock = 0;
  }
  state.candidates = Object.fromEntries(Object.entries(state.candidates)
    .filter(([address, candidate]) => state.assets[address]
      || candidate?.sources?.some(source => FACTORY_POOL_STATE_EVENT_TOPIC_SET.has(String(source.topic0 || "").toLowerCase())))
    .sort(([, left], [, right]) => (right.lastSeenBlock || 0) - (left.lastSeenBlock || 0))
    .slice(0, MAX_FACTORY_POOL_CANDIDATES));
  state.recentEvents = Object.fromEntries(Object.entries(state.recentEvents)
    .filter(([key, event]) => /^[a-f0-9x]+:\d+$/i.test(key) && event && typeof event === "object")
    .sort(([, left], [, right]) => (right.blockNumber || 0) - (left.blockNumber || 0))
    .slice(0, MAX_FACTORY_POOL_RECENT_EVENTS));
  for (const key of [
    "fallbackLastScannedBlock", "historyLogLastScannedBlock", "historyBlockLastScannedBlock",
    "historyBackwardLogCursor", "historyStateEventCursor", "historyBackwardBlockCursor",
    "historyLastScannedBlock", "historyConfigEventCursor", "lastHistoryRunAt", "relatedSelectors",
    "proxyUpgradeEvents", "blockCheckpoints",
  ]) delete state[key];
  delete state.processedTransactions;
  if (!Array.isArray(state.implementationHistory)) state.implementationHistory = [];
  if (!Array.isArray(state.implementationSelectors)) state.implementationSelectors = [];
  if (!Array.isArray(state.pendingChanges)) state.pendingChanges = [];
  if (!Array.isArray(state.sendingChanges)) state.sendingChanges = [];
  if (state.sendingChanges.length > 0) {
    state.pendingChanges = mergePendingFactoryPoolChanges(state.sendingChanges, state.pendingChanges);
    state.sendingChanges = [];
  }
  if (state.sendingImplementationChange?.previous && !state.pendingImplementationChange?.previous) {
    state.pendingImplementationChange = state.sendingImplementationChange;
  }
  state.sendingImplementationChange = null;
  if (!state.verificationHealth || typeof state.verificationHealth !== "object") {
    state.verificationHealth = { ...base.verificationHealth };
  }
  refreshCandidateVerificationHealth(state);
  return state;
}

export function loadFactoryPoolState(path, proxy = FLAP_FACTORY_PROXY) {
  if (!existsSync(path)) return createFactoryPoolState(proxy);
  const size = statSync(path).size;
  if (size > MAX_FACTORY_POOL_STATE_BYTES) {
    throw new Error(`Factory 状态文件过大（${Math.ceil(size / 1024 / 1024)}MB），请先运行 npm run repair:flap-factory-state -- "${path}"`);
  }
  try {
    return migrateFactoryPoolState(JSON.parse(readFileSync(path, "utf-8")), proxy);
  } catch (error) {
    throw new Error(`Factory 状态文件解析失败：${error.message}`);
  }
}

export function saveFactoryPoolState(path, state) {
  const tmp = `${path}.tmp`;
  state.schemaVersion = FACTORY_POOL_SCHEMA_VERSION;
  writeFileSync(tmp, JSON.stringify(state), "utf-8");
  renameSync(tmp, path);
}

function candidateKey(item) {
  return `${item.source || "unknown"}:${item.txHash || ""}:${item.logIndex ?? ""}:${item.selector || item.topic0 || ""}:${item.quoteToken}`;
}

export function factoryPoolEventKey(logEntry) {
  const txHash = String(logEntry?.transactionHash || "").toLowerCase();
  const logIndex = hexToNumber(logEntry?.logIndex);
  return /^0x[a-f0-9]{64}$/.test(txHash) ? `${txHash}:${logIndex}` : "";
}

function rememberFactoryPoolEvent(state, logEntry, source) {
  const key = factoryPoolEventKey(logEntry);
  if (!key || state.recentEvents?.[key]) return false;
  state.recentEvents ||= {};
  state.recentEvents[key] = {
    blockNumber: hexToNumber(logEntry?.blockNumber),
    transactionHash: String(logEntry?.transactionHash || "").toLowerCase(),
    logIndex: hexToNumber(logEntry?.logIndex),
    source: source || "event",
    seenAt: nowText(),
  };
  const entries = Object.entries(state.recentEvents);
  if (entries.length > MAX_FACTORY_POOL_RECENT_EVENTS) {
    entries.sort(([, left], [, right]) => (right.blockNumber || 0) - (left.blockNumber || 0));
    state.recentEvents = Object.fromEntries(entries.slice(0, MAX_FACTORY_POOL_RECENT_EVENTS));
  }
  return true;
}

function rememberCandidate(state, item) {
  const quoteToken = normalizeAddress(item?.quoteToken);
  if (!quoteToken) return false;
  const current = state.candidates[quoteToken] || {
    quoteToken,
    firstSeenBlock: item.blockNumber || null,
    lastSeenBlock: item.blockNumber || null,
    sources: [],
    sourceCount: 0,
    pendingVerification: true,
    verifyFailureCount: 0,
    consecutiveVerifyFailures: 0,
    lastVerifyAttemptAtMs: 0,
    lastVerifyBlock: 0,
    firstSeenAt: nowText(),
  };
  const key = candidateKey({ ...item, quoteToken });
  if (current.sources.some(source => source.key === key)) return false;
  current.firstSeenAt ||= nowText();
  current.firstSeenBlock = current.firstSeenBlock == null
    ? (item.blockNumber || null)
    : Math.min(current.firstSeenBlock, item.blockNumber || current.firstSeenBlock);
  current.lastSeenBlock = Math.max(current.lastSeenBlock || 0, item.blockNumber || 0) || null;
  current.blockNumber = item.blockNumber ?? current.blockNumber ?? null;
  current.transactionHash = String(item.txHash || current.transactionHash || "").toLowerCase();
  current.logIndex = item.logIndex ?? current.logIndex ?? null;
  current.lastSeenAt = nowText();
  current.source = item.source || current.source || "event";
  if (!Number.isInteger(current.decimals)) current.decimals = null;
  if (item.eventConfiguration) {
    for (const field of ["enabled", "defaultCurve", "alternativeCurve", "nativeToQuoteSwapType", "dexId"]) {
      current[field] = item.eventConfiguration[field];
    }
  }
  if (typeof item.eventDisabled === "boolean") current.disabled = item.eventDisabled;
  current.lastTxHash = String(item.txHash || current.lastTxHash || "").toLowerCase();
  current.lastSourceBlock = item.blockNumber ?? current.lastSourceBlock ?? null;
  current.pendingVerification = true;
  current.sources.push({
    key,
    source: item.source || "unknown",
    selector: item.selector || "",
    topic0: item.topic0 || "",
    txHash: item.txHash || "",
    blockNumber: item.blockNumber || null,
    logIndex: item.logIndex ?? null,
  });
  current.sourceCount = (current.sourceCount || 0) + 1;
  if (current.sources.length > 3) current.sources.splice(0, current.sources.length - 3);
  state.candidates[quoteToken] = current;
  return true;
}

function refreshCandidateVerificationHealth(state) {
  const candidates = Object.values(state.candidates || {});
  const pending = candidates.filter(candidate => candidate?.pendingVerification);
  const failing = pending.filter(candidate => candidate.lastVerifyError);
  const latestFailure = [...failing].sort((left, right) =>
    (right.lastVerifyAttemptAtMs || 0) - (left.lastVerifyAttemptAtMs || 0))[0];
  const previous = state.verificationHealth || {};
  state.verificationHealth = {
    pendingCount: pending.length,
    failingCount: failing.length,
    consecutiveFailures: failing.reduce((total, candidate) => total + (candidate.consecutiveVerifyFailures || 0), 0),
    lastError: latestFailure?.lastVerifyError || "",
    lastFailureAt: latestFailure?.lastVerifyFailureAt || previous.lastFailureAt || "",
    lastSuccessAt: previous.lastSuccessAt || "",
  };
  if (failing.length > 0) {
    state.lastError = `候选复核失败 ${failing.length} 个：${latestFailure.quoteToken}｜${latestFailure.lastVerifyError}`;
  }
  return state.verificationHealth;
}

function pruneFactoryPoolCandidates(state) {
  const expiryBlock = Math.max(0, (state.safeLatestBlock || 0) - 100);
  for (const [address, candidate] of Object.entries(state.candidates || {})) {
    if (state.assets[address] || candidate?.pendingVerification) continue;
    if ((candidate.lastSeenBlock || 0) < expiryBlock) delete state.candidates[address];
  }
  const entries = Object.entries(state.candidates || {});
  if (entries.length <= MAX_FACTORY_POOL_CANDIDATES) return;
  const removable = entries
    .filter(([address, candidate]) => !state.assets[address] && !candidate?.pendingVerification)
    .sort(([, left], [, right]) => (left.lastSeenBlock || 0) - (right.lastSeenBlock || 0));
  for (const [address] of removable) {
    if (Object.keys(state.candidates).length <= MAX_FACTORY_POOL_CANDIDATES) break;
    delete state.candidates[address];
  }
}

async function findDeploymentBlockByCode(rpcCall, proxy, safeLatest) {
  const latestCode = await rpcCall("eth_getCode", [proxy, numberToHex(safeLatest)], { requireResult: true });
  if (!latestCode || latestCode === "0x") throw new Error("Factory Proxy 当前区块不存在 bytecode");
  let low = 1;
  let high = safeLatest;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const code = await rpcCall("eth_getCode", [proxy, numberToHex(middle)], { requireResult: true });
    if (code && code !== "0x") high = middle;
    else low = middle + 1;
  }
  return low;
}

async function findProxyCreationTransaction(rpcCall, proxy, deploymentBlock) {
  const block = await rpcCall("eth_getBlockByNumber", [numberToHex(deploymentBlock), true], { requireResult: true });
  for (const transaction of block?.transactions || []) {
    if (transaction.to) continue;
    const receipt = await rpcCall("eth_getTransactionReceipt", [transaction.hash], { requireResult: true });
    if (normalizeAddress(receipt?.contractAddress) !== proxy) continue;
    return {
      txHash: String(transaction.hash || "").toLowerCase(),
      deployer: normalizeAddress(transaction.from),
    };
  }
  return null;
}

async function readImplementation(rpcCall, proxy, blockTag) {
  const raw = await rpcCall("eth_getStorageAt", [proxy, EIP1967_IMPLEMENTATION_SLOT, blockTag], { requireResult: true });
  return extractImplementationAddress(raw);
}

async function refreshImplementation({ state, rpcCall, log }) {
  const implementation = await readImplementation(rpcCall, state.proxy, numberToHex(state.safeLatestBlock));
  if (!implementation) throw new Error("无法读取 Factory implementation");
  if (implementation === state.currentImplementation) return null;
  const previous = state.currentImplementation || "";
  const code = await rpcCall("eth_getCode", [implementation, numberToHex(state.safeLatestBlock)], { requireResult: true });
  const selectors = extractBytecodeSelectors(code);
  const change = {
    previous,
    current: implementation,
    detectedAt: nowText(),
    detectedBlock: state.safeLatestBlock,
    selectors,
  };
  state.currentImplementation = implementation;
  state.implementationSelectors = selectors;
  state.implementationHistory.push(change);
  if (state.implementationHistory.length > 50) state.implementationHistory.splice(0, state.implementationHistory.length - 50);
  log?.(`[Flap Factory] implementation ${previous || "未建立"} -> ${implementation}，识别 ${selectors.length} 个选择器`);
  return change;
}

async function fetchRangeLogs(rpcCall, proxy, fromBlock, toBlock, topics) {
  if (fromBlock > toBlock) return { logs: [], toBlock };
  let end = toBlock;
  let lastError;
  while (end >= fromBlock) {
    try {
      const filter = {
        address: proxy,
        fromBlock: numberToHex(fromBlock),
        toBlock: numberToHex(end),
      };
      if (topics) filter.topics = topics;
      const logs = await rpcCall("eth_getLogs", [filter]);
      return { logs: logs || [], toBlock: end };
    } catch (error) {
      lastError = error;
      if (end === fromBlock) break;
      end = fromBlock + Math.floor((end - fromBlock) / 2);
    }
  }
  throw lastError || new Error(`无法读取 Factory 日志：${fromBlock}-${toBlock}`);
}

export function classifyFactoryPoolChange(previous, current) {
  if (!previous) return current.configured ? "added" : "disabled";
  if (!previous.configured && current.configured) return "added";
  if (previous.configured && !current.configured) return "disabled";
  if (current.configured && !previous.creationDisabled && current.creationDisabled) return "paused";
  if (current.configured && previous.creationDisabled && !current.creationDisabled) return "resumed";
  return "modified";
}

async function verifyCandidates({ state, rpcCall, items, blockTag = "latest", persistState, log }) {
  const unique = new Map();
  let discoveredCandidate = false;
  for (const item of items) {
    const address = normalizeAddress(item.quoteToken);
    if (!address) continue;
    if (item.source !== "periodic-refresh" && item.source !== "pending-retry") {
      discoveredCandidate = rememberCandidate(state, { ...item, quoteToken: address }) || discoveredCandidate;
    }
    if (!unique.has(address) || (!unique.get(address)?.selector && item.selector)) unique.set(address, item);
  }
  if (discoveredCandidate && typeof persistState === "function") {
    refreshCandidateVerificationHealth(state);
    await persistState(state, { reason: "candidate-discovered" });
  }

  const changes = [];
  for (const [quoteToken, source] of unique) {
    let decoded;
    let creationDisabled;
    const candidate = state.candidates[quoteToken]
      || (rememberCandidate(state, { ...source, quoteToken }), state.candidates[quoteToken]);
    candidate.pendingVerification = true;
    candidate.lastVerifyAttemptAtMs = Date.now();
    candidate.lastVerifyAttemptAt = nowText();
    candidate.lastVerifyBlock = hexToNumber(blockTag) || state.safeLatestBlock || source.blockNumber || 0;
    try {
      const [configurationRaw, creationDisabledRaw] = await Promise.all([
        rpcCall("eth_call", [{ to: state.proxy, data: buildQuoteTokenConfigurationCall(quoteToken) }, blockTag], { requireResult: true }),
        rpcCall("eth_call", [{ to: state.proxy, data: buildQuoteTokenCreationDisabledCall(quoteToken) }, blockTag], { requireResult: true }),
      ]);
      decoded = decodeQuoteTokenConfiguration(configurationRaw);
      creationDisabled = decodeBooleanResult(creationDisabledRaw);
      if (source.eventConfiguration && source.eventConfiguration.fingerprint !== decoded.fingerprint) {
        throw new Error("Factory getter 尚未同步到配置事件状态");
      }
      if (typeof source.eventDisabled === "boolean" && source.eventDisabled !== creationDisabled) {
        throw new Error("Factory getter 尚未同步到开放状态事件");
      }
    } catch (error) {
      candidate.lastVerifyError = error.message;
      candidate.lastVerifyFailureAt = nowText();
      candidate.verifyFailureCount = (candidate.verifyFailureCount || 0) + 1;
      candidate.consecutiveVerifyFailures = (candidate.consecutiveVerifyFailures || 0) + 1;
      candidate.pendingVerification = true;
      refreshCandidateVerificationHealth(state);
      if (candidate.consecutiveVerifyFailures === 1 || candidate.consecutiveVerifyFailures % 10 === 0) {
        log?.(`[Flap Factory] 候选复核失败 ${quoteToken}（连续 ${candidate.consecutiveVerifyFailures} 次）：${error.message}`);
      }
      if (typeof persistState === "function") {
        await persistState(state, { reason: "candidate-verify-failed", quoteToken });
      }
      continue;
    }
    const previous = state.assets[quoteToken];
    candidate.lastVerifiedAt = nowText();
    candidate.lastVerifyError = "";
    candidate.lastVerifyFailureAt = "";
    candidate.consecutiveVerifyFailures = 0;
    candidate.pendingVerification = false;
    candidate.configured = decoded.configured;
    candidate.enabled = decoded.enabled;
    candidate.officialCandidate = decoded.officialCandidate;
    candidate.defaultCurve = decoded.defaultCurve;
    candidate.alternativeCurve = decoded.alternativeCurve;
    candidate.nativeToQuoteSwapType = decoded.nativeToQuoteSwapType;
    candidate.dexId = decoded.dexId;
    candidate.creationDisabled = creationDisabled;
    candidate.disabled = creationDisabled;
    candidate.effectiveEnabled = decoded.configured && !creationDisabled;
    if (!decoded.configurationPresent && !previous) continue;

    const fingerprint = hashValue(`${decoded.fingerprint}:${creationDisabled ? 1 : 0}`);

    const next = {
      quoteToken,
      configured: decoded.configured,
      enabled: decoded.enabled,
      officialCandidate: decoded.officialCandidate,
      defaultCurve: decoded.defaultCurve,
      alternativeCurve: decoded.alternativeCurve,
      nativeToQuoteSwapType: decoded.nativeToQuoteSwapType,
      dexId: decoded.dexId,
      configurationPresent: decoded.configurationPresent,
      creationDisabled,
      disabled: creationDisabled,
      effectiveEnabled: decoded.configured && !creationDisabled,
      fields: decoded.fields,
      values: decoded.values,
      configurationFingerprint: decoded.fingerprint,
      fingerprint,
      firstSeenAt: previous?.firstSeenAt || nowText(),
      firstSeenBlock: previous?.firstSeenBlock ?? source.blockNumber ?? null,
      lastChangedAt: previous?.fingerprint === fingerprint ? previous.lastChangedAt : nowText(),
      lastSeenBlock: source.blockNumber ?? previous?.lastSeenBlock ?? null,
      blockNumber: source.blockNumber ?? previous?.blockNumber ?? null,
      transactionHash: source.txHash || previous?.transactionHash || "",
      logIndex: source.logIndex ?? previous?.logIndex ?? null,
      lastSeenAt: source.blockNumber ? nowText() : previous?.lastSeenAt || nowText(),
      lastTxHash: source.txHash || previous?.lastTxHash || "",
      lastSelector: source.selector || previous?.lastSelector || "",
      source: source.source === "periodic-refresh"
        ? previous?.source || source.source
        : source.source || previous?.source || "",
      name: previous?.name || "",
      symbol: previous?.symbol || "",
      decimals: Number.isFinite(Number(previous?.decimals)) ? Number(previous.decimals) : null,
      metadataSource: previous?.metadataSource || "",
      metadataUpdatedAt: previous?.metadataUpdatedAt || "",
      metadataNextRetryAt: previous?.metadataNextRetryAt || "",
      metadataError: previous?.metadataError || "",
      lastVerifiedBlock: hexToNumber(blockTag) || state.safeLatestBlock || source.blockNumber || null,
      lastVerifiedAtMs: candidate.lastVerifyAttemptAtMs,
    };
    state.assets[quoteToken] = next;
    if (!previous || previous.fingerprint !== next.fingerprint) {
      changes.push({ type: classifyFactoryPoolChange(previous, next), previous: previous || null, current: next });
    }
  }
  const health = refreshCandidateVerificationHealth(state);
  if (health.failingCount === 0) {
    state.verificationHealth.lastSuccessAt = nowText();
  }
  pruneFactoryPoolCandidates(state);
  return changes;
}

export async function ingestFactoryPoolEvent({
  state,
  logEntry,
  rpcCall,
  persistState,
  source = "factory-wss",
  log,
} = {}) {
  if (!state || typeof rpcCall !== "function") throw new Error("Factory WSS 事件处理缺少 state 或 rpcCall");
  const items = extractFactoryLogCandidates(logEntry, state.proxy);
  if (items.length === 0) throw new Error(`无法解析 Factory 事件：${String(logEntry?.topics?.[0] || "未知 topic")}`);
  const key = factoryPoolEventKey(logEntry);
  if (!rememberFactoryPoolEvent(state, logEntry, source)) {
    return { processed: false, duplicate: true, eventKey: key, changes: [], item: items[0], state };
  }
  const blockNumber = hexToNumber(logEntry?.blockNumber);
  state.latestBlock = Math.max(Number(state.latestBlock) || 0, blockNumber);
  state.safeLatestBlock = Math.max(Number(state.safeLatestBlock) || 0, blockNumber);
  const enrichedItems = items.map(item => ({ ...item, source }));
  const changes = await verifyCandidates({
    state,
    rpcCall,
    items: enrichedItems,
    blockTag: "latest",
    persistState,
    log,
  });
  state.lastRealtimeRunAt = nowText();
  state.lastRunAt = nowText();
  return {
    processed: true,
    duplicate: false,
    eventKey: key,
    changes,
    item: enrichedItems[0],
    state,
  };
}

async function refreshKnownAssets({ state, rpcCall, limit, blockTag, persistState, log }) {
  const addresses = Object.keys(state.assets).sort();
  if (addresses.length === 0 || limit <= 0) return [];
  const start = Math.max(0, Number(state.assetRefreshCursor) || 0) % addresses.length;
  const selected = [];
  for (let index = 0; index < Math.min(limit, addresses.length); index++) {
    selected.push(addresses[(start + index) % addresses.length]);
  }
  state.assetRefreshCursor = (start + selected.length) % addresses.length;
  return await verifyCandidates({
    state,
    rpcCall,
    blockTag,
    persistState,
    log,
    items: selected.map(quoteToken => ({ quoteToken, source: "periodic-refresh" })),
  });
}

function dedupeChanges(changes) {
  const seen = new Set();
  const unique = [];
  for (const change of changes) {
    const key = [
      change.current?.quoteToken || "",
      change.type || "",
      change.previous?.fingerprint || "",
      change.current?.fingerprint || "",
    ].join(":");
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(change);
  }
  return unique;
}

function applyStateEventToAsset(asset, logEntry) {
  const topic0 = String(logEntry?.topics?.[0] || "").toLowerCase();
  if (topic0 === QUOTE_TOKEN_CREATION_DISABLED_EVENT_TOPIC) {
    const creationDisabled = decodeBooleanResult(logEntry.data);
    return {
      ...asset,
      creationDisabled,
      effectiveEnabled: Boolean(asset.configured) && !creationDisabled,
      fingerprint: hashValue(`${asset.configurationFingerprint}:${creationDisabled ? 1 : 0}`),
    };
  }
  if (topic0 !== QUOTE_TOKEN_CONFIGURATION_EVENT_TOPIC && topic0 !== QUOTE_TOKEN_CONFIGURATION_V2_EVENT_TOPIC) return null;
  const data = String(logEntry?.data || "").replace(/^0x/i, "");
  if (!/^[a-fA-F0-9]{384,}$/.test(data)) return null;
  const decoded = decodeQuoteTokenConfiguration(`0x${data.slice(64, 384)}`);
  return {
    ...asset,
    configured: decoded.configured,
    configurationPresent: decoded.configurationPresent,
    fields: decoded.fields,
    values: decoded.values,
    configurationFingerprint: decoded.fingerprint,
    effectiveEnabled: decoded.configured && !asset.creationDisabled,
    fingerprint: hashValue(`${decoded.fingerprint}:${asset.creationDisabled ? 1 : 0}`),
  };
}

function deriveRealtimeStateEventChanges(logs, previousAssets, finalAssets, proxy) {
  const changes = [];
  const transientAssets = new Map();
  const orderedLogs = [...(logs || [])].sort((left, right) =>
    hexToNumber(left.blockNumber) - hexToNumber(right.blockNumber)
    || hexToNumber(left.transactionIndex) - hexToNumber(right.transactionIndex)
    || hexToNumber(left.logIndex) - hexToNumber(right.logIndex));
  for (const logEntry of orderedLogs) {
    const candidate = extractFactoryLogCandidates(logEntry, proxy)[0];
    const quoteToken = candidate?.quoteToken;
    if (!quoteToken || !previousAssets.has(quoteToken)) continue;
    const previous = transientAssets.get(quoteToken) || previousAssets.get(quoteToken);
    const current = applyStateEventToAsset(previous, logEntry);
    if (!current || previous.fingerprint === current.fingerprint) continue;
    changes.push({ type: classifyFactoryPoolChange(previous, current), previous, current });
    transientAssets.set(quoteToken, current);
  }
  for (const [quoteToken, transient] of transientAssets) {
    const finalAsset = finalAssets[quoteToken];
    if (!finalAsset || finalAsset.fingerprint === transient.fingerprint) continue;
    changes.push({ type: classifyFactoryPoolChange(transient, finalAsset), previous: transient, current: finalAsset });
  }
  return { changes, addresses: new Set(transientAssets.keys()) };
}

async function scanStateEventRange({
  state,
  rpcCall,
  fromBlock,
  toBlock,
  blockTag,
  preserveTransitions = false,
  retryPending = false,
  persistState,
  log,
}) {
  if (fromBlock > toBlock) return { changes: [], toBlock: fromBlock - 1 };
  const logRange = await fetchRangeLogs(
    rpcCall,
    state.proxy,
    fromBlock,
    toBlock,
    [FACTORY_POOL_STATE_EVENT_TOPICS],
  );
  const freshLogs = (logRange.logs || []).filter(logEntry => rememberFactoryPoolEvent(state, logEntry, "factory-http"));
  const items = freshLogs.flatMap(logEntry => extractFactoryLogCandidates(logEntry, state.proxy));
  if (retryPending) {
    for (const candidate of Object.values(state.candidates || {})) {
      if (!candidate?.pendingVerification) continue;
      items.push({
        quoteToken: candidate.quoteToken,
        source: "pending-retry",
        txHash: candidate.lastTxHash || "",
        blockNumber: candidate.lastSourceBlock || candidate.lastSeenBlock || null,
      });
    }
  }
  const previousAssets = preserveTransitions
    ? new Map([...new Set(items.map(item => item.quoteToken))]
        .filter(quoteToken => state.assets[quoteToken])
        .map(quoteToken => [quoteToken, { ...state.assets[quoteToken] }]))
    : new Map();
  const verifiedChanges = await verifyCandidates({ state, rpcCall, items, blockTag, persistState, log });
  if (!preserveTransitions || previousAssets.size === 0) {
    return { changes: verifiedChanges, toBlock: logRange.toBlock };
  }
  const derived = deriveRealtimeStateEventChanges(freshLogs, previousAssets, state.assets, state.proxy);
  return {
    changes: [
      ...derived.changes,
      ...verifiedChanges.filter(change => !derived.addresses.has(change.current.quoteToken)),
    ],
    toBlock: logRange.toBlock,
  };
}

export async function runFactoryPoolScan({ state, rpcCall, persistState, config = {}, log } = {}) {
  if (!state || typeof rpcCall !== "function") throw new Error("Factory 扫描缺少 state 或 rpcCall");
  const cfg = {
    confirmations: 0,
    deploymentBlock: 0,
    scanRealtime: true,
    scanCatchup: true,
    scanAssets: false,
    realtimeBootstrapBlocks: 20,
    realtimeMaxBlocksPerRun: 20,
    realtimeRescanBlocks: 5,
    catchupMaxBlocksPerRun: 2_000,
    assetRefreshPerRun: 10,
    ...config,
  };
  const [chainIdHex, latestHex] = await Promise.all([
    rpcCall("eth_chainId", []),
    rpcCall("eth_blockNumber", []),
  ]);
  const chainId = hexToNumber(chainIdHex);
  if (chainId !== BSC_CHAIN_ID) throw new Error(`Factory RPC chainId 错误：${chainId}，期望 ${BSC_CHAIN_ID}`);
  const latest = hexToNumber(latestHex);
  const safeLatest = Math.max(0, latest - cfg.confirmations);
  state.latestBlock = latest;
  state.safeLatestBlock = safeLatest;

  if (!state.deploymentBlock) {
    if (Number(cfg.deploymentBlock) > 0) {
      state.deploymentBlock = Number(cfg.deploymentBlock);
      state.deploymentDetection = "configured";
    } else {
      state.deploymentBlock = await findDeploymentBlockByCode(rpcCall, state.proxy, safeLatest);
      state.deploymentDetection = "eth_getCode-binary-search";
    }
    log?.(`[Flap Factory] 定位部署区块 ${state.deploymentBlock}（${state.deploymentDetection}）`);
  }
  if (!state.deploymentTxHash && !state.deploymentTxChecked) {
    const creation = await findProxyCreationTransaction(rpcCall, state.proxy, state.deploymentBlock);
    state.deploymentTxChecked = true;
    if (creation) {
      state.deploymentTxHash = creation.txHash;
      state.deployer = creation.deployer;
      log?.(`[Flap Factory] 定位部署交易 ${creation.txHash}`);
    }
  }
  let implementationChange = null;
  const allChanges = [];
  const safeBlockTag = numberToHex(safeLatest);

  if (cfg.scanRealtime) {
    if (!Number.isFinite(state.headLastScannedBlock)) {
      state.headLastScannedBlock = Math.max(state.deploymentBlock - 1, safeLatest - cfg.realtimeBootstrapBlocks);
    }
    if (!Number.isFinite(state.lastScannedBlock)) state.lastScannedBlock = state.headLastScannedBlock;
    if (state.headLastScannedBlock <= safeLatest) {
      const frontierBlock = Math.min(safeLatest, state.headLastScannedBlock + 1);
      const fromBlock = Math.max(
        state.deploymentBlock,
        safeLatest - cfg.realtimeMaxBlocksPerRun + 1,
        frontierBlock - cfg.realtimeRescanBlocks + 1,
      );
      const [range, detectedImplementationChange] = await Promise.all([
        scanStateEventRange({
          state,
          rpcCall,
          fromBlock,
          toBlock: safeLatest,
          blockTag: safeBlockTag,
          preserveTransitions: true,
          retryPending: true,
          persistState,
          log,
        }),
        refreshImplementation({ state, rpcCall, log }),
      ]);
      implementationChange = detectedImplementationChange;
      allChanges.push(...range.changes);
      state.headLastScannedBlock = Math.max(state.headLastScannedBlock, range.toBlock);
      if (state.lastScannedBlock >= fromBlock - 1) state.lastScannedBlock = Math.max(state.lastScannedBlock, range.toBlock);
    } else if (!state.currentImplementation) {
      implementationChange = await refreshImplementation({ state, rpcCall, log });
    }
    state.lastRealtimeRunAt = nowText();
  }

  if (cfg.scanCatchup) {
    if (!Number.isFinite(state.lastScannedBlock)) {
      state.lastScannedBlock = Math.max(state.deploymentBlock - 1, safeLatest - cfg.realtimeBootstrapBlocks);
    }
    const catchupTarget = Math.min(safeLatest, state.headLastScannedBlock || safeLatest);
    if (state.lastScannedBlock < catchupTarget) {
      const fromBlock = state.lastScannedBlock + 1;
      const toBlock = Math.min(catchupTarget, fromBlock + cfg.catchupMaxBlocksPerRun - 1);
      const range = await scanStateEventRange({
        state,
        rpcCall,
        fromBlock,
        toBlock,
        blockTag: safeBlockTag,
        persistState,
        log,
      });
      allChanges.push(...range.changes);
      state.lastScannedBlock = Math.max(state.lastScannedBlock, range.toBlock);
    }
    state.lastCatchupRunAt = nowText();
  }

  if (cfg.scanAssets) {
    allChanges.push(...await refreshKnownAssets({
      state,
      rpcCall,
      limit: cfg.assetRefreshPerRun,
      blockTag: safeBlockTag,
      persistState,
      log,
    }));
  }
  state.lastRunAt = nowText();
  const verificationHealth = refreshCandidateVerificationHealth(state);
  state.lastError = verificationHealth.failingCount > 0
    ? `候选复核失败 ${verificationHealth.failingCount} 个：${verificationHealth.lastError}`
    : "";
  return {
    changed: allChanges.length > 0 || Boolean(implementationChange),
    changes: dedupeChanges(allChanges),
    implementationChange,
    state,
  };
}

export function mergePendingFactoryPoolChanges(pending = [], changes = []) {
  const merged = [...(pending || [])];
  for (const change of changes || []) {
    const address = change.current?.quoteToken;
    if (!address) continue;
    const duplicateIndex = merged.findIndex(item =>
      item.current?.quoteToken === address
      && item.type === change.type
      && item.current?.fingerprint === change.current?.fingerprint);
    if (duplicateIndex >= 0) {
      merged[duplicateIndex] = change;
      continue;
    }
    const previousIndex = merged.findLastIndex(item => item.current?.quoteToken === address);
    const previousPending = previousIndex >= 0 ? merged[previousIndex] : null;
    if (previousPending?.type === "added" && change.type === "modified") {
      merged[previousIndex] = { ...change, type: "added", previous: previousPending.previous };
      continue;
    }
    merged.push(change);
  }
  return merged;
}
