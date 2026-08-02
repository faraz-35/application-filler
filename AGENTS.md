# AGENTS.md

Guidance for AI agents working in this repo. Read this before editing anything.

## What this is

Two products in one repo that share a single invariant — **every output is
paste-ready into one form field, no preamble, no quotes, no fences** — but use
two completely different engines to produce it:

1. **Hotkey assistant** (macOS global hotkey) — a fast, dependency-free GLM API
   call. Copy a question, press a hotkey, a cursor-following spinner shows while
   the model thinks, then the answer is pasted into the focused field (and left
   on the clipboard). **Profile-based**: one codebase serves many activities,
   each profile is a folder of markdown context.
2. **Browser extension** (Firefox MV3) — an **agentic** form-filler. Focus a
   field, press `Ctrl+Shift+Y`, edit the auto-extracted question + optional hint,
   generate. The answer is written into the field via the DOM (no clipboard, no
   focus juggling). Grounded in a per-application **job description**. This path
   shells out to the **opencode CLI**, which runs as a real coding agent over
   `workspace/` — it reads `workspace/AGENTS.md` as the persona and invokes
   `workspace/skills/` for project detail. Slow (10s–minutes) but far more
   capable, and it can fill a whole form in one batch.

Current hotkey profiles:
- `⌘⌥J` → `interview` — fill job-application / interview fields (blue spinner)
- `⌘⌥P` → `parhako` — write on behalf of the Parhako startup (purple spinner)

The extension uses a single `workspace/` regardless of the profile selected in
its toolbar (the profile field is accepted for request-shape compatibility but
the agentic path ignores it). Multi-profile workspaces are a future enhancement.

## Two engines, one invariant

| | Hotkey / CLI path | Extension path |
|---|---|---|
| Entry | `src/answer.mjs` → `core.mjs` `answer()` | `extension/` → `src/server.mjs` → `src/agentic.mjs` |
| Brain | One GLM chat-completion call | **opencode CLI** subprocess (a real agent) |
| Reads | `contexts/<profile>/*.md` | **`workspace/AGENTS.md`** + invokes **`workspace/skills/`** |
| Auth | `ZAI_API_KEY` in `.env` | opencode's own global config (`~/.config/opencode`); `.env` key is NOT used |
| Speed | ~2s | 10s–minutes (single); minutes (whole-form batch) |
| Writes answer | `pbcopy` + Hammerspoon `⌘V` | DOM `value` setter + `input`/`change`/`blur` events |

**Do not assume changes to one engine affect the other.** Editing
`contexts/interview/system.md` changes the hotkey voice and does nothing to the
extension. Editing `workspace/AGENTS.md` changes the extension voice and does
nothing to the hotkey. They are separate persona/context trees.

## Architecture / data flow

### Hotkey path (GLM, fast)

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

### Extension path (opencode agent, capable)

```
focus field ─▶ [Ctrl+Shift+Y] ─▶ content.js opens inline card (Shadow DOM)
                                   │
                                   ├─ auto-extract question (label/placeholder/aria)
                                   ├─ background.js POSTs to local server
                                   │
              src/server.mjs (127.0.0.1:8775 only)
                  ├─ POST /answer         → answerAgentic() → single opencode run
                  ├─ POST /answer-batch   → createBatchJob() → runBatchJob() (fire-and-forget)
                  └─ GET  /answer-batch/<id>  → poll job file until status="done"
                                   │
              src/agentic.mjs
                  └─ spawn: opencode run --format json --dangerously-skip-permissions
                            --dir workspace/  <prompt>
                                   │
                                   ├─ opencode reads workspace/AGENTS.md (persona + rules)
                                   ├─ opencode invokes workspace/skills/* via skill tool
                                   ├─ (batch) opencode writes answers into .jobs/<id>.json
                                   └─ final text event = the answer
                                   │
              answer written back via DOM (value setter + synthetic events)
```

## Layout

```
src/
  core.mjs         HOTKEY engine: answer(question,{profile,hint,jd}) — loads profile,
                   builds prompt, one GLM call. Typed errors (ConfigError/InputError/ApiError).
  answer.mjs       HOTKEY CLI/clipboard adapter (pbpaste → answer → pbcopy).
                   This is what Hammerspoon spawns.
  agentic.mjs      EXTENSION engine: answerAgentic() + batch jobs. Shells out to opencode
                   over workspace/. Same typed-error contract as core.mjs so the server
                   maps errors identically. Manages .jobs/ job files.
  server.mjs       EXTENSION HTTP adapter (127.0.0.1 only). Routes /answer and
                   /answer-batch to agentic.mjs. NOT an adapter over core.mjs.

contexts/<profile>/     HOTKEY persona tree. system.md (required) + any *.md reference.
                        Loaded by core.mjs. Currently: interview/, parhako/.

workspace/              EXTENSION persona tree. opencode runs with this as --dir.
  AGENTS.md             the persona, voice, output rules, humanizing rules. Always loaded.
  cover-letters.md      editorial rules for cover-letter / long-form answers. Always loaded.
  skills/<name>/        invokable project knowledge. SKILL.md index + detail files.
                        parhako-com, parhako-net, parhako-mdcat, smodin, top-dev-space, freelance.
  .jobs/<id>.json       per-batch job files (gitignored). Agent writes answers here.

extension/              Firefox MV3 extension. Thin UI + transport; no brain.
  manifest.json         commands, host perms, content scripts.
  background.js         command → open card; proxies fetches to the server (a content-script
                       fetch would be blocked by the page's CSP).
  content.js            field detect, question extract, DOM write-back, inline card (Shadow DOM),
                       field word/char limit detection (passed to the agent).
  popup.html|js|css     toolbar: server status, profile select, JD paste+persist.

hammerspoon/init.lua     hotkey bindings + spinner + paste (dofile'd from ~/.hammerspoon/init.lua).
hammerspoon/run.log      runtime log (gitignored) — PRIMARY DEBUG OUTPUT for the hotkey path.

.env                     ZAI_API_KEY, ZAI_MODEL, ZAI_BASE_URL (gitignored) — HOTKEY path only.
.env.example             template.
```

## Conventions

- **ES modules only** (`.mjs`). `"type": "module"` in package.json.
- **Zero dependencies.** Use Node's native `fetch`, `node:fs`, `node:child_process`.
  Do not add npm packages without strong reason. (The opencode CLI is an external
  binary, not an npm dep.)
- **Two persona trees, kept separate.** Hotkey = `contexts/<profile>/`; extension =
  `workspace/`. Know which surface you're changing before you edit.
- **Profiles (hotkey) are data, not code.** To add a profile: `mkdir contexts/<name>`,
  add `system.md` (+ optional reference `*.md`), bind a hotkey in
  `hammerspoon/init.lua`. No source changes.
- **Skills (extension) are data, not code.** To add project knowledge for the
  extension: `mkdir workspace/skills/<name>`, add a `SKILL.md` index (with
  frontmatter `name` + `description`) + detail files, and list it in the
  "Available skills" section of `workspace/AGENTS.md`.
- **System prompt is split (both trees):** persona/voice lives in markdown
  (`contexts/<profile>/system.md` for hotkey; `workspace/AGENTS.md` for
  extension). Output + humanizing rules are appended: hardcoded `OUTPUT_RULES`
  and `humanizingRules()` in `core.mjs` for the hotkey; inline in
  `workspace/AGENTS.md` for the extension. Keep prompt/content edits in the
  markdown, not in the source.
- **`hint` steers answer style per-call; `jd` grounds the answer in a specific
  job description per-application.** Both are optional on both paths. The
  extension also sends a per-field `limit` ({value, unit}) detected from the
  form — it's a HARD CEILING the form enforces, never a target.
- **Thinking is OFF by default** on the hotkey path (avoids 200–700 hidden
  tokens/call). `ZAI_THINKING=1` re-enables. Preserve this default. The extension
  path has no thinking toggle — opencode's model config is its own.
- **Output must be paste-ready into a single field** — that invariant is the
  whole product. Don't break it with formatting/labels.
- **Secrets stay in `.env`** (gitignored). Never hardcode keys. Note the
  extension path does not use `.env` at all — opencode authenticates via its
  own global config.

## Commands

```sh
# Hotkey path
npm run answer                                  # run interview profile, reads clipboard
node --env-file=.env src/answer.mjs parhako     # run a specific profile

# Extension path (keep running while using the extension)
npm run server                                  # local helper on http://127.0.0.1:8775 (HELPER_PORT to override)
                                                # NOTE: launchd usually keeps this running for you — see below.
```

### Extension server auto-start (launchd)

`com.faraz.application-filler.plist` (checked in) runs the server as a
**LaunchAgent** that starts at login and auto-restarts on crash/exit
(`KeepAlive`). It is symlinked into `~/Library/LaunchAgents/`. So in normal use
you do NOT need `npm run server` — the helper is already up at
`http://127.0.0.1:8775`. Verify with `curl http://127.0.0.1:8775/health`.

```sh
launchctl load   ~/Library/LaunchAgents/com.faraz.application-filler.plist   # install/start
launchctl unload ~/Library/LaunchAgents/com.faraz.application-filler.plist   # stop + disable
tail -f logs/launchd.out.log logs/launchd.err.log                          # launchd's own log
```

Notes:
- It calls `/Users/farazshah/.local/bin/node` directly because launchd starts
  processes with a near-empty `PATH`. `PATH` is also set explicitly so opencode
  resolves if it ever falls back to PATH lookup.
- The `ThrottleInterval` (10s) guards against a tight restart loop if the server
  fails fast (e.g. port already taken). `npm run server` still works for a
  manual foreground run, but launchd will fight you for the port — unload first.

There is **no linter, typecheck, or test suite** configured. Verify changes by:
1. **Hotkey:** `npm run answer` with a question on the clipboard — expect a
   clean answer on stdout and the clipboard.
2. **Server:** `npm run server`, then `curl http://127.0.0.1:8775/health`
   (→ `{"ok":true}`) and `/profiles` (→ `{"profiles":[...]}`). Then exercise
   the agentic path: `curl -X POST http://127.0.0.1:8775/answer -H
   'Content-Type: application/json' -d '{"question":"What is your Node experience?"}'`
   — slow (10s+), returns `{"answer":"..."}`. Requires opencode on PATH
   (`~/.opencode/bin`) or `OPENCODE_BIN` set. Server logs errors to its console
   and to `server.log`.
3. **Hotkey changes:** reload Hammerspoon and check `hammerspoon/run.log`.
4. **Extension changes:** reload in `about:debugging#/runtime/this-firefox`.

## Browser extension (Firefox)

Use it instead of the hotkey when answering questions in a browser form: focus
the field, press `Ctrl+Shift+Y`, edit the auto-extracted question + optional
hint, generate — the answer is written into the field directly (no clipboard,
no focus juggling). It must talk to the local server, so:

```sh
npm run server          # keep this running while using the extension
```

**Load (temporary):** `about:debugging#/runtime/this-firefox` → *This Firefox* →
*Load Temporary Add-on* → pick `extension/manifest.json`.

**Use:**
1. Click a job-application form field (textarea/input/contenteditable).
2. `Ctrl+Shift+Y` → the inline card opens under it.
3. The question is auto-extracted (label/placeholder/aria) and editable; the
   field's word/char limit is detected and passed to the agent. Type an optional
   hint, then Generate (or Ctrl/⌘+Enter). Answer is inserted; Regenerate retries.
   Esc closes.
4. Click the toolbar icon to set the **profile** (currently advisory — see
   "Two engines" note) and paste the **job description** (persisted in
   `storage.local`, attached to every answer until changed).

**Rebind the shortcut:** `about:addons` → gear → *Manage Extension Shortcuts*.

**Field write-back note:** `content.js` uses the native `value` setter + dispatches
`input`/`change`/`blur` so React/Vue (Greenhouse, Lever) register the value. If a
site doesn't, the framework-specific event is the place to look.

**Why background.js proxies fetches:** in Firefox a content-script fetch is
treated as coming from the page, so the page's CSP can block the call to
`127.0.0.1`. A background fetch runs in the extension's own context with full
host permissions, so it just works.

**Why batch uses polling:** a whole-form run takes minutes, which exceeds what a
single HTTP request (and a Firefox MV3 background page) can survive. So
`/answer-batch` POSTs the fields, gets a `jobId` back instantly, and the client
polls `GET /answer-batch/<jobId>` every few seconds until `status === "done"`.
Each poll is a short file read.

## Editing guide

| Change | Where |
|---|---|
| New hotkey activity/persona | `mkdir contexts/<name>` + `system.md`, bind hotkey in `hammerspoon/init.lua` |
| Hotkeys / spinner colors | `hammerspoon/init.lua` (one `runProfile` call per profile) |
| Hotkey model / endpoint / key | `.env` (`ZAI_MODEL`, `ZAI_BASE_URL`, `ZAI_API_KEY`) |
| Hotkey prompt voice for a profile | that profile's `system.md` |
| Hotkey global output rules | `src/core.mjs` `OUTPUT_RULES` constant |
| Extension persona / voice | `workspace/AGENTS.md` |
| Extension output / humanizing rules | `workspace/AGENTS.md` |
| Extension cover-letter / long-form rules | `workspace/cover-letters.md` |
| New project knowledge for the extension | `mkdir workspace/skills/<name>` + `SKILL.md` (+ detail files), list it in `workspace/AGENTS.md` |
| opencode binary / model | `OPENCODE_BIN` env, or opencode's own global config (`~/.config/opencode`) |
| Server port | `HELPER_PORT` env (default `8775`) |
| Extension shortcut | `extension/manifest.json` `commands` → reload in `about:debugging` |
| Extension card UI / field detection / limit detection | `extension/content.js` |
| How answers are transported (CSP-safe fetch, polling) | `extension/background.js` |

## Debug

### Hotkey path
Hammerspoon Lua errors do NOT surface in the macOS unified log. Always read
`hammerspoon/run.log` after a hotkey press:
- No `=== hotkey pressed ===` → hotkey not bound / key conflict.
- `exitCode≠0` → node script failed (see `err=`; usually API/key/clipboard).
- `paste failed:` → Accessibility not granted, or focus lost mid-run.
- No `LOADED config` line at startup → `init.lua` not loading at all.

### Extension path
- `npm run server` not running → card shows "Can't reach the helper at
  127.0.0.1:8775". Start it.
- Startup line warns "opencode binary not found" → `/answer` and `/answer-batch`
  will fail. Put opencode on PATH (`~/.opencode/bin`) or set `OPENCODE_BIN`.
- `server.log` records every request with sizes and elapsed time
  (`POST /answer profile=… q=…c hint=…c jd=…c limit=…`) — the way to confirm the
  extension is sending hint/jd/limit with each call.
- Batch job files in `workspace/.jobs/<id>.json` hold the full request and the
  agent's filled answers — inspect these when a batch misbehaves. Status:
  `pending` → `running` → `done` | `error`.
- opencode's own reasoning isn't captured here; if the answer content is wrong,
  the cause is usually in `workspace/AGENTS.md` rules or the skill content, not
  the transport.

### README divergence
`README.md` predates the agentic extension path and still describes the extension
as a thin UI over the GLM brain. Treat this `AGENTS.md` as the source of truth;
update the README when user-facing accuracy matters.
