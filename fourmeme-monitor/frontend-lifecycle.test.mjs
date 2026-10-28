import test from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendGuard, assertFrontendActive, frontendStage, frontendRequest } from './frontend-lifecycle.mjs';
import { createTransactionalOutbox } from '../shared/transactional-outbox.mjs';

test('独立健康检查终止永久等待，告警去重，正常下一轮后恢复一次', async () => {
  let now = 1;
  const notices = [], guard = createFrontendGuard({ timeoutMs: 10000, now: () => now, notify: x => notices.push(x.type) });
  for (let i = 0; i < 2; i++) {
    const run = guard.run(async () => { frontendStage('seed'); frontendRequest('https://four.meme/en?secret=hidden')('body'); return new Promise(() => {}); });
    await Promise.resolve(); await Promise.resolve();
    now += 10001; guard.check();
    await assert.rejects(run, /截止时间/);
    assert.equal(guard.snapshot().running, false);
    assert(!JSON.stringify(guard.snapshot()).includes('hidden'));
  }
  assert.deepEqual(notices, ['stalled']);
  await guard.run(async () => 7); await guard.run(async () => 8);
  assert.deepEqual(notices, ['stalled', 'recovered']);
  assert.equal(guard.snapshot().lastSuccessAt, now);
});

test('取消轮次回滚快照与通知，迟到操作不能影响新一轮或其他模块', async () => {
  let release, finished;
  const gate = new Promise(r => { release = r; }), lateDone = new Promise(r => { finished = r; });
  const store = createTransactionalOutbox({ initial: { page: { version: 1 }, pool: 1 }, persist: () => {} });
  const guard = createFrontendGuard({ timeoutMs: 20 });
  const run = guard.run(signal => store.transaction(async () => {
    const ref = store.state.page; ref.version = 2;
    await store.enqueue({ title: 'must rollback' });
    await gate;
    ref.version = 99;
    try {
      assert.throws(assertFrontendActive, /截止时间/);
      assert.throws(() => { store.state.page = { version: 99 }; }, /截止时间/);
      await assert.rejects(store.enqueue({ title: 'late' }), /截止时间/);
      assert.throws(() => store.flush(), /截止时间/);
    } finally { finished(); }
  }, { signal }));
  await store.transaction(() => { store.state.pool = 2; });
  await assert.rejects(run, /截止时间/);
  assert.equal(store.state.page.version, 1);
  assert.equal(store.state._notificationOutbox, undefined);
  await guard.run(signal => store.transaction(() => { store.state.page.version = 3; }, { signal }));
  release(); await lateDone;
  assert.equal(store.state.page.version, 3); assert.equal(store.state.pool, 2);
});

test('已完成轮次保留的嵌套对象也不能写入已发布快照', async () => {
  let ref;
  const store = createTransactionalOutbox({ initial: { page: { n: 1 } }, persist: () => {} });
  const signal = new AbortController().signal;
  await store.transaction(() => { ref = store.state.page; ref.n = 2; }, { signal });
  ref.n = 9;
  assert.equal(store.state.page.n, 2);
});
