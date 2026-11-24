import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { SAFE_QUEUE_API_BASE_URL, fetchQueueProposals, normalizeQueueProposal } from './safe-queue-api.mjs';
import { createSafeProposalState, runSafeProposalScan, DEFAULT_SAFE_API_BASE_URL } from './safe-proposal-monitor.mjs';
const SAFE = '0xc68f29bfe2f6c3d95adb5685592b9f86680968f2';
const TARGET = '0x' + '11'.repeat(20), OWNER = '0x' + '22'.repeat(20), HASH = '0x' + 'ab'.repeat(32), TX = '0x' + 'cd'.repeat(32);
const word = n => BigInt(n).toString(16).padStart(64, '0');
const row = (extra = {}) => ({ chainId: '56', safe: SAFE, safeTxHash: HASH, nonce: '7', to: TARGET,
  value: '9007199254740993000', operation: 0, data: '0x', safeTxGas: '0', baseGas: '0', gasPrice: '0',
  gasToken: null, refundReceiver: null, txHash: null, failed: null, proposer: OWNER, proposedVia: 'DELEGATE',
  proposedBy: TARGET, created: '2026-11-25T01:00:00Z', confirmations: [], ...extra });
const page = results => ({ count: results.length, results, next: null });

test('Queue 保留完整参数与签名，精确数量、空地址、时间和执行状态转换', () => {
  const signature = '0x' + 'ff'.repeat(65);
  const p = normalizeQueueProposal(row({ to: null, confirmations: [{ owner: OWNER, signature, created: '2026-11-25T01:01:00Z' }] }), SAFE, 2);
  assert.equal(p.to, '0x' + '0'.repeat(40)); assert.equal(p.gasToken, p.to);
  assert.equal(p.value, '9007199254740993000'); assert.equal(p.confirmationsRequired, 2);
  assert.equal(p.confirmations[0].signature, signature); assert.equal(p.confirmations[0].submissionDate, '2026-11-25T01:01:00Z');
  assert.equal(p.submissionDate, row().created); assert.equal(p.isExecuted, false); assert.equal(p.isSuccessful, null);
  assert.equal(normalizeQueueProposal(row({ txHash: TX, failed: true }), SAFE, 2).isSuccessful, false);
  assert.equal(normalizeQueueProposal(row({ txHash: TX, failed: false }), SAFE, 2).transactionHash, TX);
  assert.equal(normalizeQueueProposal(row({ proposedVia: 'FUTURE_TYPE' }), SAFE, 2).proposedVia, 'FUTURE_TYPE');
});

test('Queue 拒绝错链错 Safe、异常 nonce、缺失字段及不精确数字', () => {
  for (const extra of [{ chainId: '1' }, { safe: TARGET }, { nonce: '9007199254740993' }, { value: 9007199254740992 },
    { txHash: undefined }, { failed: undefined }, { created: '' }, { confirmations: null }, { gasToken: 'bad' }, { data: '0x1' }]) {
    assert.throws(() => normalizeQueueProposal(row(extra), SAFE, 2), /Safe Queue/);
  }
  for (const threshold of [0, undefined, NaN, 1.5]) assert.throws(() => normalizeQueueProposal(row(), SAFE, threshold), /Safe Queue/);
});

test('Queue 单 Safe 完整分页、固定链过滤，不发送旧筛选条件', async () => {
  const urls = [], other = row({ safeTxHash: TX, nonce: '8' });
  const result = await fetchQueueProposals({ safe: SAFE, readJson: async url => {
    const u = new URL(url); urls.push(u);
    assert.equal(u.searchParams.get('safes'), SAFE + ':56'); assert.equal(u.searchParams.getAll('safes').length, 1);
    assert.equal(u.searchParams.get('nonceOrder'), 'asc'); assert.equal(u.searchParams.get('limit'), '100');
    assert.equal(u.searchParams.has('trusted'), false); assert.equal(u.searchParams.has('nonce__gte'), false);
    return urls.length === 1 ? { count: 2, results: [row()], next: url.replace('offset=0', 'offset=1').replace(':56', ':1') }
      : { count: 2, results: [other], next: null };
  } });
  assert.equal(result.length, 2); assert.equal(urls[1].searchParams.get('offset'), '1');
  assert.deepEqual(await fetchQueueProposals({ safe: SAFE, readJson: async () => page([]) }), []);
});

test('Queue 缺页、重复页、跨站 next 与错链响应均失败，不返回部分结果', async () => {
  for (const response of [
    { count: 2, results: [row()], next: null }, { count: 1, results: [row()], next: 'https://other.test/path' },
    { count: 2, results: [row()], next: SAFE_QUEUE_API_BASE_URL + '/multisig-transactions/queue?offset=0' },
    page([row({ chainId: '1' })]), page([row(), row()]), { results: [], next: null },
  ]) await assert.rejects(fetchQueueProposals({ safe: SAFE, readJson: async () => response }), /Safe Queue/);
});

function fixture() {
  const state = createSafeProposalState([SAFE]); state.safes[SAFE].baselineEstablished = true;
  const data = { rows: [row()], nonce: 7, threshold: 2, urls: [], detail: null, now: Date.now() };
  const opts = { state, safes: [SAFE], queueApiBaseUrl: SAFE_QUEUE_API_BASE_URL,
    rpcBatch: async calls => calls.map(c => '0x' + word(c.params[0].data === '0xe75235b8' ? data.threshold : data.nonce)),
    fetchFn: async url => { data.urls.push(url); return new Response(JSON.stringify(url.includes('/queue/') ? page(data.rows) : data.detail)); } };
  return { state, data, opts, run: () => runSafeProposalScan({ ...opts, nowMs: data.now += 10000 }) };
}

test('零 owner 确认仍发现提案；签名增加、减少、门槛变化和重启沿用现有状态', async () => {
  const f = fixture(); let r = await f.run();
  assert.equal(r.changes[0].type, 'proposed'); assert.equal(r.changes[0].confirmations, 0); assert.equal(r.changes[0].required, 2);
  const firstSeen = Object.values(f.state.proposals)[0].firstSeenAt;
  f.state.pendingChanges = [];
  assert.equal((await f.run()).changes.length, 0);
  f.data.rows[0].confirmations = [{ owner: OWNER }, { owner: TARGET }];
  assert.equal((await f.run()).changes[0].type, 'ready');
  f.data.rows[0].confirmations = [{ owner: OWNER }];
  r = await f.run(); assert.equal(r.changes[0].type, 'signatures'); assert.equal(r.changes[0].status, 'pending');
  f.data.threshold = 1; assert.equal((await f.run()).changes[0].type, 'ready');
  const saved = structuredClone(f.state);
  const restarted = await runSafeProposalScan({ ...f.opts, state: saved, nowMs: f.data.now + 10000 });
  assert.equal(restarted.changes.length, 0); assert.equal(Object.values(saved.proposals)[0].firstSeenAt, firstSeen);
});

test('Queue 消失不判执行；已执行详情从 Transaction Service v2 核验', async () => {
  const f = fixture(); await f.run(); f.state.pendingChanges = []; f.data.rows = [];
  assert.equal((await f.run()).changes.length, 0); assert.equal(Object.values(f.state.proposals)[0].status, 'pending');
  f.data.nonce = 8;
  f.data.detail = { ...row(), nonce: '7', isExecuted: true, isSuccessful: true, transactionHash: TX };
  const result = await f.run(); assert.equal(result.changes[0].type, 'executed');
  assert(f.data.urls.some(u => u.includes('/tx-service/bnb/api/v2/multisig-transactions/')));
  f.data.nonce = 7; f.data.rows = [row()];
  assert.equal((await f.run()).changes[0].type, 'proposed');
  assert.equal(Object.values(f.state.proposals)[0].status, 'pending');
});

test('Queue 或门槛失败保留旧提案，不误发签名变化', async () => {
  const f = fixture(); await f.run(); f.state.pendingChanges = [];
  const before = structuredClone(f.state.proposals);
  f.data.threshold = 0; let result = await f.run();
  assert.equal(result.successfulSafes, 0); assert.deepEqual(f.state.proposals, before);
  assert.equal(result.changes.length, 0);
  f.opts.fetchFn = async () => new Response('{}', { status: 422 });
  result = await f.run(); assert.match(f.state.lastError, /Queue 参数/); assert.doesNotMatch(f.state.lastError, /EIP-55/);
  assert.deepEqual(f.state.proposals, before);
});

test('Queue 与执行共享原凭证标识，旧额度和冷却不因迁移重置', async () => {
  const f = fixture(), key = 'test-cold', sha = s => createHash('sha256').update(s).digest('hex');
  const id = sha(DEFAULT_SAFE_API_BASE_URL + '|' + key), cooldown = Date.now() + 86400000;
  const account = { apiNextAttemptAtMs: cooldown, apiQuota: { remaining: 0, resetsAt: cooldown } };
  Object.assign(f.state, { apiAccounts: { [id]: account }, apiPoolId: sha(id), apiAccountIds: [id] });
  const result = await runSafeProposalScan({ ...f.opts, apiKeys: [key] });
  assert.equal(result.changes.length, 0); assert.deepEqual(f.state.apiAccounts[id].apiQuota, account.apiQuota);
  assert.equal(f.state.apiAccounts[id].apiNextAttemptAtMs, cooldown); assert.equal(f.data.urls.length, 0);
  assert.deepEqual(f.state.apiAccountIds, [id]);
});

test('Flap 手动与持续入口、Four.meme 入口均启用 Queue，调度常量不变', () => {
  const flap = readFileSync(new URL('./monitor.mjs', import.meta.url), 'utf8');
  assert.equal(flap.match(/queueApiBaseUrl: SAFE_QUEUE_API_BASE_URL/g)?.length, 2);
  const four = readFileSync(new URL('../fourmeme-monitor/safe-monitor.mjs', import.meta.url), 'utf8');
  assert.match(four, /queueApiBaseUrl: SAFE_QUEUE_API_BASE_URL/);
  assert.match(four, /intervalMs = 10_000, activeIntervalMs = 5_000/);
});
