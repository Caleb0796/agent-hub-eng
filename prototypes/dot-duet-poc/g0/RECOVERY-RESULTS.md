# Dot–Muse 任务级授权与十分钟加密会话：恢复轮结果

2026-10-28，America/Los_Angeles。

**本轮完整通过：两端预检成功后，Dot 与 Muse 在600秒发送窗口内自动交换21条密文；每条消息的两端明文包摘要一致。Muse只在开始时批准两类网络动作，聊天过程中没有新增逐条审批，也没有为本轮主机设置永久站点放行。**

会话：`431065b8-fd21-4f1c-b41a-dc197cec8a69`。Muse一次性任务：`agent-hub-chat-431065b8`。新连接：Dot Muse Recovery Session / Agent Hub Recovery Session。

## 实测结果

| 项目 | 结果 |
|---|---|
| 发送窗口 | 16:24:04.774–16:34:04.774，精确600秒 |
| 接受消息 | Dot 11条、Muse 10条，共21条，始终交替 |
| 最后一条被接受 | 16:33:40.907，早于截止 |
| 解密验收 | 21/21条发送方与接收方的完整明文包SHA-256一致 |
| 密文验证 | 全部签名、角色、会话ID、序号、回复链及有效期检查通过；无关私钥均无法解密 |
| Muse初始审批 | 连接与POST `/mcp` 两张卡，均为 `Allowed for this scheduled task`，绑定本轮新任务 |
| 后续审批 | 重确认、轮询和聊天全程新增0张，无逐次Allow once操作 |
| 本轮全局许可 | 原生核查未发现本轮主机的全局站点或session规则 |

两端沿用既有端点加密密钥、互信与已批准源码，SHA-256为 `d3f9286d62e951aa32463c7352ff0d0b45aaaf625d34456f8cc428becaf26574`。正文只在两个原生端点内处理，Hub接收签名密文。本机验收只使用两端回执中的消息ID和完整明文包摘要，不取得正文、nonce或端点私钥。

## 修复与预检

Muse专用MCP客户端增加显式请求等待参数和脱敏阶段诊断；默认180秒，首次身份查询使用600秒。保留默认代理处理、TLS验证、Secure Vault和单次sessionless POST，不增加重试。Muse报告52项mock检查、语法检查和本地TLS失败阶段检查通过；本机16项Node、5项Python回归测试通过。

本轮Muse身份查询完整返回HTTP200，约103秒；注册重确认完整返回HTTP200，约0.6秒、状态claimed；后续状态轮询成功且未再次审批。Dot两步预检同样成功。只在这些结果确认后才启动聊天。修复后本轮成功，不等于已独立确定上一轮传输失败的唯一根因。

## 到期与清理

- Hub于16:34:04.774关闭发送窗口；到期后没有接受任何新消息。
- Dot回执停止时间16:34:09.828。Muse于16:35:24完成剩余密文的摘要验收，最后收到的第11条只解密验收，没有回复。清理耗时不计入发送窗口。
- Muse通过官方remove成功删除本轮任务定义；最终状态为succeeded，16:36:57结束，`enabled=false`、`next_run=null`、`in_flight=false`，运行中和排队数量均为0。
- Hub会话已撤销；临时通道于16:37:50关闭，进程退出已验证。
- 本轮中转状态及通道日志未发现明文包字段或端点私钥标记。字符串扫描仅为辅助证据，主要依据是已固定端点代码、签名密文和两端独立摘要的逐条匹配。

这是**任务级许可 + Hub硬截止 + 任务删除**的组合验证。没有证实Muse提供可直接设置600秒TTL的原生许可对象；初次连接配置和两张初始网络许可仍是需要完成的步骤。旧G0主机原有的两条许可记录未被本轮修改。这里的结论限于本次原生账号、连接器及活跃会话，不代表后台唤醒、多用户隔离或生产级可靠性已完成。

## 证据

- [逐条密码与摘要验收](../evidence/g0/session-grants/recovery-audit.json)
- [两端原生回执](../evidence/g0/session-grants/recovery-manifests.json)
- [已审计的密文中转记录](../evidence/g0/session-grants/recovery-relay.json)
- [最终状态与审批计数](../evidence/g0/session-grants/recovery-status.json)
- [存储与通道清理检查](../evidence/g0/session-grants/recovery-storage-check.json)
- （Muse任务许可截图：原生截图保留在原实验工作区）
- （Muse任务关闭截图：原生截图保留在原实验工作区）
- （Dot原生回执截图：原生截图保留在原实验工作区）
- [本机回归检查](../evidence/g0/session-grants/recovery-local-tests.txt)

前轮失败和授权边界保留在[调查记录](SESSION-AUTHORIZATION.md)，未覆盖历史失败证据。
