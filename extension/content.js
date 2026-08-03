// Application Filler — content script.
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

  const TAG = "[ih]";
  const log = (...a) => console.log(TAG, ...a);
  const logErr = (...a) => console.error(TAG, ...a);

  // The last field the user focused, so the card can safely steal focus for its
  // inputs without losing track of where the answer should go.
  let lastEditable = null;
  let active = null; // { close() } for the currently-open card, if any

  // The batch queue: each entry is { id, element, question, hint }.
  // `element` is a live DOM ref so we can write the answer back later; it's
  // never serialized. The batch lives in memory for the form session.
  let batch = [];
  let idCounter = 0;

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

  /* ---------------- word/char limit detection ---------------- */
  // Best-effort detection of a field's answer-length limit. Returns null when
  // nothing is found. Sources, in priority order:
  //   1. `maxlength` / `maxLength` attribute (chars) — the native HTML cap.
  //   2. data attributes: data-maxlength, data-max-words, data-limit,
  //      data-char-limit, data-word-limit.
  //   3. Hint text near the field: "max 500 characters", "up to 100 words",
  //      "(150 char max)", "limit: 200". Walks labels, aria, placeholder, and
  //      a few sibling/ancestor text nodes.
  // We report WORDS when the source says "words" (common for essay fields),
  // otherwise CHARACTERS. The agent prompt uses whichever we find.
  function extractLimit(el) {
    // 1. Native maxlength (input/textarea).
    const ml = el.getAttribute("maxlength") || el.maxLength;
    if (ml && Number(ml) > 0) return { value: Number(ml), unit: "characters" };

    // 2. data-* attributes.
    const ds = el.dataset || {};
    const dw = ds.maxWords || ds.maxWords || ds.wordLimit;
    if (dw && Number(dw) > 0) return { value: Number(dw), unit: "words" };
    const dc = ds.maxlength || ds.charLimit || ds.limit;
    if (dc && Number(dc) > 0) return { value: Number(dc), unit: "characters" };

    // 3. Hint text directly tied to THIS field. We do NOT walk up to
    //    ancestors/aunts/uncles: a shared form container often holds ANOTHER
    //    field's limit hint, and attributing that limit to this field produces
    //    false caps (the agent then truncates a long answer to fit a number that
    //    never applied — e.g. a sibling field's "50 characters" leaking into a
    //    5000-char essay field). Only field-bound sources are scanned, and each
    //    candidate must be SHORT: a real limit hint is tight ("max 500
    //    characters", "(150 char max)"), while a long paragraph that merely
    //    contains a number is almost certainly unrelated.
    const MAX_HINT = 120;
    const candidates = [];
    if (el.id) {
      const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lab?.textContent) candidates.push(lab.textContent);
    }
    const wrap = el.closest("label");
    if (wrap?.textContent) candidates.push(wrap.textContent);
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const t = document.getElementById(labelledBy)?.textContent;
      if (t) candidates.push(t);
    }
    if (el.getAttribute("aria-label")) candidates.push(el.getAttribute("aria-label"));
    if (el.placeholder) candidates.push(el.placeholder);
    if (el.title) candidates.push(el.title);
    // Direct siblings only (a tight hint element right next to the field, e.g.
    // a <small>500 char max</small>). The length cap below filters out any
    // sibling whose text is too long to be a clean hint.
    const nextSib = el.nextElementSibling;
    if (nextSib?.textContent) candidates.push(nextSib.textContent);
    const prevSib = el.previousElementSibling;
    if (prevSib?.textContent) candidates.push(prevSib.textContent);

    for (const raw of candidates) {
      // Long text is almost certainly the question prose or an unrelated block,
      // not a limit hint. Skip it rather than hunt for a number inside it.
      if (!raw || raw.length > MAX_HINT) continue;
      // Word limit: "up to 100 words", "max 250 words", "100 word limit".
      const wm = raw.match(/(?:max(?:imum)?|up to|limit(?:ed)?(?: to)?|≤)\s*(\d+)\s*(?:-?\s*)?word/i);
      if (wm) return { value: Number(wm[1]), unit: "words" };
      const wm2 = raw.match(/(\d+)\s*(?:-?\s*)?word(?:s)?(?:\s*(?:max|limit|maximum))?/i);
      if (wm2) return { value: Number(wm2[1]), unit: "words" };
      // Character limit: "max 500 characters", "(150 char max)", "limit: 200".
      const cm = raw.match(/(?:max(?:imum)?|up to|limit(?:ed)?(?: to)?|≤)\s*(\d+)\s*(?:-?\s*)?(?:char(?:acter)?s?)/i);
      if (cm) return { value: Number(cm[1]), unit: "characters" };
      const cm2 = raw.match(/(\d+)\s*(?:-?\s*)?char(?:acter)?s?(?:\s*(?:max|limit|maximum))?/i);
      if (cm2) return { value: Number(cm2[1]), unit: "characters" };
    }

    return null;
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

  // Read the field's current value — the inverse of writeValue, used to capture
  // what the user actually wrote so it can be saved as a sample. Unlike clean(),
  // this PRESERVES internal newlines (answers are often multi-paragraph); it
  // only trims the edges and normalizes CRLF. Reading doesn't need the native
  // getter trick — that's only for writing past framework overrides.
  function readAnswer(el) {
    let v;
    if (el.isContentEditable) {
      v = el.textContent || el.innerText || "";
    } else {
      v = el.value || "";
    }
    return v.replace(/\r\n/g, "\n").trim();
  }

  /* ---------------- the brain call (via the background script) ---------------- */
  // Fetching through the background avoids the page's CSP, which would otherwise
  // block a content-script fetch to 127.0.0.1 with a NetworkError.

  // Single-field fetch (used by /answer). Kept for the single-field path.
  async function fetchAnswer(question, hint, limit) {
    const { profile, jd } = await getSettings();
    const res = await browser.runtime.sendMessage({
      type: "ANSWER",
      question,
      hint,
      jd,
      profile,
      limit,
    });
    if (res?.error) throw new Error(res.error);
    if (!res?.answer) throw new Error("The helper returned no answer.");
    return res.answer;
  }

  // Batch fetch using polling: POST kicks off the job and returns a jobId
  // instantly, then we poll GET until the status is "done" or "error". Each
  // poll is a short request, so Firefox's MV3 background page never suspends
  // mid-run (the bug that orphaned long single-request batches).
  // onPoll(status) is called on every poll so the UI can update.
  async function fetchAnswers(items, { onPoll } = {}) {
    const { jd } = await getSettings();

    // 1. Start the job (instant response — just writes the file).
    const start = await browser.runtime.sendMessage({
      type: "ANSWER_BATCH_START",
      items,
      jd,
    });
    if (start?.error) throw new Error(start.error);
    if (!start?.jobId) throw new Error("The helper returned no job id.");
    const { jobId } = start;
    log("batch started, jobId=", jobId, "fields=", items.length);

    // 2. Poll until terminal. Short requests keep the background page alive.
    const startedAt = Date.now();
    const POLL_MS = 3000;
    const MAX_MS = 600000; // 10 min ceiling — same as the server-side opencode timeout
    let lastStatus = "pending";
    let pollCount = 0;
    while (true) {
      if (Date.now() - startedAt > MAX_MS) {
        throw new Error("Timed out waiting for the agent (over 10 minutes).");
      }
      const res = await browser.runtime.sendMessage({
        type: "ANSWER_BATCH_POLL",
        jobId,
      });
      pollCount++;
      lastStatus = res?.status || "pending";
      log(`poll #${pollCount} (${((Date.now() - startedAt) / 1000).toFixed(0)}s) status=${lastStatus}`);
      if (res?.error) throw new Error(res.error);
      if (onPoll) onPoll(lastStatus);
      if (lastStatus === "done") {
        if (!Array.isArray(res?.answers)) throw new Error("The helper returned no answers.");
        return res.answers;
      }
      if (lastStatus === "error") {
        throw new Error(res?.error || "The agent failed.");
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
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
    .batch-bar { display: none; align-items: center; gap: 8px; margin-top: 8px;
                 padding-top: 8px; border-top: 1px solid #e5e7eb;
                 font-size: 12px; color: #6b7280; }
    .batch-bar.show { display: flex; }
    .batch-bar a { color: #2563eb; font-weight: 600; cursor: pointer;
                   text-decoration: none; white-space: nowrap; }
    .batch-bar a:hover { text-decoration: underline; }
    .save-row { display: flex; align-items: center; gap: 8px; margin-top: 8px;
                padding-top: 8px; border-top: 1px solid #e5e7eb;
                font-size: 12px; color: #6b7280; }
    button.save { background: transparent; color: #374151; border: 1px solid #d1d5db;
                  border-radius: 8px; padding: 5px 10px; font-size: 12px;
                  font-weight: 600; cursor: pointer; white-space: nowrap; }
    button.save:hover:not(:disabled) { background: #f3f4f6; border-color: #9ca3af; }
    button.save:disabled { color: #9ca3af; cursor: default; }
    .save-note { font-size: 11px; color: #9ca3af; }
  `;

  function buildCard({ anchor, question }) {
    const host = document.createElement("div");
    host.className = "ih-card";
    host.style.cssText = "all: initial;";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>${CARD_CSS}</style>
      <div class="wrap">
        <div class="card">
          <div class="head">
            <span class="dot"></span><span class="title">Application Filler</span>
            <span class="spacer"></span>
            <button class="close" title="Close (Esc)" aria-label="Close">✕</button>
          </div>
          <label for="ih-q">Question</label>
          <textarea id="ih-q" rows="3" spellcheck="false"></textarea>
          <label for="ih-h">Hint <span class="opt">(optional)</span></label>
          <input id="ih-h" type="text" spellcheck="false"
                 placeholder="e.g. concise · emphasize leadership · 2 sentences" />
          <div class="row">
            <button class="gen">Add to batch</button>
            <span class="status"></span>
          </div>
          <div class="batch-bar">
            <span class="batch-count">0 in batch</span>
            <span class="spacer" style="flex:1"></span>
            <a class="gen-all" title="Run the agent over every queued field">Generate all</a>
          </div>
          <div class="save-row">
            <button class="save" title="Save this answer for the agent to reuse later">Save answer</button>
            <span class="save-note">stores your real wording for next time</span>
          </div>
          <div class="hint">Ctrl/⌘+Enter adds to batch · Esc closes</div>
        </div>
      </div>`;
    document.body.appendChild(host);

    const $ = (sel) => root.querySelector(sel);
    const qEl = $("textarea");
    const hEl = $("input");
    const btn = $("button.gen");
    const saveBtn = $("button.save");
    const statusEl = $(".status");
    const batchBar = $(".batch-bar");
    const batchCountEl = $(".batch-count");
    const genAllLink = $(".gen-all");
    qEl.value = question || "";

    let busy = false;
    const setStatus = (text, kind) => {
      statusEl.textContent = text || "";
      statusEl.className = "status" + (kind ? " " + kind : "");
    };

    // Save the user's answer as a reusable sample. Reads the field's LIVE value
    // at click time — so it captures whatever's in the field, whether typed by
    // hand or filled by the agent and then edited. The card's question field is
    // the question; the JD (if set in the toolbar) is included automatically.
    // Button is enabled whenever the field has content; no generation needed.
    async function saveAnswer() {
      if (busy) return;
      const answer = readAnswer(anchor);
      if (!answer) {
        toast("Field is empty — nothing to save.", "error");
        return;
      }
      const q = qEl.value.trim();
      if (!q) {
        toast("Enter the question first.", "error");
        qEl.focus();
        return;
      }
      const { jd = "" } = await getSettings();
      saveBtn.disabled = true;
      const oldText = saveBtn.textContent;
      saveBtn.textContent = "Saving…";
      try {
        const res = await browser.runtime.sendMessage({
          type: "SAVE_SAMPLE",
          question: q,
          answer,
          // Omit jd entirely when none is set — the server treats it as optional.
          ...(jd && jd.trim() ? { jd } : {}),
        });
        if (res?.error) throw new Error(res.error);
        toast(`Saved as sample ${res?.id || ""}`.trim());
        // Don't close — the user may save then keep editing or batch-add.
      } catch (e) {
        toast(e.message || "Save failed.", "error");
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = oldText;
      }
    }

    // Reflect the current batch size in the footer. The bar shows once ≥1 field
    // is queued; the count and the "Generate all (N)" label stay in sync.
    function refreshBatch() {
      const n = batch.length;
      batchCountEl.textContent = `${n} in batch`;
      genAllLink.textContent = n ? `Generate all (${n})` : "Generate all";
      batchBar.classList.toggle("show", n > 0);
    }
    refreshBatch();

    // Add the current field to the batch, then close the card. The user walks
    // field-by-field: focus next field, reopen, add again.
    function addToBatch() {
      if (busy) return;
      const q = qEl.value.trim();
      if (!q) {
        setStatus("Enter the question first.", "err");
        qEl.focus();
        return;
      }
      batch.push({
        id: "f" + idCounter++,
        element: anchor,
        question: q,
        hint: hEl.value.trim(),
        limit: (() => { try { return extractLimit(anchor); } catch { return null; } })(),
      });
      const n = batch.length;
      // The badge is best-effort UI — it must never break the core add flow.
      try { showBadge(anchor, "queued", n); } catch { /* badge is cosmetic */ }
      const limStr = batch[batch.length - 1].limit
        ? ` · ${batch[batch.length - 1].limit.value} ${batch[batch.length - 1].limit.unit} max`
        : "";
      toast(`Added (${n} field${n > 1 ? "s" : ""} in batch${limStr})`);
      refreshBatchChip();
      close();
    }

    btn.addEventListener("click", addToBatch);
    genAllLink.addEventListener("click", generateAll);
    saveBtn.addEventListener("click", saveAnswer);
    $("button.close").addEventListener("click", close);
    qEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        addToBatch();
      }
    });
    hEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        addToBatch();
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

  /* ---------------- per-field badge ---------------- */
  // A small fixed indicator pinned to the left of a batched field, showing its
  // state: queued (number) -> processing (spinner). Removed on done/error. Like
  // the card/chip/pill it lives in a Shadow DOM host so page CSS can't touch it.
  const BADGE_CSS = `
    .badge { position: fixed; z-index: 2147483645; display: flex; align-items: center;
             justify-content: center; font: 600 11px/1 -apple-system, system-ui, sans-serif;
             color: #fff; border-radius: 8px; padding: 3px 6px;
             box-shadow: 0 2px 8px rgba(15,23,42,.25); transition: background .15s; }
    .badge.queued { background: #3B82F6; min-width: 18px; }
    .badge.processing { background: #6b7280; }
    .spin { width: 11px; height: 11px; border: 2px solid rgba(255,255,255,.35);
            border-top-color: #fff; border-radius: 50%;
            animation: ih-badge-spin .7s linear infinite; display: inline-block; }
    @keyframes ih-badge-spin { to { transform: rotate(360deg); } }
  `;
  const badgeHosts = []; // { element, hostEl, badgeEl } — for scroll/resize repos
  function showBadge(element, state, num) {
    // Remove any existing badge on this element first.
    removeBadge(element);
    const host = document.createElement("div");
    host.style.cssText = "all: initial;";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${BADGE_CSS}</style><div class="badge queued"></div>`;
    const badgeEl = root.querySelector(".badge");
    document.body.appendChild(host);
    const entry = { element, hostEl: host, badgeEl };
    badgeHosts.push(entry);
    setBadgeState(element, state, num);
    positionBadge(entry);
    return entry;
  }
  function setBadgeState(element, state, num) {
    const entry = badgeHosts.find((b) => b.element === element);
    if (!entry) return;
    const { badgeEl } = entry;
    badgeEl.className = `badge ${state}`;
    if (state === "queued") {
      badgeEl.textContent = num != null ? String(num) : "✓";
    } else if (state === "processing") {
      badgeEl.innerHTML = `<span class="spin"></span>`;
    }
  }
  function removeBadge(element) {
    const idx = badgeHosts.findIndex((b) => b.element === element);
    if (idx === -1) return;
    badgeHosts[idx].hostEl.remove();
    badgeHosts.splice(idx, 1);
  }
  // Position the badge relative to its field. Wrapped so a positioning error
  // can NEVER abort the add-to-batch flow (that was the bug: an exception here
  // killed addToBatch before close() ran).
  function positionBadge(entry) {
    try {
      if (!document.contains(entry.element)) { removeBadge(entry.element); return; }
      const r = entry.element.getBoundingClientRect();
      entry.badgeEl.style.left = `${Math.max(4, r.left - 28)}px`;
      entry.badgeEl.style.top = `${r.top + Math.max(0, (r.height - 18) / 2)}px`;
    } catch {
      /* best effort — never abort the caller */
    }
  }
  function repositionAllBadges() { badgeHosts.forEach(positionBadge); }

  /* ---------------- persistent batch chip ---------------- */
  // The "Generate all" trigger must always be reachable, even after the card
  // closes on each add. This floating bottom-right chip shows whenever the
  // batch has ≥1 field, tracks the count live, and is the primary generate
  // trigger. Shadow DOM so the page can't style it.
  let batchChip = null;
  function ensureBatchChip() {
    if (batchChip && document.contains(batchChip.hostEl)) return;
    const host = document.createElement("div");
    host.style.cssText = "all: initial;";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        .chip { position: fixed; bottom: 24px; right: 24px;
                background: #3B82F6; color: #fff;
                font: 13px/1 -apple-system, system-ui, sans-serif;
                padding: 10px 14px; border-radius: 999px;
                box-shadow: 0 6px 20px rgba(15,23,42,.28);
                z-index: 2147483646; cursor: pointer;
                display: flex; align-items: center; gap: 8px;
                user-select: none; transition: background .15s; }
        .chip:hover { background: #2563eb; }
        .count { background: rgba(255,255,255,.25); padding: 3px 7px;
                 border-radius: 999px; font-weight: 700; font-size: 12px; }
      </style>
      <div class="chip" title="Run the agent over every queued field">
        <span class="label">Generate all</span><span class="count">0</span>
      </div>`;
    const chipEl = root.querySelector(".chip");
    const countEl = root.querySelector(".count");
    chipEl.addEventListener("click", generateAll);
    document.body.appendChild(host);
    batchChip = { hostEl: host, chipEl, countEl };
  }
  function refreshBatchChip() {
    const n = batch.length;
    if (n === 0) {
      if (batchChip) { batchChip.hostEl.remove(); batchChip = null; }
      return;
    }
    ensureBatchChip();
    batchChip.countEl.textContent = String(n);
  }

  /* ---------------- progress pill (shown during batch generation) ---------------- */
  // A small fixed bottom-center pill with a live elapsed counter, so the user
  // can see the agent is working across the (slow) batch run. Shadow DOM like
  // the toast so page CSS can't touch it.
  function showPill(initialText, { error = false } = {}) {
    const host = document.createElement("div");
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        .pill { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
                background: ${error ? "#7f1d1d" : "#111827"}; color: #fff;
                font: 13px/1.4 -apple-system, system-ui, sans-serif;
                padding: 10px 16px; border-radius: 999px;
                box-shadow: 0 6px 20px rgba(0,0,0,.3); z-index: 2147483647;
                max-width: 80vw; display: flex; align-items: center; gap: 8px; }
        .spin { width: 12px; height: 12px; border: 2px solid rgba(255,255,255,.3);
                border-top-color: #fff; border-radius: 50%;
                animation: ih-spin .8s linear infinite; }
        @keyframes ih-spin { to { transform: rotate(360deg); } }
      </style>
      <div class="pill"><span class="spin" style="display:none"></span><span class="txt"></span></div>`;
    const txtEl = root.querySelector(".txt");
    const spinEl = root.querySelector(".spin");
    txtEl.textContent = initialText;
    spinEl.style.display = error ? "none" : "inline-block";
    document.body.appendChild(host);
    let tick = null;
    const state = { startedAt: 0, prefix: "" };
    return {
      setText(text) { txtEl.textContent = text; },
      startCounter(startedAt, prefix) {
        state.startedAt = startedAt;
        state.prefix = prefix;
        tick = setInterval(() => {
          const s = Math.floor((Date.now() - state.startedAt) / 1000);
          txtEl.textContent = `${state.prefix} (${s}s)`;
        }, 1000);
      },
      setPrefix(prefix) { state.prefix = prefix; },
      stopCounter() { if (tick) { clearInterval(tick); tick = null; } },
      setError(text) { spinEl.style.display = "none"; host.querySelector(".pill").style.background = "#7f1d1d"; txtEl.textContent = text; },
      remove(delay = 0) {
        this.stopCounter();
        if (delay > 0) { setTimeout(() => host.remove(), delay); }
        else { host.remove(); }
      },
    };
  }

  /* ---------------- batch generation ---------------- */
  // Run the agent once over every queued field, then write each answer back
  // into its captured element. The pill reports progress; on error the batch is
  // kept so the user can retry without re-queuing.
  async function generateAll() {
    if (batch.length === 0) return;
    if (active) { active.close(); active = null; }

    const items = batch.map((b) => ({
      id: b.id,
      question: b.question,
      hint: b.hint,
      limit: b.limit || undefined,
    }));
    const n = batch.length;
    // Hide the batch chip while generating — the progress pill takes over.
    if (batchChip) batchChip.hostEl.style.display = "none";
    // Flip every field's badge to processing.
    batch.forEach((b) => setBadgeState(b.element, "processing"));

    const startedAt = Date.now();
    const prefix = `Filling ${n} field${n > 1 ? "s" : ""}…`;
    log(`generateAll start: ${n} field(s)`, batch.map((b) => ({ id: b.id, question: b.question.slice(0, 40) })));
    const pill = showPill(`${prefix} (0s)`);
    // The counter ticks every second; onPoll updates the prefix with the
    // server-side status (e.g. "running") so the user sees the agent's phase.
    pill.startCounter(startedAt, prefix);
    const phasePrefix = { running: `Researching + filling ${n} field${n > 1 ? "s" : ""}…` };

    try {
      const answers = await fetchAnswers(items, {
        onPoll: (status) => {
          if (phasePrefix[status]) pill.setPrefix(phasePrefix[status]);
        },
      });
      log("batch answers received:", answers.map((a) => ({ id: a.id, len: a.answer?.length || 0 })));
      const byId = new Map(answers.map((a) => [a.id, a.answer]));
      const expectedIds = batch.map((b) => b.id);
      const gotIds = answers.map((a) => a.id);
      const missing = expectedIds.filter((id) => !gotIds.includes(id));
      if (missing.length) logErr("answer ids missing from server:", missing, "got:", gotIds);
      let filled = 0;
      let skipped = 0;
      for (const entry of batch) {
        const answer = byId.get(entry.id);
        if (!answer || !answer.trim()) {
          logErr(`skip "${entry.id}": no answer text for this id`);
          skipped++;
          continue;
        }
        if (!document.contains(entry.element)) {
          logErr(`skip "${entry.id}": element no longer in DOM (page navigated/SPA re-rendered)`);
          skipped++;
          continue;
        }
        writeValue(entry.element, answer);
        filled++;
      }
      log(`batch done: ${filled} filled, ${skipped} skipped`);
      pill.stopCounter();
      let msg = `Done — filled ${filled} field${filled !== 1 ? "s" : ""}`;
      if (skipped) msg += ` (${skipped} skipped)`;
      pill.setText(msg);
      batch.forEach((b) => removeBadge(b.element)); // answers are in — clear badges
      batch = []; // success — clear the queue
      refreshBatchChip(); // chip stays hidden (batch empty)
      pill.remove(2500);
    } catch (e) {
      logErr("generateAll failed:", e.message || e);
      pill.setError(e.message || "Failed.");
      // Batch is kept so the user can retry — flip badges back to queued.
      batch.forEach((b, i) => setBadgeState(b.element, "queued", i + 1));
      if (batchChip) batchChip.hostEl.style.display = "";
      pill.remove(5000);
    }
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
    });
  }

  document.addEventListener(
    "focusin",
    (e) => {
      if (isEditable(e.target)) lastEditable = e.target;
    },
    true
  );
  // Keep field badges glued to their inputs while scrolling/resizing.
  window.addEventListener("scroll", repositionAllBadges, true);
  window.addEventListener("resize", repositionAllBadges);

  browser.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "OPEN_CARD") openCard();
  });
})();
