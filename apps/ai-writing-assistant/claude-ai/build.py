# Builds the claude.ai Artifact version of the writing assistant from public/.
# It runs Claude on the viewer's own claude.ai plan (the `sample` capability)
# instead of an API key. Usage: python3 claude-ai/build.py public <out.html>
import re, sys
src = sys.argv[1]; out = sys.argv[2]
html = open(f"{src}/index.html").read()
css = open(f"{src}/styles.css").read()
js = open(f"{src}/app.js").read()

def rep(s, old, new, count=1):
    assert old in s, f"missing: {old[:60]!r}"
    return s.replace(old, new, count)

# ---------- CSS: three-state theme tokens ----------
m = re.search(r"@media \(prefers-color-scheme: dark\) \{\n  :root \{\n(.*?)\n  \}\n\}\n", css, re.S)
dark = m.group(1)
css = css.replace(m.group(0),
  "@media (prefers-color-scheme: dark) {\n  :root:not([data-theme=\"light\"]) {\n" + dark + "\n    color-scheme: dark;\n  }\n}\n"
  ":root[data-theme=\"dark\"] {\n" + dark + "\n  color-scheme: dark;\n}\n")
css = rep(css, "* { box-sizing: border-box; }", "* { box-sizing: border-box; }\nhtml, body { min-height: 100%; }")
css += """
/* ---------- Artifact additions ---------- */
.check-btn { background: var(--accent); color: #fff; border: none; border-radius: 999px; padding: 7px 16px; font-weight: 600; }
.check-btn:hover { filter: brightness(0.95); }
.check-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.check-btn.stop { background: var(--surface); color: var(--text); border: 1px solid var(--border); }
.example-tag { display: inline-block; font-size: 11px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted); border: 1px dashed var(--border); border-radius: 999px; padding: 1px 8px; }
button:focus-visible, .doc-title:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) { .spinner { animation-duration: 2s; } * { transition: none !important; } }
"""

# ---------- HTML ----------
body = html[html.index("<body>") + 6: html.index("</body>")]
body = rep(body, '      <button id="keyBtn" class="ghost" hidden>🔑 API key</button>\n', "")
body = rep(body, '<button id="checkBtn" class="ghost">↻ Check now</button>', '<button id="checkBtn" class="check-btn">Check writing</button>')
body = re.sub(r"\n  <!-- API key dialog.*?</dialog>\n", "\n", body, flags=re.S)
body = rep(body, '  <script src="app.js"></script>\n', "")
assert "keyDialog" not in body

# ---------- JS ----------
# Backend: Claude via the viewer's claude.ai account (sample capability).
start = js.index("async function api(path, body) {")
end = js.index("// Replace a range through execCommand")
js = js[:start] + r'''// Claude runs on the viewer's own claude.ai account through the `sample` capability.
const samplePromise = window.claude?.use ? window.claude.use("sample") : Promise.resolve(null);

const CHECK_RULES = `You are a writing assistant embedded in an editor, similar to Grammarly. The writer is often a student or teacher. Review the text and return precise, local edits.

Categories:
- correctness: spelling, grammar, punctuation, agreement, wrong word.
- clarity: wordiness, unclear or run-on sentences, passive voice that hurts readability.
- engagement: bland or repeated words, weak verbs, monotonous sentence starts.
- delivery: tone, formality, and confidence that do not fit the writer's goals.

Rules:
- "original" MUST be copied character-for-character from the text and be as short as possible (a word or phrase; a full sentence only for sentence-level rewrites). Never span paragraphs.
- "prefix" is up to 30 characters that appear immediately before "original" in the text, verbatim ("" at the very start). It tells repeated phrases apart.
- "replacement" is the text that should replace "original" ("" to delete it).
- "explanation" is one short sentence a student could understand.
- Do not overlap suggestions. Do not suggest changes that only restate the text.
- Respect the writer's voice; suggest only what genuinely helps for their goals.
- Order suggestions by where they appear in the text.

Reply with only one JSON object, no other text:
{"overall_score": <integer 0-100 for overall quality given the goals>, "tone": "<2-4 words on how the text sounds>", "summary": "<one encouraging sentence on the biggest improvement opportunity>", "suggestions": [{"category": "correctness", "title": "<2-5 word label>", "original": "...", "prefix": "...", "replacement": "...", "explanation": "..."}]}`;

const STYLE_RULES = `You help writers make their text sound like a real person wrote it. Review the text for patterns that make writing read as AI-generated:
- stock phrases and filler ("delve into", "in today's fast-paced world", "it's important to note", "plays a crucial role", "a testament to", "navigate the complexities", "in conclusion").
- generic statements with no specific detail, example, opinion or personal voice.
- uniform sentence length and rhythm; formulaic structure (restating the prompt, three tidy parallel points, a summary conclusion that adds nothing).
- tics: overused em-dashes, "not just X, but Y", lists of three, rhetorical questions answered at once, empty intensifiers and hedges.

"ai_likeness" rates how strongly the text shows these patterns. It is a judgement about style, not about authorship: people write this way too, and neither you nor any detector can know who wrote a text. Never say the text was or was not written by AI.

"signals" are 2-4 short, specific observations (quote the text where useful). Include what already sounds human if the text is mostly natural.

"suggestions" are local edits that make the writing more specific and personal. "original" MUST be copied character-for-character from the text and be as short as possible; "prefix" is up to 30 characters immediately before it, verbatim. When a better version needs the writer's own knowledge, put a short bracketed placeholder in "replacement", like "[an example from your class]". Do not overlap suggestions. Order them by where they appear in the text.

Reply with only one JSON object, no other text:
{"ai_likeness": "low" | "medium" | "high", "signals": ["..."], "suggestions": [{"title": "<2-5 word label>", "original": "...", "prefix": "...", "replacement": "...", "explanation": "<one short sentence>"}]}`;

const REWRITE_RULES = `You are a writing assistant inside an editor. Rewrite only the passage you are given, following the instruction and the writer's goals. Keep the meaning unless asked otherwise, keep the same language, and return text that can be pasted straight back in place (no quotes, no commentary in "rewrite").

Reply with only one JSON object, no other text: {"rewrite": "<the new passage>", "note": "<one short sentence on what changed>"}`;

function goalsText(g) {
  return `Writer's goals: audience=${g.audience}; formality=${g.formality}; domain=${g.domain}; intent=${g.intent}.`;
}

const SAMPLE_ERRORS = {
  not_granted: "Claude isn't allowed on this page. Use the page's Permissions menu to allow it.",
  sampling_disabled: "Claude isn't available for this account.",
  rate_limited: "You've hit a usage limit. Try again in a little while.",
  session_expired: "Your claude.ai session expired. Sign in again, then retry.",
  prompt_too_large: "This text is too long to check at once. Try a shorter section.",
  refused: "Claude declined to work on this text.",
  invalid_json: "Claude's reply couldn't be read. Click again to retry.",
  empty_completion: "Claude returned nothing. Click again to retry.",
};

async function api(path, body, opts = {}) {
  const sample = await samplePromise;
  if (!sample) throw Object.assign(new Error("Open this page on claude.ai to use AI suggestions."), { code: "unavailable" });
  const kind = path.split("/").pop();
  const prompt = kind !== "rewrite"
    ? `${kind === "style" ? STYLE_RULES : CHECK_RULES}\n\n${goalsText(body.goals)}\n\n<text>\n${body.text}\n</text>`
    : `${REWRITE_RULES}\n\n${goalsText(body.goals)}\n\nFull document for context:\n<document>\n${body.text}\n</document>\n\nPassage to rewrite:\n<passage>\n${body.selection}\n</passage>\n\nInstruction: ${body.instruction}`;
  try {
    return await sample.json(prompt, opts);
  } catch (e) {
    const err = new Error(SAMPLE_ERRORS[e?.code] || "Couldn't reach Claude. Try again.");
    err.code = e?.code;
    throw err;
  }
}

''' + js[end:]

# Checking: manual, stoppable, streaming progress.
start = js.index("function scheduleCheck(")
end = js.index("// ---------- Suggestions: accept / dismiss / popover ----------")
js = js[:start] + r'''let checkCtl = null;

function setCheckButton(running) {
  const btn = $("checkBtn");
  btn.textContent = running ? "Stop" : "Check writing";
  btn.classList.toggle("stop", running);
}

async function runCheck() {
  if (checkCtl) { checkCtl.abort(); return; } // the button doubles as Stop
  const text = ta.value;
  if (!text.trim()) {
    state.suggestions = [];
    setScore(null);
    setStatus("", "Write or paste some text first.");
    return render();
  }
  const ctl = (checkCtl = new AbortController());
  setCheckButton(true);
  setStatus("busy", "Claude is reading your text…");
  try {
    const result = await api("check", { text, goals: state.goals }, {
      signal: ctl.signal,
      onText: ({ text: reply }) => {
        const n = (reply.match(/"original"/g) || []).length;
        setStatus("busy", n ? `Found ${n} suggestion${n === 1 ? "" : "s"} so far…` : "Claude is reading your text…");
      },
    });
    if (!result || !Array.isArray(result.suggestions)) throw new Error("Claude's reply couldn't be read. Click again to retry.");
    applyResults(ta.value, result); // locate against the *current* text
    state.example = false;
    state.lastChecked = text;
    setScore(Number(result.overall_score) || null, result.tone, result.summary);
    setStatus("", ta.value === text ? "All caught up" : "You edited while Claude was reading. Check again to refresh.");
    render();
  } catch (err) {
    setStatus(err.code === "cancelled" ? "" : "error", err.code === "cancelled" ? "Stopped." : err.message);
  } finally {
    checkCtl = null;
    setCheckButton(false);
  }
}

''' + js[end:]

js = rep(js, 'const { rewrite, note } = await api("api/rewrite", {', 'const { rewrite, note } = await api("rewrite", {')
js = rep(js, '''      goals: state.goals,
    });
    if (state.ai !== ai) return;''', '''      goals: state.goals,
    }, { cache: false });
    if (state.ai !== ai) return;''')
js = rep(js, '''    if (state.ai === ai) $("aiResultText").textContent = "⚠️ " + err.message;''',
             '''    if (state.ai === ai) $("aiResultText").textContent = err.message;''')

# Input no longer auto-checks (sampling runs only on an explicit click).
js = rep(js, '''  setStatus("", "");
  scheduleCheck();
});''', '''  if (state.lastChecked !== null && !state.example) setStatus("", "Text changed. Click Check writing to refresh.");
  else if (state.example) { state.example = false; state.suggestions = []; setScore(null); setStatus("", "Click Check writing when you're ready."); render(); }
});''')
js = rep(js, '''  state.lastChecked = null; // any edit (including undo) needs a fresh check
''', "")
js = rep(js, '$("checkBtn").addEventListener("click", () => runCheck(true));', '$("checkBtn").addEventListener("click", () => runCheck());')
js = rep(js, '''    store.set("wa.goals", next);
    runCheck(true);''', '''    store.set("wa.goals", next);
    if (!state.example && ta.value.trim()) setStatus("", "Goals updated. Click Check writing to apply them.");''')
js = rep(js, "const CHECK_DELAY_MS = 1800;\n", "")
js = rep(js, """  mode: null,               // "server" (server.js proxies Claude) or "browser" (viewer's own API key)
  assistant: null,          // browser mode: {check, rewrite} from claude-bundle.js
  ready: null,              // resolves once the mode is known
};
let bundle = null;          // browser mode: the lazily imported claude-bundle.js""", "};")
js = rep(js, "  timer: null,\n", "  example: false,           // showing the built-in example suggestions\n")

# Remove API-key backend + replace init.
start = js.index("// ---------- Backend: local server, or the viewer's own API key ----------")
end = js.index("// ---------- Init ----------")
js = js[:start] + js[end:]
js = rep(js, '''state.ready = detectMode();
state.ready.then(() => scheduleCheck(300));''', r'''// Open in a working state: the sample paragraph with example suggestions.
if (ta.value === SAMPLE) {
  applyResults(ta.value, {
    suggestions: [
      { category: "correctness", title: "Fix spelling", original: "Teh", prefix: "", replacement: "The", explanation: "“Teh” is a misspelling of “the”." },
      { category: "engagement", title: "Use a stronger word", original: "very good", prefix: "cycle is a ", replacement: "clear", explanation: "One precise word says more than “very good”." },
      { category: "correctness", title: "Fix subject-verb agreement", original: "recycle", prefix: "of how nature ", replacement: "recycles", explanation: "“Nature” is singular, so the verb needs an -s." },
      { category: "correctness", title: "Use “its”", original: "it's", prefix: "nature recycle ", replacement: "its", explanation: "“It's” means “it is”; the possessive is “its”." },
      { category: "correctness", title: "Join as one word", original: "in to", prefix: "and rises ", replacement: "into", explanation: "“Into” shows movement toward something." },
      { category: "clarity", title: "Remove wordiness", original: "In order to", prefix: "", replacement: "To", explanation: "“To” says the same thing more simply." },
      { category: "correctness", title: "Fix subject-verb agreement", original: "gets", prefix: "the droplets ", replacement: "get", explanation: "“Droplets” is plural, so use “get”." },
      { category: "clarity", title: "Split the run-on sentence", original: "This process happens over and over again and it never really stops and it is important for all living things.", prefix: "or hail. ", replacement: "This process repeats endlessly, and every living thing depends on it.", explanation: "Shorter, joined ideas are easier to follow than a chain of “and”s." },
    ],
  });
  state.example = true;
  setScore(68, "Casual, unpolished", "Example feedback on the sample text. Paste your own writing and click Check writing.");
  setStatus("", "");
  render();
  $("summary").insertAdjacentHTML("afterbegin", '<span class="example-tag">Example</span> ');
}

samplePromise.then((sample) => {
  if (!sample) {
    $("checkBtn").disabled = true;
    setStatus("error", "AI features need this page to be open on claude.ai.");
  }
});''')
for gone in ["scheduleCheck", "detectMode", "callBrowser", "bundle", "keyDialog", "state.ready"]:
    assert gone not in js, gone

page = f"""<title>AI Writing Assistant</title>
<style>
{css}
</style>
{body.strip()}
<script>
{js}
</script>
"""
open(out, "w").write(page)
print(len(page), "bytes")
