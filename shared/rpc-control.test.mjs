import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRpcControl, rpcCacheTtl } from './rpc-control.mjs';

test('coalesces concurrent reads without retaining mutable block results', async () => {
  const rpc = createRpcControl(); let calls = 0;
  const read = () => rpc.coalesce('block', async () => { calls++; await new Promise(r => setTimeout(r, 5)); return { hash: calls }; });
  const [first, second] = await Promise.all([read(), read()]);
  assert.equal(calls, 1); first.hash = 'changed'; assert.equal(second.hash, 1);
  assert.equal((await read()).hash, 2);
  assert.equal(rpcCacheTtl({ method: 'eth_getBlockByNumber' }), 0);
  assert.equal(rpcCacheTtl({ method: 'eth_getTransactionReceipt' }), 0);
});

test('Retry-After crosses monitor instances, archive errors do not block live queries', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rpc-control-')); let time = 10000;
  try {
    const first = createRpcControl({ directory, now: () => time }), second = createRpcControl({ directory, now: () => time });
    first.failure('https://node.test', new Error('header not found'));
    assert.equal(second.cooldown('https://node.test'), null);
    first.failure('https://node.test', new Error('HTTP 429'), { status: 429, headers: new Headers({ 'retry-after': '120' }) });
    time += 1001;
    await assert.rejects(second.withEndpoint('https://node.test', () => assert.fail('must not request')), /限流/);
    time += 120000;
    assert.equal(await second.withEndpoint('https://node.test', () => 42), 42);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('per-provider concurrency stays bounded and a cancelled waiter releases its queue entry', async () => {
  const rpc = createRpcControl({ concurrency: 1 }); let release;
  const first = rpc.withEndpoint('https://node.test', () => new Promise(r => { release = r; }));
  const controller = new AbortController();
  const cancelled = rpc.withEndpoint('https://node.test', () => assert.fail('cancelled request started'), controller.signal);
  controller.abort(); await assert.rejects(cancelled);
  const next = rpc.withEndpoint('https://node.test', () => 'next');
  release('first'); assert.equal(await first, 'first'); assert.equal(await next, 'next');
  assert.equal(rpc.summary().queued, 0);
});

test('method-scoped 403 and 429 do not cool working reads or recent logs', () => {
  const rpc = createRpcControl(); const url = 'https://node.test';
  const history = { payload: { method: 'eth_getLogs' }, history: true };
  rpc.failure(url, new Error('HTTP 403'), { status: 403 }, history);
  assert.ok(rpc.cooldown(url, history));
  assert.equal(rpc.cooldown(url, { payload: { method: 'eth_getLogs' }, history: false }), null);
  assert.equal(rpc.cooldown(url, { payload: { method: 'eth_blockNumber' } }), null);
  rpc.failure(url, new Error('HTTP 429'), { status: 429 }, { payload: { method: 'eth_getLogs' } });
  assert.equal(rpc.cooldown(url, { payload: { method: 'eth_call' } }), null);
  rpc.failure(url, new Error('invalid api key'), { status: 401 }, history);
  assert.ok(rpc.cooldown(url, { payload: { method: 'eth_call' } }));
});

test('critical work overtakes queued history and speculative work never queues', async () => {
  const rpc=createRpcControl({concurrency:1}); const order=[]; let release;
  const first=rpc.withEndpoint('https://node.test',()=>new Promise(r=>{release=r;}));
  const history=rpc.withEndpoint('https://node.test',()=>order.push('history'),undefined,{history:true});
  const critical=rpc.withEndpoint('https://node.test',()=>order.push('critical'),undefined,{critical:true});
  await assert.rejects(rpc.withEndpoint('https://node.test',()=>assert.fail(),undefined,{speculative:true}), e=>e.rpcBudget);
  release(); await Promise.all([first,history,critical]);
  assert.deepEqual(order,['critical','history']); assert.equal(rpc.summary().queued,0);
});

test('one waiting history request cannot occupy both local slots',async()=>{
  const rpc=createRpcControl({concurrency:2});let release;
  const first=rpc.withEndpoint('https://node.test',()=>new Promise(r=>{release=r;}),undefined,{history:true});
  const second=rpc.withEndpoint('https://node.test',()=>2,undefined,{history:true});
  assert.equal(await rpc.withEndpoint('https://node.test',()=>3),3);
  release();await first;assert.equal(await second,2);
});

test('expired queue deadline does not hide a later upstream timeout',async()=>{
 const rpc=createRpcControl(),queue=new AbortController();
 await assert.rejects(rpc.withEndpoint('https://node.test',async()=>{queue.abort();throw new DOMException('timeout','TimeoutError');},queue.signal,{payload:{method:'eth_getLogs'}}));
 assert.equal(rpc.summary().timeouts,1);
});
