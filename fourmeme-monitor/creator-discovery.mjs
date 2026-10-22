import { formatBeijingTime } from "../shared/display-format.cjs";

const addressPattern = /^0x[0-9a-f]{40}$/i;
const hashPattern = /^0x[0-9a-f]{64}$/i;
const normalized = value => String(value || "").toLowerCase();

export async function verifyCreatorCandidate(contract, candidate, rpc) {
  if (!addressPattern.test(contract) || !addressPattern.test(candidate?.creator) || !hashPattern.test(candidate?.txHash)) throw new Error("创建者候选缺少有效地址或创建交易哈希");
  const txHash = normalized(candidate.txHash);
  const [transaction, receipt] = await rpc([
    { method: "eth_getTransactionByHash", params: [txHash] },
    { method: "eth_getTransactionReceipt", params: [txHash] },
  ]);
  if (!transaction || !receipt) throw new Error("创建交易或回执暂缺，保留候选重试");
  if (normalized(transaction.hash) !== txHash || normalized(receipt.transactionHash) !== txHash) throw new Error("创建交易或回执哈希不匹配");
  if (receipt.status !== "0x1" || !hashPattern.test(receipt.blockHash) || normalized(transaction.blockHash) !== normalized(receipt.blockHash) || transaction.blockNumber !== receipt.blockNumber) throw new Error("创建交易状态或回执区块不匹配");
  if (transaction.to || normalized(receipt.contractAddress) !== normalized(contract)) throw new Error("非目标合约的直接创建回执；内部工厂创建需额外 trace 证据，暂不纳入");
  if (normalized(transaction.from) !== normalized(candidate.creator) || normalized(receipt.from) !== normalized(transaction.from)) throw new Error("创建者与交易/回执发起者不匹配");
  const [block] = await rpc([{ method: "eth_getBlockByNumber", params: [receipt.blockNumber, false] }]);
  if (!block || normalized(block.hash) !== normalized(receipt.blockHash) || block.number !== receipt.blockNumber || !block.transactions?.some(item => normalized(typeof item === "string" ? item : item.hash) === txHash)) throw new Error("创建交易不在核验区块中，保留候选");
  return { creator: normalized(transaction.from), txHash, source: candidate.source || "verified_creation", evidence: "direct_creation_receipt", blockNumber: Number(BigInt(receipt.blockNumber)), blockHash: normalized(block.hash), updatedAt: formatBeijingTime() };
}

export async function discoverCreators({ previous = {}, contracts, known = {}, lookup, rpc, now = Date.now }) {
  const state = structuredClone(previous);
  state.creators ||= {};
  state.pending ||= {};
  state.lookup ||= {};
  const missing = contracts.filter(item => !addressPattern.test(known[item.address]?.creator) && !addressPattern.test(state.creators[item.address]?.creator));
  const targets = new Set(missing.map(item => item.address));
  for (const address of Object.keys(state.pending)) if (!targets.has(address)) delete state.pending[address];
  for (const item of missing) state.pending[item.address] ||= { labels: item.labels || [], firstSeenAt: now(), attempts: 0, nextRetryAt: 0, lastError: "等待创建者来源" };
  const due = missing.filter(item => (state.pending[item.address].nextRetryAt || 0) <= now());
  if (due.some(item => !state.pending[item.address].candidate)) {
    const local = { creators: { ...known, ...state.creators }, creatorLookup: state.lookup };
    try {
      await lookup(missing, local);
      state.lookup = local.creatorLookup;
      for (const item of missing) {
        const candidate = local.creators[item.address];
        if (candidate?.creator) state.pending[item.address].candidate = candidate;
      }
    } catch (error) {
      state.lookup.lastError = error.message;
    }
  }
  const selected = due.sort((left, right) => (state.pending[left.address].lastAttemptAt || 0) - (state.pending[right.address].lastAttemptAt || 0)).slice(0, 2);
  for (const item of selected) {
    const pending = state.pending[item.address];
    pending.attempts++;
    pending.lastAttemptAt = now();
    try {
      if (!pending.candidate) throw new Error(state.lookup.apiLastError || state.lookup.pageLastError || state.lookup.chainLastError || state.lookup.lastError || "来源尚未找到创建交易，保留缺失清单");
      state.creators[item.address] = await verifyCreatorCandidate(item.address, pending.candidate, rpc);
      delete state.pending[item.address];
    } catch (error) {
      pending.lastError = error.message;
      if (/不匹配|非目标|缺少有效/.test(error.message)) delete pending.candidate;
      pending.nextRetryAt = now() + Math.min(30 * 60_000, 30_000 * 2 ** Math.min(pending.attempts - 1, 6));
    }
  }
  state.lastRunAt = now();
  state.watchedCount = contracts.length;
  state.missingCount = Object.keys(state.pending).length;
  return state;
}
