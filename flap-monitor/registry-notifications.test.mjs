import test from 'node:test';
import assert from 'node:assert/strict';
import { REGISTRY_TOPIC, CATEGORY_TOPIC, decodeRegistryLog, ingestRegistryLog, drainRegistryNotifications, auditRegistryNotifications } from './registry-notifications.mjs';
const portal = '0x90497450f2a706f1951b5bdda52b4e5d16f34c06';
const vault = '0xe26a5988e889e0f0467a54b7b6aa1618c647dc26';
const word = n => BigInt(n).toString(16).padStart(64, '0');
const event = { address: portal, topics: [REGISTRY_TOPIC], data: '0x' + vault.slice(2).padStart(64, '0') + word(1) + word(0) + word(1),
  blockNumber: '0x76f1b68', logIndex: '0x2ab',
  transactionHash: '0xa1262436b3b61c73684f83c4c2ca37e956626c4201e3509761e68acc5d82ba44',
  blockHash: '0xf740b90b42a695a74a2d069f18cb587c9754fdc3e4643efae875316d47cc68f5' };
const options = { portal, now: 1000 };

test('real Portal receipt decodes strictly; wrong source, malformed ABI and configuration-only logs cannot register', () => {
  assert.equal(decodeRegistryLog(event, portal).vault, vault);
  for (const patch of [{address:vault}, {topics:['0x'+'ab'.repeat(32)]}, {data:event.data+'00'}, {data:'0x'+word(0)+word(1)+word(0)+word(1)},
    {blockHash:null}, {transactionHash:'0x'}, {logIndex:undefined}, {data:'0x'+vault.slice(2).padStart(64,'0')+word(2)+word(0)+word(1)}]) {
    assert.equal(decodeRegistryLog({...event,...patch},portal),null);
  }
  assert.equal(ingestRegistryLog({}, {...event, data:'0x'+vault.slice(2).padStart(64,'0')+word(0)+word(0)+word(1)},options), null);
  assert.equal(ingestRegistryLog({}, {...event, topics:[CATEGORY_TOPIC], data:'0x'+vault.slice(2).padStart(64,'0')+word(0)},options), null);
});

test('WSS persists before sending, never advances HTTP cursor, and HTTP/dual endpoints deduplicate', async () => {
  const state = {lastBlock:100}, writes=[];
  const persist=()=>writes.push(JSON.parse(JSON.stringify(state)));
  const r=ingestRegistryLog(state,event,{...options,persist});
  ingestRegistryLog(state,event,{...options,persist,source:'http'});
  ingestRegistryLog(state,event,{...options,persist});
  let sends=0;
  await drainRegistryNotifications(state,{persist,send:async (record,id)=>{sends++;assert.equal(record.vault,vault);assert.match(id,/registry:/);assert.ok(writes[0].notifications[r.key]);return 'm1';}});
  assert.equal(sends,1);assert.equal(state.lastBlock,100);
  await drainRegistryNotifications(state,{send:()=>assert.fail('duplicate')});
});

test('failed delivery survives restart with stable delivery ID and bounded retry', async () => {
  const state={};ingestRegistryLog(state,event,options);let id1;
  const result=await drainRegistryNotifications(state,{now:()=>2000,send:async(_r,id)=>{id1=id;throw Error('offline');}});
  assert.equal(result.errors.length,1);
  await drainRegistryNotifications(state,{now:()=>2001,send:()=>assert.fail('backoff')});
  const restored=JSON.parse(JSON.stringify(state));
  await drainRegistryNotifications(restored,{now:()=>5000,send:async(_r,id)=>{assert.equal(id,id1);return 'm1';}});
  assert.equal(Object.values(restored.notifications)[0].messageId,'m1');
});

test('removed-before-delivery cancels alert and stale endpoint cannot resurrect it', async () => {
  const state={};ingestRegistryLog(state,{...event,removed:true},options);
  ingestRegistryLog(state,event,options);
  await drainRegistryNotifications(state,{send:()=>assert.fail('orphan')});
  assert.equal(state.knownVaults[vault],undefined);
});

test('reorg during send corrects original message and allows canonical reinclusion', async () => {
  const state={};ingestRegistryLog(state,event,options);const corrections=[];
  await drainRegistryNotifications(state,{send:async()=>{ingestRegistryLog(state,{...event,removed:true},options);return 'm1';},
    patch:async(r,version)=>corrections.push([r.messageId,version])});
  assert.deepEqual(corrections,[['m1','revoked']]);
  assert.equal(state.knownVaults[vault],undefined);
  ingestRegistryLog(state,{...event,blockHash:'0x'+'cc'.repeat(32)},options);
  let sends=0;await drainRegistryNotifications(state,{send:async()=>{sends++;return 'm2';}});
  assert.equal(sends,1);
});

test('failed correction persists across restart without sending a duplicate registration', async () => {
  const state={};ingestRegistryLog(state,event,options);
  await drainRegistryNotifications(state,{send:async()=> 'm1'});
  ingestRegistryLog(state,{...event,removed:true},options);
  await drainRegistryNotifications(state,{now:()=>2000,patch:async()=>{throw Error('patch failed');}});
  const restored=JSON.parse(JSON.stringify(state));let patched=0;
  await drainRegistryNotifications(restored,{now:()=>5000,send:()=>assert.fail('duplicate'),patch:async()=>{patched++;}});
  assert.equal(patched,1);
});

test('replacement arriving before removed is retained across restart and promoted after reorg', async () => {
  const state={};ingestRegistryLog(state,event,options);
  await drainRegistryNotifications(state,{send:async()=> 'old-card'});
  const next=ingestRegistryLog(state,{...event,blockHash:'0x'+'cc'.repeat(32),blockNumber:'0x76f1b69'},options);
  assert.equal(next.candidate,true);
  await drainRegistryNotifications(state,{send:()=>assert.fail('not a new vault yet')});
  const restored=JSON.parse(JSON.stringify(state));
  ingestRegistryLog(restored,{...event,removed:true},options);
  const sent=[],patched=[];
  await drainRegistryNotifications(restored,{send:async r=>{sent.push(r.blockHash);return 'new-card';},patch:async r=>patched.push(r.messageId)});
  assert.deepEqual(sent,['0x'+'cc'.repeat(32)]);assert.deepEqual(patched,['old-card']);
  assert.equal(restored.knownVaults[vault].eventKey,next.key);
});

test('one failed registry delivery does not starve another vault', async () => {
  const state={};ingestRegistryLog(state,event,options);
  const other='0x'+'77'.repeat(20);
  ingestRegistryLog(state,{...event,data:'0x'+other.slice(2).padStart(64,'0')+word(1)+word(0)+word(0)},options);
  const result=await drainRegistryNotifications(state,{send:async r=>{if(r.vault===vault)throw Error('first failed');return 'second';}});
  assert.equal(result.errors.length,1);assert.equal(result.sent,true);
  assert.equal(Object.values(state.notifications).find(r=>r.vault===other).messageId,'second');
});

test('background audit detects missed removal, but unavailable RPC never retracts a valid alert', async () => {
  const state={};const record=ingestRegistryLog(state,event,options);
  await drainRegistryNotifications(state,{send:async()=> 'm1'});
  await auditRegistryNotifications(state,{now:()=>2000,rpc:async()=>{throw Error('RPC unavailable');}});
  assert.equal(record.revoked,undefined);assert.match(record.auditError,/unavailable/);
  await auditRegistryNotifications(state,{now:()=>13000,rpc:async()=>({number:event.blockNumber,hash:'0x'+'cc'.repeat(32)})});
  assert.equal(record.revoked,true);assert.equal(state.knownVaults[vault],undefined);
});

test('background code verification and canonical checks stop after 128 blocks; pending corrections are retained', async () => {
  const state={latestBlock:Number(event.blockNumber)+128};const r=ingestRegistryLog(state,event,options);
  await drainRegistryNotifications(state,{send:async()=> 'm1'});
  await auditRegistryNotifications(state,{now:()=>2000,rpc:async(method)=>method==='eth_getBlockByNumber'?{number:event.blockNumber,hash:event.blockHash}:'0x'});
  assert.equal(r.settled,true);assert.equal(r.codeStatus,'missing');
  await auditRegistryNotifications(state,{now:()=>90_000_000,rpc:()=>assert.fail('settled')});
  assert.ok(state.notifications[r.key]);
  await drainRegistryNotifications(state,{patch:async()=>{}});
  await auditRegistryNotifications(state,{now:()=>90_000_000});
  assert.equal(state.notifications[r.key],undefined);
  assert.ok(state.knownVaults[vault]);
});

test('disk failure prevents first network send; pending state can be retried', async () => {
  const state={};ingestRegistryLog(state,event,options);
  await assert.rejects(drainRegistryNotifications(state,{persist:()=>{throw Error('disk full');},send:()=>assert.fail('not persisted')}),/disk full/);
  await drainRegistryNotifications(state,{now:()=>Date.now()+120000,send:async()=> 'm1'});
  assert.equal(Object.values(state.notifications)[0].messageId,'m1');
});

test('legacy known vaults stay silent, while concurrent drains send once', async () => {
  assert.equal(ingestRegistryLog({knownVaults:{[vault]:{firstSeenAt:'old'}}},event,options),null);
  const state={};ingestRegistryLog(state,event,options);let sends=0;
  const config={send:async()=>{sends++;await new Promise(r=>setImmediate(r));return 'm1';}};
  await Promise.all([drainRegistryNotifications(state,config),drainRegistryNotifications(state,config)]);
  assert.equal(sends,1);
});
