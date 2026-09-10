# TeleBox V2 命令与监听器迁移台账

本文件跟踪 V2 命令/帮助/监听器的统一迁移。只记录已核对的事实；未阅读的条目一律标注“待核对”，不推断结论。第 1 批为基础能力与代表迁移，审查后按 R1–R6 返修；状态以本文件末尾的验证记录为准。

## 1. 基线与范围

- Core 仓库：`TeleBox-Core`，分支 `main`，基线 commit `b19c75c`（feat(help): document builtin commands and align AI chat invocation），应用版本 `0.4.20`。
- 插件仓库：`TeleBox-Plugins`，分支 `codex/telebox-runtime-v2`，基线 commit `c990a85`（fix(fbi): enforce group scope and normalize observation peers）。
- 用户未跟踪改动：`src/v2/builtins/roast.ts`、`src/v2/builtins/roast.test.ts`。本迁移未读取其内容、未修改、未纳入清单、未提交；隔离全量验证副本同样不含它们。
- 主对话基线（隔离副本）：Node v24.20.0，`scripts/test-v2.cjs` 1557 total / 1556 pass / 0 fail / 1 skip。
- 115 扩展契约基线（只读参考）：`plugin-contract-baseline.json`（主对话保存），含 115 插件 / 165 命令 / 16 监听器的 description、helpOnEmpty、helpArgs、ignoreEdited 与完整可见 help。
- 命令与监听器是两条独立迁移线：插件可以先迁移监听器，命令/帮助仍留在命令批次；两者完成前均不计入“命令覆盖完成”。

## 2. 最终能力与接口契约（`telebox/sdk`）

- 版本门禁：`STRUCTURED_PLUGIN_API_VERSION = 2`。使用结构化字段的插件必须声明 `apiVersion: 2`；旧宿主明确抛出 “Unsupported plugin API version”，不静默忽略。旧插件继续用 `apiVersion: 1`，新宿主同时接受 1/2；构件清单 ABI `PLUGIN_API_VERSION = 1` 不变，已构建旧 revision 仍可加载。
- `requireSdkFeatures(...)`：旧宿主缺少该导出时插件加载期明确失败；`SDK_FEATURES = {commandMetadata, messageFilter, commandHelp}`。
- 命令树：`CommandDefinition` 与 `SubcommandDefinition` 支持递归 `subcommands`、逐级 `defaultSubcommand`、逐级 `subcommandsCaseSensitive`（默认继承、可覆盖）、逐节点 `caseSensitive`（覆盖该节点名称/别名的匹配大小写，自身策略不传给子层）、逐级 `authorize`、`public`、`aliases`。同层名称/别名只要至少一方不敏感且 casefold 相同即视为冲突并拒绝，两个敏感节点仅同字面冲突。每个分支节点都必须提供 `handle` 作为该级回退解析器；不匹配时逐级回退，`message.text` 原样保留给全文/JSON/多行/正则业务解析。
- 授权：`dispatchCommand` 沿已匹配路径父级先于子级执行 `authorize`；`public` 节点豁免自身检查，公开的直接根子命令同时豁免根 `authorize`，更深的公开节点不会跳过任何上层祖先；根 `authorize` 对所有声明 `authorize` 的命令生效（即使没有子命令），`false` 时业务 0 次。重复 `definePlugin`（`artifact.create` + `host.load`）幂等：单次调用每个应执行的授权仅一次、业务仅一次。
- 帮助：`renderCommandHelp(name, source, {prefix, title?, description?, intro?, footer?, path?})` 从同一声明渲染根 `args`、各级 `alternates/variants`（每个用法自带说明）、`arguments/examples/notes/help` sections、别名与当前前缀；`renderHelp(prefix)` 继续兼容旧插件。`resolveHelpPath` 只在“完整声明路径 + 一个帮助 token”时命中：根接受声明 `helpArgs` 与 `--help`，更深路径只接受 `--help`，避免抢占全文型输入。
- Host：`.命令 子命令 --help` 与 `.help 命令 子命令` 读取同一 `renderCommandHelp` 声明，不执行业务、不读状态、不发外部请求；`buildPluginDetails` 通用消费元数据，metadata-only 插件无需独立 `renderHelp` 也能完整渲染。`listPlugins` 返回无 handler 的深冻结描述树。
- 消息过滤：监听器/命令可声明 `direction`、`chats`、`ignoreForwarded`、`includeSaved`（outgoing||saved 等既有语义）。Host 在业务前统一过滤；`unknown` 永不匹配受限 `chats`；编辑与命令过滤默认保持不变。
- 聊天分类：`MessageEnvelope.chatType` 由显式 peer 类型 + 同步附带实体的明确 `broadcast`/`megagroup` 标志 + 线协议 `post` 事实推导；矛盾或证据不足为 `unknown`，实体不得覆盖显式 `PeerUser/PeerChat`，不新增逐消息 RPC 或任意覆盖入口。

## 3. 内置命令清单

命令键核对自源码（非正则首匹配）：`version` 同时注册 `version` 与 `ver`；`help` 注册 `help` 与 `h`；其余为单命令。runtime.ts 当前加载 19 个内置，`sure/leech/re` 已跟踪但未被 runtime 加载。`roast` 为未跟踪用户改动，不在清单内。

| 批次 | 插件 ID | 命令 | 现有声明 | 子命令/大小写/默认/全文/授权边界 | 命令/帮助状态 |
| --- | --- | --- | --- | --- | --- |
| B1 | tpm | tpm | helpOnEmpty, helpArgs=help/h, ignoreEdited | 子命令 search/s、help、list/ls、install/i、update、remove/rm；默认不敏感；空参数默认 list（Host helpOnEmpty 优先）；全文回退保留；authorize owner/群内频道，help 与 list 为 public | B1 已通过 |
| B1 | alias | alias | 无 helpOnEmpty/helpArgs；renderHelp 由 renderCommandHelp 生成 | 子命令 set/del/ls|list；大小写敏感；空参数回退“不知道你要干什么！”；多 token 与全文回退保留；owner 检查不适用（主入口 outgoing/saved + ignoreEdited 默认） | B1 已通过 |
| B2 | agent | agent | helpOnEmpty, helpArgs=help/h | 全文字段 args=你的问题；保留 ctx.services ai.chat 调用与引用文字；无授权钩子 | B2 已通过 |
| B2 | autofix | autofix | — | 无子命令；args=""；只读 git/systemctl 诊断，无授权钩子 | B2 已通过 |
| B2 | bf | bf | helpArgs=help/h | 无子命令；args=""；owner/群内频道身份；/usr/bin/tar 打包并发送 | B2 已通过 |
| B2 | env | env | helpArgs=help/h | 无子命令；args=[变量名]；可查询 NODE_ENV/TB_PREFIX/TB_CMD_IGNORE_EDITED/TB_LISTENER_HANDLE_EDITED | B2 已通过 |
| B2 | exec | exec | helpOnEmpty, helpArgs=help/h | 无子命令；args=程序 [参数...]；owner/群内频道身份；非 shell 解释，路径白名单与 15s/12000B 限制保留 | B2 已通过 |
| B2 | help | help, h | — | 大小写敏感子命令 name（无值查看公开；写入仅本人/群内频道身份且非转发；reset 精确恢复）；其余参数为帮助中心/声明路径查询（.help tpm install） | B2 已通过 |
| B2 | leech | leech | — | 子命令 session/stats/db/help(h)；默认 help；help 由 renderCommandHelp 生成；数据库 assets/leech.sqlite | B2 已通过 |
| B2 | loglevel | loglevel | — | 无子命令；args=[等级]，别名 debug/info/warning(warn)/error(err)/silent(off)；保留跨对话串行与持久化/同步语义 | B2 已通过 |
| B2 | memory | memory | helpArgs=help/h | 子命令 health(status/protect)、sysinfo、on、off、silent、set、reset；默认 health；阈值/静默/基线与 monitor job 保留 | B2 已通过 |
| B2 | ping | ping | helpArgs=help/h | 无子命令；args=[域名]；Telegram 延迟与 HTTPS HEAD（5s）保留；help/h 由声明触发 | B2 已通过 |
| B2 | prefix | prefix | — | 保留首行解析与 set/add/del、help/h 位置的业务 exception；帮助文案由 prefixCommand 的 renderCommandHelp 单一来源生成（.prefix help 与 .help prefix 同源），未加 host helpArgs；帮助仅描述用户可用语法与持久化行为 | B2 已通过 |
| B2 | privacy | privacy | helpArgs=help/h | 子命令大小写敏感：ip -> hide / mask IPv4段数 [IPv6段数]；hide 要求无剩余参数；ip.authorize 本人且非转发；无参数查看、未知参数用法与 owner 提示保留 | B2 已通过 |
| B2 | re | re | — | 无子命令；args=[消息数] [复读次数]；回复转发、1–20/1–10 上限与命令删除保留 | B2 已通过 |
| B2 | restart | restart | ignoreEdited | 无子命令；args=""；owner/群内频道身份；确认、回执、失败状态与 submitted 守卫保留 | B2 已通过 |
| B2 | status | status | — | 无子命令；args=""；渲染运行环境/进程内存/系统资源 | B2 已通过 |
| B2 | sudo | sudo | helpOnEmpty, helpArgs=help/h | 子命令 add/del/list(ls)；command authorize owner/群内频道身份；空参数帮助；未知子命令回退用法 | B2 已通过 |
| B2 | sure | sure | — | 子命令大小写敏感：user(add/del)、chat(add/del)、msg(add)、ls(list)；msg add 仅取首个非空词，缺值走原用法且不写；user/chat 错误保留 `sure user|chat add|del ID`；command authorize 仅 owner；listener 固定 direction=incoming，动态白名单保留；未由 runtime 加载 | B2 已通过 |
| B2 | sysinfo | sysinfo | — | 无子命令；args=""；主机与进程资源信息 | B2 已通过 |
| B2 | update | update | helpArgs=help/h | 子命令 ver(version)、auto、check、run(now)；默认 run；check/run 子命令 authorize owner/群内频道身份；ver/auto 公开；回执与 notifyReady 保留 | B2 已通过 |
| B2 | version | version, ver | — | 无子命令（两个命令键）；version 含 PID，ver 不含；差异在各自 help 中说明 | B2 已通过 |


## 4. 扩展命令与监听器清单（115 插件 / 165 命令 / 16 监听器）

命令/帮助批次覆盖全部 115 插件；监听器批次单独列出。声明摘要来自只读契约基线；未逐条阅读的授权/子命令语法为“待核对”。

| 命令/帮助批次 | 监听器批次 | 插件 ID | 命令数 | 监听器 | 基线声明 | 命令/帮助状态 | 监听器状态 | 备注 |
| --- | --- | --- | ---: | ---: | --- | --- | --- | --- |
| B3 | — | aban | 9 | 0 | aban(忽略编辑) kick(忽略编辑) ban(忽略编辑) unban(忽略编辑) mute(忽略编辑) unmute(忽略编辑) sb(忽略编辑) unsb(忽略编辑) refresh(忽略编辑) | B3 已通过 | — | — |
| B3 | — | acron | 1 | 0 | acron(空=帮助) | B3 已通过 | — | — |
| B3 | — | admin_board | 1 | 0 | admin_board(空=帮助 help:help/h) | B3 已通过 | — | — |
| B3 | — | aff | 1 | 0 | aff(help:help/h) | B3 已通过 | — | — |
| B3 | — | ai | 1 | 0 | ai(help:help/?) | B3 已通过 | — | — |
| B3 | — | aitc | 1 | 0 | aitc(help:help/h) | B3 已通过 | — | — |
| B3 | — | annualreport | 1 | 0 | annualreport(—) | B3 已通过 | — | — |
| B3 | — | atadmins | 1 | 0 | atadmins(help:help/h) | B3 已通过 | — | — |
| B3 | — | atall | 1 | 0 | atall(help:help/h) | B3 已通过 | — | — |
| B3 | — | audio_to_voice | 1 | 0 | audio_to_voice(help:help/h) | B3 已通过 | — | — |
| B3 | — | autochangename | 2 | 0 | acn(空=帮助 help:help/h) autochangename(空=帮助 help:help/h) | B3 已通过 | — | — |
| B3 | B1 | autodel | 1 | 1 | autodel(空=帮助 help:h/help) | B3 已通过 | 第1批完成 | 命令与监听器均已通过；direction=outgoing、edited=false、ignoreCommands=true |
| B3 | B-L2 | autodelcmd | 1 | 1 | autodelcmd(空=帮助 help:help/h) | B3 已通过 | B3 已迁移 | 监听器 direction/过滤已迁移 |
| B3 | B-L2 | autorepeat | 1 | 1 | autorepeat(—) | B3 已通过 | B3 已迁移 | 监听器 direction/过滤已迁移 |
| B3 | — | banana | 1 | 0 | banana(忽略编辑) | B3 已通过 | — | — |
| B3 | — | bgp | 1 | 0 | bgp(—) | B3 已通过 | — | — |
| B3 | — | biko | 1 | 0 | biko(空=帮助 help:help) | B3 已通过 | — | — |
| B3 | — | bin | 1 | 0 | bin(空=帮助 help:help/h) | B3 已通过 | — | — |
| B3 | — | bizhi | 1 | 0 | bizhi(—) | B3 已通过 | — | — |
| B3 | — | botmzt | 10 | 0 | botmzt(—) qd(—) rand(—) pic(—) leg(—) ass(—) chest(—) coser(—) nsfw(—) naizi(—) | B3 已通过 | — | — |
| B4 | — | bs | 1 | 0 | bs(help:help/h/说明) | B4 已通过 | — | — |
| B4 | — | bulk_delete | 1 | 0 | bd(help:help/h) | B4 已通过 | — | — |
| B4 | — | calc | 1 | 0 | calc(help:help/h) | B4 已通过 | — | — |
| B4 | — | checkapi | 1 | 0 | checkapi(空=帮助 help:help) | B4 已通过 | — | — |
| B4 | B-L2 | checkin | 1 | 1 | checkin(help:help/h) | B4 已通过 | B4 已通过 | 监听器方向已确证迁移 |
| B4 | — | clean | 1 | 0 | clean(空=帮助 help:help/h 忽略编辑) | B4 已通过 | — | — |
| B4 | — | clean_member | 1 | 0 | clean_member(空=帮助 help:help/h 忽略编辑) | B4 已通过 | — | — |
| B4 | — | clear_sticker | 2 | 0 | clear_sticker(—) cs(—) | B4 已通过 | — | — |
| B4 | — | codex_image | 1 | 0 | cximg(help:help/h 忽略编辑) | B4 已通过 | — | — |
| B4 | — | convert | 1 | 0 | convert(help:help/h) | B4 已通过 | — | — |
| B4 | — | copy_sticker_set | 2 | 0 | copy_sticker_set(—) css(—) | B4 已通过 | — | — |
| B4 | — | cosplay | 2 | 0 | cos(—) cosplay(—) | B4 已通过 | — | — |
| B4 | — | crazy4 | 1 | 0 | crazy4(help:help/h) | B4 已通过 | — | — |
| B4 | — | cy | 1 | 0 | cy(help:help/? 忽略编辑) | B4 已通过 | — | — |
| B4 | — | da | 1 | 0 | da(空=帮助 help:help/h 忽略编辑) | B4 已通过 | — | — |
| B4 | — | dbdj | 1 | 0 | dbdj(空=帮助) | B4 已通过 | — | — |
| B4 | — | dc | 1 | 0 | dc(—) | B4 已通过 | — | — |
| B4 | — | deepwiki | 1 | 0 | deepwiki(空=帮助 help:help/h) | B4 已通过 | — | — |
| B4 | — | dig | 1 | 0 | dig(空=帮助 help:help/h) | B4 已通过 | — | — |
| B4 | B-L2 | diss | 6 | 1 | diss(help:help/h) undiss(—) dislist(—) dissclear(—) dishelp(—) dissai(—) | B4 已通过 | B4 已通过 | 监听器方向已确证迁移 |
| B5 | — | dme | 1 | 0 | dme(空=帮助 help:help/h 忽略编辑) | B5 已通过 | — | — |
| B5 | — | duckduckgo | 2 | 0 | duckduckgo(—) ddg(—) | B5 已通过 | — | — |
| B5 | — | eatgif | 1 | 0 | eatgif(help:help/h) | B5 已通过 | — | — |
| B5 | — | encode | 5 | 0 | encode(空=帮助) b64encode(—) b64decode(—) urlencode(—) urldecode(—) | B5 已通过 | — | — |
| B5 | — | epic | 1 | 0 | epic(help:help/h) | B5 已通过 | — | — |
| B5 | — | exec | 0 | 0 |  | 零命令兼容包已核对 | — | — |
| B5 | — | fadian | 1 | 0 | fadian(空=帮助 help:help/h) | B5 已通过 | — | — |
| B5 | B-L2 | fbi | 1 | 1 | fbi(空=帮助 help:help/h 忽略编辑) | B5 已通过 | B5 已通过 | 监听器固定条件已迁移 |
| B5 | — | getstickers | 1 | 0 | getstickers(—) | B5 已通过 | — | — |
| B5 | — | git_PR | 1 | 0 | git(空=帮助 help:help/h) | B5 已通过 | — | — |
| B5 | B-L2 | goodnight | 2 | 1 | goodnight(help:help/h) gn(help:help/h) | B5 已通过 | B5 已通过 | 监听器保持双向；固定过滤已核对 |
| B5 | — | gt | 1 | 0 | gt(help:help/h) | B5 已通过 | — | — |
| B5 | — | his | 1 | 0 | his(help:help/h) | B5 已通过 | — | — |
| B5 | — | hitokoto | 1 | 0 | hitokoto(help:help/h) | B5 已通过 | — | — |
| B5 | — | httpcat | 1 | 0 | httpcat(—) | B5 已通过 | — | — |
| B5 | — | ids | 1 | 0 | ids(help:help/h) | B5 已通过 | — | — |
| B5 | B-L2 | im | 1 | 1 | im(忽略编辑) | B5 已通过 | B5 已通过 | 监听器固定条件已迁移 |
| B5 | — | ip | 1 | 0 | ip(—) | B5 已通过 | — | — |
| B5 | — | isalive | 1 | 0 | isalive(help:help/h) | B5 已通过 | — | — |
| B5 | — | javdb | 4 | 0 | javdb(—) av(—) jav(—) jd(—) | B5 已通过 | — | — |
| B6 | — | jupai | 1 | 0 | jupai(—) | B6 已通过 | — | — |
| B6 | — | keep_online | 1 | 0 | keep_online(—) | B6 已通过 | — | — |
| B6 | B1 | keyword | 1 | 1 | keyword(空=帮助 help:h/help) | B6 已通过 | 第1批完成 | 命令与监听器均已通过；incoming 固定过滤及动态任务匹配保留 |
| B6 | — | kkp | 1 | 0 | kkp(help:help/h) | B6 已通过 | — | — |
| B6 | — | komari | 1 | 0 | komari(help:help/h) | B6 已通过 | — | — |
| B6 | — | leech | 1 | 0 | leech(空=帮助 help:help/h) | B6 已通过 | — | — |
| B6 | — | listusernames | 1 | 0 | listusernames(help:help/h) | B6 已通过 | — | — |
| B6 | B-L2 | lottery | 1 | 1 | lottery(空=帮助 help:help 忽略编辑) | B6 已通过 | 待迁移 | incoming；保留活动关键词、发送者资格与重复参与检查 |
| B6 | — | lu_bs | 1 | 0 | lu_bs(help:help) | B6 已通过 | — | — |
| B6 | — | manage_admin | 1 | 0 | manage_admin(空=帮助 help:help/h 忽略编辑) | B6 已通过 | — | — |
| B6 | B-L2 | mode | 1 | 1 | mode(help:help/h) | B6 已通过 | 待迁移 | outgoing + includeSaved；保留名单与本地/全局模式优先级 |
| B6 | — | moyu | 1 | 0 | moyu(—) | B6 已通过 | — | — |
| B6 | — | music_bot | 8 | 0 | music_bot(—) mbs(—) mbkw(—) mbkg(—) mbqq(—) mbne(—) mbvk(—) mbym(—) | B6 已通过 | — | — |
| B6 | — | netease | 1 | 0 | netease(help:help/h) | B6 已通过 | — | — |
| B6 | — | news | 1 | 0 | news(help:help/h) | B6 已通过 | — | — |
| B6 | — | nezha | 1 | 0 | nezha(help:help/h) | B6 已通过 | — | — |
| B6 | — | nodeseek | 1 | 0 | nodeseek(空=帮助 help:help) | B6 已通过 | — | — |
| B6 | — | ntp | 1 | 0 | ntp(—) | B6 已通过 | — | — |
| B6 | — | openlist | 2 | 0 | openlist(—) op(—) | B6 已通过 | — | — |
| B6 | — | oxost | 1 | 0 | 0x0(help:help/h) | B6 已通过 | — | — |
| B7 | B-L2 | pangu | 1 | 1 | pangu(help:help/h) | B7 已通过 | B7 已通过 | 固定条件已声明，动态条件保留 |
| B7 | — | paolu | 1 | 0 | paolu(忽略编辑) | B7 已通过 | — | — |
| B7 | — | pic_to_sticker | 2 | 0 | pic_to_sticker(help:help/h) pts(help:help/h) | B7 已通过 | — | — |
| B7 | B-L2 | pmcaptcha | 2 | 1 | pmc(空=帮助 help:h/help) pmcaptcha(空=帮助 help:h/help) | B7 已通过 | B7 已通过 | 固定条件已声明，动态条件保留 |
| B7 | — | portball | 1 | 0 | portball(—) | B7 已通过 | — | — |
| B7 | — | premium | 1 | 0 | premium(help:help/h) | B7 已通过 | — | — |
| B7 | — | qr | 1 | 0 | qr(—) | B7 已通过 | — | — |
| B7 | — | rate | 1 | 0 | rate(help:help/h) | B7 已通过 | — | — |
| B7 | — | re | 1 | 0 | re(—) | B7 已通过 | — | — |
| B7 | — | restore_pin | 1 | 0 | restore_pin(help:help/h) | B7 已通过 | — | — |
| B7 | — | rev | 1 | 0 | rev(—) | B7 已通过 | — | — |
| B7 | — | save | 1 | 0 | save(help:help/h) | B7 已通过 | — | — |
| B7 | — | search | 2 | 0 | so(—) search(—) | B7 已通过 | — | — |
| B7 | — | sendat | 1 | 0 | sendat(空=帮助 help:help/h) | B7 已通过 | — | — |
| B7 | — | service | 1 | 0 | service(—) | B7 已通过 | — | — |
| B7 | — | soutu | 1 | 0 | soutu(help:help/h) | B7 已通过 | — | — |
| B7 | — | speedtest | 2 | 0 | speedtest(help:help/h) st(help:help/h) | B7 已通过 | — | — |
| B7 | — | sticker | 1 | 0 | sticker(help:help/h) | B7 已通过 | — | — |
| B7 | — | sticker_to_pic | 2 | 0 | sticker_to_pic(help:help/h) stp(help:help/h) | B7 已通过 | — | — |
| B7 | — | subinfo | 1 | 0 | subinfo(help:help/h) | B7 已通过 | — | — |
| B8 | — | sum | 1 | 0 | sum(help:help/h/?) | B8 已通过 | — | — |
| B8 | B-L2 | sure | 1 | 1 | sure(—) | B8 已通过 | B8 已通过 | 固定条件已核对 |
| B8 | — | t | 3 | 0 | t(—) ts(—) tk(—) | B8 已通过 | — | — |
| B8 | B-L2 | teletype | 1 | 1 | teletype(空=帮助 忽略编辑) | B8 已通过 | B8 已通过 | 固定条件已核对 |
| B8 | — | tmp_admin | 1 | 0 | tmp_admin(空=帮助 help:help/h) | B8 已通过 | — | — |
| B8 | B-L2 | trace | 1 | 1 | trace(help:help/h) | B8 已通过 | B8 已通过 | 固定条件已核对 |
| B8 | — | tts | 1 | 0 | tts(—) | B8 已通过 | — | — |
| B8 | — | uai | 1 | 0 | uai(空=帮助 help:help/h) | B8 已通过 | — | — |
| B8 | — | weather | 1 | 0 | weather(空=帮助 help:help/h) | B8 已通过 | — | — |
| B8 | — | whois | 1 | 0 | whois(help:help/h) | B8 已通过 | — | — |
| B8 | — | xmsl | 2 | 0 | xmsl(help:help 忽略编辑) xm(help:help 忽略编辑) | B8 已通过 | — | — |
| B8 | — | yinglish | 1 | 0 | yinglish(help:help/h) | B8 已通过 | — | — |
| B8 | — | yvlu | 1 | 0 | yvlu(—) | B8 已通过 | — | — |
| B8 | — | zhijiao | 1 | 0 | zhijiao(help:help/h) | B8 已通过 | — | — |
| B8 | — | zpr | 1 | 0 | zpr(help:help/h) | B8 已通过 | — | — |

## 5. 分批计划

命令/帮助线（内置优先，其后扩展 ID 不区分大小写排序，每批最多 20）：

- B1（本批）：SDK/Host/Telegram 基础；内置 `tpm`、`alias`；扩展命令尚未迁移；聚焦回归 + R1–R6 返修。
- B2（已通过）：内置 `agent、autofix、bf、env、exec、help、leech、loglevel、memory、ping、prefix、privacy、re、restart、status、sudo、sure、sysinfo、update、version`（20 个，22 个命令键）。
- B3（已通过）：`aban`…`botmzt` 20 个扩展，38 个命令键；含 `autodelcmd`、`autorepeat` 监听器。
- B4（已通过）：`bs`…`diss` 20 个扩展，28 个命令键；含 `checkin`、`diss` 监听器。
- B5（已通过）：`dme`…`javdb` 20 项，19 个命令插件与 1 个零命令兼容包，28 个命令键；`fbi`/`im` 过滤已迁移，`goodnight` 双向监听已核对。
- B6–B8：其余扩展按 ID 排序每批 ≤20（含 `keyword` 命令/帮助）。

监听器线（16 个监听器）：

- B1（本批）：`keyword`（incoming）、`autodel`（outgoing/非命令/非编辑）。
- B-L2：其余 14 个监听器按插件 ID 排序核对并迁移固定方向/聊天类型/转发判断，业务动态过滤保留。

每批退出条件：命令名称/别名/大小写/语法/空参数默认动作/错误行为/授权不变；详细帮助完整保留；只迁移已核对过的固定判断。

## 5b. B3 扩展迁移（20/20，已通过）

按 ID 顺序迁移 20 个扩展；真实 factory 注册命令键共 38 个，全部保持。状态：20/20 已迁移，主对话复审通过。

- 无子命令参数/全文（保留原业务 parser，声明 args/arguments/examples/help）：`annualreport`、`atadmins`、`atall`、`audio_to_voice`、`biko`、`bin`、`bizhi`。
- 标准子命令树（真实 handler + 共享 dispatcher）：`aff`（list/save/remove(rm/del)）、`aitc`（key/url/model/prompt/temp/spn/info + 自由转写 fallback）、`acron`（send/copy/forward/cmd/del/del_re/pin/unpin/list/ls/la/rm/remove/del_task/disable/off/enable/on）、`admin_board`（ls/tail/rm/lock/unlock/clear）、`ai`（help/?, config/model/reasoning/service/image/video/prompt/collapse/timeout/telegraph/search + 自由提问 fallback）、`autochangename`（acn/autochangename：save/on/off/status/mode/tz/text/emoji/time/order/style/weather/config/update/reset）、`autodel`（l/list/cancel + 时长 fallback）、`autodelcmd`（on/off/status/list/reset/add/del(remove)）、`autorepeat`（allon/alloff/set/list/on/off）、`banana`（key/limit/config + 提示词 fallback）、`bgp`（dns + IP/回复 fallback）。
- 多命令键：`aban`（9 键）、`botmzt`（10 键），各键独立 metadata + 共享/独立 handler，默认入口渲染完整模块指南。

本批监听器（3）：`autodel`（B1 direction=outgoing 保持）、`autodelcmd`（direction=outgoing + includeSaved:true，精确 `outgoing||saved`）、`autorepeat`（direction=incoming + ignoreForwarded:true，保留 60s 时效/机器人/文本业务判断）。

返修（P1–P5）与 S1–S6：
- S1：`ai` 的 config(add/del/list/type/stream/responses)、prompt(set/del)、image(preview)、video(preview/audio/duration)、telegraph(on/off/limit/del) 与 `autochangename` 的 tz(list/on/off/format/set)、text(list/clear/add/del/on/off)、weather(on/off/set) 全部下沉为真实叶子 handler；Host 的“声明路径 --help”与“.help 命令 路径”对每个叶子生成焦点指南且零写入/零外部调用；自由文本、地点/时区字符串与多行 text add 保留 fallback。
- S2：SDK 增加 `SubcommandDefinition.caseSensitive`（逐节点覆盖层级大小写策略，仍属 v2 声明）。`ai` 的 prompt/collapse/timeout/telegraph 按原实现大小写敏感，config/model/image 等保持原识别策略；`.ai TIMEOUT 60` 等大写输入继续走自由提问（零写配置），`.ai CONFIG list` 等原支持大写继续成功。
- S3：`acron` 的 `list/ls`（all 消耗后再取类型）与 `la`（类型取第一个剩余 token）筛选位置分开；`la del` 只列 del。
- S4：从旧完整可见帮助逐段迁移语义——AI providerTypes/URL 自动识别/config responses/媒体预览与 duration；ACN save 前提、IANA/GMT/UTC/simp/offset/custom 默认与 HKT/CST/EDT、+08:00、六种 Unicode 样式、按小时钟面、中英文地点；acron `对话|话题/回复ID`、pin true|1/false|0、多行 ping 示例；修正 acron 多行示例的 `{prefix}` 字面量（改由 help `<pre>` 承载），删除重复“会话状态”命令清单。
- S5：`autochangename` 命令级 authorize 恢复“无法识别您的身份”覆盖范围（status/save 仍检查身份但不要求先 save）；未 save 的 unknown 回退“请先 acn save”，`help/h`+额外 token 回退指南，text 未知动作保持“未知命令: text”；mode/text on 等依赖当前值的修改改回单次 `storage.update` 内基于 current 计算，修并发丢更新。
- S6：`admin_board` 恢复“先 resolveTarget 再报告不支持动作/参数不足”的原顺序；新增真实 getEntity fixture 覆盖有效/不可访问目标。
- R1：逐节点 `caseSensitive` 的冲突检测与实际匹配规则一致（不敏感与敏感重叠即拒绝，两敏感仅同字面冲突，同名节点重复拼法不误拒），Core 覆盖 name/name、name/alias、alias/alias、正反顺序、嵌套继承、不误传子层、冻结与 Host 元数据。
- R2：`ai config` 恢复 `defaultSubcommand: "list"`（空参/`CONFIG` 默认查询，`config LIST` 仍因动作大小写敏感而未知）。
- R3：`autochangename` 的 tz/text/weather 子树加共同 `authorize` 前置（未 save 统一“请先 acn save”且零写零外部调用），save/status/help 例外与身份检查顺序保持；`text on` 输出恢复“✅ 随机文案已开启”，清理 text.add 无用变量。
- R4：ACN `mode/update/reset`、`emoji/time`、`tz format` 焦点帮助按动作归属并独立说明 GMT/UTC/simp/offset/custom；AI 使用说明与“缺少输入”实际行为一致。
- 新增回归：`scripts/b3-migration-v2.test.js` 19 条（叶子路径遍历、混合大小写、la 筛选、并发 mode、admin_board 目标顺序、config 默认、save 前置、帮助语义归属与自定义前缀）。

P1–P5：
- P1：`aitc` 各配置子命令恢复原外层 try/catch（非法 URL 等 → 记录 `aitc_failed` 并提示“AITC 调用失败，请检查配置和网络”），缺值与成功文案逐项精确（“请提供模型名称”“请提供 Prompt 文本”“API 地址已更新”等）；`autorepeat` 各子命令恢复原外层 catch（`❌ 操作失败: <code>…</code>` 并检查 abort）。
- P2：`aban`/`botmzt` 默认入口与 `help/h`（含后续参数）渲染完整模块指南；`aban` 目标/回复语义与“封禁并清理消息”“所有有管理权群/频道”“基本群仅移出”等限制恢复，示例改为 `@username`/数字 ID；`botmzt` 恢复每类中文含义（随机/腿部/臀部/胸部/Cosplay/NSFW/奶子/签到）。
- P3：`autodel` 自由时长 fallback 恢复首 token `help/h`（含额外参数）与空参数直接调用渲染同一元数据指南。
- P4：移除 `aitc`/`autorepeat`/`autodelcmd`/`bgp`/`aff` 帮助中与 subcommands 重复的命令清单，改为命令含义/默认/条件进 description/arguments/examples，help 只保留长说明/限制/排错；补齐 `audio_to_voice` OGG/Opus 说明与 `biko` 定时示例解释。
- P5：新增 `scripts/b3-migration-v2.test.js`（9 条）：acron 多行/表达式、未知/大小写、admin_board 未知动作、ai `help`/`?`/`help extra` 与自由提问、autochangename 树/未知/大小写、aitc 非法 URL 与精确文案、autorepeat 失败注入、aban/botmzt 模块指南、autodel help+额外参数与直接调用、16 项长说明锚点。

## 5c. B4 扩展迁移（20/20，已通过）

按 ID 顺序迁移 20 个扩展；真实 factory 注册命令键共 28 个（`clear_sticker`/`cs`、`copy_sticker_set`/`css`、`cos`/`cosplay`、`diss` 家族 6 键），全部保持。状态：20/20 已迁移，主对话复审通过。

- 无子命令/数据语法（保留原 parser，声明 args/arguments/examples/help）：`calc`（四则运算与 `format` 逐字保留，示例含 `3+7`/`8/2+5`）、`crazy4`、`dbdj`（1–1000/1–100）、`clear_sticker`（默认 2000、上限 2000）、`copy_sticker_set`（短名/链接、limit 1–120）、`cosplay`（1–10）、`dc`（单目标、回复优先于显式目标）、`dig`（域名/类型/服务器/输出选项）、`clean_member`（模式 1–5 + `chat:`/`limit:`/`search`）。
- 标准子命令树（真实 handler + 共享 dispatcher）：`bs`（add/list(ls)/del(rm)/enable(on)/disable(off)/toggle）、`checkapi`（save/list/del/check/models/ask，含内联 URL/Key）、`checkin`（add/list/del/toggle/test/settings/reset/set）、`clean`（deleted|blocked × pm|member + rm/all）、`convert`（u/apikey/clear + 文件名 fallback）、`cy`（target/time/on/off/status/send）、`da`（true/stop/status，群组 authorize）、`deepwiki`（add/lst/use/del/ctx）、`dissai`（model/provider/reasoning）、`codex_image`（token + 提示词 fallback）。
- 监听器（2）：`checkin` 固定 `direction:"outgoing"`（原 `message.outgoing !== true`），保留 replyToId/pending 与文本业务判断；`diss` 固定 `direction:"incoming"`（原 `outgoing || saved` 的 outgoing 部分），保留 saved/senderId/action/content 业务判断。
- 迁移期修正：`bs` 目标字段与 `checkin` 的 `execution` 从写 `undefined` 改为省略/删除键，以适配新 JSON 存储“拒绝 undefined”的约束；JSON 往返后的持久化状态与旧实现一致。
- 新增回归：`scripts/b4-migration-v2.test.js` 33 条（帮助锚点、命令键、子命令树、深度路径焦点帮助、监听器方向、逐插件可观察输出/校验/状态注入）。
- 业务契约证据（`b4-migration-v2.test.js`，均经真实 PluginHost 或直接 handler）：`calc` 3+7/10、10/4=2.5、1/0 除零与空参指南；`crazy4` 帮助零发送、正常发送一次；`bulk_delete` on/off 账号开关持久化与数字模式删除；`clear_sticker` 非法数量与空历史；`copy_sticker_set` 三类非法输入回指南；`cosplay` 0/11 越界；`dc` 多目标与无头像；`dig` 非法域名与空参指南；`dbdj` 空参/0/空扫描；`clean_member` 空参指南、未知模式、模式参数校验；`clean` 空参指南、未知类型优先级、四分支 FLOOD_WAIT/一般错误/abort、`help extra` 回指南、rm/all 与 rm --help 零副作用；`bs` 增删查、`del` 缺 ID 回指南零写、`toggle mode --help` 不翻转；`checkapi` 空参指南、`save` 收藏夹限制、`list` 空、未知动作三段 fallback；`checkin` 空目标、settings、`set time` 生效、`reset` 状态、`set log --help` 零写、listener incoming 拒绝/outgoing+prompt 接受/无关 reply 忽略；`codex_image` 未配置、token 收藏夹限制与更新；`convert` 空参/回复流程、`apikey` 收藏夹、`clear`、`help extra` 回指南；`cy` status/on 前提/词云不足；`da` 空参指南、未知命令、私聊拒绝；`deepwiki` 空参指南、空列表、add 失败；`diss` 用法/清空/帮助/AI 设置写入、listener outgoing/saved 拒绝与 incoming 回复；`dissai` 三叶子树。


## 5d. B5 扩展迁移（20/20，已通过）

- 19 个命令插件迁入 V2 结构化声明，共 28 个命令键；`exec` 为零命令兼容包，保持 `commands: {}` 与 API v1。
- 标准命令树：`eatgif`（list/ls、clear）、`fadian`（fd/tg/kfc/wyy/cp/clear）、`fbi`（det/loc/sur/obs/ssv/cache，cache 下含 limit/rebuild）、`git_PR`（login/repos/prs/merge/mergeall）、`goodnight`/`gn`（on/off，时区保留数据解析）、`im`（on/off/addchat/delchat/addmd5/delmd5/setaction/list/delete/ban）。
- 数据与全文解析保留：`dme` 数量及 -f、`duckduckgo` 关键词与条数、`encode` 文本/回复、`gt` 多行翻译、`his` 目标/回复与数量、`ids` 首行目标、`ip` 地址/回复、`javdb` 空格番号，以及其余无子命令入口。
- 监听器：`fbi` 声明 group/supergroup/broadcast 并保留公开实体与观察目标条件，unknown 在 Host 拒绝；`im` 声明 incoming 并保留监控聊天与媒体黑名单条件；`goodnight` 保持双向统计，固定过滤已核对。
- 子命令与根回退保留原有异常提示、日志、取消抑制及校验顺序；FBI cache 次级动作仍区分大小写。帮助包括原有默认值、限制、权限、依赖与实际可用示例。
- 独立隔离全量验证（Node v24.20.0）：1678 total / 1677 pass / 0 fail / 1 skip，exit 0；两仓库 `git diff --check` 通过。
- `scripts/b5-migration-v2.test.js` 28 条：20 项入口及独立预期路径的双帮助路由，状态文件内容和修改时间不变；帮助语义；IM 配置/回复黑名单与错误注入；eatgif 错误/取消；FBI 默认/大小写/目标解析及真实 Host 观察范围；IM 实际消息执行方向；Git 回退错误处理。B4/B5 聚焦共 61 条通过。

## 5e. B6 扩展迁移（20/20，已通过）

- 20 个扩展、28 个命令键迁入结构化 V2 声明；`music_bot` 的 8 个入口、`openlist`/`op` 均保留。
- 实际命令树覆盖 `keyword`、`komari`、`leech`、`lottery`、`lu_bs`、`manage_admin`、`mode`、`music_bot`、`nezha`、`nodeseek`、`ntp`、`openlist`。其余 8 个扩展保留文本、回复或无参数业务解析并声明帮助元数据。
- 大小写与数据边界：keyword 的 list all/alias rm、lottery 的 create list、mode 全树、Nezha service 值、OpenList admin 次级动作保留原匹配规则；Cookie/密码/节点名与关键词多行全文按原规则解析。
- 权限与错误：管理员命令保留群权限与回复目标优先级；Nezha/OpenList 凭据设置保留收藏夹限制；抽奖创建者/管理员与私聊奖品范围保持；拆分后的处理函数保留状态读取、异常提示及取消行为。
- 监听器：lottery 声明 incoming；mode 声明 outgoing + includeSaved。关键词、资格、名单、模式优先级继续在业务处理层执行。
- 帮助补充实际运行约束：NodeSeek 本地时区与 Python/curl_cffi 配置；OpenList 固定安装目录及本机 5244 上传接口；网络对时使用 HTTPS Date 响应头。保留原帮助的操作流程、依赖、示例和参数说明。
- 新增 `scripts/b6-migration-v2.test.js` 27 条：独立预期命令键/嵌套路径的两种帮助入口、帮助请求不读回复/联网/调用客户端且文件内容与修改时间不变、帮助语义、多行关键词、抽奖状态与监听方向、mode 收藏夹行为、Nezha/OpenList 凭据与大小写、状态读取失败及取消。
- 聚焦验证 108/108；独立隔离全量 Node v24.20.0：1705 total / 1704 pass / 0 fail / 1 skip，exit 0；两仓库差异空白检查通过。

## 5f. B7 扩展迁移（20/20，已通过）

- 20 个扩展、25 个命令键迁入结构化 V2 声明；真实子命令覆盖 pangu、pic_to_sticker、pmcaptcha、premium、save、search、sendat、speedtest、sticker_to_pic。
- 语法保留：Premium force 与 PMCaptcha record 子项大小写敏感；图片配置值按原规则校验；speedtest 的 --system/-s 支持放在动作前后；sticker 按回复上下文处理包名、to 与 cancel；其余文本/媒体/订阅参数保留原解析。
- 监听器：pangu 声明 outgoing + includeSaved，保留编辑消息与白名单优先级；PMCaptcha 声明 private，保留双向主动过白和入站验证流程，unknown 在宿主拒绝。
- SDK 支持含连字符的子命令名称（如 pmc set wl-words），并验证路由与聚焦帮助。频道搜索新增源时省略不存在的 linkedGroup 字段，符合 JSON 存储契约。
- 新增 `scripts/b7-migration-v2.test.js` 29 条，覆盖全部入口、独立预期帮助路径、零外部调用和状态不变、帮助语义、监听器、嵌套配置、任务所有权和生命周期、频道源操作及测速参数。
- 修正媒体测试在并行运行期间重建共享 dist 的竞争：统一使用测试入口已生成的宿主构建。
- 独立隔离全量 Node v24.20.0：1735 total / 1734 pass / 0 fail / 1 skip，exit 0。

## 5g. B8 扩展迁移（15/15，已通过）

- 15 个扩展、18 个命令键迁入结构化声明；完整覆盖 sum、sure、t/ts/tk、teletype、tmp_admin、trace、tts、uai、weather、whois、xmsl/xm、yinglish、yvlu、zhijiao、zpr。
- 子命令保留原有大小写、未知输入、默认动作及权限；全文、组合选项、消息实体和回复上下文继续由对应业务解析器处理。Fish/UAI/TTS/XMSL/SUM 配置保留收藏夹密钥限制。
- sure 与 trace 声明 incoming；teletype 声明 outgoing 并忽略编辑和命令。动态名单、消息规则和用户开关保留在业务层。
- SUM 任务与供应商设置遵循 JSON 可选字段契约；定时生命周期、临时管理员恢复及到期核验沿用原行为。
- 新增 `scripts/b8-migration-v2.test.js` 23 条：全部入口和独立预期路径的两种帮助入口、帮助零外部调用及状态不变、真实 Host 过滤、任务管理、密钥限制、多词配置、AI HTTP 请求和贴纸配置。
- 独立隔离全量 Node v24.20.0：1758 total / 1757 pass / 0 fail / 1 skip，exit 0。

## 6. 当前能力与验证记录

当前交付能力：

- 授权：`dispatchCommand` 沿已匹配路径父先子后执行 `authorize`；`public` 豁免自身，公开的直接根子命令豁免根 `authorize`，更深公开节点不跳过任何祖先；`authorize` 为 `false` 时业务 0 次。重复 `definePlugin`（artifact + host.load）幂等，单次调用授权与业务各一次。
- 命令树：递归 `subcommands`、逐级 `defaultSubcommand`/`subcommandsCaseSensitive`（继承+覆盖）/`authorize`/`public`/`aliases`；不匹配逐级回退，`message.text` 原样保留；大小写冲突按每层策略检测（敏感层允许 `go`/`GO` 并存，不敏感层拒绝）。
- 帮助：`renderCommandHelp` 从单一命令声明递归渲染整棵树，根与任意聚焦子树都包含各级用法/参数/示例/notes/help；示例相对父路径展开，根与聚焦同一可执行命令；Host 与 help 中心消费同一声明（`.cmd sub --help`、`.help cmd sub`），help 入口零业务/零状态/零外部请求；`listPlugins` 返回无 handler 的深冻结描述树。
- 兼容：v1 无 `renderHelp` 的命令不被 `--help` 劫持；v1 有 `renderHelp` 保持历史触发；结构化帮助只作用于 v2 声明。`autodelcmd`/`pangu` 的 `outgoing||saved` 由 `includeSaved` 表达。
- 消息分类：显式 peer + 明确实体 `broadcast`/`megagroup` + `post` 事实；矛盾或不足为 `unknown`，不匹配受限 `chats`，不逐消息联网。
- B1 代表：`tpm`（子命令/批量/owner/public list/生成帮助）、`alias`（多 token/串行/原错误/生成帮助）、`keyword`/`autodel` 监听器方向迁移。
- B2 内置：20 个内置（22 命令键）迁入 v2 声明；标准子命令树由共享 dispatcher + handler 驱动，无子命令查询/全文命令保留业务 handle；`help`/`version` 多入口与实际行为（含 PID 差异）保留；`prefix` 保留首行业务解析但帮助文案与 `.help prefix` 同源；`privacy`/`sure` 恢复大小写敏感与非法输入零写入。

验证命令（Node v24.20.0，PATH 前置 Node24）：

- Core 类型检查 `tsc -p tsconfig.v2.json`：除未跟踪 `roast.test.ts` 外无错误。
- Core 全量已编译测试（排除未跟踪 roast）：666 tests / 665 pass / 0 fail / 1 skip。
- Core 聚焦 B1（commands/host/telegram/tpm/alias/help/builtin-help）：196 pass / 0 fail。
- Core 聚焦 B2（builtin-migration/builtin-help/agent/loglevel/prefix/privacy/restart/status/update/update-reset/version）：76 pass / 0 fail。
- Plugins 类型检查：通过。Plugins 全量 `scripts/*.test.js`（B4 后）：935 pass / 0 fail。
- Core 类型检查（排除未跟踪 `roast.test.ts`）：通过；Core 全量编译测试 666 / 665 pass / 0 fail / 1 skip。
- Plugins 聚焦 B4（`b4-migration-v2.test.js` 33 条 + `plugin-help-v2.test.js` 115 条 + 既有 B4 插件用例）：全部 pass / 0 fail。
- 隔离全量 B4：`git archive HEAD` 两个仓库 + 覆盖当前改动（Core 含未跟踪 `commands.ts`/`commands.test.ts`/`builtin-migration.test.ts`/本文件，排除未跟踪 `roast*`；Plugins 含未跟踪 `b3-migration-v2.test.js`/`b4-migration-v2.test.js`）+ 真实 `node_modules`（Core 由 `NODE_PATH` 提供，Plugins 不建本地 `node_modules` 以匹配工作区 `canvas` 解析），Node v24.20.0 运行 `scripts/test-v2.cjs`：**1650 total / 1649 pass / 0 fail / 1 skip，exit 0**（日志 `/tmp/mibox-b4-iso.log`）。

审计证据要点：B2 回归覆盖可观察状态变化与真实业务输入（privacy `ip hide extra`/`IP hide`/`ip HIDE` 零写入、mask 范围/数量非法零写入；sure 大小写/空值/非数字零写入、`msg add hello world` 仅存首词；嵌套示例经 Host 执行为有效命令），而非仅断言 apiVersion/metadata 存在。

## 7. 全量覆盖与交付

- B1 基础能力、B2 内置、B3–B8 共 115 个扩展已通过分批审查；全部命令入口已核对结构化声明与原有业务语义。
- 16 个监听器的固定条件均已迁移或核对；动态条件仍在各插件业务层执行。
- 本批应用版本为 0.5.0，Core 与扩展配套验证，使用顺序为先更新 Core，再更新扩展。
- TPM 同时搜索名称与现有索引描述，逐项展示并分页；索引缺失或损坏时报告描述不可用且保留名称搜索。可安装项与验证项均按实际 V2 入口确定。

## 8. 0.5.0 最终验收

- Node v24.20.0，两个仓库以已跟踪基线加本批文件创建隔离副本；本批 45 个 Core 文件、135 个扩展文件与验证副本逐字节一致。验收记录本身在验证结束后补齐。
- `npm run test:v2`：1768 total / 1767 pass / 0 fail / 1 skip，exit 0；包含两仓类型检查、Core、构建链和扩展回归。唯一跳过项为 `account.test.ts` 的 Linux 内核锁用例，当前平台为 macOS。
- `npm run test:plugins:v2`：115/115 扩展构建、真实 Host 加载、卸载和资源收尾通过，exit 0。工厂统计为 165 个命令键和 16 个监听器；exec 兼容入口没有命令，保持 API 1。
- 验证目录：`/var/folders/f6/cw7nkc6x6pz_rcrf90ky94gh0000gn/T/mibox-review-final-complete-bugmedji`；日志为 `npm-test-v2.log`、`npm-test-plugins-v2.log`。
- 搜索回归覆盖中文描述、名称和描述大小写、缺少描述、索引读取失败/损坏、实际 V2 入口、稳定排序、默认模块排除、大小写冲突、HTML 转义与长列表分页。
- 版本文件三处均为 0.5.0；`CHANGELOG.md` 和 `docs/v2-sdk.md` 已同步。两仓 `git diff --check` 通过。
- 本轮验证使用临时数据与模拟外部接口，交付代码与文档；真实 Telegram 业务及服务器部署不属于本次验证结果。
