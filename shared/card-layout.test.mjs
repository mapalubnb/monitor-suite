import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCardJson, buildCardBodyElements } from './feishu-client.mjs';
import { buildStartupCard } from './startup-notifier.mjs';
import { buildSafeProposalContent } from '../flap-monitor/safe-proposal-monitor.mjs';
import { buildContractIntegrityContent } from '../flap-monitor/contract-integrity-monitor.mjs';
import { buildEarlySignalContent } from '../flap-monitor/early-signal-monitor.mjs';

process.env.FOURMEME_MONITOR_TEST = '1';
process.env.FLAP_MONITOR_TEST = '1';
const { __testables: fm } = await import('../fourmeme-monitor/monitor.mjs');
const { __testables: fl } = await import('../flap-monitor/monitor.mjs');
const address = '0x' + '1'.repeat(40);
const hash = '0x' + '2'.repeat(64);
const timestamp = '2026-09-26T06:00:00.000Z';

function bodyText(elements) {
  return elements.flatMap(element => {
    if (element.tag === 'markdown') return [element.content];
    if (element.tag === 'div') return [element.text.content];
    if (element.tag === 'column_set') return element.columns.map(column => bodyText(column.elements));
    assert.notEqual(element.tag, 'table', 'notification corpus must retain its prose structure');
    return [];
  }).join('\n');
}

// Compare every word, number, URL and existing color tag in source order.
// Only whitespace, heading markup and layout dividers may differ.
const words = value => value.replace(/^---\s*$/gm, '').replace(/^#{1,3}\s+/gm, '').replace(/\*\*/g, '').replace(/\s/g, '');

test('all notification families retain their original content through the shared layout', () => {
  const proposal = { type: 'ready', quoteToken: address, safe: address, safeTxHash: hash,
    status: 'ready', confirmations: 2, required: 3, nonce: 42, actions: [],
    firstSeenAt: timestamp, submissionDate: timestamp };
  const samples = {
    startup: buildStartupCard('Flap', { pages: 'done', safe: 'pending' }, ['页面 3 个']).content,
    pools: fm.formatPoolChanges([{ type: '新增底池', symbol: 'BNB', address, status: 'PUBLISH', details: { totalBAmount: '18' } }]),
    apiSchema: fm.formatApiChanges([{ endpoint: 'public_config', type: '结构变化', added: ['flag'], removed: ['oldFlag'], changed: ['fee: number → string'] }]),
    apiValues: fm.formatApiValueChanges([{ endpoint: 'public_config', fieldChanges: [{ action: 'changed', key: 'fee', old: '0.01', new: '0.02' }] }]),
    templates: fm.formatOpenFourTemplateChanges({ added: [{ id: '1', name: 'Agent', status: 'PUBLISHED' }], statusChanged: [] }),
    contracts: fm.formatContractChanges([{ type: '合约升级', label: 'Manager', address, oldHash: 'old', newHash: 'new' }]),
    onchain: fm.formatOnchainChanges([{ type: 'Agent NFT 数量变更', old: 1, new: 2 }]),
    github: fm.formatGithubRepoChanges({ added: [{ full_name: 'example/repo', html_url: 'https://github.com/example/repo', description: '完整描述', default_branch: 'main' }] }),
    pageRecovery: fl.buildOperationalNoticeContent({ status: 'recovered', url: 'https://flap.sh/create', reason: '页面恢复', detail: '保留全部诊断内容' }),
    vault: fl.buildCaStoreVaultChangeNotification({ type: 'added', name: 'Gift Vault', factory: address, description: '保留金库文案', sourceUrl: 'https://flap.sh/bnb/CAstore' }, {}).content,
    factory: fl.buildFactoryPoolMonitorContent({ changes: [], state: { assets: {}, headLastScannedBlock: 123 } }),
    integrity: buildContractIntegrityContent([{ type: 'modified', address, field: 'owner', previous: 'old owner', current: 'new owner' }], { latestBlock: 123 }),
    safe: buildSafeProposalContent([proposal, { ...proposal, type: 'failed', transactionHash: hash }]),
    early: buildEarlySignalContent([{ kind: 'observation', detail: '发现准备操作，尚未开放', observedAt: timestamp, transactionHash: hash, blockNumber: 123 }], { tokens: {}, health: {} }),
    botHelp: '**内置指令：**\n`/help` 查看帮助\n\n**Shell 命令：**\n执行 `fm-status`\n\n**日志下载：**\n`fm-log` 获取日志',
    ai: '## 分析结论\n完整分析原文。\n\n### 依据\n- 数据：[来源](https://example.com)\n\n### 建议\n原建议保持不变。',
  };
  for (const [name, source] of Object.entries(samples)) {
    assert.ok(source, name);
    const content = source + '\n更新时间：' + timestamp;
    const card = JSON.parse(buildCardJson(name, content, 'orange'));
    assert.equal(words(bodyText(card.body.elements)), words(content), name);
    assert.equal(card.header.title.content, name);
    assert.equal(card.header.template, 'orange');
  }
});

test('code fences keep headings, dividers, fields and numbered rows as literal code', () => {
  for (const marker of ['```', '~~~~']) {
    const code = `${marker}text\n**原始标题**\n---\n01　BNB｜状态 PUBLISH\n字段：原始值\n\n  缩进\n${marker}`;
    const elements = buildCardBodyElements('**执行结果**\n' + code + '\n更新时间：' + timestamp);
    const block = elements.find(element => element.element_id?.startsWith('code_'));
    assert.equal(block.content, code);
    assert.equal(elements.filter(element => element.tag === 'table').length, 0);
    assert.equal(elements.filter(element => element.element_id?.startsWith('section_')).length, 1);
  }
});

test('ambiguous table rows never lose duplicate fields or split link and code labels', () => {
  for (const line of [
    '01　Pool｜状态 old｜状态 new',
    '01　[名称｜完整](https://example.com)｜状态 good',
    '01　`x｜y`｜状态 good',
  ]) {
    const elements = buildCardBodyElements(line + '\n更新时间：' + timestamp);
    assert.equal(elements.filter(element => element.tag === 'table').length, 0);
    assert.equal(words(bodyText(elements)), words(line + '\n更新时间：' + timestamp));
  }
});

test('short subheadings stay compact and major sections receive a single divider', () => {
  const elements = buildCardBodyElements('**新增字段：**\n字段：value\n---\n---\n**下一项**\n完整原文\n更新时间：' + timestamp);
  const headings = elements.filter(element => element.element_id?.startsWith('section_'));
  assert.equal(headings[0].text.text_size, 'normal');
  assert.equal(headings[1].text.text_size, 'heading');
  assert.equal(elements.filter(element => element.tag === 'hr').length, 1);
  assert.match(bodyText(elements), /\*\*字段：\*\*value/);
});

test('long metric values use the full width without losing content', () => {
  const value = '节点超时，等待恢复；'.repeat(40);
  const source = '**01｜运行状态**\n状态：需要关注\n错误：' + value + '\n更新时间：' + timestamp;
  const elements = buildCardBodyElements(source);
  assert.equal(elements.filter(element => element.tag === 'column_set').length, 0);
  assert.equal(words(bodyText(elements)), words(source));
});

test('existing links, colored diffs, deletion marks and inline code remain verbatim', () => {
  const lines = ['字段：<font color="red">~~旧值~~</font> → <font color="green">新值</font>',
    '地址：[原始名称](https://example.com/path?a=1&b=2)', '参数：`a:b`', 'https://example.com/path', '12:34:56'];
  const elements = buildCardBodyElements(lines.join('\n') + '\n更新时间：' + timestamp);
  const rendered = bodyText(elements);
  for (const token of ['<font color="red">~~旧值~~</font>', '<font color="green">新值</font>', '[原始名称](https://example.com/path?a=1&b=2)', '`a:b`', 'https://example.com/path', '12:34:56']) assert.ok(rendered.includes(token));
});

test('multiline colored paragraphs remain one balanced Markdown block', () => {
  const text = '<font color="green">第一段完整原文\n\n第二段完整原文</font>';
  const elements = buildCardBodyElements(text + '\n更新时间：' + timestamp);
  const block = elements.find(element => element.tag === 'markdown');
  assert.equal(block.content, text);
});
