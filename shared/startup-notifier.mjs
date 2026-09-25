import { randomUUID } from 'node:crypto';

// Startup delivery is independent of scans. Retries reuse the same request id;
// later progress patches the existing card instead of creating another one.
export function createStartupNotifier({ render, send, patch, onError = () => {},
  setTimer = setTimeout, clearTimer = clearTimeout, timeoutMs = 30_000 }) {
  const deliveryId = randomUUID();
  const sentParts = [];
  let initialCard = null;
  let messageId = '', delivered = '', timer = null, running = null;
  let dirty = false, stopped = false, failures = 0;
  function arm(delay) {
    if (stopped) return;
    if (timer !== null) clearTimer(timer);
    timer = setTimer(() => { timer = null; void refresh(); }, delay);
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
    if (stopped) return Promise.resolve();
    if (running) { dirty = true; return running; }
    if (timer !== null) { clearTimer(timer); timer = null; }
    dirty = false;
    running = Promise.resolve().then(async () => {
      const card = render();
      const fingerprint = JSON.stringify(card);
      if (fingerprint === delivered) { failures = 0; return; }
      if (!messageId) {
        initialCard ||= card;
        messageId = await bounded(() => send(initialCard, { deliveryId, sentParts }));
        if (!messageId) throw new Error('启动卡片未返回 message_id');
        delivered = JSON.stringify(initialCard);
        if (delivered !== fingerprint) dirty = true;
      } else {
        await bounded(() => patch(messageId, card));
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
