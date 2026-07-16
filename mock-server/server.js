import http from "node:http";
import { classifyVideos } from "./classifier.js";

const port = Number(process.env.PORT || 8787);
const latencyMs = Number(process.env.MOCK_LATENCY_MS || 180);
const seed = process.env.MOCK_SEED || "slopshield-demo-v1";

const server = http.createServer(async (request, response) => {
  setCorsHeaders(response);

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  if (request.method === "GET" && request.url === "/health") {
    sendJson(response, 200, { status: "ok", mode: "mock", version: "0.3.0" });
    return;
  }

  if (request.method === "GET" && request.url === "/") {
    sendJson(response, 200, {
      name: "SlopShield mock server",
      status: "ok",
      mode: "mock",
      message: "The extension sends batches to POST /v1/classify.",
      endpoints: {
        health: "GET /health",
        classify: "POST /v1/classify",
      },
    });
    return;
  }

  if (request.method === "POST" && request.url === "/v1/classify") {
    try {
      const body = await readJsonBody(request);
      if (!Array.isArray(body.videos)) {
        sendJson(response, 400, { error: "videos must be an array" });
        return;
      }
      if (body.videos.length > 100) {
        sendJson(response, 413, { error: "a maximum of 100 videos is allowed per request" });
        return;
      }

      const results = classifyVideos(body.videos, { threshold: body.threshold, seed });
      await delay(Math.max(0, latencyMs));
      sendJson(response, 200, {
        requestId: crypto.randomUUID(),
        mode: "mock",
        results,
      });
    } catch (error) {
      sendJson(response, error.statusCode || 400, { error: error.message });
    }
    return;
  }

  sendJson(response, 404, { error: "not found" });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`SlopShield mock server listening on http://localhost:${port}`);
});

function setCorsHeaders(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request) {
  let rawBody = "";
  for await (const chunk of request) {
    rawBody += chunk;
    if (rawBody.length > 1_000_000) {
      const error = new Error("request body is too large");
      error.statusCode = 413;
      throw error;
    }
  }

  try {
    return rawBody ? JSON.parse(rawBody) : {};
  } catch {
    throw new Error("request body must be valid JSON");
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
