import test from 'node:test';
import assert from 'node:assert/strict';
import { createTransactionalOutbox } from '../shared/transactional-outbox.mjs';
import { runSafeProposalScan, buildSafeProposalContent } from '../flap-monitor/safe-proposal-monitor.mjs';
import { createFourmemeSafeMonitor, readFourmemeSafeConfig, renderFourmemeSafe, FOURMEME_SAFE } from './safe-monitor.mjs';

const word = n => BigInt(n).toString(16).padStart(64, '0');
const aWord = a => a.slice(2).padStart(64, '0');
const OWNER = '0x' + '11'.repeat(20), TOKEN = '0x' + '22'.repeat(20), RECIPIENT = '0x' + '33'.repeat(20);
const HASH = '0x' + 'ab'.repeat(32), TX = '0x' + 'cd'.repeat(32);
const proposal = () => ({ safe: FOURMEME_SAFE, safeTxHash: HASH, nonce: 150, to: TOKEN, operation: 0, value: '0',
  data: '0xa9059cbb' + aWord(RECIPIENT) + word(1168057000000000000000000n),
  submissionDate: '2026-11-18T05:45:05.731Z', confirmationsRequired: 3, confirmations: [{ owner: OWNER }] });
const settle = () => new Promise(resolve => setTimeout(resolve, 5));

function fixture(initial = {}, overrides = {}) {
  let time = Date.now(), disk = structuredClone(initial), fail = false;
  const data = { nonce: 150, owners: [OWNER, TOKEN, RECIPIENT], threshold: 3, proposals: [proposal()], status: 200, requests: [], detail: null };
  const store = createTransactionalOutbox({ initial: structuredClone(initial),
    persist: value => { if (fail) throw Error('disk full'); disk = structuredClone(value); }, deliver: async () => 'delivered' });
  const rpcBatch = async calls => calls.map(c => {
    if (c.method === 'eth_blockNumber') return '0x100';
    if (c.method === 'eth_getStorageAt') return '0x' + aWord('0x3e5c63644e683549055b9be8653de26e0b4cd36e');
    switch (c.params?.[0]?.data) {
      case '0xa0e67e2b': return '0x' + word(32) + word(data.owners.length) + data.owners.map(aWord).join('');
      case '0xe75235b8': return '0x' + word(data.threshold);
      case '0xaffed0e0': return '0x' + word(data.nonce);
      case '0x313ce567': return '0x' + word(18);
      default: return '0x' + word(1);
    }
  });
  const fetchFn = async url => {
    data.requests.push(url);
    if (data.status !== 200) return new Response('{}', { status: data.status, headers: { 'retry-after': '60' } });
    return new Response(JSON.stringify(url.includes('/multisig-transactions/0x') ? data.detail : { results: url.includes('executed=true') ? data.history || (data.detail ? [data.detail] : []) : data.proposals, next: null }));
  };
  const opts = { store, rpcBatch, fetchFn, now: () => time, apiKeys: ['test-key'],
    scan: options => runSafeProposalScan({ ...options, requestIntervalMs: 1 }), ...overrides };
  const monitor = createFourmemeSafeMonitor(opts);
  return { monitor, store, data, opts, get disk() { return disk; }, set fail(value) { fail = value; }, advance: n => { time += n; },
    async poll() { await settle(); time += 100; return monitor.poll(); } };
}

test('Four.meme Safe配置独立，显式关闭和已有凭证回退不修改Flap配置', () => {
  const env = { FLAP_SAFE_API_KEYS: 'one,two', FOURMEME_SAFE_MONITOR: 'false' };
  const c = readFourmemeSafeConfig(env);
  assert.equal(c.enabled, false); assert.deepEqual(c.apiKeys, ['one', 'two']); assert.equal(c.credentialSource, 'shared-existing');
  assert.equal(c.intervalMs, 10000); assert.equal(c.activeIntervalMs, 5000);
  assert.deepEqual(readFourmemeSafeConfig({ ...env, FOURMEME_SAFE_API_KEY: 'own' }).apiKeys, ['own']);
  assert.equal(env.FLAP_SAFE_API_KEYS, 'one,two');
});

test('Four.meme Safe首次待执行通知、金额、独立字段和AI关闭；重启不重复', async () => {
  const old = { githubMonitor: { jobs: [{ id: 'gap' }] }, actorNotificationLedger: { entries: { old: true } }, flap: { untouched: true } };
  const f = fixture(old); assert.equal(f.monitor.interval(), 10000);
  assert.equal(await f.poll(), true);
  assert.equal(f.monitor.interval(), 5000); assert.equal(f.monitor.summary().currentNonce, 150);
  const n = f.disk._notificationOutbox[0].payload;
  assert.match(n.title, /Four.meme Safe 当前待执行/); assert.match(n.content, /1,?168,?057/);
  assert.match(n.content, /Four.meme Safe 签名人/); assert.equal(n.skipAi, true); assert.doesNotMatch(n.content, /Flap|\*\*/);
  for (const k of Object.keys(old)) assert.deepEqual(f.disk[k], old[k]);
  const restarted = fixture(f.disk); await restarted.poll();
  assert.equal(restarted.disk._notificationOutbox.length, 1);
});

test('Four.meme签名增加、满足门槛和同nonce不同hash均保持独立去重', async () => {
  const f = fixture(); await f.poll();
  f.data.proposals[0].confirmations.push({ owner: TOKEN }); await f.poll();
  assert.match(f.disk._notificationOutbox.at(-1).payload.title, /签名进度更新/);
  f.data.proposals[0].confirmations.push({ owner: RECIPIENT }); await f.poll();
  assert.match(f.disk._notificationOutbox.at(-1).payload.title, /签名已满足/);
  f.data.proposals.push({ ...proposal(), safeTxHash: '0x' + 'ef'.repeat(32) }); await f.poll();
  assert.equal(Object.keys(f.disk.fourmemeSafe.proposals).length, 2);
});

test('Four.meme已知提案执行后确认结果并恢复普通周期，不回放历史', async () => {
  const f = fixture(); await f.poll();
  f.data.nonce = 151; f.data.proposals = [];
  f.data.detail = { ...proposal(), isExecuted: true, isSuccessful: true, transactionHash: TX };
  await f.poll();
  assert.equal(f.monitor.interval(), 10000); assert.match(f.disk._notificationOutbox.at(-1).payload.title, /执行成功/);
  const count = f.disk._notificationOutbox.length; await f.poll(); assert.equal(f.disk._notificationOutbox.length, count);
});

test('Four.meme执行失败不能标成成功', async () => {
  const f = fixture(); await f.poll(); f.data.nonce = 151; f.data.proposals = [];
  f.data.detail = { ...proposal(), isExecuted: true, isSuccessful: false, transactionHash: TX };
  await f.poll(); assert.match(f.disk._notificationOutbox.at(-1).payload.title, /执行失败/);
});

test('Four.meme补抓两次轮询间直接执行的提案，索引缺口不跳过且重启去重', async () => {
  const f = fixture(); f.data.proposals = []; await f.poll();
  f.data.nonce = 152;
  const first = { ...proposal(), isExecuted: true, isSuccessful: true, transactionHash: TX };
  const second = { ...first, nonce: 151, safeTxHash: '0x' + 'ef'.repeat(32) };
  f.data.history = [second]; await f.poll();
  assert.deepEqual(f.monitor.summary().executionGap, { from: 150, to: 151 });
  assert.equal(f.disk._notificationOutbox?.length || 0, 0);
  f.data.history = [first, second]; await f.poll();
  assert.equal(f.monitor.summary().executionGap, null);
  assert.equal(f.disk._notificationOutbox[0].payload.fourmemeSafe.changes.length, 2);
  const restarted = fixture(f.disk); restarted.data.nonce = 152; restarted.data.proposals = []; await restarted.poll();
  assert.equal(restarted.disk._notificationOutbox.length, 1);
});

test('Four.meme签名配置在固定块复核并去重；旧owner标签不冒充当前成员', async () => {
  const f = fixture(); await f.poll(); f.advance(60000); f.data.threshold = 2; await f.poll();
  assert.equal(f.disk.fourmemeSafe.identity.threshold, 2);
  assert.equal(f.disk._notificationOutbox.filter(n => /签名配置变更/.test(n.payload.title)).length, 1);
  f.advance(60000); await f.poll();
  assert.equal(f.disk._notificationOutbox.filter(n => /签名配置变更/.test(n.payload.title)).length, 1);
  assert.match(renderFourmemeSafe([{ confirmationOwners: [OWNER] }], {}, { owners: [] }), /成员身份待核验/);
});

test('Safe格式化扩展保留Flap默认标注，Four.meme不继承Flap角色', () => {
  const c = [{ confirmationOwners: ['0x705163cf642a975d2f0570463be93aab7993d1c2'] }];
  assert.match(buildSafeProposalContent(c), /核心权限/);
  assert.doesNotMatch(renderFourmemeSafe(c), /核心权限/);
});

test('Safe写盘失败不推进提案或丢首次通知，恢复后仅提交一次', async () => {
  const f = fixture(); f.fail = true;
  await assert.rejects(f.poll(), /disk full/); assert.equal(f.disk.fourmemeSafe, undefined);
  f.fail = false; await f.poll(); assert.equal(f.disk._notificationOutbox.length, 1);
});

test('Safe挂死轮次强制释放，迟到结果隔离，下一轮恢复通知只一次', { timeout: 2000 }, async () => {
  let release, hang = true;
  const f = fixture({}, { roundTimeoutMs: 25, scan: async options => {
    if (hang) await new Promise(resolve => { release = resolve; });
    options.state.lateMarker = hang;
    return runSafeProposalScan({ ...options, requestIntervalMs: 1 });
  } });
  await assert.rejects(f.poll(), /超过/);
  assert.equal(f.monitor.summary().activeTask, null); assert.equal(f.disk.fourmemeSafe.lateMarker, undefined);
  hang = false; await f.poll(); const saved = structuredClone(f.disk); release(); await settle();
  assert.deepEqual(f.disk, saved);
  assert.equal(f.disk._notificationOutbox.filter(n => /监控异常/.test(n.payload.title)).length, 1);
  assert.equal(f.disk._notificationOutbox.filter(n => /监控恢复/.test(n.payload.title)).length, 1);
});

test('Safe限流保留旧任务和Retry-After，不在下一轮绕过服务端冷却', async () => {
  const f = fixture(); await f.poll(); f.data.status = 429; await f.poll();
  assert(Object.keys(f.disk.fourmemeSafe.proposals).length); const count = f.data.requests.length;
  assert(f.monitor.summary().apiNextAttemptAt > Date.now());
  await f.poll(); assert.equal(f.data.requests.length, count);
});

test('Safe无凭证或关闭不发请求，凭证不进入快照与面板', async () => {
  const missing = fixture({}, { apiKeys: [] }); await assert.rejects(missing.poll(), /未配置/); assert.equal(missing.data.requests.length, 0);
  const off = fixture({}, { enabled: false }); await off.poll(); assert.deepEqual(off.disk, {});
  const f = fixture(); await f.poll(); assert.doesNotMatch(JSON.stringify([f.disk, f.monitor.summary()]), /test-key/);
});

test('Safe身份首次读取无效不建立基线；旧身份复核失败仍可监控提案', async () => {
  const f = fixture(); f.data.threshold = 0; await assert.rejects(f.poll(), /身份读取无效/);
  assert.equal(f.disk.fourmemeSafe.identity, undefined); assert.equal(f.data.requests.length, 0);
  f.data.threshold = 3; await f.poll(); f.data.threshold = 0; f.advance(60000);
  f.data.proposals[0].confirmations.push({ owner: TOKEN }); await f.poll();
  assert.equal(f.disk.fourmemeSafe.identity.threshold, 3); assert.match(f.disk.fourmemeSafe.identityError, /无效/);
  assert.match(f.disk._notificationOutbox.at(-1).payload.title, /签名进度更新/);
});
