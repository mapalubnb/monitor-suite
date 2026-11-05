import test from 'node:test';
import assert from 'node:assert/strict';
import { createSafeResearchTools, missingResearchEvidence, sourceNumericFacts, runSafeResearch, requestSafeResearch } from './safe-ai-research.mjs';
import { validateSafeAiOutput, diagnoseSafeAiOutput, evidenceFallback } from './safe-ai-analysis.mjs';
import { createSafeEvidenceCollector } from './safe-ai-evidence.mjs';
import { selectorOf, fragmentFromSignature } from './safe-ai-call-codec.mjs';
import { describeOperationalAction } from './operational-call-codec.mjs';

const target = '0xa0377ab664fdd368adc3214a947a429f42e10939', safe = '0x670fedb797694432f81576222e816ea2c45af044';
const token = '0x55d398326f99059ff775485246999027b3197955', recipient = '0xf77d97e0397670415a00584857e002e148e0b5ce';
const w = n => BigInt(n).toString(16).padStart(64, '0');
const signature = 'createStream(address,uint216)';
const action = { kind: 'unknown', to: target, operation: 0, selector: selectorOf(signature), callPath: '0',
  rawData: selectorOf(signature) + recipient.slice(2).padStart(64, '0') + w(11574074074074074n),
  call: { status: 'verified_abi', signature, arguments: [{ type: 'address', value: recipient }, { type: 'uint216', value: '11574074074074074' }] } };
function fixture() {
  const evidence = { version: 2, evidenceStatus: 'resolved', block: '0x100', safe, actions: [structuredClone(action)], checks: [],
    contracts: [{ address: target, verified: true, functions: [{ ...fragmentFromSignature(signature), signature, selector: selectorOf(signature), mutability: 'nonpayable' },
      { signature: 'token()', inputs: [], outputs: [{ type: 'address' }], mutability: 'view' }], sources: [{ path: 'LlamaPay.sol', content: 'All amounts use 20 decimals\n' + 'line\n'.repeat(21999) + 'FULL_END' }] }] };
  const calls = [], rpcCall = async (method, params) => { calls.push([method, params]);
    if (method === 'eth_call' && params[0].data === selectorOf('token()')) return '0x' + token.slice(2).padStart(64, '0');
    if (method === 'eth_call' && params[0].data === selectorOf('decimals()')) return '0x' + w(18);
    throw Error('unexpected_rpc'); };
  const session = createSafeResearchTools(evidence, { rpcCall, sourceReader: async address => ({ address, verified: false }) });
  return { evidence, session, calls };
}

test('完整源码超过旧100k输入边界仍完整可读，行范围明确而非静默裁切', async () => {
  const { session } = fixture();
  const full = await session.execute('contract_source', { address: target });
  assert.ok(full.sources[0].content.length > 100000); assert.ok(full.sources[0].content.endsWith('FULL_END'));
  const part = await session.execute('source_lines', { address: target, path: 'LlamaPay.sol', start: 22001, end: 22001 });
  assert.equal(part.content, 'FULL_END'); assert.equal(part.totalLines, 22001);
});
test('ABI只读工具可沿token getter拓展关联图；拒绝任意地址与写函数', async () => {
  const { session, calls, evidence } = fixture();
  await assert.rejects(session.execute('read_contract', { address: token, signature: 'decimals()', args: [] }), /address_not_in_evidence/);
  await assert.rejects(session.execute('read_contract', { address: target, signature, args: [recipient, '1'] }), /read_requires_verified_view_abi/);
  const t = await session.execute('read_contract', { address: target, signature: 'token()', args: [] }); assert.equal(t.values[0].value, token);
  const d = await session.execute('read_contract', { address: token, signature: 'decimals()', args: [] }); assert.equal(d.values[0].value, '18');
  assert.ok(calls.every(c => c[0] === 'eth_call' && c[1][1] === '0x100'));
  assert.equal(evidence.observations.length, 2);
  await session.execute('read_contract', { address: token, signature: 'decimals()', args: [] }); assert.equal(calls.length, 2);
});
test('nonce81付款速率按20位精度精确计算，派生数值可通过校验，编造金额被拒绝', async () => {
  const { session, evidence } = fixture();
  const result = await session.execute('decimal_amount', { raw: '11574074074074074', decimals: 20, multiplier: '2592000', unitEvidence: 'All amounts use 20 decimals' });
  assert.equal(result.exact, '299.99999999999999808000'); assert.equal(result.roundedDisplay, '300'); assert.equal(result.days, '30');
  assert.ok(validateSafeAiOutput(JSON.stringify({ summary: `拟向${recipient}创建持续付款流，按30天约300 USDT。` }), evidence));
  assert.equal(validateSafeAiOutput(JSON.stringify({ summary: '拟支付99999 USDT。' }), evidence), null);
  await assert.rejects(session.execute('decimal_amount', { raw: '999999', decimals: 20, multiplier: '1', unitEvidence: '猜测' }), /not_observed/);
});
test('多项已解析不再误报缺ABI；部分未知准确区分', () => {
  const e = { actions: [action, action] }; assert.doesNotMatch(evidenceFallback(e), /缺少|0项尚未/); assert.match(evidenceFallback(e), /2项已解析.*createStream/);
  const mixed = evidenceFallback({ actions: [action, { kind: 'unknown', call: { status: 'unresolved' } }] }); assert.match(mixed, /已解析1项，另1项/);
});
test('拒绝把源码未取得说成没有验证源码，以及将平台标记当身份', () => {
  const { evidence } = fixture();
  assert.equal(validateSafeAiOutput(JSON.stringify({ summary: '新旧均无验证源码，权限变化未知。' }), evidence), null);
  assert.equal(validateSafeAiOutput(JSON.stringify({ summary: '拟启用非官方工厂。' }), evidence), null);
  assert.ok(validateSafeAiOutput(JSON.stringify({ summary: '未取得新旧源码，权限变化无法确认。' }), evidence));
});
test('已验证代码数字支持下划线和科学计数，注释/字符串/未验证来源不能添加数字事实', () => {
  const { evidence } = fixture();
  evidence.contracts[0].sources = [{ content: 'uint limit = 30_000 * 1e18; uint fee = 100; // 999999\n string s = "888888"; uint tiny = 1e-3;' }];
  evidence.contracts.push({ verified: false, sources: [{ content: 'uint fake = 777777;' }] });
  const facts = sourceNumericFacts(evidence);
  for (const n of ['30000', '1000000000000000000', '100', '0.001']) assert.ok(facts.has(n), n);
  for (const n of ['999999', '888888', '777777']) assert.equal(facts.has(n), false);
  assert.ok(validateSafeAiOutput(JSON.stringify({ summary: '拟启用工厂，代码设置池深度门槛30000 USDT。' }), evidence));
  assert.match(diagnoseSafeAiOutput(JSON.stringify({ summary: '拟设置888888 USDT门槛。' }), evidence), /888888/);
});
test('新卡通用ABI展示参数区分同selector的不同子调用', () => {
  const first = describeOperationalAction({ ...action, resolvedCall: { ...action.call, arguments: [{ name: 'to', type: 'address', value: recipient }] } });
  assert.match(first, /createStream/); assert.ok(first.includes(recipient)); assert.doesNotMatch(first, /未解析/);
});
test('工具循环获得币种后返回摘要，超长按具体原因修复且地址完整', async () => {
  const { session, evidence } = fixture(); let n = 0;
  const result = await runSafeResearch({ evidence, session, provider: {}, systemPrompt: '', validate: validateSafeAiOutput, diagnose: diagnoseSafeAiOutput,
    request: async ({ messages }) => {
      n++;
      if (n === 1) { assert.ok(messages[1].content.includes('FULL_END')); return { tool_calls: [{ id: 'a', type: 'function', function: { name: 'read_contract', arguments: JSON.stringify({ address: target, signature: 'token()', args: [] }) } }] }; }
      if (n === 2 || n === 3) { if (n === 2) assert.ok(messages.some(m => m.role === 'tool' && m.content.includes(token))); else assert.equal(messages.length, 2); return { content: JSON.stringify({ summary: '拟创建付款流。' + '说明'.repeat(120) }) }; }
      assert.match(messages.at(-1).content, /summary_exceeds_200/);
      return { content: JSON.stringify({ summary: `拟为${recipient}创建持续付款流，执行后按秒计提，提取时转账。` }) };
    } });
  assert.equal(result.stats.modelRequests, 4); assert.equal(result.stats.rpcCount, 1); assert.ok(result.summary.includes(recipient));
});
test('上下文真实超限才切换显式文件目录，不预先按字符截断', async () => {
  const { session, evidence } = fixture(); let n = 0;
  const result = await runSafeResearch({ evidence, session, provider: {}, systemPrompt: '', validate: validateSafeAiOutput, diagnose: diagnoseSafeAiOutput,
    request: async ({ messages }) => {
      if (++n === 1) { assert.ok(messages[1].content.includes('FULL_END')); throw Error('model_context_limit'); }
      assert.match(messages[1].content, /contentNotIncluded/); assert.doesNotMatch(messages[1].content, /FULL_END/);
      return { content: JSON.stringify({ summary: '拟创建持续付款流；尚未读取完整源码，取消条件未确认。' }) };
    } });
  assert.equal(result.stats.contextManifest, true);
});
test('畸形工具、超预算、取消、非成功HTTP明确失败且不泄露上游正文', async () => {
  const { session } = fixture(); await assert.rejects(session.execute('send_transaction', {}), /unknown_research_tool/);
  await assert.rejects(session.execute('recent_events', { address: target, topic0: '0x' + '1'.repeat(64), blocks: 129 }), /event_range_invalid/);
  for (let i = 0; i < 22; i++) await session.execute('contract_source', { address: target });
  await assert.rejects(session.execute('contract_source', { address: target }), /research_tool_budget/);
  await assert.rejects(requestSafeResearch({ provider: {}, messages: [], fetchFn: async () => new Response('private-provider-message', { status: 401 }) }), /model_http_401/);
  const abort = new AbortController(); abort.abort(Error('cancelled'));
  await assert.rejects(createSafeResearchTools(fixture().evidence, { signal: abort.signal }).execute('contract_source', { address: target }), /cancelled/);
});
test('初次取证不裁切源码、函数或第65项调用', async () => {
  const collect = createSafeEvidenceCollector({ sourceReader: async address => ({ address, verified: true, functions: [], sources: [{ path: 'full.sol', content: 'x'.repeat(120000) }] }), selectorReader: async () => ({ candidates: [] }) });
  const e = await collect({ safe, actions: Array.from({ length: 65 }, (_, i) => ({ kind: 'unknown', to: target, callPath: String(i), selector: '0x12345678' })) });
  assert.equal(e.actions.length, 65); assert.equal(e.contracts[0].sources[0].content.length, 120000); assert.equal(typeof collect.createResearch, 'function');
});

test('已验证持续付款必须核验币种、精度及换算，不能有工具却直接跳过关键事实', async () => {
  const { evidence, session } = fixture(); evidence.contracts[0].sources[0].content += '\ncontract LlamaPay {}';
  assert.equal(missingResearchEvidence(evidence).length, 2);
  await session.execute('read_contract', { address: target, signature: 'token()', args: [] });
  assert.ok(missingResearchEvidence(evidence).some(x => x.includes('symbol()')));
  await session.execute('read_contract', { address: token, signature: 'decimals()', args: [] });
  evidence.observations.push({ address: token, signature: 'symbol()', values: [{ type: 'string', value: 'USDT' }] });
  await session.execute('decimal_amount', { raw: '11574074074074074', decimals: 20, multiplier: '2592000', unitEvidence: 'All amounts use 20 decimals' });
  assert.deepEqual(missingResearchEvidence(evidence), []);
});

test('工具返回完整源码仍超限时明确要求更小行范围，不静默截断', async () => {
  const { session, evidence } = fixture(); let n = 0;
  const result = await runSafeResearch({ evidence, session, provider: {}, systemPrompt: '', validate: validateSafeAiOutput, diagnose: diagnoseSafeAiOutput,
    request: async ({ messages }) => {
      n++;
      if (n === 1 || n === 3) throw Error('model_context_limit');
      if (n === 2) return { tool_calls: [{ id: 'full', type: 'function', function: { name: 'contract_source', arguments: JSON.stringify({ address: target }) } }] };
      if (n === 4) assert.ok(messages.some(m => m.role === 'tool' && m.content.includes('source_result_exceeds_model_context')));
      return { content: JSON.stringify({ summary: '拟创建持续付款流；源码尚未完整读取，具体取消条件未确认。' }) };
    } });
  assert.equal(result.stats.contextManifest, true); assert.equal(n, 5);
});
