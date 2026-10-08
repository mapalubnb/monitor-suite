import { TOPICS } from './early-signal-topics.mjs';
import { formatOperationalAmount } from './operational-call-codec.mjs';

const address = value => /^0x[a-f0-9]{40}$/i.test(value || '');
const unsigned = value => /^(0|[1-9][0-9]*)$/.test(String(value ?? ''));

// Presentation only. Neither classification, raw evidence nor acknowledgement changes.
export function safeReceiptPayment(event) {
  const raw = event.raw;
  if (event.kind !== 'safeOperation' || !address(raw?.address) || raw.topics?.length !== 2
    || raw.topics[0]?.toLowerCase() !== TOPICS.SafeReceived
    || !/^0x0{24}[a-f0-9]{40}$/i.test(raw.topics[1]) || !/^0x[a-f0-9]{64}$/i.test(raw.data)) return null;
  return { safe: raw.address.toLowerCase(), from: '0x' + raw.topics[1].slice(-40).toLowerCase(), amount: BigInt(raw.data) };
}

export function summarizeEarlyOperations(events, state, link) {
  const groups = new Map(), matched = new Set(), summaries = [];
  for (const event of events) {
    if (!['approval', 'transfer'].includes(event.kind) || !address(event.token) || !address(event.from) || !address(event.to)) continue;
    const key = [event.token, event.from, event.to].map(x => x.toLowerCase()).join(':');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(event);
  }
  const batches = new Map();
  for (const rows of groups.values()) {
    if (rows.length !== 3 || rows.some(e => !unsigned(e.amount))) continue;
    const approvals = rows.filter(e => e.kind === 'approval').sort((a, b) => a.logIndex - b.logIndex);
    const transfers = rows.filter(e => e.kind === 'transfer');
    if (approvals.length !== 2 || transfers.length !== 1) continue;
    const [grant, consumed] = approvals, transfer = transfers[0];
    if (BigInt(grant.amount) <= 0n || BigInt(consumed.amount) !== 0n || BigInt(grant.amount) !== BigInt(transfer.amount)) continue;
    const token = transfer.token.toLowerCase(), owner = transfer.from.toLowerCase(), receiver = transfer.to.toLowerCase();
    // One return payment cannot be attributed to two assets sent to the same receiver.
    if (events.filter(e => e.kind === 'transfer' && e.from?.toLowerCase() === owner && e.to?.toLowerCase() === receiver).length !== 1) continue;
    const decimals = state.tokens?.[token]?.decimals;
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) continue;
    const payments = events.filter(e => {
      const payment = safeReceiptPayment(e);
      return payment?.safe === owner && payment.from === receiver;
    });
    if (payments.length !== 1) continue;
    const payment = payments[0], all = [grant, consumed, transfer, payment];
    if (!transfer.transactionHash || !transfer.blockHash || all.some(e => e.transactionHash !== transfer.transactionHash || e.blockHash !== transfer.blockHash
      || !Number.isSafeInteger(e.logIndex)) || !(grant.logIndex < consumed.logIndex && consumed.logIndex < transfer.logIndex && transfer.logIndex < payment.logIndex)) continue;
    const key = `${owner}:${token}`;
    if (!batches.has(key)) batches.set(key, { owner, token, decimals, units: 0n, wei: 0n, receivers: [], events: [] });
    const batch = batches.get(key);
    batch.units += BigInt(transfer.amount); batch.wei += safeReceiptPayment(payment).amount;
    batch.receivers.push(receiver); batch.events.push(...all);
  }
  for (const batch of batches.values()) {
    if (batch.receivers.length < 2) continue;
    for (const event of batch.events) matched.add(event);
    summaries.push(`📦 批量临时授权与转账｜${batch.receivers.length} 个对象`,
      `关联 Safe：${link(batch.owner)}`,
      `资产：${link(batch.token)}｜合计转出 ${formatOperationalAmount(batch.units.toString(), batch.decimals)}`,
      `BNB 回款合计：${formatOperationalAmount(batch.wei.toString(), 18)} BNB`,
      '各对象均匹配授权后额度归零、同额转出及 Safe 回款；仅合并展示，不代表业务已核验。',
      `对象：${batch.receivers.slice(0, 3).map(x => link(x)).join('、')}${batch.receivers.length > 3 ? ` 等 ${batch.receivers.length} 个（完整明细见交易）` : ''}`);
  }
  return { summaries, remaining: events.filter(e => !matched.has(e)) };
}
