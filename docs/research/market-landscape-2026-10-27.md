# Agent Hub 市场与平台接入研究

历史快照：2026-10-27。以下结论保留当时的公开资料调查范围；后续原生实验与最新实现状态见 PRD 和仓库主 README。公开目录审核、后台唤醒及当前商用许可没有因本项目实验而自动获得。

**有，已经有人做，而且有产品非常接近你说的“Agent Hub”。** 但我没有找到可核实的证据，证明已有成熟平台把 **Duet、Grok Bot、Dot、Muse 这四家的现成个人 Agent 全部接通，让普通用户开箱即用地互聊**。

截至 **2026 年 10 月 27 日**，公开资料显示：通信基础已经具备，真正复杂的是各平台的接入、消息唤醒、主人授权和上架审核。以下是官网、开发文档及条款调查，未做登录后的互通实测。

市场上最值得关注的是这些：

| 产品／项目 | 已经在做什么 | 与你的想法有多接近 |
|---|---|---|
| **AgentDM** | 给 Agent 分配 `@alias`，提供私信、群组、跨账户通信、Slack 双向同步，并桥接 MCP 与 A2A。官网有接入说明和演示，目前标为 Early Access。 | **最直接的竞品。** 官网列出 Claude、ChatGPT、Cursor 等兼容客户端，但这不能证明已打通 Duet、Dot 等具体个人 Agent。[官网](https://agentdm.ai/) |
| **AgentPub** | Agent 可以发现彼此，进入公共大厅、聊天室和私信；通过 MCP 或 REST API 收发消息。 | **很接近“Agent 之间打招呼”的网络。** 有公开接口文档，实际用户规模及四家兼容情况未核实。[官网](https://agentspub.ai/) |
| **Moltbook** | 面向 Agent 的社交网络，支持发帖、讨论、点赞，由人类认领自己的 Agent。 | 更偏 Agent 社区，可以作为社交方向的参照；不能据此认为四家个人 Agent 已原生互通。[官网](https://www.moltbook.com/) |
| **Fetch.ai Agentverse** | Agent 通信协议、地址及邮箱；邮箱可在 Agent 离线时暂存消息。 | 更偏开发者及服务型 Agent 网络，需要适配现有 Agent。[通信文档](https://innovationlab.fetch.ai/resources/docs/agent-communication/agent-chat-protocol)、[邮箱文档](https://uagents.fetch.ai/docs/agentverse/mailbox) |
| **Meta 的 Muse Network 计划** | Zuckerberg 在 10 月 21 日财报电话会上描述：让你的 Muse 与朋友、家人的 Muse 协作，并与商家的 Agent 交流。 | **与你设想的个人 Agent 网络高度重合。** 目前这份材料描述的是计划，未承诺向 Duet、Dot、Grok Bot 开放。[电话会实录](https://stockanalysis.com/stocks/meta/transcripts/718643-q3-2026/) |

此外，底层标准和基础设施也有人在做：**A2A** 解决不同框架 Agent 的发现与任务通信；**AGNTCY** 提供发现、身份、消息及可观测性；**ANP** 和 **MIT NANDA** 探索开放 Agent 网络。这些可以成为 Hub 的基础，但采用协议本身并不会自动获得某家个人 Agent 的接入权。[A2A](https://a2a-protocol.org/)、[AGNTCY](https://agntcy.org/)、[ANP](https://www.agent-network-protocol.com/)、[NANDA](https://www.media.mit.edu/groups/nanda/overview/)

关于各家公司是否允许，**公开资料支持“在用户授权下，通过官方扩展机制接入”，不能理解为允许第三方随意控制用户的 Agent。**

| 平台 | 官方支持的接入路径 | 对 Agent Hub 的实际意义和限制 |
|---|---|---|
| **Grok Bot** | 支持添加自定义 MCP；Routine 可以由 **webhook** 触发，并把请求内容交给 Bot。 | **收消息后自动开始工作的路径很明确。** 条款允许授权范围内的自主操作和第三方服务交互，同时要求遵守对方条款、权限和人工审核要求。[MCP 接入](https://docs.x.ai/grok-bot/computer-and-apps)、[Webhook](https://docs.x.ai/grok-bot/skills-routines-and-automations)、[条款 §2–3](https://x.ai/legal/grok-bot-terms) |
| **OpenAI Dot** | **MCP Events 明确支持 dots**：用户指定监听什么事件、如何处理，服务器通过 webhook 投递。 | **有官方的事件触发基础。** Hub 可以研究“收到联系人消息”的订阅；公开上架还要经过插件规则审查。官方明确不批准主要充当非官方第三方连接器、包括透传中间层的插件，因此必须厘清服务授权及产品边界。[MCP Events](https://developers.openai.com/plugins/build/mcp-events)、[插件规则](https://developers.openai.com/plugins/plugin-guidelines) |
| **Anthropic Duet** | 使用 Claude 账户的连接器和插件；Claude 允许用户接入自建远程 MCP。 | **存在工具接入路径，但不能承诺持续自动互聊。** Duet 文档要求发送消息前取得批准；本次没有找到 Duet 专用的通用入站消息／webhook 接口文档。[Duet 文档](https://support.claude.com/en/articles/17631495-get-started-with-claude-duet)、[自定义 MCP](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp) |
| **Meta Muse** | 用户可以让 Muse 为未上架服务创建 **Custom Connector**；进入官方目录则需提交审核。 | **私人接入和公开分发都有路径。** 官方目录 Connector 的敏感写操作必须逐次批准。Agent 消息发送如何分类、能否主动唤醒 Muse，需要进一步确认，不能由“支持 Connector”直接推断。[自定义连接器](https://www.meta.com/help/superintelligence/1687253048996149/)、[审核与权限规则](https://platform.muse.ai/docs) |

有三处边界会直接影响这个产品能不能成立：

- **模型互聊和用户的个人 Agent 互聊，是两种接入。** 调用 Claude、GPT、Grok 的模型 API，并不会自动接入用户已有的 Duet、Dot、Grok Bot 的记忆、账户权限和身份。竞品说“支持 Claude ↔ OpenAI”时，需要核实它指的是哪一种。
- **能收发消息，还要能唤醒接收方。** Grok Bot 的 webhook 和 Dot 的 MCP Events 已有明确文档；另外两家的同等能力，本次没有得到充分确认。普通 MCP 的收件箱工具本身不能保证 Agent 在无人操作时处理新消息。
- **用户同意连接，不等于所有后续行动都获准。** 例如 Anthropic 消费者条款 §3.7 限制未经明确许可的自动化访问；Meta 要求 Connector 数据仅用于必要用途，禁止拿去做无关画像或模型训练。跨 Agent 转发时，接收方的数据处理也要符合这些限制。[Anthropic 条款](https://www.anthropic.com/legal/consumer-terms)、[Meta 数据规则](https://platform.muse.ai/docs)

**如果你是在评估创业机会，我会把 AgentDM 作为第一竞品，把 Muse Network 作为需要持续关注的平台竞争者。** 潜在差异点可以放在：用户带着已有个人 Agent 加入、验证 Agent 属于谁、双方授权后建立联系人关系，以及跨平台消息的可靠送达和处理。

第一轮验证可以选 **Grok Bot ↔ Dot**：双方主人连接 Hub，授权两个 Agent 打招呼、交换指定信息、返回结果。两边都有官方事件入口，适合先验证完整闭环；Duet 和 Muse 则分别补做消息审批、入站触发和 Connector 审核验证。**目前有依据说这条路线值得做原型，还没有依据承诺“四家全自动互通、均获官方允许”。**
