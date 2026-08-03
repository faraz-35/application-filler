// Local HTTP helper that exposes the agentic brain (src/agentic.mjs) to the
// browser extension. /answer shells out to the opencode CLI, which runs as an
// agent over workspace/ — reading workspace/AGENTS.md and the skills/ — and
// answers grounded in Faraz's project knowledge. Binds to 127.0.0.1 ONLY —
// never reachable from the network.
//
//   POST /answer   { question, profile?, hint?, jd? }   -> { answer }  (agentic, slow)
//   GET  /health                                       -> { ok: true }
//   GET  /profiles                                     -> { profiles }
//
// The agentic path manages its own auth via opencode's global config; the
// .env ZAI_API_KEY is NOT used by /answer (it stays for the hotkey/CLI path).
//
// CORS is permissive: we listen on localhost only, so letting moz-extension://
// (or any origin) call us is safe. The extension will be its only real client.
//
// Run:  npm run server
//       node --env-file=.env src/server.mjs
// Override port with HELPER_PORT (default 8775).

import http from "node:http";
import { appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { listProfiles, ConfigError, InputError, ApiError } from "./core.mjs";
import {
  answerAgentic,
  createBatchJob,
  runBatchJob,
  getBatchJob,
  saveSample,
  isAvailable as opencodeAvailable,
} from "./agentic.mjs";

const HOST = "127.0.0.1";
const PORT = Number(process.env.HELPER_PORT) || 8775;

// Persistent request log so request details are inspectable after the fact — the
// console output only lives in the terminal that launched the server, which isn't
// reachable otherwise. (Gitignored.)
const requestLogPath = join(dirname(fileURLToPath(import.meta.url)), "..", "server.log");
function logLine(line) {
  const entry = `[${new Date().toISOString()}] ${line}\n`;
  process.stdout.write(entry);
  try {
    appendFileSync(requestLogPath, entry);
  } catch {
    /* best effort — don't let logging break a request */
  }
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    ...CORS_HEADERS,
  });
  res.end(body);
}

// Map core's typed errors to the right HTTP status.
function statusFor(err) {
  if (err instanceof InputError) return 400; // bad/missing question
  if (err instanceof ApiError) return 502; // upstream GLM failure
  if (err instanceof ConfigError) return 500; // missing key / bad profile setup
  return 500;
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

const server = http.createServer(async (req, res) => {
  // CORS preflight — answer before any auth/routing.
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    return res.end();
  }

  const { pathname } = new URL(req.url, `http://${HOST}`);

  if (req.method === "GET" && pathname === "/health") {
    return send(res, 200, { ok: true });
  }

  if (req.method === "GET" && pathname === "/profiles") {
    return send(res, 200, { profiles: listProfiles() });
  }

  if (req.method === "POST" && pathname === "/answer") {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return send(res, 400, { error: "Invalid JSON body." });
    }

    const { question, profile, hint, jd, limit } = body;
    // profile is accepted for request-shape compatibility but the agentic path
    // uses a single workspace (workspace/) regardless of profile — the persona
    // and skills are the same. Multi-profile workspaces are a future enhancement.
    // Log which fields arrived and how big (not their contents) — this is how to
    // confirm the extension is sending hint/jd with each request. Goes to stdout
    // and server.log (inspectable after the fact).
    const limStr = limit ? `${limit.value}${limit.unit === "words" ? "w" : "c"}` : "0";
    logLine(
      `POST /answer profile=${profile || "interview"} ` +
        `q=${question?.length || 0}c hint=${hint?.length || 0}c jd=${jd?.length || 0}c limit=${limStr}`
    );
    const startedAt = Date.now();
    try {
      // Agentic: shells out to opencode over workspace/. Slow (10-40s typical)
      // because the agent may invoke skills and reason before answering.
      const result = await answerAgentic(question, { hint, jd, limit });
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      logLine(`POST /answer -> 200 (${elapsed}s)`);
      return send(res, 200, { answer: result });
    } catch (err) {
      const status = statusFor(err);
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      logLine(`POST /answer -> ${status} (${elapsed}s) ${err.message}`);
      return send(res, status, { error: err.message });
    }
  }

  if (req.method === "POST" && pathname === "/answer-batch") {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return send(res, 400, { error: "Invalid JSON body." });
    }

    const { items, jd } = body;
    // The extension builds items as [{id, question, hint?}] from each field it
    // captured. The agent fills all of them in one run for consistent answers.
    logLine(`POST /answer-batch fields=${items?.length || 0} jd=${jd?.length || 0}c`);
    try {
      // Create the job file (instant), then start the agent WITHOUT awaiting —
      // the response returns the jobId immediately so the client can poll.
      // This avoids the MV3 background-page suspension that kills a long fetch.
      const { jobId } = createBatchJob(items, { jd });
      runBatchJob(jobId).catch((e) =>
        logLine(`runBatchJob(${jobId}) crashed: ${e.message}`)
      );
      logLine(`POST /answer-batch -> 202 job=${jobId}`);
      return send(res, 202, { jobId });
    } catch (err) {
      const status = statusFor(err);
      logLine(`POST /answer-batch -> ${status} ${err.message}`);
      return send(res, status, { error: err.message });
    }
  }

  // Poll a batch job: GET /answer-batch/<jobId> -> { status, answers?, error? }
  // status is "pending" | "running" | "done" | "error". The client polls every
  // few seconds; each call is instant (just a file read).
  if (req.method === "GET" && pathname.startsWith("/answer-batch/")) {
    const jobId = pathname.slice("/answer-batch/".length);
    try {
      const result = getBatchJob(jobId);
      // Log every poll so server.log shows whether the extension is polling at
      // all — previously this handler was silent, leaving a blind spot between
      // the 202 POST and the agent's completion (the cause of an unfillable
      // "did the client ever poll?" mystery).
      const summary =
        result.status === "done"
          ? `done (${result.answers?.length || 0} answers)`
          : result.status === "error"
            ? `error: ${result.error || "?"}`
            : result.status;
      logLine(`GET /answer-batch/${jobId} -> ${summary}`);
      return send(res, 200, result);
    } catch (err) {
      const status = statusFor(err);
      logLine(`GET /answer-batch/${jobId} -> ${status} ${err.message}`);
      return send(res, status, { status: "error", error: err.message });
    }
  }

  // Save the user's own answer as a reusable sample. The extension card's
  // "Save answer" button POSTs the question + the field's current value
  // (+ JD, when one is set). We write one entry into the my-answers skill —
  // no agent call, instant. The agent later reads INDEX.md + the entry file.
  if (req.method === "POST" && pathname === "/save-sample") {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return send(res, 400, { error: "Invalid JSON body." });
    }

    const { question, answer, jd } = body;
    logLine(
      `POST /save-sample q=${question?.length || 0}c a=${answer?.length || 0}c ` +
        `jd=${jd?.length || 0}c`
    );
    try {
      const { id } = saveSample({ question, answer, jd });
      logLine(`POST /save-sample -> 200 id=${id}`);
      return send(res, 200, { ok: true, id });
    } catch (err) {
      const status = statusFor(err);
      logLine(`POST /save-sample -> ${status} ${err.message}`);
      return send(res, status, { error: err.message });
    }
  }

  return send(res, 404, { error: "Not found." });
});

server.listen(PORT, HOST, () => {
  console.log(`application-filler server on http://${HOST}:${PORT}`);
  console.log(`  POST /answer         { question, profile?, hint?, jd? }  (single, agentic)`);
  console.log(`  POST /answer-batch   { items:[{id,question,hint?}], jd }  -> { jobId }  (202, async)`);
  console.log(`  GET  /answer-batch/<jobId>                              poll -> { status, answers? }`);
  console.log("  POST /save-sample    { question, answer, jd? }         -> { ok, id }  (instant, no agent)");
  console.log("  GET  /health");
  console.log("  GET  /profiles");
  if (!opencodeAvailable()) {
    console.warn(
      "  WARNING: opencode binary not found. /answer will fail until it's on " +
        "PATH (~/.opencode/bin) or OPENCODE_BIN is set."
    );
  }
});
