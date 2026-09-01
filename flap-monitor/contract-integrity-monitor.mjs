import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";

export const CONTRACT_INTEGRITY_SCHEMA_VERSION = 2;
export const BSC_CHAIN_ID = 56;
export const EIP1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
export const EIP1967_ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
export const EIP1967_BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

export const FLAP_CORE_CONTRACTS = Object.freeze({
  factory: "0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0",
  swapRegistry: "0x644a8f560138418bad4edefc7c17878a3c2fbeb6",
  vaultPortal: "0x90497450f2a706f1951b5bdda52b4e5d16f34c06",
  defaultVaultFactory: "0x5418f7e8ff90354db0ecd48c8b710219244eb3c5",
});

export const CONTRACT_INTEGRITY_FACTORY_EVENT_TOPICS = Object.freeze([
  "0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b", // Upgraded
  "0x7e644d79422f17c01e4894b5f4f588d331ebfa28653d42ae832dc59e38c9798f", // AdminChanged
  "0x1cf3b03a6cf19fa2baba4df148e9dcabedea7f8a5c07840e207e5c089be95d3e", // BeaconUpgraded
  "0x2f8788117e7eff1d82e926ec794901d17c78024a50270940304540a733656f0d", // RoleGranted
  "0xf6391f5c32d9c69d2a47ea670b442974b53935d1edc7fd64eb21e047a839171b", // RoleRevoked
  "0x31a3b20984650bce20de2cc7e24a3b22a069ab56c0b52456b8ceefc2a7169377", // BitFlagsChanged
]);

const ROLE_GRANTED_TOPIC = CONTRACT_INTEGRITY_FACTORY_EVENT_TOPICS[3];
const ROLE_REVOKED_TOPIC = CONTRACT_INTEGRITY_FACTORY_EVENT_TOPICS[4];
const UPGRADED_TOPIC = CONTRACT_INTEGRITY_FACTORY_EVENT_TOPICS[0];
const ADMIN_CHANGED_TOPIC = CONTRACT_INTEGRITY_FACTORY_EVENT_TOPICS[1];
const BEACON_UPGRADED_TOPIC = CONTRACT_INTEGRITY_FACTORY_EVENT_TOPICS[2];
const BIT_FLAGS_CHANGED_TOPIC = CONTRACT_INTEGRITY_FACTORY_EVENT_TOPICS[5];

const EVENT_LABELS = Object.freeze({
  [UPGRADED_TOPIC]: "代理实现升级",
  [ADMIN_CHANGED_TOPIC]: "代理管理员变更",
  [BEACON_UPGRADED_TOPIC]: "Beacon 升级",
  [ROLE_GRANTED_TOPIC]: "授予合约角色",
  [ROLE_REVOKED_TOPIC]: "撤销合约角色",
  [BIT_FLAGS_CHANGED_TOPIC]: "Factory 功能位变更",
  "0x4febb967ee9b8519f52401d3d2c24562594c261a564c21ffe046ad61d120a70c": "SwapRegistry 兑换路径移除",
  "0x2166ab98df33db0fb2b478058d5d250cd62b16ceb2efbbe2d98cfec1ffb3cb1d": "SwapRegistry 信任等级变更",
  "0x8f1ffc4dc704963c0165ea4062458f75bdba4310a1732e2a074c7c885e1dadb1": "Vault 审计报告提交",
  "0x4a8f046a4ca2bbc769fd8fc279ed7147e8a63c3f515ef382d5f53eb723a548bd": "Vault Factory 审计报告提交",
  "0x4b7856b753691492a25d38a5f62653225346549800ed513a9d8a930dfbd9af7e": "Vault 分类变更",
  "0x79c5f13fed5cc04839d97724b7e679da9f60680643995d89093a0a1160abe330": "Vault Factory 分类变更",
  "0xc47df14ad9309b59073546f93dbe3115ed09c8b206d9408441ddb07f745b10b": "Vault Adapter 注册",
  "0x76165963fce0c5b4f83141f9c1523c01626f43b99c0415a950bfc38a2a10403d": "Vault 实现升级",
});

const VAULT_FACTORY_REGISTERED_TOPIC = "0xd8cf270eb9827992a063745f0afaa72431f8c63fc46736f8b484862dcc709787";
const VAULT_FACTORY_CATEGORY_SET_TOPIC = "0x566b7414cab715cde3c8bcc93daec35325367d6c648327d19a1867d1006af3b3";
const IGNORED_OPERATIONAL_TOPICS = new Set([
  "0x504e7f360b2e5fe33cbaaae4c593bc55305328341bf79009e43e0e3b7f699603", // TokenCreated
  "0x1a9fe01bcb4855c926d7757a81014e36cae596a0e3047d297d2cf88ca298a77d", // FlapTaxVaultTokenCreated
  "0x9ec649285faba4f7761e920631349d8e0a2c7d167805da54063a237d8b17a978", // Vault created
  VAULT_FACTORY_REGISTERED_TOPIC,
  VAULT_FACTORY_CATEGORY_SET_TOPIC,
]);
const FULL_LOG_MONITOR_KINDS = new Set(["swapRegistry", "vaultPortal", "vaultFactory"]);
const VERIFIED_CATALOG_SOURCES = new Set(["builtin", "onchain-getter", "vault-portal-event"]);

const GETTERS = Object.freeze({
  factory: [
    ["version", "0x54fd4d50", "string"],
    ["newFeatureSwitch", "0xb1aad1e1", "bool"],
    ["feeRate", "0x84e5eed0", "uint"],
    ["vaultPortal", "0xb22a3410", "address", "vault-portal"],
    ["curvePairFactory", "0xb57523b0", "address"],
  ],
  swapRegistry: [
    ["weth", "0x3fc8cef3", "address"],
    ["v2Factory", "0xb4b57c39", "address"],
    ["multiDexRouter", "0x952b8901", "address", "swap-router"],
    ["defaultThreshold", "0x53f10a4b", "uint"],
    ["registryAdminRole", "0xbf584c4b", "bytes32"],
  ],
  vaultPortal: [
    ["version", "0x54fd4d50", "string"],
    ["portal", "0x0ff754ea", "address"],
    ["tokenImplV3", "0x2f567533", "address", "token-implementation"],
    ["taxTokenImpl", "0xf1d2212a", "address", "token-implementation"],
    ["taxTokenImplV2", "0xa6f33254", "address", "token-implementation"],
    ["taxTokenImplV3", "0xa3482a2f", "address", "token-implementation"],
    ["auditPrice", "0x2a226b67", "uint"],
    ["auditFeeReceiver", "0xa6b82858", "address"],
  ],
  vaultFactory: [
    ["factorySpecVersion", "0xa7b32ef0", "string"],
    ["vaultType", "0x75baf37f", "string"],
    ["vaultImplementation", "0xbba48a90", "address", "vault-implementation"],
    ["vaultBeacon", "0x9d343be1", "address", "vault-beacon"],
    ["basketImplementation", "0xab34ed8d", "address", "vault-implementation"],
    ["priceOracleAggregator", "0xf966923b", "address", "oracle"],
    ["triggerService", "0x70828b18", "address"],
    ["vaultUpgradesLocked", "0xd37d438b", "bool"],
    ["supportedAssets", "0xe5406dbf", "address[]"],
  ],
});

function nowIso() { return new Date().toISOString(); }
function hashText(value) { return createHash("sha256").update(String(value || "")).digest("hex"); }
function normalizeAddress(value) {
  const match = String(value || "").toLowerCase().match(/^0x[a-f0-9]{40}$/);
  return match && !/^0x0{40}$/.test(match[0]) ? match[0] : "";
}
function numberToHex(value) { return `0x${Math.max(0, Number(value) || 0).toString(16)}`; }
function hexToNumber(value) { return Number.parseInt(String(value || "0x0"), 16) || 0; }
function addressFromWord(value) {
  const hex = String(value || "").replace(/^0x/i, "");
  return /^[a-fA-F0-9]{64}$/.test(hex) ? normalizeAddress(`0x${hex.slice(-40)}`) : "";
}
function addressFromDataWord(data, wordIndex = 0) {
  const hex = String(data || "").replace(/^0x/i, "");
  return addressFromWord(`0x${hex.slice(wordIndex * 64, wordIndex * 64 + 64)}`);
}
function encodeAddressCall(selector, address) {
  return `${selector}${"0".repeat(24)}${normalizeAddress(address).slice(2)}`;
}

function isVerifiedCatalogEntry(entry) {
  return entry?.verified === true || VERIFIED_CATALOG_SOURCES.has(String(entry?.source || ""));
}

export function extractBytecodeSelectors(bytecode) {
  const hex = String(bytecode || "").replace(/^0x/i, "").toLowerCase();
  const selectors = new Set();
  for (let index = 0; index + 12 <= hex.length; index += 2) {
    if (hex.slice(index, index + 2) !== "63" || hex.slice(index + 10, index + 12) !== "14") continue;
    selectors.add(`0x${hex.slice(index + 2, index + 10)}`);
  }
  return [...selectors].sort();
}

export function decodeContractValue(raw, type = "bytes32") {
  const hex = String(raw || "").replace(/^0x/i, "");
  if (!hex || !/^[a-fA-F0-9]+$/.test(hex)) return "";
  if (type === "address") return addressFromWord(`0x${hex.slice(0, 64)}`);
  if (type === "bool") return BigInt(`0x${hex.slice(0, 64) || "0"}`) === 0n ? "false" : "true";
  if (type === "uint") return BigInt(`0x${hex.slice(0, 64) || "0"}`).toString();
  if (type === "string") {
    try {
      const offset = Number(BigInt(`0x${hex.slice(0, 64)}`));
      const length = Number(BigInt(`0x${hex.slice(offset * 2, offset * 2 + 64)}`));
      const body = hex.slice(offset * 2 + 64, offset * 2 + 64 + length * 2);
      return Buffer.from(body, "hex").toString("utf8").replace(/[\u0000-\u001f\u007f]/g, "").trim();
    } catch { return `0x${hex.slice(0, 64)}`; }
  }
  if (type === "address[]") {
    try {
      const offset = Number(BigInt(`0x${hex.slice(0, 64)}`));
      const length = Math.min(512, Number(BigInt(`0x${hex.slice(offset * 2, offset * 2 + 64)}`)));
      const addresses = [];
      for (let index = 0; index < length; index++) {
        const address = addressFromWord(`0x${hex.slice(offset * 2 + 64 + index * 64, offset * 2 + 128 + index * 64)}`);
        if (address) addresses.push(address);
      }
      return addresses;
    } catch { return []; }
  }
  return `0x${hex.slice(0, 64)}`;
}

function staticCatalog() {
  return {
    [FLAP_CORE_CONTRACTS.factory]: { address: FLAP_CORE_CONTRACTS.factory, label: "Flap Factory", kind: "factory", proxy: true, source: "builtin", verified: true },
    [FLAP_CORE_CONTRACTS.swapRegistry]: { address: FLAP_CORE_CONTRACTS.swapRegistry, label: "Flap SwapRegistry", kind: "swapRegistry", proxy: true, source: "builtin", verified: true },
    [FLAP_CORE_CONTRACTS.vaultPortal]: { address: FLAP_CORE_CONTRACTS.vaultPortal, label: "Flap Vault Portal", kind: "vaultPortal", proxy: true, source: "builtin", verified: true },
    [FLAP_CORE_CONTRACTS.defaultVaultFactory]: { address: FLAP_CORE_CONTRACTS.defaultVaultFactory, label: "Flap 默认 Vault Factory", kind: "vaultFactory", proxy: false, source: "builtin", verified: true },
  };
}

export function createContractIntegrityState() {
  return {
    schemaVersion: CONTRACT_INTEGRITY_SCHEMA_VERSION,
    chainId: BSC_CHAIN_ID,
    catalog: staticCatalog(),
    contracts: {},
    trackedAssets: {},
    trackedAssetCursor: 0,
    recentEvents: {},
    pendingChanges: [],
    latestBlock: 0,
    httpEventLastBlock: 0,
    lastCoreScanAt: "",
    lastExtendedScanAt: "",
    lastCodeAuditAt: "",
    lastError: "",
    wssHealth: {},
  };
}

export function migrateContractIntegrityState(raw) {
  const base = createContractIntegrityState();
  const state = raw && typeof raw === "object" ? { ...base, ...raw } : base;
  state.schemaVersion = CONTRACT_INTEGRITY_SCHEMA_VERSION;
  state.chainId = BSC_CHAIN_ID;
  state.catalog = { ...(state.catalog || {}), ...staticCatalog() };
  for (const [address, entry] of Object.entries(state.catalog)) {
    if (FULL_LOG_MONITOR_KINDS.has(entry?.kind) && !isVerifiedCatalogEntry(entry)) delete state.catalog[address];
  }
  state.contracts = state.contracts && typeof state.contracts === "object" ? state.contracts : {};
  state.trackedAssets = state.trackedAssets && typeof state.trackedAssets === "object" ? state.trackedAssets : {};
  state.recentEvents = state.recentEvents && typeof state.recentEvents === "object" ? state.recentEvents : {};
  state.pendingChanges = Array.isArray(state.pendingChanges)
    ? state.pendingChanges.filter(change => (
      change?.type !== "event" || Boolean(EVENT_LABELS[String(change?.topic0 || "").toLowerCase()])
    )).slice(-500)
    : [];
  return state;
}

export function loadContractIntegrityState(path) {
  if (!existsSync(path)) return createContractIntegrityState();
  if (statSync(path).size > 8 * 1024 * 1024) throw new Error("合约完整性状态文件超过 8MB");
  try {
    return migrateContractIntegrityState(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    throw new Error(`合约完整性状态文件解析失败：${error.message}`);
  }
}

export function saveContractIntegrityState(path, state) {
  state.schemaVersion = CONTRACT_INTEGRITY_SCHEMA_VERSION;
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  renameSync(tmp, path);
}

function addCatalogEntry(state, value, patch = {}) {
  const address = normalizeAddress(value);
  if (!address) return false;
  const previous = state.catalog[address] || {};
  const incomingVerified = patch.verified === true || VERIFIED_CATALOG_SOURCES.has(String(patch.source || ""));
  const preserveVerified = previous.source === "builtin" || (isVerifiedCatalogEntry(previous) && !incomingVerified);
  state.catalog[address] = {
    address,
    label: preserveVerified ? previous.label : patch.label || previous.label || "Flap 关联合约",
    kind: preserveVerified ? previous.kind : patch.kind || previous.kind || "dependency",
    proxy: preserveVerified ? previous.proxy : patch.proxy ?? previous.proxy ?? false,
    source: preserveVerified ? previous.source : patch.source || previous.source || "discovered",
    verified: preserveVerified ? true : incomingVerified,
    hintedKind: preserveVerified ? previous.hintedKind : patch.hintedKind || previous.hintedKind || "",
    evidenceSource: preserveVerified ? previous.evidenceSource : patch.evidenceSource || previous.evidenceSource || "",
  };
  return !previous.address;
}

export function syncContractIntegrityCatalog(state, { vaultFactories = {}, contractHints = [], factoryAssets = {} } = {}) {
  let changed = false;
  for (const factory of Object.values(vaultFactories || {})) {
    const address = factory?.factory || factory?.address;
    changed = addCatalogEntry(state, address, {
      label: `Vault Factory 候选 ${factory?.name || ""}`.trim(),
      kind: "frontendHint",
      hintedKind: "vaultFactory",
      source: "frontend-hint",
      evidenceSource: "frontend-vault-types",
    }) || changed;
  }
  for (const hint of contractHints || []) {
    const kind = String(hint?.kind || "dependency");
    changed = addCatalogEntry(state, hint?.address, {
      label: hint?.label || `Flap ${kind} 候选`,
      kind: "frontendHint",
      hintedKind: kind,
      source: "frontend-hint",
      evidenceSource: hint?.source || "frontend",
    }) || changed;
  }
  for (const [address, asset] of Object.entries(factoryAssets || {})) {
    const normalized = normalizeAddress(address);
    if (!normalized) continue;
    state.trackedAssets[normalized] = { ...(state.trackedAssets[normalized] || {}), address: normalized, label: asset?.symbol || asset?.name || normalized, source: "factory-pool", lastSeenAt: nowIso() };
  }
  return changed;
}

function changeId(change) {
  return hashText(JSON.stringify([change.type, change.address, change.field, change.previous, change.current, change.txHash, change.logIndex]));
}

function appendChange(state, change) {
  const item = { detectedAt: nowIso(), ...change };
  item.id ||= changeId(item);
  if (!state.pendingChanges.some(existing => existing.id === item.id)) state.pendingChanges.push(item);
  if (state.pendingChanges.length > 500) state.pendingChanges.splice(0, state.pendingChanges.length - 500);
  return item;
}

function compareField(state, changes, address, field, previous, current, type = "state") {
  if (previous === undefined || previous === null) return;
  if (JSON.stringify(previous) === JSON.stringify(current)) return;
  changes.push(appendChange(state, { type, address, field, previous, current }));
}

function catalogGetterList(entry) {
  return GETTERS[entry.kind] || [];
}

async function runBatch(rpcBatch, calls, size = 80) {
  const results = [];
  for (let index = 0; index < calls.length; index += size) {
    const chunk = calls.slice(index, index + size);
    try {
      results.push(...await rpcBatch(chunk));
    } catch (error) {
      // 某些代理升级后会移除可选 view；单个 getter 回滚不应让整轮完整性扫描失败。
      if (!/execution reverted/i.test(String(error?.message || ""))) throw error;
      for (const call of chunk) {
        try {
          const value = await rpcBatch([call]);
          results.push(value?.[0] ?? null);
        } catch (singleError) {
          if (!/execution reverted/i.test(String(singleError?.message || ""))) throw singleError;
          results.push(null);
        }
      }
    }
  }
  return results;
}

export async function runContractIntegrityStateScan({
  state,
  rpcCall,
  rpcBatch,
  extended = false,
  forceCodeAudit = false,
  trackedAssetLimit = 20,
  suppressFactoryImplementationChange = false,
} = {}) {
  const changes = [];
  const [chainIdHex, latestHex] = await Promise.all([rpcCall("eth_chainId", []), rpcCall("eth_blockNumber", [])]);
  const chainId = hexToNumber(chainIdHex);
  if (chainId !== BSC_CHAIN_ID) throw new Error(`Flap 合约完整性 RPC chainId 错误：${chainId}`);
  state.latestBlock = hexToNumber(latestHex);
  const blockTag = numberToHex(state.latestBlock);
  const entries = Object.values(state.catalog).filter(entry => (
    extended || (isVerifiedCatalogEntry(entry) && ["factory", "swapRegistry", "vaultPortal"].includes(entry.kind))
  ));

  const stateCalls = [];
  for (const entry of entries) {
    if (entry.proxy) {
      for (const [field, slot] of [["implementation", EIP1967_IMPLEMENTATION_SLOT], ["admin", EIP1967_ADMIN_SLOT], ["beacon", EIP1967_BEACON_SLOT]]) {
        stateCalls.push({ address: entry.address, field, type: "slot", call: { method: "eth_getStorageAt", params: [entry.address, slot, blockTag] } });
      }
    }
    for (const [field, selector, valueType, derivedKind] of catalogGetterList(entry)) {
      stateCalls.push({ address: entry.address, field, type: "getter", valueType, derivedKind, call: { method: "eth_call", params: [{ to: entry.address, data: selector }, blockTag] } });
    }
  }
  const stateResults = await runBatch(rpcBatch, stateCalls.map(item => item.call));
  const newDerived = [];
  for (let index = 0; index < stateCalls.length; index++) {
    const item = stateCalls[index];
    const raw = stateResults[index];
    if (raw == null) continue;
    const contract = state.contracts[item.address] || (state.contracts[item.address] = { address: item.address, getters: {}, slots: {} });
    if (item.type === "slot") {
      const current = addressFromWord(raw);
      const handledByFactoryMonitor = suppressFactoryImplementationChange
        && item.address === FLAP_CORE_CONTRACTS.factory
        && item.field === "implementation";
      if (!handledByFactoryMonitor) compareField(state, changes, item.address, item.field, contract.slots[item.field], current, "proxy-slot");
      contract.slots[item.field] = current;
      if (current) newDerived.push({ address: current, kind: item.field === "admin" ? "proxy-admin" : item.field, label: `${state.catalog[item.address]?.label || item.address} ${item.field}` });
    } else {
      const decoded = decodeContractValue(raw, item.valueType);
      const comparable = Array.isArray(decoded) ? decoded.join(",") : decoded;
      compareField(state, changes, item.address, item.field, contract.getters[item.field]?.value, comparable, "getter");
      contract.getters[item.field] = { value: comparable, rawHash: hashText(raw), updatedAt: nowIso() };
      if (item.valueType === "address[]") {
        for (const address of decoded) {
          state.trackedAssets[address] = { ...(state.trackedAssets[address] || {}), address, label: address, source: `${state.catalog[item.address]?.label || item.address}:${item.field}`, lastSeenAt: nowIso() };
        }
      } else if (item.derivedKind && normalizeAddress(decoded)) {
        newDerived.push({ address: decoded, kind: item.derivedKind, label: `${state.catalog[item.address]?.label || item.address} ${item.field}` });
      }
    }
    contract.lastStateBlock = state.latestBlock;
  }
  for (const derived of newDerived) addCatalogEntry(state, derived.address, { ...derived, source: "onchain-getter", verified: true });

  const codeTargets = new Set();
  for (const entry of Object.values(state.catalog)) {
    if (forceCodeAudit || !state.contracts[entry.address]?.codeHash) codeTargets.add(entry.address);
  }
  for (const derived of newDerived) {
    const address = normalizeAddress(derived.address);
    if (address && !state.contracts[address]?.codeHash) codeTargets.add(address);
  }
  const codeAddresses = [...codeTargets].filter(Boolean);
  const codes = await runBatch(rpcBatch, codeAddresses.map(address => ({ method: "eth_getCode", params: [address, blockTag] })));
  for (let index = 0; index < codeAddresses.length; index++) {
    const address = codeAddresses[index];
    if (codes[index] == null) continue;
    const code = String(codes[index]);
    const contract = state.contracts[address] || (state.contracts[address] = { address, getters: {}, slots: {} });
    const codeHash = hashText(code.toLowerCase());
    const selectors = code === "0x" ? [] : extractBytecodeSelectors(code);
    compareField(state, changes, address, "codeHash", contract.codeHash, codeHash, "code-hash");
    if (Array.isArray(contract.selectors) && contract.selectors.length > 0 && JSON.stringify(contract.selectors) !== JSON.stringify(selectors)) {
      const previousSet = new Set(contract.selectors);
      const currentSet = new Set(selectors);
      changes.push(appendChange(state, {
        type: "selectors",
        address,
        field: "functionSelectors",
        previous: contract.selectors,
        current: selectors,
        added: selectors.filter(value => !previousSet.has(value)),
        removed: contract.selectors.filter(value => !currentSet.has(value)),
      }));
    }
    contract.codeHash = codeHash;
    contract.codeBytes = Math.max(0, (code.length - 2) / 2);
    contract.selectors = selectors;
    contract.lastCodeBlock = state.latestBlock;
  }

  if (extended) {
    const addresses = Object.keys(state.trackedAssets).sort();
    const start = addresses.length > 0 ? state.trackedAssetCursor % addresses.length : 0;
    const selected = [...addresses.slice(start), ...addresses.slice(0, start)].slice(0, trackedAssetLimit);
    state.trackedAssetCursor = addresses.length > 0 ? (start + selected.length) % addresses.length : 0;
    const checks = [];
    for (const address of selected) {
      checks.push(
        { address, field: "spammerBlocked", call: { method: "eth_call", params: [{ to: FLAP_CORE_CONTRACTS.factory, data: encodeAddressCall("0xb87224d0", address) }, blockTag] }, type: "bool" },
        { address, field: "swapBlacklisted", call: { method: "eth_call", params: [{ to: FLAP_CORE_CONTRACTS.swapRegistry, data: encodeAddressCall("0xfe575a87", address) }, blockTag] }, type: "bool" },
        { address, field: "trustStatus", call: { method: "eth_call", params: [{ to: FLAP_CORE_CONTRACTS.swapRegistry, data: encodeAddressCall("0x278f3b7a", address) }, blockTag] }, type: "uint" },
        { address, field: "allowedQuoteToken", call: { method: "eth_call", params: [{ to: FLAP_CORE_CONTRACTS.swapRegistry, data: encodeAddressCall("0x235fec98", address) }, blockTag] }, type: "bool" },
      );
    }
    const checkResults = await runBatch(rpcBatch, checks.map(item => item.call));
    for (let index = 0; index < checks.length; index++) {
      if (checkResults[index] == null) continue;
      const item = checks[index];
      const asset = state.trackedAssets[item.address];
      const current = decodeContractValue(checkResults[index], item.type);
      compareField(state, changes, item.address, item.field, asset[item.field], current, "tracked-state");
      asset[item.field] = current;
      asset.lastCheckedAt = nowIso();
      asset.lastCheckedBlock = state.latestBlock;
    }
    state.lastExtendedScanAt = nowIso();
  }
  state.lastCoreScanAt = nowIso();
  if (forceCodeAudit) state.lastCodeAuditAt = nowIso();
  state.lastError = "";
  return { changed: changes.length > 0, changes, state };
}

function eventKey(logEntry) {
  return `${String(logEntry?.transactionHash || "").toLowerCase()}:${hexToNumber(logEntry?.logIndex)}`;
}

function pruneRecentEvents(state) {
  const entries = Object.entries(state.recentEvents || {}).sort(([, left], [, right]) => (right.blockNumber || 0) - (left.blockNumber || 0)).slice(0, 5_000);
  state.recentEvents = Object.fromEntries(entries);
}

export function ingestContractIntegrityEvent(state, logEntry, source = "wss", { suppressFactoryUpgrade = false } = {}) {
  const address = normalizeAddress(logEntry?.address);
  if (!address || !state.catalog[address]) return { processed: false, change: null };
  const key = eventKey(logEntry);
  if (!key || state.recentEvents[key]) return { processed: false, duplicate: true, change: null };
  const topic0 = String(logEntry?.topics?.[0] || "").toLowerCase();
  const blockNumber = hexToNumber(logEntry?.blockNumber);
  state.recentEvents[key] = { address, topic0, blockNumber, source, seenAt: nowIso() };
  pruneRecentEvents(state);

  // Factory implementation changes are already delivered by the dedicated 1s pool monitor.
  if (suppressFactoryUpgrade && address === FLAP_CORE_CONTRACTS.factory && topic0 === UPGRADED_TOPIC) {
    return { processed: true, suppressed: true, change: null };
  }
  if (topic0 === VAULT_FACTORY_REGISTERED_TOPIC) {
    const discovered = addressFromDataWord(logEntry?.data, 0);
    if (discovered) addCatalogEntry(state, discovered, { label: "Portal 注册 Vault Factory", kind: "vaultFactory", source: "vault-portal-event", verified: true });
    return { processed: true, suppressed: true, change: null };
  }
  if (IGNORED_OPERATIONAL_TOPICS.has(topic0)) return { processed: true, suppressed: true, change: null };
  const label = EVENT_LABELS[topic0];
  if (!label) return { processed: true, suppressed: true, unknown: true, change: null };
  const change = appendChange(state, {
    type: "event",
    address,
    field: label,
    current: topic0,
    topic0,
    blockNumber,
    txHash: String(logEntry?.transactionHash || "").toLowerCase(),
    logIndex: hexToNumber(logEntry?.logIndex),
    source,
  });
  return { processed: true, change };
}

export async function scanContractIntegrityEvents({ state, rpcCall, latestBlock = 0, maxBlocks = 2_000, suppressFactoryUpgrade = false } = {}) {
  const latest = latestBlock || hexToNumber(await rpcCall("eth_blockNumber", []));
  if (!state.httpEventLastBlock) {
    state.httpEventLastBlock = latest;
    return { changed: false, changes: [], initialized: true, latest };
  }
  if (state.httpEventLastBlock >= latest) return { changed: false, changes: [], latest };
  const fromBlock = state.httpEventLastBlock + 1;
  const toBlock = Math.min(latest, state.httpEventLastBlock + Math.max(1, maxBlocks));
  const otherAddresses = contractIntegritySubscriptionAddresses(state);
  const filters = [
    { address: FLAP_CORE_CONTRACTS.factory, topics: [CONTRACT_INTEGRITY_FACTORY_EVENT_TOPICS], fromBlock: numberToHex(fromBlock), toBlock: numberToHex(toBlock) },
  ];
  if (otherAddresses.length > 0) filters.push({ address: otherAddresses, fromBlock: numberToHex(fromBlock), toBlock: numberToHex(toBlock) });
  const results = await Promise.all(filters.map(filter => rpcCall("eth_getLogs", [filter])));
  const logs = results.flat().sort((left, right) => hexToNumber(left.blockNumber) - hexToNumber(right.blockNumber) || hexToNumber(left.logIndex) - hexToNumber(right.logIndex));
  const changes = [];
  for (const entry of logs) {
    const result = ingestContractIntegrityEvent(state, entry, "http-backfill", { suppressFactoryUpgrade });
    if (result.change) changes.push(result.change);
  }
  state.httpEventLastBlock = toBlock;
  return { changed: changes.length > 0, changes, latest, fromBlock, toBlock };
}

export function contractIntegritySubscriptionAddresses(state, { includeFactory = false } = {}) {
  return Object.values(state.catalog || {})
    .filter(entry => isVerifiedCatalogEntry(entry)
      && ((includeFactory && entry.kind === "factory") || FULL_LOG_MONITOR_KINDS.has(entry.kind)))
    .map(entry => entry.address)
    .filter(Boolean)
    .sort();
}

export function acknowledgeContractIntegrityChanges(state, ids = []) {
  const set = new Set(ids);
  state.pendingChanges = state.pendingChanges.filter(change => !set.has(change.id));
}

function shortValue(value) {
  if (Array.isArray(value)) return `${value.length} 项`;
  const text = String(value ?? "");
  return text.length > 100 ? `${text.slice(0, 97)}...` : text || "(空)";
}

export function buildContractIntegrityContent(changes = [], state = {}) {
  const lines = [
    `- 发现 Flap 合约完整性变更 ${changes.length} 项`,
    `- 链上区块: ${state.latestBlock || changes.map(change => change.blockNumber || 0).sort((a, b) => b - a)[0] || "未知"}`,
    "",
    "**合约变更**",
  ];
  for (const change of changes) {
    const contract = state.catalog?.[change.address];
    const label = contract?.label || change.address || "未知合约";
    lines.push(`- ${label}: [${change.address}](https://bscscan.com/address/${change.address})`);
    if (change.type === "event") {
      lines.push(`  ${change.field}: ${change.topic0}`);
      if (change.txHash) lines.push(`  交易: [${change.txHash}](https://bscscan.com/tx/${change.txHash})`);
    } else if (change.type === "selectors") {
      if (change.added?.length) lines.push(`  新增函数选择器: ${change.added.join(", ")}`);
      if (change.removed?.length) lines.push(`  移除函数选择器: ${change.removed.join(", ")}`);
    } else {
      lines.push(`  ${change.field}: ${shortValue(change.previous)} -> ${shortValue(change.current)}`);
    }
  }
  return lines.join("\n");
}

export const __testables = {
  EVENT_LABELS,
  FULL_LOG_MONITOR_KINDS,
  GETTERS,
  IGNORED_OPERATIONAL_TOPICS,
  VAULT_FACTORY_REGISTERED_TOPIC,
  addressFromWord,
  encodeAddressCall,
  hashText,
  normalizeAddress,
  isVerifiedCatalogEntry,
  runBatch,
};
