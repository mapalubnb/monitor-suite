// One in-flight run per job. Wakes during a run are coalesced, never discarded.
export function createWakeableJob({ run, intervalMs, onError = () => {}, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let timer = null, running = null, dirty = false, stopped = false;
  const health = { intervalMs, runs: 0, lastStartedAtMs: 0, lastFinishedAtMs: 0, lastError: '' };
  function arm(delay) {
    if (stopped) return;
    if (timer !== null) clearTimer(timer);
    timer = setTimer(() => { timer = null; void wake(); }, delay);
  }
  function wake() {
    if (stopped) return Promise.resolve();
    if (running) { dirty = true; return running; }
    if (timer !== null) { clearTimer(timer); timer = null; }
    const started = Date.now();
    health.lastStartedAtMs = started;
    health.runs++;
    running = Promise.resolve().then(run).then(() => { health.lastError = ''; }).catch(error => {
      health.lastError = error.message;
      onError(error);
    }).finally(() => {
      health.lastFinishedAtMs = Date.now();
      running = null;
      const delay = dirty ? 0 : Math.max(0, intervalMs - (Date.now() - started));
      dirty = false;
      arm(delay);
    });
    return running;
  }
  return { wake, snapshot: () => ({ ...health, running: !!running, stopped }), start: () => { void wake(); }, stop: async () => {
    stopped = true;
    if (timer !== null) clearTimer(timer);
    if (running) await running;
  } };
}

// Keep unchanged subscriptions connected; replace only filters that changed.
export function createSubscriptionSet(createFeed) {
  const feeds = new Map();
  return {
    update(filters) {
      const wanted = new Map(filters.map(filter => [JSON.stringify(filter), filter]));
      for (const [key, filter] of wanted) if (!feeds.has(key)) feeds.set(key, createFeed(filter).start());
      for (const [key, feed] of feeds) if (!wanted.has(key)) { feed.stop(); feeds.delete(key); }
    },
    stop() { for (const feed of feeds.values()) feed.stop(); feeds.clear(); },
  };
}
