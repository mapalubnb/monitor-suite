import { randomUUID } from "node:crypto";
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

export function createGithubApi({ token, fetchImpl = fetch, now = Date.now, onRequest = () => {} }) {
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

  async function request(path, query) {
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
    let status = 0;
    let phase = "connect-or-headers";
    let kind = "network";
    try {
      onRequest();
      const response = await fetchImpl(`https://api.github.com${path}`, {
        method: query ? "POST" : "GET",
        headers: { Authorization: `Bearer ${token.trim()}`, Accept: "application/vnd.github+json", "User-Agent": "fourmeme-monitor", "X-GitHub-Api-Version": "2022-11-28", ...(query ? { "Content-Type": "application/json" } : {}) },
        ...(query ? { body: JSON.stringify({ query }) } : {}),
        signal: AbortSignal.timeout(10_000),
      });
      status = response.status;
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
      diagnostics[lane] = { ...diagnostics[lane], lastSuccessAt: now(), lastDurationMs: durationMs, consecutiveFailures: 0, successSamples: ordered.length, successP95Ms: ordered[Math.ceil(ordered.length * 0.95) - 1], successMaxMs: ordered.at(-1) };
      return { data, hasNext: /rel="next"/.test(response.headers.get("link") || "") };
    } catch (error) {
      failures[lane]++;
      if (kind === "network" && error instanceof SyntaxError) kind = "response";
      const rawCode = [error.cause?.code, error.code, error.name].find(value => typeof value === "string");
      const errorCode = typeof rawCode === "string" && /^[A-Za-z0-9_]{1,64}$/.test(rawCode) ? rawCode : "UNKNOWN";
      if (kind === "network" && /timeout/i.test(errorCode)) kind = "timeout";
      const transient = ["network", "timeout", "server"].includes(kind);
      const delayMs = Math.min(60_000, 2000 * 2 ** Math.min(failures[lane] - 1, 5));
      pause(lane, transient && failures[lane] === 1 ? Math.max(now(), startedAt + 2000) : now() + delayMs, transient ? "网络或上游故障恢复等待" : "请求失败恢复等待");
      if (kind === "rate-limit" || kind === "forbidden") pause("shared", now() + Math.min(900_000, 60_000 * 2 ** Math.min(failures[lane] - 1, 4)), kind === "rate-limit" ? "服务端限流" : "HTTP 403 拒绝（原因待核验）");
      if (kind === "auth") pause("shared", now() + 300_000, "认证失败");
      const detail = { kind, errorCode, status, phase, durationMs: Math.max(0, now() - startedAt), failedAt: now(), retryAt: Math.max(retryAt[lane], sharedRetryAt), consecutiveFailures: failures[lane] };
      diagnostics[lane] = { ...diagnostics[lane], ...detail, failureCount: (diagnostics[lane]?.failureCount || 0) + 1 };
      const label = kind === "rate-limit" ? "限流" : kind;
      throw Object.assign(new Error(`GitHub ${lane} ${label}${status ? ` HTTP ${status}` : ""}，阶段 ${phase}，错误码 ${errorCode}，耗时 ${detail.durationMs}ms，最早恢复 ${formatBeijingTime(detail.retryAt)}`), { code: "GITHUB_REQUEST_FAILED", ...detail });
    }
  }

  return {
    heads: async names => (await request("/graphql", buildHeadQuery(names))).data,
    rest(path) {
      const result = restQueue.then(() => request(path));
      restQueue = result.catch(() => {});
      return result;
    },
    summary: () => ({ budgets: structuredClone(budgets), retryAt: { ...retryAt }, sharedRetryAt, budgetReadyAt, budgetWaits, cooldownReasons: { ...cooldownReasons }, diagnostics: structuredClone(diagnostics) }),
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
      const names = Object.keys(view().repos);
      const errors = [];
      const savedOffset = view().headOffset || 0;
      const offset = savedOffset < names.length ? savedOffset : 0;
      {
        const batch = names.slice(offset, offset + 25);
        const response = await api.heads(batch);
        await change(async state => {
          for (const [index, name] of batch.entries()) {
            if (response.errors?.some(error => !error.path || error.path[0] === `repo${index}`)) {
              errors.push(`${name}: GraphQL 返回错误`);
              continue;
            }
            const repository = response.data?.[`repo${index}`];
            if (!repository) { errors.push(`${name}: 仓库不可见或不存在`); continue; }
            const previous = state.repos[name];
            if (!previous) continue;
            const branch = repository.defaultBranchRef;
            const current = { ...previous, name: repository.nameWithOwner, nodeId: repository.id, checkedAt: now() };
            if (branch && !branch.target?.oid) { errors.push(`${name}: 提交响应不完整`); continue; }
            const head = branch?.target?.oid || "";
            const branchName = branch?.name || "";
            if ((previous.head && (previous.head !== head || previous.branch !== branchName)) || (!previous.head && previous.initialized && head)) {
              const id = randomUUID();
              const url = `https://github.com/${current.name}`;
              const content = `仓库：${current.name}\n默认分支：${branchName || "无（空仓库）"}\n原分支：${previous.branch || "无"}\n原提交：${previous.head || "无"}\n当前提交：${head || "无"}\n摘要：${branch?.target?.messageHeadline || "默认分支已清空"}\n提交时间：${branch?.target?.committedDate ? formatBeijingTime(branch.target.committedDate) : "未知"}\n发现时间：${formatBeijingTime(now())}\n文件 diff 正在后台补充；分支更新不代表每次都是新增提交。`;
              const noticeId = await store.enqueue({ title: "GitHub 代码更新", content, url: branch?.target?.url || url, template: "turquoise", skipAi: true });
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
          state.lastHeadAt = now();
          state.headOffset = offset + 25 >= names.length ? 0 : offset + 25;
          state.headErrors = errors;
          store.state.githubLastPollAt = new Date(now()).toISOString();
        });
        wake();
      }
      if (errors.length) throw new Error(errors.join("；"));
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
            state.repos[repo.full_name] = { ...existing, name: repo.full_name, nodeId: repo.node_id };
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
      const job = structuredClone(view().jobs.find(item => item.retryAt <= now() && !pending.has(item.noticeId)));
      if (!job) return false;
      try {
        if (job.stage === "compare") {
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
            job.notification = { title, content: text.length > 12000 ? `${text.slice(0, 12000)}\n卡片节选，完整 API 返回内容见 diff 文件及提交链接。` : text, diffFilePath, aiInput: text, moduleContext: "GitHub 提交与文件 diff", template: "turquoise", url: `https://github.com/${job.repo}/commit/${sha}` };
            job.index++;
            job.page = 1;
            job.files = [];
          }
        }
        await change(async state => {
          const index = state.jobs.findIndex(item => item.id === job.id);
          if (index < 0) return;
          if (job.notification) {
            await store.enqueue(job.notification);
            delete job.notification;
          }
          if (job.stage === "files" && job.index === job.commits.length) {
            if (!job.commits.length) await store.enqueue({ title: "GitHub 分支更新详情", content: `仓库：${job.repo}\n分支：${job.branch}\n比较状态：${job.status}\n${job.base} → ${job.head}\n没有新增可达提交；可能为分支回退，不能当作新增提交。`, url: `https://github.com/${job.repo}/compare/${job.base}...${job.head}`, template: "turquoise", skipAi: true });
            state.jobs.splice(index, 1);
          } else {
            state.jobs.splice(index, 1);
            state.jobs.push({ ...job, attempts: 0, retryAt: 0, lastError: "" });
          }
          state.lastDetailAt = now();
        });
        wake();
        return true;
      } catch (error) {
        await change(state => {
          const original = state.jobs.find(item => item.id === job.id);
          if (!original) return;
          if (error.code === "GITHUB_COOLDOWN" || error.code === "GITHUB_BUDGET_WAIT") {
            original.retryAt = error.retryAt;
            return;
          }
          original.attempts++;
          original.lastError = error.message;
          original.retryAt = Math.max(error.retryAt || 0, now() + Math.min(300_000, 2000 * 2 ** Math.min(original.attempts, 7)));
        });
        throw error;
      }
    });
  }

  return {
    pollHeads, discover, enrich,
    summary: () => {
      const state = view();
      return { repositories: Object.values(state.repos).map(({ name, head, branch, checkedAt }) => ({ name, head, branch, checkedAt })), lastHeadAt: state.lastHeadAt, headErrors: state.headErrors || [], lastDiscoveryAt: state.lastDiscoveryAt, lastDetailAt: state.lastDetailAt, pendingDetails: state.jobs.length, oldestDetailAt: state.jobs.length ? Math.min(...state.jobs.map(job => job.createdAt)) : 0, detailErrors: state.jobs.filter(job => job.lastError).map(({ repo, lastError, retryAt }) => ({ repo, lastError, retryAt })), ...api.summary() };
    },
  };
}
