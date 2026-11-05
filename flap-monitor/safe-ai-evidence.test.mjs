import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeCall, fragmentFromSignature, selectorOf, codeHasSelector, getterFor } from './safe-ai-call-codec.mjs';
import { createSafeEvidenceCollector, safeAiEvidenceData } from './safe-ai-evidence.mjs';
import { fetchVerifiedSafeSource, fetchSelectorCandidates } from './safe-ai-sources.mjs';
const proxy = '0x000042108465206185a077edc3f3fd2b49060000';
const impl = '0x5eeb337337b4065bc5a3c1430db6b68d5958363b';
const account = '0x7daabba7f7c7e6f888068feaa6caf59cd9242885';
const safe = '0xc68f29bfe2f6c3d95adb5685592b9f86680968f2';
const word = n => BigInt(n).toString(16).padStart(64, '0');
const addr = a => a.slice(2).padStart(64, '0');
const encode = (s, words = []) => selectorOf(s) + words.join('');
const sourceMissing = async address => ({ address, verified: false, transient: false });
const selectorNone = async () => ({ candidates: [], transient: false });
const testerData = '0x5373d2c8' + addr(account) + word(1);
const unknown = (rawData = testerData, to = proxy) => ({ kind: 'unknown', to, operation: 0, selector: rawData.slice(0, 10), rawData, callPath: '0' });
const proposal = actions => ({ safe, actions, signatures: 'authorized-full-signature' });
const sourceFor = (address, signatures) => ({ address, verified: true, provider: 'fixture-verified',
  functions: signatures.map(s => ({ signature: s, selector: selectorOf(s), inputs: fragmentFromSignature(s).inputs })), sources: [] });
function rpcFixture({ getterValue = word(0), beacon = false, clone = false } = {}) {
  const calls = [];
  const rpcCall = async (method, params) => {
    calls.push({ method, params });
    if (method === 'eth_blockNumber') return '0x7d8ade2';
    if (method === 'eth_getCode') return params[0] === proxy
      ? clone ? '0x363d3d373d3d3d363d73' + impl.slice(2) + '5af43d82803e903d91602b57fd5bf3' : '0x600000'
      : '0x635373d2c81460005700';
    if (method === 'eth_getStorageAt') return '0x' + (beacon
      ? params[1].startsWith('0xa3f0') ? addr(impl) : word(0)
      : params[1].startsWith('0x3608') ? addr(impl) : word(0));
    if (method === 'eth_call') {
      if (params[0].data === '0x5c60da1b') return '0x' + addr(impl);
      assert.equal(params[0].data, selectorOf('isTester(address)') + addr(account));
      return '0x' + getterValue;
    }
    throw Error('unexpected_method');
  };
  return { calls, rpcCall };
}

test('真实nonce196回放：保留68字节参数，追踪实现并核验tester，仍标为候选', async () => {
  const rpc = rpcFixture();
  const collect = createSafeEvidenceCollector({ ...rpc, sourceReader: sourceMissing, selectorReader: selectorNone });
  const e = await collect(proposal([unknown()]));
  assert.equal(e.actions[0].rawData, testerData);
  assert.equal(e.signatures, 'authorized-full-signature');
  assert.equal(e.proxies[0].implementation, impl);
  assert.equal(e.proxies[0].proxyType, 'EIP-1967');
  assert.equal(e.actions[0].call.signature, 'setTester(address,bool)');
  assert.deepEqual(e.actions[0].call.arguments.map(x => x.value), [account, true]);
  assert.equal(e.actions[0].call.arguments[0].displayValue, account);
  assert.ok(e.actions[0].fact.includes(account));
  assert.ok(!e.actions[0].fact.includes('…'));
  assert.equal(e.actions[0].currentState.value, false);
  assert.equal(e.actions[0].currentState.block, '0x7d8ade2');
  assert.equal(e.actions[0].call.status, 'corroborated_candidate');
  assert.equal(e.evidenceStatus, 'candidate');
  assert.match(e.actions[0].fact, /测试者资格设为开启/);
  assert.ok(rpc.calls.every(c => ['eth_blockNumber', 'eth_getCode', 'eth_getStorageAt', 'eth_call'].includes(c.method)));
  assert.ok(!JSON.stringify(rpc.calls).includes(testerData)); // never simulate/write the proposal itself
});

test('ABI多类型解析：角色、费用、金库、升级bytes与组合tuple', () => {
  for (const [s, words, expected] of [
    ['approve(address,uint256)', [addr(account), word(700000)], [account, '700000']],
    ['grantRole(bytes32,address)', ['a'.repeat(64), addr(account)], ['0x' + 'a'.repeat(64), account]],
    ['setFee(uint16)', [word(25)], ['25']],
    ['setPaused(bool)', [word(0)], [false]],
    ['deposit(uint256,address)', [word(100), addr(account)], ['100', account]],
    ['withdraw(uint256,address,address)', [word(100), addr(account), addr(safe)], ['100', account, safe]],
    ['upgradeToAndCall(address,bytes)', [addr(impl), word(64), word(2), 'abcd'.padEnd(64, '0')], [impl, '0xabcd']],
    ['configure((address,bool),uint256)', [addr(account), word(1), word(9)], [[account, true], '9']],
    ['batch(address[])', [word(32), word(2), addr(account), addr(safe)], [[account, safe]]],
  ]) assert.deepEqual(decodeCall(fragmentFromSignature(s), encode(s, words)).map(a => a.value), expected, s);
});

test('畸形bool、地址、整数、动态偏移、尾部和超大数组均拒绝', () => {
  const cases = [
    ['setTester(address,bool)', [addr(account), word(2)]],
    ['setTester(address,bool)', ['f'.repeat(64), word(1)]],
    ['setFee(uint8)', [word(256)]],
    ['setFee(uint8)', [word(1), word(0)]],
    ['f(bytes)', [word(0), word(0)]],
    ['f(bytes)', [word(32), word(70000)]],
    ['f(address[])', [word(32), word(33)]],
  ];
  for (const [s, words] of cases) assert.throws(() => decodeCall(fragmentFromSignature(s), encode(s, words)), s);
  assert.throws(() => decodeCall(fragmentFromSignature('setTester(address,bool)'), testerData.slice(0, -2)));
  assert.throws(() => decodeCall(fragmentFromSignature('f(bytes,bytes)'), encode('f(bytes,bytes)', [word(64), word(64), word(0)])));
});

test('opcode遍历不将PUSH32内部数据误当函数分发表', () => {
  assert.equal(codeHasSelector('0x7f' + '635373d2c8'.padEnd(64, '0'), '0x5373d2c8'), false);
  assert.equal(codeHasSelector('0x635373d2c814', '0x5373d2c8'), true);
});

test('EIP1167与beacon均追踪，readonly getter不执行写方法', async () => {
  for (const options of [{ clone: true }, { beacon: true }]) {
    const e = await createSafeEvidenceCollector({ ...rpcFixture(options), sourceReader: sourceMissing, selectorReader: selectorNone })(proposal([unknown()]));
    assert.equal(e.proxies[0].implementation, impl);
    assert.match(e.proxies[0].proxyType, options.clone ? /1167/ : /beacon/);
    assert.equal(e.actions[0].call.status, 'corroborated_candidate');
  }
});

test('已验证ABI可解析非内置函数；错误selector/目标不借用ABI', async () => {
  const action = unknown(encode('setLimit(uint256)', [word(5)]));
  const e = await createSafeEvidenceCollector({ sourceReader: async a => sourceFor(a, ['setLimit(uint256)']), selectorReader: selectorNone })(proposal([action]));
  assert.equal(e.actions[0].call.status, 'verified_abi'); assert.equal(e.actions[0].call.arguments[0].value, '5');
  const bad = await createSafeEvidenceCollector({ sourceReader: async () => sourceFor(impl, ['setLimit(uint256)']), selectorReader: selectorNone })(proposal([action]));
  assert.equal(bad.actions[0].call.status, 'unresolved');
});

test('选择器碰撞保留歧义，不依据成功getter擅自选函数', async () => {
  const s1 = 'burn(uint256)', s2 = 'collate_propagate_storage(bytes16)'; assert.equal(selectorOf(s1), selectorOf(s2));
  const e = await createSafeEvidenceCollector({ sourceReader: sourceMissing,
    selectorReader: async () => ({ candidates: [s1, s2].map(signature => ({ signature })), transient: false }) })(proposal([unknown(encode(s1, ['1'.repeat(32) + '0'.repeat(32)]))]));
  assert.equal(e.actions[0].call.status, 'ambiguous'); assert.equal(e.evidenceStatus, 'insufficient');
});

test('RPC与来源失败保留参数，不将未取到资料写成合约未验证', async () => {
  const e = await createSafeEvidenceCollector({ rpcCall: async () => { throw Error('rate-limit'); },
    sourceReader: sourceMissing, selectorReader: async () => ({ candidates: [], transient: true }) })(proposal([unknown('0x12345678' + word(9))]));
  assert.equal(e.actions[0].rawData, '0x12345678' + word(9)); assert.equal(e.evidenceStatus, 'insufficient'); assert.equal(e.retryable, true);
  assert.equal(e.block, null);
});

test('组合提案保留每项证据，未知项不能被已知转账掩盖', async () => {
  const e = await createSafeEvidenceCollector({ sourceReader: sourceMissing, selectorReader: selectorNone })(proposal([
    { kind: 'transfer', to: proxy, asset: proxy, recipient: account, amount: '1' }, unknown('0x12345678' + word(9)),
  ]));
  assert.equal(e.actions.length, 2); assert.equal(e.evidenceStatus, 'insufficient');
});

test('每提案16RPC/4源码/4候选查询上限，停止信号阻止后续请求', async () => {
  let count = 0;
  const rpcCall = async method => { count++; if (method === 'eth_blockNumber') return '0x99'; if (method === 'eth_getCode') return '0x6000'; return '0x' + word(0); };
  const e = await createSafeEvidenceCollector({ rpcCall, sourceReader: sourceMissing, selectorReader: selectorNone })(proposal(Array.from({ length: 20 }, (_, i) => unknown('0x12345678' + word(1), '0x' + (i + 1).toString(16).padStart(40, '0')))));
  assert.ok(count <= 16); assert.ok(e.limits.sourceCount <= 4); assert.ok(e.limits.selectorCount <= 4); assert.equal(e.limits.limited, true);
  const c = new AbortController(); c.abort(); const before = count;
  await assert.rejects(createSafeEvidenceCollector({ rpcCall })(proposal([unknown()]), { signal: c.signal })); assert.equal(count, before);
});

test('已验证Sourcify缺失时使用固定EtherscanV2，完整ABI/源码保留来源', async () => {
  const urls = [];
  const value = await fetchVerifiedSafeSource(proxy, { explorerKey: 'fixture', fetchFn: async url => {
    urls.push(url); return url.includes('sourcify') ? new Response('{}', { status: 404 }) : new Response(JSON.stringify({ status: '1', result: [{
      ABI: JSON.stringify([fragmentFromSignature('setTester(address,bool)')]), SourceCode: 'contract Test {}', ContractName: 'Test', SimilarMatch: '',
    }] }));
  } });
  assert.equal(value.verified, true); assert.equal(value.provider, 'etherscan-v2'); assert.equal(value.functions[0].selector, '0x5373d2c8');
  assert.ok(urls[1].startsWith('https://api.etherscan.io/v2/api?')); assert.ok(urls[1].includes('chainid=56'));
});

test('双选择器来源只接受实际hash匹配，注册库不是验证ABI', async () => {
  const value = await fetchSelectorCandidates('0x5373d2c8', { fetchFn: async url => new Response(JSON.stringify(url.includes('openchain')
    ? { result: { function: { '0x5373d2c8': [{ name: 'setTester(address,bool)' }, { name: 'transfer(address,uint256)' }] } } }
    : { results: [{ text_signature: 'setTester(address,bool)' }] })) });
  assert.equal(value.candidates.length, 1); assert.deepEqual(value.candidates[0].providers, ['openchain', '4byte']);
});

test('签名和完整calldata进入证据，配置凭证不混入；getter严格白名单', () => {
  assert.deepEqual(safeAiEvidenceData({ rawData: testerData, signatures: 'sig', apiKey: 'key', privateKey: 'key' }), { rawData: testerData, signatures: 'sig' });
  assert.equal(getterFor('steal(address)', [{ value: account }], {}, safe), null);
  assert.equal(getterFor('approve(address,uint256)', [{ value: account }], {}, safe).name, 'allowance(address,address)');
});
