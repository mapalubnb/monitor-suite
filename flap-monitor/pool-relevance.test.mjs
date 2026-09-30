import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createEarlySignalState, decodeEarlyReceipt, earlyAssetStage, earlyLogFilters, rewindEarlySignals, watchedWallets, runEarlySignalScan } from './early-signal-monitor.mjs';
import { poolOperationRelevance, migratePoolEvidence } from './pool-relevance.mjs';
import { selectEarlyNotification } from './early-signal-notifications.mjs';
import { selectPublicPoolNotification } from './public-pool-notifications.mjs';
import { DEX, EXECUTION_WALLETS } from './early-signal-catalog.mjs';
import { TOPICS } from './early-signal-topics.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/pddb-liquidity.json', import.meta.url)));
const owner = EXECUTION_WALLETS[0].toLowerCase(), stranger = '0x' + '12'.repeat(20);
const wallets = new Set(watchedWallets());
const word = x => BigInt(x).toString(16).padStart(64, '0');
const topic = a => '0x' + a.slice(2).padStart(64, '0');
const v3 = Object.values(fixture.pools).find(p => p.protocol === 'V3');
const makeState = () => Object.assign(createEarlySignalState(), { pools: structuredClone(fixture.pools),
  positions: structuredClone(fixture.positions), tokens: { [fixture.token]: { name: 'PDDB', effectiveEnabled: false } } });
function replay(state, transaction) {
  return decodeEarlyReceipt(fixture.receipts.find(r => r.transactionHash === transaction.hash), state);
}

test('PDDB 真实样本：官方加池即时推送，共享池第三方撤池不覆盖准备状态', () => {
  const state = makeState();
  replay(state, fixture.transactions[2]);
  assert.ok(selectEarlyNotification(state));
  assert.equal(state.pendingChanges.find(e => e.kind === 'liquidityAdded').poolRelevance, 'related');
  assert.equal(earlyAssetStage(state, fixture.token), 'prepared');
  state.pendingChanges = [];
  replay(state, fixture.transactions[1]);
  assert.ok(state.pendingChanges.every(e => e.poolRelevance === 'public'));
  assert.equal(selectEarlyNotification(state), null);
  assert.equal(earlyAssetStage(state, fixture.token), 'prepared');
  const notice = selectPublicPoolNotification(state);
  assert.equal(notice.mode, 'public-notice');
  assert.match(notice.content, /不代表 Flap 官方/);
  state.publicPoolNotifications[fixture.token] = { messageId: 'original' };
  assert.equal(selectPublicPoolNotification(JSON.parse(JSON.stringify(state))).patchMessageId, 'original');
});

test('真实 V4 公共加池不因共享仓位管理器而成为官方操作', () => {
  const state = makeState();
  replay(state, fixture.transactions[0]);
  assert.equal(state.pendingChanges[0].poolRelevance, 'public');
  assert.equal(earlyAssetStage(state, fixture.token), 'observation');
  assert.equal(selectEarlyNotification(state), null);
});

test('V3 委托撤池按已持有 NFT、代币、费率及同笔准确金额识别', () => {
  const state = makeState(); state.pools[v3.address].fee = 2500;
  const log = { address: v3.address, topics: [TOPICS.V3Burn, topic(DEX.v3Positions)],
    data: '0x' + [10,20,30].map(word).join(''), blockNumber: 124911000, logIndex: 1 };
  const event = { address: DEX.v3Positions, topics: [TOPICS.DecreaseLiquidity, '0x' + word(7594701)], data: log.data };
  assert.equal(poolOperationRelevance(state.pools[v3.address], log, [log,event], stranger, state, wallets), 'related');
  assert.equal(poolOperationRelevance(state.pools[v3.address], log, [log,{...event, data:'0x'+[11,20,30].map(word).join('')}], stranger, state, wallets), 'public');
  delete state.positions[`${DEX.v3Positions}:7594701`].tokens;
  assert.equal(poolOperationRelevance(state.pools[v3.address], log, [log,event], stranger, state, wallets), 'unknown');
});

test('V4 持有仓位 salt 核验与 NFT 转出后第三方操作区分', () => {
  const state = makeState(), pool = Object.values(state.pools).find(p=>p.protocol==='V4');
  const log = { address: DEX.v4Manager, topics: [TOPICS.ModifyLiquidity, pool.poolId, topic(DEX.v4Positions)],
    data: '0x'+[1,2,3,123].map(word).join(''), blockNumber: 100, logIndex: 3 };
  state.positions[`${DEX.v4Positions}:123`] = { owner, blockNumber: 90, logIndex: 1 };
  assert.equal(poolOperationRelevance(pool, log, [log], stranger, state, wallets), 'related');
  state.positions[`${DEX.v4Positions}:123`].owner = stranger;
  assert.equal(poolOperationRelevance(pool, log, [log], stranger, state, wallets), 'public');
});

test('新增公共池不会重建 WSS 地址订阅，HTTP 仍可收集公共活动', () => {
  const state = makeState(), before = earlyLogFilters(state, { subscriptionMode: true });
  state.pools[stranger] = { address: stranger, tokens: [fixture.token], protocol:'V3' };
  assert.deepEqual(earlyLogFilters(state, { subscriptionMode: true }), before);
  assert.ok(earlyLogFilters(state).some(f=>f.address?.includes(stranger)));
  assert.ok(before.some(f=>f.address===DEX.v3Positions && f.topics[1].includes('0x'+word(7594701))));
});

test('公共活动不能吞掉同笔权限操作，编辑退避期间重要提醒仍可发送', () => {
  const state = makeState(); replay(state, fixture.transactions[1]);
  state.publicPoolNotifications[fixture.token] = { messageId:'card', nextAttemptAtMs:Date.now()+60000 };
  assert.equal(selectPublicPoolNotification(state), null);
  state.pendingChanges.push({ id:'authority', kind:'authority', transactionHash:state.pendingChanges[0].transactionHash });
  assert.equal(selectEarlyNotification(state).changes.length, 2);
  assert.equal(selectPublicPoolNotification(state), null);
});

test('旧状态只恢复明确资金证据，重组删除相关事件后不沿用准备状态', () => {
  const state = makeState();
  state.events = Object.fromEntries(structuredClone(fixture.events).map(e=>[e.id,e]));
  migratePoolEvidence(state, wallets);
  assert.equal(earlyAssetStage(state, fixture.token), 'prepared');
  const own = Object.values(state.events).find(e=>e.kind==='liquidityAdded'&&e.poolRelevance==='related');
  rewindEarlySignals(state, own.blockNumber);
  assert.equal(earlyAssetStage(state, fixture.token), 'observation');
});

test('同笔无关代币转账不会把其他公共池升级为监控钱包操作', () => {
  const state=makeState(), pool=state.pools[v3.address];
  const burn={address:v3.address,topics:[TOPICS.V3Burn,topic(DEX.v3Positions)],data:'0x'+[1,2,3].map(word).join('')};
  const transfer={address:stranger,topics:[TOPICS.Transfer,topic(owner),topic(stranger)],data:'0x'+word(10)};
  assert.equal(poolOperationRelevance(pool,burn,[burn,transfer],stranger,state,wallets),'public');
});

test('V2 委托撤池消耗监控钱包的 LP 代币仍即时识别', () => {
  const pool={address:v3.address,protocol:'V2',tokens:v3.tokens};
  const burn={address:pool.address,topics:[TOPICS.V2Burn,topic(stranger)],data:'0x'+[1,2].map(word).join('')};
  const transfer={address:pool.address,topics:[TOPICS.Transfer,topic(owner),topic(pool.address)],data:'0x'+word(10)};
  assert.equal(poolOperationRelevance(pool,burn,[burn,transfer],stranger,makeState(),wallets),'related');
});

test('历史游标停留不妨碍记录清理，保留有效准备证据、待发和重组窗口', async () => {
  const state=makeState();state.cursor=1;state.realtimeCursor=1000;
  state.events.prepared={id:'prepared',token:fixture.token,kind:'liquidityAdded',poolRelevance:'related',blockNumber:10};
  state.events.pending={id:'pending',kind:'authority',blockNumber:11};state.pendingChanges=[state.events.pending];
  for(let i=0;i<12010;i++)state.events['public'+i]={id:'public'+i,token:fixture.token,kind:'liquidityRemoved',poolRelevance:'public',blockNumber:i===0?990:100};
  await runEarlySignalScan({state,config:{mode:'external',sources:[]},rpcBatch:async()=>[]});
  assert.equal(Object.keys(state.events).length,12000);
  assert.ok(state.events.public0);assert.ok(state.events.pending);assert.ok(state.events.prepared);
  assert.equal(earlyAssetStage(state,fixture.token),'prepared');
});
