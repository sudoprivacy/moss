#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";

function parseArgs(argv) {
  const result = {
    baseUrl: "http://127.0.0.1:43129",
    username: "e2e-admin",
    password: "",
    outputDir: process.cwd(),
    runtimes: ["host", "docker"],
    timeoutMs: 180_000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--base-url" && value)
      result.baseUrl = value.replace(/\/$/, "");
    else if (argument === "--username" && value) result.username = value;
    else if (argument === "--password" && value) result.password = value;
    else if (argument === "--output-dir" && value) result.outputDir = value;
    else if (argument === "--runtimes" && value)
      result.runtimes = value.split(",").filter(Boolean);
    else if (argument === "--timeout-seconds" && value)
      result.timeoutMs = Number(value) * 1000;
    else throw new Error(`Unknown or incomplete argument: ${argument}`);
    index += 1;
  }
  if (!result.password) throw new Error("--password is required");
  for (const runtime of result.runtimes) {
    if (runtime !== "host" && runtime !== "docker")
      throw new Error(`Unsupported runtime: ${runtime}`);
  }
  return result;
}

const options = parseArgs(process.argv.slice(2));
fs.mkdirSync(options.outputDir, { recursive: true });

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(pathname, init = {}, expectedStatus = 200) {
  const response = await fetch(`${options.baseUrl}${pathname}`, {
    ...init,
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  const text = await response.text();
  if (response.status !== expectedStatus) {
    throw new Error(
      `${init.method || "GET"} ${pathname}: expected ${expectedStatus}, got ${response.status}: ${text.slice(0, 500)}`,
    );
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function authorization(token) {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
}

function encodeClientFrame(text) {
  const payload = Buffer.from(text);
  const mask = crypto.randomBytes(4);
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, 0x80 | payload.length]);
  } else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  const masked = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index += 1) {
    masked[index] = payload[index] ^ mask[index % 4];
  }
  return Buffer.concat([header, mask, masked]);
}

function encodeControlFrame(opcode, payload = Buffer.alloc(0)) {
  const mask = crypto.randomBytes(4);
  const header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
  const masked = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index += 1) {
    masked[index] = payload[index] ^ mask[index % 4];
  }
  return Buffer.concat([header, mask, masked]);
}

function extractFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    let length = second & 0x7f;
    let headerLength = 2;
    if (length === 126) {
      if (buffer.length - offset < 4) break;
      length = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (length === 127) {
      if (buffer.length - offset < 10) break;
      const bigLength = buffer.readBigUInt64BE(offset + 2);
      if (bigLength > BigInt(Number.MAX_SAFE_INTEGER))
        throw new Error("WebSocket frame is too large");
      length = Number(bigLength);
      headerLength = 10;
    }
    const masked = (second & 0x80) !== 0;
    const maskLength = masked ? 4 : 0;
    if (buffer.length - offset < headerLength + maskLength + length) break;
    const maskStart = offset + headerLength;
    const payloadStart = maskStart + maskLength;
    const payload = Buffer.from(
      buffer.subarray(payloadStart, payloadStart + length),
    );
    if (masked) {
      const mask = buffer.subarray(maskStart, maskStart + 4);
      for (let index = 0; index < payload.length; index += 1)
        payload[index] ^= mask[index % 4];
    }
    frames.push({ fin: (first & 0x80) !== 0, opcode: first & 0x0f, payload });
    offset = payloadStart + length;
  }
  return { frames, remainder: buffer.subarray(offset) };
}

async function runConversation(wsUrl, token, runtime) {
  const url = new URL(wsUrl);
  assert(url.protocol === "ws:", `Expected ws URL, got ${wsUrl}`);
  const nonce = `MOSS_E2E_TOKEN_${runtime}_${crypto.randomUUID().replaceAll("-", "")}`;
  const expected = `MOSS_E2E_OK:${nonce}`;
  const eventPath = `${options.outputDir}/${runtime}-session-events.jsonl`;
  fs.writeFileSync(eventPath, "");

  await new Promise((resolve, reject) => {
    const socket = net.createConnection({
      host: url.hostname,
      port: Number(url.port || 80),
    });
    const key = crypto.randomBytes(16).toString("base64");
    const expectedAccept = crypto
      .createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    let handshakeComplete = false;
    let buffer = Buffer.alloc(0);
    let fragmentOpcode = 0;
    let fragments = [];
    let sawAssistant = false;
    let sawResult = false;
    let promptSent = false;
    let assistantText = "";
    let settled = false;
    const timer = setTimeout(
      () => finish(new Error(`${runtime} WebSocket conversation timed out`)),
      options.timeoutMs,
    );

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      if (!socket.destroyed) socket.destroy();
      if (error) reject(error);
      else resolve();
    };

    const handleText = (text) => {
      fs.appendFileSync(eventPath, `${text}\n`, "utf8");
      let event;
      try {
        event = JSON.parse(text);
      } catch {
        return;
      }
      if (event.type === "error") {
        finish(new Error(`${runtime} runtime error: ${event.error || text}`));
        return;
      }
      if (event.type === "exit" && !sawResult) {
        finish(
          new Error(
            `${runtime} runtime exited before a successful result: ${text}`,
          ),
        );
        return;
      }
      if (event.type === "hello" && !promptSent) {
        promptSent = true;
        socket.write(
          encodeClientFrame(
            JSON.stringify({
              type: "user",
              uuid: crypto.randomUUID(),
              message: {
                role: "user",
                content: `Reply with this exact token and no additional text: ${nonce}`,
              },
            }),
          ),
        );
      }
      if (event.type === "assistant") {
        sawAssistant = true;
        const content = event.message?.content;
        if (typeof content === "string") assistantText += content;
        else if (Array.isArray(content)) {
          assistantText += content
            .map((item) => (typeof item === "string" ? item : item?.text || ""))
            .join("");
        }
      }
      if (event.type === "result") {
        assert(
          event.status === "success",
          `${runtime} result status was ${event.status}`,
        );
        sawResult = true;
      }
      if (sawAssistant && sawResult) {
        assert(
          assistantText.includes(expected),
          `${runtime} assistant response did not include ${expected}: ${assistantText}`,
        );
        socket.write(encodeControlFrame(0x8));
        finish();
      }
    };

    const processFrames = () => {
      const parsed = extractFrames(buffer);
      buffer = Buffer.from(parsed.remainder);
      for (const frame of parsed.frames) {
        if (frame.opcode === 0x8) {
          if (!sawResult)
            finish(
              new Error(`${runtime} WebSocket closed before successful result`),
            );
          return;
        }
        if (frame.opcode === 0x9) {
          socket.write(encodeControlFrame(0xa, frame.payload));
          continue;
        }
        if (frame.opcode === 0x1 || frame.opcode === 0x2) {
          fragmentOpcode = frame.opcode;
          fragments = [frame.payload];
        } else if (frame.opcode === 0x0) {
          fragments.push(frame.payload);
        } else {
          continue;
        }
        if (frame.fin) {
          if (fragmentOpcode === 0x1)
            handleText(Buffer.concat(fragments).toString("utf8"));
          fragmentOpcode = 0;
          fragments = [];
        }
      }
    };

    socket.on("connect", () => {
      socket.write(
        [
          `GET ${url.pathname}${url.search} HTTP/1.1`,
          `Host: ${url.host}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${key}`,
          "Sec-WebSocket-Version: 13",
          `Authorization: Bearer ${token}`,
          "\r\n",
        ].join("\r\n"),
      );
    });
    socket.on("data", (chunk) => {
      try {
        buffer = Buffer.concat([buffer, chunk]);
        if (!handshakeComplete) {
          const end = buffer.indexOf("\r\n\r\n");
          if (end < 0) return;
          const head = buffer.subarray(0, end).toString("utf8");
          buffer = buffer.subarray(end + 4);
          assert(
            /^HTTP\/1\.1 101\b/.test(head),
            `${runtime} WebSocket upgrade failed: ${head}`,
          );
          const accept = head
            .match(/^sec-websocket-accept:\s*(.+)$/im)?.[1]
            ?.trim();
          assert(
            accept === expectedAccept,
            `${runtime} WebSocket accept header mismatch`,
          );
          handshakeComplete = true;
        }
        processFrames();
      } catch (error) {
        finish(error);
      }
    });
    socket.on("error", finish);
    socket.on("close", () => {
      if (!sawAssistant || !sawResult)
        finish(
          new Error(
            `${runtime} WebSocket closed before smoke assertions completed`,
          ),
        );
    });
  });

  return { nonce, expected, eventPath };
}

async function waitForSessionStatus(sessionId, token, expected) {
  const deadline = Date.now() + 30_000;
  let lastStatus = "";
  while (Date.now() < deadline) {
    const body = await request(`/api/v1/sessions/${sessionId}`, {
      headers: authorization(token),
    });
    lastStatus = body.session?.status || "";
    if (expected.includes(lastStatus)) return body.session;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `Session ${sessionId} did not reach ${expected.join("/")}; last status=${lastStatus}`,
  );
}

async function waitForSessionContext(sessionId, token, expectedValues) {
  const deadline = Date.now() + 30_000;
  let lastContext = "";
  while (Date.now() < deadline) {
    try {
      const context = await request(`/api/v1/sessions/${sessionId}/context`, {
        headers: authorization(token),
      });
      lastContext = JSON.stringify(context);
      if (expectedValues.every((value) => lastContext.includes(value)))
        return context;
    } catch {
      // Transcript creation and its final async flush may trail the result event.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Session ${sessionId} context omitted ${expectedValues.join(", ")}: ${lastContext}`,
  );
}

async function main() {
  const health = await request("/healthz");
  assert(health?.ok === true && health?.ready === true, "healthz is not ready");
  const ready = await request("/readyz");
  assert(ready?.ok === true && ready?.ready === true, "readyz is not ready");
  const admin = await request("/admin/");
  assert(
    typeof admin === "string" && /<!doctype html/i.test(admin),
    "admin UI did not return HTML",
  );
  await request("/api/v1/sessions", {}, 401);

  const login = await request("/api/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "password",
      username: options.username,
      password: options.password,
    }),
  });
  assert(
    typeof login?.access_token === "string",
    "login did not return an access token",
  );
  const token = login.access_token;
  const me = await request("/api/v1/auth/me", {
    headers: authorization(token),
  });
  assert(me?.user?.status === "active", "authenticated user is not active");

  const summaries = [];
  for (const runtime of options.runtimes) {
    let sessionId = "";
    try {
      const created = await request("/api/v1/sessions", {
        method: "POST",
        headers: authorization(token),
        body: JSON.stringify({
          dangerously_skip_permissions: true,
          runtime:
            runtime === "host"
              ? { type: "host", hostMode: "session" }
              : { type: "docker", dockerMode: "session" },
        }),
      });
      sessionId = created?.session_id || "";
      assert(sessionId, `${runtime} session creation returned no session_id`);
      assert(
        created?.runtime?.type === runtime,
        `${runtime} session created as ${created?.runtime?.type}`,
      );
      assert(
        typeof created?.ws_url === "string",
        `${runtime} session creation returned no ws_url`,
      );

      const conversation = await runConversation(
        created.ws_url,
        token,
        runtime,
      );
      const active = await waitForSessionStatus(sessionId, token, [
        "active",
        "detached",
      ]);
      await waitForSessionContext(sessionId, token, [
        conversation.nonce,
        conversation.expected,
      ]);
      summaries.push({
        runtime,
        sessionId,
        status: active.status,
        response: conversation.expected,
      });
    } finally {
      if (sessionId) {
        await request(`/api/v1/sessions/${sessionId}/terminate`, {
          method: "POST",
          headers: authorization(token),
          body: "{}",
        });
        await waitForSessionStatus(sessionId, token, ["terminated", "ended"]);
      }
    }
  }

  const summary = {
    ok: true,
    baseUrl: options.baseUrl,
    authenticatedRole: me.user.role,
    runtimes: summaries,
  };
  fs.writeFileSync(
    `${options.outputDir}/e2e-summary.json`,
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((error) => {
  const message =
    error instanceof Error ? error.stack || error.message : String(error);
  fs.writeFileSync(`${options.outputDir}/e2e-failure.txt`, `${message}\n`);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
