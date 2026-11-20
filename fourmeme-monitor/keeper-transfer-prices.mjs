import { withDeadline } from '../shared/request-deadline.mjs';
import { KNOWN_ASSETS, VERIFIED_ASSET_DISPLAY } from './address-catalog.mjs';

export const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
export const NATIVE_BNB = '0x' + '0'.repeat(40);
export const KEEPER_TRANSFER_LIMIT_WEI = 10n ** 16n;

const BNB_QUOTE = 'coingecko:binancecoin';
const assets = { ...KNOWN_ASSETS, ...VERIFIED_ASSET_DISPLAY };
const keys = [BNB_QUOTE, ...Object.keys(assets).filter(a => a !== WBNB).map(a => `bsc:${a}`)];
const priceUrl = `https://coins.llama.fi/prices/current/${keys.join(',')}?searchWidth=5m`;
const maxAgeMs = 5 * 60_000;

export function createKeeperTransferPrices({ now = Date.now, fetchImpl = fetch } = {}) {
  const cache = new Map();
  let nextRefresh = 0, pending = null;
  const isFresh = (timestamp, at) => Number.isSafeInteger(timestamp) && timestamp <= at + 30_000 && at - timestamp <= maxAgeMs;
  return {
    refresh() {
      if (pending || now() < nextRefresh) return pending;
      nextRefresh = now() + 60_000;
      pending = withDeadline(async signal => {
        const resp = await fetchImpl(priceUrl, { signal });
        if (!resp.ok) { await resp.body?.cancel(); return; }
        const { coins } = await resp.json();
        signal.throwIfAborted();
        const at = now();
        for (const key of keys) {
          const quote = coins?.[key], timestamp = quote?.timestamp * 1000;
          if (typeof quote?.price !== 'number' || !isFresh(timestamp, at)
              || !Number.isFinite(quote.confidence) || quote.confidence < 0.9) continue;
          const units = Math.round(quote.price * 1e8);
          if (!Number.isSafeInteger(units) || units <= 0) continue;
          if (timestamp >= (cache.get(key)?.timestamp ?? 0)) cache.set(key, { units: BigInt(units), timestamp });
        }
      }, 3000).catch(() => {}).finally(() => { pending = null; });
      return pending;
    },
    priceOf(asset) {
      const quote = cache.get(asset === NATIVE_BNB ? BNB_QUOTE : `bsc:${asset}`);
      return quote && isFresh(quote.timestamp, now()) ? quote.units : undefined;
    },
    summary() {
      const at = now();
      return { bnbReady: isFresh(cache.get(BNB_QUOTE)?.timestamp, at),
        freshTokens: keys.slice(1).filter(k => isFresh(cache.get(k)?.timestamp, at)).length, supportedTokens: keys.length - 1 };
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
