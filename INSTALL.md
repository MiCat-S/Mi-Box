# MiBot 部署教程

MiBot 使用你的 Telegram 账号运行。准备一台能访问 GitHub、npm 和 Telegram 的
Debian/Ubuntu 服务器，系统须已启用 systemd。

下面按首次部署顺序操作。标为 `sh` 的命令在服务器终端执行；以 `.tpm`、
`.help` 开头的命令在 Telegram 发送。某一步报错时，先处理该错误，再继续下一步。

## 1. 登录服务器

打开电脑上的终端或 SSH 工具，连接你的服务器。将下面的 `服务器IP` 换成实际 IP：

```sh
ssh root@服务器IP
```

输入服务器密码或使用 SSH 密钥登录。后续服务器命令均以 root 执行；
如果你使用普通用户登录，先执行 `sudo -i` 切换到 root。

## 2. 安装运行环境

先安装系统依赖：

```sh
apt-get update
apt-get install -y curl ca-certificates git build-essential python3 pkg-config libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev bind9-dnsutils util-linux
```

MiBot 需要 **Node.js 24**。如果 `node --version` 已显示 `v24.x`，可跳过下面的
Node 安装命令。否则，使用 [nvm 官方安装方式](https://github.com/nvm-sh/nvm/tree/v0.40.4#install--update-script)
安装并启用 Node 24：

```sh
export NVM_DIR="$HOME/.nvm"
mkdir -p "$NVM_DIR"
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.4/install.sh -o /tmp/mibot-nvm-install.sh && bash /tmp/mibot-nvm-install.sh
. "$NVM_DIR/nvm.sh"
nvm install 24
nvm alias default 24
nvm use 24
node --version
npm --version
```

最后两行应分别显示 `v24.x` 和 npm 的版本号。

## 3. 下载并构建 MiBot

下面将主程序放在 `/root/mibot`。你也可以选择其他目录，只需在后续 `cd`
命令中使用同一个路径。首次部署只需要下载主仓库：

```sh
git clone --branch main https://github.com/MiCat-S/Mi-Box.git /root/mibot
cd /root/mibot
npm ci
npm run package:v2
npm run check:v2
```

`npm ci` 安装依赖，`package:v2` 构建主程序，`check:v2` 执行离线自检。
最后一条命令输出中出现 `"result":"ok"`，表示离线自检通过。

`ai`、`gt` 等扩展由插件仓库维护，启动后通过 Telegram 中的 `.tpm install`
下载和安装。扩展产物及配置保存在主项目内；部署时无需手动克隆插件仓库。

如果 Git 提示目标目录已经存在且不为空，先确认那里是否已有 MiBot，
不要删除目录后重新安装；已有部署请看下方的更新说明。

## 4. 登录 Telegram 账号

在浏览器打开 [my.telegram.org](https://my.telegram.org)，用要部署的 Telegram
账号登录，进入 **API development tools**，按表单创建应用，取得 `api_id`
和 `api_hash`。详细说明见 [Telegram 官方文档](https://core.telegram.org/api/obtaining_api_id)。

回到服务器终端执行：

```sh
cd /root/mibot
umask 077
npm run login
```

按终端提示依次输入：

| 提示 | 输入内容 |
| --- | --- |
| `API ID` | 刚才取得的 `api_id`，是一串数字 |
| `API hash` | 刚才取得的 `api_hash` |
| `Phone number (+country code)` | Telegram 手机号，包含 `+` 和国家或地区代码 |
| `Telegram login code` | Telegram 发给你的登录验证码 |
| `Two-step verification password` | 账号开启了两步验证时，输入其密码 |

敏感输入不会显示在终端，输入后按回车即可。看到
`Mi Box account saved to config.json` 表示登录成功。
账号会话保存在项目的 `config.json`，请妥善保管，不要发送给他人或提交到 GitHub。

如果提示 `config.json exists`，说明已有账号配置。已有账号迁移应保留
`config.json`、`.env` 和 `assets/`，跳过登录步骤；不要删除配置来绕过提示。

## 5. 验证账号能正常运行

在服务器终端执行：

```sh
npm start
```

日志出现 `runtime.ready` 后，打开刚才登录的 Telegram 账号，在“收藏夹”
分别发送下面两条消息：

```text
.help
.ping
```

能看到命令帮助和延迟结果后，回到服务器终端按 **Ctrl+C**，等待程序退出。
下一步会交给 systemd 在后台运行，同一账号不要同时启动多个实例。

## 6. 安装后台服务

在服务器终端执行：

```sh
cd /root/mibot
npm run service:install
```

安装器会构建、自检、备份并启动服务，同时设置开机自启。
看到 `MiBot is ready and enabled at boot.` 表示安装和启动检查通过。
再到 Telegram 发送一次 `.ping`，确认后台服务可以响应，随后可关闭 SSH 连接。

服务以 root 运行，名称为 `mibot`。账号和插件拥有该运行账户的权限，
请只安装可信代码。安装器用于首次安装；已有服务使用下面的更新流程。
安装失败时会恢复主程序和服务定义、保留账号数据，并打印备份位置。

## 7. 在 Telegram 安装插件

下面的命令在 Telegram“收藏夹”中发送。以 AI 和翻译插件为例，依次发送：

```text
.tpm search ai
.tpm install ai gt
.tpm list
```

等待安装结果后，`.tpm list` 应列出 `ai` 和 `gt`。然后分别发送 `.help ai`
和 `.help gt`，按插件帮助配置 AI 接口和模型。安装其他插件时，将名称换成
搜索结果中的插件名，例如 `.tpm install dig ip ids`。

| 用途 | Telegram 命令 |
| --- | --- |
| 按名称或功能搜索 | `.tpm search 翻译` |
| 一次安装多个插件 | `.tpm install ai gt dig` |
| 查看已安装插件 | `.tpm list` |
| 更新全部已安装插件 | `.tpm update all` |
| 卸载指定插件，保留配置 | `.tpm remove dig` |
| 查看插件参数与使用方法 | `.help 插件名` |

插件安装记录会在服务重启后恢复。`.agent` 依赖 `ai` 提供聊天服务，
使用前同样需要安装并配置 `ai`。

## 更新与日常管理

在 Telegram 中发送 `.update` 更新主程序，发送 `.tpm update all` 更新已安装插件。
两种更新分别管理主程序和扩展。

从 0.6.x 升级后，需要 AI 或翻译功能时发送 `.tpm install ai gt`。
原有插件配置保留，安装后可继续使用。

遇到运行问题，在服务器执行对应命令：

| 用途 | 服务器命令 |
| --- | --- |
| 查看服务状态 | `systemctl status mibot --no-pager` |
| 查看最近 100 行日志 | `journalctl -u mibot -n 100 --no-pager` |
| 持续查看日志，Ctrl+C 退出查看 | `journalctl -u mibot -f` |
| 重启服务 | `systemctl restart mibot` |
| 停止服务 | `systemctl stop mibot` |
| 启动服务 | `systemctl start mibot` |

`active (running)` 表示进程正在运行；是否能正常使用仍以 Telegram 命令响应为准。
备份、升级和回滚详见 [运维说明](deploy/systemd/README.md)。

## 自定义路径

安装器默认使用脚本所在的项目目录和当前 PATH 中的 Node 24。
需要明确指定时，可以分别使用两个可选参数：

```sh
npm run service:install -- --root /srv/mibot --node /opt/node24/bin/node
```

`--root` 选择已有项目目录；`--node` 指定 Node 24 可执行文件。
相对路径以调用时的工作目录为准。主服务和更新服务保存同一组绝对路径，
程序与账号数据留在部署目录，服务文件注册到 `/etc/systemd/system`。

### 手动安装

使用上一节安装器即可完成常规部署。手动维护服务文件时，在项目目录生成并检查：

```sh
node scripts/render-service.cjs ./temp/systemd
systemd-analyze verify ./temp/systemd/mibot.service ./temp/systemd/mibot-update.service
install -m 644 ./temp/systemd/mibot.service /etc/systemd/system/mibot.service
install -m 644 ./temp/systemd/mibot-update.service /etc/systemd/system/mibot-update.service
systemctl daemon-reload
systemctl enable --now mibot
```

仓库内的 `.service` 文件是模板，应安装生成后的文件。
生成器也支持 `--root /srv/mibot`，Node 路径取执行生成器的 Node 24。
替换已有服务文件前，先停止服务并备份服务文件、账号配置和 `assets/`。
直接调用更新脚本可用 `bash scripts/update-service.sh --root /srv/mibot`。

已有 `telebox-v2.service` 的部署，应先备份并停止旧服务，生成并安装
`mibot.service` 和 `mibot-update.service`，确认 Telegram 命令响应正常后禁用旧服务。
