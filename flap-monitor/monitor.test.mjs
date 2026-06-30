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

test("shared resource diffs are extracted and coalesced even when one page has CAstore changes", () => {
  const sharedMeta = {
    assetStats: {
      unchanged: 20,
      modified: 2,
      renamed: 1,
      substantiveFileNames: ["1094-58c02e471cdb0fcb.js", "webpack-41b2e37c796e2aae.js"],
      substantiveAssetPaths: ["/_next/static/chunks/1094-58c02e471cdb0fcb.js", "/_next/static/chunks/webpack-41b2e37c796e2aae.js"],
      semanticProfile: __testables.buildAssetSemanticProfile([
        "/_next/static/chunks/1094-58c02e471cdb0fcb.js",
        "/_next/static/chunks/webpack-41b2e37c796e2aae.js",
      ]),
      configDiffs: [
        { field: "enabled", oldVal: "(新增)", newVal: "!0", file: "1094-58c02e471cdb0fcb.js" },
        { field: "showInCAStore", oldVal: "(新增)", newVal: "!1", file: "1094-58c02e471cdb0fcb.js" },
      ],
      jsTextDiffs: [
        { type: "added", text: "you can still view its tax info while indexing.", file: "1094-58c02e471cdb0fcb.js" },
      ],
      vaultDiffs: [],
    },
    textChangeCount: 0,
    textChanges: [],
    i18nChangeCount: 0,
    i18nDiffs: [],
    caStoreVaultDiffs: [],
  };
  const notifications = [
    {
      url: "https://flap.sh/bnb/CAstore",
      title: "Flap 页面变更",
      template: "red",
      changes: ["🏦 CAstore 金库内容变更：", "  🔴 移除金库: Hot Vaults / Perpetual Short Vault", "📦 前端资源变更：修改 2", "🔧 配置参数变更："],
      meta: {
        ...JSON.parse(JSON.stringify(sharedMeta)),
        caStoreVaultDiffs: [{ type: "removed", area: "Hot Vaults", name: "Perpetual Short Vault", oldDescription: "A BNB-margin short-only vault." }],
      },
      snapshotUpdate: { key: "castore", features: {} },
    },
    ...["https://flap.sh/create", "https://flap.sh/launch"].map((url, i) => ({
      url,
      title: "Flap 页面变更",
      template: "red",
      changes: ["📦 前端资源变更：修改 2", "🔧 配置参数变更："],
      meta: JSON.parse(JSON.stringify(sharedMeta)),
      snapshotUpdate: { key: `p${i}`, features: {} },
    })),
  ];

  const grouped = __testables.coalesceFlapNotifications(notifications);

  assert.equal(grouped.length, 2);
  assert.equal(grouped[0].url, "https://flap.sh/bnb/CAstore");
  assert.equal(grouped[0].meta.assetStats, null);
  assert.equal(grouped[0].meta.caStoreVaultDiffs.length, 1);
  assert.equal(grouped[1].title, "Flap 全站前端资源变更");
  assert.equal(grouped[1].url, "https://flap.sh");
  assert.equal(grouped[1].snapshotUpdates.length, 3);
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
  assert.match(grouped[0].content, /<font color="green">新增文案<\/font>: <font color="green">Create an account and generate a wallet<\/font>/);
  assert.match(grouped[0].content, /Create an account and generate a wallet/);
  assert.match(grouped[0].content, /fees：<font color="red">\(新增\)<\/font> → <font color="green">void<\/font>/);
  assert.match(grouped[0].content, /\*\*AI 分析\*\*/);
  assert.equal(grouped[0].skipBusinessPriorityTitle, true);
  assert.equal(grouped[0].skipAi, false);
  assert.equal(grouped[0].useFullDiffForAi, true);
  assert.equal(grouped[0].snapshotUpdates.length, 3);
});

test("Flap asset extraction explains SVG paths Tailwind utilities and style pseudo configs as UI signals", () => {
  const oldFeatures = {
    assetHash: "old-assets",
    assetContents: {
      "8625-aaa.js": {
        path: "/_next/static/chunks/8625-aaa.js",
        contentHash: "old",
        strings: ["stable shared copy for diff matching"],
      },
    },
  };
  const newFeatures = {
    assetHash: "new-assets",
    assetContents: {
      "8625-aaa.js": {
        path: "/_next/static/chunks/8625-aaa.js",
        contentHash: "new",
        strings: [
          "stable shared copy for diff matching",
          "M7 0.583984L11.9587 2.28634C12.2356 2.38143 12.4212 2.64208 12.4212 2.93497V6.99935C12.4212 9.18164 11.2444 11.1949 9.3413 12.2654L7 13.583Z",
          "absolute bottom-2 left-1/2 -translate-x-1/2",
          "absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none",
          "disabled:pointer-events-none",
          "peer-disabled:cursor-not-allowed peer-disabled:opacity-70 text-[12px] font-medium leading-[18px] text-white/80",
          "group-hover/nav-dropdown:visible group-focus-within/nav-dropdown:opacity-100 max-[375px]:hidden min-[1400px]:flex",
          "[--ui20-chamfer-bg:#000000] hover:[--ui20-chamfer-bg:#D0FF00]",
          "[&_[data-radix-scroll-area-viewport]>div]:!block [&_[data-radix-scroll-area-viewport]>div]:!min-w-0",
        ],
      },
    },
  };

  const { changes, meta } = __testables.diffFeatures(oldFeatures, newFeatures);
  const payload = JSON.stringify({ changes, meta });

  assert.deepEqual(meta.assetStats.configDiffs, []);
  assert.deepEqual(meta.assetStats.jsTextDiffs, []);
  assert.equal(meta.assetStats.substantiveFiles, 0);
  assert.equal(meta.assetStats.noiseFiles, 1);
  assert(meta.assetStats.uiStyleDiffs.length > 0);
  assert(meta.assetStats.uiStyleDiffs.some(d => d.category === "icon"));
  assert(meta.assetStats.uiStyleDiffs.some(d => d.category === "disabled"));
  assert(meta.assetStats.uiStyleDiffs.some(d => d.category === "responsive"));
  assert(meta.assetStats.uiStyleDiffs.some(d => d.category === "component"));
  assert(meta.assetStats.uiStyleDiffs.some(d => d.contextLabel === "顶部导航/下拉菜单"));
  assert(meta.assetStats.uiStyleDiffs.some(d => d.contextLabel === "代币创建表单控件"));
  assert(meta.assetStats.uiStyleDiffs.some(d => d.contextLabel === "弹窗/下拉层/滚动区"));

  const content = __testables.buildCardBriefing(
    "https://flap.sh/create",
    null,
    meta.assetStats,
    0,
    0,
    [],
    [],
    [],
  );

  assert.match(content, /UI\/样式信号/);
  assert.match(content, /禁用态交互/);
  assert.match(content, /图标\/矢量/);
  assert.match(content, /响应式布局/);
  assert.match(content, /组件样式变量/);
  assert.match(content, /范围：/);
  assert.match(content, /顶部导航\/下拉菜单|代币创建表单控件|弹窗\/下拉层\/滚动区/);
  assert.match(content, /意图判断/);
  assert.doesNotMatch(content, /M7 0\.583984/);
  assert.doesNotMatch(content, /absolute bottom-2/);
  assert.doesNotMatch(content, /disabled:pointer-events-none/);
});

test("structured shared resource diffs coalesce even when semantic page routes differ", () => {
  const configDiffs = [
    { field: "dividendBps", oldVal: "100", newVal: "200", file: "8625-3a0e67b3310b1e9a.js" },
  ];
  const jsTextDiffs = [
    { type: "added", text: "you can still view its tax info while indexing.", file: "8625-3a0e67b3310b1e9a.js" },
  ];
  const makeNotification = (url, route, key) => {
    const paths = [
      "/_next/static/chunks/8625-3a0e67b3310b1e9a.js",
      `/_next/static/chunks/app/${route}/page-${key}.js`,
    ];
    return {
      url,
      title: "Flap 页面变更",
      template: "red",
      changes: ["📦 前端资源变更：修改 2", "🔧 配置参数变更：1"],
      meta: {
        assetStats: {
          unchanged: 20,
          renamed: 0,
          modified: 2,
          added: 0,
          removed: 0,
          noiseFiles: 0,
          noiseCount: 0,
          substantiveFiles: 2,
          substantiveCount: 2,
          substantiveFileNames: ["8625-3a0e67b3310b1e9a.js", `page-${key}.js`],
          substantiveAssetPaths: paths,
          semanticProfile: __testables.buildAssetSemanticProfile(paths, { configDiffs, jsTextDiffs, vaultDiffs: [] }),
          configDiffs,
          vaultDiffs: [],
          jsTextDiffs,
        },
        textChangeCount: 0,
        textChanges: [],
        i18nChangeCount: 0,
        i18nDiffs: [],
        caStoreVaultDiffs: [],
      },
      snapshotUpdate: { key, features: {} },
    };
  };

  const grouped = __testables.coalesceFlapNotifications([
    makeNotification("https://flap.sh/bnb/CAstore", "[chain]/CAstore", "castore"),
    makeNotification("https://flap.sh/launch", "launch", "launch"),
    makeNotification("https://flap.sh/create", "create", "create"),
  ]);

  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].title, "Flap 全站前端资源变更");
  assert.equal(grouped[0].url, "https://flap.sh");
  assert.equal(grouped[0].snapshotUpdates.length, 3);
});

test("shared UI style signals coalesce into one explanatory site-wide notification", () => {
  const uiStyleDiffs = [
    { type: "added", category: "disabled", label: "禁用态交互", intent: "调整禁用状态下的点击或交互反馈", evidence: "disabled / pointer-events", contextKey: "wallet-connect", contextLabel: "钱包连接控件", contextConfidence: "高", file: "8625-3a0e67b3310b1e9a.js" },
    { type: "added", category: "interaction", label: "交互反馈", intent: "调整 hover/focus/active 或过渡反馈", evidence: "hover / focus / transition / ring", contextKey: "navigation-menu", contextLabel: "顶部导航/下拉菜单", contextConfidence: "高", file: "8625-3a0e67b3310b1e9a.js" },
  ];
  const makeNotification = (url, key) => ({
    url,
    title: "Flap 页面变更",
    template: "red",
    changes: ["📦 前端资源变更：修改 1"],
    meta: {
      assetStats: {
        unchanged: 20,
        renamed: 0,
        modified: 1,
        added: 0,
        removed: 0,
        noiseFiles: 1,
        noiseCount: 2,
        substantiveFiles: 0,
        substantiveCount: 0,
        substantiveFileNames: [],
        substantiveAssetPaths: [],
        configDiffs: [],
        vaultDiffs: [],
        jsTextDiffs: [],
        uiStyleDiffs,
      },
      textChangeCount: 0,
      textChanges: [],
      i18nChangeCount: 0,
      i18nDiffs: [],
      caStoreVaultDiffs: [],
    },
    snapshotUpdate: { key, features: {} },
  });

  const grouped = __testables.coalesceFlapNotifications([
    makeNotification("https://flap.sh/launch", "launch"),
    makeNotification("https://flap.sh/create", "create"),
  ]);

  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].title, "Flap 全站前端资源变更");
  assert.match(grouped[0].content, /UI\/样式信号 2 处/);
  assert.match(grouped[0].content, /未发现明确业务配置变化/);
  assert.match(grouped[0].content, /禁用态交互/);
  assert.match(grouped[0].content, /钱包连接控件/);
  assert.match(grouped[0].content, /顶部导航\/下拉菜单/);
  assert.match(grouped[0].content, /调整禁用状态下的点击或交互反馈/);
  assert.equal(grouped[0].snapshotUpdates.length, 2);
});

test("Flap UI style context inference maps real Tailwind patterns to concrete components", () => {
  const cases = [
    {
      text: "group-hover/nav-dropdown:visible group-focus-within/nav-dropdown:opacity-100",
      context: "顶部导航/下拉菜单",
    },
    {
      text: "ui20-connect-chamfer [--ui20-chamfer-bg:#000000] hover:[--ui20-chamfer-bg:#D0FF00]",
      context: "钱包连接控件",
    },
    {
      text: "peer-disabled:cursor-not-allowed peer-disabled:opacity-70 text-[12px] font-medium",
      context: "代币创建表单控件",
    },
    {
      text: "[&_[data-radix-scroll-area-viewport]>div]:!block [&_[data-radix-scroll-area-viewport]>div]:!min-w-0",
      context: "弹窗/下拉层/滚动区",
    },
  ];

  for (const item of cases) {
    assert.equal(__testables.inferUiComponentContext(item.text).label, item.context);
  }

  assert.equal(
    __testables.inferUiComponentContext("rounded-[4px] border object-cover", "page-59769a4a66f32125.js", "/_next/static/chunks/app/[chain]/CAstore/page-59769a4a66f32125.js").label,
    "CAstore 金库卡片/模板列表",
  );
});

test("CAstore Chinese vault headings are extracted as structured vault sections", () => {
  const html = `
    <main>
      <h2>热门金库</h2>
      <h3>禮物稅收金庫</h3>
      <p>指定一個 X 帳戶作為禮物擁有者，可以將交易費用分配給任何 EVM 地址。</p>
      <a href="/launch?vaultfactory=0x08E41a61C5D25420E3cb314Bc513EC99B2841003">Open</a>
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
  assert.equal(features.caStoreVaults[0].factory, "0x08E41a61C5D25420E3cb314Bc513EC99B2841003");
  assert.match(features.caStoreVaults[1].description, /LP 代币质押进金库/);
});

test("CAstore vault change notification is simple, linked, AI-ready and suppresses duplicate page card", () => {
  const diff = {
    type: "added",
    area: "热门金库",
    name: "禮物稅收金庫",
    newDescription: "指定一個 X 帳戶作為禮物擁有者，可以將交易費用分配給任何 EVM 地址。",
    factory: "0x08E41a61C5D25420E3cb314Bc513EC99B2841003",
  };
  const notification = __testables.buildCaStoreVaultChangeNotification(diff, {});

  assert.equal(notification.title, "CAstore 金库变更：禮物稅收金庫");
  assert.match(notification.content, /金库名字/);
  assert.match(notification.content, /禮物稅收金庫/);
  assert.match(notification.content, /指定一個 X 帳戶/);
  assert.match(notification.content, /<font color="green">新增金库<\/font>/);
  assert.match(notification.content, /🔗 \[打开金库页面\]\(https:\/\/flap\.sh\/launch\?vaultfactory=0x08E41a61C5D25420E3cb314Bc513EC99B2841003\)/);
  assert.match(notification.content, /AI 分析异步生成中/);
  assert.match(notification.aiInput, /金库名字: 禮物稅收金庫/);

  const pageNotification = {
    changes: ["🏦 CAstore 金库内容变更：", "  🟢 新增金库: 热门金库 / 禮物稅收金庫"],
    meta: {
      assetStats: null,
      textChangeCount: 0,
      i18nChangeCount: 0,
      caStoreVaultDiffs: [diff],
    },
  };
  assert.equal(__testables.getStandaloneCaStoreVaultDiffs(pageNotification).length, 1);
  assert.equal(__testables.shouldSuppressCaStoreOnlyPageNotification(pageNotification), true);
});

test("standalone CAstore vault card can be omitted from mixed page card", () => {
  const notification = {
    url: "https://flap.sh/bnb/CAstore",
    changes: [
      "🏦 CAstore 金库内容变更：",
      "  🔴 移除金库: Hot Vaults / Perpetual Short Vault",
      "✏️ 文案修改：",
    ],
    meta: {
      assetStats: null,
      textChangeCount: 1,
      textChanges: [{ type: "removed", text: "Perpetual Short Vault" }],
      i18nChangeCount: 0,
      i18nDiffs: [],
      caStoreVaultDiffs: [{ type: "removed", area: "Hot Vaults", name: "Perpetual Short Vault" }],
      fullDiffLines: ["🏦 CAstore 金库内容变更：", "✏️ 页面文案完整 Diff"],
    },
  };

  const stripped = __testables.omitStandaloneCaStoreVaultDiffs(notification);

  assert.equal(stripped.meta.caStoreVaultDiffs.length, 0);
  assert(stripped.changes.every(line => !line.includes("CAstore 金库")));
  assert.equal(stripped.meta.textChanges.length, 1);
  assert.equal(__testables.shouldSuppressCaStoreOnlyPageNotification(notification), false);
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
  const longOldText = "旧手续费 " + "旧配置说明 ".repeat(40).trim();
  const longNewText = "新手续费 " + "新配置说明 ".repeat(40).trim();
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
    [{ type: "modified", oldText: longOldText, newText: longNewText, ctxBefore: "CAstore" }],
    [{ type: "added", area: "热门金库", name: "禮物稅收金庫", newDescription: "指定账户收取礼物税收" }],
  );

  assert(content.startsWith("**结论摘要**"));
  assert(content.indexOf("**重点变更**") < content.indexOf("**资源统计**"));
  assert(content.indexOf("禮物稅收金庫") < content.indexOf("vault-page.js"));
  assert.doesNotMatch(content, /建议动作/);
  assert.match(content, /- 原：<font color="red">旧手续费 旧配置说明/);
  assert.match(content, /  新：<font color="green">新手续费 新配置说明/);
  assert.match(content, /旧配置说明 旧配置说明 旧配置说明/);
  assert.match(content, /新配置说明 新配置说明 新配置说明/);
  assert.doesNotMatch(content, /\.\.\.|…/);
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
  assert.doesNotMatch(notification.content, /完整资源 Diff/);
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
  assert.match(content, /enabled：<font color="red">true<\/font> → <font color="green">false<\/font>/);
});

test("round vault factory aggregation stabilizes conflicting page snapshots", () => {
  const factory = "0xD5f57C8FbFFE993ca7c73858DEBE18f79ff4a3F8";
  const entries = [
    {
      url: "https://flap.sh/bnb/CAstore",
      map: { [factory]: { name: "ShortOnlyVaultOracle", factory, enabled: true, showInCAStore: false, ai: false, constraints: null } },
    },
    {
      url: "https://flap.sh/launch",
      map: { [factory]: { name: "ShortOnlyVaultOracle", factory, enabled: true, showInCAStore: true, ai: false, constraints: null } },
    },
    {
      url: "https://flap.sh/create",
      map: { [factory]: { name: "ShortOnlyVaultOracle", factory, enabled: true, showInCAStore: false, ai: false, constraints: null } },
    },
  ];

  const { map, conflicts } = __testables.mergeRoundVaultFactoryMaps(entries);
  const diff = __testables.diffVaultFactories({
    [factory]: { name: "ShortOnlyVaultOracle", factory, enabled: true, showInCAStore: true, ai: false, constraints: null },
  }, map);

  assert.equal(map[factory].showInCAStore, false);
  assert(conflicts.some(c => c.field === "showInCAStore"));
  assert.equal(diff.modified.length, 1);
  assert.deepEqual(diff.modified[0].diffs, ["showInCAStore: true → false"]);
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
