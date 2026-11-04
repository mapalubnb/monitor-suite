// BSC relationships verified 2026-11-03. Priority never implies official identity.
export const OWNER_MANAGEMENT_CONTRACT = '0x9e27098dcd8844bcc6287a557e0b4d09c86b8a4b';
export const NESTED_OWNER_SAFE = '0x1d60bbbef79fb9540d271dbb01925380323a8f66';
export const OWNER_CATALOG = Object.freeze(Object.fromEntries([
  ['0x25d1be80daae074d3faf7987fb21bdfe791e2bbc', '核心权限｜多 Safe 签名人', 'core'],
  ['0x29a64981d327c2b4893f1bb84aa9a6266efbb491', '核心权限｜多 Safe 签名人', 'core'],
  ['0xa85c06f58b6a2f1bf577b15f20f4aa66d8a334ec', '核心权限｜多 Safe 签名人', 'core'],
  ['0x705163cf642a975d2f0570463be93aab7993d1c2', '核心权限｜配置与升级签名人', 'core'],
  [OWNER_MANAGEMENT_CONTRACT, '核心权限｜业务 Safe 合约 owner／管理入口', 'core'],
  ['0x01db37579e55ce13f4504019025e36047bdad845', '核心权限｜运营资金与辅助 Safe 签名人', 'core'],
  ['0x0806d3920dafd50e8ceb189c82d2d3a217e2a045', '核心权限｜业务 Safe／关联 Safe 唯一签名人', 'core'],
  [NESTED_OWNER_SAFE, '核心权限｜归集与储备 Safe 的嵌套 Safe owner', 'core'],
  ['0x01be21a32c281e98ef239b89ce9e7b1baba2abcd', '核心权限｜业务 Safe 签名人', 'core'],
  ['0x5d9d048471df8961b8e1d2f8bf4332090f1c361a', '核心权限｜业务 Safe 签名人', 'core'],
  ['0x7cec45a85bcda408b83a7107bad5ba54f0b0128b', '核心权限｜业务 Safe 签名人', 'core'],
  ['0x3737721dcb6b8737cb8b9223380c59334cbdf4bf', '核心权限｜业务 Safe 签名人', 'core'],
  ['0xde1ffc96e701707299612c9c51cb398460675661', '核心权限｜业务 Safe 签名人', 'core'],
  ['0x0754ae4f8f9090a95fd28b473ba1e66ddcfacefd', '核心权限｜业务 Safe 签名人', 'core'],
  ['0xd8b61d3c1fe630d1a827256231c14bd61b0d4ad5', '增强观察｜辅助 Safe 签名人', 'enhanced'],
  ['0x4c08e9166f2cc66daf63ef9254017a74fe4d9a2f', '增强观察｜辅助 Safe 签名人', 'enhanced'],
  ['0x90def8dedf8f3218900454ac1ff736549e8090fb', '增强观察｜辅助 Safe 签名人', 'enhanced'],
  ['0x7b1184b1e0b58c16586bfdf4e410e7b72b8c7592', '二级关联｜嵌套 Safe 签名人', 'nested'],
  ['0x3fc791a56f99da498dfddac14e4081737d9f4d07', '二级关联｜嵌套 Safe 签名人', 'nested'],
  ['0x0cd8aef58e65c201835506291305f9529e7d1a12', '二级关联｜嵌套 Safe 签名人', 'nested'],
  ['0x2009337fd3f640768f07cdf1c28aa7f94ab396ff', '二级关联｜嵌套 Safe 签名人', 'nested'],
  ['0x949ab4eeef712770861eaaa956d4e3a26ba9a8cf', '二级关联｜嵌套 Safe 签名人', 'nested'],
  ['0xab80a862ff1c4cc2eb694a79c6c6c2fe07a71f32', '二级关联｜嵌套 Safe 签名人', 'nested'],
].map(([address, label, priority]) => [address, Object.freeze({ label, priority, verifiedAt: '2026/11/3' })])));
export const CORE_PERMISSION_OWNERS = Object.keys(OWNER_CATALOG).filter(a => OWNER_CATALOG[a].priority === 'core');
export const ownerLabel = address => OWNER_CATALOG[String(address || '').toLowerCase()]?.label || '关联 owner｜角色待核验';
export const ownerLink = address => `[${address}](https://bscscan.com/address/${address})（${ownerLabel(address)}）`;
// Builders and delivery/edit paths may all call this. Keep labels inline and
// idempotent, without changing link destinations or matching a hash/calldata prefix.
export function annotateOwners(content) {
  let text = String(content || '').replace(
    /(?:\r?\n){0,2}Owner 标注（权限关系，不代表官方身份）：\r?\n(?:• \[0x[a-f\d]{40}\]\(https:\/\/bscscan\.com\/address\/0x[a-f\d]{40}\)：[^\r\n]*(?:\r?\n|$))+/gi,
    '\n');
  // Old queued content can already carry a label; preserve other parentheses.
  for (const { label } of Object.values(OWNER_CATALOG)) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp(`（${escaped}）(?:\\s*（${escaped}）)+`, 'g'), `（${label}）`);
  }
  return text.replace(
    /\[[^\]\n]*\]\(https?:\/\/[^\s)]+\)|https?:\/\/[^\s<>()]+|(?<![\w])0x[a-f\d]{40}(?![a-f\d])/gi,
    (token, offset) => {
      // Consume entire Markdown links / bare URLs before looking for addresses.
      const address = token.startsWith('[') ? token.match(/^\[(0x[a-f\d]{40})\]/i)?.[1]
        : /^0x[a-f\d]{40}$/i.test(token) ? token : null;
      const entry = address && OWNER_CATALOG[address.toLowerCase()];
      if (!entry) return token;
      const label = `（${entry.label}）`;
      return text.slice(offset + token.length).trimStart().startsWith(label) ? token : token + label;
    }).trimEnd();
}
