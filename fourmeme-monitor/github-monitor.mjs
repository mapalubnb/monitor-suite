import { randomUUID } from "node:crypto";
import { Agent } from "undici";
import { formatBeijingTime } from "../shared/display-format.cjs";
import { AsyncLocalStorage } from "node:async_hooks";
import { createDeadlineSignal, withAbortSignal, withDeadline } from "../shared/request-deadline.mjs";
import { cardStatus, cardTime } from './card-style.mjs';

const repoHeading = (name, url = `https://github.com/${name}`) => `## 📦 [${name}](${url})`;
const plain = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

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
      void Promise.resolve().then(() => pool.destroy()).catch(() => {});
    },
    summary: () => ({ connectionResets: { ...resets } }),
    async close() { const all = [...pools.values()]; pools.clear(); await Promise.allSettled(all.map(pool => withDeadline(() => pool.destroy(), 2000))); },
  };
}

export function createGithubApi({ token, fetchImpl = fetch, transport, now = Date.now, onRequest = () => {}, requestTimeoutMs = 10_000, queueTimeoutMs = 15_000 }) {
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
  const active = {};
  let queuedRest = 0, queueTimeouts = 0, hardTimeouts = 0;

  function pause(lane, until, reason) {
    if (!Number.isFinite(until)) return;
    if (lane === "shared") {
      if (until >= sharedRetryAt) { sharedRetryAt = until; cooldownReasons.shared = reason; }
    } else if (until >= retryAt[lane]) {
      retryAt[lane] = until;
      cooldownReasons[lane] = reason;
    }
  }

  async function request(path, query, queuedAt = now(), parentSignal) {
    parentSignal?.throwIfAborted();
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
    const deadline = createDeadlineSignal(requestTimeoutMs, parentSignal, "GitHub 请求超过强制截止时间");
    const attempt = { path, startedAt, queuedAt, deadlineAt: startedAt + requestTimeoutMs, phase };
    active[lane] = attempt;
    try {
      return await withAbortSignal(async signal => {
        onRequest();
        const response = await (transport ? transport.fetch : fetchImpl)(`https://api.github.com${path}`, {
          method: query ? "POST" : "GET",
          headers: { Authorization: `Bearer ${token.trim()}`, Accept: "application/vnd.github+json", "User-Agent": "fourmeme-monitor", "X-GitHub-Api-Version": "2022-11-28", ...(query ? { "Content-Type": "application/json" } : {}) },
          ...(query ? { body: JSON.stringify({ query }) } : {}),
          signal,
        });
        signal.throwIfAborted();
        status = response.status;
        headersAt = now();
        phase = "body";
        attempt.phase = phase;
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
          // Cleanup is advisory; an uncooperative stream must not hold the queue.
          void Promise.resolve().then(() => response.body?.cancel()).catch(() => {});
          transport?.reset(lane);
          throw new Error(`GitHub ${lane} HTTP ${response.status}`);
        }
        const data = await response.json();
        signal.throwIfAborted(); // Late bodies must not overwrite fresh budgets/health.
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
      }, deadline.signal);
    } catch (error) {
      if (deadline.signal.aborted && /TimeoutError/.test(deadline.signal.reason?.name || "")) {
        kind = "timeout";
        hardTimeouts++;
      }
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
    } finally {
      deadline.dispose();
      if (active[lane] === attempt) delete active[lane];
    }
  }

  return {
    heads: async (names, { signal } = {}) => (await request("/graphql", buildHeadQuery(names), now(), signal)).data,
    async rest(path, { signal } = {}) {
      const queuedAt = now();
      const waiting = createDeadlineSignal(queueTimeoutMs, signal, "GitHub REST 排队超过截止时间");
      let started = false;
      queuedRest++;
      const result = restQueue.then(() => {
        waiting.signal.throwIfAborted();
        started = true;
        waiting.dispose();
        return request(path, undefined, queuedAt, signal);
      });
      restQueue = result.catch(() => {});
      try { return await withAbortSignal(() => result, waiting.signal); }
      catch (error) {
        if (!started && waiting.signal.aborted && !signal?.aborted) {
          queueTimeouts++;
          throw Object.assign(new Error("GitHub REST 排队超时，已取消未开始的请求"), { code: "GITHUB_QUEUE_TIMEOUT", kind: "timeout", phase: "queue", retryAt: now() + 2000 });
        }
        throw error;
      } finally { queuedRest--; waiting.dispose(); }
    },
    summary: () => ({ budgets: structuredClone(budgets), retryAt: { ...retryAt }, sharedRetryAt, budgetReadyAt, budgetWaits, cooldownReasons: { ...cooldownReasons }, diagnostics: structuredClone(diagnostics), requests: { active: structuredClone(active), restPending: queuedRest, queueTimeouts, hardTimeouts }, ...transport?.summary() }),
  };
}

// Retire only GitHub's old detail work before the persisted outbox can drain.
// Keep the IDs and part boundaries of surviving, possibly partly sent cards.
export function retireGithubDetails(snapshot) {
  const state = snapshot.githubMonitor;
  const fields = [[state, "jobs"], [state, "lastDetailAt"], [state?.health, "details"], [snapshot.moduleErrors, "githubDetails"]];
  let changed = false;
  for (const [obj, key] of fields) {
    if (obj && Object.hasOwn(obj, key)) {
      delete obj[key];
      changed = true;
    }
  }
  if (Array.isArray(snapshot._notificationOutbox)) {
    const surviving = [];
    for (const entry of snapshot._notificationOutbox) {
      const { title, github } = entry.payload || {};
      if (github?.kind === "detail" || /^GitHub (?:文件 diff(?:[：:\s]|$)|分支更新详情$|详情通道(?:停滞|恢复)$|新提交（\d+个）$)/u.test(title || "")) {
        changed = true;
        continue;
      }
      const oldStatus = title === "GitHub 代码更新" ? "默认分支变化 / 文件 diff 待补"
        : title === "GitHub 新增监控仓库" ? "已纳入默认分支与文件 diff 监控" : "";
      if (oldStatus) {
        const status = title === "GitHub 代码更新" ? "默认分支变化" : "已纳入默认分支监控";
        for (const card of [entry.payload, ...(entry.cardParts || [])]) {
          if (card.content?.includes(oldStatus)) {
            card.content = card.content.replace(oldStatus, status);
            changed = true;
          }
        }
      }
      surviving.push(entry);
    }
    if (surviving.length !== snapshot._notificationOutbox.length) snapshot._notificationOutbox = surviving;
  }
  return changed;
}

function freshState(snapshot) {
  const repos = {};
  for (const name of new Set([...GITHUB_REPOSITORIES, ...Object.keys(snapshot.githubRepos || {}).filter(name => GITHUB_DISCOVERY_OWNERS.includes(name.split("/")[0]))])) {
    repos[name] = { name, head: name === GITHUB_REPOSITORIES[0] ? snapshot.githubSha || "" : "", branch: name === GITHUB_REPOSITORIES[0] ? "main" : "" };
  }
  return { version: 1, repos, lastHeadAt: 0, lastDiscoveryAt: 0 };
}

export function createGithubMonitor({ store, api, now = Date.now, wake = () => {}, stopped = () => false,
  taskTimeouts = {} }) {
  let commits = Promise.resolve();
  const running = new Map();
  const taskContext = new AsyncLocalStorage();
  const timeouts = { heads: 20_000, discovery: 60_000, ...taskTimeouts };
  const headGaps = [];
  let lastDelivery = null;
  const view = () => store.state.githubMonitor || freshState(store.state);
  function assertActive(attempt = taskContext.getStore()) {
    if (!attempt) return;
    attempt.signal.throwIfAborted();
    if (stopped() || running.get(attempt.lane) !== attempt) throw Object.assign(new Error("GitHub 过期任务结果已隔离"), { code: "GITHUB_STALE_TASK" });
  }
  function change(fn) {
    const attempt = taskContext.getStore();
    const result = commits.then(() => {
      assertActive(attempt);
      if (stopped()) return;
      return store.transaction(async () => {
        assertActive(attempt);
        store.state.githubMonitor ||= freshState(store.state);
        await fn(store.state.githubMonitor);
        assertActive(attempt);
      }, { signal: attempt?.signal });
    });
    commits = result.catch(() => {});
    return result;
  }
  const laneName = lane => ({ discovery: "仓库发现", heads: "提交探测" })[lane];
  async function incident(state, lane, reason) {
    state.health ||= {};
    const previous = state.health[lane] || {};
    state.health[lane] = { ...previous, active: true, since: previous.active ? previous.since : now(), lastRecoveryAt: now(), recoveries: (previous.recoveries || 0) + 1, reason };
    if (!previous.active) await store.enqueue({ title: `GitHub ${laneName(lane)}通道停滞`, content: `${cardStatus('warning', '工作已隔离 / 调度继续')}\n${reason}\n提交基线与待发通知已保留，恢复请求遵守服务端限流。`, template: "yellow", skipAi: true });
  }
  async function recovered(state, lane) {
    const health = state.health?.[lane];
    if (!health?.active) return;
    await store.enqueue({ title: `GitHub ${laneName(lane)}通道恢复`, content: cardStatus('healthy', '采集已恢复 / 进度已保存'), template: "green", skipAi: true });
    Object.assign(health, { active: false, recoveredAt: now() });
  }
  async function guarded(lane, fn) {
    if (running.has(lane) || stopped()) return;
    const deadline = createDeadlineSignal(timeouts[lane], undefined, `GitHub ${laneName(lane)}单轮超过截止时间`);
    const attempt = { id: randomUUID(), lane, signal: deadline.signal, startedAt: now(), deadlineAt: now() + timeouts[lane] };
    running.set(lane, attempt);
    try { return await withAbortSignal(() => taskContext.run(attempt, () => fn(attempt.signal)), attempt.signal); }
    catch (error) {
      if (attempt.signal.aborted && !stopped()) {
        const reason = `GitHub ${laneName(lane)}单轮超过${timeouts[lane] / 1000}秒，已取消本轮`;
        await taskContext.run(undefined, () => change(state => incident(state, lane, reason)));
        wake();
        throw Object.assign(new Error(reason), { code: "GITHUB_TASK_TIMEOUT", kind: "timeout" });
      }
      throw error;
    } finally {
      deadline.dispose();
      if (running.get(lane) === attempt) running.delete(lane);
    }
  }

  async function pollHeads() {
    return guarded("heads", async signal => {
      const names = Object.keys(view().repos).filter(name => !(view().repos[name].headRetryAt > now()));
      if (!names.length) return { checked: 0, failed: 0 };
      const errors = [];
      let checked = 0;
      const savedOffset = view().headOffset || 0;
      const offset = savedOffset < names.length ? savedOffset : 0;
      {
        const batch = names.slice(offset, offset + 25);
        const response = await api.heads(batch, { signal });
        assertActive();
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
                await store.enqueue({ title: "GitHub 单仓库监控异常", content: `${repoHeading(name)}\n${cardStatus('warning', '单仓库读取异常')}\n${reason}\n已保留当前分支基线，其他仓库继续检查。\n下次恢复探测：${formatBeijingTime(previous.headRetryAt)}`, url: `https://github.com/${name}`, cardOpts: { showDetailLink: false }, template: "yellow", skipAi: true });
                previous.incidentNotified = true;
              }
              errors.push(`${name}: ${reason}`);
              continue;
            }
            const branch = repository.defaultBranchRef;
            const current = { ...previous, name: repository.nameWithOwner, nodeId: repository.id, checkedAt: now(), lastAttemptAt: now(), availability: "healthy", lastHeadError: "", headFailures: 0, headRetryAt: 0, incidentNotified: false, lastCheckGapMs: previous.checkedAt ? now() - previous.checkedAt : 0 };
            checked++;
            if (previous.incidentNotified) await store.enqueue({ title: "GitHub 单仓库监控恢复", content: `${repoHeading(current.name)}\n${cardStatus('healthy', '已恢复读取')}\n继续检查默认分支及最新提交。`, url: `https://github.com/${current.name}`, cardOpts: { showDetailLink: false }, template: "green", skipAi: true });
            const head = branch?.target?.oid || "";
            const branchName = branch?.name || "";
            if ((previous.head && (previous.head !== head || previous.branch !== branchName)) || (!previous.head && previous.initialized && head)) {
              const url = `https://github.com/${current.name}`;
              const target = branch?.target?.url || url;
              const content = [
                repoHeading(current.name, target),
                cardStatus('changed', '默认分支变化'),
                `分支：${previous.branch !== branchName ? `${plain(previous.branch || '无')} → ` : ''}${plain(branchName || '无（空仓库）')}`,
                `提交：${previous.head || '无'} → ${head || '无'}`,
                plain(branch?.target?.messageHeadline || '默认分支已清空'),
                '分支更新也可能由回退或切换产生。',
                `提交时间：${branch?.target?.committedDate ? formatBeijingTime(branch.target.committedDate) : '未知'}`,
                `${cardTime(now())}（发现时间）`,
              ].join('\n');
              await store.enqueue({ title: "GitHub 代码更新", content, url: target, cardOpts: { showDetailLink: false }, template: "turquoise", skipAi: true, github: { repo: current.name, kind: "head", detectedAt: now() } });
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
            await recovered(state, "heads");
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
    return guarded("discovery", async signal => {
      const found = new Map();
      // Publish only after both accounts are fully read. A failed account/page
      // must not make its previous repositories look deleted. Existing v1
      // snapshots acquire the new account through this same discovery path.
      for (const owner of GITHUB_DISCOVERY_OWNERS) {
        for (let page = 1; ; page++) {
          const response = await api.rest(`/users/${owner}/repos?per_page=100&sort=full_name&direction=asc&page=${page}`, { signal });
          assertActive();
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
            if (fields.length) await store.enqueue({ title: "GitHub 仓库信息变更", content: `${repoHeading(repo.full_name, repo.html_url)}\n${cardStatus('changed', `信息更新 ${fields.length} 项`)}\n${fields.map(field => `${field}：${String(before[field])} → ${String(catalog[repo.full_name][field])}`).join("\n")}\n${cardTime(now())}（发现时间）`, url: repo.html_url, cardOpts: { showDetailLink: false }, template: "turquoise", skipAi: true });
          }
          const existing = Object.values(state.repos).find(item => item.nodeId === repo.node_id || item.name === repo.full_name);
          if (existing) {
            if (existing.name !== repo.full_name) delete state.repos[existing.name];
            const reappeared = previousCatalog && !Object.values(previousCatalog).some(item => item.node_id === repo.node_id);
            state.repos[repo.full_name] = { ...existing, name: repo.full_name, nodeId: repo.node_id, ...(reappeared || existing.name !== repo.full_name ? { headRetryAt: 0 } : {}) };
          } else {
            state.repos[repo.full_name] = { name: repo.full_name, nodeId: repo.node_id, head: "", branch: "" };
            await store.enqueue({ title: "GitHub 新增监控仓库", content: `${repoHeading(repo.full_name, repo.html_url)}\n${cardStatus('added', '已纳入默认分支监控')}\n首次探测建立基线，不回放全部历史。\n${cardTime(now())}（发现时间）`, url: repo.html_url, cardOpts: { showDetailLink: false }, template: "turquoise", skipAi: true });
          }
        }
        for (const [name, before] of Object.entries(previousCatalog || {})) {
          if (!catalog[name] && !found.has(before.node_id)) await store.enqueue({ title: "GitHub 仓库列表变化", content: `${repoHeading(name)}\n${cardStatus('warning', '从公开仓库列表消失')}\n可能为删除、转私有或转移，保留监控基线。\n${cardTime(now())}（发现时间）`, url: `https://github.com/${name}`, cardOpts: { showDetailLink: false }, template: "yellow", skipAi: true });
        }
        state.catalog = catalog;
        state.lastDiscoveryAt = now();
        await recovered(state, "discovery");
      });
      wake();
    });
  }

  return {
    pollHeads, discover,
    recordDelivery(payload) {
      if (payload.github) lastDelivery = { ...payload.github, sentAt: now(), delayMs: Math.max(0, now() - payload.github.detectedAt) };
    },
    summary: () => {
      const state = view();
      const gaps = headGaps.map(item => item.gap).filter(value => value > 0).sort((a,b) => a-b);
      const pending = (store.state._notificationOutbox || []).filter(entry => entry.payload?.github || entry.payload?.title?.startsWith("GitHub"));
      const taskStatus = Object.fromEntries([...running].map(([lane, { id, startedAt, deadlineAt }]) => [lane, { id, startedAt, deadlineAt }]));
      return { health: { ...structuredClone(state.health || {}), activeTasks: taskStatus }, repositories: Object.values(state.repos).map(({ name, head, branch, checkedAt, availability, lastHeadError, headRetryAt, lastCheckGapMs }) => ({ name, head, branch, checkedAt, availability, lastHeadError, headRetryAt, lastCheckGapMs })), lastHeadAt: state.lastHeadAt, headErrors: state.headErrors || [], lastDiscoveryAt: state.lastDiscoveryAt, headIntervals: { samples: gaps.length, p95Ms: gaps[Math.ceil(gaps.length * .95)-1] || 0, maxMs: gaps.at(-1) || 0 }, delivery: { pending: pending.length, oldestAt: pending.length ? Math.min(...pending.map(item=>item.createdAt)) : 0, last: lastDelivery ? { ...lastDelivery } : null }, ...api.summary() };
    },
  };
}
