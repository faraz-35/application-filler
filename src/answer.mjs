import { execSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectDir = join(__dirname, "..");

const apiKey = process.env.ZAI_API_KEY;
const model = process.env.ZAI_MODEL || "glm-4.6";
const baseURL =
  process.env.ZAI_BASE_URL || "https://open.bigmodel.cn/api/paas/v4";

if (!apiKey) {
  console.error("Missing ZAI_API_KEY. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

// 1. Grab the interview question from the clipboard
const question = execSync("pbpaste", { encoding: "utf8" }).trim();
if (!question) {
  console.error("Clipboard is empty. Copy the question first, then hit the hotkey.");
  process.exit(1);
}

// 2. Load every context/*.md file as the candidate's background
const contextDir = join(projectDir, "context");
const context = readdirSync(contextDir)
  .filter((f) => f.endsWith(".md"))
  .sort()
  .map((f) => {
    const body = readFileSync(join(contextDir, f), "utf8").trim();
    return `## ${f}\n\n${body}`;
  })
  .join("\n\n---\n\n");

// 3. Ask GLM to answer the question using that context
const res = await fetch(`${baseURL}/chat/completions`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  },
  body: JSON.stringify({
    model,
    messages: [
      {
        role: "system",
        content: `You are helping a candidate fill out a job application or interview questionnaire.

Answer the candidate's question using the context below. Write the answer so it can be pasted straight into the form field:
- No preamble ("Here is your answer:"), no trailing notes.
- No surrounding quotes or code fences.
- Match the tone the question implies (formal for corporate forms, plain for open-ended ones).
- Be honest and specific. If the context lacks an answer, say so plainly rather than inventing one.
- Keep it tight — one paragraph or a few bullets, sized to the question.

CANDIDATE CONTEXT:
${context}`,
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
