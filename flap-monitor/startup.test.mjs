import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('real Flap entry starts with enabled feeds after lifecycle state initialization', () => {
  // Exercise the production entry (not FLAP_MONITOR_TEST). Isolate I/O so this
  // smoke test cannot read credentials, write runtime state or send messages.
  const asModule = source => `data:text/javascript,${encodeURIComponent(source)}`;
  const fsMock = asModule(`
    export * from 'node:fs';
    export const existsSync = () => false;
    export const readdirSync = () => [];
    export const writeFileSync = () => {};
    export const appendFileSync = () => {};
    export const renameSync = () => {};
    export const mkdirSync = () => {};
    export const unlinkSync = () => {};
  `);
  const wsMock = asModule(`
    export default class WebSocket {
      static OPEN = 1;
      on() { return this; }
      send() {} close() {} terminate() {} ping() {}
    }
  `);
  const loader = asModule(`
    export async function resolve(specifier, context, nextResolve) {
      if (specifier === 'node:fs' && context.parentURL !== ${JSON.stringify(fsMock)})
        return { url: ${JSON.stringify(fsMock)}, shortCircuit: true };
      if (specifier === 'ws') return { url: ${JSON.stringify(wsMock)}, shortCircuit: true };
      return nextResolve(specifier, context);
    }
  `);
  const bootstrap = `
    import { register } from 'node:module';
    register(${JSON.stringify(loader)}, import.meta.url);
    globalThis.fetch = () => new Promise(() => {});
    await import(${JSON.stringify(new URL('./monitor.mjs', import.meta.url).href)});
    setTimeout(() => process.exit(0), 300);
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', bootstrap], {
    encoding: 'utf8', timeout: 10_000,
    env: {
      ...process.env, FLAP_MONITOR_TEST: '0',
      FEISHU_APP_ID: '', FEISHU_APP_SECRET: '', FEISHU_CHAT_ID: '',
      FLAP_EARLY_SIGNAL_MONITOR: 'true', FLAP_EARLY_WS_ENABLED: 'true',
    },
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /=== Flap 监控 v2 启动 ===/);
  assert.match(result.stdout, /Flap 启动通知/);
  assert.doesNotMatch(result.stdout + result.stderr, /before initialization|监控启动异常/);
});
