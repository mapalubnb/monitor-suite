import { withDeadline } from '../shared/request-deadline.mjs';
import { abiSelector, categoryFor, decodeCall, fragmentFromSignature, isAddress, selectorOf } from './safe-ai-call-codec.mjs';

const ZERO = '0x' + '0'.repeat(40);
const IMPL = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const BEACON = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';
const lower = a => String(a).toLowerCase();
const addressWord = x => /^0x0{24}[a-f\d]{40}$/i.test(x || '') && x !== '0x' + '0'.repeat(64) ? '0x' + x.slice(-40).toLowerCase() : null;
const tool = (name, description, properties, required = Object.keys(properties)) => ({ type: 'function', function: {
  name, description, parameters: { type: 'object', properties, required, additionalProperties: false },
} });
const str = { type: 'string' }, num = { type: 'integer' };
// Numeric literals from verified executable source are evidence; comments, strings and addresses are not numeric facts.
export function sourceNumericFacts(evidence) {
  const facts = new Set();
  for (const c of evidence.contracts || []) if (c.verified) for (const source of c.sources || []) {
    const code = source.content.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, ' ').replace(/0x[a-f\d_]+/gi, ' ');
    for (const match of code.matchAll(/(?<![\w.])(\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?[\d_]+)?)(?![\w.])/g)) {
      const literal = match[1].replaceAll('_', ''), [mantissa, exponent = '0'] = literal.toLowerCase().split('e');
      facts.add(mantissa);
      const exp = Number(exponent); if (!Number.isInteger(exp) || Math.abs(exp) > 1000) continue;
      const [whole, fraction = ''] = mantissa.split('.'), digits = whole + fraction, point = whole.length + exp;
      let expanded = point <= 0 ? '0.' + '0'.repeat(-point) + digits : point >= digits.length ? digits + '0'.repeat(point - digits.length) : digits.slice(0, point) + '.' + digits.slice(point);
      expanded = expanded.replace(/^0+(?=\d)/, ''); if (expanded.includes('.')) expanded = expanded.replace(/0+$/, '').replace(/\.$/, '');
      facts.add(expanded);
    }
  }
  return facts;
}
export const SAFE_RESEARCH_TOOLS = [
  tool('contract_source', '获取关联地址的完整验证ABI、源码文件清单；path为空返回全部完整源码，指定path返回完整文件。文件过大可用source_lines分段读取，不静默截断。', { address: str, path: str }, ['address']),
  tool('source_lines', '按明确行范围读取已验证源码，返回总行数；可继续读取剩余部分。', { address: str, path: str, start: num, end: num }),
  tool('resolve_proxy', '在同一核验区块追踪EIP1967/beacon/1167实现。', { address: str }),
  tool('read_contract', '只读查询已验证ABI的view/pure函数，或标准token/owner getter。args传十进制整数字符串、完整地址、true/false或bytes；不接受交易或任意RPC。', { address: str, signature: str, args: { type: 'array', items: str } }),
  tool('recent_events', '查询关联地址最近至多128块的指定topic0事件，返回原始日志，不能视为该Safe提案执行证明。', { address: str, topic0: str, blocks: num }),
  tool('decode_call', '使用目标或当前实现的验证ABI重新解析指定callPath；不以选择器库候选代替验证ABI。', { callPath: str }),
  tool('decimal_amount', '精确换算证据中的整数：raw / 10^decimals * multiplier；提供单位依据。程序计算并记录派生事实。', { raw: str, decimals: num, multiplier: str, unitEvidence: str }),
];

export function missingResearchEvidence(evidence) {
  const missing = [], observations = evidence.observations || [];
  for (const action of evidence.actions || []) {
    // A verified LlamaPay ABI/source gives enough semantics to require these facts. Other contracts still use general research tools.
    if (action.call?.signature !== 'createStream(address,uint216)' || action.call.status !== 'verified_abi') continue;
    const source = evidence.contracts?.find(c => c.verified && (c.address === action.to || evidence.proxies?.some(p => p.address === action.to && p.implementation === c.address)));
    if (!source?.sources?.some(s => /contract\s+LlamaPay\b/.test(s.content))) continue;
    const tokenResult = observations.find(o => o.address === action.to && o.signature === 'token()');
    const token = tokenResult?.values?.[0]?.value;
    if (!token) missing.push(`查询${action.to}的token()确定支付资产`);
    else for (const signature of ['symbol()', 'decimals()']) if (!observations.some(o => o.address === token && o.signature === signature)) missing.push(`查询${token}的${signature}`);
    const rate = action.call.arguments?.[1]?.value;
    const quote = source.sources.flatMap(s => s.content.split('\n')).find(line => /amountPerSec.*decimals/.test(line))?.trim();
    if (!(evidence.derivedFacts || []).some(d => d.raw === rate && d.multiplier === '2592000')) missing.push(`使用decimal_amount将原始速率${rate}按源码确认的内部精度换算30天金额，multiplier=2592000${quote ? '；unitEvidence可直接使用源码原文：' + JSON.stringify(quote) : ''}`);
  }
  return [...new Set(missing)];
}

// Only observed addresses and their verified graph may be queried. No arbitrary URL, shell, signing or broadcast tool exists.
export function createSafeResearchTools(evidence, { rpcCall, sourceReader, signal } = {}) {
  const allowed = new Set(), contracts = new Map(), proxies = new Map(), cache = new Map();
  const observations = evidence.observations ||= [], derived = evidence.derivedFacts ||= [];
  let calls = 0, rpcCount = 0, sourceCount = 0;
  function discover(value) {
    for (const a of JSON.stringify(value)?.match(/0x[a-f\d]{40}(?![a-f\d])/gi) || []) if (lower(a) !== ZERO) allowed.add(lower(a));
  }
  discover([evidence.safe, evidence.actions, evidence.proxies, evidence.upgrades]);
  for (const c of evidence.contracts || []) { contracts.set(lower(c.address), c); allowed.add(lower(c.address)); if (c.verified) discover(c.sources); }
  for (const p of evidence.proxies || []) if (p.implementation) proxies.set(lower(p.address), lower(p.implementation));
  const check = address => { address = lower(address); if (!isAddress(address) || !allowed.has(address)) throw Error('address_not_in_evidence'); return address; };
  async function rpc(method, params) {
    if (!rpcCall || !evidence.block) throw Error('fixed_block_unavailable');
    if (++rpcCount > 20) throw Error('research_rpc_budget');
    return withDeadline(() => rpcCall(method, params), 6000, signal);
  }
  async function source(address) {
    address = check(address);
    let c = contracts.get(address);
    if (!c?.verified) {
      if (++sourceCount > 8) throw Error('research_source_budget');
      c = await sourceReader(address, { signal });
      if (lower(c?.address) !== address) throw Error('source_address_mismatch');
      contracts.set(address, c);
      if (c.verified) discover(c.sources);
      const i = evidence.contracts.findIndex(x => lower(x.address) === address);
      if (i < 0) evidence.contracts.push(c); else evidence.contracts[i] = c;
    }
    if (!c?.verified) throw Error('verified_source_unavailable');
    return c;
  }
  async function resolve(address) {
    address = check(address);
    if (proxies.has(address)) return { address, implementation: proxies.get(address), block: evidence.block };
    const code = await rpc('eth_getCode', [address, evidence.block]);
    const clone = code?.match(/^0x363d3d373d3d3d363d73([a-f\d]{40})5af43d82803e903d91602b57fd5bf3$/i);
    let implementation = clone ? '0x' + clone[1] : addressWord(await rpc('eth_getStorageAt', [address, IMPL, evidence.block]));
    let beacon;
    if (!implementation && code !== '0x') {
      beacon = addressWord(await rpc('eth_getStorageAt', [address, BEACON, evidence.block]));
      if (beacon) implementation = addressWord(await rpc('eth_call', [{ to: beacon, data: selectorOf('implementation()'), gas: '0x186a0' }, evidence.block]));
    }
    if (implementation) { implementation = lower(implementation); allowed.add(implementation); proxies.set(address, implementation); }
    const result = { address, implementation, beacon, block: evidence.block };
    observations.push({ tool: 'resolve_proxy', ...result }); return result;
  }
  async function abiFunctions(address) {
    const candidates = [address, proxies.get(address)].filter(Boolean), found = [];
    for (const a of candidates) { try { found.push(...(await source(a)).functions); } catch {} }
    return found;
  }
  const standard = { 'token()': 'address', 'asset()': 'address', 'owner()': 'address', 'decimals()': 'uint8',
    'symbol()': 'string', 'name()': 'string', 'balanceOf(address)': 'uint256', 'allowance(address,address)': 'uint256' };
  function encodeWord(p, value) {
    if (p.type === 'address' && isAddress(value)) return value.slice(2).toLowerCase().padStart(64, '0');
    if (p.type === 'bool' && ['true', 'false'].includes(value)) return (value === 'true' ? '1' : '0').padStart(64, '0');
    if (/^u?int\d+$/.test(p.type) && /^-?\d+$/.test(value)) {
      let n = BigInt(value), bits = BigInt(p.type.match(/\d+/)[0]), signed = p.type.startsWith('int');
      if (n < (signed ? -(1n << (bits - 1n)) : 0n) || n >= (1n << (signed ? bits - 1n : bits))) throw Error('integer_range');
      if (n < 0n) n += 1n << 256n; return n.toString(16).padStart(64, '0');
    }
    if (/^bytes\d+$/.test(p.type) && new RegExp(`^0x[a-f\\d]{${Number(p.type.slice(5)) * 2}}$`, 'i').test(value)) return value.slice(2).padEnd(64, '0');
    throw Error('unsupported_read_argument');
  }
  async function execute(name, args = {}) {
    signal?.throwIfAborted();
    if (++calls > 24) throw Error('research_tool_budget');
    const key = JSON.stringify([name, args]); if (cache.has(key)) return cache.get(key);
    let result;
    if (name === 'contract_source' || name === 'source_lines') {
      const c = await source(args.address);
      const files = c.sources || [], manifest = files.map(f => ({ path: f.path, lines: f.content.split('\n').length }));
      if (name === 'source_lines') {
        const file = files.find(f => f.path === args.path); if (!file) throw Error('source_path_not_found');
        const lines = file.content.split('\n');
        if (!Number.isInteger(args.start) || !Number.isInteger(args.end) || args.start < 1 || args.end < args.start || args.start > lines.length) throw Error('source_line_range');
        result = { address: c.address, path: args.path, start: args.start, end: Math.min(args.end, lines.length), totalLines: lines.length, content: lines.slice(args.start - 1, args.end).join('\n') };
      } else {
        const sources = args.path ? files.filter(f => f.path === args.path) : files;
        if (args.path && !sources.length) throw Error('source_path_not_found');
        result = { ...c, sources, manifest };
      }
    } else if (name === 'resolve_proxy') result = await resolve(args.address);
    else if (name === 'read_contract') {
      const address = check(args.address), functions = standard[args.signature]
        ? [contracts.get(address), contracts.get(proxies.get(address))].flatMap(c => c?.verified ? c.functions || [] : [])
        : await abiFunctions(address);
      const f = functions.find(f => f.signature === args.signature && ['view', 'pure'].includes(f.mutability));
      if (!f && !standard[args.signature]) throw Error('read_requires_verified_view_abi');
      const fragment = f || { ...fragmentFromSignature(args.signature), outputs: [{ type: standard[args.signature] }] };
      if (!Array.isArray(args.args) || args.args.length !== fragment.inputs.length) throw Error('argument_count');
      const data = selectorOf(args.signature) + fragment.inputs.map((p, i) => encodeWord(p, args.args[i])).join('');
      const raw = await rpc('eth_call', [{ to: address, data, gas: '0x493e0' }, evidence.block]);
      const out = { name: 'readResult', inputs: fragment.outputs || [] };
      const values = decodeCall(out, abiSelector(out) + raw.slice(2)).map(v => ({ ...v, value: v.type === 'string' ? Buffer.from(v.value.slice(2), 'hex').toString('utf8') : v.value }));
      result = { address, signature: args.signature, args: args.args, values, block: evidence.block, abi: f ? 'verified' : 'standard_getter_candidate', note: '当前只读结果，不证明提案执行' };
      discover(values.filter(v => v.type === 'address')); observations.push({ tool: name, ...result });
    } else if (name === 'recent_events') {
      const address = check(args.address);
      if (!/^0x[a-f\d]{64}$/i.test(args.topic0) || !Number.isInteger(args.blocks) || args.blocks < 1 || args.blocks > 128) throw Error('event_range_invalid');
      const end = BigInt(evidence.block), start = end - BigInt(args.blocks) + 1n;
      result = { address, fromBlock: '0x' + (start < 0n ? 0n : start).toString(16), toBlock: evidence.block };
      result.logs = await rpc('eth_getLogs', [{ ...result, topics: [args.topic0] }]);
      observations.push({ tool: name, ...result });
    } else if (name === 'decode_call') {
      const a = evidence.actions.find(a => String(a.callPath) === String(args.callPath));
      if (!a || Number(a.operation || 0) !== 0) throw Error('call_path_unavailable');
      const functions = await abiFunctions(check(a.to));
      const matches = [];
      for (const f of functions.filter(f => f.selector === a.selector)) {
        try { const parameters = decodeCall({ ...f, name: f.signature.split('(')[0] }, a.rawData);
          if (!matches.some(x => x.signature === f.signature)) matches.push({ signature: f.signature, arguments: parameters }); } catch {}
      }
      if (matches.length !== 1) throw Error(matches.length ? 'ambiguous_verified_abi' : 'matching_verified_abi_unavailable');
      a.call = { ...matches[0], status: 'verified_abi' }; discover(a.call.arguments);
      a.analysisCategory = categoryFor(a.call.signature.split('(')[0]);
      const checkRow = evidence.checks?.find(c => c.callPath === a.callPath);
      if (checkRow) Object.assign(checkRow, { status: 'verified_abi', function: a.call.signature });
      evidence.evidenceStatus = evidence.actions.some(a => ['unresolved', 'ambiguous'].includes(a.call?.status)) ? 'insufficient'
        : evidence.actions.some(a => ['candidate', 'corroborated_candidate'].includes(a.call?.status)) ? 'candidate' : 'resolved';
      result = { callPath: a.callPath, ...a.call };
    } else if (name === 'decimal_amount') {
      const { raw, decimals, multiplier, unitEvidence } = args;
      if (!/^-?\d+$/.test(raw) || !/^\d+$/.test(multiplier) || !Number.isInteger(decimals) || decimals < 0 || decimals > 255 || !unitEvidence?.trim()) throw Error('calculation_invalid');
      const facts = new Set([...(JSON.stringify([evidence.actions, observations]).replace(/0x[a-f\d]+/gi, '').match(/-?\d+(?:\.\d+)?/g) || []), ...sourceNumericFacts(evidence)]);
      if (!facts.has(raw)) throw Error('calculation_raw_not_observed');
      const unitSource = [...contracts.values()].filter(c => c.verified).flatMap(c => (c.sources || []).map(s => ({ ...s, address: c.address })))
        .find(s => unitEvidence.length >= 8 && s.content.includes(unitEvidence));
      const unitGetter = observations.find(o => o.signature === 'decimals()' && o.values?.[0]?.value === String(decimals) && unitEvidence === `decimals()=${decimals}`);
      if (!unitSource && !unitGetter) throw Error('unit_evidence_requires_exact_source_quote_or_decimals_getter');
      const n = BigInt(raw) * BigInt(multiplier), sign = n < 0n ? '-' : '', digits = (n < 0n ? -n : n).toString().padStart(decimals + 1, '0');
      const exact = sign + (decimals ? digits.slice(0, -decimals) + '.' + digits.slice(-decimals) : digits);
      const scale = 10n ** BigInt(decimals), cents = ((n < 0n ? -n : n) * 100n + scale / 2n) / scale;
      const rounded = sign + cents / 100n + '.' + (cents % 100n).toString().padStart(2, '0');
      result = { raw, decimals, multiplier, unitEvidence, unitSource: unitSource ? { address: unitSource.address, path: unitSource.path } : { address: unitGetter.address, getter: 'decimals()' }, exact, rounded, roundedDisplay: rounded.replace(/\.00$/, '').replace(/(\.\d)0$/, '$1'),
        ...(BigInt(multiplier) % 86400n === 0n ? { days: (BigInt(multiplier) / 86400n).toString() } : {}), note: '单位依据须由源码/状态支持；rounded为约数' };
      derived.push(result);
    } else throw Error('unknown_research_tool');
    cache.set(key, result); return result;
  }
  evidence.contracts ||= [];
  return { tools: SAFE_RESEARCH_TOOLS, execute, stats: () => ({ toolCalls: calls, rpcCount, sourceCount }) };
}

const cooldowns = new Map();
export async function requestSafeResearch({ provider, messages, tools, requireTool = false, thinking = false, signal, fetchFn = fetch }) {
  const cooldownKey = `${provider.apiUrl}|${provider.apiKey}`;
  if ((cooldowns.get(cooldownKey) || 0) > Date.now()) throw Error('model_provider_cooldown');
  return withDeadline(async activeSignal => {
    const response = await fetchFn(provider.apiUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}` },
      body: JSON.stringify({ model: provider.model, messages, temperature: 0.1, max_tokens: 4096,
        thinking: { type: thinking && !requireTool ? 'enabled' : 'disabled' }, ...(thinking && !requireTool ? { reasoning_effort: 'low' } : {}),
        ...(tools?.length ? { tools, ...(requireTool ? { tool_choice: 'required' } : {}) } : { response_format: { type: 'json_object' } }) }), signal: activeSignal });
    if (!response.ok) {
      const body = await response.text();
      if ([401, 402, 403].includes(response.status)) cooldowns.set(cooldownKey, Date.now() + 30 * 60_000);
      const context = [400, 413, 422].includes(response.status) && /context|tokens|maximum.*length|too.large/i.test(body);
      const reason = /reasoning_content/i.test(body) ? 'reasoning_context_invalid' : /tool_choice/i.test(body) ? 'tool_choice_invalid' : '';
      const e = Error(context ? 'model_context_limit' : `model_http_${response.status}${reason ? ':' + reason : ''}`); e.status = response.status; throw e;
    }
    const json = await response.json(), message = json.choices?.[0]?.message;
    if (!message || json.choices?.[0]?.finish_reason === 'length') throw Error('model_output_incomplete');
    return message;
  }, 45_000, signal);
}

function manifestEvidence(evidence) {
  return { ...evidence, sourceDelivery: '接口报告上下文超限；本次只提供完整文件目录，源码未读取部分不能当已审查。请用source_lines分段获取必要内容。',
    contracts: evidence.contracts?.map(c => ({ ...c, sources: c.sources?.map(s => ({ path: s.path, totalLines: s.content.split('\n').length, contentNotIncluded: true })) })) };
}

// Full inputs by default; only an explicit provider context error switches to a disclosed, pageable source manifest.
export async function runSafeResearch({ evidence, session, provider, systemPrompt, validate, diagnose, request = requestSafeResearch, signal, log = () => {} }) {
  let messages = [{ role: 'system', content: systemPrompt + '\n工作分两阶段：先利用只读工具补齐事实，再压缩为短摘要；不要为了短文而跳过核验。源码先读实际调用及其内部函数、继承和修饰器；资金流须查资产getter和单位，使用decimal_amount计算，摘要只用换算后的金额，不重复原始整数。区分合约内余额记账与钱包真实转账：按秒计提不等于每秒自动转账；核对资金托管位置、实际转账触发及取消结算逻辑再解释。unitEvidence填写源码中解释精度的原文片段，或已读取的decimals()=数值。组合调用逐项识别。同类多收款提案优先保留各收款方完整地址、币种及金额，目标合约地址已在原卡时可以整项省去，不缩写。证据足够后输出summary JSON，正文尽量150字以内，绝不超过180字。最多6轮查询，不能虚构工具结果。' },
    { role: 'user', content: JSON.stringify(evidence) }];
  let repairs = 0, manifest = false, requests = 0, summarizing = false;
  for (let round = 0; round < 8; round++) {
    signal?.throwIfAborted();
    const tools = round < 6 && !summarizing ? session.tools : [];
    const missing = missingResearchEvidence(evidence);
    if (missing.length) messages.push({ role: 'user', content: `还缺少关键事实，先调用工具完成：${missing.join('；')}。工具确实返回失败才可明确说明该缺项，不能省略金额直接宣布分析完成。` });
    let message;
    try { requests++; message = await request({ provider, messages, tools, requireTool: missing.length > 0 && !summarizing, thinking: summarizing, signal }); }
    catch (e) {
      if (e.message === 'model_context_limit' && !manifest) {
        manifest = true; log('Safe AI 上下文容量不足，明确切换源码目录并按需分段读取');
        messages = [messages[0], { role: 'user', content: JSON.stringify(manifestEvidence(evidence)) }]; summarizing = false; continue;
      }
      if (e.message === 'model_context_limit' && manifest) {
        // A requested full file can itself exceed the provider window. Replace its delivery with an explicit error, never an undisclosed prefix.
        let replaced = false;
        for (const m of messages) if (m.role === 'tool') {
          try { const value = JSON.parse(m.content);
            if (value.sources || typeof value.content === 'string') {
              m.content = JSON.stringify({ error: 'source_result_exceeds_model_context', address: value.address, path: value.path,
                totalLines: value.totalLines, manifest: value.manifest || value.sources?.map(s => ({ path: s.path, lines: s.content.split('\n').length })),
                instruction: '本次源码未送达模型，使用source_lines请求较小行范围；已读源码不代表整个文件已审查。' }); replaced = true;
            }
          } catch {}
        }
        if (replaced) { log('Safe AI 单次源码工具结果超出接口容量，要求明确缩小读取行范围'); continue; }
      }
      throw e;
    }
    if (message.tool_calls?.length) {
      if (!tools.length || message.tool_calls.length > 24) throw Error('research_tool_budget');
      messages.push({ role: 'assistant', content: message.content || null, tool_calls: message.tool_calls, ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}) });
      for (const call of message.tool_calls) {
        let value;
        try { value = await session.execute(call.function.name, JSON.parse(call.function.arguments)); }
        catch (e) { value = { error: e.message, evidenceUnavailable: true }; (evidence.researchFailures ||= []).push({ tool: call.function.name, reason: e.message }); }
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(value) });
      }
      continue;
    }
    if (missing.length && !(evidence.researchFailures || []).length) {
      messages.push({ role: 'assistant', content: message.content || '', ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}) }); continue;
    }
    if (missing.length && !/未能|未取得|尚缺|缺少|未确认|无法确认/.test(message.content || '')) {
      messages.push({ role: 'assistant', content: message.content || '', ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}) }, { role: 'user', content: '工具查询失败，摘要必须明确尚缺的币种或金额事实，不能忽略后当作完整分析。' }); continue;
    }
    if (!summarizing) {
      // Thinking starts a clean conversation with the complete evidence ledger. Never mix non-thinking tool messages into a thinking tool history.
      const readSourceEvidence = manifest ? messages.filter(m => m.role === 'tool').map(m => { try { return JSON.parse(m.content); } catch { return null; } })
        .filter(v => v && (v.sources || typeof v.content === 'string')) : [];
      messages = [messages[0], { role: 'user', content: JSON.stringify({ evidence: manifest ? manifestEvidence(evidence) : evidence,
        readSourceEvidence, draft: message.content, instruction: '证据采集已结束。独立核对草稿事实：明确提案动作、单位和资金记账/转账区别。描述余额时必须区分钱包余额与存入合约的余额，不添加未查询的余额条件。收款人参数不等于调用权限；检查msg.sender及修饰器，无限制时说“调用withdraw时向收款方转账”，不能说“收款方withdraw才转账”。金库源码充分时，核心资金规则和管理权限比官方标记、风险编号或UI绑定细节优先；creatorFee按收取时机解释，收入中支付创建者的比例称创建者分成，不能写成创建时收费。升级仅解释有证据的差异。草稿不是事实来源，不得沿用其中无证据结论；资料未取得不能写成没有验证源码，official字段不能断言身份。只输出200字内summary JSON。' }) }];
      summarizing = true; continue;
    }
    const summary = validate(message.content, evidence);
    if (summary) { evidence.researchIncomplete = missing;
      return { summary, stats: { ...session.stats(), modelRequests: requests, contextManifest: manifest, incomplete: missing.length > 0 } }; }
    const reason = diagnose(message.content, evidence); log(`Safe AI 输出校验未通过：${reason}`);
    if (++repairs > 2) throw Error(`output_validation:${reason}`);
    let length = 0; try { length = [...JSON.parse(message.content).summary].length; } catch {}
    messages.push({ role: 'assistant', content: message.content || '', ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}) }, { role: 'user', content: `输出未通过：${reason}，当前正文${length}字符。只修正摘要，保留动作、各收款完整地址及换算后的金额，不要原始整数；删除原卡已有的目标合约地址和冗余介绍；正文控制在150字符左右，最多180字符。不要重复查询已有证据。只输出summary JSON。` });
  }
  throw Error('research_round_budget');
}
