import { observationAddresses, RELATED_SAFES, POSITION_MANAGERS } from './early-signal-catalog.mjs';
import { extractFlapProposalActions } from './safe-proposal-monitor.mjs';
import { describeOperationalAction } from './operational-call-codec.mjs';
import { TOPICS } from './early-signal-topics.mjs';

const lower = a => String(a || '').toLowerCase();
const link = a => `[${a}](https://bscscan.com/address/${a})`;

// Activation is independent of the existing real-time/history cursors. Never
// replay a newly observed address's old traffic during a historical catch-up.
export function establishObservationCoverage(state, config, head) {
  state.observationCoverage ||= {};
  for (const a of observationAddresses(config)) state.observationCoverage[a] ??= head;
}

export function observeAddressTransaction(receipt, transaction, state, config, trustedWallets) {
  if (!transaction || Number(receipt.status) !== 1
    || lower(transaction.hash) !== lower(receipt.transactionHash)
    || lower(transaction.blockHash) !== lower(receipt.blockHash)
    || Number(transaction.blockNumber) !== Number(receipt.blockNumber)) return [];
  const from = lower(transaction.from), to = lower(transaction.to);
  const observers = new Set(observationAddresses(config).filter(a =>
    Number(receipt.blockNumber) >= (state.observationCoverage?.[a] ?? Infinity)));
  const relatedSafes = new Set((config.relatedSafes ?? RELATED_SAFES).map(lower));
  // Existing trusted-wallet paths retain their own classification and noise policy.
  if (trustedWallets.has(from) || trustedWallets.has(to)) return [];
  const safeCall = relatedSafes.has(to) && observers.has(to)
    && transaction.input?.toLowerCase().startsWith('0x6a761202');
  const safeFailure = safeCall && receipt.logs?.some(l => lower(l.address) === to
    && lower(l.topics?.[0]) === '0x23428b18acfb3ea64b08dc0c1d296ea9c09702c09083ca5272e64d115b687d23');
  const safeSuccess = safeCall && !safeFailure && receipt.logs?.some(l => lower(l.address) === to
    && lower(l.topics?.[0]) === '0x442e715f626346e8c54381002da614f62bee8d27386535b2521ec8540898556e');
  const safeExecution = safeSuccess || safeFailure;
  const own = observers.has(from);
  const incomingNative = observers.has(to) && BigInt(transaction.value || 0) > 0n;
  // Passive token receipts stay in the existing silent-record policy. A Transfer
  // claiming an observer as sender is not proof that the observer signed it.
  const incoming = (receipt.logs || []).filter(l => lower(l.topics?.[0]) === TOPICS.Transfer
    && l.topics.length === 3 && /^0x[a-f0-9]{64}$/i.test(l.data || '')
    && observers.has('0x' + lower(l.topics[2]).slice(-40)));
  if (!own && !safeExecution && !incomingNative) return incoming.filter(l => BigInt(l.data) > 0n).map(l => ({
    kind: 'transfer', observationOnly: true, passiveIncoming: true, token: lower(l.address),
    from: '0x' + lower(l.topics[1]).slice(-40), to: '0x' + lower(l.topics[2]).slice(-40),
    amount: BigInt(l.data).toString(), observationLogIndex: Number(l.logIndex),
    detail: `观察地址被动收币：${link(lower(l.address))}；不作为主动采购或官方归属证据。`,
  }));
  const actor = safeExecution ? to : own ? from : to;
  const base = { kind: 'addressObservation', observationOnly: true, actor,
    ...(safeCall ? { safeExecutionStatus: safeFailure ? 'failed' : safeSuccess ? 'executed' : 'unverified' } : {}),
    detail: `关联地址观察：${link(actor)}\n仅确认地址参与，不代表官方动作、加池准备或底池开放。` };
  // Safe can emit ExecutionFailure while the outer receipt still has status=1.
  // Never present the attempted inner calls as completed actions in that case.
  if (safeCall && !safeSuccess) return [{ ...base, detail: `${base.detail}\n${safeFailure
    ? 'Safe 内部执行失败；外层交易已上链，不代表资金调拨或管理操作完成。'
    : 'Safe 执行结果待核验；缺少有效执行结果事件，不确认内部操作成功。'}` }];
  if (!to && receipt.contractAddress && own) return [{ ...base,
    detail: `${base.detail}\n部署合约：${link(lower(receipt.contractAddress))}` }];
  if (!own && !safeExecution) return [{ ...base, detail: `${base.detail}\n${describeOperationalAction({
    kind: 'funding', asset: 'BNB', recipient: to, amount: BigInt(transaction.value || 0).toString() })}\n来源：${link(from)}` }];
  let actions;
  try { actions = extractFlapProposalActions({ to, data: transaction.input || '0x', value: transaction.value || '0x0' },
    { includeOperations: true, safeAddresses: [...trustedWallets, ...relatedSafes] }); }
  catch { actions = [{ kind: 'unknown', to, selector: String(transaction.input || '').slice(0, 10), reason: '调用结构待核验' }]; }
  // Zero-value empty calls add no useful signal. Do not revive revoked-grant notifications.
  actions = actions.filter(a => a.kind !== 'grantRevoke' && a.kind !== 'grantQuery'
    && !(a.kind === 'funding' && BigInt(a.amount || 0) === 0n));
  if (!actions.length) return [];
  const descriptions = actions.slice(0, 16).map(a => describeOperationalAction(a, state.tokens));
  for (const l of receipt.logs || []) {
    if (!POSITION_MANAGERS.includes(lower(l.address)) || l.topics?.length !== 2
      || ![TOPICS.IncreaseLiquidity, TOPICS.DecreaseLiquidity].includes(lower(l.topics[0]))
      || !/^0x[a-f0-9]{192}$/i.test(l.data || '') || !/^0x[a-f0-9]{64}$/i.test(l.topics[1])) continue;
    if (BigInt('0x' + l.data.slice(2, 66)) > 0n) descriptions.push(
      `回执确认${lower(l.topics[0]) === TOPICS.IncreaseLiquidity ? '增加' : '减少'}流动性：仓位 #${BigInt(l.topics[1])}，管理器 ${lower(l.address)}；资产数量待映射，不认定官方底池。`);
  }
  if (actions.length > 16) descriptions.push(`另有 ${actions.length - 16} 项调用，见交易详情。`);
  if (POSITION_MANAGERS.includes(to)) descriptions.push('调用已知仓位管理器；实际加撤池及数量以回执事件为准。');
  return [{ ...base, detail: [base.detail, ...descriptions].join('\n') }];
}
