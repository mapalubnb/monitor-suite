import { randomUUID } from 'node:crypto';

// Startup delivery is independent of scans. Retries reuse the same request id;
// later progress patches the existing card instead of creating another one.
export function createStartupNotifier({ render, send, patch, onError = () => {},
  setTimer = setTimeout, clearTimer = clearTimeout, timeoutMs = 30_000,
  now = Date.now, maxAgeMs = 5 * 60_000 }) {
  const startedAt = now();
  const expiresAt = startedAt + maxAgeMs;
  const startupTime = new Date(startedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  const deliveryId = randomUUID();
  const sentParts = [];
  let initialCard = null;
  let messageId = '', delivered = '', timer = null, running = null;
  let dirty = false, stopped = false, failures = 0;
  let sendFlight = null, patchFlight = null;
  function expired() {
    if (now() < expiresAt) return false;
    if (!stopped) onError(new Error('启动通知窗口已结束，停止补发和更新'));
    stopped = true;
    if (timer !== null) clearTimer(timer);
    timer = null;
    return true;
  }
  function arm(delay) {
    if (stopped || expired()) return;
    if (timer !== null) clearTimer(timer);
    timer = setTimer(() => { timer = null; void refresh(); }, Math.min(delay, expiresAt - now()));
  }
  async function bounded(operation) {
    let deadline;
    try {
      return await Promise.race([
        Promise.resolve().then(operation),
        new Promise((_, reject) => { deadline = setTimer(() => reject(new Error('启动卡片请求超时')), timeoutMs); }),
      ]);
    } finally { if (deadline !== undefined) clearTimer(deadline); }
  }
  function refresh() {
    if (stopped || expired()) return Promise.resolve();
    if (running) { dirty = true; return running; }
    if (timer !== null) { clearTimer(timer); timer = null; }
    dirty = false;
    running = Promise.resolve().then(async () => {
      const rendered = render();
      const card = { ...rendered, content: `${rendered.content}\n本次进程启动：${startupTime}｜PID ${process.pid}` };
      const fingerprint = JSON.stringify(card);
      if (fingerprint === delivered) { failures = 0; return; }
      if (!messageId) {
        initialCard ||= card;
        // 超时仅结束等待，底层请求可能仍在执行；继续等待同一请求，禁止并发补发。
        if (!sendFlight) sendFlight = Promise.resolve().then(() => send(initialCard, { deliveryId, sentParts, expiresAt }))
          .then(id => {
            if (!id) throw new Error('启动卡片未返回 message_id');
            messageId = id;
            delivered = JSON.stringify(initialCard);
            return id;
          }).catch(error => { sendFlight = null; throw error; });
        messageId = await bounded(() => sendFlight);
        if (!messageId) throw new Error('启动卡片未返回 message_id');
        delivered = JSON.stringify(initialCard);
        if (delivered !== fingerprint) dirty = true;
      } else {
        if (patchFlight) await bounded(() => patchFlight);
        if (stopped || expired()) return;
        patchFlight = Promise.resolve().then(() => patch(messageId, card)).finally(() => { patchFlight = null; });
        await bounded(() => patchFlight);
        delivered = fingerprint;
      }
      failures = 0;
    }).catch(error => {
      failures++;
      onError(error);
    }).finally(() => {
      running = null;
      if (failures) arm(Math.min(60_000, 2_000 * 2 ** Math.min(failures - 1, 5)));
      else if (dirty) arm(0);
    });
    return running;
  }
  return { refresh, stop() { stopped = true; if (timer !== null) clearTimer(timer); timer = null; } };
}

export function buildStartupCard(platform, checks, counts = []) {
  const states = Object.values(checks).filter(value => value !== 'disabled');
  const failed = states.filter(value => value === 'failed').length;
  const pending = states.filter(value => value === 'pending').length;
  return {
    title: `${platform} 监控已启动`,
    template: failed ? 'orange' : pending ? 'blue' : 'green',
    content: [
      '**🟢 进程已启动**',
      `首轮检查：完成 ${states.length - pending}/${states.length}｜异常 ${failed}`,
      ...(pending ? ['其余基线正在后台检查，结果稍后更新。'] : []),
      ...counts,
      `详情：\`${platform === 'Four.meme' ? 'fm-status' : 'fl-status'}\``,
    ].join('\n'),
  };
}
