import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCardJson } from "./shared/feishu-client.mjs";

const installSource = readFileSync(new URL("./install.sh", import.meta.url), "utf-8");

function extractHeredoc(commandName, marker = "EOF") {
  const startLine = `cat > "$BIN_DIR/${commandName}" << '${marker}'`;
  const start = installSource.indexOf(startLine);
  assert.notEqual(start, -1, `未找到 ${commandName}`);
  const bodyStart = installSource.indexOf("\n", start) + 1;
  const end = installSource.indexOf(`\n${marker}`, bodyStart);
  assert.notEqual(end, -1, `未找到 ${commandName} 结束标记`);
  return installSource.slice(bodyStart, end);
}

function extractNodeEvalScripts(source) {
  return [...source.matchAll(/node -e "([\s\S]*?)"(?:\s+2>\/dev\/null)?/g)].map(match => match[1]);
}

function renderFourmemeStatus(snapshot) {
  const source = extractHeredoc("fm-status");
  const script = extractNodeEvalScripts(source).find(item => item.includes("openFourTemplates"));
  assert.ok(script, "未找到 Four.meme 快照状态渲染器");
  const dir = mkdtempSync(join(tmpdir(), "monitor-suite-status-"));
  const snapshotPath = join(dir, "snapshot.json");
  try {
    writeFileSync(snapshotPath, JSON.stringify(snapshot), "utf-8");
    const runnable = script.replace("'$SNAP'", JSON.stringify(snapshotPath));
    const result = spawnSync(process.execPath, ["-e", runnable], { encoding: "utf-8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("PM2 status parser accepts ANSI-prefixed JSON", () => {
  const helper = extractHeredoc("_pm2-proc-info", "HELPER_EOF").replace(/^#!.*\n/, "");
  const pm2Data = [{
    name: "fourmeme-monitor",
    pid: 123,
    pm2_env: { status: "online", restart_time: 2, pm_uptime: Date.now() - 60_000 },
    monit: { memory: 64 * 1024 * 1024, cpu: 1.5 },
  }];
  const result = spawnSync(process.execPath, ["-e", helper, "unused", "fourmeme-monitor"], {
    input: `\u001b[?25l>\n${JSON.stringify(pm2Data)}\n\u001b[?25h`,
    encoding: "utf-8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /状态: 在线/);
  assert.match(result.stdout, /PID: 123/);
  assert.doesNotMatch(result.stdout, /解析失败|●|○/);
});

test("startup status commands contain no emoji, markdown bullets or omitted-item copy", () => {
  for (const name of ["fm-status", "fl-status", "bot-status", "mon-status"]) {
    const source = extractHeredoc(name);
    assert.doesNotMatch(source, /[\p{Extended_Pictographic}]/u, `${name} 仍包含 emoji`);
    assert.doesNotMatch(source, /console\.log\(['"]-\s|echo\s+["']-\s/, `${name} 仍包含列表蓝点`);
    assert.doesNotMatch(source, /\.\.\. 还有|…/, `${name} 仍包含省略内容`);
  }
});

test("embedded status command JavaScript is syntactically valid", () => {
  for (const name of ["fm-status", "fl-status", "mon-status"]) {
    const scripts = extractNodeEvalScripts(extractHeredoc(name));
    assert.ok(scripts.length > 0, `${name} 未找到内嵌 JavaScript`);
    for (const script of scripts) {
      assert.doesNotThrow(() => new Function(script), `${name} 内嵌 JavaScript 语法错误`);
    }
  }
});

test("Four.meme pool status keeps only the requested four fields", () => {
  const source = extractHeredoc("fm-status");
  const poolLine = source.split("\n").find(line => line.includes("allPools.entries()) console.log"));
  assert.ok(poolLine, "未找到底池状态输出");
  for (const field of ["符号", "状态", "地址", "募集总量"]) assert.match(poolLine, new RegExp(field));
  assert.doesNotMatch(poolLine, /买入费|卖出费|初始金额|buyFee|sellFee|b0Amount/);
});

test("full Four.meme status keeps useful OpenFour content and removes repetitive technical detail", () => {
  const addresses = Array.from({ length: 12 }, (_, index) => `0x${String(index + 1).padStart(40, "0")}`);
  const output = renderFourmemeStatus({
    poolConfig: [],
    frontendPages: {},
    apiStructure: {},
    openFourTemplates: {
      "101": { id: "101", name: "Launch Agent", status: "PUBLISHED", tag: "Agent", userAddress: addresses[9] },
      "102": { id: "102", name: "Trading Assistant", status: "INIT", tag: "Trading", userAddress: addresses[10] },
    },
    openFourModules: {
      registry: addresses[0],
      presetIds: ["1", "2", "3", "4"],
      byAddress: {
        [addresses[1]]: { roles: ["tokenImpl", "launchpad"], presetIds: ["1", "2", "3"] },
        [addresses[2]]: { roles: ["tokenImpl"], presetIds: ["4"] },
      },
    },
    contractFingerprints: {
      TokenManager: { address: addresses[3], implAddress: addresses[4] },
      AgentFactory: { address: addresses[5], implAddress: addresses[6] },
    },
    onchainParams: { agentNftCount: 2, agentNfts: [addresses[7], addresses[8]] },
    chainActorMonitor: {
      actors: {
        [addresses[9]]: { actionWatched: true, roles: ["creator"], labels: ["TokenManager", "AgentFactory", "OpenFour", "implementation"] },
        [addresses[10]]: { actionWatched: true, roles: ["manual"], labels: ["Manual", "Registry", "Core", "Router"] },
      },
      creators: {},
    },
    githubRepos: {},
  });

  assert.match(output, /OpenFour：模板 2 个｜PUBLISHED 1 个｜模块 2 个｜presetIds 4 个/);
  assert.match(output, /\*\*08｜OpenFour 模板\*\*/);
  assert.match(output, /01　ID 101｜名称 Launch Agent｜状态 PUBLISHED｜标签 Agent/);
  assert.match(output, /02　ID 102｜名称 Trading Assistant｜状态 INIT｜标签 Trading/);
  assert.match(output, /模块：2 个｜presetIds 4 个/);
  assert.match(output, /角色分布：launchpad 1｜tokenImpl 2/);
  assert.doesNotMatch(output, new RegExp(addresses[1]));
  assert.doesNotMatch(output, new RegExp(addresses[4]));
  assert.doesNotMatch(output, new RegExp(addresses[7]));
  assert.match(output, /合约名称：TokenManager、AgentFactory/);
  assert.match(output, /AgentNFT：2 个/);
  assert.match(output, new RegExp(addresses[9]));
  assert.match(output, /角色 创建者/);
  assert.match(output, /角色 手动配置/);
  const actorLines = output.split("\n").filter(line => /^\d{2}　\[0x/.test(line));
  assert.equal(actorLines.length, 2);
  for (const line of actorLines) assert.doesNotMatch(line, /｜标签 |implementation|Registry|Core|Router/);

  const card = JSON.parse(buildCardJson("Four.meme 状态", output, "green"));
  const tables = card.body.elements.filter(element => element.tag === "table");
  assert.ok(tables.length >= 2);
  assert.match(JSON.stringify(tables), /Launch Agent/);
  assert.match(JSON.stringify(tables), /Trading Assistant/);
  assert.ok(tables.every(table => table.columns.every(column => /^\d+px$/.test(column.width))));
});
