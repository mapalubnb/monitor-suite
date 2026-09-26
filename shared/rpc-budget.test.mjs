import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createRpcBudget, rpcProvider } from './rpc-budget.mjs';

test('provider aliases share a budget and batch members are charged individually', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rpc-budget-'));
  const options = { directory, maxWaitMs: 0, limits: { 'bsc.publicnode.com': { rps: 0.01, burst: 3, concurrency: 2 } } };
  try {
    const first = createRpcBudget(options), second = createRpcBudget(options);
    const release = await first.acquire('https://bsc.publicnode.com', { cost: 3 }); await release();
    await assert.rejects(second.acquire('https://bsc-rpc.publicnode.com'), error => error.rpcBudget);
    assert.equal(rpcProvider('https://bsc-dataseed-public.bnbchain.org'), rpcProvider('https://bsc-dataseed.bnbchain.org'));
    const state = JSON.parse(readFileSync(join(directory, readdirSync(directory).find(n => n.endsWith('.json')))));
    assert.equal(state.tokens, 0); assert.equal(state.leases.length, 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a separate process observes occupied slots; a crashed owner is reclaimed', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rpc-budget-'));
  const options = { directory, maxWaitMs: 50, limits: { 'node.test': { concurrency: 1 } } };
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import {createRpcBudget} from ${JSON.stringify(new URL('./rpc-budget.mjs', import.meta.url).href)};
    await createRpcBudget(${JSON.stringify(options)}).acquire('https://node.test');
    console.log('ready'); setInterval(()=>{},1000);
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); child.once('exit', code => reject(new Error('child exited '+code))); });
    await assert.rejects(createRpcBudget(options).acquire('https://node.test'), error => error.rpcBudget);
    const ended = new Promise(resolve => child.once('exit', resolve)); child.kill(); await ended;
    const release = await createRpcBudget(options).acquire('https://node.test'); await release();
  } finally { child.kill(); rmSync(directory, { recursive: true, force: true }); }
});

test('history is restricted to one slot while live reads can proceed; cancellation does not leak a lease', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rpc-budget-'));
  const budget = createRpcBudget({ directory, maxWaitMs: 50 });
  try {
    const history = await budget.acquire('https://node.test', { history: true });
    await assert.rejects(budget.acquire('https://node.test', { history: true }), error => error.rpcBudget);
    const live = await budget.acquire('https://node.test'); await live();
    const controller = new AbortController(); controller.abort();
    await assert.rejects(budget.acquire('https://node.test', { signal: controller.signal }));
    await history();
    const state = JSON.parse(readFileSync(join(directory, readdirSync(directory).find(n => n.endsWith('.json')))));
    assert.equal(state.leases.length, 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('corrupt budget data fails closed instead of silently creating another quota', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rpc-budget-'));
  try {
    const budget = createRpcBudget({ directory }); const release = await budget.acquire('https://node.test'); await release();
    writeFileSync(join(directory, readdirSync(directory).find(n => n.endsWith('.json'))), 'bad');
    await assert.rejects(budget.acquire('https://node.test'), SyntaxError);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('background budget preserves tokens for live and critical work across instances', async()=>{
 const directory=mkdtempSync(join(tmpdir(),'rpc-reserve-'));
 const options={directory,maxWaitMs:0,limits:{'node.test':{rps:0.001,burst:20,concurrency:4,criticalReserve:2}}};
 try{
  const a=createRpcBudget(options),b=createRpcBudget(options);
  const h=await a.acquire('https://node.test',{cost:12,history:true});await h();
  await assert.rejects(b.acquire('https://node.test',{cost:1,history:true}),e=>e.rpcBudget);
  const live=await b.acquire('https://node.test',{cost:6});await live();
  const critical=await a.acquire('https://node.test',{cost:2,critical:true});await critical();
 }finally{rmSync(directory,{recursive:true,force:true});}
});

test('pressure reads shared occupancy without spending quota',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'rpc-pressure-'));try{
 const budget=createRpcBudget({directory});assert.equal(budget.pressure('https://node.test'),0);
 const release=await budget.acquire('https://node.test',{history:true});
 assert.ok(budget.pressure('https://node.test',{history:true})>budget.pressure('https://node.test',{critical:true}));
 await release();assert.equal(budget.pressure('https://node.test'),0);
 }finally{rmSync(directory,{recursive:true,force:true});}
});

test('default reserve admits a complete critical batch after ordinary traffic',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'rpc-critical-'));try{
 const budget=createRpcBudget({directory,maxWaitMs:0,limits:{'node.test':{rps:0.001,burst:40}}});
 const ordinary=await budget.acquire('https://node.test',{cost:32});await ordinary();
 await assert.rejects(budget.acquire('https://node.test'),e=>e.rpcBudget);
 const critical=await budget.acquire('https://node.test',{cost:8,critical:true});await critical();
 }finally{rmSync(directory,{recursive:true,force:true});}
});
