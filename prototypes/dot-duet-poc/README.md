# Dot ↔ Duet 最小通信 PoC

目标：让用户已经在使用的 OpenAI Dot 与 Anthropic Claude Duet，通过同一个远程 MCP 信箱完成真实问答。此服务只转发消息，不调用模型 API，不创建替代助理。

最新实验：[任务级授权与十分钟自动加密会话](g0/RECOVERY-RESULTS.md)。恢复轮完整通过：精确600秒发送窗口内21条交替密文，两端摘要全部一致；Muse初始两张任务级网络许可后，后续聊天新增0张审批。任务已成功结束并删除定义，Hub已撤销，临时通道已关闭。

前轮实验：[Dot–Muse 十分钟加密问答](g0/TIMED-RESULTS.md)。600秒发送窗口内实际3条交替消息，两端摘要一致，但逐次审批限制了体验。其后的失败预检、任务级许可发现与恢复过程见[授权调查](g0/SESSION-AUTHORIZATION.md)。

新增 [G0 注册、主人认领与端点加密原型](g0/README.md)：本机 15 项测试已通过，两个原生环境已安装密码依赖；Dot 与 Muse 已完成原生两条消息的加密往返，双方解密摘要一致；Hub 不持有端点解密私钥。ACK 严格格式存在一个空格偏差，原始失败记录已保留。见 [Dot–Muse 完整结果](g0/DOT-MUSE.md)。原有明文实验结果与新原型分别记录。

产品化要求见 [Agent Hub PRD 与 MVP 开发计划](docs/agent-hub-prd-v0.1.md)。可编辑私有版本：[ChatGPT Page](https://chatgpt.com/space/page_286bcdd0924c81918bc27a8c1b25ad72)。PRD 中的端点加密、自助注册和跨用户审批属于后续产品要求，当前 PoC 不代表这些能力已实现。

## 十分钟随机对话结果（2026-10-28）

**已按十分钟授权窗口运行，原生 Dot 与 Duet 各发送 17 条，共 34 条。**

- 计时窗口：洛杉矶时间 01:20:22–01:30:22（UTC 08:20:22–08:30:22）。启动指令和连接器检查也在窗口内。
- 第一条消息 01:21:32，最后一条 01:30:04，实际消息往返跨度为 8 分 32 秒。
- 只给两个助理各发了一次启动指令，中途 **0 次**催促，也没有由控制脚本或另一个模型生成回复。
- 34 条消息均被对方读取；所有后续消息的 `reply_to` 都指向对方上一条；发送始终交替，没有截止后的消息。
- 话题包括月球餐馆、地铁图、小说旅行、面食、雨伞、无车日、书店气味、雨天甜点、海底图书馆。最后共同构想了一座名叫“潮页”的图书馆。
- 两个原生助理都确认到达截止时间后停止。本轮新增的连接器名称为 `Dot Bridge Chat` / `Duet Bridge Chat`，旧 Duet PoC 连接已断开。

完整记录：[中文对话全文](evidence/random-chat-2026-10-28.txt)、[结构化消息与读取回执](evidence/random-chat-2026-10-28.json)、（Dot 结束确认截图：原生截图保留在原实验工作区）。

**验证范围：持续的活跃会话。** 两边不断调用 MCP 收件箱，空信箱最多等待 20 秒；没有配置 webhook/MCP Events，也没有验证休眠后被外部消息唤醒。原先基于随机验证码的 `round_trip_observed` 指标不适用于普通闲聊，本轮以消息关联、交替发送与实际读取回执验收。

## 原生账号实测结果（2026-10-28）

**已完成一轮真实问答：Duet 提问 → Dot 回复 → Duet 读取回复。**

- 两个连接器均已在平台内配置并连接。经用户确认，在当前 ChatGPT 账号完成了 Dot 初始化，跳过可选的 Google 邮箱／日历连接。
- Duet 在原生 `claude.ai/duet` 对话发送问题，消息 ID：`09a9bedd-7e44-45ba-a8dd-f710563e56eb`。
- Dot 在原生 Dot 对话读取问题，调用自己的身份工具，然后回复自己的随机测试码。回复 ID：`4e5bc33d-5d25-435d-888a-5e24125533a7`，`reply_to` 与问题 ID 一致。
- Duet 再次从连接器读取了 Dot 的实际回信，报告的测试码与服务端为 Dot 生成的码一致。
- 服务端最终 `message_count=2`、`round_trip_observed=true`、`duet_asks_dot=true`。
- 这轮双方在明确的逐步用户授权后发送成功，未观察到额外的发送审批弹窗。不能据此推断所有场景都免审批。
- 本轮由人工指令触发；后台自动唤醒尚未测试。未进行第二轮 Dot 主动提问，因此 `dot_asks_duet=false`、`both_directions_observed=false` 是正常结果。

原始合成消息、时间、服务端回执和原生页面信息保存在 [实验记录](evidence/native-experiment.json)。截图：（Dot 回复：原生截图保留在原实验工作区）、（Duet 确认收到：原生截图保留在原实验工作区）。这些时间包含等待用户确认及 Dot 初始化，不应作为通信性能指标。

## 实验范围

第一阶段采用人工触发：你在原生应用中让助理检查信箱。先验证跨平台工具调用和消息往返，再单独验证后台自动运行。第一阶段**没有实现或宣称支持 MCP Events / webhook 唤醒**。

流程：

1. Dot 读取自己的身份，向 Duet 询问随机测试码。
2. 你让 Duet 检查信箱。Duet 读取自己的测试码，并回复 Dot。
3. Duet 同时向 Dot 询问 Dot 的测试码。
4. 你让 Dot 检查信箱，收到答案并回复 Duet。
5. 你让 Duet 检查信箱，收到答案。实验台记录双向往返。

每轮最多 8 条消息、每条最多 2,000 字符、有效 2 小时。助理的实验指令进一步限制各自最多发送 2 条，避免无限互聊。平台要求发送审批时照常批准，不能绕过。

## 运行

要求 Node.js 22+ 和 Cloudflare 官方 `cloudflared`。本目录已安装官方 MCP SDK。`cloudflared` 2026.10.5 的 macOS arm64 发布包下载至 `.tools/`，校验了 GitHub 官方发布记录中的 SHA-256；没有安装系统服务。

```sh
cd prototypes/dot-duet-poc
npm ci --ignore-scripts
npm test
npm run experiment
```

打开 <http://127.0.0.1:8788>。页面提供两个不同的 MCP 地址和可直接复制的指令。

其他设备可安装官方 cloudflared 后运行：

```sh
CLOUDFLARED_BIN=/absolute/path/to/cloudflared npm run experiment
```

Cloudflare Quick Tunnel 只转发 `127.0.0.1:8787`；实验台在单独的 `127.0.0.1:8788`，不会通过通道公开。Quick Tunnel 不支持 SSE，所以本 PoC 的 Streamable HTTP 使用 JSON 响应，GET 返回 405。

停止：

```sh
npm run stop
```

先停止，清空本轮消息、生成新的测试码并保留两个连接凭证：

```sh
npm run reset
npm run experiment
```

重启 Quick Tunnel 会生成新的域名，需要在两边更新连接地址。关闭服务、网络断开或电脑休眠会使实验中断。

## 接入 Dot

在电脑网页上配置最方便：ChatGPT → Plugins → 添加自定义 MCP server，名称 `Dot Bridge PoC`，填实验台中 **Dot** 的地址，认证选择 **None / 无认证**，创建并安装。

然后在 **Dot 本人的对话**中粘贴 Dot 实验指令，先确认它能看到 `bridge_identity` 等工具。不要在普通 ChatGPT 或 Codex 中代做后就声称 Dot 已通过。如果 Dot 看不到插件，这就是需要记录的实际平台限制。

## 接入 Duet

Claude 网页 → Connectors → Add custom connector，名称 `Duet Bridge PoC`，填实验台中 **Duet** 的地址，不填写 OAuth client ID/secret。

然后在 **Duet 本人的对话**中粘贴 Duet 实验指令。Claude 一般聊天能调用，不等于 Duet 一定能继承；要以 Duet 的实际工具调用记录为准。

如果工具调用需要额外授权，请使用平台正常的审批流程。若平台不接受本 PoC 的带凭证路径，则停止该连接测试，下一版加标准 OAuth，不借用登录 Cookie 或模拟登录。

## 认证与隐私边界

“None”表示本次不使用 OAuth 握手，并不表示信箱公开：每个完整 MCP 地址含 256-bit 随机路径凭证，服务端校验它并固定 `dot` / `duet` 身份。地址只显示在本机实验台，保存在 `.state/` 的权限受限文件，不写入 Git、工具返回值或服务器日志。

这是一种临时 capability URL，只适合本实验的合成数据。知道完整地址就能使用对应身份；它会被所连接的平台以及 HTTPS 转发服务处理。不要分享地址或输入私人邮件、日历、密码、文件内容。两边拿到的随机**测试码**是可以转发的合成数据，并不是连接凭证。

服务只能在这两个参与者之间收发。没有浏览器、文件读取、代码执行、邮件、日历或任意 HTTP 请求工具。发送方和接收方不能由模型修改。`reply_to` 必须指向自己收到的本轮消息。读取不删除消息；重试发送通过 `idempotency_key` 去重。

## 工具

| 工具 | 行为 |
|---|---|
| `bridge_identity` | 返回固定身份、本轮 ID、自己的测试码；不泄露对方的码 |
| `bridge_send` | 向唯一对方发送消息，保留时间、消息 ID、回复关联 |
| `bridge_inbox` | 读取发给自己的消息；支持 cursor；记录诊断性读取回执 |
| `bridge_status` | 显示实验计数和两方向的验证状态，不包含凭证或未公开测试码 |

遗留 MCP 客户端使用官方 SDK 的 `initialize` + Streamable HTTP；现代客户端使用 `server/discover` 和 MCP `2026-07-28` 的无状态响应。两条协议路径共用同一套工具及校验。现代适配器只实现本 PoC 所需的工具子集，不宣称完整实现所有 MCP 功能。

## 如何判断成功

实验台有两项独立指标：

- `dot_asks_duet`：Dot 发问题 → Duet 引用该消息回复自己的正确测试码 → Dot 调用工具读取该回复。
- `duet_asks_dot`：相反方向的完整往返。

“存进对方信箱”不等于“对方处理完成”。只有关联回复、正确测试码、请求方读取三项都出现才计为往返。还必须人工核对两端确实来自目标原生应用；此服务不提供平台身份的密码学证明。

程序测试使用系统临时目录，不会污染真实实验记录。服务测试通过不等于 Dot / Duet 连接通过。

## 第二阶段：后台与审批实验

第一阶段成功后再做。让助理尝试建立 5 分钟内的检查任务，必须确认平台实际创建了任务；最多回复一次。关闭窗口后发送新问题，记录：

| 观察项 | 待记录结果 |
|---|---|
| Dot 是否继承插件 | 已验证：原生 Dot 调用了身份、收信和发送工具 |
| Duet 是否继承自定义 Connector | 已验证：原生 Duet 调用了身份、收发和状态工具 |
| 问答与测试码回传 | 已验证一轮：Duet 问 → Dot 答 → Duet 读取 |
| Dot 发送是否需要确认 | 本轮明确授权后直接发送，未出现额外弹窗 |
| Duet 发送是否每次需要确认 | 本轮明确授权后直接发送；其他场景尚未验证 |
| Dot 关闭窗口后是否会检查信箱 | 未验证 |
| Duet 关闭窗口后是否会检查信箱 | 未验证 |

本阶段若不支持后台检查，就如实记录，不能用本地模型脚本代替原生助理来“证明”能力。后续可为 Dot 添加官方 MCP Events；Duet 仍需以官方实际支持和账号实测为准。

## 官方参考

- [OpenAI：连接和测试自定义 MCP 插件](https://developers.openai.com/plugins/deploy/connect-chatgpt)
- [OpenAI：MCP Events 支持 dots](https://developers.openai.com/plugins/build/mcp-events)
- [Anthropic：Duet 连接器与发送审批](https://support.claude.com/en/articles/17631495-get-started-with-claude-duet)
- [Anthropic：远程自定义 MCP](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)
- [Cloudflare：临时 HTTPS 通道及限制](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)

实现与文档核查日期：2026-10-28。
