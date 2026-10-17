// BSC evidence audited 2026-09-25. Roles describe observed activity, not legal identity.
// Never promote an address solely because it shares a Safe owner or receives a transfer.
export const CORE_SAFES = Object.freeze([
  ["0xc68f29BfE2f6c3D95AdB5685592B9F86680968f2", "计价配置"],
  ["0xA04Aa4575bA2327D28869cdD5F0E9165a8EC2CF5", "业务与金库"],
  ["0xCD561eB3828232d3eC174Fb5e321586209FBF535", "运营资金"],
  ["0x8a08D98CBB218fceB318Ecf3aBc1BA43D8A7aB0E", "归集与授权"],
  ["0xF5b72a706fE0c5B2D4f52238BfCe5cF7F068C9eE", "储备资金"],
  ["0x1f96BC88f0794060433Be5F3EC9159a9C4f08A3b", "合约升级"],
  ["0x670FEDB797694432f81576222e816EA2C45aF044", "LP 仓位"],
  ["0x903787b6f03C5c09A335EDD235b0870609ADC7fB", "额度委托"],
]);
export const AUXILIARY_SAFES = Object.freeze([
  "0x3690C3AB4A23910efcF007057f28492edAa9f523",
  "0xf82dC45E843693D9ffd42D6922a5d534c4AbC3C8",
  "0xE1c8bCbd9784E2Efc78C1310Ac3E0c6c568322F0",
]);
export const EXECUTION_WALLETS = [
  "0x81459cD6b1bdf55D01A824350A79a0c201530992",
  // 2026-10-14: received EWYB from the operating Safe, funded V3 pool
  // 0xc60e...a66b and received LP NFT #7668265. Business association, not identity proof.
  "0x57d5656b4212af89f0afcc9680a7fb1d08b5c5c9",
];
export const CORE_OWNERS = [
  "0x25D1BE80daaE074D3FAF7987fb21bdfe791E2BBc",
  "0x29a64981d327c2B4893F1bB84aa9A6266EFBb491",
  "0xA85c06f58B6A2F1BF577B15F20F4AA66D8a334Ec",
  "0x705163Cf642a975d2F0570463BE93AAb7993D1c2",
];
// Read-only BSC verification at block 128109250 (2026-10-17).
// A funded/actively signed Safe is a financial relation, not Portal authority.
export const RELATED_SAFES = ["0x65eA398b9EB6b7A75FD5A1018463039374A0b908"];
export const OBSERVATION_WALLETS = [...CORE_OWNERS,
  "0x01bE21A32c281E98Ef239b89CE9e7b1babA2ABcd",
  "0x0806D3920dAFd50e8cEb189c82D2d3a217e2A045",
  "0x5d9D048471df8961B8E1d2f8bf4332090F1C361a",
  "0x7cec45a85BCdA408b83A7107Bad5bA54F0b0128b",
  "0x3737721dCb6B8737cB8b9223380C59334cbDf4BF",
  "0xde1ffc96E701707299612c9c51CB398460675661",
  "0x0754Ae4F8F9090A95Fd28B473ba1e66dDcfACEFd",
  "0x01db37579E55cE13f4504019025e36047bDaD845",
  "0x1d60bBBEF79Fb9540D271Dbb01925380323A8f66",
  "0xd8B61d3c1fe630d1a827256231c14bd61B0d4Ad5",
  "0x4c08e9166F2cc66dAF63eF9254017a74fe4d9a2f",
  "0x90deF8Dedf8F3218900454aC1Ff736549e8090Fb",
  // Received funds from the operating Safe and RELATED_SAFES; no LP attribution.
  "0x24160Dfca52F12017338932DEcE5c85c4F971aeB",
];
export function observationAddresses(config = {}) {
  return [...new Set([...(config.observationWallets ?? OBSERVATION_WALLETS),
    ...(config.relatedSafes ?? RELATED_SAFES)].map(a => String(a).toLowerCase()))]
    .filter(a => /^0x[a-f0-9]{40}$/.test(a));
}
export const ALLOWANCE_MODULE = "0xcfbfac74c26f8647cbdb8c5caf80bb5b32e43134";
export const COW_SETTLEMENT = "0x9008d19f58aabd9ed0d60971565aa8510560ab41";
// CoW Protocol core deployments: GPv2VaultRelayer on BNB.
// https://github.com/cowprotocol/docs/blob/main/docs/cow-protocol/reference/contracts/core/README.mdx
export const COW_VAULT_RELAYER = "0xc92e8bdf79f0507f65a392b0ab4667716bfe0110";
export const PROXY_ADMINS = ["0xb2480c2d17bf4510701c4def374de6d22e039bd4", "0xc8215c1f9c8aaeac02dbeb7fb5d14e5bb77d607f"];
// Sources: developer.pancakeswap.finance/contracts/{v2,v3,infinity}/... and
// developers.uniswap.org/docs/protocols/v4/deployments (BNB, chainId 56).
export const DEX = Object.freeze({
  v2Factory: "0xca143ce32fe78f1f7019d7d551a6402fc5350c73",
  v3Factory: "0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865",
  v3Positions: "0x46a15b0b27311cedf172ab29e4f4766fbe7f4364",
  v4Manager: "0x28e2ea090877bf75740558f6bfb36a5ffee9e9df",
  v4Positions: "0x7a4a5c919ae2541aed11041a1aeee68f1287f95b",
  clManager: "0xa0ffb9c1ce1fe56963b0321b32e7a0302114058b",
  clPositions: "0x55f4c8aba71a1e923edc303eb4feff14608cc226",
  binManager: "0xc697d2898e0d09264376196696c51d7abbbaa4a9",
});
export const POSITION_MANAGERS = [DEX.v3Positions, DEX.v4Positions, DEX.clPositions];
export const BASE_ASSETS = new Set([
  "0x0000000000000000000000000000000000000000",
  "0x55d398326f99059ff775485246999027b3197955",
  "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
  "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d",
]);
