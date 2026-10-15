# Flap 监控交接

归属：`02｜Flap 监控`。先读根 [AGENTS.md](../AGENTS.md)、[项目总控](../docs/PROJECT_STATE.md)，再读 [MONITORING.md](MONITORING.md) 的较新记录与相关实现。旧章节可能描述已经替换的方案，必须核对代码和生产配置。默认只改本模块，提交与发布交总控；写入前取得项目占用。

## 入口与状态

| 文件 | 职责 |
| --- | --- |
| `monitor.mjs` | 调度、页面、注册、卡片集成与各模块协调 |
| `factory-pool-monitor.mjs` | Factory 资产配置、兑换路径与创建状态 |
| `contract-integrity-monitor.mjs`、`vault-portal-v116.mjs` | 合约完整性、角色、审计事件及 1.16.0 适配 |
| `safe-proposal-monitor.mjs` | Safe 提案、签名、执行与只读模拟 |
| `early-signal-monitor.mjs`、`early-signal-catalog.mjs` | 提前信号、候选资产、关联地址、流动性与回执 |
| `early-signal-notifications.mjs`、`cow-notifications.mjs` | 即时推送、配套动作归并与 CoW 进度更新 |
| `pool-relevance.mjs`、`public-pool-notifications.mjs` | 钱包参与证据与第三方公共池降噪 |
| `pending-registry.mjs`、`pending-registry-worker.mjs`、`registry-notifications.mjs` | pending 注册预警、线程与链上确认卡片 |

运行状态：`snapshot.json`、`factory-pool-state.json`、`contract-integrity-state.json`、`safe-proposal-state.json`、`early-signal-state.json`、`runtime-metrics.json`。不要打印 Safe 签名、账号凭证或整个巨大状态文件。保护游标、待发事件、已发送分片、重组记录和历史放弃记录。

## 生产频率基线

北京时间 **2026/10/15 23:19** 读取服务器 `.env` 的相关配置，版本 `1.10.33`。下面是配置调度周期，不是保证每个请求或通知都在该时间完成。

| 通道 | 当前配置 |
| --- | --- |
| 页面主轮询 | 1 秒 |
| Factory 实时 / 追赶 | 500 毫秒 / 1 秒；0 额外确认块 |
| 金库注册 | WSS 即时 + 1 秒 HTTP 补漏；0 额外确认块 |
| 完整性核心 / 扩展 / 代码审计 | 10 秒 / 60 秒 / 600 秒，配合 WSS |
| Safe 常规 / 活跃提案 | 10 秒 / 5 秒 |
| 提前信号链上扫描 | 1 秒 + WSS；0 额外确认块 |
| CoW / 关联地址发现 | 10 秒 / 24 小时；到期检查不等于重新全量发现 |

资产、仓位、余额等独立任务还须核对 `runtime-metrics.json.jobs` 和当前调度实现。不要从旧“默认一个确认块”文字回退已生效的零额外确认；零确认仍须校验链与回执，并处理重组。WSS 不替代 Safe/CoW 链下 API、页面或无事件 getter 检查。

## 必须保留的用户决定

1. 已删除“05｜Robinhood CAStore”监控，不重新加入。日常汇总已取消，重要动作即时推送。
2. `GrantRevoked`（审计授权已撤销）仅保留记录，不推送，也不补发旧队列；其他角色/权限、授权使用、审计报告照常处理。
3. 监控钱包真实加池/撤池仍即时提醒。配套转账、CoW 分批成交、额度消耗只能在同交易、对象和精确金额等证据匹配时合并；持续授权、未知操作、权限、新流动性和不完整匹配不能误滤。
4. 第三方公共池活动不推断为官方动作，不推进资产准备状态；已有公共池观察卡按原策略编辑，原始记录按现有保留策略保存，相关钱包活动及证据不完整操作继续提醒。
5. 普通转账卡片标题为“转账”；资产名下显示完整代币合约。资产名称复用现有 API/链上缓存，不为首条通知额外等待。
6. 审计卡片标题“审计报告提交”；显示关联代币、金库、工厂、Portal 登记描述和官方标记。关联代币链接用 `https://gmgn.ai/bsc/token/{token}`；金库/工厂区分清楚，创建入口 `https://flap.sh/launch?vaultfactory={factory}&chain=bnb&lang=zh` 只填已确认对应的工厂。
7. 审计提交不等于审计通过；未标记官方不等于恶意。映射按事件区块核验，降级查询最新状态时注明“当前映射”。
8. Safe 金额按 BNB/代币/包装份额真实精度换算，不展示巨大的原始 wei 当实际金额。只读模拟通过不等于执行成功或最终确认；提案和签名进度保持真实状态。
9. pending 匹配注册调用后先入队“尚未核验”，模拟结果和链上确认更新原卡。保留来源、首见、转发与投递时间；私有池/公共订阅覆盖不足时不能承诺每笔提前捕获。
10. 已采用的单节点历史成功读取策略、历史放弃记录及失败不推进游标规则保留。不要自动恢复已放弃区间，也不要擅自新增放弃区间。
11. Safe Key 选择、预算分池和轮转策略保持当前实现；多 Key 有消耗不自动等于重复请求，不为减少展示消耗改动用户已保留的策略。RPC/共享预算修改交总控。

## 已核验关联执行钱包

- `0x57d5656b4212af89f0afcc9680a7fb1d08b5c5c9`：已有 EWYB 收币、PancakeSwap V3 授权、加池及 NFT #7668265 持有证据，已加入配置与动态监控。
- 运营 Safe 样本 `0xcd561eb3828232d3ec174fb5e321586209fbf535`；既有执行地址 `0x81459cd6b1bdf55d01a824350a79a0c201530992`。
- 标签表示已核验业务关联，不证明地址永久归属。完整集合以 catalog 与服务器显式 `FLAP_EARLY_WALLETS` 为准，显式配置会覆盖默认值。
- 未开放非基础资产向执行钱包调拨提示“疑似流动性准备”；执行钱包对已知仓位管理器非零授权提示“加池准备”。收币/授权不等于已经加池或开放，不能省略证据边界。

## 最近状态与待关注限制

- Flap 最新业务变更：`861fee1f1c6541343eee871dcbf7de0da9f7b152`，版本 `1.10.33`；仓库随后还有 Four.meme 提交，不能用本模块最后修改 SHA 误判服务器整体版本。
- 2026/10/15 23:19 状态抽查：进程 online，Factory、完整性、Safe 的 `lastError` 为空；未在本轮进行全通道审计。
- 公共 RPC/WSS 与 Safe、官网限流仍可能发生；检查真实错误、任务完成时间、队列、游标和退避，不能用短时正常保证长期无错。
- 历史维护背景见 [历史策略](../docs/flap-history-policy-2026-09-27.md)、[提前信号精度](../docs/flap-early-precision-2026-09-28.md)、[VaultPortal 适配](../docs/flap-vaultportal-v116-2026-10-07.md)。

## 验证与待发布交接

专项使用 `npm run test:flap`，语法使用 `npm run check`；按变更选择真实回执 fixtures 验证分类、重组、失败重试及分片投递。回放不向真实群发送消息、不推进生产游标。

当前无待发布业务改动；本次为交接初始化。下次替换本段填写：问题及证据、改动文件、重要事件保留/降噪边界、测试结果、性能和请求增量、配置/状态迁移、需重启服务、残留问题。提交与部署由总控完成。
