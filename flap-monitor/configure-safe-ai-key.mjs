import { readFileSync, writeFileSync, copyFileSync, renameSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function updateSafeAiKeyEnv(text, key) {
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(key)) throw Error('Key 格式无效，未写入');
  // Preserve all other settings; deduplicate only the dedicated secret entry.
  const lines = text.split(/\r?\n/).filter(l => !/^FLAP_SAFE_AI_DEEPSEEK_API_KEY=/.test(l));
  while (lines.at(-1) === '') lines.pop();
  return lines.join('\n') + '\nFLAP_SAFE_AI_DEEPSEEK_API_KEY=' + key + '\n';
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const key = readFileSync(0, 'utf8').trim();
    const file = fileURLToPath(new URL('../.env', import.meta.url));
    const previous = readFileSync(file, 'utf8'), next = updateSafeAiKeyEnv(previous, key);
    const backup = file + '.safe-ai-backup-' + Date.now();
    copyFileSync(file, backup); chmodSync(backup, 0o600);
    const tmp = file + '.safe-ai-tmp'; writeFileSync(tmp, next, { mode: 0o600 }); chmodSync(tmp, 0o600); renameSync(tmp, file);
    console.log('Safe 专用 DeepSeek Key 已写入；未修改全局模型或其他配置。');
  } catch { console.error('Key 配置失败，检查输入和 .env 权限；未输出凭证。'); process.exitCode = 1; }
}
