# Monitor Suite 📡

用于监控 **Four.meme** 与 **Flap.sh** 的自动化工具。发现页面、接口、合约、链上资产或 GitHub 变化后，通过飞书群及时推送。

## ✨ 主要功能

- **Four.meme**：底池、前端页面、公开 API、OpenFour 模板、GitHub、合约及链上参数。
- **Flap.sh**：BNB CAStore、Robinhood CAStore、metadata schema、Vault Portal、Vault Factory、SwapRegistry、核心代理升级、Factory 底池状态，以及 Safe 提案、采购订单、资金、包装资产、LP 仓位与流动性提前信号。
- **飞书卡片**：规则结果优先发送，AI 摘要异步补充；长文案、URL、地址和交易哈希完整保留。
- **稳定低延迟**：支持 PM2、动态 RPC 竞速、短超时切换、断点补扫和去重；Factory 名称与飞书发送不阻塞后续扫描。
- **前端增量抓取**：FourMeme 保留真实 `dpl` 部署 URL，同路径部署参数变化直接迁移缓存，只下载新增或路径变化的资源；部分失败会在下轮只补抓失败项。
- **前端抗风控**：同一进程使用稳定浏览器标识，脚本和样式请求携带正确的资源类型与页面来源；同域请求只错开启动时间，慢响应不会串行阻塞页面和 API 监控。
- **Factory 防漏检**：新候选先保存再复核，getter 暂时失败会持续重试；RPC 空日志需双节点确认，避免错误推进游标。
- **低资源运行**：不使用 `newHeads`，不枚举未知 mapping；精准事件配合状态复核。提前监控默认读取短窗口完整区块，过滤关联钱包的直接 BNB 交易，可用 `FLAP_EARLY_NATIVE_TX_SCAN=false` 关闭。

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
| Flap.sh | 页面与 Vault Portal 注册事件 | 页面 1 秒；注册事件沿用现有低频确认扫描 |
| Flap.sh | Factory 底池新增、修改、暂停、恢复与停用快通道 | WSS 实时，HTTP 1 秒兜底，不等待确认块 |
| Flap.sh | Factory 断点补扫 | 后台运行，自动找回停机或 RPC 故障期间的变化 |
| Flap.sh | Factory 已知资产复核 | 后台轮转，补充发现 getter 状态变化 |
| Flap.sh | 管理 Safe 计价代币及 Vault Factory 管理提案 | 默认 10 秒，活跃提案 5 秒；按链上 nonce 过滤并独立退避 |
| Flap.sh | Factory / SwapRegistry / Vault Portal 核心完整性 | 精准地址 WSS；HTTP 批量校验 10 秒兜底 |
| Flap.sh | Vault Factory 与已知资产黑名单/信任状态 | 60 秒轮转 |
| Flap.sh | bytecode hash 与函数选择器审计 | 10 分钟 |
| Flap.sh | 前端 metadata schema | 仅静态资源变化时解析 |

前端页面或 API 遇到 `403`、`429`、Cloudflare 或网络异常时会自动退避和重试。静态资源按 URL 独立执行 `30 秒 → 60 秒 → 120 秒 → 5 分钟` 退避，成功后立即恢复；HTML 仍按 7 秒频率检测。只有当前资源全部就绪后才更新正式快照，不会把半包或请求失败误判为业务变更。

## ⏱️ 调整频率

- Four.meme 前端最低 `5` 秒，API 最低 `8` 秒，其余高频模块最低 `1` 秒。
- Four.meme HTTP 链上读取默认使用 bloXroute、48Club、Alchemy Public 和 PublicNode 四个独立节点；按并发负载、失败次数、实时延迟和退避状态自动轮转，不固定单一主节点。
- 同一时刻完全相同的 RPC 请求会共享一次网络结果；单节点 `403/429` 只隔离该节点，其他健康节点继续工作，所有节点均退避时快速结束本轮，避免形成请求风暴。
- 可通过 `FOURMEME_BSC_RPC_URLS` 覆盖默认节点列表，不会改变任何监控间隔。
- Four.meme 合约监控使用 `eth_getStorageAt + eth_getCode` 批量读取并在本地计算代码哈希，不依赖公共节点兼容性较差的 `eth_getProof`。
- Flap 轮询最低 `500ms`。
- Flap Factory 实时扫描使用固定 1 秒节拍和 0 确认块；RPC 自动选择低延迟健康节点，断点补扫与资产复核在后台轮转并主动让路。
- Factory 默认并行订阅 `wss://bsc-rpc.publicnode.com` 与 `wss://bsc.publicnode.com`。WSS 收到官方配置或开放状态事件后立即持久化候选，再复核 Factory getter 并读取 ERC20 `name/symbol/decimals`。
- WSS 建立后只回扫最近 `10000` 个区块，范围可通过 `FLAP_FACTORY_WS_BACKFILL_BLOCKS` 调整为 `5000～20000`；默认按 `2000` 块分段并在 RPC 限制时自动缩小，事件使用 `transactionHash + logIndex` 持久化去重，重启和双节点投递不会重复入库。
- WSS 节点的连接、订阅、断线、重连、最后事件和短窗口回扫状态会持久化；启动卡片与 `fl-status` 同步显示实时通道、HTTP 兜底及回扫健康状态。
- WSS 仅更新候选库、输出日志并复用现有飞书通知，不签名、不发送交易，也不改变任何自动发射逻辑。
- Factory 实时、断点补扫和资产复核可以并行请求，扫描结果、游标、状态文件和通知队列按单写顺序合并，不会互相覆盖。
- Factory 不再从部署区块开始扫描完整历史。更新部署前已经存在、但当前 15 个基线资产之外的旧资产不会自动回溯；更新后的新事件和停机缺口仍会及时发现。
- Safe 提案预警默认监控八个已核验核心/核心关联 Safe（旧配置的两个地址自动合并），新增资金、授权、LP NFT、CoW 预签名与额度模块操作；，解析发往 Factory 的计价币配置（`0x23d89f95`）、兑换路径（`0x659e381f`）及创建暂停/恢复开关，以及发往 Vault Portal 的 Vault Factory 注册／配置更新。支持已验证 MultiSend 地址的递归批量调用，同一提案同一代币合并展示，保留内部调用顺序；未知 Factory 调用会提示选择器，不静默丢弃。首次运行提示仍待执行的提案一次，不补发已执行历史。
- Safe API 查询使用链上 `nonce()` 作为下限并跟随分页，自动排除废弃历史提案。首次发现提示管理提案，签名满足提示“等待执行”，不推断已经开放。nonce 前进后按 `safeTxHash` 查执行详情；仅在确有同 nonce 执行记录时区分成功、内层失败和被替换，索引尚未同步时保留“执行结果待确认”。执行成功后复核配置 getter，当前状态不同不会被误判为该提案执行失败。
- Safe 提案监控使用 `FLAP_SAFE_API_KEY` Bearer 认证；默认每 10 秒查询，发现待执行提案后自动切换为 5 秒。Safe 模块本身不订阅新区块，也不签名或广播交易；普通 EOA 签名齐备且 nonce 可用时执行只读模拟；API 遇到 `429`、超时或网络失败时按 Safe 独立退避，429 最大退避 30 分钟并错开请求，不阻塞现有页面和链上监控。限流期间保留最后成功快照，并在状态卡片标明缓存状态与下次重试时间。
- Factory 的升级/权限关键事件合并到原有 WSS 订阅；内置 SwapRegistry、Vault Portal 与链上验证过的 Vault Factory 使用相同 WSS 节点做精准地址订阅，不增加新区块订阅。
- 前端资源提取到的合约地址只作为候选记录，不能直接进入 WSS；普通 Transfer、Deposit 等未知事件不会生成完整性告警。
- 核心代理 implementation/admin/beacon 槽与关键 getter 默认每 10 秒合并成批量 RPC；已知底池资产的 `isSpammerBlocked`、`isBlacklisted`、信任等级和计价币许可按 60 秒轮转。
- bytecode 只在首次发现、实现地址变化或 10 分钟审计时读取，不会每轮重复下载。
- 前端静态资源只保存 metadata 字段顺序、指纹和明确的合约地址提示，不保存原始 JS；旧快照升级时仅重建一次基线，不产生误报。
- 在不读取完整区块且不枚举未知 key 的约束下，无事件、目标地址也未知的私有 mapping 写入无法被链上监控发现；一旦地址进入 Factory 资产、Vault Factory 或前端配置目录，后续状态变化会进入轮转校验。
- 频率变量均在 [.env.example](./.env.example) 中有说明；修改 `.env` 后执行 `mon-restart`。
- 遇到源站风控时，优先适当增加间隔或将前端并发从 `6` 降到 `4`。

## 📨 飞书输出

- 变更会先发送规则化结果，AI 分析完成后再更新原卡片。
- 文案、i18n、URL、地址和交易哈希不会截断；超长内容自动拆分为连续卡片。
- 普通卡片不显示操作按钮，仅在存在完整 DIFF 文件时显示下载按钮。
- Factory 底池使用“支持创建 / 暂停创建 / 已停用”三种状态；卡片显示变更数量、名称或符号、状态和完整可点击地址。
- 原需要置顶的 Flap 重点告警改为在首张卡片中提醒 `FEISHU_MENTION_OPEN_ID`；长卡片后续分片不重复提醒，留空则正常发送但不 @。
- BNB 自定义金库链接统一使用 `vaultfactory=<地址>&chain=bnb&lang=zh`，Robinhood 使用对应的 `chain=robinhood` 参数。
- 启动卡片与状态卡片显示 Factory WSS 订阅数、最后订阅/事件时间、短窗口回扫结果及 HTTP 扫描进度，不显示交易和内部配置字段。

## 本次更新：1.4.0 / Flap 1.3.0

- Safe 监控扩展至八个核心地址，新增资金、授权、LP 仓位、CoW 预签名、额度模块及升级权限解析，支持已知 Safe 的嵌套调用；未知操作保留原始 calldata。签名进度、前序 nonce 阻塞和只读执行模拟分开展示。
- 新增独立的 BSC 提前信号模块：采购订单、关联资产收支、包装资产映射、V2/V3/V4/Infinity 建池及流动性变化、模块执行、直接 BNB 转账与余额净变动、每日关联 Safe 发现。候选地址不自动标为官方。
- API 与链上扫描独立运行，WSS 唤醒 HTTP 扫描，持久化游标并支持断线补扫、重组更正、通知失败保留和分来源退避。首次不补发历史成交和链上动作，仍提示有效待执行订单和 Safe 提案。
- 新增 `early-signal-state.json`；Safe schema 4 保留旧状态。安装脚本、启动卡、`fl-status` 同步升级。完整范围、配置和边界见 [提前监控说明](flap-monitor/MONITORING.md)。
- 检测均为只读；包装/加池不等于确定开放，公开提案也不保证执行。跨链未核验地址仍属于后续调查范围。

## 上次更新：1.3.36 / Flap 1.2.28

- Safe 提前监控新增 Vault Factory 注册／配置更新，兼容四参数 `0x4809625b` 与五参数 `0xefa7595a`，展示启用、官方标识、风险等级和分类；按目标工厂分别跟踪签名和执行结果，四参数版本不推断分类。

- 新增 Safe 计价代币配置、兑换路径、暂停/恢复提案预警，修复 aWDH 一类“配置 + 路径”批量提案未被识别的问题。
- Factory WSS、HTTP 实时扫描与补扫新增路径事件，单独修改或清空路径也会通知；路径按区块和日志位置合并，避免旧结果覆盖新路径。
- Safe 状态升级为 schema 3，Factory 状态升级为 schema 12，自动保留旧基线和待发送记录。无需删除状态文件；部署时需同时更新所有 Flap 模块（安装脚本已包含新增 codec）。
- 路径编码通过区块 123583333 的真实 calldata 与事件交叉验证。当前支持每跳六个 ABI word 的布局，保留第六个扩展字段原值；新版完整 ABI 尚未取得，不擅自命名扩展字段或兑换类型 7。遇到不兼容布局会明确报解析异常，不写入错误路径。
- 新代币先发送完整地址，再异步补充名称。签名满足不保证执行时间；未公开到 Safe Transaction Service 的提案无法提前获取。
- 回归样本位于 `flap-monitor/fixtures/safe-awdh-proposal.json`，只含公开提案字段和链上日志，不含签名。

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
- Factory 实时通道异常：检查 `fl-status` 的 WSS 已订阅数量；单节点断线会显示“部分可用”，全部断线会显示“需要关注”。短窗口回扫失败会单独显示，不与 WSS 连接错误混淆。
- Factory 显示候选复核失败：候选地址和交易证据已保留，实时轮询会自动重试；检查 RPC getter 可用性即可。
- 合约完整性异常：检查 `fl-status` 的合约目录、精准地址 WSS、核心校验、扩展轮转与代码审计时间；发送失败的变更会保留在 `contract-integrity-state.json`。
- Safe 提案预警异常：检查 `fl-status` 的 Safe nonce、基线和最近错误；发送失败的预警会保留在 `safe-proposal-state.json`，Safe API 限流会自动恢复，执行详情查询也遵循退避。

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
