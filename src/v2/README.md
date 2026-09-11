# MiBot V2 Runtime

MiBot 使用 Node.js 24 运行预编译 TypeScript。`index.ts --serve` 启动认证账号、
协议适配和插件宿主；`index.ts --check` 执行离线集成检查。生产服务使用 Linux systemd。

## 架构与开发规范

[MiBot 开发 Skill](../../skills/mibot-development/SKILL.md) 是 V2 开发入口，按任务读取：

- [架构与依赖边界](../../skills/mibot-development/references/architecture.md)：模块归属、受管资源和插件代际。
- [插件开发](../../skills/mibot-development/references/plugin-development.md)：声明、命令、帮助、状态与 Telegram 协议。
- [验证与交付](../../skills/mibot-development/references/verification.md)：构建、回归、兼容性及交付边界。

公共接口以 [`sdk.ts`](sdk.ts) 为准，命令声明细节见 [V2 SDK](../../docs/v2-sdk.md)。
历史迁移记录保存在 `rewrite-lab/` 和 `docs/v2-command-migration.md`。

## 构建与验证

从 Core 根目录执行：

```sh
npm run package:v2
npm run check:v2
```

Core 可独立构建。完整开发验证需要同级配套插件仓库：

```sh
npm run test:v2
npm run test:plugins:v2
```

`test:v2` 检查两仓类型、Core、构建链及插件回归；`test:plugins:v2` 构建扩展并验证真实
Host 加载、卸载和资源收尾。离线检查使用临时数据及模拟传输，不读取账号配置、不登录
Telegram，也不加载用户已安装的扩展。

## 运行与扩展

账号连接、互斥和进程退出由 `runtime.ts` / `account.ts` 管理。基础内置在 runtime
注册，业务扩展通过 TPM 安装，服务重启时恢复安装记录。扩展导出同步、无副作用的插件
工厂，通过 `telebox/sdk` 获取声明及宿主能力。

构建插件候选不会激活它。发布协调器负责完整性检查、旧代清理、新代激活及选择记录，
资源清理失败不能视为换代成功。构件完整性检查不构成不可信代码沙箱。

实际安装、登录和服务管理见 [部署教程](../../INSTALL.md) 与
[运维说明](../../deploy/systemd/README.md)。
