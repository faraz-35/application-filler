// Shared engine for interview-helper: config, profile loading, prompt assembly,
// and the GLM call. Used by both the CLI (src/answer.mjs) and the local helper
// server (src/server.mjs). No dependencies — Node natives only.
//
// answer(question, { profile, hint, jd }) is the single entry point: it loads the
// profile, builds the prompt, calls GLM, and returns the answer string. It throws
// typed errors (ConfigError / InputError / ApiError) so callers can decide how to
// present them (CLI prints + exits; server maps to HTTP status).

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const contextsDir = join(__dirname, "..", "contexts");

// ---- Typed errors: callers map these to the right exit code / HTTP status. ----
export class ConfigError extends Error {}
export class InputError extends Error {}
export class ApiError extends Error {}

// ---- Config (read from env each call so changes take effect without restart). ----
export function getConfig() {
  const apiKey = process.env.ZAI_API_KEY;
  if (!apiKey) {
    throw new ConfigError(
      "Missing ZAI_API_KEY. Copy .env.example to .env and fill it in."
    );
  }
  return {
    apiKey,
    model: process.env.ZAI_MODEL || "glm-4.6",
    baseURL: process.env.ZAI_BASE_URL || "https://api.z.ai/api/paas/v4",
    // Thinking is OFF by default: reasoning models otherwise burn 200-700 hidden
    // tokens/answer. ZAI_THINKING=1 re-enables it for hard questions.
    thinking:
      process.env.ZAI_THINKING === "1"
        ? { type: "enabled" }
        : { type: "disabled" },
  };
}

// ---- Profile loading ----
// A profile is contexts/<name>/ with system.md (required) + any other *.md
// (reference, loaded alphabetically). system.md = role/voice; the rest = context.
export function loadProfile(profile) {
  const profileDir = join(contextsDir, profile);
  if (!existsSync(profileDir)) {
    throw new ConfigError(
      `Unknown profile "${profile}". No directory at contexts/${profile}/`
    );
  }

  const mdFiles = readdirSync(profileDir).filter((f) => f.endsWith(".md")).sort();

  const systemFile = mdFiles.find((f) => f === "system.md");
  if (!systemFile) {
    throw new ConfigError(
      `contexts/${profile}/ is missing system.md (the role/instructions file).`
    );
  }
  const systemPrompt = readFileSync(join(profileDir, systemFile), "utf8").trim();

  const reference = mdFiles
    .filter((f) => f !== "system.md")
    .map((f) => `## ${f}\n\n${readFileSync(join(profileDir, f), "utf8").trim()}`)
    .join("\n\n---\n\n");

  return { systemPrompt, reference };
}

// Constant output rules applied to every answer. Keep this paste-ready invariant
// intact — it is the whole product.
const OUTPUT_RULES = `OUTPUT RULES (apply to every answer):
- Write so the answer can be pasted straight into a single form field.
- No preamble ("Here is your answer:"), no trailing notes, no surrounding quotes, no code fences.
- Be honest and specific. If the reference lacks an answer, say so plainly rather than inventing one.
- Keep it tight — sized to the question.`;

// ---- Prompt assembly ----
// system.md defines the role/voice; everything else is appended per call:
//   OUTPUT RULES   — constant
//   reference      — the profile's reference *.md (candidate background)
//   jd             — the job being applied for (per-application, optional)
//   hint           — the user's steer for this specific answer (optional)
export function buildPrompt({ systemPrompt, reference, jd, hint }) {
  const blocks = [systemPrompt, OUTPUT_RULES];

  if (reference) {
    blocks.push(`REFERENCE CONTEXT (the candidate's background):\n${reference}`);
  }
  if (jd && jd.trim()) {
    blocks.push(`JOB DESCRIPTION (the role being applied for — tailor the answer to it):\n${jd.trim()}`);
  }
  if (hint && hint.trim()) {
    blocks.push(`ANSWER DIRECTION (the user's steer for this specific answer):\n${hint.trim()}`);
  }

  return blocks.join("\n\n---\n\n");
}

// ---- The single entry point ----
// Returns the answer string. Throws ConfigError / InputError / ApiError on failure.
export async function answer(question, opts = {}) {
  const { profile = "interview", hint, jd } = opts;

  const q = (question ?? "").toString().trim();
  if (!q) {
    throw new InputError("No question provided.");
  }

  const config = getConfig();
  const { systemPrompt, reference } = loadProfile(profile);
  const systemContent = buildPrompt({ systemPrompt, reference, jd, hint });

  const res = await fetch(`${config.baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      thinking: config.thinking,
      messages: [
        { role: "system", content: systemContent },
        { role: "user", content: q },
      ],
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new ApiError(`GLM API error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const out = data.choices?.[0]?.message?.content?.trim();
  if (!out) {
    throw new ApiError(`The model returned no answer: ${JSON.stringify(data)}`);
  }
  return out;
}
