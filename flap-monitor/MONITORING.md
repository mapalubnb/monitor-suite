# Flap 底池提前监控（1.4.0）

## 免费加速升级

| 通道 | 当前行为 |
|---|---|
| WSS 快速回执 | 收到相关日志后优先拉取该交易回执，达到确认高度并核对区块 hash 后处理；不等待整轮日志扫描。 |
| 新区块 | `newHeads` 触发快速信号确认复核及金库注册扫描；多个节点相同区块通知去重。普通 BNB 直接转账仍由完整区块 HTTP 扫描补齐。 |
| 动态订阅 | 新候选资产／池出现时更新过滤器，只替换发生变化的订阅；全局无关建池日志不占用快速回执队列。 |
| HTTP 补扫 | 保留独立 1 秒目标调度；日志查询最多三路并发，每轮全部成功才推进游标。断线重连立即唤醒补扫。 |
| 外部数据 | CoW、资产、仓位、余额、地址发现五个独立任务。前四个默认 10 秒目标调度；地址发现每分钟检查是否到期，正常成功后 24 小时刷新。 |
| 资产优先级 | 快速回执涉及的候选资产及补扫新发现资产优先复核 getter，每批最多十个，仍遵守来源失败退避。 |
| 金库注册 | 独立 1 秒目标调度与 WSS 唤醒，不再等待网页下载；仍等待五个确认块，发送成功才推进游标。 |
| 页面 | ETag 优先、Last-Modified 备用，304 复用正文；地区限制／错误页不进入响应缓存。服务器不支持条件请求时仍正常下载。 |

单任务不并发重入，运行中的触发合并为下一轮；发送队列与扫描分离。快速回执每批最多二十笔，内存提示队列最多一千笔，超出部分由 HTTP 游标补扫。提前信号默认一个确认块，Factory 零额外确认块，均未降低。Safe 提案仍为 5／10 秒 API 轮询，没有接入付费 Webhook。

快速信号额外保存尚未由 HTTP 覆盖的区块 hash（最多 128 个），定期校验及重组撤回。流动性状态按链上区块和日志顺序判断，避免较旧补扫覆盖较新快速信号；HTTP 游标不由快速通道推进。延迟取决于节点、API 和飞书，未承诺固定送达时限。官网 403 和客户端分页覆盖限制仍适用。

## 2026-09-25 核对与修复

已核对 BNB Portal 实际版本 v5.24.0，以及 wPOPMTx 配置 `[1,89,89,7,0]`、创建未暂停。官方部署文档仍标注 v5.23.1，版本判断以链上 getter 为准。详见 [代码与官网核对记录](AUDIT-2026-09-25.md)。

页面资源下载不完整、页面／金库消息发送失败时保留旧基线；Safe 与合约通知队列不再按旧容量静默截断。合约通知每批最多八条。CoW 订单过期和再次开放均跟踪。无关 DEX 池仅保留最近最多 512 个发现记录，不进入持续流动性查询；500 个候选资产达到上限后保留新事件并记录容量异常，不阻塞其他扫描。

页面监控抓取公开 HTML 和静态资源，不自动操作 Chrome。Chrome 插件本次用于人工核对：BNB CAStore 存在客户端分页，第二页不会改变 URL；现有 HTML 监控不保证第二页全部描述覆盖。创建页可能继承浏览器链选择，URL 的 `chain=bnb` 不是链状态证明。本机 Node 抓取收到地区限制 403，需在实际部署出口检查页面可用性；失败样本不会覆盖基线。

## 底池候选筛选

公共 DEX 建池或加池仅跟踪已有候选资产，不把配对代币自动纳入候选；已确认开放资产的普通公共配对不推送提前信号。关联钱包主动交易或转出、采购与 Safe 配置仍提供独立线索，单纯向执行钱包转入代币不构成官方建池证据。升级时清理旧版本无法核验来源的建池／流动性提示及仅由配对扩散产生的候选，保留独立资金、采购、包装和提案记录。

## 推送含义

| 状态 | 证据 |
|---|---|
| 观察线索 | 收款、授权、LP 仓位转移；不判断开放意图 |
| 疑似备货 | 公开采购订单，或包装事件并通过 `asset()` 核验原始资产 |
| 底池已有流动性，开放未确认 | 已核验 DEX 池子的正向流动性事件 |
| 已提议开放 | Safe 明确启用计价代币／解除创建暂停；仅设置兑换路径不足以判定 |
| 签名满足，执行条件待核实 | 达到签名阈值；可能仍有前序 nonce、时间锁或其他条件 |
| 当前执行模拟通过 | nonce 可用且 `eth_call` 模拟 Safe 执行返回成功；不广播，不保证未来执行成功 |
| 链上支持创建 | Factory 配置启用且创建开关未暂停；不保证价格、交易深度或任何交易必然成功 |

同一资产按时间线聚合，一张卡片最多八条变化，长卡由现有飞书组件分段。来源时间、首次观测时间、链上区块分别保存；API 的历史创建时间不等于监控实际发现时间。发送成功才确认队列，失败保留待发送记录。

## 默认地址

| Safe | 历史行为用途 |
|---|---|
| `0xc68f29BfE2f6c3D95AdB5685592B9F86680968f2` | 计价代币配置 |
| `0xA04Aa4575bA2327D28869cdD5F0E9165a8EC2CF5` | 业务／Vault Factory |
| `0xCD561eB3828232d3eC174Fb5e321586209FBF535` | 运营资金与采购预签名 |
| `0x8a08D98CBB218fceB318Ecf3aBc1BA43D8A7aB0E` | 归集与授权 |
| `0xF5b72a706fE0c5B2D4f52238BfCe5cF7F068C9eE` | 储备资金与额度授权 |
| `0x1f96BC88f0794060433Be5F3EC9159a9C4f08A3b` | Portal／VaultPortal 升级 |
| `0x670FEDB797694432f81576222e816EA2C45aF044` | LP 仓位与资金分配 |
| `0x903787b6f03C5c09A335EDD235b0870609ADC7fB` | 额度委托执行 |

执行钱包：`0x81459cD6b1bdf55D01A824350A79a0c201530992`。

额度模块：`0xCFbFaC74C26F8647cBDb8c5caf80BB5b32E43134`。另外三个历史辅助 Safe 的链上收支也纳入观察，见 `early-signal-catalog.mjs`。角色标签来自公开行为，并非法律身份认证。

每日刷新已知 Safe 的 owner、threshold、modules、guard，并按 owner 反查其他 Safe。共同签名人、新收款者、链上授权接收者进入候选名单，不自动添加进高优先监控或授予“官方”标签。核验后通过配置加入，避免相似地址与共享 owner 投毒。

## 覆盖与边界

- **Safe**：现有计价配置、路径、创建开关、Vault Factory 注册保留；新增 ERC20 转账/授权、三种已验证仓位管理器的 NFT 转移、CoW 订单预签名、代理升级、角色与模块操作。已知 MultiSend、已知 Safe 递归展开，最大四层；其他调用保留目标、选择器与完整 calldata。
- **签名模拟**：仅支持普通 EOA 的 65 字节 EIP-712／eth_sign 签名；合约签名、预批准 hash、RPC 不支持时保持“未核实”。签名本身不写入状态文件，不发送链上交易。
- **CoW**：按八个核心 Safe 与执行钱包读取公开订单，覆盖买入/卖出资产、状态、有效期和成交变化；订单撤销／过期会降低预期。初次不补发历史完成订单；开放订单仍提示一次。每 owner 最多十页，超过上限明确报错，不以缺失推断取消。私有订单不能保证提前看到。
- **资产与 BNB**：按钱包过滤 ERC20/ERC721 Transfer 与 Approval，解码关联交易完整回执。直接 BNB 交易从完整区块过滤；SafeReceived 和执行／运营资金钱包的余额净变化补充内部资金线索；手续费归集 Safe 的普通外部入账不触发备货提醒。余额包含 Gas、多个收支抵消，不能替代内部调用 trace；没有宣称逐笔覆盖所有内部 BNB 转账。
- **包装**：ERC4626 Deposit/Withdraw 结合 `asset()` 映射；仅 mint 事件不证明跨链。非 ERC4626 或 getter 不支持时保留原始线索，不猜测桥接来源。
- **DEX**：Pancake V2/V3 使用官方 Factory 创建事件与池注册 getter 核验；V4、Pancake Infinity CL/Bin 使用官方 Manager 和 poolId。建池与加池分开；减仓会降低“准备”判断。池在监控开始前已创建时，V2/V3 通过 getter 补齐；历史 V4/Infinity 池若缺少初始化映射，保留 poolId 原始操作提示，不虚构资产。V3 LP NFT 可补齐 token0/token1/fee，其他仓位仅在有已验证映射时解释。
- **模块**：监听 Safe 的模块执行成功/失败、模块增删、所有者及阈值变化；低流量额度模块日志按相关 Safe 地址过滤，未知事件原值保留。未知新模块会被元数据变化发现，未核验 ABI 不强行解释。
- **权限与配置**：原合约完整性模块继续监控，补入已验证 ProxyAdmin。Factory 是最终确认源。跨链其他 Safe、桥消息配对仍不在本次 BSC 自动确认范围内。

## 运行与配置

| 配置 | 默认 | 用途 |
|---|---|---|
| `FLAP_SAFE_PROPOSAL_INTERVAL_MS` | 10000 | Safe 空闲轮询 |
| `FLAP_SAFE_PROPOSAL_ACTIVE_INTERVAL_MS` | 5000 | 活跃提案轮询 |
| `FLAP_SAFE_INCLUDE_CORE` | true | 自动合并八个核心地址；兼容旧 `.env` 两地址列表 |
| `FLAP_EARLY_SIGNAL_MONITOR` | true | 提前信号总开关 |
| `FLAP_EARLY_INTERVAL_MS` | 1000 | HTTP 补扫与快速通道重试目标间隔，扣除本轮耗时 |
| `FLAP_EARLY_COW_INTERVAL_MS` | 10000 | CoW 独立轮询目标间隔，实际受请求耗时／配额影响 |
| `FLAP_REGISTRY_INTERVAL_MS` | 1000 | 金库注册独立 HTTP 轮询目标间隔 |
| `FLAP_REGISTRY_WS_ENABLED` | true | 金库注册／区块订阅；也受 Factory WSS 总开关约束 |
| `FLAP_EARLY_DISCOVERY_INTERVAL_MS` | 86400000 | Safe 地址关系刷新 |
| `FLAP_EARLY_MAX_BLOCKS` | 20 | 单次追赶窗口 |
| `FLAP_EARLY_CONFIRMATIONS` | 1 | 提前信号确认块数；Factory 原实时设置不变 |
| `FLAP_EARLY_NATIVE_TX_SCAN` | true | 直接 BNB 交易扫描；完整区块读取会增加流量 |
| `FLAP_EARLY_WS_ENABLED` | true | 动态钱包／池订阅、快速回执与新区块确认触发 |
| `FLAP_EARLY_WALLETS` | 已核验执行钱包 | 额外执行钱包列表，逗号分隔 |
| `FLAP_COW_API_BASE_URL` | CoW BNB API | 公开订单服务 |

已有 `.env` 中显式填写的 120000/30000 间隔不会被代码覆盖；需要改成上述间隔才能提高旧部署频率。请按 Safe API 配额配置 `FLAP_SAFE_API_KEY`，公共 RPC 需支持按 topics 查询日志和完整区块。BNB 官方 dataseed 禁用 `eth_getLogs`，不能作为唯一日志节点；项目默认多 RPC 会自动切换。

WSS 快速通道与 HTTP 游标补扫互补，同一回执用日志标识去重。每轮完整窗口校验后提交，失败不越过游标。游标块 hash 改变时回退 128 块，清理关联本地信号，发出重组更正，再重扫；快速通道尚未被补扫覆盖的区块另行校验。超过保留范围的深重组需要人工回溯；低确认数信号不是最终性承诺。

状态文件：`early-signal-state.json`，独立原子写入、启动加载校验、事件剪枝；积压达到上限停止推进并显示异常，不静默丢通知。`fl-status` 展示游标、最新区块、候选资产、待发送数量和分来源退避状态。状态异常请先备份排查，不要直接删除文件。

## 验证与部署

本次加速升级通过 260 项全量回归、语法检查和差异格式检查。2026-09-25 本机 15 秒只读 WSS 检查中，`bsc-rpc.publicnode.com` 返回 `newHeads`（区块 123884780），另一默认节点未在该窗口返回区块。该检查证明订阅可用，不代表长期节点稳定性或生产推送延迟；保留多节点与 HTTP 兜底。

运行 `npm run check`、`npm test`。`fixtures/early-signal-history.json` 保存 2026-09-25 公开 wPOPMTx 加池/包装回执、CoW 订单及 LP/额度提案，不包含 Safe 签名。

安装脚本会复制全部新模块，保留旧状态文件。部署须更新整个项目，确认 `.env` 的间隔和 RPC 配额后，运行原有安装/更新流程并重启 `flap-monitor`；本地测试通过不代表服务器进程已经使用新版。

协议依据：[Safe Modules](https://docs.safe.global/advanced/smart-account-modules)、[CoW Order API](https://api.cow.fi/docs/)、[Pancake Infinity 部署](https://developer.pancakeswap.finance/contracts/infinity/resources/addresses)、[Uniswap V4 部署](https://developers.uniswap.org/docs/protocols/v4/deployments)、[Flap 官方部署](https://docs.flap.sh/flap/developers/deployed-contract-addresses)。
