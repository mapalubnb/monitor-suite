import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchSite, migrateSitePages, LEGACY_URLS } from './site-domain.mjs';
test('恢复主域名；只允许公开只读请求从 cool 跳转 sh', async () => {
 const calls=[]; const fake=async url=>{calls.push(url);return calls.length===1?new Response(null,{status:307,headers:{location:'https://flap.sh/apps'}}):new Response('ok')};
 assert.equal(await (await fetchSite('https://flap.cool/apps',{},fake)).text(),'ok');
 assert.deepEqual(calls,['https://flap.cool/apps','https://flap.sh/apps']);
 for(const opts of [{method:'POST',body:'secret'},{headers:{Authorization:'Bearer secret'}},{headers:{Cookie:'secret'}},{headers:{'X-API-Key':'secret'}},{credentials:'include'}]) {
  let count=0;await assert.rejects(fetchSite('https://flap.cool/apps',opts,async()=>{count++;return new Response(null,{status:307,headers:{location:'https://flap.sh/apps'}})}),/跨域/);assert.equal(count,1);
 }
});
test('同域跳转可用，其他跨域和协议仍阻断', async () => {
 const urls=[];await fetchSite('https://flap.sh',{},async url=>{urls.push(url);return urls.length===1?new Response(null,{status:308,headers:{location:'/board'}}):new Response('ok')});
 assert.deepEqual(urls,['https://flap.sh','https://flap.sh/board']);
 for(const target of ['https://other.example','https://flap.sh.evil.example','http://flap.sh','https://flap.cool'])await assert.rejects(fetchSite('https://flap.sh',{},async()=>new Response(null,{status:302,headers:{location:target}})),/跨域/);
 await assert.rejects(fetchSite('file:///secret'),/协议/);
});
test('恢复较新 cool 基线一次，保留两域记录且重启不覆盖已刷新主站', () => {
 const key=s=>s.replace(/[^a-zA-Z0-9]/g,'_');const sh=LEGACY_URLS[0],cool=sh.replace('flap.sh','flap.cool');
 const data={pages:{[key(sh)]:{nested:{v:'stale'}},[key(cool)]:{nested:{v:'recent'}}}};
 migrateSitePages(data,key);assert.equal(data.pages[key(sh)].nested.v,'recent');data.pages[key(sh)].nested.v='live';migrateSitePages(data,key);
 assert.equal(data.pages[key(sh)].nested.v,'live');assert.equal(data.pages[key(cool)].nested.v,'recent');assert.equal(data.legacySiteMonitor.enabled,true);
});
