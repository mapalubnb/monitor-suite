# Flap Safe 专用分析与 Key 配置

Suite 1.12.85 / Flap 1.10.56。仅 Safe 提案解读使用 DeepSeek；页面、机制介绍、其他 AI 仍关闭。

2026/11/4 11:16实测：用户已配置专用Key，线上configured=true，真实DeepSeek思考/非思考请求均返回HTTP200及deepseek-flash。经用户授权发送一张合成测试卡，异步更新同一消息，新增93字解读已从飞书完整JSON读回核验。生产新提案任务尚为0，不把测试样本视为自然提案验收；原频率和其他AI关闭均不变。后续若更换Key，仍需重新验证鉴权。

## 2026/11/5 Safe AI按需取证升级（Suite1.12.85 / Flap1.10.56）

取消源码3000字符、4文件、100函数及模型输入100000字符的固定截断，初始请求保留完整源码/ABI/参数。只有上游明确返回上下文容量错误才切换显式文件目录，按行继续读取，未读部分不视为已审查。新增Safe独立只读工具循环：验证源码、代理实现、ABI view/pure或标准getter、128块内指定事件、通用调用解码与有单位依据的精确金额计算。请求走既有后台RPC通道，不新增监控定时器。

修复多调用已解析仍误报缺ABI、单个已知动作掩盖未知项、合法派生金额被拒绝等问题。输出错误给出具体原因并有界修正；新提案原卡可补充验证ABI的函数/参数，不回写历史提案。完整地址、200字、绿色、零签名触发、降噪/历史/频率及其他AI关闭不变。

每个分析任务仍最多两次尝试；单次初步取证40秒，模型/补查总截止150秒、最多8次模型请求（前6轮可查询）、24工具调用、20次补充RPC、8个源码读取预算。接口/预算失败保留准确事实提示，不能保证未公开源码或任意新机制均能完整识别。源码无字符上限会增加内存/输入费用，接口容量仍是实际边界。Key沿用，无配置/状态迁移；发布只重启Flap。

验证：本地全项目757/757、专项47/47通过，语法检查通过；真实模型隔离回放和部署验收待执行。修改文件：safe-ai-analysis/evidence/sources、operational-call-codec、新safe-ai-research及测试、根/模块版本和说明。


## 配置 Key

在本机终端运行：

```powershell
ssh -t tencent "sudo -n bash /root/monitor-suite/flap-monitor/configure-safe-ai-key.sh"
```

在提示处粘贴 DeepSeek 官方 API Key，然后回车；输入不回显，不放入命令行参数或 Git。
脚本备份服务器根 `.env`，仅更新 `FLAP_SAFE_AI_DEEPSEEK_API_KEY`，权限设为600，并仅重启 `flap-monitor`。
不修改全局 `ai-models.json`、其他 Key 或其他服务。不要将 Key 发到聊天或日志。
若此前显式设置 `FLAP_SAFE_AI_ENABLED=false`，脚本保留该设置；需要启用时再将该专用开关设为true。

模型固定 `deepseek-flash`，接口固定 `https://api.deepseek.com/chat/completions`。
运行指标 `flap-monitor/runtime-metrics.json` 中：

- `ai.enabled=false`：其他 Flap AI 仍关闭。
- `safeAi.enabled=true`：Safe 专用功能启用。
- `safeAi.configured=true`：进程已读到专用 Key；不代表鉴权、余额或实际推理已验证。
- `safeAi.health=missing_key`：尚无专用 Key；原始监控通知照常。
- `analysis_failed` / `patch_failed`：分析或原卡编辑失败；不另发分析卡、不回退模型。

首次部署不会写入或代填 Key。真实接口鉴权及生成质量必须在配置后验证。

## 处理边界

首次启动将启用时间持久化到 `safe-ai-state.json`。严格排除启用前、提交时间缺失、已有基线及已终结提案。新提案无需签名（0签名即可）进入分析，后续签名复用结果，不重复调用模型。
只在提案提交后30分钟窗口内接受新任务；任务也最多存活30分钟。配置 Key 较晚不会补分析过期提案。
同链、同 Safe、同 SafeTxHash 的所有资产/子调用合并分析，进度通知复用已有结果。
普通转账模板不调用模型，撤销授权额度为零、被关闭的审计撤销/查询不会单独触发分析。
金额未知时明确待核验，不能将 raw wei 当实际数量。

金库/机制模板与升级优先于普通授权。先保留完整calldata并在本地解码，再补充证据；按用户2026/11/4最新授权，完整调用数据及其中签名可进入DeepSeek请求，不再提前脱敏。配置凭证不进入请求，AI任务状态不重复保存完整输入。

覆盖既有金库注册/开放开关、代理升级、角色/owner/Safe成员/门槛/模块、授权额度、包装资产、资金和流动性组合操作；新增通用有界ABI参数解码与setTester等候选识别。读取EIP-1967实现、beacon或标准EIP-1167克隆的一层实现，按同一区块查询代码/状态；失败时缓存实现仅作为候选，不冒充当前实现。未知函数根据验证ABI或OpenChain/4byte候选匹配；候选必须过参数布局校验，多个候选不擅自消歧。选择器出现于字节码、白名单getter返回仅提供旁证，不等于完整语义证明。

源码优先Sourcify，缺失时复用可选`ETHERSCAN_V2_API_KEY`（兼容`ETHERSCAN_API_KEY`）查询固定Etherscan V2接口。没有该Key时保留候选与链上核验，不假称浏览器源码可用；不会使用DeepSeek Key调用浏览器API。当前支持isTester/isWhitelisted/paused/owner/hasRole/isOwner/getThreshold/isModuleEnabled/allowance/asset等受限只读getter；从不执行提案方法作模拟，模型仅能请求受约束的只读工具，由程序构造RPC。当前状态不冒充提案提交时状态，更不证明提案已执行。

每次取证最多16次逻辑RPC（走原后台预算）、4个源码地址、4个选择器的双来源查询，总截止40秒，单请求也有限时；缓存最多各64项。不得因候选猜测扩展为新金库开放或收益结论。源码读取与ABI差异不构成完整语义、存储布局或安全审计。未知代理类型、超出ABI递归/数组/尺寸边界及来源失败会明确保留缺项。

证据状态分别为resolved/candidate/insufficient；暂时失败且未解析时最多补证一次。仍缺证据时由模型使用只读工具继续补查；部分未知必须说明，不能标记为完整解析。失败时输出准确“核验提示”。模型输出须保留候选措辞及关键参数；两次不合格时回退事实提示。运行指标safeAi.evidence统计证据状态，任务保留checks、核验区块及请求计数供排查。未取得资料不等于合约未验证。

单个异步消费者运行，原始通知不等模型；任务最多两次尝试、队列/卡片各最多200项。
新工具分析先用deepseek-flash非思考模式获取必要事实，再以低强度思考核验机制并压缩；内部工具结果与最终200字摘要分离，不输出推理过程。
每张卡片的新增解读含标签、标点不超过200字；多笔解读超限时合并为事实摘要。
分片长卡保持原卡，不额外发送分析卡。正文过长、无法编辑、模型超时或输出校验失败也保留原始通知。
新卡在首发后补充，原卡金额/名称更新与 AI 共用编辑入口，避免交叉覆盖；不批量修改历史卡。

独立任务状态是运行文件，不提交 Git。不要删除它来“重置”分析；部署备份该文件及所有原有状态。
原14项任务周期、历史放弃记录、Safe Key策略、降噪和Agent Curve停用保持。

官方接口依据：[DeepSeek Chat API](https://api-docs.deepseek.com/api/create-chat-completion/)、[Sourcify 验证数据](https://docs.sourcify.dev/docs/repository/)、[Etherscan验证源码](https://docs.etherscan.io/api-reference/endpoint/getsourcecode)、[Solidity ABI规范](https://docs.soliditylang.org/en/latest/abi-spec.html)。

本次按用户授权，Safe 原提案状态保留服务返回的完整签名及原始签名调用；金库注册也保留完整 calldata。AI 任务/卡片快照不重复保存这些大字段，通知正文不展示签名。旧记录缺少原始字段时使用已有解析参数，不回放历史提案。

AI输出中的钱包、合约地址必须为证据内完整42字符地址，省略号/截断地址会被校验拒绝；完整地址逐字符计入200字上限。参数展示、金库工厂与tester事实提示也保留完整地址。普通转账模板保持原规则；已生成的历史分析不重写。

解读先写具体动作，金库与升级只解释有证据的机制/权限差异。候选函数可使用一次“按当前证据判断”或“函数识别尚待ABI确认”，不再强制出现“候选/可能”；笼统的权限范围待核验不能替代函数识别限定。保留完整地址、200字和其他校验，不自动补充“提案解读”标题。完整提示词在safe-ai-analysis.mjs的SYSTEM常量。
