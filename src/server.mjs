// Local HTTP helper that exposes the brain in src/core.mjs to the browser
// extension (and anything else on this machine). Binds to 127.0.0.1 ONLY — never
// reachable from the network — so the API key stays in .env and out of the browser.
//
//   POST /answer   { question, profile?, hint?, jd? }   -> { answer }
//   GET  /health                                       -> { ok: true }
//
// CORS is permissive: we listen on localhost only, so letting moz-extension://
// (or any origin) call us is safe. The extension will be its only real client.
//
// Run:  npm run server
//       node --env-file=.env src/server.mjs
// Override port with HELPER_PORT (default 7437).

import http from "node:http";
import { answer, ConfigError, InputError, ApiError } from "./core.mjs";

const HOST = "127.0.0.1";
const PORT = Number(process.env.HELPER_PORT) || 7437;

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

  if (req.method === "POST" && pathname === "/answer") {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return send(res, 400, { error: "Invalid JSON body." });
    }

    const { question, profile, hint, jd } = body;
    try {
      const result = await answer(question, { profile, hint, jd });
      return send(res, 200, { answer: result });
    } catch (err) {
      const status = statusFor(err);
      // Log status + message only — never the question/answer (privacy, length).
      console.error(`[${new Date().toISOString()}] POST /answer -> ${status} ${err.message}`);
      return send(res, status, { error: err.message });
    }
  }

  return send(res, 404, { error: "Not found." });
});

server.listen(PORT, HOST, () => {
  console.log(`interview-helper server on http://${HOST}:${PORT}`);
  console.log("  POST /answer  { question, profile?, hint?, jd? }");
  console.log("  GET  /health");
});
