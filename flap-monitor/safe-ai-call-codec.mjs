import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

export const selectorOf = text => '0x' + bytesToHex(keccak_256(utf8ToBytes(text))).slice(0, 8);
export const abiType = p => p.type?.startsWith('tuple')
  ? `(${(p.components || []).map(abiType).join(',')})${p.type.slice(5)}` : p.type === 'uint' ? 'uint256' : p.type === 'int' ? 'int256' : p.type;
export const abiSignature = f => `${f.name}(${(f.inputs || []).map(abiType).join(',')})`;
export const abiSelector = f => selectorOf(abiSignature(f));
export const isAddress = a => /^0x[a-f\d]{40}$/i.test(a || '');

// These are candidates, never a target-contract ABI. A matching selector alone proves no semantics.
export const CALL_CANDIDATES = [
  'setTester(address,bool)', 'setWhitelist(address,bool)', 'setWhitelisted(address,bool)',
  'setFee(uint256)', 'setFeeRecipient(address)', 'setPaused(bool)', 'pause()', 'unpause()',
  'upgradeTo(address)', 'upgradeToAndCall(address,bytes)', 'upgrade(address,address)', 'upgradeAndCall(address,address,bytes)',
  'approve(address,uint256)', 'transfer(address,uint256)', 'transferFrom(address,address,uint256)',
  'grantRole(bytes32,address)', 'revokeRole(bytes32,address)', 'transferOwnership(address)', 'acceptOwnership()',
  'enableModule(address)', 'disableModule(address,address)', 'changeThreshold(uint256)',
  'addOwnerWithThreshold(address,uint256)', 'removeOwner(address,address,uint256)', 'swapOwner(address,address,address)',
  'deposit(uint256,address)', 'mint(uint256,address)', 'withdraw(uint256,address,address)', 'redeem(uint256,address,address)',
];

function splitTypes(text) {
  const out = []; let depth = 0, start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(') depth++; if (text[i] === ')') depth--;
    if (depth < 0 || depth > 6) throw Error('type_depth');
    if (text[i] === ',' && depth === 0) { out.push(text.slice(start, i)); start = i + 1; }
  }
  if (depth) throw Error('type_unbalanced');
  if (text) out.push(text.slice(start));
  if (out.length > 32) throw Error('too_many_parameters');
  return out;
}
function param(type) {
  if (type.startsWith('(')) {
    let depth = 0, end = -1;
    for (let i = 0; i < type.length; i++) { if (type[i] === '(') depth++; if (type[i] === ')' && --depth === 0) { end = i; break; } }
    if (end < 0) throw Error('tuple_invalid');
    return { type: 'tuple' + type.slice(end + 1), components: splitTypes(type.slice(1, end)).map(param) };
  }
  return { type: type.replace(/^uint(?=\[|$)/, 'uint256').replace(/^int(?=\[|$)/, 'int256') };
}
export function fragmentFromSignature(text) {
  if (typeof text !== 'string' || text.length > 600 || !/^[A-Za-z_][A-Za-z\d_]*\([A-Za-z\d_(),\[\]]*\)$/.test(text)) throw Error('signature_invalid');
  const i = text.indexOf('(');
  return { type: 'function', name: text.slice(0, i), inputs: splitTypes(text.slice(i + 1, -1)).map(param) };
}
function array(p) {
  const m = p.type.match(/^(.*)\[(\d*)\]$/);
  if (!m) return null;
  const count = m[2] ? Number(m[2]) : null;
  if (count !== null && (!Number.isSafeInteger(count) || count > 32)) throw Error('array_limit');
  return { child: { ...p, type: m[1] }, count };
}
function dynamic(p, depth = 0) {
  if (depth > 6) throw Error('type_depth');
  const a = array(p);
  return a ? a.count === null || dynamic(a.child, depth + 1) : ['bytes', 'string'].includes(p.type)
    || p.type === 'tuple' && (p.components || []).some(x => dynamic(x, depth + 1));
}
function width(p) {
  if (dynamic(p)) return 32;
  const a = array(p);
  return a ? a.count * width(a.child) : p.type === 'tuple' ? p.components.reduce((n, x) => n + width(x), 0) : 32;
}

// Bounded ABI reader: strict scalar padding, forward offsets, non-overlapping tails, no unbounded arrays.
export function decodeCall(fragment, calldata) {
  if (!/^0x[\da-f]*$/i.test(calldata || '') || calldata.length > 131082 || calldata.slice(0, 10).toLowerCase() !== abiSelector(fragment)) throw Error('calldata_invalid');
  const hex = calldata.slice(10).toLowerCase(); if (hex.length % 64) throw Error('word_alignment');
  const bytes = hex.length / 2; let budget = 256;
  const word = offset => {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset % 32 || offset + 32 > bytes) throw Error('abi_bounds');
    return hex.slice(offset * 2, offset * 2 + 64);
  };
  const number = offset => { const n = BigInt('0x' + word(offset)); if (n > 65536n) throw Error('offset_limit'); return Number(n); };
  function tuple(params, base, depth) {
    if (depth > 6 || params.length > 32) throw Error('decode_limit');
    const head = params.reduce((n, p) => n + width(p), 0); let cursor = base, end = base + head;
    const values = [];
    for (const p of params) {
      let at = cursor;
      if (dynamic(p)) { at = base + number(cursor); if (at < end || at % 32) throw Error('tail_overlap'); }
      const v = value(p, at, depth + 1); values.push(v.value);
      if (dynamic(p)) end = v.end;
      cursor += width(p);
    }
    return { value: values, end };
  }
  function value(p, at, depth) {
    if (--budget < 0 || depth > 7) throw Error('decode_limit');
    const a = array(p);
    if (a) { const count = a.count ?? number(at); if (count > 32) throw Error('array_limit'); return tuple(Array(count).fill(a.child), at + (a.count === null ? 32 : 0), depth); }
    if (p.type === 'tuple') return tuple(p.components || [], at, depth);
    if (['bytes', 'string'].includes(p.type)) {
      const length = number(at), end = at + 32 + Math.ceil(length / 32) * 32;
      if (length > 16384 || end > bytes || /[^0]/.test(hex.slice((at + 32 + length) * 2, end * 2))) throw Error('bytes_bounds');
      // Keep opaque data intact locally; the caller decides which existing signatures enter AI evidence.
      return { value: '0x' + hex.slice((at + 32) * 2, (at + 32 + length) * 2), end };
    }
    const w = word(at), n = BigInt('0x' + w); let v;
    if (p.type === 'address') { if (!/^0{24}/.test(w)) throw Error('address_padding'); v = '0x' + w.slice(24); }
    else if (p.type === 'bool') { if (n > 1n) throw Error('bool_invalid'); v = n === 1n; }
    else if (/^u?int\d+$/.test(p.type)) {
      const bits = Number(p.type.match(/\d+/)[0]); if (bits < 8 || bits > 256 || bits % 8) throw Error('int_width');
      const signed = p.type.startsWith('int'), mask = (1n << BigInt(bits)) - 1n;
      const low = n & mask, negative = signed && (low >> BigInt(bits - 1)) === 1n;
      if ((negative ? low | (((1n << 256n) - 1n) ^ mask) : low) !== n) throw Error('int_padding');
      v = (negative ? low - (1n << BigInt(bits)) : low).toString();
    } else if (/^bytes\d+$/.test(p.type)) {
      const length = Number(p.type.slice(5)); if (length < 1 || length > 32 || /[^0]/.test(w.slice(length * 2))) throw Error('bytes_padding');
      v = '0x' + w.slice(0, length * 2);
    } else throw Error('unsupported_type');
    return { value: v, end: at + 32 };
  }
  const result = tuple(fragment.inputs || [], 0, 0);
  if (result.end !== bytes) throw Error('trailing_calldata');
  return (fragment.inputs || []).map((p, i) => ({ name: p.name || `arg${i}`, type: abiType(p), value: result.value[i] }));
}

export function codeHasSelector(code, selector) {
  if (!/^0x[\da-f]+$/i.test(code || '')) return false;
  // Walk opcodes, ignoring PUSH data; a match is supporting evidence, not an ABI proof.
  const b = Buffer.from(code.slice(2), 'hex');
  for (let i = 0; i < b.length; i++) {
    const op = b[i]; if (op === 0x63 && '0x' + b.subarray(i + 1, i + 5).toString('hex') === selector) return true;
    if (op >= 0x60 && op <= 0x7f) i += op - 0x5f;
  }
  return false;
}

export function categoryFor(name = '') {
  if (/upgrade/i.test(name)) return 'upgrade';
  if (/vault|deposit|withdraw|redeem|mint|harvest|claim|reward/i.test(name)) return 'vault';
  if (/tester|whitelist|role|owner|module|threshold|pause|enable|disable|guard/i.test(name)) return 'permission';
  if (/approve|allowance/i.test(name)) return 'approval';
  if (/swap|liquidity|position/i.test(name)) return 'liquidity';
  if (/transfer|fund/i.test(name)) return 'funding';
  return 'configuration';
}

// Only these read-only getters may be called; never execute a proposal's method to "test" it.
export function getterFor(signature, args, action, safe) {
  const values = args?.map(a => a.value) || [];
  const addrWord = a => isAddress(a) ? a.slice(2).toLowerCase().padStart(64, '0') : null;
  const call = (name, words, type) => words.every(w => typeof w === 'string' && /^[\da-f]{64}$/i.test(w))
    ? { name, data: selectorOf(name) + words.join(''), type } : null;
  if (signature === 'setTester(address,bool)') return call('isTester(address)', [addrWord(values[0])], 'bool');
  if (signature === 'setWhitelisted(address,bool)') return call('isWhitelisted(address)', [addrWord(values[0])], 'bool');
  if (['pause()', 'unpause()', 'setPaused(bool)'].includes(signature)) return call('paused()', [], 'bool');
  if (signature === 'transferOwnership(address)' || action.kind === 'ownership') return call('owner()', [], 'address');
  if (signature === 'changeThreshold(uint256)' || action.kind === 'safeThreshold') return call('getThreshold()', [], 'uint256');
  if (['grantRole(bytes32,address)', 'revokeRole(bytes32,address)'].includes(signature) || action.kind === 'role')
    return call('hasRole(bytes32,address)', [String(values[0] || action.role).replace(/^0x/, ''), addrWord(values[1] || action.account)], 'bool');
  if (signature === 'approve(address,uint256)' || action.kind === 'approval')
    return call('allowance(address,address)', [addrWord(safe), addrWord(values[0] || action.spender)], 'uint256');
  if (['enableModule(address)', 'disableModule(address,address)'].includes(signature) || action.kind === 'module')
    return call('isModuleEnabled(address)', [addrWord(action.module || values[signature.startsWith('disable') ? 1 : 0])], 'bool');
  if (action.kind === 'safeOwner' || /^(addOwnerWithThreshold|removeOwner|swapOwner)\(/.test(signature))
    return call('isOwner(address)', [addrWord(action.account || values[signature.startsWith('add') ? 0 : 1])], 'bool');
  if (action.kind === 'wrapping' || /^(deposit|withdraw|redeem|mint)\(/.test(signature)) return call('asset()', [], 'address');
  return null;
}

export function decodeGetter(result, type) {
  const f = { name: 'read', inputs: [{ type }] };
  return decodeCall(f, abiSelector(f) + String(result).slice(2))[0].value;
}
