// BSC EntryPoint v0.7 / Safe4337Module v0.3.0. Bounded, read-only decoding.
// Sources: safe-fndn/safe-modules modules/4337 and eth-infinitism/account-abstraction v0.7.
import { abiAddress, abiUint, abiBytes, hexWords } from './operational-call-codec.mjs';
import { extractFlapProposalActions } from './safe-proposal-monitor.mjs';

export const ENTRY_POINT_V07 = '0x0000000071727de22e5e9d8baf0edac6f37da032';
export const SAFE_4337_MODULE = '0x75cf11467937ce3f2f357ce24ffc3dbf8fd5c226';
export const USER_OPERATION_EVENT = '0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f';
const lower = x => String(x || '').toLowerCase();
export const operationKey4337 = op => `@operation:4337:${op.sender}:${op.userOpNonce}`;

export function decodeHandleOps(tx) {
  if (lower(tx?.to) !== ENTRY_POINT_V07 || !lower(tx?.input).startsWith('0x765e827f')) return [];
  const data = lower(tx.input).slice(10);
  if (data.length > 262144) throw Error('ERC-4337 批次超过解析上限');
  const words = hexWords(data);
  const integer = i => Number(BigInt('0x' + words[i]));
  const start = integer(0) / 32;
  if (!Number.isSafeInteger(start) || start < 2 || start >= words.length) throw Error('UserOperation 数组偏移无效');
  const count = integer(start);
  if (!Number.isSafeInteger(count) || count < 1 || count > 64 || start + count >= words.length) throw Error('UserOperation 数量无效');
  const result = [], seen = new Set();
  let previousEnd = (start + 1 + count) * 32;
  for (let i = 0; i < count; i++) {
    const offset = integer(start + 1 + i);
    const begin = (start + 1) * 32 + offset;
    if (!Number.isSafeInteger(begin) || offset % 32 || begin < previousEnd || begin + 288 > data.length / 2) throw Error('UserOperation tuple 越界');
    const tuple = data.slice(begin * 2), w = hexWords(tuple);
    const sender = abiAddress(w[0]), userOpNonce = abiUint(w[1]);
    // Validate all dynamic ranges, including signatures, but never return/store signatures.
    let end = 288;
    for (const slot of [2, 3, 7, 8]) {
      const off = Number(BigInt('0x' + w[slot]));
      if (off < end) throw Error('UserOperation 动态字段重叠');
      const bytes = abiBytes(tuple, slot);
      end = off + 32 + Math.ceil((bytes.length - 2) / 64) * 32;
    }
    previousEnd = begin + end;
    const key = `${sender}:${userOpNonce}`;
    if (seen.has(key)) throw Error('UserOperation 身份重复');
    seen.add(key);
    result.push({ sender, userOpNonce, userOpIndex: i, callData: abiBytes(tuple, 3) });
  }
  return result;
}

export function decodeSafeUserOperation(op, config = {}) {
  try {
    const selector = op.callData.slice(0, 10);
    // executeUserOp / executeUserOpWithErrorString(address,uint256,bytes,uint8)
    if (!['0x7bb37428', '0x541d63c8'].includes(selector)) throw Error('未覆盖的智能账户入口');
    const body = op.callData.slice(10), w = hexWords(body);
    if (BigInt('0x' + w[2]) < 128n || !/^0{63}[01]$/.test(w[3])) throw Error('Safe UserOperation 参数无效');
    return extractFlapProposalActions({ to: abiAddress(w[0]), value: abiUint(w[1]), data: abiBytes(body, 2), operation: Number(abiUint(w[3])) },
      { includeOperations: true, factoryAddress: config.factoryAddress, safeAddresses: [op.sender] })
      .map(({ rawData, ...action }) => action);
  } catch (error) {
    return [{ kind: 'unknown', to: op.sender, selector: op.callData.slice(0, 10), reason: `模块操作待解析：${error.message}` }];
  }
}

export function userOperationResult(receipt, op) {
  if (Number(receipt?.status) === 0) return { status: 'failed', reason: '整笔 EntryPoint 交易失败' };
  const matches = [];
  for (const l of receipt?.logs || []) {
    if (lower(l.address) !== ENTRY_POINT_V07 || lower(l.topics?.[0]) !== USER_OPERATION_EVENT || l.topics.length !== 4 || l.removed) continue;
    try {
      const w = hexWords(l.data);
      if (w.length !== 4 || !/^0{63}[01]$/.test(w[1]) || !/^0x[a-f0-9]{64}$/i.test(l.topics[1])) continue;
      if (abiAddress(l.topics[2].slice(2)) === op.sender && abiUint(w[0]) === op.userOpNonce)
        matches.push({ status: w[1].endsWith('1') ? 'executed' : 'failed', userOpHash: lower(l.topics[1]), logIndex: Number(l.logIndex) });
    } catch { /* malformed/unrelated logs are not execution evidence */ }
  }
  if (matches.length !== 1) return { status: 'unverified', reason: '缺少唯一匹配的 UserOperation 执行结果' };
  const result = matches[0];
  if (result.status === 'executed') {
    // Prefund module calls happen before BeforeExecution; they are not proof that
    // this operation executed. Bound the module event to this operation's span.
    const logs = receipt.logs || [];
    const boundary = Math.max(-1, ...logs.filter(l => lower(l.address) === ENTRY_POINT_V07
      && [USER_OPERATION_EVENT, '0xbb47ee3e183a558b1a2ff0874b079f3fc5478b7454eacf2bfc5af2ff5878f972'].includes(lower(l.topics?.[0]))
      && Number(l.logIndex) < result.logIndex).map(l => Number(l.logIndex)));
    const moduleSuccess = logs.some(l => lower(l.address) === op.sender && !l.removed
      && lower(l.topics?.[0]) === '0x6895c13664aa4f67288b25d7a21d7aaa34916e355fb9b6fae0a139a9085becb8'
      && l.topics?.length === 2 && lower(l.topics[1]) === '0x' + SAFE_4337_MODULE.slice(2).padStart(64, '0')
      && Number(l.logIndex) > boundary && Number(l.logIndex) < result.logIndex);
    if (!moduleSuccess) return { ...result, status: 'unverified', reason: 'UserOperation 成功，但缺少对应 Safe4337 模块执行证据' };
  }
  return result;
}

// Unknown bundle selectors/oversized calldata still leave scoped on-chain
// execution evidence. Preserve a pending-decode alert instead of dropping it.
export function receiptUserOperations(receipt) {
  const operations = new Map();
  for (const l of receipt.logs || []) {
    if (lower(l.address) !== ENTRY_POINT_V07 || lower(l.topics?.[0]) !== USER_OPERATION_EVENT || l.topics.length !== 4 || l.removed) continue;
    try {
      const w = hexWords(l.data);
      if (w.length !== 4 || !/^0{63}[01]$/.test(w[1])) continue;
      const op = { sender: abiAddress(l.topics[2].slice(2)), userOpNonce: abiUint(w[0]), userOpIndex: operations.size, callData: '0x' };
      operations.set(operationKey4337(op), op);
    } catch { /* invalid evidence */ }
  }
  return [...operations.values()];
}
