# MiBot 当前修复状态与后续方案

核验日期：2026-09-07。本报告区分源码审阅、台账记录与实际测试，不把存在实现等同于功能验收。

## 执行进展（2026-09-07）

P0 及 P1 功能完整性清单的四项本地修复已通过独立复验。以下记录更新本文后续的初始核验快照，不代表数据迁移、发布链路、P2 或生产验收完成。

- 媒体宿主正例使用运行时预算，默认宿主拒绝超额需求的负例保留。
- 默认插件测试匹配 18 个内置模块及 ai/gt；FBI 连续消息在立即卸载、重载后仍持久化。
- getstickers 支持回复与命令自身媒体；真实 ZIP 内容已校验，发送完成前保留文件。归档读取失败、输出失败和取消均有回归，取消后不再等待无法保证结束的 finalize。
- Darwin 成功发送 SIGKILL 后的临时 EPERM 不再永久污染结果；仍须确认进程组不存在才结算，真实控制失败仍报错。

验证环境为隔离 Node v24.20.0（macOS），未更改系统 Node。独立验收结果：

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| Core `npm run build:v2` | 0 | 44 个源码构建文件 |
| Core `npm run typecheck:v2` | 0 | 通过 |
| Core `npm run check:v2` | 0 | ok；pending tasks/resources 均为 0 |
| Core `npm run test:v2` | 0 | 1198 项：1197 通过、0 失败、1 跳过 |
| Plugins 两个修复批次测试 | 0 | 17/17 通过 |
| Core processes 定向复跑三轮 | 0 | 每轮 21/21 通过 |
| `git diff --check` | 0 | 通过 |

两批次为 `scripts/generation-tracking-batch-v2.test.js` 和 `scripts/sticker-media-batch-v2.test.js`。定向复跑前使用 `node scripts/build-v2.cjs --test` 构建；此前直接访问不存在的测试产物退出 1，已记录为测试路径准备问题。验收结束未发现目标测试进程残留。

### P1 功能完整性验收

- annualreport：新增 `PluginContext.plugins.list()`，返回当前 ready 插件的冻结 `{id, description}` 快照；卸载后旧 context 拒绝访问。报告显示实际激活数量，保留 startTime、reportCount 和未知历史字段。Host 专项 28/28、报告专项 3/3 通过。
- rev：共享字素与 CRLF 行布局，保持 UTF-16 实体偏移、实体类与附加字段；裁剪实体尾部空白，过滤非法嵌套。普通格式覆盖完整相交字素；链接/提及等语义实体仅保留原范围完整覆盖的字素，无法表达的范围丢弃但文字保留。专项 14/14 通过，最后一次四插件合并专项 34/34 通过。
- javdb：长报告保留正文并使用短封面 caption，短报告沿用完整 caption；真实 teleproto 上传构造确认 `InputMediaUploadedPhoto.spoiler === true`。虚拟时间验证 59 秒不删除、60 秒删除一次、卸载取消和删除失败日志。专项 11/11 通过。
- music_bot：实例私有队列与游标，发送前历史 ID 和发送返回 ID 作为边界，点击前单独建立媒体边界；排队取消不使后继越过前驱，失败释放后继，重载隔离。专项 10/10 通过，包含 fresh reply 早于 sendMessage 返回的时序。

最新独立全量验收：Core `build:v2`、`typecheck:v2`、`check:v2`、`test:v2` 均退出 0；全量共 1223 项，1222 通过、0 失败、1 跳过。跳过项为平台相关 kernel lock 测试。`test:v2` 同时执行 Plugins `tsconfig.v2.json` 类型检查，不能以 Core 独立 typecheck 代替插件类型检查。JavDB/Music Bot 合并专项 21/21 通过。验收结束未发现目标构建/测试进程残留，完成的执行与验收 Agent 已回收。

音乐队列自测曾并行构建同一缓存目录而出现 ENOTEMPTY，后续按构建器约束串行运行通过；最终验收按串行执行，未隐去该诊断过程。

### 仍待完成

1. P1 数据兼容：全量旧路径/schema/未知字段/ID 精度/默认值、导入幂等和失败回滚；lu_bs 发送中退订、并发配置、重启及取消测试。
2. P1 发布链路：远端 main/开发分支与 TPM 最小 SDK 对齐，干净安装/更新/卸载/重装，以及 `.update` 各失败阶段和 TG 最终通知。annualreport 现在依赖本批新增宿主接口，发布时必须落实兼容要求，不能单独宣称旧核心可安装。
3. P2：本文所列剩余 15 项及历史/未索引入口归属，尚未在本轮新增迁移。
4. 实机与资源：Telegram/JavDB/音乐机器人真实网络、FFmpeg/lottie 真实转换、Linux 进程回收、重复失败句柄测量、同机全进程统计、50 次载卸及 24 小时持续运行。

本批未提交、推送或部署，没有生产配置或权限变化。底层不响应 AbortSignal 的已发出 RPC 仍须等待返回，当前插件会在返回后阻止继续操作。本轮不宣称完整迁移完成或最低资源占用已达成。

## 初始核验范围与限制

Core 当前审阅提交为 14e6ef8；Plugins 本轮起始提交为 85c44aa。Plugins 存在修改中的 generation-tracking-batch-v2.test.js，以及未提交的 sticker、pic_to_sticker、getstickers 和对应批次测试。

按 primary-owned-sol 技能查询配置提供者模型列表，已返回 gpt-5.6-sol。随后派发一个只读核验子任务，但该任务在多次等待及请求中间结果后没有交回报告或测试证据；主任务已关闭并收到 shutdown 通知。未切换其他执行模型。本报告由主模型进行源码证据审阅，不宣称 Sol 核验完成，也不宣称重新运行测试通过。

## 当前进度

索引 126 项中有 111 个 V2 入口，108 个已被 Git 跟踪，3 个为未提交文件。剩余 15 项：eat、gif、music、music_hub、parsehub、quote、say、shift、speedlink、speedtest、ssh、sub、theme、warp、yt-dlp。

完整静态范围仍为 150 个入口：20 个旧内置、127 个主目录扩展、3 个历史扩展。不能把 126 个索引项直接替代完整范围。

当前 migration-status.cjs 输出：planned 35、in-progress 105、offline-verified 10、live-verified 0、accepted 0。证据计数为 implementations 115、contractTests 69、hostTests 46。后两项是文件关联/文本识别，不是实际运行通过数量；live-verified 为 0 表示台账没有记录，不能反推所有功能从未被使用。

## 已有后续修复

| 事项 | 当前源码证据 | 结论 |
| --- | --- | --- |
| 进程资源预算 | runtime.ts:154 配置 180 秒及 2 MiB；host.ts validateProcessRequirements；媒体插件声明 resources.processes | 已实现预算机制，需运行正反例验证 |
| lu_bs | 已有 schemaVersion、订阅正规化、发送时重新读取与按当前订阅更新消息 ID | 原草稿已有重写，完整时区/恢复验收待补 |
| music_bot | botTails、serial、botCursors | 已实现按机器人串行与游标，需验证取消和旧回包 |
| javdb | HTTP allowedHosts/maxRedirects，存在定时器逻辑 | 重定向与销毁已补代码，真实 spoiler/长 caption 待验证 |
| rev | reversedEntities 与发送实体处理 | 已恢复实体路径，多行/Unicode 边界待验证 |
| 迁移台账 | 推断入口只记 in-progress，并列出待验收 | 已区分文件存在与验收完成，历史记录仍需核对 |

## 优先修复清单

### P0：真实宿主测试配置与运行兼容

sticker-media-batch-v2.test.js 的最后一项测试创建默认 PluginHost，却加载声明 180 秒进程需求的 getstickers。默认宿主上限仍是 30 秒，validateProcessRequirements 会拒绝超额需求。此为源码可推导冲突，本轮尚未执行复现。

具体修改：将正例宿主配置为运行时明确支持的预算；新增默认宿主拒绝超额插件的负例，断言错误原因。不要通过删掉插件需求或放宽所有默认限制使测试变绿。其他媒体批次同样检查预算，但只修改实际有冲突的文件。

验证计划：先读 Core package.json 确认脚本；Node 24 执行 npm run build:v2、npm run typecheck:v2、npm run check:v2；Plugins 执行 node --test scripts/sticker-media-batch-v2.test.js；Core 执行 npm run test:v2。记录每条命令的退出码与测试汇总，不用已存在 dist 替代当前构建。

### P1：功能完整性与测试真实性

annualreport 继续对照旧版插件计数与统计语义，不能用报告生成次数代替插件数量。通过宿主只读服务获得已激活插件数，禁止扫描旧目录冒充实际加载。

逐项检查 javdb 的 60 秒销毁、长 caption 拆分、真实上传媒体 spoiler；rev 的多行实体和字素边界；music_bot 的同秒旧消息、队列取消、失败后释放。为每项先写能复现差异的行为测试，再实现最小修复。

验证使用真实 PluginHost、真实资源生命周期和存储。Telegram 请求可在传输边界记录，但涉及媒体构造时断言实际 RPC 类型/字段，而不仅检查任意 options 对象。

### P1：数据兼容与定时任务

对已有迁移器核对旧路径、schema、未知字段、ID 精度和原始默认值。使用匿名化旧样本验证第一次导入、重复导入、失败回滚和并发配置更新。lu_bs 重点验证发送过程中退订不会被旧状态覆盖，重启后任务注册不重复，取消后不再发送。

### P1：发布与用户可用性

核对两仓库当前 main 与开发分支的真实 SHA、TPM 获取分支、最小 SDK 版本。开发分支实现不直接标为可安装。通过干净检出测试安装、更新、卸载和重装；默认命令集合与已安装扩展在 .help 中动态显示。

对 .update 单独验证启动失败、构建失败、重启失败和 TG 通知失败。保留任务 ID、chat ID、原消息 ID；服务恢复后在 Telegram 发送最终结果。线上报错原因必须由当前服务日志验证，不能用本地源码更新代替线上修复证明。

### P2：剩余迁移与资源验收

按现有完整方案完成剩余 15 项，同时审计 3 个历史入口及未索引源码归属。每项先列功能合同和数据迁移，再实现与验证；不以简化功能缩短工作量。

所有必要进程纳入同机资源测量。先跑代表性负载，再进行 50 次加载/卸载和 24 小时持续运行；记录 PSS/RSS、峰值、CPU 时间、吞吐和延迟。未取得数据前不宣称达到最低资源或既定改善比例。

## 实施与独立验收

下一次执行先恢复可用的 Sol 执行路径并确认能及时返回阶段证据。主模型给出 P0 的具体文件边界后，由单个 Sol 实现；结束即回收。再派独立新上下文 Sol，仅运行上述验证计划，返回命令、退出码、数量和失败摘要，结束即回收。通过后依次处理 P1，不并发修改共享宿主和发布脚本。

初始审阅只交付源码状态与修复方案；后续实际修复与测试结果见本文开头的执行进展。完整迁移目标仍未完成。
