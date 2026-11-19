import { withDeadline, withAbortSignal, createDeadlineSignal } from '../shared/request-deadline.mjs';
import { decodeOperationalCall, describeOperationalAction } from '../flap-monitor/operational-call-codec.mjs';
import { USER_OPERATION_EVENT, receiptUserOperations, userOperationResult } from '../flap-monitor/erc4337-codec.mjs';
import { FOURMEME_ADDRESS_CATALOG, KNOWN_ASSETS } from './address-catalog.mjs';
import { formatBeijingTime } from '../shared/display-format.cjs';
import { addressRpcFailure } from './address-rpc.mjs';

export const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
export const APPROVAL = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';
const lower = x => String(x || '').toLowerCase();
const hashOK = x => /^0x[a-f0-9]{64}$/i.test(x || '');
const addressOK = x => /^0x[a-f0-9]{40}$/i.test(x || '');
const hex = n => '0x' + n.toString(16);
const num = x => { if (!/^0x[0-9a-f]+$/i.test(x || '')) throw Error('地址监控 RPC 数量无效'); const n = Number(BigInt(x)); if (!Number.isSafeInteger(n)) throw Error('RPC 数量越界'); return n; };
const topicAddress = t => /^0x0{24}[a-f0-9]{40}$/i.test(t || '') ? lower('0x' + t.slice(-40)) : '';
const link = a => `[${a}](https://bscscan.com/address/${a})`;
const amount = (n, decimals) => { const v = BigInt(n).toString().padStart(decimals + 1, '0'); return decimals ? (v.slice(0, -decimals) + '.' + v.slice(-decimals)).replace(/\.?0+$/, '') : v; };

// Match Flap's address-observation card: action, one grouped observation,
// observation time, then a compact transaction/block footer. No raw tx hash row.
export function renderFourmemeAddressContent({ result, catalog, txHash, block, observedAt }) {
  const action = result.failed ? '🔎 关联操作｜交易失败'
    : result.lines.some(l => /资产转移|直接转移/.test(l)) ? '💸 资金变动'
    : result.lines.some(l => /授权/.test(l)) ? '🔑 代币授权' : '🔎 关联操作';
  const labels = result.touched.map(a => { const info = catalog.find(c => c.address === a); return `${info.label}：${link(a)}（${info.evidence}）`; });
  return [action, `• 关联地址观察：\n${labels.join('\n')}\n${result.lines.join('\n')}`,
    `🕒 ${formatBeijingTime(observedAt)}`, `[交易](https://bscscan.com/tx/${txHash})｜区块 ${block}`, ''].join('\n');
}
function validBlock(b, n, full = false) {
  if (!b || num(b.number) !== n || !hashOK(b.hash) || !hashOK(b.parentHash) || (full && (!Array.isArray(b.transactions) || b.transactions.some(t => !t || typeof t !== 'object' || !hashOK(t.hash) || num(t.blockNumber) !== n || lower(t.blockHash) !== lower(b.hash))))) throw Error(`地址监控区块 ${n} 不完整，保留缺口`);
  return b;
}
export function addressLogFilters(addresses, from, to) {
  const topics = addresses.map(a => '0x' + a.slice(2).padStart(64, '0'));
  return [ [[TRANSFER, APPROVAL], topics], [TRANSFER, null, topics], [USER_OPERATION_EVENT, null, topics] ]
    .map(t => ({ fromBlock: hex(from), toBlock: hex(to), topics: t }));
}

// Flap policy: pure passive token receipts stay recorded, never promoted to a
// purchase/official operation. Native transfers and mixed active calls stay urgent.
export function observeFourmemeAddressTx(tx, receipt, catalog, { actorCovered = [], assets = KNOWN_ASSETS } = {}) {
  const watched = new Map(catalog.map(a => [a.address, a]));
  const from = lower(tx.from), to = lower(tx.to), touched = new Set();
  const direct = watched.has(from) || watched.has(to);
  if (watched.has(from)) touched.add(from);
  if (watched.has(to)) touched.add(to);
  const operations = receiptUserOperations(receipt).filter(o => watched.has(o.sender));
  for (const op of operations) touched.add(op.sender);
  const active = direct || operations.length > 0;
  const lines = [], silent = [], tokenEvents = [];
  for (const l of receipt.logs || []) {
    const topic = lower(l.topics?.[0]);
    if (![TRANSFER, APPROVAL].includes(topic)) continue;
    const a = topicAddress(l.topics[1]), b = topicAddress(l.topics[2]);
    if (!watched.has(a) && !(topic === TRANSFER && watched.has(b))) continue;
    if (![3, 4].includes(l.topics.length)) continue;
    const token = lower(l.address), meta = assets[token];
    const raw = l.topics.length === 4 ? l.topics[3] : l.data;
    if (!/^0x[a-f0-9]{64}$/i.test(raw || '')) continue;
    const event = { token, from: a, to: b, kind: topic === TRANSFER ? 'transfer' : 'approval', rawAmount: raw, logIndex: l.logIndex, nft: l.topics.length === 4 };
    tokenEvents.push(event);
    if (!active && !meta) { silent.push(event); continue; }
    if (watched.has(a)) touched.add(a); if (watched.has(b)) touched.add(b);
    const quantity = l.topics.length === 4 ? `NFT ID ${BigInt(raw)}` : meta ? `${amount(raw, meta.decimals)} ${meta.symbol}` : `数量原始整数 ${BigInt(raw)}（精度未知）`;
    lines.push(`${topic === TRANSFER ? '资产转移' : '授权变更'}：${link(token)}｜${quantity}\n${link(a)} → ${link(b)}`);
  }
  const failed = num(receipt.status) === 0;
  const native = BigInt(tx.value || '0x0');
  if (direct && native > 0n) lines.unshift(`${failed ? '尝试转移（交易失败，未生效）' : '直接转移'} ${amount(native, 18)} BNB：${link(from)} → ${to ? link(to) : '新合约'}`);
  const actorOnly = watched.get(from)?.role === 'creator' && actorCovered.includes(from) && (!watched.has(to) || watched.get(to)?.role === 'creator');
  if (direct && (!actorOnly || lines.length)) {
    if (!to) lines.push(`创建合约：${failed ? '失败' : link(lower(receipt.contractAddress))}`);
    else if ((tx.input || '0x').length >= 10) {
      const action = decodeOperationalCall({ to, data: tx.input, value: tx.value || '0x0' });
      lines.push(`${failed ? '调用尝试（交易失败，未生效）' : '调用解码（内部效果仍以事件核验）'}：${describeOperationalAction(action, assets, { formatOwner: link })}`);
    } else if (!lines.length && watched.has(from)) lines.push(`地址主动交易：${link(from)} → ${link(to)}`);
  }
  for (const op of operations) {
    const result = userOperationResult(receipt, op);
    lines.push(`ERC-4337 账户操作：${link(op.sender)}｜nonce ${op.userOpNonce}｜${({ executed: '执行成功', failed: '执行失败', unverified: '账户执行待核验' })[result.status]}${result.reason ? `（${result.reason}）` : ''}`);
  }
  const passiveIncoming = !active && tokenEvents.length > 0
    && tokenEvents.every(e => e.kind === 'transfer' && !watched.has(e.from) && watched.has(e.to));
  return { lines: passiveIncoming ? [] : lines, touched: [...touched], silent: passiveIncoming ? tokenEvents : silent, failed, passiveIncoming };
}

// One persisted incident stream. Failed rounds never advance the scan cursor;
// success alone is insufficient to close an incident while a backlog remains.
export function updateAddressHealth(state, { at, head, error, stallMs = 60000, recoveryMs = 30000 }) {
  const h = state.health ||= {};
  h.lastAttemptAt = at;
  const lag = Math.max(0, (head || 0) - (state.cursor || 0));
  if (error) {
    h.failures = (h.failures || 0) + 1;
    h.failureSince ??= at;
    h.failureCursor ??= state.cursor ?? null;
    h.lastError = error.message; h.failureKind = error.addressFailureKind || addressRpcFailure(error);
    h.provider = error.provider || ''; h.retryAt = error.retryAfterMs > 0 ? at + error.retryAfterMs : null;
    h.healthySince = null; h.healthyChecks = 0;
  } else {
    h.failures = 0; h.lastSuccessAt = at; h.retryAt = null;
    if (h.failureCursor == null || state.cursor > h.failureCursor) { h.failureSince = null; h.failureCursor = null; }
  }
  const since = error ? (h.failureSince ?? at) : (state.lastProgressAt ?? h.lastSuccessAt ?? at);
  // A single timeout or a burst of budget waits is diagnostic, not a new card.
  if (lag > 32) h.lagSince ??= at; else h.lagSince = null;
  const stalled = at - since >= stallMs || (h.lagSince != null && at - h.lagSince >= stallMs);
  if (stalled && !h.alerted) {
    h.alerted = true; h.incidentAt = at; h.incidentCursor = state.cursor ?? null;
    h.healthySince = null; h.healthyChecks = 0; h.status = 'stalled';
    const lagging = h.lagSince != null && at - h.lagSince >= stallMs;
    return { title: '监控异常', content: `${error ? h.lastError : lagging ? '扫描持续落后超过32块' : '链上扫描持续未推进'}\n已持续 ${Math.floor((at - (lagging ? h.lagSince : since)) / 1000)} 秒。游标：${state.cursor ?? '待建立'}｜观测头块：${head || '未知'}｜落后：${lag} 块。\n失败区块未跳过；原缺口与去重保留，WSS＋1秒调度继续补扫。` };
  }
  const caughtUp = !error && !stalled && lag <= 2 && (h.incidentCursor == null || state.cursor > h.incidentCursor);
  if (h.alerted && caughtUp) {
    h.healthySince ??= at; h.healthyChecks = (h.healthyChecks || 0) + 1;
    if (at - h.healthySince >= recoveryMs && h.healthyChecks >= 3) {
      h.alerted = false; h.status = 'healthy'; h.lastError = ''; h.failureKind = ''; h.failureSince = null;
      h.recoveredAt = at; h.healthySince = null; h.healthyChecks = 0;
      return { title: '监控恢复', content: `已连续稳定核验至少 ${Math.floor(recoveryMs / 1000)} 秒并推进游标。\n当前游标：${state.cursor}｜观测头块：${head}｜落后：${lag} 块。\n历史缺口及去重记录保留；连续补扫已恢复。` };
    }
    h.status = 'recovering';
  } else {
    h.healthySince = null; h.healthyChecks = 0;
    h.status = h.alerted ? 'stalled' : error ? 'waiting' : 'healthy';
    if (!error && !h.alerted) { h.lastError = ''; h.failureKind = ''; }
  }
  return null;
}

export function createFourmemeAddressMonitor({ store, rpcBatch, rpcFactory, now = Date.now, wake = () => {}, stopped = () => false,
  enabled = true, catalog = FOURMEME_ADDRESS_CATALOG, actorCovered = () => [], feed = () => ({}),
  maxBlocks = 32, confirmations = 0, timeoutMs = 12000, roundTimeoutMs = 25000 } = {}) {
  if (catalog.length === 0 || catalog.some(a => !addressOK(a.address)) || new Set(catalog.map(a => a.address)).size !== catalog.length) throw Error('地址目录无效或重复');
  let task = null, runtime = { head: 0, lastAttemptAt: 0 };
  const read = () => store.state.fourmemeAddresses || { anchors: [], seen: {}, passive: [], health: {}, catalog: [] };
  const notice = (title, content, detail = {}) => ({ title: `Four.meme 地址 ${title}`, content, template: 'orange', skipAi: true,
    moduleContext: 'Four.meme 独立地址监控', fourmemeAddress: { detectedAt: now(), ...detail } });
  async function poll() {
    if (!enabled || stopped() || task) return false;
    const deadline = createDeadlineSignal(roundTimeoutMs, undefined, '地址监控单轮超时，保留游标，下轮恢复');
    const current = { signal: deadline.signal, startedAt: now(), deadlineAt: now() + roundTimeoutMs }; task = current;
    let roundRpc = rpcBatch;
    const assertActive = () => { current.signal.throwIfAborted(); if (task !== current || stopped()) throw Error('地址监控过期轮次已隔离'); };
    const call = calls => withDeadline(async () => { assertActive(); const values = await roundRpc(calls); assertActive(); if (!Array.isArray(values) || values.length !== calls.length) throw Error('地址监控 RPC 批次不完整'); return values; }, timeoutMs, current.signal);
    const blocks = async (numbers, full = false) => (await call(numbers.map(n => ({ method: 'eth_getBlockByNumber', params: [hex(n), full] })))).map((b, i) => validBlock(b, numbers[i], full));
    runtime.lastAttemptAt = now();
    try {
      roundRpc = rpcFactory ? rpcFactory(current) : rpcBatch;
      return await withAbortSignal(async () => {
        const draft = structuredClone(read()), notices = [];
        const [headHex, savedAnchor] = await call([{ method: 'eth_blockNumber', params: [] },
          ...(draft.cursor === undefined ? [] : [{ method: 'eth_getBlockByNumber', params: [hex(draft.cursor), false] }])]);
        const head = num(headHex), target = Math.max(0, head - confirmations); runtime.head = head;
        if (draft.cursor === undefined) {
          const [anchor] = await blocks([target]);
          draft.cursor = target; draft.activatedAt = now(); draft.activationBlock = target;
          draft.lastProgressAt = now();
          draft.anchors = [{ number: target, hash: lower(anchor.hash) }];
        } else {
          const anchor = validBlock(savedAnchor, draft.cursor);
          if (lower(anchor.hash) !== draft.anchors.at(-1)?.hash) {
            const previous = draft.anchors.filter(a => a.number <= target).reverse();
            const canonical = await blocks(previous.map(a => a.number));
            const common = previous.find((a, i) => a.hash === lower(canonical[i].hash));
            if (!common) throw Error('地址监控重组超过64块，缺口保留，需核验共同祖先');
            const invalid = Object.values(draft.seen).filter(s => s.block > common.number && !s.removed);
            for (const item of invalid) item.removed = true;
            if (invalid.length) notices.push(notice('链重组更正', `以下已报告交易所在区块已被替换，原报告不再代表当前主链结果：\n${invalid.map(s => s.tx).join('\n')}\n已回退至 ${common.number}，重新扫描。`));
            draft.cursor = common.number; draft.anchors = draft.anchors.filter(a => a.number <= common.number);
            draft.reorgs = (draft.reorgs || 0) + 1;
          }
        }
        // Existing entries retain their activation height; newly added addresses
        // begin at the current confirmed head without replaying old history.
        draft.catalog = catalog.map(a => ({ ...a, activationBlock: draft.catalog.find(old => old.address === a.address)?.activationBlock ?? target }));
        const end = Math.min(target, draft.cursor + maxBlocks);
        if (end > draft.cursor) {
          const start = draft.cursor + 1, numbers = Array.from({ length: end - start + 1 }, (_, i) => start + i);
          const [full, lists] = await Promise.all([blocks(numbers, true),
            call(addressLogFilters(catalog.map(a => a.address), start, end).map(f => ({ method: 'eth_getLogs', params: [f] })))]);
          const byNumber = new Map(full.map(b => [num(b.number), b]));
          let parent = draft.anchors.at(-1).hash;
          for (const b of full) { if (lower(b.parentHash) !== parent) throw Error('地址监控区块父哈希不连续'); parent = lower(b.hash); }
          const candidates = new Map();
          for (const b of full) for (const tx of b.transactions) {
            if (catalog.some(a => (a.address === lower(tx.from) || a.address === lower(tx.to)) && num(b.number) > draft.catalog.find(c => c.address === a.address).activationBlock)) candidates.set(lower(tx.hash), tx);
          }
          for (const list of lists) {
            if (!Array.isArray(list)) throw Error('地址监控日志响应无效');
            for (const l of list) {
              const b = byNumber.get(num(l.blockNumber));
              if (!b || l.removed || lower(l.blockHash) !== lower(b.hash)) throw Error('地址监控日志与主链区块不一致');
              const tx = b.transactions.find(t => lower(t.hash) === lower(l.transactionHash));
              if (!tx) throw Error('地址监控日志缺少所属交易');
              candidates.set(lower(tx.hash), tx);
            }
          }
          const txs = [...candidates.values()];
          // Keep receipt batches bounded; a failed chunk prevents cursor advance.
          for (let i = 0; i < txs.length; i += 20) {
            const chunk = txs.slice(i, i + 20);
            const receipts = await call(chunk.map(t => ({ method: 'eth_getTransactionReceipt', params: [t.hash] })));
            for (const [j, tx] of chunk.entries()) {
              const r = receipts[j], n = num(tx.blockNumber), b = byNumber.get(n);
              if (!r || lower(r.transactionHash) !== lower(tx.hash) || lower(r.blockHash) !== lower(b.hash) || num(r.blockNumber) !== n || !['0x0', '0x1'].includes(r.status) || !Array.isArray(r.logs) || r.logs.some(l => l.removed || lower(l.blockHash) !== lower(b.hash) || lower(l.transactionHash) !== lower(tx.hash) || num(l.blockNumber) !== n)) throw Error('地址监控回执不完整或已重组');
              const eligible = draft.catalog.filter(a => n > a.activationBlock);
              const result = observeFourmemeAddressTx(tx, r, eligible, { actorCovered: actorCovered() });
              const id = `${lower(b.hash)}:${lower(tx.hash)}`;
              if (result.silent.length) {
                draft.passive.push({ id, block: n, tx: tx.hash, observedAt: now(), reason: result.passiveIncoming ? 'passive_token_income' : 'unknown_asset', eventCount: result.silent.length, events: result.silent.slice(0, 100) });
                draft.silentTransactions = (draft.silentTransactions || 0) + 1;
              }
              if (!result.lines.length || draft.seen[id]) continue;
              const detectedAt = now();
              notices.push({ ...notice('关联地址观察', renderFourmemeAddressContent({ result, catalog: eligible,
                txHash: tx.hash, block: n, observedAt: detectedAt }), { txHash: tx.hash, block: n, chainAt: num(b.timestamp) * 1000 }),
                title: result.failed ? 'Four.meme 关联地址观察｜交易失败' : 'Four.meme 关联地址观察' });
              draft.seen[id] = { tx: tx.hash, block: n, detectedAt };
            }
          }
          const [final] = await blocks([end]);
          if (lower(final.hash) !== lower(full.at(-1).hash)) throw Error('地址监控提交前检测到重组');
          draft.cursor = end;
          draft.anchors = [...draft.anchors, ...full.map(b => ({ number: num(b.number), hash: lower(b.hash) }))].slice(-64);
          draft.lastProgressAt = now();
        }
        draft.passive = draft.passive.slice(-100);
        draft.seen = Object.fromEntries(Object.entries(draft.seen).slice(-4096));
        // Legacy snapshots may lack progress time until their first new block.
        draft.lastProgressAt ??= draft.health.lastSuccessAt || now();
        const healthNotice = updateAddressHealth(draft, { at: now(), head: Math.max(head, feed().latestHeadBlock || 0) - confirmations });
        if (healthNotice) notices.push(notice(healthNotice.title, healthNotice.content));
        draft.head = head;
        await store.transaction(async () => { assertActive(); store.state.fourmemeAddresses = draft; for (const n of notices) await store.enqueue(n); }, { signal: current.signal });
        assertActive(); wake(); return true;
      }, current.signal);
    } catch (error) {
      if (!stopped()) await store.transaction(async () => {
        const state = store.state.fourmemeAddresses ||= { anchors: [], seen: {}, passive: [], catalog: [], health: {} };
        const healthNotice = updateAddressHealth(state, { at: now(), head: Math.max(runtime.head, state.head || 0, feed().latestHeadBlock || 0) - confirmations, error });
        if (healthNotice) await store.enqueue(notice(healthNotice.title, healthNotice.content));
      });
      wake(); throw error;
    } finally { deadline.dispose(); if (task === current) task = null; }
  }
  return { poll, summary() {
    const s = read(), currentFeed = feed(), observedHead = Math.max(runtime.head || s.head || 0, currentFeed.latestHeadBlock || 0);
    return { enabled, intervalMs: 1000, confirmations, aiEnabled: false, catalog: s.catalog.length ? s.catalog : catalog,
      cursor: s.cursor, head: observedHead, lagBlocks: s.cursor === undefined ? null : Math.max(0, observedHead - confirmations - s.cursor),
      activatedAt: s.activatedAt, activationBlock: s.activationBlock, lastProgressAt: s.lastProgressAt, health: s.health, passiveRecords: s.passive.length, silentTransactions: s.silentTransactions || 0, passivePolicy: 'flap-passive-token-silent',
      lastAttemptAt: runtime.lastAttemptAt, reorgs: s.reorgs || 0, feed: currentFeed,
      pendingNotifications: (store.state._notificationOutbox || []).filter(n => n.payload?.fourmemeAddress).length,
      activeTask: task ? { startedAt: task.startedAt, deadlineAt: task.deadlineAt } : null };
  } };
}
