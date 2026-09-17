// Runs under Node (the store uses node:sqlite, which Bun lacks): `tsx --test`.
// Covers the owner-aware routing slice of the LB HA plan: getAttemptOwnerStatus
// (db), buildWsUrl (route query + regression anchors) and wsRouteHint, all
// exported from db.ts / server.ts for testability.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type http from "node:http";
import { DirectConnectStore } from "../db.js";
import { buildWsUrl, wsRouteHint } from "../server.js";
import type { ServerConfig } from "../types.js";

function setup() {
  return new DirectConnectStore(":memory:");
}

async function seedSessionAndAttempt(store: DirectConnectStore, ownerInstanceId: string) {
  const sessionId = `s_${Math.random().toString(36).slice(2)}`;
  await store.createSession({
    sessionId,
    transcriptSessionId: "t1",
    transcriptPath: "/tmp/t.jsonl",
    userId: "u1",
    orgId: "o1",
    role: "user",
    scopes: [],
    cwd: "/tmp",
    runtime: {
      type: "host",
      engine: "scode",
      configDir: null,
      containerName: null,
    } as never,
    status: "active",
    desiredState: "active",
  });
  const attempt = await store.createAttempt({
    sessionId,
    generation: 1,
    backendType: "host",
    resumeTranscriptSessionId: "t1",
    serverInstanceId: ownerInstanceId,
    attachPath: "/tmp/x.sock",
  });
  return { sessionId, attemptId: attempt.attemptId };
}

describe("getAttemptOwnerStatus — owner metadata for LB routing", () => {
  it("returns the live owner for a fresh heartbeat", async () => {
    const store = setup();
    await store.registerServerInstance("hostA", 101, "a");
    const { attemptId } = await seedSessionAndAttempt(store, "a");
    const status = await store.getAttemptOwnerStatus(attemptId, 30_000);
    assert.equal(status.ownerInstanceId, "a");
    assert.equal(status.ownerLive, true);
  });

  it("reports owner dead when the instance heartbeat is stale", async () => {
    const store = setup();
    await store.registerServerInstance("hostA", 101, "a");
    const { attemptId } = await seedSessionAndAttempt(store, "a");
    store.db
      .prepare("UPDATE server_instances SET heartbeat_at = ? WHERE instance_id = ?")
      .run(Date.now() - 60_000, "a");
    const status = await store.getAttemptOwnerStatus(attemptId, 30_000);
    assert.equal(status.ownerInstanceId, "a");
    assert.equal(status.ownerLive, false);
  });

  it("reports owner dead after stopServerInstance", async () => {
    const store = setup();
    await store.registerServerInstance("hostA", 101, "a");
    const { attemptId } = await seedSessionAndAttempt(store, "a");
    await store.stopServerInstance("a");
    const status = await store.getAttemptOwnerStatus(attemptId, 30_000);
    assert.equal(status.ownerInstanceId, "a");
    assert.equal(status.ownerLive, false);
  });

  it("returns null/false for an unknown attempt id", async () => {
    const store = setup();
    const status = await store.getAttemptOwnerStatus("nope", 30_000);
    assert.equal(status.ownerInstanceId, null);
    assert.equal(status.ownerLive, false);
  });

  it("returns null owner when server_instance_id is NULL", async () => {
    const store = setup();
    await store.registerServerInstance("hostA", 101, "a");
    const { attemptId } = await seedSessionAndAttempt(store, "a");
    store.db
      .prepare("UPDATE session_attempts SET server_instance_id = NULL WHERE attempt_id = ?")
      .run(attemptId);
    const status = await store.getAttemptOwnerStatus(attemptId, 30_000);
    assert.equal(status.ownerInstanceId, null);
    assert.equal(status.ownerLive, false);
  });
});

function makeConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 43127,
    advertisedHost: undefined as unknown as string,
    publicBaseUrl: undefined as unknown as string,
    instanceId: "a",
    routeCookieName: "moss_route",
    routeCookieSecure: false,
    ...overrides,
  } as ServerConfig;
}

const fakeServer = { address: () => ({ port: 45678 }) } as unknown as http.Server;

describe("buildWsUrl — owner route query", () => {
  it("regression anchor: publicBaseUrl path unchanged without route", () => {
    const url = buildWsUrl(fakeServer, makeConfig({ publicBaseUrl: "http://lb.example.com/base/" }), "sid1");
    assert.equal(url, "ws://lb.example.com/base/ws/sessions/sid1");
  });

  it("regression anchor: local derivation unchanged without route", () => {
    const url = buildWsUrl(fakeServer, makeConfig(), "sid1");
    assert.equal(url, "ws://127.0.0.1:45678/ws/sessions/sid1");
  });

  it("regression anchor: https publicBaseUrl maps to wss", () => {
    const url = buildWsUrl(fakeServer, makeConfig({ publicBaseUrl: "https://lb.example.com" }), "sid1");
    assert.equal(url, "wss://lb.example.com/ws/sessions/sid1");
  });

  it("appends ?moss_route=<owner> when routeInstance is set (after basePath)", () => {
    const url = buildWsUrl(
      fakeServer,
      makeConfig({ publicBaseUrl: "http://lb.example.com/base" }),
      "sid1",
      "a",
    );
    assert.equal(url, "ws://lb.example.com/base/ws/sessions/sid1?moss_route=a");
  });

  it("honours a custom routeCookieName as the query parameter name", () => {
    const url = buildWsUrl(
      fakeServer,
      makeConfig({ publicBaseUrl: "http://lb.example.com", routeCookieName: "lbroute" }),
      "sid1",
      "a",
    );
    assert.equal(url, "ws://lb.example.com/ws/sessions/sid1?lbroute=a");
  });

  it("URL-encodes instance ids that need it", () => {
    const url = buildWsUrl(
      fakeServer,
      makeConfig({ publicBaseUrl: "http://lb.example.com" }),
      "sid1",
      "host-a",
    );
    assert.equal(url, "ws://lb.example.com/ws/sessions/sid1?moss_route=host-a");
  });

  it("null/undefined routeInstance keeps the URL bare", () => {
    const cfg = makeConfig({ publicBaseUrl: "http://lb.example.com" });
    assert.equal(buildWsUrl(fakeServer, cfg, "sid1", null), "ws://lb.example.com/ws/sessions/sid1");
    assert.equal(buildWsUrl(fakeServer, cfg, "sid1", undefined), "ws://lb.example.com/ws/sessions/sid1");
  });
});

describe("wsRouteHint — when to stick ws_url to the owner", () => {
  const liveOwner = { ownerInstanceId: "a", ownerLive: true };

  it("returns the owner id for a live owner behind an LB in multi-instance mode", () => {
    assert.equal(wsRouteHint(makeConfig({ publicBaseUrl: "http://lb" }), liveOwner), "a");
  });

  it("returns the owner id even when owner == self (deterministic routing)", () => {
    assert.equal(wsRouteHint(makeConfig({ publicBaseUrl: "http://lb", instanceId: "a" }), liveOwner), "a");
  });

  it("returns null when instanceId is not configured (single instance)", () => {
    assert.equal(
      wsRouteHint(makeConfig({ publicBaseUrl: "http://lb", instanceId: undefined as unknown as string }), liveOwner),
      null,
    );
  });

  it("returns null without publicBaseUrl (no LB to route through)", () => {
    assert.equal(wsRouteHint(makeConfig(), liveOwner), null);
  });

  it("returns null for a dead owner (falls to pool for CAS adoption)", () => {
    assert.equal(wsRouteHint(makeConfig({ publicBaseUrl: "http://lb" }), { ownerInstanceId: "a", ownerLive: false }), null);
  });

  it("returns null when there is no owner at all", () => {
    assert.equal(wsRouteHint(makeConfig({ publicBaseUrl: "http://lb" }), { ownerInstanceId: null, ownerLive: false }), null);
  });
});
