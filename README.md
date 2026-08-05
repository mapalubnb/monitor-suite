# Monitor Suite 📡

用于监控 **Four.meme** 与 **Flap.sh** 的自动化工具。发现页面、接口、合约、链上资产或 GitHub 变化后，通过飞书群及时推送。

## ✨ 主要功能

- **Four.meme**：底池、前端页面、公开 API、OpenFour 模板、GitHub、合约及链上参数。
- **Flap.sh**：BNB CAStore、Robinhood CAStore、金库工厂、链上金库注册，以及 Factory 底池的新增、配置修改、暂停、恢复和停用。
- **飞书卡片**：规则结果优先发送，AI 摘要异步补充；长文案、URL、地址和交易哈希完整保留。
- **稳定低延迟**：支持 PM2、动态 RPC 竞速、短超时切换、断点补扫和去重；Factory 名称与飞书发送不阻塞后续扫描。
- **前端增量抓取**：FourMeme 保留真实 `dpl` 部署 URL，同路径部署参数变化直接迁移缓存，只下载新增或路径变化的资源；部分失败会在下轮只补抓失败项。
- **前端抗风控**：同一进程使用稳定浏览器标识，脚本和样式请求携带正确的资源类型与页面来源；同域请求只错开启动时间，慢响应不会串行阻塞页面和 API 监控。
- **Factory 防漏检**：新候选先保存再复核，getter 暂时失败会持续重试；RPC 空日志需双节点确认，避免错误推进游标。
- **低资源运行**：Factory 只读取三个可信配置事件，不遍历历史交易；状态文件自动剪枝并使用紧凑格式保存。

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
| `fl-status` | 查看 Flap.sh、金库、Factory 资产及当前扫描区块 |
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
| Flap.sh | Factory 断点补扫 | 后台运行，自动找回停机或 RPC 故障期间的变化 |
| Flap.sh | Factory 已知资产复核 | 后台轮转，补充发现 getter 状态变化 |

前端页面或 API 遇到 `403`、`429`、Cloudflare 或网络异常时会自动退避和重试。静态资源按 URL 独立执行 `30 秒 → 60 秒 → 120 秒 → 5 分钟` 退避，成功后立即恢复；HTML 仍按 7 秒频率检测。只有当前资源全部就绪后才更新正式快照，不会把半包或请求失败误判为业务变更。

## ⏱️ 调整频率

- Four.meme 前端最低 `5` 秒，API 最低 `8` 秒，其余高频模块最低 `1` 秒。
- Four.meme HTTP 链上读取默认使用 bloXroute、48Club、Alchemy Public 和 PublicNode 四个独立节点；按并发负载、失败次数、实时延迟和退避状态自动轮转，不固定单一主节点。
- 同一时刻完全相同的 RPC 请求会共享一次网络结果；单节点 `403/429` 只隔离该节点，其他健康节点继续工作，所有节点均退避时快速结束本轮，避免形成请求风暴。
- 可通过 `FOURMEME_BSC_RPC_URLS` 覆盖默认节点列表，不会改变任何监控间隔。
- Four.meme 合约监控使用 `eth_getStorageAt + eth_getCode` 批量读取并在本地计算代码哈希，不依赖公共节点兼容性较差的 `eth_getProof`。
- Flap 轮询最低 `500ms`。
- Flap Factory 实时扫描使用固定 1 秒节拍和 0 确认块；RPC 自动选择低延迟健康节点，断点补扫与资产复核在后台轮转并主动让路。
- Factory 实时、断点补扫和资产复核可以并行请求，扫描结果、游标、状态文件和通知队列按单写顺序合并，不会互相覆盖。
- Factory 不再从部署区块开始扫描完整历史。更新部署前已经存在、但当前 15 个基线资产之外的旧资产不会自动回溯；更新后的新事件和停机缺口仍会及时发现。
- 频率变量均在 [.env.example](./.env.example) 中有说明；修改 `.env` 后执行 `mon-restart`。
- 遇到源站风控时，优先适当增加间隔或将前端并发从 `6` 降到 `4`。

## 📨 飞书输出

- 变更会先发送规则化结果，AI 分析完成后再更新原卡片。
- 文案、i18n、URL、地址和交易哈希不会截断；超长内容自动拆分为连续卡片。
- 普通卡片不显示操作按钮，仅在存在完整 DIFF 文件时显示下载按钮。
- Factory 底池使用“支持创建 / 暂停创建 / 已停用”三种状态；卡片显示变更数量、名称或符号、状态和完整可点击地址。
- 启动卡片使用精简信息；状态卡片只显示必要的 Factory 扫描进度，不显示交易和内部配置字段。

## 🧹 Factory 状态瘦身

旧版 `factory-pool-state.json` 如果因错误候选膨胀到数百 MB，升级后需执行一次流式瘦身。该命令保留资产、扫描游标和待发送通知，并自动备份原文件：

```bash
cd /root/monitor-suite
pm2 stop flap-monitor
npm install
npm run repair:flap-factory-state -- flap-monitor/factory-pool-state.json
pm2 restart flap-monitor
fl-status
```

状态文件超过 16MB 时监控会拒绝整文件解析并提示运行上述命令，避免 Node.js 再次 OOM。

## 🧭 路由管理

在飞书群发送 `route list` 查看待确认路由，使用 `route add <完整URL>` 添加，或用 `route ignore <完整URL>` 忽略。路由移除需要连续确认，避免 SSR 或部署切换产生误报。

## 🔍 排查问题

常见检查：

- 飞书不推送：检查三个 `FEISHU_*` 配置、机器人权限及群成员状态。
- GitHub 请求失败：检查服务器 DNS、IPv4/IPv6 路由和 `GITHUB_TOKEN`。
- 页面频繁报错：先查看日志中的首个失败 URL 和底层错误，再检查 `fourmeme-monitor/frontend-asset-failures.json` 的完整失败清单；必要时降低前端资源并发。
- Factory 扫描落后：检查 `fl-status` 的实时与断点游标以及 RPC 日志；断点补扫会从 `lastScannedBlock` 继续，不会遍历部署以来的全部历史。
- Factory 显示候选复核失败：候选地址和交易证据已保留，实时轮询会自动重试；检查 RPC getter 可用性即可。

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
