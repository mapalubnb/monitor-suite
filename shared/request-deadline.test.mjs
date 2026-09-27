import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { execFileSync } from 'node:child_process';
import { createDeadlineSignal, withDeadline } from './request-deadline.mjs';

test('deadline disposes its parent listener on success, error and cancellation', async () => {
  const parent = new AbortController();
  assert.equal(await withDeadline(() => 42, 1000, parent.signal), 42);
  assert.equal(getEventListeners(parent.signal, 'abort').length, 0);
  await assert.rejects(withDeadline(() => { throw new Error('failed'); }, 1000, parent.signal), /failed/);
  assert.equal(getEventListeners(parent.signal, 'abort').length, 0);
  const pending = withDeadline(() => new Promise(() => {}), 1000, parent.signal);
  parent.abort(new Error('cancelled'));
  await assert.rejects(pending, /cancelled/);
  assert.equal(getEventListeners(parent.signal, 'abort').length, 0);
  await assert.rejects(withDeadline(() => assert.fail('already cancelled'), 1000, parent.signal), /cancelled/);
});

test('hung body reaches independent deadline and late results cannot complete the request', async () => {
  let resolveBody, signal;
  const pending = withDeadline(async s => {
    signal = s;
    return await new Promise(resolve => { resolveBody = resolve; });
  }, 20);
  await assert.rejects(pending, error => error.name === 'TimeoutError');
  assert.ok(signal.aborted);
  resolveBody('late');
  await assert.rejects(pending, error => error.name === 'TimeoutError');
});

test('disposing a queue deadline does not abort a completed or separately timed transport', async () => {
  const deadline = createDeadlineSignal(10);
  deadline.dispose(); deadline.dispose();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(deadline.signal.aborted, false);
});

test('completed queue signals do not accumulate across 30000 cancelled requests', () => {
  const url = new URL('./request-deadline.mjs', import.meta.url).href;
  const code = `import {createDeadlineSignal} from ${JSON.stringify(url)};
    const pause=()=>new Promise(resolve=>setImmediate(resolve));
    global.gc(); const before=process.memoryUsage().heapUsed;
    for(let i=0;i<30000;i++) { const parent=new AbortController();
      const deadline=createDeadlineSignal(10,parent.signal); parent.abort(); deadline.dispose();
      if(i%1000===0) await pause(); }
    for(let i=0;i<5;i++){await pause();global.gc();}
    console.log(process.memoryUsage().heapUsed-before);`;
  const bytes = Number(execFileSync(process.execPath, ['--expose-gc', '--max-old-space-size=128', '--input-type=module', '-e', code], { encoding: 'utf8' }));
  assert.ok(bytes < 8 * 1024 * 1024, `retained ${bytes} bytes`);
});
