import { Worker } from 'node:worker_threads';
import { extractFlapProposalActions, VAULT_PORTAL, DEFAULT_FLAP_ADMIN_SAFES } from './safe-proposal-monitor.mjs';
import { formatBeijingTime } from '../shared/display-format.cjs';
import { buildVaultFactoryLaunchUrl } from './vault-links.mjs';
import { decodeRegistryLog, REGISTRY_TOPIC } from './registry-notifications.mjs';

const hash = value => /^0x[0-9a-f]{64}$/.test(value || '');
const address = value => /^0x[0-9a-f]{40}$/.test(value || '');
export const pendingRegistryKey = (tx, vault) => `${tx}:${vault}`;

// No RPC calls for unrelated transactions. Only complete, bounded calldata is decoded.
export function decodePendingRegistration(tx, safes = DEFAULT_FLAP_ADMIN_SAFES) {
  if (!tx || typeof tx !== 'object' || tx.blockNumber != null || tx.blockHash != null) return [];
  const to = String(tx.to || '').toLowerCase(), from = String(tx.from || '').toLowerCase();
  const txHash = String(tx.hash || '').toLowerCase(), data = String(tx.input || '').toLowerCase();
  const allowed = safes.map(s => s.toLowerCase());
  if (!hash(txHash) || !address(from) || ![VAULT_PORTAL, ...allowed].includes(to)
    || !/^0x(?:[0-9a-f]{2})+$/.test(data) || data.length > 65538) return [];
  try {
    if (tx.chainId != null && BigInt(tx.chainId) !== 56n) return [];
    const nonce = BigInt(tx.nonce).toString(), value = BigInt(tx.value || '0x0').toString();
    if (BigInt(nonce) < 0n || BigInt(value) < 0n) return [];
    if (to !== VAULT_PORTAL && (data.slice(0, 10) !== '0x6a761202' || data.length < 10 + 10 * 64)) return [];
    const actions = extractFlapProposalActions({ to, data, value, operation: 0 }, { includeOperations: true, safeAddresses: allowed });
    return [...new Map(actions.filter(a => a.kind === 'vaultFactory' && a.enabled && !a.extraData)
      .map(a => [a.vaultFactory, { txHash, from, to, nonce, value, data, vault: a.vaultFactory,
        viaSafe: to !== VAULT_PORTAL, official: a.official, riskLevel: a.riskLevel }])).values()].slice(0, 16);
  } catch { return []; }
}

export function ingestPendingRegistration(state, candidates, { now = Date.now(), persist = () => {}, mode = 'live' } = {}) {
  state.pendingRegistrations ||= {};
  let added = 0;
  for (const candidate of candidates) {
    const key = pendingRegistryKey(candidate.txHash, candidate.vault);
    if (state.pendingRegistrations[key] || state.knownVaults?.[candidate.vault]
      || Object.values(state.notifications || {}).some(r => r.txHash === candidate.txHash && r.vault === candidate.vault)) continue;
    if (Object.keys(state.pendingRegistrations).length >= 256) {
      state.pendingCapacityReachedAt = new Date(now).toISOString(); break;
    }
    state.pendingRegistrations[key] = { ...candidate, key, mode, firstSeenAt: new Date(now).toISOString(),
      status: 'checking', nextCheckAt: 0, nextAttemptAt: 0 };
    added++;
  }
  if (added) persist();
  return added;
}

export function observePendingReplacement(state, tx, persist = () => {}) {
  if (!hash(tx?.hash) || !address(tx?.from)) return;
  let nonce;
  try { nonce = BigInt(tx.nonce).toString(); } catch { return; }
  let changed = false;
  for (const r of Object.values(state.pendingRegistrations || {})) {
    if (r.from === tx.from && r.nonce === nonce && r.txHash !== tx.hash && r.replacementHash !== tx.hash
      && ['checking', 'pending', 'unverified'].includes(r.status)) { r.replacementHash = tx.hash; changed = true; }
  }
  if (changed) persist();
}

export function pendingRegistryContent(r) {
  const status = { pending: '🟡 发现注册交易，等待链上执行', failed: '🔴 交易执行失败',
    replaced: '🟠 已核实同发送账户、同 nonce 的其他交易上链', noRegistration: '🟠 交易已上链，未发现对应的有效注册事件',
    configuration: '🟢 已有工厂的登记／配置操作已执行',
    withdrawn: '🔴 注册日志被区块重组撤回，暂不视为注册成功',
    unverified: '🟠 暂未确认交易结果，继续以链上注册事件为准' }[r.status] || '🟡 注册操作待核验';
  return [status, `🏦 拟登记工厂：[${r.vault}](https://bscscan.com/address/${r.vault})`,
    `[创建入口](${buildVaultFactoryLaunchUrl(r.vault)})`,
    `调用方式：${r.viaSafe ? 'Safe 执行交易' : 'Portal 直接调用'}`,
    '仅为待执行注册／配置线索，不代表新工厂已注册；首次注册以链上核验为准。',
    r.simulatedAt ? `只读模拟通过：${formatBeijingTime(r.simulatedAt)}（不保证最终执行成功）` : '',
    `首次观测：${formatBeijingTime(r.firstSeenAt)}`,
    `[交易](https://bscscan.com/tx/${r.txHash})`,
    r.status === 'replaced' ? `[上链替代交易](https://bscscan.com/tx/${r.replacementHash})` : '',
  ].filter(Boolean).join('\n\n');
}

// One matching transaction per pass; no mempool-wide hash lookups or retry queues.
export async function checkPendingRegistrations(state, { rpc, ingestLog, persist = () => {}, now = Date.now } = {}) {
  const records = Object.values(state.pendingRegistrations || {});
  const linked = r => Object.values(state.notifications || {}).find(n => n.txHash === r.txHash && n.vault === r.vault && !n.revoked);
  for (const r of records) {
    const event = linked(r);
    if (event) { r.status = 'registered'; r.logSeenAt = event.firstSeenAt;
      r.pendingLeadMs = Date.parse(event.firstSeenAt) - Date.parse(r.firstSeenAt); delete r.data; }
    if (now() - Date.parse(r.firstSeenAt) > 86_400_000 && r.status !== 'pending'
      && (!r.messageId || r.patchedStatus === r.status || r.status === 'registered')) delete state.pendingRegistrations[r.key];
  }
  const r = records.filter(r => ['checking', 'pending', 'unverified'].includes(r.status)
    && (r.nextCheckAt || 0) <= now() && now() - Date.parse(r.firstSeenAt) < 1_800_000)
    .sort((a, b) => (a.nextCheckAt || 0) - (b.nextCheckAt || 0))[0];
  if (!r) { persist(); return; }
  const group = records.filter(x => x.txHash === r.txHash);
  const update = patch => { for (const x of group) if (!linked(x)) Object.assign(x, patch); };
  update({ nextCheckAt: now() + (r.simulatedAt ? 10_000 : 5_000) });
  try {
    if (!r.simulatedAt && r.status === 'checking') {
      const result = await rpc('eth_call', [{ to: r.to, from: r.from, value: '0x' + BigInt(r.value).toString(16), data: r.data }, 'latest']);
      if (r.viaSafe ? !/^0x0{63}1$/.test(result || '') : !/^0x(?:[a-f0-9]{2})*$/i.test(result || '')) throw Error('只读模拟未返回成功结果');
      update({ simulatedAt: new Date(now()).toISOString(), status: 'pending', nextCheckAt: now() + 2000, lastError: '' });
    } else {
      const receipt = await rpc('eth_getTransactionReceipt', [r.txHash]);
      if (receipt) {
        if (!hash(receipt.blockHash) || receipt.transactionHash?.toLowerCase() !== r.txHash) throw Error('回执身份不符');
        const block = await rpc('eth_getBlockByNumber', [receipt.blockNumber, false]);
        if (block?.hash?.toLowerCase() !== receipt.blockHash.toLowerCase()) throw Error('回执所在分叉尚未核实');
        if (Number(receipt.status) === 1) {
          if (!Array.isArray(receipt.logs)) throw Error('回执缺少日志列表');
          const logs = receipt.logs.filter(log => log.transactionHash?.toLowerCase() === r.txHash
            && log.blockHash?.toLowerCase() === receipt.blockHash.toLowerCase() && Number(log.blockNumber) === Number(receipt.blockNumber));
          for (const log of logs) ingestLog(log);
          const registrations = logs.map(log => decodeRegistryLog(log, VAULT_PORTAL))
            .filter(log => log?.topic0 === REGISTRY_TOPIC && log.enabled && !log.removed);
          for (const x of group) if (!linked(x)) {
            if (!registrations.some(log => log.vault === x.vault)) x.status = 'noRegistration';
            else if (state.knownVaults?.[x.vault]) x.status = 'configuration';
            // Positive confirmation-block settings may intentionally postpone ingestion.
          }
        } else if (Number(receipt.status) === 0) update({ status: 'failed' });
        else throw Error('回执状态无效');
      } else if (r.replacementHash) {
        const replacement = await rpc('eth_getTransactionReceipt', [r.replacementHash]);
        if (replacement?.blockHash && replacement.transactionHash?.toLowerCase() === r.replacementHash) {
          const block = await rpc('eth_getBlockByNumber', [replacement.blockNumber, false]);
          if (block?.hash?.toLowerCase() === replacement.blockHash.toLowerCase()) update({ status: 'replaced' });
        }
      }
      if (now() - Date.parse(r.firstSeenAt) > 60_000) {
        for (const x of group) if (x.status === 'pending' && !linked(x)) x.status = 'unverified';
      }
    }
  } catch (error) {
    update({ lastError: error.message });
    if (now() - Date.parse(r.firstSeenAt) > 60_000) update({ status: 'unverified' });
  }
  persist();
}

export function startPendingRegistryFeed({ urls, safes, tracked = [], onCandidates, onReplacement, onHealth, onError }) {
  let worker, stopped = false, timer, failures = 0;
  const start = () => {
    if (stopped) return;
    worker = new Worker(new URL('./pending-registry-worker.mjs', import.meta.url), {
      workerData: { urls, safes, tracked: typeof tracked === 'function' ? tracked() : tracked },
      execArgv: process.execArgv.filter(arg => !arg.startsWith('--input-type')),
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 } });
    worker.on('message', message => {
      if (stopped) return;
      try {
        if (message.type === 'candidates') onCandidates(message.candidates);
        if (message.type === 'replacement') onReplacement(message.tx);
        if (message.type === 'health') { onHealth(message.health); if (message.health.status === 'subscribed') failures = 0; }
      } catch (error) { onError(error); }
      finally { if (['candidates', 'replacement'].includes(message.type)) worker?.postMessage({ type: 'ack' }); }
    });
    worker.on('error', onError);
    worker.on('exit', code => {
      if (!stopped) { onHealth({ status: 'restarting', updatedAt: new Date().toISOString() }); onError(Error(`pending 接收线程退出：${code}`));
        timer = setTimeout(start, Math.min(60_000, 1000 * 2 ** Math.min(++failures, 6))); timer.unref(); }
    });
  };
  start();
  return { stop: async () => { stopped = true; clearTimeout(timer); await worker?.terminate(); } };
}
