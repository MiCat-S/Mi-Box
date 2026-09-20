# MiBot systemd 运维

初次安装见 [INSTALL.md](../../INSTALL.md)。
更新由独立的 `mibot-update.service` 临时任务执行，避免更新任务随着
主服务重启而被终止。查看更新结果：

```sh
systemctl status mibot-update.service --no-pager
journalctl -u mibot-update.service -n 100 --no-pager
```
服务名为 `mibot`。安装器根据项目实际目录、当前 Node 24 可执行文件
生成两个服务，支持嵌套目录及带空格的路径。
初次安装可用 `npm run service:install -- --root /path/to/project --node /path/to/node`
指定路径；每个参数均可省略，默认从脚本位置和 PATH 检测。
相对路径以调用时的工作目录为准；`--root` 选择已有部署，不移动项目及账号数据。

已有服务需要调整路径时，先停止服务并备份两个服务文件与账号数据，
再在实际项目目录运行 `node scripts/render-service.cjs ./temp/systemd`。
生成器可通过 `--root DIRECTORY` 指定已有部署目录，
输出位置由第一个参数决定。直接执行更新脚本时可使用
`bash scripts/update-service.sh --root DIRECTORY`，也兼容原有的位置参数。
按 [手动安装步骤](../../INSTALL.md#手动安装) 检查并替换两个服务文件。
更新任务从自身脚本位置识别仓库，使用服务中保存的 PATH；
仓库内的模板文件不能直接作为服务安装。扩展通过 TPM 下载并安装在主项目内。

```sh
systemctl status mibot --no-pager
systemctl restart mibot
systemctl stop mibot
journalctl -u mibot -f
```

日志由 journald 管理，按机器容量配置保留策略。卸载 PM2 前确认它没有
管理其他程序。同一账号不能并行运行两个实例。

## 沙箱

`mibot.service` 启用了一组 systemd 加固选项（`NoNewPrivileges`、
`ProtectSystem=full`、`ProtectKernel*`、`RestrictSUIDSGID` 等）。服务文件内
注释说明了哪些选项被刻意排除及其原因，修改前先读该注释。更新用的
`mibot-update.service` 和 `mibot-update-monitor.service` 不加固，它们需要
执行 git、npm 和 `systemctl restart`。

服务仍以 root 运行。`.exec` 和 TPM 安装的扩展拥有该身份的全部权限，
只安装可信代码。降权到专用非 root 用户需要为 `mibot.service`、
`mibot-update.service` 和 `mibot-update.timer` 配置 polkit 规则，属于独立改动。

## 内存

启动后常驻约 110 MB，其中 Telegram 协议层的 TL 定义占大头，属固定成本。
扩展按需加载 `sharp`、`canvas` 等依赖，装得越多常驻越高。

内存紧张的机器可以给 V8 设堆上限，让回收更早触发：在 `mibot.service` 的
`ExecStart` 中于 `@RUNTIME@` 前加 `--max-old-space-size=<MB>`。此处不预置
数值：设得低于扩展的实际峰值会让进程 OOM，图片和视频处理类扩展尤其吃内存。
先用 `.memory` 观察若干天的 RSS 峰值，再取峰值之上的余量。

`systemctl status mibot` 显示当前占用；cgroup 级别的 `MemoryHigh=` 可以在
超限时触发回收而不直接杀进程，`MemoryMax=` 则会直接杀，按需选择。

## 升级

1. 确认两仓库的目标提交配套，记录原提交，不强制重置未提交改动。
2. 在独立候选目录安装依赖，执行 `npm run package:v2`、
   `npm run test:v2` 和 `npm run check:v2`。全量开发测试需要同级插件源码仓库；
   常规构建与部署只需要 Core。不在运行中的 dist 下构建。
3. 停止服务并确认退出；备份旧程序、dist、package.json、锁文件、
   config.json、.env 和 assets。备份含账号密钥，限制访问权限，
   不上传到 GitHub。
4. 整体替换通过验证的 `dist/v2`，保留 `dist/v2-plugins` 中的已安装扩展；
   依赖有变化时安装匹配版本。保留生产配置、assets 和旧产物，
   不复制候选测试账号的数据。
5. 启动服务，检查 `runtime.ready`、进程稳定性、错误日志，
   并实测 Telegram 关键命令。仅 active 不代表登录就绪。

## 回滚

停止服务后恢复旧程序、插件和匹配依赖，保留升级后写入的数据。
涉及不兼容数据迁移时使用对应恢复步骤，不用旧快照直接覆盖生产数据。
启动后重复就绪和关键命令检查。
