import test from 'node:test';
import assert from 'node:assert/strict';
import { createEarlySignalState, scanCowOrders, readEarlyFullBlocks } from './early-signal-monitor.mjs';
const a = '0x' + '1'.repeat(40), b = '0x' + '2'.repeat(40);
test('CoW共享429立即停止、重启保留冷却，恢复公平轮转且不清其他地址错误', async () => {
  let state = createEarlySignalState(), time = 100000, calls = [];
  const config = { wallets: [a,b], safes: [], scheduledSource: true, cowClock: () => time, cowSleep: async ms => { time += ms; } };
  const limited = async url => { calls.push(url); return new Response('', { status:429, headers:{'retry-after':'60'} }); };
  await scanCowOrders(state, config, limited, time);
  assert.equal(calls.length, 1); assert.equal(state.cowTransport.nextAttemptAtMs,160000);
  assert.equal(state.health['cow:'+b],undefined);
  state=structuredClone(state);time=159999;await scanCowOrders(state,config,limited,time);assert.equal(calls.length,1);
  time=160000;calls=[];
  await scanCowOrders(state,config,async url=>{calls.push(url);return new Response('[]');},time);
  assert(calls[0].includes(b));assert.equal(calls.length,2);assert.equal(state.health['cow:'+a].lastError,'');
  assert.equal(state.cowTransport.lastError,'');assert(time>=160250);
});
test('CoW分页429不提交半份订单快照', async () => {
  const state=createEarlySignalState();let calls=0;
  await scanCowOrders(state,{wallets:[a,b],safes:[],cowClock:()=>100000,cowSleep:async()=>{}},async()=>{
    calls++;return calls===1?new Response(JSON.stringify(Array(100).fill({}))):new Response('',{status:429});
  },100000);
  assert.equal(calls,2);assert.deepEqual(state.orders,{});assert.equal(state.health['cow:'+a].lastSuccessAt,undefined);
});
test('完整区块后批失败保留前批缓存，重试复核规范哈希且无漏块',async()=>{
  const state={};let fail=true,full=[];
  const rpc=async calls=>{
    if(calls[0].params[1] && Number(calls[0].params[0])===5 && fail)throw Error('timeout');
    return calls.map(c=>{const n=Number(c.params[0]);if(c.params[1])full.push(n);return {number:c.params[0],hash:'0x'+n.toString(16).padStart(64,'0'),transactions:c.params[1]?[]:undefined};});
  };
  await assert.rejects(readEarlyFullBlocks(state,[1,2,3,4,5,6],rpc),/timeout/);
  fail=false;const blocks=await readEarlyFullBlocks(state,[1,2,3,4,5,6],rpc);
  assert.equal(blocks.length,6);assert.deepEqual(full,[1,2,3,4,5,6]);
});
