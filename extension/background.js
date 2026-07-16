// Background event page. Three jobs:
//  1. Keyboard command → tell the active tab's content script to open the card
//     (injecting content.js on demand if the tab predates the last reload —
//     otherwise sendMessage throws "Receiving end does not exist").
//  2. Fetch a single answer ON BEHALF of content scripts (message "ANSWER").
//  3. Fetch a whole batch ON BEHALF of content scripts (message "ANSWER_BATCH").
//
// (2) and (3) live here, not in content.js, on purpose: in Firefox a
// content-script fetch is treated as coming from the web page, so the page's
// CSP can block the call to 127.0.0.1 (this is the "NetworkError" you'd
// otherwise hit). A background fetch runs in the extension's own context with
// full host permissions, so it just works.

const SERVER = "http://127.0.0.1:8775";

// The single-answer path (/answer) is one long fetch (~30-90s). The batch path
// avoids long fetches entirely via polling (POST returns instantly, then short
// GET polls), so this timeout only bounds the single path. 10 min is a hard
// ceiling to catch a dead process.
const ANSWER_TIMEOUT_MS = 600000; // 10 minutes

// POST to the server with a hard timeout. Always resolves to the parsed JSON
// body (or throws on network/abort/timeout). The caller maps the result.
async function postJson(path, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ANSWER_TIMEOUT_MS);
  try {
    const res = await fetch(`${SERVER}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    let data = {};
    try {
      data = await res.json();
    } catch {
      /* non-JSON response handled below */
    }
    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

// Map an exception from postJson to a human-readable error string.
function messageForError(e, { batch = false } = {}) {
  if (e?.name === "AbortError") {
    return batch
      ? "The agent took too long (over 10 minutes). Try fewer fields or simplify them."
      : "The agent took too long (over 10 minutes). Try again or simplify the question.";
  }
  if (/network|failed to fetch/i.test(e?.message || "")) {
    return `Can't reach the helper at ${SERVER}. Is "npm run server" running?`;
  }
  return e?.message || "Request failed.";
}

browser.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "ANSWER") {
    return (async () => {
      try {
        const { ok, status, data } = await postJson("/answer", {
          question: msg.question,
          hint: msg.hint,
          jd: msg.jd,
          profile: msg.profile,
        });
        if (!ok) return { error: data.error || `Helper error (HTTP ${status}).` };
        if (!data.answer) return { error: "The helper returned no answer." };
        return { answer: data.answer };
      } catch (e) {
        return { error: messageForError(e) };
      }
    })();
  }

  if (msg?.type === "ANSWER_BATCH_START") {
    return (async () => {
      try {
        const { ok, status, data } = await postJson("/answer-batch", {
          items: msg.items,
          jd: msg.jd,
        });
        if (!ok) return { error: data.error || `Helper error (HTTP ${status}).` };
        if (!data.jobId) return { error: "The helper returned no job id." };
        return { jobId: data.jobId };
      } catch (e) {
        return { error: messageForError(e, { batch: true }) };
      }
    })();
  }

  if (msg?.type === "ANSWER_BATCH_POLL") {
    return (async () => {
      try {
        const res = await fetch(`${SERVER}/answer-batch/${msg.jobId}`, { signal: AbortSignal.timeout(30000) });
        let data = {};
        try { data = await res.json(); } catch { /* non-JSON */ }
        if (!res.ok) return { error: data.error || `Helper error (HTTP ${res.status}).` };
        return data; // { status, answers?, error? }
      } catch (e) {
        return { error: messageForError(e, { batch: true }) };
      }
    })();
  }

  return undefined;
});

// On-demand content-script injection. Tabs that were already open when the
// extension was (re)loaded never received content.js, so sendMessage to them
// throws "Could not establish connection. Receiving end does not exist."
// Injecting here (guarded by the script's own __ihInjected flag) fixes that.
async function ensureContentScript(tabId) {
  try {
    await browser.tabs.sendMessage(tabId, { type: "OPEN_CARD" });
  } catch {
    // No listener — inject content.js, wait for it, then retry once.
    try {
      await browser.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
      await browser.tabs.sendMessage(tabId, { type: "OPEN_CARD" });
    } catch {
      /* privileged page (about:*, addons store, pdf.js) — nothing to do */
    }
  }
}

browser.commands.onCommand.addListener(async (cmd) => {
  if (cmd !== "open-answer-card") return;

  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.id) return;

  await ensureContentScript(tab.id);
});
