# Monitor Suite

Four.meme 和 Flap.sh 的自动化监控项目。监控结果通过飞书群推送，支持 AI 摘要、PM2 部署和快捷命令运维。

## 目录

```text
monitor-suite/
  fourmeme-monitor/      Four.meme 监控与飞书 Bot
  flap-monitor/          Flap.sh 页面/API/i18n 监控
  shared/                飞书客户端、AI 客户端等共享模块
  install.sh             一键部署脚本
  .env.example           环境变量模板
  package.json           根依赖与检查脚本
```

## Four.meme 监控频率

| 模块 | 内容 | 默认频率 |
| --- | --- | --- |
| 底池配置 | Pool Config 变化 | 3s |
| 前端页面池 | HTML、文案、`__NEXT_DATA__`、i18n、路由/端点、资源 diff | 10s |
| API 结构和值 | public/KOL/token ranking/search 等公开端点 | 15s |
| OpenFour 模板 | 新模板、模板状态变化、链上 presetIds 注册 | 3s |
| GitHub | 主仓库提交、账号仓库列表 | 30s/90s，仓库列表 300s |
| 合约与链上参数 | 合约 bytecode、AgentNFT 等链上参数 | 3s |
| 创建者动作 | WebSocket 新区块驱动，HTTP 兜底 | 实时 + 10s 兜底 |

前端/API 已做 keep-alive、条件请求、并发抓取、风控退避、去重窗口和新页面 warm-up。稳定状态下会尽量贴近 `10s/15s`；遇到 403/429/Cloudflare 等风控时会自动退避。

飞书通知使用 Card JSON 2.0，以信息块和表格展示规则数据。变更通知会优先立即发送规则化结果，AI 分析完成后再补充；文案、i18n、URL、地址和交易哈希等可读变更保留完整内容，超长正文自动拆成连续多张卡片，不截断、不丢弃。卡片不提供普通操作按钮，仅在存在完整 DIFF 文件时显示下载按钮。

## 快速部署

```bash
git clone https://github.com/mapalubnb/monitor-suite.git
cd monitor-suite
cp .env.example .env
nano .env
sudo bash install.sh
```

`install.sh` 会安装依赖、配置 PM2、启动 Four.meme 监控、Flap.sh 监控和飞书 Bot。源码目录在 `/root/monitor-suite` 时使用统一部署；从其他目录运行时会复制到独立运行目录。

## 必填配置

`.env` 至少需要：

```env
FEISHU_APP_ID=cli_xxxxxxxxxxxx
FEISHU_APP_SECRET=your_app_secret_here
FEISHU_CHAT_ID=oc_xxxxxxxxxxxx
```

AI 摘要是可选能力，配置任一模型 Key 即可启用，例如：

```env
DOUBAO_API_KEY=
DEEPSEEK_API_KEY=
OPENAI_API_KEY=
```

## 高频参数

默认已按较快频率配置。需要调整时改 `.env`：

```env
FOURMEME_POOL_INTERVAL_SECONDS=2
FOURMEME_FRONTEND_INTERVAL_SECONDS=7
FOURMEME_API_INTERVAL_SECONDS=10
OPENFOUR_TEMPLATE_INTERVAL_SECONDS=2
FOURMEME_CONTRACT_INTERVAL_SECONDS=2
FOURMEME_ONCHAIN_INTERVAL_SECONDS=2
FOURMEME_MODULE_JITTER_MS=100
FOURMEME_FRONTEND_HTML_CONCURRENCY=6
FOURMEME_FRONTEND_ASSET_CONCURRENCY=6
FOURMEME_API_PROBE_STAGGER_MS=150
FOURMEME_HOST_REQUEST_MIN_DELAY_MS=60
FOURMEME_FRONTEND_WARMUP_STABLE_RUNS=1
FOURMEME_FRONTEND_ROUTE_REMOVAL_CONFIRM_RUNS=2
FOURMEME_ACTOR_HTTP_FALLBACK_MS=8000
OPENFOUR_REGISTRY_DISCOVERY_DEBOUNCE_MS=1000
FLAP_POLL_INTERVAL_MS=1000
FLAP_FACTORY_POOL_INTERVAL_MS=1000
FLAP_FACTORY_CATCHUP_INTERVAL_MS=1000
FLAP_FACTORY_HISTORY_INTERVAL_MS=1000
FLAP_FACTORY_POOL_CONFIRMATIONS=5
FLAP_FACTORY_CATCHUP_MAX_BLOCKS=2000
FLAP_FACTORY_HISTORY_LOG_CHUNK_BLOCKS=2000
FLAP_FACTORY_HISTORY_BLOCK_CHUNK_BLOCKS=10
FLAP_FACTORY_HISTORY_BACKWARD_LOG_CHUNK_BLOCKS=2000
FLAP_FACTORY_HISTORY_CONFIG_EVENT_CHUNK_BLOCKS=5000
FLAP_FACTORY_HISTORY_CONFIG_EVENT_CHUNKS_PER_RUN=5
FLAP_FACTORY_HISTORY_BACKWARD_BLOCK_CHUNK_BLOCKS=10
FLAP_FACTORY_TOKEN_METADATA_API_URL=https://api.gopluslabs.io/api/v1/token_security/56
FLAP_FACTORY_TOKEN_METADATA_TIMEOUT_MS=800
FLAP_FACTORY_TOKEN_METADATA_RETRY_MS=300000
```

`FOURMEME_HOST_REQUEST_MIN_DELAY_MS` 只错开 Four.meme 同 host 的请求，不改变各模块监控间隔；设为 `0` 可关闭。

Four.meme 前端最低 `5` 秒，API 最低 `8` 秒；底池、OpenFour、合约和链上参数最低 `1` 秒。低于下限的配置会自动钳制，避免请求过密。

全站路由和 API 引用采用聚合检测：新增引用当轮立即推送，移除连续两轮确认后推送。页面文案、i18n、配置和真实 API 变化仍保持即时通知。

`FLAP_POLL_INTERVAL_MS` 默认 `1000`，最低 `500`。遇到源站风控时可适当调高。

## 性能优化

Four.meme 监控在保持原有轮询间隔不变的前提下使用分层快速检测：创建者动作先在完整区块的原始响应文本中查找监听地址，无命中时跳过高成本 JSON 解析；合约每轮先比较链上代码哈希，代码变化后才下载 bytecode 和解析函数选择器；完全相同的前端 HTML 会直接复用结构化结果。创建者扫描游标单独保存到 `actor-state.json`，避免每个新区块重写包含全部前端资源的主快照。

`fm-status` 会显示各模块最近耗时、平均耗时、累计请求、错误数、内存、快照写入耗时以及创建者扫描模式。原始区块预过滤或 `eth_getProof` 不可用时会自动回退原有完整检测，不降低监控覆盖。

GitHub 等外部请求遇到 DNS、连接超时、连接重置或 IPv6 路由异常时会自动择优 IPv4/IPv6，并进行两次短间隔重试。最终失败日志会包含底层错误码、目标地址和原因，便于区分服务器网络问题与 GitHub API 错误。

Flap 新金库通知、金库工厂变更和状态输出会同时提供 BscScan 合约链接与 `flap.sh/launch?vaultfactory=<地址>` 金库入口。页面监控同时覆盖 BNB CAstore 与 Robinhood 中文 CAstore；Robinhood 币股金库使用独立快照及带 `chain=robinhood&lang=zh` 的金库入口，不会并入 BSC 金库工厂状态。Flap 启动卡片与 `fl-status` 状态卡片都会同步显示 Robinhood 页面、币股模板、完整 Factory 和金库入口。

Flap 同时会从 BSC 链上自动重建 Factory Proxy `0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0` 的 quoteToken 候选集合。扫描器处理 Factory 事件、管理配置调用、`newTokenV6` 等实际发射交易和完整区块交易；所有 ABI 对齐地址字段都会进入复核流程，因此 implementation 升级后即使方法选择器变化也不会只依赖旧 ABI。每个候选地址最终通过 `getQuoteTokenConfiguration(address)` 复核五个返回字段，第一字段为 `1` 时视为启用，BNB 使用零地址。

当前 Proxy 已通过只读历史状态确认部署于区块 `39980228`，创建交易为 `0x9f6935c97b662a10a8c4ea725e172e8a13fd37beb9fe76a9100ee97619639d00`。程序仍会在首次运行时自行定位并保存结果，不依赖这段文档作为运行时数据源。

Factory 扫描采用三个独立调度器：`headLastScannedBlock` 每秒追踪最新确认块，优先发现新资产；快速补扫调度器使用已验证的底池配置事件 topic，向前连续补缺口时每轮最多推进 2000 块，同时从当前区块向部署区块反向处理 5 个 5000 块区间，不再下载同区块内数万条无关 Factory 日志。配置事件单段范围在运行时钳制为 5000，即使旧 `.env` 保留更大的值也不会反复触发公共 RPC 超范围错误。深度历史模块独立执行通用日志、交易 calldata 和完整区块正反向扫描，继续覆盖 `newTokenV6` 等没有可识别配置事件的历史调用。启动前已经存在的底池会优先由配置事件反向通道发现，不必等待正向游标遍历数千万区块，也不会因只依赖单一事件而漏检。

链上状态独立保存在 `flap-monitor/factory-pool-state.json`，并支持 RPC 自动切换、动态日志分块、短链重组检查、断点续扫和持久化待发送通知。首次全新安装只建立实时基线；已有游标的进程重启会继续检测停机期间的确认块，发送失败的待通知也不会被启动流程清空。新底池卡片不等待名称请求：链上变化确认后立即推送完整地址、状态、交易和区块，名称未缓存时暂显“名称同步中”；随后异步并行请求 GoPlus 免费免密 API 与只读 ERC-20 `name()`、`symbol()`，获取成功后编辑原飞书卡片，不产生第二张重复通知。结果写入状态缓存且不影响链上配置判断。启动卡片、变更卡片和 `fl-status` 只显示名称、符号、状态和完整地址，不再展示五个内部配置字段。

被风控时建议先把前端并发降到：

```env
FOURMEME_FRONTEND_HTML_CONCURRENCY=4
FOURMEME_FRONTEND_ASSET_CONCURRENCY=4
```

## 常用命令

```bash
pm2 status
pm2 logs fourmeme-monitor
pm2 restart all
```

安装后也可使用快捷命令：

| 命令 | 用途 |
| --- | --- |
| `mon-status` | 查看全部进程和数据摘要 |
| `mon-log [N]` | 查看全部日志 |
| `mon-restart` | 重启全部进程 |
| `fm-status` | 查看 Four.meme 监控摘要 |
| `fm-log [N]` | 查看 Four.meme 日志 |
| `fm-check` | 立即触发 Four.meme 全量检测 |
| `fl-status` | 查看 Flap.sh 页面、金库工厂和链上注册中心摘要 |
| `fl-log [N]` | 查看 Flap.sh 日志 |
| `bot-status` | 查看飞书 Bot 状态 |
| `bot-log [N]` | 查看飞书 Bot 日志 |

## 更新部署

```bash
cd ~/monitor-suite
git pull
sudo bash install.sh
pm2 status
```

## 本地检查

```bash
npm run check
npm test
```

## 飞书应用

1. 在飞书开放平台创建自建应用。
2. 开启机器人能力。
3. 添加消息发送相关权限。
4. 把应用加入目标群。
5. 将 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`FEISHU_CHAT_ID` 写入 `.env`。

在飞书中可发送 `route list` 查看待确认的新路由，使用 `route add <完整URL>` 加入前端监控，或使用 `route ignore <完整URL>` 忽略该路由。

## 说明

- `.env` 不提交到仓库。
- `snapshot.json`、日志和历史文件是运行态数据，不应手动覆盖。
- 飞书仅推送启动、变更、异常和恢复消息，不提供周期心跳与日报。
- `SIGUSR1` 可立即触发全量检测，`SIGINT`/`SIGTERM` 会优雅退出并等待消息队列排空。

## License

Private
