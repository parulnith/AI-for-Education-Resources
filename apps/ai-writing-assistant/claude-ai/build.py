# Builds the claude.ai Artifact version of the writing assistant from public/.
# It runs Claude on the viewer's own claude.ai plan (the `sample` capability)
# instead of an API key, and saves stories and images to the viewer's claude.ai
# account (`db`, `user`, `assets`).
#
# Usage: python3 claude-ai/build.py <out.html>
# Publish with capabilities {"sample": {}, "db": {}, "user": {}, "assets": {}}.
import pathlib, re, sys

here = pathlib.Path(__file__).resolve().parent
public = here.parent / "public"
out = pathlib.Path(sys.argv[1])

html = (public / "index.html").read_text()
css = (public / "styles.css").read_text()
app = (public / "app.js").read_text()
platform = (here / "platform.js").read_text()

fonts = re.findall(r'<link rel="(?:preconnect|stylesheet)" href="https://fonts\.[^>]+>', html)
body = html[html.index("<body>") + len("<body>"): html.index("</body>")]
body = re.sub(r"\s*<!-- web-only -->.*?<!-- /web-only -->", "", body, flags=re.S)
body = re.sub(r'\s*<script src="[^"]+"></script>', "", body)
assert "keyDialog" not in body and "<script" not in body

page = "\n".join([
    "<title>AI Writing Assistant</title>",
    *fonts,
    f"<style>\n{css}</style>",
    body.strip(),
    f"<script>\n{platform}</script>",
    f"<script>\n{app}</script>",
    "",
])
out.write_text(page)
print(f"wrote {out} ({len(page):,} bytes)")
