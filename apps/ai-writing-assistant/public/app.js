// AI Writing Assistant – front end.
//
// A Medium-style rich-text editor (contenteditable) with Grammarly-style
// suggestions. Suggestions are located in a plain-text view of the story
// (title + blocks joined by blank lines) and drawn with the CSS Custom
// Highlight API, so the story's own markup is never touched by underlines.
//
// Everything that depends on where the page runs lives in `window.Platform`
// (platform-web.js, or claude-ai/platform.js for the claude.ai build):
//   Platform.call(kind, body, {signal, onText, cache})  kind: check | style | rewrite
//   Platform.autoCheck                                   check automatically while typing
//   Platform.openStore()                                 a story store, or null for the local one

const $ = (id) => document.getElementById(id);
const editor = $("editor");
const popover = $("popover");
const bubble = $("bubble");

const CHECK_CATS = ["correctness", "clarity", "engagement", "delivery"];
const CATEGORIES = [...CHECK_CATS, "style"];
const LABELS = { correctness: "Correctness", clarity: "Clarity", engagement: "Engagement", delivery: "Delivery", style: "AI-like" };
const LEVELS = { low: "Low", medium: "Medium", high: "High" };
const MAX_CHARS = 30000;
const CHECK_DELAY_MS = 1800;
const SAVE_DELAY_MS = 800;
const UNIT_SEL = "h1,h2,h3,p,blockquote,li,figcaption,pre";

const prefs = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
  },
};

const state = {
  idx: { text: "", nodes: [] },  // plain-text view of the story
  suggestions: [],               // {id, category, title, original, replacement, explanation, start, end}
  dismissed: new Set(prefs.get("wa.dismissed", [])),
  filter: "all",
  activeId: null,
  openId: null,
  checkedText: null,
  example: false,                // showing the built-in example suggestions
  checkCtl: null,
  checkTimer: null,
  goals: prefs.get("wa.goals", { audience: "general", formality: "neutral", domain: "general", intent: "inform" }),
  ai: null,                      // {start, end, instruction, result, busy}
  linkRange: null,
  doc: null,                     // the open story {id, title, html, updatedAt, sample}
  store: null,
  saveTimer: null,
  saving: Promise.resolve(),
  insertTarget: null,
};
let nextId = 1;

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const keyOf = (s) => `${s.original}\u0000${s.replacement}`;
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// ---------- Sample story ----------

const SAMPLE_HTML = `<h1>How the Water Cycle Works</h1>
<p>Teh water cycle is a very good example of how nature recycle it's resources. When the sun heats up oceans and lakes, water evaporates and rises in to the air as vapor.</p>
<h2>From clouds to rain</h2>
<p>In order to form clouds, the vapor cools down and condenses into tiny droplets. Eventually, the droplets gets heavy and they fall back to earth as rain, snow, or hail.</p>
<blockquote>This process happens over and over again and it never really stops and it is important for all living things.</blockquote>`;

const SAMPLE_SUGGESTIONS = [
  { category: "correctness", title: "Fix spelling", original: "Teh", prefix: "", replacement: "The", explanation: "“Teh” is a misspelling of “the”." },
  { category: "engagement", title: "Use a stronger word", original: "very good", prefix: "cycle is a ", replacement: "clear", explanation: "One precise word says more than “very good”." },
  { category: "correctness", title: "Fix subject-verb agreement", original: "recycle", prefix: "of how nature ", replacement: "recycles", explanation: "“Nature” is singular, so the verb needs an -s." },
  { category: "correctness", title: "Use “its”", original: "it's", prefix: "nature recycle ", replacement: "its", explanation: "“It's” means “it is”; the possessive is “its”." },
  { category: "correctness", title: "Join as one word", original: "in to", prefix: "and rises ", replacement: "into", explanation: "“Into” shows movement toward something." },
  { category: "clarity", title: "Remove wordiness", original: "In order to", prefix: "", replacement: "To", explanation: "“To” says the same thing more simply." },
  { category: "correctness", title: "Fix subject-verb agreement", original: "gets", prefix: "the droplets ", replacement: "get", explanation: "“Droplets” is plural, so use “get”." },
  { category: "clarity", title: "Split the run-on sentence", original: "This process happens over and over again and it never really stops and it is important for all living things.", prefix: "", replacement: "This process repeats endlessly, and every living thing depends on it.", explanation: "Shorter, joined ideas are easier to follow than a chain of “and”s." },
];

// ---------- Sanitizing pasted / stored HTML ----------

const BLOCK_TAGS = { H1: "h1", H2: "h2", H3: "h3", H4: "h3", H5: "h3", H6: "h3", P: "p", BLOCKQUOTE: "blockquote", PRE: "pre", DIV: "p", SECTION: "p", ARTICLE: "p" };
const INLINE_TAGS = { B: "strong", STRONG: "strong", I: "em", EM: "em", A: "a", BR: "br", CODE: "code", U: "u", S: "s" };
const okHref = (h) => /^(https?:|mailto:)/i.test(h || "");
const okSrc = (s) => /^(https?:|data:image\/(png|jpe?g|gif|webp);|\/_blob\/)/i.test(s || "");

function cleanInline(node, out) {
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) { out.append(child.data.replace(/\s+/g, " ")); continue; }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const tag = INLINE_TAGS[child.tagName];
    if (!tag) { cleanInline(child, out); continue; }
    const el = document.createElement(tag);
    if (tag === "a") { const href = child.getAttribute("href"); if (okHref(href)) el.setAttribute("href", href); else { cleanInline(child, out); continue; } }
    if (tag !== "br") cleanInline(child, el);
    out.append(el);
  }
}

function figureFor(src, caption = "") {
  const fig = document.createElement("figure");
  const img = document.createElement("img");
  img.src = src;
  img.alt = caption;
  const cap = document.createElement("figcaption");
  cap.textContent = caption;
  fig.append(img, cap);
  return fig;
}

function cleanBlocks(node, out) {
  let para = null; // collects loose inline content
  const flush = () => { if (para && para.textContent.trim()) out.append(para); para = null; };
  for (const child of node.childNodes) {
    const isEl = child.nodeType === Node.ELEMENT_NODE;
    const tag = isEl ? child.tagName : "";
    if (isEl && (tag === "UL" || tag === "OL")) {
      flush();
      const list = document.createElement(tag.toLowerCase());
      for (const li of child.querySelectorAll(":scope > li")) {
        const item = document.createElement("li");
        cleanInline(li, item);
        if (item.textContent.trim()) list.append(item);
      }
      if (list.children.length) out.append(list);
    } else if (isEl && tag === "FIGURE") {
      flush();
      const img = child.querySelector("img");
      if (img && okSrc(img.getAttribute("src"))) out.append(figureFor(img.getAttribute("src"), child.querySelector("figcaption")?.textContent.trim() || ""));
    } else if (isEl && tag === "IMG") {
      flush();
      if (okSrc(child.getAttribute("src"))) out.append(figureFor(child.getAttribute("src"), child.getAttribute("alt") || ""));
    } else if (isEl && tag === "HR") {
      flush();
      out.append(document.createElement("hr"));
    } else if (isEl && BLOCK_TAGS[tag]) {
      flush();
      if (child.querySelector("p,div,h1,h2,h3,h4,ul,ol,figure,img,blockquote")) { cleanBlocks(child, out); continue; }
      const el = document.createElement(BLOCK_TAGS[tag]);
      cleanInline(child, el);
      if (el.textContent.trim() || tag === "H1") out.append(el);
    } else {
      para ??= document.createElement("p");
      const holder = document.createElement("span");
      holder.append(child.cloneNode(true));
      cleanInline(holder, para);
    }
  }
  flush();
}

function sanitize(html) {
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  const out = document.createElement("div");
  cleanBlocks(tpl.content, out);
  return out.innerHTML;
}

// ---------- Editor structure ----------

function setBlockTag(el, tag) {
  const repl = document.createElement(tag);
  repl.append(...el.childNodes);
  el.replaceWith(repl);
  return repl;
}

// Keeps the story's shape: a title first, paragraphs as top-level blocks,
// figures with editable captions, and the placeholders Medium shows.
function normalize() {
  for (const node of [...editor.childNodes]) {
    if (node.nodeType === Node.TEXT_NODE && node.data.trim()) {
      const p = document.createElement("p");
      node.replaceWith(p);
      p.append(node);
    } else if (node.nodeType === Node.ELEMENT_NODE && (node.tagName === "DIV" || node.tagName === "SPAN")) {
      setBlockTag(node, "p");
    }
  }
  let first = editor.firstElementChild;
  if (!first || first.tagName !== "H1") {
    first = document.createElement("h1");
    first.append(document.createElement("br"));
    editor.prepend(first);
  }
  for (const h of editor.querySelectorAll("h1")) if (h !== first) setBlockTag(h, "h2");
  if (!first.nextElementSibling) {
    const p = document.createElement("p");
    p.append(document.createElement("br"));
    editor.append(p);
  }
  // Empty blocks need a <br> so the caret can sit in them.
  for (const el of editor.querySelectorAll(":scope > h1, :scope > h2, :scope > h3, :scope > p, :scope > blockquote")) {
    if (!el.firstChild) el.append(document.createElement("br"));
  }
  for (const fig of editor.querySelectorAll("figure")) {
    fig.contentEditable = "false";
    let cap = fig.querySelector("figcaption");
    if (!cap) { cap = document.createElement("figcaption"); fig.append(cap); }
    cap.contentEditable = "true";
    if (!fig.querySelector(".fig-remove")) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "fig-remove";
      btn.textContent = "Remove image";
      fig.append(btn);
    }
  }
  // Placeholders
  for (const el of editor.querySelectorAll(".empty")) { el.classList.remove("empty"); el.removeAttribute("data-placeholder"); }
  const mark = (el, text) => { el.classList.add("empty"); el.dataset.placeholder = text; };
  if (!first.textContent.trim()) mark(first, "Title");
  const body = [...editor.children].slice(1);
  if (body.length === 1 && body[0].tagName === "P" && !body[0].textContent.trim()) mark(body[0], "Tell your story…");
  for (const cap of editor.querySelectorAll("figcaption")) if (!cap.textContent.trim()) mark(cap, "Type a caption (optional)");
}

function serialize() {
  const clone = editor.cloneNode(true);
  clone.querySelectorAll(".fig-remove").forEach((b) => b.remove());
  clone.querySelectorAll("[contenteditable]").forEach((el) => el.removeAttribute("contenteditable"));
  clone.querySelectorAll("[data-placeholder]").forEach((el) => el.removeAttribute("data-placeholder"));
  clone.querySelectorAll("[class]").forEach((el) => el.removeAttribute("class"));
  return clone.innerHTML;
}

const storyTitle = () => editor.querySelector("h1")?.textContent.trim() || "";

// ---------- Plain-text index: text offsets <-> DOM positions ----------

function units() {
  return [...editor.querySelectorAll(UNIT_SEL)].filter((el) => !el.querySelector(UNIT_SEL));
}

function buildIndex() {
  let text = "";
  const nodes = [];
  units().forEach((unit, i) => {
    if (i) text += "\n\n";
    const walker = document.createTreeWalker(unit, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      nodes.push({ node: n, start: text.length, end: text.length + n.data.length });
      text += n.data;
    }
  });
  return { text, nodes };
}

function pointAt(offset, preferNext) {
  const nodes = state.idx.nodes;
  let hit = null;
  for (const e of nodes) {
    if (offset >= e.start && offset <= e.end) {
      hit = e;
      if (!(preferNext && offset === e.end)) break;
    } else if (e.start > offset) break;
  }
  return hit ? { node: hit.node, offset: offset - hit.start } : null;
}

function rangeFor(start, end) {
  const a = pointAt(start, true);
  const b = pointAt(end, false);
  if (!a || !b) return null;
  const r = document.createRange();
  try { r.setStart(a.node, a.offset); r.setEnd(b.node, b.offset); } catch { return null; }
  return r;
}

function offsetOf(node, offset) {
  if (node.nodeType !== Node.TEXT_NODE) {
    const child = node.childNodes[offset];
    const walker = document.createTreeWalker(child || node, NodeFilter.SHOW_TEXT);
    if (child) { const t = child.nodeType === Node.TEXT_NODE ? child : walker.nextNode(); if (t) return offsetOf(t, 0); }
    let last = null;
    for (let t = walker.nextNode(); t; t = walker.nextNode()) last = t;
    return last ? offsetOf(last, last.data.length) : null;
  }
  const e = state.idx.nodes.find((x) => x.node === node);
  return e ? e.start + Math.min(offset, node.data.length) : null;
}

function selectionOffsets() {
  const sel = getSelection();
  if (!sel.rangeCount || !editor.contains(sel.anchorNode)) return null;
  const r = sel.getRangeAt(0);
  const start = offsetOf(r.startContainer, r.startOffset);
  const end = offsetOf(r.endContainer, r.endOffset);
  return start === null || end === null ? null : { start, end, collapsed: r.collapsed };
}

function selectRange(range) {
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

// Replace a text range through execCommand so native undo (Ctrl+Z) still works.
function replaceText(start, end, text) {
  const range = rangeFor(start, end);
  if (!range) return false;
  editor.focus({ preventScroll: true });
  selectRange(range);
  const ok = text ? document.execCommand("insertText", false, text) : document.execCommand("delete");
  if (!ok) {
    range.deleteContents();
    if (text) range.insertNode(document.createTextNode(text));
    onEdit();
  }
  return true;
}

// ---------- Suggestions ----------

function locate(text, s, taken) {
  if (!s.original) return null;
  const free = (i) => !taken.some((t) => i < t.end && i + s.original.length > t.start);
  const hits = [];
  for (let i = text.indexOf(s.original); i !== -1; i = text.indexOf(s.original, i + 1)) {
    if (free(i)) hits.push(i);
  }
  if (!hits.length) return null;
  const exact = s.prefix ? hits.find((i) => text.slice(Math.max(0, i - s.prefix.length), i) === s.prefix) : undefined;
  const start = exact ?? hits[0];
  return { start, end: start + s.original.length };
}

// Replaces the suggestions in `cats` with a new run's results. Suggestions from
// other runs stay, unless a new one overlaps them (the newest run wins).
function applyResults(result, cats = CHECK_CATS) {
  const text = state.idx.text;
  const fresh = [];
  for (const s of result.suggestions || []) {
    if (!cats.includes(s.category) || s.original === s.replacement || state.dismissed.has(keyOf(s))) continue;
    const pos = locate(text, s, fresh);
    if (!pos || text.slice(pos.start, pos.end).includes("\n")) continue;
    fresh.push({ ...s, ...pos, id: nextId++ });
  }
  const overlaps = (a) => fresh.some((b) => a.start < b.end && a.end > b.start);
  const kept = state.suggestions.filter((s) => !cats.includes(s.category) && !overlaps(s));
  state.suggestions = [...kept, ...fresh].sort((a, b) => a.start - b.start);
}

// Keep suggestion offsets in sync as the user types; drop ones touched by the edit.
function shiftForEdit(oldText, newText) {
  let p = 0;
  const max = Math.min(oldText.length, newText.length);
  while (p < max && oldText[p] === newText[p]) p++;
  let s = 0;
  while (s < max - p && oldText[oldText.length - 1 - s] === newText[newText.length - 1 - s]) s++;
  const oldEnd = oldText.length - s;
  const delta = newText.length - oldText.length;
  if (!delta && p === oldText.length) return; // formatting-only change

  const shift = (r) => {
    if (r.end < p) return true;
    if (r.start > oldEnd) { r.start += delta; r.end += delta; return true; }
    return false;
  };
  state.suggestions = state.suggestions.filter(shift);
  if (state.ai && !shift(state.ai)) hideBubble(true);
}

// ---------- Rendering ----------

function paintHighlights() {
  if (!window.CSS?.highlights || typeof Highlight === "undefined") return;
  const groups = Object.fromEntries([...CATEGORIES, "active", "pending"].map((c) => [c, []]));
  for (const s of state.suggestions) {
    if (state.filter !== "all" && s.category !== state.filter) continue;
    const r = rangeFor(s.start, s.end);
    if (!r) continue;
    groups[s.category].push(r);
    if (s.id === state.activeId) groups.active.push(rangeFor(s.start, s.end));
  }
  if (state.ai?.busy || state.ai?.result !== undefined || state.ai?.panel) {
    const r = rangeFor(state.ai.start, state.ai.end);
    if (r) groups.pending.push(r);
  }
  for (const [name, ranges] of Object.entries(groups)) CSS.highlights.set(`sg-${name}`, new Highlight(...ranges));
}

function cardHtml(s) {
  const change = s.replacement
    ? `<del>${esc(s.original)}</del> <ins>${esc(s.replacement)}</ins>`
    : `<del>${esc(s.original)}</del> <span class="fine">(remove)</span>`;
  return `
    <div class="card-head"><i class="dot ${s.category}"></i>${LABELS[s.category]} ·
      <span class="card-title">${esc(s.title)}</span></div>
    <div class="card-preview">${change}</div>
    <div class="card-body">
      <div class="change">${change}</div>
      <p class="explain">${esc(s.explanation)}</p>
      <div class="card-actions">
        <button class="primary" data-accept="${s.id}">Accept</button>
        <button data-dismiss="${s.id}">Dismiss</button>
      </div>
    </div>`;
}

function renderSidebar() {
  const counts = { all: state.suggestions.length };
  for (const c of CATEGORIES) counts[c] = state.suggestions.filter((s) => s.category === c).length;
  for (const k in counts) $(`count-${k}`).textContent = counts[k];
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.cat === state.filter));

  const list = state.suggestions.filter((s) => state.filter === "all" || s.category === state.filter);
  const checked = state.checkedText !== null && state.idx.text.trim();
  $("cards").innerHTML = list.length
    ? list.map((s) => `<div class="card ${s.category}${s.id === state.openId ? " open" : ""}" data-id="${s.id}">${cardHtml(s)}</div>`).join("")
    : `<div class="empty-state"><div class="big">${checked ? "🎉" : "✍️"}</div>${
        checked ? "No issues here. Nice work!" : "Suggestions appear here after a check."}</div>`;
  $("acceptAll").hidden = counts.correctness < 2;
}

function renderStats() {
  const text = state.idx.text;
  const words = (text.match(/\b[\w'’-]+\b/g) || []).length;
  const images = editor.querySelectorAll("figure").length;
  const minutes = Math.max(1, Math.round(words / 238 + images * 0.2));
  $("stats").innerHTML = `<span>${words} words</span><span>${words ? minutes : 0} min read</span>${images ? `<span>${images} image${images === 1 ? "" : "s"}</span>` : ""}`;
}

function setScore(score, tone, summary) {
  const ring = $("scoreRing");
  $("scoreNum").textContent = score ?? "–";
  ring.style.setProperty("--p", score ?? 0);
  ring.style.setProperty("--c", score >= 85 ? "var(--accent)" : score >= 60 ? "#f59e0b" : "var(--correctness)");
  $("tone").textContent = tone ? `Sounds: ${tone}` : "Check your writing to get feedback";
  $("summary").textContent = summary || "";
}

function setStatus(kind, msg) {
  const el = $("status");
  el.className = "status" + (kind === "error" ? " error" : "");
  el.innerHTML = kind === "busy" ? `<span class="spinner"></span>${esc(msg)}` : esc(msg || "");
}

function render() {
  paintHighlights();
  renderSidebar();
  renderStats();
}

// ---------- Editing ----------

function onEdit() {
  normalize();
  const old = state.idx.text;
  state.idx = buildIndex();
  shiftForEdit(old, state.idx.text);
  if (state.example) {
    state.example = false;
    state.suggestions = [];
    setScore(null);
    setStatus("", "");
  }
  hidePopover();
  render();
  placeInsertButton();
  scheduleSave();
  if (Platform.autoCheck) scheduleCheck();
  else if (state.checkedText !== null && state.idx.text !== state.checkedText) setStatus("", "Text changed. Click Check writing to refresh.");
}

editor.addEventListener("input", onEdit);

function currentBlock() {
  const sel = getSelection();
  if (!sel.rangeCount) return null;
  let n = sel.anchorNode;
  if (n?.nodeType === Node.TEXT_NODE) n = n.parentNode;
  while (n && n !== editor && n.parentNode !== editor) n = n.parentNode;
  return n && n !== editor ? n : null;
}

function caretAtEndOf(el) {
  const sel = getSelection();
  if (!sel.isCollapsed || !sel.rangeCount) return false;
  const r = document.createRange();
  r.selectNodeContents(el);
  r.setStart(sel.anchorNode, sel.anchorOffset);
  return !r.toString().length;
}

function placeCaret(el, atEnd = false) {
  const r = document.createRange();
  r.selectNodeContents(el);
  r.collapse(!atEnd);
  editor.focus({ preventScroll: true });
  selectRange(r);
}

const MD_SHORTCUTS = { "#": "h2", "##": "h3", ">": "blockquote", "-": "ul", "*": "ul", "1.": "ol" };

function applyBlock(kind) {
  if (kind === "ul") return document.execCommand("insertUnorderedList");
  if (kind === "ol") return document.execCommand("insertOrderedList");
  const block = currentBlock();
  const tag = block?.tagName.toLowerCase();
  if (tag === "h1") return;
  document.execCommand("formatBlock", false, tag === kind ? "p" : kind);
}

editor.addEventListener("keydown", (e) => {
  const block = currentBlock();
  if (!block) return;
  // Enter in the title moves to the story body.
  if (e.key === "Enter" && block.tagName === "H1") {
    e.preventDefault();
    let next = block.nextElementSibling;
    if (!next || next.tagName !== "P") {
      next = document.createElement("p");
      next.append(document.createElement("br"));
      block.after(next);
    }
    placeCaret(next);
    return onEdit();
  }
  // "---" then Enter inserts a divider.
  if (e.key === "Enter" && block.tagName === "P" && block.textContent === "---") {
    e.preventDefault();
    const r = document.createRange();
    r.selectNodeContents(block);
    selectRange(r);
    document.execCommand("insertHTML", false, "<hr><p><br></p>");
    return;
  }
  // Markdown-style shortcuts at the start of a paragraph: "# ", "## ", "> ", "- ", "1. ".
  if (e.key === " " && block.tagName === "P" && MD_SHORTCUTS[block.textContent] && caretAtEndOf(block)) {
    e.preventDefault();
    const kind = MD_SHORTCUTS[block.textContent];
    const r = document.createRange();
    r.selectNodeContents(block);
    selectRange(r);
    document.execCommand("delete");
    applyBlock(kind);
  }
});

// Paste: keep headings, lists, links, bold/italic and images; drop everything else.
editor.addEventListener("paste", (e) => {
  const cd = e.clipboardData;
  if (!cd) return;
  const files = [...cd.files].filter((f) => f.type.startsWith("image/"));
  if (files.length) {
    e.preventDefault();
    files.forEach((f) => insertImage(f));
    return;
  }
  if (currentBlock()?.tagName === "H1" || e.target.closest?.("figcaption")) {
    e.preventDefault();
    document.execCommand("insertText", false, cd.getData("text/plain").replace(/\s+/g, " "));
    return;
  }
  const html = cd.getData("text/html");
  const plain = cd.getData("text/plain");
  e.preventDefault();
  if (html) {
    document.execCommand("insertHTML", false, sanitize(html));
  } else if (/\n\s*\n/.test(plain)) {
    const paras = plain.split(/\n\s*\n/).map((p) => `<p>${esc(p.trim()).replace(/\n/g, "<br>")}</p>`).join("");
    document.execCommand("insertHTML", false, paras);
  } else {
    document.execCommand("insertText", false, plain);
  }
});

editor.addEventListener("dragover", (e) => {
  if ([...(e.dataTransfer?.items || [])].some((i) => i.kind === "file")) e.preventDefault();
});
editor.addEventListener("drop", (e) => {
  const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith("image/"));
  if (!files.length) return;
  e.preventDefault();
  const r = document.caretRangeFromPoint?.(e.clientX, e.clientY);
  if (r) { editor.focus({ preventScroll: true }); selectRange(r); }
  files.forEach((f) => insertImage(f));
});

// Figures: click to select, button to remove.
editor.addEventListener("click", (e) => {
  for (const f of editor.querySelectorAll("figure.selected")) f.classList.remove("selected");
  const fig = e.target.closest("figure");
  if (e.target.classList.contains("fig-remove")) {
    const r = document.createRange();
    r.selectNode(fig);
    editor.focus({ preventScroll: true });
    selectRange(r);
    document.execCommand("delete");
    return;
  }
  if (fig && e.target.tagName === "IMG") fig.classList.add("selected");
});

// ---------- Images ----------

async function shrinkImage(file) {
  if (file.type === "image/gif" || typeof createImageBitmap !== "function") return file;
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / bmp.width);
  if (scale === 1 && file.size < 700_000) return file;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const type = file.type === "image/png" && file.size < 1_500_000 ? "image/png" : "image/jpeg";
  return new Promise((res) => canvas.toBlob((b) => res(b || file), type, 0.85));
}

const readAsDataUrl = (blob) => new Promise((res, rej) => {
  const fr = new FileReader();
  fr.onload = () => res(fr.result);
  fr.onerror = () => rej(fr.error);
  fr.readAsDataURL(blob);
});

async function insertImage(file) {
  if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) return setStatus("error", "Use a PNG, JPEG, GIF or WebP image.");
  const sel = getSelection();
  const range = sel.rangeCount && editor.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
  setStatus("busy", "Adding image…");
  try {
    const blob = await shrinkImage(file);
    const src = state.store.putImage ? await state.store.putImage(blob) : await readAsDataUrl(blob);
    editor.focus({ preventScroll: true });
    if (range) selectRange(range);
    else placeCaret(editor.lastElementChild, true);
    const block = currentBlock();
    if (block?.tagName === "H1") placeCaret(block.nextElementSibling || block);
    const html = `<figure><img src="${esc(src)}" alt=""><figcaption></figcaption></figure><p><br></p>`;
    document.execCommand("insertHTML", false, html);
    setStatus("", "");
  } catch (err) {
    setStatus("error", `Couldn't add the image: ${err?.message || err?.code || "unknown error"}.`);
  }
}

$("imageInput").addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;
  if (state.insertTarget?.isConnected) placeCaret(state.insertTarget);
  insertImage(file);
});

// The (+) button on empty lines.
function placeInsertButton() {
  const wrap = $("insertWrap");
  const block = currentBlock();
  const show = document.activeElement === editor && block?.tagName === "P" && !block.textContent.trim() && block !== editor.firstElementChild;
  if (!show) { if (!wrap.contains(document.activeElement)) { wrap.hidden = true; $("insertMenu").hidden = true; } return; }
  state.insertTarget = block;
  wrap.hidden = false;
  const fs = parseFloat(getComputedStyle(block).lineHeight) || 32;
  wrap.style.top = block.offsetTop + (fs - 32) / 2 + "px";
}

$("insertBtn").addEventListener("mousedown", (e) => e.preventDefault());
$("insertBtn").addEventListener("click", () => {
  const menu = $("insertMenu");
  menu.hidden = !menu.hidden;
  $("insertBtn").setAttribute("aria-expanded", String(!menu.hidden));
});
$("insImage").addEventListener("click", () => { $("insertMenu").hidden = true; $("imageInput").click(); });
$("insDivider").addEventListener("click", () => {
  $("insertMenu").hidden = true;
  if (!state.insertTarget?.isConnected) return;
  placeCaret(state.insertTarget);
  document.execCommand("insertHTML", false, "<hr><p><br></p>");
});

// ---------- Selection bubble: formatting + AI ----------

function positionFloating(el, rect, above) {
  el.hidden = false;
  const vw = document.documentElement.clientWidth;
  const left = Math.max(8, Math.min(rect.left + rect.width / 2 - el.offsetWidth / 2, vw - el.offsetWidth - 8));
  let top = above ? rect.top - el.offsetHeight - 10 : rect.bottom + 10;
  if (above && top < 64) top = rect.bottom + 10;
  el.style.left = left + window.scrollX + "px";
  el.style.top = top + window.scrollY + "px";
}

function refreshBubbleState() {
  const block = currentBlock();
  const tag = block?.tagName.toLowerCase();
  for (const b of bubble.querySelectorAll("[data-cmd]")) {
    const c = b.dataset.cmd;
    const on = c === "bold" || c === "italic" ? document.queryCommandState(c) : c === tag || (c === "ul" && tag === "ul");
    b.classList.toggle("on", !!on);
  }
}

function showBubble() {
  const sel = getSelection();
  if (!sel.rangeCount || sel.isCollapsed || !editor.contains(sel.anchorNode)) return hideBubble();
  if (!sel.toString().trim()) return hideBubble();
  const offs = selectionOffsets();
  hidePopover();
  if (!state.ai?.busy) state.ai = offs ? { start: offs.start, end: offs.end } : null;
  $("aiPanel").hidden = true;
  $("linkForm").hidden = true;
  refreshBubbleState();
  positionFloating(bubble, sel.getRangeAt(0).getBoundingClientRect(), true);
}

function hideBubble(force = false) {
  if (bubble.hidden) return;
  if (!force && (state.ai?.busy || bubble.contains(document.activeElement))) return;
  bubble.hidden = true;
  state.ai = null;
  paintHighlights();
}

let selTimer = null;
document.addEventListener("selectionchange", () => {
  clearTimeout(selTimer);
  selTimer = setTimeout(() => {
    if (bubble.contains(document.activeElement)) return;
    const sel = getSelection();
    if (sel.rangeCount && editor.contains(sel.anchorNode)) {
      if (sel.isCollapsed) { hideBubble(); placeInsertButton(); maybeShowPopover(); }
      else showBubble();
    }
  }, 120);
});

bubble.addEventListener("mousedown", (e) => {
  if (e.target.closest(".bubble-row button")) e.preventDefault(); // keep the text selection
});

bubble.querySelector(".bubble-row").addEventListener("click", (e) => {
  const cmd = e.target.closest("[data-cmd]")?.dataset.cmd;
  if (!cmd) return;
  if (cmd === "bold" || cmd === "italic") document.execCommand(cmd);
  else if (cmd === "link") {
    const sel = getSelection();
    state.linkRange = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    $("aiPanel").hidden = true;
    $("linkForm").hidden = false;
    $("linkInput").value = sel.anchorNode?.parentElement?.closest("a")?.getAttribute("href") || "";
    $("linkInput").focus();
  } else if (cmd === "ai") {
    $("linkForm").hidden = true;
    $("aiPanel").hidden = !$("aiPanel").hidden;
    $("aiResult").hidden = state.ai?.result === undefined;
    if (state.ai) state.ai.panel = !$("aiPanel").hidden;
    paintHighlights();
  } else applyBlock(cmd);
  refreshBubbleState();
});

$("linkForm").addEventListener("submit", (e) => {
  e.preventDefault();
  let url = $("linkInput").value.trim();
  if (url && !/^(https?:|mailto:)/i.test(url)) url = "https://" + url;
  editor.focus({ preventScroll: true });
  if (state.linkRange) selectRange(state.linkRange);
  document.execCommand(url ? "createLink" : "unlink", false, url);
  hideBubble(true);
});

async function runAi(instruction) {
  const ai = state.ai;
  if (!ai) return;
  ai.instruction = instruction;
  ai.busy = true;
  ai.panel = true;
  paintHighlights();
  $("aiResult").hidden = false;
  $("aiResultText").innerHTML = `<div class="ai-loading"><span class="spinner"></span>Writing…</div>`;
  $("aiNote").textContent = "";
  try {
    const { rewrite, note } = await Platform.call("rewrite", {
      text: state.idx.text,
      selection: state.idx.text.slice(ai.start, ai.end),
      instruction,
      goals: state.goals,
    }, { cache: false });
    if (state.ai !== ai) return;
    ai.result = String(rewrite ?? "");
    $("aiResultText").textContent = ai.result;
    $("aiNote").textContent = note || "";
  } catch (err) {
    if (state.ai === ai) { ai.result = undefined; $("aiResultText").textContent = err.message; }
  } finally {
    ai.busy = false;
  }
}

$("aiPanel").querySelectorAll(".ai-quick button").forEach((b) => b.addEventListener("click", () => runAi(b.dataset.instr)));
$("aiForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = $("aiPrompt").value.trim();
  if (v) runAi(v);
});
$("aiRetry").addEventListener("click", () => state.ai?.instruction && runAi(state.ai.instruction));
$("aiDiscard").addEventListener("click", () => hideBubble(true));
$("aiReplace").addEventListener("click", () => {
  const ai = state.ai;
  if (!ai?.result) return;
  hideBubble(true);
  replaceText(ai.start, ai.end, ai.result);
});
$("aiInsert").addEventListener("click", () => {
  const ai = state.ai;
  if (!ai?.result) return;
  hideBubble(true);
  const end = rangeFor(ai.end, ai.end);
  if (!end) return;
  let block = end.endContainer;
  while (block && block.parentNode !== editor) block = block.parentNode;
  if (!block) return;
  placeCaret(block, true);
  document.execCommand("insertParagraph");
  document.execCommand("insertText", false, ai.result);
});

// ---------- Suggestion popover ----------

const byId = (id) => state.suggestions.find((s) => s.id === Number(id));

function maybeShowPopover() {
  const offs = selectionOffsets();
  if (!offs?.collapsed) return hidePopover();
  const s = state.suggestions.find((x) => (state.filter === "all" || x.category === state.filter) && offs.start >= x.start && offs.start <= x.end);
  if (!s) return hidePopover();
  if (!popover.hidden && state.activeId === s.id) return;
  const r = rangeFor(s.start, s.end);
  if (!r) return;
  state.activeId = s.id;
  paintHighlights();
  popover.innerHTML = cardHtml(s);
  const rects = r.getClientRects();
  positionFloating(popover, rects[rects.length - 1] || r.getBoundingClientRect(), false);
}

function hidePopover() {
  if (popover.hidden) return;
  popover.hidden = true;
  state.activeId = null;
  paintHighlights();
}

function accept(id) {
  const s = byId(id);
  if (!s) return;
  hidePopover();
  replaceText(s.start, s.end, s.replacement);
}

function dismiss(id) {
  const s = byId(id);
  if (!s) return;
  state.dismissed.add(keyOf(s));
  prefs.set("wa.dismissed", [...state.dismissed].slice(-300));
  state.suggestions = state.suggestions.filter((x) => x !== s);
  hidePopover();
  render();
}

function handleCardClick(e) {
  if (e.target.dataset.accept) return accept(e.target.dataset.accept);
  if (e.target.dataset.dismiss) return dismiss(e.target.dataset.dismiss);
  const card = e.target.closest(".card");
  if (!card) return;
  const id = Number(card.dataset.id);
  state.openId = state.openId === id ? null : id;
  renderSidebar();
  const s = byId(id);
  const r = s && rangeFor(s.start, s.end);
  if (r) {
    const rect = r.getBoundingClientRect();
    if (rect.top < 80 || rect.bottom > innerHeight - 40) window.scrollBy({ top: rect.top - innerHeight / 2, behavior: "smooth" });
  }
}
$("cards").addEventListener("click", handleCardClick);
popover.addEventListener("click", handleCardClick);
$("cards").addEventListener("mouseover", (e) => {
  const id = Number(e.target.closest(".card")?.dataset.id) || null;
  if (id !== state.activeId) { state.activeId = id; paintHighlights(); }
});
$("cards").addEventListener("mouseleave", () => { state.activeId = null; paintHighlights(); });

$("tabs").addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  state.filter = btn.dataset.cat;
  hidePopover();
  render();
});

$("acceptAll").addEventListener("click", () => {
  const fixes = state.suggestions.filter((s) => s.category === "correctness").sort((a, b) => b.start - a.start);
  for (const s of fixes) replaceText(s.start, s.end, s.replacement); // back-to-front keeps offsets valid
});

document.addEventListener("mousedown", (e) => {
  if (!popover.contains(e.target) && !editor.contains(e.target)) hidePopover();
  if (!bubble.contains(e.target) && !editor.contains(e.target)) hideBubble(true);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { hidePopover(); hideBubble(true); closeDrawer(); }
});
window.addEventListener("resize", () => { hidePopover(); hideBubble(true); placeInsertButton(); });

// ---------- Checking ----------

function scheduleCheck(delay = CHECK_DELAY_MS) {
  clearTimeout(state.checkTimer);
  state.checkTimer = setTimeout(() => runCheck({ auto: true }), delay);
}

function setCheckButton(running) {
  const btn = $("checkBtn");
  btn.textContent = running ? "Stop" : "Check writing";
  btn.classList.toggle("stop", running);
}

async function runCheck({ auto = false } = {}) {
  if (state.checkCtl) {
    state.checkCtl.abort();
    state.checkCtl = null;
    if (!auto) return setCheckButton(false), setStatus("", "Stopped.");
  }
  const text = state.idx.text;
  if (auto && text === state.checkedText) return;
  if (!text.trim()) {
    state.suggestions = state.suggestions.filter((s) => s.category === "style");
    setScore(null);
    setStatus("", auto ? "" : "Write something first.");
    return render();
  }
  if (text.length > MAX_CHARS) return setStatus("error", `This story is too long to check at once (over ${MAX_CHARS.toLocaleString()} characters).`);
  const ctl = (state.checkCtl = new AbortController());
  setCheckButton(true);
  setStatus("busy", "Claude is reading your story…");
  try {
    const result = await Platform.call("check", { text, goals: state.goals }, {
      signal: ctl.signal,
      onText: ({ text: reply }) => {
        const n = (reply.match(/"original"/g) || []).length;
        if (state.checkCtl === ctl) setStatus("busy", n ? `Found ${n} suggestion${n === 1 ? "" : "s"} so far…` : "Claude is reading your story…");
      },
    });
    if (state.checkCtl !== ctl) return;
    if (!result || !Array.isArray(result.suggestions)) throw new Error("Claude's reply couldn't be read. Try again.");
    applyResults(result);
    state.example = false;
    state.checkedText = text;
    setScore(Number(result.overall_score) || null, result.tone, result.summary);
    const changed = state.idx.text !== text;
    setStatus("", changed ? (Platform.autoCheck ? "" : "You edited while Claude was reading. Check again to refresh.") : "All caught up");
    if (changed && Platform.autoCheck) scheduleCheck();
    render();
  } catch (err) {
    if (state.checkCtl !== ctl) return;
    setStatus(err.code === "cancelled" ? "" : "error", err.code === "cancelled" ? "Stopped." : err.message);
  } finally {
    if (state.checkCtl === ctl) { state.checkCtl = null; setCheckButton(false); }
  }
}

$("checkBtn").addEventListener("click", () => runCheck());

// ---------- "Sounds like AI?" ----------

async function runStyle() {
  const text = state.idx.text;
  if (!text.trim()) return setStatus("", "Write something first.");
  if (text.length > MAX_CHARS) return setStatus("error", "This story is too long to analyze at once.");
  const btn = $("styleBtn");
  btn.disabled = true;
  setStatus("busy", "Looking for phrasing that reads as AI-written…");
  try {
    const result = await Platform.call("style", { text, goals: state.goals });
    const level = LEVELS[result?.ai_likeness] ? result.ai_likeness : "medium";
    if (state.example) { state.example = false; state.suggestions = []; setScore(null); }
    applyResults({ suggestions: (result?.suggestions || []).map((s) => ({ ...s, category: "style" })) }, ["style"]);
    $("aiLevel").textContent = LEVELS[level];
    $("aiLevel").className = `level ${level}`;
    $("aiSignals").innerHTML = (result?.signals || []).map((x) => `<li>${esc(String(x))}</li>`).join("");
    $("aiMeter").hidden = false;
    state.filter = "style";
    const n = state.suggestions.filter((s) => s.category === "style").length;
    setStatus("", n ? `${n} passage${n === 1 ? "" : "s"} could sound more like you.` : "Nothing stands out as AI-like.");
    render();
  } catch (err) {
    setStatus("error", err.message);
  } finally {
    btn.disabled = false;
  }
}
$("styleBtn").addEventListener("click", runStyle);

// Closing the panel also clears the AI-like underlines; the writer decides what to use.
$("aiMeterClose").addEventListener("click", () => {
  $("aiMeter").hidden = true;
  state.suggestions = state.suggestions.filter((s) => s.category !== "style");
  if (state.filter === "style") state.filter = "all";
  hidePopover();
  setStatus("", "");
  render();
});

// ---------- Stories: saving, listing, switching ----------

// Local store (IndexedDB), used when the platform has no store of its own.
function localStore() {
  let dbp = null;
  const open = () => (dbp ??= new Promise((res, rej) => {
    const req = indexedDB.open("writing-assistant", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("docs", { keyPath: "id" });
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  }));
  const tx = async (mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction("docs", mode);
      const req = fn(t.objectStore("docs"));
      t.oncomplete = () => res(req?.result);
      t.onerror = () => rej(t.error);
    });
  };
  return {
    note: "Stories are saved in this browser. Clearing site data removes them.",
    async list() {
      const all = (await tx("readonly", (s) => s.getAll())) || [];
      return all.map(({ id, title, updatedAt }) => ({ id, title, updatedAt }));
    },
    get: (id) => tx("readonly", (s) => s.get(id)),
    save: (doc) => tx("readwrite", (s) => s.put(doc)),
    remove: (id) => tx("readwrite", (s) => s.delete(id)),
  };
}

function memoryStore() {
  const docs = new Map();
  return {
    note: "This browser blocks storage, so stories are kept only until you close the page.",
    list: async () => [...docs.values()].map(({ id, title, updatedAt }) => ({ id, title, updatedAt })),
    get: async (id) => docs.get(id),
    save: async (doc) => { docs.set(doc.id, { ...doc }); },
    remove: async (id) => { docs.delete(id); },
  };
}

async function openStore() {
  const platformStore = await Platform.openStore?.().catch(() => null);
  if (platformStore) return platformStore;
  try {
    const s = localStore();
    await s.list();
    return s;
  } catch {
    return memoryStore();
  }
}

function setSaveState(msg) { $("saveState").textContent = msg; }

function scheduleSave() {
  if (!state.doc) return;
  setSaveState("Draft");
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveNow, SAVE_DELAY_MS);
}

function saveNow() {
  clearTimeout(state.saveTimer);
  const doc = state.doc;
  if (!doc) return state.saving;
  const html = serialize();
  const title = storyTitle();
  if (html === doc.html && title === doc.title) return state.saving;
  const next = { ...doc, html, title, updatedAt: Date.now(), sample: false };
  if (state.store.maxBytes && new Blob([html]).size > state.store.maxBytes) {
    setSaveState("Not saved: this story is too large");
    setStatus("error", "This story is too large to save. Remove an image or split it into two stories.");
    return state.saving;
  }
  state.doc = next;
  setSaveState("Saving…");
  state.saving = state.saving
    .then(() => state.store.save(next))
    .then(() => { if (state.doc === next) setSaveState("Saved"); })
    .catch((err) => setSaveState(`Not saved: ${err?.message || err?.code || "storage error"}`));
  return state.saving;
}

window.addEventListener("pagehide", () => { saveNow(); });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") saveNow(); });

function loadDoc(doc) {
  state.doc = doc;
  prefs.set("wa.current", doc.id);
  editor.innerHTML = sanitize(doc.html || "");
  normalize();
  state.idx = buildIndex();
  state.suggestions = [];
  state.checkedText = null;
  state.filter = "all";
  $("aiMeter").hidden = true;
  setScore(null);
  setStatus("", "");
  hidePopover();
  hideBubble(true);
  if (doc.sample) {
    applyResults({ suggestions: SAMPLE_SUGGESTIONS });
    state.example = true;
    setScore(68, "Casual, unpolished", "Example feedback on a sample story. Start writing your own and click Check writing.");
    $("summary").insertAdjacentHTML("afterbegin", '<span class="example-tag">Example</span> ');
  }
  setSaveState(doc.updatedAt ? "Saved" : "");
  render();
  window.scrollTo({ top: 0 });
  if (!doc.sample && Platform.autoCheck && state.idx.text.trim()) scheduleCheck(500);
}

async function newStory() {
  await saveNow();
  const doc = { id: newId(), title: "", html: "<h1></h1><p></p>", updatedAt: 0 };
  loadDoc(doc);
  closeDrawer();
  placeCaret(editor.querySelector("h1"));
}

const fmtDate = (t) => {
  if (!t) return "Not saved yet";
  const d = new Date(t);
  const today = new Date();
  return d.toDateString() === today.toDateString()
    ? `Today, ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
    : d.toLocaleDateString([], { month: "short", day: "numeric", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
};

async function renderStories() {
  const list = $("storyList");
  let stories = [];
  try { stories = await state.store.list(); } catch (err) { list.innerHTML = `<li class="fine">Couldn't load your stories.</li>`; return; }
  if (state.doc && !stories.some((s) => s.id === state.doc.id)) stories.push({ id: state.doc.id, title: storyTitle(), updatedAt: state.doc.updatedAt });
  stories.sort((a, b) => (b.updatedAt || Infinity) - (a.updatedAt || Infinity));
  list.innerHTML = stories.map((s) => `
    <li class="story${s.id === state.doc?.id ? " current" : ""}">
      <button class="story-open" data-open="${esc(s.id)}">
        <span class="story-title">${esc((s.id === state.doc?.id ? storyTitle() : s.title) || "Untitled story")}</span>
        <span class="story-date">${fmtDate(s.updatedAt)}</span>
      </button>
      <button class="story-del" data-del="${esc(s.id)}" aria-label="Delete story">Delete</button>
    </li>`).join("");
  $("storageNote").textContent = state.store.note || "";
}

function openDrawer() {
  saveNow();
  $("drawer").hidden = false;
  $("scrim").hidden = false;
  renderStories();
}
function closeDrawer() {
  $("drawer").hidden = true;
  $("scrim").hidden = true;
}

$("storiesBtn").addEventListener("click", openDrawer);
$("drawerClose").addEventListener("click", closeDrawer);
$("scrim").addEventListener("click", closeDrawer);
$("newStory").addEventListener("click", newStory);
$("storyList").addEventListener("click", async (e) => {
  const open = e.target.closest("[data-open]")?.dataset.open;
  const del = e.target.closest("[data-del]");
  if (open) {
    if (open === state.doc?.id) return closeDrawer();
    await saveNow();
    const doc = await state.store.get(open).catch(() => null);
    if (doc) { loadDoc(doc); closeDrawer(); }
    else setStatus("error", "Couldn't open that story.");
  } else if (del) {
    if (!del.classList.contains("confirm")) {
      del.classList.add("confirm");
      del.textContent = "Delete?";
      setTimeout(() => { if (del.isConnected) { del.classList.remove("confirm"); del.textContent = "Delete"; } }, 3000);
      return;
    }
    const id = del.dataset.del;
    try { await state.store.remove(id); } catch { return setStatus("error", "Couldn't delete that story."); }
    if (id === state.doc?.id) {
      state.doc = null;
      const rest = (await state.store.list()).sort((a, b) => b.updatedAt - a.updatedAt);
      const next = rest[0] && (await state.store.get(rest[0].id));
      if (next) loadDoc(next);
      else { await newStory(); $("drawer").hidden = false; $("scrim").hidden = false; }
    }
    renderStories();
  }
});

// ---------- Goals ----------

const dialog = $("goalsDialog");
$("goalsBtn").addEventListener("click", () => {
  for (const [name, value] of Object.entries(state.goals)) {
    const input = dialog.querySelector(`input[name="${name}"][value="${value}"]`);
    if (input) input.checked = true;
  }
  dialog.showModal();
});
dialog.addEventListener("close", () => {
  const next = {};
  for (const name of ["audience", "formality", "domain", "intent"]) {
    next[name] = dialog.querySelector(`input[name="${name}"]:checked`)?.value ?? state.goals[name];
  }
  if (JSON.stringify(next) === JSON.stringify(state.goals)) return;
  state.goals = next;
  prefs.set("wa.goals", next);
  if (state.example || !state.idx.text.trim()) return;
  if (Platform.autoCheck) runCheck();
  else setStatus("", "Goals updated. Click Check writing to apply them.");
});

// ---------- Start ----------

async function start() {
  try { document.execCommand("defaultParagraphSeparator", false, "p"); } catch { /* older engines */ }
  state.store = await openStore();
  let stories = [];
  try { stories = await state.store.list(); } catch { /* empty */ }
  let doc = null;
  const current = prefs.get("wa.current", null);
  const pick = stories.find((s) => s.id === current) || stories.sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (pick) doc = await state.store.get(pick.id).catch(() => null);
  if (!doc) {
    // First run: bring over text from the earlier plain-text editor, or start with the sample story.
    const legacy = prefs.get("wa.text", null);
    const legacyTitle = prefs.get("wa.title", "");
    const isOldSample = legacy && legacy.startsWith("Teh water cycle is a very good example");
    doc = legacy && legacy.trim() && !isOldSample
      ? { id: newId(), title: legacyTitle, updatedAt: 0, html: `<h1>${esc(legacyTitle)}</h1>` + legacy.split(/\n\s*\n/).map((p) => `<p>${esc(p.trim())}</p>`).join("") }
      : { id: newId(), title: "How the Water Cycle Works", updatedAt: 0, html: SAMPLE_HTML, sample: true };
  }
  loadDoc(doc);
}

start();
