# 架构与依赖边界

本规范以 MiBot Core 0.7.0 的 V2 实现为核对基线。能力和具体签名随仓库演进，使用前检查当前源码；旧开发手册和迁移台账用于理解历史行为，当前入口及公共 SDK 决定新代码的接入方式。

## 分层与源码定位

下表路径均相对 Core，扩展路径相对插件仓库。

| 层 | 职责 | 主要入口 |
| --- | --- | --- |
| 进程与账号 | 配置、账号互斥、认证客户端、启动及退出 | `src/v2/index.ts`、`runtime.ts`、`account.ts` |
| 协议适配 | Telegram 消息归一化、客户端操作、协议兼容 | `src/v2/telegram.ts`、`protocol-compat.ts` |
| 宿主与调度 | 插件代际、命令准入、队列、服务注册、授权路由 | `src/v2/host.ts`、`executor.ts`、`commands.ts`、`delegation.ts`、`permissions.ts` |
| 公共契约 | 声明、上下文、消息信封、帮助和 UI 工具 | `src/v2/sdk.ts`、`ui/` |
| 受管资源 | 生命周期、存储、网络、文件、进程、定时任务 | `src/v2/lifecycle.ts`、`storage.ts`、`sqlite.ts`、`http.ts`、`files.ts`、`processes.ts`、`scheduler.ts` |
| 构件与发布 | 构建、完整性、激活、回滚和安装记录 | `scripts/build-v2-plugin.cjs`、`src/v2/artifacts.ts`、`releases.ts`、`builtins/tpm.ts` |
| 功能实现 | Core 基础内置或 TPM 扩展业务 | `src/v2/builtins/` 或插件 `<id>/v2.ts`、`<id>/v2/` |

依赖方向：扩展业务 → `telebox/sdk` → 宿主提供的资源能力。Core 的 `runtime.ts` 装配具体实现，宿主向处理器注入上下文。业务模块不自行建立 Telegram 账号连接、不直接操作 Host 的发布状态，也不绕过宿主注册全局消息入口。

## 实现归属与部署

- 由 `runtime.ts` 显式加载的基础功能归 Core；通过 TPM 安装的功能归插件仓库。不要仅因 `builtins/` 中存在文件就认定它被默认加载。
- `ai`、`gt`、`leech`、`re`、`sure` 当前由扩展提供。`.agent` 通过服务调用消费已安装的 AI 能力，不复制其业务实现。默认内置清单与双仓归属由 `scripts/default-plugins.test.cjs` 及相关归属测试核对。
- 历史兼容包可以保留身份与说明，不能再注册同一功能的活动命令、监听器或生命周期副作用。新增实现不得自动扩大默认安装集合。
- Core 的生产构建只依赖 Core；跨仓类型检查与完整测试需要配套插件检出。不能把测试环境要求变成部署前提。
- `.update` 更新主程序并重启；`.tpm update <id>` / `.tpm update all` 更新扩展。构建候选文件不等于激活，推送仓库不等于线上已更新。

## 生命周期不变量

每次加载是一代插件实例，持有自己的 `PluginContext` 与 `ResourceScope`。模块顶层只放类型、纯函数和不可变声明；可变业务状态放在工厂实例内或受管存储中。

1. 工厂求值不启动网络、计时器、监听器、进程或数据库写入。`setup`、命令、监听器、服务及任务负责实际执行。
2. 长任务交给 `ctx.tasks.run(label, signal => ...)`；自定义资源通过 `ctx.tasks.add(label, disposer)` 注册。宿主已追踪的处理器无需机械地再包一层任务。
3. 回调内发起的资源操作必须在该回调内完成。不能从 `withClient`、`withResponse`、`withTemp` 返回仍在运行的工作或供后续使用的资源句柄。
4. 取消是停止请求，不是完成证明。耗时操作接收相应 signal，循环在下一次副作用前检查取消；不支持取消的操作等待真实结束。
5. `drain` 的超时或清理错误必须报告，未完成工作不能丢失所有权；旧代清理未完成时不能启用新代。插件处理器不能等待自身作用域卸载，换代由外部协调器执行。
6. 卸载保留业务配置；发布回滚恢复代码选择，不把业务数据回滚成旧快照。数据结构演进必须考虑当前支持的回滚代码能否读取。

宿主命令执行保持有界队列与同聊天顺序；前缀变更更新路由，不重建插件代际。JSON 更新串行化并原子替换文件，发布选择记录要求单进程写入；账号互斥由 Core 负责，插件不能另开写入进程绕过此边界。

修改构件加载器时区分 `inspectArtifact`（不执行代码）与 `prepareArtifact`（执行受信任模块顶层）；`create` 求值工厂。所有实例卸载后才能释放构件句柄；本构件 CJS / JSON 缓存可回收，共享依赖和原生模块保留缓存。

## 能力边界

| 需求 | 使用方式 | 关键约束 |
| --- | --- | --- |
| Telegram 文本/原生调用 | `ctx.telegram.*`、`withClient` | 账号连接归 runtime；默认文本为字面文本 |
| JSON / SQLite | `ctx.storage.json` / `sqlite` | 插件命名空间、串行更新；不自建常驻数据库单例 |
| HTTP / 流 | `ctx.http.json` / `text` / `withResponse` | 响应体消费和取消清理都计入生命周期 |
| 临时媒体 / 原生程序 | `ctx.files.withTemp`、`ctx.processes.run` | 等上传/转码实际结束再清临时文件；遵守进程并发、队列和输出上限 |
| 持久文件 | `ctx.files.dataDirectory` / `dataFile` / `dataPath` | `dataPath` 只解析路径，后续 I/O 仍需受管 |
| Cron / 动态任务 | 声明 `jobs` 或 `ctx.jobs.register` | 重载恢复一次；动态删除使用返回的 disposer |
| 跨插件服务 | `ctx.services.available` / `call` | 提供方通过 `services` 声明；处理服务调用的取消信号 |

这些接口管理资源所有权，不是运行不可信代码的隔离沙箱。构件哈希用于完整性检查，不能证明来源可信；插件代码具有运行账号权限。
