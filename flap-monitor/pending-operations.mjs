import { observationAddresses, RELATED_SAFES, EXECUTION_WALLETS, POSITION_MANAGERS, DEX } from './early-signal-catalog.mjs';
import { extractFlapProposalActions, DEFAULT_FLAP_ADMIN_SAFES } from './safe-proposal-monitor.mjs';
import { FLAP_FACTORY_PROXY } from './factory-pool-monitor.mjs';
import { describeOperationalAction } from './operational-call-codec.mjs';
import { formatBeijingTime } from '../shared/display-format.cjs';

const lower = x => String(x || '').toLowerCase();
const address = x => /^0x[a-f0-9]{40}$/.test(x);
const hash = x => /^0x[a-f0-9]{64}$/.test(x);
export const OPERATION_KEY = '@operation';
const SUCCESS = '0x442e715f626346e8c54381002da614f62bee8d27386535b2521ec8540898556e';
const FAILURE = '0x23428b18acfb3ea64b08dc0c1d296ea9c09702c09083ca5272e64d115b687d23';

export function decodePendingOperation(tx, config = {}) {
  if (!tx || tx.blockNumber != null || tx.blockHash != null) return [];
  const from = lower(tx.from), to = lower(tx.to), data = lower(tx.input), txHash = lower(tx.hash);
  const safes = [...(config.safes || DEFAULT_FLAP_ADMIN_SAFES), ...(config.relatedSafes ?? RELATED_SAFES)].map(lower);
  const sources = new Set([...observationAddresses(config), ...(config.wallets || EXECUTION_WALLETS).map(lower)]);
  const viaSafe = safes.includes(to) && data.startsWith('0x6a761202');
  if (!address(from) || !address(to) || !hash(txHash) || !/^0x(?:[a-f0-9]{2})*$/.test(data)
    || data.length > 65538 || (!viaSafe && !sources.has(from))) return [];
  try {
    if (tx.chainId != null && BigInt(tx.chainId) !== 56n) return [];
    const nonce = BigInt(tx.nonce).toString(), value = BigInt(tx.value || 0).toString();
    if (BigInt(nonce) < 0n || BigInt(value) < 0n) return [];
    const factory = lower(config.factoryAddress || FLAP_FACTORY_PROXY);
    const all = extractFlapProposalActions({ to, data, value, operation: 0 }, { factoryAddress: factory, includeOperations: true, safeAddresses: safes });
    // Registration owns its existing card. Never reinterpret malformed/unknown
    // calls or a selector on an arbitrary target as a privileged operation.
    if (all.some(a => a.kind === 'vaultFactory' || a.kind === 'unknown')) return [];
    const actions = all.filter(a => {
      if (['safeOwner', 'safeThreshold', 'module'].includes(a.kind)) return safes.includes(a.to);
      if (['creation', 'configuration', 'route'].includes(a.kind)) return a.to === factory;
      if (['funding', 'transfer'].includes(a.kind)) return BigInt(a.amount || 0) > 0n;
      if (a.kind === 'approval') return POSITION_MANAGERS.includes(a.spender);
      if (a.kind === 'liquidityCall') return a.to === DEX.v3Positions;
      return a.kind === 'positionTransfer' && POSITION_MANAGERS.includes(a.to);
    });
    if (!actions.length || actions.length > 16) return [];
    return [{ operationPreview: true, txHash, from, to, nonce, value, data, viaSafe,
      vault: OPERATION_KEY, actions: actions.map(({ rawData, ...a }) => a) }];
  } catch { return []; }
}

export function pendingOperationContent(r) {
  const status = { checking: '发现待执行重要操作，尚未核验', pending: '只读模拟通过，等待链上执行',
    unverified: '暂未确认，继续核验', executed: '交易执行成功，具体业务效果以回执事件为准', failed: '交易执行失败',
    withdrawn: '原执行区块已重组，撤回此前确认', replaced: '同发送账户、同 nonce 的替代交易已上链' }[r.status] || '待核验';
  const summary = (r.actions || []).map(a => ['configuration', 'route', 'creation'].includes(a.kind)
    ? `Factory ${a.kind === 'creation' ? `创建开关：${a.disabled ? '停用' : '启用'}` : a.kind === 'route' ? '兑换路径变更' : '计价配置变更'}｜资产 ${a.quoteToken || '待核验'}`
    : describeOperationalAction(a, r.tokenMetadata || {}));
  return [`${status}；不代表平台已开放。`, `发送地址：${r.from}`, `目标地址：${r.to}`,
    r.viaSafe ? '调用方式：Safe 执行（可能为所有者直接执行，不代表存在公开离线签名）' : '调用方式：关联地址直接调用',
    ...summary, `首次观测：${formatBeijingTime(r.firstSeenAt)}`, `来源：${r.pendingSource || 'unknown'}`,
    r.simulationStatus ? `模拟：${r.simulationStatus}（不保证打包后成功）` : '',
    r.confirmedAt ? `链上时间：${formatBeijingTime(r.confirmedAt)}` : '',
    r.confirmedDetail || '', `[交易详情](https://bscscan.com/tx/${r.txHash})`].filter(Boolean).join('\n');
}

// Merge only new observation envelopes; existing LP/permission/CoW alerts stay intact.
export function reconcileOperationObservations(early, pendingState) {
  const heldIds = new Set(), acknowledgedIds = [];
  let changed = false;
  for (const event of early.pendingChanges || []) {
    if (event.kind !== 'addressObservation' || !event.observationOnly) continue;
    if (early.notificationDelivery?.ids?.includes(event.id)) continue;
    const r = pendingState?.pendingRegistrations?.[`${event.transactionHash}:${OPERATION_KEY}`];
    if (!r?.operationPreview || r.mode !== 'live' || !hash(event.blockHash)) continue;
    if (r.withdrawnBlockHash === event.blockHash) { heldIds.add(event.id); continue; }
    if (r.confirmedBlockHash && r.confirmedBlockHash !== event.blockHash) continue;
    // A successful outer Safe receipt does not establish inner execution success.
    if (r.viaSafe && !['executed', 'failed'].includes(event.safeExecutionStatus)) continue;
    const status = r.viaSafe ? event.safeExecutionStatus : 'executed';
    if (r.confirmedDetail !== event.detail || r.status !== status) {
      Object.assign(r, { confirmedDetail: event.detail, status,
        confirmedBlockHash: event.blockHash, confirmedBlockNumber: event.blockNumber, settled: false });
      changed = true;
    }
    heldIds.add(event.id);
    if (r.messageId && r.patchedDetail === event.detail && r.patchedStatus === status) acknowledgedIds.push(event.id);
  }
  return { heldIds, acknowledgedIds, changed };
}

// Called inside the existing one-transaction-per-pass scheduler. No extra job.
export async function checkPendingOperation(r, state, { rpc, now, persist }) {
  r.nextCheckAt = now() + (r.simulatedAt ? 10000 : 5000);
  const version = () => JSON.stringify([r.status, r.confirmedBlockHash, r.confirmedDetail]);
  const initial = version();
  try {
    if (r.confirmedBlockHash && !r.settled) {
      const block = await rpc('eth_getBlockByNumber', ['0x' + r.confirmedBlockNumber.toString(16), false]);
      if (version() !== initial) return;
      if (!hash(lower(block?.hash)) || Number(block.number) !== r.confirmedBlockNumber) throw Error('执行区块暂不可核验');
      if (lower(block.hash) !== r.confirmedBlockHash) {
        r.status = 'withdrawn'; r.withdrawnBlockHash = r.confirmedBlockHash;
        delete r.confirmedBlockHash; delete r.confirmedDetail; delete r.confirmedAt;
      } else r.settled = (state.latestBlock || 0) - r.confirmedBlockNumber >= 128;
      persist(); return;
    }
    if (!r.simulationAttemptedAt && r.status === 'checking') {
      r.simulationAttemptedAt = new Date(now()).toISOString(); persist();
      const result = await rpc('eth_call', [{ to: r.to, from: r.from, value: '0x' + BigInt(r.value).toString(16), data: r.data }, 'latest']);
      if (version() !== initial) return;
      // Do not infer ERC20 execution success from empty/true return data.
      if (r.viaSafe && !/^0x0{63}1$/i.test(result || '')) throw Error('Safe 模拟未返回成功');
      if (!/^0x(?:[a-f0-9]{2})*$/i.test(result || '')) throw Error('模拟响应无效');
      r.simulationStatus = 'passed'; r.simulatedAt = new Date(now()).toISOString(); r.status = 'pending'; r.nextCheckAt = now() + 2000;
    } else {
      const receipt = await rpc('eth_getTransactionReceipt', [r.txHash]);
      if (version() !== initial) return;
      if (receipt) {
        if (lower(receipt.transactionHash) !== r.txHash || !hash(lower(receipt.blockHash))
          || lower(receipt.from) !== r.from || lower(receipt.to) !== r.to) throw Error('回执身份不符');
        const block = await rpc('eth_getBlockByNumber', [receipt.blockNumber, false]);
        if (version() !== initial) return;
        if (lower(block?.hash) !== lower(receipt.blockHash) || Number(block.number) !== Number(receipt.blockNumber)) throw Error('执行分叉待核验');
        if (![0, 1].includes(Number(receipt.status))) throw Error('回执状态无效');
        const safeSuccess = !r.viaSafe || receipt.logs?.some(l => lower(l.address) === r.to && lower(l.topics?.[0]) === SUCCESS);
        const safeFailure = r.viaSafe && receipt.logs?.some(l => lower(l.address) === r.to && lower(l.topics?.[0]) === FAILURE);
        if (Number(receipt.status) === 1 && !safeSuccess && !safeFailure) throw Error('缺少 Safe 执行结果');
        r.status = Number(receipt.status) === 1 && safeSuccess && !safeFailure ? 'executed' : 'failed';
        r.confirmedBlockHash = lower(receipt.blockHash); r.confirmedBlockNumber = Number(receipt.blockNumber);
        r.confirmedAt = new Date(Number(block.timestamp) * 1000).toISOString();
      } else if (r.replacementHash) {
        const tx = await rpc('eth_getTransactionByHash', [r.replacementHash]);
        if (lower(tx?.hash) !== r.replacementHash || lower(tx?.from) !== r.from || BigInt(tx.nonce).toString() !== r.nonce) throw Error('替代交易身份不符');
        const rr = await rpc('eth_getTransactionReceipt', [r.replacementHash]);
        if (rr && lower(rr.transactionHash) === r.replacementHash && hash(lower(rr.blockHash))) {
          const b = await rpc('eth_getBlockByNumber', [rr.blockNumber, false]);
          if (version() !== initial) return;
          if (lower(b?.hash) === lower(rr.blockHash)) { r.status = 'replaced'; r.confirmedBlockHash = lower(rr.blockHash); r.confirmedBlockNumber = Number(rr.blockNumber); }
        }
      } else if (now() - Date.parse(r.firstSeenAt) > 60000) r.status = 'unverified';
    }
    r.lastError = '';
  } catch (error) {
    if (version() !== initial) return;
    r.lastError = error.message;
    if (r.status === 'checking') { r.status = 'unverified'; r.simulationStatus = /revert|未返回成功/i.test(error.message) ? 'rejected' : 'unavailable'; }
  }
  persist();
}
