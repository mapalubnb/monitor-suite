import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { CORE_SAFES, AUXILIARY_SAFES, EXECUTION_WALLETS, CORE_OWNERS, ALLOWANCE_MODULE, PROXY_ADMINS,
  DEX, POSITION_MANAGERS, BASE_ASSETS } from "./early-signal-catalog.mjs";
import { TOPICS } from "./early-signal-topics.mjs";
import { abiAddress, abiUint, hexWords } from "./operational-call-codec.mjs";
import { normalizeAddress, extractFlapProposalActions } from "./safe-proposal-monitor.mjs";
import { FLAP_FACTORY_PROXY, QUOTE_CONFIG_SELECTOR, QUOTE_TOKEN_CREATION_DISABLED_SELECTOR } from "./factory-pool-monitor.mjs";

export const EARLY_SIGNAL_SCHEMA_VERSION = 2;
const ZERO = "0x" + "0".repeat(40);
const iso = ms => new Date(ms).toISOString();
const hash = s => createHash("sha256").update(s).digest("hex");
const lower = a => String(a || "").toLowerCase();
const blockTag = n => `0x${n.toString(16)}`;
const pad = a => `0x${a.slice(2).padStart(64, "0")}`;
const addressTopic = t => { try { return abiAddress(String(t || "").replace(/^0x/, "")); } catch { return ""; } };
const keys = o => Object.keys(o || {});
const uniq = a => [...new Set(a.filter(Boolean))];
const MAX_EVENTS = 12000;
const MAX_PENDING = 2000;
const MAX_TOKENS = 500;
const FEE_SAFE = "0x8a08d98cbb218fceb318ecf3abc1ba43d8a7ab0e";
const REORG_WINDOW = 128;
const DAY = 86400000;
const STAGES = { observation: "观察线索", stocking: "疑似备货", prepared: "底池已有流动性，开放未确认",
  proposed: "已提议开放", signed: "开放提案签名已满足，执行条件待核实", executable: "开放提案已通过执行模拟（以校验时点为准）", opened: "链上支持创建", disabled: "链上暂停／停用" };
export const stageLabel = stage => STAGES[stage] || stage;

export function createEarlySignalState() {
  return { schemaVersion: EARLY_SIGNAL_SCHEMA_VERSION, chainId: 56, cursor: null, cursorHash: "", events: {},
    pendingChanges: [], tokens: {}, pools: {}, positions: {}, orders: {}, candidates: {}, safeInfo: {},
    balances: {}, stages: {}, proposalVersions: {}, fastBlocks: {}, health: {}, discoveryCursor: 0, lastDiscoveryAt: 0, lastRunAt: "" };
}
export function loadEarlySignalState(path) {
  if (!existsSync(path)) return createEarlySignalState();
  if (statSync(path).size > 32 * 1024 * 1024) throw new Error("提前监控状态超过 32MB，请检查积压");
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (raw.chainId !== 56) throw new Error("提前监控状态不是 BSC");
  const state = { ...createEarlySignalState(), ...raw, schemaVersion: EARLY_SIGNAL_SCHEMA_VERSION };
  for (const name of ["events", "tokens", "pools", "positions", "orders", "candidates", "safeInfo", "balances", "stages", "proposalVersions", "fastBlocks", "health"]) {
    if (!state[name] || typeof state[name] !== "object" || Array.isArray(state[name])) throw new Error(`提前监控状态 ${name} 无效`);
  }
  if (!Array.isArray(state.pendingChanges)) throw new Error("提前监控队列无效");
  if ((raw.schemaVersion || 1) < 2) {
    // Legacy public-pool events did not record official participation. Drop only
    // unverifiable pool-derived alerts; retain independent funding/order/proposal evidence.
    const poolReasons = new Set(["已核验 DEX 建池", "已核验池子的流动性变化"]);
    const independent = new Set(Object.values(state.events).filter(e => e.token
      && !["poolCreated", "liquidityAdded", "liquidityRemoved", "configuration"].includes(e.kind)).map(e => e.token));
    const removed = new Set();
    for (const [token, meta] of Object.entries(state.tokens)) {
      if (poolReasons.has(meta.reason) && !independent.has(token)) {
        delete state.tokens[token]; removed.add(token);
      }
    }
    const invalid = e => ["poolCreated", "liquidityAdded", "liquidityRemoved"].includes(e.kind) || removed.has(e.token);
    state.pendingChanges = state.pendingChanges.filter(e => !invalid(e));
    for (const [id, e] of Object.entries(state.events)) if (invalid(e)) delete state.events[id];
  }
  if (state.health.chain) state.health.chain.nextAttemptAtMs = Math.min(state.health.chain.nextAttemptAtMs || 0, Date.now() + 60_000);
  pruneDiscoveryPools(state);
  return state;
}
function isRelevantPool(pool, state) {
  return pool.officialOperation || pool.tokens?.some(token => state.tokens[token] && state.tokens[token].effectiveEnabled !== true);
}
function pruneDiscoveryPools(state) {
  const unrelated = Object.values(state.pools).filter(pool => !isRelevantPool(pool, state));
  unrelated.sort((a, b) => (b.blockNumber || 0) - (a.blockNumber || 0));
  for (const pool of unrelated.slice(512)) delete state.pools[pool.address];
}
export function saveEarlySignalState(path, state) {
  writeFileSync(`${path}.tmp`, JSON.stringify(state), "utf8");
  renameSync(`${path}.tmp`, path);
}
export function acknowledgeEarlySignals(state, ids) {
  const set = new Set(ids);
  state.pendingChanges = state.pendingChanges.filter(x => !set.has(x.id));
}
function emit(state, event, { silent = false, nowMs = Date.now() } = {}) {
  const id = event.id || hash(JSON.stringify(event));
  if (state.events[id]) return false;
  if (!silent && state.pendingChanges.length >= MAX_PENDING) throw new Error("提前信号通知积压达到上限，停止推进以免丢失");
  const record = { ...event, id, observedAt: iso(nowMs) };
  state.events[id] = record;
  if (!silent) state.pendingChanges.push(record);
  return true;
}
function trackToken(state, token, reason, nowMs) {
  token = normalizeAddress(token);
  if (!token || BASE_ASSETS.has(token)) return;
  if (!state.tokens[token] && keys(state.tokens).length >= MAX_TOKENS) {
    // Preserve the event, but do not let unsolicited dust permanently stall the cursor.
    state.health.capacity = { lastError: `候选资产达到 ${MAX_TOKENS} 个，新资产仅保留事件，需审查名单` };
    return;
  }
  state.tokens[token] ||= { address: token, firstSeenAt: iso(nowMs), reason };
  if (!["已核验 DEX 建池", "已核验池子的流动性变化"].includes(reason)) state.tokens[token].reason = reason;
  state.tokens[token].lastSeenAt = iso(nowMs);
}
function candidate(state, address, evidence, nowMs) {
  address = normalizeAddress(address);
  if (!address || address === ZERO || CORE_SAFES.some(([a]) => lower(a) === address)) return;
  const previous = state.candidates[address];
  if (!previous && keys(state.candidates).length >= 1000) return;
  state.candidates[address] = { ...previous, address, confidence: "待核验", firstSeenAt: previous?.firstSeenAt || iso(nowMs),
    lastSeenAt: iso(nowMs), evidence: uniq([...(previous?.evidence || []), evidence]).slice(-8) };
}
export function watchedWallets(config = {}) {
  return uniq([...(config.safes || CORE_SAFES.map(([a]) => a)), ...AUXILIARY_SAFES,
    ...(config.wallets || EXECUTION_WALLETS)].map(normalizeAddress));
}
export function earlyLogFilters(state, config = {}) {
  const wallets = watchedWallets(config).map(pad);
  const operationAddresses = uniq([...watchedWallets(config), ALLOWANCE_MODULE, ...PROXY_ADMINS,
    config.factoryAddress || FLAP_FACTORY_PROXY, "0x90497450f2a706f1951b5bdda52b4e5d16f34c06",
    DEX.v2Factory, DEX.v3Factory,
    ...Object.values(state.pools).filter(p => /^0x[a-f0-9]{40}$/.test(p.address) && isRelevantPool(p, state)).map(p => p.address)]);
  return [
    { topics: [[TOPICS.Transfer, TOPICS.Approval], wallets] },
    { topics: [TOPICS.Transfer, null, wallets.filter(a => a !== pad(FEE_SAFE))] },
    { address: operationAddresses, topics: [[...Object.values(TOPICS).filter(t => ![TOPICS.Transfer, TOPICS.Approval, TOPICS.SafeReceived].includes(t))]] },
    { address: watchedWallets(config).filter(a => a !== FEE_SAFE), topics: [TOPICS.SafeReceived] },
    // Module ABI versions may differ. Its low-volume logs are retained and scoped by Safe address.
    { address: ALLOWANCE_MODULE },
    { address: [DEX.v4Manager, DEX.clManager, DEX.binManager], topics: [[TOPICS.V4Initialize, TOPICS.CLInitialize, TOPICS.BinInitialize]] },
    ...(Object.values(state.pools).some(p => p.poolId && isRelevantPool(p, state)) ? [{
      address: [DEX.v4Manager, DEX.clManager, DEX.binManager],
      topics: [[TOPICS.ModifyLiquidity, TOPICS.BinMint, TOPICS.BinBurn], uniq(Object.values(state.pools).filter(p => p.poolId && isRelevantPool(p, state)).map(p => p.poolId))],
    }] : []),
  ];
}
export function shouldPrioritizeEarlyLog(event, state) {
  // Global factory initialization subscriptions include unrelated public pools.
  // Wallet-scoped logs and known pools still enter the fast lane immediately.
  const topic = lower(event.topics?.[0]);
  if ([TOPICS.PairCreated, TOPICS.PoolCreated, TOPICS.V4Initialize, TOPICS.CLInitialize, TOPICS.BinInitialize].includes(topic)) {
    const offset = [TOPICS.PairCreated, TOPICS.PoolCreated].includes(topic) ? 1 : 2;
    return [addressTopic(event.topics?.[offset]), addressTopic(event.topics?.[offset + 1])].some(token => state.tokens[token] && state.tokens[token].effectiveEnabled !== true);
  }
  return true;
}
function logId(log) { return `${lower(log.blockHash)}:${lower(log.transactionHash)}:${Number(log.logIndex)}`; }
function chainOrder(a, b) {
  return Number(a.blockNumber || 0) - Number(b.blockNumber || 0)
    || Number(a.logIndex ?? a.id?.split(":")[2] ?? 0) - Number(b.logIndex ?? b.id?.split(":")[2] ?? 0);
}

// Receipt decoding accepts only recognized factories/managers or verified pool addresses.
export function decodeEarlyReceipt(receipt, state, { config = {}, nowMs = Date.now(), silent = false, transaction = null } = {}) {
  if (!receipt || Number(receipt.status) !== 1) return [];
  const options = { nowMs, silent };
  const wallets = new Set(watchedWallets(config));
  const executors = new Set((config.wallets || EXECUTION_WALLETS).map(lower));
  const feeSafe = FEE_SAFE;
  const txFrom = lower(transaction?.from || receipt.from);
  const logs = [...(receipt.logs || [])].sort((a, b) => Number(a.logIndex) - Number(b.logIndex));
  const related = wallets.has(txFrom) || logs.some(l => lower(l.topics?.[0]) === TOPICS.Transfer
    && wallets.has(addressTopic(l.topics[1])));
  // A public pair with a known quote asset must never promote its other token.
  const poolSignalTokens = pool => pool.tokens.filter(token => !BASE_ASSETS.has(token)
    && (related || state.tokens[token] && state.tokens[token].effectiveEnabled !== true));
  const emitted = [];
  const add = (log, event) => {
    const e = { ...event, id: `${logId(log)}:${event.kind}:${event.token || ""}`, blockNumber: Number(log.blockNumber || receipt.blockNumber),
      logIndex: Number(log.logIndex || 0),
      blockHash: lower(log.blockHash || receipt.blockHash), transactionHash: lower(receipt.transactionHash),
      source: "chain", chainId: 56, provisional: true };
    if (emit(state, e, options)) emitted.push(e);
  };
  // Initialize first even when a receipt contains activity before the pool creation log.
  for (const l of logs) {
    const t = lower(l.topics?.[0]), a = lower(l.address);
    try {
      const w = hexWords(l.data || "0x");
      let pool;
      if (t === TOPICS.PairCreated && a === DEX.v2Factory) pool = { address: abiAddress(w[0]), protocol: "V2" };
      if (t === TOPICS.PoolCreated && a === DEX.v3Factory) pool = { address: abiAddress(w[1]), protocol: "V3", fee: Number(BigInt(l.topics[3])) };
      if ((t === TOPICS.V4Initialize && a === DEX.v4Manager) || (t === TOPICS.CLInitialize && a === DEX.clManager)
        || (t === TOPICS.BinInitialize && a === DEX.binManager)) pool = { address: `${a}:${lower(l.topics[1])}`, manager: a, poolId: lower(l.topics[1]), protocol: a === DEX.v4Manager ? "V4" : a === DEX.clManager ? "Infinity CL" : "Infinity Bin" };
      if (!pool) continue;
      const offset = pool.poolId ? 2 : 1;
      pool.tokens = [addressTopic(l.topics[offset]), addressTopic(l.topics[offset + 1])];
      pool.blockNumber = Number(l.blockNumber || receipt.blockNumber);
      if (related) pool.officialOperation = true;
      if (!poolSignalTokens(pool).length) {
        // A bounded discovery cache is useful when a token is observed shortly afterwards.
        // Cached unrelated pools must never enter active liquidity subscriptions.
        state.pools[pool.address] = pool;
        pruneDiscoveryPools(state);
        continue;
      }
      state.pools[pool.address] = pool;
      for (const token of poolSignalTokens(pool)) {
        trackToken(state, token, "已核验 DEX 建池", nowMs);
        add(l, { kind: "poolCreated", token, stage: "observation", detail: `${pool.protocol} 建池/初始化｜${pool.address}` });
      }
    } catch (error) { if (related) add(l, { kind: "decodeError", detail: `${a} ${t}：${error.message}（保留原始日志）`, raw: l }); }
  }
  for (const l of logs) {
    const t = lower(l.topics?.[0]), a = lower(l.address);
    try {
      const w = hexWords(l.data || "0x");
      if ([TOPICS.Transfer, TOPICS.Approval].includes(t)) {
        const from = addressTopic(l.topics[1]), to = addressTopic(l.topics[2]);
        if (!wallets.has(from) && !(t === TOPICS.Transfer && wallets.has(to))) continue;
        // Routine protocol fee inflows are not evidence of new quote-token preparation.
        if (t === TOPICS.Transfer && to === feeSafe && !wallets.has(from)) continue;
        const nft = l.topics.length === 4;
        const amount = nft ? abiUint(l.topics[3].slice(2)) : abiUint(w[0]);
        if (amount === "0") continue;
        const kind = t === TOPICS.Approval ? "approval" : nft ? (POSITION_MANAGERS.includes(a) ? "positionTransfer" : "nftTransfer") : "transfer";
        if (!nft && (wallets.has(from) || executors.has(to))) trackToken(state, a, "关联钱包资产流", nowMs);
        // Incoming dust never expands the monitored address set or implies stocking.
        if (t === TOPICS.Transfer && wallets.has(from)) candidate(state, to, `资金/仓位接收 ${receipt.transactionHash}`, nowMs);
        add(l, { kind, token: nft ? "" : a, stage: "observation", from, to, amount, tokenId: nft ? amount : undefined,
          detail: `${kind === "positionTransfer" ? "LP NFT 转移" : kind === "approval" ? "授权" : nft ? "NFT 转移" : "代币收支"} ${a}｜${from} → ${to}｜${nft ? "tokenId" : "原始数量"} ${amount}` });
        if (kind === "positionTransfer") {
          const key = `${a}:${amount}`, next = { manager: a, tokenId: amount, owner: to, blockNumber: Number(receipt.blockNumber), logIndex: Number(l.logIndex || 0) };
          if (!state.positions[key] || chainOrder(next, state.positions[key]) >= 0) state.positions[key] = { ...state.positions[key], ...next };
        }
      } else if ([TOPICS.Deposit, TOPICS.Withdraw].includes(t) && related) {
        const participant = [addressTopic(l.topics[1]), addressTopic(l.topics[2]), addressTopic(l.topics[3])].some(x => wallets.has(x));
        if (!participant || (t === TOPICS.Deposit && w.length !== 2)) continue;
        trackToken(state, a, "ERC4626 事件，待 asset() 复核", nowMs);
        add(l, { kind: t === TOPICS.Deposit ? "wrap" : "redeem", token: a, stage: "observation", detail: `${t === TOPICS.Deposit ? "存入并铸造包装份额" : "赎回包装份额"} ${a}｜原始参数 ${w.map(abiUint).join(" / ")}；asset() 映射待复核` });
      } else if ([TOPICS.ModuleSuccess, TOPICS.ModuleFailure, TOPICS.EnabledModule, TOPICS.DisabledModule,
        TOPICS.AddedOwner, TOPICS.RemovedOwner, TOPICS.ChangedThreshold, TOPICS.SafeReceived].includes(t) && wallets.has(a)) {
        if (t === TOPICS.SafeReceived && a === feeSafe && !wallets.has(addressTopic(l.topics[1]))) continue;
        add(l, { kind: "safeOperation", detail: `Safe ${a}｜${Object.keys(TOPICS).find(k => TOPICS[k] === t)}｜参数 ${JSON.stringify(l.topics.slice(1))} ${l.data}`, raw: l });
      } else if (a === ALLOWANCE_MODULE) {
        const known = new Set([...wallets].map(x => x.slice(2)));
        if (![...(l.topics || []), ...w].some(x => known.has(x.replace(/^0x/, "").slice(-40)))) continue;
        add(l, { kind: "allowance", detail: `额度模块事件 ${t}；参数原值已保留`, raw: l });
      } else if ([TOPICS.RoleGranted, TOPICS.OwnershipTransferred].includes(t)
        && [FLAP_FACTORY_PROXY, "0x90497450f2a706f1951b5bdda52b4e5d16f34c06", ...PROXY_ADMINS].includes(a)) {
        const account = addressTopic(l.topics[2]);
        candidate(state, account, `链上权限变更 ${a} ${receipt.transactionHash}`, nowMs);
        add(l, { kind: "authority", detail: `合约 ${a} 权限/管理员变更 → ${account}；新地址需核验`, raw: l });
      }
      const pool = state.pools[a] || state.pools[`${a}:${lower(l.topics?.[1])}`];
      if (!pool) {
        if (related && [DEX.v4Manager, DEX.clManager, DEX.binManager].includes(a)
          && [TOPICS.ModifyLiquidity, TOPICS.BinMint, TOPICS.BinBurn].includes(t)) add(l, { kind: "unmappedLiquidity", detail: `发现关联流动性操作｜管理器 ${a}｜poolId ${l.topics[1]}；资产映射尚未取得，保留日志供核验`, raw: l });
        continue;
      }
      if (!related && !pool.tokens.some(token => state.tokens[token])) continue;
      let direction = 0;
      if (t === TOPICS.V3Mint && pool.protocol === "V3") direction = BigInt(`0x${w[1]}`) > 0n ? 1 : 0;
      if (t === TOPICS.V3Burn && pool.protocol === "V3") direction = BigInt(`0x${w[0]}`) > 0n ? -1 : 0;
      if (t === TOPICS.V2Mint && pool.protocol === "V2") direction = w.some(x => BigInt(`0x${x}`) > 0n) ? 1 : 0;
      if (t === TOPICS.V2Burn && pool.protocol === "V2") direction = -1;
      if (t === TOPICS.ModifyLiquidity && pool.poolId) {
        const delta = BigInt.asIntN(256, BigInt(`0x${w[2]}`));
        direction = delta > 0n ? 1 : delta < 0n ? -1 : 0;
      }
      if (t === TOPICS.BinMint && pool.protocol === "Infinity Bin") direction = 1;
      if (t === TOPICS.BinBurn && pool.protocol === "Infinity Bin") direction = -1;
      if (direction && related) pool.officialOperation = true;
      if (direction) for (const token of poolSignalTokens(pool)) {
        trackToken(state, token, "已核验池子的流动性变化", nowMs);
        add(l, {
        kind: direction > 0 ? "liquidityAdded" : "liquidityRemoved", token, stage: direction > 0 ? "prepared" : "observation",
        detail: `${pool.protocol} ${direction > 0 ? "增加" : "减少"}流动性｜${pool.address}`, raw: l,
        });
      }
    } catch (error) { if (related) add(l, { kind: "decodeError", detail: `${a} ${t}：${error.message}`, raw: l }); }
  }
  return emitted;
}

async function jsonGet(url, { fetchFn = globalThis.fetch, timeoutMs = 5000, apiKey = "" } = {}) {
  const response = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs), headers: { Accept: "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) } });
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status} (${new URL(url).hostname})`);
    const raw = response.headers?.get?.("retry-after");
    error.retryAfterMs = Number.isFinite(Number(raw)) ? Number(raw) * 1000 : Math.max(0, Date.parse(raw) - Date.now()) || 0;
    throw error;
  }
  return response.json();
}
async function sourcePass(state, name, fn, nowMs, intervalMs = 0) {
  const health = state.health[name] ||= {};
  if (Number(health.nextAttemptAtMs) > nowMs || nowMs - (health.lastSuccessMs || 0) < intervalMs) return;
  try {
    await fn();
    Object.assign(health, { lastSuccessAt: iso(nowMs), lastSuccessMs: nowMs, failures: 0, lastError: "", nextAttemptAtMs: 0 });
  } catch (error) {
    health.failures = (health.failures || 0) + 1;
    health.lastError = error.message;
    health.nextAttemptAtMs = nowMs + Math.max(Number(error.retryAfterMs) || 0, Math.min(name === "chain" || name === "realtime" ? 60_000 : 1800000, 5000 * 2 ** Math.min(9, health.failures - 1)));
  }
}

export function ingestCowOrders(state, owner, orders, { nowMs = Date.now(), bootstrap = false } = {}) {
  if (!Array.isArray(orders)) throw new Error("CoW 订单响应不是数组");
  for (const order of orders) {
    if (!/^0x[a-f0-9]{112}$/i.test(order.uid || "")) continue;
    if (lower(order.owner) !== lower(owner)) throw new Error("CoW 订单 owner 不匹配");
    const previous = state.orders[order.uid];
    const status = ["open", "presignaturePending"].includes(order.status) && Number(order.validTo) * 1000 <= nowMs ? "expired" : order.status;
    const fingerprint = [status, order.executedSellAmount, order.executedBuyAmount].join(":");
    const next = { uid: order.uid, owner: lower(owner), buyToken: lower(order.buyToken), sellToken: lower(order.sellToken),
      fingerprint, status, revision: (previous?.revision || 0) + (previous?.fingerprint === fingerprint ? 0 : 1), creationDate: order.creationDate, validTo: order.validTo, lastSeenAt: iso(nowMs) };
    const active = ["open", "presignaturePending"].includes(order.status) && Number(order.validTo) * 1000 > nowMs;
    if (bootstrap && !active || previous?.fingerprint === fingerprint) { state.orders[order.uid] = next; continue; }
    const token = lower(order.buyToken);
    trackToken(state, token, "CoW 采购目标", nowMs);
    const stage = ["fulfilled", "open", "presignaturePending"].includes(status) ? "stocking" : "observation";
    emit(state, { id: `cow:${order.uid}:${next.revision}:${fingerprint}`, source: "cow", kind: "order", token, stage,
      orderUid: order.uid, status, sourceTime: order.creationDate,
      detail: `CoW ${status}｜${owner}｜卖出 ${order.sellToken} → 买入 ${token}｜原始卖出数量 ${order.sellAmount}｜有效期 ${iso(Number(order.validTo) * 1000)}` }, { nowMs });
    state.orders[order.uid] = next;
  }
}
export async function scanCowOrders(state, config, fetchFn, nowMs) {
  const owners = uniq([...(config.wallets || EXECUTION_WALLETS), ...(config.safes || CORE_SAFES.map(([a]) => a))]);
  for (const owner of owners) await sourcePass(state, `cow:${lower(owner)}`, async () => {
    const bootstrap = !state.health[`cow:${lower(owner)}`]?.lastSuccessAt;
    const all = [];
    let complete = false;
    for (let offset = 0; offset < 1000; offset += 100) {
      const page = await jsonGet(`${config.cowApiBaseUrl || "https://api.cow.fi/bnb/api/v1"}/account/${owner}/orders?limit=100&offset=${offset}`, { fetchFn, timeoutMs: config.timeoutMs });
      if (!Array.isArray(page)) throw new Error("CoW 分页格式错误");
      all.push(...page);
      // Complete snapshot prevents missing old, still open orders. Never infer cancellation from absence.
      if (page.length < 100) { complete = true; break; }
    }
    if (!complete) throw new Error("CoW 订单超过分页上限，未完成快照");
    ingestCowOrders(state, owner, all, { nowMs, bootstrap });
  }, nowMs, config.scheduledSource ? 0 : config.cowIntervalMs || 10000);
}

export function syncEarlyProposals(state, safeState, nowMs = Date.now()) {
  for (const record of Object.values(safeState?.proposals || {})) {
    const fp = [record.status, record.confirmations, record.required, record.nonceBlocked, record.executionCheck?.status, hash(JSON.stringify(record.actions || []))].join(":");
    if (state.proposalVersions[record.key] === fp) continue;
    state.proposalVersions[record.key] = fp;
    for (const a of record.actions || []) {
      if (a.quoteToken) trackToken(state, a.quoteToken, "Safe 配置提案", nowMs);
      if (a.kind === "transfer" || a.kind === "positionTransfer" || a.kind === "funding") candidate(state, a.recipient, `Safe 计划调拨 ${record.safeTxHash}`, nowMs);
    }
    // A route alone is preparation, not a proposal to enable creating tokens.
    const lastConfig = record.actions?.filter(a => a.kind === "configuration").at(-1);
    const lastCreation = record.actions?.filter(a => a.kind === "creation").at(-1);
    const enable = (lastConfig ? lastConfig.config.enabled === 1 : lastCreation?.disabled === false) && lastCreation?.disabled !== true;
    if (!enable || !record.quoteToken) continue;
    const active = ["pending", "ready"].includes(record.status);
    emit(state, { id: `proposal:${record.key}:${fp}`, kind: "proposal", source: "safe", token: record.quoteToken,
      safeTxHash: record.safeTxHash, status: record.status, sourceTime: record.submissionDate,
      stage: active ? record.executionCheck?.status === "passed" ? "executable" : record.status === "ready" ? "signed" : "proposed" : "observation",
      detail: `开放提案 ${record.status}｜签名 ${record.confirmations}/${record.required}｜nonce ${record.nonce}${record.nonceBlocked ? "，前序 nonce 未执行" : ""}；${record.executionCheck?.status === "passed" ? "当前模拟通过，不保证后续执行成功" : "执行条件未核验"}` }, { nowMs, silent: true });
  }
}

export async function scanAddressDiscovery(state, config, fetchFn, nowMs) {
  const base = (config.safeApiBaseUrl || "https://api.safe.global/tx-service/bnb/api/v1").replace(/\/$/, "");
  const opts = { fetchFn, timeoutMs: config.timeoutMs, apiKey: config.safeApiKey || "" };
  const safes = uniq([...(config.safes || CORE_SAFES.map(([a]) => a)), ...AUXILIARY_SAFES]);
  for (const safe of safes) {
    const info = await jsonGet(`${base}/safes/${safe}/`, opts);
    if (lower(info.address) !== lower(safe) || !Array.isArray(info.owners) || !Array.isArray(info.modules)) throw new Error("Safe 元数据无效");
    const previous = state.safeInfo[lower(safe)];
    const fp = JSON.stringify([info.owners.map(lower).sort(), info.threshold, info.modules.map(lower).sort(), info.guard]);
    if (previous && fp !== JSON.stringify([previous.owners.map(lower).sort(), previous.threshold, previous.modules.map(lower).sort(), previous.guard])) emit(state, {
      id: `safe-info:${lower(safe)}:${hash(fp)}`, kind: "authority", source: "safe-api", detail: `Safe ${safe} 签名人/阈值/模块/guard 变化｜阈值 ${info.threshold}｜模块 ${info.modules.join(", ")}`,
    }, { nowMs });
    state.safeInfo[lower(safe)] = info;
  }
  const owners = uniq([...CORE_OWNERS, ...Object.values(state.safeInfo).flatMap(s => s.owners)]);
  for (const owner of owners) {
    const response = await jsonGet(`${base}/owners/${owner}/safes/`, opts);
    if (!Array.isArray(response.safes)) throw new Error("Safe owner 反查格式无效");
    for (const safe of response.safes) {
      const existing = state.candidates[lower(safe)];
      candidate(state, safe, `共同签名人 ${owner}（不代表官方归属）`, nowMs);
      if (!existing && state.lastDiscoveryAt && state.candidates[lower(safe)]) emit(state, { id: `discovery:${lower(safe)}`, kind: "candidate", source: "safe-api", detail: `新关联 Safe ${safe}｜共同签名人 ${owner}；仅列观察，不自动信任` }, { nowMs });
    }
  }
  state.lastDiscoveryAt = nowMs;
}

export function rewindEarlySignals(state, fromBlock, nowMs = Date.now()) {
  state.reorgRevision = (state.reorgRevision || 0) + 1;
  for (const block of Object.keys(state.fastBlocks || {})) if (Number(block) >= fromBlock) delete state.fastBlocks[block];
  const invalid = new Set(Object.values(state.events).filter(e => Number.isInteger(e.blockNumber) && e.blockNumber >= fromBlock).map(e => e.id));
  for (const id of invalid) delete state.events[id];
  state.pendingChanges = state.pendingChanges.filter(e => !invalid.has(e.id));
  for (const [id, pool] of Object.entries(state.pools)) if (pool.blockNumber >= fromBlock) delete state.pools[id];
  for (const [id, pos] of Object.entries(state.positions)) if (pos.blockNumber >= fromBlock) delete state.positions[id];
  state.balances = {};
  state.stages = {};
  for (const meta of Object.values(state.tokens)) {
    delete meta.effectiveEnabled;
    delete meta.configurationCheckedAt;
  }
  emit(state, { id: `reorg:${state.cursorHash}:${fromBlock}`, kind: "reorg", source: "chain", detail: `检测到链重组：撤回 ${invalid.size} 条本地信号并从区块 ${fromBlock} 重扫；此前相关通知暂不作为确认依据` }, { nowMs });
  state.cursor = Math.min(state.cursor ?? fromBlock - 1, fromBlock - 1);
  if (state.realtimeCursor != null) state.realtimeCursor = Math.min(state.realtimeCursor, fromBlock - 1);
  state.realtimeCursorHash = "";
  state.cursorHash = "";
}

async function strictRpc(rpcBatch, method, params) {
  const [value] = await rpcBatch([{ method, params }], { requireAllResults: true });
  if (value == null) throw new Error(`${method} 返回空结果`);
  return value;
}
async function resolveReceiptPools(state, receipts, rpcBatch, config) {
  const walletSet = new Set(watchedWallets(config));
  const wanted = new Set();
  for (const receipt of receipts) {
    const related = walletSet.has(lower(receipt.from)) || receipt.logs?.some(l => l.topics?.[0] === TOPICS.Transfer
      && [addressTopic(l.topics[1]), addressTopic(l.topics[2])].some(a => walletSet.has(a)));
    if (!related) continue;
    for (const l of receipt.logs || []) if ([TOPICS.V3Mint, TOPICS.V3Burn, TOPICS.V2Mint, TOPICS.V2Burn].includes(lower(l.topics?.[0])) && !state.pools[lower(l.address)]) wanted.add(lower(l.address));
  }
  for (const pool of [...wanted].slice(0, 30)) {
    const calls = ["0x0dfe1681", "0xd21220a7", "0xc45a0155", "0xddca3f43"].map(data => ({ method: "eth_call", params: [{ to: pool, data }, "latest"] }));
    const values = await rpcBatch(calls);
    const token0 = addressTopic(values[0]), token1 = addressTopic(values[1]), factory = addressTopic(values[2]);
    if (!token0 || !token1 || ![DEX.v2Factory, DEX.v3Factory].includes(factory)) continue;
    const protocol = factory === DEX.v3Factory ? "V3" : "V2";
    if (protocol === "V3" && !/^0x[a-f0-9]{64}$/i.test(values[3] || "")) continue;
    const data = (protocol === "V3" ? "0x1698ee82" : "0xe6a43905") + pad(token0).slice(2) + pad(token1).slice(2) + (protocol === "V3" ? values[3].slice(2) : "");
    const [registered] = await rpcBatch([{ method: "eth_call", params: [{ to: factory, data }, "latest"] }]);
    if (addressTopic(registered) !== pool) continue;
    state.pools[pool] = { address: pool, protocol, tokens: [token0, token1], verified: true, blockNumber: 0 };
  }
}
export async function refreshEarlyPositions(state, rpcBatch) {
  for (const position of Object.values(state.positions).filter(p => !p.tokens && p.manager === DEX.v3Positions).slice(0, 10)) {
    const [value] = await rpcBatch([{ method: "eth_call", params: [{ to: position.manager, data: "0x99fbab88" + BigInt(position.tokenId).toString(16).padStart(64, "0") }, "latest"] }]);
    try {
      const w = hexWords(value);
      if (w.length !== 12) continue;
      const current = state.positions[`${position.manager}:${position.tokenId}`];
      if (!current) continue;
      current.tokens = [abiAddress(w[2]), abiAddress(w[3])];
      current.fee = Number(BigInt(`0x${w[4]}`));
      for (const e of state.pendingChanges) if (e.kind === "positionTransfer" && e.tokenId === current.tokenId && e.detail.includes(current.manager)) e.detail += `｜资产 ${current.tokens.join(" / ")}｜fee ${current.fee}`;
    } catch { /* A burnt/reverting position remains an NFT movement, never a guessed pool. */ }
  }
}
export async function refreshNativeBalances(state, config, rpcBatch, nowMs) {
  // Fee collection wallets change on nearly every trade. Observe execution/funding balances,
  // while all watched Safes still have direct-transfer and module-event coverage.
  const wallets = uniq([...(config.wallets || EXECUTION_WALLETS).map(lower), "0xcd561eb3828232d3ec174fb5e321586209fbf535"]);
  const balances = await rpcBatch(wallets.map(address => ({ method: "eth_getBalance", params: [address, "latest"] })), { requireAllResults: true });
  for (let i = 0; i < wallets.length; i++) {
    if (!/^0x[a-f0-9]+$/i.test(balances[i] || "")) throw new Error("BNB 余额无效");
    const address = wallets[i], current = BigInt(balances[i]).toString(), previous = state.balances[address];
    if (previous !== undefined && previous !== current) emit(state, { id: `balance:${address}:${nowMs}`, kind: "nativeBalance", source: "rpc",
      detail: `BNB 余额净变动 ${address}｜wei ${BigInt(current) - BigInt(previous)}；含 Gas/内部转账影响，不等同单笔转账` }, { nowMs });
    state.balances[address] = current;
  }
}
export async function scanEarlyChain(state, config, rpcBatch, nowMs) {
  const cursorKey = config.realtime ? "realtimeCursor" : "cursor";
  const hashKey = config.realtime ? "realtimeCursorHash" : "cursorHash";
  const chain = await strictRpc(rpcBatch, "eth_chainId", []);
  if (Number(chain) !== 56) throw new Error("RPC chainId 不是 BSC 56");
  const latest = Number(await strictRpc(rpcBatch, "eth_blockNumber", []));
  state.latestBlock = latest;
  const confirmations = config.confirmations ?? 1;
  const head = Math.min(latest - confirmations, config.realtime ? Infinity : state.historyEndBlock ?? Infinity);
  await validateFastBlocks(state, head, rpcBatch, nowMs);
  const bootstrap = state[cursorKey] == null;
  let scanCursor = bootstrap ? Math.max(0, head - (config.bootstrapBlocks ?? 2)) : state[cursorKey];
  if (scanCursor > head) return;
  if (state[hashKey]) {
    const previous = await strictRpc(rpcBatch, "eth_getBlockByNumber", [blockTag(state[cursorKey]), false]);
    if (lower(previous.hash) !== state[hashKey]) {
      rewindEarlySignals(state, Math.max(1, state[cursorKey] - REORG_WINDOW), nowMs);
      scanCursor = state[cursorKey];
    }
  }
  const from = scanCursor + 1;
  const to = Math.min(head, from + (config.maxBlocksPerRun || 10) - 1);
  if (from > to) return;
  const reorgRevision = state.reorgRevision || 0;
  const boundary = await strictRpc(rpcBatch, "eth_getBlockByNumber", [blockTag(to), false]);
  const filters = earlyLogFilters(state, config);
  const logs = [];
  // Some public BSC nodes disable batch eth_getLogs: keep these requests independent.
  for (let i = 0; i < filters.length; i += 3) {
    const pages = await Promise.all(filters.slice(i, i + 3).map(filter =>
      strictRpc(rpcBatch, "eth_getLogs", [{ ...filter, fromBlock: blockTag(from), toBlock: blockTag(to) }])));
    for (const page of pages) {
      if (!Array.isArray(page)) throw new Error("eth_getLogs 非数组");
      logs.push(...page);
    }
  }
  const transactionMap = new Map();
  if (config.nativeTransactions !== false) {
    const wallets = new Set(watchedWallets(config));
    const blocks = await rpcBatch(Array.from({ length: to - from + 1 }, (_, i) => ({ method: "eth_getBlockByNumber", params: [blockTag(from + i), true] })), { requireAllResults: true });
    for (const block of blocks) {
      if (!Array.isArray(block.transactions)) throw new Error("完整区块交易不可用");
      for (const tx of block.transactions) if (wallets.has(lower(tx.from)) || wallets.has(lower(tx.to))) transactionMap.set(lower(tx.hash), tx);
    }
  }
  const hashes = uniq([...logs.map(l => lower(l.transactionHash)), ...transactionMap.keys()]);
  if (hashes.length > 300) throw new Error("单窗口关联交易超过 300，请降低 FLAP_EARLY_MAX_BLOCKS");
  const receipts = [];
  for (let i = 0; i < hashes.length; i += 20) {
    const result = await rpcBatch(hashes.slice(i, i + 20).map(h => ({ method: "eth_getTransactionReceipt", params: [h] })), { requireAllResults: true });
    if (result.some(r => !r?.blockHash || Number(r.blockNumber) < from || Number(r.blockNumber) > to)) throw new Error("回执尚未就绪/不在扫描窗口");
    receipts.push(...result);
  }
  const receiptBlocks = uniq(receipts.map(receipt => receipt.blockNumber));
  const canonicalBlocks = await rpcBatch(receiptBlocks.map(number => ({ method: "eth_getBlockByNumber", params: [number, false] })), { requireAllResults: true });
  const canonicalHashes = new Map(receiptBlocks.map((number, i) => [number, lower(canonicalBlocks[i]?.hash)]));
  if (receipts.some(receipt => !canonicalHashes.get(receipt.blockNumber) || lower(receipt.blockHash) !== canonicalHashes.get(receipt.blockNumber)))
    throw new Error("回执区块已重组，保留游标重试");
  // Fetch pool metadata outside the commit, then merge only this field into the draft.
  const resolved = { pools: structuredClone(state.pools) };
  await resolveReceiptPools(resolved, receipts, rpcBatch, config);
  const check = await strictRpc(rpcBatch, "eth_getBlockByNumber", [blockTag(to), false]);
  if (lower(check.hash) !== lower(boundary.hash)) throw new Error("扫描期间发生重组，保留游标重试");
  if ((state.reorgRevision || 0) !== reorgRevision) throw new Error("并发快速通道检测到重组，保留游标重试");
  // Commit a complete window atomically in memory. Any malformed response leaves the old cursor intact.
  const draft = structuredClone(state);
  Object.assign(draft.pools, resolved.pools);
  for (const receipt of receipts.sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber) || Number(a.transactionIndex) - Number(b.transactionIndex))) {
    const tx = transactionMap.get(lower(receipt.transactionHash));
    decodeEarlyReceipt(receipt, draft, { config, nowMs, silent: bootstrap, transaction: tx });
    if (tx && Number(receipt.status) === 1 && BigInt(tx.value || "0") > 0n) {
      emit(draft, { id: `native:${receipt.blockHash}:${tx.hash}`, kind: "nativeTransfer", source: "chain", blockNumber: Number(receipt.blockNumber), blockHash: lower(receipt.blockHash),
        transactionHash: lower(tx.hash), detail: `BNB 直接转账 ${tx.from} → ${tx.to}｜wei ${BigInt(tx.value).toString()}（不含内部调用）` }, { nowMs, silent: bootstrap });
    }
  }
  if (config.realtime && bootstrap && draft.historyEndBlock == null) draft.historyEndBlock = scanCursor;
  draft[cursorKey] = to;
  draft[hashKey] = lower(boundary.hash);
  draft.chainBaselineAt ||= iso(nowMs);
  for (const block of Object.keys(draft.fastBlocks || {})) if (Number(block) <= to) delete draft.fastBlocks[block];
  // Source health entries can be held by a concurrent API pass across an await.
  Object.assign(state, draft, { health: state.health });
}

async function validateFastBlocks(state, head, rpcBatch, nowMs) {
  const anchors = Object.entries(state.fastBlocks || {}).filter(([block]) => Number(block) <= head);
  if (!anchors.length) return;
  const blocks = await rpcBatch(anchors.map(([block]) => ({ method: "eth_getBlockByNumber", params: [blockTag(Number(block)), false] })), { requireAllResults: true });
  for (let i = 0; i < anchors.length; i++) {
    if (!blocks[i]?.hash) throw new Error("快速信号区块校验不可用");
    if (lower(blocks[i].hash) !== anchors[i][1]) {
      rewindEarlySignals(state, Math.max(1, Math.min(Number(anchors[i][0]), (state.cursor ?? 0) + 1)), nowMs);
      return;
    }
  }
}

// Fast lane never advances the HTTP cursor. Both lanes use receipt log IDs for deduplication.
export async function processEarlyReceiptHints(state, hints, config, rpcBatch, nowMs = Date.now()) {
  if (!state.chainBaselineAt) return { processed: [], tokens: [] };
  const chain = await strictRpc(rpcBatch, "eth_chainId", []);
  if (Number(chain) !== 56) throw new Error("RPC chainId 不是 BSC 56");
  const latest = Number(await strictRpc(rpcBatch, "eth_blockNumber", []));
  const head = latest - (config.confirmations ?? 1);
  await validateFastBlocks(state, head, rpcBatch, nowMs);
  const eligible = hints.filter(h => Number(h.blockNumber) <= head).slice(0, 20);
  const processed = [], tokens = new Set();
  for (const hint of eligible) {
    const reorgRevision = state.reorgRevision || 0;
    const receipt = await strictRpc(rpcBatch, "eth_getTransactionReceipt", [hint.transactionHash]);
    if (lower(receipt.transactionHash) !== lower(hint.transactionHash) || Number(receipt.blockNumber) > head) continue;
    const block = await strictRpc(rpcBatch, "eth_getBlockByNumber", [receipt.blockNumber, false]);
    if (lower(block.hash) !== lower(receipt.blockHash)) continue;
    if (!state.fastBlocks?.[Number(receipt.blockNumber)] && Object.keys(state.fastBlocks || {}).length >= 128) break;
    const resolved = { pools: structuredClone(state.pools) };
    await resolveReceiptPools(resolved, [receipt], rpcBatch, config);
    const check = await strictRpc(rpcBatch, "eth_getBlockByNumber", [receipt.blockNumber, false]);
    if (lower(check.hash) !== lower(receipt.blockHash)) continue;
    if ((state.reorgRevision || 0) !== reorgRevision) continue;
    const draft = structuredClone(state);
    Object.assign(draft.pools, resolved.pools);
    const events = decodeEarlyReceipt(receipt, draft, { config, nowMs });
    draft.fastBlocks ||= {};
    if (Number(receipt.blockNumber) > (state.cursor ?? 0)) draft.fastBlocks[Number(receipt.blockNumber)] = lower(receipt.blockHash);
    Object.assign(state, draft, { health: state.health });
    for (const event of events) if (event.token) tokens.add(event.token);
    processed.push(hint.transactionHash);
  }
  return { processed, tokens: [...tokens] };
}

export async function refreshEarlyAssets(state, config, rpcBatch, nowMs) {
  const addresses = keys(state.tokens);
  const start = (state.assetCursor || 0) % Math.max(1, addresses.length);
  const priority = (config.priorityTokens || []).filter(token => state.tokens[token]);
  const selected = uniq([...priority, ...addresses.slice(start), ...addresses.slice(0, start)]).slice(0, config.assetsPerRun || 10);
  if (!priority.length) state.assetCursor = start + selected.length;
  for (const token of selected) {
    const values = await rpcBatch([
      { method: "eth_call", params: [{ to: token, data: "0x38d52e0f" }, "latest"] },
      { method: "eth_call", params: [{ to: config.factoryAddress || FLAP_FACTORY_PROXY, data: QUOTE_CONFIG_SELECTOR + token.slice(2).padStart(64, "0") }, "latest"] },
      { method: "eth_call", params: [{ to: config.factoryAddress || FLAP_FACTORY_PROXY, data: QUOTE_TOKEN_CREATION_DISABLED_SELECTOR + token.slice(2).padStart(64, "0") }, "latest"] },
    ]);
    const meta = state.tokens[token];
    const underlying = addressTopic(values[0]);
    if (underlying && underlying !== ZERO && underlying !== token) {
      meta.underlying = underlying;
      meta.mappingVerifiedAt = iso(nowMs);
      for (const event of Object.values(state.events)) if (event.token === token && event.kind === "wrap") event.stage = "stocking";
    }
    // Never convert RPC errors/empty reads into disabled/opened states.
    if (!/^0x[a-f0-9]{320}$/i.test(values[1] || "") || !/^0x0{63}[01]$/i.test(values[2] || "")) throw new Error(`资产 ${token} 的 Factory 配置读取失败，保留上次快照`);
    const enabled = BigInt(`0x${values[1].slice(2, 66)}`) === 1n && BigInt(values[2]) === 0n;
    const previous = meta.effectiveEnabled;
    if (previous !== undefined && previous !== enabled || previous === undefined && enabled) {
      emit(state, { id: `configuration:${token}:${enabled}:${iso(nowMs)}`, kind: "configuration", source: "rpc", token,
        stage: enabled ? "opened" : "disabled", detail: `${enabled ? "链上 getter 确认支持创建" : "链上 getter 确认暂停／停用"}；兑换路径与成交条件仍以实际链上状态为准` }, { nowMs, silent: previous === undefined && enabled });
    }
    meta.effectiveEnabled = enabled;
    if (enabled) meta.everEnabled = true;
    meta.configurationCheckedAt = iso(nowMs);
  }
}

export function earlyAssetStage(state, token) {
  const meta = state.tokens[token] || {};
  if (meta.effectiveEnabled === true) return "opened";
  const signals = Object.values(state.events).filter(e => e.token === token);
  const proposals = new Map(signals.filter(e => e.kind === "proposal").map(e => [e.safeTxHash, e]));
  for (const stage of ["executable", "signed", "proposed"]) if ([...proposals.values()].some(e => e.stage === stage)) return stage;
  if (meta.effectiveEnabled === false && meta.everEnabled) return "disabled";
  const liquidity = signals.filter(e => ["liquidityAdded", "liquidityRemoved"].includes(e.kind)).sort(chainOrder).at(-1);
  if (liquidity?.kind === "liquidityAdded") return "prepared";
  const order = signals.filter(e => e.kind === "order").at(-1);
  const wrapping = signals.filter(e => ["wrap", "redeem"].includes(e.kind)).sort(chainOrder).at(-1);
  if (order?.stage === "stocking" || wrapping?.kind === "wrap" && meta.underlying) return "stocking";
  return "observation";
}

export function buildEarlySignalContent(changes, state) {
  const groups = new Map();
  for (const e of changes) {
    const key = e.token || e.kind;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  const lines = [];
  for (const [key, events] of groups) {
    const token = events[0].token;
    const stage = token ? earlyAssetStage(state, token) : "observation";
    const color = stage === "opened" ? "green" : stage === "disabled" ? "red" : "orange";
    lines.push(`**🔎 <font color='${color}'>${token ? stageLabel(stage) : "关联操作"}</font>**`);
    if (token) lines.push(`资产：[${token}](https://bscscan.com/address/${token})`);
    if (state.tokens[token]?.underlying) lines.push(`原始资产：${state.tokens[token].underlying}`);
    if (state.tokens[token]?.configurationCheckedAt) lines.push(`链上状态最后复核：${state.tokens[token].configurationCheckedAt}`);
    if (state.health.assets?.lastError) lines.push("当前配置复核异常，上述状态为缓存快照。");
    for (const e of events) {
      lines.push(`• ${e.detail}`);
      if (e.sourceTime) lines.push(`来源时间：${e.sourceTime}`);
      lines.push(`首次观测：${e.observedAt}`);
      if (e.transactionHash) lines.push(`[交易](https://bscscan.com/tx/${e.transactionHash})｜区块 ${e.blockNumber}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
function prune(state, nowMs) {
  const protectedIds = new Set(state.pendingChanges.map(e => e.id));
  const entries = Object.entries(state.events);
  if (entries.length > MAX_EVENTS) {
    const removable = entries.filter(([id, e]) => !protectedIds.has(id) && (!e.blockNumber || e.blockNumber < state.cursor - REORG_WINDOW));
    for (const [id] of removable.slice(0, entries.length - MAX_EVENTS)) delete state.events[id];
  }
  for (const [uid, order] of Object.entries(state.orders)) if (nowMs - Date.parse(order.lastSeenAt) > 30 * DAY && !["open", "presignaturePending"].includes(order.status)) delete state.orders[uid];
}
export async function runEarlySignalScan({ state, config = {}, rpcBatch, fetchFn = globalThis.fetch, safeState, nowMs = Date.now() }) {
  if (!state || typeof rpcBatch !== "function") throw new Error("缺少提前监控状态或 RPC");
  syncEarlyProposals(state, safeState, nowMs);
  if (config.mode !== "external") await sourcePass(state, config.realtime ? "realtime" : "chain", () => scanEarlyChain(state, config, rpcBatch, nowMs), nowMs);
  if (config.mode !== "chain") {
    const enabled = source => !config.sources || config.sources.includes(source);
    const periodicInterval = config.scheduledSource ? 0 : 10000;
    if (enabled("cow")) await scanCowOrders(state, config, fetchFn, nowMs);
    if (enabled("assets")) await sourcePass(state, "assets", () => refreshEarlyAssets(state, config, rpcBatch, nowMs), nowMs, config.priorityTokens?.length || config.scheduledSource ? 0 : config.assetIntervalMs || 10000);
    if (enabled("positions")) await sourcePass(state, "positions", () => refreshEarlyPositions(state, rpcBatch), nowMs, periodicInterval);
    if (enabled("balances")) await sourcePass(state, "balances", () => refreshNativeBalances(state, config, rpcBatch, nowMs), nowMs, periodicInterval);
    if (enabled("discovery")) await sourcePass(state, "discovery", () => scanAddressDiscovery(state, config, fetchFn, nowMs), nowMs, config.discoveryIntervalMs || DAY);
  }
  state.lastRunAt = iso(nowMs);
  prune(state, nowMs);
  return { changed: state.pendingChanges.length > 0, errors: Object.entries(state.health).filter(([, h]) => h.lastError).map(([name, h]) => `${name}: ${h.lastError}`) };
}
