// Runs under Node (the store uses node:sqlite, which Bun lacks): `tsx --test`.
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "http";
import { randomUUID } from "crypto";
import { DirectConnectStore } from "../db.js";
import type { RuntimeService } from "../runtimeService.js";
import type {
  AuthProxyRule,
  AuthProxyServer,
  SessionTokenResolver,
} from "../authProxy/authProxyServer.js";
import type { NexusClient } from "../nexus/nexusClient.js";

/**
 * A session runner's auth-proxy bearer token must stay valid for exactly as
 * long as its attempt is the session's live attempt. It used to live only in
 * the proxy's memory with a fixed 24h TTL from spawn, so a long-lived channel
 * (WeCom) session silently lost every injected credential after a day — and
 * every session lost them on a server restart — with `fetchurl` returning
 * {"error":"invalid_token"}.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

// The proxy reads its listen port at import time, so both it and
// runtimeService (which imports it) are loaded only after this is set.
process.env.MOSS_AUTH_PROXY_PORT = "0";
let RuntimeServiceCtor: typeof RuntimeService;

type User = { status: string; departmentId: string | null; role: string };

function setup() {
  const store = new DirectConnectStore(":memory:");
  const instance = store.registerServerInstance("host", 1);
  store.createSession({
    sessionId: "s1",
    transcriptSessionId: "s1",
    transcriptPath: "/t",
    userId: "u1",
    orgId: "o1",
    role: "user",
    scopes: ["*"],
    cwd: "/w",
    runtime: { type: "host" } as never,
    status: "active" as never,
    desiredState: "active" as never,
  });
  const users = new Map<string, User>([
    ["u1", { status: "active", departmentId: "d1", role: "member" }],
  ]);
  // resolveAuthProxyToken only touches store + authService; spare the full
  // RuntimeService constructor (backends, nexus, config) for this unit.
  const runtime = Object.create(RuntimeServiceCtor.prototype) as RuntimeService;
  Object.assign(runtime, {
    store,
    authService: { getUserById: (id: string) => users.get(id) ?? null },
  });
  const resolver: SessionTokenResolver = hash => runtime.resolveAuthProxyToken(hash);

  let generation = 0;
  function spawnAttempt(hashFn: (t: string) => string) {
    const attempt = store.createAttempt({
      sessionId: "s1",
      generation: ++generation,
      backendType: "host",
      resumeTranscriptSessionId: "s1",
      serverInstanceId: instance.instanceId,
    });
    store.setCurrentAttempt("s1", attempt.attemptId);
    const token = randomUUID();
    store.setAttemptAuthProxyTokenHash(attempt.attemptId, hashFn(token));
    return { attempt, token };
  }
  return { store, users, resolver, spawnAttempt };
}

describe("auth proxy session tokens (DB-backed)", () => {
  let mod: typeof import("../authProxy/authProxyServer.js");
  let upstream: Server;
  let upstreamPort = 0;
  const seen: IncomingMessage["headers"][] = [];
  const proxies: AuthProxyServer[] = [];
  const realNow = Date.now;
  let clockOffset = 0;

  function rule(): AuthProxyRule {
    return {
      configItemId: 9,
      name: "whoami",
      urlPattern: `http://127.0.0.1:${upstreamPort}/*`,
      scheme: "bearer",
      bearerPrefix: "",
      scope: "user",
      orgId: null,
      secretNamespace: "user:{userId}:whoami",
      entries: [{ configKey: "whoami", name: "我是谁", required: true }],
      authType: "static",
      pinyin: "whoami",
    } as AuthProxyRule;
  }

  async function newProxy(resolver: SessionTokenResolver): Promise<AuthProxyServer> {
    const proxy = new mod.AuthProxyServer();
    proxy.setNexusClient({
      getSecret: async (ns: string, key: string) => ({ value: `${ns}/${key}` }),
    } as unknown as NexusClient);
    proxy.setSessionTokenResolver(resolver);
    proxy.updateRules([rule()]);
    await proxy.start();
    proxies.push(proxy);
    return proxy;
  }

  async function call(proxy: AuthProxyServer, token: string): Promise<number> {
    const res = await fetch(`http://127.0.0.1:${proxy.port}/proxy`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Remote-URL": `http://127.0.0.1:${upstreamPort}/headers`,
        "X-Remote-Method": "GET",
      },
    });
    await res.text();
    return res.status;
  }

  before(async () => {
    mod = await import("../authProxy/authProxyServer.js");
    RuntimeServiceCtor = (await import("../runtimeService.js")).RuntimeService;
    upstream = createServer((req, res) => {
      seen.push(req.headers);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
    await new Promise<void>(r => upstream.listen(0, "127.0.0.1", () => r()));
    upstreamPort = (upstream.address() as { port: number }).port;
    Date.now = () => realNow() + clockOffset;
  });

  after(async () => {
    Date.now = realNow;
    for (const p of proxies) await p.stop();
    await new Promise<void>(r => upstream.close(() => r()));
    delete process.env.MOSS_AUTH_PROXY_PORT;
  });

  beforeEach(() => {
    seen.length = 0;
    clockOffset = 0;
  });

  it("resolves the runner token and injects the session user's credential", async () => {
    const { resolver, spawnAttempt } = setup();
    const { token } = spawnAttempt(mod.hashAuthProxyToken);
    const proxy = await newProxy(resolver);
    assert.equal(await call(proxy, token), 200);
    assert.equal(seen[0].authorization, "Bearer user:u1:whoami/whoami");
  });

  it("stays valid more than 24h after spawn while the attempt is live", async () => {
    const { resolver, spawnAttempt } = setup();
    const { token } = spawnAttempt(mod.hashAuthProxyToken);
    const proxy = await newProxy(resolver);
    assert.equal(await call(proxy, token), 200);
    clockOffset = 3 * DAY_MS;
    assert.equal(await call(proxy, token), 200);
  });

  it("survives a proxy restart (nothing held in memory)", async () => {
    const { resolver, spawnAttempt } = setup();
    const { token } = spawnAttempt(mod.hashAuthProxyToken);
    const first = await newProxy(resolver);
    assert.equal(await call(first, token), 200);
    const restarted = await newProxy(resolver);
    assert.equal(await call(restarted, token), 200);
  });

  it("is rejected once its attempt stops", async () => {
    const { store, resolver, spawnAttempt } = setup();
    const { attempt, token } = spawnAttempt(mod.hashAuthProxyToken);
    const proxy = await newProxy(resolver);
    assert.equal(await call(proxy, token), 200);
    store.markAttemptLost(attempt.attemptId, "gone");
    proxy.evictSessionTokenHash(mod.hashAuthProxyToken(token));
    assert.equal(await call(proxy, token), 401);
  });

  it("re-checks the DB after the cache window even without an eviction", async () => {
    const { store, resolver, spawnAttempt } = setup();
    const { attempt, token } = spawnAttempt(mod.hashAuthProxyToken);
    const proxy = await newProxy(resolver);
    assert.equal(await call(proxy, token), 200);
    store.markAttemptLost(attempt.attemptId, "gone");
    clockOffset = 31_000;
    assert.equal(await call(proxy, token), 401);
  });

  it("rejects the previous attempt's token after a respawn", async () => {
    const { resolver, spawnAttempt } = setup();
    const old = spawnAttempt(mod.hashAuthProxyToken);
    const fresh = spawnAttempt(mod.hashAuthProxyToken);
    const proxy = await newProxy(resolver);
    assert.equal(await call(proxy, old.token), 401);
    assert.equal(await call(proxy, fresh.token), 200);
  });

  it("rejects tokens of terminated sessions and disabled users", async () => {
    const { store, users, resolver, spawnAttempt } = setup();
    const { token } = spawnAttempt(mod.hashAuthProxyToken);
    const hash = mod.hashAuthProxyToken(token);
    assert.ok(resolver(hash));
    users.set("u1", { status: "disabled", departmentId: "d1", role: "member" });
    assert.equal(resolver(hash), null);
    users.set("u1", { status: "active", departmentId: "d1", role: "member" });
    store.setSessionLifecycle("s1", "terminated", "terminated");
    assert.equal(resolver(hash), null);
  });

  it("reads department and admin role live, not frozen at spawn", () => {
    const { users, resolver, spawnAttempt } = setup();
    const { token } = spawnAttempt(mod.hashAuthProxyToken);
    const hash = mod.hashAuthProxyToken(token);
    assert.deepEqual(resolver(hash), { userId: "u1", orgId: "o1", departmentId: "d1", isAdmin: false });
    users.set("u1", { status: "active", departmentId: "d2", role: "admin" });
    assert.deepEqual(resolver(hash), { userId: "u1", orgId: "o1", departmentId: "d2", isAdmin: true });
  });

  it("rejects unknown tokens and stores only the hash", async () => {
    const { store, resolver, spawnAttempt } = setup();
    const { attempt, token } = spawnAttempt(mod.hashAuthProxyToken);
    const proxy = await newProxy(resolver);
    assert.equal(await call(proxy, randomUUID()), 401);
    const row = store.db
      .prepare("SELECT auth_proxy_token_hash FROM session_attempts WHERE attempt_id = ?")
      .get(attempt.attemptId) as { auth_proxy_token_hash: string };
    assert.notEqual(row.auth_proxy_token_hash, token);
    assert.equal(store.getAttempt(attempt.attemptId)!.authProxyTokenHash, mod.hashAuthProxyToken(token));
  });

  it("keeps explicitly registered (admin test) tokens on their fixed TTL", async () => {
    const { resolver } = setup();
    const proxy = await newProxy(resolver);
    proxy.registerToken("test-token", "u1", "o1", null, false, null);
    assert.equal(await call(proxy, "test-token"), 200);
    clockOffset = DAY_MS + 1;
    assert.equal(await call(proxy, "test-token"), 401);
  });
});
