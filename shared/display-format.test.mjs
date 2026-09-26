import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { formatBeijingTime, formatDisplayText } from './display-format.cjs';
import { buildCardJson } from './feishu-client.mjs';

test('UTC, explicit offsets and Beijing local timestamps have the same display', () => {
  for (const value of ['2026-09-26T06:55:52.123Z', '2026-09-26T14:55:52.123+08:00', '2026/9/26 14:55:52.123']) {
    assert.equal(formatBeijingTime(value), '2026/9/26 14:55:52.123');
  }
  assert.equal(formatBeijingTime('2026-09-26T06:55:52Z'), '2026/9/26 14:55:52');
  assert.equal(formatBeijingTime('2026-09-26T23:55:52.007Z'), '2026/9/27 07:55:52.007');
  assert.equal(formatBeijingTime(Date.parse('2026-09-26T06:55:52.123Z')), '2026/9/26 14:55:52.123');
  assert.equal(formatBeijingTime('未知'), '未知');
  assert.equal(formatBeijingTime(undefined), '未知');
  assert.equal(formatBeijingTime('2026-02-31T06:00:00Z'), '2026-02-31T06:00:00Z');
});

test('format is independent of server timezone and does not shift an already formatted time', () => {
  const expression = `const {formatBeijingTime}=require('./shared/display-format.cjs'); console.log(formatBeijingTime('2026-09-26T06:55:52.123Z'));`;
  for (const TZ of ['UTC', 'America/New_York', 'Asia/Shanghai']) {
    const result = spawnSync(process.execPath, ['-e', expression], { env: { ...process.env, TZ }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), '2026/9/26 14:55:52.123');
  }
  const text = '首次观测：2026/9/26 14:55:52.123';
  assert.equal(formatDisplayText(formatDisplayText(text)), text);
});

test('all card text loses double stars while links, deletion marks and colors survive', () => {
  const url = 'https://example.com/?time=2026-09-26T06:55:52.123Z';
  const content = `**事件详情**\n**首次观测：**2026-09-26T06:55:52.123Z\n[合约](${url})\n<font color="red">~~旧值~~</font>\n更新时间：2026-09-26T06:55:52Z`;
  const card = JSON.parse(buildCardJson('**提醒**', content, 'orange'));
  const json = JSON.stringify(card);
  assert.doesNotMatch(json, /\*\*/);
  assert.match(json, /2026\/9\/26 14:55:52\.123/);
  assert.match(json, /2026\/9\/26 14:55:52/);
  assert.ok(json.includes(url));
  assert.ok(json.includes('~~旧值~~'));
  assert.equal(card.header.title.content, '提醒');
  assert.equal(card.header.template, 'orange');
  assert.ok(card.body.elements.some(element => element.text?.text_size === 'heading'));
});
