import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

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
