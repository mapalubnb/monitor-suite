# Monitor Suite 📡

监控 **Four.meme** 与 **Flap.sh** 的页面、接口、合约和链上变化，通过飞书群发送通知。项目包含两个独立监控进程和一个飞书交互机器人。

## 监控功能

### Four.meme

| 模块 | 监控内容 |
| --- | --- |
| 底池配置 | 支持资产的新增、移除及配置变化 |
| 前端页面 | 页面文案、多语言内容、静态资源、路由和 API 端点变化 |
| 公开 API | 响应结构、字段类型及关键业务值变化；列表字段类型连续三轮确认，过滤混合样本和数组标记噪声 |
| OpenFour | 业务模板上线与状态变化，Registry 模块实现和 preset 注册变化 |
| 合约与链上参数 | 代理实现地址、合约代码、关键参数及 Agent NFT 注册列表变化 |
| 创建者动作 | 已识别创建者及手动配置地址发起的交易、合约部署和管理操作 |
| GitHub | 配置账号的仓库变化，以及主仓库的新提交和代码差异 |

### Flap.sh

| 模块 | 监控内容 |
| --- | --- |
| 页面与金库目录 | BNB、Robinhood 的 CAStore 金库列表、页面内容及 metadata 字段变化 |
| Factory 底池 | 计价代币新增、配置和兑换路径变化，以及支持创建、暂停、恢复、停用状态 |
| Vault Factory | Vault Portal 中的工厂注册与配置变化；Safe、链上及页面金库卡片附带对应 Flap 金库链接 |
| Safe 提案 | 计价代币、兑换路径、创建开关、Vault Factory、资金、授权和流动性相关操作，跟踪签名及执行状态 |
| 提前信号 | 采购订单、关联地址资金流、包装资产、建池、LP 仓位及流动性变化 |
| 合约完整性 | 核心代理升级、权限、关键配置、资产黑名单与信任状态变化 |

提前信号用于发现准备动作。**采购、包装或加池不代表底池已经开放，Safe 提案也不保证执行。** 监控只读，不签名或发送链上交易；未公开的 Safe 提案无法提前获取。详细范围见 [Flap 监控说明](flap-monitor/MONITORING.md)。

## 通知与运行方式

- **飞书卡片**：展示变化内容和相关链接，长内容自动分片，完整差异可下载。
- **启动通知**：进程启动后独立发送单张卡片，后台更新首轮检查进度和异常数量；发送或更新失败会自动重试。Flap 日志记录启动卡片的发送结果，便于排查漏发。详细运行状态使用 `fm-status` 或 `fl-status` 查看。
- **可选 AI 分析**：先推送监控结果，再异步补充摘要；余额或凭证异常时暂停该提供商 30 分钟，基础通知继续发送。
- **实时与轮询结合**：链上模块使用 WSS 触发及 HTTP 兜底；页面、API、GitHub 和 Safe 服务按各自频率查询。
- **故障恢复**：实时扫描与历史补扫分别保存进度，旧积压不会阻塞最新事件；失败退避并重试待发送通知。历史节点不可用时保留缺口，状态命令显示补扫异常。
- **机器人交互**：查询状态、查看日志、管理路由和执行远程运维命令，仅允许白名单用户操作。

默认情况下，Four.meme 高频配置模块每 2 秒检查，前端每 7 秒、API 每 10 秒；Flap 页面与 Factory 实时轮询为 1 秒。具体间隔、RPC、监听地址和功能开关见 [.env.example](.env.example)，实际延迟受确认块、网络和服务限流影响。

## 安装与配置

适用环境：Ubuntu 24.04、Node.js 20+。安装脚本负责安装 Node.js、PM2 和依赖，并启动 `fourmeme-monitor`、`flap-monitor`、`feishu-bot` 三个进程。

```bash
cd /root
git clone git@github.com:mapalubnb/monitor-suite.git
cd monitor-suite
cp .env.example .env
nano .env
sudo bash install.sh
```

安装前在 `.env` 中填写飞书应用凭证和目标群：

```env
FEISHU_APP_ID=cli_xxxxxxxxxxxx
FEISHU_APP_SECRET=your_app_secret_here
FEISHU_CHAT_ID=oc_xxxxxxxxxxxx
```

其他配置按需填写：

| 配置 | 用途 |
| --- | --- |
| `FEISHU_ALLOWED_SENDERS` | 可操作机器人的用户 open_id，逗号分隔；留空拒绝交互操作，自动告警不受影响 |
| `FEISHU_MENTION_OPEN_ID` | Flap 重点告警需要 @ 的用户，留空不提醒指定用户 |
| `FLAP_SAFE_API_KEY` | Safe 提案查询认证 |
| `GITHUB_TOKEN` | 提高 GitHub API 可用额度 |
| `DOUBAO_API_KEY` / `DEEPSEEK_API_KEY` / `QWEN_API_KEY` / `OPENAI_API_KEY` | 可选，填写任意一个以启用 AI 摘要 |

完整配置和每项说明见 [.env.example](.env.example)。保留 `.env` 和运行状态文件，不要提交凭证或删除用于恢复进度的快照。

### 调整监控配置

编辑 `/root/monitor-suite/.env`，可修改监控频率、RPC 节点、监听地址及功能开关：

- **Four.meme**：前端默认 7 秒、最低 5 秒；API 默认 10 秒、最低 8 秒；底池、模板、合约和链上参数默认 2 秒、最低 1 秒。
- **Flap**：页面默认 1000ms、最低 500ms；Safe 提案默认 10 秒，有待执行提案时切换为 5 秒。
- **RPC**：通过 `FOURMEME_BSC_RPC_URLS` 等对应模块配置指定节点；多个地址按 `.env.example` 的格式填写。
- **源站限流**：适当增加检查间隔，或降低前端请求并发。

修改配置后重启并查看状态：

```bash
cd /root/monitor-suite
nano .env
mon-restart
mon-status
```

## 更新部署

已有安装直接拉取代码并重新运行安装脚本：

```bash
cd /root/monitor-suite
git pull
sudo bash install.sh
pm2 status
```

`install.sh` 会保留现有 `.env`，并自动补齐缺少的配置项。需要凭证的项目仍需自行填写；不要重新复制 `.env.example` 覆盖已有配置，也不要删除监控状态文件。

## 日常使用

| 命令 | 用途 |
| --- | --- |
| `mon-status` / `mon-log [N]` | 查看全部进程状态或日志 |
| `mon-restart` | 重启全部进程 |
| `fm-status` / `fm-log [N]` | 查看 Four.meme 状态或日志 |
| `fm-check` | 立即触发 Four.meme 检查 |
| `fl-status` / `fl-log [N]` | 查看 Flap 状态、扫描进度或日志 |
| `bot-status` / `bot-log [N]` | 查看机器人状态或日志 |

白名单用户可在飞书中使用 `route list` 查看待确认的 Four.meme 路由，使用 `route add <完整URL>` 加入监控，或用 `route ignore <完整URL>` 忽略。

异常时先查看对应模块的状态和日志，核对飞书权限、RPC 连接或接口限流情况。

本地检查：

```bash
npm install
npm run check
npm test
```
