# MiBot Core 迁移到 Go 的方案

本文写给执行迁移的人或 agent。它自包含：不需要读本仓库其他文档就能开工，但
开工前必须按 §9 读完列出的源码文件。所有数字均为 2026-09-20 在 macOS arm64、
Node 24.21.0 / Go 1.26.6 上实测；Linux 上绝对值略有差异，比例不变。

## 1. 为什么迁、迁到哪

### 1.1 现状

- Node 24 + TypeScript，Telegram 协议层用 `teleproto`（gramjs 分支）。
- 启动常驻 RSS **110.5 MB**（已含 0.9.2 的 undici 懒加载优化）。
- 其中 **45 MB 是 TL schema 的运行时数据**，拆分如下：

  | 项 | RSS |
  |---|---|
  | `tl/generated/api-definitions.js`：1.8 MB 源码解析成 2527 个嵌套对象 | 27.2 MB |
  | `createApiFromDefinitions` 全量构造 2527 个类 | 14.2 MB |
  | createApi 运行时 | 3.3 MB |

- 裸 node 进程 42.1 MB。剩余约 20 MB 是宿主、内置和 better-sqlite3 等。

在 Node 内继续压已经验证过没有空间：TL 惰性构造只造热路径 480 个类型可省
10 MB，但那 27 MB 的定义数组是整体 `require` 进来的，除非改 teleproto 的数据
格式否则跑不掉。天花板约 110 → 80 MB，还要长期维护一个 fork。**不做。**

### 1.2 目标

- Go + [gotd/td](https://github.com/gotd/td)。实测 gotd 完整类型表（2729 条）
  全部触达后进程 RSS **6.3 MB**，二进制 7.3 MB，堆 0.3 MB。原因是 TL schema
  在 Go 里是编译进 text/rodata 的结构体和方法，mmap 按页惰性加载。
- 完整 userbot 含连接、crypto、会话和业务逻辑，**目标常驻 ≤ 30 MB**，即
  约 4 倍改善。这是估算，Phase 1 结束时用真实客户端复测并更新本节。
- 插件仍然是 TypeScript，打包体验与现在完全相同：esbuild 打成单个 JS 文件，
  跨平台一份。**这是本方案的核心约束，见 §2。**

### 1.3 明确不做

- 不用 `-buildmode=plugin`：要求 Go 版本、依赖版本、编译 flag 与宿主完全一致，
  不能卸载，无 Windows。社区插件仓库不可用。
- 不用 hashicorp/go-plugin 之类的多进程 RPC：裸 Go 进程就 6 MB，20 个插件
  ≥ 120 MB，比现在的 Node 还高，迁移意义归零。
- 不复用现有 TypeScript 核心逻辑，从零写；但**复用现有的契约、测试用例和
  行为规格**（§9 列出的文件就是规格）。
- 不在本次迁移中改插件 SDK 的语义。能力面 1:1 对应，见 §3。

## 2. 插件运行方式：Go 宿主 + goja

[goja](https://github.com/dop251/goja) 是纯 Go 的 JS 引擎（无 CGO），支持
ES2015+ 大部分特性，含 async/await、generator、Promise、可选链和空值合并。
配合 [goja_nodejs](https://github.com/dop251/goja_nodejs) 的 eventloop 运行
异步代码。

选它而不是 wazero/WASM 的理由：插件作者写 TS，goja 直接跑 esbuild 的产物；
WASM 路线要把 QuickJS 塞进每个 .wasm，对作者门槛高、每实例内存也更大。
隔离需求（内存上限、CPU 中断）goja 有 `Interrupt()` 和可自定义的
`ArrayBufferAllocator` 能覆盖，够用。

### 2.1 为什么现有插件能跑

MiBot 的 SDK 早已把所有能力收口到 `PluginContext`（`ctx.*`）上，架构规范明确
扩展不得导入 Core 内部路径。规矩写的插件几乎不直接碰 Node API。把 `ctx.*`
用 Go host function 实现一遍，多数插件的 bundle 就能在 goja 里跑。

### 2.2 会坏的插件（Phase 0 必须先量）

构件 manifest（`src/v2/artifacts.ts` 的 `ArtifactManifest.imports`）记录了每
个插件打包时的外部 import 列表，`--packages=external` 让所有 npm 包都留在这
个列表里。**扫描所有已发布构件的 manifest 就能静态得到受影响范围**，不必读
代码。按严重度：

1. **直接用 `ctx.telegram.withClient()` 或 `invoke()` 配合 `Api.*` 构造器**的
   插件：与 teleproto 的 TL 对象模型硬耦合。这是最难的一类，需要在 goja 里
   提供 `Api.*` 到 gotd 请求的映射层，或改写插件。Phase 0 统计数量后决定映射
   层覆盖哪些构造器（按使用频次取前 N 个，其余要求插件改写）。
2. **原生模块**：只有 3 个——`better-sqlite3`、`canvas`、`sharp`。Go 侧替代：

   | npm | Go 替代 | 暴露方式 |
   |---|---|---|
   | better-sqlite3 | `modernc.org/sqlite`（纯 Go，无 CGO） | `ctx.storage.sqlite` 已是宿主能力，插件不直接 import |
   | sharp / smartcrop-sharp | `github.com/disintegration/imaging` 或 `golang.org/x/image` | 新增 `ctx.images` host function |
   | canvas | 同上 + `github.com/fogleman/gg` 绘制 | 同上 |

3. **纯 JS 但依赖 Node 内置模块**的包（`axios`、`undici`、`archiver`、`ssh2`、
   `cheerio` 的部分路径）：goja 没有 `node:http`/`node:fs`/`node:net`。这些包在
   插件 bundle 里本来就应该被 `ctx.http`/`ctx.files` 取代；Phase 0 统计后，
   对高频的提供 shim，其余要求改写。
4. 完全纯 JS 的工具包（`lodash`、`dayjs`、`js-yaml`、`runes`、`opencc-js`、
   `emoji-db`、`p-limit`、`lru-cache`）：在 goja 里直接跑，打包时改为
   `--packages=bundle` 内联进插件即可。

### 2.3 打包格式变化

现在：`esbuild --bundle --packages=external --external:telebox/sdk --platform=node --format=cjs --target=node24`

迁移后：`--packages=bundle`（纯 JS 依赖内联）、`--platform=neutral`、
`--format=cjs`、`--target=es2020`（或 goja 实测支持的最高级别），`telebox/sdk`
仍然 external，由宿主注入。manifest 的 `schemaVersion` 升到 2，`imports` 只允
许 `telebox/sdk`。构件的完整性哈希、revision、激活/回滚流程
（`artifacts.ts`、`releases.ts`）**格式和语义原样保留**。

## 3. 目标架构

按现有分层 1:1 对应，目录名仅供参考：

| 层 | 现有 | Go |
|---|---|---|
| 进程与账号 | `index.ts`、`runtime.ts`、`account.ts` | `cmd/mibot/`、`internal/account/` |
| 协议适配 | `telegram.ts`、`protocol-compat.ts` | `internal/telegram/`（gotd 封装、消息归一化为 `MessageEnvelope`） |
| 宿主与调度 | `host.ts`、`executor.ts`、`commands.ts`、`delegation.ts`、`permissions.ts` | `internal/host/`（插件代际、准入、按 chatId 串行的有界队列、授权路由） |
| 公共契约 | `sdk.ts`、`ui/` | `internal/sdk/`：`ctx.*` 的 Go 实现 + 注入 goja 的 JS 桩 |
| 受管资源 | `lifecycle.ts`、`storage.ts`、`sqlite.ts`、`http.ts`、`files.ts`、`processes.ts`、`scheduler.ts` | `internal/resource/`：ResourceScope、drain、JSON 原子写、SQLite、HTTP 地址策略、临时文件、子进程限额、cron |
| 构件与发布 | `artifacts.ts`、`releases.ts`、`builtins/tpm.ts`、`scripts/build-v2-plugin.cjs` | `internal/artifact/`、`internal/release/`；构建脚本仍用 esbuild（Node 只在**开发/打包机**上需要，运行时不需要） |
| 内置 | `builtins/*.ts` | 用 Go 重写，不走 goja。它们是 Core 的一部分，且多个直接用 `Api.*` |

### 3.1 必须保持的宿主不变量

这些来自 `skills/mibot-development/references/architecture.md` 和对应测试，
是验收项而非建议：

- 每次加载是一代插件实例，持有自己的 `PluginContext` 与 ResourceScope。
  goja 里对应：**每代一个 `goja.Runtime`**，卸载即丢弃整个 Runtime，不复用。
- 卸载时 `drain` 的超时或清理错误必须报告；旧代清理未完成时不能启用新代。
- 命令执行是有界队列；同聊天串行、不同聊天并行；同一消息的编辑按消息 ID 保序。
- 前缀变更只更新路由，不重建插件代际。
- JSON 更新串行化并原子替换文件；账号互斥由 Core 负责（现为 `os.tmpdir()`
  下的 flock，迁移时**顺手移到 `/run` 或 XDG runtime dir**，解决 systemd
  `PrivateTmp` 不能开的问题，见 `deploy/systemd/mibot.service` 注释）。
- 消息准入：非 outgoing 消息只在 `saved === true && senderId === selfId` 时进
  主路径；`saved` 单独不放行（0.9.1 修复，见 `host.ts` `dispatchPrimary`）。
  edited 默认不进命令。sudo/sure 走独立授权策略。
- `ctx.telegram.edit/reply` 默认字面文本，HTML 需显式 `parseMode`。
- Telegram ID 全程用十进制字符串，不经过 float64。gotd 用 int64，边界处转换。

### 3.2 `ctx.*` 能力面对照

| 能力 | 现有实现要点 | Go 实现要点 |
|---|---|---|
| `ctx.telegram.edit/reply/getReply` | 带 signal、字面文本默认 | gotd `message.Sender`；HTML 需自行做实体转换（gotd 有 `styling` 包） |
| `ctx.telegram.invoke(request)` / `withClient(client)` | 直接暴露 teleproto | **不再暴露原生客户端**。提供受限的 `invoke(name, params)`，只覆盖 Phase 0 统计出的高频构造器 |
| `ctx.storage.json` | 原子写、串行更新 | 同 |
| `ctx.storage.sqlite` / `legacySqlite` | 每次操作开连接用完即关、readonly + fileMustExist | modernc.org/sqlite，同策略 |
| `ctx.http.json/text/withResponse` | 超时、字节上限、重定向限制、`denyPrivateAddresses` 在真实 DNS 连接点过滤（含 v4-mapped v6、NAT64） | `net.Dialer.Control` + 自定义 Resolver 实现同样的过滤；单元测试直接移植 `http.test.ts` 的用例 |
| `ctx.files.withTemp/dataDirectory/dataFile/dataPath` | 命名空间内路径、符号链接拒绝 | 同 |
| `ctx.processes.run` | 并发、队列、超时、输出上限 | `os/exec` + 信号量 |
| `ctx.jobs` / `jobs` 声明 | cron，重载恢复一次 | `robfig/cron/v3` |
| `ctx.regexp.test` | Worker 隔离 + 硬超时，防灾难性回溯 | **Go 的 `regexp` 是 RE2，线性时间，不需要隔离**。但不支持 lookbehind 和反向引用；Phase 0 扫插件里的正则字面量，决定是保留 goja 内置正则（有回溯风险，需 `Interrupt` 兜底）还是走 RE2 |
| `ctx.services` | 跨插件调用，处理取消 | 同 |
| `ctx.tasks.run/add` | ResourceScope | 同 |
| `ctx.settings` | 声明式设置 | 同 |
| `ctx.log` | 结构化日志进 journald | `log/slog` |

## 4. 会话迁移

`config.json` 存 `api_id`、`api_hash` 和 gramjs 格式的 `StringSession`。gotd
的会话格式不同，但 StringSession 是公开格式（版本字节 + DC id + IP + 端口 +
256 字节 auth key），**写一个一次性转换器**把它导入 gotd 的
`session.Storage`，用户不必重新登录。转换器要有测试：用一个已知的
StringSession 解出的 DC 和 auth key 与 gramjs 解析结果逐字节一致。

`.tpm`、`.update` 的安装记录和插件的 `assets/` 数据目录布局不变。

## 5. 分阶段计划与门禁

每个 Phase 有明确的"过/不过"标准。不过就停下来汇报，不要硬推。

### Phase 0：可行性验证（预计 1 周）

目标：用数据回答"goja 能不能跑现有插件"，以及受影响范围。

1. 用 goja + goja_nodejs eventloop 跑一个**真实的**现有插件 bundle
   （从插件仓库挑一个只用 `ctx.telegram.edit` 和 `ctx.storage.json` 的），
   `ctx.*` 用最小 stub。验证：async/await 的 handler 能 await 一个由 Go 侧
   resolve 的 Promise；取消信号能中断；异常能带栈回到 Go。
2. 测量：一个 goja Runtime 装载该 bundle 后的内存增量；20 个 Runtime 的总量。
3. 扫描插件仓库所有构件 manifest 的 `imports`，输出三张表：用了
   `withClient`/`invoke`+`Api.*` 的插件及其用到的构造器频次；用了原生模块的；
   用了 Node 内置模块的。
4. 扫描插件源码里的正则字面量，标出用了 lookbehind/反向引用的。
5. 决定 esbuild `--target` 级别（逐级试到 goja 报语法错为止）。

**过的标准**：1 全部通过；2 中单 Runtime ≤ 3 MB；3 中第一类插件占比可接受
（由项目负责人看表决定，方案不预设阈值）。

### Phase 1：Core 骨架（预计 2–3 周）

账号读取与会话转换（§4）、gotd 客户端连接、消息归一化为 `MessageEnvelope`、
准入规则、按 chatId 的有界串行队列、前缀/别名解析、帮助渲染、`.ping`、
`.version`、`.memory`、`.status`（不含图片卡片）。

**过的标准**：真实账号连上后 `.ping` 有回应；`host.test.ts` 里的准入用例
（outgoing / saved+selfId / edited / 未认证失败关闭）逐条移植并通过；
**用真实客户端复测 RSS 并更新 §1.2 的目标数字**。

### Phase 2：SDK 能力面（预计 3–4 周）

按 §3.2 逐项实现 `ctx.*` 并注入 goja；每项对应的现有 `*.test.ts` 用例移植。
`ctx.http` 的私网地址过滤和 `ctx.processes` 的限额是安全边界，测试不能省。
`Api.*` 映射层按 Phase 0 的频次表覆盖前 N 个。

**过的标准**：Phase 0 选的那个插件不改一行代码在新宿主上完整工作；再挑 3 个
中等复杂度插件（含一个用 sqlite、一个用 http、一个用 jobs）同样通过。

### Phase 3：内置命令（预计 2 周）

`help`、`alias`、`prefix`、`env`、`sysinfo`、`exec`、`restart`、`bf`、`sudo`、
`loglevel`、`agent`、`privacy`、`autofix` 用 Go 重写。`exec` 和 `sudo` 的权限
检查逐条对照 `permissions.ts` 与对应测试。这一阶段是机械移植，见 §10 模型建议。

### Phase 4：构件与发布（预计 2 周）

构件加载器（goja Runtime 生命周期 = 插件代际）、完整性校验、激活/回滚、
`.tpm install/update/remove`、`scripts/build-v2-plugin.cjs` 改为 §2.3 的参数并
产出 schemaVersion 2 的 manifest。

**过的标准**：`artifacts.test.ts` 和 `releases.test.ts` 的用例移植通过；
安装 → 更新 → 回滚 → 卸载全链路在真实账号上跑通，卸载后 Runtime 被 GC
（用 `runtime.MemStats` 验证内存回落）。

### Phase 5：部署与更新（预计 1 周）

单个静态二进制。`.update` 从"git pull + npm + build + restart"变成"下载新
二进制 → 校验签名/哈希 → 原子替换 → restart"。systemd unit 可以开
`PrivateTmp`（前提是账号锁已移出 `/tmp`）和 `MemoryDenyWriteExecute`
（Go 不需要 JIT，goja 是解释器）。`install-service.sh` 相应简化。

### Phase 6：并行运行与切换

新旧两套用**不同账号**并行跑一周（同一账号不能双实例，账号锁会拦）。比对
日志里的命令处理结果。切换时先备份 `config.json` 和 `assets/`。

## 6. 风险登记

| 风险 | 影响 | 应对 |
|---|---|---|
| goja 对某些 ES 语法或内置对象支持不全 | 插件 bundle 语法错或运行时缺 API | Phase 0 逐级试 target；缺的内置对象用 JS polyfill 注入 |
| `Api.*` 硬耦合插件多 | 映射层做不完 | Phase 0 先出频次表，负责人决定覆盖范围；其余插件标记"需改写" |
| Go RE2 与 JS 正则语义差异 | 依赖 lookbehind 的插件行为变 | Phase 0 扫描；默认保留 goja 内置正则 + `Interrupt` 超时兜底 |
| StringSession 转换出错 | 用户被登出、需重新验证 | 转换器有逐字节测试；Phase 6 用备用账号先验 |
| goja 性能低于 V8 | 高频 listener 插件延迟上升 | goja 解释执行约慢 10–50 倍，但插件逻辑通常 I/O 绑定；Phase 2 对 listener 路径压测 |
| 单 goja Runtime 内存超预期 | 20 插件后总量逼近 Node | Phase 0 门禁 ≤ 3 MB/Runtime；超了改共享 Runtime + 隔离 realm 方案 |
| HTML 实体转换 | `parseMode: "html"` 的富文本渲染差异 | 移植 `ui/document.ts` 的 supportedTags 白名单和测试 |

## 7. 验收标准（整体）

- 真实账号运行、装 5 个以上插件后，常驻 RSS ≤ 30 MB（若 Phase 1 复测后更新了
  目标，以更新值为准）。
- §3.1 全部不变量有对应测试且通过。
- 现有 Core 905 项测试中与行为相关的（排除 Node 环境和构建脚本本身的）已移植，
  移植清单写在 `docs/go-migration-tests.md`，标明每条的去向：移植 / 不适用 /
  待定。
- `deploy/systemd/README.md` 和 `INSTALL.md` 更新为二进制部署流程。
- 插件开发文档更新 §2.3 的打包变化和 §3.2 中 `invoke` 的新签名。

## 8. 工作方式

- 在本仓库开分支（建议 `go-rewrite`），Go 代码放新目录（建议 `go/`），
  **不删 `src/v2`**——它是行为规格和测试来源，直到 Phase 6 切换后再清理。
- 每个 Phase 一个或多个 PR，PR 描述引用本文的 Phase 编号和门禁。
- 每次实现一个 `ctx.*` 能力，先读对应的 `.ts` 和 `.test.ts`，把测试用例翻成
  Go 测试再写实现。
- 版本约定见 `skills/mibot-development/references/verification.md`。Go 侧的
  版本从同一个 `package.json`（或迁移后独立的版本文件）读，不写死。
- 不确定某行为的语义时，**以现有测试为准，其次是现有实现，最后才是文档**。

## 9. 开工前必读

按顺序：

1. `skills/mibot-development/references/architecture.md` — 分层、不变量、能力边界
2. `src/v2/sdk.ts` — `PluginContext`、`MessageEnvelope`、`PluginDefinition` 的完整契约
3. `src/v2/host.ts` + `host.test.ts` — 准入、分发、代际
4. `src/v2/lifecycle.ts` + `lifecycle.test.ts` — ResourceScope 与 drain 语义
5. `src/v2/http.ts` + `http.test.ts` — 地址策略的精确行为
6. `src/v2/artifacts.ts` + `releases.ts` — 构件格式与发布状态机
7. `scripts/build-v2-plugin.cjs` — 现有打包参数
8. `deploy/systemd/mibot.service` — 注释里写了哪些加固选项因何被排除
9. `CHANGELOG.md` 0.9.1 与 0.9.2 条目 — 最近的安全修复与内存优化，别在迁移中退回去

## 10. 附：给项目负责人的执行建议

Phase 0–2 是设计和契约工作，判断密集、错了返工代价高，用推理能力更强的模型。
Phase 3 是机械移植（每个内置命令都有现成的 TS 实现和测试对照），中等模型即可，
但要求它每个命令都先跑通移植的测试再动下一个。Phase 4–5 再回到强模型，
构件生命周期和更新流程是安全边界。
