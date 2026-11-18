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
export function readFourmemeAddressConfig(env = process.env) {
  return { enabled: env.FOURMEME_ADDRESS_MONITOR !== 'false', intervalMs: 1000,
    catalog: FOURMEME_ADDRESS_CATALOG };
}
