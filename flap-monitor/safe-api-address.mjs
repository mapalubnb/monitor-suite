import { keccak_256 } from '@noble/hashes/sha3';

// EIP-55 at the HTTP boundary; state indexes continue using lowercase addresses.
export function safeApiAddress(value) {
  const address = String(value || '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) throw Error('Safe API 地址无效');
  const body = address.slice(2);
  const digest = Buffer.from(keccak_256(new TextEncoder().encode(body))).toString('hex');
  return '0x' + [...body].map((c, i) => parseInt(digest[i], 16) >= 8 ? c.toUpperCase() : c).join('');
}
