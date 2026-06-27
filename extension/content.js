// Interview Helper — content script.
//
// Listens for the "open card" shortcut (relayed by the background), finds the
// focused field, auto-extracts its question, and shows an inline card with an
// editable question + an optional hint. On generate it calls the local helper
// brain and writes the answer straight into the field via the DOM — no clipboard,
// no need to stay focused on the field (the target is captured at trigger time).
//
// The card lives in a Shadow DOM so the host page's CSS can't touch it.

(() => {
  if (window.__ihInjected) return;
  window.__ihInjected = true;

  // The last field the user focused, so the card can safely steal focus for its
  // inputs without losing track of where the answer should go.
  let lastEditable = null;
  let active = null; // { close() } for the currently-open card, if any

  /* ---------------- settings ---------------- */
  async function getSettings() {
    const { profile = "interview", jd = "" } = await browser.storage.local.get([
      "profile",
      "jd",
    ]);
    return { profile, jd };
  }

  /* ---------------- field detection ---------------- */
  const TEXTY = new Set(["text", "search", "url", "email", "tel", "password", ""]);

  function isEditable(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName;
    if (tag === "TEXTAREA") return !el.disabled && !el.readOnly;
    if (tag === "INPUT") {
      const type = (el.type || "text").toLowerCase();
      return TEXTY.has(type) && !el.disabled && !el.readOnly;
    }
    return !!el.isContentEditable;
  }

  function currentTarget() {
    const a = document.activeElement;
    // activeElement is retargeted to this card's host (a plain div) while the card
    // inputs are focused — isEditable(div) is false, so we fall back to the stored
    // last field. That's exactly what we want.
    if (isEditable(a)) return a;
    if (lastEditable && document.contains(lastEditable) && isEditable(lastEditable)) {
      return lastEditable;
    }
    return null;
  }

  /* ---------------- question extraction ---------------- */
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

  function humanize(name) {
    return clean(name.replace(/[_\-]+/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2"));
  }

  // Walk up a few ancestors, scanning preceding siblings for short label-like text.
  function nearbyText(el) {
    let node = el;
    for (let depth = 0; depth < 3 && node; depth++, node = node.parentElement) {
      let sib = node.previousElementSibling;
      for (let i = 0; i < 3 && sib; i++, sib = sib.previousElementSibling) {
        const t = clean(sib.textContent);
        if (t && t.length <= 160) return t;
      }
    }
    return "";
  }

  function extractQuestion(el) {
    if (el.id) {
      const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      const t = clean(lab?.textContent);
      if (t) return t;
    }
    const wrap = el.closest("label");
    const wt = clean(wrap?.textContent);
    if (wt) return wt;

    const aria = clean(el.getAttribute("aria-label"));
    if (aria) return aria;

    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const t = clean(document.getElementById(labelledBy)?.textContent);
      if (t) return t;
    }

    const ph = clean(el.placeholder);
    if (ph) return ph;

    const title = clean(el.title);
    if (title) return title;

    const near = nearbyText(el);
    if (near) return near;

    if (el.name) return humanize(el.name);
    return "";
  }

  /* ---------------- writing the answer back (framework-aware) ---------------- */
  function writeValue(el, value) {
    if (el.isContentEditable) {
      el.focus();
      el.textContent = value;
      el.dispatchEvent(new InputEvent("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }
    // Use the native setter so React/Vue/etc. (which override `value`) notice the
    // change; a plain `el.value = x` is silently swallowed by those frameworks.
    const proto =
      el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc?.set) desc.set.call(el, value);
    else el.value = value;

    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
  }

  /* ---------------- the brain call (via the background script) ---------------- */
  // Fetching through the background avoids the page's CSP, which would otherwise
  // block a content-script fetch to 127.0.0.1 with a NetworkError.
  async function fetchAnswer(question, hint) {
    const { profile, jd } = await getSettings();
    const res = await browser.runtime.sendMessage({
      type: "ANSWER",
      question,
      hint,
      jd,
      profile,
    });
    if (res?.error) throw new Error(res.error);
    if (!res?.answer) throw new Error("The helper returned no answer.");
    return res.answer;
  }

  /* ---------------- toast ---------------- */
  function toast(text, kind = "info") {
    const host = document.createElement("div");
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        .t { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
              background: ${kind === "error" ? "#7f1d1d" : "#111827"}; color: #fff;
              font: 13px/1.4 -apple-system, system-ui, sans-serif;
              padding: 9px 14px; border-radius: 8px; box-shadow: 0 6px 20px rgba(0,0,0,.3);
              z-index: 2147483647; max-width: 80vw; }
      </style>
      <div class="t"></div>`;
    root.querySelector(".t").textContent = text;
    document.body.appendChild(host);
    setTimeout(() => host.remove(), 2600);
  }

  /* ---------------- the inline card (Shadow DOM) ---------------- */
  const CARD_CSS = `
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
    .wrap { position: fixed; z-index: 2147483646; width: 380px; }
    .card { background: #ffffff; border: 1px solid #e5e7eb; border-radius: 12px;
            box-shadow: 0 12px 32px rgba(15,23,42,.18); padding: 12px; }
    .head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #3B82F6; }
    .title { font-size: 12px; font-weight: 600; color: #374151; }
    .spacer { flex: 1; }
    .close { border: none; background: transparent; cursor: pointer; color: #9ca3af;
             font-size: 15px; line-height: 1; padding: 3px 6px; border-radius: 6px; }
    .close:hover { background: #f3f4f6; color: #374151; }
    label { display: block; font-size: 10px; font-weight: 700; color: #6b7280;
            margin: 8px 0 4px; text-transform: uppercase; letter-spacing: .04em; }
    label .opt { text-transform: none; font-weight: 400; color: #9ca3af; }
    textarea, input { width: 100%; border: 1px solid #d1d5db; border-radius: 8px; padding: 8px 10px;
                      font-size: 13px; color: #111827; outline: none; background: #fff; }
    textarea { resize: vertical; min-height: 58px; }
    textarea:focus, input:focus { border-color: #3B82F6; box-shadow: 0 0 0 3px rgba(59,130,246,.15); }
    .row { display: flex; gap: 8px; margin-top: 10px; align-items: center; }
    button.gen { background: #3B82F6; color: #fff; border: none; border-radius: 8px;
                 padding: 8px 14px; font-size: 13px; font-weight: 600; cursor: pointer; white-space: nowrap; }
    button.gen:disabled { background: #9ca3af; cursor: default; }
    button.gen:hover:not(:disabled) { background: #2563eb; }
    .status { font-size: 12px; color: #6b7280; min-height: 16px; margin-top: 8px;
              word-break: break-word; flex: 1; }
    .status.err { color: #b91c1c; }
    .status.ok { color: #047857; }
    .status.load { color: #2563eb; }
    .hint { font-size: 10px; color: #9ca3af; margin-top: 8px; }
  `;

  function buildCard({ anchor, question, onGenerate }) {
    const host = document.createElement("div");
    host.className = "ih-card";
    host.style.cssText = "all: initial;";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>${CARD_CSS}</style>
      <div class="wrap">
        <div class="card">
          <div class="head">
            <span class="dot"></span><span class="title">Interview Helper</span>
            <span class="spacer"></span>
            <button class="close" title="Close (Esc)" aria-label="Close">✕</button>
          </div>
          <label for="ih-q">Question</label>
          <textarea id="ih-q" rows="3" spellcheck="false"></textarea>
          <label for="ih-h">Hint <span class="opt">(optional)</span></label>
          <input id="ih-h" type="text" spellcheck="false"
                 placeholder="e.g. concise · emphasize leadership · 2 sentences" />
          <div class="row">
            <button class="gen">Generate</button>
            <span class="status"></span>
          </div>
          <div class="hint">Ctrl/⌘+Enter generates · Esc closes</div>
        </div>
      </div>`;
    document.body.appendChild(host);

    const $ = (sel) => root.querySelector(sel);
    const qEl = $("textarea");
    const hEl = $("input");
    const btn = $("button.gen");
    const statusEl = $(".status");
    qEl.value = question || "";

    let busy = false;
    const setStatus = (text, kind) => {
      statusEl.textContent = text || "";
      statusEl.className = "status" + (kind ? " " + kind : "");
    };
    const truncate = (s, n = 70) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

    async function generate() {
      if (busy) return;
      const q = qEl.value.trim();
      if (!q) {
        setStatus("Enter the question first.", "err");
        qEl.focus();
        return;
      }
      busy = true;
      btn.disabled = true;
      btn.textContent = "Generating…";
      setStatus("Thinking…", "load");
      try {
        const answer = await onGenerate(q, hEl.value.trim());
        setStatus("Inserted into field ✓  " + truncate(answer), "ok");
        btn.textContent = "Regenerate";
      } catch (e) {
        setStatus(e.message || "Failed.", "err");
        btn.textContent = "Retry";
      } finally {
        busy = false;
        btn.disabled = false;
      }
    }

    btn.addEventListener("click", generate);
    $("button.close").addEventListener("click", close);
    qEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        generate();
      }
    });
    hEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        generate();
      }
    });

    // Esc anywhere closes (capture, so it wins over the page).
    const onEsc = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    document.addEventListener("keydown", onEsc, true);

    // Keep the card glued to its field while scrolling/resizing.
    function reposition() {
      if (!document.contains(anchor)) return close();
      const r = anchor.getBoundingClientRect();
      const wrap = $(".wrap");
      const cardH = wrap.offsetHeight || 240;
      let top = r.bottom + 6;
      if (top + cardH > window.innerHeight) top = Math.max(8, r.top - cardH - 6);
      let left = r.left;
      if (left + 380 > window.innerWidth) left = Math.max(8, window.innerWidth - 388);
      wrap.style.top = top + "px";
      wrap.style.left = left + "px";
    }
    const onScrollResize = () => reposition();
    window.addEventListener("scroll", onScrollResize, true);
    window.addEventListener("resize", onScrollResize);
    reposition();

    // Focus the hint by default — the question is auto-filled and editable, but
    // the hint is usually what you want to type next.
    setTimeout(() => hEl.focus(), 0);

    function close() {
      document.removeEventListener("keydown", onEsc, true);
      window.removeEventListener("scroll", onScrollResize, true);
      window.removeEventListener("resize", onScrollResize);
      host.remove();
    }

    return { close };
  }

  /* ---------------- orchestration ---------------- */
  function openCard() {
    const target = currentTarget();
    if (!target) {
      toast("Focus a text field first, then press the shortcut.", "error");
      return;
    }
    if (active) {
      active.close();
      active = null;
    }
    active = buildCard({
      anchor: target,
      question: extractQuestion(target),
      onGenerate: async (q, hint) => {
        const answer = await fetchAnswer(q, hint);
        writeValue(target, answer);
        return answer;
      },
    });
  }

  document.addEventListener(
    "focusin",
    (e) => {
      if (isEditable(e.target)) lastEditable = e.target;
    },
    true
  );

  browser.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "OPEN_CARD") openCard();
  });
})();
