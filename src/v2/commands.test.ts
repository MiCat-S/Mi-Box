import test from "node:test";
import assert from "node:assert/strict";
import {
  definePlugin, requireSdkFeatures, SAFE_REGEXP_LIMITS, SDK_FEATURES, STRUCTURED_PLUGIN_API_VERSION,
  type CommandInvocation, type MessageEnvelope, type PluginContext,
} from "./sdk";
import {renderCommandHelp, resolveHelpPath, hasStructuredHelp} from "./commands";
import {HTMLParser} from "teleproto/extensions/html.js";

const envelope: MessageEnvelope = {id: 1, chatId: "1", senderId: "1", text: ".demo", outgoing: true};
const context = {} as PluginContext;
const invocation = (args: string[]): CommandInvocation => ({message: envelope, command: "demo", prefix: ".", args});

test("structured command metadata requires plugin API version 2 while legacy declarations still load", () => {
  assert.throws(() => definePlugin({apiVersion: 1, id: "demo", description: "demo", commands: {
    demo: {description: "demo", args: "x", handle() {}},
  }}), /requires plugin API version 2/);
  const legacy = definePlugin({apiVersion: 1, id: "demo", description: "demo", commands: {
    demo: {description: "demo", handle() {}},
  }});
  assert.equal(legacy.apiVersion, 1);
  assert.equal(typeof legacy.commands.demo.handle, "function");
  const structured = definePlugin({apiVersion: STRUCTURED_PLUGIN_API_VERSION, id: "demo", description: "demo", commands: {
    demo: {description: "demo", args: "x", handle() {}},
  }});
  assert.equal(Object.isFrozen(structured.commands.demo), true);
  assert.equal(Object.isFrozen(structured.commands.demo), true);
  assert.throws(() => definePlugin({apiVersion: 2, id: "demo", description: "demo", commands: {
    demo: {description: "demo", subcommands: {go: {description: "go", handle() {}}}},
  } as never}), /Invalid command definition/);
});

test("shared dispatcher routes declared subcommands, aliases and the fallback parser", async () => {
  const calls: string[] = [];
  const definition = definePlugin({apiVersion: 2, id: "demo", description: "demo", commands: {
    demo: {
      description: "demo",
      subcommands: {
        run: {description: "run", aliases: ["r"], handle(input) {calls.push(`run:${input.args.join(",")}`);}},
        list: {description: "list", handle(input) {calls.push(`list:${input.args.join(",")}`);}},
      },
      handle(input) {calls.push(`fallback:${input.args.join(",")}`);},
    },
  }});
  await definition.commands.demo.handle(invocation(["run", "one", "two"]), context);
  await definition.commands.demo.handle(invocation(["R", "solo"]), context);
  await definition.commands.demo.handle(invocation(["bogus", "raw", "text"]), context);
  await definition.commands.demo.handle(invocation([]), context);
  assert.deepEqual(calls, ["run:one,two", "run:solo", "fallback:bogus,raw,text", "fallback:"]);
});

test("shared dispatcher preserves case-sensitive subcommands and the default subcommand", async () => {
  const calls: string[] = [];
  const definition = definePlugin({apiVersion: 2, id: "demo", description: "demo", commands: {
    demo: {
      description: "demo", subcommandsCaseSensitive: true, defaultSubcommand: "list",
      subcommands: {
        run: {description: "run", handle() {calls.push("run");}},
        list: {description: "list", public: true, handle(input) {calls.push(`list:${input.args.length}`);}},
      },
      handle() {calls.push("fallback");},
    },
  }});
  await definition.commands.demo.handle(invocation(["RUN"]), context);
  await definition.commands.demo.handle(invocation([]), context);
  await definition.commands.demo.handle(invocation(["run", "x"]), context);
  assert.deepEqual(calls, ["fallback", "list:0", "run"]);
});

test("command authorization always runs before a dispatched handler and public subcommands bypass it", async () => {
  const log: string[] = [];
  let authorized = 0;
  const definition = definePlugin({apiVersion: 2, id: "demo", description: "demo", commands: {
    demo: {
      description: "demo",
      subcommands: {
        open: {description: "open", public: true, handle() {log.push("open");}},
        guarded: {description: "guarded", handle() {log.push("guarded");}},
      },
      authorize() {authorized += 1; return false;},
      handle() {log.push("fallback");},
    },
  }});
  await definition.commands.demo.handle(invocation(["guarded"]), context);
  await definition.commands.demo.handle(invocation(["open"]), context);
  await definition.commands.demo.handle(invocation(["unknown"]), context);
  assert.deepEqual(log, ["open"]);
  assert.equal(authorized, 2);
});

test("command metadata, filters and subcommands are validated and rejected on real errors", () => {
  const build = (command: Record<string, unknown>) => definePlugin({apiVersion: 2, id: "demo", description: "demo",
    commands: {demo: {description: "demo", handle() {}, ...command}} as never});
  assert.throws(() => build({direction: "sideways"}), /direction/);
  assert.throws(() => build({chats: ["nowhere"]}), /chat types/);
  assert.throws(() => build({chats: []}), /chat types/);
  assert.throws(() => build({ignoreForwarded: "yes"}), /forwarded policy/);
  assert.throws(() => build({includeSaved: "yes"}), /saved policy/);
  assert.throws(() => build({subcommandsCaseSensitive: "yes"}), /subcommand case policy/);
  assert.throws(() => build({defaultSubcommand: "missing", subcommands: {go: {description: "go", handle() {}}}}), /default subcommand/);
  assert.throws(() => build({subcommands: {go: {description: "go", aliases: ["g"], handle() {}}, goagain: {description: "again", aliases: ["G"], handle() {}}}}), /Conflicting subcommand name/);
  assert.throws(() => build({arguments: [{name: ""}]}), /Invalid command argument/);
  assert.throws(() => build({examples: [{args: "\0"}]}), /Invalid command example/);
});

test("hyphenated subcommand tokens dispatch and resolve focused help", async () => {
  const received: string[][] = [];
  const definition = definePlugin({apiVersion: 2, id: "demo", description: "demo", commands: {
    demo: {description: "demo", subcommands: {set: {description: "set", handle() {}, subcommands: {
      "wl-words": {description: "words", handle(input) {received.push([...input.args]);}},
    }}}, handle() {}},
  }});
  await definition.commands.demo.handle(invocation(["SET", "WL-WORDS", "hello", "world"]), context);
  assert.deepEqual(received, [["hello", "world"]]);
  assert.deepEqual(resolveHelpPath(definition.commands.demo, ["set", "wl-words", "--help"]), ["set", "wl-words"]);
  assert.match(renderCommandHelp("demo", definition.commands.demo, {prefix: "."}), /wl-words/);
  for (const token of ["-words", "two words", "word\0", "a/b"]) {
    assert.throws(() => definePlugin({apiVersion: 2, id: "demo", description: "demo", commands: {
      demo: {description: "demo", subcommands: {[token]: {description: "invalid", handle() {}}}, handle() {}},
    }}), /Invalid subcommand definition/);
  }
});

test("generated help derives usage, aliases, examples and long sections from one definition", () => {
  const definition = definePlugin({apiVersion: 2, id: "demo", description: "demo", commands: {
    demo: {
      description: "Useful demo command",
      args: "[x]",
      arguments: [{name: "x", required: true, description: "input"}],
      examples: [{args: "one"}],
      subcommands: {
        go: {
          group: "Doing", aliases: ["g"], args: "target", alternates: [{args: "all", description: "every target"}],
          description: "go somewhere", examples: [{args: "g one", description: "see <code>{prefix}help</code>"}],
          notes: ["• note <code>{prefix}demo</code>"],
          handle() {},
        },
      },
      help: [{heading: "Limits", body: "body <code>{prefix}demo go</code>"}],
      handle() {},
    },
  }});
  const html = renderCommandHelp("demo", definition.commands.demo, {prefix: "<&", title: "<b>Title</b>", footer: ["tail <code>{prefix}demo</code>"]});
  assert.match(html, /<b>Title<\/b>/);
  assert.match(html, /Useful demo command/);
  assert.match(html, /<b>Doing<\/b>/);
  assert.match(html, /<code>&lt;&amp;demo go target<\/code>/);
  assert.match(html, /<code>&lt;&amp;demo go all<\/code> — every target/);
  assert.match(html, /<code>&lt;&amp;demo \[x\]<\/code>/);
  assert.match(html, /简写：<code>&lt;&amp;demo g<\/code>/);
  assert.match(html, /示例：<code>&lt;&amp;demo g one<\/code>/);
  assert.match(html, /see <code>&lt;&amp;help<\/code>/);
  assert.match(html, /<code>x<\/code>（必填） — input/);
  assert.match(html, /示例：<code>&lt;&amp;demo one<\/code>/);
  assert.match(html, /<b>Limits<\/b>/);
  assert.match(html, /body <code>&lt;&amp;demo go<\/code>/);
  assert.match(html, /tail <code>&lt;&amp;demo<\/code>/);
  assert.doesNotMatch(html, /\{prefix\}/);
});

test("SDK feature assertions expose a stable capability list", () => {
  assert.deepEqual(Object.keys(SDK_FEATURES), [
    "commandMetadata", "messageFilter", "commandHelp", "httpAddressPolicy", "safeRegexp", "legacySqlite",
  ]);
  assert.doesNotThrow(() => requireSdkFeatures("commandMetadata", "commandHelp", "httpAddressPolicy", "safeRegexp", "legacySqlite"));
  assert.throws(() => requireSdkFeatures("nope" as never), /Unsupported SDK feature: nope/);
  assert.deepEqual(SAFE_REGEXP_LIMITS, {maxPatternLength: 512, maxInputLength: 4096, startupTimeoutMs: 1000,
    executionTimeoutMs: 50, concurrency: 4, queueCapacity: 64});
});

test("authorization without subcommands rejects before the root business handler", async () => {
  let checks = 0;
  let business = 0;
  const definition = definePlugin({apiVersion: 2, id: "demo", description: "demo", commands: {
    demo: {description: "demo", authorize() {checks += 1; return false;}, handle() {business += 1;}},
  }});
  await definition.commands.demo.handle(invocation(["anything"]), context);
  assert.equal(checks, 1);
  assert.equal(business, 0);
  assert.throws(() => definePlugin({apiVersion: 2, id: "demo", description: "demo", commands: {
    demo: {description: "demo", authorize: "no" as never, handle() {}},
  }}), /Invalid command authorization/);
});

test("repeated normalization keeps exactly one authorization and one business call per dispatch", async () => {
  let checks = 0;
  let business = 0;
  const raw = {apiVersion: 2 as const, id: "demo", description: "demo", commands: {
    demo: {
      description: "demo", args: "[x]", defaultSubcommand: "go",
      subcommands: {go: {description: "go", handle(input: CommandInvocation) {business += 1; assert.deepEqual(input.subcommands, ["go"]);}}},
      authorize() {checks += 1;},
      handle() {business += 10;},
    },
  }};
  let definition = definePlugin(raw);
  for (let index = 0; index < 3; index += 1) definition = definePlugin(definition);
  await definition.commands.demo.handle(invocation([]), context);
  assert.equal(checks, 1);
  assert.equal(business, 1);
  await definition.commands.demo.handle(invocation(["go"]), context);
  assert.equal(checks, 2);
  assert.equal(business, 2);
  await definition.commands.demo.handle(invocation(["unknown"]), context);
  assert.equal(checks, 3);
  assert.equal(business, 12);
});

test("nested subcommands route, fall back per level, honor defaults, aliases and case policy", async () => {
  const calls: string[] = [];
  const definition = definePlugin({apiVersion: 2, id: "demo", description: "demo", commands: {
    demo: {
      description: "demo",
      subcommands: {
        go: {
          description: "go", defaultSubcommand: "next",
          subcommands: {
            next: {description: "next", aliases: ["n"], handle(input) {calls.push(`next:${input.args.join(",")}:${input.subcommands?.join("/")}:${input.message.text}`);}},
            back: {description: "back", handle() {calls.push("back");}},
          },
          handle(input) {calls.push(`go-fallback:${input.args.join(",")}`);},
        },
        run: {
          description: "run", authorize() {calls.push("run-check"); return true;},
          subcommands: {
            fast: {description: "fast", public: true, handle() {calls.push("fast");}},
            slow: {description: "slow", authorize() {calls.push("slow-check"); return false;}, handle() {calls.push("slow");}},
          },
          handle() {calls.push("run-fallback");},
        },
      },
      authorize() {calls.push("root-check"); return true;},
      handle() {calls.push("root-fallback");},
    },
  }});
  const message = {...envelope, text: ".demo go n x y"};
  await definition.commands.demo.handle({message, command: "demo", prefix: ".", args: ["go", "n", "x", "y"]}, context);
  assert.deepEqual(calls, ["root-check", "next:x,y:go/next:.demo go n x y"]);
  calls.length = 0;
  await definition.commands.demo.handle(invocation(["go", "unknown"]), context);
  assert.deepEqual(calls, ["root-check", "go-fallback:unknown"]);
  calls.length = 0;
  await definition.commands.demo.handle(invocation(["go"]), context);
  assert.deepEqual(calls, ["root-check", "next::go/next:.demo"]);
  calls.length = 0;
  // A public leaf never skips its non-public ancestors.
  await definition.commands.demo.handle(invocation(["run", "fast"]), context);
  assert.deepEqual(calls, ["root-check", "run-check", "fast"]);
  calls.length = 0;
  await definition.commands.demo.handle(invocation(["run", "slow"]), context);
  assert.deepEqual(calls, ["root-check", "run-check", "slow-check"]);
  calls.length = 0;
  await definition.commands.demo.handle(invocation(["unknown"]), context);
  assert.deepEqual(calls, ["root-check", "root-fallback"]);
});

test("nested case sensitivity inherits and can be overridden per level", async () => {
  const calls: string[] = [];
  const definition = definePlugin({apiVersion: 2, id: "demo", description: "demo", commands: {
    demo: {
      description: "demo", subcommandsCaseSensitive: true,
      subcommands: {go: {description: "go", subcommandsCaseSensitive: false,
        subcommands: {deep: {description: "deep", handle() {calls.push("deep");}}}, handle() {calls.push("go");}}},
      handle() {calls.push("root");},
    },
  }});
  await definition.commands.demo.handle(invocation(["GO", "deep"]), context);
  assert.deepEqual(calls, ["root"], "case-sensitive root rejects GO and uses its own fallback");
  calls.length = 0;
  await definition.commands.demo.handle(invocation(["go", "DEEP"]), context);
  assert.deepEqual(calls, ["deep"], "insensitive child accepts DEEP");
});

test("declared help resolves root args, nested help sections and focused paths", () => {
  const definition = definePlugin({apiVersion: 2, id: "demo", description: "demo", commands: {
    demo: {
      description: "demo root", args: "<target>", helpArgs: ["help"],
      subcommands: {
        go: {
          description: "go", args: "target", group: "Group",
          help: [{heading: "Need", body: "NEEDED_CONFIG <code>{prefix}demo go</code>"}],
          arguments: [{name: "target", description: "where"}],
          examples: [{args: "go x"}], notes: ["• note <code>{prefix}demo</code>"],
          handle() {},
        },
      },
      help: [{heading: "Root", body: "root body {prefix}demo"}],
      handle() {},
    },
  }});
  const command = definition.commands.demo;
  const html = renderCommandHelp("demo", command, {prefix: "<&"});
  assert.match(html, /<code>&lt;&amp;demo &lt;target&gt;<\/code>/);
  assert.match(html, /<b>Root<\/b>[\s\S]*root body &lt;&amp;demo/);
  assert.match(html, /<b>Need<\/b>[\s\S]*NEEDED_CONFIG <code>&lt;&amp;demo go<\/code>/);
  assert.match(html, /<code>target<\/code> — where/);
  assert.match(html, /示例：<code>&lt;&amp;demo go x<\/code>/);
  assert.match(html, /• note <code>&lt;&amp;demo<\/code>/);
  const focused = renderCommandHelp("demo", command, {prefix: ".", path: ["go"]});
  assert.match(focused, /<b>demo go<\/b>/);
  assert.match(focused, /NEEDED_CONFIG/);
  assert.doesNotMatch(focused, /root body/);
  assert.doesNotMatch(focused, /Needed/);
  assert.equal(resolveHelpPath(command, ["h"], ["help"]), undefined, "only declared help tokens are accepted at the root");
  assert.deepEqual(resolveHelpPath(command, ["help"], ["help"]), []);
  assert.deepEqual(resolveHelpPath(command, ["go", "--help"], ["help"]), ["go"]);
  assert.equal(resolveHelpPath(command, ["go", "help"], ["help"]), undefined, "free-text tokens are never captured");
  assert.equal(resolveHelpPath(command, ["go", "x", "--help"], ["help"]), undefined, "undeclared trailing tokens are not help");
  assert.equal(hasStructuredHelp(command), true);
});

test("recursive help renders the whole declared tree and expands examples relative to the parent path", () => {
  const definition = definePlugin({apiVersion: 2, id: "tree", description: "tree", commands: {
    tree: {
      description: "root",
      subcommands: {
        go: {
          description: "go", args: "target", examples: [{args: "go x"}],
          help: [{heading: "Go", body: "GO_PREREQUISITE"}],
          subcommands: {
            next: {description: "nested", args: "target", examples: [{args: "next x"}],
              help: [{heading: "Deep", body: "DEEP_PREREQUISITE"}], handle() {}},
          },
          handle() {},
        },
      },
      handle() {},
    },
  }});
  const command = definition.commands.tree;
  const root = renderCommandHelp("tree", command, {prefix: "."});
  assert.match(root, /<code>\.tree go target<\/code>/);
  assert.match(root, /<code>\.tree go next target<\/code>/);
  assert.match(root, /GO_PREREQUISITE/);
  assert.match(root, /DEEP_PREREQUISITE/);
  assert.match(root, /示例：<code>\.tree go x<\/code>/);
  assert.match(root, /示例：<code>\.tree go next x<\/code>/);
  const focused = renderCommandHelp("tree", command, {prefix: ".", path: ["go"]});
  assert.match(focused, /<code>\.tree go target<\/code>/);
  assert.match(focused, /<code>\.tree go next target<\/code>/);
  assert.match(focused, /DEEP_PREREQUISITE/);
  assert.match(focused, /示例：<code>\.tree go x<\/code>/);
  assert.match(focused, /示例：<code>\.tree go next x<\/code>/);
  assert.doesNotMatch(focused, /\.tree go go x/);
  const deep = renderCommandHelp("tree", command, {prefix: ".", path: ["go", "next"]});
  assert.match(deep, /示例：<code>\.tree go next x<\/code>/);
  assert.doesNotMatch(deep, /\.tree go next next x/);
});

test("case-sensitive levels allow distinct names while insensitive levels reject conflicts", async () => {
  const calls: string[] = [];
  const definition = definePlugin({apiVersion: 2, id: "demo", description: "demo", commands: {
    demo: {
      description: "demo", subcommandsCaseSensitive: true,
      subcommands: {
        go: {description: "go", handle() {calls.push("go");}},
        GO: {description: "GO", handle() {calls.push("GO");}},
        level: {
          description: "level",
          subcommands: {deep: {description: "deep", handle() {calls.push("deep");}}, DEEP: {description: "DEEP", handle() {calls.push("DEEP");}}},
          handle() {calls.push("level");},
        },
      },
      handle() {calls.push("root");},
    },
  }});
  await definition.commands.demo.handle(invocation(["go"]), context);
  await definition.commands.demo.handle(invocation(["GO"]), context);
  // A child inherits the sensitive policy and keeps distinct cased siblings.
  await definition.commands.demo.handle(invocation(["level", "deep"]), context);
  await definition.commands.demo.handle(invocation(["level", "DEEP"]), context);
  assert.deepEqual(calls, ["go", "GO", "deep", "DEEP"]);
  const build = (childPolicy: boolean) => definePlugin({apiVersion: 2, id: "demo", description: "demo", commands: {
    demo: {
      description: "demo", subcommandsCaseSensitive: true,
      subcommands: {level: {description: "level", subcommandsCaseSensitive: childPolicy,
        subcommands: {go: {description: "go", handle() {}}, GO: {description: "GO", handle() {}}}, handle() {}}},
      handle() {},
    },
  }});
  assert.doesNotThrow(() => build(true));
  assert.throws(() => build(false), /Conflicting subcommand name/);
  assert.throws(() => definePlugin({apiVersion: 2, id: "demo", description: "demo", commands: {
    demo: {description: "demo", subcommandsCaseSensitive: false,
      subcommands: {go: {description: "go", handle() {}}, GO: {description: "GO", handle() {}}}, handle() {}},
  }}), /Conflicting subcommand name/);
});

test("legacy api version 1 declarations cannot silently use v2-only metadata", () => {
  assert.throws(() => definePlugin({apiVersion: 1, id: "demo", description: "demo", commands: {
    demo: {description: "demo", alternates: [{args: "all", description: "all"}], handle() {}},
  }}), /requires plugin API version 2/);
  assert.throws(() => definePlugin({apiVersion: 1, id: "demo", description: "demo", commands: {
    demo: {description: "demo", handle() {}},
  }, listeners: [{includeSaved: true, handle() {}}]}), /requires plugin API version 2/);
});

test("field matrix: every declared field survives at the root and at each focused subtree", () => {
  type Node = {readonly id: string; readonly sub: import("./sdk").SubcommandDefinition};
  const make = (id: string, children: Node[]): Node => ({
    id,
    sub: {
      description: `DESC_${id}`, args: `ARG_${id}`,
      alternates: [{args: `ALT_${id}`, description: `ALTD_${id}`}],
      arguments: [{name: `PARAM_${id}`, description: `PARAMD_${id}`}],
      examples: [{args: `${id} EX_${id}`, description: `EXD_${id}`}],
      help: [{heading: `HEAD_${id}`, body: `BODY_${id}`}],
      notes: [`NOTE_${id}`], aliases: [`ALIAS_${id}`],
      subcommands: Object.fromEntries(children.map(child => [child.id, child.sub])),
      handle() {},
    },
  });
  const side3 = make("side3", []);
  const three = make("three", []);
  const two = make("two", [three, side3]);
  const side2 = make("side2", []);
  const one = make("one", [two, side2]);
  const side1 = make("side1", []);
  const definition = definePlugin({apiVersion: 2, id: "demo", description: "demo", commands: {
    demo: {
      description: "DESC_root", args: "ARG_root",
      alternates: [{args: "ALT_root", description: "ALTD_root"}],
      arguments: [{name: "PARAM_root", description: "PARAMD_root"}],
      examples: [{args: "EX_root", description: "EXD_root"}],
      help: [{heading: "HEAD_root", body: "BODY_root"}],
      subcommands: {one: one.sub, side1: side1.sub},
      handle() {},
    },
  }});
  const paths = new Map<string, string[]>([
    ["root", []], ["one", ["one"]], ["side1", ["side1"]],
    ["two", ["one", "two"]], ["side2", ["one", "side2"]],
    ["three", ["one", "two", "three"]], ["side3", ["one", "two", "side3"]],
  ]);
  const prefix = "<&🙂";
  const focusPaths: string[][] = [[], ["one"], ["one", "two"], ["one", "two", "three"]];
  for (const focus of focusPaths) {
    const html = renderCommandHelp("demo", definition.commands.demo, {prefix, path: focus});
    const visible = HTMLParser.parse(html)[0];
    assert.equal(html.includes("{prefix}"), false, `unexpanded placeholder for ${focus.join("/") || "root"}`);
    assert.ok(visible.includes(`${prefix}demo`), "active prefix is preserved");
    const included = [...paths.keys()].filter(id => {
      const path = paths.get(id)!;
      return focus.every((step, index) => path[index] === step) && path.length >= focus.length;
    });
    for (const id of included) {
      const path = paths.get(id)!;
      for (const marker of [`DESC_${id}`, `ARG_${id}`, `ALT_${id}`, `ALTD_${id}`, `PARAM_${id}`,
        `PARAMD_${id}`, `EX_${id}`, `EXD_${id}`, `HEAD_${id}`, `BODY_${id}`]) {
        assert.ok(visible.includes(marker), `${focus.join("/") || "root"} missing ${marker}`);
      }
      if (id !== "root") {
        assert.ok(visible.includes(`NOTE_${id}`), `focused subtree lost note ${id}`);
        assert.ok(visible.includes(`ALIAS_${id}`), `focused subtree lost alias ${id}`);
      }
      // Usage, example and alias commands are valid full paths and appear exactly once.
      const parentPath = path.slice(0, -1);
      const parentInvocation = `${prefix}demo${parentPath.length ? ` ${parentPath.join(" ")}` : ""}`;
      const usage = `${parentInvocation} ${id === "root" ? "" : id} ARG_${id}`.replace("  ", " ");
      assert.equal(visible.split(usage).length - 1, 1, `usage duplication for ${id}`);
      const exampleCommand = `${parentInvocation} ${id === "root" ? "EX_root" : `${id} EX_${id}`}`;
      assert.ok(visible.includes(exampleCommand), `example command not executable for ${id}: ${exampleCommand}`);
      if (id !== "root") {
        assert.ok(visible.includes(`${parentInvocation} ALIAS_${id}`), `alias not copyable for ${id}`);
        assert.equal(visible.includes(`${parentInvocation} ${id} ${id} `), false, `doubled path for ${id}`);
      }
    }
    for (const id of [...paths.keys()].filter(id => !included.includes(id))) {
      assert.equal(visible.includes(`DESC_${id}`), false, `${focus.join("/")} leaked sibling ${id}`);
      assert.equal(visible.includes(`ARG_${id}`), false, `${focus.join("/")} leaked sibling arg ${id}`);
    }
  }
});

test("per-node case policy rejects overlapping siblings but keeps distinct sensitive names", async () => {
  const build = (subcommands: Record<string, unknown>) => definePlugin({apiVersion: 2, id: "demo", description: "demo",
    commands: {demo: {description: "demo", subcommands, handle() {}} as never}});
  // A repeated spelling inside the same node is not a sibling conflict.
  assert.doesNotThrow(() => build({foo: {description: "foo", aliases: ["foo"], handle() {}}}));
  // At least one insensitive side makes differently-cased spellings overlap, in either order.
  assert.throws(() => build({foo: {description: "foo", handle() {}}, FOO: {description: "FOO", caseSensitive: true, handle() {}}}), /Conflicting subcommand name/);
  assert.throws(() => build({FOO: {description: "FOO", caseSensitive: true, handle() {}}, foo: {description: "foo", handle() {}}}), /Conflicting subcommand name/);
  // Two sensitive siblings keep distinct spellings.
  assert.doesNotThrow(() => build({foo: {description: "foo", caseSensitive: true, handle() {}}, FOO: {description: "FOO", caseSensitive: true, handle() {}}}));
  // name/alias and alias/alias overlaps follow the same rule.
  assert.throws(() => build({one: {description: "one", caseSensitive: true, aliases: ["bar"], handle() {}}, two: {description: "two", aliases: ["BAR"], handle() {}}}), /Conflicting subcommand name/);
  assert.throws(() => build({one: {description: "one", aliases: ["zz"], handle() {}}, two: {description: "two", aliases: ["ZZ"], handle() {}}}), /Conflicting subcommand name/);
  assert.throws(() => build({foo: {description: "foo", caseSensitive: "yes", handle() {}}}), /Invalid subcommand definition/);
});

test("sensitive siblings route by exact spelling and freeze their policy", async () => {
  const calls: string[] = [];
  const definition = definePlugin({apiVersion: 2, id: "demo", description: "demo", commands: {
    demo: {description: "demo", subcommands: {
      foo: {description: "foo", caseSensitive: true, handle() {calls.push("foo");}},
      FOO: {description: "FOO", caseSensitive: true, handle() {calls.push("FOO");}},
    }, handle() {calls.push("fallback");}},
  }});
  assert.equal(definition.commands.demo.subcommands?.foo.caseSensitive, true);
  assert.equal(Object.isFrozen(definition.commands.demo.subcommands?.foo), true);
  await definition.commands.demo.handle(invocation(["foo"]), context);
  await definition.commands.demo.handle(invocation(["FOO"]), context);
  await definition.commands.demo.handle(invocation(["Foo"]), context);
  assert.deepEqual(calls, ["foo", "FOO", "fallback"]);
});

test("a node's own caseSensitive policy does not leak into its children", async () => {
  const calls: string[] = [];
  const definition = definePlugin({apiVersion: 2, id: "demo", description: "demo", commands: {
    demo: {description: "demo", subcommands: {
      A: {description: "A", caseSensitive: true, subcommands: {
        deep: {description: "deep", handle() {calls.push("deep");}},
      }, handle() {calls.push("A");}},
    }, handle() {calls.push("fallback");}},
  }});
  // A itself is case-sensitive, but its children inherit the root (insensitive) level.
  await definition.commands.demo.handle(invocation(["A", "DEEP"]), context);
  assert.deepEqual(calls, ["deep"]);
  calls.length = 0;
  await definition.commands.demo.handle(invocation(["a"]), context);
  assert.deepEqual(calls, ["fallback"]);
});
