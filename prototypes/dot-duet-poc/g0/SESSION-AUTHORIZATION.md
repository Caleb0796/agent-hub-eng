# 一次会话授权调查与受控验证

更新：2026-10-28，America/Los_Angeles。

**已验证 Muse 的任务级许可方案。首次正规MCP预检失败后，主人另行授权修复和新临时连接；恢复轮完成600秒、21条自动加密消息，聊天全程没有新增逐条审批，任务与通道已收尾。完整结果见[恢复轮验收](RECOVERY-RESULTS.md)。以下保留能力调查及前轮失败记录。**

## 可用机制与限制

Dot 的实验插件当前采用 `Allow low-risk actions`，应用级设置为 `Use my default`，没有修改全局权限。OpenAI 的官方说明允许具体的持续指令覆盖范围内的后续行为，但保留内置审批规则：[Control your dot](https://learn.chatgpt.com/docs/dots/controls)。

Meta 官方架构说明提到按任务、会话和时间限定的许可，由 Sentinel 决定呈现哪些选项；这不代表每个自定义连接器都有可直接调用的 TTL 参数：[Muse 安全架构](https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse)。帮助页也列出 `Allow for this task`：[Muse guidance and approval](https://www.meta.com/help/superintelligence/1385290430137537/)。

常规连接器指南列出单次、永久和拒绝，并要求尊重审批范围，不能用工具描述覆盖安全要求：[Connector guidelines](https://platform.muse.ai/docs)。

当前账号的实际结果是：

| 路径 | 实测或核查结果 |
|---|---|
| 普通主会话中的原始 HTTPS / `tool.exec` | 前轮不断出现单次或站点级许可 |
| 一次性 `runonce` 计划任务 | 原生卡明确关联任务名，菜单出现 **Always allow for this scheduled task** |
| 任务级许可后的第二次同任务 POST | 没有再次出现审批记录，但探针收到 HTTP 403，应用端未收到请求 |
| 原生 600 秒许可字段 | 当前公开接口未找到；不能宣称存在可直接设定的授权到期时间 |
| `timeout_secs` | 是执行预算；探针120秒预算的墙钟耗时335秒，包含246秒等待审批，不能拿它代替墙钟截止 |
| 任务完成后 | 活动定义消失，历史状态仍可查询为 disabled、无下一次运行、无运行中实例；不能把历史记录误认为仍在执行 |
| 全局站点许可 | 探针主机没有新增全局站点或 session 规则；任务级对象的内部 expiry 字段不可查询 |

## 组合方案

可实施的方向是：**每次聊天创建唯一的临时一次性任务 → 主人批准该任务范围 → 保留既有端点密钥与互信 → Hub 独立执行600秒硬截止 → 任务结束并清理 → 检查活动任务及全局许可残留。**

这是一种任务级许可与应用层资源期限的组合，不是“原生许可对象自动在600秒过期”，也不是站点永久允许后再偷偷撤销。首次连接配置、任务的初始网络授权类别以及聊天中的逐条审批必须分别统计。

正式重跑前需通过两步门槛：同一任务中的身份查询和既有签名注册重确认都成功，且无需对每条后续消息再点 Allow once。Hub 已加入双端认证重确认门槛，未满足时不能启动会话。

## 一次性探针

- 任务：`agent-hub-task-permission-probe`，一次性 runonce、120秒执行预算；不读私钥、凭证或私人内容，只投递两份固定公开合成数据。
- 计划及实际开始：14:26:00；结束：14:31:35。
- 首次 POST 审批于14:26:33提出，14:30:39选择了 **Allowed for this scheduled task**。
- 第二次 POST 没有新增审批条目，证明该任务上下文中授权可复用。
- 两次均得到 HTTP 403，正文 `Your request was blocked.`；没有保存响应头，无法确定来自哪个中间环节，不能直接归因为 Hub 或 Cloudflare。
- 探针服务端接受数为0。探针通道于14:36:44自动关闭。
- 官方 remove 返回 `schedule does not exist`；活动列表无此任务，历史状态 disabled、无 next_run / in_flight。没有创建 goal 或 space，也没有修改其他任务。

## 正规 MCP 条件测试

- 会话：`d19cc3ee-a8fd-4c10-a0b7-6402d97aeec1`。
- 唯一任务：`agent-hub-chat-d19cc3ee`，runonce；900秒执行预算仅作准备与收尾保险丝，聊天仍受 Hub 600秒期限控制。
- 主人明确批准了恢复连接、原生数据交换提示和该临时任务的许可。
- 原生系统分别呈现连接与 POST 两类许可；两项均选任务级许可，没有选全局站点永久允许。这是一次主人确认下的两项原生任务许可，不能写成“原生系统只有一张审批卡”。
- Dot 两步预检通过。Muse 端点哈希和双方指纹核对通过，Hub 在15:19:47收到其认证身份查询，但客户端报告传输未完成，没有得到完整响应；注册重确认未执行。
- Muse 任务15:12:39开始，15:22:28结束，状态 failed。不存在新的聊天消息，Hub 从未 armed。
- 本次不是已证实的403/401；保留记录没有HTTP状态与响应头，不能明确归因。

客户端只读代码核查显示：sessionless 路径没有 initialize、额外 GET/DELETE 或重试循环；使用 `urllib` 单次 POST，socket 超时180秒。错误来自 `URLError`、`TimeoutError` 或 `OSError` 的通用分支。审批等待与传输超时可能耦合，但没有完整阶段日志，原因仍待验证。

## 恢复边界

原计划只延长专用客户端初次等待，并通过官方 `cron.run` 恢复相同任务一次；若任务不存在则停止，不重建同ID来继承许可。该操作被自动审批拒绝，理由是当前实验采用“超时即停止”，失败后的恢复需要新的授权。**拒绝发生在执行前，原生客户端没有因该请求被修改，也没有重试。**

原通道于15:32:44自动关闭，失败会话已撤销；因此恢复使用新的临时实例、连接与任务身份，没有沿用旧任务许可。恢复确认提交后保持停止，直到主人明确授权才继续。

15:46 的 Muse 原生回复确认清理结果：官方 remove 对 `agent-hub-chat-d19cc3ee` 返回 `schedule does not exist`；活动列表无此任务，历史状态 `enabled=false`、`next_run` 为空、`in_flight=false`，运行中和排队实例均为0。新主机没有全局站点或 session 许可规则。此前旧 G0 主机的两条规则仍存在，本轮未修改；因此这里的清理结论仅指本次失败任务与新主机，不代表已撤销历次实验的所有许可。

新的恢复应保留：同一对端与既有密钥、原生代理与TLS验证、无会话MCP协议、明确的安全错误日志、预检通过才启动、600秒聊天硬截止、失败立即停止、结束清理。不采用永久站点许可，也不把自动点击多次 Allow once 当作一次会话授权。

## 证据与实现

### 已授权的恢复进展

主人已确认“授权修复后再验证”。本轮使用新会话 `431065b8-fd21-4f1c-b41a-dc197cec8a69`，计划任务 `agent-hub-chat-431065b8`，不复用旧任务许可。

Muse 已完成专用客户端的本地修复并复制到新的 `custom.agent-hub-recovery-session`：

- `--request-timeout` 默认180秒，首次身份预检可显式设600秒；无重试循环或新增HTTP方法。
- 诊断区分连接、等待响应头和读取响应体，输出异常类型、errno、耗时及白名单响应头，不输出请求/响应正文、凭证或原始异常文本。
- 已核对其返回的最小代码：HTTPS追踪类调用原有 `super().connect()` / `super().getresponse()`；默认ProxyHandler保留，TLS context/check_hostname沿用默认处理。
- Muse原生报告语法检查通过、52项mock检查通过，并完成本地TLS失败阶段检查。这些检查运行在Muse端；本机另有16项Node、5项Python回归测试通过。
- 加密端点SHA-256仍为 `d3f9286d62e951aa32463c7352ff0d0b45aaaf625d34456f8cc428becaf26574`，密钥和pin未变。

Dot连接保存曾被自动审批拒绝，要求明确授权将专用令牌放在Server URL中。主人随后已确认“允许按此方式保存本轮实验连接”，Dot临时插件已创建。两端原生连接卡的通用数据共享提示又被自动审批拦截；主人随后明确回复“接受提示并完成本轮两端连接”，两端连接均已完成。

新任务于16:18:12启动，执行保险丝1500秒用于预检、600秒聊天和收尾。两张初始网络许可（连接、POST /mcp）均选择了本任务的 `Always allow for this scheduled task`。Muse原生只读回报确认：身份请求完整HTTP200、约103秒；注册重确认完整HTTP200、约0.6秒、claimed；后续状态轮询HTTP200，无第三张审批。Dot两步预检也成功。本轮Hub于16:22:52就绪，首条密文于16:24:04.774接受，固定截止为16:34:04.774。最终接受21条密文（Dot11、Muse10），两端摘要全部一致，后续聊天新增0张审批。任务16:36:57成功结束且定义删除，Hub已撤销，通道16:37:50关闭。详见[完整验收](RECOVERY-RESULTS.md)。

- （Dot当前连接提示：原生截图保留在原实验工作区）
- （Muse当前连接提示：原生截图保留在原实验工作区）
- [恢复本地测试](../evidence/g0/session-grants/recovery-local-tests.txt)

- [预检门槛及回归测试](../evidence/g0/session-grant-local-tests.txt)：16项Node测试、5项Python测试通过。
- [本轮状态快照](../evidence/g0/session-grants/current-status.json)
- [公开合成探针服务记录](../evidence/g0/session-grants/probe-server.json)
- [受控恢复范围](PREFLIGHT-RECOVERY.md)
- `run-task-session.mjs` 准备新实例，`timed-store.mjs` 在两端认证重确认前拒绝启动。

以上结论针对当前账号、当前自定义连接器与运行路径。恢复轮已经完成任务级许可后的自动加密聊天验证；这不代表所有Muse场景、原生600秒许可TTL或生产级可靠性均已验证。
