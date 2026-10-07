// AI Writing Assistant: a small Node server that serves the editor UI and
// proxies two endpoints to Claude:
//   POST /api/check   -> inline suggestions (grammar, clarity, engagement, delivery)
//   POST /api/rewrite -> rewrite a selected passage with an instruction
//
// Run:  ANTHROPIC_API_KEY=... npm start      (or MOCK=1 npm start to try the UI offline)

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(here, "public");
const PORT = Number(process.env.PORT ?? 3000);
const MODEL = process.env.CLAUDE_MODEL ?? "claude-opus-5-5";
const MOCK = process.env.MOCK === "1";
const MAX_CHARS = 30000;

const client = MOCK ? null : new Anthropic();

// ---------- Schemas ----------

const Suggestion = z.object({
  category: z.enum(["correctness", "clarity", "engagement", "delivery"]),
  title: z.string().describe("2-5 word label, e.g. 'Fix subject-verb agreement'"),
  original: z.string().describe("Exact substring copied verbatim from the text"),
  prefix: z
    .string()
    .describe("Up to 30 characters that appear immediately before `original` in the text (verbatim), used to locate it; empty string if at the very start"),
  replacement: z.string().describe("Text that should replace `original`; empty string to delete it"),
  explanation: z.string().describe("One short sentence a student could understand"),
});

const CheckResult = z.object({
  overall_score: z.number().int().describe("0-100 overall writing quality for the stated goals"),
  tone: z.string().describe("2-4 words describing how the text currently sounds"),
  summary: z.string().describe("One encouraging sentence on the biggest improvement opportunity"),
  suggestions: z.array(Suggestion),
});

const RewriteResult = z.object({
  rewrite: z.string(),
  note: z.string().describe("One short sentence on what changed"),
});

// ---------- Prompts ----------

const CHECK_SYSTEM = `You are a writing assistant embedded in an editor, similar to Grammarly. \
The writer is often a student or teacher. Review the text and return precise, local edits.

Categories:
- correctness: spelling, grammar, punctuation, agreement, wrong word.
- clarity: wordiness, unclear or run-on sentences, passive voice that hurts readability.
- engagement: bland or repeated words, weak verbs, monotonous sentence starts.
- delivery: tone, formality, and confidence that do not fit the writer's goals.

Rules:
- \`original\` MUST be copied character-for-character from the text and be as short as possible \
(a word or phrase; a full sentence only for sentence-level rewrites). Never span paragraphs.
- \`prefix\` is the exact text immediately before \`original\`, used to tell repeated phrases apart.
- Do not overlap suggestions. Do not suggest changes that only restate the text.
- Respect the writer's voice; suggest only what genuinely helps for their goals.
- Order suggestions by where they appear in the text.`;

const REWRITE_SYSTEM = `You are a writing assistant inside an editor. Rewrite only the passage \
you are given, following the instruction and the writer's goals. Keep the meaning unless asked \
otherwise, keep the same language, and return text that can be pasted straight back in place \
(no quotes, no commentary in \`rewrite\`).`;

function goalsText(goals = {}) {
  const g = {
    audience: goals.audience ?? "general",
    formality: goals.formality ?? "neutral",
    domain: goals.domain ?? "general",
    intent: goals.intent ?? "inform",
  };
  return `Writer's goals: audience=${g.audience}; formality=${g.formality}; domain=${g.domain}; intent=${g.intent}.`;
}

// ---------- Claude calls ----------

class RefusalError extends Error {}

async function askClaude({ system, user, schema, effort }) {
  const response = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort, format: betaZodOutputFormat(schema) },
    system,
    messages: [{ role: "user", content: user }],
  });
  if (response.stop_reason === "refusal") {
    throw new RefusalError("Claude declined to process this text.");
  }
  if (response.stop_reason === "max_tokens" || !response.parsed_output) {
    throw new Error("The response was cut off. Try checking a shorter passage.");
  }
  return response.parsed_output;
}

async function check({ text, goals }) {
  if (MOCK) return mockCheck(text);
  return askClaude({
    system: CHECK_SYSTEM,
    user: `${goalsText(goals)}\n\n<text>\n${text}\n</text>`,
    schema: CheckResult,
    effort: "low", // fast feedback while typing
  });
}

async function rewrite({ text, selection, instruction, goals }) {
  if (MOCK) return { rewrite: selection.toUpperCase(), note: "Mock mode: uppercased the selection." };
  return askClaude({
    system: REWRITE_SYSTEM,
    user:
      `${goalsText(goals)}\n\nFull document for context:\n<document>\n${text}\n</document>\n\n` +
      `Passage to rewrite:\n<passage>\n${selection}\n</passage>\n\nInstruction: ${instruction}`,
    schema: RewriteResult,
    effort: "medium",
  });
}

// Offline demo so the UI can be explored without an API key.
function mockCheck(text) {
  const rules = [
    [/\bteh\b/i, "the", "correctness", "Fix spelling", "“teh” is a misspelling of “the”."],
    [/\bdont\b/i, "don't", "correctness", "Add apostrophe", "Contractions need an apostrophe."],
    [/\bvery good\b/i, "excellent", "engagement", "Use a stronger word", "A single precise word is more vivid."],
    [/\bin order to\b/i, "to", "clarity", "Remove wordiness", "“To” says the same thing more simply."],
    [/\bgonna\b/i, "going to", "delivery", "Use formal wording", "“Gonna” is informal for most writing."],
  ];
  const suggestions = [];
  for (const [re, replacement, category, title, explanation] of rules) {
    const m = re.exec(text);
    if (m) {
      const cased = /[A-Z]/.test(m[0][0]) ? replacement[0].toUpperCase() + replacement.slice(1) : replacement;
      suggestions.push({
        category, title, explanation,
        replacement: cased,
        original: m[0],
        prefix: text.slice(Math.max(0, m.index - 30), m.index),
      });
    }
  }
  return {
    overall_score: Math.max(40, 95 - suggestions.length * 8),
    tone: "Friendly, informal",
    summary: "Mock mode: start the server with an API key for real suggestions.",
    suggestions,
  };
}

// ---------- HTTP ----------

const MIME = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml" };

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > MAX_CHARS * 3) throw new Error("Request too large");
  }
  return JSON.parse(raw || "{}");
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "POST" && (req.url === "/api/check" || req.url === "/api/rewrite")) {
      const body = await readJson(req);
      if (typeof body.text !== "string" || body.text.length > MAX_CHARS) {
        return send(res, 400, { error: `Text must be a string under ${MAX_CHARS} characters.` });
      }
      if (req.url === "/api/check") {
        if (!body.text.trim()) return send(res, 200, { overall_score: 100, tone: "", summary: "", suggestions: [] });
        return send(res, 200, await check(body));
      }
      if (typeof body.selection !== "string" || !body.selection.trim() || typeof body.instruction !== "string") {
        return send(res, 400, { error: "Select some text and give an instruction." });
      }
      return send(res, 200, await rewrite(body));
    }

    if (req.method === "GET") {
      const urlPath = req.url === "/" ? "/index.html" : decodeURIComponent(req.url.split("?")[0]);
      const file = path.join(PUBLIC_DIR, path.normalize(urlPath));
      if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, { error: "Forbidden" });
      const data = await fs.readFile(file).catch(() => null);
      if (!data) return send(res, 404, { error: "Not found" });
      res.writeHead(200, { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream" });
      return res.end(data);
    }

    send(res, 404, { error: "Not found" });
  } catch (err) {
    if (err instanceof RefusalError) return send(res, 422, { error: err.message });
    if (err instanceof Anthropic.AuthenticationError) {
      return send(res, 401, { error: "Invalid or missing ANTHROPIC_API_KEY on the server." });
    }
    if (err instanceof Anthropic.RateLimitError) return send(res, 429, { error: "Rate limited. Try again in a moment." });
    if (err instanceof Anthropic.APIError) return send(res, 502, { error: `Claude API error: ${err.message}` });
    console.error(err);
    send(res, 500, { error: err.message ?? "Server error" });
  }
});

server.listen(PORT, () => {
  console.log(`AI Writing Assistant running at http://localhost:${PORT}${MOCK ? " (mock mode)" : ""}`);
});
