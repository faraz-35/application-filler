// Background event page. Two jobs:
//  1. Keyboard command → tell the active tab's content script to open the card.
//  2. Fetch the helper brain ON BEHALF of content scripts (message "ANSWER").
//
// (2) lives here, not in content.js, on purpose: in Firefox a content-script
// fetch is treated as coming from the web page, so the page's CSP can block the
// call to 127.0.0.1 (this is the "NetworkError" you'd otherwise hit). A background
// fetch runs in the extension's own context with full host permissions, so it just
// works.

const SERVER = "http://127.0.0.1:8775";

// Fetch the brain for a content script. Always resolves to { answer } or { error }
// (never rejects) so the caller doesn't have to parse serialized exceptions.
browser.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== "ANSWER") return;

  return (async () => {
    try {
      const res = await fetch(`${SERVER}/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: msg.question,
          hint: msg.hint,
          jd: msg.jd,
          profile: msg.profile,
        }),
      });

      let data = {};
      try {
        data = await res.json();
      } catch {
        /* non-JSON response handled below */
      }
      if (!res.ok) {
        return { error: data.error || `Helper error (HTTP ${res.status}).` };
      }
      if (!data.answer) return { error: "The helper returned no answer." };
      return { answer: data.answer };
    } catch (e) {
      const text =
        /network|failed to fetch/i.test(e?.message || "")
          ? `Can't reach the helper at ${SERVER}. Is "npm run server" running?`
          : e?.message || "Request failed.";
      return { error: text };
    }
  })();
});

browser.commands.onCommand.addListener(async (cmd) => {
  if (cmd !== "open-answer-card") return;

  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.id) return;

  // sendMessage throws if no content script is listening (privileged pages like
  // about:*, the extension store, pdf.js). Swallow those — nothing to do there.
  try {
    await browser.tabs.sendMessage(tab.id, { type: "OPEN_CARD" });
  } catch {
    /* no content script on this page */
  }
});
