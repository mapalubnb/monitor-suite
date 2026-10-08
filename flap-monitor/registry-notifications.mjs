// Registration delivery is independent of HTTP scans. Only durable, validated
// Portal logs enter this queue; HTTP and WSS share the same identities.
export const REGISTRY_TOPIC = '0xd8cf270eb9827992a063745f0afaa72431f8c63fc46736f8b484862dcc709787';
export const CATEGORY_TOPIC = '0x566b7414cab715cde3c8bcc93daec35325367d6c648327d19a1867d1006af3b3';
const hash = x => /^0x[a-f0-9]{64}$/.test(x || '');
const lower = x => String(x || '').toLowerCase();
const flights = new WeakMap();
const previewFor = (state, record) => state.pendingRegistrations?.[`${record.txHash}:${record.vault}`];
function claimVault(state, record) {
  record.candidate = false;
  state.knownVaults[record.vault] = { eventKey: record.key, firstSeenAt: record.firstSeenAt, txHash: record.txHash,
    blockNumber: record.blockNumber, topic0: record.topic0 };
}

export function decodeRegistryLog(log, portal) {
  if (lower(log?.address) !== lower(portal) || log?.topics?.length !== 1) return null;
  const topic0 = lower(log.topics[0]), data = lower(log.data);
  const count = topic0 === REGISTRY_TOPIC ? 4 : topic0 === CATEGORY_TOPIC ? 2 : 0;
  if (!count || !new RegExp(`^0x[0-9a-f]{${count * 64}}$`).test(data)) return null;
  const words = data.slice(2).match(/.{64}/g);
  if (!/^0{24}[a-f0-9]{40}$/.test(words[0]) || /^0+$/.test(words[0])) return null;
  if (topic0 === REGISTRY_TOPIC && (!/^0{63}[01]$/.test(words[1]) || !/^0{63}[01]$/.test(words[2]) || BigInt('0x' + words[3]) > 255n)) return null;
  if (topic0 === CATEGORY_TOPIC && BigInt('0x' + words[1]) > 255n) return null;
  const blockNumber = Number(log.blockNumber), logIndex = Number(log.logIndex);
  if (log.blockNumber == null || log.logIndex == null || !Number.isSafeInteger(blockNumber) || blockNumber <= 0 || !Number.isSafeInteger(logIndex) || logIndex < 0
    || !hash(lower(log.blockHash)) || !hash(lower(log.transactionHash))) return null;
  const vault = '0x' + words[0].slice(-40), blockHash = lower(log.blockHash), txHash = lower(log.transactionHash);
  return { vault, blockHash, txHash, blockNumber, logIndex, topic0,
    key: `${blockHash}:${txHash}:${vault}`, removed: log.removed === true,
    enabled: topic0 === REGISTRY_TOPIC ? words[1].endsWith('1') : null };
}

export function revokeRegistryEvent(state, record, persist, now = Date.now()) {
  if (record.revoked) return false;
  record.revoked = true;
  record.revokedAt = new Date(now).toISOString();
  record.nextAttemptAt = 0;
  const preview = previewFor(state, record);
  if (preview && !preview.confirmedEventKey) {
    preview.status = 'withdrawn'; preview.nextAttemptAt = 0;
  }
  if (state.knownVaults?.[record.vault]?.eventKey === record.key) {
    delete state.knownVaults[record.vault];
    // A replacement fork may arrive before the old endpoint reports removed.
    const replacement = Object.values(state.notifications).filter(r => r.vault === record.vault && r.candidate && !r.revoked)
      .sort((a, b) => b.blockNumber - a.blockNumber)[0];
    if (replacement) claimVault(state, replacement);
  }
  persist();
  return true;
}

export function ingestRegistryLog(state, log, { portal, persist = () => {}, now = Date.now(), source = 'wss' } = {}) {
  const event = decodeRegistryLog(log, portal);
  if (!event) return null;
  state.notifications ||= {};
  state.knownVaults ||= {};
  let record = state.notifications[event.key];
  if (event.removed) {
    // Keep tombstones so a delayed second endpoint cannot resurrect an orphan.
    if (!record) record = state.notifications[event.key] = { ...event, firstSeenAt: new Date(now).toISOString() };
    revokeRegistryEvent(state, record, persist, now);
    return record;
  }
  if (record) return record;
  // Category-only changes are configuration events, not proof of registration.
  if (event.topic0 !== REGISTRY_TOPIC || !event.enabled) return null;
  const known = state.knownVaults[event.vault];
  const previous = state.notifications[known?.eventKey];
  if (known && (!previous || previous.settled || previous.blockHash === event.blockHash)) return null;
  record = state.notifications[event.key] = { ...event, source, firstSeenAt: new Date(now).toISOString(), nextAttemptAt: 0 };
  const preview = previewFor(state, record);
  if (preview) {
    preview.status = 'registered'; preview.logSeenAt = record.firstSeenAt;
    preview.pendingLeadMs = now - Date.parse(preview.firstSeenAt);
    record.pendingFirstSeenAt = preview.firstSeenAt;
    record.pendingLeadMs = preview.pendingLeadMs;
  }
  if (known) record.candidate = true;
  else claimVault(state, record);
  persist();
  return record;
}

function patchVersion(record) {
  return record.revoked ? 'revoked' : record.codeStatus === 'missing' ? 'missing-code' : '';
}

export function drainRegistryNotifications(state, { persist = () => {}, send, patch, sendPending, patchPending, now = Date.now } = {}) {
  if (flights.has(state)) return flights.get(state);
  if (!Object.values(state.notifications || {}).some(r => (r.nextAttemptAt || 0) <= now()
    && (!r.messageId && !r.revoked && !r.candidate || r.messageId && patchVersion(r) && r.patchedVersion !== patchVersion(r)))
    && !Object.values(state.pendingRegistrations || {}).some(r => r.mode === 'live' && (r.nextAttemptAt || 0) <= now()
      && (sendPending && !r.messageId && r.status === 'pending'
        || patchPending && r.messageId && !['checking', 'registered'].includes(r.status) && r.patchedStatus !== r.status))) {
    return Promise.resolve({ sent: false, errors: [] });
  }
  const run = (async () => {
    let sent = 0;
    const errors = [];
    for (const record of Object.values(state.notifications || {})) {
      if ((record.nextAttemptAt || 0) > now()) continue;
      try {
        // Persist again before each network operation, including after a failed disk write.
        if (!record.messageId && !record.revoked && !record.candidate) {
          persist();
          const preview = previewFor(state, record);
          let id;
          if (preview?.messageId && !preview.confirmedEventKey) {
            await patch({ ...record, messageId: preview.messageId }, 'registered');
            id = preview.messageId; preview.confirmedEventKey = record.key; preview.patchedStatus = 'registered';
          } else id = await send(record, `registry:${record.key}`);
          if (!id) throw new Error('金库注册消息未送达，保留待发送事件');
          record.messageId = id;
          record.sentAt = new Date(now()).toISOString();
          record.deliveryMs = Math.max(0, now() - Date.parse(record.firstSeenAt));
          persist();
          sent++;
        }
        const version = patchVersion(record);
        if (record.messageId && version && version !== record.patchedVersion) {
          persist();
          // Snapshot version: a removed event during await must trigger another patch.
          await patch(record, version);
          record.patchedVersion = version;
          persist();
        }
        record.failures = 0;
        record.lastError = '';
        record.nextAttemptAt = 0;
      } catch (error) {
        record.failures = (record.failures || 0) + 1;
        record.nextAttemptAt = now() + Math.min(60_000, 1000 * 2 ** Math.min(6, record.failures - 1));
        record.lastError = error.message;
        errors.push(error.message);
      }
    }
    // Share the same delivery flight with mined logs. A log arriving while the
    // preview send is in flight adopts its message ID on the next drain.
    for (const r of Object.values(state.pendingRegistrations || {})) {
      if (r.mode !== 'live' || (r.nextAttemptAt || 0) > now() || ['checking', 'registered'].includes(r.status)) continue;
      try {
        if (!r.messageId && r.status === 'pending' && sendPending) {
          persist();
          const version = r.status;
          const id = await sendPending({ ...r }, `registry-pending:${r.key}`);
          if (!id) throw Error('pending 注册预警未送达');
          r.messageId = id; r.sentAt = new Date(now()).toISOString(); r.patchedStatus = version;
          r.deliveryMs = now() - Date.parse(r.firstSeenAt); persist(); sent++;
        }
        if (r.messageId && r.status !== 'registered' && r.patchedStatus !== r.status && patchPending) {
          persist(); const version = r.status;
          await patchPending({ ...r }); r.patchedStatus = version; persist();
        }
        r.failures = 0; r.nextAttemptAt = 0; r.lastDeliveryError = '';
      } catch (error) {
        r.failures = (r.failures || 0) + 1;
        r.nextAttemptAt = now() + Math.min(60000, 1000 * 2 ** Math.min(r.failures, 6));
        r.lastDeliveryError = error.message; errors.push(error.message);
      }
    }
    state.deliveryError = errors.join('；');
    persist();
    return { sent: sent > 0, errors };
  })().finally(() => flights.delete(state));
  flights.set(state, run);
  return run;
}

export async function auditRegistryNotifications(state, { rpc, persist = () => {}, now = Date.now } = {}) {
  const record = Object.values(state.notifications || {}).find(r => (r.messageId || r.candidate) && !r.revoked && !r.settled
    && (r.nextAuditAt || 0) <= now());
  if (record) {
    record.nextAuditAt = now() + 10_000;
    try {
      const block = await rpc('eth_getBlockByNumber', ['0x' + record.blockNumber.toString(16), false]);
      if (!hash(lower(block?.hash)) || Number(block.number) !== record.blockNumber) throw new Error('注册区块核验暂未返回有效区块');
      if (lower(block.hash) !== record.blockHash) revokeRegistryEvent(state, record, persist, now());
      else {
        record.canonicalCheckedAt = new Date(now()).toISOString();
        if (!record.codeStatus) {
          const code = await rpc('eth_getCode', [record.vault, 'latest']);
          if (!/^0x(?:[a-f0-9]{2})*$/i.test(code || '')) throw new Error('金库合约代码核验返回无效');
          record.codeStatus = code === '0x' ? 'missing' : 'present';
        }
        // Keep checking recent events across restarts/disconnects. After 128 blocks,
        // a canonical hash match ends this bounded background check (not a finality claim).
        record.settled = (state.latestBlock || 0) - record.blockNumber >= 128;
      }
      record.auditError = '';
    } catch (error) { record.auditError = error.message; }
    persist();
  }
  // Never prune an unsent alert or an outstanding correction.
  let pruned = false;
  for (const [key, r] of Object.entries(state.notifications || {})) {
    if (now() - Date.parse(r.firstSeenAt) < 86_400_000) continue;
    if ((r.settled && (r.messageId || r.candidate) || r.revoked) && (!patchVersion(r) || !r.messageId || r.patchedVersion === patchVersion(r))) {
      delete state.notifications[key]; pruned = true;
    }
  }
  if (pruned) persist();
}
