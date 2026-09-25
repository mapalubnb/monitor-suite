import { ALLOWANCE_MODULE, COW_SETTLEMENT, POSITION_MANAGERS } from "./early-signal-catalog.mjs";

export const hexWords = data => {
  const h = String(data || "").replace(/^0x/, "").toLowerCase();
  if (!/^(?:[a-f0-9]{64})*$/.test(h)) throw new Error("ABI 字长无效");
  return h.match(/.{64}/g) || [];
};
export const abiAddress = word => {
  if (!/^0{24}[a-f0-9]{40}$/.test(word || "")) throw new Error("ABI 地址无效");
  return `0x${word.slice(24)}`;
};
export const abiUint = word => {
  if (!/^[a-f0-9]{64}$/.test(word || "")) throw new Error("ABI 整数无效");
  return BigInt(`0x${word}`).toString();
};
export function abiBytes(data, slot) {
  const h = data.replace(/^0x/, "");
  const w = hexWords(h);
  const offset = Number(BigInt(`0x${w[slot]}`));
  if (!Number.isSafeInteger(offset) || offset % 32 || offset < (slot + 1) * 32 || offset * 2 + 64 > h.length) throw new Error("ABI offset 越界");
  const length = Number(BigInt(`0x${h.slice(offset * 2, offset * 2 + 64)}`));
  if (!Number.isSafeInteger(length) || length > 131072 || (offset + 32 + length) * 2 > h.length) throw new Error("ABI bytes 越界");
  return `0x${h.slice((offset + 32) * 2, (offset + 32 + length) * 2)}`;
}

// Classification never implies intent to enable a quote token. Unknown calldata is retained.
export function decodeOperationalCall(transaction, path = "0") {
  const to = String(transaction.to || "").toLowerCase();
  const data = String(transaction.data || "0x").toLowerCase();
  const selector = data.slice(0, 10);
  const base = { to, selector, operation: Number(transaction.operation || 0), callPath: path, quoteToken: "", rawData: data };
  const unknown = reason => ({ ...base, kind: "unknown", reason });
  try {
    if (base.operation !== 0) return unknown("非 CALL，保留原始调用");
    if (data === "0x") return { ...base, kind: "funding", recipient: to, amount: BigInt(transaction.value || 0).toString(), asset: "BNB" };
    const w = hexWords(data.slice(10));
    if (selector === "0xa9059cbb" && w.length === 2) return { ...base, kind: "transfer", asset: to, recipient: abiAddress(w[0]), amount: abiUint(w[1]) };
    if (selector === "0x095ea7b3" && w.length === 2) return { ...base, kind: "approval", asset: to, spender: abiAddress(w[0]), amount: abiUint(w[1]) };
    if (["0x42842e0e", "0xb88d4fde", "0x23b872dd"].includes(selector) && POSITION_MANAGERS.includes(to)) {
      return { ...base, kind: "positionTransfer", asset: to, sender: abiAddress(w[0]), recipient: abiAddress(w[1]), tokenId: abiUint(w[2]) };
    }
    if (selector === "0xec6cb13f" && to === COW_SETTLEMENT) {
      const orderUid = abiBytes(data.slice(10), 0);
      if (orderUid.length !== 114 || !/^0{63}[01]$/.test(w[1])) throw new Error("CoW 订单 UID/bool 无效");
      return { ...base, kind: "cowPresign", orderUid, signed: w[1].endsWith("1") };
    }
    if (["0x99a88ec4", "0x9623609d"].includes(selector)) return { ...base, kind: "upgrade", proxy: abiAddress(w[0]), implementation: abiAddress(w[1]) };
    if (["0x2f2ff15d", "0xd547741f"].includes(selector) && w.length === 2) return { ...base, kind: "role", role: `0x${w[0]}`, account: abiAddress(w[1]), granted: selector === "0x2f2ff15d" };
    if (selector === "0xf2fde38b" && w.length === 1) return { ...base, kind: "ownership", account: abiAddress(w[0]) };
    if (selector === "0x610b5925" && w.length === 1) return { ...base, kind: "module", enabled: true, module: abiAddress(w[0]) };
    if (selector === "0xe009cfde" && w.length === 2) return { ...base, kind: "module", enabled: false, module: abiAddress(w[1]) };
    if (to === ALLOWANCE_MODULE) {
      if (selector === "0xbeaeb388" && w.length === 5) return { ...base, kind: "allowance", delegate: abiAddress(w[0]), asset: abiAddress(w[1]), amount: abiUint(w[2]), resetMinutes: abiUint(w[3]), reason: "设置额度" };
      if (selector === "0xe71bdf41" && w.length === 1) return { ...base, kind: "allowance", delegate: abiAddress(w[0]), reason: "添加委托人" };
      return { ...base, kind: "allowance", reason: "额度模块调用（参数原值已保留）" };
    }
    if (["0x6e553f65", "0x94bf804d", "0xb460af94", "0xba087652"].includes(selector)) return { ...base, kind: "wrapping", asset: to, amount: abiUint(w[0]), reason: "存入/铸造/赎回调用，资产映射需链上核验" };
    return unknown("未覆盖的操作，需核验 ABI");
  } catch (error) { return unknown(error.message); }
}

export function describeOperationalAction(a) {
  const descriptions = {
    funding: `BNB 调拨 → ${a.recipient}｜原始数量 ${a.amount}`,
    transfer: `代币转账 ${a.asset} → ${a.recipient}｜原始数量 ${a.amount}`,
    approval: `代币授权 ${a.asset} → ${a.spender}｜原始额度 ${a.amount}`,
    positionTransfer: `LP NFT ${a.asset} #${a.tokenId} → ${a.recipient}`,
    cowPresign: `CoW 订单${a.signed ? "预签名" : "撤销预签名"}：${a.orderUid}`,
    upgrade: `合约升级 ${a.proxy} → ${a.implementation}`,
    role: `${a.granted ? "授予" : "撤销"}角色 ${a.role} → ${a.account}`,
    ownership: `管理员变更 → ${a.account}`,
    module: `${a.enabled ? "启用" : "停用"} Safe 模块 ${a.module}`,
    allowance: `${a.reason} ${a.selector}${a.delegate ? `｜委托 ${a.delegate}` : ""}${a.asset ? `｜资产 ${a.asset}｜原始额度 ${a.amount}｜重置间隔 ${a.resetMinutes} 分钟` : ""}`,
    wrapping: `${a.reason}｜${a.asset}｜原始数量 ${a.amount}`,
  };
  return descriptions[a.kind] || `未解析调用 ${a.to}｜${a.selector}｜${a.reason || ""}`;
}
