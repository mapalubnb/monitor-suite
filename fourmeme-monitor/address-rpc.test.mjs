import test from 'node:test';
import assert from 'node:assert/strict';
import { createAddressRoundRpc } from './address-rpc.mjs';
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
