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
