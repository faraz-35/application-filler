// Background event page: turns the keyboard command into a message to the active
// tab's content script. The content script owns all field detection + UI.
// (Content scripts don't receive the `commands` event directly.)

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
