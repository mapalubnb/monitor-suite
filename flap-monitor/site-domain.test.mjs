import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchSite, migrateSitePages, LEGACY_URLS } from './site-domain.mjs';
test('旧域名及子域在请求前拒绝，跳转也不能绕过', async () => {
  let calls = 0;
  const fake = async () => { calls++; return new Response(null, { status: 302, headers: { location: 'https://FLAP.SH./x' } }); };
  for (const url of ['https://flap.sh', 'https://api.flap.sh', 'https://FLAP.SH./']) await assert.rejects(fetchSite(url, {}, fake), /旧域名/);
  assert.equal(calls, 0);
  await assert.rejects(fetchSite('https://flap.cool', {}, fake), /旧域名/);
  assert.equal(calls, 1);
});
test('同域跳转可用，跨域跳转阻断', async () => {
  const urls = [];
  await fetchSite('https://flap.cool', {}, async (url, opts) => {
    urls.push(url); assert.equal(opts.redirect, 'manual');
    return urls.length === 1 ? new Response(null, { status: 308, headers: { location: '/board' } }) : new Response('ok');
  });
  assert.deepEqual(urls, ['https://flap.cool', 'https://flap.cool/board']);
  await assert.rejects(fetchSite('https://flap.cool', {}, async () => new Response(null, { status: 302, headers: { location: 'https://other.example' } })), /跨域/);
});
test('迁移复制旧基线，保留旧记录并停用，重启不覆盖新基线', () => {
  const key = s => s.replace(/[^a-zA-Z0-9]/g, '_');
  const old = LEGACY_URLS[0], next = old.replace('flap.sh', 'flap.cool');
  const data = { pages: { [key(old)]: { contentHash: 'old', nested: { value: 1 } } } };
  migrateSitePages(data, key); data.pages[key(next)].nested.value = 2;
  migrateSitePages(data, key);
  assert.equal(data.pages[key(old)].nested.value, 1);
  assert.equal(data.pages[key(next)].nested.value, 2);
  assert.equal(data.legacySiteMonitor.enabled, false);
});
