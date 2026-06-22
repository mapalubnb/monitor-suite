# Monitor Suite

Four.meme 和 Flap.sh 的自动化监控项目。监控结果通过飞书群推送，支持 AI 摘要、PM2 部署和快捷命令运维。

## 目录

```text
monitor-suite/
  fourmeme-monitor/      Four.meme 监控与飞书 Bot
  fourmeme-fetcher-service/ Four.meme Scrapling 抓取 sidecar
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
| OpenFour 模板 | 新模板、模板状态变化 | 3s |
| GitHub | 主仓库提交、账号仓库列表 | 30s/90s，仓库列表 300s |
| 合约与链上参数 | 合约 bytecode、AgentNFT 等链上参数 | 3s |
| 创建者动作 | WebSocket 新区块驱动，HTTP 兜底 | 实时 + 10s 兜底 |

前端/API 已做 keep-alive、条件请求、并发抓取、风控退避、去重窗口和新页面 warm-up。前端默认通过本机 Scrapling stealth 浏览器 sidecar 抓取，稳定状态下会尽量贴近 `10s/15s`；遇到 403/429/Cloudflare 等风控时会拒绝写入拦截页，并按站点聚合告警。

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
FOURMEME_FRONTEND_INTERVAL_SECONDS=10
FOURMEME_API_INTERVAL_SECONDS=15
FOURMEME_MODULE_JITTER_MS=200
FOURMEME_FRONTEND_HTML_CONCURRENCY=6
FOURMEME_FRONTEND_ASSET_CONCURRENCY=6
FOURMEME_API_PROBE_STAGGER_MS=200
FOURMEME_FRONTEND_WARMUP_STABLE_RUNS=1
```

被风控时建议先把前端并发降到：

```env
FOURMEME_FRONTEND_HTML_CONCURRENCY=4
FOURMEME_FRONTEND_ASSET_CONCURRENCY=4
```

## Cloudflare 抓取服务

Four.meme 前端默认不再使用本地手动验证 Chrome profile，而是由服务器上的 `fourmeme-fetcher-service` 常驻运行 Scrapling `AsyncStealthySession`。主监控每 10s 调度页面池，sidecar 复用同一个 stealth 浏览器上下文并限制页面池大小，常规 HTML 抓取不额外固定等待；资源 JS/CSS 只在首次、资源列表变化或创建页重点检测时按需补抓。

默认配置：

```env
FOURMEME_FRONTEND_FETCH_PROVIDER=scrapling
FOURMEME_SCRAPLING_FETCH_ENABLED=true
FOURMEME_SCRAPLING_FETCH_URL=http://127.0.0.1:8787/fetch
FOURMEME_SCRAPLING_TIMEOUT_MS=80000
FOURMEME_SCRAPLING_MAX_PAGES=4
FOURMEME_SCRAPLING_PAGE_TIMEOUT_MS=60000
FOURMEME_SCRAPLING_FETCH_TOTAL_TIMEOUT_MS=65000
FOURMEME_SCRAPLING_FETCH_WITH_ASSETS_TOTAL_TIMEOUT_MS=75000
FOURMEME_SCRAPLING_WAIT_MS=0
FOURMEME_SCRAPLING_WARMUP_URL=https://four.meme/en
FOURMEME_SCRAPLING_WARMUP_TIMEOUT_MS=90000
FOURMEME_SCRAPLING_ALLOWED_HOSTS=four.meme,*.four.meme
FOURMEME_SCRAPLING_TOKEN=
FOURMEME_SCRAPLING_SOLVE_CLOUDFLARE=true
FOURMEME_SCRAPLING_MAX_ASSETS=20
FOURMEME_SCRAPLING_MAX_ASSET_TOTAL_BYTES=6000000
FOURMEME_SCRAPLING_ASSET_TOTAL_TIMEOUT_MS=15000
FOURMEME_SCRAPLING_PROXY=
```

资源占用策略：`FOURMEME_SCRAPLING_MAX_PAGES=4` 控制浏览器并发页面数，避免每个 URL 拉起新浏览器；Node 侧 `FOURMEME_FRONTEND_HTML_CONCURRENCY` 可以继续保持 6，超过 sidecar 页面池的请求会排队。资源补抓默认最多 20 个文件、15s 总预算、6MB 总内容，防止资源 diff 拖垮 10s HTML 轮询。CPU/内存紧张时先把 `MAX_PAGES` 降到 2；如果 22 个页面无法在 10s 内完成，再把它升到 6。若服务器出口 IP 被 Cloudflare 高强度拦截，优先配置 `FOURMEME_SCRAPLING_PROXY` 为住宅/ISP 出口。

安全边界：sidecar 默认只绑定 `127.0.0.1`，且只允许抓取 `four.meme` / `*.four.meme`。如果要把 `FOURMEME_SCRAPLING_HOST` 改成非 localhost，必须同时设置 `FOURMEME_SCRAPLING_TOKEN`，主监控会用同名变量发送鉴权头。

10s 间隔说明：调度器仍固定按 10s 触发，常规成功抓取可维持高频发现新路由；如果 Cloudflare 触发长挑战、代理出口不稳定或单页接近 `PAGE_TIMEOUT_MS`，当轮可能顺延，脚本会跳过拦截页并继续下一轮。

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
| `fl-status` | 查看 Flap.sh 监控摘要 |
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
npm run test:fourmeme
```

## 飞书应用

1. 在飞书开放平台创建自建应用。
2. 开启机器人能力。
3. 添加消息发送相关权限。
4. 把应用加入目标群。
5. 将 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`FEISHU_CHAT_ID` 写入 `.env`。

## 说明

- `.env` 不提交到仓库。
- `snapshot.json`、日志和历史文件是运行态数据，不应手动覆盖。
- `SIGUSR1` 可立即触发全量检测，`SIGINT`/`SIGTERM` 会优雅退出并等待消息队列排空。

## License

Private
