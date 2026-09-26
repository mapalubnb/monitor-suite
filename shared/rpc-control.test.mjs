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
