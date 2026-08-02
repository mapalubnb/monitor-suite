import { createReadStream, existsSync, renameSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { migrateFactoryPoolState } from "./factory-pool-monitor.mjs";

const require = createRequire(import.meta.url);
const { chain } = require("stream-chain");
const { parser } = require("stream-json");
const { ignore } = require("stream-json/filters/Ignore");
const { streamObject } = require("stream-json/streamers/StreamObject");

const LARGE_TOP_LEVEL_FIELDS = ["candidates", "relatedSelectors", "blockCheckpoints", "proxyUpgradeEvents"];

export async function compactFactoryPoolStateFile(inputPath, outputPath = inputPath) {
  const input = resolve(inputPath);
  const output = resolve(outputPath);
  if (!existsSync(input)) throw new Error(`状态文件不存在：${input}`);

  const raw = {};
  const inputBytes = statSync(input).size;
  const jsonStream = chain([
    createReadStream(input, { encoding: "utf-8" }),
    parser({ streamValues: false }),
    ...LARGE_TOP_LEVEL_FIELDS.map(field => ignore({ filter: field })),
    streamObject(),
  ]);
  for await (const { key, value } of jsonStream) raw[key] = value;

  raw.candidates = {};
  const state = migrateFactoryPoolState(raw);
  for (const [address, asset] of Object.entries(state.assets || {})) {
    state.candidates[address] = {
      quoteToken: address,
      firstSeenBlock: asset.firstSeenBlock ?? null,
      lastSeenBlock: asset.lastSeenBlock ?? asset.lastVerifiedBlock ?? null,
      sources: [],
      sourceCount: 0,
      pendingVerification: false,
      verifyFailureCount: 0,
      consecutiveVerifyFailures: 0,
      lastVerifyAttemptAtMs: asset.lastVerifiedAtMs || 0,
      lastVerifyBlock: asset.lastVerifiedBlock || 0,
      lastVerifiedAt: asset.metadataUpdatedAt || "",
      configured: Boolean(asset.configured),
      creationDisabled: Boolean(asset.creationDisabled),
      effectiveEnabled: Boolean(asset.effectiveEnabled),
    };
  }

  const content = JSON.stringify(state);
  const temp = `${output}.tmp`;
  writeFileSync(temp, content, "utf-8");
  if (input === output) renameSync(input, `${input}.oversized-backup-${Date.now()}`);
  renameSync(temp, output);
  return {
    input,
    output,
    inputBytes,
    outputBytes: Buffer.byteLength(content),
    assets: Object.keys(state.assets || {}).length,
    candidates: Object.keys(state.candidates || {}).length,
  };
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  const input = process.argv[2];
  const output = process.argv[3] || input;
  if (!input) {
    console.error("用法：node flap-monitor/compact-factory-pool-state.mjs <旧状态文件> [新状态文件]");
    process.exit(1);
  }
  compactFactoryPoolStateFile(input, output).then(result => {
    console.log(`Factory 状态瘦身完成：资产 ${result.assets} 个，候选 ${result.candidates} 个，${result.inputBytes} -> ${result.outputBytes} bytes`);
  }).catch(error => {
    console.error(`Factory 状态瘦身失败：${error.message}`);
    process.exit(1);
  });
}
