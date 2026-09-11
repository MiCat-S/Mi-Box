# MiBot V2 安装

## 环境

在线服务目前支持 Linux。以下命令面向 Debian/Ubuntu 的 root 终端。
先安装 Node.js 24 和 npm，确认 `node --version` 为 `v24.x`。
不要复制其他机器的 node_modules，原生依赖需要匹配当前平台。

```sh
apt-get update
apt-get install -y git build-essential python3 pkg-config libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev bind9-dnsutils util-linux
```

## 获取与构建

两个仓库都使用 `main` 分支。项目可放在任意目录，包括嵌套目录；
下面使用 `/root/mibot` 作为示例。插件默认从项目同级的 `mibot-plugins`
或 `TeleBox-Plugins` 目录读取。已有目录不得直接覆盖。

```sh
git clone --branch main https://github.com/MiCat-S/Mi-Box.git /root/mibot
git clone --branch main https://github.com/MiCat-S/Mi-Box-Plugins.git /root/mibot-plugins
cd /root/mibot
npm ci
npm run package:v2
npm run check:v2
```

插件仓库放在其他位置时，在构建前指定实际路径：

```sh
export MIBOT_PLUGINS_DIR=/srv/mibot-plugins
npm run package:v2
```

离线检查通过不代表 Telegram 登录或全部插件外部接口已验证。
打包只包含默认模块所需的 `ai`、`gt`，其他扩展在 TG 通过
`.tpm search` 查找后安装，不随安装器自动启用。支持一次指定多个插件：

```text
.tpm install aban acron aff autochangename bgp bulk_delete checkapi clean_member dc dig dme duckduckgo encode exec ids ip keyword portball rate re
```

插件名以空格或换行分隔；重复名称只处理一次，失败项单独汇总。
`.tpm update 插件名 [插件名 ...]` 和 `.tpm remove 插件名 [插件名 ...]`
同样支持多个名字。`all` 单独使用。

## 登录与前台验证

准备自己申请的 Telegram `api_id` 和 `api_hash`：

```sh
cd /root/mibot
umask 077
npm run login
```

输入 API 凭据、手机号、验证码及两步验证密码。成功后生成权限为
0600 的 `config.json`，已有文件不会被覆盖。此入口支持手机号登录，
目前不提供二维码登录和代理配置向导。

已有账号迁移须保留原 `config.json`、`.env` 和 `assets/`，无需重复登录。
先停掉同一账号的所有旧实例，再运行：

```sh
npm start
```

看到 `runtime.ready` 后，在 Telegram 验证 `.help`、`.ping`、`.memory`。
按 Ctrl+C 并等待完全退出，再启用 systemd。不能同时运行前台、PM2
和 systemd 中的同一账号。

## systemd

完成登录后，可用一条命令完成构建、离线检查、备份、安装服务、
开机自启和启动就绪检查：

```sh
cd /root/mibot
npm run service:install
```

安装器从脚本位置识别项目目录，自动选择当前 PATH 中的 Node 24，
生成主服务和更新服务所需的绝对路径。也可明确指定：

```sh
npm run service:install -- --root /srv/mibot --node /opt/node24/bin/node --plugins /srv/mibot-plugins
```

三个参数均可省略；`--root` 选择已有部署目录，不会移动或复制项目。
相对路径以执行命令时的工作目录为准，目录符号链接会解析为实际路径。
两个服务保存相同的部署目录、Node 搜索路径和插件目录，更新任务沿用这些设置。
程序、配置及账号数据继续保存在部署目录内；服务注册文件位于
`/etc/systemd/system`。

运行前须停止同账号的其他实例（包括其他机器上的实例）。此脚本用于
首次安装，发现本机账号进程、已启用的服务或安装并发时会拒绝执行。
不会重新登录或覆盖 config.json。失败时恢复程序和服务定义并停服，
保留账号数据；备份路径会在终端打印。成功后仍需在 TG 验证 `.help`
和 `.ping`。已有服务升级请使用运维说明，不要重复运行安装器。

### 手动安装

在实际项目目录中生成服务文件，再检查和安装。仓库中的 `.service` 文件是
带占位符的模板；生成器会填入当前路径。现有服务调整路径前，先停止服务，
备份两个已安装的服务文件以及账号数据。

```sh
node scripts/render-service.cjs ./temp/systemd
systemd-analyze verify ./temp/systemd/mibot.service ./temp/systemd/mibot-update.service
install -m 644 ./temp/systemd/mibot.service /etc/systemd/system/mibot.service
install -m 644 ./temp/systemd/mibot-update.service /etc/systemd/system/mibot-update.service
systemctl daemon-reload
systemctl enable --now mibot
systemctl status mibot --no-pager
journalctl -u mibot -n 50 --no-pager
```

生成器也支持 `node scripts/render-service.cjs ./temp/systemd --root /srv/mibot --plugins /srv/mibot-plugins`。
输出目录相对于当前工作目录，Node 路径取执行生成器的 Node 24；省略选项时
使用生成器所在项目及默认插件目录。直接运行更新脚本时，可用
`bash scripts/update-service.sh --root /srv/mibot` 选择已有部署，省略时从脚本位置识别。

服务以 root 运行。插件和 `.exec` 将拥有该账户权限，只安装可信代码。
非 root 部署需要另行调整所有权及服务管理授权。

服务名为 `mibot`，与 `.restart` 一致；直接执行 Node。
升级、备份、回滚见 [运维说明](deploy/systemd/README.md)。

已有 `telebox-v2.service` 的部署，先备份并停止旧服务，
在实际项目目录中生成并安装 `mibot.service` 和 `mibot-update.service`。
确认新服务正常后禁用旧服务，禁止两个实例同时运行。GitHub 仓库地址
不受本地目录名影响，继续使用上面的 Mi-Box 和 Mi-Box-Plugins 地址。
