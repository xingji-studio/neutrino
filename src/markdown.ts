import type { Buffer } from "./terminal/buffer.js";
import { C, type Style } from "./colors.js";
import { displayWidth, truncateByWidth, wcwidth } from "./width.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface Span {
  text: string;
  style: Style;
}

export interface Line {
  spans: Span[];
}

export type TableAlign = "left" | "center" | "right";

export type Block =
  | { type: "paragraph"; spans: Span[] }
  | { type: "heading"; level: number; spans: Span[] }
  | { type: "listItem"; ordered: boolean; number: number; level: number; spans: Span[] }
  | { type: "code"; lang: string; lines: string[] }
  | { type: "quote"; spans: Span[] }
  | { type: "rule" }
  | { type: "table"; header: Span[][]; rows: Span[][][]; align: TableAlign[] }
  | { type: "blank" };

// ---------------------------------------------------------------------------
// Style helpers
// ---------------------------------------------------------------------------

function mergeStyle(base: Style, over: Style): Style {
  return {
    fg: over.fg ?? base.fg,
    bg: over.bg ?? base.bg,
    bold: over.bold ?? base.bold,
    dim: over.dim ?? base.dim,
    inverse: over.inverse ?? base.inverse,
    italic: over.italic ?? base.italic,
  };
}

function styleKeyOf(st: Style): string {
  return JSON.stringify([
    st.fg ? `f${st.fg[0]},${st.fg[1]},${st.fg[2]}` : "",
    st.bg ? `b${st.bg[0]},${st.bg[1]},${st.bg[2]}` : "",
    st.bold ? 1 : 0,
    st.dim ? 1 : 0,
    st.inverse ? 1 : 0,
    st.italic ? 1 : 0,
  ]);
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

// ---------------------------------------------------------------------------
// Inline parsing (bold / italic / code / links / strikethrough / escapes)
// ---------------------------------------------------------------------------

const WORD_RE = /[\p{L}\p{N}]/u;

function codePointBefore(text: string, i: number): string {
  let j = i - 1;
  if (j < 0) return "";
  const code = text.charCodeAt(j);
  if (code >= 0xdc00 && code <= 0xdfff && j > 0) {
    const hi = text.charCodeAt(j - 1);
    if (hi >= 0xd800 && hi <= 0xdbff) return text.slice(j - 1, j + 1);
  }
  return text[j];
}

/** `*` / `_` opening emphasis must not be glued to a word and must have content after it. */
function isEmphasisOpen(text: string, i: number): boolean {
  const prev = codePointBefore(text, i);
  if (prev && WORD_RE.test(prev)) return false;
  const next = text.codePointAt(i + 1) ?? 0;
  if (!next) return false;
  if (/\s/.test(String.fromCodePoint(next))) return false;
  return true;
}

export function parseInline(text: string, base: Style = {}): Span[] {
  const spans: Span[] = [];
  const append = (sp: Span): void => {
    const last = spans[spans.length - 1];
    if (last && styleKeyOf(last.style) === styleKeyOf(sp.style)) {
      last.text += sp.text;
    } else {
      spans.push(sp);
    }
  };
  const push = (raw: string, over: Style): void => {
    if (!raw) return;
    append({ text: decodeEntities(raw), style: mergeStyle(base, over) });
  };
  const pushNested = (raw: string, over: Style): void => {
    const inner = parseInline(raw, mergeStyle(base, over));
    for (const sp of inner) append(sp);
  };

  let i = 0;
  const n = text.length;
  while (i < n) {
    const cp = text.codePointAt(i) ?? 0;
    const ch = String.fromCodePoint(cp);
    const unitLen = ch.length;

    // backslash escape: \*
    if (ch === "\\" && i + 1 < n) {
      const ncp = text.codePointAt(i + 1) ?? 0;
      push(String.fromCodePoint(ncp), {});
      i += 1 + String.fromCodePoint(ncp).length;
      continue;
    }
    // inline code `...`
    if (ch === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i) {
        push(text.slice(i + 1, end), { fg: C.green, bg: C.codeBg });
        i = end + 1;
        continue;
      }
    }
    // link [label](url)
    if (ch === "[") {
      const close = text.indexOf("]", i + 1);
      if (close > i && text[close + 1] === "(") {
        const pend = text.indexOf(")", close + 2);
        if (pend > close + 2) {
          const label = text.slice(i + 1, close);
          const url = text.slice(close + 2, pend);
          push(label || url, { fg: C.accent, bold: true });
          if (label && url) push(" (" + url + ")", { fg: C.dim });
          i = pend + 1;
          continue;
        }
      }
    }
    // bold + italic *** / ___
    if ((ch === "*" && text.startsWith("***", i)) || (ch === "_" && text.startsWith("___", i))) {
      const delim = text.slice(i, i + 3);
      const end = text.indexOf(delim, i + 3);
      if (end > i + 3) {
        pushNested(text.slice(i + 3, end), { bold: true, italic: true });
        i = end + 3;
        continue;
      }
    }
    // bold ** / __
    if ((ch === "*" && text.startsWith("**", i)) || (ch === "_" && text.startsWith("__", i))) {
      const prev = codePointBefore(text, i);
      if (!prev || !WORD_RE.test(prev)) {
        const delim = text.slice(i, i + 2);
        const end = text.indexOf(delim, i + 2);
        if (end > i + 2) {
          pushNested(text.slice(i + 2, end), { bold: true });
          i = end + 2;
          continue;
        }
      }
    }
    // strikethrough ~~
    if (ch === "~" && text.startsWith("~~", i)) {
      const end = text.indexOf("~~", i + 2);
      if (end > i + 2) {
        pushNested(text.slice(i + 2, end), { dim: true });
        i = end + 2;
        continue;
      }
    }
    // emphasis * / _
    if (ch === "*" || ch === "_") {
      if (isEmphasisOpen(text, i)) {
        const end = text.indexOf(ch, i + 1);
        if (end > i + 1) {
          pushNested(text.slice(i + 1, end), { italic: true });
          i = end + 1;
          continue;
        }
      }
    }

    // plain text run: fast path, also lets HTML entities decode as a unit
    let j = i;
    while (j < n) {
      const c = text[j];
      if (c === "\\" || c === "`" || c === "[" || c === "*" || c === "_" || c === "~") break;
      j++;
    }
    if (j > i) {
      push(text.slice(i, j), {});
      i = j;
      continue;
    }

    push(ch, {});
    i += unitLen;
  }
  return spans;
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

function indentWidth(line: string): number {
  const m = line.match(/^\s*/);
  return m ? m[0].replace(/\t/g, "  ").length : 0;
}

function isDelimiterRow(line: string): boolean {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  const cells = s.split("|");
  if (cells.length < 2) return false;
  return cells.every((c) => /^\s*:?-{1,}:?\s*$/.test(c.trim()));
}

function looksLikeTable(src: string[], i: number): boolean {
  if (i + 1 >= src.length) return false;
  if (!src[i].includes("|")) return false;
  return isDelimiterRow(src[i + 1]);
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

function parseTable(
  src: string[],
  i: number,
  base: Style,
): { block: Extract<Block, { type: "table" }>; consumed: number } {
  const header = splitRow(src[i]).map((c) => parseInline(c, base));
  const delim = splitRow(src[i + 1]);
  const align: TableAlign[] = delim.map((c) => {
    const t = c.trim();
    if (t.startsWith(":") && t.endsWith(":")) return "center";
    if (t.endsWith(":")) return "right";
    return "left";
  });
  const rows: Span[][][] = [];
  let j = i + 2;
  while (j < src.length && src[j].trim() && src[j].includes("|")) {
    rows.push(splitRow(src[j]).map((c) => parseInline(c, base)));
    j++;
  }
  return { block: { type: "table", header, rows, align }, consumed: j - i };
}

export function parseMarkdown(text: string, base: Style = {}): Block[] {
  const blocks: Block[] = [];
  const src = text.replace(/\r\n?/g, "\n").split("\n");
  const n = src.length;
  let i = 0;

  const isFence = (line: string): RegExpMatchArray | null => line.match(/^\s*(`{3,}|~{3,})(.*)$/);
  const isHeading = (line: string): RegExpMatchArray | null => line.match(/^(#{1,6})\s+(.*)$/);
  const isRule = (line: string): boolean => /^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line);
  const isQuote = (line: string): boolean => /^\s*>/.test(line);
  const isList = (line: string): RegExpMatchArray | null =>
    line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);

  while (i < n) {
    const line = src[i];
    if (!line.trim()) {
      blocks.push({ type: "blank" });
      i++;
      continue;
    }

    // fenced code block
    const fence = isFence(line);
    if (fence) {
      const lang = (fence[2].trim().split(/\s+/)[0] ?? "").replace(/^`+/, "");
      const closeRe = new RegExp(`^\\s*${fence[1][0]}{${fence[1].length},}\\s*$`);
      const codeLines: string[] = [];
      i++;
      while (i < n && !closeRe.test(src[i])) {
        codeLines.push(src[i]);
        i++;
      }
      i++; // skip closing fence (or past the end)
      blocks.push({ type: "code", lang, lines: codeLines });
      continue;
    }

    // ATX heading
    const heading = isHeading(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, spans: parseInline(heading[2], base) });
      i++;
      continue;
    }

    // horizontal rule
    if (isRule(line)) {
      blocks.push({ type: "rule" });
      i++;
      continue;
    }

    // blockquote
    if (isQuote(line)) {
      const quoteLines: string[] = [];
      while (i < n && isQuote(src[i])) {
        quoteLines.push(src[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      blocks.push({ type: "quote", spans: parseInline(quoteLines.join("\n"), base) });
      continue;
    }

    // table
    if (looksLikeTable(src, i)) {
      const tbl = parseTable(src, i, base);
      blocks.push(tbl.block);
      i += tbl.consumed;
      continue;
    }

    // list
    const listMatch = isList(line);
    if (listMatch) {
      while (i < n) {
        const l = src[i];
        if (!l.trim()) break;
        const lm = isList(l);
        if (!lm) {
          // indented continuation line of the previous item
          const prev = blocks[blocks.length - 1];
          if (indentWidth(l) > 0 && prev && prev.type === "listItem") {
            const item = prev as Extract<Block, { type: "listItem" }>;
            item.spans = [...item.spans, { text: " ", style: {} }, ...parseInline(l.trim(), base)];
            i++;
            continue;
          }
          break;
        }
        const indentStr = lm[1].replace(/\t/g, "  ");
        const marker = lm[2];
        const ordered = /^\d+\.$/.test(marker);
        const number = ordered ? parseInt(marker, 10) : 0;
        blocks.push({
          type: "listItem",
          ordered,
          number,
          level: Math.min(6, Math.floor(indentStr.length / 2)),
          spans: parseInline(lm[3], base),
        });
        i++;
      }
      continue;
    }

    // plain paragraph: collect until a block boundary or blank line
    const paraLines: string[] = [];
    while (i < n) {
      const l = src[i];
      if (!l.trim()) break;
      if (isHeading(l) || isRule(l) || isQuote(l) || isFence(l) || isList(l)) break;
      paraLines.push(l);
      i++;
    }
    blocks.push({ type: "paragraph", spans: parseInline(paraLines.join("\n"), base) });
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Wrapping
// ---------------------------------------------------------------------------

function chunkByWidth(text: string, width: number): string[] {
  if (width < 1) width = 1;
  const chunks: string[] = [];
  let cur = "";
  let curW = 0;
  for (const ch of text) {
    const w = wcwidth(ch.codePointAt(0) ?? 0);
    if (curW + w > width && cur.length > 0) {
      chunks.push(cur);
      cur = ch;
      curW = w;
    } else {
      cur += ch;
      curW += w;
    }
  }
  if (cur.length > 0) chunks.push(cur);
  return chunks;
}

interface WordTok {
  text: string;
  style: Style;
  spaceBefore: boolean;
}

/** Wrap a single (newline-free) run of spans into lines, word by word. */
function wrapSegment(spans: Span[], width: number): Line[] {
  if (width < 1) width = 1;
  const words: WordTok[] = [];
  let pendingSpace = false;
  for (const s of spans) {
    const parts = s.text.split(/(\s+)/);
    for (const p of parts) {
      if (!p) continue;
      if (/^\s+$/.test(p)) {
        pendingSpace = true;
      } else {
        words.push({ text: p, style: s.style, spaceBefore: pendingSpace });
        pendingSpace = false;
      }
    }
  }

  const lines: Line[] = [];
  let cur: Span[] = [];
  let curW = 0;
  const pushLine = (): void => {
    if (cur.length) lines.push({ spans: cur });
    cur = [];
    curW = 0;
  };
  const addWord = (w: WordTok): void => {
    const ww = displayWidth(w.text);
    if (cur.length === 0) {
      if (ww <= width) {
        cur.push({ text: w.text, style: w.style });
        curW = ww;
      } else {
        const chunks = chunkByWidth(w.text, width);
        for (let c = 0; c < chunks.length - 1; c++) {
          lines.push({ spans: [{ text: chunks[c], style: w.style }] });
        }
        cur.push({ text: chunks[chunks.length - 1], style: w.style });
        curW = displayWidth(chunks[chunks.length - 1]);
      }
      return;
    }
    const extra = (w.spaceBefore ? 1 : 0) + ww;
    if (curW + extra <= width) {
      if (w.spaceBefore) cur.push({ text: " ", style: w.style });
      cur.push({ text: w.text, style: w.style });
      curW += extra;
    } else {
      pushLine();
      addWord({ ...w, spaceBefore: false });
    }
  };
  for (const w of words) addWord(w);
  pushLine();
  return lines;
}

/**
 * Wrap spans into lines, optionally prefixing the first line and indenting
 * continuation lines. Used for headings, list items and blockquotes.
 */
export function wrapSpans(
  spans: Span[],
  width: number,
  opts: { prefix?: Span[]; indent?: number } = {},
): Line[] {
  const prefix = opts.prefix ?? [];
  const prefixW = displayWidth(prefix.map((p) => p.text).join(""));
  const indent = opts.indent ?? prefixW;
  const contentW = Math.max(4, width - Math.max(prefixW, indent));
  const inner = wrapSegment(spans, contentW);
  const out: Line[] = [];
  if (inner.length === 0) {
    out.push({ spans: [...prefix] });
    return out;
  }
  for (let k = 0; k < inner.length; k++) {
    const lead: Span[] = k === 0 ? prefix : [{ text: " ".repeat(indent), style: {} }];
    out.push({ spans: [...lead, ...inner[k].spans] });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Block rendering
// ---------------------------------------------------------------------------

export function renderBlocks(blocks: Block[], width: number): Line[] {
  const out: Line[] = [];
  let pendingBlank = false;
  for (const b of blocks) {
    if (b.type === "blank") {
      pendingBlank = true;
      continue;
    }
    if (pendingBlank && out.length > 0) out.push({ spans: [] });
    pendingBlank = false;
    for (const ln of renderBlock(b, width)) out.push(ln);
  }
  return out;
}

function renderBlock(b: Block, width: number): Line[] {
  switch (b.type) {
    case "paragraph":
      return wrapSpans(b.spans, width);
    case "heading": {
      const level = Math.min(6, b.level);
      const prefix: Span[] = [{ text: "#".repeat(level) + " ", style: { fg: C.accent, bold: true } }];
      const spans = b.spans.map((s) => ({ ...s, style: { ...s.style, bold: true } }));
      return wrapSpans(spans, width, { prefix });
    }
    case "listItem": {
      const marker = b.ordered ? `${b.number || 1}.` : "•";
      const prefix: Span[] = [{ text: marker + " ", style: { fg: C.accent, bold: true } }];
      const pad: Span[] = b.level > 0 ? [{ text: "  ".repeat(b.level), style: {} }] : [];
      return wrapSpans(b.spans, width, { prefix, indent: 2 }).map((ln) => ({
        spans: [...pad, ...ln.spans],
      }));
    }
    case "quote": {
      const prefix: Span[] = [{ text: "│ ", style: { fg: C.dim } }];
      const spans = b.spans.map((s) => ({ ...s, style: { ...s.style, dim: true } }));
      return wrapSpans(spans, width, { prefix, indent: 2 });
    }
    case "code": {
      const lines: Line[] = [];
      const style: Style = { fg: C.green, bg: C.codeBg };
      for (const raw of b.lines) {
        for (const chunk of chunkByWidth(raw, width)) {
          lines.push({ spans: [{ text: chunk, style }] });
        }
      }
      return lines;
    }
    case "rule":
      return [{ spans: [{ text: "─".repeat(Math.max(4, width)), style: { fg: C.dim } }] }];
    case "table":
      return renderTable(b, width);
    default:
      return [];
  }
}

function wrapCell(cell: Span[], w: number): Line[] {
  if (!cell.length) return [{ spans: [] }];
  const lines = wrapSegment(cell, w);
  return lines.length ? lines : [{ spans: [] }];
}

function renderTable(t: Extract<Block, { type: "table" }>, width: number): Line[] {
  const nCols = Math.max(1, t.header.length);
  const allRows: Span[][][] = [t.header, ...t.rows];
  const out: Line[] = [];

  // Natural width per column (max display width of any single line of text).
  const natural = new Array<number>(nCols).fill(1);
  for (const row of allRows) {
    for (let c = 0; c < nCols; c++) {
      const cell = row[c] ?? [];
      let cw = 0;
      for (const s of cell) {
        for (const part of s.text.split("\n")) {
          cw = Math.max(cw, displayWidth(part));
        }
      }
      if (cw > natural[c]) natural[c] = Math.min(cw, width);
    }
  }

  // Total row width = sum(colW) + 3*nCols + 1 (borders + padding).
  const budget = Math.max(nCols, width - 3 * nCols - 1);
  const totalNatural = natural.reduce((a, b) => a + b, 0);
  let colW: number[];
  if (totalNatural + 3 * nCols + 1 <= width) {
    colW = natural.slice();
  } else {
    colW = natural.map((w) => Math.max(1, Math.floor((w * budget) / totalNatural)));
    const used = colW.reduce((a, b) => a + b, 0);
    colW[nCols - 1] = Math.max(1, colW[nCols - 1] + (budget - used));
  }

  const borderStyle: Style = { fg: C.dim };
  const mkBorder = (left: string, mid: string, right: string): Span[] => {
    const spans: Span[] = [];
    for (let c = 0; c < nCols; c++) {
      spans.push({ text: (c === 0 ? left : mid) + "─".repeat(colW[c] + 2), style: borderStyle });
    }
    spans.push({ text: right, style: borderStyle });
    return spans;
  };

  const renderRow = (row: Span[][], isHeader: boolean): void => {
    const wrapped = row.map((cell, c) => wrapCell(cell, colW[c]));
    const rowH = Math.max(1, ...wrapped.map((w) => w.length));
    for (let li = 0; li < rowH; li++) {
      const spans: Span[] = [];
      for (let c = 0; c < nCols; c++) {
        if (c === 0) spans.push({ text: "│ ", style: borderStyle });
        const cellLine = wrapped[c][li]?.spans ?? [];
        for (const s of cellLine) {
          spans.push(isHeader ? { ...s, style: { ...s.style, bold: true } } : s);
        }
        const used = displayWidth(cellLine.map((s) => s.text).join(""));
        const pad = Math.max(0, colW[c] - used);
        let padLeft = 0;
        let padRight = pad;
        const a = t.align[c] ?? "left";
        if (a === "center") {
          padLeft = Math.floor(pad / 2);
          padRight = pad - padLeft;
        } else if (a === "right") {
          padLeft = pad;
          padRight = 0;
        }
        if (padLeft > 0) spans.push({ text: " ".repeat(padLeft), style: {} });
        if (padRight > 0) spans.push({ text: " ".repeat(padRight), style: {} });
        spans.push({ text: c < nCols - 1 ? " │ " : " │", style: borderStyle });
      }
      out.push({ spans });
    }
  };

  out.push({ spans: mkBorder("┌", "┬", "┐") });
  renderRow(t.header, true);
  out.push({ spans: mkBorder("├", "┼", "┤") });
  for (const r of t.rows) renderRow(r, false);
  out.push({ spans: mkBorder("└", "┴", "┘") });
  return out;
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/** Parse and render a markdown string into styled lines. */
export function renderMarkdownText(text: string, width: number, base: Style = {}): Line[] {
  return renderBlocks(parseMarkdown(text, base), width);
}

/**
 * Draw a sequence of styled spans onto the buffer, starting at (x, y),
 * clipped to `maxWidth` columns.
 */
export function drawSpans(buf: Buffer, x: number, y: number, spans: Span[], maxWidth: number): void {
  let col = x;
  const limit = x + maxWidth;
  for (const s of spans) {
    if (col >= limit) break;
    const avail = limit - col;
    if (avail <= 0) break;
    const w = displayWidth(s.text);
    const text = w > avail ? truncateByWidth(s.text, avail) : s.text;
    if (!text) continue;
    buf.writeText(col, y, text, s.style);
    col += displayWidth(text);
  }
}
