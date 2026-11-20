import { withDeadline } from '../shared/request-deadline.mjs';
import { formatBeijingTime } from '../shared/display-format.cjs';
import { FOURMEME_SAFE } from './address-catalog.mjs';

const SUCCESS = '0x442e715f626346e8c54381002da614f62bee8d27386535b2521ec8540898556e';
const FAILURE = '0x23428b18acfb3ea64b08dc0c1d296ea9c09702c09083ca5272e64d115b687d23';
const RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;
const lower = value => String(value || '').toLowerCase();
const hash = value => /^0x[a-f\d]{64}$/i.test(value || '') ? lower(value) : '';

// Only the generic address observation is eligible. Other reported evidence,
// failed executions and ambiguous Safe events retain their separate alerts.
export function observedSafeExecution(tx, receipt, result) {
  if (lower(tx.to) !== FOURMEME_SAFE || !lower(tx.input).startsWith('0x6a761202')
      || receipt.status !== '0x1' || BigInt(tx.value || '0x0') !== 0n
      || result.lines.length !== 1 || !result.lines[0].startsWith('调用解码') || result.silent.length) return null;
  const events = (receipt.logs || []).filter(log => lower(log.address) === FOURMEME_SAFE && [SUCCESS, FAILURE].includes(lower(log.topics?.[0])));
  if (events.length !== 1 || lower(events[0].topics[0]) !== SUCCESS) return null;
  const [event] = events;
  const safeTxHash = event.topics.length === 1 && /^0x[a-f\d]{128}$/i.test(event.data || '')
    ? hash(event.data.slice(0, 66)) : '';
  const blockHash = hash(receipt.blockHash), executor = lower(tx.from);
  if (!safeTxHash || !blockHash || !/^0x[a-f\d]{40}$/.test(executor)) return null;
  return { safeTxHash, blockHash, executor };
}

function receiptKey(payload) {
  const address = payload.fourmemeAddress;
  if (hash(address?.txHash) && hash(address.safeExecution?.safeTxHash) && hash(address.safeExecution.blockHash)) {
    return { key: `${hash(address.txHash)}:${hash(address.safeExecution.safeTxHash)}`, address };
  }
  const safe = payload.fourmemeSafe;
  const change = safe?.changes?.length === 1 && safe.changes[0];
  if (safe?.safe === FOURMEME_SAFE && change?.type === 'executed' && hash(change.transactionHash) && hash(change.hash)) {
    return { key: `${hash(change.transactionHash)}:${hash(change.hash)}` };
  }
  return null;
}

function withAddressEvidence(payload, observation) {
  const executor = observation.safeExecution.executor;
  return { ...payload, content: [payload.content, '## 链上即时观测',
    `执行者：[${executor}](https://bscscan.com/address/${executor})`,
    `区块：[${observation.block}](https://bscscan.com/block/${observation.block})`,
    `链上时间：${formatBeijingTime(observation.chainAt)}`,
    `首次链上观察：${formatBeijingTime(observation.detectedAt)}`,
  ].join('\n') };
}

export async function deliverSafeExecutionCard({ store, payload, options, send, edit, fitsSingleCard, now = Date.now, log = () => {} }) {
  const match = receiptKey(payload);
  if (!match) return send(payload, options);
  const { key, address } = match;
  const recorded = store.state._fourmemeSafeExecutionCards?.[key];
  const previous = recorded && now() - recorded.at < RECEIPT_TTL_MS ? recorded : null;
  const remember = entry => store.transaction(() => {
    const ledger = Object.entries(store.state._fourmemeSafeExecutionCards || {})
      .filter(([k, receipt]) => k !== key && now() - receipt.at < RECEIPT_TTL_MS).slice(-127);
    store.state._fourmemeSafeExecutionCards = Object.fromEntries([...ledger, [key, { ...entry, at: now() }]]);
  });
  if (previous?.deliveryId === options.deliveryId && previous?.messageId) return previous.messageId;
  if (address && previous?.type === 'safe' && (!previous.blockHash || previous.blockHash === address.safeExecution.blockHash)) {
    if (!previous.blockHash) await remember({ ...previous, blockHash: address.safeExecution.blockHash });
    log('[Four.meme Safe] 已送达执行详情，省略同一交易的通用地址卡');
    return previous.messageId;
  }
  if (!address && previous?.type === 'address' && (previous.patchFailures || 0) < 2) {
    const combined = withAddressEvidence(payload, previous.observation);
    if (fitsSingleCard(combined)) {
      let edited = false;
      try {
        await withDeadline(() => edit(previous.messageId, combined), 5_000);
        edited = true;
      } catch (error) {
        const patchFailures = (previous.patchFailures || 0) + 1;
        await remember({ ...previous, patchFailures });
        if (patchFailures < 2) throw error;
        log('[Four.meme Safe] 原卡编辑失败，执行详情改为单独送达');
      }
      if (edited) {
        await remember({ type: 'safe', messageId: previous.messageId, deliveryId: options.deliveryId, blockHash: previous.blockHash });
        log('[Four.meme Safe] 执行详情已补入链上首卡');
        return previous.messageId;
      }
    }
  }
  const messageId = await send(payload, options);
  if (messageId && (!address || ((options.cardParts?.length || 0) <= 1 && fitsSingleCard(payload)))) {
    await remember(address
      ? { type: 'address', messageId, deliveryId: options.deliveryId, blockHash: address.safeExecution.blockHash, observation: address }
      : { type: 'safe', messageId, deliveryId: options.deliveryId, blockHash: previous?.blockHash });
  }
  return messageId;
}
