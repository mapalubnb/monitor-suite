import test from "node:test";
import assert from "node:assert/strict";

process.env.FLAP_MONITOR_TEST = "1";

const { __testables } = await import("./monitor.mjs");

test("shared Flap asset-only page changes are summarized into one site-wide notification", () => {
  const notifications = [
    {
      url: "https://flap.sh/bnb/CAstore",
      title: "Flap 页面变更",
      template: "red",
      changes: [
        "📦 前端资源变更： 不变 28 | 修改 2",
        "🔇 构建噪音： 1 文件 4 处 (webpack-3790dbebac76c2a6.js)",
      ],
      meta: {
        assetStats: { unchanged: 28, renamed: 0, modified: 2, added: 0, removed: 0, noiseFiles: 1, noiseCount: 4, substantiveFiles: 1, substantiveCount: 2, substantiveFileNames: ["webpack-3790dbebac76c2a6.js"] },
        textChangeCount: 0,
        textChanges: [],
        i18nChangeCount: 0,
        i18nDiffs: [],
        caStoreVaultDiffs: [],
      },
      snapshotUpdate: { key: "castore", features: { marker: "castore" } },
    },
    {
      url: "https://flap.sh/launch",
      title: "Flap 页面变更",
      template: "red",
      changes: [
        "📦 前端资源变更： 不变 20 | 修改 2",
        "🔇 构建噪音： 1 文件 4 处 (webpack-3790dbebac76c2a6.js)",
      ],
      meta: {
        assetStats: { unchanged: 20, renamed: 0, modified: 2, added: 0, removed: 0, noiseFiles: 1, noiseCount: 4, substantiveFiles: 1, substantiveCount: 2, substantiveFileNames: ["webpack-3790dbebac76c2a6.js"] },
        textChangeCount: 0,
        textChanges: [],
        i18nChangeCount: 0,
        i18nDiffs: [],
        caStoreVaultDiffs: [],
      },
      snapshotUpdate: { key: "launch", features: { marker: "launch" } },
    },
  ];

  const grouped = __testables.coalesceFlapNotifications(notifications);

  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].title, "Flap 全站前端资源变更");
  assert.equal(grouped[0].url, "https://flap.sh");
  assert.match(grouped[0].changes.join("\n"), /影响页面 2 个/);
  assert.match(grouped[0].changes.join("\n"), /https:\/\/flap\.sh\/bnb\/CAstore/);
  assert.match(grouped[0].changes.join("\n"), /https:\/\/flap\.sh\/launch/);
  assert.match(grouped[0].content, /\[https:\/\/flap\.sh\/bnb\/CAstore\]\(https:\/\/flap\.sh\/bnb\/CAstore\)/);
  assert.equal(grouped[0].skipAi, false);
  assert.equal(grouped[0].useFullDiffForAi, true);
  assert.equal(grouped[0].snapshotUpdates.length, 2);
});

test("specific Flap page content changes remain page-level notifications", () => {
  const notifications = [
    {
      url: "https://flap.sh/bnb/CAstore",
      title: "Flap 页面变更",
      template: "red",
      changes: ["🏦 CAstore 金库内容变更：", "  🟢 新增金库: Gift Vault"],
      meta: {
        assetStats: null,
        textChangeCount: 0,
        textChanges: [],
        i18nChangeCount: 0,
        i18nDiffs: [],
        caStoreVaultDiffs: [{ type: "added", name: "Gift Vault" }],
      },
      snapshotUpdate: { key: "castore", features: { marker: "castore" } },
    },
    {
      url: "https://flap.sh/launch",
      title: "Flap 页面变更",
      template: "red",
      changes: ["📦 前端资源变更： 不变 20 | 修改 2"],
      meta: {
        assetStats: { unchanged: 20, renamed: 0, modified: 2, added: 0, removed: 0, noiseFiles: 0, noiseCount: 0, substantiveFiles: 1, substantiveCount: 1, substantiveFileNames: ["webpack-3790dbebac76c2a6.js"] },
        textChangeCount: 0,
        textChanges: [],
        i18nChangeCount: 0,
        i18nDiffs: [],
        caStoreVaultDiffs: [],
      },
      snapshotUpdate: { key: "launch", features: { marker: "launch" } },
    },
  ];

  const grouped = __testables.coalesceFlapNotifications(notifications);

  assert.equal(grouped.length, 2);
  assert.equal(grouped[0].title, "Flap 页面变更");
  assert.equal(grouped[0].url, "https://flap.sh/bnb/CAstore");
  assert.equal(grouped[1].title, "Flap 全站前端资源变更");
});

test("asset notifications containing business keywords stay page-level", () => {
  const notifications = [
    {
      url: "https://flap.sh/bnb/CAstore",
      title: "Flap 页面变更",
      template: "red",
      changes: [
        "📦 前端资源变更： 不变 28 | 修改 2",
        "📝 vault-page.js (2 处实质变更)",
        "  + New Vault fee rate",
      ],
      meta: {
        assetStats: {
          unchanged: 28,
          renamed: 0,
          modified: 2,
          added: 0,
          removed: 0,
          noiseFiles: 0,
          noiseCount: 0,
          substantiveFiles: 1,
          substantiveCount: 2,
          substantiveFileNames: ["vault-page.js"],
          configDiffs: [],
          vaultDiffs: [],
          jsTextDiffs: [],
        },
        textChangeCount: 0,
        textChanges: [],
        i18nChangeCount: 0,
        i18nDiffs: [],
        caStoreVaultDiffs: [],
      },
      snapshotUpdate: { key: "castore", features: { marker: "castore" } },
    },
  ];

  const grouped = __testables.coalesceFlapNotifications(notifications);

  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].title, "Flap 页面变更");
  assert.equal(grouped[0].url, "https://flap.sh/bnb/CAstore");
});

test("shared business resource diffs across pages are coalesced into one site-wide notification", () => {
  const sharedMeta = {
    assetStats: {
      unchanged: 28,
      renamed: 2,
      modified: 2,
      added: 0,
      removed: 0,
      noiseFiles: 0,
      noiseCount: 0,
      substantiveFiles: 2,
      substantiveCount: 10,
      substantiveFileNames: ["8101-025ad0379fc93d08.js", "webpack-fcd3cb604bdd2e6d.js"],
      configDiffs: [
        { field: "fees", oldVal: "(新增)", newVal: "void", file: "8101-025ad0379fc93d08.js" },
        { field: "maxFeePerGas", oldVal: "(新增)", newVal: "void", file: "8101-025ad0379fc93d08.js" },
      ],
      vaultDiffs: [],
      jsTextDiffs: [
        { type: "added", text: "Create an account and generate a wallet", file: "8101-025ad0379fc93d08.js" },
      ],
    },
    textChangeCount: 0,
    textChanges: [],
    i18nChangeCount: 0,
    i18nDiffs: [],
    caStoreVaultDiffs: [],
  };
  const notifications = ["https://flap.sh/bnb/CAstore", "https://flap.sh/create", "https://flap.sh/launch"].map((url, i) => ({
    url,
    title: "Flap 页面变更",
    template: "red",
    changes: ["📦 前端资源变更： 不变 28 | 重命名 2 | 修改 2", "🔧 配置参数变更：", "  fees: (新增) → void"],
    meta: JSON.parse(JSON.stringify(sharedMeta)),
    snapshotUpdate: { key: `p${i}`, features: { marker: i } },
  }));

  const grouped = __testables.coalesceFlapNotifications(notifications);

  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].title, "Flap 全站前端资源变更");
  assert.equal(grouped[0].url, "https://flap.sh");
  assert.match(grouped[0].content, /功能文案 1 处/);
  assert.match(grouped[0].content, /业务配置 2 项/);
  assert.match(grouped[0].content, /完整资源 Diff 已作为 AI 输入/);
  assert.equal(grouped[0].skipBusinessPriorityTitle, true);
  assert.equal(grouped[0].skipAi, false);
  assert.equal(grouped[0].useFullDiffForAi, true);
  assert.equal(grouped[0].snapshotUpdates.length, 3);
});

test("CAstore Chinese vault headings are extracted as structured vault sections", () => {
  const html = `
    <main>
      <h2>热门金库</h2>
      <h3>禮物稅收金庫</h3>
      <p>指定一個 X 帳戶作為禮物擁有者，可以將交易費用分配給任何 EVM 地址。</p>
      <h3>LP质押分红金库</h3>
      <p>将你的 LP 代币质押进金库，获得 BNB 分红奖励。</p>
      <h3>黑洞排行榜燃烧分红金库</h3>
      <p>税收分为两个池：燃烧分红池按燃烧价值权重分配给用户。</p>
    </main>
  `;

  const features = __testables.extractPageFeatures(html);

  assert.deepEqual(features.caStoreVaults.map(v => v.name), [
    "禮物稅收金庫",
    "LP质押分红金库",
    "黑洞排行榜燃烧分红金库",
  ]);
  assert.equal(features.caStoreVaults[0].area, "热门金库");
  assert.match(features.caStoreVaults[1].description, /LP 代币质押进金库/);
});

test("asset string extraction keeps business strings beyond the ordinary cap", () => {
  const ordinaryStrings = Array.from({ length: 260 }, (_, i) => `"ordinary string ${String(i).padStart(3, "0")} with enough words"`);
  const businessString = `"新增金库费率配置 New Vault fee rate affects CAstore templates"`;
  const content = `${ordinaryStrings.join(";")};${businessString};`;

  const strings = __testables.extractStrings(content, "js");

  assert(strings.length <= __testables.CONFIG.assetStringLimit);
  assert(strings.some(s => s.includes("新增金库费率配置")));
});

test("round asset cache reuses shared chunks across pages", async () => {
  const roundAssetCache = new Map();
  let fetchCount = 0;
  const fetchAsset = async (url) => {
    fetchCount++;
    return { ok: true, text: async () => `const label = "asset ${url} business words";` };
  };

  const [first, second] = await Promise.all([
    __testables.downloadAssetContents(
      ["/_next/static/chunks/8101-a.js", "/_next/static/chunks/webpack-a.js"],
      "https://flap.sh",
      { roundAssetCache, fetchAsset },
    ),
    __testables.downloadAssetContents(
      ["/_next/static/chunks/8101-a.js", "/_next/static/chunks/app/launch/page-a.js"],
      "https://flap.sh",
      { roundAssetCache, fetchAsset },
    ),
  ]);

  assert.equal(fetchCount, 3);
  assert.equal(first["8101-a.js"].contentHash, second["8101-a.js"].contentHash);
});

test("asset download plan reuses unchanged assets and fetches only new paths", () => {
  const oldFeatures = {
    assetFiles: ["/_next/static/chunks/webpack-a.js", "/_next/static/chunks/8101-a.js"],
    assetContents: {
      "webpack-a.js": { filename: "webpack-a.js", path: "/_next/static/chunks/webpack-a.js", contentHash: "runtime" },
      "8101-a.js": { filename: "8101-a.js", path: "/_next/static/chunks/8101-a.js", contentHash: "shared" },
    },
  };
  const newFeatures = {
    assetFiles: ["/_next/static/chunks/webpack-a.js", "/_next/static/chunks/app/launch/page-b.js"],
  };

  const plan = __testables.planAssetContentDownload(oldFeatures, newFeatures);

  assert.deepEqual(plan.reuseFilenames, ["webpack-a.js"]);
  assert.deepEqual(plan.toDownload, ["/_next/static/chunks/app/launch/page-b.js"]);
  assert.equal(plan.reusedContents["webpack-a.js"].contentHash, "runtime");
});

test("asset semantic profile classifies page chunks and shared runtime chunks", () => {
  const profile = __testables.buildAssetSemanticProfile([
    "/_next/static/chunks/webpack-167217394b1418fd.js",
    "/_next/static/chunks/8101-706af7c3a9ce2627.js",
    "/_next/static/chunks/app/launch/page-58c52ba25a5f0aae.js",
    "/_next/static/chunks/app/layout-dc8bafd06bb8b592.js",
  ]);

  assert(profile.runtime.some(item => item.file.includes("webpack-167217394b1418fd.js")));
  assert(profile.shared.some(item => item.file.includes("8101-706af7c3a9ce2627.js")));
  assert.deepEqual(profile.pageRoutes, ["launch"]);
  assert(profile.appShell.some(item => item.kind === "layout"));
});

test("page-specific chunk changes remain page-level notifications", () => {
  const notifications = [
    {
      url: "https://flap.sh/launch",
      title: "Flap 页面变更",
      template: "red",
      changes: ["📦 前端资源变更： 修改 1"],
      meta: {
        assetStats: {
          unchanged: 28,
          modified: 1,
          substantiveFileNames: ["page-58c52ba25a5f0aae.js"],
          substantiveAssetPaths: ["/_next/static/chunks/app/launch/page-58c52ba25a5f0aae.js"],
          semanticProfile: __testables.buildAssetSemanticProfile(["/_next/static/chunks/app/launch/page-58c52ba25a5f0aae.js"]),
          configDiffs: [],
          vaultDiffs: [],
          jsTextDiffs: [],
        },
        textChangeCount: 0,
        textChanges: [],
        i18nChangeCount: 0,
        i18nDiffs: [],
        caStoreVaultDiffs: [],
      },
      snapshotUpdate: { key: "launch", features: {} },
    },
    {
      url: "https://flap.sh/create",
      title: "Flap 页面变更",
      template: "red",
      changes: ["📦 前端资源变更： 修改 1"],
      meta: {
        assetStats: {
          unchanged: 28,
          modified: 1,
          substantiveFileNames: ["page-314a5953cbeca095.js"],
          substantiveAssetPaths: ["/_next/static/chunks/app/create/page-314a5953cbeca095.js"],
          semanticProfile: __testables.buildAssetSemanticProfile(["/_next/static/chunks/app/create/page-314a5953cbeca095.js"]),
          configDiffs: [],
          vaultDiffs: [],
          jsTextDiffs: [],
        },
        textChangeCount: 0,
        textChanges: [],
        i18nChangeCount: 0,
        i18nDiffs: [],
        caStoreVaultDiffs: [],
      },
      snapshotUpdate: { key: "create", features: {} },
    },
  ];

  const grouped = __testables.coalesceFlapNotifications(notifications);

  assert.equal(grouped.length, 2);
  assert.equal(grouped[0].url, "https://flap.sh/launch");
  assert.equal(grouped[1].url, "https://flap.sh/create");
});

test("manual Flap check can reuse the same notification coalescing path", () => {
  const notifications = [
    {
      url: "https://flap.sh/bnb/CAstore",
      title: "手动检测 — 页面变更",
      template: "red",
      changes: ["📦 前端资源变更： 不变 28 | 修改 2"],
      meta: {
        assetStats: { unchanged: 28, renamed: 0, modified: 2, added: 0, removed: 0, noiseFiles: 0, noiseCount: 0, substantiveFiles: 1, substantiveCount: 1, substantiveFileNames: ["webpack-3790dbebac76c2a6.js"] },
        textChangeCount: 0,
        textChanges: [],
        i18nChangeCount: 0,
        i18nDiffs: [],
        caStoreVaultDiffs: [],
      },
      snapshotUpdate: { key: "castore", features: { marker: "castore" } },
    },
    {
      url: "https://flap.sh/launch",
      title: "手动检测 — 页面变更",
      template: "red",
      changes: ["📦 前端资源变更： 不变 20 | 修改 2"],
      meta: {
        assetStats: { unchanged: 20, renamed: 0, modified: 2, added: 0, removed: 0, noiseFiles: 0, noiseCount: 0, substantiveFiles: 1, substantiveCount: 1, substantiveFileNames: ["webpack-3790dbebac76c2a6.js"] },
        textChangeCount: 0,
        textChanges: [],
        i18nChangeCount: 0,
        i18nDiffs: [],
        caStoreVaultDiffs: [],
      },
      snapshotUpdate: { key: "launch", features: { marker: "launch" } },
    },
  ];

  const grouped = __testables.coalesceFlapNotifications(notifications, { titlePrefix: "手动检测 — " });

  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].title, "手动检测 — Flap 全站前端资源变更");
});

test("business priority title can preserve manual check source prefix", () => {
  const notification = {
    title: "手动检测 — 页面变更",
    template: "red",
    changes: ["🏦 CAstore 金库内容变更：", "  🟢 新增金库: Gift Vault"],
  };

  __testables.applyBusinessPriorityTitle(notification, { titlePrefix: "手动检测 — " });

  assert.equal(notification.title, "手动检测 — ⚡ 重点变更：金库/Vault");
  assert.equal(notification.template, "red");
});

test("page change card puts summary and important copy before resource details", () => {
  const content = __testables.buildCardBriefing(
    "https://flap.sh/bnb/CAstore",
    null,
    {
      unchanged: 28,
      renamed: 0,
      modified: 2,
      added: 0,
      removed: 0,
      noiseFiles: 1,
      noiseCount: 4,
      substantiveFiles: 1,
      substantiveCount: 2,
      substantiveFileNames: ["vault-page.js"],
      configDiffs: [{ field: "feeRate", oldVal: "1", newVal: "2", file: "vault-page.js" }],
      vaultDiffs: [],
      jsTextDiffs: [{ type: "added", text: "New Vault fee rate enabled", file: "vault-page.js" }],
    },
    1,
    1,
    [{ type: "added", key: "castore.giftVault", value: "禮物稅收金庫" }],
    [{ type: "modified", oldText: "旧手续费", newText: "新手续费", ctxBefore: "CAstore" }],
    [{ type: "added", area: "热门金库", name: "禮物稅收金庫", newDescription: "指定账户收取礼物税收" }],
  );

  assert(content.startsWith("**结论摘要**"));
  assert(content.indexOf("**重点变更**") < content.indexOf("**资源统计**"));
  assert(content.indexOf("禮物稅收金庫") < content.indexOf("vault-page.js"));
  assert.doesNotMatch(content, /建议动作/);
  assert.match(content, /AI 分析异步生成中，变更已先推送/);
});

test("site-wide asset card leads with no business-change conclusion", () => {
  const notification = __testables.buildSiteWideAssetNotification([
    {
      url: "https://flap.sh/bnb/CAstore",
      changes: ["📦 前端资源变更： 不变 28 | 修改 2", "🔇 构建噪音： 1 文件 4 处 (webpack.js)"],
      meta: {
        assetStats: { unchanged: 28, renamed: 0, modified: 2, added: 0, removed: 0, noiseFiles: 1, noiseCount: 4, substantiveFiles: 1, substantiveCount: 2, substantiveFileNames: ["webpack.js"] },
      },
      snapshotUpdate: { key: "castore", features: {} },
    },
  ]);

  assert(notification.content.startsWith("**结论摘要**"));
  assert(notification.content.indexOf("本地初筛") < notification.content.indexOf("**AI 分析**"));
  assert(notification.content.indexOf("**AI 分析**") < notification.content.indexOf("**影响页面**"));
  assert.match(notification.content, /完整资源 Diff 已作为 AI 输入/);
  assert.equal(notification.skipAi, false);
  assert.equal(notification.useFullDiffForAi, true);
});

test("site-wide asset-only notification is not promoted by negative business words", () => {
  const notification = __testables.buildSiteWideAssetNotification([
    {
      url: "https://flap.sh/bnb/CAstore",
      changes: ["📦 前端资源变更： 不变 28 | 修改 2"],
      meta: {
        assetStats: { unchanged: 28, renamed: 0, modified: 2, added: 0, removed: 0, noiseFiles: 0, noiseCount: 0, substantiveFiles: 1, substantiveCount: 2, substantiveFileNames: ["webpack-167217394b1418fd.js"] },
      },
      snapshotUpdate: { key: "castore", features: {} },
    },
  ]);

  assert.equal(notification.skipBusinessPriorityTitle, true);
  __testables.applyBusinessPriorityTitle(notification);

  assert.equal(notification.title, "Flap 全站前端资源变更");
  assert.equal(notification.template, "orange");
});

test("site-wide asset card summarizes runtime resources without raw webpack fragments", () => {
  const notification = __testables.buildSiteWideAssetNotification([
    {
      url: "https://flap.sh/bnb/CAstore",
      changes: [
        "📦 前端资源变更： 不变 28 | 修改 2",
        "📝 webpack-fcd3cb604bdd2e6d.js → webpack-167217394b1418fd.js (46 处实质变更 + 4 噪音已过滤)",
        "  - !=typeof trustedTypes&&trustedTypes.createPolicy&&(d=trustedTypes.createPolicy(",
        "  - ),t=0;t",
      ],
      meta: {
        assetStats: { unchanged: 28, renamed: 0, modified: 2, added: 0, removed: 0, noiseFiles: 0, noiseCount: 0, substantiveFiles: 2, substantiveCount: 46, substantiveFileNames: ["8101-706af7c3a9ce2627.js", "webpack-167217394b1418fd.js"] },
      },
      snapshotUpdate: { key: "castore", features: {} },
    },
    {
      url: "https://flap.sh/launch",
      changes: [
        "📦 前端资源变更： 不变 28 | 修改 2",
        "📝 webpack-fcd3cb604bdd2e6d.js → webpack-167217394b1418fd.js (46 处实质变更 + 4 噪音已过滤)",
        "  - !=typeof trustedTypes&&trustedTypes.createPolicy&&(d=trustedTypes.createPolicy(",
      ],
      meta: {
        assetStats: { unchanged: 28, renamed: 0, modified: 2, added: 0, removed: 0, noiseFiles: 0, noiseCount: 0, substantiveFiles: 2, substantiveCount: 46, substantiveFileNames: ["8101-706af7c3a9ce2627.js", "webpack-167217394b1418fd.js"] },
      },
      snapshotUpdate: { key: "launch", features: {} },
    },
  ]);

  assert.match(notification.content, /资源范围/);
  assert.match(notification.content, /runtime/);
  assert.match(notification.content, /共享 chunk/);
  assert.doesNotMatch(notification.content, /trustedTypes|t=0;t/);
  assert.doesNotMatch(notification.content, /!=typeof/);
});

test("vault factory card summarizes counts before details", () => {
  const content = __testables.formatVaultFactoryChanges({
    added: [{ name: "Gift Vault", factory: "0xabc", showInCAStore: true, ai: false, enabled: true, constraints: { min: 1 } }],
    removed: [],
    modified: [{ name: "Old Vault", factory: "0xdef", diffs: ["enabled: true → false"] }],
  });

  assert(content.startsWith("**结论摘要**"));
  assert(content.indexOf("新增 1") < content.indexOf("Gift Vault"));
  assert(content.indexOf("Gift Vault") < content.indexOf("Old Vault"));
});

test("operational notice card is readable and action oriented", () => {
  const content = __testables.buildOperationalNoticeContent({
    status: "页面请求失败",
    url: "https://flap.sh/launch",
    severity: "orange",
    reason: "HTTP 403",
    consecutiveFailures: 3,
  });

  assert(content.startsWith("**状态:** 页面请求失败"));
  assert.doesNotMatch(content, /建议动作/);
  assert.match(content, /HTTP 403/);
});

test("full diff uses detailed lines without summary truncation", () => {
  const diff = __testables.buildFlapFullDiff({
    diffTitle: "=== Flap.sh 详细 Diff ===",
    url: "https://flap.sh",
    changes: ["📝 chunk.js (20 处实质变更)", "  ... 还有 12 处新增"],
    meta: {
      fullDiffLines: [
        "【前端资源完整 Diff】",
        "文件: chunk.js",
        "+ long added string 001",
        "+ long added string 020",
      ],
    },
  });

  assert.match(diff, /long added string 001/);
  assert.match(diff, /long added string 020/);
  assert.doesNotMatch(diff, /\.\.\. 还有 12 处新增/);
});
