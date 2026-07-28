import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export const FACTORY_POOL_SCHEMA_VERSION = 3;
export const BSC_CHAIN_ID = 56;
export const BNB_QUOTE_TOKEN = "0x0000000000000000000000000000000000000000";
export const FLAP_FACTORY_PROXY = "0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0";
export const QUOTE_CONFIG_SELECTOR = "0x26ef20d5";
export const EIP1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
export const UPGRADED_EVENT_TOPIC = "0xbc7cd75a20ee27fd9adebab32041f75521455e56b11f8c68e9c7f1bdb3e0f2c";
export const QUOTE_TOKEN_CONFIGURATION_EVENT_TOPIC = "0x7c4631d6e19bd6f974dc94a65d6b5e91d7b1b472d5d206bd8c61309aa849d518";

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

export function decodeQuoteTokenConfiguration(result) {
  const hex = String(result || "").replace(/^0x/i, "").toLowerCase();
  if (!/^[a-f0-9]{320,}$/.test(hex)) throw new Error(`底池配置返回长度无效：${Math.floor(hex.length / 2)} bytes`);
  const fields = Array.from({ length: 5 }, (_, index) => `0x${hex.slice(index * 64, (index + 1) * 64)}`);
  const values = fields.map(field => BigInt(field).toString());
  return {
    fields,
    values,
    enabled: BigInt(fields[0]) === 1n,
    configured: fields.some(field => field !== `0x${ZERO_WORD}`),
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
  if (topic0 === QUOTE_TOKEN_CONFIGURATION_EVENT_TOPIC) {
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
    historyLogLastScannedBlock: null,
    historyBlockLastScannedBlock: null,
    historyBackwardLogCursor: null,
    historyConfigEventCursor: null,
    historyBackwardBlockCursor: null,
    historyLastScannedBlock: null,
    currentImplementation: "",
    implementationSelectors: [],
    implementationHistory: [],
    proxyUpgradeEvents: [],
    candidates: {},
    assets: {},
    relatedSelectors: {},
    processedTransactions: {},
    blockCheckpoints: {},
    assetRefreshCursor: 0,
    pendingChanges: [],
    pendingImplementationChange: null,
    lastRealtimeRunAt: "",
    lastHistoryRunAt: "",
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
  for (const key of ["candidates", "assets", "relatedSelectors", "processedTransactions", "blockCheckpoints"]) {
    if (!state[key] || typeof state[key] !== "object" || Array.isArray(state[key])) state[key] = {};
  }
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
  if (item.txHash) return `tx:${item.txHash}:${item.quoteToken}`;
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
  if (item.txHash) state.processedTransactions[item.txHash] = item.blockNumber || 0;
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

async function fetchRangeLogs(rpcCall, proxy, fromBlock, toBlock) {
  if (fromBlock > toBlock) return { logs: [], toBlock };
  let end = toBlock;
  let lastError;
  while (end >= fromBlock) {
    try {
      const logs = await rpcCall("eth_getLogs", [{
        address: proxy,
        fromBlock: numberToHex(fromBlock),
        toBlock: numberToHex(end),
      }]);
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
    try {
      const raw = await rpcCall("eth_call", [{ to: state.proxy, data: buildQuoteTokenConfigurationCall(quoteToken) }, blockTag], { requireResult: true });
      decoded = decodeQuoteTokenConfiguration(raw);
    } catch (error) {
      const candidate = state.candidates[quoteToken];
      if (candidate) candidate.lastVerifyError = error.message;
      continue;
    }
    const previous = state.assets[quoteToken];
    if (!decoded.configured && !previous && !state.candidates[quoteToken]) continue;
    if (source.source !== "periodic-refresh" || !state.candidates[quoteToken]) rememberCandidate(state, { ...source, quoteToken });
    const candidate = state.candidates[quoteToken];
    candidate.lastVerifiedAt = nowText();
    candidate.lastVerifyError = "";
    candidate.configured = decoded.configured;
    candidate.enabled = decoded.enabled;
    if (!decoded.configured && !previous) continue;

    const next = {
      quoteToken,
      enabled: decoded.enabled,
      configured: decoded.configured,
      fields: decoded.fields,
      values: decoded.values,
      fingerprint: decoded.fingerprint,
      firstSeenAt: previous?.firstSeenAt || nowText(),
      firstSeenBlock: previous?.firstSeenBlock ?? source.blockNumber ?? null,
      lastChangedAt: previous?.fingerprint === decoded.fingerprint ? previous.lastChangedAt : nowText(),
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
      changes.push({ type: !previous ? "added" : next.enabled ? "modified" : "disabled", previous: previous || null, current: next });
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
  const highestCursor = Math.max(state.headLastScannedBlock || 0, state.lastScannedBlock || 0);
  for (const blockNumber of blocks) {
    if (blockNumber > highestCursor) continue;
    const block = await rpcCall("eth_getBlockByNumber", [numberToHex(blockNumber), false], { requireResult: true });
    const actual = String(block?.hash || "").toLowerCase();
    const expected = String(state.blockCheckpoints[blockNumber] || "").toLowerCase();
    if (actual && actual === expected) return null;
    const rollbackTo = Math.max(state.deploymentBlock - 1, blockNumber - 1);
    if ((state.headLastScannedBlock || 0) >= blockNumber) state.headLastScannedBlock = rollbackTo;
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

async function scanForwardRange({ state, rpcCall, rpcBatch, fromBlock, toBlock, blockTag, includeFullBlocks = true }) {
  if (fromBlock > toBlock) return { changes: [], toBlock: fromBlock - 1, checkpoints: {} };
  const logRange = await fetchRangeLogs(rpcCall, state.proxy, fromBlock, toBlock);
  const scannedTo = logRange.toBlock;
  recordProxyUpgradeEvents(state, logRange.logs);
  const transactions = await collectTransactionsForLogs(rpcCall, logRange.logs, rpcBatch);
  const fullBlocks = includeFullBlocks
    ? await scanFullBlockRange(rpcCall, state.proxy, fromBlock, scannedTo, rpcBatch)
    : { items: [], checkpoints: {} };
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

function trimBlockCheckpoints(state, confirmations) {
  const blocks = Object.keys(state.blockCheckpoints).map(Number).sort((a, b) => a - b);
  while (blocks.length > Math.max(40, confirmations * 8)) delete state.blockCheckpoints[blocks.shift()];
}

export async function runFactoryPoolScan({ state, rpcCall, rpcBatch, config = {}, log } = {}) {
  if (!state || typeof rpcCall !== "function") throw new Error("Factory 扫描缺少 state 或 rpcCall");
  const cfg = {
    confirmations: 5,
    deploymentBlock: 0,
    scanRealtime: true,
    scanHistory: true,
    realtimeBootstrapBlocks: 20,
    realtimeMaxBlocksPerRun: 20,
    catchupMaxBlocksPerRun: 100,
    historyLogChunkBlocks: 2_000,
    historyBlockChunkBlocks: 10,
    historyBackwardLogChunkBlocks: 2_000,
    historyConfigEventChunkBlocks: 50_000,
    historyBackwardBlockChunkBlocks: 10,
    deepHistoryBlockScan: true,
    assetRefreshPerRun: 10,
    ...config,
  };
  const chainId = hexToNumber(await rpcCall("eth_chainId", []));
  if (chainId !== BSC_CHAIN_ID) throw new Error(`Factory RPC chainId 错误：${chainId}，期望 ${BSC_CHAIN_ID}`);
  const latest = hexToNumber(await rpcCall("eth_blockNumber", []));
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

  const implementationChange = cfg.scanRealtime ? await refreshImplementation({ state, rpcCall, log }) : null;
  const allChanges = [];
  const safeBlockTag = numberToHex(safeLatest);
  let reorg = null;

  if (cfg.scanRealtime) {
    if (!Number.isFinite(state.headLastScannedBlock)) {
      state.headLastScannedBlock = Math.max(state.deploymentBlock - 1, safeLatest - cfg.realtimeBootstrapBlocks);
    }
    if (!Number.isFinite(state.lastScannedBlock)) state.lastScannedBlock = state.headLastScannedBlock;
    reorg = await rollbackReorgIfNeeded({ state, rpcCall, log });
    if (state.headLastScannedBlock < safeLatest) {
      const desiredFrom = state.headLastScannedBlock + 1;
      const fromBlock = Math.max(desiredFrom, safeLatest - cfg.realtimeMaxBlocksPerRun + 1);
      const range = await scanForwardRange({ state, rpcCall, rpcBatch, fromBlock, toBlock: safeLatest, blockTag: safeBlockTag });
      allChanges.push(...range.changes);
      state.headLastScannedBlock = range.toBlock;
      if (state.lastScannedBlock >= fromBlock - 1) state.lastScannedBlock = Math.max(state.lastScannedBlock, range.toBlock);
      Object.assign(state.blockCheckpoints, range.checkpoints);
      trimBlockCheckpoints(state, cfg.confirmations);
    }
    allChanges.push(...await refreshKnownAssets({ state, rpcCall, limit: cfg.assetRefreshPerRun, blockTag: safeBlockTag }));
    state.lastRealtimeRunAt = nowText();
  }

  if (cfg.scanHistory) {
    if (!Number.isFinite(state.lastScannedBlock)) {
      state.lastScannedBlock = Math.max(state.deploymentBlock - 1, safeLatest - cfg.realtimeBootstrapBlocks);
    }
    const catchupTarget = Math.min(safeLatest, state.headLastScannedBlock || safeLatest);
    if (state.lastScannedBlock < catchupTarget) {
      const fromBlock = state.lastScannedBlock + 1;
      const toBlock = Math.min(catchupTarget, fromBlock + cfg.catchupMaxBlocksPerRun - 1);
      const range = await scanForwardRange({ state, rpcCall, rpcBatch, fromBlock, toBlock, blockTag: safeBlockTag });
      allChanges.push(...range.changes);
      state.lastScannedBlock = range.toBlock;
      Object.assign(state.blockCheckpoints, range.checkpoints);
      trimBlockCheckpoints(state, cfg.confirmations);
    }

    if (!Number.isFinite(state.historyConfigEventCursor)) state.historyConfigEventCursor = safeLatest + 1;
    if (state.historyConfigEventCursor > state.deploymentBlock) {
      const toBlock = state.historyConfigEventCursor - 1;
      const fromBlock = Math.max(state.deploymentBlock, toBlock - cfg.historyConfigEventChunkBlocks + 1);
      const logRange = await fetchReverseRangeLogs(
        rpcCall,
        state.proxy,
        fromBlock,
        toBlock,
        [QUOTE_TOKEN_CONFIGURATION_EVENT_TOPIC],
      );
      const items = (logRange.logs || []).flatMap(logEntry => extractFactoryLogCandidates(logEntry, state.proxy));
      allChanges.push(...await verifyCandidates({ state, rpcCall, items, blockTag: safeBlockTag }));
      state.historyConfigEventCursor = logRange.fromBlock;
    }

    if (!Number.isFinite(state.historyBackwardLogCursor)) state.historyBackwardLogCursor = safeLatest + 1;
    if (state.historyBackwardLogCursor > state.deploymentBlock) {
      const toBlock = state.historyBackwardLogCursor - 1;
      const fromBlock = Math.max(state.deploymentBlock, toBlock - cfg.historyBackwardLogChunkBlocks + 1);
      const logRange = await fetchReverseRangeLogs(rpcCall, state.proxy, fromBlock, toBlock);
      recordProxyUpgradeEvents(state, logRange.logs);
      const transactions = await collectTransactionsForLogs(rpcCall, logRange.logs, rpcBatch);
      const items = collectCandidatesFromLogsAndTransactions(logRange.logs, transactions, state.proxy);
      allChanges.push(...await verifyCandidates({ state, rpcCall, items, blockTag: safeBlockTag }));
      state.historyBackwardLogCursor = logRange.fromBlock;
    }

    if (cfg.deepHistoryBlockScan) {
      if (!Number.isFinite(state.historyBackwardBlockCursor)) state.historyBackwardBlockCursor = safeLatest + 1;
      if (state.historyBackwardBlockCursor > state.deploymentBlock) {
        const toBlock = state.historyBackwardBlockCursor - 1;
        const fromBlock = Math.max(state.deploymentBlock, toBlock - cfg.historyBackwardBlockChunkBlocks + 1);
        const fullBlocks = await scanFullBlockRange(rpcCall, state.proxy, fromBlock, toBlock, rpcBatch);
        allChanges.push(...await verifyCandidates({ state, rpcCall, items: fullBlocks.items, blockTag: safeBlockTag }));
        state.historyBackwardBlockCursor = fromBlock;
      }
    }

    if (state.historyLogLastScannedBlock < Math.min(safeLatest, state.lastScannedBlock)) {
      const fromBlock = state.historyLogLastScannedBlock + 1;
      const toBlock = Math.min(state.lastScannedBlock, fromBlock + cfg.historyLogChunkBlocks - 1);
      const logRange = await fetchRangeLogs(rpcCall, state.proxy, fromBlock, toBlock);
      recordProxyUpgradeEvents(state, logRange.logs);
      const transactions = await collectTransactionsForLogs(rpcCall, logRange.logs, rpcBatch);
      const items = collectCandidatesFromLogsAndTransactions(logRange.logs, transactions, state.proxy);
      allChanges.push(...await verifyCandidates({ state, rpcCall, items, blockTag: safeBlockTag }));
      state.historyLogLastScannedBlock = logRange.toBlock;
    }

    if (cfg.deepHistoryBlockScan && state.historyBlockLastScannedBlock < Math.min(safeLatest, state.lastScannedBlock)) {
      const fromBlock = state.historyBlockLastScannedBlock + 1;
      const toBlock = Math.min(state.lastScannedBlock, fromBlock + cfg.historyBlockChunkBlocks - 1);
      const fullBlocks = await scanFullBlockRange(rpcCall, state.proxy, fromBlock, toBlock, rpcBatch);
      allChanges.push(...await verifyCandidates({ state, rpcCall, items: fullBlocks.items, blockTag: safeBlockTag }));
      state.historyBlockLastScannedBlock = toBlock;
    }
    state.lastHistoryRunAt = nowText();
  }

  const processedEntries = Object.entries(state.processedTransactions);
  if (processedEntries.length > 5_000) {
    processedEntries.sort((a, b) => Number(b[1]) - Number(a[1]));
    state.processedTransactions = Object.fromEntries(processedEntries.slice(0, 5_000));
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

export function buildFactoryPoolChangeLines(changes = []) {
  const lines = [];
  for (const change of changes) {
    const item = change.current;
    const label = change.type === "added" ? "新增" : change.type === "disabled" ? "停用" : "修改";
    const name = item.quoteToken === BNB_QUOTE_TOKEN ? "BNB" : item.name || item.symbol || "名称待同步";
    const symbol = item.symbol && item.symbol !== name ? ` (${item.symbol})` : "";
    lines.push(`${label}底池: ${name}${symbol}`);
    lines.push(`  状态: ${item.enabled ? "已启用" : "未启用或已停用"}`);
    lines.push(`  quoteToken: ${item.quoteToken}`);
    if (item.lastTxHash) lines.push(`  交易: ${item.lastTxHash}`);
    if (item.lastSeenBlock != null) lines.push(`  区块: ${item.lastSeenBlock}`);
  }
  return lines;
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
