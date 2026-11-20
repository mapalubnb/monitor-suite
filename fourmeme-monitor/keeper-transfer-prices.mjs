import { withDeadline } from '../shared/request-deadline.mjs';
import { KNOWN_ASSETS, VERIFIED_ASSET_DISPLAY } from './address-catalog.mjs';

export const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
export const NATIVE_BNB = '0x' + '0'.repeat(40);
export const KEEPER_TRANSFER_LIMIT_WEI = 10n ** 17n; // 0.1 BNB

const BNB_QUOTE = 'coingecko:binancecoin';
const assets = { ...KNOWN_ASSETS, ...VERIFIED_ASSET_DISPLAY };
const tokens = Object.keys(assets).filter(a => a !== WBNB);
const keyFor = asset => asset === NATIVE_BNB ? BNB_QUOTE : `bsc:${asset}`;
const keys = [BNB_QUOTE, ...tokens.map(keyFor)];
const priceUrl = `https://coins.llama.fi/prices/current/${keys.join(',')}?searchWidth=5m`;
const maxAgeMs = 5 * 60_000;
const dexQuoteTokens = new Set([...Object.keys(KNOWN_ASSETS), '0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d',
  '0xce24439f2d9c6a2289f741120fe202248b666666']);

export function createKeeperTransferPrices({ now = Date.now, fetchImpl = fetch } = {}) {
  const cache = new Map();
  let nextRefresh = 0, pending = null;
  const isFresh = (timestamp, at) => Number.isSafeInteger(timestamp) && timestamp <= at + 30_000 && at - timestamp <= maxAgeMs;
  const isCached = (key, at) => isFresh(cache.get(key)?.timestamp, at);
  function storeQuote(key, price, timestamp) {
    const units = Math.round(price * 1e8);
    if (Number.isSafeInteger(units) && units > 0 && timestamp >= (cache.get(key)?.timestamp ?? 0)) {
      cache.set(key, { units: BigInt(units), timestamp });
    }
  }
  function request(url, consume) {
    return withDeadline(async signal => {
      const response = await fetchImpl(url, { signal });
      if (!response.ok) { await response.body?.cancel(); return; }
      const data = await response.json();
      signal.throwIfAborted();
      consume(data, response);
    }, 3000).catch(() => {});
  }
  async function refreshQuotes() {
    await request(priceUrl, ({ coins }) => {
      const at = now();
      for (const key of keys) {
        const quote = coins?.[key], timestamp = quote?.timestamp * 1000;
        if (typeof quote?.price !== 'number' || !isFresh(timestamp, at)
            || !Number.isFinite(quote.confidence) || quote.confidence < 0.9) continue;
        storeQuote(key, quote.price, timestamp);
      }
    });
    const at = now(), missing = new Set(tokens.filter(asset => !isCached(keyFor(asset), at)));
    if (!isCached(BNB_QUOTE, at)) missing.add(WBNB);
    if (!missing.size) return;
    await request(`https://api.dexscreener.com/tokens/v1/bsc/${[...missing].join(',')}`, (pairs, response) => {
      if (!Array.isArray(pairs)) return;
      const receivedAt = now();
      const timestamp = Math.min(receivedAt - Number(response.headers?.get('age') || 0) * 1000,
        Date.parse(response.headers?.get('date')) || receivedAt);
      if (!isFresh(timestamp, receivedAt)) return;
      const best = new Map();
      for (const pair of pairs) {
        if (typeof pair?.baseToken?.address !== 'string' || typeof pair?.quoteToken?.address !== 'string'
            || typeof pair?.priceUsd !== 'string') continue;
        const token = pair.baseToken.address.toLowerCase(), quote = pair.quoteToken.address.toLowerCase();
        const liquidity = pair?.liquidity?.usd, volume = pair?.volume?.h24, price = Number(pair?.priceUsd);
        if (pair?.chainId !== 'bsc' || !missing.has(token) || !dexQuoteTokens.has(quote)
            || !Number.isFinite(liquidity) || liquidity < 25_000 || !Number.isFinite(volume) || volume < 1000
            || !Number.isFinite(price) || price <= 0 || liquidity <= (best.get(token)?.liquidity ?? 0)) continue;
        best.set(token, { liquidity, price });
      }
      for (const [token, { price }] of best) storeQuote(token === WBNB ? BNB_QUOTE : keyFor(token), price, timestamp);
    });
  }
  return {
    refresh() {
      if (pending || now() < nextRefresh) return pending;
      nextRefresh = now() + 60_000;
      pending = refreshQuotes().finally(() => { pending = null; });
      return pending;
    },
    priceOf(asset) {
      const quote = cache.get(keyFor(asset));
      return quote && isFresh(quote.timestamp, now()) ? quote.units : undefined;
    },
    summary() {
      const at = now();
      return { bnbReady: isCached(BNB_QUOTE, at),
        freshTokens: tokens.filter(a => isCached(keyFor(a), at)).length, supportedTokens: tokens.length };
    },
  };
}

export function keeperTransferValueWei(totals, priceOf, assetOf) {
  let bnb = (totals.get(NATIVE_BNB) || 0n) + (totals.get(WBNB) || 0n);
  let usd = 0n;
  // Keep all token fractions until after adding them. Round up only when
  // converting the final result to wei, so just above the limit still alerts.
  const scale = 77;
  for (const [token, raw] of totals) {
    if (!raw || token === NATIVE_BNB || token === WBNB) continue;
    const decimals = assetOf(token)?.decimals, usdPrice = priceOf?.(token);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > scale || typeof usdPrice !== 'bigint' || usdPrice <= 0n) return undefined;
    usd += raw * usdPrice * 10n ** BigInt(scale - decimals);
  }
  if (usd) {
    const bnbUsd = priceOf?.(NATIVE_BNB);
    if (typeof bnbUsd !== 'bigint' || bnbUsd <= 0n) return undefined;
    const denominator = bnbUsd * 10n ** BigInt(scale - 18);
    bnb += (usd + denominator - 1n) / denominator;
  }
  return bnb;
}
