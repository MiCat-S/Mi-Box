# MiBot Core 开发与交付

- V2 架构与开发规范见 [`skills/mibot-development/SKILL.md`](skills/mibot-development/SKILL.md)。修改核心、插件或公共 SDK 时，按任务读取其中对应参考；当前源码和测试用于核对具体接口。
- 使用 Node.js 24；完整验证命令为 `npm run test:v2`，依赖同级插件仓库。
- 每批完成并准备提交推送的代码修改，须同步递增应用版本；普通修复和维护默认递增 patch，新功能按兼容性选择 minor，破坏兼容的变更选择 major。同一批修改只递增一次。
- 保持 `package.json.version`、`package-lock.json.version` 和 `package-lock.json.packages[""].version` 一致，并在 `CHANGELOG.md` 记录该版本的日期与用户可见变化。
- `.version`、`.ver` 和 `.update ver` 从应用版本配置读取版本，不写死版本号。
- 完成相关验证、检查改动范围及版本一致性后，主动交给配置好的 Pi Agent 提交并正常推送当前工作分支；已有用户授权，无需再次询问。提交只包含本轮相关文件。
