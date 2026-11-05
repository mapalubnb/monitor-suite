import { withDeadline } from '../shared/request-deadline.mjs';
import { abiSelector, abiSignature, isAddress, fragmentFromSignature } from './safe-ai-call-codec.mjs';

export async function boundedJson(url, { fetchFn = fetch, signal, maxBytes = 2_000_000, timeoutMs = 6000 } = {}) {
  return withDeadline(async activeSignal => {
    const r = await fetchFn(url, { signal: activeSignal, redirect: 'error' });
    if (!r.ok) { const e = Error('http_status'); e.status = r.status; throw e; }
    if (Number(r.headers?.get('content-length')) > maxBytes) throw Error('source_size');
    let text = '', count = 0; const decoder = new TextDecoder();
    for await (const chunk of r.body) { count += chunk.byteLength; if (count > maxBytes) throw Error('source_size'); text += decoder.decode(chunk, { stream: true }); }
    return JSON.parse(text + decoder.decode());
  }, timeoutMs, signal);
}
function normalized(address, abi, sources, provider, extra = {}) {
  if (!Array.isArray(abi)) throw Error('abi_invalid');
  const functions = abi.filter(f => f.type === 'function').map(f => ({
    signature: abiSignature(f), selector: abiSelector(f), mutability: f.stateMutability, inputs: f.inputs || [], outputs: f.outputs || [],
  }));
  return { address: address.toLowerCase(), verified: true, provider, functions, abi,
    sources: Object.entries(sources || {}).map(([path, v]) => ({ path, content: typeof v === 'string' ? v : v.content || '' }))
      .sort((a, b) => Number(/openzeppelin|node_modules|interfaces|libraries|\/lib\//i.test(a.path)) - Number(/openzeppelin|node_modules|interfaces|libraries|\/lib\//i.test(b.path))), ...extra };
}

// Fixed domains only. "Unavailable" describes our evidence, never the verification status of a contract.
export async function fetchVerifiedSafeSource(address, { fetchFn = fetch, signal, explorerKey = '' } = {}) {
  if (!isAddress(address)) return { address, verified: false, reason: '地址无效' };
  const issues = []; let transient = false;
  try {
    const d = await boundedJson(`https://sourcify.dev/server/v2/contract/56/${address}?fields=abi,sources`, { fetchFn, signal, maxBytes: Infinity });
    if (String(d.chainId) !== '56' || d.address?.toLowerCase() !== address.toLowerCase() || !['match', 'exact_match'].includes(d.runtimeMatch)) throw Error('verification_mismatch');
    return normalized(address, d.abi, d.sources, 'sourcify', { verifiedAt: d.verifiedAt });
  } catch (e) { transient ||= ![404, 400].includes(e.status); issues.push(e.status === 404 ? 'Sourcify未收录'
    : e.status ? `Sourcify HTTP ${e.status}` : e.name === 'TimeoutError' ? 'Sourcify请求超时' : 'Sourcify连接失败或身份不匹配'); }
  if (explorerKey && !signal?.aborted) {
    try {
      const url = new URL('https://api.etherscan.io/v2/api');
      for (const [k, v] of Object.entries({ chainid: '56', module: 'contract', action: 'getsourcecode', address, apikey: explorerKey })) url.searchParams.set(k, v);
      const d = await boundedJson(url.toString(), { fetchFn, signal, maxBytes: Infinity });
      const row = d.status === '1' && d.result?.length === 1 ? d.result[0] : null;
      // Similar-match sources are not an exact-address verification.
      if (!row?.SourceCode || row.SimilarMatch) { transient ||= !row; throw Error('explorer_unavailable'); }
      let text = row.SourceCode, sources;
      if (text.startsWith('{{')) text = text.slice(1, -1);
      if (text.startsWith('{')) { const json = JSON.parse(text); sources = json.sources || json; }
      else sources = { [row.ContractName || 'Contract.sol']: { content: text } };
      return normalized(address, JSON.parse(row.ABI), sources, 'etherscan-v2');
    } catch { issues.push('区块浏览器验证资料不可用'); }
  } else issues.push('未配置Etherscan V2 Key，未查询浏览器API');
  return { address: address.toLowerCase(), verified: false, transient, issues, reason: '未取得匹配的验证源码/ABI（不等于合约未验证）' };
}

export async function fetchSelectorCandidates(selector, { fetchFn = fetch, signal } = {}) {
  if (!/^0x[\da-f]{8}$/.test(selector || '')) return { candidates: [], transient: false };
  let transient = false; const found = new Map();
  const sources = [
    ['openchain', `https://api.openchain.xyz/signature-database/v1/lookup?function=${selector}&filter=true`, d => (d.result?.function?.[selector] || []).map(v => v.name)],
    ['4byte', `https://www.4byte.directory/api/v1/signatures/?hex_signature=${selector}`, d => (d.results || []).map(v => v.text_signature)],
  ];
  // Both registries contribute candidates so conflicting signatures remain ambiguous.
  for (const [provider, url, extract] of sources) {
    if (signal?.aborted) break;
    try {
      const d = await boundedJson(url, { fetchFn, signal, maxBytes: 100_000, timeoutMs: 3500 });
      for (const signature of extract(d).slice(0, 16)) {
        try { const f = fragmentFromSignature(signature); if (abiSelector(f) !== selector) continue;
          const canonical = abiSignature(f); found.set(canonical, { signature: canonical, inputs: f.inputs,
            providers: [...(found.get(canonical)?.providers || []), provider] });
        } catch { /* Invalid registry suggestions are not ABI evidence. */ }
      }
    } catch { transient = true; }
  }
  return { candidates: [...found.values()], transient };
}
