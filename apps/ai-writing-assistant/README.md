# AI Writing Assistant ✍️

A Medium-style writing editor with Grammarly-style help from Claude. Write stories with headings, quotes, lists, links and images, and get:

- **A clean writing page.** A big title, then headings, quotes, lists, links, **bold** and *italic*. Select text to see the formatting toolbar, or type shortcuts at the start of a line: `# ` for a heading, `## ` for a small heading, `> ` for a quote, `- ` for a list, and `---` then Enter for a divider.
- **Images.** Click **＋** on an empty line, paste an image, or drag one in. Click an image to remove it, and type a caption under it. Large images are resized automatically.
- **Your stories.** Click **☰** to see, open, create and delete stories. Everything saves as you type.
- **Inline underlines**, colour-coded like Grammarly:
  🔴 Correctness · 🔵 Clarity · 🟢 Engagement · 🟣 Delivery · 🟠 AI-like
- **Suggestion cards** in the sidebar. Click a card or an underlined word to see the change and a short explanation, then **Accept** or **Dismiss**. You can also accept all correctness fixes at once.
- **An overall score and tone** ("Sounds: confident, friendly").
- **AI rewrite on any selection.** Select text, click **✨ AI**, and choose *Improve*, *Shorten*, *Simplify* (for a 10-year-old), *Formal*, *Friendly*, or give your own instruction. You can preview the result, then replace the selection or insert the result below it.
- **🤖 Sounds like AI?** underlines phrasing that reads as machine-written (stock phrases, generic filler, formulaic structure) and suggests more personal wording. It also rates the text Low, Medium or High, with the reasons. This is style feedback, not a detector: no tool can reliably tell whether text was written by AI, so don't use it as proof.
- **Goals** (audience, formality, domain, intent) that change the feedback. For example, choose *Young students* when you write for a class.
- Native **undo** (Ctrl/Cmd+Z) works after you accept a suggestion.

![Screenshot](screenshot.png)

## Use it online

**https://parulnith.github.io/AI-for-Education-Resources/**

Open the page, paste your [Anthropic API key](https://console.anthropic.com/settings/keys), and start writing. Your key stays in your browser and is sent only to `api.anthropic.com`. Use the **🔑 API key** button to change or forget it.

> **One-time setup for the repository owner:** go to *Settings → Pages* and set **Source** to **GitHub Actions**. After that, every push to `main` that touches this folder redeploys the site through `.github/workflows/deploy-writing-assistant.yml`. You can also run the workflow by hand from the *Actions* tab.

### On claude.ai (no API key)

`claude-ai/build.py` builds a single-page version that runs on your Claude subscription instead of an API key. It works only inside claude.ai. Stories and images are saved to your claude.ai account, and checks run when you click **Check writing** instead of automatically while you type.

```bash
python3 claude-ai/build.py writing-assistant.html
```

Publish it as an Artifact with the capabilities `{"sample": {}, "db": {}, "user": {}, "assets": {}}`.

## Run it locally

Requires Node.js 18+ and an [Anthropic API key](https://console.anthropic.com/).

```bash
cd apps/ai-writing-assistant
npm install
ANTHROPIC_API_KEY=sk-ant-... npm start
# open http://localhost:3000
```

To try the interface without a key, run `npm run mock`. Mock mode uses a few canned rules instead of AI.

Optional environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Port the server listens on |
| `CLAUDE_MODEL` | `claude-opus-5-5` | Claude model used for checks and rewrites |
| `MOCK` | unset | Set to `1` for offline mock mode |

## How it works

```
public/index.html   Page: top bar, stories drawer, editor, sidebar, selection toolbar, dialogs
public/styles.css   Medium-style editor and Grammarly-style sidebar (light and dark)
public/app.js       Editor, suggestions, AI rewrite, stories (shared by every version)
public/platform-web.js  Web version: Claude via server.js or your API key; stories in IndexedDB
src/assistant.js    Prompts, output schemas and Claude calls (shared)
src/browser.js      Browser entry, bundled to public/claude-bundle.js by `npm run build`
claude-ai/platform.js   claude.ai version: Claude via your plan; stories and images in your account
claude-ai/build.py  Builds the claude.ai version from public/ + claude-ai/platform.js
server.js           Node server: serves the page and calls Claude with the server's key
```

The page works in two modes. If `server.js` is running, the page uses it, and the API key stays on the server. If the page is hosted as static files (GitHub Pages), it asks for your key and calls Claude directly from the browser.

- **Editor.** A `contenteditable` page. For checking, the story is turned into plain text (the title and each block, separated by blank lines), and suggestions are matched back to that text. Underlines are drawn with the browser's CSS Custom Highlight API, so they never change the story's own markup. Accepting a change goes through the browser's editing commands, so undo keeps working.
- **Stories** are saved in the browser (IndexedDB) in the web version, and in your claude.ai account in the claude.ai version. Images are stored inside the story in the web version.
- **`POST /api/check`** sends the text and your goals to Claude, which returns structured JSON (a score, a tone, and a list of `{category, original, replacement, explanation}`). The browser finds each `original` phrase in the text and underlines it. While you type, underlines shift with the text. In the web version, the text is checked again about 2 seconds after you stop typing.
- **`POST /api/rewrite`** rewrites only the selected passage and sends the whole document along for context.
