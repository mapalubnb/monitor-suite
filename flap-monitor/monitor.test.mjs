import test from "node:test";
import assert from "node:assert/strict";

process.env.FLAP_MONITOR_TEST = "1";

const { __testables } = await import("./monitor.mjs");

test("default Flap polling interval remains fast and configurable", () => {
  assert.equal(__testables.CONFIG.pollIntervalMs, 1_500);
});

test("Flap startup card is complete and uses no emoji or bullet list markers", () => {
  const content = __testables.buildFlapStartupContent({
    pages: Object.fromEntries(__testables.CONFIG.urls.map((url, index) => [url, {
      originalUrl: url,
      assetFiles: [`asset-${index}.js`],
      i18nStrings: { title: `页面 ${index}` },
    }])),
    vaultFactories: {
      first: { name: "完整金库", factory: "0x0000000000000000000000000000000000000001", enabled: true, showInCAStore: true },
    },
    registryMonitor: { lastBlock: 100, safeLatestBlock: 105, latestBlock: 110, knownVaults: { one: {} } },
  }, "monitor-host");
  for (const url of __testables.CONFIG.urls) assert.match(content, new RegExp(url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  for (const url of __testables.CONFIG.bscRpcUrls) assert.match(content, new RegExp(url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(content, /0x0000000000000000000000000000000000000001/);
  assert.doesNotMatch(content, /[\p{Extended_Pictographic}]/u);
  assert.doesNotMatch(content, /(^|\n)-\s/m);
});

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
  assert.match(grouped[0].content, /\[\/bnb\/CAstore\]\(https:\/\/flap\.sh\/bnb\/CAstore\)/);
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
  assert.match(grouped[0].content, /\*\*🤖 AI 分析\*\*/);
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

  assert.doesNotMatch(content, /UI\/样式信号/);
  assert.doesNotMatch(content, /禁用态交互|图标\/矢量|响应式布局|组件样式变量/);
  assert.match(content, /完整资源\/UI\/实现信号见 Diff 详情/);
  assert.doesNotMatch(content, /意图判断/);
  assert.doesNotMatch(content, /M7 0\.583984/);
  assert.doesNotMatch(content, /absolute bottom-2/);
  assert.doesNotMatch(content, /disabled:pointer-events-none/);
});

test("minified code fragments are folded into intent signals instead of readable copy", () => {
  const oldFeatures = {
    assetHash: "old-assets",
    assetContents: {
      "8625.js": {
        path: "/_next/static/chunks/8625.js",
        contentHash: "old",
        strings: [
          "stable shared copy for diff matching",
          "),n}}},provides:function(n){n.generateAbstractMask=function(n){var t,a,e,i,o,s,f,c,l=n.children,u=n.attributes,m=n.main,d=n.mask,b=n.maskId,p=n.transform,v=m.width,g=m.icon",
          ")&&e.USE_PROFILES,eA=!1!==e.ALLOW_ARIA_ATTR,ex=!1!==e.ALLOW_DATA_ATTR,eS=e.ALLOW_UNKNOWN_PROTOCOLS||!1,eC=!1!==e.ALLOW_SELF_CLOSE_IN_ATTR,eP=e.SAFE_FOR_TEMPLATES||!1",
          "!==e.toLowerCase(),R=e=>!!(e&&(z(e.vault)||z(e.vaultFactory))),H=e=>e.tax?",
          ",X(t.change))})]})})(),t.showTaxInfo&&o&&(0,r.jsxs)(",
          ",label:V(t.dividendBps,Z(e.dividendBadge,",
          "{swapOpacity:undefined}",
        ],
      },
    },
  };
  const newFeatures = {
    assetHash: "new-assets",
    assetContents: {
      "8625.js": {
        path: "/_next/static/chunks/8625.js",
        contentHash: "new",
        strings: [
          "stable shared copy for diff matching",
          "),n}}},provides:function(n){n.generateAbstractMask=function(n){var t,a,e,i,o,s,f,c,l=n.children,u=n.attributes,m=n.main,d=n.mask,p=n.maskId,b=n.transform,v=m.width,g=m.icon",
          ")&&e.USE_PROFILES,eA=!1!==e.ALLOW_ARIA_ATTR,ex=!1!==e.ALLOW_DATA_ATTR,eS=e.ALLOW_UNKNOWN_PROTOCOLS||!1,eP=!1!==e.ALLOW_SELF_CLOSE_IN_ATTR,eC=e.SAFE_FOR_TEMPLATES||!1",
          "!==e.toLowerCase(),H=e=>!!(e&&(V(e.vault)||V(e.vaultFactory))),R=e=>e.tax?",
          ",Q(t.change))})]})})(),t.showTaxInfo&&o&&(0,r.jsxs)(",
          ",label:z(t.dividendBps,Z(e.dividendBadge,",
          "{swapOpacity:!1}",
          "you can still view its tax info while indexing.",
        ],
      },
    },
  };

  const { changes, meta } = __testables.diffFeatures(oldFeatures, newFeatures);
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
  const payload = JSON.stringify({ changes, meta, content });

  assert.equal(meta.assetStats.jsTextDiffs.length, 1);
  assert.equal(meta.assetStats.jsTextDiffs[0].text, "you can still view its tax info while indexing.");
  assert(meta.assetStats.codeIntentDiffs.length > 0);
  assert.deepEqual(meta.assetStats.configDiffs.filter(d => d.field === "swapOpacity"), []);
  assert.doesNotMatch(content, /实现意图信号/);
  assert.doesNotMatch(content, /税费\/税务信息|Vault\/金库判定|分红参数|安全\/富文本白名单/);
  assert.match(content, /you can still view its tax info while indexing\./);
  assert.doesNotMatch(payload, /generateAbstractMask/);
  assert.doesNotMatch(content, /USE_PROFILES|showTaxInfo&&o|dividendBps,Z|!==e\.toLowerCase|generateAbstractMask/);
  assert.doesNotMatch(content, /swapOpacity/);
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

test("same Flap business change coalesces even when page chunks and UI impact differ", () => {
  const jsTextDiffs = [
    { type: "added", text: ", you can still view its fee info while indexing.", file: "page-placeholder.js" },
    { type: "removed", text: "DiamondPulse Tail-Cut Vault", file: "page-placeholder.js" },
  ];
  const codeIntentDiffs = [
    { type: "added", key: "dividend", label: "分红参数", intent: "可能调整 dividendBps、分红徽标或分红展示逻辑", evidence: "dividendBps / dividendBadge", file: "main-app-c72dc75351f84185.js" },
    { type: "added", key: "dividend", label: "分红参数", intent: "可能调整 dividendBps、分红徽标或分红展示逻辑", evidence: "dividendBps / dividendBadge", file: "main-app-c72dc75351f84185.js" },
    { type: "removed", key: "dividend", label: "分红参数", intent: "可能调整 dividendBps、分红徽标或分红展示逻辑", evidence: "dividendBps / dividendBadge", file: "main-app-4a134b52bf8b81e0.js" },
    { type: "removed", key: "dividend", label: "分红参数", intent: "可能调整 dividendBps、分红徽标或分红展示逻辑", evidence: "dividendBps / dividendBadge", file: "main-app-4a134b52bf8b81e0.js" },
  ];
  const makeUiDiffs = (count, files) => Array.from({ length: count }, (_, i) => ({
    type: i % 2 ? "removed" : "added",
    category: "layout",
    label: "布局定位",
    intent: "调整组件位置、对齐或层级",
    evidence: "absolute / top / right / bottom / translate",
    contextKey: i >= 2 ? "wallet-connect" : "unknown",
    contextLabel: i >= 2 ? "钱包连接控件" : "未定位具体组件",
    contextConfidence: i >= 2 ? "高" : "低",
    file: files[i % files.length],
  }));
  const makeNotification = ({ url, key, pageRoute, pageFile, uiCount, uiFiles }) => {
    const assetPaths = [
      "/_next/static/chunks/3092-8887ce94f4aa5d3e.js",
      "/_next/static/chunks/5437-ad8495d6a7676030.js",
      `/_next/static/chunks/app/${pageRoute}/${pageFile}`,
      "/_next/static/css/2dfb716651435e0a.css",
      "/_next/static/chunks/main-app-4a134b52bf8b81e0.js",
      "/_next/static/chunks/webpack-597e0b49301a2e1a.js",
    ];
    const pageJsTextDiffs = jsTextDiffs.map(d => ({ ...d, file: pageFile }));
    const uiStyleDiffs = makeUiDiffs(uiCount, uiFiles);
    const assetStats = {
      unchanged: 28,
      renamed: 1,
      modified: 8,
      added: 0,
      removed: 0,
      noiseFiles: 2,
      noiseCount: 6,
      substantiveFiles: 6,
      substantiveCount: 8,
      substantiveFileNames: ["3092-8887ce94f4aa5d3e.js", "5437-ad8495d6a7676030.js", pageFile, "2dfb716651435e0a.css", "main-app-4a134b52bf8b81e0.js", "webpack-597e0b49301a2e1a.js"],
      substantiveAssetPaths: assetPaths,
      semanticProfile: __testables.buildAssetSemanticProfile(assetPaths, { configDiffs: [], vaultDiffs: [], jsTextDiffs: pageJsTextDiffs, uiStyleDiffs, codeIntentDiffs }),
      configDiffs: [],
      vaultDiffs: [],
      jsTextDiffs: pageJsTextDiffs,
      uiStyleDiffs,
      codeIntentDiffs,
    };
    return {
      url,
      title: "Flap 页面变更",
      template: "red",
      changes: ["📦 前端资源变更：修改 8 | 重命名 1"],
      meta: {
        assetStats,
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
    makeNotification({ url: "https://flap.sh/create", key: "create", pageRoute: "create", pageFile: "page-62ecac793de5f41d.js", uiCount: 2, uiFiles: ["407-7088d032298ec180.js", "4643-7d9eda7b083f9d52.js"] }),
    makeNotification({ url: "https://flap.sh/bnb/CAstore", key: "castore", pageRoute: "[chain]/CAstore", pageFile: "page-50dce0de0e0c111a.js", uiCount: 8, uiFiles: ["6055-d674eedd435ff478.js", "1946-b696c7945cec7add.js", "407-7088d032298ec180.js", "4643-7d9eda7b083f9d52.js"] }),
    makeNotification({ url: "https://flap.sh/launch", key: "launch", pageRoute: "launch", pageFile: "page-d53a27e3a7a1ff1e.js", uiCount: 2, uiFiles: ["407-7088d032298ec180.js", "4643-7d9eda7b083f9d52.js"] }),
  ]);

  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].title, "Flap 全站前端资源变更");
  assert.equal(grouped[0].url, "https://flap.sh");
  assert.equal(grouped[0].snapshotUpdates.length, 3);
  assert.match(grouped[0].content, /影响页面: 3 个/);
  assert.match(grouped[0].content, /功能文案 2 处/);
  assert.doesNotMatch(grouped[0].content, /实现意图信号/);
  assert.doesNotMatch(grouped[0].content, /UI\/样式信号/);
  assert.match(grouped[0].content, /DiamondPulse Tail-Cut Vault/);
  assert.match(grouped[0].content, /you can still view its fee info while indexing/);
  assert.doesNotMatch(grouped[0].content, /钱包连接控件/);
  assert.doesNotMatch(grouped[0].title, /重点变更/);
});

test("shared minified implementation signals are coalesced without raw code in the card", () => {
  const codeIntentDiffs = [
    { type: "removed", key: "tax", label: "税费/税务信息", intent: "可能调整税费读取、税务信息展示或索引期查看逻辑", evidence: "showTaxInfo / taxInfo / tax", file: "8625-old.js" },
    { type: "added", key: "tax", label: "税费/税务信息", intent: "可能调整税费读取、税务信息展示或索引期查看逻辑", evidence: "showTaxInfo / taxInfo / tax", file: "8625-new.js" },
    { type: "added", key: "dividend", label: "分红参数", intent: "可能调整 dividendBps、分红徽标或分红展示逻辑", evidence: "dividendBps / dividendBadge", file: "8625-new.js" },
  ];
  const makeNotification = (url, key) => ({
    url,
    title: "Flap 页面变更",
    template: "red",
    changes: [
      "📦 前端资源变更：修改 1",
      "📝 8625-old.js → 8625-new.js (3 处实质变更)",
      "  · 3 处不可读实现片段已折叠到 Diff 详情",
    ],
    meta: {
      assetStats: {
        unchanged: 20,
        renamed: 1,
        modified: 1,
        added: 0,
        removed: 0,
        noiseFiles: 1,
        noiseCount: 3,
        substantiveFiles: 0,
        substantiveCount: 0,
        substantiveFileNames: ["8625-new.js"],
        substantiveAssetPaths: ["/_next/static/chunks/8625-new.js"],
        configDiffs: [],
        vaultDiffs: [],
        jsTextDiffs: [],
        uiStyleDiffs: [],
        codeIntentDiffs,
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
    makeNotification("https://flap.sh/bnb/CAstore", "castore"),
    makeNotification("https://flap.sh/launch", "launch"),
    makeNotification("https://flap.sh/create", "create"),
  ]);

  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].title, "Flap 全站前端资源变更");
  assert.equal(grouped[0].url, "https://flap.sh");
  assert.doesNotMatch(grouped[0].content, /实现意图信号/);
  assert.doesNotMatch(grouped[0].content, /税费\/税务信息/);
  assert.doesNotMatch(grouped[0].content, /分红参数/);
  assert.match(grouped[0].content, /完整资源\/UI\/实现信号见 Diff 详情/);
  assert.doesNotMatch(grouped[0].content, /showTaxInfo&&o|dividendBps,Z|function\(|generateAbstractMask/);
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
  assert.doesNotMatch(grouped[0].content, /UI\/样式信号/);
  assert.doesNotMatch(grouped[0].content, /禁用态交互|钱包连接控件|顶部导航\/下拉菜单/);
  assert.match(grouped[0].content, /完整资源\/UI\/实现信号见 Diff 详情/);
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
  assert.match(notification.content, /金库:/);
  assert.match(notification.content, /禮物稅收金庫/);
  assert.match(notification.content, /指定一個 X 帳戶/);
  assert.match(notification.content, /<font color="green">新增金库<\/font>/);
  assert.equal(notification.launchUrl, "https://flap.sh/launch?vaultfactory=0x08E41a61C5D25420E3cb314Bc513EC99B2841003");
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

test("page change card puts summary and important copy before ai analysis", () => {
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

  assert(content.startsWith("**📌 结论摘要**"));
  assert(content.indexOf("**🎯 重点变更**") < content.indexOf("**🤖 AI 分析**"));
  assert.doesNotMatch(content, /\*\*资源统计\*\*/);
  assert.doesNotMatch(content, /- 概览: 修改/);
  assert.doesNotMatch(content, /建议动作/);
  assert.match(content, /- 原：<font color="red">旧手续费 旧配置说明/);
  assert.match(content, /  新：<font color="green">新手续费 新配置说明/);
  assert.match(content, /旧配置说明 旧配置说明 旧配置说明/);
  assert.match(content, /新配置说明 新配置说明 新配置说明/);
  assert.doesNotMatch(content, /\.\.\.|…/);
  assert.match(content, /AI 分析异步生成中，变更已先推送/);
});

test("launch text card summarizes anti-farmer duration changes and keeps full source copy", () => {
  const cssNoise = `span:first-child]:h-1 [&>span:first-child]:rounded-none [&[role=slider]]:h-3 style="--radix-slider-thumb-transform:translateX(-50%)"`;
  const addedDescription = "This feature ensures that trades occur primarily in the tax liquidity pool during the protection period, improving the stability of token tax revenue.";
  const content = __testables.buildCardBriefing(
    "https://flap.sh/launch",
    null,
    null,
    8,
    0,
    [],
    [
      {
        type: "modified",
        oldText: `Payment token * BNB USDT USD1 ASTER U 币安人生 Token Setting Buy Tax Rate ${cssNoise} Anti-Farmer Protection Duration 3 day(s) During the anti-farmer protection period, users will not be able to add liquidity to some V3 pools. Set 0 days to disable the protection period. Min: 0 days · Max: 1 year (365 days) · Default: 3 days Tax Allocation Total allocation must be 100%`,
        newText: `Payment token * BNB USDT USD1 ASTER U 币安人生 Token Setting Buy Tax Rate ${cssNoise} Anti-Farmer Protection Duration 30 day(s) During the anti-farmer protection period, users will not be able to add liquidity to some V3 pools. ${addedDescription} Set 0 days to disable the protection period. Min: 0 days · Max: 1 year (365 days) · Default: 30 days Tax Allocation Total allocation must be 100%`,
        ctxBefore: "Create Tax Token Create Token Reserve Your Token CA",
      },
      {
        type: "added",
        text: addedDescription,
        ctxBefore: "During the anti-farmer protection period, users will not be able to add liquidity to some V3 pools.",
      },
    ],
    [],
  );

  assert.match(content, /页面文案变更（归纳 \+ 完整原文，共 2 处）/);
  assert.match(content, /防巨鲸薅币保护周期（Anti-Farmer Protection Duration）/);
  assert.match(content, /默认时长/);
  assert.match(content, /<font color="red">3 天<\/font> → <font color="green">30 天<\/font>/);
  assert.match(content, /取值区间：最小值 0 天 \/ 最大值 365 天（1 年），区间规则未改动/);
  assert.match(content, /新增说明/);
  assert.match(content, /开关提示未改/);
  assert.match(content, /radix-slider/);
  assert.match(content, /Payment token \* BNB/);
  assert.match(content, new RegExp(addedDescription.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
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

  assert(notification.content.startsWith("**📌 结论摘要**"));
  assert(notification.content.indexOf("本地初筛") < notification.content.indexOf("**🌐 影响页面**"));
  assert(notification.content.indexOf("**🌐 影响页面**") < notification.content.indexOf("**🎯 重点变更**"));
  assert(notification.content.indexOf("**🎯 重点变更**") < notification.content.indexOf("**🤖 AI 分析**"));
  assert.doesNotMatch(notification.content, /\n- \[\/bnb\/CAstore\]/);
  assert.doesNotMatch(notification.content, /资源统计/);
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

  assert.doesNotMatch(notification.content, /资源范围/);
  assert.doesNotMatch(notification.content, /runtime/);
  assert.doesNotMatch(notification.content, /共享 chunk/);
  assert.match(notification.content, /完整资源\/UI\/实现信号见 Diff 详情/);
  assert.doesNotMatch(notification.content, /trustedTypes|t=0;t/);
  assert.doesNotMatch(notification.content, /!=typeof/);
});

test("vault factory card summarizes counts before details", () => {
  const content = __testables.formatVaultFactoryChanges({
    added: [{ name: "Gift Vault", factory: "0xabc", showInCAStore: true, ai: false, enabled: true, constraints: { min: 1 } }],
    removed: [],
    modified: [{ name: "Old Vault", factory: "0xdef", diffs: ["enabled: true → false"] }],
  });

  assert(content.startsWith("**📌 结论摘要**"));
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

test("vault factory extraction resolves webpack aliases for visible CAStore vault changes", () => {
  const chunk = `
  (self.webpackChunk_N_E=self.webpackChunk_N_E||[]).push([[1],{
    78770:function(e,t,a){"use strict";a.d(t,{JY:function(){return d},ON:function(){return l}});let l="IndexVault",d="0x5418f7e8fF90354DB0eCD48c8b710219244Eb3C5";},
    56704:function(e,t,a){"use strict";a.d(t,{KB:function(){return s},Fn:function(){return d},vg:function(){return r}});let r="StocksVault",s="0x40a9a2FDa017E0923EA0B403F2f063f9E51168Fb",d=["0xf8aC088F06D155f3C3F531f1Ef80B14f1604530a"];}
  }]);
  var r=a(78770),i=a(56704);
  const config={taxVaults:{vaultTypes:[
    {name:r.ON,factory:r.JY,enabled:!0,showInCAStore:!0,constraints:{minDividendBps:0,maxDividendBps:0},descriptionI18nKey:"vaults.IndexVault.description",shortDescriptionI18nKey:"vaults.IndexVault.shortDescription",logo:"/stocks-vault-logo.svg"},
    {name:i.vg,factory:i.KB,enabled:!0,showInCAStore:!1,constraints:{minDividendBps:0,maxDividendBps:0},extra:{legacyFactories:i.Fn.join(",")},descriptionI18nKey:"vaults.StocksVault.description",shortDescriptionI18nKey:"vaults.StocksVault.shortDescription",logo:"/stocks-vault-logo.svg"}
  ]}};
  `;

  const vf = __testables.extractVaultFactories(chunk);
  const map = Object.fromEntries(vf.factories.map(v => [v.factory.toLowerCase(), v]));
  const index = map["0x5418f7e8ff90354db0ecd48c8b710219244eb3c5"];
  const stocks = map["0x40a9a2fda017e0923ea0b403f2f063f9e51168fb"];

  assert.equal(index.name, "IndexVault");
  assert.equal(index.showInCAStore, true);
  assert.equal(index.descriptionI18nKey, "vaults.IndexVault.description");
  assert.equal(stocks.name, "StocksVault");
  assert.equal(stocks.showInCAStore, false);
  assert.equal(stocks.legacyFactories, "0xf8aC088F06D155f3C3F531f1Ef80B14f1604530a");

  const diff = __testables.diffVaultFactories({
    "0x40a9a2FDa017E0923EA0B403F2f063f9E51168Fb": { ...stocks, showInCAStore: true },
  }, __testables.mergeRoundVaultFactoryMaps([{ url: "https://flap.sh/bnb/CAstore", map: __testables.factoryListToMap(vf.factories) }]).map);
  const content = __testables.formatVaultFactoryChanges(diff);
  const title = __testables.buildVaultFactoryChangeTitle(diff, "🏦 ");

  assert.equal(diff.added.length, 1);
  assert.equal(diff.modified.length, 1);
  assert.match(title, /新增可见 1 \/ 下架 1/);
  assert.match(content, /IndexVault/);
  assert.match(content, /0x5418f7e8fF90354DB0eCD48c8b710219244Eb3C5/);
  assert.match(content, /StocksVault/);
  assert.match(content, /showInCAStore/);
});

test("registry log extraction detects on-chain registered vault address", () => {
  const log = {
    address: "0x90497450f2a706f1951b5bdda52b4e5d16f34c06",
    topics: ["0xd8cf270eb9827992a063745f0afaa72431f8c63fc46736f8b484862dcc709787"],
    data: "0x0000000000000000000000005418f7e8ff90354db0ecd48c8b710219244eb3c50000000000000000000000000000000000000000000000000000000000000001",
    blockNumber: "0x66c7754",
    transactionHash: "0x9e239cd0483e66d8f077f786fd5bfdee4036e838c0dedf680f63eabbd2614e68",
  };

  const addresses = __testables.extractRegistryVaultAddressesFromLog(log);
  const content = __testables.buildRegistryMonitorContent([{
    vault: addresses[0],
    txHash: log.transactionHash,
    blockNumber: Number.parseInt(log.blockNumber, 16),
    topic0: log.topics[0],
  }], { fromBlock: 107771732, toBlock: 107771732 });

  assert.deepEqual(addresses, ["0x5418f7e8ff90354db0ecd48c8b710219244eb3c5"]);
  assert.match(content, /链上注册中心发现新金库 1 个/);
  assert.match(content, /注册中心:/);
  assert.doesNotMatch(content, /证据详情/);
  assert.match(content, /0x5418f7e8ff90354db0ecd48c8b710219244eb3c5/);
  assert.match(content, /0x9e239cd0/);
  assert.equal(
    __testables.buildVaultFactoryLaunchUrl(addresses[0]),
    "https://flap.sh/launch?vaultfactory=0x5418f7e8ff90354db0ecd48c8b710219244eb3c5&lang=zh",
  );
});

test("operational notice card is readable and action oriented", () => {
  const content = __testables.buildOperationalNoticeContent({
    status: "页面请求失败",
    url: "https://flap.sh/launch",
    severity: "orange",
    reason: "HTTP 403",
    consecutiveFailures: 3,
  });

  assert(content.startsWith("**📌 结论摘要**"));
  assert.match(content, /- 状态: 页面请求失败/);
  assert.match(content, /- 连续失败: 3 次/);
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

test("flap cards keep every readable copy change without truncation", () => {
  const longOld = `旧文案-${"完整内容".repeat(80)}`;
  const longNew = `新文案-${"完整内容".repeat(80)}`;
  const textChanges = Array.from({ length: 15 }, (_, i) => ({
    type: "modified",
    oldText: `${longOld}-${i}`,
    newText: `${longNew}-${i}`,
  }));
  const content = __testables.buildCardBriefing(
    "https://flap.sh/create",
    null,
    null,
    textChanges.length,
    0,
    [],
    textChanges,
  );
  assert.match(content, new RegExp(`${longOld}-14`));
  assert.match(content, new RegExp(`${longNew}-14`));
  assert.doesNotMatch(content, /完整内容\.\.\.|完整内容…|还有 \d+ 处修改/);
});
