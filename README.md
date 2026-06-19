# interview-helper

AI helper that fills form fields from global hotkeys. Each hotkey loads its own
**profile** — a folder of markdown context — so one codebase serves many
activities.

| Hotkey | Profile | Use |
|---|---|---|
| `⌘⌥J` | `interview` | Fill job-application / interview fields (blue spinner) |
| `⌘⌥P` | `parhako` | Write on behalf of the Parhako startup (purple spinner) |

**Workflow:** copy a question from any field → press the hotkey → a spinner
follows your cursor while GLM thinks → the answer is pasted into the focused
field (and left on the clipboard).

## Architecture

```
copy question ──▶ [⌘⌥J / ⌘⌥P] ──▶ Hammerspoon runs: node src/answer.mjs <profile>
                                       │
                                       ├─ pbpaste              → the question
                                       ├─ read contexts/<profile>/*.md
                                       │     system.md = role + instructions
                                       │     other *.md = reference context
                                       ├─ call Z.AI GLM        → answer
                                       ├─ pbcopy               → on clipboard ✓
                                       └─ (Hammerspoon) ⌘V     → pasted into field ✓
```

No dependencies — uses Node's native `fetch`. Your API key stays local in `.env`.

## Setup

### 1. Add your key
```sh
cd /Users/farazshah/Programming/interview-helper
cp .env.example .env
# then edit .env and paste your ZAI_API_KEY
```

### 2. Fill in profile context
Each profile is a directory under `contexts/`. A profile has:
- `system.md` — the role + instructions (required)
- any number of other `*.md` files — reference material (loaded alphabetically)

```
contexts/
  interview/   system.md  about-me.md  experience.md  voice.md
  parhako/     system.md  product.md   brand.md
```

Edit the markdown freely — changes take effect on the next hotkey press, no rebuild.

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
Then reload: click the Hammerspoon menu-bar icon → **Reload Config** (or `⌃⌥⌘R`).

## Test without the hotkey
Copy a question, then run with a profile name:
```sh
npm run answer           # defaults to "interview"
node --env-file=.env src/answer.mjs parhako
```
The answer prints to the terminal and is on the clipboard — paste with `⌘V`.

## Usage
1. Open any form (browser, native app, anything).
2. Select and copy the question text (`⌘C`).
3. Click the input field you want filled.
4. Press `⌘⌥J` (interview) or `⌘⌥P` (parhako). Wait ~2s — the answer appears.

## Add a new profile
1. `mkdir contexts/<name>` and add a `system.md` (plus any reference `.md`).
2. Bind a hotkey in `hammerspoon/init.lua`:
   ```lua
   hs.hotkey.bind({ "cmd", "alt" }, "x", function() runProfile("<name>", "#10B981") end)
   ```
3. Reload Hammerspoon. Done — no other code changes.

## Customize
- **Hotkeys / spinner colors:** `hammerspoon/init.lua` (one `runProfile` call per profile).
- **Model:** `.env` `ZAI_MODEL`. Recommended `glm-4.5-air` (fast + cheap). Alt `glm-4.6` (best quality). Avoid reasoning defaults — `thinking` is disabled in `answer.mjs` for speed; set `ZAI_THINKING=1` to re-enable per-call.
- **Prompt rules:** edit the profile's `system.md` (not source code).

## Debug
Hammerspoon Lua errors don't show in the macOS unified log — always check
`hammerspoon/run.log` after a hotkey press:
- No `=== hotkey pressed ===` line → hotkey not bound / key conflict.
- `exitCode≠0` → node script failed (check `err=`; likely API/key/clipboard).
- `paste failed:` → Accessibility not effective, or focus lost.
