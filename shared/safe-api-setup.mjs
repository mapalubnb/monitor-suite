import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { emitKeypressEvents } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const validKey = value => /^[^\s,"'\\#\x00-\x1f\x7f]+$/.test(value);
export function appendSafeApiKeys(source, additions) {
  if (!additions.length || additions.some(key => !validKey(key))) throw new Error('请输入有效 Key，每次输入一个');
  const value = name => {
    const matches = [...source.matchAll(new RegExp(`^${name}=(.*)$`, 'gm'))];
    return (matches.at(-1)?.[1] || '').trim().replace(/^(["'])(.*)\1$/, '$2');
  };
  const old = (value('FLAP_SAFE_API_KEYS') || value('FLAP_SAFE_API_KEY')).split(/[\s,]+/).filter(Boolean);
  const keys = [...new Set([...old, ...additions])];
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(/\r?\n/).filter(line => !/^FLAP_SAFE_API_KEYS=/.test(line));
  while (lines.at(-1) === '') lines.pop();
  return {text: lines.join(newline) + newline + 'FLAP_SAFE_API_KEYS=' + keys.join(',') + newline,
    added: keys.length - new Set(old).size, total: keys.length};
}

export function collectSafeApiKeys(input = process.stdin, output = process.stdout) {
  if (!input.isTTY || !input.setRawMode) throw new Error('请在 SSH 交互终端运行 fl-safe-api');
  return new Promise(resolve => {
    const keys = [];
    let buffer = '';
    const wasRaw = Boolean(input.isRaw);
    const prompt = () => output.write(`第 ${keys.length + 1} 个 Key（隐藏输入，空回车保存）：`);
    const finish = result => {
      input.removeListener('keypress', onKey);
      input.removeListener('end', onEnd);
      input.setRawMode(wasRaw);
      input.pause();
      output.write('\n');
      resolve(result);
    };
    const onEnd = () => finish(null);
    const onKey = (text, key = {}) => {
      if (key.ctrl && ['c', 'd'].includes(key.name)) return finish(null);
      if (key.name === 'return' || key.name === 'enter') {
        output.write('\n');
        if (!buffer) return finish(keys);
        if (!validKey(buffer)) output.write('格式无效，请逐个粘贴 Key，不要输入引号或逗号。\n');
        else if (keys.includes(buffer)) output.write('本次已输入该 Key，已忽略重复项。\n');
        else { keys.push(buffer); output.write(`已接收 ${keys.length} 个 Key。\n`); }
        buffer = '';
        prompt();
      } else if (key.name === 'backspace') buffer = buffer.slice(0, -1);
      else if (key.ctrl && key.name === 'u') buffer = '';
      else if (!key.ctrl && !key.meta && text && !/[\x00-\x1f\x7f]/.test(text)) buffer += text;
    };
    emitKeypressEvents(input);
    input.setRawMode(true);
    input.on('keypress', onKey);
    input.once('end', onEnd);
    input.resume();
    prompt();
  });
}

export async function runSafeApiSetup({envPath = fileURLToPath(new URL('../.env', import.meta.url)),
  input = process.stdin, output = process.stdout,
  restart = () => execFileSync('pm2', ['restart', 'flap-monitor', '--silent'], {stdio: 'pipe'})} = {}) {
  output.write('Safe API 逐个录入：保留已有配置，自动去重。\n每个 Key 后按回车；空回车保存退出；Ctrl+C 取消且不保存。\n');
  const keys = await collectSafeApiKeys(input, output);
  if (!keys?.length) { output.write('未修改配置。\n'); return; }
  const result = appendSafeApiKeys(readFileSync(envPath, 'utf8'), keys);
  if (!result.added) { output.write('输入的 Key 均已存在，未修改配置。\n'); return; }
  const temp = `${envPath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, result.text, {mode: 0o600, flag: 'wx'});
    renameSync(temp, envPath);
  } finally { try { unlinkSync(temp); } catch {} }
  output.write(`已保存：新增 ${result.added} 个，共 ${result.total} 个 Key。\n`);
  try { restart(); output.write('Flap 已重启，新配置已加载。使用 fl-status 查看状态。\n'); }
  catch { throw new Error('配置已保存，但 Flap 重启失败，请执行 fl-restart'); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--help')) console.log('fl-safe-api：隐藏逐个录入 Key，空回车保存并重启 Flap，Ctrl+C 取消。');
  else runSafeApiSetup().catch(error => { console.error(error.code ? '配置文件读写失败，请使用 sudo fl-safe-api 并确认 .env 存在。' : error.message); process.exitCode = 1; });
}
