import assert from "node:assert/strict";
import test from "node:test";
import { toolCallHtml } from "../src/ui/js/views/live.js";

function render(name: string, args: Record<string, unknown>) {
  return toolCallHtml({ name, arguments: JSON.stringify(args) });
}

test("renders Cline-style execute_command with cwd and timeout", () => {
  const html = render("execute_command", {
    command: "npm test",
    cwd: "C:\\repo",
    timeout: 5000,
  });
  assert.match(html, /命令/);
  assert.match(html, /\$<\/span> npm test/);
  assert.match(html, /目录 C:\\repo/);
  assert.match(html, /超时 5000 ms/);
});

test("parses Cline replace_in_file diffs into a readable edit", () => {
  const diff = [
    "------- SEARCH",
    "const a = 1;",
    "=======",
    "const a = 2;",
    "+++++++ REPLACE",
  ].join("\n");
  const html = render("replace_in_file", { path: "src/a.ts", diff });
  assert.match(html, /编辑/);
  assert.match(html, /src\/a\.ts/);
  assert.match(html, /− const a = 1;/);
  assert.match(html, /\+ const a = 2;/);
  assert.match(html, /live-call-add">\+1<\/span><span class="live-call-del">-1</);
});

test("renders read_file and write_file aliases", () => {
  const read = render("read_file", { path: "src/b.ts" });
  assert.match(read, /读取/);
  assert.match(read, /src\/b\.ts/);

  const write = render("write_file", { path: "src/b.ts", content: "one\ntwo" });
  assert.match(write, /写入/);
  assert.match(write, /live-call-add">\+2<\/span><span>7 字符/);
});

test("renders Cline search_files and list_files", () => {
  const search = render("search_files", {
    path: "src",
    regex: "TODO",
    file_pattern: "*.ts",
  });
  assert.match(search, /搜索/);
  assert.match(search, /TODO/);
  assert.match(search, /src/);
  assert.match(search, /匹配 \*\.ts/);

  const list = render("list_files", { path: "src", recursive: true });
  assert.match(list, /目录/);
  assert.match(list, /src/);
  assert.match(list, /递归/);
});

test("routes str_replace_editor create and view actions", () => {
  const create = render("str_replace_editor", {
    command: "create",
    path: "src/c.ts",
    file_text: "a\nb",
  });
  assert.match(create, /写入/);
  assert.match(create, /src\/c\.ts/);
  assert.match(create, /\+2/);

  const view = render("str_replace_editor", { command: "view", path: "src/c.ts" });
  assert.match(view, /读取/);
});

test("summarizes apply_patch files and size", () => {
  const patch = [
    "*** Begin Patch",
    "*** Update File: src/d.ts",
    "@@",
    "-old",
    "+new",
    "*** End Patch",
  ].join("\n");
  const html = render("apply_patch", { input: patch });
  assert.match(html, /补丁/);
  assert.match(html, /src\/d\.ts/);
  assert.match(html, /补丁 6 行/);
});

test("falls back to pretty JSON for unknown tools", () => {
  const html = render("mcp__github__create_issue", { title: "Bug" });
  assert.match(html, /live-call-args/);
  assert.match(html, /&quot;Bug&quot;/);
});

test("escapes tool arguments before rendering HTML", () => {
  const html = render("execute_command", { command: "echo <script>alert(1)</script>" });
  assert.ok(!html.includes("<script>"));
  assert.match(html, /&lt;script&gt;/);
});