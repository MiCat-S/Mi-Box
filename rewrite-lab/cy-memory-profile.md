# 词云绘图进程内存评估

`node scripts/cy-memory-profile-v2.cjs` 对比现有 `cy` 绘图函数在主进程和按需子进程中的表现。子进程用于离线实验，运行中的词云插件继续使用现有绘图路径。

## 本机测量

2026-09-09，macOS arm64，Node.js 24.20.0、Canvas 3.2.3。使用合成词频，经原版筛选得到 220 个词，生成 900 × 640 PNG。每种方式连续绘图 5 次，再交换执行顺序重复一组，避免仅凭首次启动耗时作判断。

| 指标 | 进程内绘图 | 每张图片启动子进程 |
| --- | ---: | ---: |
| 第五次绘图后空闲 RSS | 93.3–93.5 MiB | 61.2 MiB |
| 整个进程树采样 RSS 峰值 | 93.3–93.5 MiB | 151.8 MiB |
| 后四次绘图耗时中位数 | 151.9–153.5 ms | 287.7–288.1 ms |
| 完成绘图后的进程数量 | 1 | 1 |
| 父进程是否加载 Canvas | 是 | 否 |

两组共 20 张图片的字节完全相同，SHA-256 为 `ed34be988780c106eb2ab924f68fb09dbfe79bcad7b34fa889ded634c39a037d`。

这组结果支持按需子进程降低绘图后的常驻内存，同时显示它增加执行期间的总 RSS 和重复绘图耗时。是否适合目标服务器，取决于可用内存、绘图频率及 Linux 上的实测结果。

## Linux 复测

在安装了项目依赖的 Node.js 24 环境中，从 Core 仓库运行：

```sh
npm run build:v2
node scripts/cy-memory-profile-v2.cjs --plugins ../TeleBox-Plugins --output /tmp/cy-profile-inline-first.json
node scripts/cy-memory-profile-v2.cjs --plugins ../TeleBox-Plugins --order child-first --output /tmp/cy-profile-child-first.json
```

`--plugins` 指向包含 `cy/v2/wordcloud.ts` 的插件源码仓库。输出路径必须是尚不存在的文件。脚本使用合成输入，不调用 Telegram 或 HTTP；只在 Core 的 `temp` 下建立实验文件，结束后清理。

JSON 记录 Node、Canvas、系统、可用中文字体路径、绘图源码哈希、PNG 哈希、每轮耗时和内存，以及子进程环境策略（`childEnvStrategy`）。当前实现为 `"inherited"`，子进程继承完整父环境；如部署采用其他环境变量策略，应使用该策略重新测量。Linux 额外读取 `/proc/<pid>/smaps_rollup` 计算进程树 PSS；无权限或进程在读取期间退出时，该次 PSS 为 `null`。运行脚本不需要提升权限。

比较目标包括：

- 原版渲染与子进程渲染在相同字体环境下是否产生完全相同的 PNG。
- 父进程和绘图子进程的合计 RSS、PSS，以及绘图结束后的空闲占用。
- 首次与连续绘图耗时、子进程是否全部退出。
- 目标机器在其他插件同时活动时是否仍有足够的执行内存余量。

## 测量边界

- 空闲采样前显式执行 JS GC，以观察绘图后的保留内存；这不是生产服务的自然 GC 时序。
- RSS 加总会重复计算共享内存页；Linux PSS 将共享页按比例分摊。
- 20 ms 定时采样可能错过短时峰值，报告中的峰值是已观测值的下界。报告还列出实际最大采样间隔。
- 子进程自身的 `maxRSSKiB` 是它整个生命周期的高水位，不能与另一个时刻的父进程峰值直接相加作为同时峰值。
- 子进程继承父进程完整环境变量。如果生产部署限制子进程环境（剥离 PATH、无 HOME 等），可能影响 Canvas 字体查找和原生内存行为，需要在对应环境下复测。
- 本机未安装代码中列出的 Linux 中文字体，使用了系统字体回退；本机像素一致不代替 Linux 字体环境验证。
- 实验只覆盖词云选词与绘图，不包含真实消息拉取、上传、其他插件负载或完整服务基线。
