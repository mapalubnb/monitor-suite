import { ALLOWANCE_MODULE, COW_SETTLEMENT, POSITION_MANAGERS } from "./early-signal-catalog.mjs";
import { VAULT_PORTAL_ADDRESS, GRANT_REVOKER_ROLE, AUDITOR_ROLE, portalRoleName } from './vault-portal-v116.mjs';

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
    if (to === VAULT_PORTAL_ADDRESS) {
      if (selector === '0x211be400' && w.length === 0) return { ...base, kind: 'grantRoleAdmin', role: GRANT_REVOKER_ROLE, newAdmin: AUDITOR_ROLE };
      if (selector === '0x6e500b55' && w.length === 1) return { ...base, kind: 'grantRevoke', digest: '0x' + w[0] };
      if (selector === '0x15f9e17a' && w.length === 1) return { ...base, kind: 'grantQuery', digest: '0x' + w[0] };
      if (selector === '0xf2277e85') {
        const token = abiAddress(w[0]);
        const offset = Number(BigInt('0x' + w[1]));
        if (!Number.isSafeInteger(offset) || offset < 96 || offset % 32 || offset / 32 + 8 > w.length) throw Error('审计授权 tuple 偏移无效');
        const tuple = data.slice(10 + offset * 2), tw = hexWords(tuple);
        const riskLevel = Number(abiUint(tw[3]));
        if (riskLevel > 4) throw Error('审计风险等级无效');
        const string = slot => {
          if (BigInt('0x' + tw[slot]) < 256n) throw Error('审计授权字符串覆盖 tuple 头部');
          return Buffer.from(abiBytes(tuple, slot).slice(2), 'hex').toString('utf8');
        };
        if (BigInt('0x' + w[2]) < BigInt(offset + 256)) throw Error('审计授权签名覆盖 tuple 头部');
        const signature = abiBytes(data.slice(10), 2);
        if (signature.length !== 132) throw Error('审计授权签名长度无效');
        return { ...base, kind: 'auditGrantSubmit', token, grantToken: abiAddress(tw[0]), factory: abiAddress(tw[1]),
          deployer: abiAddress(tw[2]), riskLevel, ipfsCid: string(4), artifactId: string(5), manifestHash: '0x' + tw[6], nonce: abiUint(tw[7]) };
      }
    }
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

const ZERO_ADDRESS = `0x${"0".repeat(40)}`;
const MAX_UINT256 = (1n << 256n) - 1n;
const tokenKey = value => String(value || "").toLowerCase();
const addressLink = address => `[${address}](https://bscscan.com/address/${address})`;
const plainLabel = value => String(value || "").replace(/[\\`*_[\]<>\r\n]/g, "");
export const hasTokenDecimals = metadata => Number.isInteger(metadata?.decimals)
  && metadata.decimals >= 0 && metadata.decimals <= 255;

// Exact decimal placement, without Number conversion, rounding or precision loss.
export function formatOperationalAmount(raw, decimals) {
  if (!hasTokenDecimals({ decimals }) || !/^\d+$/.test(String(raw ?? ""))) return "金额待确认（精度或数值未核验）";
  const digits = BigInt(raw).toString().padStart(decimals + 1, "0");
  if (!decimals) return digits;
  const fraction = digits.slice(-decimals).replace(/0+$/, "");
  return digits.slice(0, -decimals) + (fraction ? `.${fraction}` : "");
}

export function operationalAmountToken(action, metadata = {}) {
  if (action.kind === "funding") return "BNB";
  if (action.kind === "allowance" && tokenKey(action.asset) === ZERO_ADDRESS) return "BNB";
  const token = tokenKey(action.asset);
  if (action.kind !== "wrapping") return token;
  // ERC-4626 mint/redeem use shares; deposit/withdraw use underlying assets.
  const underlying = tokenKey(metadata[token]?.underlying);
  if (!/^0x[0-9a-f]{40}$/.test(underlying) || underlying === ZERO_ADDRESS || underlying === token) return "";
  return ["0x94bf804d", "0xba087652"].includes(action.selector) ? token : underlying;
}

export function describeOperationalAction(a, metadata = {}) {
  const token = operationalAmountToken(a, metadata);
  const meta = token === "BNB" ? { decimals: 18, symbol: "BNB" } : metadata[token] || {};
  const unit = plainLabel(meta.symbol || meta.name);
  const formatted = formatOperationalAmount(a.amount, meta.decimals);
  const quantity = hasTokenDecimals(meta) && /^\d+$/.test(String(a.amount ?? ""))
    ? `${formatted}${unit ? ` ${unit}` : ""}` : formatted;
  const unlimited = a.kind === "approval" && /^\d+$/.test(String(a.amount ?? "")) && BigInt(a.amount) === MAX_UINT256;
  const wrapLabel = ({ "0x6e553f65": "存入底层资产", "0x94bf804d": "铸造份额",
    "0xb460af94": "提取底层资产", "0xba087652": "赎回份额" })[a.selector] || "包装／赎回";
  const descriptions = {
    funding: `💸 BNB 调拨\n金额：${quantity}\n接收地址：${addressLink(a.recipient)}`,
    transfer: `💸 代币转账\n资产：${addressLink(a.asset)}\n金额：${quantity}\n接收地址：${addressLink(a.recipient)}`,
    approval: `🔑 代币授权\n资产：${addressLink(a.asset)}\n额度：${unlimited ? "无限额度" : quantity}\n授权对象：${addressLink(a.spender)}`,
    positionTransfer: `LP NFT ${a.asset} #${a.tokenId} → ${a.recipient}`,
    cowPresign: `CoW 订单${a.signed ? "预签名" : "撤销预签名"}：${a.orderUid}`,
    upgrade: `合约升级 ${a.proxy} → ${a.implementation}`,
    role: `${a.granted ? "授予" : "撤销"}角色：${portalRoleName(a.role, a.to)}\n角色标识：${a.role}\n账户：${addressLink(a.account)}`,
    grantRoleAdmin: `🔑 角色管理权限迁移\n角色：${portalRoleName(a.role, a.to)}\n新管理角色：${portalRoleName(a.newAdmin, a.to)}\n仅改变管理关系，不直接授予账户权限。`,
    grantRevoke: `🚫 撤销未使用的审计授权\n授权摘要：${a.digest}\n不删除已上链的审计报告。`,
    grantQuery: `🔎 查询审计授权使用状态\n授权摘要：${a.digest}\n只读查询，不改变链上权限。`,
    auditGrantSubmit: `📝 通过签名授权提交审计报告\n代币：${addressLink(a.token)}\n授权绑定代币：${addressLink(a.grantToken)}\n工厂：${addressLink(a.factory)}\n指定提交者：${addressLink(a.deployer)}\n风险等级：${a.riskLevel}\n报告 CID：${plainLabel(a.ipfsCid)}\nUI 标识：${plainLabel(a.artifactId)}\n授权 nonce：${a.nonce}\n授权有效性仍需链上核验。`,
    ownership: `管理员变更 → ${a.account}`,
    module: `${a.enabled ? "启用" : "停用"} Safe 模块 ${a.module}`,
    allowance: `${a.reason} ${a.selector}${a.delegate ? `\n委托：${addressLink(a.delegate)}` : ""}${a.asset ? `\n资产：${token === "BNB" ? "BNB" : addressLink(a.asset)}\n额度：${quantity}\n重置间隔：${a.resetMinutes} 分钟` : ""}`,
    wrapping: `${wrapLabel}\n包装合约：${addressLink(a.asset)}\n${token ? `数量：${quantity}\n计量资产：${addressLink(token)}` : "金额待确认（底层资产映射未核验）"}`,
  };
  return descriptions[a.kind] || `未解析调用 ${a.to}｜${a.selector}｜${a.reason || ""}`;
}
