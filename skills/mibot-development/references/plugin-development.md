# 插件、命令与协议开发

## 目录与声明

最小扩展是 `<id>/v2.ts`。业务复杂时，把同包处理器、类型与纯函数拆到 `<id>/v2/`；无需为简单命令创建空的多层目录。测试放在插件仓库 `scripts/<id>-v2.test.js` 或 `<id>-v2-<component>.test.js`。`plugins.json` 提供搜索描述，可安装性仍由实际 `v2.ts` 决定。

新结构化声明使用 `STRUCTURED_PLUGIN_API_VERSION`（当前为 2）；API 1 仍受支持。构件 manifest ABI `PLUGIN_API_VERSION` 当前为 1，两种版本含义不同。不要为使用 API 2 手工改构建器的 ABI。需要指定 SDK 能力时可使用 `requireSdkFeatures`；新增公共能力须同步兼容性和加载失败测试。

以下模板演示无副作用工厂、结构化子命令和持久化。将 `example` 改为实际插件 ID 与命令名。

```ts
import {
  definePlugin, STRUCTURED_PLUGIN_API_VERSION,
  type CommandDefinition,
} from "telebox/sdk";

export default function createExample() {
  const example: CommandDefinition = {
    description: "记录调用次数",
    helpOnEmpty: true,
    ignoreEdited: true,
    subcommands: {
      add: {
        description: "增加一次记录",
        async handle({message}, ctx) {
          const store = ctx.storage.json("state.json", {count: 0});
          const state = await store.update(current => ({count: current.count + 1}));
          await ctx.telegram.edit(message, `已记录 ${state.count} 次`);
        },
      },
      status: {
        description: "查看记录次数",
        async handle({message}, ctx) {
          const state = await ctx.storage.json("state.json", {count: 0}).read();
          await ctx.telegram.edit(message, `当前 ${state.count} 次`);
        },
      },
    },
    async handle({message, prefix}, ctx) {
      await ctx.telegram.edit(message, `使用 ${prefix}example add 或 ${prefix}example status`);
    },
  };
  return definePlugin({
    apiVersion: STRUCTURED_PLUGIN_API_VERSION,
    id: "example",
    description: "记录调用次数",
    commands: {example},
  });
}
```

## 路由、帮助与授权

- 根入口写在 `commands`，标准子命令写在递归 `subcommands`，子命令别名写 `aliases`。每个节点保留 `handle` 处理未匹配输入；不要维护一套与声明不一致的 switch 分发。
- `invocation.args` 已去掉匹配的子命令路径。全文、多行、JSON、正则等输入按业务需要读 `message.text`；实体偏移等协议信息查看 `message.raw`。别名路由可能重写业务命令文本，不能把拆分后重组的 args 当作原始消息。
- 用 `args`、`arguments`、`alternates`、`examples`、`help` 描述用法；宿主和 `renderCommandHelp` 读取同一声明。帮助使用当前 prefix，动态 HTML 用 `ui.text` / `ui.code` 等转义。品牌名称读 `getBotName()`。
- 帮助渲染不执行业务与授权处理器，因此只能包含适合公开展示的说明，不能夹带运行时私密状态。默认 `parseMode` 是字面文本；需要 HTML 时明确传 `{parseMode: "html"}`。长输出用 `ui` 分页并处理部分发送结果。
- 聊天范围通过 `chats`、`direction`、`ignoreForwarded`、`includeSaved` 声明；命令编辑消息用 `ignoreEdited`，监听器用 `edited` / `ignoreCommands`。受限聊天列表不匹配 `unknown`，不要为了分类给每条消息添加 RPC。
- 范围过滤不替代权限检查。管理操作复用当前权限辅助函数，并验证账号本人、委托和频道身份等相关入口。监听器的用户白名单、业务开关在范围过滤后执行。
- `authorize` 按匹配路径父先子后执行，返回 false 则停止。子命令 `public` 可跳过自身授权；直接根子节点公开时还跳过根授权，更深的公开节点仍受祖先限制。调整此字段时需验证所有受影响路径。

## 异步业务与状态

普通命令 await 完成；确需快速返回的长任务使用 `ctx.tasks.run` 并处理失败，区分正常取消与业务错误。限制批处理并发、结果缓存大小和定时状态保留期，具体上限按真实负载选择，不建立永久保存消息对象或客户端的全局缓存。

JSON 用 `update` 完成读改写，避免先 read 再独立写入造成覆盖。保留既有配置文件名和字段；结构迁移在受管操作中执行。不要把 `process.cwd()` 拼出的账号配置路径作为扩展存储接口。

## Telegram 协议边界

- 业务存储和 `MessageEnvelope` 的聊天/用户 ID 使用字符串，不能随意转成 JS `number`。构造 TL 请求时按当前 Teleproto 类型生成 ID 与 peer，保留 access hash。
- 需要当前账号作为 `InputPeer` 时使用 `new Api.InputPeerSelf()`；其他对象使用 `client.getInputEntity` 或合适的 `Api.InputPeerUser` / `InputPeerChannel` 等。`Peer`、`InputPeer`、`InputChannel` 和裸 ID 不是可互换的字段类型。
- Teleproto 的整数对象可能在请求 resolve 时被当成普通 TL 对象。协议修复必须让测试经过当前依赖的 `request.resolve(client, utils)` 和 `request.getBytes()`，不能只让 mock `invoke` 返回成功。
- 分页删除或历史查询按实际响应的 offset / 游标终止；每轮检查取消。区分基本群、超级群和广播频道的 API 与权限，不把缺少实体信息视为拥有权限。
- 批处理逐项记录成功与失败；成功发送请求、权限查询成功、封禁成功、历史清理完成是不同结果，用户反馈按实际完成阶段生成。
