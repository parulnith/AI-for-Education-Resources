// Platform for the web build of the writing assistant.
//
// Claude is reached through server.js when it is running (the API key stays on
// the server). When the page is hosted as static files (e.g. GitHub Pages), the
// viewer pastes their own Anthropic API key and the page calls Claude directly
// from the browser through claude-bundle.js (built by `npm run build`).
// Stories are kept in the browser (IndexedDB) by app.js.

(() => {
  const $ = (id) => document.getElementById(id);
  const keyDialog = $("keyDialog");
  let mode = null;      // "server" or "browser"
  let assistant = null; // browser mode: {check, style, rewrite}
  let bundle = null;    // browser mode: the lazily imported claude-bundle.js

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

  async function detectMode() {
    try {
      const res = await fetch("api/health");
      if (res.ok && (await res.json()).ok) { mode = "server"; return; }
    } catch { /* no server: static hosting */ }

    mode = "browser";
    $("keyBtn").hidden = false;
    bundle = await import("./claude-bundle.js");
    const key = savedKey();
    if (!key) return openKeyDialog();
    try {
      assistant = await bundle.connect(key);
    } catch (err) {
      openKeyDialog(bundle.describeError(err).message);
    }
  }

  const ready = detectMode();

  async function call(kind, body, { signal } = {}) {
    await ready;
    if (mode === "browser") {
      if (!assistant) {
        openKeyDialog();
        throw new Error("Add your Anthropic API key to start.");
      }
      try {
        return await assistant[kind](body);
      } catch (err) {
        const { auth, message } = bundle.describeError(err);
        if (auth) openKeyDialog(message);
        throw new Error(message);
      }
    }
    let res;
    try {
      res = await fetch(`api/${kind}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (err.name === "AbortError") throw Object.assign(new Error("Stopped."), { code: "cancelled" });
      throw new Error("Couldn't reach the server.");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
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
      assistant = await bundle.connect(key);
      saveKey(key, $("keyRemember").checked);
      keyDialog.close();
    } catch (err) {
      $("keyError").textContent = bundle.describeError(err).message;
    } finally {
      btn.disabled = false;
      btn.textContent = "Start writing";
    }
  });

  $("keyForget").addEventListener("click", () => {
    saveKey(null);
    assistant = null;
    $("keyInput").value = "";
    $("keyForget").hidden = true;
  });

  window.Platform = { autoCheck: true, call };
})();
