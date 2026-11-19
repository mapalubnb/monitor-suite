import { formatBeijingTime } from '../shared/display-format.cjs';

const states = {
  added: ['green', '🟢'], removed: ['red', '🔴'], changed: ['orange', '🟠'],
  healthy: ['green', '🟢'], warning: ['orange', '⚠️'], failed: ['red', '🔴'],
};

export function cardStatus(kind, text) {
  const [color, icon] = states[kind];
  return `<font color="${color}">${icon} ${text}</font>`;
}

export function cardTime(time = Date.now()) {
  return `更新时间：${formatBeijingTime(time)}`;
}

export function formatCommandReply(result, { markdown, summary } = {}) {
  const output = String(result.text ?? '');
  if (result.ok && markdown) return summary ? `${cardStatus('healthy', '命令执行完成')}\n${output}` : output;
  if (!result.ok && result.code == null && !summary) return output;
  const longest = [...output.matchAll(/`+/g)].reduce((max, match) => Math.max(max, match[0].length), 2);
  const fence = '`'.repeat(longest + 1);
  const status = result.ok
    ? summary && cardStatus('healthy', '命令执行完成')
    : cardStatus('failed', `命令执行失败${result.code == null ? '' : ` / 退出码 ${result.code}`}`);
  return `${status ? status + '\n' : ''}${fence}\n${output}\n${fence}`;
}
