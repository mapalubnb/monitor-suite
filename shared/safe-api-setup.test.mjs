import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendSafeApiKeys, collectSafeApiKeys, runSafeApiSetup } from './safe-api-setup.mjs';

function terminal() {
  const input = new PassThrough(); input.isTTY = true;
  input.setRawMode = value => { input.isRaw = value; };
  let text = '';
  return {input, output: {write: value => {text += value;}}, text: () => text,
    type: value => input.emit('keypress', value, {}),
    enter: () => input.emit('keypress', '\r', {name: 'return'})};
}

test('setup appends deduplicated keys while preserving other env values and legacy key', () => {
  const before = '# config\r\nOTHER=keep\r\nFLAP_SAFE_API_KEY="old"\r\n';
  const result = appendSafeApiKeys(before, ['second', 'second', 'third']);
  assert.equal(result.added, 2);
  assert.equal(result.total, 3);
  assert.ok(result.text.startsWith(before));
  assert.ok(result.text.endsWith('FLAP_SAFE_API_KEYS=old,second,third\r\n'));
  assert.throws(() => appendSafeApiKeys(before, ['bad\nINJECT=x']), /有效/);
});

test('hidden input accepts multiple keys and empty enter finishes without exposing values', async () => {
  const t = terminal();
  const result = collectSafeApiKeys(t.input, t.output);
  t.type('secret-one'); t.enter(); t.type('secret-two'); t.enter(); t.enter();
  assert.deepEqual(await result, ['secret-one','secret-two']);
  assert.doesNotMatch(t.text(), /secret-one|secret-two/);
  assert.equal(t.input.isRaw, false);
  t.input.destroy();
});

test('cancel does not save or restart; finishing saves once and restarts only Flap', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'safe-api-setup-')), envPath = join(dir, '.env');
  let restarts = 0;
  try {
    writeFileSync(envPath, 'OTHER=keep\nFLAP_SAFE_API_KEY=old\n');
    let t = terminal();
    let run = runSafeApiSetup({envPath, input:t.input, output:t.output, restart:()=>{restarts++;}});
    t.type('cancelled-secret'); t.input.emit('keypress', '', {ctrl:true,name:'c'});
    await run; t.input.destroy();
    assert.equal(restarts, 0);
    assert.doesNotMatch(readFileSync(envPath,'utf8'), /cancelled-secret/);
    t = terminal();
    run = runSafeApiSetup({envPath, input:t.input, output:t.output, restart:()=>{restarts++;}});
    t.type('added-secret'); t.enter(); t.enter();
    await run; t.input.destroy();
    assert.equal(restarts, 1);
    assert.match(readFileSync(envPath,'utf8'), /FLAP_SAFE_API_KEYS=old,added-secret/);
    assert.doesNotMatch(t.text(), /added-secret/);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
