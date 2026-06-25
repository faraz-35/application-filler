# AGENTS.md

Guidance for AI agents working in this repo.

## What this is

A macOS global-hotkey AI helper that fills form fields. You copy a question,
press a hotkey, a cursor-following spinner shows while the model thinks, then the
answer is pasted into the focused field (and left on the clipboard). It is
**profile-based**: one codebase serves many activities, each profile is a folder
of markdown context.

Current profiles:
- `⌘⌥J` → `interview` — fill job-application / interview fields (blue spinner)
- `⌘⌥P` → `parhako` — write on behalf of the Parhako startup (purple spinner)

## Architecture / data flow

```
copy question ─▶ [hotkey] ─▶ Hammerspoon runs: node src/answer.mjs <profile>
                                   │
                                   ├─ pbpaste           → the question
                                   ├─ read contexts/<profile>/*.md
                                   │     system.md  = role + instructions (required)
                                   │     other *.md = reference context (alphabetical)
                                   ├─ POST Z.AI GLM    → answer
                                   ├─ pbcopy           → answer on clipboard
                                   └─ Hammerspoon ⌘V   → pasted into focused field
```

The brain lives in one place; everything else is a thin adapter over it:
- `src/core.mjs` — the engine (no deps). Exposes `answer(question, { profile, hint, jd })`:
  loads the profile, builds the prompt, calls GLM, returns the answer string. Throws
  typed errors (`ConfigError` / `InputError` / `ApiError`) so callers can map them.
- `src/answer.mjs` — CLI/clipboard adapter over `answer()`. Reads `pbpaste`, writes
  `pbcopy`. This is what the Hammerspoon hotkey runs.
- `src/server.mjs` — local HTTP adapter over `answer()`, bound to `127.0.0.1` only.
  Exposes `POST /answer` + `GET /health` for the browser extension (keeps the API key
  out of the browser).
- `hammerspoon/init.lua` — binds hotkeys, draws the spinner, spawns node, then
  simulates the paste. Wires profiles to hotkey+color via `runProfile(name, color)`.

## Layout

```
src/core.mjs              the engine: answer(question,{profile,hint,jd}) — profile, prompt, GLM call
src/answer.mjs            CLI/clipboard adapter over core (pbpaste → answer → pbcopy)
src/server.mjs            local HTTP adapter over core (127.0.0.1 only) for the browser extension
hammerspoon/init.lua       hotkey bindings + spinner + paste (dofile'd from ~/.hammerspoon/init.lua)
hammerspoon/run.log        runtime log (gitignored) — PRIMARY DEBUG OUTPUT
contexts/<profile>/        one folder per profile: system.md + any *.md reference
.env                       ZAI_API_KEY, ZAI_MODEL, ZAI_BASE_URL (gitignored)
.env.example               template
```

## Conventions

- **ES modules only** (`.mjs`). `"type": "module"` in package.json.
- **Zero dependencies.** Use Node's native `fetch`, `node:fs`, `node:child_process`.
  Do not add npm packages without strong reason.
- **Profiles are data, not code.** To add a profile: `mkdir contexts/<name>`,
  add `system.md` (+ optional reference `*.md`), bind a hotkey in
  `hammerspoon/init.lua`. No source changes needed.
- **System prompt is split:** the profile's `system.md` defines the role/voice;
  `core.mjs` appends hardcoded OUTPUT RULES (paste-ready, no preamble, no
  quotes/fences, honest if reference lacks the answer). Keep prompt/content
  edits in the markdown, not in the source.
- **The brain is one function:** all logic flows through `answer()` in `core.mjs`.
  `hint` steers answer style per-call; `jd` grounds the answer in a specific job
  description per-application. Both are optional and only augment the prompt.
- **Thinking is OFF by default** for speed (avoids 200-700 hidden tokens/call).
  `ZAI_THINKING=1` re-enables. Preserve this default.
- **Output must be paste-ready into a single field** — that invariant is the
  whole product. Don't break it with formatting/labels.
- **Secrets stay in `.env`** (gitignored). Never hardcode keys.

## Commands

```sh
npm run answer                          # run interview profile, reads clipboard
node --env-file=.env src/answer.mjs parhako   # run a specific profile
npm run server                          # local helper on http://127.0.0.1:7437 (HELPER_PORT to override)
```

There is **no linter, typecheck, or test suite** configured. Verify changes by:
1. Running `npm run answer` with a question on the clipboard — expect a clean
   answer on stdout and the clipboard.
2. After hotkey changes, reload Hammerspoon and check `hammerspoon/run.log`.

## Editing guide

| Change | Where |
|---|---|
| New activity/persona | `mkdir contexts/<name>` + `system.md`, bind hotkey in `hammerspoon/init.lua` |
| Hotkeys / spinner colors | `hammerspoon/init.lua` (one `runProfile` call per profile) |
| Model / endpoint / key | `.env` (`ZAI_MODEL`, `ZAI_BASE_URL`, `ZAI_API_KEY`) |
| Prompt voice/rules for a profile | that profile's `system.md` |
| Global output rules | `src/core.mjs` `OUTPUT_RULES` constant |
| Server port | `HELPER_PORT` env (default `7437`) |

## Debug

Hammerspoon Lua errors do NOT surface in the macOS unified log. Always read
`hammerspoon/run.log` after a hotkey press:
- No `=== hotkey pressed ===` → hotkey not bound / key conflict.
- `exitCode≠0` → node script failed (see `err=`; usually API/key/clipboard).
- `paste failed:` → Accessibility not granted, or focus lost mid-run.
- No `LOADED config` line at startup → `init.lua` not loading at all.
