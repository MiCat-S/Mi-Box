# MiBot systemd 运维

初次安装见 [INSTALL.md](../../INSTALL.md)。
更新由独立的 `mibot-update.service` 临时任务执行，避免更新任务随着
主服务重启而被终止。查看更新结果：

```sh
systemctl status mibot-update.service --no-pager
journalctl -u mibot-update.service -n 100 --no-pager
```
服务名为 `mibot`。安装器根据项目实际目录、当前 Node 24 可执行文件
和插件目录生成两个服务，支持嵌套目录及带空格的路径。
初次安装可用 `npm run service:install -- --root /path/to/project --node /path/to/node --plugins /path/to/plugins`
指定路径；每个参数均可省略，默认从脚本位置、PATH 和同级插件目录检测。
相对路径以调用时的工作目录为准；`--root` 选择已有部署，不移动项目及账号数据。

已有服务需要调整路径时，先停止服务并备份两个服务文件与账号数据，
再在实际项目目录运行 `node scripts/render-service.cjs ./temp/systemd`。
生成器可通过 `--root DIRECTORY` 和 `--plugins DIRECTORY` 指定已有目录，
输出位置由第一个参数决定。直接执行更新脚本时可使用
`bash scripts/update-service.sh --root DIRECTORY`，也兼容原有的位置参数。
按 [手动安装步骤](../../INSTALL.md#手动安装) 检查并替换两个服务文件。
更新任务从自身脚本位置识别仓库，使用服务中保存的 PATH 和
`MIBOT_PLUGINS_DIR`；仓库内的模板文件不能直接作为服务安装。

```sh
systemctl status mibot --no-pager
systemctl restart mibot
systemctl stop mibot
journalctl -u mibot -f
```

日志由 journald 管理，按机器容量配置保留策略。卸载 PM2 前确认它没有
管理其他程序。同一账号不能并行运行两个实例。

## 升级

1. 确认两仓库的目标提交配套，记录原提交，不强制重置未提交改动。
2. 在独立候选目录安装依赖，执行 `npm run package:v2`、
   `npm run test:v2` 和 `npm run check:v2`。保留同级插件目录布局，
   不在运行中的 dist 下构建。
3. 停止服务并确认退出；备份旧程序、dist、package.json、锁文件、
   config.json、.env 和 assets。备份含账号密钥，限制访问权限，
   不上传到 GitHub。
4. 整体替换通过验证的 `dist/v2` 与 `dist/v2-plugins-active`；
   依赖有变化时安装匹配版本。保留生产配置、assets 和旧产物，
   不复制候选测试账号的数据。
5. 启动服务，检查 `runtime.ready`、进程稳定性、错误日志，
   并实测 Telegram 关键命令。仅 active 不代表登录就绪。

## 回滚

停止服务后恢复旧程序、插件和匹配依赖，保留升级后写入的数据。
涉及不兼容数据迁移时使用对应恢复步骤，不用旧快照直接覆盖生产数据。
启动后重复就绪和关键命令检查。
