// A small, dependency-free markdown renderer for the web conversation view.
//
// The browser receives model output as plain text. This module turns the
// common GitHub-flavoured subset into HTML:
//
//   headings, paragraphs, hard line breaks, emphasis, strikethrough, inline
//   code, fenced code blocks, block quotes, ordered/unordered/nested lists,
//   task lists, horizontal rules, links, images and pipe tables.
//
// Raw HTML is never passed through: every text run is escaped, and links /
// images are limited to http(s) (plus mailto for links). The terminal has its
// own renderer in `src/markdown.ts`; this one shares the same syntax rules but
// emits HTML for the browser instead of styled terminal cells.

const HTML_ESCAPE = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => HTML_ESCAPE[char]);
}

const ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
};

/** Decode the handful of entities markdown authors actually type. */
function decodeEntities(value) {
  return String(value ?? "").replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos|nbsp);/gi, (match, name) => {
    const key = name.toLowerCase();
    if (key.startsWith("#x")) {
      const code = Number.parseInt(key.slice(2), 16);
      return Number.isFinite(code) ? safeCodePoint(code) : match;
    }
    if (key.startsWith("#")) {
      const code = Number.parseInt(key.slice(1), 10);
      return Number.isFinite(code) ? safeCodePoint(code) : match;
    }
    return ENTITIES[key] ?? match;
  });
}

function safeCodePoint(code) {
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return "\ufffd";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "\ufffd";
  }
}

/** Text outside code spans/blocks: entities are decoded, then all markup escaped. */
function escapeText(value) {
  return escapeHtml(decodeEntities(value));
}

function escapeAttribute(value) {
  return escapeHtml(decodeEntities(value));
}

function indentOf(line) {
  const match = /^ */.exec(line);
  return match ? match[0].length : 0;
}

function isBlank(line) {
  return !String(line ?? "").trim();
}

function isOpeningBoundary(previous) {
  return !previous || /[\s([{<"']/.test(previous);
}

function isSafeLink(url) {
  return /^(?:https?:|mailto:)/i.test(String(url ?? "").trim());
}

function isSafeImage(url) {
  return /^https?:/i.test(String(url ?? "").trim());
}

function cleanUrl(raw) {
  return String(raw ?? "")
    .trim()
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/^<|>$/g, "")
    .replace(/\\([()<> ])/g, "$1");
}

// --------------------------------------------------------------- inline HTML

function parseCodeSpan(text, start) {
  let run = 0;
  while (text[start + run] === "`") run += 1;
  if (run === 0) return null;
  const close = text.indexOf("`".repeat(run), start + run);
  if (close < 0) return null;
  let content = text.slice(start + run, close).replace(/\n/g, " ");
  // A single padding space on each side is part of the syntax, not the code.
  if (content.length > 2 && content.startsWith(" ") && content.endsWith(" ")) {
    content = content.slice(1, -1);
  }
  return { html: `<code>${escapeHtml(content)}</code>`, next: close + run };
}

function findClosingBracket(text, start) {
  let depth = 1;
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === "\\") {
      i += 1;
      continue;
    }
    if (text[i] === "[") depth += 1;
    else if (text[i] === "]") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function parseDestination(text, start) {
  if (text[start] !== "(") return null;
  let depth = 1;
  let i = start + 1;
  let inAngle = false;
  for (; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "<" && i === start + 1) {
      inAngle = true;
      continue;
    }
    if (ch === ">" && inAngle) {
      inAngle = false;
      continue;
    }
    if (inAngle) continue;
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  if (depth !== 0) return null;
  const inner = text.slice(start + 1, i).trim();
  if (!inner) return null;
  let url = inner;
  let title = "";
  if (inner.startsWith("<")) {
    const close = inner.indexOf(">");
    if (close > 0) {
      url = inner.slice(1, close);
      title = inner.slice(close + 1).trim();
    }
  } else {
    const quote = inner.search(/\s+["'(]/);
    if (quote > 0) {
      url = inner.slice(0, quote);
      title = inner.slice(quote).trim();
    } else {
      const space = inner.search(/\s/);
      if (space > 0) {
        url = inner.slice(0, space);
        title = inner.slice(space).trim();
      }
    }
  }
  title = title.replace(/^["'(]|["')]$/g, "").trim();
  return { url: cleanUrl(url), title: cleanUrl(title), next: i + 1 };
}

function renderLinkOrImage(text, start, image, depth) {
  const labelStart = start + (image ? 2 : 1);
  const close = findClosingBracket(text, labelStart);
  if (close < 0 || text[close + 1] !== "(") return null;
  const destination = parseDestination(text, close + 1);
  if (!destination) return null;
  const label = text.slice(labelStart, close);
  const title = destination.title ? ` title="${escapeAttribute(destination.title)}"` : "";
  if (image) {
    if (isSafeImage(destination.url)) {
      return {
        html: `<img src="${escapeAttribute(destination.url)}" alt="${escapeAttribute(label.replace(/[*_~`]/g, ""))}"${title} loading="lazy" referrerpolicy="no-referrer">`,
        next: destination.next,
      };
    }
    return { html: escapeText(label), next: destination.next };
  }
  if (isSafeLink(destination.url)) {
    return {
      html: `<a href="${escapeAttribute(destination.url)}"${title} target="_blank" rel="noopener noreferrer">${renderInline(label, depth + 1)}</a>`,
      next: destination.next,
    };
  }
  // Do not turn javascript:/data:/file: destinations into clickable links.
  return { html: renderInline(label, depth + 1), next: destination.next };
}

function findSingle(text, start, char) {
  for (let i = start; i < text.length; i += 1) {
    if (text[i] !== char) continue;
    if (text[i - 1] === "\\") continue;
    if (text[i + 1] === char || text[i - 1] === char) continue;
    return i;
  }
  return -1;
}

function renderEmphasis(text, start, depth) {
  const char = text[start];
  const previous = text[start - 1] ?? "";
  const triple = char + char + char;
  const double = char + char;
  if (text.startsWith(triple, start)) {
    const end = text.indexOf(triple, start + 3);
    if (end > start + 3) {
      const inner = text.slice(start + 3, end);
      if (inner.trim() && !/^\s|\s$/.test(inner)) {
        return {
          html: `<strong><em>${renderInline(inner, depth + 1)}</em></strong>`,
          next: end + 3,
        };
      }
    }
  }
  if (text.startsWith(double, start)) {
    const next = text[start + 2] ?? "";
    if (!/^\s$/.test(next)) {
      const end = text.indexOf(double, start + 2);
      if (end > start + 2) {
        const inner = text.slice(start + 2, end);
        if (inner.trim() && !/^\s|\s$/.test(inner)) {
          return {
            html: `<strong>${renderInline(inner, depth + 1)}</strong>`,
            next: end + 2,
          };
        }
      }
    }
  }
  // `foo_bar_baz` is an identifier, not emphasis. `*` has no such word rule
  // (CommonMark allows intraword `*`), and non-ASCII text such as Chinese can
  // put an underscore directly next to a word.
  if (char === "_" && /^[A-Za-z0-9]$/.test(previous)) return null;
  const nextChar = text[start + 1] ?? "";
  if (!nextChar || /^\s$/.test(nextChar)) return null;
  const end = findSingle(text, start + 1, char);
  if (end > start + 1) {
    const inner = text.slice(start + 1, end);
    if (inner.trim() && !/^\s|\s$/.test(inner)) {
      return {
        html: `<em>${renderInline(inner, depth + 1)}</em>`,
        next: end + 1,
      };
    }
  }
  return null;
}

function trimBareUrl(url) {
  let value = url;
  while (/[.,;:!?]$/.test(value)) value = value.slice(0, -1);
  while (value.endsWith(")")) {
    const open = (value.match(/\(/g) ?? []).length;
    const close = (value.match(/\)/g) ?? []).length;
    if (open >= close) break;
    value = value.slice(0, -1);
  }
  return value;
}

function renderAutolink(text, start, depth) {
  if (text[start] === "<") {
    const angle = /^<((?:https?:\/\/|mailto:)[^>\s]+)>/i.exec(text.slice(start));
    if (angle) {
      const url = angle[1];
      return {
        html: `<a href="${escapeAttribute(url)}" target="_blank" rel="noopener noreferrer">${escapeText(url)}</a>`,
        next: start + angle[0].length,
      };
    }
    const email = /^<([A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})>/.exec(text.slice(start));
    if (email) {
      return {
        html: `<a href="mailto:${escapeAttribute(email[1])}" target="_blank" rel="noopener noreferrer">${escapeText(email[1])}</a>`,
        next: start + email[0].length,
      };
    }
    return null;
  }
  const bare = /^(?:https?:\/\/)[^\s<>"'`]+/i.exec(text.slice(start));
  if (!bare) return null;
  const previous = text[start - 1] ?? "";
  if (!isOpeningBoundary(previous)) return null;
  const url = trimBareUrl(bare[0]);
  if (!url) return null;
  return {
    html: `<a href="${escapeAttribute(url)}" target="_blank" rel="noopener noreferrer">${escapeText(url)}</a>`,
    next: start + url.length,
  };
}

const INLINE_SPECIAL = /[\\`[!<*_~\nhH]/;

function renderInline(source, depth = 0) {
  const text = String(source ?? "");
  if (!text) return "";
  if (depth > 8) return escapeText(text);

  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];

    if (ch === "\\" && i + 1 < text.length) {
      if (text[i + 1] === "\n") out += "<br>";
      else out += escapeText(text[i + 1]);
      i += 2;
      continue;
    }

    if (ch === "`") {
      const code = parseCodeSpan(text, i);
      if (code) {
        out += code.html;
        i = code.next;
        continue;
      }
    }

    if (ch === "!" && text[i + 1] === "[") {
      const image = renderLinkOrImage(text, i, true, depth);
      if (image) {
        out += image.html;
        i = image.next;
        continue;
      }
    }

    if (ch === "[") {
      const link = renderLinkOrImage(text, i, false, depth);
      if (link) {
        out += link.html;
        i = link.next;
        continue;
      }
    }

    if (ch === "<") {
      const auto = renderAutolink(text, i, depth);
      if (auto) {
        out += auto.html;
        i = auto.next;
        continue;
      }
    }

    if (ch === "*" || ch === "_") {
      const emphasis = renderEmphasis(text, i, depth);
      if (emphasis) {
        out += emphasis.html;
        i = emphasis.next;
        continue;
      }
    }

    if (ch === "~" && text.startsWith("~~", i)) {
      const end = text.indexOf("~~", i + 2);
      if (end > i + 2) {
        const inner = text.slice(i + 2, end);
        if (inner.trim() && !/^\s|\s$/.test(inner)) {
          out += `<del>${renderInline(inner, depth + 1)}</del>`;
          i = end + 2;
          continue;
        }
      }
    }

    if (ch === "h" || ch === "H") {
      const auto = renderAutolink(text, i, depth);
      if (auto) {
        out += auto.html;
        i = auto.next;
        continue;
      }
    }

    if (ch === "\n") {
      out += "<br>";
      i += 1;
      continue;
    }

    // Consume a run of ordinary text in one escaped chunk.
    let j = i + 1;
    while (j < text.length && !INLINE_SPECIAL.test(text[j])) {
      j += 1;
    }
    out += escapeText(text.slice(i, j));
    i = j;
  }
  return out;
}

// -------------------------------------------------------------- block HTML

function isFence(line) {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return null;
  return { fence: match[1], info: match[2].trim() };
}

function isHeading(line) {
  const match = /^(#{1,6})[ \t]+(.*)$/.exec(line);
  if (!match) return null;
  const content = match[2].replace(/[ \t]+#+[ \t]*$/, "").trim();
  return { level: match[1].length, content };
}

function isRule(line) {
  return /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(line);
}

function isQuote(line) {
  return /^ {0,3}>/.test(line);
}

function matchList(line) {
  const match = /^( *)([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/.exec(line);
  if (!match) return null;
  const marker = match[2];
  return {
    indent: match[1].length,
    marker,
    ordered: /^\d/.test(marker),
    number: /^\d/.test(marker) ? Number.parseInt(marker, 10) : 0,
    content: match[3] ?? "",
  };
}

function splitTableRow(line) {
  let text = String(line ?? "").trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|") && !text.endsWith("\\|")) text = text.slice(0, -1);
  const cells = [];
  let current = "";
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\\" && text[i + 1] === "|") {
      current += "|";
      i += 1;
      continue;
    }
    if (text[i] === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += text[i];
  }
  cells.push(current.trim());
  return cells;
}

function isDelimiterCell(cell) {
  return /^:?-{1,}:?$/.test(String(cell ?? "").trim());
}

function looksLikeTable(lines, index) {
  if (index + 1 >= lines.length) return false;
  if (!lines[index].includes("|")) return false;
  const header = splitTableRow(lines[index]);
  const delimiter = splitTableRow(lines[index + 1]);
  return header.length >= 1 && header.length === delimiter.length && delimiter.every(isDelimiterCell);
}

function tableAlignment(cell) {
  const text = String(cell ?? "").trim();
  if (text.startsWith(":") && text.endsWith(":")) return "center";
  if (text.endsWith(":")) return "right";
  return "left";
}

function renderTable(lines, index, depth) {
  const header = splitTableRow(lines[index]);
  const delimiter = splitTableRow(lines[index + 1]);
  const align = delimiter.map(tableAlignment);
  let i = index + 2;
  const rows = [];
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || !line.includes("|")) break;
    const cells = splitTableRow(line);
    if (cells.length === 1 && !line.trim().includes("|")) break;
    rows.push(cells);
    i += 1;
  }
  const cell = (tag, content, column) =>
    `<${tag} class="align-${align[column] ?? "left"}">${renderInline(content, depth + 1)}</${tag}>`;
  let html = '<div class="table-wrap"><table><thead><tr>';
  for (let column = 0; column < header.length; column += 1) html += cell("th", header[column], column);
  html += "</tr></thead><tbody>";
  for (const row of rows) {
    const padded = [...row];
    while (padded.length < header.length) padded.push("");
    html += "<tr>";
    for (let column = 0; column < header.length; column += 1) html += cell("td", padded[column], column);
    html += "</tr>";
  }
  html += "</tbody></table></div>";
  return { html, next: i };
}

function collectQuote(lines, start) {
  const quoteLines = [];
  let i = start;
  while (i < lines.length && isQuote(lines[i])) {
    quoteLines.push(lines[i].replace(/^ {0,3}> ?/, ""));
    i += 1;
  }
  return { lines: quoteLines, next: i };
}

function collectList(lines, start) {
  const first = matchList(lines[start]);
  const baseIndent = first.indent;
  const ordered = first.ordered;
  let html = ordered
    ? `<ol${first.number > 1 ? ` start="${first.number}"` : ""}>`
    : "<ul>";
  let i = start;
  while (i < lines.length) {
    const item = matchList(lines[i]);
    if (!item || item.indent !== baseIndent || item.ordered !== ordered) break;
    const contentLines = [item.content];
    i += 1;

    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        let next = i + 1;
        while (next < lines.length && !lines[next].trim()) next += 1;
        if (next >= lines.length) {
          i = next;
          break;
        }
        const following = matchList(lines[next]);
        const followingIndent = following ? following.indent : indentOf(lines[next]);
        if ((following && followingIndent >= baseIndent) || followingIndent > baseIndent) {
          contentLines.push("");
          i += 1;
          continue;
        }
        break;
      }
      const following = matchList(line);
      const indent = indentOf(line);
      if (following && indent === baseIndent) break;
      if (indent <= baseIndent) break;
      contentLines.push(line.slice(Math.min(indent, baseIndent + 2)));
      i += 1;
    }

    const task = /^\[([ xX])\][ \t]+([\s\S]*)$/.exec(contentLines[0] ?? "");
    if (task) contentLines[0] = task[2];
    let body = renderBlocks(contentLines, 0, true);
    if (task) {
      const checked = task[1].toLowerCase() === "x";
      const checkbox = `<input type="checkbox" class="task-checkbox" disabled${checked ? " checked" : ""}> `;
      body = body.startsWith("<p>") ? `<p>${checkbox}${body.slice(3)}` : `${checkbox}${body}`;
    }
    html += `<li${task ? ' class="task-item"' : ""}>${body || ""}</li>`;
  }
  html += ordered ? "</ol>" : "</ul>";
  return { html, next: i };
}

function startsBlock(lines, index) {
  const line = lines[index];
  if (isFence(line) || isHeading(line) || isRule(line) || isQuote(line) || matchList(line)) return true;
  if (/^ {4}/.test(line)) return true;
  return looksLikeTable(lines, index);
}

function renderBlocks(lines, depth = 0, listItem = false) {
  if (depth > 16) return `<p>${renderInline(lines.join("\n"), 0)}</p>`;
  let html = "";
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i += 1;
      continue;
    }

    const fence = isFence(line);
    if (fence) {
      const marker = fence.fence[0];
      const length = fence.fence.length;
      const close = new RegExp(`^ {0,3}${marker === "`" ? "`" : "~"}{${length},}[ \\t]*$`);
      const code = [];
      i += 1;
      while (i < lines.length && !close.test(lines[i])) {
        code.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      const language = (fence.info.split(/[ \t]+/)[0] ?? "").replace(/[^\w#+.-]/g, "");
      html += `<pre class="code"><code${language ? ` class="language-${language}"` : ""}>${escapeHtml(code.join("\n"))}</code></pre>`;
      continue;
    }

    const heading = isHeading(line);
    if (heading) {
      html += `<h${heading.level}>${renderInline(heading.content, depth + 1)}</h${heading.level}>`;
      i += 1;
      continue;
    }

    if (
      i + 1 < lines.length
      && !isBlank(line)
      && !isFence(line)
      && !isHeading(line)
      && !isRule(line)
      && !isQuote(line)
      && !matchList(line)
      && /^ {0,3}(=+|-+)[ \t]*$/.test(lines[i + 1])
    ) {
      const level = lines[i + 1].trim().startsWith("=") ? 1 : 2;
      html += `<h${level}>${renderInline(line.trim(), depth + 1)}</h${level}>`;
      i += 2;
      continue;
    }

    if (isRule(line)) {
      html += "<hr>";
      i += 1;
      continue;
    }

    if (isQuote(line)) {
      const quote = collectQuote(lines, i);
      html += `<blockquote>${renderBlocks(quote.lines, depth + 1)}</blockquote>`;
      i = quote.next;
      continue;
    }

    if (looksLikeTable(lines, i)) {
      const table = renderTable(lines, i, depth);
      html += table.html;
      i = table.next;
      continue;
    }

    if (matchList(line)) {
      const list = collectList(lines, i);
      html += list.html;
      i = list.next;
      continue;
    }

    if (/^ {4}/.test(line)) {
      const code = [];
      while (i < lines.length && (isBlank(lines[i]) || /^ {4}/.test(lines[i]))) {
        code.push(lines[i].replace(/^ {4}/, ""));
        i += 1;
      }
      while (code.length && !code[code.length - 1].trim()) code.pop();
      html += `<pre class="code"><code>${escapeHtml(code.join("\n"))}</code></pre>`;
      continue;
    }

    const paragraph = [];
    while (i < lines.length) {
      if (isBlank(lines[i])) break;
      if (paragraph.length > 0 && startsBlock(lines, i)) break;
      paragraph.push(lines[i].trim());
      i += 1;
    }
    if (paragraph.length) {
      html += `<p>${renderInline(paragraph.join("\n"), depth + 1)}</p>`;
    }
  }
  return html;
}

/**
 * Render markdown to safe HTML. `listItem` is internal recursion state.
 */
export function renderMarkdown(source) {
  const text = String(source ?? "").replace(/\r\n?/g, "\n").replace(/\t/g, "  ");
  if (!text.trim()) return "";
  return renderBlocks(text.split("\n"));
}

export { escapeHtml, escapeText };
