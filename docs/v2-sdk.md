# V2 命令与消息过滤 SDK

结构化声明从 Core 0.5.0 起提供。先更新 Core，再安装或更新使用结构化声明的扩展。
Core 继续接收现有 API 1 插件；新命令声明使用 `STRUCTURED_PLUGIN_API_VERSION`。
旧 Core 缺少此能力时会明确拒绝加载，插件激活失败按现有发布机制恢复原版本。
构建产物的 manifest ABI 仍使用 `PLUGIN_API_VERSION`，与插件声明能力版本分别管理。

每个插件保持一处业务实现。Core 内置与按需安装的扩展各自维护所属命令、帮助及回归测试；`ai`、`gt`、`leech`、`re`、`sure` 由插件仓库提供，通过 TPM 安装。Core 独立构建，历史兼容包只保留身份和说明。架构约束及开发流程见 [MiBot 开发 Skill](../skills/mibot-development/SKILL.md)。

## 命令声明

工厂同步返回声明；初始化资源放入 `setup`，业务资源放入受宿主管理的处理函数。
声明同时驱动命令分发与帮助，无需维护另一份命令表。

```ts
import {
  definePlugin, STRUCTURED_PLUGIN_API_VERSION, renderCommandHelp,
  type CommandDefinition,
} from "telebox/sdk";

export default function createExample() {
  const example: CommandDefinition = {
    description: "文本工具",
    args: "文本",
    helpArgs: ["help", "h"],
    examples: [{args: "你好世界"}, {args: "status"}],
    subcommands: {
      status: {
        description: "查看状态", aliases: ["st"], args: "",
        async handle({message}, ctx) {
          await ctx.telegram.edit(message, "Ready");
        },
      },
    },
    help: [{heading: "输入说明：", body: "文本保留原消息内容；可用 <code>{prefix}example status</code> 查看状态。"}],
    async handle({message}, ctx) {
      await ctx.telegram.edit(message, message.text);
    },
  };
  return definePlugin({
    apiVersion: STRUCTURED_PLUGIN_API_VERSION,
    id: "example", description: "文本工具",
    commands: {example},
    renderHelp: prefix => renderCommandHelp("example", example, {prefix}),
  });
}
```

- `subcommands` 可递归嵌套，每个节点关联 `handle`；匹配失败交给最近节点的处理函数。`defaultSubcommand` 只在该层参数为空时选择默认节点。
- 默认忽略子命令名称与别名的大小写。`subcommandsCaseSensitive` 按层继承并可覆盖；子节点的 `caseSensitive` 可单独覆盖其名称和别名的匹配规则。
- 子命令名支持字母、数字、下划线，以及首字符之后的连字符，例如 `wl-words`。同层名称与别名必须在该层大小写规则下无冲突。
- `invocation.args` 只包含匹配路径之后的参数；`subcommands` 为规范化后的完整路径，`subcommand` 为最深节点名称。`message.text` 保持原样，全文、多行、正则、JSON、组合选项及实体偏移继续用原始消息解析。
- 根命令名和多个命令入口仍在 `commands` 中声明；子命令 `aliases` 只作用于所属层。
- `authorize` 沿匹配路径父先子后执行，返回 `false` 后停止业务。`public` 豁免该节点自身授权；直接根子节点公开时也豁免根授权，更深的公开节点不豁免祖先。重复规范化不会重复执行授权或业务。

## 帮助内容与入口

`args` 是用法尾部；`arguments` 说明参数名称、是否必填及含义；`alternates` 表达同一处理器支持的其他用法；`examples` 给出可执行示例。子命令示例从其父路径展开，如 `status` 节点示例填写 `status`。`help` 保留依赖、配置流程、限制、故障提示和长示例；子命令还可声明 `group` 和 `notes`。

`renderCommandHelp` 递归生成整棵树，或使用 `path` 渲染聚焦子树。Host 的 `.cmd sub --help` 与 `.help cmd sub` 读取同一声明；原有根帮助入口由 `helpArgs`、`helpOnEmpty`、`renderHelp` 表达。帮助不执行业务处理器或授权处理器，勿在帮助中包含私密运行状态。

根 `helpArgs` 只匹配单个参数；嵌套聚焦帮助要求完整有效的子命令路径，末尾为 `--help`，避免误截业务文本。插件原先按首词处理的帮助语法仍由业务回退保留。API 1 的帮助触发方式保持兼容。

帮助随当前前缀生成，公共帮助入口沿用宿主 HTML 和分页处理。`help.body`、`notes` 和渲染器标题等是受信任 HTML；动态内容须使用 `ui.text`、`ui.code` 等转义。`{prefix}` 由渲染器替换为已转义前缀。宿主列出的命令描述树不含处理函数且深冻结。

## 消息过滤

命令和监听器均可声明 `chats`、`direction`、`ignoreForwarded`、`includeSaved`；命令继续支持 `ignoreEdited`，监听器继续支持 `edited` 与 `ignoreCommands`。

```ts
listeners: [{
  chats: ["private"],
  direction: "incoming",
  ignoreForwarded: true,
  edited: false,
  async handle(message, ctx) {
    // 用户名单、业务开关等动态规则在这里判断。
  },
}]
```

| 字段 | 行为 |
| --- | --- |
| `chats` | `private`、`group`、`supergroup`、`broadcast`；未知类型不匹配任何受限列表 |
| `direction` | `incoming` 或 `outgoing`；省略时允许双向 |
| `ignoreForwarded` | 为 true 时在处理器运行前拒绝转发消息 |
| `includeSaved` | 收藏夹可豁免方向限制，其他过滤条件仍执行 |
| 监听器 `edited` | true 允许编辑与新消息；false 或省略均拒绝编辑消息 |
| 监听器 `ignoreCommands` | 跳过宿主识别为命令的消息 |

聊天类型由协议 peer、消息事实及已知实体确定，不逐消息联网补查；不足或矛盾信息标为 `unknown`。收藏夹仍是私聊，并用 `saved` 标识。过滤在本人命令和委托命令入口一致执行，拒绝路径不会进入业务或读写业务状态。过滤限定消息范围；权限检查仍由原有授权逻辑负责。

`requireSdkFeatures("commandMetadata", "messageFilter", "commandHelp")` 可显式声明依赖的能力；使用新结构化字段时必须采用 API 2 声明。

## 仓库描述搜索与验证

`.tpm search [关键词]` 忽略大小写匹配名称或描述，空参数展示全部，逐项显示名称与描述并稳定排序、分页。描述来自同一次 Git 仓库读取的 `plugins.json`；可安装项仍由实际 `ID/v2.ts` 决定。缺少描述不影响名称搜索，索引不可用时明确提示。默认模块排除、大小写冲突处理及安装更新流程保持原有规则。

在 Node.js 24 下从 Core 运行，插件仓库位于同级目录：

```sh
npm run test:v2
npm run test:plugins:v2
```

前者检查两仓类型并运行 Core、构建链及插件回归；后者构建全部扩展并通过真实 Host 验证加载、卸载与资源收尾。测试使用临时数据和模拟外部接口，不代表生产服务已经部署或真实账号操作已验证。
