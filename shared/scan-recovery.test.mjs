import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverLiveCursor, activateHistoryGap } from './scan-recovery.mjs';

test('lag recovery preserves exact gaps through repeated recovery and historical progress', () => {
  const state = {live: 100, hash: 'old', history: 50, end: 80};
  assert.equal(recoverLiveCursor(state, {head: 10000, cursorKey: 'live', hashKey: 'hash'}), true);
  assert.equal(state.live, 9980);
  assert.equal(state.hash, '');
  assert.deepEqual(state.realtimeGaps, [{from: 101, to: 9980}]);
  assert.equal(activateHistoryGap(state, state, 'history', 'end'), false);
  state.live = 10000;
  recoverLiveCursor(state, {head: 20000, cursorKey: 'live'});
  assert.deepEqual(state.realtimeGaps, [{from: 101, to: 9980}, {from: 10001, to: 19980}]);
  state.history = 80;
  assert.equal(activateHistoryGap(state, state, 'history', 'end'), true);
  assert.equal(state.history, 100);
  assert.equal(state.end, 9980);
  assert.equal(state.realtimeGaps.length, 1);
});

test('normal live progress and uninitialized cursors are not moved', () => {
  for (const live of [undefined, null, 9900]) {
    const state = {live};
    assert.equal(recoverLiveCursor(state, {head: 10000, cursorKey: 'live'}), false);
    assert.equal(state.live, live);
  }
});

test('blocked history rotates without losing a block and survives serialization',async()=>{
 const {selectReadyHistoryRange,deferHistoryRange}=await import('./scan-recovery.mjs');
 let state={cursor:10,end:100,realtimeGaps:[{from:201,to:220}]};
 deferHistoryRange(state,'cursor',300000,1000);
 assert.equal(selectReadyHistoryRange(state,'cursor','end',1001),true);
 assert.equal(state.cursor,200);assert.equal(state.end,220);
 assert.deepEqual(state.realtimeGaps,[{from:11,to:100}]);
 state=JSON.parse(JSON.stringify(state));state.cursor=220;
 assert.equal(selectReadyHistoryRange(state,'cursor','end',2000),false);
 assert.equal(selectReadyHistoryRange(state,'cursor','end',302000),true);
 assert.equal(state.cursor,10);assert.equal(state.end,100);assert.deepEqual(state.realtimeGaps,[]);
});
