import test from 'node:test';
import assert from 'node:assert/strict';
import { createTransactionalOutbox } from './transactional-outbox.mjs';

test('outbox persists a frozen card plan before sending and restores it after restart', async () => {
  let disk = {};
  const plan = [{title:'提醒 (1/2)',content:'第一片'},{title:'提醒 (2/2)',content:'第二片'}];
  const persist = value => { disk = structuredClone(value); };
  const first = createTransactionalOutbox({persist,deliver:async (_payload,opts)=>{
    await opts.onPlan(plan);
    assert.deepEqual(disk._notificationOutbox[0].cardParts,plan);
    await opts.onPartSent(['sent-1']);
    throw Error('offline');
  }});
  await first.enqueue({title:'提醒'});
  await first.drain();
  const restored=createTransactionalOutbox({initial:disk,persist,deliver:async (_payload,opts)=>{
    assert.deepEqual(opts.cardParts,plan);
    assert.deepEqual(opts.sentParts,['sent-1']);
    return 'sent-1';
  }});
  await restored.drain(Infinity);
  assert.equal(disk._notificationOutbox.length,0);
});

test('completed transaction releases inherited async scope and delayed work sees current state', async () => {
  const store = createTransactionalOutbox({initial: {large: {payload: 'x'.repeat(1_000_000)}, cursor: 1}, persist: () => {}});
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let delayed;
  await store.transaction(async () => {
    void store.state.large;
    delayed = gate.then(async () => {
      assert.equal(store.inTransaction(), false);
      assert.equal(store.state.cursor, 2);
      await store.transaction(() => { store.state.cursor = 3; });
    });
  });
  await store.transaction(() => { store.state.cursor = 2; });
  release();
  await delayed;
  assert.equal(store.state.cursor, 3);
});

test('snapshot and alerts commit together, failed scans roll back both', async () => {
  let disk = { cursor: 1 };
  const store = createTransactionalOutbox({ initial: disk, persist: value => { disk = structuredClone(value); }, deliver: async () => 'message' });
  await assert.rejects(store.transaction(async () => {
    store.state.cursor = 2;
    await store.enqueue({ title: 'change' });
    throw new Error('missing block');
  }), /missing block/);
  assert.deepEqual(disk, { cursor: 1 });
  await store.transaction(async () => { store.state.cursor = 2; await store.enqueue({ title: 'change' }); });
  assert.equal(disk.cursor, 2);
  assert.equal(disk._notificationOutbox.length, 1);
  await store.drain();
  assert.equal(disk._notificationOutbox.length, 0);
});

test('failed disk commit retains old cursor and can be retried', async () => {
  let fail = true;
  const store = createTransactionalOutbox({ initial: { cursor: 1 }, persist: () => { if (fail) throw new Error('disk full'); } });
  await assert.rejects(store.transaction(() => { store.state.cursor = 2; }), /disk full/);
  assert.equal(store.state.cursor, 1);
  fail = false;
  await store.transaction(() => { store.state.cursor = 2; });
  assert.equal(store.state.cursor, 2);
});

test('parallel modules merge unrelated fields without publishing unfinished changes', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const store = createTransactionalOutbox({ initial: { pool: { n: 1 }, api: 1 }, persist: () => {} });
  const first = store.transaction(async () => { store.state.pool.n = 2; await gate; });
  assert.equal(store.state.pool.n, 1);
  await store.transaction(() => { store.state.api = 2; });
  release(); await first;
  assert.equal(store.state.pool.n, 2);
  assert.equal(store.state.api, 2);
});

test('same-field write conflict retries instead of overwriting newer state', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const store = createTransactionalOutbox({ initial: { cursor: 1 }, persist: () => {} });
  const first = store.transaction(async () => { store.state.cursor = 2; await gate; });
  await store.transaction(() => { store.state.cursor = 3; });
  release(); await assert.rejects(first, /并发快照字段冲突/);
  assert.equal(store.state.cursor, 3);
});

test('restart resumes partial delivery and a failed alert does not starve others', async () => {
  let disk = {};
  const persist = value => { disk = structuredClone(value); };
  const store = createTransactionalOutbox({ persist, deliver: async (payload, opts) => {
    if (payload.title === 'first') { await opts.onPartSent(['part1']); throw new Error('offline'); }
    return 'second';
  } });
  await store.enqueue({ title: 'first' });
  await store.enqueue({ title: 'second' });
  await store.drain();
  assert.equal(disk._notificationOutbox.length, 1);
  assert.deepEqual(disk._notificationOutbox[0].parts, ['part1']);
  const id = disk._notificationOutbox[0].id;
  const restarted = createTransactionalOutbox({ initial: disk, persist, deliver: async (_, opts) => {
    assert.equal(opts.deliveryId, id);
    assert.deepEqual(opts.sentParts, ['part1']);
    return 'part1';
  } });
  await restarted.drain(Date.now() + 400_000);
  assert.equal(disk._notificationOutbox.length, 0);
});

test('pool removal pending confirmation survives restart', async () => {
  let disk;
  const store = createTransactionalOutbox({ initial: { pool: ['a'] }, persist: value => { disk = structuredClone(value); } });
  await store.transaction(() => { store.state.pool = []; store.state._pendingPoolRemovals = { a: { expireAt: 123, data: { symbol: 'A' } } }; });
  const restarted = createTransactionalOutbox({ initial: disk, persist: () => {} });
  assert.equal(restarted.state._pendingPoolRemovals.a.expireAt, 123);
});

test('two modules detecting the same change cannot enqueue duplicate alerts', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let disk;
  const store = createTransactionalOutbox({ initial: { implementation: 'old' }, persist: value => { disk = structuredClone(value); } });
  const first = store.transaction(async () => { store.state.implementation = 'new'; await store.enqueue({ title: 'upgrade' }); await gate; });
  await store.transaction(async () => { store.state.implementation = 'new'; await store.enqueue({ title: 'upgrade' }); });
  release();
  await assert.rejects(first, /并发快照字段冲突/);
  assert.equal(disk._notificationOutbox.length, 1);
});
