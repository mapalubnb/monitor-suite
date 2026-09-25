// Calldata/event layout verified against the aWDH transaction in block 123583333.
// Do not infer new enum names from the older public IPortal interface.
export const SET_QUOTE_CONFIG_SELECTOR = "0x23d89f95";
export const SET_QUOTE_ROUTE_SELECTOR = "0x659e381f";
export const QUOTE_ROUTE_EVENT_TOPIC = "0xc4c3a09d1a80d62ff2d83ac3ebcca6f71162204305f6989cacedc298e4779807";

function words(value) {
  const hex = String(value || "").replace(/^0x/, "");
  if (!hex || hex.length % 64 || !/^[a-f0-9]+$/i.test(hex)) throw new Error("ABI 数据长度或编码无效");
  return hex.toLowerCase().match(/.{64}/g);
}

function uint(word, max = Number.MAX_SAFE_INTEGER) {
  const n = BigInt(`0x${word}`);
  if (n > BigInt(max)) throw new Error("ABI 整数越界");
  return Number(n);
}

function address(word) {
  if (!/^0{24}[a-f0-9]{40}$/.test(word || "")) throw new Error("ABI 地址无效");
  return `0x${word.slice(24)}`;
}

export function decodeQuoteConfigurationCall(data) {
  const w = words(data);
  if (w.length !== 6) throw new Error("计价币配置应包含地址和五个参数");
  return {
    quoteToken: address(w[0]),
    config: Object.fromEntries(["enabled", "defaultCurve", "alternativeCurve", "nativeToQuoteSwapType", "dexId"]
      .map((name, i) => [name, uint(w[i + 1], 255)])),
  };
}

export function decodeQuoteRoute(data) {
  const w = words(data);
  if (w.length < 3 || uint(w[1]) !== 64) throw new Error("兑换路径 offset 无效");
  const count = uint(w[2], 64);
  if (w.length !== 3 + count * 6) throw new Error("兑换路径跳数或 tuple 长度无效");
  const hops = [];
  for (let i = 0; i < count; i++) {
    const row = w.slice(3 + i * 6, 9 + i * 6);
    const signed = BigInt.asIntN(256, BigInt(`0x${row[3]}`));
    if (signed < BigInt(Number.MIN_SAFE_INTEGER) || signed > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("tickSpacing 越界");
    hops.push({
      poolType: uint(row[0]), dexId: uint(row[1]), fee: uint(row[2]),
      tickSpacing: Number(signed), tokenOut: address(row[4]),
      // Preserve the sixth slot until its meaning is verified from the new ABI.
      extraWord: `0x${row[5]}`,
    });
  }
  return { quoteToken: address(w[0]), hops };
}

export function formatQuoteRoute(hops = []) {
  if (!hops.length) return ["兑换路径：清空"];
  const lines = [`🧭 兑换路径：${hops.length} 跳`];
  let from = "WBNB";
  for (const [index, hop] of hops.entries()) {
    const pool = ({ 0: "V2", 1: "V3", 2: "V4" })[hop.poolType] || `类型 ${hop.poolType}`;
    lines.push(`第 ${index + 1} 跳：${from} → ${hop.tokenOut}`);
    lines.push(`池类型 ${pool}｜DEX ID ${hop.dexId}｜fee ${hop.fee}｜tickSpacing ${hop.tickSpacing}`);
    if (hop.extraWord && !/^0x0{64}$/i.test(hop.extraWord)) lines.push(`扩展字段（原值）：${hop.extraWord}`);
    from = hop.tokenOut;
  }
  return lines;
}
