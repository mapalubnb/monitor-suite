import { CORE_OWNERS, CORE_SAFES, RELATED_SAFES } from './early-signal-catalog.mjs';
import { abiAddress, abiUint, hexWords } from './operational-call-codec.mjs';
import { TOPICS } from './early-signal-topics.mjs';
import { formatBeijingTime } from '../shared/display-format.cjs';

export const SAFE_FACTORIES = ['0x4e1dcf7ad4e460cfd30791ccc4f9c8a4f820ec67'];
export const SAFE_SINGLETONS = ['0x41675c099f32341bf84bfc5382af534df5c7461a', '0x29fcb43b46531bca003ddc8fcb67ffe91900c762'];
export const PROXY_CREATION = '0x4f51faf6c4561ff95f067657e43439f0f856d97c04d9ec9070a6199ad418e235';
export const SAFE_SETUP = '0x141df868a6331af528e38c83b7aa03edc19be66e37ae67f9285bf4f8e3c6a1a8';
// Runtime read from the factory-created 0xdfee...2fab in the audited fixture.
// Matching getters/storage alone would allow an arbitrary contract to spoof a Safe.
export const SAFE_PROXY_RUNTIME = '0x608060405273ffffffffffffffffffffffffffffffffffffffff600054167fa619486e0000000000000000000000000000000000000000000000000000000060003514156050578060005260206000f35b3660008037600080366000845af43d6000803e60008114156070573d6000fd5b3d6000f3fea264697066735822122003d1488ee65e08fa41e58e888a9865554c535f2c77126a82cb4c0f917f31441364736f6c63430007060033';
const lower = x => String(x || '').toLowerCase();
const address = x => /^0x[a-f0-9]{40}$/.test(x);
const unique = xs => [...new Set(xs.map(lower).filter(address))];
const SEED_OWNER = '0x0806d3920dafd50e8ceb189c82d2d3a217e2a045';

export function observedSafeConfig(state, config = {}) {
  return { ...config, relatedSafes: unique([...(config.relatedSafes ?? RELATED_SAFES),
    ...Object.keys(state.observedSafes || {})]) };
}
export function discoveryOwners(state) {
  // Do not expand recursively from owners of newly discovered, untrusted Safes.
  return unique([...CORE_OWNERS, SEED_OWNER, ...Object.entries(state.safeInfo || {}).flatMap(([a, s]) => state.ownerRelations?.[a]?.owners || s.owners || []),
    ...Object.values(state.ownerRelations || {}).flatMap(s => s.owners)]);
}
export function decodeOwners(value) {
  const w = hexWords(value);
  if (w[0] !== '20'.padStart(64, '0')) throw Error('Safe owners 偏移无效');
  const n = Number(abiUint(w[1]));
  if (n < 1 || n > 64 || w.length !== n + 2) throw Error('Safe owners 数量无效');
  const owners = w.slice(2).map(abiAddress);
  if (new Set(owners).size !== n) throw Error('Safe owners 重复');
  return owners;
}

export function safeDiscoveryCandidates(receipt, state) {
  if (Number(receipt.status) !== 1) return [];
  const known = new Set(discoveryOwners(state)), result = [];
  for (const l of receipt.logs || []) {
    if (l.removed || !SAFE_FACTORIES.includes(lower(l.address)) || lower(l.topics?.[0]) !== PROXY_CREATION) continue;
    try {
      if (l.topics.length !== 2) continue;
      const safe = abiAddress(l.topics[1].slice(2)), singleton = abiAddress(hexWords(l.data)[0]);
      if (!SAFE_SINGLETONS.includes(singleton)) continue;
      const setup = receipt.logs.find(s => lower(s.address) === safe && lower(s.topics?.[0]) === SAFE_SETUP
        && s.topics.length === 2 && abiAddress(s.topics[1].slice(2)) === lower(l.address));
      if (!setup) continue;
      const w = hexWords(setup.data), offset = Number(abiUint(w[0])) / 32;
      if (!Number.isInteger(offset) || offset < 4 || offset >= w.length) continue;
      const n = Number(abiUint(w[offset]));
      if (n < 1 || n > 64 || w.length !== offset + 1 + n) continue;
      const owners = w.slice(offset + 1).map(abiAddress);
      if (owners.some(a => known.has(a))) result.push({ safe, singleton, log: l });
    } catch { /* untrusted event payload */ }
  }
  return result;
}

// Only matching creations incur calls. Block-pinned getters verify actual ownership,
// including setup delegatecalls that may have changed owners after SafeSetup.
export async function verifySafeDiscoveries(receipt, state, config, rpcBatch, nowMs, blockTime) {
  // Keep root Safe ownership current; newly observed Safes cannot expand trust roots.
  const changedRoots = unique((receipt.logs || []).filter(l => Number(receipt.status) === 1
    && [TOPICS.AddedOwner, TOPICS.RemovedOwner].includes(lower(l.topics?.[0]))
    && CORE_SAFES.some(([a]) => lower(a) === lower(l.address))).map(l => l.address));
  for (const safe of changedRoots) {
    const [value] = await rpcBatch([{ method: 'eth_call', params: [{ to: safe, data: '0xa0e67e2b' }, receipt.blockNumber] }], { requireAllResults: true });
    state.ownerRelations ||= {};
    state.ownerRelations[safe] = { owners: decodeOwners(value), blockNumber: Number(receipt.blockNumber) };
  }
  const roots = new Set(discoveryOwners(state));
  const results = [];
  for (const { safe, singleton, log } of safeDiscoveryCandidates(receipt, state)) {
    if (state.observedSafes?.[safe]) continue;
    if (Object.keys(state.observedSafes || {}).length >= 128) {
      results.push({ log, kind: 'safeDiscovery', observationOnly: true, actor: safe,
        detail: `关联 Safe 候选 ${safe}：动态观察已达 128 个上限，本地址尚未启用持续观察，需人工核验容量；不代表官方归属。` });
      continue;
    }
    const values = await rpcBatch([
      { method: 'eth_call', params: [{ to: safe, data: '0xa0e67e2b' }, receipt.blockNumber] },
      { method: 'eth_call', params: [{ to: safe, data: '0xe75235b8' }, receipt.blockNumber] },
      { method: 'eth_getStorageAt', params: [safe, '0x0', receipt.blockNumber] },
    ], { requireAllResults: true });
    const owners = decodeOwners(values[0]), threshold = Number(BigInt(values[1]));
    if (abiAddress(hexWords(values[2])[0]) !== singleton || threshold < 1 || threshold > owners.length) throw Error('Safe 创建身份核验不一致');
    const common = owners.filter(a => roots.has(a));
    if (!common.length) continue;
    state.observedSafes ||= {};
    state.observationCoverage ||= {};
    state.observedSafes[safe] = { address: safe, owners, threshold, singleton, commonOwners: common,
      replayFrom: Number(receipt.blockNumber), blockNumber: Number(receipt.blockNumber), blockHash: lower(receipt.blockHash), transactionHash: lower(receipt.transactionHash),
      firstSeenAt: new Date(nowMs).toISOString(), source: 'verified-creation', observationOnly: true };
    state.observationCoverage[safe] = Number(receipt.blockNumber);
    results.push({ log, kind: 'safeDiscovery', observationOnly: true, actor: safe,
      detail: `新关联 Safe [${safe}](https://bscscan.com/address/${safe})｜持续观察已启用\n共同 owner：${common.join('、')}｜阈值 ${threshold}/${owners.length}\n链上时间：${blockTime ? formatBeijingTime(blockTime) : '待补充'}\n首次发现：${formatBeijingTime(nowMs)}\n仅为关联观察，不代表官方归属、加池准备或底池开放。` });
  }
  return results;
}

export function rewindObservedSafes(state, fromBlock) {
  for (const [a, info] of Object.entries(state.observedSafes || {})) if (info.blockNumber >= fromBlock) {
    delete state.observedSafes[a];
    delete state.observationCoverage?.[a];
  }
  for (const [a, info] of Object.entries(state.ownerRelations || {})) if (info.blockNumber >= fromBlock) delete state.ownerRelations[a];
}

export async function verifyApiObservedSafe(safe, state, rpcBatch, nowMs) {
  safe = lower(safe);
  if (!address(safe) || state.observedSafes?.[safe] || Object.keys(state.observedSafes || {}).length >= 128) return null;
  const revision = state.reorgRevision || 0;
  const [head] = await rpcBatch([{ method: 'eth_getBlockByNumber', params: ['latest', false] }], { requireAllResults: true });
  if (!/^0x[a-f0-9]{64}$/i.test(head?.hash)) throw Error('Safe 观察起点区块无效');
  const [o, t, code, runtime] = await rpcBatch([
    { method: 'eth_call', params: [{ to: safe, data: '0xa0e67e2b' }, head.number] },
    { method: 'eth_call', params: [{ to: safe, data: '0xe75235b8' }, head.number] },
    { method: 'eth_getStorageAt', params: [safe, '0x0', head.number] },
    { method: 'eth_getCode', params: [safe, head.number] },
  ], { requireAllResults: true });
  const owners = decodeOwners(o), threshold = Number(BigInt(t)), singleton = abiAddress(hexWords(code)[0]);
  const common = owners.filter(a => discoveryOwners(state).includes(a));
  if (lower(runtime) !== SAFE_PROXY_RUNTIME || !SAFE_SINGLETONS.includes(singleton) || !common.length || threshold < 1 || threshold > owners.length) return null;
  const [check] = await rpcBatch([{ method: 'eth_getBlockByNumber', params: [head.number, false] }], { requireAllResults: true });
  if (lower(check?.hash) !== lower(head.hash) || (state.reorgRevision || 0) !== revision) throw Error('Safe 观察起点已重组');
  // A fast receipt scan may have activated this Safe while these reads awaited.
  // Preserve its earlier coverage and replay cursor, and recheck shared capacity.
  if (state.observedSafes?.[safe] || Object.keys(state.observedSafes || {}).length >= 128) return null;
  state.observedSafes ||= {}; state.observationCoverage ||= {};
  state.observedSafes[safe] = { address: safe, owners, threshold, singleton, commonOwners: common,
    firstSeenAt: new Date(nowMs).toISOString(), replayFrom: Number(head.number), blockNumber: Number(head.number), blockHash: lower(head.hash), source: 'api-chain-verified', observationOnly: true };
  // Include the current block in the observation window; no unbounded historical replay.
  state.observationCoverage[safe] = Number(head.number);
  return state.observedSafes[safe];
}

// Merge only newly verified entries and newer root ownership. Never replace
// concurrent API/fast-lane additions with an older snapshot across RPC awaits.
export function mergeObservedSafes(target, source) {
  target.observedSafes ||= {}; target.observationCoverage ||= {}; target.ownerRelations ||= {};
  for (const [a, info] of Object.entries(source.observedSafes || {})) {
    if (!target.observedSafes[a]) {
      target.observedSafes[a] = info;
      target.observationCoverage[a] = source.observationCoverage[a];
    }
  }
  for (const [a, info] of Object.entries(source.ownerRelations || {}))
    if (!target.ownerRelations[a] || target.ownerRelations[a].blockNumber < info.blockNumber) target.ownerRelations[a] = info;
}
