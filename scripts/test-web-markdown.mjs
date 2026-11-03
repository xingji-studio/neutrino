// The web conversation renderer must support the markdown the agent writes,
// while treating every model byte as text: no raw HTML, no dangerous schemes.
import assert from "node:assert/strict";
import { renderMarkdown } from "../web/markdown.js";

function contains(html, ...needles) {
  for (const needle of needles) assert.ok(html.includes(needle), `expected ${JSON.stringify(needle)} in ${html}`);
}

// Headings, paragraphs, hard line breaks and emphasis.
{
  const html = renderMarkdown("# Title\n\n## Second\n\nA line\nnext line\n\n**bold** *italic* ***both*** ~~gone~~ `code`");
  contains(html, "<h1>Title</h1>", "<h2>Second</h2>", "<p>A line<br>next line</p>");
  contains(html, "<strong>bold</strong>", "<em>italic</em>", "<strong><em>both</em></strong>", "<del>gone</del>", "<code>code</code>");
  const cjk = renderMarkdown("这是*重点*，以及**加粗**和 `代码`。");
  contains(cjk, "这是<em>重点</em>，以及<strong>加粗</strong>和 <code>代码</code>。");
  assert.equal(renderMarkdown("snake_case_name"), "<p>snake_case_name</p>");
}

// Setext headings and horizontal rules are not confused with one another.
{
  assert.equal(renderMarkdown("Title\n==="), "<h1>Title</h1>");
  assert.equal(renderMarkdown("Title\n---"), "<h2>Title</h2>");
  assert.equal(renderMarkdown("---"), "<hr>");
}

// Lists: ordering, nesting and task markers.
{
  const html = renderMarkdown("- one\n- two\n  - nested\n\n1. first\n2. second\n\n- [ ] todo\n- [x] done");
  contains(html, "<ul>", "</ul>", "<ol>", "</ol>", "nested");
  assert.match(html, /<ol><li><p>first<\/p><\/li><li><p>second<\/p><\/li><\/ol>/);
  contains(html, 'class="task-item"', 'type="checkbox"', "todo", "done");
  assert.match(html, /<input type="checkbox" class="task-checkbox" disabled checked> done/);
  assert.match(html, /<input type="checkbox" class="task-checkbox" disabled> todo/);
  assert.equal(renderMarkdown("3. three"), '<ol start="3"><li><p>three</p></li></ol>');
}

// Code fences keep their content literal, even when it looks like HTML.
{
  const html = renderMarkdown("```ts\nconst html = \"<script>alert(1)</script>\";\n```");
  contains(html, '<pre class="code"><code class="language-ts">');
  assert.ok(!html.includes("<script>"), "fenced code is escaped");
  contains(html, "&lt;script&gt;alert(1)&lt;/script&gt;");
}

// Block quotes can contain their own blocks.
{
  const html = renderMarkdown("> quoted **text**\n>\n> - nested");
  contains(html, "<blockquote>", "<strong>text</strong>", "<ul>", "</blockquote>");
}

// Tables: cells, inline formatting and alignment.
{
  const html = renderMarkdown("| Left | Center | Right |\n| --- | :---: | ---: |\n| **a** | b | `c` |");
  contains(html, '<div class="table-wrap"><table>', "<thead>", "<tbody>", "<th class=\"align-left\">Left</th>");
  contains(html, "align-center", "align-right", "<strong>a</strong>", "<code>c</code>");
}

// Links and images: safe destinations only.
{
  const html = renderMarkdown("[site](https://example.com/a_(b) \"Example\") ![shot](https://example.com/a.png)");
  contains(html, '<a href="https://example.com/a_(b)" title="Example" target="_blank" rel="noopener noreferrer">site</a>');
  contains(html, '<img src="https://example.com/a.png" alt="shot"', 'loading="lazy"', 'referrerpolicy="no-referrer"');
  const unsafe = renderMarkdown("[click](javascript:alert(1)) ![x](data:image/png;base64,abc) [file](file:///etc/passwd)");
  assert.ok(!unsafe.includes("javascript:"), "javascript links are not emitted");
  assert.ok(!unsafe.includes("data:image"), "data images are not emitted");
  assert.ok(!unsafe.includes("file:///"), "file links are not emitted");
  contains(unsafe, "click", "x", "file");
}

// Autolinks and escaped markdown.
{
  const html = renderMarkdown("See <https://example.com/a> or https://example.com/b, and \\*literal\\*.");
  assert.ok(html.includes('href="https://example.com/a"'));
  assert.ok(html.includes('href="https://example.com/b"'));
  assert.ok(html.includes("*literal*"));
  assert.ok(!html.includes("<em>literal</em>"));
}

// Raw HTML, event-handler injection, entities and nested formatting are inert.
{
  const html = renderMarkdown(
    '<img src=x onerror="alert(1)">\n\n<script>alert(2)</script>\n\n&amp; &lt;tag&gt; **<b>bold</b>**',
  );
  assert.ok(!html.includes("<img src=x"), "raw HTML is escaped");
  assert.ok(!html.includes("<script>"), "script tags are escaped");
  assert.ok(!html.includes('onerror="'), "event attributes never reach the DOM");
  contains(html, "&lt;img src=x onerror=", "&amp;", "&lt;tag&gt;");
  contains(html, "<strong>&lt;b&gt;bold&lt;/b&gt;</strong>");
}

// Tables and lists reject unterminated syntax instead of dropping content.
{
  const html = renderMarkdown("| A | B |\nnot a delimiter\n\n```txt\nunclosed");
  contains(html, "| A | B |", "not a delimiter", "unclosed");
}

console.log("ok web markdown: blocks, inline formatting, tables, links, images and XSS boundaries");
