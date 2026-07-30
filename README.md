# Monitor Suite 📡

用于监控 **Four.meme** 与 **Flap.sh** 的自动化工具。发现页面、接口、合约、链上资产或 GitHub 变化后，通过飞书群及时推送。

## ✨ 主要功能

- **Four.meme**：底池、前端页面、公开 API、OpenFour 模板、GitHub、合约及链上参数。
- **Flap.sh**：BNB CAStore、Robinhood CAStore、金库工厂、链上金库注册，以及 Factory 底池的新增、配置修改、暂停、恢复和停用。
- **飞书卡片**：规则结果优先发送，AI 摘要异步补充；长文案、URL、地址和交易哈希完整保留。
- **稳定低延迟**：支持 PM2、RPC 切换、重试、断点续扫和去重；Factory 名称查询不阻塞首次推送。

> ℹ️ 项目不包含心跳检测和日报，只推送启动、变更、异常与恢复消息。

## 🚀 快速安装

适用环境：Ubuntu 24.04、Node.js 20+。安装脚本会自动安装 Node.js、PM2 和项目依赖。

```bash
cd /root
git clone git@github.com:mapalubnb/monitor-suite.git
cd monitor-suite
cp .env.example .env
nano .env
sudo bash install.sh
```

安装后会启动 `fourmeme-monitor`、`flap-monitor` 和 `feishu-bot` 三个 PM2 进程。

## ⚙️ 必填配置

编辑 `/root/monitor-suite/.env`，至少填写：

```env
FEISHU_APP_ID=cli_xxxxxxxxxxxx
FEISHU_APP_SECRET=your_app_secret_here
FEISHU_CHAT_ID=oc_xxxxxxxxxxxx
```

AI 摘要可选，填写 `DOUBAO_API_KEY`、`DEEPSEEK_API_KEY`、`QWEN_API_KEY` 或 `OPENAI_API_KEY` 中任意一个即可。

所有可配置项及说明见 [.env.example](./.env.example)。

## 🔄 更新部署

```bash
cd /root/monitor-suite
git pull
sudo bash install.sh
pm2 status
```

`install.sh` 会保留现有 `.env`，并自动补齐新版新增的配置项。

## 🛠️ 常用命令

| 命令 | 用途 |
| --- | --- |
| `mon-status` | 查看全部进程和监控摘要 |
| `mon-log [N]` | 查看全部日志 |
| `mon-restart` | 重启全部进程 |
| `fm-status` | 查看 Four.meme 状态 |
| `fm-log [N]` | 查看 Four.meme 日志 |
| `fm-check` | 立即执行 Four.meme 检测 |
| `fl-status` | 查看 Flap.sh、金库和 Factory 资产状态 |
| `fl-log [N]` | 查看 Flap.sh 日志 |
| `bot-status` | 查看飞书 Bot 状态 |
| `bot-log [N]` | 查看飞书 Bot 日志 |

## 📊 监控范围与默认频率

| 平台 | 模块 | 默认频率 |
| --- | --- | --- |
| Four.meme | 底池、OpenFour、合约、链上参数 | 2 秒 |
| Four.meme | 前端页面、文案、i18n、路由与资源 | 7 秒 |
| Four.meme | 公开 API 结构与值 | 10 秒 |
| Four.meme | 创建者链上动作 | WebSocket 实时，HTTP 8 秒兜底 |
| Four.meme | GitHub 提交 | 有 Token 30 秒，无 Token 90 秒 |
| Flap.sh | 页面与链上注册中心 | 1 秒 |
| Flap.sh | Factory 底池新增、修改、暂停、恢复与停用快通道 | 1 秒，不等待确认块 |
| Flap.sh | Factory 缺口与历史补扫 | 独立后台运行 |

前端或 API 遇到 `403`、`429`、Cloudflare 或网络异常时会自动退避和重试，不会把请求失败误判为业务变更。

## ⏱️ 调整频率

- Four.meme 前端最低 `5` 秒，API 最低 `8` 秒，其余高频模块最低 `1` 秒。
- Flap 轮询最低 `500ms`。
- 频率变量均在 [.env.example](./.env.example) 中有说明；修改 `.env` 后执行 `mon-restart`。
- 遇到源站风控时，优先适当增加间隔或将前端并发从 `6` 降到 `4`。

## 📨 飞书输出

- 变更会先发送规则化结果，AI 分析完成后再更新原卡片。
- 文案、i18n、URL、地址和交易哈希不会截断；超长内容自动拆分为连续卡片。
- 普通卡片不显示操作按钮，仅在存在完整 DIFF 文件时显示下载按钮。
- Factory 底池使用“支持创建 / 暂停创建 / 已停用”三种状态；卡片显示变更数量、名称或符号、状态、完整可点击地址和可快速复制的地址代码块。
- 启动卡片与状态卡片使用精简信息，不显示扫描区块、交易和内部配置字段。

## 🧭 路由管理

在飞书群发送 `route list` 查看待确认路由，使用 `route add <完整URL>` 添加，或用 `route ignore <完整URL>` 忽略。路由移除需要连续确认，避免 SSR 或部署切换产生误报。

## 🔍 排查问题

常见检查：

- 飞书不推送：检查三个 `FEISHU_*` 配置、机器人权限及群成员状态。
- GitHub 请求失败：检查服务器 DNS、IPv4/IPv6 路由和 `GITHUB_TOKEN`。
- 页面频繁报错：提高轮询间隔或降低前端抓取并发。
- Factory 历史进度较慢：保持进程持续运行，实时新资产快通道不会被历史补扫阻塞。

## ✅ 本地验证

```bash
npm install
npm run check
npm test
```

## ⚠️ 注意事项

- `.env` 包含凭证，不要提交到 Git。
- `snapshot.json`、状态文件、日志和历史文件属于运行数据，不要手动覆盖。
- `SIGUSR1` 可立即触发检测；`SIGINT` 和 `SIGTERM` 会等待消息队列排空后退出。

## License

Private
