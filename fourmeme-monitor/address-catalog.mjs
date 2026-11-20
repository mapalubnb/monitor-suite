// Evidence and scope are documented in ADDRESS_MONITORING.md. Signers are
// permission-linked accounts, not proof that every transaction is official.
const rows = [
  ['0x088b79aaeb498d30dd32589681ac4e9b00e96f04', '用户指定关注地址', 'user', '用户指定，官方归属待独立核验'],
  ['0x46cdf0f5e4776421e07673b02ee83a6eab944fd7', 'BNC4 回购销毁地址', 'public', '官方公开公告'],
  ['0x4baf0e36e2937beb44d046266f28e4954bf44d32', '官方公开生态钱包', 'public', '官方迁移公告'],
  ['0x161dd0cfdb0aa25e2504f725655ef9b799375b71', 'Four.meme 核心 Safe', 'safe', '链上管理权限'],
  ['0x7cf6b1c47b4a199a4af6da22726c2c8bfa64a3f1', 'OpenFour Treasury', 'treasury', 'FeeRouter treasury()'],
  ['0xee5617402708bc9560772f753213ddae852c38ed', 'OpenFour Rebate Keeper', 'treasury', 'FeeRouter rebate()'],
  ['0xf384b0d1250db293b06a23ab23dfea282853ba11', '已停用公开钱包', 'historical', '历史观察，不代表当前官方行为'],
  ['0xe096774fef711a0b28cb7bc9839b892bd5e2f603', 'TokenManager 系列部署者', 'creator', '现有创建者监控'],
  ['0x8558fe0c40ccad66f7e6c2900bf4d8b5c96cbd19', 'OpenFour 部署者', 'creator', '现有创建者监控'],
  ['0x27b8a3829c232c4d8be4085395cd736404e5f5e6', 'TokenManagerBNW 部署者', 'creator', '现有创建者监控'],
  ['0xb779a009e99512ca46bc76a4df26e6dd58ee22ea', 'AirDrop 部署者', 'creator', '现有创建者监控'],
  ...['0xbcc640be713e73d9960c6a5d8d5958e77bf2ef85', '0xa9b9e257ddae54e587b8271d98f7d305cc5c2346',
    '0x4682a6915f3c9723251cc514768baf6947a670cd', '0xd4a89d4941abccb4f866f91a45dac92322e8ebb5',
    '0x99950366c89d529ca212081b73cfeefa56e9c89a', '0x7d122b71b3ca97af60ee69d28a430378b5056003',
    '0xe01cd3c97e0a1ef6b45c8beb568f3e0fe7168972'].map(a => [a, 'Safe 签名人', 'signer', '权限关联，不将个人活动等同官方操作']),
];
export const FOURMEME_ADDRESS_CATALOG = Object.freeze(rows.map(([address, label, role, evidence]) => Object.freeze({ address, label, role, evidence })));
export const KNOWN_ASSETS = Object.freeze({
  '0x55d398326f99059ff775485246999027b3197955': { symbol: 'USDT', decimals: 18 },
  '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': { symbol: 'USDC', decimals: 18 },
  '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c': { symbol: 'WBNB', decimals: 18 },
});

// BSC symbol()/decimals() verified at block 134645454. Display and the
// specific Keeper policy only; these assets do not expand watched traffic.
const displayRows = [
  ['0x6a2b0b704650a93f7495d728c3b851a1c5f73172', 'RYDE4', 18],
  ['0xbe9d156892e55e7154bcd3cb0fea677f9d3103e1', 'SPCXB', 18],
  ['0x46ceefda28dd7207059ed19b0acdc026955bb15c', 'GMEB', 18],
  ['0x4902c5ebc598265ed2212b559b042de8a5eeec3f', 'BNCB', 18],
  ['0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d', 'USD1', 18],
  ['0x205812cdbed920aff76c6580abd681a46d11efc7', 'QQQB', 18],
  ['0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82', 'Cake', 18],
  ['0x02fca66c1d1afb4e2a7884261eb00f63598a7436', 'NVDAB', 18],
  ['0x2d2d8449ec0bb78c497c36ffaac583dff4bd4444', 'MVP', 18],
  ['0xbe82f76637dba2c114c41df856c2c51e522e2cb8', 'EWYB', 18],
  ['0xca750ef65f295bbecd685abf54e82caf297bdb61', 'SKHYB', 18],
  ['0x5b1910eaad6450e50f816082aa078c41f10c292f', 'TSLAB', 18],
  ['0x92aa03137385f18539301349dcfc9ebc923ffb10', 'SKYAI', 18],
  ['0x7c8d5502b544ddaf8852fc46d1174e34876d545c', 'BNC4', 18],
  ['0x26e32dab9f844d7256db4195b3a43750272a51e9', 'EWJB', 18],
  ['0xce24439f2d9c6a2289f741120fe202248b666666', 'U', 18],
  ['0x38dd26788cf2d901e3abf04efe3007d459d0fc53', 'ANTB', 18],
  ['0x1d80392d12caaaf9e333bb0bb7f021eacf297fe6', 'pPOLY', 18],
  ['0x5ce033b2bfca3af30b3e8c8457deaf776a8b695a', 'BEM', 8],
  ['0xc0c240c870606a5cb3150795e2d0dfff9f1f7456', 'RION', 18],
];
export const VERIFIED_ASSET_DISPLAY = Object.freeze(Object.fromEntries(
  displayRows.map(([address, symbol, decimals]) => [address, Object.freeze({ symbol, decimals })]),
));

export function readFourmemeAddressConfig(env = process.env) {
  return { enabled: env.FOURMEME_ADDRESS_MONITOR !== 'false', intervalMs: 1000,
    catalog: FOURMEME_ADDRESS_CATALOG };
}
