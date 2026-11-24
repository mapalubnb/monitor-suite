import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fetchQueueProposals, SAFE_QUEUE_API_BASE_URL } from './safe-queue-api.mjs';
import { selectQueueBatch, finishQueueBatch } from './safe-queue-batch.mjs';
import { createSafeProposalState, runSafeProposalScan } from './safe-proposal-monitor.mjs';
const addr = n => '0x' + n.toString(16).padStart(40, '0');
const hash = n => '0x' + n.toString(16).padStart(64, '0');
const word = n => '0x' + BigInt(n).toString(16).padStart(64, '0');
const safes = Array.from({ length: 11 }, (_, i) => addr(i + 1));
const row = (safe, i) => ({ chainId: '56', safe, safeTxHash: hash(i + 100), nonce: '1', to: addr(99),
  value: '1', operation: 0, data: '0x', safeTxGas: '0', baseGas: '0', gasPrice: '0',
  gasToken: null, refundReceiver: null, txHash: null, failed: null, created: '2026-11-25T01:00:00Z', confirmations: [] });

function fixture(count = 11) {
  const list = safes.slice(0, count), state = createSafeProposalState(list);
  for (const s of list) state.safes[s].baselineEstablished = true;
  const data = { rows: list.map(row), bad: null, status: 200, urls: [], rpc: [], nonceBad: null, thresholdBad: null, now: Date.now() };
  const opts = { state, safes: list, queueApiBaseUrl: SAFE_QUEUE_API_BASE_URL, queueBatchEnabled: true, maxSafesPerRun: 1,
    rpcBatch: async calls => { data.rpc.push(calls); return calls.map(c =>
      c.params[0].data === '0xe75235b8' ? c.params[0].to === data.thresholdBad ? null : word(2)
        : c.params[0].to === data.nonceBad ? null : word(1)); },
    fetchFn: async url => {
      data.urls.push(url);
      const requested = new URL(url).searchParams.getAll('safes').map(x => x.split(':')[0]);
      const status = data.status !== 200 ? data.status : requested.includes(data.bad) ? 422 : 200;
      const results = data.rows.filter(r => requested.includes(r.safe));
      return new Response(JSON.stringify({ count: results.length, results, next: null }), { status });
    } };
  return { state, data, opts, run: () => runSafeProposalScan({ ...opts, nowMs: data.now += 310000 }) };
}

test('11个Safe同轮一次查询，逐笔发现、零确认和重启去重', async () => {
  const f = fixture(); const first = await f.run();
  assert.equal(f.data.urls.length, 1); assert.equal(first.successfulSafes, 11); assert.equal(first.changes.length, 11);
  assert(first.changes.every(p => p.confirmations === 0 && p.required === 2));
  assert.equal(new URL(f.data.urls[0]).searchParams.getAll('safes').length, 11);
  const stamps = Object.values(f.state.proposals).map(p => p.firstSeenAt);
  const restarted = structuredClone(f.state);
  const second = await runSafeProposalScan({ ...f.opts, state: restarted, nowMs: f.data.now + 10000 });
  assert.equal(second.changes.length, 0); assert.deepEqual(Object.values(restarted.proposals).map(p => p.firstSeenAt), stamps);
  assert.equal(f.state.queueBatch.lastScan.pageRequests, 1); assert.equal(f.state.queueBatch.groups.length, 1);
});

test('批量分页保留全部Safe参数，混合返回按地址分离；空列表仍是全部成功', async () => {
  let calls = 0;
  const list = safes.slice(0, 2), rows = list.map(row);
  const result = await fetchQueueProposals({ safes: list, readJson: async url => {
    const parsed = new URL(url); assert.deepEqual(parsed.searchParams.getAll('safes'), list.map(s => s + ':56'));
    calls++;
    return calls === 1 ? { count: 2, results: [rows[1]], next: url.replace('offset=0', 'offset=1') }
      : { count: 2, results: [rows[0]], next: null };
  } });
  assert.equal(calls, 2); assert.equal(result.length, 2);
  const f = fixture(); f.data.rows = []; const r = await f.run();
  assert.equal(r.successfulSafes, 11); assert.equal(r.changes.length, 0);
  assert(!f.data.rpc.flat().some(c => c.params[0].data === '0xe75235b8'));
});

test('一次422仅拆分状态，下轮原节奏定位坏Safe；健康组重聚，坏Safe恢复后回归整批', async () => {
  const f = fixture(); f.data.bad = safes[5];
  const first = await f.run(); assert.equal(f.data.urls.length, 1); assert.equal(first.successfulSafes, 0);
  assert.equal(f.state.queueBatch.groups.length, 2);
  const initial = structuredClone(f.state); Object.assign(f.state, JSON.parse(JSON.stringify(initial)));
  for (let i = 0; i < 22; i++) {
    const before = f.data.urls.length; await f.run(); assert.equal(f.data.urls.length - before, 1);
  }
  const groups = f.state.queueBatch.groups;
  assert(groups.some(g => g.validated && g.safes.length === 10));
  assert(groups.some(g => !g.validated && g.safes.length === 1 && g.safes[0] === f.data.bad));
  for (const s of safes.filter(s => s !== f.data.bad)) assert(f.state.safes[s].lastSuccessAt);
  assert.equal(f.state.safes[f.data.bad].lastSuccessAt, '');
  f.data.bad = null;
  for (let i = 0; i < 3; i++) await f.run();
  assert.equal(f.state.queueBatch.groups.length, 1); assert.equal(f.state.queueBatch.groups[0].safes.length, 11);
  assert.equal(f.state.lastError, '');
});

test('429、503及分页错误不拆成请求风暴，不推进基线或覆盖提案', async () => {
  const f = fixture(); await f.run(); const original = structuredClone(f.state.proposals);
  for (const status of [429, 503]) {
    f.data.status = status; const before = f.data.urls.length; const r = await f.run();
    assert.equal(f.data.urls.length - before, 1); assert.equal(r.successfulSafes, 0);
    assert.equal(f.state.queueBatch.groups.length, 1); assert.deepEqual(f.state.proposals, original);
  }
  const r = await runSafeProposalScan({ ...f.opts, nowMs: f.data.now + 310000,
    fetchFn: async () => new Response(JSON.stringify({ count: 2, results: [f.data.rows[0]], next: null })) });
  assert.equal(r.successfulSafes, 0); assert.deepEqual(f.state.proposals, original);
  assert.match(f.state.lastError, /分页未完成/);
});

test('nonce故障Safe不混入批量，其他地址继续；门槛每批最多2项且逐Safe隔离', async () => {
  const f = fixture(); f.data.nonceBad = safes[0]; f.data.thresholdBad = safes[1];
  const r = await f.run(); assert.equal(r.successfulSafes, 9);
  assert.equal(new URL(f.data.urls[0]).searchParams.getAll('safes').length, 10);
  const thresholdCalls = f.data.rpc.filter(c => c[0].params[0].data === '0xe75235b8');
  assert(thresholdCalls.every(c => c.length <= 2)); assert.equal(thresholdCalls.flat().length, 10);
  assert.equal(f.state.safes[safes[0]].lastSuccessAt, ''); assert.equal(f.state.safes[safes[1]].lastSuccessAt, '');
  assert.match(f.state.safes[safes[0]].lastNonceError, /nonce/);
});

test('单个Safe结构错误不覆盖其旧提案，其余Safe正常刷新', async () => {
  const f = fixture(); await f.run(); const prior = structuredClone(f.state.proposals[hash(100) + ':']);
  f.data.rows[0].created = 'bad date'; const r = await f.run();
  assert.equal(r.successfulSafes, 10); assert.deepEqual(f.state.proposals[hash(100) + ':'], prior);
});

test('批次重启保留隔离，配置增删与暂时冷却不遗漏或重复地址', () => {
  const state = {}; let choice = selectQueueBatch(state, safes, safes); finishQueueBatch(state, choice, { status: 422 });
  const restored = JSON.parse(JSON.stringify(state));
  choice = selectQueueBatch(restored, safes, safes.slice(5)); assert(choice.safes.every(s => safes.slice(5).includes(s)));
  finishQueueBatch(restored, choice);
  const configured = [...safes.slice(1), addr(50)]; selectQueueBatch(restored, configured, []);
  assert.deepEqual(restored.queueBatch.groups.flatMap(g => g.safes).sort(), [...configured].sort());
  assert.equal(selectQueueBatch(restored, configured, []), null);
});

test('超过100个Safe分组轮转，分页上限拆分不再合并造成死循环', () => {
  const list = Array.from({ length: 101 }, (_, i) => addr(i + 1)), state = {};
  let choice = selectQueueBatch(state, list, list); assert.equal(choice.safes.length, 100); finishQueueBatch(state, choice);
  choice = selectQueueBatch(state, list, list); assert.equal(choice.safes.length, 1); finishQueueBatch(state, choice);
  const other = {}; choice = selectQueueBatch(other, safes, safes); finishQueueBatch(other, choice, { code: 'QUEUE_PAGE_LIMIT' });
  for (let i = 0; i < 4; i++) { choice = selectQueueBatch(other, safes, safes); finishQueueBatch(other, choice); }
  assert.equal(other.queueBatch.groups.length, 2); assert(other.queueBatch.groups.every(g => g.separate));
});

test('批量能力不放宽链和地址校验，不影响Four.meme单Safe入口', async () => {
  await assert.rejects(fetchQueueProposals({ safes: [safes[0], safes[0]] }), /重复/);
  await assert.rejects(fetchQueueProposals({ safes: Array.from({ length: 101 }, (_, i) => addr(i + 1)) }), /100/);
  await assert.rejects(fetchQueueProposals({ safes: safes.slice(0, 2), readJson: async () => ({ count: 1, results: [row(addr(50), 1)], next: null }) }), /身份/);
  const flap = readFileSync(new URL('./monitor.mjs', import.meta.url), 'utf8');
  assert.equal(flap.match(/queueBatchEnabled: true/g)?.length, 2);
  const four = readFileSync(new URL('../fourmeme-monitor/safe-monitor.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(four, /queueBatchEnabled: true/); assert.match(four, /maxSafesPerRun: 1/);
});

test('分页达到原10页上限不发布部分结果，下一轮拆分查询而非立即重试', async () => {
  const f = fixture(); let requests = 0;
  const result = await runSafeProposalScan({ ...f.opts, fetchFn: async url => {
    requests++; const parsed = new URL(url), offset = Number(parsed.searchParams.get('offset'));
    parsed.searchParams.set('offset', String(offset + 1));
    return new Response(JSON.stringify({ count: 11, results: [f.data.rows[offset]], next: offset < 10 ? parsed.href : null }));
  } });
  assert.equal(requests, 10); assert.equal(result.successfulSafes, 0); assert.equal(result.changes.length, 0);
  assert.equal(Object.keys(f.state.proposals).length, 0); assert.equal(f.state.queueBatch.groups.length, 2);
  assert(f.state.queueBatch.groups.every(g => g.separate));
});
