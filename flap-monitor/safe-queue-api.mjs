// Queue handles off-chain proposals only. Keep the Transaction Service base and
// credential identity unchanged for execution history, discovery and quotas.
export const SAFE_QUEUE_API_BASE_URL = 'https://api.safe.global/queue/api/v1';
const ZERO = '0x' + '0'.repeat(40);
const address = v => typeof v === 'string' && /^0x[0-9a-f]{40}$/i.test(v);
const hash = v => typeof v === 'string' && /^0x[0-9a-f]{64}$/i.test(v);
const integer = v => /^(0|[1-9]\d*)$/.test(String(v)) && (typeof v !== 'number' || Number.isSafeInteger(v));

export function normalizeQueueProposal(row, safe, threshold) {
  if (String(row?.chainId) !== '56' || !address(row.safe) || row.safe.toLowerCase() !== safe.toLowerCase()
    || !hash(row.safeTxHash) || !integer(row.nonce) || !Number.isSafeInteger(Number(row.nonce))
    || !Number.isSafeInteger(threshold) || threshold < 1 || !Array.isArray(row.confirmations)
    || !(row.txHash === null || hash(row.txHash)) || ![null, true, false].includes(row.failed)
    || typeof row.created !== 'string' || !Number.isFinite(Date.parse(row.created))) {
    throw Error('Safe Queue 提案链、身份或状态字段无效，保留旧基线');
  }
  for (const name of ['to', 'gasToken', 'refundReceiver']) {
    if (row[name] !== null && !address(row[name])) throw Error('Safe Queue 地址字段无效：' + name);
  }
  for (const name of ['value', 'safeTxGas', 'baseGas', 'gasPrice']) {
    if (!integer(row[name])) throw Error('Safe Queue 数量字段无效：' + name);
  }
  if (![0, 1].includes(row.operation) || !(row.data === null || /^0x(?:[0-9a-f]{2})*$/i.test(row.data))
    || row.confirmations.some(c => !address(c?.owner))) throw Error('Safe Queue 调用或签名字段无效');
  return { ...row, to: row.to ?? ZERO, gasToken: row.gasToken ?? ZERO, refundReceiver: row.refundReceiver ?? ZERO,
    nonce: Number(row.nonce), confirmationsRequired: threshold, submissionDate: row.created,
    transactionHash: row.txHash, isExecuted: row.txHash !== null, isSuccessful: row.failed === null ? null : !row.failed,
    confirmations: row.confirmations.map(c => ({ ...c, submissionDate: c.created })) };
}

export async function fetchQueueProposals({ safe, safes = [safe], baseUrl = SAFE_QUEUE_API_BASE_URL, readJson }) {
  if (!Array.isArray(safes) || !safes.length || safes.length > 100 || safes.some(s => !address(s)))
    throw Error('Safe Queue 查询地址无效或超过100项');
  const requested = new Set(safes.map(s => s.toLowerCase()));
  if (requested.size !== safes.length) throw Error('Safe Queue 查询地址重复');
  const first = new URL(baseUrl.replace(/\/+$/, '') + '/multisig-transactions/queue');
  first.search = new URLSearchParams({ nonceOrder: 'asc', limit: '100' });
  for (const item of requested) first.searchParams.append('safes', item + ':56');
  const results = [], visited = new Set(), hashes = new Set();
  let url = first.href, expected;
  while (url) {
    const parsed = new URL(url, first);
    if (parsed.origin !== first.origin || parsed.pathname !== first.pathname || parsed.username || parsed.password)
      throw Error('Safe Queue 分页地址无效');
    // Only the server offset may advance; a next link cannot change chain/safe/filter.
    const offset = parsed.searchParams.get('offset') || '0';
    if (!integer(offset) || Number(offset) !== results.length) throw Error('Safe Queue 分页游标不连续');
    parsed.search = first.search;
    parsed.searchParams.set('offset', offset);
    if (visited.has(parsed.href)) throw Error('Safe Queue 分页循环');
    if (visited.size >= 10) throw Object.assign(Error('Safe Queue 分页超过上限，保留旧基线并拆分批次'), { code: 'QUEUE_PAGE_LIMIT' });
    visited.add(parsed.href);
    const page = await readJson(parsed.href);
    if (!Number.isSafeInteger(page?.count) || page.count < 0 || !Array.isArray(page.results)
      || !(page.next === null || typeof page.next === 'string' && page.next.length > 0)
      || (expected !== undefined && page.count !== expected)) throw Error('Safe Queue 分页响应不完整，保留旧基线');
    expected = page.count;
    for (const row of page.results) {
      if (String(row?.chainId) !== '56' || !address(row.safe) || !requested.has(row.safe.toLowerCase())
        || !hash(row.safeTxHash) || hashes.has(row.safeTxHash.toLowerCase())) throw Error('Safe Queue 分页身份不符或重复');
      hashes.add(row.safeTxHash.toLowerCase()); results.push(row);
    }
    if (results.length > expected || (page.next && (!page.results.length || results.length >= expected)))
      throw Error('Safe Queue 分页数量不一致');
    url = page.next;
  }
  if (results.length !== expected) throw Error('Safe Queue 分页未完成');
  return results;
}

export function safeExecutionApiBase(baseUrl) {
  return baseUrl.replace(/\/+$/, '').replace(/\/api\/v1$/, '/api/v2');
}
