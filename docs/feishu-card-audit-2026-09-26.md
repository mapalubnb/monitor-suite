# 飞书卡片输出复查（2026/9/26）

检查版本：615a794，Monitor Suite 1.11.8。此次为只读检查，没有修改或重启生产程序，也没有向飞书群发送测试消息。

后续修复：经用户确认，1.11.9 已实现下述四项修复，并增加 11 项回归测试（共 370 项）。卡片在构建后校验元素数和请求体大小，代码块与颜色跨片补齐，链接／Unicode 字符保持完整；发送和更新复用统一规划器，通知队列持久化分片计划。以下内容保留为修复前检查记录。

## 结论

当前常规输出与官方 JSON 2.0 规范基本一致；实际状态命令没有发现双星号和旧格式时间。但长消息分片存在已复现的问题，不能认定所有输出均无问题。

## 官方依据

直接读取官方页面正文，非第三方教程：

- [JSON 2.0 结构](https://open.feishu.cn/document/feishu-cards/card-json-v2-structure)，页面更新于 2025-06-23：客户端须为 7.20 或更新版本；共享卡片 update_multi=true；单卡最多 200 个元素或组件；element_id 全局唯一、字母开头、仅字母数字下划线、最长 20 字符。
- [富文本 Markdown](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/content-components/rich-text)，页面更新于 2026-08-27：支持 Markdown 链接、代码块、删除线、emoji 和指定 HTML 标签。加粗是合法语法，但连续星号及语法前后空格可能影响显示。按用户要求继续移除双星号。
- [普通文本](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/content-components/plain-text)，页面更新于 2025-10-20：div.text 支持 plain_text 和 lark_md，heading/normal/notation 字号均有效；lark_md 支持链接、颜色和删除线。
- [表格](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/content-components/table)，页面更新于 2025-09-25：最多 5 个表格，根层放置，最多 50 列，每页 1–10 行；markdown 列有效；auto 行高及 row_max_height 需要客户端 7.33+；即使设置最大行高，过长单元格仍可能被裁剪。
- [发送消息](https://open.feishu.cn/document/server-docs/im-v1/message/create)，页面更新于 2026-04-10：卡片请求体最大 30 KB，包含样式和序列化结构，不能仅按正文字符数判断。

## 覆盖范围和证据

检查共享 sendCard、replyCard、patchCard、sendText、replyText 入口，以及调用它们的 Four.meme、Flap 和机器人代码。未发现其它绕开共享客户端的卡片发送入口。

复跑全量 359 项测试，全部通过。其中展示语料覆盖启动、底池、API 结构/API 值、OpenFour、合约、链上参数、GitHub、页面恢复、金库、Factory、完整性、Safe、提前信号、帮助、AI 共 16 类；其内容保留检查通过。现有测试通过不代表未覆盖的边界不存在问题。

服务器现场输出经相同卡片构建流程核验（2026/9/26 15:23 左右）：

| 命令 | 分片数 | 单片最多元素 | 最大模拟请求体字节 | 双星号/旧格式时间 |
| --- | ---: | ---: | ---: | --- |
| fm-status | 3 | 29 | 9012 | 无 |
| fl-status | 9 | 29 | 7469 | 无 |
| mon-status | 1 | 29 | 4417 | 无 |
| bot-status | 1 | 15 | 2338 | 无 |
| mon-help | 1 | 5 | 3360 | 无 |

请求体使用占位接收者 ID 计算，用于容量检查，不是实际发送记录。当前分片数量随状态内容变化。

三个进程均 online。抽查各进程日志尾部最多 300 KB、其中北京时间 15 点的新格式记录：Four.meme 71 行、机器人 25 行、Flap 74 行；两项监控各有一次卡片发送成功记录，没有匹配到飞书发送/更新失败。此观察仅覆盖该日志窗口，不代表全部历史均无错误。

## 发现的问题

### 1. 单卡元素数和请求体大小未受保护（优先）

shared/feishu-client.mjs 根据正文字符数分片，构建布局之后未校验官方 200 元素和 30 KB 限制。

复现：75 组“二级标题 + 一个值”，正文仅 964 字符，不会触发 3460 字符分片；最终含 303 个带 tag 的元素，卡片 JSON 为 25992 字节，模拟发送请求体为 31087 字节，已经超过两项边界。普通长正文未必超限，但短而密集的 AI 标题/段落可以触发。

### 2. 跨卡代码块未闭合、续开（优先）

splitMessageContent 只切字符串；balanceCardFontTags 只修复 font 标签。150 行日志包在一个代码块中时，切为两片：第一片仅有开围栏，第二片仅有尾围栏且不以代码块开头。后续日志可能按 Markdown 解释，缩进和符号失去原义。机器人通用命令及错误输出确实使用代码块，所以这不是仅存在于虚构输入的风险。

### 3. 超长链接和 emoji 可被切断

复现超长 URL：一个包含 3500 字符路径的 Markdown 链接切为两片，任何一片均不包含完整链接。

复现 Unicode：3459 个 ASCII 字符后跟一个 emoji，按 3460 个 UTF-16 单元切分，两个分片中出现孤立代理项，客户端可能显示替代字符。

这两项主要影响极端输入；当前常规合约链接远短于分片阈值。

### 4. Four.meme 的发送和 AI 更新阈值不一致

shared/feishu-client.mjs 的实际卡片分片阈值默认 3460；fourmeme-monitor/monitor.mjs 的 isTooLongForSingleCard 使用 3500。3461–3500 字符的正文已经发送成多片，却仍可能被判断为单卡更新，导致首片覆盖为完整正文后，原后续片仍留在群内。Flap 已使用减去 40 的一致阈值。

## 建议修复范围

- shared/feishu-client.mjs：统一卡片分片入口；在最终 JSON 及请求体阶段校验元素数/字节数；切分时保留完整链接、Unicode 字符，跨片补全代码围栏和颜色标签。
- fourmeme-monitor/monitor.mjs、flap-monitor/monitor.mjs：发送、AI 更新及提前信号名称补全复用相同的分片结果或判定，避免各自维护阈值。
- shared/feishu-client.test.mjs、shared/card-layout.test.mjs 及监控测试：增加以上失败用例和内容完整性、重试分片 ID 一致性验证。
- package.json、两个模块的 package.json 和 README.md：实施修复时同步版本及说明。

主要风险是分片边界改变后，已保存的 sentParts 和异步更新映射必须保持一致；不能简单更换一个切分函数而忽略队列重试、名称补全和 AI 更新路径。应先完成边界用例，再在 Linux 临时目录跑全量测试，备份后部署。

## 验证边界

完成官方规范、源码、构建结果、回归测试和生产日志检查。没有逐一在桌面端/移动端飞书客户端进行视觉验收，也没有用极端输入向生产群发送测试卡片。官方不保证所有客户端版本的渲染完全一致，因此不能据上述检查宣称所有客户端、所有输入下绝无问题。
