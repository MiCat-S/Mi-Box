# MiBot

Telegram UserBot，基于 Node.js 24、TypeScript 和 Teleproto。
V2 预编译后由 Node 直接运行，生产服务使用 systemd。

## 部署

**第一次部署，请按 [从零部署教程](INSTALL.md) 操作。** 教程包括服务器连接、
Node.js 24 安装、Telegram 登录、后台服务及插件安装，每一步都注明执行位置和成功标志。

已准备好 Debian/Ubuntu、root 权限和 Node.js 24 的用户，可在服务器终端依次执行：

```sh
git clone --branch main https://github.com/MiCat-S/Mi-Box.git /root/mibot
cd /root/mibot
npm ci
npm run package:v2
npm run check:v2
npm run login
npm start
```

`npm run login` 会依次询问 API ID、API hash、手机号和验证码；获取方式及输入说明见教程。
`npm start` 出现 `runtime.ready` 后，在自己的 Telegram“收藏夹”分别发送 `.help`、`.ping`。
确认有响应，回到终端按 Ctrl+C 停止前台实例，再安装后台服务：

```sh
npm run service:install
```

看到 `MiBot is ready and enabled at boot.` 后，再到 Telegram 发送 `.ping` 验证。
后台服务配置完成后即可关闭 SSH 连接。

项目可部署在其他目录，服务路径自动识别；自定义 Node 和手动服务配置见教程。
扩展插件通过 Telegram 安装，部署时只需克隆主仓库。

## 功能

默认命令：

```text
.agent .memory .ping .status .sysinfo .tpm .update
.alias .autofix .bf .env .exec .h .help .loglevel
.prefix .restart .sudo .ver .version
```

`ai`、`gt`、`dig` 等扩展从插件仓库按需安装。以下命令在 Telegram“收藏夹”发送，
例如安装 AI 助手和翻译插件：

```text
.tpm search ai
.tpm install ai gt
.tpm list
.help ai
.help gt
```

等待安装结果，再按 `.help ai` 和 `.help gt` 配置接口及模型。`.agent` 也需要
先安装并配置 `ai`。安装多个插件时用空格分隔，例如 `.tpm install dig ip ids`。

`.tpm install all` 一次下载仓库并安装全部可用 V2 扩展，跳过已加载和默认模块。单个插件安装失败后会继续处理其余插件，并汇总结果。`.tpm update all` 一次下载仓库并更新全部已安装扩展；`.tpm remove all` 卸载全部已安装扩展并保留配置数据。两者均逐个处理，单个失败后继续并汇总结果。TPM 管理命令支持账号本人在群内使用频道身份发送的新消息。

TPM 仅允许账号所有者管理扩展。安装和更新从配套插件仓库的 main
下载源码，短时构建后加载；安装记录会在服务重启时恢复。
卸载保留配置数据。扩展代码具有运行账号的权限，安装前确认信任。

`.update` 更新主程序并重启服务。TPM 已安装扩展通过 `.tpm update all` 单独更新。

参数以 `.help 命令` 为准。旧版插件仍在迁移，不能把任意旧版 `.ts`
直接作为 V2 插件安装。subinfo 文件导出等功能尚未迁移。

## 开发

- SDK：`src/v2/sdk.ts`
- 核心入口：`src/v2/index.ts`
- 插件入口：插件目录内的 `v2.ts`
- 打包：`npm run package:v2`
- 测试：`npm run test:v2`，需要 Node 24 和同级插件仓库
- 离线检查：`npm run check:v2`，不会登录 Telegram

每个 V2 插件只有一处业务实现：默认内置由 `src/v2/builtins` 维护，按需安装的扩展由插件仓库维护。`leech`、`re`、`sure` 使用扩展实现；`ai`、`gt` 同样通过 TPM 按需安装。历史兼容包可保留插件身份和说明，业务命令、监听器及生命周期操作由所属实现提供。全量测试会检查跨仓库同名实现的归属。

`config.json`、`.env`、`assets/` 含账号和插件数据，不得公开上传。
服务管理见 [运维说明](deploy/systemd/README.md)，许可证见 [LICENSE](LICENSE)。

### 自定义显示名

账号本人可在群聊、私聊或收藏夹发送 `.help name Cat Bot`，即可将帮助、更新、重启及年度报告中的显示名设置为 `Cat Bot`。支持空格和中文，最多 48 个字符；设置立即生效，并保存到 `assets/help/branding.json`。

- `.help name`：查看当前显示名。
- `.help name reset`：恢复默认 `MiBot`。

扩展插件通过 `telebox/sdk` 的 `getBotName()` 读取当前显示名；拼入 HTML 时须转义。服务名、命令和仓库地址保持固定。
