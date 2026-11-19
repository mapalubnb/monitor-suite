import test from 'node:test';
import assert from 'node:assert/strict';
import { createAddressRoundRpc } from './address-rpc.mjs';
import { createRpcControl } from '../shared/rpc-control.mjs';
// This file is also runnable on its own, outside monitor.test's test-mode setup.
process.env.FOURMEME_MONITOR_TEST = '1';
test('同轮头块/日志/回执固定节点，下一轮独立选择且请求分批', async () => {
  const sources = [], shared = ['fast', 'slow'];
  const request = async (payload, timeout, options) => {
    const url = options.pool[0]; sources.push(url);
    return options.parseResponse({ json: async () => payload.map(p => ({ id: p.id, result: p.method === 'eth_blockNumber' ? '0x123' : [] })) }, url);
  };
  const read = createAddressRoundRpc({ pool: shared, makePool: x => x, request, batchSize: 2 });
  await read([{ method: 'eth_blockNumber' }]); shared.reverse();
  await read(Array.from({ length: 3 }, () => ({ method: 'eth_getLogs' })));
  assert.deepEqual(sources, ['fast', 'fast', 'fast']);
  await createAddressRoundRpc({ pool: shared, makePool: x => x, request })([{ method: 'eth_blockNumber' }]);
  assert.equal(sources.at(-1), 'slow');
});
test('头块暂不可用有限重试原参数，不降为前一块、不吞真实故障', async () => {
  let attempts = 0; const waits = [], params = [];
  const read = createAddressRoundRpc({ pool: [], makePool: x => x, delay: async ms => waits.push(ms), request: async (payload, _, options) => {
    params.push(payload[0].params); attempts++;
    return options.parseResponse({ json: async () => [{ id: 1, result: attempts < 3 ? null : { hash: 'head' } }] }, 'node');
  } });
  assert.deepEqual(await read([{ method: 'eth_getBlockByNumber', params: ['0x123', true] }]), [{ hash: 'head' }]);
  assert.deepEqual(waits, [120, 240]); assert.ok(params.every(p => p[0] === '0x123'));
  let errors = 0; await assert.rejects(createAddressRoundRpc({ request: async () => { errors++; throw Error('HTTP 429'); } })([{}]), /429/); assert.equal(errors, 1);
});
test('持久缺块只尝试三次，已取消轮次不继续读取', async () => {
  let n = 0; const c = new AbortController();
  const read = createAddressRoundRpc({ signal: c.signal, pool: [], makePool: x => x, delay: async () => {}, request: async () => { n++; throw Error('block range extends beyond current head block'); } });
  await assert.rejects(read([{}]), /beyond/); assert.equal(n, 3);
  c.abort(Error('cancelled')); await assert.rejects(read([{}]), /cancelled/); assert.equal(n, 3);
});

test('HTTP空429保留状态与重试时间；非数组RPC限流也正确分类', async () => {
  const rpc = response => createAddressRoundRpc({ request: (p, t, o) => o.parseResponse(response, 'https://rpc.test/private-key') });
  await assert.rejects(rpc(new Response('', { status: 429, headers: { 'Retry-After': '45' } }))([{}]), e =>
    e.status === 429 && e.retryAfterMs === 45000 && e.addressFailureKind === 'rate_limit' && e.provider === 'rpc.test' && !e.message.includes('private-key'));
  await assert.rejects(rpc(new Response(JSON.stringify({ error: { message: 'rate limit' } })))([{}]), e => e.addressFailureKind === 'rate_limit');
  await assert.rejects(rpc(new Response('', { status: 403 }))([{}]), e => e.status === 403 && /403/.test(e.message));
});

test('真实RPC路由：头块健康但日志冷却时选备用，全轮固定；新冷却仅下轮换节点', async () => {
  const { __testables: t } = await import('./monitor.mjs');
  let at = Date.now(); const control = createRpcControl({ now: () => at }), calls = [];
  const a = 'https://a.test', b = 'https://b.test';
  const makePool = urls => t.createRpcEndpointPool(urls, { isBackedOff: () => false });
  const pool = makePool([a, b]);
  const request = (payload, ms, opts) => t.requestBscRpcPayload(payload, ms, { ...opts, control, inflight: new Map(),
    fetchFn: async url => { calls.push({ url, method: payload[0].method }); return new Response(JSON.stringify(payload.map(p => ({ id: p.id, result: p.method === 'eth_blockNumber' ? '0x123' : [] })))); } });
  control.failure(a, Error('HTTP 429'), undefined, { payload: [{ method: 'eth_getLogs' }] });
  const round = () => createAddressRoundRpc({ pool, makePool, request, control });
  const read = round(); await read([{ method: 'eth_blockNumber' }]); await read([{ method: 'eth_getLogs' }]);
  assert.deepEqual(calls.map(c => c.url), [b, b]);
  control.failure(b, Error('HTTP 429'), undefined, { payload: [{ method: 'eth_getTransactionReceipt' }] });
  await assert.rejects(read([{ method: 'eth_getTransactionReceipt' }]), e => e.addressFailureKind === 'cooldown' && /本轮固定RPC/.test(e.message));
  const before = calls.length;
  await assert.rejects(round()([{ method: 'eth_blockNumber' }]), /完整扫描条件/);
  assert.equal(calls.length, before);
  at += 30001; await round()([{ method: 'eth_blockNumber' }]);
  assert.equal(calls.at(-1).url, a);
});

test('完整扫描预选检查单独区块、组合头块和回执作用域；参考整轮预算压力', async () => {
  const { __testables: t } = await import('./monitor.mjs');
  const a = 'https://a.test', b = 'https://b.test';
  for (const methods of [['eth_getBlockByNumber'], ['eth_blockNumber','eth_getBlockByNumber'], ['eth_getTransactionReceipt']]) {
    const control = createRpcControl(); control.failure(a, Error('HTTP 429'), undefined, { payload: methods.map(method => ({ method })) });
    const { addressRoundPool } = await import('./address-rpc.mjs');
    const pool = addressRoundPool(t.createRpcEndpointPool([a, b], { isBackedOff: () => false }), control);
    assert.equal(pool.acquire(new Set()).endpoint.url, b);
  }
  const { addressRoundPool } = await import('./address-rpc.mjs');
  const pool = addressRoundPool(t.createRpcEndpointPool([a, b], { isBackedOff: () => false }), {
    cooldown: () => null, pressure: (url, r) => url === a && r.payload.some(p => p.method === 'eth_getLogs') ? 3 : 0,
  });
  assert.equal(pool.acquire(new Set()).endpoint.url, b);
});

test('空429经真实传输层保留Retry-After冷却和限流指标，下一轮不重复请求', async () => {
  const { __testables: t } = await import('./monitor.mjs');
  const control = createRpcControl(), url = 'https://limited.test'; let sent = 0;
  const makePool = urls => t.createRpcEndpointPool(urls, { isBackedOff: () => false });
  const request = (p, ms, opts) => t.requestBscRpcPayload(p, ms, { ...opts, control, inflight: new Map(), fetchFn: async () => {
    sent++; return new Response('', { status: 429, headers: { 'Retry-After': '90' } });
  } });
  const round = () => createAddressRoundRpc({ pool: makePool([url]), makePool, request, control });
  await assert.rejects(round()([{ method: 'eth_getLogs' }]), /HTTP 429/);
  assert.equal(control.summary().upstream429, 1);
  assert.ok(control.cooldown(url, { payload: [{ method: 'eth_getLogs' }] }).until > Date.now() + 89000);
  await assert.rejects(round()([{ method: 'eth_blockNumber' }]), /完整扫描条件/);
  assert.equal(sent, 1);
});
