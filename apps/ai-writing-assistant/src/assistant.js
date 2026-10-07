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

const StyleResult = z.object({
  ai_likeness: z
    .enum(["low", "medium", "high"])
    .describe("How strongly the text shows patterns typical of AI-generated writing"),
  signals: z.array(z.string()).describe("2-4 short, specific observations about the writing's style"),
  suggestions: z.array(Suggestion.omit({ category: true })),
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

const STYLE_SYSTEM = `You help writers make their text sound like a real person wrote it. \
Review the text for patterns that make writing read as AI-generated:
- stock phrases and filler ("delve into", "in today's fast-paced world", "it's important to note", \
"plays a crucial role", "a testament to", "navigate the complexities", "in conclusion").
- generic statements with no specific detail, example, opinion or personal voice.
- uniform sentence length and rhythm; formulaic structure (restating the prompt, three tidy \
parallel points, a summary conclusion that adds nothing).
- tics: overused em-dashes, "not just X, but Y", lists of three, rhetorical questions answered \
at once, empty intensifiers and hedges.

\`ai_likeness\` rates how strongly the text shows these patterns. It is a judgement about style, \
not about authorship: people write this way too, and neither you nor any detector can know who \
wrote a text. Never say the text was or was not written by AI.

\`signals\` are 2-4 short, specific observations (quote the text where useful). Include what \
already sounds human if the text is mostly natural.

\`suggestions\` are local edits that make the writing more specific and personal. \
\`original\` MUST be copied character-for-character from the text and be as short as possible; \
\`prefix\` is the exact text immediately before it. When a better version needs the writer's own \
knowledge, put a short bracketed placeholder in \`replacement\`, like "[an example from your class]". \
Do not overlap suggestions. Order them by where they appear in the text.`;

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

// Returns {check, style, rewrite} bound to an Anthropic client. Shared by the Node
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
    style: ({ text, goals }) =>
      askClaude(client, model, {
        system: STYLE_SYSTEM,
        user: `${goalsText(goals)}\n\n<text>\n${text}\n</text>`,
        schema: StyleResult,
        effort: "medium",
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
