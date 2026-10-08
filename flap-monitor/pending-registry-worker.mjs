import { parentPort, workerData } from 'node:worker_threads';
import WebSocket from 'ws';
import { decodePendingRegistration } from './pending-registry.mjs';

// Keep the full-chain stream off the monitor's event loop. Use one connection,
// fail over between configured endpoints, and never fetch hash-only payloads.
const urls = workerData.urls.filter(url => /^wss:\/\//.test(url));
const health = { status: 'connecting', messages: 0, matches: 0, hashesIgnored: 0, reconnects: 0, dropped: 0 };
const seen = new Map(), tracked = new Map();
for (const r of workerData.tracked || []) {
  if (tracked.size >= 256) break;
  tracked.set(`${r.from}:${r.nonce}`, { hash: r.txHash, at: Date.now() });
}
let socket, endpoint = 0, lastMessage = Date.now(), retry, started = Date.now(), windowStart = 0, forwarded = 0, outstanding = 0;
parentPort.on('message', message => { if (message.type === 'ack') outstanding = Math.max(0, outstanding - 1); });
function forward(message) {
  if (forwarded++ >= 10 || outstanding >= 16) {
    health.dropped++;
    health.recentDrops ||= [];
    health.recentDrops.push({ txHash: message.candidates?.[0]?.txHash || message.tx?.hash,
      workerSeenAt: message.candidates?.[0]?.workerSeenAt || new Date().toISOString(), source: health.endpoint,
      reason: outstanding >= 16 ? 'ipc-backpressure' : 'forward-rate-limit' });
    health.recentDrops = health.recentDrops.slice(-32);
    return false;
  }
  outstanding++; parentPort.postMessage(message); return true;
}
const publish = () => parentPort.postMessage({ type: 'health', health: { ...health, updatedAt: new Date().toISOString() } });
function connect() {
  if (!urls.length) { health.status = 'disabled'; publish(); return; }
  health.status = 'connecting'; health.endpoint = new URL(urls[endpoint % urls.length]).hostname; publish();
  const ws = socket = new WebSocket(urls[endpoint++ % urls.length], { handshakeTimeout: 10000, maxPayload: 262144 });
  started = lastMessage = Date.now();
  ws.on('open', () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['newPendingTransactions', true] })));
  ws.on('pong', () => { lastMessage = Date.now(); });
  ws.on('message', raw => {
    const workerSeenMs = Date.now();
    if (socket !== ws) return;
    lastMessage = Date.now();
    let message; try { message = JSON.parse(String(raw)); } catch { return; }
    if (message.id === 1) {
      if (message.error || !message.result) { health.lastError = message.error?.message || '订阅未返回 ID'; ws.terminate(); return; }
      health.subscription = message.result; health.status = 'subscribed'; health.lastError = ''; publish(); return;
    }
    if (message.params?.subscription !== health.subscription) return;
    const tx = message.params?.result;
    if (!tx) return;
    health.messages++;
    if (typeof tx !== 'object') {
      health.hashesIgnored++; health.lastError = '节点仅返回哈希，未进行全链 RPC 查询';
      if (health.hashesIgnored % 100 === 0) ws.terminate();
      return;
    }
    if (tx.blockNumber != null || tx.blockHash != null) return;
    const from = String(tx.from || '').toLowerCase();
    let nonce; try { nonce = BigInt(tx.nonce).toString(); } catch { return; }
    const key = `${from}:${nonce}`;
    if (Date.now() - windowStart > 1000) { windowStart = Date.now(); forwarded = 0; }
    if (tracked.has(key) && tracked.get(key).hash !== tx.hash && !seen.has(tx.hash)) {
      if (forward({ type: 'replacement', tx: { hash: tx.hash, from, nonce } })) seen.set(tx.hash, Date.now());
      if (seen.size > 2048) seen.delete(seen.keys().next().value);
    }
    const candidates = decodePendingRegistration(tx, workerData.safes);
    if (!candidates.length || seen.has('candidate:' + tx.hash)) return;
    for (const candidate of candidates) { candidate.workerSeenAt = new Date(workerSeenMs).toISOString(); candidate.pendingSource = health.endpoint; }
    health.matches += candidates.length;
    if (!forward({ type: 'candidates', candidates })) return;
    seen.set('candidate:' + tx.hash, Date.now());
    if (seen.size > 2048) seen.delete(seen.keys().next().value);
    tracked.set(key, { hash: tx.hash, at: Date.now() });
    if (tracked.size > 256) tracked.delete(tracked.keys().next().value);
  });
  ws.on('error', error => { health.lastError = error.message; ws.terminate(); });
  ws.on('close', () => {
    health.status = 'reconnecting'; health.subscription = ''; health.reconnects++; publish();
    const delay = Date.now() - started > 30000 ? 1000 : Math.min(30000, 1000 * 2 ** Math.min(health.reconnects, 5));
    clearTimeout(retry); retry = setTimeout(connect, delay);
  });
}
setInterval(() => {
  const now = Date.now();
  for (const [key, at] of seen) if (now - at > 120000) seen.delete(key);
  for (const [key, value] of tracked) if (now - value.at > 1800000) tracked.delete(key);
  if (socket?.readyState === WebSocket.OPEN) {
    if (now - lastMessage > 45000 || health.status !== 'subscribed' && now - started > 15000) socket.terminate();
    else socket.ping();
  }
  publish();
}, 10000);
connect();
