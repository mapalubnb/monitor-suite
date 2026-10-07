// VaultPortal 1.16.0 verified ABI (BNB implementation 0x184a...9c1c).
// Role identifiers are scoped to this Portal; selectors alone do not establish identity.
export const VAULT_PORTAL_ADDRESS = '0x90497450f2a706f1951b5bdda52b4e5d16f34c06';
export const GRANT_REVOKER_ROLE = '0x5b663e4bacc7480c4127252ad710aca84e2e5fbdd0472a72403d14375bba0f55';
export const AUDITOR_ROLE = '0x59a1c48e5837ad7a7f3dcedcbe129bf3249ec4fbf651fd4f5e2600ead39fe2f5';
export const ROLE_ADMIN_CHANGED = '0xbd79b86ffe0ab8e8776151514217cd7cacd52c909f66475c3af44e129f0b00ff';
export const GRANT_REVOKED = '0x2fb04799ec659d4a157688a8e500e996a960f1d59afdaf410c8e80c3ba0b7951';
export const GRANT_USED = '0xd71105d893b347538f285a541ad4e99272f6acf75befde43ee79a525afda0940';
const ROLE_GRANTED = '0x2f8788117e7eff1d82e926ec794901d17c78024a50270940304540a733656f0d';
const ROLE_REVOKED = '0xf6391f5c32d9c69d2a47ea670b442974b53935d1edc7fd64eb21e047a839171b';
const roles = {
  ['0x' + '0'.repeat(64)]: '默认管理员（DEFAULT_ADMIN_ROLE）',
  [AUDITOR_ROLE]: '审计角色（AUDITOR_ROLE）',
  [GRANT_REVOKER_ROLE]: '审计授权撤销角色（GRANT_REVOKER_ROLE）',
  '0x7edcee67725a77bfa311b39349d7e96df9b23fbdbdcb328dfc17d77926920c13': '金库管理员（VAULT_ADMIN_ROLE）',
};
export function portalRoleName(role, address = VAULT_PORTAL_ADDRESS) {
  return String(address).toLowerCase() === VAULT_PORTAL_ADDRESS ? roles[String(role).toLowerCase()] || role : role;
}

export const PORTAL_MODULE_GETTERS = [
  ['查询模块 LENS', '0x18a4619a', 'address', 'vault-module'],
  ['V6 创建模块', '0xbb28acf9', 'address', 'vault-module'],
  ['V7 创建模块', '0x03fa12f4', 'address', 'vault-module'],
  ['管理配置模块', '0x033440cf', 'address', 'vault-module'],
  ['UI 登记模块', '0x99cc6da1', 'address', 'vault-module'],
  ['审计模块', '0xa89eec7e', 'address', 'vault-module'],
];

export function decodePortalPermissionEvent(log) {
  const topics = (log.topics || []).map(value => String(value).toLowerCase());
  const topic = topics[0];
  const isGrant = [GRANT_REVOKED, GRANT_USED].includes(topic);
  if (isGrant && String(log.address).toLowerCase() !== VAULT_PORTAL_ADDRESS) return null;
  if (![ROLE_ADMIN_CHANGED, ROLE_GRANTED, ROLE_REVOKED, GRANT_REVOKED, GRANT_USED].includes(topic)) return null;
  const size = topic === GRANT_REVOKED ? 3 : 4;
  if (topics.length !== size || topics.some(t => !/^0x[a-f0-9]{64}$/.test(t)) || log.data !== '0x') {
    return { kind: 'malformed', reason: '事件参数不符合已验证 ABI，保留原始记录待核验', topics, data: String(log.data || '') };
  }
  const address = word => {
    if (!/^0x0{24}[a-f0-9]{40}$/.test(word)) throw Error('事件地址编码无效');
    return '0x' + word.slice(-40);
  };
  try {
    if (topic === ROLE_ADMIN_CHANGED) return { kind: 'roleAdmin', role: topics[1], previousAdmin: topics[2], newAdmin: topics[3] };
    if (topic === GRANT_REVOKED) return { kind: 'grantRevoked', digest: topics[1], actor: address(topics[2]) };
    if (topic === GRANT_USED) return { kind: 'grantUsed', digest: topics[1], signer: address(topics[2]), actor: address(topics[3]) };
    return { kind: 'roleMember', role: topics[1], account: address(topics[2]), actor: address(topics[3]), granted: topic === ROLE_GRANTED };
  } catch (error) { return { kind: 'malformed', reason: error.message, topics, data: log.data }; }
}

export function permissionEventLines(event, address) {
  if (!event) return [];
  const link = a => `[${a}](https://bscscan.com/address/${a})`;
  if (event.kind === 'roleAdmin') return [`角色：${portalRoleName(event.role, address)}`, `角色标识：${event.role}`,
    `原管理角色：${portalRoleName(event.previousAdmin, address)}`, `新管理角色：${portalRoleName(event.newAdmin, address)}`,
    '仅改变角色的管理权限，不代表已授予账户权限或撤销审计授权。'];
  if (event.kind === 'roleMember') return [`角色：${portalRoleName(event.role, address)}`, `角色标识：${event.role}`,
    `${event.granted ? '授予' : '撤销'}账户：${link(event.account)}`, `操作账户：${link(event.actor)}`];
  if (event.kind === 'grantRevoked') return [`授权摘要：${event.digest}`, `撤销账户：${link(event.actor)}`,
    '该授权已失效；此操作不删除已上链的审计报告。'];
  if (event.kind === 'grantUsed') return [`授权摘要：${event.digest}`, `授权签署账户：${link(event.signer)}`,
    `提交账户：${link(event.actor)}`];
  return [event.reason, `原始 topics：${event.topics?.join(' / ')}`, `原始数据：${event.data}`];
}
