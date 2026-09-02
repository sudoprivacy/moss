#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function parseArgs(argv) {
  const result = {
    baseUrl: "http://127.0.0.1:43129",
    username: "e2e-admin",
    password: "",
    summaryFile: "",
    outputDir: process.cwd(),
    browser: process.env.MOSS_E2E_BROWSER || "",
    createdUsername: "e2e-browser-user",
    createdPassword: "moss-e2e-browser-password",
    timeoutMs: 45_000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--base-url" && value)
      result.baseUrl = value.replace(/\/$/, "");
    else if (argument === "--username" && value) result.username = value;
    else if (argument === "--password" && value) result.password = value;
    else if (argument === "--summary-file" && value)
      result.summaryFile = value;
    else if (argument === "--output-dir" && value)
      result.outputDir = value;
    else if (argument === "--browser" && value) result.browser = value;
    else if (argument === "--created-username" && value)
      result.createdUsername = value;
    else if (argument === "--created-password" && value)
      result.createdPassword = value;
    else if (argument === "--timeout-seconds" && value)
      result.timeoutMs = Number(value) * 1000;
    else throw new Error(`Unknown or incomplete argument: ${argument}`);
    index += 1;
  }
  if (!result.password) throw new Error("--password is required");
  if (!result.summaryFile) throw new Error("--summary-file is required");
  if (!Number.isFinite(result.timeoutMs) || result.timeoutMs <= 0)
    throw new Error("--timeout-seconds must be a positive number");
  return result;
}

function resolveBrowser(explicitPath) {
  const candidates = [
    explicitPath,
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate.includes("/") && fs.existsSync(candidate)) return candidate;
    const found = spawnSync("sh", ["-c", `command -v "${candidate}"`], {
      encoding: "utf8",
    });
    if (found.status === 0 && found.stdout.trim()) return found.stdout.trim();
  }
  throw new Error(
    "Chrome/Chromium is required (set MOSS_E2E_BROWSER to its executable path)",
  );
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitUntil(callback, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await callback();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await sleep(200);
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`Timed out waiting for ${description}${detail}`);
}

class CdpClient {
  constructor(webSocketUrl, timeoutMs) {
    this.webSocketUrl = webSocketUrl;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.socket = null;
  }

  async connect() {
    this.socket = new WebSocket(this.webSocketUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Timed out connecting to Chrome DevTools")),
        this.timeoutMs,
      );
      this.socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      this.socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error("Failed to connect to Chrome DevTools"));
        },
        { once: true },
      );
    });

    this.socket.addEventListener("message", (event) => {
      const raw =
        typeof event.data === "string"
          ? event.data
          : Buffer.from(event.data).toString("utf8");
      const message = JSON.parse(raw);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error)
          pending.reject(
            new Error(
              `${pending.method}: ${message.error.message || JSON.stringify(message.error)}`,
            ),
          );
        else pending.resolve(message.result || {});
        return;
      }
      const callbacks = this.listeners.get(message.method) || [];
      for (const callback of callbacks) callback(message.params || {});
    });

    this.socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Chrome DevTools connection closed"));
      }
      this.pending.clear();
    });
  }

  on(method, callback) {
    const callbacks = this.listeners.get(method) || [];
    callbacks.push(callback);
    this.listeners.set(method, callbacks);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Chrome DevTools command timed out: ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.close();
  }
}

const options = parseArgs(process.argv.slice(2));
const screenshotsDir = path.join(options.outputDir, "screenshots");
fs.mkdirSync(screenshotsDir, { recursive: true });

const conversationSummary = JSON.parse(
  fs.readFileSync(options.summaryFile, "utf8"),
);
const hostSession = conversationSummary.runtimes?.find(
  (item) => item.runtime === "host",
);
const dockerSession = conversationSummary.runtimes?.find(
  (item) => item.runtime === "docker",
);
assert(hostSession?.sessionId, "E2E summary omitted the host session");
assert(dockerSession?.sessionId, "E2E summary omitted the Docker session");
assert(hostSession?.response, "E2E summary omitted the host response");
assert(dockerSession?.response, "E2E summary omitted the Docker response");

const browserExecutable = resolveBrowser(options.browser);
const browserProfile = fs.mkdtempSync(
  path.join(os.tmpdir(), "moss-admin-browser-e2e-"),
);
const browserLogPath = path.join(options.outputDir, "browser-chromium.log");
const browserLog = fs.openSync(browserLogPath, "w");
const browserProcess = spawn(
  browserExecutable,
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--disable-background-networking",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-sync",
    "--hide-scrollbars",
    "--lang=zh-CN",
    "--no-first-run",
    "--remote-allow-origins=*",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    `--user-data-dir=${browserProfile}`,
    "about:blank",
  ],
  { stdio: ["ignore", browserLog, browserLog] },
);

let cdp;
const browserEvents = [];
const evidence = {
  ok: false,
  browser: path.basename(browserExecutable),
  viewport: { width: 1600, minimumHeight: 1200, maximumHeight: 2200 },
  createdUser: options.createdUsername,
  hostSessionId: hostSession.sessionId,
  dockerSessionId: dockerSession.sessionId,
  assertions: [],
  screenshots: [],
};

function recordAssertion(name) {
  evidence.assertions.push({ name, ok: true });
  process.stdout.write(`[browser-e2e] PASS ${name}\n`);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function writeEvidenceGallery() {
  const checks = evidence.assertions
    .map((item) => `<li>✅ ${escapeHtml(item.name)}</li>`)
    .join("\n");
  const screenshots = evidence.screenshots
    .map(
      (item) => `<figure>
  <img src="${escapeHtml(item.file)}" alt="${escapeHtml(item.file)}">
  <figcaption><strong>${escapeHtml(item.file)}</strong><br>${item.width}×${item.height} · ${escapeHtml(item.path)}</figcaption>
</figure>`,
    )
    .join("\n");
  fs.writeFileSync(
    path.join(options.outputDir, "browser-evidence.html"),
    `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>Moss Server E2E 浏览器证据</title>
<style>body{font:15px system-ui,sans-serif;max-width:1500px;margin:32px auto;padding:0 24px;color:#182033}li{margin:6px 0}.gallery{display:grid;gap:28px}figure{margin:0;padding:16px;border:1px solid #d8dee9;border-radius:12px;background:#f8fafc}img{display:block;width:100%;height:auto;border:1px solid #e5e7eb}figcaption{margin-top:12px;line-height:1.6}</style></head>
<body><h1>Moss Server E2E 浏览器证据</h1><ul>${checks}</ul><div class="gallery">${screenshots}</div></body></html>\n`,
  );
}

async function stopBrowser() {
  cdp?.close();
  if (browserProcess.exitCode === null) {
    browserProcess.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => browserProcess.once("exit", resolve)),
      sleep(3_000),
    ]);
  }
  if (browserProcess.exitCode === null) browserProcess.kill("SIGKILL");
  fs.closeSync(browserLog);
  try {
    fs.rmSync(browserProfile, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200,
    });
  } catch (error) {
    // Chrome helpers can briefly retain profile files after the main process
    // exits. The hosted runner is disposable, so never replace a passed E2E
    // result with a best-effort /tmp cleanup failure.
    process.stderr.write(
      `[browser-e2e] warning: could not remove temporary profile: ${error.message}\n`,
    );
  }
}

async function evaluate(expression) {
  const response = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (response.exceptionDetails) {
    const description =
      response.exceptionDetails.exception?.description ||
      response.exceptionDetails.text ||
      "browser evaluation failed";
    throw new Error(description);
  }
  return response.result?.value;
}

async function waitForExpression(expression, description) {
  return waitUntil(
    async () => Boolean(await evaluate(expression)),
    options.timeoutMs,
    description,
  );
}

async function navigate(pathname) {
  const target = `${options.baseUrl}/admin${pathname}`;
  await cdp.send("Page.navigate", { url: target });
  await waitForExpression(
    `document.readyState === "complete" && location.href === ${JSON.stringify(target)}`,
    `navigation to ${target}`,
  );
}

async function waitForText(text, description = text) {
  await waitForExpression(
    `document.body?.innerText.includes(${JSON.stringify(text)})`,
    `page text ${description}`,
  );
}

async function clickText(text, selector = "button, a") {
  const clicked = await evaluate(`(() => {
    const normalize = value => (value || "").replace(/\\s+/g, " ").trim();
    const element = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find(item => normalize(item.textContent) === ${JSON.stringify(text)} && item.getClientRects().length > 0);
    if (!element) return false;
    element.click();
    return true;
  })()`);
  assert(clicked, `Could not find visible ${selector} with text: ${text}`);
}

async function fillSelector(selector, value) {
  const filled = await evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return false;
    const prototype = element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    element.focus();
    setter.call(element, ${JSON.stringify(value)});
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: ${JSON.stringify(value)} }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return element.value === ${JSON.stringify(value)};
  })()`);
  assert(filled, `Could not fill input: ${selector}`);
}

async function fillDialogField(labelText, value) {
  const filled = await evaluate(`(() => {
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) return false;
    const normalize = input => (input || "").replace(/\\s+/g, " ").trim();
    const label = [...dialog.querySelectorAll("label")]
      .find(item => normalize(item.textContent) === ${JSON.stringify(labelText)});
    if (!label) return false;
    const element = label.htmlFor
      ? document.getElementById(label.htmlFor)
      : label.parentElement?.querySelector("input, textarea");
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return false;
    const prototype = element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    element.focus();
    setter.call(element, ${JSON.stringify(value)});
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: ${JSON.stringify(value)} }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return element.value === ${JSON.stringify(value)};
  })()`);
  assert(filled, `Could not fill dialog field: ${labelText}`);
}

async function clickSession(sessionId) {
  const clicked = await evaluate(`(() => {
    const suffix = "/sessions/${sessionId}";
    const link = [...document.querySelectorAll("a")]
      .find(item => (item.getAttribute("href") || "").endsWith(suffix));
    if (!link) return false;
    link.click();
    return true;
  })()`);
  assert(clicked, `Could not find session detail link: ${sessionId}`);
}

async function capture(name, expectedText = []) {
  for (const text of expectedText) await waitForText(text);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1600,
    height: 1200,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(150);
  const expandedHeight = await evaluate(`(() => {
    const main = document.querySelector("main");
    const contentHeight = main ? main.scrollHeight + 160 : document.documentElement.scrollHeight;
    return Math.max(1200, Math.min(2200, Math.ceil(contentHeight)));
  })()`);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1600,
    height: expandedHeight,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(300);
  const screenshot = await cdp.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: true,
  });
  const filename = `${name}.png`;
  const outputPath = path.join(screenshotsDir, filename);
  const image = Buffer.from(screenshot.data, "base64");
  assert(image.length > 5_000, `Screenshot appears empty: ${filename}`);
  fs.writeFileSync(outputPath, image);
  const page = await evaluate(`({ title: document.title, path: location.pathname })`);
  evidence.screenshots.push({
    file: `screenshots/${filename}`,
    title: page.title,
    path: page.path,
    width: 1600,
    height: expandedHeight,
    expectedText,
  });
  process.stdout.write(`[browser-e2e] screenshot ${filename}\n`);
}

async function main() {
  const devToolsPortFile = path.join(browserProfile, "DevToolsActivePort");
  await waitUntil(
    () => fs.existsSync(devToolsPortFile) && fs.statSync(devToolsPortFile).size > 0,
    options.timeoutMs,
    "Chrome DevTools port",
  );
  const [port] = fs.readFileSync(devToolsPortFile, "utf8").trim().split("\n");
  const targets = await waitUntil(
    async () => {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (!response.ok) return null;
      const items = await response.json();
      return items.find((item) => item.type === "page") ? items : null;
    },
    options.timeoutMs,
    "Chrome page target",
  );
  const target = targets.find((item) => item.type === "page");
  cdp = new CdpClient(target.webSocketDebuggerUrl, options.timeoutMs);
  await cdp.connect();
  cdp.on("Runtime.consoleAPICalled", (event) => {
    browserEvents.push({ type: "console", level: event.type });
  });
  cdp.on("Runtime.exceptionThrown", (event) => {
    browserEvents.push({
      type: "exception",
      text: event.exceptionDetails?.text || "uncaught browser exception",
    });
  });
  cdp.on("Network.loadingFailed", (event) => {
    if (!event.canceled)
      browserEvents.push({
        type: "network-failure",
        errorText: event.errorText,
      });
  });
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Network.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1600,
    height: 1200,
    deviceScaleFactor: 1,
    mobile: false,
  });

  await navigate("/login");
  await capture("01-login-page", ["企业中控平台", "用户名", "密码"]);
  recordAssertion("管理端登录页可访问");

  await fillSelector("#username", options.username);
  await fillSelector("#password", options.password);
  await clickText("登录", 'button[type="submit"]');
  await waitForExpression(
    `location.pathname === "/admin" || location.pathname === "/admin/"`,
    "successful browser login redirect",
  );
  await waitForText("数据看板");
  await capture("02-dashboard-after-login", ["数据看板"]);
  recordAssertion("管理员通过浏览器表单登录");

  await clickText("用户与组织", "a");
  await waitForExpression(
    `location.pathname === "/admin/users"`,
    "user management route",
  );
  await waitForText("用户列表");
  await capture("03-user-management", ["用户与组织管理", "用户列表"]);
  recordAssertion("用户管理页面和用户列表可加载");

  await clickText("新建用户", "button");
  await waitForExpression(
    `Boolean(document.querySelector('[role="dialog"]'))`,
    "new user dialog",
  );
  await fillDialogField("用户名", options.createdUsername);
  await fillDialogField("初始密码", options.createdPassword);
  await capture("04-user-create-form", ["新建用户", "初始密码"]);
  recordAssertion("新建用户表单可填写");

  const submitted = await evaluate(`(() => {
    const dialog = document.querySelector('[role="dialog"]');
    const button = [...(dialog?.querySelectorAll("button") || [])]
      .find(item => (item.textContent || "").replace(/\\s+/g, " ").trim() === "创建用户");
    if (!button) return false;
    button.click();
    return true;
  })()`);
  assert(submitted, "Could not submit the new user form");
  await waitForExpression(
    `!document.querySelector('[role="dialog"]') && document.body?.innerText.includes(${JSON.stringify(options.createdUsername)})`,
    "created user in user list",
  );
  await fillSelector(
    'input[placeholder="搜索用户名、部门或邮箱"]',
    options.createdUsername,
  );
  await waitForText(options.createdUsername, "created user name");
  await capture("05-user-created", ["用户列表", options.createdUsername]);
  recordAssertion("通过管理端创建用户并在列表中确认");

  await clickText("会话管理", "a");
  await waitForExpression(
    `location.pathname === "/admin/sessions"`,
    "session management route",
  );
  await waitForText(hostSession.sessionId.slice(0, 12), "host session row");
  await waitForText(dockerSession.sessionId.slice(0, 12), "Docker session row");
  await capture("06-session-management", [
    "会话管理",
    hostSession.sessionId.slice(0, 12),
    dockerSession.sessionId.slice(0, 12),
    "host",
    "docker",
  ]);
  recordAssertion("会话管理列表显示 host 和 Docker 会话");

  await clickSession(hostSession.sessionId);
  await waitForExpression(
    `location.pathname.endsWith(${JSON.stringify(`/sessions/${hostSession.sessionId}`)})`,
    "host session detail route",
  );
  await capture("07-host-session-chat", [
    "对话历史",
    hostSession.sessionId,
    "Reply with this exact token and no additional text",
    hostSession.response,
  ]);
  recordAssertion("host 会话详情显示用户提问和 Mock 回复");

  await clickText("会话管理", "a");
  await waitForExpression(
    `location.pathname === "/admin/sessions"`,
    "session management route after host detail",
  );
  await waitForText(dockerSession.sessionId.slice(0, 12), "Docker session row");
  await clickSession(dockerSession.sessionId);
  await waitForExpression(
    `location.pathname.endsWith(${JSON.stringify(`/sessions/${dockerSession.sessionId}`)})`,
    "Docker session detail route",
  );
  await capture("08-docker-session-chat", [
    "对话历史",
    dockerSession.sessionId,
    "Reply with this exact token and no additional text",
    dockerSession.response,
  ]);
  recordAssertion("Docker 会话详情显示用户提问和 Mock 回复");

  evidence.ok = true;
  evidence.browserEvents = browserEvents;
  writeEvidenceGallery();
  fs.writeFileSync(
    path.join(options.outputDir, "browser-e2e-summary.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
}

main()
  .catch(async (error) => {
    const message =
      error instanceof Error ? error.stack || error.message : String(error);
    evidence.failure = message;
    evidence.browserEvents = browserEvents;
    fs.writeFileSync(
      path.join(options.outputDir, "browser-e2e-summary.json"),
      `${JSON.stringify(evidence, null, 2)}\n`,
    );
    fs.writeFileSync(
      path.join(options.outputDir, "browser-e2e-failure.txt"),
      `${message}\n`,
    );
    if (cdp) {
      try {
        await capture("99-failure", []);
      } catch {
        // Preserve the original browser assertion failure.
      }
    }
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  })
  .finally(stopBrowser);
