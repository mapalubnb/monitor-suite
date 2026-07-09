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
FOURMEME_HOST_REQUEST_MIN_DELAY_MS=80
FOURMEME_FRONTEND_WARMUP_STABLE_RUNS=1
```

`FOURMEME_HOST_REQUEST_MIN_DELAY_MS` 只错开 Four.meme 同 host 的请求，不改变各模块监控间隔；设为 `0` 可关闭。

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
