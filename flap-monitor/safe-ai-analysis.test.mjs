import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSafeAiService, classifySafeAi, validateSafeAiOutput, safeAiPublicData, transferBrief } from './safe-ai-analysis.mjs';
import { abiSelector, createSafeEvidenceCollector, fetchVerifiedSafeSource } from './safe-ai-evidence.mjs';
import { updateSafeAiKeyEnv } from './configure-safe-ai-key.mjs';
const start = Date.parse('2026-11-04T03:00:00Z');
const safe = '0x' + '1'.repeat(40), token = '0x' + '2'.repeat(40), target = '0x' + '3'.repeat(40);
const hash = '0x' + 'a'.repeat(64);
const action = { kind: 'vaultFactory', to: target, vaultFactory: token, enabled: true };
const proposal = (overrides = {}) => ({ key: hash, safeTxHash: hash, safe, nonce: 1, status: 'pending',
  submissionDate: new Date(start + 1).toISOString(), firstSeenAt: new Date(start + 2).toISOString(),
  confirmations: 0, actions: [action], ...overrides });
const change = p => ({ ...p, type: 'proposed' });
function fixture(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'safe-ai-')); let now = start;
  const rows = { a: proposal() }, patches = [], calls = [];
  const settings = { file: join(dir, 'safe-ai-state.json'), now: () => now,
    getKey: () => 'test-only-key', getProposals: () => rows, getMetadata: () => ({}),
    collectEvidence: async p => ({ actions: p.actions, contextIncomplete: true }),
    complete: async opts => { calls.push(opts); return JSON.stringify({ summary: '拟登记机制模板，收益和退出规则需要核验。' }); },
    render: (changes, m) => `原始卡:${changes.map(x => x.nonce).join(',')}|${m[token]?.symbol || 'unknown'}`,
    patch: async (...args) => patches.push(args), ...options };
  const service = createSafeAiService(settings);
  const register = (changes = [change(rows.a)], id = 'message') => service.registerCard({ id, title: '原始提案', changes, metadata: {}, color: 'red' });
  return { dir, settings, rows, patches, calls, service, register, setNow: n => { now = n; },
    clean: () => rmSync(dir, { recursive: true, force: true }) };
}

test('Safe AI: tool research enriches only the registered card and deduplicates subsequent signatures', async () => {
  let researched = 0;
  const collectEvidence = async p => ({ version: 2, evidenceStatus: 'insufficient', actions: p.actions, checks: [], contracts: [] });
  collectEvidence.createResearch = () => ({ tools: [] });
  const f = fixture({ collectEvidence, research: async ({ evidence }) => {
    researched++;
    evidence.actions[0].call = { status: 'verified_abi', signature: 'createStream(address,uint216)', arguments: [{ type: 'address', name: 'to', value: token }] };
    return { summary: `拟向${token}创建持续付款流。`, stats: { modelRequests: 2, toolCalls: 1 } };
  } });
  try {
    f.rows.a.actions = [{ kind: 'unknown', to: target, selector: '0xc355f343', callPath: '0' }];
    assert.ok(f.register()); await f.service.tick();
    assert.equal(f.patches.length, 1); assert.match(f.patches[0][2], /<font color='green'>/);
    const saved = JSON.parse(readFileSync(f.settings.file));
    assert.equal(saved.cards.message.changes[0].actions[0].resolvedCall.signature, 'createStream(address,uint216)');
    assert.equal(Object.values(saved.jobs)[0].research.modelRequests, 2);
    assert.equal(f.rows.a.actions[0].call, undefined);
    await f.service.tick(); assert.equal(researched, 1); assert.equal(f.patches.length, 1);
  } finally { f.clean(); }
});

test('Safe AI: tool failure records cause and falls back after bounded retries without false missing ABI', async () => {
  const collectEvidence = async () => ({ version: 2, evidenceStatus: 'resolved', actions: [1, 2].map(() => ({ kind: 'unknown', call: { status: 'verified_abi', signature: 'createStream(address,uint216)' } })), contracts: [] });
  collectEvidence.createResearch = () => ({});
  const f = fixture({ collectEvidence, research: async () => { throw Error('model_http_429'); } });
  try {
    f.register(); await f.service.tick(); f.setNow(start + 61_000); await f.service.tick();
    const job = Object.values(JSON.parse(readFileSync(f.settings.file)).jobs)[0];
    assert.equal(job.lastError, 'model_http_429'); assert.equal(job.status, 'model_failed');
    assert.match(f.patches[0][2], /2项已解析/); assert.doesNotMatch(f.patches[0][2], /缺少匹配ABI/);
  } finally { f.clean(); }
});
test('Safe AI: new unsigned proposals are eligible; cutoff/existing/terminal/muted stay excluded', async () => {
  const f = fixture();
  try {
    for (const overrides of [{ submissionDate: new Date(start - 1).toISOString() }, { submissionDate: '' },
      { status: 'executed' }, { actions: [{ kind: 'grantRevoke' }] }]) {
      f.rows.a = proposal(overrides); assert.equal(f.register(), false);
    }
    f.rows.a = proposal(); assert.equal(f.register([{ ...change(f.rows.a), type: 'existing' }]), false);
    assert.equal(f.register([{ ...change(f.rows.a), type: 'signatures' }]), false);
    f.rows.a = proposal({ safeTxHash: '0x' + 'c'.repeat(64) });
    assert.equal(f.rows.a.confirmations, 0);
    assert.equal(f.register(), true); await f.service.tick(); assert.equal(f.calls.length, 1);
    assert.equal(f.patches[0][0], 'message');
    assert.match(f.patches[0][2], /<font color='green'>AI解读/);
    assert.doesNotMatch(JSON.stringify(f.calls), /signature"|rawData/);
  } finally { f.clean(); }
});
test('Safe AI: combine split asset rows, pin model and send authorized calldata/signatures without duplicating state', async () => {
  const f = fixture();
  try {
    f.rows.a = proposal({ actions: [{ ...action, rawData: 'secret-signature' }] });
    f.rows.b = proposal({ quoteToken: token, actions: [{ kind: 'upgrade', proxy: target, implementation: token, signature: 'secret' }] });
    f.register([change(f.rows.a), change(f.rows.b)]); await f.service.tick();
    assert.equal(f.calls.length, 1);
    assert.equal(JSON.parse(f.calls[0].userMessage).actions.length, 2);
    assert.equal(JSON.parse(f.calls[0].userMessage).actions[0].rawData, 'secret-signature');
    assert.equal(JSON.parse(f.calls[0].userMessage).actions[1].signature, 'secret');
    assert.equal(f.calls[0].provider.model, 'deepseek-flash');
    assert.equal(f.calls[0].provider.apiUrl, 'https://api.deepseek.com/chat/completions');
    assert.doesNotMatch(readFileSync(f.settings.file, 'utf8'), /secret-signature|test-only-key/);
    assert.ok([...f.patches[0][2].split('\n\n')[1].replace(/<\/?font\b[^>]*>/g, '')].length <= 200);
  } finally { f.clean(); }
});

test('Safe AI: insufficient evidence retries once without model; unresolved is not marked done or green AI', async () => {
  let collected = 0;
  const f = fixture({ collectEvidence: async () => { collected++; return { version: 2, evidenceStatus: 'insufficient', retryable: true,
    actions: [{ kind: 'unknown', call: { status: 'unresolved' } }], checks: [{ status: 'unresolved' }] }; } });
  try {
    f.register(); await f.service.tick(); assert.equal(f.calls.length, 0); assert.equal(f.patches.length, 0);
    f.setNow(start + 61_000); await f.service.tick(); assert.equal(collected, 2); assert.equal(f.calls.length, 0);
    assert.equal(f.patches.length, 1); assert.match(f.patches[0][2], /核验提示/); assert.doesNotMatch(f.patches[0][2], /<font/);
    const job = Object.values(JSON.parse(readFileSync(f.settings.file)).jobs)[0]; assert.equal(job.status, 'insufficient');
    await f.service.tick(); assert.equal(collected, 2);
  } finally { f.clean(); }
});

test('Safe AI: candidate language is mandatory; semantic failure gets bounded retry and factual fallback', async () => {
  const evidence = { version: 2, evidenceStatus: 'candidate', actions: [{ kind: 'unknown', category: 'permission',
    call: { status: 'corroborated_candidate', signature: 'setTester(address,bool)' }, fact: '候选：拟开启指定地址测试者资格，具体权限待核验。' }],
    checks: [{ status: 'corroborated_candidate', function: 'setTester(address,bool)' }] };
  assert.equal(validateSafeAiOutput(JSON.stringify({ summary: '提案调用未验证合约，目的与机制待核验。' }), evidence), null);
  assert.equal(validateSafeAiOutput(JSON.stringify({ summary: '提案将开放新金库。' }), evidence), null);
  assert.ok(validateSafeAiOutput(JSON.stringify({ summary: '候选操作为开启测试者资格，具体测试权限待核验。' }), evidence));
  for (const summary of ['按当前证据判断，拟开启测试者资格；具体权限范围尚缺实现代码。',
    '拟开启测试者资格，函数识别尚待ABI确认。']) {
    assert.equal(validateSafeAiOutput(JSON.stringify({ summary }), evidence), summary);
  }
  assert.equal(validateSafeAiOutput(JSON.stringify({ summary: '拟开启测试者资格，具体权限范围待核验。' }), evidence), null);
  const resolved = { ...evidence, evidenceStatus: 'resolved' };
  assert.equal(validateSafeAiOutput(JSON.stringify({ summary: '拟开启测试者资格。' }), resolved), '拟开启测试者资格。');

  const f = fixture({ collectEvidence: async () => evidence, complete: async () => JSON.stringify({ summary: '调用未知，收益退出限制待核验。' }) });
  try { f.register(); await f.service.tick(); assert.equal(f.patches.length, 0);
    f.setNow(start + 61_000); await f.service.tick(); assert.equal(f.patches.length, 1); assert.match(f.patches[0][2], /核验提示.*候选/);
    const job = Object.values(JSON.parse(readFileSync(f.settings.file)).jobs)[0]; assert.equal(job.status, 'model_failed');
  } finally { f.clean(); }
});
test('Safe AI: unsigned analysis survives restart; first and further signatures reuse it', async () => {
  const f = fixture();
  try {
    assert.equal(f.rows.a.confirmations, 0);
    f.register(); await f.service.tick();
    await f.service.tick(); assert.equal(f.calls.length, 1); assert.equal(f.patches.length, 1);
    const restarted = createSafeAiService(f.settings);
    for (const confirmations of [1, 2]) {
      f.rows.a.confirmations = confirmations;
      restarted.registerCard({ id: `progress-${confirmations}`, title: '签名进度', changes: [{ ...f.rows.a, type: 'signatures' }], metadata: {}, color: 'red' });
      await restarted.tick(); assert.equal(f.calls.length, 1); assert.equal(f.patches.at(-1)[0], `progress-${confirmations}`);
    }
  } finally { f.clean(); }
});
test('Safe AI: ordinary transfers use exact-unit templates without a model request', async () => {
  const f = fixture({ getMetadata: () => ({ [token]: { symbol: 'USDT', decimals: 18 } }) });
  try {
    f.rows.a.actions = [{ kind: 'transfer', asset: token, recipient: target, amount: '700000000000000000000000' }];
    f.register(); await f.service.tick(); assert.equal(f.calls.length, 0);
    assert.match(f.patches[0][2], /700000 USDT/); assert.doesNotMatch(f.patches[0][2], /AI解读/);
    f.service.updateMetadata('message', { [token]: { symbol: 'USD', decimals: 18 } }); await f.service.tick();
    assert.match(f.patches.at(-1)[2], /700000 USD/);
    assert.equal(classifySafeAi([{ kind: 'approval', amount: '0' }]), 'skip');
    const mixed = [...f.rows.a.actions, { kind: 'approval', amount: '0' }];
    assert.equal(classifySafeAi(mixed), 'transfer');
    assert.match(transferBrief(mixed, { [token]: { symbol: 'USDT', decimals: 18 } }), /700000 USDT/);
    assert.ok([...transferBrief([{ ...f.rows.a.actions[0], amount: '1'.repeat(200) }], {})].length <= 140);
  } finally { f.clean(); }
});
test('Safe AI: no key/disabled/expired jobs do not invoke AI; retry count is bounded', async () => {
  const f = fixture({ getKey: () => '' });
  try {
    f.register(); await f.service.tick(); assert.equal(f.service.status().health, 'missing_key');
    assert.equal(f.calls.length, 0); f.setNow(start + 31 * 60_000); await f.service.tick(); assert.equal(f.service.status().pending, 0);
  } finally { f.clean(); }
  let count = 0;
  const g = fixture({ complete: async () => { count++; throw Error('offline'); } });
  try {
    g.register(); await g.service.tick(); await g.service.tick(); assert.equal(count, 1);
    g.setNow(start + 61_000); await g.service.tick(); g.setNow(start + 122_000); await g.service.tick(); assert.equal(count, 2);
  } finally { g.clean(); }
  const h = fixture({ enabled: false });
  try { assert.equal(h.register(), false); await h.service.tick(); assert.equal(h.calls.length, 0); } finally { h.clean(); }
});
test('Safe AI: execution while analysis is in flight prevents stale AI enrichment', async () => {
  let release, entered;
  const started = new Promise(r => { entered = r; });
  const f = fixture({ complete: async () => { entered(); return new Promise(r => { release = r; }); } });
  try {
    f.register(); const run = f.service.tick(); await started; f.rows.a.status = 'executed';
    release(JSON.stringify({ summary: '拟改变机制。' })); await run; assert.equal(f.patches.length, 0);
  } finally { f.clean(); }
});
test('Safe AI: metadata arriving during patch is not lost, including when key is absent', async () => {
  let release, entered, first = true; const started = new Promise(r => { entered = r; });
  const patches = [];
  const f = fixture({ getKey: () => '', patch: async (...args) => { patches.push(args);
    if (first) { first = false; entered(); await new Promise(r => { release = r; }); } } });
  try {
    f.register(); f.service.updateMetadata('message', { [token]: { symbol: 'OLD' } });
    const run = f.service.tick(); await started;
    f.service.updateMetadata('message', { [token]: { symbol: 'NEW' } }); release(); await run; await f.service.tick();
    assert.match(patches.at(-1)[2], /NEW/); assert.equal(patches.length, 2);
  } finally { f.clean(); }
});
test('Safe AI: unsafe, oversized, invented numeric or non-JSON output fails closed', () => {
  const check = summary => validateSafeAiOutput(JSON.stringify({ summary }), { contextIncomplete: true });
  for (const text of ['已执行升级', '保证收益', '收益增加99倍', 'x'.repeat(201), '<at id="all">', '[点击](https://bad)']) assert.equal(check(text), null);
  assert.equal(validateSafeAiOutput('not json', {}), null);
  assert.match(check('拟升级实现，权限影响需核验。'), /仍待核验/);
  assert.equal(safeAiPublicData({ signature: 'secret', nested: { rawData: 'secret', amount: '1' } }).nested.amount, '1');
});
test('Safe AI: multi-proposal card total brief stays within 200 characters', async () => {
  const f = fixture();
  try {
    f.rows.b = proposal({ key: 'b', safeTxHash: '0x' + 'b'.repeat(64), nonce: 2 });
    f.register([change(f.rows.a), change(f.rows.b)]); await f.service.tick(); await f.service.tick();
    for (const p of f.patches) assert.ok([...p[2].split('\n\n')[1].replace(/<\/?font\b[^>]*>/g, '')].length <= 200);
  } finally { f.clean(); }
});

test('Safe AI: vault and upgrade work precedes approvals; no old reanalysis after record pruning', async () => {
  const f = fixture();
  try {
    f.rows.a = proposal({ actions: [{ kind: 'approval', to: token, spender: target, amount: '100' }] });
    f.register(); f.rows.b = proposal({ safeTxHash: '0x' + 'b'.repeat(64), nonce: 2 });
    f.register([change(f.rows.b)], 'vault'); await f.service.tick();
    assert.equal(JSON.parse(f.calls[0].userMessage).actions[0].kind, 'vaultFactory');
    f.setNow(start + 31 * 60_000); await f.service.tick();
    assert.equal(f.register(), false); assert.equal(f.register([change(f.rows.b)], 'late'), false);
  } finally { f.clean(); }
});
test('Safe evidence: bind verification identity, ABI selectors, old/new implementation and complete sources', async () => {
  const fn = { type: 'function', name: 'transfer', inputs: [{ type: 'address' }, { type: 'uint256' }] };
  assert.equal(abiSelector(fn), '0xa9059cbb');
  let urls = [];
  const fetchFn = async url => { urls.push(url); return new Response(JSON.stringify({ chainId: '56', address: token,
    runtimeMatch: 'match', abi: [fn], sources: { 'a.sol': { content: '中文测试' } } })); };
  const source = await fetchVerifiedSafeSource(token, { fetchFn }); assert.equal(source.verified, true);
  assert.equal((await fetchVerifiedSafeSource(target, { fetchFn })).verified, false);
  assert.ok(urls.every(u => u.startsWith('https://sourcify.dev/server/v2/contract/56/')));
  const collector = createSafeEvidenceCollector({ getContext: () => ({ integrity: {
    contracts: { [safe]: { slots: { implementation: target }, lastStateBlock: 123 } } } }),
    sourceReader: async a => ({ address: a, verified: true, functions: a === target ? [] : source.functions,
      sources: [{ path: 'a.sol', content: 'x'.repeat(5000) }] }) });
  const e = await collector(proposal({ actions: [{ kind: 'upgrade', proxy: safe, implementation: token }] }));
  assert.equal(e.upgrades[0].currentCachedImplementation, target);
  assert.deepEqual(e.upgrades[0].abiAdded, ['transfer(address,uint256)']);
  assert.equal(e.contextIncomplete, true); assert.equal(e.contracts[0].sources[0].content, 'x'.repeat(5000)); assert.equal(e.contracts[0].sources[0].truncated, undefined);
});
test('Safe key helper changes only dedicated credential, never global provider or enabled flags', () => {
  const env = 'AI_MODEL=old\nFLAP_SAFE_AI_ENABLED=false\nFLAP_SAFE_AI_DEEPSEEK_API_KEY=old\nOTHER=123\n';
  const next = updateSafeAiKeyEnv(env, 'test-not-a-real-secret');
  assert.match(next, /AI_MODEL=old\nFLAP_SAFE_AI_ENABLED=false/); assert.match(next, /OTHER=123/);
  assert.equal((next.match(/FLAP_SAFE_AI_DEEPSEEK_API_KEY=/g) || []).length, 1);
  assert.throws(() => updateSafeAiKeyEnv(env, 'bad\nOTHER=1'));
});

test('Safe AI: qualified execution uncertainty passes while an adjacent execution claim fails', () => {
  const evidence = { version: 2, actions: [], evidenceStatus: 'resolved' };
  const check = summary => validateSafeAiOutput(JSON.stringify({ summary }), evidence);
  for (const qualifier of ['是否已执行', '不代表已执行', '不等于提案已完成', '不能证明该提案已执行']) {
    assert.ok(check(`拟变更权限，${qualifier}，具体状态待核验。`));
    assert.equal(check(`拟变更权限，${qualifier}，但已执行成功。`), null);
  }
  assert.equal(check('提案已完成。'), null);
});

test('Safe AI: parsed vault registration must name the factory and direction even without legacy calldata', async () => {
  const evidence = await createSafeEvidenceCollector({ sourceReader: async address => ({address, verified:false}) })({
    safe, actions: [{ kind:'vaultFactory', to:target, vaultFactory:token, enabled:true, official:false, riskLevel:1, category:0 }] });
  assert.equal(evidence.actions[0].parsedParameters.enabled, true);
  assert.equal(evidence.actions[0].category, 0);
  assert.equal(evidence.actions[0].analysisCategory, 'vault');
  assert.match(evidence.actions[0].fact, /category=0/);
  assert.match(evidence.actions[0].fact, /登记为启用/);
  const check = summary => validateSafeAiOutput(JSON.stringify({summary}), evidence);
  assert.equal(check('拟注册金库工厂，但实际工厂地址及参数取值未解析。'), null);
  assert.equal(check('提案拟登记并启用金库工厂0x2222…2222；不代表金库开放。'), null);
  assert.ok(check(`提案拟登记并启用金库工厂${token}；不代表金库开放，资金与退出规则待源码核验。`));
  assert.equal(evidence.actions[0].parsedParameters.factoryDisplay, token);
});


test('Safe AI: full addresses required for tester and upgrade; no shortened or invented address', () => {
  const evidence = { version: 2, evidenceStatus: 'candidate', actions: [{ kind:'unknown', to:target,
    call:{ signature:'setTester(address,bool)', arguments:[{type:'address',value:token},{type:'bool',value:true}] } }] };
  const check = summary => validateSafeAiOutput(JSON.stringify({summary}), evidence);
  assert.ok(check(`候选提案拟通过${target}为${token}开启测试者资格，具体权限待核验。`));
  assert.equal(check(`AI解读：提案解读：候选提案拟通过${target}为${token}开启测试者资格，具体权限待核验。`),
    check(`候选提案拟通过${target}为${token}开启测试者资格，具体权限待核验。`));
  for (const address of ['0x2222…2222','0x2222...2222','0x…2222',token.slice(0,-1)+'3']) {
    assert.equal(check(`候选提案拟为${address}开启测试者资格，具体权限待核验。`), null);
  }
  const upgrade = { version:2, evidenceStatus:'resolved', actions:[{kind:'upgrade',analysisCategory:'upgrade',proxy:target,implementation:token}] };
  assert.ok(validateSafeAiOutput(JSON.stringify({summary:`提案拟将代理${target}升级至实现${token}；存储布局及机制影响待核验。`}),upgrade));
});

test('Safe AI: exact 200 visible characters pass with full address; 201 fails, card never truncates address', async () => {
  const prefix = `提案拟调整${target}的权限；`;
  const summary = prefix + '说明'.repeat(100);
  const exact = [...summary].slice(0, 200 - [...'AI解读：'].length).join('');
  const evidence = {version:2,evidenceStatus:'resolved',actions:[{kind:'ownership',to:target}]};
  assert.equal(validateSafeAiOutput(JSON.stringify({summary:exact}),evidence), exact);
  assert.equal(validateSafeAiOutput(JSON.stringify({summary:exact+'字'}),evidence), null);
  const f=fixture({collectEvidence:async()=>evidence,complete:async()=>JSON.stringify({summary:exact})});
  try {
    f.register(); await f.service.tick();
    const brief=f.patches[0][2].split('\n\n')[1];
    assert.match(brief, /<font color='green'>/);
    const visible=brief.replace(/<\/?font\b[^>]*>/g,'');
    assert.equal([...visible].length,200);
    assert.ok(visible.includes(target)); assert.ok(!visible.includes('…'));
  } finally { f.clean(); }
});
