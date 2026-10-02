import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpRecovery, retryAfterMs } from './http-recovery.mjs';

const api = 'https://four.meme/meme-api/v1/public/config';
const page = 'https://four.meme/en/create-token';
const immediate = task => Promise.resolve().then(task);
const ok = () => new Response('{"code":0}', { status: 200 });
const deny = () => new Response('Access denied', { status: 403 });
function harness() {
  let time = 1000;
  const reports = [];
  const guard = createHttpRecovery({ now: () => time, onRestriction: x => reports.push(x) });
  return { guard, reports, at: value => { time = value; },
    request: (url, response = ok, opts = {}, schedule = immediate) => guard.request(url, opts, schedule, response, 1000) };
}

test('API 403 isolates pages; in-flight success cannot shorten cooldown', async () => {
  const h = harness();
  let finish;
  const old = h.request(api + '?old=1', () => new Promise(r => { finish = r; }));
  await Promise.resolve(); await Promise.resolve();
  await assert.rejects(h.request(api, deny), /HTTP 403/);
  h.at(1500); finish(ok()); await old;
  assert.equal(h.guard.snapshot().states['https://four.meme:api'].until, 31000);
  await assert.rejects(h.request(api), /退避中/);
  assert.equal((await h.request(page)).status, 200);
  assert.equal(h.reports[0].path, '/meme-api/v1/public/config');
  assert.equal(h.reports[0].preview, 'Access denied');
});

test('queued request rechecks cooldown before network dispatch', async () => {
  const h = harness(); let start, calls = 0;
  const queued = h.request(api + '?queued', () => { calls++; return ok(); }, {}, task => new Promise((resolve, reject) => {
    start = () => Promise.resolve().then(task).then(resolve, reject);
  }));
  await assert.rejects(h.request(api, deny), /403/);
  const rejected = assert.rejects(queued, /退避中/);
  await start(); await rejected;
  assert.equal(calls, 0);
});

test('identical in-flight GET is shared with independently readable responses, no TTL reuse', async () => {
  const h = harness(); let finish, calls = 0;
  const dispatch = () => { calls++; return new Promise(r => { finish = r; }); };
  const first = h.request(api, dispatch, { headers: { Accept: 'application/json' } });
  const second = h.request(api, dispatch, { method: 'GET', headers: { accept: 'application/json' } });
  await Promise.resolve(); await Promise.resolve(); finish(ok());
  const [a, b] = await Promise.all([first, second]);
  assert.equal(await a.text(), await b.text()); assert.equal(calls, 1);
  await h.request(api, () => { calls++; return ok(); });
  assert.equal(calls, 2); assert.equal(h.guard.snapshot().counters.reused, 1);
});

test('different validators, POSTs and cancellation signals are never coalesced', async () => {
  const h = harness(); let calls = 0;
  const dispatch = async () => { calls++; return ok(); };
  await Promise.all([
    h.request(page, dispatch, { headers: { 'If-None-Match': 'a' } }),
    h.request(page, dispatch, { headers: { 'If-None-Match': 'b' } }),
    h.request(api, dispatch, { method: 'POST', body: '{}' }),
    h.request(api, dispatch, { method: 'POST', body: '{}' }),
    h.request(page, dispatch, { signal: new AbortController().signal }),
    h.request(page, dispatch, { signal: new AbortController().signal }),
  ]); assert.equal(calls, 6);
});

test('429 honors Retry-After beyond local ceiling and persists host cooldown', async () => {
  const h = harness();
  await assert.rejects(h.request(api, () => new Response('limited', { status: 429, headers: { 'Retry-After': '600', 'cf-ray': 'sample' } })), /429/);
  assert.equal(h.guard.snapshot().states['https://four.meme'].until, 601000);
  await assert.rejects(h.request(page), /退避中/);
  const restored = createHttpRecovery({ now: () => 2000, initial: h.guard.snapshot() });
  assert.throws(() => restored.assertAvailable(page), /退避中/);
  assert.equal(retryAfterMs('Thu, 01 Jan 1970 00:02:00 GMT', 1000), 119000);
});

test('independent page and API 403 promote to host cooldown', async () => {
  const h = harness();
  await assert.rejects(h.request(api, deny), /403/);
  await assert.rejects(h.request(page, deny), /403/);
  assert.ok(h.guard.snapshot().states['https://four.meme']);
  await assert.rejects(h.request('https://four.meme/_next/static/app.js'), /退避中/);
});

test('cooldown expiry admits one probe; repeated failure doubles instead of resetting', async () => {
  const h = harness();
  await assert.rejects(h.request(api, deny), /403/); h.at(31001);
  let finish;
  const probe = h.request(api, () => new Promise(r => { finish = r; }));
  await Promise.resolve(); await Promise.resolve();
  await assert.rejects(h.request(api + '?other'), /退避中/);
  finish(ok()); await probe;
  h.at(32000); await assert.rejects(h.request(api, deny), /403/);
  assert.equal(h.guard.snapshot().states['https://four.meme:api'].until, 92000);
});

test('restriction clears only after sustained successful checks; 304 is a valid success', async () => {
  const h = harness();
  await assert.rejects(h.request(api, deny), /403/);
  h.at(31001); await h.request(api);
  h.at(40000); await h.request(api);
  assert.ok(h.guard.snapshot().states['https://four.meme:api']);
  h.at(91001); assert.equal((await h.request(api, () => new Response(null, { status: 304 }))).status, 304);
  assert.deepEqual(h.guard.snapshot().states, {});
});

test('long server cooldown survives a later restart; exhausted 5xx retry stays service-scoped', async () => {
  const h = harness();
  await assert.rejects(h.request(api, () => new Response('limited', { status: 429, headers: { 'Retry-After': '172800' } })), /429/);
  const restored = createHttpRecovery({ now: () => 86402_000, initial: h.guard.snapshot() });
  assert.throws(() => restored.assertAvailable(api), /退避中/);
  const fresh = harness();
  assert.throws(() => fresh.guard.recordFailure(api, new Response('unavailable', { status: 503 }), 'unavailable'), /503/);
  assert.equal(fresh.guard.snapshot().states['https://four.meme:api'].until, 6000);
  assert.equal((await fresh.request(page)).status, 200);
  assert.equal(fresh.guard.snapshot().counters.serverErrors, 1);
});
