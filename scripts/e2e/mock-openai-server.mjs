#!/usr/bin/env node

import { appendFileSync, writeFileSync } from "node:fs";
import http from "node:http";

function parseArgs(argv) {
  const result = {
    host: "0.0.0.0",
    port: 0,
    apiKey: process.env.MOSS_E2E_API_KEY || "moss-e2e-key",
    logFile: process.env.MOSS_E2E_MOCK_LOG || "",
    urlFile: process.env.MOSS_E2E_MOCK_URL_FILE || "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--host" && value) result.host = value;
    else if (argument === "--port" && value) result.port = Number(value);
    else if (argument === "--api-key" && value) result.apiKey = value;
    else if (argument === "--log-file" && value) result.logFile = value;
    else if (argument === "--url-file" && value) result.urlFile = value;
    else throw new Error(`Unknown or incomplete argument: ${argument}`);
    index += 1;
  }
  if (
    !Number.isInteger(result.port) ||
    result.port < 0 ||
    result.port > 65535
  ) {
    throw new Error(`Invalid port: ${result.port}`);
  }
  return result;
}

const options = parseArgs(process.argv.slice(2));

const mockAgent = {
  id: "moss-e2e-agent",
  name: "moss-e2e-agent",
  display_name: "Moss E2E 智能体",
  description: "用于验证智能体商店的本地 Mock 数据。",
  emoji: "🤖",
  category: "E2E",
  categories: ["E2E"],
  skills: [],
};

const mockSkill = {
  id: "moss-e2e-skill",
  name: "moss-e2e-skill",
  display_name: "Moss E2E 技能",
  description: "用于验证技能商店的本地 Mock 数据。",
  emoji: "🧪",
  category: "E2E",
  categories: ["E2E"],
};

function writeJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

function appendRecord(record) {
  if (!options.logFile) return;
  appendFileSync(options.logFile, `${JSON.stringify(record)}\n`, "utf8");
}

function collectText(value, result = []) {
  if (typeof value === "string") {
    result.push(value);
    return result;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, result);
    return result;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectText(item, result);
  }
  return result;
}

function responseText(body) {
  const allText = collectText(body).join("\n");
  const matches = allText.match(/MOSS_E2E_TOKEN_[A-Za-z0-9_-]+/g);
  const token = matches?.at(-1) || "MOSS_E2E_TOKEN_MISSING";
  return `MOSS_E2E_OK:${token}`;
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) throw new Error("request_too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendStreamingResponse(response, model, content) {
  const id = `chatcmpl-moss-e2e-${Date.now()}`;
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-request-id": id,
  });
  const frames = [
    { id, model, choices: [{ delta: { role: "assistant" } }] },
    { id, model, choices: [{ delta: { content } }] },
    { id, model, choices: [{ delta: {}, finish_reason: "stop" }] },
    {
      id,
      model,
      choices: [],
      usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
    },
  ];
  for (const frame of frames)
    response.write(`data: ${JSON.stringify(frame)}\n\n`);
  response.end("data: [DONE]\n\n");
}

const server = http.createServer(async (request, response) => {
  const pathname = new URL(request.url || "/", "http://localhost").pathname;
  if (request.method === "GET" && pathname === "/healthz") {
    writeJson(response, 200, { ok: true });
    return;
  }
  if (
    request.method === "GET" &&
    (pathname === "/v1/models" || pathname === "/models")
  ) {
    writeJson(response, 200, {
      object: "list",
      data: [{ id: "moss-e2e-model", object: "model", owned_by: "moss-e2e" }],
    });
    return;
  }
  if (request.method === "GET" && pathname === "/api/specific_pricing") {
    writeJson(response, 200, {
      success: true,
      data: [{ model_id: "moss-e2e-model", model: "Moss E2E Model", ratio: 1 }],
    });
    return;
  }
  if (request.method === "GET" && pathname === "/api/categories") {
    appendRecord({
      timestamp: new Date().toISOString(),
      path: pathname,
      kind: "hub",
    });
    writeJson(response, 200, { success: true, data: ["E2E"] });
    return;
  }
  if (request.method === "GET" && pathname === "/api/assistants/cursor") {
    appendRecord({
      timestamp: new Date().toISOString(),
      path: pathname,
      kind: "hub",
    });
    writeJson(response, 200, {
      success: true,
      data: {
        assistants: [mockAgent],
        next_cursor: null,
        has_more: false,
      },
    });
    return;
  }
  if (request.method === "GET" && pathname === "/api/skills/cursor") {
    appendRecord({
      timestamp: new Date().toISOString(),
      path: pathname,
      kind: "hub",
    });
    writeJson(response, 200, {
      success: true,
      data: { skills: [mockSkill], next_cursor: null, has_more: false },
    });
    return;
  }
  if (request.method === "GET" && pathname === "/api/skills/moss-e2e-skill") {
    appendRecord({
      timestamp: new Date().toISOString(),
      path: pathname,
      kind: "hub",
    });
    writeJson(response, 200, {
      success: true,
      data: {
        skill: mockSkill,
        versions: [
          {
            version: "1.0.0",
            source_url: "http://127.0.0.1/moss-e2e-skill.zip",
            checksum: "moss-e2e-checksum",
          },
        ],
      },
    });
    return;
  }
  if (request.method !== "POST" || !pathname.endsWith("/chat/completions")) {
    writeJson(response, 404, { error: { message: "not found" } });
    return;
  }

  try {
    const expectedAuthorization = `Bearer ${options.apiKey}`;
    if (request.headers.authorization !== expectedAuthorization) {
      appendRecord({
        timestamp: new Date().toISOString(),
        path: pathname,
        authorized: false,
      });
      writeJson(response, 401, { error: { message: "invalid e2e API key" } });
      return;
    }

    const rawBody = await readBody(request);
    const body = JSON.parse(rawBody);
    const content = responseText(body);
    const model =
      typeof body.model === "string" ? body.model : "moss-e2e-model";
    appendRecord({
      timestamp: new Date().toISOString(),
      path: pathname,
      authorized: true,
      stream: body.stream === true,
      model,
      response: content,
    });

    if (body.stream === true) {
      sendStreamingResponse(response, model, content);
      return;
    }
    writeJson(response, 200, {
      id: `chatcmpl-moss-e2e-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
    });
  } catch (error) {
    appendRecord({
      timestamp: new Date().toISOString(),
      path: pathname,
      error: error instanceof Error ? error.message : String(error),
    });
    writeJson(response, 400, { error: { message: "invalid request" } });
  }
});

server.listen(options.port, options.host, () => {
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("mock server has no TCP address");
  const url = `http://127.0.0.1:${address.port}/v1`;
  if (options.urlFile) writeFileSync(options.urlFile, `${url}\n`, "utf8");
  process.stdout.write(`MOSS_E2E_MOCK_URL=${url}\n`);
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
