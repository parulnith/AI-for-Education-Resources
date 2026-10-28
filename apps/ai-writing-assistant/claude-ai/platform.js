// Platform for the claude.ai build of the writing assistant.
//
// Claude runs on the viewer's own claude.ai plan (the `sample` capability), so
// no API key is needed. Stories are saved to the viewer's private space in the
// artifact's database (`db` + `user`), and images go to the artifact's asset
// store (`assets`). Checks run when the viewer clicks, never on a timer.

(() => {
  const use = (name) => (window.claude?.use ? window.claude.use(name) : Promise.resolve(null));
  const samplePromise = use("sample");

  const CHECK_RULES = `You are a writing assistant embedded in an editor, similar to Grammarly. The writer is often a student or teacher. Review the text and return precise, local edits. The text is a story: the first line is its title, and blocks are separated by blank lines.

Categories:
- correctness: spelling, grammar, punctuation, agreement, wrong word.
- clarity: wordiness, unclear or run-on sentences, passive voice that hurts readability.
- engagement: bland or repeated words, weak verbs, monotonous sentence starts.
- delivery: tone, formality, and confidence that do not fit the writer's goals.

Rules:
- "original" MUST be copied character-for-character from the text and be as short as possible (a word or phrase; a full sentence only for sentence-level rewrites). Never span blocks.
- "prefix" is up to 30 characters that appear immediately before "original" in the text, verbatim ("" at the start of a block). It tells repeated phrases apart.
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

"suggestions" are local edits that make the writing more specific and personal. "original" MUST be copied character-for-character from the text, never span blocks, and be as short as possible; "prefix" is up to 30 characters immediately before it, verbatim. When a better version needs the writer's own knowledge, put a short bracketed placeholder in "replacement", like "[an example from your class]". Do not overlap suggestions. Order them by where they appear in the text.

Reply with only one JSON object, no other text:
{"ai_likeness": "low" | "medium" | "high", "signals": ["..."], "suggestions": [{"title": "<2-5 word label>", "original": "...", "prefix": "...", "replacement": "...", "explanation": "<one short sentence>"}]}`;

  const REWRITE_RULES = `You are a writing assistant inside an editor. Rewrite only the passage you are given, following the instruction and the writer's goals. Keep the meaning unless asked otherwise, keep the same language, and return text that can be pasted straight back in place (no quotes, no commentary in "rewrite").

Reply with only one JSON object, no other text: {"rewrite": "<the new passage>", "note": "<one short sentence on what changed>"}`;

  const goalsText = (g) =>
    `Writer's goals: audience=${g.audience}; formality=${g.formality}; domain=${g.domain}; intent=${g.intent}.`;

  const SAMPLE_ERRORS = {
    not_granted: "Claude isn't allowed on this page. Use the page's Permissions menu to allow it.",
    sampling_disabled: "Claude isn't available for this account.",
    rate_limited: "You've hit a usage limit. Try again in a little while.",
    session_expired: "Your claude.ai session expired. Sign in again, then retry.",
    prompt_too_large: "This story is too long to check at once. Try a shorter one.",
    refused: "Claude declined to work on this text.",
    invalid_json: "Claude's reply couldn't be read. Try again.",
    empty_completion: "Claude returned nothing. Try again.",
    cancelled: "Stopped.",
  };

  async function call(kind, body, opts = {}) {
    const sample = await samplePromise;
    if (!sample) throw Object.assign(new Error("AI features need this page to be open on claude.ai."), { code: "unavailable" });
    const prompt = kind === "rewrite"
      ? `${REWRITE_RULES}\n\n${goalsText(body.goals)}\n\nFull document for context:\n<document>\n${body.text}\n</document>\n\nPassage to rewrite:\n<passage>\n${body.selection}\n</passage>\n\nInstruction: ${body.instruction}`
      : `${kind === "style" ? STYLE_RULES : CHECK_RULES}\n\n${goalsText(body.goals)}\n\n<text>\n${body.text}\n</text>`;
    const options = {};
    if (opts.signal) options.signal = opts.signal;
    if (opts.onText) options.onText = opts.onText;
    if (opts.cache !== undefined) options.cache = opts.cache;
    try {
      return await sample.json(prompt, options);
    } catch (e) {
      throw Object.assign(new Error(SAMPLE_ERRORS[e?.code] || "Couldn't reach Claude. Try again."), { code: e?.code });
    }
  }

  // Stories live in the viewer's private subtree: data/users/<id>/<storyId>.
  async function openStore() {
    const [db, user, assets] = await Promise.all([use("db"), use("user"), use("assets")]);
    const uid = user ? await user.id().catch(() => null) : null;
    if (!db || !uid) return null;
    const col = db.collection("data/users/" + uid);
    const once = async (fn) => {
      try { return await fn(); } catch (e) {
        if (e?.code !== "unavailable") throw e;
        await new Promise((r) => setTimeout(r, 400 + Math.random() * 600));
        return fn();
      }
    };
    return {
      note: "Stories are saved to your claude.ai account, so they're here on any device where you open this page.",
      maxBytes: 240_000,
      async list() {
        const snap = await once(() => col.get());
        return snap.docs.map((d) => {
          const { title = "", updatedAt = 0 } = d.data() || {};
          return { id: d.id, title, updatedAt };
        });
      },
      async get(id) {
        const snap = await once(() => col.doc(id).get());
        return snap.exists ? { id, ...snap.data() } : null;
      },
      async save(doc) {
        const { id, ...body } = doc;
        await once(() => col.doc(id).set(body));
      },
      remove: (id) => once(() => col.doc(id).delete()),
      putImage: assets
        ? async (blob) => {
            try { return "/_blob/" + (await assets.upload(blob)).id; } catch (e) {
              throw new Error(e?.code === "too_large" ? "the image is too large" : e?.code === "quota_or_state" ? "image storage is full" : "upload failed");
            }
          }
        : null,
    };
  }

  samplePromise.then((sample) => {
    if (sample) return;
    document.getElementById("checkBtn").disabled = true;
    document.getElementById("styleBtn").disabled = true;
    const el = document.getElementById("status");
    el.className = "status error";
    el.textContent = "AI features need this page to be open on claude.ai.";
  });

  window.Platform = { autoCheck: false, call, openStore };
})();
