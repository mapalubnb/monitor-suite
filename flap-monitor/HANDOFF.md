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

### 2026/10/22 待发布：CoW 与 RPC 完整性修复

- 用户在总控明确授权方案全部实现、频率不变，验证后先 GitHub 后服务器。总控持锁串行实施，基线 98758f6；Suite 1.12.52 / Flap 1.10.37 / Four.meme 1.5.20。
- Flap：early-signal-monitor.mjs 区分 EthFlow owner/trader，校验 UID owner、按 userValidTo 到期，订单/事件/队列原子内存提交；异常记录在 cowValidation 健康项保留并每轮重查，正常记录继续扫描。仅将旧 owner 兼容错误的退避置为可重试，成功后才恢复健康。cow-notifications.mjs 用订单 UID 的已知 trader 归属核验成交、显示真实钱包，继续复用原卡和投递 ID。
- Flap monitor.mjs 与 shared/scan-recovery.mjs：注册、提前信号统一窗口按日志节点已知可用高度重读，失败不确认、尾段不跳过、不退回已完成游标；高度短暂落后留到下一次既有调度，不触发普通故障长退避。
- Four.meme monitor.mjs：actorHistory 与 creatorDiscovery 使用历史预算；新增可选 historyblock/historyread 池，默认历史区块排除实测返回 null 的 blxrbdn，实时节点保留；严格读取已尝试所有节点后不再次发起宽松 batch。生产配置不需变更。
- 文件还包括两模块相关回归、版本、README、.env.example、MONITORING.md、CREATOR_DISCOVERY.md、本交接与 PROJECT_STATE；未改变调度间隔、WSS、Safe Key、AI 关闭策略、历史放弃、原消息队列及去重 ID。
- 本地根语法检查通过；隔离串行全量（所有 *.test.mjs，含未列入旧 npm test 清单的用例）701/701 通过。新增测试覆盖身份误归属、UID 伪造、有效期、队列满回滚、重启幂等、发送失败重投、节点落后缩窗及尾段追齐、null 区块切备用、预算不足不重复请求。
- 真实 API 4 笔订单内存回放全部接受，旧 EthFlow 已成交订单启动 pending=0、再次回放 pending=0；未发测试卡片。旧注册纯逻辑测试误写工作区快照导致 Windows EPERM，已注入不落盘回调；生产存储未改。三个旧投递测试的合成 UID/浮点秒时间改为合法输入，不放宽身份校验。
- 发布需重启 Flap 和 Four.meme；机器人不重启。风险：公共节点仍可能拒绝/限流/超时，供应商问题不能保证永久消失；确认实际游标、所有周期、CoW 正常检查、队列与旧状态保留后记录验收。尚无自然新 EthFlow 操作的端到端送达证据。


### 2026/10/22 已发布：1.10.36 关闭 Flap 全部 AI 分析

- 用户明确要求关闭 Flap 的所有 AI 分析，另明确授权本地验证后通知总控部署。基于 `4e1225c992b86a1f2eb2040b907c27797d70ea46`；未提交、推送、改服务器或重启。
- 文件：`monitor.mjs`、`monitor.test.mjs`、模块 `package.json`、`MONITORING.md`、本交接。模块版本 1.10.36；根版本和 README 由总控整合。
- 实现：模块独立固定关闭开关同时拦截通知选择、直接金库通知增强、页面摘要和金库介绍底层入口。共享模型配置无法重新启用本模块；不发 AI 请求、重试、AI 编辑或单独补发。原始卡片、链接、diff 附件、规则解析及所有链上监控保持；运行指标新增 `ai.enabled=false`。无 AI 持久待办队列需迁移，已有消息投递队列保留。
- 验证：根 `npm run check` 通过。新回归将共享 AI 模拟为已启用、有效 Key，核验两个底层入口返回空、零网络请求、零摘要／增强回调，原始卡片及附件仍发送。首轮新测试写只读属性失败，已改用可恢复的属性描述符；同轮既有注册测试遇到 Windows snapshot rename EPERM，改串行复跑结果见后续记录。
- 最终本地验证：`npm run test:flap -- --test-concurrency=1` 379/379 通过，`git diff --check` 通过。首轮错误未通过删除测试或改变运行策略规避；共享文件和生产状态未修改。
- 发布要求：无需改 `.env` 或删除共享凭证；仅重启 `flap-monitor`。总控复核后按验证、提交、推送、三方提交核对流程发布，验收运行指标 AI 关闭、无新增 AI 请求／重试及原监控游标推进。保留 Four.meme 已关闭 AI 的策略、机器人手动问答、原频率、Safe Key、降噪与历史放弃记录。本地完成不代表线上已经关闭。


总控发布验收（北京时间 2026/10/22 19:03:52）：业务提交 `3d4191f8f0f519f0b436a8ebc528aa6dc3bfb65a` 已先推送 GitHub、核对确切 SHA 后快进部署；Suite 1.12.50 / Flap 1.10.36。总控串行全量 635/635、根语法检查通过，服务器串行 Flap 专项 379/379。先前 Windows 快照 EPERM 在本次串行验证未重现，未修改共享存储或其他模块。

- 仅重启 Flap，PID 1346618；Four.meme PID 1325193、机器人 PID 1203994 未变，三进程 online。连续三个样本 Flap ai.enabled=false，Four.meme 仍为 false。日志只有共享客户端读取“初始模型”，未见 AI 请求错误、摘要编辑或补发；关闭路径由共享 AI 启用情况下的隔离回归验证，无真实 AI 请求或测试卡片。
- 根/模块 .env 与 ai-models.json 逐字比较一致，14 个可观测任务 intervalMs 逐项一致；其他调度代码与配置未改。原始通知、附件、过滤、Safe Key 与历史策略保留。
- 观察样本：提前信号实时游标 129118566 → 129118702，末次与最新高度相同；Factory 实时 129118515 → 129118700，完整性 129118468 → 129118694，注册 129118569 → 129118703，Safe 最近完成时间更新到 19:03:45.711。
- 原提前信号历史游标/终点 124064613 保留，历史放弃记录逐项一致；6 条原有提前信号待发记录保留。CoW owner 不匹配仍存在；一次注册 HTTP 查询遇节点落后一块/公共节点拒绝，末次已恢复并推进，不代表供应商长期无错。
- 备份：`/root/monitor-suite-backups/flap-1.10.36-20261022-190150`，含代码、受限权限配置、停机后的全部核心状态及快照分片、测试和验收 JSON。未删除旧卡片或共享密钥。
- Suite 1.12.51 只同步上线验收，无需再次重启；未经用户重新授权，不因共享模型/凭证恢复重新开启 Flap 自动 AI。

### 2026/10/21 已发布：1.10.35 关联 Safe 与 ERC-4337

总控发布验收（北京时间 2026/10/21 17:15:41）：业务提交 `847db12793528b5b389b5d2fb0b02888e9e8ddbd` 先推送 GitHub、核对确切提交，再服务器快进。根业务版本 1.12.42，本次验收文档 1.12.43；Flap 1.10.35。服务器语法检查及 Flap 378/378 测试通过，本地全量 592/592 通过。以下“未提交／未部署”描述为模块交接时的历史记录，以本段验收为准。

仅重启 Flap（PID 818101），Four.meme PID 2902374、机器人 PID 209466 均未改变；环境文件哈希与 14 个可观测任务 intervalMs 和发布前一致，Safe 5 秒调度及其他配置未变。新 Safe dfee 于 17:15:06.230 建立 API 基线，nonce=0，错误为空；观察地址共 19 个，新地址从 128912061 起覆盖。提前信号实时推进至 128912368 / 128912371，Factory 128912372 / 128912372；合约完整性持续推进，任务错误为空。WSS healthy，pending 收到 61877 条消息、丢弃 0、无断线，观察约 141 秒；尚未自然命中新 ERC-4337 操作，不能代替真实新操作端到端验收或长期稳定证明。

备份 `/root/monitor-suite-backups/flap-1.10.35-20261021-171251` 含前一提交代码、配置、停机后状态及快照分片、语法／测试日志、前后指标。原 6 条提前信号待处理事件未清空。既存 CoW owner 不匹配仍为 332 次，两个公共池过期卡片仍有 HTTP 400。观察窗口还有 RPC 429 计数 3、访问拒绝 1、预算暂拒 13，WSS 短暂心跳重连后恢复；旧版日志也存在节点高度落后及重连，不以过滤错误、推进失败游标或降低频率掩盖。当前扫描恢复推进，但公共节点波动及上述遗留问题仍需后续专项处理。

- 授权：用户明确确认按计划实施并交总控发布；本次由链上核验对话执行 Flap 模块修复，例外范围已登记 PROJECT_STATE。基于 `2a01ee94b7edca375b86c3a2dca778f8961df2b5`，未提交／推送／部署，未改服务器或发送测试卡片。
- 问题与证据：新 Safe `0xdfee42acb3fce076033edcf2084687340b8f2fab` 于 2026/10/21 00:51:27 创建并执行 ERC-4337 授权；16:47:58.920 才被每日 API 关联发现，生产仅候选、无持续观察覆盖。脱敏真实回执见 `fixtures/safe-4337-20261021.json`，交易 `0x7ff81775492dbc6a7f77cb0d9194efa68df938a2825c426c48ef1bd77c9f8542`。
- 文件：新增 `erc4337-codec.mjs`、`safe-observation.mjs`、`safe-4337.test.mjs`、上述 fixture；修改 `address-observation.mjs`、`early-signal-catalog.mjs`、`early-signal-monitor.mjs`、`early-signal-monitor.test.mjs`、`pending-operations.mjs`、`pending-registry-worker.mjs`、`pending-registry.mjs`、`monitor.mjs`、模块 `package.json`、`MONITORING.md`、本文件与 `docs/PROJECT_STATE.md`。共 16 个文件；根版本及根脚本留总控整合。
- 行为：静态新 Safe 仅关联观察；可信工厂创建事件＋owners/threshold/singleton 核验后动态持续观察，API 新候选额外核验 runtime；名单与补扫起点持久化、订阅与 pending 配置热更新。不扩充官方执行钱包，不将关联自动当官方。普通提案轮询覆盖静态新 Safe；动态新 Safe 的链上操作／公开 pending 持续观察，不自动扩张 Safe API 提案轮询集合。
- ERC-4337：按 sender/nonce 独立核验 UserOperation 结果、模块调用与预付 gas 边界；保留未知/超限/路由器调用的待解析提醒；不把外层模拟通过当作单笔成功。动态发现同窗口后续操作通过持久补扫捕获，不倒退实时主游标；并发状态合并、重组、重启和通知去重有回归测试。
- 验证：`npm run check` 通过，新增模块及最终改动单独 `node --check` 通过；全仓 `npm test` 589/589 通过，随后补充路由器回归后最终 `npm run test:flap` 376/376 通过（新增专项共 15 项）；`git diff --check` 通过。测试隔离了真实通知凭证，没有发群测试。不是线上时延/长期稳定证明。
- 总控复核：修正 pending 回执在 UserOperation 结果完整核验前提前写入 executed 的问题，新增失败回归后改为原子确认；API 核验跨 await 不覆盖快速发现的更早补扫起点，重组后不提交旧结果，API 发现事件带区块身份以支持撤回。根版本整合为 1.12.42，新增模块纳入语法检查。最终本地 `npm run check`、`git diff --check` 通过，全量 `npm test` 592/592 通过（专项 17 项）；服务器验收待发布后补记。
- 配置／状态：无需改 `.env` 或手工修改生产状态，保持全部调度周期、Safe Key、历史放弃和降噪设置。模块版本 1.10.35。新增可选 `observedSafes`（含 replayFrom）、`ownerRelations`，复用 observationCoverage；新静态地址从升级激活高度开始，旧历史不批量补推。回滚需保留/备份状态，旧版不会使用动态名单扩展，应明确回滚后覆盖缩减。
- 总控上线：更新根 Suite 版本和必要说明，建议在根 check 脚本显式列入新增两个模块（专项已由 early-signal-monitor.test.mjs 引入，不要再重复枚举同一专项）；按先验证、提交、推 GitHub、确切提交校验、服务器快进顺序，只重启 Flap。备份完整状态与配置，不重置游标。验收本地/GitHub/服务器一致、dfee 静态观察与普通 Safe API 轮询、WSS 新过滤器、pending Worker 健康、实时游标推进及 source health。
- 限制／资源：已核验工厂和 singleton 集合之外不自动纳入，其他 EntryPoint 版本只保留既有模块事件提醒；私有 pending 不可见，解析 64 操作/128 KiB，动态观察最多 128 个（满额创建提醒尚未启用），沿用 300 笔/窗口与 Worker 背压。全局工厂日志和有关创建 getter 增加 RPC 压力，需上线观察延迟/错误/丢弃指标；不承诺固定秒数。原公共池超 14 天卡片编辑失败与 CoW owner 不匹配属于既存问题，本次未处理或清空。


专项使用 `npm run test:flap`，语法使用 `npm run check`；按变更选择真实回执 fixtures 验证分类、重组、失败重试及分片投递。回放不向真实群发送消息、不推进生产游标。

### 已发布：1.10.34 关联地址覆盖（2026/10/17）

用户已确认实施并授权验证后交总控发布。实现基于本地 `main` 的 `026159cc9cb984a635769529203b6bcbaec63bda`；本模块未提交、推送、修改服务器或重启服务。根版本及 README 由总控整合。

总控已接手并整合 Suite `1.12.40`、根 README 及新增模块语法检查。复核补充修正了 Safe 外层回执成功但内部失败时的观察归并：必须有有效 Safe 执行结果，缺失结果保持待核验，失败不能被覆盖为成功。该场景先通过失败测试复现，修复后相关 80 项及全量 575 项测试通过，`npm run check` 通过。实际部署结果以总控发布回执及三方提交核对为准。

发布前基线（2026/10/17 13:06，北京时间）：服务器仍为 1.10.33，提前信号实时游标与最新高度一致，pending 订阅正常。EWYB 执行钱包已有 `CoW 订单 owner 不匹配`（132 次）的既存来源错误；本次不删除校验或清空错误掩盖它，该项需后续单独核验。

总控发布验收（2026/10/17 13:09:54，北京时间）：业务提交 `d1aba563e5437a58ad7d141adcd0431d442f2f95` 已先推 GitHub 再快进部署；服务器语法检查及 Flap 361 项测试通过。仅重启 Flap，版本 1.10.34、PID 3521060；Four.meme 与飞书机器人 PID 不变，`.env` 哈希和全部任务调度周期不变。新 Safe 于 13:09:18.702 完成公开提案轮询，nonce 2、错误为空；18 个观察地址从 128111708 起覆盖。实时游标推进至 128111911，与当时最新高度一致；Factory／注册已追平，pending 已收 17743 条消息、丢弃 0。观察窗口约 94 秒，尚无新增重要 pending 自然命中，不能视为长期稳定或提前捕获率证明。

回滚备份：`/root/monitor-suite-backups/flap-1.10.34-20261017-130754`，含前一提交代码、配置、停机后完整 Flap 状态及快照分片、验证日志和前后指标。另有既存公共池卡片编辑失败：升级前备份已记录 2391 次 HTTP 400，升级后错误 230031 明确为超过 14 天编辑期限，仍有两条旧公共池事件等待更新。该项和上述 CoW 来源错误需后续单独修复，不删除队列或更改降噪规则来掩盖。本轮无待发布业务改动。

- 问题与证据：资金关联 Safe `0x65eA398b9EB6b7A75FD5A1018463039374A0b908` 原仅候选，现补提案／签名监控；16 个签名关联地址和资金收款人 `0x24160Dfca52F12017338932DEcE5c85c4F971aeB` 补独立观察。新 Safe 仍为 2/3，四个真实样本的区块 hash 于 2026/10/17 13:02:57 只读复核通过。证据、完整名单与业务边界见 [MONITORING](MONITORING.md) 最新章节及 fixture。
- 修改文件：`early-signal-catalog.mjs`、新增 `address-observation.mjs`、`early-signal-monitor.mjs`、`early-signal-notifications.mjs`、`operational-call-codec.mjs`、`safe-proposal-monitor.mjs`、新增 `pending-operations.mjs`、`pending-registry.mjs`、`pending-registry-worker.mjs`、`registry-notifications.mjs`、`monitor.mjs`；测试 `early-signal-monitor.test.mjs`、`pending-registry.test.mjs`；新增 `fixtures/address-coverage-20261017.json`；模块 `package.json`、`MONITORING.md` 和本交接。
- 行为：新增地址不授予官方／执行钱包身份，不提升准备阶段；被动收币静默、投毒日志不认定主动参与。新增 owner 进入待核验候选。重要 pending 有只读模拟、回执身份／Safe 结果核验、替代及重组纠正；新观察结果归并原预警，投递成功才出队。原关键权限／LP／CoW 事件继续独立提醒。
- 验证：`npm run check` 通过，两个新增模块分别 `node --check` 通过；`npm run test:flap` 360/360 通过（原 350 项 + 10 项新测试）。新增测试覆盖真实资金调拨／新增 owner／v=1／投毒回放、历史起点、畸形／错误目标调用、V3 multicall、重组、失败回执、替代身份、发送失败重启及迟到模拟。未向真实群发测试卡片，未推进生产状态。
- 保持：所有周期、Safe Key／预算、旧降噪、已关闭推送、历史放弃记录和历史读取策略不变。新 Safe 进入固定轮转会拉长整体覆盖周期；17 个观察地址只增加命中交易查询，不增加余额／CoW 轮询。pending 沿用单笔核验和 Worker 既有预算，注册优先；高负载可能使新增操作等待或被容量限制，健康计数可见。
- 配置／迁移：正常生产配置无需新增环境变量，保留 `FLAP_EARLY_WALLETS`；不把 24160 或签名者加入其中。可选 `FLAP_OBSERVATION_WALLETS` 仅追加观察。若关闭 `FLAP_SAFE_INCLUDE_CORE`，总控需核对显式 Safe 列表。新 `observationCoverage` 自首次实时高度起生效，状态其余字段保持；不做历史补发和旧游标变更。
- 发布：请总控复核 diff、更新根版本／README，再验证、中文提交、推送并核验确切提交后部署；仅需重启 `flap-monitor`，保留并备份现有状态。发布后核对新 Safe 配置／轮转、观察起点、扫描推进、pending 队列和错误。该结果为本地验证，不代表已上线；私有 pending／未公开 Safe 提案、未覆盖的 V4／Infinity pending 仍有覆盖限制。

服务器发布前补充：隔离全量两次均 700/701，唯一失败为旧 HTTP body 超时测试在 150ms 内尚未建立 localhost 连接，单独运行通过。比较增加时间、预热连接、隔离子进程与模拟响应后，改用立即返回响应头、正文等待 AbortSignal 的确定性回归，仍验证必须读取正文并按时中止；生产请求/超时逻辑不改。Suite 1.12.53 仅测试稳定化与文档收尾，需重新完整验证后部署。

发布观察补充（Suite 1.12.54 / Four.meme 1.5.21 / Flap 1.10.38）：9ace16c 于 19:21 上线后 CoW 已恢复、所有周期不变，旧 6 条待处理记录保留；观察发现创建者历史本地预算等待仍触发旧 60 秒失败退避。补充区分本地预算（下个原有 10 秒周期重试）与真实错误（保留退避并尊重 Retry-After），错误和游标仍保留，不通过清错伪装成功。共享 RPC 指标增加失败类别、区间、地址数量、topic 分支数量，便于识别 PublicNode 查询拒绝；不记录密钥 URL、地址或 calldata，不改变限额。需再验证、先推 GitHub 后部署。

PublicNode 拒绝根因补齐（Suite 1.12.55 / Flap 1.10.39）：新诊断定位到提前信号 355 地址 / 25 topic 分支查询触发 403；直接请求 50 地址时服务端明确返回 “A maximum of 10 addresses is allowed”。公共 PublicNode 的 >10 地址查询预先交由支持宽查询的节点，原地址集合完整保留，单地址/最多10地址查询不受该能力限制影响。无其他可用节点时仍失败保留游标，不把不支持误认为空日志。新增完整过滤条件转交与小范围继续可用回归；仅 Flap 需重启。
