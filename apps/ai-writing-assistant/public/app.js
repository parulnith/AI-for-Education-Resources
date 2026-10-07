// AI Writing Assistant – front end.
// The editor is a <textarea> layered over a "backdrop" div that mirrors the
// text and draws coloured underlines (Grammarly-style) under suggestions.

const $ = (id) => document.getElementById(id);
const ta = $("text");
const backdrop = $("backdrop");
const mirror = $("mirror");
const popover = $("popover");
const aiBar = $("aiBar");

const CATEGORIES = ["correctness", "clarity", "engagement", "delivery"];
const CHECK_DELAY_MS = 1800;
const SAMPLE = `Teh water cycle is a very good example of how nature recycle it's resources. When the sun heats up oceans and lakes, water evaporates and rises in to the air as vapor.

In order to form clouds, the vapor cools down and condenses into tiny droplets. Eventually, the droplets gets heavy and they fall back to earth as rain, snow, or hail. This process happens over and over again and it never really stops and it is important for all living things.`;

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
  },
};

const state = {
  suggestions: [],          // {id, category, title, original, replacement, explanation, start, end}
  dismissed: new Set(store.get("wa.dismissed", [])),
  filter: "all",
  activeId: null,
  openId: null,
  lastText: "",
  lastChecked: null,
  seq: 0,
  timer: null,
  goals: store.get("wa.goals", { audience: "general", formality: "neutral", domain: "general", intent: "inform" }),
  ai: null,                 // {start, end, instruction, result}
  mode: null,               // "server" (server.js proxies Claude) or "browser" (viewer's own API key)
  assistant: null,          // browser mode: {check, rewrite} from claude-bundle.js
  ready: null,              // resolves once the mode is known
};
let bundle = null;          // browser mode: the lazily imported claude-bundle.js
let nextId = 1;

// ---------- Utilities ----------

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const keyOf = (s) => `${s.original}\u0000${s.replacement}`;

async function api(path, body) {
  await state.ready;
  if (state.mode === "browser") return callBrowser(path, body);
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

async function callBrowser(path, body) {
  if (!state.assistant) {
    openKeyDialog();
    throw new Error("Add your Anthropic API key to start.");
  }
  if (body.text.length > bundle.MAX_CHARS) throw new Error(`Text must be under ${bundle.MAX_CHARS} characters.`);
  try {
    return await state.assistant[path.endsWith("check") ? "check" : "rewrite"](body);
  } catch (err) {
    const { auth, message } = bundle.describeError(err);
    if (auth) openKeyDialog(message);
    throw new Error(message);
  }
}

// Replace a range through execCommand so the browser's native undo (Ctrl+Z) still works.
function replaceRange(start, end, text) {
  ta.focus();
  ta.setSelectionRange(start, end);
  const ok = text
    ? document.execCommand("insertText", false, text)
    : document.execCommand("delete");
  if (!ok) {
    ta.setRangeText(text, start, end, "end");
    ta.dispatchEvent(new Event("input"));
  }
}

// ---------- Locating suggestions in the text ----------

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

function applyResults(text, result) {
  const taken = [];
  const out = [];
  for (const s of result.suggestions || []) {
    if (!CATEGORIES.includes(s.category) || s.original === s.replacement || state.dismissed.has(keyOf(s))) continue;
    const pos = locate(text, s, taken);
    if (!pos) continue;
    taken.push(pos);
    out.push({ ...s, ...pos, id: nextId++ });
  }
  state.suggestions = out.sort((a, b) => a.start - b.start);
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

  const shift = (r) => {
    if (r.end < p) return true;
    if (r.start > oldEnd) { r.start += delta; r.end += delta; return true; }
    return false; // overlaps or touches the edit
  };
  state.suggestions = state.suggestions.filter(shift);
  if (state.ai && !shift(state.ai)) hideAiBar();
}

// ---------- Rendering ----------

function renderBackdrop() {
  const text = ta.value;
  const ranges = [];
  if (state.ai) ranges.push({ start: state.ai.start, end: state.ai.end, cls: "pending" });
  for (const s of state.suggestions) {
    if (state.filter !== "all" && s.category !== state.filter) continue;
    if (state.ai && s.start < state.ai.end && s.end > state.ai.start) continue;
    ranges.push({ start: s.start, end: s.end, cls: s.category + (s.id === state.activeId ? " active" : ""), id: s.id });
  }
  ranges.sort((a, b) => a.start - b.start);

  let html = "";
  let pos = 0;
  for (const r of ranges) {
    html += esc(text.slice(pos, r.start));
    html += `<mark class="${r.cls}"${r.id ? ` data-id="${r.id}"` : ""}>${esc(text.slice(r.start, r.end))}</mark>`;
    pos = r.end;
  }
  html += esc(text.slice(pos));
  backdrop.innerHTML = html + (text.endsWith("\n") ? " " : "");
}

function autosize() {
  ta.style.height = "auto";
  ta.style.height = ta.scrollHeight + "px";
}

function cardHtml(s) {
  const change = s.replacement
    ? `<del>${esc(s.original)}</del> <ins>${esc(s.replacement)}</ins>`
    : `<del>${esc(s.original)}</del> <span class="muted">(remove)</span>`;
  return `
    <div class="card-head"><i class="dot ${s.category}"></i>${s.category[0].toUpperCase() + s.category.slice(1)}
      · <span class="card-title">${esc(s.title)}</span></div>
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
  const cards = $("cards");
  if (!list.length) {
    const checked = state.lastChecked !== null && ta.value.trim();
    cards.innerHTML = `<div class="empty"><div class="big">${checked ? "🎉" : "✍️"}</div>${
      checked ? "No issues here. Nice work!" : "Suggestions will appear here as you write."}</div>`;
  } else {
    cards.innerHTML = list
      .map((s) => `<div class="card ${s.category}${s.id === state.openId ? " open" : ""}" data-id="${s.id}">${cardHtml(s)}</div>`)
      .join("");
  }
  $("acceptAll").hidden = counts.correctness < 2;
}

function renderStats() {
  const text = ta.value;
  const words = (text.match(/\b[\w'’-]+\b/g) || []).length;
  const sentences = (text.match(/[^.!?]+[.!?]+/g) || []).length;
  const minutes = Math.max(1, Math.round(words / 238));
  $("stats").innerHTML = `<span>${words} words</span><span>${text.length} characters</span><span>${sentences} sentences</span><span>${words ? minutes : 0} min read</span>`;
}

function setScore(score, tone, summary) {
  const ring = $("scoreRing");
  $("scoreNum").textContent = score ?? "–";
  ring.style.setProperty("--p", score ?? 0);
  ring.style.setProperty("--c", score >= 85 ? "var(--accent)" : score >= 60 ? "#f59e0b" : "var(--correctness)");
  $("tone").textContent = tone ? `Sounds: ${tone}` : "Start typing to get feedback";
  $("summary").textContent = summary || "";
}

function setStatus(kind, msg) {
  const el = $("status");
  el.className = "status" + (kind === "error" ? " error" : "");
  el.innerHTML = kind === "busy" ? `<span class="spinner"></span>${esc(msg)}` : esc(msg || "");
}

function render() {
  renderBackdrop();
  renderSidebar();
  renderStats();
}

// ---------- Checking ----------

function scheduleCheck(delay = CHECK_DELAY_MS) {
  clearTimeout(state.timer);
  state.timer = setTimeout(runCheck, delay);
}

async function runCheck(force = false) {
  const text = ta.value;
  if (!force && text === state.lastChecked) return;
  if (!text.trim()) {
    state.suggestions = [];
    state.lastChecked = text;
    setScore(null);
    setStatus("", "");
    return render();
  }
  const mySeq = ++state.seq;
  setStatus("busy", "Checking your writing…");
  try {
    const result = await api("api/check", { text, goals: state.goals });
    if (mySeq !== state.seq) return; // a newer check is in flight
    applyResults(ta.value, result); // locate against the *current* text
    state.lastChecked = text;
    setScore(result.overall_score, result.tone, result.summary);
    setStatus("", ta.value === text ? "All caught up" : "");
    if (ta.value !== text) scheduleCheck();
    render();
  } catch (err) {
    if (mySeq === state.seq) setStatus("error", err.message);
  }
}

// ---------- Suggestions: accept / dismiss / popover ----------

const byId = (id) => state.suggestions.find((s) => s.id === Number(id));

function accept(id) {
  const s = byId(id);
  if (!s) return;
  hidePopover();
  replaceRange(s.start, s.end, s.replacement);
}

function dismiss(id) {
  const s = byId(id);
  if (!s) return;
  state.dismissed.add(keyOf(s));
  store.set("wa.dismissed", [...state.dismissed].slice(-300));
  state.suggestions = state.suggestions.filter((x) => x !== s);
  hidePopover();
  render();
}

function showPopover(s) {
  const mark = backdrop.querySelector(`mark[data-id="${s.id}"]`);
  if (!mark) return;
  state.activeId = s.id;
  renderBackdrop();
  const rect = backdrop.querySelector(`mark[data-id="${s.id}"]`).getBoundingClientRect();
  popover.innerHTML = cardHtml(s);
  popover.hidden = false;
  const left = Math.min(rect.left + window.scrollX, window.scrollX + document.documentElement.clientWidth - popover.offsetWidth - 12);
  popover.style.left = Math.max(8, left) + "px";
  popover.style.top = rect.bottom + window.scrollY + 8 + "px";
}

function hidePopover() {
  if (popover.hidden) return;
  popover.hidden = true;
  state.activeId = null;
  renderBackdrop();
}

function suggestionAtCaret() {
  if (ta.selectionStart !== ta.selectionEnd) return null;
  const pos = ta.selectionStart;
  return state.suggestions.find(
    (s) => (state.filter === "all" || s.category === state.filter) && pos >= s.start && pos <= s.end,
  );
}

// ---------- AI rewrite toolbar ----------

function selectionRect(start, end) {
  const t = ta.value;
  mirror.innerHTML = esc(t.slice(0, start)) + `<span id="selMark">${esc(t.slice(start, end))}</span>` + esc(t.slice(end));
  const rects = $("selMark").getClientRects();
  return rects[rects.length - 1] || $("selMark").getBoundingClientRect();
}

function maybeShowAiBar() {
  const { selectionStart: start, selectionEnd: end } = ta;
  if (end - start < 2 || !ta.value.slice(start, end).trim()) {
    if (state.ai && !state.ai.busy) hideAiBar();
    return;
  }
  hidePopover();
  state.ai = { start, end };
  $("aiResult").hidden = true;
  $("aiPrompt").value = "";
  aiBar.hidden = false;
  const rect = selectionRect(start, end);
  const maxLeft = window.scrollX + document.documentElement.clientWidth - aiBar.offsetWidth - 12;
  aiBar.style.left = Math.max(8, Math.min(rect.left + window.scrollX, maxLeft)) + "px";
  aiBar.style.top = rect.bottom + window.scrollY + 10 + "px";
}

function hideAiBar() {
  if (!state.ai) return;
  state.ai = null;
  aiBar.hidden = true;
  renderBackdrop();
}

async function runAi(instruction) {
  const ai = state.ai;
  if (!ai) return;
  ai.instruction = instruction;
  ai.busy = true;
  renderBackdrop(); // show the selection as a pending highlight
  const box = $("aiResult");
  box.hidden = false;
  $("aiResultText").innerHTML = `<div class="ai-loading"><span class="spinner"></span>Writing…</div>`;
  $("aiNote").textContent = "";
  try {
    const { rewrite, note } = await api("api/rewrite", {
      text: ta.value,
      selection: ta.value.slice(ai.start, ai.end),
      instruction,
      goals: state.goals,
    });
    if (state.ai !== ai) return;
    ai.result = rewrite;
    $("aiResultText").textContent = rewrite;
    $("aiNote").textContent = note;
  } catch (err) {
    if (state.ai === ai) $("aiResultText").textContent = "⚠️ " + err.message;
  } finally {
    ai.busy = false;
  }
}

// ---------- Event wiring ----------

ta.addEventListener("input", () => {
  shiftForEdit(state.lastText, ta.value);
  state.lastText = ta.value;
  state.lastChecked = null; // any edit (including undo) needs a fresh check
  hidePopover();
  autosize();
  render();
  store.set("wa.text", ta.value);
  setStatus("", "");
  scheduleCheck();
});

ta.addEventListener("mouseup", () => setTimeout(() => {
  maybeShowAiBar();
  const s = suggestionAtCaret();
  s ? showPopover(s) : hidePopover();
}));

ta.addEventListener("keyup", (e) => {
  if (e.key.startsWith("Arrow") || e.key === "Home" || e.key === "End" || (e.shiftKey && e.key !== "Shift")) {
    maybeShowAiBar();
    const s = suggestionAtCaret();
    s ? showPopover(s) : hidePopover();
  }
});

document.addEventListener("mousedown", (e) => {
  if (!popover.contains(e.target) && e.target !== ta) hidePopover();
  if (!aiBar.contains(e.target) && e.target !== ta) hideAiBar();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { hidePopover(); hideAiBar(); }
});

window.addEventListener("resize", () => { autosize(); hidePopover(); hideAiBar(); });

// Card list: open, hover-highlight, accept, dismiss.
function handleCardClick(e) {
  if (e.target.dataset.accept) return accept(e.target.dataset.accept);
  if (e.target.dataset.dismiss) return dismiss(e.target.dataset.dismiss);
  const card = e.target.closest(".card");
  if (!card) return;
  const id = Number(card.dataset.id);
  state.openId = state.openId === id ? null : id;
  renderSidebar();
  backdrop.querySelector(`mark[data-id="${id}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
}
$("cards").addEventListener("click", handleCardClick);
popover.addEventListener("click", handleCardClick);

$("cards").addEventListener("mouseover", (e) => {
  const id = Number(e.target.closest(".card")?.dataset.id) || null;
  if (id !== state.activeId) { state.activeId = id; renderBackdrop(); }
});
$("cards").addEventListener("mouseleave", () => { state.activeId = null; renderBackdrop(); });

$("tabs").addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  state.filter = btn.dataset.cat;
  hidePopover();
  render();
});

$("acceptAll").addEventListener("click", () => {
  const fixes = state.suggestions.filter((s) => s.category === "correctness").sort((a, b) => b.start - a.start);
  for (const s of fixes) replaceRange(s.start, s.end, s.replacement); // back-to-front keeps offsets valid
});

$("checkBtn").addEventListener("click", () => runCheck(true));

// AI toolbar
aiBar.querySelectorAll(".ai-quick button").forEach((b) => b.addEventListener("click", () => runAi(b.dataset.instr)));
$("aiForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = $("aiPrompt").value.trim();
  if (v) runAi(v);
});
$("aiRetry").addEventListener("click", () => state.ai?.instruction && runAi(state.ai.instruction));
$("aiDiscard").addEventListener("click", hideAiBar);
$("aiReplace").addEventListener("click", () => {
  const ai = state.ai;
  if (!ai?.result) return;
  hideAiBar();
  replaceRange(ai.start, ai.end, ai.result);
});
$("aiInsert").addEventListener("click", () => {
  const ai = state.ai;
  if (!ai?.result) return;
  hideAiBar();
  replaceRange(ai.end, ai.end, "\n\n" + ai.result);
});

// Title
$("title").value = store.get("wa.title", "");
$("title").addEventListener("input", (e) => store.set("wa.title", e.target.value));

// Goals dialog
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
  if (JSON.stringify(next) !== JSON.stringify(state.goals)) {
    state.goals = next;
    store.set("wa.goals", next);
    runCheck(true);
  }
});

// ---------- Backend: local server, or the viewer's own API key ----------

const keyDialog = $("keyDialog");

function savedKey() {
  try { return localStorage.getItem("wa.apiKey") || sessionStorage.getItem("wa.apiKey"); } catch { return null; }
}

function saveKey(key, remember) {
  try {
    localStorage.removeItem("wa.apiKey");
    sessionStorage.removeItem("wa.apiKey");
    if (key) (remember ? localStorage : sessionStorage).setItem("wa.apiKey", key);
  } catch { /* storage unavailable: the key lives only in memory */ }
}

function openKeyDialog(error = "") {
  $("keyError").textContent = error;
  $("keyInput").value = savedKey() || "";
  $("keyForget").hidden = !savedKey();
  if (!keyDialog.open) keyDialog.showModal();
  $("keyInput").focus();
}

async function connectWithKey(key) {
  state.assistant = await bundle.connect(key);
  setStatus("", "Connected to Claude");
}

async function detectMode() {
  try {
    const res = await fetch("api/health");
    if (res.ok && (await res.json()).ok) { state.mode = "server"; return; }
  } catch { /* no server: static hosting */ }

  state.mode = "browser";
  $("keyBtn").hidden = false;
  bundle = await import("./claude-bundle.js");
  const key = savedKey();
  if (!key) return openKeyDialog();
  try {
    await connectWithKey(key);
  } catch (err) {
    openKeyDialog(bundle.describeError(err).message);
  }
}

$("keyBtn").addEventListener("click", () => openKeyDialog());

$("keyForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const key = $("keyInput").value.trim();
  const btn = $("keySubmit");
  btn.disabled = true;
  btn.textContent = "Connecting…";
  $("keyError").textContent = "";
  try {
    await connectWithKey(key);
    saveKey(key, $("keyRemember").checked);
    keyDialog.close();
    runCheck(true);
  } catch (err) {
    $("keyError").textContent = bundle.describeError(err).message;
  } finally {
    btn.disabled = false;
    btn.textContent = "Start writing";
  }
});

$("keyForget").addEventListener("click", () => {
  saveKey(null);
  state.assistant = null;
  $("keyInput").value = "";
  $("keyForget").hidden = true;
  setStatus("", "API key removed from this browser");
});

// ---------- Init ----------

ta.value = store.get("wa.text", SAMPLE);
state.lastText = ta.value;
autosize();
render();
if (document.fonts) document.fonts.ready.then(autosize);
state.ready = detectMode();
state.ready.then(() => scheduleCheck(300));
