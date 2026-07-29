import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export const FACTORY_POOL_SCHEMA_VERSION = 6;
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

const ZERO_WORD = "0".repeat(64);

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

export function extractFactoryTransactionCandidates(transaction, proxy = FLAP_FACTORY_PROXY) {
  if (normalizeAddress(transaction?.to) !== normalizeAddress(proxy)) return [];
  const input = String(transaction?.input || transaction?.data || "");
  if (!/^0x[a-fA-F0-9]{8,}$/.test(input)) return [];
  const selector = input.slice(0, 10).toLowerCase();
  return extractAddressWords(input).map(quoteToken => ({
    quoteToken,
    selector,
    txHash: String(transaction?.hash || "").toLowerCase(),
    blockNumber: hexToNumber(transaction?.blockNumber),
    source: "transaction",
  }));
}

export function extractFactoryLogCandidates(logEntry, proxy = FLAP_FACTORY_PROXY) {
  if (normalizeAddress(logEntry?.address) !== normalizeAddress(proxy)) return [];
  const topic0 = String(logEntry?.topics?.[0] || "").toLowerCase();
  if (topic0 === QUOTE_TOKEN_CONFIGURATION_EVENT_TOPIC || topic0 === QUOTE_TOKEN_CONFIGURATION_V2_EVENT_TOPIC) {
    const data = String(logEntry?.data || "").replace(/^0x/i, "");
    const quoteToken = /^[a-fA-F0-9]{64,}$/.test(data)
      ? normalizeAddress(`0x${data.slice(24, 64)}`)
      : "";
    return quoteToken ? [{
      quoteToken,
      selector: "",
      topic0,
      txHash: String(logEntry?.transactionHash || "").toLowerCase(),
      blockNumber: hexToNumber(logEntry?.blockNumber),
      logIndex: hexToNumber(logEntry?.logIndex),
      source: "event",
    }] : [];
  }
  if (topic0 === QUOTE_TOKEN_CREATION_DISABLED_EVENT_TOPIC) {
    const quoteToken = extractAddressWords(logEntry?.topics?.[1] || "")[0]
      || extractAddressWords(logEntry?.data || "")[0]
      || "";
    return quoteToken ? [{
      quoteToken,
      selector: QUOTE_TOKEN_CREATION_DISABLED_SELECTOR,
      topic0,
      txHash: String(logEntry?.transactionHash || "").toLowerCase(),
      blockNumber: hexToNumber(logEntry?.blockNumber),
      logIndex: hexToNumber(logEntry?.logIndex),
      source: "event",
    }] : [];
  }
  const addresses = new Set();
  for (const topic of (logEntry?.topics || []).slice(1)) {
    for (const address of extractAddressWords(topic)) addresses.add(address);
  }
  for (const address of extractAddressWords(logEntry?.data || "")) addresses.add(address);
  return [...addresses].map(quoteToken => ({
    quoteToken,
    selector: "",
    topic0,
    txHash: String(logEntry?.transactionHash || "").toLowerCase(),
    blockNumber: hexToNumber(logEntry?.blockNumber),
    logIndex: hexToNumber(logEntry?.logIndex),
    source: "event",
  }));
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
  };
  delete migrated.enabled;
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
    fallbackLastScannedBlock: null,
    lastScannedBlock: null,
    historyLogLastScannedBlock: null,
    historyBlockLastScannedBlock: null,
    historyBackwardLogCursor: null,
    historyStateEventCursor: null,
    historyBackwardBlockCursor: null,
    historyLastScannedBlock: null,
    currentImplementation: "",
    implementationSelectors: [],
    implementationHistory: [],
    proxyUpgradeEvents: [],
    candidates: {},
    assets: {},
    relatedSelectors: {},
    blockCheckpoints: {},
    assetRefreshCursor: 0,
    pendingChanges: [],
    pendingImplementationChange: null,
    lastRealtimeRunAt: "",
    lastCatchupRunAt: "",
    lastHistoryRunAt: "",
    lastRunAt: "",
    lastError: "",
  };
}

export function migrateFactoryPoolState(raw, proxy = FLAP_FACTORY_PROXY) {
  const base = createFactoryPoolState(proxy);
  const previousSchemaVersion = Number(raw?.schemaVersion) || 0;
  const state = raw && typeof raw === "object" ? { ...base, ...raw } : base;
  state.schemaVersion = FACTORY_POOL_SCHEMA_VERSION;
  state.chainId = BSC_CHAIN_ID;
  state.proxy = normalizeAddress(proxy);
  for (const key of ["candidates", "assets", "relatedSelectors", "blockCheckpoints"]) {
    if (!state[key] || typeof state[key] !== "object" || Array.isArray(state[key])) state[key] = {};
  }
  if (!Number.isFinite(state.fallbackLastScannedBlock) && Number.isFinite(state.headLastScannedBlock)) {
    state.fallbackLastScannedBlock = state.headLastScannedBlock;
  }
  state.assets = Object.fromEntries(Object.entries(state.assets).map(([address, asset]) => [address, migrateFactoryPoolAsset(asset)]));
  for (const candidate of Object.values(state.candidates)) {
    if (!candidate || typeof candidate !== "object") continue;
    delete candidate.enabled;
    if (typeof candidate.creationDisabled !== "boolean") candidate.creationDisabled = false;
    if (typeof candidate.effectiveEnabled !== "boolean") {
      candidate.effectiveEnabled = Boolean(candidate.configured) && !candidate.creationDisabled;
    }
  }
  if (previousSchemaVersion < 6) state.historyStateEventCursor = null;
  delete state.historyConfigEventCursor;
  delete state.processedTransactions;
  if (!Array.isArray(state.implementationHistory)) state.implementationHistory = [];
  if (!Array.isArray(state.proxyUpgradeEvents)) state.proxyUpgradeEvents = [];
  if (!Array.isArray(state.implementationSelectors)) state.implementationSelectors = [];
  if (!Array.isArray(state.pendingChanges)) state.pendingChanges = [];
  return state;
}

export function loadFactoryPoolState(path, proxy = FLAP_FACTORY_PROXY) {
  try {
    if (existsSync(path)) return migrateFactoryPoolState(JSON.parse(readFileSync(path, "utf-8")), proxy);
  } catch {}
  return createFactoryPoolState(proxy);
}

export function saveFactoryPoolState(path, state) {
  const tmp = `${path}.tmp`;
  state.schemaVersion = FACTORY_POOL_SCHEMA_VERSION;
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
  renameSync(tmp, path);
}

function candidateKey(item) {
  return `${item.source || "unknown"}:${item.txHash || ""}:${item.logIndex ?? ""}:${item.selector || item.topic0 || ""}:${item.quoteToken}`;
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
  };
  const key = candidateKey({ ...item, quoteToken });
  if (current.sources.some(source => source.key === key)) return false;
  current.firstSeenBlock = current.firstSeenBlock == null
    ? (item.blockNumber || null)
    : Math.min(current.firstSeenBlock, item.blockNumber || current.firstSeenBlock);
  current.lastSeenBlock = Math.max(current.lastSeenBlock || 0, item.blockNumber || 0) || null;
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
  if (current.sources.length > 20) current.sources.splice(1, current.sources.length - 20);
  state.candidates[quoteToken] = current;
  if (/^0x[a-f0-9]{8}$/.test(item.selector || "")) {
    const selector = item.selector.toLowerCase();
    const related = state.relatedSelectors[selector] || {
      selector,
      firstSeenBlock: item.blockNumber || null,
      lastSeenBlock: item.blockNumber || null,
      count: 0,
      quoteTokens: [],
    };
    related.lastSeenBlock = Math.max(related.lastSeenBlock || 0, item.blockNumber || 0) || null;
    related.count++;
    related.implementation = state.currentImplementation || related.implementation || "";
    if (!related.quoteTokens.includes(quoteToken)) related.quoteTokens.push(quoteToken);
    state.relatedSelectors[selector] = related;
  }
  return true;
}

function updateHistoryFloor(state) {
  const values = [state.historyLogLastScannedBlock, state.historyBlockLastScannedBlock]
    .filter(value => Number.isFinite(value));
  state.historyLastScannedBlock = values.length > 0 ? Math.min(...values) : null;
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

async function fetchReverseRangeLogs(rpcCall, proxy, fromBlock, toBlock, topics) {
  if (fromBlock > toBlock) return { logs: [], fromBlock };
  let start = fromBlock;
  let lastError;
  while (start <= toBlock) {
    try {
      const filter = {
        address: proxy,
        fromBlock: numberToHex(start),
        toBlock: numberToHex(toBlock),
      };
      if (topics) filter.topics = topics;
      const logs = await rpcCall("eth_getLogs", [filter]);
      return { logs: logs || [], fromBlock: start };
    } catch (error) {
      lastError = error;
      if (start === toBlock) break;
      start = toBlock - Math.floor((toBlock - start) / 2);
    }
  }
  throw lastError || new Error(`无法反向读取 Factory 日志：${fromBlock}-${toBlock}`);
}

async function collectTransactionsForLogs(rpcCall, logs, rpcBatch) {
  const hashes = [...new Set((logs || []).map(log => String(log.transactionHash || "").toLowerCase()).filter(Boolean))];
  if (typeof rpcBatch === "function") {
    const transactions = [];
    for (let offset = 0; offset < hashes.length; offset += 50) {
      const chunk = hashes.slice(offset, offset + 50);
      const results = await rpcBatch(chunk.map(hash => ({ method: "eth_getTransactionByHash", params: [hash] })));
      transactions.push(...results.filter(Boolean));
    }
    return transactions;
  }
  const transactions = [];
  for (const hash of hashes) {
    const transaction = await rpcCall("eth_getTransactionByHash", [hash], { requireResult: true });
    if (transaction) transactions.push(transaction);
  }
  return transactions;
}

function collectCandidatesFromLogsAndTransactions(logs, transactions, proxy) {
  const items = [];
  for (const logEntry of logs || []) items.push(...extractFactoryLogCandidates(logEntry, proxy));
  for (const transaction of transactions || []) items.push(...extractFactoryTransactionCandidates(transaction, proxy));
  return items;
}

function recordProxyUpgradeEvents(state, logs) {
  for (const logEntry of logs || []) {
    if (String(logEntry?.topics?.[0] || "").toLowerCase() !== UPGRADED_EVENT_TOPIC) continue;
    const implementation = extractAddressWords(logEntry.topics?.[1] || "", { includeZero: false })[0] || "";
    if (!implementation) continue;
    const event = {
      key: `${String(logEntry.transactionHash || "").toLowerCase()}:${hexToNumber(logEntry.logIndex)}`,
      implementation,
      txHash: String(logEntry.transactionHash || "").toLowerCase(),
      blockNumber: hexToNumber(logEntry.blockNumber),
      logIndex: hexToNumber(logEntry.logIndex),
    };
    if (state.proxyUpgradeEvents.some(existing => existing.key === event.key)) continue;
    state.proxyUpgradeEvents.push(event);
    if (state.proxyUpgradeEvents.length > 100) state.proxyUpgradeEvents.splice(0, state.proxyUpgradeEvents.length - 100);
    const history = [...state.implementationHistory].reverse().find(item => item.current === implementation && !item.txHash);
    if (history) {
      history.txHash = event.txHash;
      history.upgradeBlock = event.blockNumber;
    }
  }
}

async function scanFullBlockRange(rpcCall, proxy, fromBlock, toBlock, rpcBatch) {
  const items = [];
  const checkpoints = {};
  const blockNumbers = [];
  for (let blockNumber = fromBlock; blockNumber <= toBlock; blockNumber++) blockNumbers.push(blockNumber);
  const blocks = typeof rpcBatch === "function"
    ? await rpcBatch(blockNumbers.map(blockNumber => ({ method: "eth_getBlockByNumber", params: [numberToHex(blockNumber), true] })))
    : await Promise.all(blockNumbers.map(blockNumber => rpcCall("eth_getBlockByNumber", [numberToHex(blockNumber), true], { requireResult: true })));
  for (let index = 0; index < blockNumbers.length; index++) {
    const blockNumber = blockNumbers[index];
    const block = blocks[index];
    if (!block) throw new Error(`区块 ${blockNumber} 返回为空`);
    checkpoints[blockNumber] = String(block.hash || "").toLowerCase();
    for (const transaction of block.transactions || []) {
      items.push(...extractFactoryTransactionCandidates(transaction, proxy));
    }
  }
  return { items, checkpoints };
}

export function classifyFactoryPoolChange(previous, current) {
  if (!previous) return current.configured ? "added" : "disabled";
  if (!previous.configured && current.configured) return "added";
  if (previous.configured && !current.configured) return "disabled";
  if (current.configured && !previous.creationDisabled && current.creationDisabled) return "paused";
  if (current.configured && previous.creationDisabled && !current.creationDisabled) return "resumed";
  return "modified";
}

async function verifyCandidates({ state, rpcCall, items, blockTag = "latest" }) {
  const unique = new Map();
  for (const item of items) {
    const address = normalizeAddress(item.quoteToken);
    if (!address) continue;
    if (!unique.has(address) || (!unique.get(address)?.selector && item.selector)) unique.set(address, item);
  }

  const changes = [];
  for (const [quoteToken, source] of unique) {
    let decoded;
    let creationDisabled;
    try {
      const [configurationRaw, creationDisabledRaw] = await Promise.all([
        rpcCall("eth_call", [{ to: state.proxy, data: buildQuoteTokenConfigurationCall(quoteToken) }, blockTag], { requireResult: true }),
        rpcCall("eth_call", [{ to: state.proxy, data: buildQuoteTokenCreationDisabledCall(quoteToken) }, blockTag], { requireResult: true }),
      ]);
      decoded = decodeQuoteTokenConfiguration(configurationRaw);
      creationDisabled = decodeBooleanResult(creationDisabledRaw);
    } catch (error) {
      const candidate = state.candidates[quoteToken];
      if (candidate) candidate.lastVerifyError = error.message;
      continue;
    }
    const previous = state.assets[quoteToken];
    if (source.source !== "periodic-refresh" || !state.candidates[quoteToken]) rememberCandidate(state, { ...source, quoteToken });
    const candidate = state.candidates[quoteToken];
    candidate.lastVerifiedAt = nowText();
    candidate.lastVerifyError = "";
    candidate.configured = decoded.configured;
    candidate.creationDisabled = creationDisabled;
    candidate.effectiveEnabled = decoded.configured && !creationDisabled;
    if (!decoded.configurationPresent && !previous) continue;

    const fingerprint = hashValue(`${decoded.fingerprint}:${creationDisabled ? 1 : 0}`);

    const next = {
      quoteToken,
      configured: decoded.configured,
      configurationPresent: decoded.configurationPresent,
      creationDisabled,
      effectiveEnabled: decoded.configured && !creationDisabled,
      fields: decoded.fields,
      values: decoded.values,
      configurationFingerprint: decoded.fingerprint,
      fingerprint,
      firstSeenAt: previous?.firstSeenAt || nowText(),
      firstSeenBlock: previous?.firstSeenBlock ?? source.blockNumber ?? null,
      lastChangedAt: previous?.fingerprint === fingerprint ? previous.lastChangedAt : nowText(),
      lastSeenBlock: source.blockNumber ?? previous?.lastSeenBlock ?? null,
      lastTxHash: source.txHash || previous?.lastTxHash || "",
      lastSelector: source.selector || previous?.lastSelector || "",
      source: source.source || previous?.source || "",
      name: previous?.name || "",
      symbol: previous?.symbol || "",
      metadataSource: previous?.metadataSource || "",
      metadataUpdatedAt: previous?.metadataUpdatedAt || "",
      metadataNextRetryAt: previous?.metadataNextRetryAt || "",
      metadataError: previous?.metadataError || "",
    };
    state.assets[quoteToken] = next;
    if (!previous || previous.fingerprint !== next.fingerprint) {
      changes.push({ type: classifyFactoryPoolChange(previous, next), previous: previous || null, current: next });
    }
  }
  return changes;
}

async function refreshKnownAssets({ state, rpcCall, limit, blockTag }) {
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
    items: selected.map(quoteToken => ({ quoteToken, source: "periodic-refresh" })),
  });
}

async function rollbackReorgIfNeeded({ state, rpcCall, log }) {
  const blocks = Object.keys(state.blockCheckpoints).map(Number).filter(Number.isFinite).sort((a, b) => b - a);
  const highestCursor = Math.max(
    state.headLastScannedBlock || 0,
    state.fallbackLastScannedBlock || 0,
    state.lastScannedBlock || 0,
  );
  for (const blockNumber of blocks) {
    if (blockNumber > highestCursor) continue;
    const block = await rpcCall("eth_getBlockByNumber", [numberToHex(blockNumber), false], { requireResult: true });
    const actual = String(block?.hash || "").toLowerCase();
    const expected = String(state.blockCheckpoints[blockNumber] || "").toLowerCase();
    if (actual && actual === expected) return null;
    const rollbackTo = Math.max(state.deploymentBlock - 1, blockNumber - 1);
    if ((state.headLastScannedBlock || 0) >= blockNumber) state.headLastScannedBlock = rollbackTo;
    if ((state.fallbackLastScannedBlock || 0) >= blockNumber) state.fallbackLastScannedBlock = rollbackTo;
    if ((state.lastScannedBlock || 0) >= blockNumber) state.lastScannedBlock = rollbackTo;
    for (const key of Object.keys(state.blockCheckpoints)) {
      if (Number(key) >= blockNumber) delete state.blockCheckpoints[key];
    }
    log?.(`[Flap Factory] 检测到确认链重组，相关游标回退至 ${rollbackTo}`);
    return { blockNumber, expected, actual, rollbackTo };
  }
  return null;
}

function dedupeChanges(changes) {
  const byAddress = new Map();
  for (const change of changes) byAddress.set(change.current.quoteToken, change);
  return [...byAddress.values()];
}

async function scanForwardRange({ state, rpcCall, rpcBatch, fromBlock, toBlock, blockTag }) {
  if (fromBlock > toBlock) return { changes: [], toBlock: fromBlock - 1, checkpoints: {} };
  const logRange = await fetchRangeLogs(rpcCall, state.proxy, fromBlock, toBlock);
  const scannedTo = logRange.toBlock;
  recordProxyUpgradeEvents(state, logRange.logs);
  const transactions = await collectTransactionsForLogs(rpcCall, logRange.logs, rpcBatch);
  const fullBlocks = await scanFullBlockRange(rpcCall, state.proxy, fromBlock, scannedTo, rpcBatch);
  const items = [
    ...collectCandidatesFromLogsAndTransactions(logRange.logs, transactions, state.proxy),
    ...fullBlocks.items,
  ];
  return {
    changes: await verifyCandidates({ state, rpcCall, items, blockTag }),
    toBlock: scannedTo,
    checkpoints: fullBlocks.checkpoints,
  };
}

async function scanStateEventRange({ state, rpcCall, fromBlock, toBlock, blockTag }) {
  if (fromBlock > toBlock) return { changes: [], toBlock: fromBlock - 1 };
  const logRange = await fetchRangeLogs(
    rpcCall,
    state.proxy,
    fromBlock,
    toBlock,
    [FACTORY_POOL_STATE_EVENT_TOPICS],
  );
  const items = (logRange.logs || []).flatMap(logEntry => extractFactoryLogCandidates(logEntry, state.proxy));
  return {
    changes: await verifyCandidates({ state, rpcCall, items, blockTag }),
    toBlock: logRange.toBlock,
  };
}

function trimBlockCheckpoints(state, confirmations) {
  const blocks = Object.keys(state.blockCheckpoints).map(Number).sort((a, b) => a - b);
  while (blocks.length > Math.max(40, confirmations * 8)) delete state.blockCheckpoints[blocks.shift()];
}

export async function runFactoryPoolScan({ state, rpcCall, rpcBatch, config = {}, log } = {}) {
  if (!state || typeof rpcCall !== "function") throw new Error("Factory 扫描缺少 state 或 rpcCall");
  const cfg = {
    confirmations: 0,
    deploymentBlock: 0,
    scanRealtime: true,
    scanFallback: false,
    scanCatchup: true,
    scanHistory: true,
    realtimeBootstrapBlocks: 20,
    realtimeMaxBlocksPerRun: 20,
    catchupMaxBlocksPerRun: 2_000,
    historyLogChunkBlocks: 2_000,
    historyBlockChunkBlocks: 10,
    historyBackwardLogChunkBlocks: 2_000,
    historyConfigEventChunkBlocks: 5_000,
    historyConfigEventChunksPerRun: 5,
    historyBackwardBlockChunkBlocks: 10,
    deepHistoryBlockScan: true,
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
    state.historyLogLastScannedBlock = state.deploymentBlock - 1;
    state.historyBlockLastScannedBlock = state.deploymentBlock - 1;
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
  if (!Number.isFinite(state.historyLogLastScannedBlock)) state.historyLogLastScannedBlock = state.deploymentBlock - 1;
  if (!Number.isFinite(state.historyBlockLastScannedBlock)) state.historyBlockLastScannedBlock = state.deploymentBlock - 1;

  let implementationChange = null;
  const allChanges = [];
  const safeBlockTag = numberToHex(safeLatest);
  let reorg = null;

  if (cfg.scanRealtime) {
    if (!Number.isFinite(state.headLastScannedBlock)) {
      state.headLastScannedBlock = Math.max(state.deploymentBlock - 1, safeLatest - cfg.realtimeBootstrapBlocks);
    }
    if (!Number.isFinite(state.lastScannedBlock)) state.lastScannedBlock = state.headLastScannedBlock;
    if (state.headLastScannedBlock < safeLatest) {
      const desiredFrom = state.headLastScannedBlock + 1;
      const fromBlock = Math.max(desiredFrom, safeLatest - cfg.realtimeMaxBlocksPerRun + 1);
      const [range, detectedImplementationChange] = await Promise.all([
        scanStateEventRange({ state, rpcCall, fromBlock, toBlock: safeLatest, blockTag: safeBlockTag }),
        refreshImplementation({ state, rpcCall, log }),
      ]);
      implementationChange = detectedImplementationChange;
      allChanges.push(...range.changes);
      state.headLastScannedBlock = range.toBlock;
      if (state.lastScannedBlock >= fromBlock - 1) state.lastScannedBlock = Math.max(state.lastScannedBlock, range.toBlock);
    } else if (!state.currentImplementation) {
      implementationChange = await refreshImplementation({ state, rpcCall, log });
    }
    state.lastRealtimeRunAt = nowText();
  }

  if (cfg.scanFallback) {
    if (!Number.isFinite(state.fallbackLastScannedBlock)) {
      state.fallbackLastScannedBlock = Math.max(state.deploymentBlock - 1, safeLatest - cfg.realtimeBootstrapBlocks);
    }
    reorg = await rollbackReorgIfNeeded({ state, rpcCall, log });
    if (state.fallbackLastScannedBlock < safeLatest) {
      const fromBlock = state.fallbackLastScannedBlock + 1;
      const toBlock = Math.min(safeLatest, fromBlock + cfg.realtimeMaxBlocksPerRun - 1);
      const range = await scanForwardRange({ state, rpcCall, rpcBatch, fromBlock, toBlock, blockTag: safeBlockTag });
      allChanges.push(...range.changes);
      state.fallbackLastScannedBlock = range.toBlock;
      Object.assign(state.blockCheckpoints, range.checkpoints);
      trimBlockCheckpoints(state, cfg.confirmations);
    }
    allChanges.push(...await refreshKnownAssets({ state, rpcCall, limit: cfg.assetRefreshPerRun, blockTag: safeBlockTag }));
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
      });
      allChanges.push(...range.changes);
      state.lastScannedBlock = Math.max(state.lastScannedBlock, range.toBlock);
    }
    if (!Number.isFinite(state.historyStateEventCursor)) state.historyStateEventCursor = safeLatest + 1;
    for (let index = 0; index < cfg.historyConfigEventChunksPerRun; index++) {
      if (state.historyStateEventCursor <= state.deploymentBlock) break;
      const toBlock = state.historyStateEventCursor - 1;
      const fromBlock = Math.max(state.deploymentBlock, toBlock - cfg.historyConfigEventChunkBlocks + 1);
      const logRange = await fetchReverseRangeLogs(
        rpcCall,
        state.proxy,
        fromBlock,
        toBlock,
        [FACTORY_POOL_STATE_EVENT_TOPICS],
      );
      const items = (logRange.logs || []).flatMap(logEntry => extractFactoryLogCandidates(logEntry, state.proxy));
      allChanges.push(...await verifyCandidates({ state, rpcCall, items, blockTag: safeBlockTag }));
      state.historyStateEventCursor = logRange.fromBlock;
    }
    state.lastCatchupRunAt = nowText();
  }

  if (cfg.scanHistory) {
    if (!Number.isFinite(state.historyBackwardLogCursor)) state.historyBackwardLogCursor = safeLatest + 1;
    const backwardLogFloor = Math.max(state.deploymentBlock, state.historyLogLastScannedBlock + 1);
    if (state.historyBackwardLogCursor > backwardLogFloor) {
      const toBlock = state.historyBackwardLogCursor - 1;
      const fromBlock = Math.max(backwardLogFloor, toBlock - cfg.historyBackwardLogChunkBlocks + 1);
      const logRange = await fetchReverseRangeLogs(rpcCall, state.proxy, fromBlock, toBlock);
      recordProxyUpgradeEvents(state, logRange.logs);
      const transactions = await collectTransactionsForLogs(rpcCall, logRange.logs, rpcBatch);
      const items = collectCandidatesFromLogsAndTransactions(logRange.logs, transactions, state.proxy);
      allChanges.push(...await verifyCandidates({ state, rpcCall, items, blockTag: safeBlockTag }));
      state.historyBackwardLogCursor = logRange.fromBlock;
    }

    if (cfg.deepHistoryBlockScan) {
      if (!Number.isFinite(state.historyBackwardBlockCursor)) state.historyBackwardBlockCursor = safeLatest + 1;
      const backwardBlockFloor = Math.max(state.deploymentBlock, state.historyBlockLastScannedBlock + 1);
      if (state.historyBackwardBlockCursor > backwardBlockFloor) {
        const toBlock = state.historyBackwardBlockCursor - 1;
        const fromBlock = Math.max(backwardBlockFloor, toBlock - cfg.historyBackwardBlockChunkBlocks + 1);
        const fullBlocks = await scanFullBlockRange(rpcCall, state.proxy, fromBlock, toBlock, rpcBatch);
        allChanges.push(...await verifyCandidates({ state, rpcCall, items: fullBlocks.items, blockTag: safeBlockTag }));
        state.historyBackwardBlockCursor = fromBlock;
      }
    }

    const forwardLogTarget = Math.min(safeLatest, state.lastScannedBlock, state.historyBackwardLogCursor - 1);
    if (state.historyLogLastScannedBlock < forwardLogTarget) {
      const fromBlock = state.historyLogLastScannedBlock + 1;
      const toBlock = Math.min(forwardLogTarget, fromBlock + cfg.historyLogChunkBlocks - 1);
      const logRange = await fetchRangeLogs(rpcCall, state.proxy, fromBlock, toBlock);
      recordProxyUpgradeEvents(state, logRange.logs);
      const transactions = await collectTransactionsForLogs(rpcCall, logRange.logs, rpcBatch);
      const items = collectCandidatesFromLogsAndTransactions(logRange.logs, transactions, state.proxy);
      allChanges.push(...await verifyCandidates({ state, rpcCall, items, blockTag: safeBlockTag }));
      state.historyLogLastScannedBlock = logRange.toBlock;
    }

    const forwardBlockTarget = Math.min(safeLatest, state.lastScannedBlock, (state.historyBackwardBlockCursor ?? safeLatest + 1) - 1);
    if (cfg.deepHistoryBlockScan && state.historyBlockLastScannedBlock < forwardBlockTarget) {
      const fromBlock = state.historyBlockLastScannedBlock + 1;
      const toBlock = Math.min(forwardBlockTarget, fromBlock + cfg.historyBlockChunkBlocks - 1);
      const fullBlocks = await scanFullBlockRange(rpcCall, state.proxy, fromBlock, toBlock, rpcBatch);
      allChanges.push(...await verifyCandidates({ state, rpcCall, items: fullBlocks.items, blockTag: safeBlockTag }));
      state.historyBlockLastScannedBlock = toBlock;
    }
    state.lastHistoryRunAt = nowText();
  }

  updateHistoryFloor(state);
  state.lastRunAt = nowText();
  state.lastError = "";
  return {
    changed: allChanges.length > 0 || Boolean(implementationChange),
    changes: dedupeChanges(allChanges),
    implementationChange,
    reorg,
    state,
  };
}

export function mergePendingFactoryPoolChanges(pending = [], changes = []) {
  const byAddress = new Map((pending || []).map(change => [change.current.quoteToken, change]));
  for (const change of changes || []) {
    const previousPending = byAddress.get(change.current.quoteToken);
    byAddress.set(change.current.quoteToken, previousPending?.type === "added"
      ? { ...change, type: "added", previous: previousPending.previous }
      : change);
  }
  return [...byAddress.values()];
}
