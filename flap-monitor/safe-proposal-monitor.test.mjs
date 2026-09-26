import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SAFE_MULTISEND_SELECTOR,
  VAULT_PORTAL,
  SET_QUOTE_TOKEN_CREATION_DISABLED_SELECTOR,
  acknowledgeSafeProposalChanges,
  createSafeProposalState,
  decodeMultiSendTransactions,
  extractFlapEnableTargets,
  extractFlapProposalActions,
  buildSafeProposalContent,
  migrateSafeProposalState,
  fetchSafeProposals,
  loadSafeProposalState,
  runSafeProposalScan,
  saveSafeProposalState,
  encodeSafeExecutionSimulation,
  createSafeRateLimitedFetch,
} from "./safe-proposal-monitor.mjs";

const FACTORY = "0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0";
const SAFE = "0xc68f29bfe2f6c3d95adb5685592b9f86680968f2";
const CHECKSUM_SAFE = "0xc68f29BfE2f6c3D95AdB5685592B9F86680968f2";
const TOKEN = "0xe87afb3076aeb0f9b14e368de8145ae6a2826a14";
const OTHER = "0x1111111111111111111111111111111111111111";
const SAFE_TX_HASH = `0x${"97".repeat(32)}`;
const AWDH = JSON.parse(readFileSync(new URL("./fixtures/safe-awdh-proposal.json", import.meta.url), "utf8"));
const MULTISEND = "0x9641d764fc13c8b624c04430c7356c1c7c8102e2";

test('Safe service cooldown survives state reload and respects Retry-After across addresses', async () => {
  let now = 1000, requests = 0;
  let state = {};
  const fetchFn = async () => { requests++; return {status: 429, ok: false, headers: {get: () => '600'}}; };
  let guarded = createSafeRateLimitedFetch(state, fetchFn, {now: () => now, sleep: async ms => { now += ms; }});
  await guarded.waitForTurn(); await guarded('first');
  assert.equal(state.apiNextAttemptAtMs, 601000);
  state = JSON.parse(JSON.stringify(state));
  guarded = createSafeRateLimitedFetch(state, fetchFn, {now: () => now});
  await assert.rejects(guarded.waitForTurn(), /共享冷却/);
  assert.equal(requests, 1);
});

test('Safe polling rotates one address per run without updating skipped poll times', async () => {
  const state = createSafeProposalState([SAFE, OTHER]);
  const calls = [];
  const scan = nowMs => runSafeProposalScan({state, safes: [SAFE, OTHER], maxSafesPerRun: 1, nowMs,
    rpcBatch: async calls => calls.map(() => '0x' + '0'.repeat(64)),
    fetchFn: async url => { calls.push(url); return {ok: true, json: async () => ({results: [], next: null})}; },
  });
  await scan(1000);
  assert.equal(calls.length, 1);
  assert.equal(state.safes[OTHER].lastPollAt, '');
  await scan(2000);
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0], calls[1]);
});

test('Safe monthly exhaustion uses server reset and remaining quota spaces successful requests', async () => {
  const state = {}, now = () => 1000;
  const response = (remaining, status) => ({status, ok: status === 200,
    headers: {get: key => ({'x-ratelimit-limit': '50000', 'x-ratelimit-remaining': String(remaining), 'x-ratelimit-reset': '472938'})[key] ?? null}});
  let guard = createSafeRateLimitedFetch(state, async () => response(0, 429), {now});
  await guard.waitForTurn(); await guard('url');
  assert.equal(state.apiNextAttemptAtMs, 472939000);
  assert.equal(state.apiQuota.remaining, 0);
  await assert.rejects(guard.waitForTurn(), /共享冷却/);
  const fresh = {};
  guard = createSafeRateLimitedFetch(fresh, async () => response(1000, 200), {now});
  await guard.waitForTurn(); await guard('url');
  assert.equal(fresh.apiRequestNextAt, 473938);
  await assert.rejects(guard.waitForTurn(), /额度预算等待/);
});
const VAULT_CALLS = JSON.parse(readFileSync(new URL("./fixtures/safe-vault-factory-calls.json", import.meta.url), "utf8"));
const jsonResponse = value => ({ ok: true, status: 200, json: async () => value });

test("Safe migration preserves delivery backlog beyond the old 200 item limit", () => {
  const original = createSafeProposalState([SAFE]);
  original.pendingChanges = Array.from({ length: 250 }, (_, i) => ({ id: `pending-${i}`, type: "ready" }));
  const migrated = migrateSafeProposalState(original, [SAFE]);
  assert.equal(migrated.pendingChanges.length, 250);
  assert.equal(migrated.pendingChanges[0].id, "pending-0");
});
const word = value => {
  const hex = typeof value === "number" || typeof value === "bigint"
    ? BigInt(value).toString(16)
    : String(value).replace(/^0x/, "");
  return hex.padStart(64, "0");
};
const uintResult = value => `0x${BigInt(value).toString(16).padStart(64, "0")}`;
const vaultCall = (factory = TOKEN, category = null) => `0x${category === null ? "4809625b" : "efa7595a"}${word(factory)}${word(1)}${word(0)}${word(2)}${category === null ? "" : word(category)}`;
const enableCall = (token = TOKEN, disabled = false) =>
  `${SET_QUOTE_TOKEN_CREATION_DISABLED_SELECTOR}${word(token)}${word(disabled ? 1 : 0)}`;

function encodeMultiSend(transactions) {
  const payload = transactions.map(transaction => {
    const data = transaction.data.replace(/^0x/, "");
    return [
      Number(transaction.operation || 0).toString(16).padStart(2, "0"),
      transaction.to.replace(/^0x/, "").toLowerCase(),
      word(transaction.value || 0),
      word(data.length / 2),
      data,
    ].join("");
  }).join("");
  return `${SAFE_MULTISEND_SELECTOR}${word(32)}${word(payload.length / 2)}${payload.padEnd(Math.ceil(payload.length / 64) * 64, "0")}`;
}

function proposal({ confirmations = 1, required = 2, nonce = 12, data = enableCall(), to = FACTORY } = {}) {
  return {
    safe: SAFE,
    to,
    data,
    operation: 0,
    nonce,
    safeTxHash: SAFE_TX_HASH,
    proposer: OTHER,
    submissionDate: "2026-08-24T03:54:41.501Z",
    confirmationsRequired: required,
    confirmations: Array.from({ length: confirmations }, (_, index) => ({
      owner: `0x${String(index + 1).padStart(40, "0")}`,
    })),
  };
}

function response(results, { status = 200, retryAfter = "" } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => name.toLowerCase() === "retry-after" ? retryAfter : "" },
    json: async () => ({ results }),
  };
}

function rpcFixture({ nonce = 12, disabled = true, configured = true } = {}) {
  return async calls => calls.map(call => {
    const selector = call.params?.[0]?.data?.slice(0, 10);
    if (selector === "0xaffed0e0") return uintResult(nonce);
    if (selector === "0x26ef20d5") return `0x${[configured ? 1 : 0, 2, 3, 4, 5].map(value => word(value)).join("")}`;
    return uintResult(disabled ? 1 : 0);
  });
}

test("MSTRB direct Safe proposal decodes the quote token only when disabled is false", () => {
  assert.deepEqual(extractFlapEnableTargets(proposal(), { factoryAddress: FACTORY }), [TOKEN]);
  assert.deepEqual(extractFlapEnableTargets(proposal({ data: enableCall(TOKEN, true) }), { factoryAddress: FACTORY }), []);
  assert.deepEqual(extractFlapEnableTargets(proposal({ to: OTHER }), { factoryAddress: FACTORY }), []);
});

test("MultiSend recursively finds only Flap Factory enable calls", () => {
  const data = encodeMultiSend([
    { to: OTHER, data: enableCall() },
    { to: FACTORY, data: enableCall(TOKEN, true) },
    { to: FACTORY, data: enableCall() },
  ]);
  const decoded = decodeMultiSendTransactions(data);
  assert.equal(decoded.length, 3);
  assert.deepEqual(extractFlapEnableTargets({ to: "0x9641d764fc13c8b624c04430c7356c1c7c8102e2", data, operation: 1 }, { factoryAddress: FACTORY }), [TOKEN]);
});

test("first successful Safe poll announces currently pending proposals once", async () => {
  const state = createSafeProposalState([SAFE]);
  const result = await runSafeProposalScan({
    state,
    safes: [SAFE],
    factoryAddress: FACTORY,
    rpcBatch: rpcFixture(),
    fetchFn: async () => response([proposal()]),
    nowMs: Date.parse("2026-08-24T04:00:00Z"),
  });
  assert.equal(result.changed, true);
  assert.equal(result.changes[0].type, "existing");
  assert.equal(state.safes[SAFE].baselineEstablished, true);
  assert.equal(Object.values(state.proposals).length, 1);
  assert.equal(state.pendingChanges.length, 1);
});

test("new proposal and completed confirmations each alert once", async () => {
  const state = createSafeProposalState([SAFE]);
  let results = [];
  const options = {
    state,
    safes: [SAFE],
    factoryAddress: FACTORY,
    rpcBatch: rpcFixture(),
    fetchFn: async () => response(results),
  };
  await runSafeProposalScan({ ...options, nowMs: 1_000 });
  results = [proposal({ confirmations: 1 })];
  const proposed = await runSafeProposalScan({ ...options, nowMs: 2_000 });
  assert.deepEqual(proposed.changes.map(item => item.type), ["proposed"]);
  const duplicate = await runSafeProposalScan({ ...options, nowMs: 3_000 });
  assert.equal(duplicate.changed, false);
  results = [proposal({ confirmations: 2 })];
  const ready = await runSafeProposalScan({ ...options, nowMs: 4_000 });
  assert.deepEqual(ready.changes.map(item => item.type), ["ready"]);
  acknowledgeSafeProposalChanges(state, state.pendingChanges.map(item => item.id));
  assert.equal(state.pendingChanges.length, 0);
});

test("Safe API 429 preserves state and applies retry-after backoff", async () => {
  const state = createSafeProposalState([SAFE]);
  const result = await runSafeProposalScan({
    state,
    safes: [SAFE],
    factoryAddress: FACTORY,
    rpcBatch: rpcFixture(),
    fetchFn: async () => response([], { status: 429, retryAfter: "30" }),
    nowMs: 10_000,
  });
  assert.equal(result.changed, false);
  assert.match(state.safes[SAFE].lastError, /429/);
  assert.equal(state.safes[SAFE].nextAttemptAtMs, 40_000);
  await runSafeProposalScan({
    state,
    safes: [SAFE],
    factoryAddress: FACTORY,
    rpcBatch: rpcFixture(),
    fetchFn: async () => { throw new Error("backoff期间不应请求 API"); },
    nowMs: 20_000,
  });
  assert.match(state.lastError, /429/);
});

test("Safe API request includes the on-chain nonce filter", async () => {
  let requestedUrl = "";
  await fetchSafeProposals({
    safe: SAFE,
    nonce: 12,
    fetchFn: async url => {
      requestedUrl = url;
      return response([]);
    },
  });
  assert.match(requestedUrl, /nonce__gte=12/);
  assert.match(requestedUrl, /executed=false/);
});

test("Safe API request sends the configured bearer token without exposing it in the URL", async () => {
  let requestedUrl = "";
  let requestedHeaders = {};
  await fetchSafeProposals({
    safe: SAFE,
    nonce: 12,
    apiKey: "test-safe-api-key",
    fetchFn: async (url, options) => {
      requestedUrl = url;
      requestedHeaders = options.headers;
      return response([]);
    },
  });
  assert.equal(requestedHeaders.Authorization, "Bearer test-safe-api-key");
  assert.doesNotMatch(requestedUrl, /test-safe-api-key/);
});

test("Safe scan preserves the EIP-55 address when building the API path", async () => {
  const state = createSafeProposalState([CHECKSUM_SAFE]);
  let requestedUrl = "";
  await runSafeProposalScan({
    state,
    safes: [CHECKSUM_SAFE],
    factoryAddress: FACTORY,
    rpcBatch: rpcFixture(),
    fetchFn: async url => {
      requestedUrl = url;
      return response([]);
    },
  });
  assert.match(requestedUrl, new RegExp(CHECKSUM_SAFE));
});

test("Safe proposal state persists without losing its baseline", () => {
  const directory = mkdtempSync(join(tmpdir(), "flap-safe-proposal-"));
  const path = join(directory, "state.json");
  try {
    const state = createSafeProposalState([SAFE]);
    state.safes[SAFE].baselineEstablished = true;
    saveSafeProposalState(path, state);
    const loaded = loadSafeProposalState(path, [SAFE]);
    assert.equal(loaded.safes[SAFE].baselineEstablished, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("real aWDH calldata groups configuration and two-hop route before execution", async () => {
  const actions = extractFlapProposalActions(AWDH);
  assert.deepEqual(actions.map(action => action.kind), ["configuration", "route"]);
  assert.deepEqual(actions[0].config, { enabled: 1, defaultCurve: 48, alternativeCurve: 48, nativeToQuoteSwapType: 7, dexId: 0 });
  assert.deepEqual(actions[1].hops.map(hop => [hop.poolType, hop.dexId, hop.fee, hop.tickSpacing]), [[1, 0, 100, 0], [2, 1, 9000, 90]]);
  assert.equal(actions[1].hops[1].tokenOut, actions[0].quoteToken);
  const state = createSafeProposalState([SAFE]);
  state.safes[SAFE].baselineEstablished = true;
  let sample = { ...AWDH, isExecuted: false, confirmations: AWDH.confirmations.slice(0, 1) };
  const opts = { state, safes: [SAFE], rpcBatch: rpcFixture({ nonce: 118 }), fetchFn: async () => response([sample]) };
  const first = await runSafeProposalScan(opts);
  assert.deepEqual(first.changes.map(change => change.type), ["proposed"]);
  assert.equal(first.changes[0].actions.length, 2);
  assert.equal(Object.keys(state.proposals).length, 1);
  assert.equal((await runSafeProposalScan(opts)).changed, false);
  sample = { ...sample, confirmations: AWDH.confirmations };
  assert.deepEqual((await runSafeProposalScan(opts)).changes.map(change => change.type), ["ready"]);
  const card = buildSafeProposalContent(state.pendingChanges);
  assert.match(card, /9000/);
  assert.match(card, /48/);
  assert.match(card, /签名已满足，等待执行/);
  assert.doesNotMatch(card, /即将开放|明确的开放意图/);
  assert.deepEqual(extractFlapEnableTargets(AWDH), []);
});

test("nested calls preserve order, pauses, unknown selectors and reject untrusted wrappers", () => {
  const children = decodeMultiSendTransactions(AWDH.data);
  const nested = { to: MULTISEND, operation: 1, data: encodeMultiSend([
    children[1], { to: FACTORY, data: enableCall(TOKEN, true) }, children[0],
    { to: FACTORY, data: "0x12345678" },
  ]) };
  const root = { to: MULTISEND, operation: 1, data: encodeMultiSend([nested]) };
  assert.deepEqual(extractFlapProposalActions(root).map(action => action.kind), ["route", "creation", "configuration", "unknown"]);
  assert.equal(extractFlapProposalActions(root)[1].disabled, true);
  assert.deepEqual(extractFlapProposalActions({ ...root, to: OTHER }), []);
  assert.equal(extractFlapProposalActions({ ...children[0], operation: 1 })[0].kind, "unknown");
  assert.equal(extractFlapProposalActions({ ...children[1], data: children[1].data.slice(0, -64) })[0].kind, "unknown");
});

function trackedState() {
  const state = createSafeProposalState([SAFE]);
  state.safes[SAFE].baselineEstablished = true;
  const record = { ...proposal(), key: `${SAFE_TX_HASH}:${TOKEN}`, safe: SAFE, quoteToken: TOKEN,
    status: "ready", confirmations: 2, required: 2, actions: [{ kind: "creation", quoteToken: TOKEN, disabled: false }] };
  state.proposals[record.key] = record;
  state.pendingChanges = [{ ...record, type: "ready", id: "unsent-ready" }];
  return state;
}

test("consumed nonce resolves by exact Safe transaction, not whether token happens to be enabled", async () => {
  for (const status of ["executed", "failed", "invalidated", "confirming"]) {
    const state = trackedState();
    const detail = { ...proposal(), isExecuted: status === "executed" || status === "failed",
      isSuccessful: status !== "failed", transactionHash: `0x${"ab".repeat(32)}` };
    const winner = { ...detail, isExecuted: true, safeTxHash: `0x${"cd".repeat(32)}` };
    const result = await runSafeProposalScan({ state, safes: [SAFE], rpcBatch: rpcFixture({ nonce: 13, disabled: false }),
      fetchFn: async url => url.includes("/multisig-transactions/0x") ? jsonResponse(detail)
        : response(url.includes("executed=true") && status === "invalidated" ? [winner] : []) });
    assert.equal(Object.values(state.proposals)[0].status, status);
    assert.deepEqual(result.changes.map(change => change.type), status === "confirming" ? [] : [status]);
    assert.ok(state.pendingChanges.every(change => change.type !== "ready"));
  }
});

test("execution result rate limits retain confirming state and block further API requests", async () => {
  const state = trackedState();
  await runSafeProposalScan({ state, safes: [SAFE], nowMs: 10000, rpcBatch: rpcFixture({ nonce: 13 }),
    fetchFn: async url => url.includes("/multisig-transactions/0x")
      ? response([], { status: 429, retryAfter: "120" }) : response([]) });
  assert.equal(Object.values(state.proposals)[0].status, "confirming");
  assert.equal(state.safes[SAFE].nextAttemptAtMs, 130000);
  await runSafeProposalScan({ state, safes: [SAFE], nowMs: 20000, rpcBatch: rpcFixture({ nonce: 13 }),
    fetchFn: async () => assert.fail("退避中不应查询详情或列表") });
});

test("pending proposal pagination retains nonce filter and refuses cross-origin next URLs", async () => {
  let count = 0;
  const base = "https://safe.test/api/v1";
  const results = await fetchSafeProposals({ safe: SAFE, nonce: 12, apiBaseUrl: base,
    fetchFn: async url => {
      assert.match(url, /nonce__gte=12/);
      return jsonResponse(count++ === 0 ? { results: [proposal()], next: `${base}/safes/${SAFE}/multisig-transactions/?offset=100` }
        : { results: [proposal({ nonce: 13 })], next: null });
    } });
  assert.equal(results.length, 2);
  await assert.rejects(fetchSafeProposals({ safe: SAFE, nonce: 12, apiBaseUrl: base,
    fetchFn: async () => jsonResponse({ results: [], next: "https://other.test/collect" }) }), /分页地址无效/);
});

test("old state migration and restart preserve alerts without replaying executed history", async () => {
  const state = trackedState();
  state.schemaVersion = 1;
  delete Object.values(state.proposals)[0].actions;
  const migrated = migrateSafeProposalState(state, [SAFE]);
  assert.equal(Object.values(migrated.proposals)[0].actions[0].kind, "creation");
  assert.equal(migrated.pendingChanges.length, 1);
  const dir = mkdtempSync(join(tmpdir(), "safe-restart-"));
  try {
    const path = join(dir, "state.json");
    saveSafeProposalState(path, migrated);
    const loaded = loadSafeProposalState(path, [SAFE]);
    const result = await runSafeProposalScan({ state: loaded, safes: [SAFE], rpcBatch: rpcFixture(),
      fetchFn: async () => response([proposal({ confirmations: 2 }), AWDH]) });
    assert.equal(result.changed, false);
    assert.equal(loaded.pendingChanges.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("missing threshold is not reported as signature-complete", async () => {
  const state = createSafeProposalState([SAFE]);
  const result = await runSafeProposalScan({ state, safes: [SAFE], rpcBatch: rpcFixture(),
    fetchFn: async () => response([{ ...proposal(), confirmationsRequired: null }]) });
  assert.equal(result.changes[0].status, "pending");
  assert.match(buildSafeProposalContent(result.changes), /1\/未知/);
});

test("historical Vault Factory registration overloads decode only at Vault Portal", () => {
  for (const [index, call] of VAULT_CALLS.entries()) {
    const [action] = extractFlapProposalActions(call);
    assert.equal(action.kind, "vaultFactory");
    assert.equal(action.vaultFactory, `0x${call.data.slice(34, 74)}`);
    assert.equal(action.enabled, true);
    assert.equal(action.category === null, index === 0);
    if (index === 2) assert.ok(action.extraData.length > 2);
    assert.deepEqual(extractFlapProposalActions({ ...call, to: OTHER }), []);
    assert.equal(extractFlapProposalActions({ ...call, operation: 1 })[0].kind, "unknown");
    assert.equal(extractFlapProposalActions({ ...call, data: call.data.slice(0, index === 0 ? 264 : 328) })[0].kind, "unknown");
  }
  const invalidBool = `0x4809625b${word(TOKEN)}${word(2)}${word(0)}${word(1)}`;
  assert.equal(extractFlapProposalActions({ to: VAULT_PORTAL, data: invalidBool })[0].kind, "unknown");
  assert.equal(extractFlapProposalActions({ to: VAULT_PORTAL, data: vaultCall(TOKEN, 256) })[0].kind, "unknown");
});

test("mixed MultiSend keeps each Vault Factory separate from quote tokens, deduplicates and tracks execution", async () => {
  const state = createSafeProposalState([SAFE]);
  const p = { ...proposal(), to: MULTISEND, operation: 1, data: encodeMultiSend([
    { to: VAULT_PORTAL, data: vaultCall(TOKEN) },
    { to: FACTORY, data: enableCall(TOKEN) },
    { to: VAULT_PORTAL, data: vaultCall(OTHER, 1) },
    { to: VAULT_PORTAL, data: vaultCall(TOKEN, 9) },
  ]) };
  const scan = confirmations => runSafeProposalScan({ state, safes: [SAFE], rpcBatch: rpcFixture(),
    fetchFn: async () => response([{ ...p, confirmations: proposal({ confirmations }).confirmations }]) });
  let result = await scan(1);
  assert.equal(result.changes.length, 3);
  assert.equal(new Set(result.changes.map(c => c.id)).size, 3);
  const vault = result.changes.find(c => c.vaultFactory === TOKEN);
  assert.equal(vault.quoteToken, "");
  assert.equal(vault.actions.length, 2);
  const card = buildSafeProposalContent([vault]);
  assert.match(card, /Vault Factory 注册／配置更新/);
  assert.ok(card.includes(`https://flap.sh/launch?vaultfactory=${TOKEN}&chain=bnb&lang=zh`));
  assert.equal((card.match(/vaultfactory=/g) || []).length, 1);
  assert.doesNotMatch(buildSafeProposalContent(result.changes.filter(c => !c.vaultFactory)), /vaultfactory=/);
  assert.match(card, /未提供（四参数版本）/);
  assert.match(card, /未知分类（9）/);
  assert.doesNotMatch(card, /计价代币：/);
  result = await scan(1);
  assert.equal(result.changes.length, 0);
  result = await scan(2);
  assert.deepEqual(result.changes.map(c => c.type), ["ready", "ready", "ready"]);
  const restored = migrateSafeProposalState(JSON.parse(JSON.stringify(state)), [SAFE]);
  let getterCalls = 0;
  result = await runSafeProposalScan({ state: restored, safes: [SAFE],
    rpcBatch: async calls => { getterCalls += calls.filter(c => c.params?.[0]?.data !== "0xaffed0e0").length; return rpcFixture({ nonce: 13 })(calls); },
    fetchFn: async url => url.includes("/multisig-transactions/0x")
      ? jsonResponse({ ...p, isExecuted: true, isSuccessful: true, transactionHash: `0x${"ab".repeat(32)}` }) : response([]) });
  assert.equal(result.changes.length, 3);
  assert.ok(result.changes.every(c => c.type === "executed"));
  assert.equal(getterCalls, 2, "only the quote token uses quote configuration getters");
  assert.equal(result.changes.filter(c => c.vaultFactory).length, 2);
});


test("EOA signature simulation encodes dynamic arguments without storing or broadcasting signatures", async () => {
  const p = proposal({ confirmations: 2 });
  p.confirmations.forEach(c => { c.signature = "0x" + "11".repeat(64) + "1b"; });
  const data = encodeSafeExecutionSimulation(p);
  assert.ok(data.startsWith("0x6a761202"));
  assert.equal(BigInt("0x" + data.slice(10 + 2 * 64, 10 + 3 * 64)), 320n);
  const state = createSafeProposalState([SAFE]);
  const callsSeen = [];
  await runSafeProposalScan({ state, safes: [SAFE], fetchFn: async () => response([p]), rpcBatch: async calls => {
    callsSeen.push(...calls);
    return calls.map(c => uintResult(c.params[0].data.startsWith("0x6a761202") ? 1 : 12));
  } });
  assert.ok(callsSeen.every(c => c.method === "eth_call"));
  assert.equal(Object.values(state.proposals)[0].executionCheck.status, "passed");
  assert.equal(JSON.stringify(state).includes(p.confirmations[0].signature), false);
  p.confirmations[0].signature = "0x" + "11".repeat(64) + "00";
  assert.equal(encodeSafeExecutionSimulation(p), null);
});

test("future nonce prevents executable claim and one missing nonce does not block another Safe", async () => {
  const state = createSafeProposalState([SAFE, OTHER]);
  const p = proposal({ confirmations: 2, nonce: 13 });
  await runSafeProposalScan({ state, safes: [SAFE, OTHER], fetchFn: async () => response([p]),
    rpcBatch: async () => [uintResult(12), null] });
  const record = Object.values(state.proposals)[0];
  assert.equal(record.nonceBlocked, true);
  assert.equal(record.executionCheck.status, "blocked");
  assert.match(state.safes[OTHER].lastError, /nonce/);
  assert.equal(state.safes[SAFE].baselineEstablished, true);
});
