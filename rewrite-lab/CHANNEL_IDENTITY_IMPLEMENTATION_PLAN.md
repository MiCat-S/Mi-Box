# MiBot 频道身份命令认证与回复身份实施计划

- 状态：等待实机取证后进入实现
- 编制日期：2026-09-08
- 适用仓库：`TeleBox-Core`、`TeleBox-Plugins`
- 文档范围：认证方案、实验准备、实现步骤与验收标准

## 1. 结论与安全边界

目标是让登录 MiBot 的账号本人，在群内选择“自己创建的频道”作为发送身份时仍能执行命令，同时保持现有个人身份和收藏夹命令行为。

正式实现必须同时证明两件事：

1. 显示为发送者的频道确实由当前登录账号创建；
2. 当前这一条命令消息的真实操作者确实是当前登录账号，而不是共享该频道身份的另一名管理员。

频道所有权只能回答第一项，不能回答第二项。因此，以下信息都不能单独签发命令权限：

- `message.out`；
- `MessageEnvelope.senderId` 是某个频道；
- 本地维护的 `ownedChannelIds` 或启动时遍历结果；
- `channels.getSendAs` 返回该频道；
- 当前账号是目标群或发送频道的管理员。

候选的逐消息证据是目标群管理日志中的发送/编辑事件：事件的 `user_id` 必须等于当前登录账号 ID，事件内消息必须与当前命令的目标会话、消息 ID 和当前内容相对应。该机制目前只有协议结构依据，没有真实 Telegram 行为证据。实机实验必须先于正式权限实现；若实验不能稳定得到充分证据，对应场景应明确为“不支持”，不得退化为频道白名单、`out` 或所有权缓存放行。

本功能只扩展命令的可信“操作账号”，不改变消息作者字段：

- `message.senderId` 始终保留 Telegram 展示出来的实际 peer；
- 不把频道 ID 写入 owner/sudo 名单；
- 不把频道消息伪装成 `senderId === selfId`；
- 可信操作账号只存在于 Core 私有、命令生命周期内的记录中；
- 监听器中基于 `senderId` 的用户统计、抽奖创建者、审核对象等语义保持原样。

插件与 Core 运行在同一进程，插件不是安全沙箱。私有 `WeakMap` 能防止普通对象复制或结构伪造获得命令权限，但不能约束恶意同进程代码、原生客户端访问或任意进程权限。实现与验收不得把它描述成插件隔离边界。

## 2. 当前基线与已核实事实

### 2.1 仓库基线

计划编制时的只读核验结果：

| 项目 | 基线 | 工作区状态 |
| --- | --- | --- |
| Core | `7eec2122e9ede46fb66b26b8497c79a185b597ed`，`main` 相对 `origin/main` ahead 2 | 无未提交文件 |
| Plugins | `d5af08db8569a9e7c3241756e7d81c3cbc8120de`，`codex/telebox-runtime-v2` | 无未提交文件 |
| Node | `/tmp/telebox-node24.4ggax9/node-v24.20.0-darwin-arm64/bin/node` | `v24.20.0`，当前仍存在 |
| Teleproto | `package-lock.json` 固定为 `teleproto@1.229.0` | 类型中具备本计划涉及的 TL 类与 `sendAs` 参数 |

此前“1260 项、1259 通过、1 项平台跳过”是已有完整回归记录，不是本功能测试证据。频道身份功能当前没有业务源码改动，也没有真实 Telegram 实验结果。

UI、IP 隐私改动与 Google GT 的发布/部署状态不属于本计划，不得在本功能实验、实现或回滚中改变。

### 2.2 当前消息与权限链路

已从源码核实：

1. `src/v2/telegram.ts`
   - `messageEnvelope` 优先从 `raw.fromId` 生成 `senderId`；频道 peer 变为 `-100...`；
   - `outgoing` 直接来自 `raw.out`；
   - 原始 `Api.Message` 保留在 `raw`；
   - `edited`、`forwarded`、`saved` 已分别记录；
   - `edit` 编辑原消息；`reply` 新发回复，但当前没有显式 `sendAs`；
   - `TeleprotoPort.withClient` 在 RPC 前后检查取消信号，但 RPC 本身不接收 `AbortSignal`。
2. `src/v2/host.ts`
   - `dispatchPrimary` 当前先要求 `outgoing || saved`；
   - 再解析已注册命令、前缀与别名并执行编辑过滤；
   - 随后克隆并冻结 `MessageEnvelope`，进入按 `chatId` 串行的 `KeyedExecutor`；
   - `dispatchListeners` 是单独路径。
3. `src/v2/permissions.ts`
   - `isOwner`、`requireOwner`、`isPrivileged` 最终依赖 `message.senderId === ownerId`。
4. `src/v2/runtime.ts`
   - 登录后从 `getMe()` 得到可信 `selfId`；
   - 构造 `TeleprotoPort`、`PluginHost` 后订阅新消息和编辑消息；
   - 每条事件先 `dispatchPrimary`，再 `dispatchListeners`。
5. Core 直接 owner 检查
   - `privacy`、`tpm`、`update`、`restart`、`sudo`、`sure`、`exec`、`bf` 已统一或间接使用权限函数；
   - `src/v2/builtins/help.ts` 的 `name` 设置仍直接比较 `senderId !== ownerId`，实现时必须改用统一可信身份；
   - 普通命令没有额外 owner 检查，依赖 Host 的主命令准入。
6. Plugins
   - 当前 115 个含 `definePlugin` 的 V2 入口文件也都使用了标准 `telegram.edit/reply`；一个文件可能注册多个命令，因此这里是文件数，不是命令总数；
   - `TeleBox-Plugins/sure/v2.ts` 直接将 `senderId` 与 `getMe().id` 比较，属于必须迁移的 owner 权限判断；
   - `lottery/v2.ts` 等对 `senderId` 的“活动创建者/消息作者”比较属于业务作者语义，不应批量替换；
   - 有 56 个 V2 文件包含原生 `client.sendMessage/sendFile/editMessage` 候选调用，必须逐调用区分“当前命令会话输出”“外部 bot 交互”“后台通知”“监听器输出”。

### 2.3 官方协议事实

以下是协议页面能直接支持的事实，不等同于实机可靠性结论：

- [`message.out`](https://core.telegram.org/constructor/message) 只说明消息是 outgoing；页面没有把它定义为匿名/频道身份背后的真实操作者证明。
- [`channels.getAdminLog`](https://core.telegram.org/method/channels.getAdminLog) 读取频道/超级群管理日志，仅用户账号可调用；目标会话需要管理员权限，可能返回 `CHAT_ADMIN_REQUIRED`、`CHANNEL_PRIVATE` 等错误。
- [`channelAdminLogEvent`](https://core.telegram.org/constructor/channelAdminLogEvent) 包含事件 `user_id` 和 `action`。
- [`channelAdminLogEventActionSendMessage`](https://core.telegram.org/constructor/channelAdminLogEventActionSendMessage) 包含被发送的原消息。
- [`channelAdminLogEventActionEditMessage`](https://core.telegram.org/constructor/channelAdminLogEventActionEditMessage) 包含 `prev_message` 与 `new_message`。
- [`channelAdminLogEventsFilter`](https://core.telegram.org/constructor/channelAdminLogEventsFilter) 有 `send` 与 `edit` 过滤项；其中 `send` 的官方描述是“频道中发布了一条消息”，是否涵盖超级群中以频道身份发言必须实测。
- [`channels.getParticipant`](https://core.telegram.org/method/channels.getParticipant) 可查询频道/超级群参与者；[`channelParticipantCreator`](https://core.telegram.org/constructor/channelParticipantCreator) 带创建者 `user_id`。
- [`channels.getSendAs`](https://core.telegram.org/method/channels.getSendAs) 返回目标会话可使用的发送身份；它能说明上下文可用性，不能说明某条消息由谁操作。
- 本地 `teleproto@1.229.0` 的 `sendMessage` 与 `sendFile` 支持 `sendAs`；`editMessage` 参数没有 `sendAs`。库具有参数不代表 Telegram 服务端在所有目标会话中接受该身份，仍须实验。

### 2.4 尚未解决的问题

下列项目在实机前一律标记为“未知”：

- 本账号从不同官方客户端以频道身份发言时，MiBot 会话收到的 `out` 是否始终一致；
- 第二名管理员使用同一频道身份时，本账号收到消息的 `out` 值；
- 超级群中这类消息是否产生 `ChannelAdminLogEventActionSendMessage`；
- 日志事件出现的延迟、偶发缺失、重复、排序与分页行为；
- 消息事件和日志内消息能否稳定以 `(peer, message.id)` 关联；
- 编辑事件是否能可靠指出最后一次编辑者，并与当前内容一致；
- 频道身份回复、发文件时显式 `sendAs` 的行为，以及编辑原消息是否始终保留展示身份；
- MiBot 不是目标群管理员时是否存在别的、同等强度且合规的逐消息证据。目前没有候选证据。

## 3. 总体决策门

实施按以下顺序推进：

```text
已注册命令候选
  ├─ 个人身份/收藏夹现有路径 ──> 签发 direct-account 命令身份
  └─ 频道展示身份
       ├─ 发送频道由 self 创建？── 否 -> 拒绝
       ├─ 该频道可在目标会话 send_as？── 否/未知 -> 拒绝或无法判定
       ├─ 本条消息的管理日志 actor == self？── 否/缺失 -> 拒绝或无法判定
       └─ 回复路径能维持展示身份且命令已审计？── 否 -> 该命令/会话暂不支持
                                                是 -> 签发 owned-channel 命令身份
```

“拒绝”表示证据明确不满足，例如频道不是 self 创建或日志 actor 是其他用户。“无法判定”表示 RPC 权限不足、超时、日志缺失、协议形状不符或证据相互冲突。两者对命令执行的外部结果相同：不执行。内部只记录不含消息正文的原因码，以便观察，不把异常当作允许。

进入正式实现的必要门槛：

1. 至少完成第 5 节实验矩阵中的正例、第二管理员反例、编辑反例和目标群非管理员反例；
2. 正例能在预定上限内稳定得到唯一、可关联、actor 为 self 的证据；
3. 反例不会获得同样的 self 证据；
4. 回复身份实验能给出不泄露个人身份的明确实现路径；
5. 若任一核心条件不成立，则记录“不支持的场景”，停止对应实现分支。

## 4. 阶段化执行计划总表

| 阶段 | 输入 | 操作 | 产出证据 | 通过条件 | 失败分支 |
| --- | --- | --- | --- | --- | --- |
| 1. 基线与协议核对 | 两仓库、官方 TL 文档、锁定依赖 | 复核指令、SHA、工作区、消息/权限/回复链路和库类型 | 基线表、源码位置、官方链接 | 事实与假设分离，无生产变更 | 基线漂移则重做差异审阅并更新计划，不覆盖用户改动 |
| 2. 实验工具准备 | 私有测试拓扑、现有本地会话、Node 24 | 编写仅用于 `rewrite-lab` 的取证 probe 与结构化结果 schema | probe 源码、离线单测、字段白名单 | 不记录正文/密钥，默认 dry-run，真实发送需显式开关 | 会话或协议库不兼容则只保留只读采集并停止发送步骤 |
| 3. 实机实验 | 用户一次性提供的测试资源与本次授权 | 按矩阵发、改、转发合成消息；读取事件、所有权、send-as 与管理日志 | 脱敏 JSONL、用例结果表、延迟统计 | 正反例区分稳定，证据链完整 | 缺日志、权限不足、冲突或不稳定均记无法判定，不推断可靠 |
| 4. 技术决策 | 实验报告 | 评审 actor 证明、性能、权限覆盖与回复身份 | ADR/实验结论 | 只批准已证实的场景 | 证明不可得则声明该场景不支持，不做频道白名单回退 |
| 5. Core 实现 | 批准的证据规则 | 增加私有命令身份、频道 verifier、Host 队列内认证、统一权限读取 | Core diff 与单元/集成测试 | 个人行为兼容，频道正例允许，所有反例拒绝 | 任一越权/回归则 feature flag 默认关闭并回滚 Core |
| 6. 回复与插件迁移 | 已证实的 edit/reply/sendFile 行为 | 中央化显式 send-as；逐个分类原生发送出口；迁移 owner 直比 | 出口清单、插件 diff、身份验收 | 所有已开放命令均不会静默以个人身份新发消息 | 无法维持身份的命令保持禁用或 edit-only |
| 7. 回归、灰度与发布 | Core 与插件候选制品 | 离线全回归、私有群验收、分阶段发布与回滚演练 | 测试报告、灰度观察、回滚记录 | 验收项全部通过且获得新的发布授权 | 本轮不部署；未来任一指标异常先关功能再回滚 |

## 5. 实机取证设计

### 5.1 测试拓扑与前置条件

只使用专门的私有测试资源：

- A：运行 MiBot 的测试账号，也是待测频道的创建者；
- B：可配合的第二名管理员，能够在测试群选择与 A 相同的频道身份；
- C：A 创建的测试频道，用作 send-as 身份；
- D：A 仅管理但不是创建者的测试频道，用于所有权反例；
- G1：A/MiBot 是管理员的私有测试超级群；
- G2：A/MiBot 不是管理员的私有测试超级群，用于日志权限反例；
- A1/A2：A 的两个客户端，用于同账号多客户端一致性。

若没有 B 或 D，可以先完成其余用例，但不得据此宣称防住共享身份越权；正式实现门槛仍未满足。不得用生产群、真实用户消息或既有部署授权代替本次实验授权。

用户不需要在对话中提交 API ID、API hash、session string、登录验证码或任何密钥。优先使用已在本机配置并由用户指定的测试会话；若没有，由用户在本地按现有登录流程创建测试会话，敏感值不进入实验报告。

### 5.2 合成消息与数据最小化

每条消息使用唯一标记，例如 `MIBOT-CID-<run-id>-<case-id>-<sequence>`。除测试命令标记和无害固定文本外不发送内容。

允许持久化的最少字段：

```ts
interface ProbeRecord {
  runId: string;
  caseId: string;
  observedAt: string;
  source: "message-event" | "admin-log" | "participant" | "send-as" | "response";
  peerId?: string;
  messageId?: number;
  fromPeerId?: string;
  out?: boolean;
  edited?: boolean;
  forwarded?: boolean;
  eventId?: string;
  actorUserId?: string;
  actionClass?: string;
  actionMessageId?: number;
  actionPeerId?: string;
  creatorUserId?: string;
  sendAsPeerIds?: string[];
  latencyMs?: number;
  attempt?: number;
  rpcErrorCode?: string;
  contentDigest?: string; // 只对合成文本做 SHA-256，不保存正文
}
```

禁止收集或输出：

- 无关聊天正文、媒体内容、成员列表和群历史；
- session、API hash、登录验证码、cookie、token、环境变量值；
- 原始 RPC 对象的全量序列化；
- 非匹配管理日志事件中的消息正文。

管理日志 RPC 可能在内存中返回附近事件。probe 与生产实现只能抽取白名单元数据，立即丢弃正文；实验结束后由用户确认再清理合成消息或结果文件。消息删除本身仍属于实机副作用，必须包含在当次明确授权中。

### 5.3 实验矩阵

表中“允许/拒绝”是安全期望，不是对 Telegram 当前行为的预判。“无法判定”最终也不得执行命令。

| ID | 操作者与输入 | 变体 | 期望 | 必查证据 |
| --- | --- | --- | --- | --- |
| P1 | A 以个人身份在 G1 发命令 | A1 | 允许，沿用个人路径 | `from=self`、现有 envelope/Host 行为 |
| P2 | A 以个人身份在 G1 发命令 | A2 | 允许 | 与 P1 一致，不依赖频道 RPC |
| P3 | A 在收藏夹发普通命令 | 新消息 | 允许 | 保持 `saved` 兼容 |
| C1 | A 以 C 身份在 G1 发命令 | A1 | 证据充分才允许 | C 的 creator=self；匹配日志 actor=self；C 在 send-as 上下文可用 |
| C2 | A 以 C 身份在 G1 发命令 | A2 | 同 C1 | 多客户端字段、日志与延迟一致性 |
| C3 | A 以 C 身份快速连续发多条命令 | 同 chat | 允许且保持消息顺序 | 日志关联无串线；现有 chat 队列顺序不变 |
| C4 | A 以 C 身份在两个测试群并发发命令 | 跨 chat | 各自独立判定 | creator RPC 可在途去重；消息日志按 peer 隔离 |
| N1 | B 以同一个 C 身份在 G1 发相同命令 | 与 C1 文本相同 | 拒绝 | 匹配事件 actor=B，不得因 C 属于 A 而放行 |
| N2 | A 以 D 身份在 G1 发命令 | A 是管理员非创建者 | 拒绝 | `GetParticipant(D,self)` 不是 Creator |
| N3 | 任意人以非 A 创建的频道身份发命令 | 新消息 | 拒绝 | creator 证明失败 |
| E1 | A 以 C 发消息后由 A 编辑为命令 | 命令允许 edited 时 | 仅在原发送 actor 与最新编辑 actor 均为 A 时允许 | send + 最新 edit 事件、当前内容摘要一致 |
| E2 | A 以 C 发消息后由 B 编辑为命令 | 相同频道身份 | 拒绝 | 最新匹配 edit actor=B |
| E3 | B 以 C 发消息后由 A 编辑为命令 | 编辑他人消息 | 拒绝 | 原 send actor=B，即使 edit actor=A 也不允许 |
| E4 | A 以 C 发命令后出现多次交错编辑 | A/B/A | 仅以完整事件序列和当前内容判断；冲突则拒绝 | 最新内容、actor 顺序、重复/排序 |
| F1 | A 手动转发合成命令文本 | 以 C 展示或保留来源 | 拒绝频道身份认证 | `fwdFrom`/`forwarded`，不把来源当操作者 |
| F2 | 合成频道帖子自动转发到已有的测试关联群 | 仅已有拓扑 | 拒绝 | 转发字段、事件 action，不绕过匿名机制；不为实验新建关联关系 |
| AN1 | A/B 使用匿名群管理员身份 | 群自身身份 | 默认拒绝，范围外 | sender peer 与目标群相同或匿名身份；不等同于外部自有频道皮套 |
| S1 | A 以 C 在 G2 发命令 | MiBot 非目标群管理员 | 无法判定并拒绝 | `CHAT_ADMIN_REQUIRED` 等精确错误 |
| S2 | C 不在 `getSendAs(G1)` 结果中 | 上下文变化/权限撤销 | 拒绝 | send-as 上下文不一致 |
| R1 | 管理日志事件延迟出现 | 多轮轮询 | 上限内出现才可继续 | 每次查询时刻、首次命中延迟、总 RPC 数 |
| R2 | 管理日志缺失 | 到达上限仍无匹配 | 无法判定并拒绝 | 明确 `no-correlated-event`，不回退 |
| R3 | 管理日志返回重复匹配事件 | 相同 actor/相同消息 | 可归一化为一个证据 | 重复数；内容和 actor 必须一致 |
| R4 | 管理日志出现冲突匹配 | actor/内容不一致 | 拒绝 | `conflicting-evidence` |
| R5 | RPC 权限、FloodWait、网络错误 | 各类失败 | 无法判定并拒绝 | 错误类、次数、耗时；不记录服务器文本中的敏感内容 |
| O1 | 已认证频道命令仅编辑原消息 | 成功/失败 | 成功时仍显示 C；失败不得改为个人新发 | 编辑后展示身份与消息 ID |
| O2 | 已认证频道命令新发 reply | 显式 `sendAs=C` | 只在仍显示 C 时开放 | 返回消息 `fromId`、服务端错误、目标 topic/reply |
| O3 | 已认证频道命令 sendFile | 显式 `sendAs=C` | 只在仍显示 C 时开放 | 文件消息 `fromId`、caption、reply/topic |
| O4 | O2/O3 的 `sendAs` 被撤销或失败 | 失败 | 不得静默以个人身份重试 | 无个人身份消息，错误可通过安全 edit 呈现 |

大多数命令默认 `ignoreEdited: true`。E1–E4 仍要用专门 probe 或一个明确允许编辑的合成命令验证，因为未来存在 `ignoreEdited: false` 命令；正式 verifier 对编辑消息不能只复用原始发送事件。

### 5.4 实验步骤

1. **只读预检**
   - 记录 A、B、C、D、G1、G2 的测试标签与 peer ID；
   - 用 `getMe()` 确认当前会话是 A；
   - 用 `GetParticipant(C,A)`、`GetParticipant(D,A)` 记录 Creator 正反例；
   - 用 `GetSendAs(G1/G2)` 只记录 peer ID 列表；
   - 不发送消息。
2. **事件采集校准**
   - probe 订阅 `NewMessage` 与 `EditedMessage`；
   - A1、A2 依次发送个人身份合成消息；
   - 仅记录第 5.2 节字段，确认 message ID、peer 和客户端动作能对应。
3. **频道身份正例**
   - A1、A2 分别以 C 发送唯一合成命令；
   - 从收到消息时刻开始查询 G1 管理日志；
   - 首轮建议 `eventsFilter: {send: true}`、`q: ""`、`maxId/minId: 0`、小 `limit`；新消息实验比较不带 `admins` 和仅带 A 的两种查询。编辑消息必须观察未按 actor 过滤的相关 send/edit 事件，否则无法证明“最后一次编辑者”；
   - 按 `(target peer, message.id, current content digest)` 关联 send action，记录 event actor 与首命中延迟。
4. **共享身份反例**
   - B 用同一 C 发送相同格式、不同唯一标记的消息；
   - 验证事件 actor 是否为 B；
   - 比较 A 端 `out/fromId/senderId` 与 C1/C2，明确这些字段能否作为候选过滤器，但不作为最终证明。
5. **编辑与转发**
   - 严格按 E1–E4、F1–F2 执行；
   - 查询 `send:true, edit:true`，关联 `action.message` 或 `action.newMessage`；
   - 当前内容必须与最新 edit 的 `newMessage` 一致；原始 send actor 和最新 edit actor 均为 A 才能成为编辑消息正例。
6. **错误与边界**
   - 在 G2 验证管理日志权限错误；
   - 若现有测试拓扑自然存在“不含 C”的目标会话则验证 S2；否则只用离线 fixture 覆盖，不为实验改变频道或群权限；
   - 用合成消息模拟重复结果、乱序数组和冲突证据，真实 FloodWait 不主动制造。
7. **回复身份**
   - 对已证明由 A 操作的 C 消息测试原消息 edit；
   - 分别测试 `sendMessage(..., {sendAs: C})` 和 `sendFile(..., {sendAs: C})`；用未列入 send-as 的测试 peer 触发 O4 错误，不撤销真实权限；
   - 测试 topic、普通回复、分页第二条、新文件与发送身份失效；
   - 检查界面展示与返回 raw message，不以“API 调用成功”代替身份验收。
8. **清理与报告**
   - 仅在本次授权包含删除时删除合成消息；
   - 输出每个 case 的 `allow/reject/indeterminate`、证据、延迟和限制；
   - 清理动作失败不影响取证结论，但需在报告中列出剩余测试消息 ID。

### 5.5 延迟与可靠性判定

每个正例至少重复 20 次，覆盖 A1/A2 和低频/短突发；N1 至少重复 10 次。样本量用于发现明显不稳定性，不代表 Telegram 的服务等级承诺。

记录 `min/p50/p95/max` 首命中延迟、缺失率、重复率、冲突率与 RPC 错误率。生产轮询参数只能根据实验数据确定，并满足：

- 有固定的最大查询次数、每次最大结果数和总观察窗口；
- 不通过无限轮询等待日志；
- 达到上限后返回 `indeterminate/no-correlated-event`；
- 不以 `Promise.race` 提前遗留仍在运行的共享客户端 RPC；
- 当前 Teleproto RPC 不原生接受 `AbortSignal`，所以“有界”首先保证请求数和结果量有界。严格墙钟超时只有在底层 RPC 自身能终止时才能承诺；关闭流程必须等待已经开始的 RPC 真实结束。

若正例存在任何无法解释的 actor 错配，或管理日志在正常条件下仍有非零缺失且没有另一项同强度证明，则该场景不进入实现。

## 6. 证据驱动的技术决策

实验完成后生成一份 ADR，至少回答：

1. `ActionSendMessage` 是否覆盖 G1 中 send-as C 的消息？
2. `(peer,message.id)` 是否唯一且足够关联？是否还需当前内容摘要/日期窗口？
3. 第二管理员的 actor 是否稳定为 B？
4. 编辑消息需要哪些 send/edit 事件组合？
5. 新消息生产查询是否可使用 `admins:[self]`；若只查 self，未命中统一归类为无法判定而非“他人发送”。编辑消息不得仅查 self 后把较早的 self edit 当作最新 edit；若不能安全取得完整相关顺序，就不支持编辑触发频道命令。
6. 选定的轮询次数、limit 和总窗口是什么，依据哪些延迟数据？
7. 目标群非管理员、广播频道、forum topic、匿名群身份分别支持到什么程度？
8. edit/reply/sendFile 哪些路径能保持频道身份？

批准规则：

- **充分**：频道 creator=self，send-as 上下文一致，且唯一匹配的逐消息事件 actor=self；编辑消息还需原 send 与最新 edit 均符合；
- **明确拒绝**：creator 不是 self、send-as 不包含该频道、匹配事件 actor 不是 self、消息为转发/自动转发、匿名群身份不在批准范围；
- **无法判定**：无管理日志权限、无匹配事件、超出观察窗口、RPC/解析错误、证据冲突；
- **行为**：只有“充分”签发命令身份，其余均不执行。

如果管理日志不能形成可靠逐消息证明，ADR 的结论应是“当前 Telegram/Teleproto 组合下暂不支持频道身份命令”。可保留只读 probe 与实验报告，不能实现弱化放行。

## 7. Core 代码方案

本节是通过第 6 节决策门后的目标接口。名称可以按代码评审微调，但安全语义不可弱化。

### 7.1 `src/v2/command-identity.ts`

新增 Core 私有的命令身份能力，不从 `telebox/sdk` 导出写入函数：

```ts
export type TrustedCommandIdentity = Readonly<{
  accountId: string;
  kind: "direct-account" | "owned-channel";
  authorPeerId: string;
  sendAsPeerId?: string;
  evidence: "personal-sender" | "saved-messages" | "admin-log-send" | "admin-log-send-edit";
}>;

const trusted = new WeakMap<MessageEnvelope, TrustedCommandIdentity>();

// 仅 Core Host/认证器可调用；拒绝重复写入或不合法 ID。
export function bindCommandIdentity(
  message: MessageEnvelope,
  identity: TrustedCommandIdentity,
): void;

// Host 冻结 snapshot 后显式转移，结构展开不会自动继承权限。
export function transferCommandIdentity(
  source: MessageEnvelope,
  target: MessageEnvelope,
): void;

export function readCommandIdentity(
  message: MessageEnvelope,
): TrustedCommandIdentity | undefined;

// handler 结束的 finally 中撤销，防止消息对象成为长期可重放 owner capability。
export function clearCommandIdentity(message: MessageEnvelope): void;
```

约束：

- 不在 `MessageEnvelope` 增加可由对象字面量伪造的 `accountId/isOwner` 字段；
- `TrustedCommandIdentity` 不含日志 event ID、正文或永久授权；
- 原 envelope 上的临时绑定只用于 Host clone/transfer，转移后立即清除；
- handler snapshot 的绑定在 handler 完成或失败的 `finally` 中清除；
- `WeakMap` 不是授权缓存，不跨消息、进程或重启复用。

### 7.2 `src/v2/channel-ownership.ts`

新增有界、三态结果的 verifier：

```ts
export type ChannelVerification =
  | Readonly<{status: "verified"; identity: TrustedCommandIdentity}>
  | Readonly<{status: "rejected"; reason:
      | "not-channel-message"
      | "forwarded-message"
      | "anonymous-group-identity"
      | "not-creator"
      | "send-as-unavailable"
      | "different-actor"
      | "conflicting-evidence"}>
  | Readonly<{status: "indeterminate"; reason:
      | "missing-raw-message"
      | "admin-log-unavailable"
      | "no-correlated-event"
      | "rpc-failed"
      | "protocol-shape"
      | "cancelled"}>;

export interface ChannelVerifierOptions {
  maxAttempts: number;
  resultLimit: number;
  observationWindowMs: number;
}

export interface ChannelIdentityVerifier {
  verify(message: MessageEnvelope, signal: AbortSignal): Promise<ChannelVerification>;
}

export class ChannelOwnershipVerifier implements ChannelIdentityVerifier {
  constructor(
    telegram: TelegramPort,
    selfId: string,
    options: ChannelVerifierOptions,
    logger: PluginLogger,
  );

  verify(message: MessageEnvelope, signal: AbortSignal): Promise<ChannelVerification>;
}
```

`verify` 的固定顺序：

1. 校验 `raw` 是 `Api.Message`，`raw.fromId` 是 `PeerChannel`，并与 `message.senderId` 的 marked ID 一致；
2. 频道身份必须与目标群不同；匿名群自身身份默认拒绝；
3. `forwarded`/`fwdFrom` 直接拒绝频道认证；
4. 将发送频道、目标 peer 和 self 解析为 input entity，不用 `Number` 转 64 位 ID；
5. 调用 `Api.channels.GetParticipant({channel: senderChannel, participant: self})`；只有返回 `Api.ChannelParticipantCreator` 且 `participant.userId.toString() === selfId` 才继续；
6. 调用 `Api.channels.GetSendAs({peer: targetPeer})`，只将“结果包含 senderChannel”作为上下文一致性条件，不把它当作者证明；
7. 查询目标群管理日志。新消息匹配 `ActionSendMessage.message`；编辑消息必须从未按 actor 过滤的相关事件中匹配原始 send 与指向当前内容的最新 `ActionEditMessage.newMessage`；
8. 比较目标 peer、消息 ID、当前正文（只在内存比较或摘要比较）和 actor；
9. 唯一一致的 self 证据返回 `verified`；明确他人/冲突返回 `rejected`；缺失、权限或 RPC 问题返回 `indeterminate`。

并发与生命周期：

- creator 检查以 `(selfId,senderChannel)` 做**仅在途** Promise 去重，Promise settle 后在 `finally` 删除；
- send-as 检查以 `(targetPeer,senderChannel)` 做仅在途去重；
- 管理日志检查以 `(targetPeer,messageId,edited,contentDigest)` 做仅在途去重；
- 不保存永久成功集合，不在内存或磁盘缓存“该频道永远属于 self”；
- 每次新命令重新形成完整证据，避免频道转让、权限撤销后沿用结果；
- 使用传入 signal 与 runtime/plugin scope 组合取消；已发出的 Teleproto RPC 必须真实 settle，不能在后台逃逸；
- 日志只包含 reason、attempt、latency bucket、RPC error class，默认不含正文、频道标题或用户名称。

### 7.3 `src/v2/host.ts`

`HostOptions` 增加运行时提供的可信账号和 verifier：

```ts
export interface HostOptions {
  // 现有字段保持
  selfId: string;
  channelIdentity: ChannelIdentityVerifier;
}
```

`dispatchPrimary` 调整为：

1. 仍先解析前缀/别名，并确认是已注册、已就绪命令；未知文本不触发频道 RPC；
2. 仍在进入 handler 前执行 `ignoreEdited` 过滤；默认忽略的编辑命令不触发认证；
3. 将认证本身放入现有 `executor.submit(message.chatId, ...)` 任务内，保证同 chat 消息的认证与执行顺序一致；
4. 个人路径：
   - `saved === true` 签发 `saved-messages`；
   - 或 `outgoing === true && senderId === selfId` 签发 `personal-sender`；
   - 生产 `messageEnvelope` 对缺失个人 `fromId` 已用 selfId 回填；不为任意 `outgoing` 频道直接签发个人身份；
5. 频道路径：仅符合原始 `PeerChannel` 结构的已注册命令调用 `channelIdentity.verify`；`out` 可根据实验结果作为拒绝廉价噪声的候选过滤，但永远不是最终证明；
6. 仅 `verified` 进入 handler。绑定原 envelope、冻结 `snapshot`、调用 `transferCommandIdentity`，随后清除原 envelope；
7. handler 完成/抛错后在 `finally` 清除 snapshot 身份；
8. `rejected/indeterminate` 返回 `false`，不调用命令 handler；
9. `dispatchListeners` 收到普通 envelope，不获得命令可信身份。

必须保留：解析结果冻结、按 chat 执行器、plugin scope 生命周期、队列容量和现有个人/收藏夹命令顺序。

### 7.4 `src/v2/permissions.ts` 与 SDK 只读接口

统一权限函数只读取私有可信操作账号：

```ts
export function commandAccountId(message: MessageEnvelope): string | undefined {
  return readCommandIdentity(message)?.accountId;
}

export function isOwner(message: MessageEnvelope, ownerId = process.env.TB_OWNER_ID): boolean {
  return validDecimal(ownerId) && commandAccountId(message) === ownerId;
}
```

`requireOwner`、`isPrivileged` 继续基于 `isOwner`。禁止回退到裸 `senderId`，否则手工构造 envelope 可绕过认证。现有测试 fixture 必须通过 Core 内部测试 helper 或 Host 正常分发获得可信记录，不能为了少改测试保留不安全回退。

给插件只暴露只读能力，不暴露 bind/transfer：

```ts
export interface PluginContext {
  readonly identity: {
    accountId(message: MessageEnvelope): string | undefined;
    kind(message: MessageEnvelope): "direct-account" | "owned-channel" | undefined;
  };
}
```

`contextFor` 的实现调用 Core 私有 `readCommandIdentity`。复制、展开或自建 `MessageEnvelope` 得不到身份。插件 `sure/v2.ts` 使用 `ctx.identity.accountId(invocation.message)` 与 `getMe().id` 比较；其他基于消息作者的 `senderId` 逻辑不变。

### 7.5 `src/v2/runtime.ts`

登录得到 `selfId` 后：

1. 复用同一个 `TeleprotoPort`；
2. 用 `selfId` 和已由实验确定的有界参数构造 `ChannelOwnershipVerifier`；
3. 把 `selfId`、verifier 和 transport 传给 `PluginHost`；
4. verifier 归属 runtime/root 生命周期，shutdown 时停止接收新认证并等待在途 RPC；
5. 功能以默认关闭的显式 feature flag 开始灰度，例如 `TB_CHANNEL_COMMAND_IDENTITY=off|observe|enforce`：
   - `off`：保持当前生产行为；
   - `observe`：只对合成/明确测试范围采集判定，不签发频道命令身份；
   - `enforce`：只对已批准场景签发；
6. feature flag 不包含频道 ID 白名单，不能改变 owner 集合。

`observe` 不得对任意生产群扫描管理日志；它必须额外受测试 peer 范围限制，且只有后续用户明确授权才启用。

## 8. 回复身份与发送出口方案

认证命令与回复展示身份是两个独立验收面。即使命令操作者已经证明为 A，也不能让原本以 C 展示的命令在回复时静默暴露 A 的个人身份。

### 8.1 原消息 edit

`editMessage` 没有 `sendAs` 参数，因为它编辑既有消息。实验 O1 必须确认：

- A 认证后的原消息可被编辑；
- 编辑后消息 ID 不变、展示身份仍是 C；
- 对 B 发出的消息或无法认证消息，MiBot 不尝试用管理员编辑权限改写；
- edit 失败时不自动调用个人身份 reply。

若 O1 稳定通过，edit 可作为首批最小回复路径。

### 8.2 新 reply

`TeleprotoPort.reply` 根据 `readCommandIdentity(message)` 选择身份：

- `owned-channel`：显式设置 `sendAs` 为已认证的 `sendAsPeerId`；
- `direct-account`：按实验决定显式 self 或保持当前个人行为；
- 无可信命令身份的监听器/后台任务：保持既有语义，不继承频道身份。

`sendAs` 失败时直接抛出稳定错误，例如 `CHANNEL_RESPONSE_IDENTITY_UNAVAILABLE`；禁止不带 `sendAs` 重试。分页第二页、topic reply 和异常提示同样适用。

### 8.3 新 sendFile helper

SDK 增加以原命令消息为上下文的受控文件发送接口，禁止调用者自行覆盖 `sendAs`：

```ts
import type {SendFileInterface} from "teleproto/client/uploads";

export type CommandSendFileOptions = Omit<SendFileInterface, "sendAs">;

export interface TelegramPort {
  // 现有方法
  sendFile(
    message: MessageEnvelope,
    options: CommandSendFileOptions,
    signal: AbortSignal,
  ): Promise<void>;
}
```

transport 从 `message.raw` 解析当前 target peer，从可信身份注入 `sendAs`；调用方仍可指定当前会话内的 `replyTo/topMsgId`。如果实验表明某些媒体类型、album 或 topic 不能可靠保持 C，则这些能力不对频道命令开放。

### 8.4 原生 client 调用审计

标准 `ctx.telegram.edit/reply/sendFile` 可以中央执行身份策略；`ctx.telegram.withClient` 中的原生发送会绕过它。因此实现阶段必须逐调用分类，而不是批量添加 `senderId` 或 `sendAs`：

- **当前命令会话的新文本/文件输出**：迁移到标准 `reply/sendFile`，由 Core 注入身份；
- **编辑当前命令消息**：迁移或确认走 `telegram.edit`；
- **外部 bot 对话、收藏夹进度、后台通知、定时任务**：不继承命令频道身份，保留原目标和语义；
- **监听器根据第三方消息响应**：不读取命令身份；
- **删除、下载、pin、权限管理等非发送调用**：按原业务审核，不机械修改。

当前 56 个 V2 候选文件清单如下，实施时生成逐调用表，记录分类、是否迁移、理由和测试：

```text
acron/v2.ts
ai/v2/media.ts
atadmins/v2.ts
atall/v2.ts
audio_to_voice/v2.ts
autorepeat/v2.ts
banana/v2.ts
bgp/v2.ts
biko/v2.ts
bizhi/v2.ts
botmzt/v2.ts
bulk_delete/v2.ts
checkin/v2.ts
clean_member/v2.ts
codex_image/v2.ts
convert/v2.ts
cosplay/v2.ts
crazy4/v2.ts
cy/v2.ts
da/v2.ts
dme/v2.ts
eatgif/v2.ts
fbi/v2.ts
getstickers/v2.ts
httpcat/v2.ts
javdb/v2.ts
jupai/v2.ts
keyword/v2.ts
kkp/v2.ts
listusernames/v2.ts
lottery/v2.ts
lu_bs/v2.ts
moyu/v2.ts
music_bot/v2.ts
netease/v2.ts
nezha/v2.ts
nodeseek/v2.ts
paolu/v2.ts
pic_to_sticker/v2.ts
pmcaptcha/v2.ts
portball/v2.ts
qr/v2.ts
rev/v2.ts
save/v2.ts
search/v2.ts
sendat/v2.ts
speedtest/v2/report.ts
sticker/v2.ts
sticker_to_pic/v2.ts
sum/v2.ts
sure/v2.ts
t/v2.ts
tmp_admin/v2.ts
tts/v2.ts
yvlu/v2/media.ts
zpr/v2.ts
```

首批灰度只开放已经完成出口审计的命令。若需要代码级显式标记，在 `CommandDefinition` 增加默认关闭的 `channelIdentity: "edit-only" | "full"`：

- `edit-only` 只允许原消息编辑，不允许新 reply/file；
- `full` 要求文本与文件新发路径均已通过身份测试；
- 未声明的第三方命令对 owned-channel 身份返回不支持；
- 这是命令能力声明，不是频道 ID 白名单。

是否需要该标记由出口审计结果决定；在无法中央保证 `withClient` 调用安全时必须采用，不能为了覆盖率默认全开。

## 9. 配置与作者语义

频道身份认证成功后，普通命令和不包含秘密的设置命令可在已支持的群里使用。不得新增“所有配置都必须在收藏夹”的全局限制。

现有密钥/token 设置保护必须保留并单独回归，例如：

- `checkapi save`；
- `convert apikey`；
- `cximg token`；
- `banana key`；
- `aitc key`；
- `nezha set ... secret`；
- `xmsl set key`；
- `tts config/key`；
- `tk` API Key；
- `checkin set bot TOKEN CHAT_ID`；
- `ai` API Key 配置。

这些命令仍依据 `message.saved` 限制秘密输入；频道可信操作账号不能绕过收藏夹要求。无密钥的模式、阈值、展示或普通插件设置按原命令规则可在群里执行。

插件影响面必须按语义分类：

- `TeleBox-Plugins/sure/v2.ts` 的 owner 直比迁移到 `ctx.identity.accountId`；
- Core `help name` 迁移到统一 `isOwner`；
- `lottery.creatorId`、`bulk_delete` 自己消息判断、`pmcaptcha` 对方用户、`fbi` 追踪用户、`keyword` mention、`trace`/`goodnight`/`autorepeat` 等继续使用 `senderId`；
- 不进行全仓 `senderId -> accountId` 替换。

## 10. 测试文件与验收用例

### 10.1 计划新增/修改的测试

Core：

- `src/v2/command-identity.test.ts`
  - 普通对象、spread clone、JSON round-trip 不能获得身份；
  - bind/transfer 后只有目标对象可读；
  - 重复 bind、非法 ID 被拒绝；
  - clear 后 owner/privileged 失败；
  - WeakMap 不改变 envelope 字段。
- `src/v2/channel-ownership.test.ts`
  - Creator+self 正例；管理员非 Creator、Creator userId 不符反例；
  - GetSendAs 包含/不包含频道；
  - send actor self/other、缺失、重复一致、重复冲突；
  - peer/message ID/content 不匹配；
  - forwarded、匿名群身份、missing raw；
  - edit 原 actor/最新 actor 组合；
  - RPC 错误三态映射；
  - 最大尝试/limit、在途去重、settle 后重新查询；
  - abort 与 lifecycle drain 不遗留任务。
- `src/v2/host.test.ts`
  - 未注册命令不调用 verifier；
  - 默认 ignoreEdited 在 verifier 前返回；
  - direct personal/saved 兼容；
  - 裸 outgoing channel 不放行；
  - verified 才调用 handler；rejected/indeterminate 均不调用；
  - 认证位于同 chat 队列内，跨 chat 并发保持现有限制；
  - Host snapshot 获得身份、原消息和 listener 不获得；
  - handler throw/complete 后清除身份；
  - shutdown 等待在途认证。
- `src/v2/permissions.test.ts`
  - 个人与 owned-channel 的 `accountId` 均可满足正确 owner；
  - 错 owner、无记录、伪造 senderId、伪造新字段均失败。
- `src/v2/telegram.test.ts`
  - edit 不新发消息且保留原目标；
  - channel identity reply 显式传 `sendAs`；
  - sendFile 显式传 `sendAs`、reply/topic 参数正确；
  - sendAs 错误不无身份重试；
  - direct/listener/后台路径保持既有行为。
- `src/v2/runtime.test.ts` 或现有 runtime fixture
  - selfId 与 verifier 正确注入；
  - off/observe/enforce 默认与切换；
  - observe 不签发权限。
- `src/v2/builtins/help.test.ts`、`privacy.test.ts`、`tpm.test.ts`、`restart.test.ts`、`update.test.ts`、`exec/bf/sudo/sure` 相应测试
  - 可信频道操作账号满足 owner；
  - 伪造 sender/频道所有权不能满足 owner；
  - forwarded 与秘密配置限制仍按既有规则。

Plugins：

- `sure` V2 测试覆盖 `ctx.identity.accountId` 正反例；
- 为每个迁移的当前会话 raw send 增加 send-as 参数/标准 helper 测试；
- 为秘密设置命令增加频道身份下仍拒绝、收藏夹个人身份仍允许的回归；
- 为 `lottery` 等保留作者语义的插件增加“频道命令身份不会改写 senderId”回归；
- build/package 测试确认新 SDK 接口与插件产物兼容。

### 10.2 离线检查顺序

使用确认仍存在的 Node 24：

```sh
/tmp/telebox-node24.4ggax9/node-v24.20.0-darwin-arm64/bin/node node_modules/typescript/bin/tsc -p tsconfig.v2.json
/tmp/telebox-node24.4ggax9/node-v24.20.0-darwin-arm64/bin/node node_modules/typescript/bin/tsc -p ../TeleBox-Plugins/tsconfig.v2.json
/tmp/telebox-node24.4ggax9/node-v24.20.0-darwin-arm64/bin/node scripts/test-v2.cjs
```

先运行新增聚焦测试，再运行完整 `scripts/test-v2.cjs`。若临时 Node 路径届时不存在，使用符合 `package.json` 的 Node 24 新路径并记录实际版本，不把环境缺失误报为代码通过。

### 10.3 功能验收条件

只有以下全部满足才可称为实现完成：

1. A 个人身份和收藏夹的现有命令行为不变；
2. A 以 C 身份发出的已支持命令，只有在 creator 与逐消息 actor 证据都充分时执行一次；
3. B 使用同一 C 身份的相同命令 100% 被拒绝；
4. A 使用非自有 D、转发、自动转发、匿名群身份、编辑他人消息均不获频道命令身份；
5. 管理日志权限不足、缺失、超时、重复冲突与 RPC 错误全部 fail closed；
6. `senderId` 仍是频道 ID，可信 `accountId` 只在命令 handler 生命周期可读；
7. 同 chat 连续命令顺序保持，跨 chat 并发不发生证据串线；
8. 没有永久频道成功缓存，权限/所有权变化后的下一条命令重新核验；
9. edit/reply/sendFile 都按批准范围保持 C，任何 sendAs 失败均不降级为 A 个人身份新发；
10. owner-only 的 Core 命令和 Plugins `sure` 读取统一可信账号；作者业务逻辑仍读 `senderId`；
11. 密钥/token 设置仍只在收藏夹，普通命令和无密钥设置未被新增全局收藏夹限制；
12. 聚焦测试、Core/Plugins typecheck、打包测试和完整回归通过；平台跳过项必须与既有原因一致；
13. 实机验收只在用户指定的私有测试拓扑完成，报告不含无关正文或凭据；
14. 代码审阅确认无 UI、IP 隐私、Google GT 或其他无关变更。

## 11. 分阶段发布与回滚

本轮不执行发布。未来每一阶段都需要新的明确授权。

建议顺序：

1. 合并 Core 私有身份、verifier、feature flag 和测试，生产保持 `off`；
2. 在本地/测试实例使用 `observe` 完成只读判定对照，不签发频道权限；
3. 先发布 Core，使旧插件继续工作；
4. 发布已消费只读 identity/sendFile 接口且完成出口审计的插件；
5. 仅在私有测试群切换 `enforce`，先开放 edit-only 命令；
6. reply/sendFile 身份验收通过后扩大到 full 命令；
7. 观察拒绝原因、RPC 错误、认证延迟和身份错误；不记录消息内容；
8. 另行评审是否扩大范围，不承诺所有群都能使用。

回滚触发条件：

- 任何 B/非 creator/无法判定消息被执行；
- 任何频道命令回复以 A 个人身份出现；
- 管理日志延迟或错误造成明显队列阻塞；
- lifecycle shutdown 出现在途认证泄漏；
- 个人身份命令、插件 ABI 或秘密设置出现回归。

回滚顺序：

1. 将 feature flag 切回 `off`，停止签发新的频道命令身份；
2. 等待现有 handler 与在途 RPC 正常 drain；
3. 若仅插件回复出口异常，回滚对应插件到旧制品，Core 保持 off 兼容；
4. 若 Core ABI/行为异常，先回滚消费新 SDK 的插件，再回滚 Core；
5. 不修改 owner/sudo 数据，不删除用户配置，不改变 UI/IP/GT 部署状态；
6. 保存不含正文的错误码和版本信息用于复盘。

## 12. 实机前需要用户一次性提供的信息与授权

开始第 5 节真实实验前，只需要用户返回以下信息：

1. 指定用于实验的 MiBot 测试账号/本地会话标识（不提供 session 或密钥）；
2. 私有测试超级群 G1，以及 MiBot/A 是否具备读取管理日志的管理员权限；
3. A 创建的测试频道 C，并确认它可在 G1 选择为发送身份；
4. 是否有可配合的第二管理员 B；若有，确认 B 可选择同一 C；
5. 是否有 A 仅管理但非创建者的测试频道 D；
6. 是否已有非管理员目标群 G2；没有则将该实机用例标为未执行，以离线错误 fixture 补充，不为本实验新建或改权；
7. 对本次实验的明确授权范围：仅在上述私有测试资源中发送（包括转发用例）合成测试消息、编辑与删除这些合成消息，以及只读查询参与者、send-as 列表和管理日志；不包含建群、修改管理员/频道关联或其他权限变更；
8. 希望保留还是删除实验后的合成消息与脱敏报告。

推荐返回格式：

```text
测试会话标识：
G1：
C：
B：有/无
D：有/无
G2：有/无
授权：同意在以上私有测试资源发送（含转发用例）/编辑/删除合成消息，并只读查询参与者、send-as 与管理日志；不修改群或频道权限
清理：删除合成消息 / 保留合成消息
```

历史生产部署授权不能自动延伸为 Telegram 聊天操作授权。没有这些信息时，本计划仍是完整交付，但状态保持“未实测、未批准实现”。

## 13. 本计划不包含的事项

- 不遍历并永久缓存全部频道作为 owner；启动全量遍历最多只能在未来作为可选性能预热，不能参与授权结论；
- 不支持绕过 Telegram 匿名机制；
- 不修改生产权限、owner/sudo 名单或频道管理员设置；
- 不发送真实聊天内容，不读取无关历史；
- 不自动修改业务源码、提交、推送、部署或重启服务；
- 不扩大到所有群、所有匿名身份或所有插件，支持范围以实验证据和出口审计为准。
