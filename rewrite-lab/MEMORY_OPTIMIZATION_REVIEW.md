# MiBot 内存优化审查与验证

日期：2026-09-08。Core 基线 `552ec2b`，Plugins 基线 `d5af08d`。本轮修改运行时任务上下文、JSON 更新、HTTP 文本读取，以及 FBI、BGP、JavDB 三个插件；以本地代码审查、回归和离线测量验收。

## 已实现的修改

| 位置 | 审查发现 | 最终实现与验证 |
| --- | --- | --- |
| `src/v2/executor.ts` | 异步上下文保存整个 Job，后代定时器可在任务结束后继续引用回调和消息载荷 | 上下文只保存重入状态。4 个已完成任务各携带 16 MiB Buffer，保留后代定时器时，修复前 4 个载荷仍存活，修复后全部释放；保留任务排序、取消和重入规则 |
| `src/v2/storage.ts` | 每次已经重新解析文件，再复制完整文档，更新期间同时持有两份对象树 | 更新回调直接使用本次读取的独立文档。保持原子写入、未知字段、大整数、失败回滚和返回值隔离 |
| `src/v2/http.ts` | 每个网络分片产生一个长期保留的字符串，极小分片增加数组和字符串开销 | 按需分配 16 KiB 缓冲区合并小分片，大分片直接解码。保留实际解压字节上限、流式 UTF-8、取消及流释放 |
| `fbi/v2.ts`、`fbi/v2/cache.ts` | 实时加入新群不执行配置上限，降低上限不收缩存量，编辑事件重复占用历史槽位 | 启动、消息接收、配置变更和重建均执行原有群组/消息/期限限制；按最近活动保留群组；同 ID 更新；保留已接收消息的持久化和重建期间的并发消息 |
| `bgp/v2.ts`、`javdb/v2.ts` | 仅加载插件或显示帮助就加载图片、网页处理库 | 到实际查询/渲染时加载；帮助和 BGP DNS 路径保持轻量。真实 SVG→PNG、文件发送前完整读取及临时文件清理通过离线回归 |

FBI 的配置、监视记录和保留记录中的未知字段继续保存。过期、重复和超配额缓存按已有缓存策略清理；降低群组上限立即生效，优先保留最近活动的群组。

## 测量结果

环境：本地 macOS arm64、Node.js `v24.20.0`。每项优化前后各运行 3 个独立进程，交替执行顺序，以下为中位数。使用合成内容，测试中显式执行 GC，以区分对象仍被引用与分配器保留的内存。

| 场景与指标 | 优化前 | 优化后 |
| --- | ---: | ---: |
| 完成任务后仍存活的载荷（4 × 16 MiB） | 64 MiB | 0 MiB |
| JSON 更新回调阶段的 JS 堆（16.54 MiB 文件） | 41.26 MiB | 22.76 MiB |
| 同一 JSON 工作负载的进程最高 RSS | 240.19 MiB | 231.08 MiB |
| 2 MiB HTTP、每次读取 1 字节：读取结束时 JS 堆 | 29.02 MiB | 8.60 MiB |
| 同一 HTTP 工作负载的进程最高 RSS | 167.44 MiB | 79.95 MiB |
| BGP 加载及帮助完成后的 RSS | 91.42 MiB | 58.84 MiB |
| JavDB 加载及帮助完成后的 RSS | 79.63 MiB | 58.83 MiB |

解释与边界：

- 任务载荷释放由 WeakRef 与 ArrayBuffer 计量共同验证；该案例的最高 RSS 均为 113.45 MiB，不能把释放载荷写成 RSS 立即下降 64 MiB。
- JSON 回调堆下降约 45%，指该阶段的存活对象，不是完整进程峰值下降 45%。
- 1 字节 HTTP 分片是极端压力场景。常规 1 KiB 分片的堆为 8.66→8.59 MiB，64 KiB 分片为 8.48→8.49 MiB，基本不变；因此不作普遍网络性能提升的承诺。
- BGP/JavDB 数据是处理库尚未被其他插件加载的独立进程结果。共享依赖的收益不能相加；实际使用后，库仍由 Node 模块缓存管理。
- 本轮没有测量生产机器或完整业务持续运行的 RSS，不等同于生产内存验收。

## 验证

在 Node 24 下执行：

```sh
node scripts/test-v2.cjs
node dist/v2/index.js --check
```

完整脚本包含 Core 与 Plugins TypeScript 检查、默认插件打包、Core 构建及两仓库回归：**1277 项，1276 通过，0 失败，1 跳过**。跳过的是 `src/v2/account.test.ts` 中仅在 Linux 执行的内核文件锁测试。

离线自检返回 `result: ok`，退出清理为 `completed: true`、`pendingTasks: 0`、`pendingResources: 0`；检查期间没有常驻编译器。两仓库差异格式检查通过。

新增回归覆盖：

- 任务结束、后代定时器仍存活时的载荷释放，以及后代在任务结束后正常提交。
- JSON 修改/返回对象隔离、嵌套回滚和大整数。
- 小分片与大分片混合、跨批次 UTF-8、BOM、尾部不完整字符。
- FBI 超额缓存、旧缓存修整、降低上限、编辑去重、立即重载、并发重建、延迟实体查询与卸载期间原子提交。
- 插件加载/帮助时的依赖集合，以及实际图片处理结果。

## 可复现入口

新增 `scripts/memory-profile-v2.cjs`，只使用临时数据、本地构建和模拟响应：

```sh
node scripts/build-v2.cjs --test
node scripts/memory-profile-v2.cjs
node --expose-gc scripts/memory-profile-v2.cjs --case http --chunk 1024
node --expose-gc scripts/memory-profile-v2.cjs --case http --chunk 65536
node --expose-gc scripts/memory-profile-v2.cjs --case plugin --artifact /absolute/path/to/plugin-artifact
```

比较运行时版本时，传入 `--modules /absolute/path/to/compiled-v2`。该目录需包含对应版本的 `executor.js`、`storage.js`、`http.js`、`lifecycle.js`；插件工作负载使用完整构建目录。测量应使用相同 Node 和机器，分别在独立进程执行。

本次本地证据：

- `/tmp/mibot-memory-executor-red.log`：原执行器保留载荷的失败回归。
- `/tmp/mibot-memory-lazy-red.log`：原插件加载处理库的失败回归。
- `/tmp/mibot-memory-comparison.jsonl`：30 组运行时原始测量。
- `/tmp/mibot-memory-plugin-comparison.jsonl`：12 组插件原始测量。
- `/tmp/mibot-memory-plugin-focused.log`：38 项插件聚焦回归。
- `/tmp/mibot-memory-full.log`：完整回归。

## 后续边界

FBI 仍使用完整 JSON 文件持久化，默认最多 300 群 × 每群 3000 条记录；配置允许更高群数。因此缓存现在受约束，但大型历史缓存仍会占用显著内存。进一步降低这部分峰值应评估分组持久化或 SQLite 按需查询，并单独验证数据迁移与检索行为。

本报告覆盖上述代码修复和本地验收；生产内存收益需在部署后，通过相同业务负载的持续测量另行确认。
