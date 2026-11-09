import { randomUUID } from "node:crypto";
import { Agent } from "undici";
import { formatBeijingTime } from "../shared/display-format.cjs";

export const GITHUB_DISCOVERY_OWNERS = ["four-meme-community", "flap-sh"];

export const GITHUB_REPOSITORIES = [
  "four-meme-community/four-meme-ai",
  "four-meme-community/openfour-docs",
  "four-meme-community/openfour-boost-launchpad",
  "four-meme-community/fourmeme-docs",
  "bnb-chain/bnb-chain.github.io",
  "flap-sh/FlapVaultExample",
  "flap-sh/flap-vault-component-template",
  "flap-sh/flap-skills",
];

export function buildHeadQuery(names) {
  return `query { rateLimit { cost remaining resetAt } ${names.map((name, index) => {
    const [owner, repo] = name.split("/");
    return `repo${index}: repository(owner:${JSON.stringify(owner)}, name:${JSON.stringify(repo)}) {
      id nameWithOwner url defaultBranchRef { name target { ... on Commit { oid messageHeadline committedDate url } } }
    }`;
  }).join(" ")} }`;
}

// Each lane has only one in-flight request. Retire a failed connection without
// aborting the other lane or changing the process-wide dispatcher.
export function createGithubTransport({ fetchImpl = fetch, makeAgent = () => new Agent({ connections: 1, pipelining: 1, keepAliveTimeout: 30_000, keepAliveMaxTimeout: 120_000, connect: { autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 250 } }) } = {}) {
  const pools = new Map();
  const resets = { graphql: 0, rest: 0 };
  return {
    fetch(url, options) {
      const lane = options.method === "POST" ? "graphql" : "rest";
      if (!pools.has(lane)) pools.set(lane, makeAgent());
      return fetchImpl(url, { ...options, dispatcher: pools.get(lane) });
    },
    reset(lane) {
      const pool = pools.get(lane);
      if (!pool) return;
      pools.delete(lane);
      resets[lane]++;
      void Promise.resolve(pool.destroy()).catch(() => {});
    },
    summary: () => ({ connectionResets: { ...resets } }),
    async close() { const all = [...pools.values()]; pools.clear(); await Promise.allSettled(all.map(pool => pool.destroy())); },
  };
}

export function createGithubApi({ token, fetchImpl = fetch, transport, now = Date.now, onRequest = () => {} }) {
  const budgets = {};
  const retryAt = { graphql: 0, rest: 0 };
  const failures = { graphql: 0, rest: 0 };
  let sharedRetryAt = 0;
  let budgetReadyAt = 0;
  let budgetWaits = 0;
  let restQueue = Promise.resolve();
  const cooldownReasons = { graphql: "", rest: "", shared: "" };
  const diagnostics = {};
  const durations = { graphql: [], rest: [] };

  function pause(lane, until, reason) {
    if (!Number.isFinite(until)) return;
    if (lane === "shared") {
      if (until >= sharedRetryAt) { sharedRetryAt = until; cooldownReasons.shared = reason; }
    } else if (until >= retryAt[lane]) {
      retryAt[lane] = until;
      cooldownReasons[lane] = reason;
    }
  }

  async function request(path, query, queuedAt = now()) {
    const lane = query ? "graphql" : "rest";
    if (!token?.trim()) throw new Error("GitHub 2秒监控需要 GITHUB_TOKEN；未发送匿名请求");
    const readyAt = Math.max(sharedRetryAt, retryAt[lane]);
    if (now() < readyAt) {
      const reason = cooldownReasons[sharedRetryAt > retryAt[lane] ? "shared" : lane];
      throw Object.assign(new Error(`[退避中] GitHub ${lane} ${reason}，恢复时间 ${formatBeijingTime(readyAt)}`), { code: "GITHUB_COOLDOWN", reason, retryAt: readyAt });
    }
    if (query && now() < budgetReadyAt) {
      budgetWaits++;
      throw Object.assign(new Error("GitHub 本地预算等待（非服务端限流）"), { code: "GITHUB_BUDGET_WAIT", retryAt: budgetReadyAt });
    }
    const startedAt = now();
    let headersAt = 0;
    let status = 0;
    let phase = "connect-or-headers";
    let kind = "network";
    try {
      onRequest();
      const response = await (transport ? transport.fetch : fetchImpl)(`https://api.github.com${path}`, {
        method: query ? "POST" : "GET",
        headers: { Authorization: `Bearer ${token.trim()}`, Accept: "application/vnd.github+json", "User-Agent": "fourmeme-monitor", "X-GitHub-Api-Version": "2022-11-28", ...(query ? { "Content-Type": "application/json" } : {}) },
        ...(query ? { body: JSON.stringify({ query }) } : {}),
        signal: AbortSignal.timeout(10_000),
      });
      status = response.status;
      headersAt = now();
      phase = "body";
      const remaining = response.headers.get("x-ratelimit-remaining");
      const reset = response.headers.get("x-ratelimit-reset");
      if (remaining !== null && reset !== null) budgets[lane] = { remaining: Number(remaining), resetAt: Number(reset) * 1000 };
      if (budgets[lane]?.remaining <= 100) pause(lane, budgets[lane].resetAt + 1000, "主额度保留等待");
      const retryAfter = response.headers.get("retry-after");
      if (retryAfter !== null) pause("shared", now() + (Number.isFinite(Number(retryAfter)) ? Math.max(0, Number(retryAfter)) * 1000 : Math.max(0, Date.parse(retryAfter) - now())), "服务端 Retry-After");
      const pollInterval = Number(response.headers.get("x-poll-interval"));
      if (pollInterval > 0) pause(lane, now() + pollInterval * 1000, "服务端 X-Poll-Interval");
      if (!response.ok) {
        kind = response.status === 429 ? "rate-limit" : response.status === 403 ? "forbidden" : response.status === 401 ? "auth" : response.status >= 500 ? "server" : "http";
        await response.body?.cancel();
        throw new Error(`GitHub ${lane} HTTP ${response.status}`);
      }
      const data = await response.json();
      if (query && data.data?.rateLimit) {
        const rate = data.data.rateLimit;
        budgets.graphql = { cost: rate.cost, remaining: rate.remaining, resetAt: Date.parse(rate.resetAt) };
        if (rate.remaining <= 100) pause("graphql", Date.parse(rate.resetAt) + 1000, "主额度保留等待");
        else budgetReadyAt = startedAt + Math.ceil(rate.cost * Math.max(0, Date.parse(rate.resetAt) - startedAt) / (rate.remaining - 100));
      }
      if (query && data.errors?.some(error => error.type === "RATE_LIMITED" || /rate limit|abuse|secondary/i.test(error.message))) {
        kind = "rate-limit";
        throw new Error("GitHub GraphQL 限流，保留游标");
      }
      failures[lane] = 0;
      const durationMs = Math.max(0, now() - startedAt);
      durations[lane].push(durationMs);
      if (durations[lane].length > 120) durations[lane].shift();
      const ordered = [...durations[lane]].sort((left, right) => left - right);
      diagnostics[lane] = { ...diagnostics[lane], lastSuccessAt: now(), lastDurationMs: durationMs, queueMs: startedAt - queuedAt, headersMs: headersAt - startedAt, bodyMs: now() - headersAt, consecutiveFailures: 0, successSamples: ordered.length, successP95Ms: ordered[Math.ceil(ordered.length * 0.95) - 1], successMaxMs: ordered.at(-1) };
      return { data, hasNext: /rel="next"/.test(response.headers.get("link") || "") };
    } catch (error) {
      // A missing comparison/repository is not a failure of the REST lane.
      const resourceError = kind === "http" && [404, 409, 410, 422].includes(status);
      if (!resourceError) failures[lane]++;
      else failures[lane] = 0;
      if (kind === "network" && error instanceof SyntaxError) kind = "response";
      const rawCode = [error.cause?.code, error.code, error.name].find(value => typeof value === "string");
      const errorCode = typeof rawCode === "string" && /^[A-Za-z0-9_]{1,64}$/.test(rawCode) ? rawCode : "UNKNOWN";
      if (kind === "network" && /timeout/i.test(errorCode)) kind = "timeout";
      const transient = ["network", "timeout", "server"].includes(kind);
      if (["network", "timeout"].includes(kind)) transport?.reset(lane);
      const delayMs = Math.min(60_000, 2000 * 2 ** Math.min(failures[lane] - 1, 5));
      if (!resourceError) pause(lane, transient && failures[lane] === 1 ? Math.max(now(), startedAt + 2000) : now() + delayMs, transient ? "网络或上游故障恢复等待" : "请求失败恢复等待");
      if (kind === "rate-limit" || kind === "forbidden") pause("shared", now() + Math.min(900_000, 60_000 * 2 ** Math.min(failures[lane] - 1, 4)), kind === "rate-limit" ? "服务端限流" : "HTTP 403 拒绝（原因待核验）");
      if (kind === "auth") pause("shared", now() + 300_000, "认证失败");
      const detail = { kind: resourceError ? "resource" : kind, errorCode, status, phase, queueMs: startedAt - queuedAt, headersMs: headersAt ? headersAt - startedAt : null, bodyMs: headersAt ? now() - headersAt : null, durationMs: Math.max(0, now() - startedAt), failedAt: now(), retryAt: Math.max(retryAt[lane], sharedRetryAt), consecutiveFailures: failures[lane] };
      diagnostics[lane] = { ...diagnostics[lane], ...detail, failureCount: (diagnostics[lane]?.failureCount || 0) + 1 };
      const label = kind === "rate-limit" ? "限流" : kind;
      throw Object.assign(new Error(`GitHub ${lane} ${label}${status ? ` HTTP ${status}` : ""}，阶段 ${phase}，错误码 ${errorCode}，耗时 ${detail.durationMs}ms${resourceError ? "，仅影响当前资源" : `，最早恢复 ${formatBeijingTime(detail.retryAt)}`}`), { code: resourceError ? "GITHUB_RESOURCE_UNAVAILABLE" : "GITHUB_REQUEST_FAILED", ...detail });
    }
  }

  return {
    heads: async names => (await request("/graphql", buildHeadQuery(names))).data,
    rest(path) {
      const queuedAt = now();
      const result = restQueue.then(() => request(path, undefined, queuedAt));
      restQueue = result.catch(() => {});
      return result;
    },
    summary: () => ({ budgets: structuredClone(budgets), retryAt: { ...retryAt }, sharedRetryAt, budgetReadyAt, budgetWaits, cooldownReasons: { ...cooldownReasons }, diagnostics: structuredClone(diagnostics), ...transport?.summary() }),
  };
}

function freshState(snapshot) {
  const repos = {};
  for (const name of new Set([...GITHUB_REPOSITORIES, ...Object.keys(snapshot.githubRepos || {}).filter(name => GITHUB_DISCOVERY_OWNERS.includes(name.split("/")[0]))])) {
    repos[name] = { name, head: name === GITHUB_REPOSITORIES[0] ? snapshot.githubSha || "" : "", branch: name === GITHUB_REPOSITORIES[0] ? "main" : "" };
  }
  return { version: 1, repos, jobs: [], lastHeadAt: 0, lastDiscoveryAt: 0, lastDetailAt: 0 };
}

export function createGithubMonitor({ store, api, now = Date.now, saveDiff = () => undefined, wake = () => {}, stopped = () => false }) {
  let commits = Promise.resolve();
  const running = new Set();
  const headGaps = [];
  let lastDelivery = null;
  const view = () => store.state.githubMonitor || freshState(store.state);
  function change(fn) {
    const result = commits.then(() => {
      if (stopped()) return;
      return store.transaction(async () => {
        store.state.githubMonitor ||= freshState(store.state);
        await fn(store.state.githubMonitor);
      });
    });
    commits = result.catch(() => {});
    return result;
  }
  async function guarded(lane, fn) {
    if (running.has(lane) || stopped()) return;
    running.add(lane);
    try { return await fn(); } finally { running.delete(lane); }
  }

  async function pollHeads() {
    return guarded("heads", async () => {
      const names = Object.keys(view().repos).filter(name => !(view().repos[name].headRetryAt > now()));
      if (!names.length) return { checked: 0, failed: 0 };
      const errors = [];
      let checked = 0;
      const savedOffset = view().headOffset || 0;
      const offset = savedOffset < names.length ? savedOffset : 0;
      {
        const batch = names.slice(offset, offset + 25);
        const response = await api.heads(batch);
        await change(async state => {
          for (const [index, name] of batch.entries()) {
            const previous = state.repos[name];
            if (!previous) continue;
            const problem = response.errors?.find(error => !error.path || error.path[0] === `repo${index}`);
            const repository = response.data?.[`repo${index}`];
            const incomplete = repository && (!repository.id || !repository.nameWithOwner || !Object.hasOwn(repository, "defaultBranchRef") || (repository.defaultBranchRef && !repository.defaultBranchRef.target?.oid));
            if (problem || !repository || incomplete) {
              const unavailable = problem?.type === "NOT_FOUND" || (!problem && repository === null);
              const reason = unavailable ? "仓库不可访问（可能删除、转私有或权限变化）" : "GraphQL 返回错误或提交响应不完整";
              const count = (previous.headFailures || 0) + 1;
              Object.assign(previous, { availability: unavailable ? "unavailable" : "degraded", lastHeadError: reason, headFailures: count, lastAttemptAt: now(), headRetryAt: count < 2 ? 0 : now() + (unavailable ? 60_000 : Math.min(60_000, 2000 * 2 ** Math.min(count - 1, 5))) });
              if (count >= 2 && !previous.incidentNotified) {
                await store.enqueue({ title: "GitHub 单仓库监控异常", content: `仓库：${name}\n${reason}\n原提交与待补详情已保留；其他仓库继续检查。\n下次恢复探测：${formatBeijingTime(previous.headRetryAt)}`, url: `https://github.com/${name}`, template: "yellow", skipAi: true });
                previous.incidentNotified = true;
              }
              errors.push(`${name}: ${reason}`);
              continue;
            }
            const branch = repository.defaultBranchRef;
            const current = { ...previous, name: repository.nameWithOwner, nodeId: repository.id, checkedAt: now(), lastAttemptAt: now(), availability: "healthy", lastHeadError: "", headFailures: 0, headRetryAt: 0, incidentNotified: false, lastCheckGapMs: previous.checkedAt ? now() - previous.checkedAt : 0 };
            checked++;
            if (previous.incidentNotified) await store.enqueue({ title: "GitHub 单仓库监控恢复", content: `仓库：${current.name}\n已恢复读取，继续从保留的提交基线比较；历史缺口以详情队列为准。`, url: `https://github.com/${current.name}`, template: "green", skipAi: true });
            for (const job of state.jobs) if (job.repo === name) {
              job.repo = current.name;
              if (previous.availability === "unavailable") job.retryAt = 0;
            }
            const head = branch?.target?.oid || "";
            const branchName = branch?.name || "";
            if ((previous.head && (previous.head !== head || previous.branch !== branchName)) || (!previous.head && previous.initialized && head)) {
              const id = randomUUID();
              const url = `https://github.com/${current.name}`;
              const content = `仓库：${current.name}\n默认分支：${branchName || "无（空仓库）"}\n原分支：${previous.branch || "无"}\n原提交：${previous.head || "无"}\n当前提交：${head || "无"}\n摘要：${branch?.target?.messageHeadline || "默认分支已清空"}\n提交时间：${branch?.target?.committedDate ? formatBeijingTime(branch.target.committedDate) : "未知"}\n发现时间：${formatBeijingTime(now())}\n文件 diff 正在后台补充；分支更新不代表每次都是新增提交。`;
              const noticeId = await store.enqueue({ title: "GitHub 代码更新", content, url: branch?.target?.url || url, template: "turquoise", skipAi: true, github: { repo: current.name, kind: "head", detectedAt: now() } });
              if (head) state.jobs.push({ id, repo: current.name, branch: branchName, base: previous.head, head, noticeId, createdAt: now(), stage: previous.head ? "compare" : "files", page: 1, commits: previous.head ? [] : [{ sha: head }], index: 0, files: [], attempts: 0, retryAt: 0 });
            }
            current.head = head;
            current.branch = branchName;
            current.initialized = true;
            // Keep insertion order stable: headOffset indexes this same list
            // next round. Reinserting unchanged names would skip the next batch.
            if (name !== current.name) delete state.repos[name];
            state.repos[current.name] = current;
            if (name === GITHUB_REPOSITORIES[0]) store.state.githubSha = head;
          }
          if (checked) {
            state.lastHeadAt = now();
          }
          state.lastHeadAttemptAt = now();
          state.headOffset = offset + 25 >= names.length ? 0 : offset + 25;
          state.headErrors = Object.values(state.repos).filter(repo => repo.lastHeadError).map(repo => `${repo.name}: ${repo.lastHeadError}`);
          if (checked) store.state.githubLastPollAt = new Date(now()).toISOString();
        });
        wake();
      }
      if (checked) {
        const last = headGaps.at(-1)?.at;
        headGaps.push({ at: now(), gap: last ? now() - last : 0 });
        if (headGaps.length > 121) headGaps.shift();
      }
      return { checked, failed: errors.length };
    });
  }

  async function discover() {
    return guarded("discovery", async () => {
      const found = new Map();
      // Publish only after both accounts are fully read. A failed account/page
      // must not make its previous repositories look deleted. Existing v1
      // snapshots acquire the new account through this same discovery path.
      for (const owner of GITHUB_DISCOVERY_OWNERS) {
        for (let page = 1; ; page++) {
          const response = await api.rest(`/users/${owner}/repos?per_page=100&sort=full_name&direction=asc&page=${page}`);
          if (!Array.isArray(response.data) || response.data.some(repo => !repo.full_name || !repo.node_id || repo.full_name.split("/")[0].toLowerCase() !== owner.toLowerCase())) throw new Error("GitHub 仓库列表响应不完整或账号不匹配");
          for (const repo of response.data) found.set(repo.node_id, repo);
          if (!response.hasNext) break;
        }
      }
      await change(async state => {
        const previousCatalog = state.catalog || store.state.githubRepos;
        const catalog = {};
        for (const repo of found.values()) {
          catalog[repo.full_name] = { node_id: repo.node_id, full_name: repo.full_name, description: repo.description || "", default_branch: repo.default_branch || "", archived: Boolean(repo.archived), disabled: Boolean(repo.disabled) };
          const before = previousCatalog && (previousCatalog[repo.full_name] || Object.values(previousCatalog).find(item => item.node_id === repo.node_id));
          if (before) {
            const fields = ["description", "default_branch", "archived", "disabled"].filter(field => before[field] !== undefined && before[field] !== catalog[repo.full_name][field]);
            if (fields.length) await store.enqueue({ title: "GitHub 仓库信息变更", content: `仓库：${repo.full_name}\n${fields.map(field => `${field}：${String(before[field])} → ${String(catalog[repo.full_name][field])}`).join("\n")}\n发现时间：${formatBeijingTime(now())}`, url: repo.html_url, template: "turquoise", skipAi: true });
          }
          const existing = Object.values(state.repos).find(item => item.nodeId === repo.node_id || item.name === repo.full_name);
          if (existing) {
            if (existing.name !== repo.full_name) delete state.repos[existing.name];
            for (const job of state.jobs) if (job.repo === existing.name) job.repo = repo.full_name;
            const reappeared = previousCatalog && !Object.values(previousCatalog).some(item => item.node_id === repo.node_id);
            state.repos[repo.full_name] = { ...existing, name: repo.full_name, nodeId: repo.node_id, ...(reappeared || existing.name !== repo.full_name ? { headRetryAt: 0 } : {}) };
          } else {
            state.repos[repo.full_name] = { name: repo.full_name, nodeId: repo.node_id, head: "", branch: "" };
            await store.enqueue({ title: "GitHub 新增监控仓库", content: `仓库：${repo.full_name}\n发现时间：${formatBeijingTime(now())}\n已自动纳入默认分支提交及文件 diff 监控；首次探测建立基线，不回放全部历史。`, url: repo.html_url, template: "turquoise", skipAi: true });
          }
        }
        for (const [name, before] of Object.entries(previousCatalog || {})) {
          if (!catalog[name] && !found.has(before.node_id)) await store.enqueue({ title: "GitHub 仓库列表变化", content: `仓库：${name}\n已从账号公开仓库列表消失，可能为删除、转私有或转移；保留监控基线，不断言已经删除。\n发现时间：${formatBeijingTime(now())}`, url: `https://github.com/${name}`, template: "yellow", skipAi: true });
        }
        state.catalog = catalog;
        state.lastDiscoveryAt = now();
      });
      wake();
    });
  }

  async function enrich() {
    return guarded("details", async () => {
      const pending = new Set((store.state._notificationOutbox || []).map(entry => entry.id));
      const job = structuredClone(view().jobs.find(item => item.retryAt <= now() && !pending.has(item.noticeId) && view().repos[item.repo]?.availability !== "unavailable"));
      if (!job) return false;
      try {
        if (job.recoveryProbe) {
          const probe = job.recoveryProbe;
          const probeSha = probe === "base" ? job.base : probe === "commit" ? job.commits[job.index]?.sha || job.head : job.head;
          const path = probe === "repo" ? `/repos/${job.repo}` : `/repos/${job.repo}/commits/${probeSha}`;
          const result = await api.rest(path);
          if (probe === "repo" ? !result.data.full_name : result.data.sha !== probeSha) throw new Error("GitHub 恢复探测响应不完整");
          job.recoveryProbe = probe === "repo" ? (job.stage === "compare" && job.base ? "base" : "commit") : probe === "base" ? "head" : "";
          if (!job.recoveryProbe) job.blockedReason = "";
        } else if (job.stage === "compare") {
          const result = await api.rest(`/repos/${job.repo}/compare/${job.base}...${job.head}?per_page=100&page=${job.page}`);
          if (!Array.isArray(result.data.commits) || !["ahead", "behind", "diverged", "identical"].includes(result.data.status)) throw new Error("GitHub compare 响应不完整");
          job.status = result.data.status;
          for (const commit of result.data.commits) {
            if (!commit.sha) throw new Error("GitHub compare 缺失提交 SHA");
            if (!job.commits.some(item => item.sha === commit.sha)) job.commits.push({ sha: commit.sha });
          }
          if (result.hasNext) job.page++;
          else {
            if (Number.isFinite(result.data.total_commits) && job.commits.length < result.data.total_commits) throw new Error("GitHub compare 提交分页不完整");
            job.stage = "files";
            job.page = 1;
          }
        } else if (job.index < job.commits.length) {
          const sha = job.commits[job.index].sha;
          const result = await api.rest(`/repos/${job.repo}/commits/${sha}?per_page=100&page=${job.page}`);
          if (result.data.sha !== sha || !Array.isArray(result.data.files)) throw new Error("GitHub commit 文件响应不完整");
          job.message = result.data.commit?.message || sha;
          job.committedAt = result.data.commit?.committer?.date || "";
          for (const file of result.data.files) {
            if (!file.filename) throw new Error("GitHub commit 缺失文件名");
            if (!job.files.some(item => item.filename === file.filename)) job.files.push(file);
          }
          if (result.hasNext && job.files.length < 3000) job.page++;
          else {
            const limitNote = job.files.length >= 3000 || result.hasNext ? "\n注意：已触及 GitHub 单提交 3000 文件上限，不能视为完整 diff。" : "";
            const text = `仓库：${job.repo}\n默认分支：${job.branch}\n提交：${sha}\n提交时间：${job.committedAt ? formatBeijingTime(job.committedAt) : "未知"}\n${job.message}\n比较状态：${job.status || "首次提交"}${limitNote}\n\n${job.files.map(file => `${file.status} ${file.filename}${file.previous_filename ? `（原路径 ${file.previous_filename}）` : ""} +${file.additions} -${file.deletions}\n${file.patch ?? "GitHub 未提供 patch（二进制或超大文件等），请查看提交链接。"}`).join("\n\n")}`;
            const title = `GitHub 文件 diff：${job.repo} ${sha.slice(0, 8)}`;
            const diffFilePath = saveDiff(`GitHub_${job.id.slice(0, 8)}_${sha.slice(0, 12)}`, text);
            if (!diffFilePath) throw new Error("GitHub diff 文件保存失败，保留详情任务重试");
            job.notification = { title, content: text.length > 12000 ? `${text.slice(0, 12000)}\n卡片节选，完整 API 返回内容见 diff 文件及提交链接。` : text, diffFilePath, aiInput: text, moduleContext: "GitHub 提交与文件 diff", template: "turquoise", skipAi: true, url: `https://github.com/${job.repo}/commit/${sha}`, github: { repo: job.repo, kind: "detail", detectedAt: job.createdAt } };
            job.index++;
            job.page = 1;
            job.files = [];
          }
        }
        await change(async state => {
          const index = state.jobs.findIndex(item => item.id === job.id);
          if (index < 0) return;
          // Discovery/head polling may have renamed this repository while REST
          // was in flight. Never restore the stale name from the detached job.
          job.repo = state.jobs[index].repo;
          if (job.notification) {
            await store.enqueue(job.notification);
            delete job.notification;
          }
          if (!job.recoveryProbe && !job.blockedReason && job.stage === "files" && job.index === job.commits.length) {
            if (!job.commits.length) await store.enqueue({ title: "GitHub 分支更新详情", content: `仓库：${job.repo}\n分支：${job.branch}\n比较状态：${job.status}\n${job.base} → ${job.head}\n没有新增可达提交；可能为分支回退，不能当作新增提交。`, url: `https://github.com/${job.repo}/compare/${job.base}...${job.head}`, template: "turquoise", skipAi: true });
            state.jobs.splice(index, 1);
          } else {
            state.jobs.splice(index, 1);
            state.jobs.push({ ...job, attempts: job.recoveryProbe ? job.attempts : 0, retryAt: 0, lastError: job.recoveryProbe ? job.lastError : "" });
          }
          state.lastDetailAt = now();
        });
        wake();
        return true;
      } catch (error) {
        await change(async state => {
          const original = state.jobs.find(item => item.id === job.id);
          if (!original) return;
          if (error.code === "GITHUB_COOLDOWN" || error.code === "GITHUB_BUDGET_WAIT") {
            original.retryAt = error.retryAt;
            return;
          }
          original.attempts++;
          original.lastError = error.message;
          if (error.code === "GITHUB_RESOURCE_UNAVAILABLE") {
            original.blockedReason = job.recoveryProbe === "repo" ? "repository_unavailable" : ["base", "head", "commit"].includes(job.recoveryProbe) ? `${job.recoveryProbe}_unavailable` : "comparison_or_commit_unavailable";
            original.recoveryProbe = "repo";
            original.retryAt = Math.max(error.retryAt || 0, now() + 300_000);
            if (!original.gapNotified) {
              await store.enqueue({ title: "GitHub 文件 diff 补全受阻", content: `仓库：${job.repo}\n${job.base || "无"} → ${job.head}\n资源不可访问，已保留任务、分页进度及历史缺口；其他仓库继续处理。\n后续将核验仓库与原始提交，不将缺失内容视为已补全。`, url: `https://github.com/${job.repo}`, template: "yellow", skipAi: true });
              original.gapNotified = true;
            }
            return;
          }
          original.retryAt = Math.max(error.retryAt || 0, now() + Math.min(300_000, 2000 * 2 ** Math.min(original.attempts, 7)));
        });
        if (error.code === "GITHUB_RESOURCE_UNAVAILABLE") { wake(); return false; }
        throw error;
      }
    });
  }

  return {
    pollHeads, discover, enrich,
    recordDelivery(payload) {
      if (payload.github) lastDelivery = { ...payload.github, sentAt: now(), delayMs: Math.max(0, now() - payload.github.detectedAt) };
    },
    summary: () => {
      const state = view();
      const gaps = headGaps.map(item => item.gap).filter(value => value > 0).sort((a,b) => a-b);
      const pending = (store.state._notificationOutbox || []).filter(entry => entry.payload?.github || entry.payload?.title?.startsWith("GitHub"));
      return { repositories: Object.values(state.repos).map(({ name, head, branch, checkedAt, availability, lastHeadError, headRetryAt, lastCheckGapMs }) => ({ name, head, branch, checkedAt, availability, lastHeadError, headRetryAt, lastCheckGapMs })), lastHeadAt: state.lastHeadAt, headErrors: state.headErrors || [], lastDiscoveryAt: state.lastDiscoveryAt, lastDetailAt: state.lastDetailAt, pendingDetails: state.jobs.length, oldestDetailAt: state.jobs.length ? Math.min(...state.jobs.map(job => job.createdAt)) : 0, detailErrors: state.jobs.filter(job => job.lastError).map(({ repo, lastError, retryAt, blockedReason }) => ({ repo, lastError, retryAt, blockedReason })), headIntervals: { samples: gaps.length, p95Ms: gaps[Math.ceil(gaps.length * .95)-1] || 0, maxMs: gaps.at(-1) || 0 }, delivery: { pending: pending.length, oldestAt: pending.length ? Math.min(...pending.map(item=>item.createdAt)) : 0, last: lastDelivery ? { ...lastDelivery } : null }, ...api.summary() };
    },
  };
}
