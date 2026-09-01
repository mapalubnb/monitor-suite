import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SAFE_MULTISEND_SELECTOR,
  SET_QUOTE_TOKEN_CREATION_DISABLED_SELECTOR,
  acknowledgeSafeProposalChanges,
  createSafeProposalState,
  decodeMultiSendTransactions,
  extractFlapEnableTargets,
  fetchSafeProposals,
  loadSafeProposalState,
  runSafeProposalScan,
  saveSafeProposalState,
} from "./safe-proposal-monitor.mjs";

const FACTORY = "0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0";
const SAFE = "0xc68f29bfe2f6c3d95adb5685592b9f86680968f2";
const CHECKSUM_SAFE = "0xc68f29BfE2f6c3D95AdB5685592B9F86680968f2";
const TOKEN = "0xe87afb3076aeb0f9b14e368de8145ae6a2826a14";
const OTHER = "0x1111111111111111111111111111111111111111";
const SAFE_TX_HASH = `0x${"97".repeat(32)}`;
const word = value => {
  const hex = typeof value === "number" || typeof value === "bigint"
    ? BigInt(value).toString(16)
    : String(value).replace(/^0x/, "");
  return hex.padStart(64, "0");
};
const uintResult = value => `0x${BigInt(value).toString(16).padStart(64, "0")}`;
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
  assert.deepEqual(extractFlapEnableTargets({ to: OTHER, data, operation: 1 }, { factoryAddress: FACTORY }), [TOKEN]);
});

test("first successful Safe poll establishes a baseline without historical alerts", async () => {
  const state = createSafeProposalState([SAFE]);
  const result = await runSafeProposalScan({
    state,
    safes: [SAFE],
    factoryAddress: FACTORY,
    rpcBatch: rpcFixture(),
    fetchFn: async () => response([proposal()]),
    nowMs: Date.parse("2026-08-24T04:00:00Z"),
  });
  assert.equal(result.changed, false);
  assert.equal(state.safes[SAFE].baselineEstablished, true);
  assert.equal(Object.values(state.proposals).length, 1);
  assert.equal(state.pendingChanges.length, 0);
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

test("advanced Safe nonce alerts only when the quote token remains disabled", async () => {
  const makeState = () => {
    const state = createSafeProposalState([SAFE]);
    state.safes[SAFE].baselineEstablished = true;
    state.proposals[`${SAFE_TX_HASH}:${TOKEN}`] = {
      ...proposal(), key: `${SAFE_TX_HASH}:${TOKEN}`, safe: SAFE, quoteToken: TOKEN,
      status: "pending", confirmations: 1, required: 2, firstSeenAt: "2026-08-24T03:54:42Z",
    };
    return state;
  };
  const invalidatedState = makeState();
  const invalidated = await runSafeProposalScan({
    state: invalidatedState,
    safes: [SAFE],
    factoryAddress: FACTORY,
    rpcBatch: rpcFixture({ nonce: 13, disabled: true }),
    fetchFn: async () => response([]),
    nowMs: 5_000,
  });
  assert.deepEqual(invalidated.changes.map(item => item.type), ["invalidated"]);

  const executedState = makeState();
  const executed = await runSafeProposalScan({
    state: executedState,
    safes: [SAFE],
    factoryAddress: FACTORY,
    rpcBatch: rpcFixture({ nonce: 13, disabled: false }),
    fetchFn: async () => response([]),
    nowMs: 5_000,
  });
  assert.equal(executed.changed, false);
  assert.equal(Object.values(executedState.proposals)[0].status, "executed");

  const unconfiguredState = makeState();
  const unconfigured = await runSafeProposalScan({
    state: unconfiguredState,
    safes: [SAFE],
    factoryAddress: FACTORY,
    rpcBatch: rpcFixture({ nonce: 13, disabled: false, configured: false }),
    fetchFn: async () => response([]),
    nowMs: 5_000,
  });
  assert.deepEqual(unconfigured.changes.map(item => item.type), ["invalidated"]);
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
