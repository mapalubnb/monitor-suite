import test from 'node:test';
import assert from 'node:assert/strict';
import { createStartupNotifier, buildStartupCard } from './startup-notifier.mjs';

function clock() {
  let next = 0;
  const tasks = new Map();
  return {
    tasks,
    setTimer(fn, delay) { const id = ++next; tasks.set(id, { fn, delay }); return id; },
    clearTimer(id) { tasks.delete(id); },
    async fire(delay) {
      const item = [...tasks].find(([, task]) => task.delay === delay);
      assert.ok(item, `missing timer ${delay}`);
      tasks.delete(item[0]); item[1].fn();
      await new Promise(resolve => setImmediate(resolve));
    },
  };
}

test('startup sends before baselines complete and coalesces progress during delivery', async () => {
  const time = clock();
  let resolveSend, checks = { api: 'pending' };
  const sent = [], patched = [];
  const notifier = createStartupNotifier({ ...time,
    render: () => buildStartupCard('Flap', checks),
    send: card => { sent.push(card); return new Promise(resolve => { resolveSend = resolve; }); },
    patch: async (id, card) => patched.push({ id, card }),
  });
  const sending = notifier.refresh();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.length, 1);
  assert.match(sent[0].content, /完成 0\/1/);
  checks = { api: 'complete' };
  void notifier.refresh();
  resolveSend('startup-card');
  await sending;
  await time.fire(0);
  assert.equal(sent.length, 1);
  assert.equal(patched[0].id, 'startup-card');
  assert.match(patched[0].card.content, /完成 1\/1/);
  notifier.stop();
});

test('failed creation retries same request and patches latest status after recovery', async () => {
  const time = clock();
  const checks = { api: 'pending' }, sent = [], patched = [];
  const notifier = createStartupNotifier({ ...time,
    render: () => buildStartupCard('Four.meme', checks),
    send: async (card, opts) => {
      sent.push({ card, id: opts.deliveryId });
      if (sent.length === 1) throw new Error('network unavailable');
      return 'card-id';
    },
    patch: async (_, card) => patched.push(card),
  });
  await notifier.refresh();
  checks.api = 'complete';
  await time.fire(2_000);
  assert.equal(sent[0].id, sent[1].id);
  assert.deepEqual(sent[0].card, sent[1].card);
  await time.fire(0);
  assert.match(patched[0].content, /完成 1\/1/);
  notifier.stop();
});

test('failed card patch retries the existing message without creating another card', async () => {
  const time = clock();
  let sends = 0, patches = 0;
  const checks = { scan: 'pending' };
  const notifier = createStartupNotifier({ ...time,
    render: () => buildStartupCard('Flap', checks),
    send: async () => { sends++; return 'existing'; },
    patch: async id => { assert.equal(id, 'existing'); if (++patches === 1) throw new Error('rate limit'); },
  });
  await notifier.refresh();
  checks.scan = 'failed';
  await notifier.refresh();
  await time.fire(2_000);
  assert.equal(sends, 1);
  assert.equal(patches, 2);
  await notifier.refresh();
  assert.equal(patches, 2);
  notifier.stop();
});

test('stalled startup delivery times out and shutdown cancels retry', async () => {
  const time = clock();
  const errors = [];
  const notifier = createStartupNotifier({ ...time,
    render: () => buildStartupCard('Flap', { scan: 'pending' }),
    send: () => new Promise(() => {}), patch: async () => {},
    onError: error => errors.push(error.message),
  });
  const pending = notifier.refresh();
  await new Promise(resolve => setImmediate(resolve));
  await time.fire(30_000);
  await pending;
  assert.deepEqual(errors, ['启动卡片请求超时']);
  assert.equal(time.tasks.size, 1);
  notifier.stop();
  assert.equal(time.tasks.size, 0);
});

test('startup card distinguishes failures from pending checks and excludes disabled modules', () => {
  const card = buildStartupCard('Flap', { a: 'complete', b: 'failed', c: 'pending', d: 'disabled' });
  assert.equal(card.template, 'orange');
  assert.match(card.content, /完成 2\/3｜异常 1/);
  assert.match(card.content, /后台检查/);
  assert.doesNotMatch(card.content, /全部.*完成/);
});

test('timed out send is reused until its late result arrives instead of sending again', async () => {
  const time = clock();
  let resolveSend, sends = 0;
  const notifier = createStartupNotifier({ ...time,
    render: () => buildStartupCard('Flap', {scan: 'pending'}),
    send: () => { sends++; return new Promise(resolve => { resolveSend = resolve; }); },
    patch: async () => {},
  });
  const first = notifier.refresh();
  await new Promise(resolve => setImmediate(resolve));
  await time.fire(30_000);
  await first;
  await time.fire(2_000);
  assert.equal(sends, 1);
  resolveSend('late-card');
  await new Promise(resolve => setImmediate(resolve));
  await notifier.refresh();
  assert.equal(sends, 1);
  notifier.stop();
});

test('startup window expires permanently and all retries keep actual startup time', async () => {
  const time = clock();
  let now = 0;
  const cards = [], errors = [];
  const notifier = createStartupNotifier({...time, now: () => now, maxAgeMs: 5000,
    render: () => buildStartupCard('Flap', {scan: 'pending'}),
    send: async (card, opts) => { cards.push(card); assert.equal(opts.expiresAt, 5000); throw new Error('offline'); },
    patch: async () => {}, onError: e => errors.push(e.message),
  });
  await notifier.refresh();
  now = 2000;
  await time.fire(2000);
  assert.deepEqual(cards[0], cards[1]);
  assert.match(cards[0].content, /本次进程启动：.*PID/);
  now = 5000;
  await time.fire(3000);
  await notifier.refresh();
  assert.equal(cards.length, 2);
  assert.equal(time.tasks.size, 0);
  assert.match(errors.at(-1), /停止补发/);
});
