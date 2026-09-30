import { DEX, POSITION_MANAGERS } from './early-signal-catalog.mjs';
import { TOPICS } from './early-signal-topics.mjs';

export const POOL_KINDS = new Set(['poolCreated', 'liquidityAdded', 'liquidityRemoved']);
const lower = x => String(x || '').toLowerCase();
const address = x => /^0x[0-9a-f]{64}$/i.test(x || '') ? lower('0x' + x.slice(-40)) : '';
const words = data => /^0x(?:[0-9a-f]{64})+$/i.test(data || '') ? data.slice(2).match(/.{64}/g) : [];
const positionOrder = (log, pos) => Number(log.blockNumber) > Number(pos.blockNumber)
  || Number(log.blockNumber) === Number(pos.blockNumber) && Number(log.logIndex) >= Number(pos.logIndex || 0);

// A shared pool/position manager is not proof of wallet participation.
export function poolOperationRelevance(pool, log, logs, txFrom, state, wallets) {
  if (wallets.has(lower(txFrom))) return 'related';
  const transfers = logs.filter(l => lower(l.topics?.[0]) === TOPICS.Transfer);
  if (pool.protocol === 'V2' && transfers.some(l => lower(l.address) === pool.address && l.topics.length === 3
    && wallets.has(address(l.topics[1])))) return 'related';
  if (transfers.some(l => pool.tokens.includes(lower(l.address)) && l.topics.length === 3
    && ((wallets.has(address(l.topics[1])) && address(l.topics[2]) === (pool.manager || pool.address))
      || (address(l.topics[1]) === pool.address && wallets.has(address(l.topics[2])))))) return 'related';
  const t = lower(log.topics?.[0]);
  if ([TOPICS.V3Mint, TOPICS.V3Burn, TOPICS.V2Mint, TOPICS.V2Burn].includes(t)
    && wallets.has(address(log.topics[1]))) return 'related';
  if (t === TOPICS.ModifyLiquidity && wallets.has(address(log.topics[2]))) return 'related';
  // V4 PositionManager uses bytes32(tokenId) as its position salt.
  // https://github.com/Uniswap/v4-periphery/blob/main/src/PositionManager.sol
  if (t === TOPICS.ModifyLiquidity && pool.manager === DEX.v4Manager
    && address(log.topics[2]) === DEX.v4Positions) {
    const w = words(log.data);
    if (w.length === 4) {
      const id = BigInt('0x' + w[3]).toString();
      const pos = state.positions?.[`${DEX.v4Positions}:${id}`];
      if (pos && wallets.has(pos.owner)) return positionOrder(log, pos) ? 'related' : 'unknown';
      if (transfers.some(l => lower(l.address) === DEX.v4Positions && l.topics.length === 4
        && BigInt(l.topics[3]).toString() === id
        && [address(l.topics[1]), address(l.topics[2])].some(a => wallets.has(a)))) return 'related';
    }
  }
  if (pool.protocol === 'V3' && [TOPICS.V3Mint, TOPICS.V3Burn].includes(t)) {
    const target = words(log.data).slice(t === TOPICS.V3Mint ? 1 : 0, t === TOPICS.V3Mint ? 4 : 3).join('');
    for (const l of logs) {
      if (lower(l.address) !== DEX.v3Positions || l.topics?.length !== 2
        || lower(l.topics[0]) !== (t === TOPICS.V3Mint ? TOPICS.IncreaseLiquidity : TOPICS.DecreaseLiquidity)
        || words(l.data).length !== 3 || words(l.data).join('') !== target) continue;
      const id = BigInt(l.topics[1]).toString();
      const pos = state.positions?.[`${DEX.v3Positions}:${id}`];
      const ownedTransfer = transfers.some(n => lower(n.address) === DEX.v3Positions && n.topics.length === 4
        && BigInt(n.topics[3]).toString() === id && [address(n.topics[1]), address(n.topics[2])].some(a => wallets.has(a)));
      if (ownedTransfer) return 'related';
      if (pos && wallets.has(pos.owner)) {
        if (!positionOrder(log, pos) || !pos.tokens || pool.fee == null) return 'unknown';
        if (pos.tokens.every(token => pool.tokens.includes(token)) && pos.fee === pool.fee) return 'related';
      }
    }
  }
  // Missing sender or an unresolved wallet-owned position is never silenced.
  if (!/^0x[0-9a-f]{40}$/.test(lower(txFrom))) return 'unknown';
  if (transfers.some(l => POSITION_MANAGERS.includes(lower(l.address)) && l.topics.length === 4
    && [address(l.topics[1]), address(l.topics[2])].some(a => wallets.has(a)))) return 'unknown';
  return 'public';
}

export function migratePoolEvidence(state, wallets) {
  const byTx = new Map();
  for (const e of Object.values(state.events)) {
    if (!e.transactionHash) continue;
    if (!byTx.has(e.transactionHash)) byTx.set(e.transactionHash, []);
    byTx.get(e.transactionHash).push(e);
  }
  for (const e of Object.values(state.events)) {
    if (!POOL_KINDS.has(e.kind) || e.poolRelevance) continue;
    const poolAddress = e.raw?.address || e.detail?.split('｜')[1];
    const group = byTx.get(e.transactionHash) || [];
    // Legacy records have no transaction sender. Recover positive evidence only.
    e.poolRelevance = group.some(t => t.kind === 'transfer' && wallets.has(t.from)
      && t.to === poolAddress) ? 'related' : 'unknown';
  }
  for (const e of state.pendingChanges) if (state.events[e.id]?.poolRelevance) e.poolRelevance = state.events[e.id].poolRelevance;
}
