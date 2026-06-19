import { execSync } from "node:child_process";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectDir = join(__dirname, "..");

// A "profile" is a directory under contexts/<name>/ holding markdown files.
// system.md = role + instructions; every other *.md = reference context.
// Usage: node src/answer.mjs [profile]   (default: interview)
const profile = process.argv[2] || "interview";
const profileDir = join(projectDir, "contexts", profile);

if (!existsSync(profileDir)) {
  console.error(`Unknown profile "${profile}". No directory at contexts/${profile}/`);
  process.exit(1);
}

const apiKey = process.env.ZAI_API_KEY;
const model = process.env.ZAI_MODEL || "glm-4.6";
const baseURL =
  process.env.ZAI_BASE_URL || "https://open.bigmodel.cn/api/paas/v4";

if (!apiKey) {
  console.error("Missing ZAI_API_KEY. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

// 1. Grab the question from the clipboard
const question = execSync("pbpaste", { encoding: "utf8" }).trim();
if (!question) {
  console.error("Clipboard is empty. Copy the question first, then hit the hotkey.");
  process.exit(1);
}

// 2. Load profile context: system.md (instructions) + every other *.md (reference)
const mdFiles = readdirSync(profileDir)
  .filter((f) => f.endsWith(".md"))
  .sort();

const systemFile = mdFiles.find((f) => f === "system.md");
if (!systemFile) {
  console.error(`contexts/${profile}/ is missing system.md (the role/instructions file).`);
  process.exit(1);
}
const systemPrompt = readFileSync(join(profileDir, systemFile), "utf8").trim();

const reference = mdFiles
  .filter((f) => f !== "system.md")
  .map((f) => {
    const body = readFileSync(join(profileDir, f), "utf8").trim();
    return `## ${f}\n\n${body}`;
  })
  .join("\n\n---\n\n");

// 3. Ask GLM. Common output rules apply to every profile; system.md adds the role.
// Thinking is OFF: reasoning models otherwise burn 200-700 hidden tokens/answer.
// Set ZAI_THINKING=1 to re-enable for hard questions.
const thinking = process.env.ZAI_THINKING === "1"
  ? { type: "enabled" }
  : { type: "disabled" };

const res = await fetch(`${baseURL}/chat/completions`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  },
  body: JSON.stringify({
    model,
    thinking,
    messages: [
      {
        role: "system",
        content: `${systemPrompt}

---

OUTPUT RULES (apply to every answer):
- Write so the answer can be pasted straight into a single form field.
- No preamble ("Here is your answer:"), no trailing notes, no surrounding quotes, no code fences.
- Be honest and specific. If the reference lacks an answer, say so plainly rather than inventing one.
- Keep it tight — sized to the question.

${reference ? `REFERENCE CONTEXT:\n${reference}` : ""}`,
      },
      { role: "user", content: question },
    ],
  }),
});

if (!res.ok) {
  const errText = await res.text();
  console.error(`GLM API error ${res.status}: ${errText}`);
  process.exit(1);
}

const data = await res.json();
const answer = data.choices?.[0]?.message?.content?.trim();
if (!answer) {
  console.error("The model returned no answer.", JSON.stringify(data));
  process.exit(1);
}

// 4. Put the answer on the clipboard. Hammerspoon simulates ⌘V after we exit.
execSync("pbcopy", { input: answer });
console.log(answer);
