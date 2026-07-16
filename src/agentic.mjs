// Agentic engine for the browser extension path. Instead of a single GLM call,
// this shells out to the opencode CLI, which runs as an agent over the
// workspace/ directory: it reads workspace/AGENTS.md as the persona, discovers
// workspace/skills/ via the skill tool, and answers grounded in Faraz's
// project knowledge.
//
// Pattern ported from remote-job-radar/vetting/llm.py: opencode emits a
// newline-delimited JSON event stream on stdout; we keep only the
// {"type":"text","part":{"text":"..."}} events and return the last one.
//
// Reuses the typed errors from core.mjs so the server maps them to the same
// HTTP statuses. The hotkey/CLI path (core.mjs answer()) is untouched — this
// module is the extension-only adapter.
//
// Auth: opencode manages its own provider/credentials via its global config
// (~/.config/opencode). The ZAI_API_KEY in .env is NOT used here — it stays
// for the hotkey path only.

import { spawn } from "node:child_process";
import {
  existsSync,
  accessSync,
  constants,
  writeFileSync,
  readFileSync,
  mkdirSync,
  unlinkSync,
  renameSync,
} from "node:fs";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError, InputError, ApiError } from "./core.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
// The agent runs with workspace/ as its project root: it reads
// workspace/AGENTS.md and discovers workspace/skills/.
const workspaceDir = join(__dirname, "..", "workspace");

// Per-batch job files live here (gitignored). The server writes a skeleton
// {fields:[{question,answer:""}]}, the agent fills `answer` for each and
// writes the file back, then we read it back to collect the answers.
export const jobsDir = join(workspaceDir, ".jobs");
try {
  mkdirSync(jobsDir, { recursive: true });
} catch {
  /* workspace may be read-only in odd setups; surface a real error at call time */
}

// ---- Binary resolution ----
// Resolution order (mirrors remote-job-radar's VETTING_OPENCODE_BIN):
//   1. OPENCODE_BIN env var (absolute path)
//   2. `opencode` on PATH (checked via the common install locations)
//   3. ~/.opencode/bin/opencode (the default installer location)
// Throws ConfigError when check_only=false and nothing is found.
export function resolveBinary({ checkOnly = false } = {}) {
  const envBin = process.env.OPENCODE_BIN;
  if (envBin) {
    if (isExecutable(envBin)) return envBin;
    if (!checkOnly) {
      throw new ConfigError(`OPENCODE_BIN=${envBin} is not an executable file`);
    }
    return null;
  }

  // The installer puts it here; common across setups.
  const defaultBin = join(homedir(), ".opencode", "bin", "opencode");
  if (isExecutable(defaultBin)) return defaultBin;

  // Fall back to hoping it's on PATH — spawn will ENOENT if not, mapped below.
  if (existsSync(defaultBin) || checkOnly) {
    // If we're just checking, be honest: we can't fully verify PATH resolution
    // without spawning, so only report the known location.
    if (checkOnly) return existsSync(defaultBin) ? defaultBin : null;
  }
  return "opencode";
}

function isExecutable(p) {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Best-effort availability check for the startup log line. */
export function isAvailable() {
  const envBin = process.env.OPENCODE_BIN;
  if (envBin && isExecutable(envBin)) return true;
  const defaultBin = join(homedir(), ".opencode", "bin", "opencode");
  return existsSync(defaultBin);
}

// ---- opencode subprocess ----
// Runs `opencode run --format json --dangerously-skip-permissions --dir <workspace> <prompt>`,
// collects stdout, and enforces a timeout. Resolves with the raw stdout string.
// --dangerously-skip-permissions keeps the call non-interactive (no permission
// prompts blocking the subprocess); the workspace contains only markdown, and
// the agent is instructed (in workspace/AGENTS.md) to be read-only.
export function runOpencode(prompt, { dir = workspaceDir, timeout = 120000 } = {}) {
  const binary = resolveBinary();

  return new Promise((resolve, reject) => {
    const args = [
      "run",
      "--format", "json",
      "--dangerously-skip-permissions",
      "--dir", dir,
      prompt,
    ];
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new ApiError(`opencode timed out after ${timeout / 1000}s`));
    }, timeout);

    child.on("error", (err) => {
      clearTimeout(timer);
      // ENOENT = binary not found on PATH.
      if (err.code === "ENOENT") {
        reject(new ConfigError(
          "opencode binary not found. Set OPENCODE_BIN to its path, or add " +
          "~/.opencode/bin to PATH."
        ));
      } else {
        reject(new ApiError(`Failed to spawn opencode: ${err.message}`));
      }
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const tail = (stderr || "").trim().split("\n").slice(-1)[0];
        reject(new ApiError(
          `opencode exited ${code}: ${tail || "no stderr"}`
        ));
        return;
      }
      resolve(stdout);
    });
  });
}

// ---- NDJSON stream parsing ----
// The stream contains events like {"type":"step_start",...},
// {"type":"text","part":{"type":"text","text":"..."}}, {"type":"step_finish",...}.
// We keep only the type:"text" events and return the final one's text — that's
// the model's last answer to the user.
export function extractFinalText(stdout) {
  const texts = [];
  for (const raw of (stdout || "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue; // non-JSON line (e.g. a stray log) — skip
    }
    if (event?.type !== "text") continue;
    const part = event.part || {};
    if (part.type === "text" && typeof part.text === "string" && part.text) {
      texts.push(part.text);
    }
  }
  return texts.length ? texts[texts.length - 1] : "";
}

// ---- Prompt assembly ----
// The persona + output/humanizing rules live in workspace/AGENTS.md (read by
// opencode as the project root instructions). This function only builds the
// per-call user message: the question, plus optional jd/hint.
function buildMessage(question, { hint, jd } = {}) {
  const blocks = [`QUESTION (from a job application form):\n${question}`];

  if (jd && jd.trim()) {
    blocks.push(
      `JOB DESCRIPTION (the role being applied for — tailor the answer to it):\n${jd.trim()}`
    );
  }
  if (hint && hint.trim()) {
    blocks.push(`ANSWER DIRECTION (the user's steer for this specific answer):\n${hint.trim()}`);
  }

  blocks.push(
    "For questions about specific projects or experience, invoke the relevant " +
      "skill(s) via the skill tool FIRST, read them, then answer. The skills are " +
      "your only source of project detail — do not invent. Output ONLY the " +
      "paste-ready answer, nothing else."
  );

  return blocks.join("\n\n---\n\n");
}

// ---- The single entry point ----
// Returns the answer string. Throws ConfigError / InputError / ApiError.
// Mirrors core.mjs answer()'s contract so server.mjs maps errors identically.
export async function answerAgentic(question, opts = {}) {
  // Default 10 min to match the batch path and the client ceiling. A single
  // skill-grounded answer can exceed 2 min (runOpencode's own default).
  const { hint, jd, timeout = 600000 } = opts;

  const q = (question ?? "").toString().trim();
  if (!q) {
    throw new InputError("No question provided.");
  }

  const message = buildMessage(q, { hint, jd });
  const stdout = await runOpencode(message, { timeout });
  const out = extractFinalText(stdout).trim();
  if (!out) {
    throw new ApiError(
      `opencode produced no text events (stdout was ${stdout.length} bytes)`
    );
  }
  return out;
}

// ---- Async batch jobs (polling model) ----
// A whole-form batch runs for minutes, which exceeds what a single HTTP
// request (and a Firefox MV3 background page) can survive. So we split it:
//
//   createBatchJob(items)      → writes a job file, returns jobId (instant)
//   runBatchJob(jobId)         → runs opencode, updates the file (fire-and-forget)
//   getBatchJob(jobId)         → reads { status, answers?, error? } (instant)
//
// The server calls createBatchJob, kicks off runBatchJob without awaiting, and
// returns the jobId immediately. The client polls getBatchJob every few seconds
// until status === "done" (or "error"). Each poll is short, so the MV3
// background page never suspends mid-run.
//
// Job file shape: { status, jd, fields:[{id,question,hint,answer}], error?, answers? }
//   status: "pending" → "running" → "done" | "error"

// Validate items and write the skeleton job file. Returns { jobId }.
// Throws InputError on bad input. Synchronous (no agent call).
export function createBatchJob(items, { jd } = {}) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new InputError("No fields provided.");
  }
  for (const it of items) {
    if (!it || typeof it.id === "undefined" || !(it.question || "").trim()) {
      throw new InputError('Each field needs an "id" and a "question".');
    }
  }

  if (!existsSync(jobsDir)) {
    try {
      mkdirSync(jobsDir, { recursive: true });
    } catch {
      throw new ConfigError(`Could not create jobs dir at ${jobsDir}`);
    }
  }

  const jobId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const jobPath = join(jobsDir, `${jobId}.json`);

  const skeleton = {
    status: "pending",
    jd: (jd || "").trim(),
    fields: items.map((it) => ({
      id: it.id,
      question: it.question,
      hint: (it.hint || "").trim(),
      answer: "",
    })),
  };
  writeFileSync(jobPath, JSON.stringify(skeleton, null, 2), "utf8");
  return { jobId };
}

// Run the agent and update the job file. Fire-and-forget: the server starts
// this WITHOUT awaiting so the HTTP response returns immediately. All outcomes
// (success, error, timeout) are written to the file for the poller to read.
export async function runBatchJob(jobId, { timeout = 600000 } = {}) {
  const jobPath = join(jobsDir, `${jobId}.json`);

  // Atomic write: write to a temp sibling then rename, so a poller never reads
  // a half-written file. Reads can still race with the agent's own writes, so
  // the reader (getBatchJob) is also resilient to transient parse errors.
  function writeJson(data) {
    const tmp = `${jobPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    try {
      renameSync(tmp, jobPath);
    } catch {
      // rename failed — best effort: leave the temp; reader handles absence.
    }
  }

  function writeStatus(patch) {
    try {
      const cur = JSON.parse(readFileSync(jobPath, "utf8"));
      writeJson({ ...cur, ...patch });
    } catch {
      /* file unreadable mid-write — the poller will retry and see the next state */
    }
  }

  writeStatus({ status: "running", startedAt: Date.now() });

  try {
    const job = JSON.parse(readFileSync(jobPath, "utf8"));
    const prompt = buildBatchPrompt(`.jobs/${jobId}.json`, job.fields.length, job.jd);
    await runOpencode(prompt, { timeout });

    // Read back the file the agent filled.
    let filled;
    try {
      filled = JSON.parse(readFileSync(jobPath, "utf8"));
    } catch {
      throw new ApiError(
        `Agent did not write back .jobs/${jobId}.json (missing or unreadable).`
      );
    }

    const answers = (filled.fields || []).map((f) => ({
      id: f.id,
      answer: typeof f.answer === "string" ? f.answer.trim() : "",
    }));
    const missing = answers.filter((a) => !a.answer).length;
    if (missing === filled.fields.length) {
      throw new ApiError(
        `Agent produced no answers (all fields empty). Job file kept at ${jobPath} for inspection.`
      );
    }
    writeStatus({ status: "done", answers });
  } catch (err) {
    // Keep the job file for inspection; record the error for the poller.
    if (/timed out/i.test(err.message) && !/Job file kept/.test(err.message)) {
      err.message += ` Job file kept at ${jobPath} for inspection.`;
    }
    writeStatus({ status: "error", error: err.message });
  }
}

// Read the current job state. Returns { status, answers?, error? }.
// "pending" | "running" | "done" | "error". On a transient parse failure (the
// file is mid-write), returns { status: "pending" } so the poller retries
// instead of erroring out. Throws ApiError only if the job file doesn't exist.
export function getBatchJob(jobId) {
  const jobPath = join(jobsDir, `${jobId}.json`);
  if (!existsSync(jobPath)) {
    throw new ApiError(`Unknown job: ${jobId}`);
  }
  let job;
  try {
    job = JSON.parse(readFileSync(jobPath, "utf8"));
  } catch {
    // File is being written (atomic rename usually prevents this, but the
    // agent's own writes to the same file can still race). Treat as pending.
    return { status: "pending" };
  }
  const out = { status: job.status || "pending" };
  if (job.status === "done") out.answers = job.answers || [];
  if (job.status === "error") out.error = job.error || "Unknown error.";
  return out;
}

// The batch prompt points the agent at the job file relative to the workspace
// root (its --dir). It must fill every `answer` consistently, write the file
// back, and output nothing else — we read the file, not stdout.
function buildBatchPrompt(relPath, count, jd) {
  const blocks = [
    `Fill out a job application form. There ${count === 1 ? "is 1 field" : `are ${count} fields`} to answer.`,
    "",
    `The fields are in this JSON file (relative to the workspace root): ${relPath}`,
    "Read the file, then for EACH field fill in the \`answer\` property with the",
    "paste-ready answer to that field's question. Honor any per-field hint.",
    "",
    "Rules:",
    "- Invoke the relevant skill(s) via the skill tool for any project/experience",
    "  question, just as for a single-field request.",
    "- Answer all fields CONSISTENTLY — don't contradict yourself across fields.",
    "- The answer for each field is paste-ready into a single form input.",
    "- WRITE the file back when done (update the in-place \`answer\` values).",
    "- Output NOTHING to the response — your work is in the file, not stdout.",
  ];
  if (jd && jd.trim()) {
    blocks.push(
      "",
      `JOB DESCRIPTION (tailor the answers to this role):\n${jd.trim()}`
    );
  }
  return blocks.join("\n");
}
