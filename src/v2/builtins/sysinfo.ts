import os from "node:os";
import {STRUCTURED_PLUGIN_API_VERSION, definePlugin, type CommandDefinition} from "../sdk";

const mb = (value: number): string => (value / 1048576).toFixed(2);
const uptime = (value: number): string => {
  const days = Math.floor(value / 86400);
  const hours = Math.floor(value / 3600) % 24;
  const minutes = Math.floor(value / 60) % 60;
  return `${days}天 ${hours}小时 ${minutes}分钟`;
};

const sysinfoCommand: CommandDefinition = {
  description: "查看详细系统信息",
  args: "",
  arguments: [],
  examples: [{args: "", description: "查看主机与 Mi Box 进程的详细资源信息"}],
  help: [
    {
      heading: "输出内容",
      body: "• 主机：主机名、系统、内核、运行时间、负载、CPU 核数、系统内存。\n" +
        "• Mi Box 进程：Node 版本、PID、RSS、Heap、External。",
    },
    {heading: "说明", body: "信息来自当前进程与主机，不执行外部命令或网络请求。"},
  ],
  async handle(invocation, ctx) {
    const memory = process.memoryUsage();
    const total = os.totalmem();
    const free = os.freemem();
    const lines = [
      "<b>系统信息</b>", "",
      `主机: <code>${os.hostname()}</code>`,
      `系统: <code>${os.platform()} ${os.arch()}</code>`,
      `内核: <code>${os.release()}</code>`,
      `运行时间: <code>${uptime(os.uptime())}</code>`,
      `负载: <code>${os.loadavg().map(value => value.toFixed(2)).join(" / ")}</code>`,
      `CPU: <code>${os.cpus().length} 核</code>`,
      `系统内存: <code>${mb(total - free)} / ${mb(total)} MB</code>`, "",
      "<b>Mi Box 进程</b>",
      `Node: <code>${process.version}</code>`,
      `PID: <code>${process.pid}</code>`,
      `RSS: <code>${mb(memory.rss)} MB</code>`,
      `Heap: <code>${mb(memory.heapUsed)} / ${mb(memory.heapTotal)} MB</code>`,
      `External: <code>${mb(memory.external)} MB</code>`,
    ];
    await ctx.telegram.edit(invocation.message, lines.join("\n"), {parseMode: "html"});
  },
};

export default function createSysinfo() {
  return definePlugin({apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "sysinfo", description: "查看主机系统、资源与 Mi Box 运行信息",
    commands: {sysinfo: sysinfoCommand},
  });
}
