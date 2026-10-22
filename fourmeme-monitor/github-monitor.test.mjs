import test from "node:test";
import assert from "node:assert/strict";
import { createTransactionalOutbox } from "../shared/transactional-outbox.mjs";
import { createGithubApi, createGithubMonitor, GITHUB_REPOSITORIES, buildHeadQuery } from "./github-monitor.mjs";

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

test("GitHub 五仓库单次 GraphQL 建立基线，不回放历史", async () => {
  const context = fixture();
  await context.monitor.pollHeads();
  assert.equal(context.requests.length, 1);
  assert.deepEqual(context.requests[0], GITHUB_REPOSITORIES);
  assert.equal(Object.keys(context.persisted.githubMonitor.repos).length, 5);
  assert.equal(context.persisted._notificationOutbox, undefined);
  assert.match(buildHeadQuery(GITHUB_REPOSITORIES), /repo4: repository/);
});

test("GitHub 每个仓库都提醒，首条不请求详情、不等待 AI，重复探测不重复推送", async () => {
  const context = fixture();
  await context.monitor.pollHeads();
  for (const name of GITHUB_REPOSITORIES) context.change(name);
  await context.monitor.pollHeads();
  await context.monitor.pollHeads();
  assert.equal(context.persisted._notificationOutbox.length, 5);
  assert.equal(context.persisted.githubMonitor.jobs.length, 5);
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
  await assert.rejects(context.monitor.pollHeads(), /GraphQL/);
  assert.equal(context.persisted._notificationOutbox.length, 1);
  assert.equal(context.persisted.githubMonitor.repos[GITHUB_REPOSITORIES[1]].head, "old");
});

test("GitHub 仓库发现完整翻页、自动纳入，下轮监测提交", async () => {
  const context = fixture();
  await context.monitor.pollHeads();
  const name = "four-meme-community/new-repo";
  context.api.rest = async path => ({ data: path.endsWith("page=1") ? [] : [{ node_id: "new-id", full_name: name }], hasNext: path.endsWith("page=1") });
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
  assert.equal(Object.keys(context.persisted.githubMonitor.repos).length, 5);
});

test("GitHub 更名按 node ID 迁移，不丢失基线", async () => {
  const context = fixture();
  await context.monitor.pollHeads();
  context.api.rest = async () => ({ data: [{ node_id: "node0", full_name: "four-meme-community/renamed" }] });
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
  context.api.rest = async () => ({ data: [{ node_id: "node0", full_name: GITHUB_REPOSITORIES[0], description, pushed_at: pushed }] });
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
  assert.equal(Object.keys(context.persisted.githubMonitor.repos).length, 32);
  assert.equal(new Set(context.requests.flat()).size, 32);
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
