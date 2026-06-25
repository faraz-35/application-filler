// CLI entry: read the question from the clipboard, get an answer, put it back on
// the clipboard. Hammerspoon runs `node src/answer.mjs <profile>` on the hotkey.
//
// All thinking lives in src/core.mjs (answer()). This file is only the clipboard
// adapter plus user-facing error handling — no API/prompt logic here.
//
// Usage:  npm run answer           -> interview profile
//         node --env-file=.env src/answer.mjs parhako

import { execSync } from "node:child_process";
import { answer, ConfigError, InputError, ApiError } from "./core.mjs";

function readClipboard() {
  return execSync("pbpaste", { encoding: "utf8" }).trim();
}

function writeClipboard(text) {
  execSync("pbcopy", { input: text });
}

const profile = process.argv[2] || "interview";

try {
  const question = readClipboard();
  if (!question) {
    console.error("Clipboard is empty. Copy the question first, then hit the hotkey.");
    process.exit(1);
  }

  const result = await answer(question, { profile });

  // Hammerspoon simulates ⌘V after we exit; the answer must be on the clipboard.
  writeClipboard(result);
  console.log(result);
} catch (err) {
  // core throws typed errors with ready-to-read messages.
  if (err instanceof ConfigError || err instanceof InputError || err instanceof ApiError) {
    console.error(err.message);
  } else {
    console.error("Unexpected error:", err);
  }
  process.exit(1);
}
