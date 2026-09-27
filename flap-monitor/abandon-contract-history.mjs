import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Administrative, one-time operation; never called automatically at startup.
// Match the entire active range so a stale operator command cannot skip new work.
export function abandonContractHistory(state, from, to, at = new Date().toISOString()) {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to < from) {
    throw new Error('必须指定有效的起止区块');
  }
  if (state.historyAbandonments?.some(range => range.from === from && range.to === to)) return false;
  if (state.httpEventLastBlock + 1 !== from || state.eventHistoryEndBlock !== to) {
    throw new Error('当前历史区间与指定区间不一致，未修改状态');
  }
  if ((state.realtimeGaps || []).some(range => range.from <= to && range.to >= from)) {
    throw new Error('待补队列与指定区间重叠，需先核对，未修改状态');
  }
  state.historyAbandonments = [...(state.historyAbandonments || []), {
    from, to, at, reason: '用户确认放弃旧合约日志补扫；并非已扫描完成',
  }];
  state.httpEventLastBlock = to;
  state.eventHistoryError = '';
  state.eventHistoryNextAt = 0;
  if (state.historyRangeRetries) delete state.historyRangeRetries[from];
  return true;
}

export function abandonContractHistoryFile(path, from, to, apply = false) {
  const input = resolve(path);
  const raw = readFileSync(input, 'utf8');
  const state = JSON.parse(raw);
  const changed = abandonContractHistory(state, from, to);
  const result = { from, to, changed, applied: false };
  if (!changed || !apply) return result;
  const backup = `${input}.before-abandon-${Date.now()}.json`;
  writeFileSync(backup, raw, { flag: 'wx', mode: 0o600 });
  const temp = `${input}.abandon.tmp`;
  writeFileSync(temp, JSON.stringify(state, null, 2), { flag: 'wx', mode: 0o600 });
  renameSync(temp, input);
  return { ...result, applied: true, backup };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [path, from, to, mode] = process.argv.slice(2);
  try {
    if (!path || !from || !to || (mode && mode !== '--apply') || process.argv.length > 6) {
      throw new Error('用法：先停止 Flap，再执行 node flap-monitor/abandon-contract-history.mjs <状态文件> <起始区块> <结束区块> [--apply]；默认仅预览');
    }
    console.log(JSON.stringify(abandonContractHistoryFile(path, Number(from), Number(to), mode === '--apply')));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
