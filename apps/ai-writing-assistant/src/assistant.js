// Prompts, output schemas and Claude calls for the writing assistant.

import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

export const DEFAULT_MODEL = "claude-opus-5-5";
export const MAX_CHARS = 30000;

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

export class RefusalError extends Error {}

async function askClaude(client, model, { system, user, schema, effort }) {
  const response = await client.beta.messages.parse({
    model,
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

// Returns {check, rewrite} bound to an Anthropic client. Shared by the Node
// server (server.js) and the browser build (src/browser.js).
export function createAssistant(client, model = DEFAULT_MODEL) {
  return {
    check: ({ text, goals }) =>
      askClaude(client, model, {
        system: CHECK_SYSTEM,
        user: `${goalsText(goals)}\n\n<text>\n${text}\n</text>`,
        schema: CheckResult,
        effort: "low", // fast feedback while typing
      }),
    rewrite: ({ text, selection, instruction, goals }) =>
      askClaude(client, model, {
        system: REWRITE_SYSTEM,
        user:
          `${goalsText(goals)}\n\nFull document for context:\n<document>\n${text}\n</document>\n\n` +
          `Passage to rewrite:\n<passage>\n${selection}\n</passage>\n\nInstruction: ${instruction}`,
        schema: RewriteResult,
        effort: "medium",
      }),
  };
}
