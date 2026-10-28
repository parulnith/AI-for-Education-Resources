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
import { createAssistant, DEFAULT_MODEL, MAX_CHARS, RefusalError } from "./src/assistant.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(here, "public");
const PORT = Number(process.env.PORT ?? 3000);
const MODEL = process.env.CLAUDE_MODEL ?? DEFAULT_MODEL;
const MOCK = process.env.MOCK === "1";

const client = MOCK ? null : new Anthropic();
const assistant = MOCK ? null : createAssistant(client, MODEL);

function check({ text, goals }) {
  return MOCK ? mockCheck(text) : assistant.check({ text, goals });
}

function style({ text, goals }) {
  return MOCK ? mockStyle(text) : assistant.style({ text, goals });
}

function rewrite(body) {
  if (MOCK) return { rewrite: body.selection.toUpperCase(), note: "Mock mode: uppercased the selection." };
  return assistant.rewrite(body);
}

function mockStyle(text) {
  const phrases = ["it is important to note", "in today's fast-paced world", "delve into", "plays a crucial role", "in conclusion"];
  const suggestions = [];
  for (const phrase of phrases) {
    const i = text.toLowerCase().indexOf(phrase);
    if (i === -1) continue;
    suggestions.push({
      title: "Replace stock phrase",
      original: text.slice(i, i + phrase.length),
      prefix: text.slice(Math.max(0, i - 30), i),
      replacement: "[say it in your own words]",
      explanation: "This phrase is common in AI-generated text and adds little.",
    });
  }
  return {
    ai_likeness: suggestions.length > 1 ? "high" : suggestions.length ? "medium" : "low",
    signals: ["Mock mode: start the server with an API key for real feedback."],
    suggestions,
  };
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
    if (req.method === "GET" && req.url === "/api/health") return send(res, 200, { ok: true, mock: MOCK });

    if (req.method === "POST" && ["/api/check", "/api/style", "/api/rewrite"].includes(req.url)) {
      const body = await readJson(req);
      if (typeof body.text !== "string" || body.text.length > MAX_CHARS) {
        return send(res, 400, { error: `Text must be a string under ${MAX_CHARS} characters.` });
      }
      if (req.url === "/api/check") {
        if (!body.text.trim()) return send(res, 200, { overall_score: 100, tone: "", summary: "", suggestions: [] });
        return send(res, 200, await check(body));
      }
      if (req.url === "/api/style") {
        if (!body.text.trim()) return send(res, 400, { error: "Write or paste some text first." });
        return send(res, 200, await style(body));
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
