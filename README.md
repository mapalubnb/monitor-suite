# Monitor Suite

实时监控 [Four.meme](https://four.meme) 和 [Flap.sh](https://flap.sh) 平台变更的自动化监控系统，通过飞书群聊推送告警和 AI 变更摘要。

## 架构概览

```
~/monitor-suite/              # 源码 + 部署目录（/root/monitor-suite/）
├── fourmeme-monitor/         # Four.meme 全面监控
│   ├── monitor.mjs           #   Four.meme 多模块监控（OpenFour/底池/前端/API/GitHub/合约/链上参数）
│   ├── feishu-bot.mjs        #   飞书 Bot（群聊指令交互 + 卡片回调）
│   └── package.json
├── flap-monitor/             # Flap.sh 页面监控
│   ├── monitor.mjs           #   前端/API/i18n/路由监控
│   └── package.json
├── shared/                   # 共享模块
│   ├── feishu-client.mjs     #   飞书 SDK 统一消息通道（手动 token 管理）
│   └── ai-client.mjs        #   多模型 AI 客户端（热切换）
├── ai-models.json            # AI 模型配置（10+ 模型）
├── install.sh                # 一键部署脚本
├── .env.example              # 环境变量模板
├── .env                      # 实际环境变量（需手动创建，不提交）
└── package.json              # 根依赖（飞书 SDK）

部署模式（install.sh 自动检测）：
- 统一部署：源码目录即 /root/monitor-suite/ 时，PM2 直接从子目录启动，不复制文件
- 独立部署：从其他位置运行时，复制到 ~/fourmeme-monitor/ 和 ~/flap-monitor/
```

## 核心功能

### Four.meme 监控 (`fourmeme-monitor/monitor.mjs`)

| 模块 | 监控内容 | 频率 |
|------|---------|------|
| 模块 1 | 底池配置（Pool Config） | 3s |
| 模块 2 | 前端代码（基础页面 + 自动发现页面，含文案 diff、`__NEXT_DATA__`、i18n、路由/端点发现，同轮相同 JS/CSS 资源变更合并推送） | 15s |
| 模块 3 | API 结构（多端点并行，结构 + 值 diff，覆盖 public/blog/mapi 端点发现） | 30s |
| 模块 4 | OpenFour 业务模板（新模板上线、模板状态变化，如 `PUBLISHED`） | 3s |
| 模块 4b | OpenFour Registry 新模块发现（链上 logs 触发，发现新的 module/token implementation 地址） | 实时触发 |
| 模块 5 | GitHub 仓库/项目变更（主仓库提交高频轮询，账号仓库列表降频检查） | 有 token 30s / 无 token 90s |
| 模块 6 | BSC 智能合约（静态核心合约 + OpenFour 链上发现，`/v1/public/address` 作为种子/兜底，RPC batch） | 3s |
| 模块 7 | 链上参数（RPC batch） | 3s |
| 模块 8 | 合约创建者动作（合约地址页读取 + RPC 近期反查兜底，自动缓存 deployer，只监听 deployer/手动配置地址作为 `tx.from` 发起的交易，命中后立即复查合约） | 3s |

### Flap.sh 监控 (`flap-monitor/monitor.mjs`)

- 页面并行抓取（含错开延迟避免风控）
- i18n chunk 并行下载与 diff
- 前端路由发现 + API 结构监控

### Four.meme 前端/API 覆盖策略

- 基础监控页面：`/zh-TW/create-token`、`/zh-TW/agentic`、`/zh-TW/announcement`、`/zh-TW/contract*`、`/en/contract*`
- 自动从 HTML、`__NEXT_DATA__`、JS 资源字符串中发现新页面，并在同一轮纳入监控
- 首页、语言根路径、ranking 页面和动态项目页（如 `/`、`/en`、`/zh-TW`、`/en/ranking`、`/zh-TW/ranking`、`/token/0x...`、`/presale/数字`、`/competition/项目ID`）不纳入页面发现，避免新增代币/预售/竞赛项目刷屏
- 路由/端点发现覆盖 `/api/`、`/meme-api/`、`/mapi/`、`/v1/`、`/blog/v1/` 和站内完整 URL
- 纯资源列表小抖动会在同一轮 2.5 秒后快速复抓确认；真实变化立即推送，短暂恢复则静默忽略
- API 探针只覆盖无需登录且稳定返回 JSON 的公开端点：public 配置、地址、文件 host、KOL、token ranking/search；公告/Blog 变化由前端页面监控覆盖，登录/签名/创建类 private 接口不做结构监控
- 链上创建者动作监听只过滤合约 deployer/手动配置地址作为 `tx.from` 发起的交易，不监听普通用户对工厂合约的创建代币调用；动作检测默认启用 WebSocket 新区块订阅（`BSC_WS_URLS` / `FOURMEME_ACTOR_WS_ENABLED=true`），收到 `newHeads` 后立即处理已确认区块，HTTP 扫描继续作为断线、漏事件和追赶兜底（`FOURMEME_ACTOR_HTTP_FALLBACK_MS`，默认 10s）。扫链优先于创建者补全，默认 1 个确认块、每批 80 块，落后时同轮最多追 800 块，命中动作当批立即推送；追块进度日志默认每 5 分钟或每减少 5000 块输出一次，避免刷屏。默认从 BscScan 合约地址页读取 `Contract Creator` 并缓存 deployer（`FOURMEME_CREATOR_PAGE_LOOKUP=true`，默认每轮最多补 2 个，避免阻塞实时扫链）。如果页面抓取被封，新合约会用 BSC RPC 在近期区块中反查创建交易兜底（`FOURMEME_CREATOR_CHAIN_LOOKUP=true`，默认回看约 24 小时）。历史 deployer 无法通过普通 RPC 无限期反查，`FOURMEME_WATCH_CREATORS` 仅作为手动补充；如页面抓取被封且 API key 支持 BSC `getcontractcreation`，可设置 `FOURMEME_CREATOR_LOOKUP=true` 并配置 `ETHERSCAN_V2_API_KEY` / `ETHERSCAN_API_KEY` 作为备用，失败会冷却重试避免刷日志；旧变量 `BSCSCAN_API_KEY` 仍兼容。

### 飞书 Bot (`fourmeme-monitor/feishu-bot.mjs`)

- WebSocket 长连接（无需公网 IP，无需配置事件订阅）
- 群聊指令交互（查看状态、切换 AI 模型、手动触发检测等）
- 远程 Shell 执行（含危险命令拦截）
- 每日报告（可选）

### AI 变更摘要 (`shared/ai-client.mjs`)

支持 10+ AI 模型的热切换，对检测到的变更自动生成中文摘要：

- **豆包** Pro / Lite
- **DeepSeek** V3 / R1
- **通义千问** Plus / Turbo
- **智谱 GLM-4** Plus
- **GPT-4o** / GPT-4o Mini
- **Claude Sonnet**

通过 `ai-models.json` 配置，支持 `ENV:VAR_NAME` 语法从环境变量解析 API Key，运行时可通过飞书 Bot 指令热切换模型。

### 飞书消息通道 (`shared/feishu-client.mjs`)

所有消息统一通过飞书官方 SDK (`@larksuiteoapi/node-sdk`) 的 `client.im.message.create()` 发送：

- 卡片消息 / 文本消息 / 文件消息
- 消息回复 / 卡片编辑（更新 AI 摘要）/ 消息置顶
- 内置 QPS 节流器（4 QPS，预留余量；飞书限 5 QPS/群）
- 队列机制（最大 100 条）+ 可选低优先级心跳

## 反风控策略

- UA 轮换（多浏览器 User-Agent 池）
- Per-domain 自适应退避
- 请求抖动（随机延迟）
- GitHub 认证请求 + 提交/账号列表分频轮询

## 部署

### 环境要求

- Ubuntu 20.04+ / Debian 11+
- Node.js 20+
- PM2（进程管理）

### 安装步骤

```bash
# 1. 克隆仓库到 /root/monitor-suite
cd ~ && git clone https://github.com/mapalubnb/monitor-suite.git
cd ~/monitor-suite

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env 填入飞书应用凭证、AI API Key 等
nano .env

# 3. 一键部署
sudo bash install.sh
```

`install.sh` 会自动完成：
- 检查并安装 Node.js 20.x 和 PM2
- 自动检测部署模式（统一部署 vs 独立部署）
- 自动补齐 `.env.example` 中新增但现有 `.env` 缺失的配置项（不覆盖已有密钥）
- 统一部署模式：PM2 直接从 `/root/monitor-suite/` 子目录启动
- 独立部署模式：复制到 `/root/fourmeme-monitor/` 和 `/root/flap-monitor/`
- 创建共享目录的符号链接（`../shared/` → `/root/monitor-suite/shared/`）
- 安装依赖并通过 PM2 启动服务
- 安装 20+ 快捷命令到 `/usr/local/bin/`（自动兼容两种部署路径）

### 卸载

```bash
# 停止并删除 PM2 进程
pm2 delete fourmeme-monitor 2>/dev/null
pm2 delete flap-monitor 2>/dev/null
pm2 delete feishu-bot 2>/dev/null
pm2 save

# 删除独立部署目录（如存在）
rm -rf ~/fourmeme-monitor ~/flap-monitor

# 删除快捷命令
rm -f /usr/local/bin/fm-* /usr/local/bin/fl-* /usr/local/bin/bot-* /usr/local/bin/mon-* /usr/local/bin/_pm2-proc-info

# 如需完全清除，删除源码目录
# rm -rf ~/monitor-suite
```

### 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `FEISHU_APP_ID` | 是 | 飞书自建应用 App ID |
| `FEISHU_APP_SECRET` | 是 | 飞书自建应用 App Secret |
| `FEISHU_CHAT_ID` | 是 | 目标群聊 Chat ID |
| `FEISHU_CARD_CHUNK_LIMIT` | 否 | 飞书卡片分片长度，默认 3500；超长卡片会分多张发送，不截断 |
| `FEISHU_TEXT_CHUNK_LIMIT` | 否 | 飞书文本分片长度，默认 3500；超长文本会分多条发送，不截断 |
| `FEISHU_BOT_EXEC_MAX_BUFFER` | 否 | 飞书 Bot 执行命令输出缓冲，默认 16777216（16MB） |
| `DOUBAO_API_KEY` | 否 | 豆包 API Key |
| `DEEPSEEK_API_KEY` | 否 | DeepSeek API Key |
| `OPENFOUR_TEMPLATE_INTERVAL_SECONDS` | 否 | OpenFour 业务模板监控间隔，默认/最低 3 秒 |
| `OPENFOUR_REGISTRY_LOG_MONITOR` | 否 | 是否启用 OpenFourRegistry 链上日志监听，默认 `true` |
| `OPENFOUR_REGISTRY_DISCOVERY_DEBOUNCE_MS` | 否 | Registry logs 触发新模块发现的合并延迟，默认 3000ms |
| `GITHUB_TOKEN` | 否 | GitHub Token（提升 rate limit）|
| `GITHUB_INTERVAL_SECONDS` | 否 | GitHub 主仓库提交监控间隔；默认有 token 30 秒、无 token 90 秒，低于安全下限会自动抬高 |
| `GITHUB_REPO_LIST_INTERVAL_SECONDS` | 否 | GitHub 账号仓库列表监控间隔，默认/最低 300 秒 |
| `HEARTBEAT_ENABLED` | 否 | 是否启用心跳推送，默认 `false` |
| `HEARTBEAT_MINUTES` | 否 | 心跳间隔，默认 240 分钟；仅在 `HEARTBEAT_ENABLED=true` 时生效 |
| `DAILY_REPORT` | 否 | 是否启用每日报告，默认 `false` |

完整变量列表见 `.env.example`。

### PM2 管理

```bash
pm2 status                    # 查看服务状态
pm2 logs fourmeme-monitor     # 查看日志
pm2 restart all               # 重启所有服务
kill -USR1 <PID>              # 手动触发一次全量检测
```

### 更新代码

```bash
cd ~/monitor-suite && git pull
sudo bash install.sh
```

## 飞书应用配置

1. 在 [飞书开放平台](https://open.feishu.cn/) 创建自建应用
2. 开启 **机器人** 能力
3. 添加权限：`im:message`（发送消息）、`im:message:send_as_bot`、`im:resource`（上传文件）
4. 将应用添加到目标群聊
5. 获取群聊的 `chat_id`，填入 `.env`

## 快捷命令

安装后可在任何 shell（包括飞书 Bot）中使用：

| 命令 | 说明 |
|------|------|
| `mon-status` | 所有进程 + 数据摘要 + 磁盘占用 |
| `mon-log [N]` | 所有进程日志（默认 80 行，倒序） |
| `mon-restart` | 重启全部进程 |
| `mon-stop` | 停止全部进程 |
| `mon-ai` | 查看/切换 AI 模型 |
| `mon-help` | 显示所有快捷命令 |
| `fm-status` | Four.meme 进程 + OpenFour/底池/前端/API/GitHub/合约/链上/创建者数据摘要 |
| `fm-log [N]` | 日志（默认 80 行，倒序） |
| `fm-restart` | 重启 |
| `fm-check` | SIGUSR1 触发全量检测 |
| `fm-daily` | 日报开关（on/off/on 20） |
| `fm-heartbeat` | 心跳推送开关/间隔设置（off/on/分钟数） |
| `fl-status` | Flap.sh 进程 + 页面/资源/i18n 摘要 |
| `fl-log [N]` | 日志 |
| `fl-restart` | 重启 |
| `fl-check` | SIGUSR1 触发检测 |
| `bot-status` | 飞书 Bot 进程状态 |
| `bot-log [N]` | Bot 日志 |
| `bot-restart` | 重启 Bot |

## 信号

| 信号 | 作用 |
|------|------|
| `SIGUSR1` | 立即触发一次全量检测 |
| `SIGINT` / `SIGTERM` | 优雅关闭（等待消息队列排空） |

## License

Private
