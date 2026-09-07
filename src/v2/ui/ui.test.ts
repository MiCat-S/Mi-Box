import assert from "node:assert/strict";
import test from "node:test";
import {Parser} from "htmlparser2";
import {HTMLParser} from "teleproto/extensions/html.js";
import {bold, code, command, concat, field, text} from "./text";
import {MAX_ENTITIES, MAX_HTML_LENGTH, renderDocument, richText, section} from "./document";
import {renderFeedback} from "./feedback";

test("safe text builders escape all Telegram HTML metacharacters", () => {
  const value = `&<>\"'🙂`;
  assert.equal(text(value), "&amp;&lt;&gt;&quot;&#39;🙂");
  assert.equal(bold(value), "<b>&amp;&lt;&gt;&quot;&#39;🙂</b>");
  assert.equal(code(value), "<code>&amp;&lt;&gt;&quot;&#39;🙂</code>");
  assert.equal(field("标签<&", value), "<b>标签&lt;&amp;</b>: <code>&amp;&lt;&gt;&quot;&#39;🙂</code>");
  assert.equal(command("命令<&", "run", ["x<&", "🙂"]), "<code>命令&lt;&amp;run x&lt;&amp; 🙂</code>");
  assert.equal(concat(bold("标题"), text(" · "), code("值")), "<b>标题</b> · <code>值</code>");
});

test("document renderer escapes structure, preserves Unicode, and closes tags per page", async () => {
  const pages = await renderDocument({
    title: "Bot <名称> & 状态",
    subtitle: "说明🙂",
    sections: [section("区块<&", [text("第一行🙂"), bold("第二行")])],
    footer: [text("结束<&")],
  });
  assert.equal(pages.length, 1);
  assert.ok(pages[0].includes("Bot &lt;名称&gt; &amp; 状态"));
  assert.ok(pages[0].includes("<b>区块&lt;&amp;</b>"));
  assert.ok(pages[0].includes("结束&lt;&amp;"));
  const [visible] = HTMLParser.parse(pages[0]);
  assert.match(visible, /第一行🙂/);
  const parser = new Parser({onclosetag(_name, implied) {assert.equal(implied, false);}}, {xmlMode: true});
  parser.end(pages[0]);
});

test("rich text keeps allowed markup and safely falls back for unsupported content", async () => {
  const allowed = await richText('<b>好</b> <a href="https://example.com/?a=1&amp;b=2">链接</a>');
  assert.equal(allowed[0], '<b>好</b> <a href="https://example.com/?a=1&amp;b=2">链接</a>');
  const unsafe = await richText("<script>secret</script>");
  assert.ok(unsafe.every(value => !value.includes("<script>")));
  assert.ok(unsafe.join("\n").includes("&lt;script&gt;secret&lt;/script&gt;"));
});

test("document pages retain long Unicode text without slicing HTML", async () => {
  const body = "🙂<&汉字".repeat(1500);
  const pages = await renderDocument({title: "长文本", sections: [section([text(body)])]});
  assert.ok(pages.length > 1);
  assert.ok(pages.every(page => page.length <= MAX_HTML_LENGTH));
  assert.ok(pages.every(page => (page.match(/<(?:b|code|pre|a|i|u|strong|em|s|del|blockquote|span)[ >]/g) ?? []).length <= MAX_ENTITIES));
  const [visible] = HTMLParser.parse(pages.join("\n"));
  assert.equal((visible.match(/🙂/g) ?? []).length, 1500);
  assert.equal((visible.match(/汉字/g) ?? []).length, 1500);
});

test("feedback renders bounded business diagnostics and never exception payloads", () => {
  const html = renderFeedback({state: "error", title: "操作失败", detail: "请稍后重试",
    diagnostic: {stage: "repository", code: "EXIT_FAILED", label: "仓库访问"}, nextStep: "检查服务状态"});
  const [visible] = HTMLParser.parse(html);
  assert.match(visible, /失败 · 操作失败/);
  assert.match(visible, /阶段：仓库访问 repository \/ EXIT_FAILED/);
  assert.match(visible, /下一步：检查服务状态/);
  assert.ok(!visible.includes("Error"));
});
