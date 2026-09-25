import test from "node:test";
import assert from "node:assert/strict";
import { createWakeableJob, createSubscriptionSet } from "./realtime-scheduler.mjs";

test("wakes during an in-flight run coalesce into one immediate follow-up", async () => {
  let release, calls = 0;
  const timers = new Map(); let id = 0;
  const job = createWakeableJob({ intervalMs: 10000,
    setTimer: (fn, delay) => { timers.set(++id, { fn, delay }); return id; }, clearTimer: key => timers.delete(key),
    run: async () => { calls++; if (calls === 1) await new Promise(resolve => { release = resolve; }); },
  });
  const first = job.wake(); await Promise.resolve();
  job.wake(); job.wake();
  assert.equal(calls, 1);
  release(); await first;
  assert.equal(timers.size, 1);
  const next = [...timers.values()][0]; timers.clear();
  assert.equal(next.delay, 0);
  next.fn(); await job.stop();
  assert.equal(calls, 2);
  assert.equal(timers.size, 0);
});

test("slow external job cannot block independent asset checks", async () => {
  let release, checked = false;
  const slow = createWakeableJob({ intervalMs: 10000, run: () => new Promise(resolve => { release = resolve; }) });
  const assets = createWakeableJob({ intervalMs: 10000, run: async () => { checked = true; } });
  const pending = slow.wake(); await Promise.resolve();
  await assets.wake(); assert.equal(checked, true);
  release(); await pending;
  await Promise.all([slow.stop(), assets.stop()]);
});

test("subscription updates keep unchanged feeds and stop obsolete pool filters", () => {
  const created = [], stopped = [];
  const feeds = createSubscriptionSet(filter => ({ start() { created.push(filter); return this; }, stop() { stopped.push(filter); } }));
  const wallet = { topics: ["wallet"] }, poolA = { address: ["poolA"] }, poolB = { address: ["poolA", "poolB"] };
  feeds.update([wallet, poolA]); feeds.update([wallet, poolA]);
  assert.equal(created.length, 2);
  feeds.update([wallet, poolB]);
  assert.deepEqual(created, [wallet, poolA, poolB]);
  assert.deepEqual(stopped, [poolA]);
  feeds.stop(); assert.equal(stopped.length, 3);
});
