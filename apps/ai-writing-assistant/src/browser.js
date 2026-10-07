// Browser build entry: lets the static page call Claude directly with the
// viewer's own API key (used when the page is hosted without server.js).
// Bundled to public/claude-bundle.js by `npm run build`.

import Anthropic from "@anthropic-ai/sdk";
import { createAssistant, DEFAULT_MODEL, MAX_CHARS, RefusalError } from "./assistant.js";

export { MAX_CHARS };

// Validates the key with a cheap Models API call, then returns {check, rewrite}.
export async function connect(apiKey, model = DEFAULT_MODEL) {
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  await client.models.retrieve(model);
  return createAssistant(client, model);
}

export function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError) {
    return { auth: true, message: "That API key was rejected. Check it and try again." };
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return { auth: true, message: "This API key doesn't have access to the model." };
  }
  if (err instanceof Anthropic.RateLimitError) return { message: "Rate limited. Try again in a moment." };
  if (err instanceof Anthropic.APIConnectionError) return { message: "Couldn't reach Claude. Check your connection." };
  if (err instanceof Anthropic.APIError) return { message: `Claude API error: ${err.message}` };
  if (err instanceof RefusalError) return { message: err.message };
  return { message: err?.message ?? "Something went wrong." };
}
