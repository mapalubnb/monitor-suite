import test from 'node:test';
import assert from 'node:assert/strict';
import { createTransactionalOutbox } from '../shared/transactional-outbox.mjs';
import { createFourmemeAddressMonitor, updateAddressHealth, observeFourmemeAddressTx, renderFourmemeAddressContent, addressLogFilters, TRANSFER, APPROVAL } from './address-monitor.mjs';
import { FOURMEME_ADDRESS_CATALOG, KNOWN_ASSETS, FOURMEME_SAFE, readFourmemeAddressConfig } from './address-catalog.mjs';
import { deliverSafeExecutionCard } from './safe-execution-delivery.mjs';
import { ENTRY_POINT_V07, USER_OPERATION_EVENT } from '../flap-monitor/erc4337-codec.mjs';
import { keccak_256 } from '@noble/hashes/sha3';
const A = FOURMEME_ADDRESS_CATALOG[0].address, B = FOURMEME_ADDRESS_CATALOG[1].address, X = '0x' + '33'.repeat(20);
const token = Object.keys(KNOWN_ASSETS)[0], cat = FOURMEME_ADDRESS_CATALOG.slice(0, 2);
const h = n => '0x' + BigInt(n).toString(16).padStart(64, '0'), hex = n => '0x' + n.toString(16), word = n => h(n).slice(2), topic = a => '0x' + a.slice(2).padStart(64, '0');
function fixture(initial = {}, options = {}) {
  const data = { head: 101, chain: new Map(), receipts: new Map(), logs: [], calls: [], fail: false, hang: false };
  for (let n = 0; n <= 140; n++) data.chain.set(n, { number: hex(n), hash: h(n + 1000), parentHash: h(n + 999), timestamp: hex(1795000000 + n), transactions: [] });
  let disk = structuredClone(initial), failWrite = false;
  const store = createTransactionalOutbox({ initial: structuredClone(initial), persist: value => { if (failWrite) throw Error('disk full'); disk = structuredClone(value); }, deliver: async () => 'sent' });
  const rpcBatch = async calls => {
    data.calls.push(...calls);
    if (data.hang) await new Promise(resolve => { data.release = resolve; });
    if (data.fail) throw Error('RPC offline');
    return calls.map(c => {
      if (c.method === 'eth_blockNumber') return hex(data.head);
      if (c.method === 'eth_getBlockByNumber') return structuredClone(data.chain.get(Number(c.params[0])));
      if (c.method === 'eth_getTransactionReceipt') return structuredClone(data.receipts.get(c.params[0]));
      if (c.method === 'eth_getLogs') { const f = c.params[0]; return data.logs.filter(l => Number(l.blockNumber) >= Number(f.fromBlock) && Number(l.blockNumber) <= Number(f.toBlock) && f.topics.every((v, i) => v === null || (Array.isArray(v) ? v.includes(l.topics[i]) : v === l.topics[i]))); }
      throw Error(c.method);
    });
  };
  const opts = { store, rpcBatch, catalog: cat, confirmations: 1, timeoutMs: 50, roundTimeoutMs: 200, ...options };
  const monitor = createFourmemeAddressMonitor(opts);
  function add(n, { from = A, to = X, value = '0xde0b6b3a7640000', input = '0x', logs = [], status = '0x1' } = {}) {
    const b = data.chain.get(n), tx = { hash: h(n + 9000 + b.transactions.length), blockHash: b.hash, blockNumber: b.number, from, to, value, input };
    b.transactions.push(tx);
    const receiptLogs = logs.map((l, i) => ({ ...l, blockHash: b.hash, blockNumber: b.number, transactionHash: tx.hash, logIndex: hex(i) }));
    const r = { transactionHash: tx.hash, blockHash: b.hash, blockNumber: b.number, status, logs: receiptLogs, contractAddress: to ? null : X };
    data.receipts.set(tx.hash, r); data.logs.push(...receiptLogs); return { tx, r };
  }
  return { data, store, monitor, opts, add, get disk() { return disk; }, set failWrite(v) { failWrite = v; } };
}
test('18地址目录、归属边界、固定1秒及日志topic正确，不含Flap地址', () => {
  assert.equal(FOURMEME_ADDRESS_CATALOG.length, 18); assert.equal(new Set(FOURMEME_ADDRESS_CATALOG.map(a => a.address)).size, 18);
  assert.equal(FOURMEME_ADDRESS_CATALOG.filter(a => a.role === 'signer').length, 7);
  assert.equal(readFourmemeAddressConfig({}).intervalMs, 1000); assert.equal(readFourmemeAddressConfig({ FOURMEME_ADDRESS_MONITOR: 'false' }).enabled, false);
  for (const [sig, hash] of [['Transfer(address,address,uint256)', TRANSFER], ['Approval(address,address,uint256)', APPROVAL]]) assert.equal('0x' + Buffer.from(keccak_256(sig)).toString('hex'), hash);
  assert.equal(addressLogFilters([A], 1, 2)[0].topics[1][0], topic(A));
});

test('默认不延后区块，头块交易立即进入扫描；旧游标和去重连续保留', async () => {
  const f = fixture(); await f.monitor.poll(); f.add(101);
  const opts = { ...f.opts }; delete opts.confirmations;
  const m = createFourmemeAddressMonitor(opts); assert.equal(m.summary().confirmations, 0);
  await m.poll(); assert.equal(f.disk.fourmemeAddresses.cursor, 101); assert.equal(f.disk._notificationOutbox.length, 1);
});

test('RPC轮次初始化失败也释放任务，后续轮次可恢复', async () => {
  const f = fixture(); let first = true;
  const m = createFourmemeAddressMonitor({ ...f.opts, rpcFactory: () => { if (first) { first = false; throw Error('no eligible RPC'); } return f.opts.rpcBatch; } });
  await assert.rejects(m.poll(), /eligible RPC/); assert.equal(m.summary().activeTask, null);
  await m.poll(); assert.equal(f.disk.fourmemeAddresses.cursor, 100);
});

test('地址通知保留动作、归属、交易及区块，并区分链上与发现时间', () => {
  const text = renderFourmemeAddressContent({ result: { lines: ['直接转移 1 BNB'], touched: [A] }, catalog: cat, txHash: h(1), block: 123, observedAt: 1795000000000, chainAt: 1794999990000 });
  assert.match(text, /^💸 资金变动\n/);
  assert.match(text, /\[交易\]\(https:\/\/bscscan.com\/tx\/0x[a-f0-9]{64}\) \/ \[区块 123\]\(https:\/\/bscscan.com\/block\/123\)/);
  assert.match(text, /链上时间：2026\/11\/18 .*\n更新时间：2026\/11\/18 .*（监控发现）$/);
  assert.doesNotMatch(text, /延后|发现时间：|交易：\[0x|\*\*/);
});
test('首次只建立基线；重启去重、独立字段与AI关闭', async () => {
  const old = { chainActorMonitor: { history: { cursor: 12 } }, actorNotificationLedger: { entries: { old: true } }, githubMonitor: { gap: true }, fourmemeSafe: { old: true } };
  const f = fixture(old); f.add(100); await f.monitor.poll(); assert.equal(f.disk._notificationOutbox, undefined);
  f.add(101); f.data.head = 102; await f.monitor.poll();
  assert.equal(f.disk.fourmemeAddresses.cursor, 101); assert.equal(f.disk._notificationOutbox.length, 1);
  const p = f.disk._notificationOutbox[0].payload; assert.match(p.content, /1 BNB/); assert.equal(p.skipAi, true); assert.doesNotMatch(p.content, /\*\*|Flap/);
  for (const key of Object.keys(old)) assert.deepEqual(f.disk[key], old[key]);
  await createFourmemeAddressMonitor(f.opts).poll(); assert.equal(f.disk._notificationOutbox.length, 1);
});
test('WSS断连仍按HTTP补齐连续块，单轮受限不跳缺口', async () => {
  const f = fixture({}, { maxBlocks: 2 }); await f.monitor.poll(); f.add(104); f.data.head = 107;
  await f.monitor.poll(); assert.equal(f.disk.fourmemeAddresses.cursor, 102);
  await f.monitor.poll(); assert.equal(f.disk.fourmemeAddresses.cursor, 104); assert.equal(f.disk._notificationOutbox.length, 1);
  await f.monitor.poll(); assert.equal(f.disk.fourmemeAddresses.cursor, 106); assert.equal(f.monitor.summary().lagBlocks, 0);
});
test('被调用的EIP7702账户无需作为tx.from也被捕获，签名人标识不扩张', async () => {
  const f = fixture(); await f.monitor.poll(); f.add(101, { from: X, to: A, value: '0x0', input: '0x12345678' }); f.data.head = 102; await f.monitor.poll();
  assert.match(f.disk._notificationOutbox[0].payload.content, /未解析调用.*0x12345678/);
});

const safeSuccessTopic = '0x442e715f626346e8c54381002da614f62bee8d27386535b2521ec8540898556e';
const safeFailureTopic = '0x23428b18acfb3ea64b08dc0c1d296ea9c09702c09083ca5272e64d115b687d23';
const safeReceiptEvent = { address: FOURMEME_SAFE, topics: [safeSuccessTopic], data: h(700) + word(0) };

test('Safe 即时地址卡仅为已核验的通用执行观察附上关联键', async () => {
  const safe = FOURMEME_ADDRESS_CATALOG.find(a => a.address === FOURMEME_SAFE);
  const f = fixture({}, { catalog: [safe], mergeSafeExecutions: true });
  await f.monitor.poll();
  const call = { from: X, to: FOURMEME_SAFE, value: '0x0', input: '0x6a761202' };
  f.add(101, { ...call, logs: [safeReceiptEvent] });
  f.add(101, { ...call, logs: [safeReceiptEvent, { address: token, topics: [TRANSFER, topic(FOURMEME_SAFE), topic(X)], data: h(12) }] });
  f.add(101, { ...call, logs: [{ ...safeReceiptEvent, topics: [safeFailureTopic] }] });
  f.data.head = 102;
  await f.monitor.poll();
  const [first, funding, failed] = f.disk._notificationOutbox.map(entry => entry.payload);
  assert.equal(first.fourmemeAddress.safeExecution.safeTxHash, h(700));
  assert.equal(first.fourmemeAddress.safeExecution.executor, X);
  assert.match(first.content, /Safe 执行成功（链上回执已核验）/);
  assert.equal(funding.fourmemeAddress.safeExecution, undefined);
  assert.match(funding.content, /资产转移/);
  assert.equal(failed.fourmemeAddress.safeExecution, undefined);
});

const addressCard = {
  title: '地址首报', content: '完整首报',
  fourmemeAddress: { txHash: h(701), block: 134540147, chainAt: 1795000000000, detectedAt: 1795000000123,
    safeExecution: { blockHash: h(702), safeTxHash: h(700), executor: X } },
};
const executionCard = {
  title: 'Safe 详细执行', content: '保留完整提案和调用证据',
  fourmemeSafe: { safe: FOURMEME_SAFE, changes: [{ type: 'executed', hash: h(700), transactionHash: h(701) }] },
};

function safeDeliveryHarness() {
  let disk = {}, current, failures = 0;
  const sent = [], edits = [];
  function restart() {
    current = createTransactionalOutbox({ initial: structuredClone(disk), persist: state => { disk = structuredClone(state); },
      deliver: (payload, options) => deliverSafeExecutionCard({ store: current, payload, options,
        send: async p => { sent.push(p); return 'message-' + sent.length; },
        edit: async (id, p) => { edits.push({ id, p }); if (failures-- > 0) throw Error('edit failure'); },
        fitsSingleCard: p => !p.tooLarge,
      }),
    });
    return current;
  }
  return { sent, edits, restart, failEdits: n => { failures = n; } };
}

test('Safe 先送即时首报，跨重启在原卡补完整详情，详细先到也只发一张', async () => {
  for (const safeFirst of [false, true]) {
    const h = safeDeliveryHarness();
    let store = h.restart();
    await store.enqueue(safeFirst ? executionCard : addressCard);
    await store.drain();
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0].title, safeFirst ? executionCard.title : addressCard.title);
    store = h.restart();
    await store.enqueue(safeFirst ? addressCard : executionCard);
    await store.drain();
    assert.equal(h.sent.length, 1);
    assert.equal(store.state._notificationOutbox.length, 0);
    if (safeFirst) assert.equal(h.edits.length, 0);
    else {
      assert.equal(h.edits[0].id, 'message-1');
      assert.match(h.edits[0].p.content, /保留完整提案和调用证据.*执行者.*134540147/s);
    }
  }
});

test('Safe 编辑失败跨重启重试并兜底，重组后新锚点与不同 SafeTxHash 都照常发送', async () => {
  const delivery = safeDeliveryHarness();
  let store = delivery.restart();
  await store.enqueue(addressCard);
  await store.drain();
  delivery.failEdits(2);
  await store.enqueue(executionCard);
  await store.drain();
  assert.equal(store.state._notificationOutbox.length, 1);
  assert.equal(delivery.sent.length, 1);
  store = delivery.restart();
  await store.drain(Date.now() + 60_000);
  assert.equal(store.state._notificationOutbox.length, 0);
  assert.deepEqual(delivery.sent.map(x => x.title), [addressCard.title, executionCard.title]);
  await store.enqueue({ ...addressCard, fourmemeAddress: { ...addressCard.fourmemeAddress,
    safeExecution: { ...addressCard.fourmemeAddress.safeExecution, blockHash: h(703) } } });
  await store.enqueue({ ...executionCard, fourmemeSafe: { ...executionCard.fourmemeSafe,
    changes: [{ ...executionCard.fourmemeSafe.changes[0], hash: h(704) }] } });
  await store.drain();
  assert.equal(delivery.sent.length, 4);
});

test('监控地址间资产转移推送；未知资产被动收入静默记录；一笔多地址仅一条', async () => {
  const f = fixture(); await f.monitor.poll();
  f.add(101, { from: X, to: X, value: '0x0', logs: [{ address: token, topics: [TRANSFER, topic(A), topic(B)], data: h(1000000000000000000n) }] });
  f.add(101, { from: X, to: X, value: '0x0', logs: [{ address: X, topics: [TRANSFER, topic(X), topic(B)], data: h(123) }] });
  f.data.head = 102; await f.monitor.poll(); assert.equal(f.disk._notificationOutbox.length, 1); assert.equal(f.disk.fourmemeAddresses.passive.length, 1);
  assert.match(f.disk._notificationOutbox[0].payload.content, /1 USDT/);
});

test('与Flap一致：纯被动代币收款无论金额只记录，重启不补发', async () => {
  const f = fixture(); await f.monitor.poll();
  for (const raw of [168714895711991n, 1000000n * 10n ** 18n]) f.add(101, { from: X, to: X, value: '0x0', logs: [{ address: token, topics: [TRANSFER, topic(X), topic(B)], data: h(raw) }] });
  f.data.head = 102; await f.monitor.poll();
  assert.equal(f.disk._notificationOutbox, undefined); assert.equal(f.disk.fourmemeAddresses.silentTransactions, 2);
  assert.equal(f.disk.fourmemeAddresses.passive[0].reason, 'passive_token_income');
  assert.equal(BigInt(f.disk.fourmemeAddresses.passive[0].events[0].rawAmount), 168714895711991n);
  await createFourmemeAddressMonitor(f.opts).poll(); assert.equal(f.disk._notificationOutbox, undefined);
  assert.equal(f.disk.fourmemeAddresses.silentTransactions, 2);
});

test('小额主动转出、被调用、授权、直接BNB与混合操作不因降噪消失', async () => {
  const f = fixture(); await f.monitor.poll();
  const income = { address: token, topics: [TRANSFER, topic(X), topic(B)], data: h(1) };
  f.add(101, { from: A, to: X, value: '0x0', input: '0x12345678', logs: [income] });
  f.add(101, { from: X, to: B, value: '0x1' });
  f.add(101, { from: X, to: X, value: '0x0', logs: [income, { address: token, topics: [APPROVAL, topic(B), topic(X)], data: h(1) }] });
  f.add(101, { from: A, to: X, value: '0x1' });
  f.data.head = 102; await f.monitor.poll(); assert.equal(f.disk._notificationOutbox.length, 4);
  assert.equal(f.disk.fourmemeAddresses.silentTransactions || 0, 0);
});
test('主动授权/转移未知资产保留精度未知；失败调用不声称生效', () => {
  const f = fixture(); const { tx, r } = f.add(101, { input: '0x12345678', status: '0x0' });
  assert.match(observeFourmemeAddressTx(tx, r, cat).lines.join('\n'), /交易失败，未生效/);
  const t = f.add(102, { value: '0x0', logs: [{ address: X, topics: [APPROVAL, topic(A), topic(B)], data: h(123) }] });
  assert.match(observeFourmemeAddressTx(t.tx, t.r, cat).lines.join('\n'), /精度未知/);
});

const keeper = FOURMEME_ADDRESS_CATALOG.find(x => x.label === 'OpenFour Rebate Keeper');
const completionTopic = '0x0b930379a90ac974f8f7af77345b7d40a967fc4ea295de11245b4045781ecdf3';
const companionTopic = '0x0226a2f5c1ae0e071aeec3d4ebafcefdc5c549be11f40ed27e76e802acccf374';
const claimInput = '0xffb83a52' + [100137601, 160, 352, 1795154819, 544].map(word).join('');
const completion = { address: keeper.address, topics: [completionTopic], data: h(100137601) };
const stock = '0x4902c5ebc598265ed2212b559b042de8a5eeec3f';
const bem = '0x5ce033b2bfca3af30b3e8c8457deaf776a8b695a';
const payout = (address, raw, to = X) => ({ address, topics: [TRANSFER, topic(keeper.address), topic(to)], data: h(raw) });
const claim = (logs, extra = {}) => ({ from: X, to: keeper.address, value: '0x0', input: claimInput, logs: [...logs, completion], ...extra });

test('Keeper 已证实的小额与零额领取只写审计，同币种累计超限照常推送', async () => {
  const f = fixture({}, { catalog: [keeper] });
  await f.monitor.poll();
  const first = payout(stock, 32687671412000000n);
  const companion = { ...first, topics: [companionTopic, ...first.topics.slice(1)], data: first.data + word(32687671412000000n) };
  f.add(101, claim([first, companion, payout(bem, 462n)]));
  f.add(101, claim([]));
  f.add(101, claim([payout(stock, 30000000000000000n), payout(stock, 30000000000000000n)]));
  f.data.head = 102;
  await f.monitor.poll();
  assert.equal(f.disk.fourmemeAddresses.cursor, 101);
  assert.equal(f.disk.fourmemeAddresses.keeperSmallRebates, 2);
  assert.deepEqual(f.disk.fourmemeAddresses.passive.map(x => [x.reason, x.eventCount]), [['keeper_small_rebate', 2], ['keeper_small_rebate', 0]]);
  assert.equal(BigInt(f.disk.fourmemeAddresses.passive[0].events[0].rawAmount), 32687671412000000n);
  assert.equal(f.disk._notificationOutbox.length, 1);
  const card = f.disk._notificationOutbox[0].payload.content;
  assert.match(card, /资产转移 · 2 项/);
  assert.match(card, /0\.03 BNCB/);
  assert.match(card, /Keeper 返佣路径/);
  assert.equal(card.match(new RegExp('→ \\[' + X + '\\]', 'g')).length, 1);
  await createFourmemeAddressMonitor(f.opts).poll();
  assert.equal(f.disk.fourmemeAddresses.keeperSmallRebates, 2);
});

test('Keeper 领取锚点不匹配、不同收款方、未知精度、授权、失败和原生转账持续告警', () => {
  const f = fixture({}, { catalog: [keeper, ...cat] });
  const small = payout(stock, 1n);
  const samples = [
    claim([small], { input: '0x12345678' + claimInput.slice(10) }),
    claim([small], { logs: [small, { ...completion, data: h(22) }] }),
    claim([payout(stock, 1n, A)]),
    claim([payout('0x' + '67'.repeat(20), 1n)]),
    claim([small, { ...small, topics: [APPROVAL, ...small.topics.slice(1)] }]),
    claim([], { status: '0x0' }),
    claim([small], { value: '0x1' }),
    claim([payout(stock, 1n, A)], { from: A }),
  ];
  for (const sample of samples) {
    const { tx, r } = f.add(101, sample);
    const result = observeFourmemeAddressTx(tx, r, [keeper, ...cat]);
    assert.equal(result.silentReason, undefined);
    assert.ok(result.lines.length);
  }
});

test('已验证精度显示 BEM 的八位小数，展示资产不扩大被动监听', () => {
  const f = fixture();
  const active = f.add(101, { from: A, to: X, value: '0x0', logs: [{ address: bem, topics: [TRANSFER, topic(A), topic(X)], data: h(462) }] });
  assert.match(observeFourmemeAddressTx(active.tx, active.r, cat).lines.join('\n'), /0\.00000462 BEM/);
  const passive = f.add(101, { from: X, to: X, value: '0x0', logs: [{ address: bem, topics: [TRANSFER, topic(X), topic(A)], data: h(462) }] });
  assert.deepEqual(observeFourmemeAddressTx(passive.tx, passive.r, cat).lines, []);
});

test('部署记录与已有创建者通道去重，但新资产事件保留', () => {
  const f = fixture(); const t = f.add(101, { to: null, value: '0x0' }); const creators = [{ ...cat[0], role: 'creator' }];
  assert.match(observeFourmemeAddressTx(t.tx, t.r, creators).lines.join('\n'), /创建合约/);
  assert.equal(observeFourmemeAddressTx(t.tx, t.r, creators, { actorCovered: [A] }).lines.length, 0);
});
test('ERC4337未知入口仍保留账户事件，不能将整笔成功当作账户执行成功', () => {
  const f = fixture(); const t = f.add(101, { from: X, to: ENTRY_POINT_V07, value: '0x0', logs: [{ address: ENTRY_POINT_V07, topics: [USER_OPERATION_EVENT, h(999), topic(A), topic(X)], data: '0x' + [1, 0, 1, 1].map(word).join('') }] });
  assert.match(observeFourmemeAddressTx(t.tx, t.r, cat).lines.join('\n'), /ERC-4337.*执行失败/);
});
test('回执缺失/错链不推进游标、补齐后只报一次', async () => {
  const f = fixture(); await f.monitor.poll(); const t = f.add(101); f.data.head = 102; f.data.receipts.delete(t.tx.hash);
  await assert.rejects(f.monitor.poll(), /回执/); assert.equal(f.disk.fourmemeAddresses.cursor, 100);
  f.data.receipts.set(t.tx.hash, { ...t.r, blockHash: h(99999) }); await assert.rejects(f.monitor.poll(), /回执/);
  f.data.receipts.set(t.tx.hash, t.r); await f.monitor.poll(); assert.equal(f.disk._notificationOutbox.length, 1);
});
test('父哈希错链和提交前重组均不提交部分扫描', async () => {
  const f = fixture(); await f.monitor.poll(); f.add(101); f.data.head = 102; f.data.chain.get(101).parentHash = h(888);
  await assert.rejects(f.monitor.poll(), /父哈希/); assert.equal(f.disk.fourmemeAddresses.cursor, 100);
  f.data.chain.get(101).parentHash = h(1100);
  const rpc = f.opts.rpcBatch; const m = createFourmemeAddressMonitor({ ...f.opts, rpcBatch: async calls => {
    const result = await rpc(calls); if (calls[0].method === 'eth_getTransactionReceipt') f.data.chain.get(101).hash = h(777); return result;
  } });
  await assert.rejects(m.poll(), /提交前/); assert.equal(f.disk._notificationOutbox, undefined);
});
test('重组回滚、已发更正、新链重扫与去重', async () => {
  const f = fixture(); await f.monitor.poll(); f.add(101); f.data.head = 102; await f.monitor.poll();
  const b = f.data.chain.get(101); b.hash = h(9999); b.transactions = [];
  await f.monitor.poll(); assert.equal(f.disk.fourmemeAddresses.reorgs, 1); assert.equal(f.disk._notificationOutbox.length, 2);
  assert.match(f.disk._notificationOutbox[1].payload.title, /重组更正/); await f.monitor.poll(); assert.equal(f.disk._notificationOutbox.length, 2);
});
test('写盘失败原子回滚，不损坏旧字段或发布半份通知', async () => {
  const f = fixture(); await f.monitor.poll(); const before = f.disk; f.add(101); f.data.head = 102; f.failWrite = true;
  await assert.rejects(f.monitor.poll(), /disk full/); assert.deepEqual(f.disk, before); f.failWrite = false;
  await f.monitor.poll(); assert.equal(f.disk._notificationOutbox.length, 1);
});
test('单次强制超时释放、迟到结果隔离，不刷异常/恢复卡', async () => {
  const f = fixture({}, { timeoutMs: 20, roundTimeoutMs: 10 }); await f.monitor.poll();
  f.data.head = 102; f.add(101); f.data.hang = true; await assert.rejects(f.monitor.poll(), /超时/);
  assert.equal(f.monitor.summary().activeTask, null); assert.equal(f.disk.fourmemeAddresses.cursor, 100);
  assert.equal(f.disk._notificationOutbox, undefined);
  assert.equal(f.disk.fourmemeAddresses.health.failureKind, 'timeout');
  f.data.hang = false; await f.monitor.poll(); f.data.release(); await new Promise(r => setTimeout(r, 30));
  assert.equal(f.disk._notificationOutbox.length, 1); assert.equal(f.disk.fourmemeAddresses.cursor, 101);
});
test('持续60秒失败告警一次；重启保留事件，追上且稳定30秒恢复一次', async () => {
  let at = 1000;
  const f = fixture({}, { now: () => at }); await f.monitor.poll(); f.data.fail = true;
  for (let i = 0; i < 6; i++) await assert.rejects(f.monitor.poll());
  assert.equal(f.disk._notificationOutbox, undefined);
  at += 60001; await assert.rejects(f.monitor.poll());
  assert.equal(f.disk._notificationOutbox.length, 1);
  const restarted = createFourmemeAddressMonitor(f.opts);
  await assert.rejects(restarted.poll()); assert.equal(f.disk._notificationOutbox.length, 1);
  f.data.fail = false; await restarted.poll(); // same head must not recover
  assert.equal(f.disk.fourmemeAddresses.health.alerted, true);
  f.data.head++; await restarted.poll(); at += 15000; f.data.head++; await restarted.poll();
  assert.equal(f.disk._notificationOutbox.length, 1);
  at += 15000; f.data.head++; await restarted.poll();
  assert.equal(f.disk._notificationOutbox.length, 2);
  assert.match(f.disk._notificationOutbox[1].payload.content, /游标：103/);
  await restarted.poll(); assert.equal(f.disk._notificationOutbox.length, 2);
});

test('反复短抖动不刷卡；持续落后即使RPC成功也告警；稳定期失败重新计时', () => {
  const s = { cursor: 100, lastProgressAt: 1000, health: {} };
  const wait = Object.assign(Error('预算暂满'), { rpcBudget: true });
  for (let at = 1000; at < 200000; at += 10000) {
    assert.equal(updateAddressHealth(s, { at, head: s.cursor + 1, error: wait }), null);
    s.cursor++; s.lastProgressAt = at + 5000;
    assert.equal(updateAddressHealth(s, { at: at + 5000, head: s.cursor }), null);
  }
  assert.equal(s.health.alerted || false, false);
  updateAddressHealth(s, { at: 200000, head: s.cursor + 100 });
  s.cursor++; s.lastProgressAt = 260001;
  assert.match(updateAddressHealth(s, { at: 260001, head: s.cursor + 100 }).title, /异常/);
  s.cursor++; s.lastProgressAt = 261000;
  updateAddressHealth(s, { at: 261000, head: s.cursor });
  updateAddressHealth(s, { at: 280000, head: s.cursor, error: wait });
  s.cursor++; s.lastProgressAt = 290000;
  updateAddressHealth(s, { at: 290000, head: s.cursor });
  assert.equal(updateAddressHealth(s, { at: 300000, head: s.cursor }), null);
  assert.equal(s.health.alerted, true);
  s.cursor++; s.lastProgressAt = 320000;
  assert.match(updateAddressHealth(s, { at: 320000, head: s.cursor }).title, /恢复/);
});
test('新增地址独立生效区块，旧地址掉线期间历史仍连续补回', async () => {
  const f = fixture({}, { catalog: [cat[0]], maxBlocks: 2 }); await f.monitor.poll(); f.add(101); f.add(102, { from: B }); f.data.head = 104;
  const m = createFourmemeAddressMonitor({ ...f.opts, catalog: cat }); await m.poll();
  assert.equal(f.disk._notificationOutbox.length, 1); assert.equal(f.disk.fourmemeAddresses.catalog[1].activationBlock, 103);
});
