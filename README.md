# interview-helper

AI helper that fills job-interview form fields from a global hotkey.

**Workflow:** copy a question from any form → press `⌘⌥J` → the answer is
generated from your context files, placed on the clipboard, and pasted into
the field that has focus.

## Architecture

```
copy question ──▶ [⌘⌥J] ──▶ Hammerspoon runs src/answer.mjs
                                │
                                ├─ pbpaste  → read the question
                                ├─ read context/*.md → your background
                                ├─ call Z.AI GLM → answer
                                ├─ pbcopy  → answer now on clipboard ✓
                                └─ (Hammerspoon) simulate ⌘V → pasted into field ✓
```

No dependencies — uses Node's native `fetch`. Your API key stays local in `.env`.

## Setup

### 1. Add your key
```sh
cd /Users/farazshah/Programming/interview-helper
cp .env.example .env
# then edit .env and paste your ZAI_API_KEY
```

### 2. Fill in your context
Edit the files in `context/` — they're the "skill" the AI uses:
- `about-me.md` — who you are
- `voice.md` — how the AI should write
- `experience.md` — your work history, STAR stories, stack

Add as many extra `.md` files as you like; every file in `context/` is loaded.
Changes take effect on the next hotkey press — no rebuild.

### 3. Install Hammerspoon
```sh
brew install --cask hammerspoon
open -a Hammerspoon
```

### 4. Grant Accessibility
Hammerspoon needs this to read the clipboard and paste into other apps:
**System Settings → Privacy & Security → Accessibility → enable Hammerspoon**

### 5. Load this project's config
Hammerspoon's config lives at `~/.hammerspoon/init.lua`. Add this one line
(create the file if it doesn't exist):
```lua
dofile("/Users/farazshah/Programming/interview-helper/hammerspoon/init.lua")
```
Then reload: click the Hammerspoon menu-bar icon → **Reload Config**
(or press `⌃⌥⌘R`).

## Test without the hotkey first
Copy a question, then run:
```sh
npm run answer
```
The answer prints to the terminal and is on the clipboard — paste with `⌘V` to
verify. Once that works, the hotkey will do the paste for you.

## Usage
1. Open any job application form (browser, native app, anything).
2. Select and copy the question text (`⌘C`).
3. Click the input field you want filled.
4. Press `⌘⌥J`. Wait ~2s — the answer appears in the field.

## Customize
- **Hotkey:** edit `hammerspoon/init.lua` — change `{"cmd","alt"}, "j"`.
- **Model:** edit `.env` (`ZAI_MODEL`). Try `glm-4-flash` for speed.
- **Prompt rules:** edit `src/answer.mjs` (the `system` message).
- **Per-form context:** drop another `.md` in `context/` and delete it when done.
