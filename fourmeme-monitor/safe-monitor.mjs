import { createSafeProposalState, runSafeProposalScan, acknowledgeSafeProposalChanges,
  buildSafeProposalContent, normalizeSafeApiKeys } from '../flap-monitor/safe-proposal-monitor.mjs';
import { createDeadlineSignal, withAbortSignal, withDeadline } from '../shared/request-deadline.mjs';
import { cardStatus } from './card-style.mjs';

export const FOURMEME_SAFE = '0x161dd0cfdb0aa25e2504f725655ef9b799375b71';
const ACTIVE = new Set(['pending', 'ready', 'confirming']);
const address = word => /^0{24}[a-f0-9]{40}$/i.test(word || '') ? '0x' + word.slice(24).toLowerCase() : '';
const words = value => typeof value === 'string' && /^0x(?:[a-f0-9]{64})+$/i.test(value) ? value.slice(2).match(/.{64}/g) : [];

export function readFourmemeSafeConfig(env = process.env) {
  const own = env.FOURMEME_SAFE_API_KEYS || env.FOURMEME_SAFE_API_KEY;
  const apiKeys = normalizeSafeApiKeys(own || env.FLAP_SAFE_API_KEYS, own ? '' : env.FLAP_SAFE_API_KEY);
  return { enabled: env.FOURMEME_SAFE_MONITOR !== 'false', apiKeys,
    credentialSource: own ? 'fourmeme' : apiKeys.length ? 'shared-existing' : 'missing',
    intervalMs: 10_000, activeIntervalMs: 5_000, timeoutMs: 5_000, roundTimeoutMs: 30_000 };
}

function decodeIdentity(values, block, at) {
  const ownerWords = words(values[0]);
  const count = Number(BigInt('0x' + (ownerWords[1] || '0')));
  const owners = ownerWords.slice(2).map(address);
  const threshold = Number(BigInt(values[1] || '0x0'));
  const singleton = address(words(values[2])[0]);
  if (ownerWords[0] !== '20'.padStart(64, '0') || count < 1 || count > 100 || owners.length !== count
    || owners.some(a => !a || /^0x0+$/.test(a)) || new Set(owners).size !== count
    || !Number.isSafeInteger(threshold) || threshold < 1 || threshold > count || !singleton || /^0x0+$/.test(singleton)) {
    throw Error('Four.meme Safe 成员、门槛或代理身份读取无效，保留旧状态');
  }
  return { owners, threshold, singleton, block: Number(BigInt(block)), checkedAt: at };
}

export function renderFourmemeSafe(changes = [], metadata = {}, identity) {
  const options = {
    formatOwner: owner => /^0x[a-f0-9]{40}$/i.test(owner || '') ? `[${owner}](https://bscscan.com/address/${owner})（${identity?.owners?.includes(owner.toLowerCase()) ? 'Four.meme Safe 签名人' : '成员身份待核验'}）` : '未知地址',
    annotate: text => text.replaceAll('**', ''),
  };
  return changes.map(change => {
    const [heading, status, ...details] = buildSafeProposalContent([change], metadata, options).trimEnd().split('\n');
    const index = details.findIndex(line => line.startsWith('确认进度：'));
    const progress = index === -1 ? [] : details.splice(index, 1);
    return [`## ${heading}`, status, ...progress, ...details].join('\n');
  }).join('\n\n');
}

// The reused engine is pure state + injected I/O. Never import Flap's process,
// credentials loader, scheduler, AI, or state files into the Four.meme runtime.
export function createFourmemeSafeMonitor({ store, rpcBatch, fetchFn = fetch, now = Date.now,
  wake = () => {}, stopped = () => false, onRequest = () => {}, enabled = true,
  apiKeys = [], credentialSource = 'fourmeme', intervalMs = 10_000, activeIntervalMs = 5_000,
  timeoutMs = 5_000, roundTimeoutMs = 30_000, identityIntervalMs = 60_000,
  scan = runSafeProposalScan } = {}) {
  let current = null;
  const read = () => store.state.fourmemeSafe || createSafeProposalState([FOURMEME_SAFE]);
  const period = () => Object.values(read().proposals || {}).some(p => ACTIVE.has(p.status)) ? activeIntervalMs : intervalMs;
  const assertActive = task => {
    task.signal.throwIfAborted();
    if (current !== task || stopped()) throw Error('Four.meme Safe 过期轮次已隔离');
  };
  const notification = (title, content, template = 'orange', detail = {}) => ({
    title: `Four.meme Safe ${title}`, content, template, skipAi: true,
    moduleContext: 'Four.meme Safe 资金与管理提案',
    url: `https://app.safe.global/transactions/queue?safe=bnb:${FOURMEME_SAFE}`,
    ...(detail.changes ? { cardOpts: { showDetailLink: false, showUpdatedAt: false } } : {}),
    fourmemeSafe: { safe: FOURMEME_SAFE, detectedAt: now(), ...detail },
  });

  async function poll() {
    if (!enabled || stopped() || current) return false;
    const deadline = createDeadlineSignal(roundTimeoutMs, undefined, 'Four.meme Safe 单轮超过30秒，已释放并等待下一轮');
    const task = { signal: deadline.signal, startedAt: now(), deadlineAt: now() + roundTimeoutMs };
    current = task;
    const draft = structuredClone(read());
    const notices = [];
    const call = (calls, options) => withDeadline(async () => {
      assertActive(task);
      const result = await rpcBatch(calls, options);
      assertActive(task);
      return result;
    }, timeoutMs, task.signal, 'Four.meme Safe RPC 超时');
    try {
      const result = await withAbortSignal(async () => {
        if (!apiKeys.length) throw Error('未配置 Safe API 凭证；未发送匿名请求');
        let identityFailure = '';
        if (!draft.identity || now() - draft.identity.checkedAt >= identityIntervalMs) {
          try {
            const [block] = await call([{ method: 'eth_blockNumber', params: [] }]);
            if (!/^0x[a-f0-9]+$/i.test(block || '')) throw Error('Safe 核验区块无效');
            const values = await call([
              { method: 'eth_call', params: [{ to: FOURMEME_SAFE, data: '0xa0e67e2b' }, block] },
              { method: 'eth_call', params: [{ to: FOURMEME_SAFE, data: '0xe75235b8' }, block] },
              { method: 'eth_getStorageAt', params: [FOURMEME_SAFE, '0x0', block] },
            ]);
            const identity = decodeIdentity(values, block, now());
            if (draft.identity && JSON.stringify([draft.identity.owners, draft.identity.threshold, draft.identity.singleton]) !== JSON.stringify([identity.owners, identity.threshold, identity.singleton])) {
              notices.push(notification('签名配置变更', `${cardStatus('changed', '签名配置已核验')}\n管理 Safe：${FOURMEME_SAFE}\n门槛：${draft.identity.threshold}/${draft.identity.owners.length} → ${identity.threshold}/${identity.owners.length}\n当前成员：\n${identity.owners.join('\n')}\n实现：${draft.identity.singleton} → ${identity.singleton}\n核验区块：${identity.block}`, 'red'));
            }
            draft.identity = identity;
            draft.identityError = '';
          } catch (error) {
            assertActive(task);
            if (!draft.identity) throw error;
            identityFailure = error.message;
            draft.identityError = identityFailure;
          }
        }
        const scanned = await scan({ state: draft, safes: [FOURMEME_SAFE], rpcBatch: call,
          apiKeys, requestIntervalMs: 5000, maxSafesPerRun: 1, timeoutMs, nowMs: now(), captureUnseenExecutions: true,
          isolateExecutionFailures: true, executionBudgetMs: 3000,
          fetchFn: async (url, options) => {
            assertActive(task); onRequest();
            const response = await withAbortSignal(() => fetchFn(url, options), task.signal);
            assertActive(task);
            return response;
          } });
        assertActive(task);
        // Optional amount metadata is bounded; missing decimals remain explicitly
        // unknown. It never gates progress indefinitely or invokes an AI service.
        const assets = [...new Set((draft.pendingChanges || []).flatMap(c => (c.actions || []).map(a => a.asset)))]
          .filter(a => /^0x[a-f0-9]{40}$/i.test(a || '') && !/^0x0+$/.test(a) && !Number.isInteger(draft.tokenMetadata?.[a]?.decimals)).slice(0, 2);
        if (assets.length) {
          try {
            const values = await withDeadline(() => call(assets.map(to => ({ method: 'eth_call', params: [{ to, data: '0x313ce567' }, 'latest'] }))), Math.min(timeoutMs, 1500), task.signal);
            draft.tokenMetadata ||= {};
            for (const [i, asset] of assets.entries()) {
              const w = words(values[i]);
              if (w.length === 1 && BigInt('0x' + w[0]) <= 255n) draft.tokenMetadata[asset] = { decimals: Number(BigInt('0x' + w[0])) };
            }
          } catch { assertActive(task); }
        }
        const suffix = { existing: '当前待执行提案', proposed: '发现管理提案', signatures: '签名进度更新', ready: '签名已满足，等待执行', executed: '执行成功', failed: '执行失败', invalidated: '提案已被替换' };
        for (const type of new Set(draft.pendingChanges.map(c => c.type))) {
          const changes = draft.pendingChanges.filter(c => c.type === type);
          notices.push(notification(suffix[type] || '提案状态更新', renderFourmemeSafe(changes, draft.tokenMetadata, draft.identity),
            type === 'executed' ? 'green' : ['failed', 'invalidated'].includes(type) ? 'yellow' : 'red',
            { changes: changes.map(c => ({ id: c.id, hash: c.safeTxHash, nonce: c.nonce, type })) }));
        }
        acknowledgeSafeProposalChanges(draft, draft.pendingChanges.map(c => c.id));
        const problem = [draft.lastError || scanned.errors?.join('；'), identityFailure].filter(Boolean).join('；');
        const oldHealth = draft.health || {};
        const failedAttempt = !!(scanned.errors?.length || identityFailure || draft.safes?.[FOURMEME_SAFE]?.lastNonceError);
        draft.health = { ...oldHealth, lastAttemptAt: task.startedAt, lastError: problem,
          failures: problem ? (oldHealth.failures || 0) + Number(failedAttempt) : scanned.successfulSafes > 0 ? 0 : oldHealth.failures || 0 };
        if (!problem && scanned.successfulSafes > 0) {
          draft.health.lastSuccessAt = now();
          if (oldHealth.alerted) notices.push(notification('监控恢复', `${cardStatus('healthy', '提案读取恢复 / 进度已保存')}\n历史提案和去重记录保留。`, 'green'));
          draft.health.alerted = false;
        } else if (draft.health.failures >= 5 && !oldHealth.alerted) {
          draft.health.alerted = true;
          notices.push(notification('监控异常', `${cardStatus('warning', `提案检查异常 / 连续 ${draft.health.failures} 次`)}\n${problem}\n保留原状态与通知，按现有限流规则重试。`, 'yellow'));
        }
        // Execution failures retain their own incident, deadlines and retries.
        // A skipped execution job is neither another failure nor a recovery.
        const pending = Object.values(draft.proposals || {}).filter(p => ACTIVE.has(p.status) && p.nonce < draft.safes?.[p.safe]?.currentNonce);
        const safeHealth = draft.safes?.[FOURMEME_SAFE] || {};
        const executionProblem = pending.length > 0 || !!safeHealth.executionGap;
        const eh = draft.executionHealth ||= { failures: 0, alerted: false };
        if (executionProblem) {
          eh.pendingSince ||= now();
          eh.failures += Number(!!scanned.executionErrors?.length);
          eh.lastError = [...new Set([...pending.map(p => p.executionError || '旧提案执行结果待核验'),
            ...(safeHealth.executionGap ? [safeHealth.executionHistoryError || '执行索引缺口待补齐'] : [])])].join('；');
          if (!eh.alerted && (eh.failures >= 5 || now() - eh.pendingSince >= 60000)) {
            eh.alerted = true;
            notices.push(notification('执行补查异常', `${cardStatus('warning', '执行补查异常 / 独立重试')}\n${eh.lastError}\n保留缺口与旧提案，新提案和签名监控继续运行。`, 'yellow'));
          }
        } else {
          if (eh.alerted) notices.push(notification('执行补查恢复', `${cardStatus('healthy', '执行补查已恢复')}\n旧提案及执行缺口已处理，原提案与去重记录保留。`, 'green'));
          Object.assign(eh, { failures: 0, alerted: false, pendingSince: 0, lastError: '' });
        }
        await store.transaction(async () => {
          assertActive(task);
          store.state.fourmemeSafe = draft;
          for (const payload of notices) await store.enqueue(payload);
        }, { signal: task.signal });
        assertActive(task);
        wake();
        return !problem && scanned.successfulSafes > 0;
      }, task.signal);
      return result;
    } catch (error) {
      if (!stopped()) {
        // Do not commit the partially scanned draft. Record only fault health.
        await store.transaction(async () => {
          const state = store.state.fourmemeSafe ||= createSafeProposalState([FOURMEME_SAFE]);
          const health = state.health ||= {};
          health.lastAttemptAt = task.startedAt;
          health.lastError = error.message;
          health.failures = (health.failures || 0) + 1;
          if ((task.signal.aborted || health.failures >= 5) && !health.alerted) {
            health.alerted = true;
            await store.enqueue(notification('监控异常', `${cardStatus('warning', '本轮检查失败 / 原进度保留')}\n${error.message}\n原提案及去重记录保留，后续轮次自动重试。`, 'yellow'));
          }
        });
        wake();
      }
      throw error;
    } finally { deadline.dispose(); if (current === task) current = null; }
  }
  return { poll, interval: period,
    summary() {
      const state = read();
      return { enabled, configured: !!apiKeys.length, credentialSource, intervalMs: period(), aiEnabled: false,
        safe: FOURMEME_SAFE, identity: state.identity, identityError: state.identityError || '',
        currentNonce: state.safes?.[FOURMEME_SAFE]?.currentNonce, lastPollAt: state.lastRunAt,
        executionGap: state.safes?.[FOURMEME_SAFE]?.executionGap || null,
        executionHealth: state.executionHealth || {},
        executionRetries: Object.values(state.proposals || {}).filter(p => ACTIVE.has(p.status) && p.nonce < state.safes?.[p.safe]?.currentNonce)
          .map(p => ({ nonce: p.nonce, hash: p.safeTxHash, retryAt: p.executionNextAttemptAtMs || 0, lastError: p.executionError || '' })),
        executionHistoryRetryAt: state.safes?.[FOURMEME_SAFE]?.executionHistoryNextAttemptAtMs || 0,
        lastSuccessAt: state.lastSuccessAt, health: state.health || {}, activeTask: current ? { startedAt: current.startedAt, deadlineAt: current.deadlineAt } : null,
        activeProposals: Object.values(state.proposals || {}).filter(p => ACTIVE.has(p.status)).map(p => ({ nonce: p.nonce, hash: p.safeTxHash, confirmations: p.confirmations, required: p.required, status: p.status })),
        pendingNotifications: (store.state._notificationOutbox || []).filter(n => n.payload?.fourmemeSafe).length,
        apiNextAttemptAt: Math.max(state.apiNextAttemptAtMs || 0, state.safes?.[FOURMEME_SAFE]?.nextAttemptAtMs || 0),
        lastError: state.health?.lastError || state.lastError || '',
      };
    },
  };
}
