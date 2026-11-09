import test from "node:test";
import assert from "node:assert/strict";
import { createTransactionalOutbox } from "../shared/transactional-outbox.mjs";
import { createGithubApi, createGithubMonitor, createGithubTransport, GITHUB_REPOSITORIES, buildHeadQuery } from "./github-monitor.mjs";

function fixture(initial = {}) {
  let timestamp = 1_800_000_000_000;
  let failPersist = false;
  let persisted = structuredClone(initial);
  const sent = [];
  const requests = [];
  const heads = new Map(GITHUB_REPOSITORIES.map((name, index) => [name, { id: `node${index}`, nameWithOwner: name, defaultBranchRef: { name: "main", target: { oid: "old", messageHeadline: "message", committedDate: "2026-10-22T00:00:00Z", url: `https://github.com/${name}/commit/old` } } }]));
  const api = {
    async heads(names) {
      requests.push(names);
      return { data: Object.fromEntries(names.map((name, index) => [`repo${index}`, heads.get(name)])) };
    },
    async rest(path) { requests.push(path); throw new Error("未设置 REST 测试响应"); },
    summary: () => ({}),
  };
  const store = createTransactionalOutbox({ initial, persist: value => { if (failPersist) throw new Error("disk full"); persisted = structuredClone(value); }, deliver: async payload => { sent.push(payload); return "message-id"; } });
  const monitor = createGithubMonitor({ store, api, now: () => timestamp, saveDiff: () => "test.diff" });
  return { monitor, api, store, heads, requests, sent, get persisted() { return persisted; }, set failPersist(value) { failPersist = value; }, advance: value => { timestamp += value; }, change: (name = GITHUB_REPOSITORIES[0], sha = "new") => { heads.get(name).defaultBranchRef.target.oid = sha; } };
}

async function changedFixture() {
  const context = fixture();
  await context.monitor.pollHeads();
  context.change();
  await context.monitor.pollHeads();
  return context;
}

test("GitHub 旧五仓库状态接入flap-sh，保留游标任务，新仓库翻页纳入且只提醒一次", async () => {
  const old = fixture();
  await old.monitor.pollHeads();
  old.change();
  await old.monitor.pollHeads();
  const initial = structuredClone(old.persisted);
  for (const name of GITHUB_REPOSITORIES.slice(5)) delete initial.githubMonitor.repos[name];
  const context = fixture(initial);
  const catalog = GITHUB_REPOSITORIES.map((full_name, i) => ({ full_name, node_id: `node${i}` }));
  const extra = { full_name: 'flap-sh/new-project', node_id: 'new-project' };
  const paths = [];
  context.api.rest = async path => {
    paths.push(path);
    if (path.includes('/users/four-meme-community/')) return { data: catalog.slice(0, 4) };
    return path.endsWith('page=1') ? { data: catalog.slice(5), hasNext: true } : { data: [extra] };
  };
  await context.monitor.discover();
  await context.monitor.discover();
  assert.equal(Object.keys(context.persisted.githubMonitor.repos).length, 9);
  assert.deepEqual(context.persisted.githubMonitor.jobs, initial.githubMonitor.jobs);
  assert.equal(context.persisted.githubMonitor.repos[GITHUB_REPOSITORIES[0]].head, 'new');
  assert.equal(context.persisted._notificationOutbox.length, 5); // original + four additions
  assert.equal(paths.filter(p => p.includes('/users/flap-sh/') && p.endsWith('page=2')).length, 2);
  context.change(GITHUB_REPOSITORIES[0]);
  context.heads.set(extra.full_name, { id: extra.node_id, nameWithOwner: extra.full_name, defaultBranchRef: { name: 'master', target: { oid: 'first' } } });
  await context.monitor.pollHeads();
  assert.equal(context.persisted._notificationOutbox.length, 5); // no historical replay
  context.change(extra.full_name, 'second');
  await context.monitor.pollHeads();
  assert.equal(context.persisted.githubMonitor.jobs.at(-1).repo, extra.full_name);
  assert.equal(context.persisted.githubMonitor.jobs.at(-1).base, 'first');
});

test("GitHub 第二账号失败不提交半份目录、不误报其他账号移除", async () => {
  const context = fixture();
  context.api.rest = async path => ({ data: GITHUB_REPOSITORIES.filter(n => n.startsWith(path.includes('/users/flap-sh/') ? 'flap-sh/' : 'four-meme-community/')).map(full_name => ({ full_name, node_id: full_name })) });
  await context.monitor.discover();
  const before = structuredClone(context.persisted);
  context.api.rest = async path => {
    if (path.includes('/users/flap-sh/')) throw Error('flap unavailable');
    return { data: [] };
  };
  await assert.rejects(context.monitor.discover(), /flap unavailable/);
  assert.deepEqual(context.persisted, before);
  context.api.rest = async () => ({ data: [{ full_name: 'unexpected/repo', node_id: 'bad' }] });
  await assert.rejects(context.monitor.discover(), /账号不匹配/);
  assert.deepEqual(context.persisted, before);
});

test("GitHub 八仓库单次 GraphQL 建立基线，不回放历史", async () => {
  const context = fixture();
  await context.monitor.pollHeads();
  assert.equal(context.requests.length, 1);
  assert.deepEqual(context.requests[0], GITHUB_REPOSITORIES);
  assert.equal(Object.keys(context.persisted.githubMonitor.repos).length, 8);
  assert.equal(context.persisted._notificationOutbox, undefined);
  assert.match(buildHeadQuery(GITHUB_REPOSITORIES), /repo7: repository/);
});

test("GitHub 每个仓库都提醒，首条不请求详情、不等待 AI，重复探测不重复推送", async () => {
  const context = fixture();
  await context.monitor.pollHeads();
  for (const name of GITHUB_REPOSITORIES) context.change(name);
  await context.monitor.pollHeads();
  await context.monitor.pollHeads();
  assert.equal(context.persisted._notificationOutbox.length, 8);
  assert.equal(context.persisted.githubMonitor.jobs.length, 8);
  assert.ok(context.persisted._notificationOutbox.every(entry => entry.payload.skipAi));
  assert.ok(context.requests.every(Array.isArray));
  await context.monitor.enrich();
  assert.equal(context.requests.length, 3);
});

test("GitHub 游标与首条提醒、详情任务原子落盘，磁盘失败不丢失", async () => {
  const context = fixture();
  await context.monitor.pollHeads();
  context.change();
  context.failPersist = true;
  await assert.rejects(context.monitor.pollHeads(), /disk full/);
  assert.equal(context.store.state.githubMonitor.repos[GITHUB_REPOSITORIES[0]].head, "old");
  context.failPersist = false;
  await context.monitor.pollHeads();
  assert.equal(context.persisted._notificationOutbox.length, 1);
  assert.equal(context.persisted.githubMonitor.jobs.length, 1);
});

test("GitHub 迁移旧主仓库 SHA，其他仓库不误报历史", async () => {
  const context = fixture({ githubSha: "previous" });
  await context.monitor.pollHeads();
  assert.equal(context.persisted.githubMonitor.jobs[0].base, "previous");
  assert.equal(context.persisted._notificationOutbox.length, 1);
});

test("GitHub GraphQL 局部错误不推进失败仓库，成功仓库仍提醒", async () => {
  const context = fixture();
  await context.monitor.pollHeads();
  context.change();
  const getHeads = context.api.heads;
  context.api.heads = async names => ({ ...await getHeads(names), errors: [{ path: ["repo1"], message: "unavailable" }] });
  assert.deepEqual(await context.monitor.pollHeads(), { checked: 7, failed: 1 });
  assert.equal(context.persisted._notificationOutbox.length, 1);
  assert.equal(context.persisted.githubMonitor.repos[GITHUB_REPOSITORIES[1]].head, "old");
});

test("GitHub 仓库发现完整翻页、自动纳入，下轮监测提交", async () => {
  const context = fixture();
  await context.monitor.pollHeads();
  const name = "four-meme-community/new-repo";
  context.api.rest = async path => path.includes('/users/flap-sh/') ? { data: [] } : ({ data: path.endsWith("page=1") ? [] : [{ node_id: "new-id", full_name: name }], hasNext: path.endsWith("page=1") });
  await context.monitor.discover();
  context.heads.set(name, { id: "new-id", nameWithOwner: name, defaultBranchRef: { name: "master", target: { oid: "first" } } });
  await context.monitor.pollHeads();
  context.change(name, "second");
  await context.monitor.pollHeads();
  assert.equal(context.persisted.githubMonitor.jobs[0].repo, name);
  assert.equal(context.persisted.githubMonitor.jobs[0].branch, "master");
  assert.equal(context.persisted._notificationOutbox.length, 2);
});

test("GitHub 仓库列表翻页失败不发布不完整结果", async () => {
  const context = fixture();
  await context.monitor.pollHeads();
  context.api.rest = async path => {
    if (path.endsWith("page=2")) throw new Error("timeout");
    return { data: [{ node_id: "new-id", full_name: "four-meme-community/new" }], hasNext: true };
  };
  await assert.rejects(context.monitor.discover(), /timeout/);
  assert.equal(Object.keys(context.persisted.githubMonitor.repos).length, 8);
});

test("GitHub 更名按 node ID 迁移，不丢失基线", async () => {
  const context = fixture();
  await context.monitor.pollHeads();
  context.api.rest = async path => ({ data: path.includes('/users/flap-sh/') ? [] : [{ node_id: "node0", full_name: "four-meme-community/renamed" }] });
  await context.monitor.discover();
  assert.equal(context.persisted.githubMonitor.repos["four-meme-community/renamed"].head, "old");
  assert.equal(context.persisted.githubMonitor.repos[GITHUB_REPOSITORIES[0]], undefined);
});

test("GitHub compare 分页去重，逐提交文件分页，首条送达后才补详情", async () => {
  const context = await changedFixture();
  await context.store.drain();
  let call = 0;
  context.api.rest = async () => {
    call++;
    if (call === 1) return { data: { status: "ahead", total_commits: 2, commits: [{ sha: "one" }] }, hasNext: true };
    if (call === 2) return { data: { status: "ahead", total_commits: 2, commits: [{ sha: "one" }, { sha: "two" }] } };
    if (call === 3) return { data: { sha: "one", files: [{ filename: "a", patch: "+a" }] }, hasNext: true };
    if (call === 4) return { data: { sha: "one", files: [{ filename: "a", patch: "+a" }, { filename: "b" }] } };
    return { data: { sha: "two", files: [{ filename: "c", patch: "+c" }] } };
  };
  for (let count = 0; count < 5; count++) await context.monitor.enrich();
  assert.equal(context.persisted.githubMonitor.jobs.length, 0);
  assert.equal(context.persisted._notificationOutbox.length, 2);
  assert.match(context.persisted._notificationOutbox[0].payload.content, /未提供 patch/);
  assert.equal(context.persisted._notificationOutbox[0].payload.diffFilePath, "test.diff");
});

test("GitHub 详情失败保留任务和分页进度，重启后重试", async () => {
  const context = await changedFixture();
  await context.store.drain();
  await assert.rejects(context.monitor.enrich(), /未设置/);
  assert.equal(context.persisted.githubMonitor.jobs[0].stage, "compare");
  assert.equal(context.persisted.githubMonitor.jobs[0].attempts, 1);
  const resumed = fixture(context.persisted);
  resumed.advance(10_000);
  resumed.api.rest = async () => ({ data: { status: "ahead", commits: [{ sha: "new" }], total_commits: 1 } });
  await resumed.monitor.enrich();
  assert.equal(resumed.persisted.githubMonitor.jobs[0].stage, "files");
});

test("GitHub 分支回退不伪造新提交，空仓库后首次提交也监控", async () => {
  const context = await changedFixture();
  await context.store.drain();
  context.api.rest = async () => ({ data: { status: "behind", commits: [], total_commits: 0 } });
  await context.monitor.enrich();
  assert.match(context.persisted._notificationOutbox[0].payload.content, /没有新增可达提交/);
  const empty = fixture();
  empty.heads.get(GITHUB_REPOSITORIES[0]).defaultBranchRef = null;
  await empty.monitor.pollHeads();
  empty.heads.get(GITHUB_REPOSITORIES[0]).defaultBranchRef = { name: "main", target: { oid: "first" } };
  await empty.monitor.pollHeads();
  assert.equal(empty.persisted.githubMonitor.jobs[0].commits[0].sha, "first");
});

test("GitHub 慢详情不阻塞头探测，新变化仍即时入队", async () => {
  const context = await changedFixture();
  await context.store.drain();
  let release;
  context.api.rest = () => new Promise(resolve => { release = resolve; });
  const detail = context.monitor.enrich();
  context.change(GITHUB_REPOSITORIES[1]);
  await context.monitor.pollHeads();
  assert.equal(context.persisted._notificationOutbox.length, 1);
  release({ data: { status: "ahead", commits: [{ sha: "new" }], total_commits: 1 } });
  await detail;
  assert.equal(context.persisted.githubMonitor.jobs.length, 2);
});

test("GitHub 无 token 不发匿名请求", async () => {
  const api = createGithubApi({ token: "", fetchImpl: () => assert.fail("不得联网") });
  await assert.rejects(api.heads(GITHUB_REPOSITORIES), /GITHUB_TOKEN/);
});

test("GitHub REST 额度不足退避，但 GraphQL 独立预算不被阻塞", async () => {
  let count = 0;
  const api = createGithubApi({ token: "test", now: () => 1000, fetchImpl: async () => {
    count++;
    return new Response("{}", { headers: count === 1 ? { "x-ratelimit-remaining": "99", "x-ratelimit-reset": "60" } : {} });
  } });
  await api.rest("/test");
  await assert.rejects(api.rest("/test"), /退避中/);
  await api.heads(GITHUB_REPOSITORIES);
  assert.equal(count, 2);
});

test("GitHub 二级限流 Retry-After 同时暂停 REST 和 GraphQL", async () => {
  let count = 0;
  const api = createGithubApi({ token: "test", now: () => 1000, fetchImpl: async () => { count++; return new Response("{}", { status: 429, headers: { "retry-after": "120" } }); } });
  await assert.rejects(api.rest("/test"), /429/);
  await assert.rejects(api.heads(GITHUB_REPOSITORIES), /退避中/);
  assert.equal(count, 1);
  assert.equal(api.summary().sharedRetryAt, 121000);
});

test("GitHub GraphQL HTTP 200 限流错误不可当成功", async () => {
  const api = createGithubApi({ token: "test", fetchImpl: async () => new Response(JSON.stringify({ errors: [{ type: "RATE_LIMITED", message: "rate limited" }] })) });
  await assert.rejects(api.heads(GITHUB_REPOSITORIES), /限流/);
});

test("GitHub GraphQL 保存真实 cost 并按 remaining/reset 暂停", async () => {
  const api = createGithubApi({ token: "test", now: () => 1000, fetchImpl: async () => new Response(JSON.stringify({ data: { rateLimit: { cost: 2, remaining: 50, resetAt: "2026-10-22T00:00:00Z" } } })) });
  await api.heads(GITHUB_REPOSITORIES);
  assert.equal(api.summary().budgets.graphql.cost, 2);
  await assert.rejects(api.heads(GITHUB_REPOSITORIES), /退避中/);
});

test("GitHub 默认分支更换即使 SHA 一致也提醒", async () => {
  const context = fixture();
  await context.monitor.pollHeads();
  context.heads.get(GITHUB_REPOSITORIES[0]).defaultBranchRef.name = "develop";
  await context.monitor.pollHeads();
  assert.equal(context.persisted._notificationOutbox.length, 1);
  assert.equal(context.persisted.githubMonitor.jobs[0].branch, "develop");
});

test("GitHub 保留仓库元数据变化，pushed_at 不重复发项目提醒", async () => {
  const context = fixture();
  let description = "old";
  let pushed = "old";
  context.api.rest = async path => ({ data: path.includes('/users/flap-sh/') ? [] : [{ node_id: "node0", full_name: GITHUB_REPOSITORIES[0], description, pushed_at: pushed }] });
  await context.monitor.discover();
  pushed = "new";
  await context.monitor.discover();
  assert.equal(context.persisted._notificationOutbox, undefined);
  description = "new";
  await context.monitor.discover();
  assert.equal(context.persisted._notificationOutbox.length, 1);
  assert.match(context.persisted._notificationOutbox[0].payload.content, /description：old → new/);
});

test("GitHub 文件 diff 落盘失败不能删除详情任务", async () => {
  const context = await changedFixture();
  await context.store.drain();
  context.api.rest = async () => ({ data: { status: "ahead", commits: [{ sha: "new" }], total_commits: 1 } });
  await context.monitor.enrich();
  const monitor = createGithubMonitor({ store: context.store, api: context.api, saveDiff: () => null });
  context.api.rest = async () => ({ data: { sha: "new", files: [] } });
  await assert.rejects(monitor.enrich(), /文件保存失败/);
  assert.equal(context.store.state.githubMonitor.jobs[0].index, 0);
});

test("GitHub 大于 25 仓库跨轮分批，持久化轮转不遗漏", async () => {
  const names = Array.from({ length: 27 }, (_, index) => `four-meme-community/repo${index}`);
  const context = fixture({ githubRepos: Object.fromEntries(names.map(name => [name, {}])) });
  for (const name of names) context.heads.set(name, { nameWithOwner: name, id: name, defaultBranchRef: { name: "main", target: { oid: "first" } } });
  await context.monitor.pollHeads();
  assert.equal(context.persisted.githubMonitor.headOffset, 25);
  await context.monitor.pollHeads();
  assert.equal(context.requests.length, 2);
  assert.equal(Object.keys(context.persisted.githubMonitor.repos).length, 35);
  assert.equal(new Set(context.requests.flat()).size, 35);
  assert.ok(Object.values(context.persisted.githubMonitor.repos).every(repo => repo.initialized));
});

test("GitHub 慢详情任务轮转，其他仓库详情不会被单个大提交独占", async () => {
  const context = await changedFixture();
  context.change(GITHUB_REPOSITORIES[1]);
  await context.monitor.pollHeads();
  await context.store.drain();
  const paths = [];
  context.api.rest = async path => { paths.push(path); return { data: { status: "ahead", commits: [{ sha: "new" }], total_commits: 1 } }; };
  await context.monitor.enrich();
  await context.monitor.enrich();
  assert.ok(paths[0].includes(GITHUB_REPOSITORIES[0]));
  assert.ok(paths[1].includes(GITHUB_REPOSITORIES[1]));
});

test("GitHub 停止后不再请求或写入", async () => {
  const context = fixture();
  const monitor = createGithubMonitor({ store: context.store, api: context.api, stopped: () => true });
  await Promise.all([monitor.pollHeads(), monitor.discover(), monitor.enrich()]);
  assert.equal(context.requests.length, 0);
  assert.deepEqual(context.persisted, {});
});

for (const duration of [300, 1500, 2500]) test(`GitHub ${duration}ms 响应耗时不重复叠加预算等待`, async () => {
  let timestamp = 0;
  let calls = 0;
  const api = createGithubApi({ token: "test", now: () => timestamp, fetchImpl: async () => {
    calls++;
    timestamp += duration;
    return new Response(JSON.stringify({ data: { rateLimit: { cost: 1, remaining: 4900, resetAt: new Date(3600000).toISOString() } } }));
  } });
  await api.heads(GITHUB_REPOSITORIES);
  assert.equal(api.summary().budgetReadyAt, 750);
  timestamp = duration > 2000 ? 4000 : 2000;
  await api.heads(GITHUB_REPOSITORIES);
  assert.equal(calls, 2);
  assert.equal(api.summary().budgetWaits, 0);
});

test("GitHub 预算等待区别于服务端限流，额度不足仍暂停", async () => {
  let timestamp = 0;
  const api = createGithubApi({ token: "test", now: () => timestamp, fetchImpl: async () => new Response(JSON.stringify({ data: { rateLimit: { cost: 2, remaining: 200, resetAt: new Date(3600000).toISOString() } } })) });
  await api.heads(GITHUB_REPOSITORIES);
  timestamp = 2000;
  await assert.rejects(api.heads(GITHUB_REPOSITORIES), error => error.code === "GITHUB_BUDGET_WAIT");
  assert.equal(api.summary().sharedRetryAt, 0);
  assert.equal(api.summary().budgetWaits, 1);
});

test("GitHub 首次十秒超时不再额外等待，连续失败退避且成功后复位", async () => {
  let timestamp = 0;
  let failing = true;
  let calls = 0;
  const api = createGithubApi({ token: "test", now: () => timestamp, fetchImpl: async () => {
    calls++;
    timestamp += 10_000;
    if (failing) throw new DOMException("timeout", "TimeoutError");
    return new Response("{}");
  } });
  await assert.rejects(api.heads(GITHUB_REPOSITORIES), error => error.kind === "timeout" && error.retryAt === 10000);
  await assert.rejects(api.heads(GITHUB_REPOSITORIES), error => error.retryAt === 24000);
  await assert.rejects(api.heads(GITHUB_REPOSITORIES), error => error.code === "GITHUB_COOLDOWN");
  assert.equal(calls, 2);
  assert.equal(api.summary().diagnostics.graphql.failureCount, 2);
  timestamp = 24000;
  failing = false;
  await api.heads(GITHUB_REPOSITORIES);
  assert.equal(api.summary().diagnostics.graphql.consecutiveFailures, 0);
  failing = true;
  await assert.rejects(api.heads(GITHUB_REPOSITORIES), error => error.retryAt === 44000);
});

test("GitHub 快速断连仍至少间隔两秒，不泄露原始错误内容", async () => {
  let timestamp = 1000;
  let calls = 0;
  const api = createGithubApi({ token: "secret-token", now: () => timestamp, fetchImpl: async () => {
    calls++;
    throw new TypeError("secret-token https://private.example", { cause: { code: "ECONNRESET" } });
  } });
  await assert.rejects(api.heads(GITHUB_REPOSITORIES), error => {
    assert.equal(error.retryAt, 3000);
    assert.equal(error.errorCode, "ECONNRESET");
    assert.doesNotMatch(error.message, /secret-token|private/);
    return error.kind === "network";
  });
  timestamp = 2999;
  await assert.rejects(api.heads(GITHUB_REPOSITORIES), error => error.code === "GITHUB_COOLDOWN");
  assert.equal(calls, 1);
  assert.equal(api.summary().sharedRetryAt, 0);
});

test("GitHub REST 网络失败不冻结 GraphQL，响应体失败记录阶段", async () => {
  const api = createGithubApi({ token: "test", now: () => 1000, fetchImpl: async (_url, options) => {
    if (options.method === "POST") return new Response("{}");
    return { status: 200, ok: true, headers: new Headers(), json: async () => { throw new TypeError("fetch failed", { cause: { code: "UND_ERR_SOCKET" } }); } };
  } });
  await assert.rejects(api.rest("/test"), error => error.phase === "body" && error.errorCode === "UND_ERR_SOCKET");
  await api.heads(GITHUB_REPOSITORIES);
  assert.equal(api.summary().sharedRetryAt, 0);
});

test("GitHub 连续二级限流扩大等待，不被网络快速恢复绕过", async () => {
  let timestamp = 1000;
  let calls = 0;
  const api = createGithubApi({ token: "test", now: () => timestamp, fetchImpl: async () => { calls++; return new Response("{}", { status: 429 }); } });
  await assert.rejects(api.heads(GITHUB_REPOSITORIES));
  assert.equal(api.summary().sharedRetryAt, 61000);
  timestamp = 61000;
  await assert.rejects(api.heads(GITHUB_REPOSITORIES));
  assert.equal(api.summary().sharedRetryAt, 181000);
  timestamp = 180999;
  await assert.rejects(api.rest("/test"), error => error.code === "GITHUB_COOLDOWN");
  assert.equal(calls, 2);
});

test("GitHub HTTP 403 原因未知与认证失败保持保护且不伪装网络超时", async () => {
  for (const [status, kind, wait] of [[403, "forbidden", 60000], [401, "auth", 300000]]) {
    const api = createGithubApi({ token: "test", now: () => 1000, fetchImpl: async () => new Response("{}", { status }) });
    await assert.rejects(api.rest("/test"), error => error.kind === kind);
    assert.equal(api.summary().sharedRetryAt, 1000 + wait);
    await assert.rejects(api.heads(GITHUB_REPOSITORIES), error => error.code === "GITHUB_COOLDOWN");
  }
});

test("GitHub 主额度和 X-Poll-Interval 等待不因网络恢复缩短", async () => {
  for (const [headers, readyAt] of [[{ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "120" }, 121000], [{ "x-poll-interval": "45" }, 46000]]) {
    const api = createGithubApi({ token: "test", now: () => 1000, fetchImpl: async () => new Response("{}", { status: 503, headers }) });
    await assert.rejects(api.rest("/test"));
    assert.equal(api.summary().retryAt.rest, readyAt);
    await assert.rejects(api.rest("/test"), error => error.retryAt === readyAt);
  }
});

test("GitHub Retry-After 日期和无效值不污染冷却时间", async () => {
  for (const [header, expected] of [[new Date(180000).toUTCString(), 180000], ["invalid", 61000]]) {
    const api = createGithubApi({ token: "test", now: () => 1000, fetchImpl: async () => new Response("{}", { status: 429, headers: { "retry-after": header } }) });
    await assert.rejects(api.rest("/test"));
    assert.equal(api.summary().sharedRetryAt, expected);
  }
});

test("GitHub 耗时样本有界且仅记录成功请求，诊断副本不可改内部状态", async () => {
  let timestamp = 0;
  const api = createGithubApi({ token: "test", now: () => timestamp, fetchImpl: async () => { timestamp += 750; return new Response("{}"); } });
  for (let index = 0; index < 125; index++) await api.heads(GITHUB_REPOSITORIES);
  const summary = api.summary();
  assert.equal(summary.diagnostics.graphql.successSamples, 120);
  assert.equal(summary.diagnostics.graphql.successP95Ms, 750);
  summary.diagnostics.graphql.successSamples = 0;
  assert.equal(api.summary().diagnostics.graphql.successSamples, 120);
});

test("GitHub 详情冷却只调整就绪时间，不累加请求失败或丢失分页", async () => {
  const context = await changedFixture();
  await context.store.drain();
  const original = structuredClone(context.persisted.githubMonitor.jobs[0]);
  const retryAt = original.createdAt + 120000;
  context.api.rest = async () => { throw Object.assign(new Error("冷却"), { code: "GITHUB_COOLDOWN", retryAt }); };
  await assert.rejects(context.monitor.enrich());
  assert.deepEqual(context.persisted.githubMonitor.jobs[0], { ...original, retryAt });
  assert.equal(await context.monitor.enrich(), false);
  context.advance(120000);
  context.api.rest = async () => ({ data: { status: "ahead", commits: [{ sha: "new" }], total_commits: 1 } });
  assert.equal(await context.monitor.enrich(), true);
  assert.equal(context.persisted.githubMonitor.jobs[0].stage, "files");
});

test("GitHub 探测网络中断不推进游标，恢复后仍推送新提交并保留详情", async () => {
  const context = fixture();
  await context.monitor.pollHeads();
  const heads = context.api.heads;
  context.change();
  context.api.heads = async () => { throw Object.assign(new Error("timeout"), { code: "GITHUB_REQUEST_FAILED", kind: "timeout" }); };
  await assert.rejects(context.monitor.pollHeads());
  assert.equal(context.persisted.githubMonitor.repos[GITHUB_REPOSITORIES[0]].head, "old");
  context.api.heads = heads;
  await context.monitor.pollHeads();
  await context.monitor.pollHeads();
  assert.equal(context.persisted._notificationOutbox.length, 1);
  assert.equal(context.persisted.githubMonitor.jobs.length, 1);
});

test('GitHub 404/409/410/422不冻结正常REST，也不扩大网络失败计数', async () => {
  for (const status of [404,409,410,422]) {
    let calls=0;
    const api=createGithubApi({token:'test',now:()=>1000,fetchImpl:async()=>new Response('{}',{status:++calls===1?status:200})});
    await assert.rejects(api.rest('/missing'), e=>e.code==='GITHUB_RESOURCE_UNAVAILABLE');
    await api.rest('/healthy');
    assert.equal(calls,2);
    assert.equal(api.summary().retryAt.rest,0);
    assert.equal(api.summary().diagnostics.rest.consecutiveFailures,0);
  }
});

test('GitHub 资源404仍遵守服务端Retry-After和额度保护', async () => {
  const api=createGithubApi({token:'test',now:()=>1000,fetchImpl:async()=>new Response('{}',{status:404,headers:{'retry-after':'60'}})});
  await assert.rejects(api.rest('/missing'));
  await assert.rejects(api.heads(GITHUB_REPOSITORIES),e=>e.code==='GITHUB_COOLDOWN'&&e.retryAt===61000);
});

test('GitHub 不可见仓库隔离后正常仓库继续更新，恢复从旧基线补齐且故障仅通知一次', async () => {
  const c=await changedFixture();await c.store.drain();
  const bad=GITHUB_REPOSITORIES[0], original=structuredClone(c.persisted.githubMonitor.jobs);
  const heads=c.api.heads;let missing=true;
  c.api.heads=async names=>{const r=await heads(names);const i=names.indexOf(bad);if(missing&&i>=0){r.data['repo'+i]=null;r.errors=[{type:'NOT_FOUND',path:['repo'+i]}];}return r;};
  await c.monitor.pollHeads();await c.monitor.pollHeads();
  assert.equal(c.persisted.githubMonitor.repos[bad].availability,'unavailable');
  assert.equal(await c.monitor.enrich(),false);
  assert.deepEqual(c.persisted.githubMonitor.jobs,original);
  c.change(GITHUB_REPOSITORIES[1],'healthy-new');await c.monitor.pollHeads();
  assert.ok(!c.requests.at(-1).includes(bad));
  assert.equal(c.persisted.githubMonitor.repos[GITHUB_REPOSITORIES[1]].head,'healthy-new');
  assert.equal(c.persisted._notificationOutbox.filter(e=>e.payload.title==='GitHub 单仓库监控异常').length,1);
  c.advance(60000);await c.monitor.pollHeads();
  assert.equal(c.persisted._notificationOutbox.filter(e=>e.payload.title==='GitHub 单仓库监控异常').length,1);
  missing=false;c.change(bad,'after-recovery');c.advance(60000);await c.monitor.pollHeads();
  assert.equal(c.persisted.githubMonitor.repos[bad].availability,'healthy');
  assert.equal(c.persisted.githubMonitor.jobs.find(j=>j.head==='after-recovery').base,'new');
  assert.equal(c.persisted._notificationOutbox.filter(e=>e.payload.title==='GitHub 单仓库监控恢复').length,1);
  await c.monitor.pollHeads();
  assert.equal(c.persisted.githubMonitor.jobs.filter(j=>j.head==='after-recovery').length,1);
});

test('GitHub 仓库隔离及历史详情重启保留，全部不可见时不伪造成功检查',async()=>{
  const c=await changedFixture();await c.store.drain();
  c.api.heads=async names=>({data:Object.fromEntries(names.map((_,i)=>['repo'+i,null]))});
  await c.monitor.pollHeads();await c.monitor.pollHeads();
  const last=c.persisted.githubMonitor.lastHeadAt;
  const resumed=fixture(c.persisted);resumed.advance(2000);
  assert.deepEqual(await resumed.monitor.pollHeads(),{checked:0,failed:0});
  assert.equal(resumed.persisted.githubMonitor.lastHeadAt,last);
  assert.deepEqual(resumed.persisted.githubMonitor.jobs,c.persisted.githubMonitor.jobs);
});

test('GitHub 完整目录重现立即恢复探测，持续目录不反复清除隔离',async()=>{
  const c=fixture();await c.monitor.pollHeads();
  const bad=GITHUB_REPOSITORIES[0];
  c.api.rest=async path=>({data:GITHUB_REPOSITORIES.filter(n=>n.startsWith(path.includes('flap-sh')?'flap-sh/':'four-meme-community/')).map(n=>({full_name:n,node_id:c.heads.get(n).id}))});
  await c.monitor.discover();
  c.api.heads=async names=>({data:Object.fromEntries(names.map((n,i)=>['repo'+i,n===bad?null:c.heads.get(n)]))});
  await c.monitor.pollHeads();await c.monitor.pollHeads();
  const retry=c.persisted.githubMonitor.repos[bad].headRetryAt;
  await c.monitor.discover();assert.equal(c.persisted.githubMonitor.repos[bad].headRetryAt,retry);
  const list=c.api.rest;c.api.rest=async path=>{const r=await list(path);r.data=r.data.filter(x=>x.full_name!==bad);return r;};
  await c.monitor.discover();c.api.rest=list;await c.monitor.discover();
  assert.equal(c.persisted.githubMonitor.repos[bad].headRetryAt,0);
});

test('GitHub 更名同步迁移已排队详情，保留原始SHA和进度',async()=>{
  const c=await changedFixture();const before=structuredClone(c.persisted.githubMonitor.jobs[0]);
  const name=GITHUB_REPOSITORIES[0];c.heads.get(name).nameWithOwner='four-meme-community/renamed';
  await c.monitor.pollHeads();
  assert.deepEqual(c.persisted.githubMonitor.jobs[0],{...before,repo:'four-meme-community/renamed'});
});

const resourceFailure=()=>Object.assign(new Error('HTTP 404'),{code:'GITHUB_RESOURCE_UNAVAILABLE',status:404});
test('GitHub 缺失compare保留任务，分步区分仓库及旧提交缺口，不阻塞其他任务',async()=>{
  const c=await changedFixture();await c.store.drain();
  const original=structuredClone(c.persisted.githubMonitor.jobs[0]);
  c.api.rest=async()=>{throw resourceFailure();};assert.equal(await c.monitor.enrich(),false);
  let j=c.persisted.githubMonitor.jobs[0];assert.equal(j.base,original.base);assert.equal(j.stage,'compare');assert.equal(j.recoveryProbe,'repo');
  c.change(GITHUB_REPOSITORIES[1],'another');await c.monitor.pollHeads();await c.store.drain();
  c.api.rest=async()=>({data:{status:'ahead',commits:[{sha:'another'}]}});
  assert.equal(await c.monitor.enrich(),true);
  c.advance(300000);
  c.api.rest=async path=>{if(path.endsWith('/commits/old'))throw resourceFailure();return {data:{full_name:original.repo}};};
  assert.equal(await c.monitor.enrich(),true); // repository can be accessed
  // Another job has a turn; keep focus on the blocked comparison without losing it.
  await c.store.transaction(()=>{c.store.state.githubMonitor.jobs.find(x=>x.repo!==original.repo).retryAt=Number.MAX_SAFE_INTEGER;});
  assert.equal(await c.monitor.enrich(),false);
  j=c.persisted.githubMonitor.jobs.find(x=>x.id===original.id);
  assert.equal(j.blockedReason,'base_unavailable');assert.equal(j.base,original.base);assert.deepEqual(j.commits,[]);
  assert.equal(c.sent.filter(x=>x.title==='GitHub 文件 diff 补全受阻').length,1);
});

test('GitHub 404任务重启后恢复仓库和提交验证，继续原compare并生成diff',async()=>{
  const c=await changedFixture();await c.store.drain();c.api.rest=async()=>{throw resourceFailure();};await c.monitor.enrich();
  const r=fixture(c.persisted);r.advance(300000);
  const paths=[];r.api.rest=async path=>{paths.push(path);if(path.includes('/compare/'))return {data:{status:'ahead',commits:[{sha:'new'}]}};if(path.endsWith('/commits/old'))return {data:{sha:'old'}};if(path.endsWith('/commits/new'))return {data:{sha:'new'}};if(path.includes('/commits/new?'))return {data:{sha:'new',files:[{filename:'a',patch:'+a'}]}};return {data:{full_name:GITHUB_REPOSITORIES[0]}};};
  for(let i=0;i<5;i++)await r.monitor.enrich();
  assert.equal(r.persisted.githubMonitor.jobs.length,0);
  assert.equal(paths.length,5);
  assert.equal(r.persisted._notificationOutbox.filter(e=>e.payload.title.startsWith('GitHub 文件 diff：')).length,1);
});

test('GitHub 隔离写盘失败不提交健康状态或通知',async()=>{
  const c=fixture();await c.monitor.pollHeads();c.api.heads=async()=>({data:{}});await c.monitor.pollHeads();
  const before=structuredClone(c.persisted);c.failPersist=true;
  await assert.rejects(c.monitor.pollHeads(),/disk full/);assert.deepEqual(c.persisted,before);
});

test('GitHub 超时只重建故障通道连接，不产生额外重试且下轮仍复用健康通道',async()=>{
  const made=[],used=[];let fail=false,t=1000;
  const transport=createGithubTransport({makeAgent:()=>{const a={destroyed:false,destroy:async()=>{a.destroyed=true;}};made.push(a);return a;},fetchImpl:async(_url,opts)=>{used.push(opts.dispatcher);if(fail&&opts.method==='POST'){t+=10000;throw Object.assign(new Error('timeout'),{name:'TimeoutError'});}return new Response('{}');}});
  const api=createGithubApi({token:'test',now:()=>t,transport});
  await api.heads([]);await api.rest('/test');fail=true;await assert.rejects(api.heads([]));
  assert.equal(used.length,3);assert.equal(made[0].destroyed,true);assert.equal(made[1].destroyed,false);
  await api.rest('/test');assert.equal(used.at(-1),made[1]);fail=false;await api.heads([]);
  assert.notEqual(used.at(-1),made[0]);assert.equal(api.summary().connectionResets.graphql,1);
  await transport.close();assert.ok(made.every(x=>x.destroyed));
});

test('GitHub 响应体断连也重建对应连接并记录阶段耗时',async()=>{
  let t=1000,resets=[];
  const api=createGithubApi({token:'test',now:()=>t,transport:{fetch:async()=>{t+=300;return {ok:true,status:200,headers:new Headers(),json:async()=>{t+=700;throw Object.assign(new Error('socket'),{code:'UND_ERR_SOCKET'});}};},reset:lane=>resets.push(lane),summary:()=>({})}});
  await assert.rejects(api.heads([]));assert.deepEqual(resets,['graphql']);
  const d=api.summary().diagnostics.graphql;assert.equal(d.headersMs,300);assert.equal(d.bodyMs,700);assert.equal(d.phase,'body');
});

test('GitHub 检查间隔与发现至送达分别统计，首条不等详情及AI',async()=>{
  const c=fixture();await c.monitor.pollHeads();c.advance(2000);c.change();await c.monitor.pollHeads();
  const payload=c.persisted._notificationOutbox[0].payload;assert.equal(payload.skipAi,true);assert.equal(payload.github.kind,'head');
  assert.equal(c.monitor.summary().delivery.pending,1);c.advance(450);c.monitor.recordDelivery(payload);await c.store.drain();
  assert.equal(c.monitor.summary().delivery.pending,0);assert.equal(c.monitor.summary().delivery.last.delayMs,450);assert.equal(c.monitor.summary().headIntervals.p95Ms,2000);
});

test('GitHub 详情请求进行中更名不会被旧任务覆盖',async()=>{
  const c=await changedFixture();await c.store.drain();let release;
  c.api.rest=()=>new Promise(resolve=>{release=resolve;});
  const work=c.monitor.enrich();await new Promise(resolve=>setImmediate(resolve));
  c.heads.get(GITHUB_REPOSITORIES[0]).nameWithOwner='four-meme-community/renamed';await c.monitor.pollHeads();
  release({data:{status:'ahead',commits:[{sha:'new'}]}});await work;
  assert.equal(c.persisted.githubMonitor.jobs[0].repo,'four-meme-community/renamed');assert.equal(c.persisted.githubMonitor.jobs[0].stage,'files');
});

test('GitHub 缺失字段响应不误判仓库已不可见，不推进有效SHA',async()=>{
  const c=fixture();await c.monitor.pollHeads();c.api.heads=async()=>({data:{repo0:{id:'node0',nameWithOwner:GITHUB_REPOSITORIES[0]}}});
  const result=await c.monitor.pollHeads();assert.equal(result.checked,0);assert.equal(c.persisted.githubMonitor.repos[GITHUB_REPOSITORIES[0]].head,'old');assert.equal(c.persisted.githubMonitor.repos[GITHUB_REPOSITORIES[0]].availability,'degraded');
});
