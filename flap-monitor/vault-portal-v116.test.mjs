import test from 'node:test';
import assert from 'node:assert/strict';
import { VAULT_PORTAL_ADDRESS as portal, GRANT_REVOKER_ROLE as role, AUDITOR_ROLE as auditor,
  ROLE_ADMIN_CHANGED, GRANT_REVOKED, GRANT_USED, PORTAL_MODULE_GETTERS } from './vault-portal-v116.mjs';
import { createContractIntegrityState, ingestContractIntegrityEvent, buildContractIntegrityContent,
  acknowledgeContractIntegrityChanges, readyContractIntegrityChanges, migrateContractIntegrityState,
  runContractIntegrityStateScan } from './contract-integrity-monitor.mjs';
import { decodeOperationalCall, describeOperationalAction } from './operational-call-codec.mjs';
import { extractFlapProposalActions } from './safe-proposal-monitor.mjs';

const addr = n => '0x' + n.repeat(40);
const word = a => '0x' + a.slice(2).padStart(64, '0');
const uint = n => BigInt(n).toString(16).padStart(64, '0');
const zero = '0x' + '0'.repeat(64);
const auditTopic = '0x8f1ffc4dc704963c0165ea4062458f75bdba4310a1732e2a074c7c885e1dadb1';
const log = (topics, index = 179, extras = {}) => ({ address: portal, topics, data: '0x',
  transactionHash: '0x57241699faaa3a3e2f5e6086b41d817bcd885e7f7925b56fe477f7862588f2ef',
  blockHash: '0x' + 'a'.repeat(64), blockNumber: '0x' + (126218746).toString(16),
  logIndex: '0x' + index.toString(16), ...extras });
const roleLog = log([ROLE_ADMIN_CHANGED, role, zero, auditor]);
const grantLog = log([GRANT_USED, role, word(addr('1')), word(addr('2'))], 180);
const auditLog = log([auditTopic, word(addr('3')), word(addr('1'))], 181);

test('真实角色迁移事件解码、持久化、双通道去重和角色基线一致', () => {
  const state = createContractIntegrityState();
  const { change } = ingestContractIntegrityEvent(state, roleLog);
  assert.equal(change.permission.role, role);
  assert.equal(change.permission.newAdmin, auditor);
  assert.equal(state.contracts[portal].getters['审计撤销角色的管理权限'].value, auditor);
  assert.match(buildContractIntegrityContent([change], state), /GRANT_REVOKER_ROLE.*\n/);
  assert.match(buildContractIntegrityContent([change], state), /新管理角色：审计角色/);
  const restored = migrateContractIntegrityState(JSON.parse(JSON.stringify(state)));
  assert.equal(ingestContractIntegrityEvent(restored, roleLog, 'http').duplicate, true);
  assert.equal(restored.pendingChanges.length, 1);
});

test('未知角色保留哈希；畸形事件保留待核验；其他合约同名 Grant 不套用 Portal 语义', () => {
  const state = createContractIntegrityState();
  const unknown = '0x' + '9'.repeat(64);
  const { change } = ingestContractIntegrityEvent(state, log([ROLE_ADMIN_CHANGED, unknown, zero, auditor]));
  assert.match(buildContractIntegrityContent([change], state), new RegExp(unknown));
  const malformed = ingestContractIntegrityEvent(state, log([GRANT_REVOKED, role], 190)).change;
  assert.equal(malformed.permission.kind, 'malformed');
  assert.match(buildContractIntegrityContent([malformed], state), /待核验/);
  const fake = ingestContractIntegrityEvent(state, log([GRANT_REVOKED, role, word(addr('1'))], 191,
    { address: '0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0' }));
  assert.equal(fake.change, null);
});

test('授权使用与同笔报告合并，正反到达顺序都只投递报告，重启保留摘要', () => {
  for (const events of [[grantLog, auditLog], [auditLog, grantLog]]) {
    const state = createContractIntegrityState();
    for (const event of events) ingestContractIntegrityEvent(state, event);
    const restored = migrateContractIntegrityState(JSON.parse(JSON.stringify(state)));
    assert.equal(restored.pendingChanges.length, 1);
    assert.equal(restored.pendingChanges[0].grants[0].digest, role);
    assert.match(buildContractIntegrityContent(restored.pendingChanges, restored), /同笔交易的签名授权/);
    assert.doesNotMatch(buildContractIntegrityContent(restored.pendingChanges, restored), /尚未关联/);
    const grantRemoval = ingestContractIntegrityEvent(restored, { ...grantLog, removed: true });
    assert.equal(grantRemoval.change, null);
    assert.deepEqual(restored.pendingChanges[0].grants, []);
    const auditRemoval = ingestContractIntegrityEvent(restored, { ...auditLog, removed: true });
    assert.equal(auditRemoval.change.type, 'reorg');
  }
});

test('报告已投递后迟到授权不再单发；不同交易或分叉不得合并', () => {
  const state = createContractIntegrityState();
  const audit = ingestContractIntegrityEvent(state, auditLog).change;
  acknowledgeContractIntegrityChanges(state, [audit.id]);
  ingestContractIntegrityEvent(state, grantLog);
  assert.equal(state.pendingChanges.length, 0);
  const other = createContractIntegrityState();
  ingestContractIntegrityEvent(other, auditLog);
  ingestContractIntegrityEvent(other, { ...grantLog, blockHash: '0x' + 'b'.repeat(64) });
  assert.equal(other.pendingChanges.length, 2);
});

test('孤立授权使用超时保留提醒，静默撤销不阻塞角色事件且重启不补发', () => {
  const state = createContractIntegrityState();
  const grant = ingestContractIntegrityEvent(state, grantLog).change;
  const revokedLog = log([GRANT_REVOKED, role, word(addr('1'))], 190);
  assert.equal(ingestContractIntegrityEvent(state, revokedLog).suppressed, true);
  const record = Object.values(state.recentEvents).find(r => r.permission?.kind === 'grantRevoked');
  assert.equal(record.permission.digest, role);
  assert.equal(record.notified, false);
  const changedRole = ingestContractIntegrityEvent(state, roleLog).change;
  assert.deepEqual(readyContractIntegrityChanges(state, Date.parse(grant.detectedAt)).map(c => c.id), [changedRole.id]);
  assert.equal(readyContractIntegrityChanges(state, Date.parse(grant.detectedAt) + 1501).length, 2);
  assert.match(buildContractIntegrityContent([grant], state), /尚未关联/);
  // Simulate a persisted notification queued by the previous release.
  const eventKey = Object.keys(state.recentEvents).find(k => state.recentEvents[k] === record);
  record.notified = true;
  state.pendingChanges.push({ id: 'legacy-revocation', type: 'event', address: portal,
    topic0: GRANT_REVOKED, eventKey, permission: record.permission });
  const restored = migrateContractIntegrityState(JSON.parse(JSON.stringify(state)));
  assert.equal(restored.pendingChanges.length, 2);
  assert.equal(restored.recentEvents[eventKey].notified, false);
  assert.equal(ingestContractIntegrityEvent(restored, revokedLog, 'http').duplicate, true);
  assert.equal(ingestContractIntegrityEvent(restored, { ...revokedLog, removed: true }).change, null);
});

test('同笔批量审计的第二个授权不被前一个报告吞掉', () => {
  const state = createContractIntegrityState();
  ingestContractIntegrityEvent(state, grantLog);
  ingestContractIntegrityEvent(state, auditLog);
  const second = ingestContractIntegrityEvent(state, { ...grantLog, logIndex: '0xb6', topics: [GRANT_USED, auditor, word(addr('1')), word(addr('2'))] }).change;
  assert.ok(state.pendingChanges.some(c => c.id === second.id));
  ingestContractIntegrityEvent(state, { ...auditLog, logIndex: '0xb7', topics: [auditTopic, word(addr('4')), word(addr('1'))] });
  assert.equal(state.pendingChanges.length, 2);
  assert.equal(state.pendingChanges[0].grants[0].digest, role);
  assert.equal(state.pendingChanges[1].grants[0].digest, auditor);
});

test('迟到的旧区块 getter 不覆盖新角色事件且新状态复核不重复通知', async () => {
  const state = createContractIntegrityState();
  ingestContractIntegrityEvent(state, roleLog);
  const scan = head => runContractIntegrityStateScan({ state,
    rpcCall: async method => method === 'eth_chainId' ? '0x38' : '0x' + head.toString(16),
    rpcBatch: async calls => calls.map(c => c.method === 'eth_getCode' ? '0x6000'
      : c.method === 'eth_call' && c.params[0].data.startsWith('0x248a9ca3') && head >= 126218746 ? auditor : zero) });
  await scan(126218745);
  assert.equal(state.contracts[portal].getters['审计撤销角色的管理权限'].value, auditor);
  await scan(126218747);
  assert.equal(state.pendingChanges.filter(c => c.field === '审计撤销角色的管理权限').length, 0);
});

test('新版 Safe 调用严格绑定 Portal，角色名称清晰并保留原始 calldata', () => {
  const migration = extractFlapProposalActions({ to: portal, data: '0x211be400' }, { includeOperations: true })[0];
  assert.equal(migration.kind, 'grantRoleAdmin');
  assert.equal(migration.rawData, '0x211be400');
  assert.match(describeOperationalAction(migration), /AUDITOR_ROLE/);
  const revoke = decodeOperationalCall({ to: portal, data: '0x6e500b55' + role.slice(2) });
  assert.equal(revoke.kind, 'grantRevoke');
  assert.match(describeOperationalAction(revoke), /不删除已上链/);
  for (const tx of [{ to: addr('1'), data: '0x211be400' }, { to: portal, data: '0x211be400' + uint(0) },
    { to: portal, data: '0x6e500b55' }, { to: portal, data: '0x211be400', operation: 1 }]) {
    assert.equal(decodeOperationalCall(tx).kind, 'unknown');
  }
  const member = decodeOperationalCall({ to: portal, data: '0x2f2ff15d' + role.slice(2) + word(addr('1')).slice(2) });
  assert.match(describeOperationalAction(member), /审计授权撤销角色/);
});

test('签名提交审计正确读取动态 tuple 和原始 nonce，畸形授权不误解码', () => {
  const str = s => uint(Buffer.byteLength(s)) + Buffer.from(s).toString('hex').padEnd(64, '0');
  const tuple = word(addr('3')).slice(2) + word(addr('4')).slice(2) + word(addr('2')).slice(2)
    + uint(1) + uint(256) + uint(320) + role.slice(2) + uint(9007199254740993n) + str('cid') + str('ui');
  const data = '0xf2277e85' + word(addr('3')).slice(2) + uint(96) + uint(96 + tuple.length / 2)
    + tuple + uint(65) + '11'.repeat(65).padEnd(192, '0');
  const action = decodeOperationalCall({ to: portal, data });
  assert.equal(action.kind, 'auditGrantSubmit');
  assert.equal(action.ipfsCid, 'cid');
  assert.equal(action.artifactId, 'ui');
  assert.equal(action.nonce, '9007199254740993');
  assert.equal(decodeOperationalCall({ to: portal, data: '0xf2277e85' + uint(1) }).kind, 'unknown');
});

test('六个模块在原核心扫描建基线，变更后发现依赖且不增加日志订阅', async () => {
  const state = createContractIntegrityState();
  let module = addr('5'), head = 126219000;
  const rpcCall = async method => method === 'eth_chainId' ? '0x38' : '0x' + head.toString(16);
  const rpcBatch = async calls => calls.map(c => {
    if (c.method === 'eth_getCode') return '0x6000';
    if (c.method === 'eth_getStorageAt') return zero;
    if (PORTAL_MODULE_GETTERS.some(g => g[1] === c.params[0].data)) return word(module);
    return zero;
  });
  await runContractIntegrityStateScan({ state, rpcCall, rpcBatch });
  assert.equal(state.pendingChanges.length, 0);
  assert.equal(state.catalog[module].kind, 'vault-module');
  module = addr('6'); head++;
  const result = await runContractIntegrityStateScan({ state, rpcCall, rpcBatch });
  assert.equal(result.changes.filter(c => PORTAL_MODULE_GETTERS.some(g => g[0] === c.field)).length, 6);
  assert.equal(state.catalog[module].kind, 'vault-module');
});
