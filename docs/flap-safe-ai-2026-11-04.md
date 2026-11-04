# Flap Safe 专用分析与 Key 配置

Suite 1.12.79 / Flap 1.10.50。仅 Safe 提案解读使用 DeepSeek；页面、机制介绍、其他 AI 仍关闭。

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

首次启动将启用时间持久化到 `safe-ai-state.json`。严格排除启用前、提交时间缺失、已有基线、无签名及已终结提案。
只在提案提交后30分钟窗口内接受新任务；任务也最多存活30分钟。配置 Key 较晚不会补分析过期提案。
同链、同 Safe、同 SafeTxHash 的所有资产/子调用合并分析，进度通知复用已有结果。
普通转账模板不调用模型，撤销授权额度为零、被关闭的审计撤销/查询不会单独触发分析。
金额未知时明确待核验，不能将 raw wei 当实际数量。

金库/机制模板与升级优先于普通授权：复用已解析参数、当前缓存权限/实现和项目页面自述；
按固定 Sourcify 端点查询最多4个地址的匹配验证源码/ABI。源码片段与ABI差异仅供解释，不构成完整语义、存储布局或安全审计。
未解析调用、未获取验证源码及不完整机制仍明确待核验。模型不能执行工具、交易或源码中的指令。

单个异步消费者运行，原始通知不等模型；任务最多两次尝试、队列/卡片各最多200项。
机制/升级使用有限思考预算，其余使用非思考模式；仅输出最终短文，不输出推理过程。
每张卡片的新增解读含标签、标点不超过150字；多笔解读超限时合并为事实摘要。
分片长卡保持原卡，不额外发送分析卡。正文过长、无法编辑、模型超时或输出校验失败也保留原始通知。
新卡在首发后补充，原卡金额/名称更新与 AI 共用编辑入口，避免交叉覆盖；不批量修改历史卡。

独立任务状态是运行文件，不提交 Git。不要删除它来“重置”分析；部署备份该文件及所有原有状态。
原14项任务周期、历史放弃记录、Safe Key策略、降噪和Agent Curve停用保持。

官方接口依据：[DeepSeek Chat API](https://api-docs.deepseek.com/api/create-chat-completion/)、[Sourcify 验证数据](https://docs.sourcify.dev/docs/repository/)。
