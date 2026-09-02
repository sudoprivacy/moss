// Runs under Node (the store uses node:sqlite, which Bun lacks): `tsx --test`.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DirectConnectStore } from "../db.js";

const TIMEOUT = 30_000;

function setup() {
  const store = new DirectConnectStore(":memory:");
  const a = store.registerServerInstance("hostA", 1);
  const b = store.registerServerInstance("hostB", 2);
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
  const attempt = store.createAttempt({
    sessionId: "s1",
    generation: 1,
    backendType: "host",
    resumeTranscriptSessionId: "s1",
    serverInstanceId: a.instanceId,
  });
  return { store, a, b, attempt };
}

function makeStale(store: DirectConnectStore, instanceId: string, ageMs: number): void {
  store.db
    .prepare("UPDATE server_instances SET heartbeat_at = ? WHERE instance_id = ?")
    .run(Date.now() - ageMs, instanceId);
}

describe("claimAttempt — concurrent multi-instance HA", () => {
  it("a live owner keeps its attempt (another instance cannot claim)", () => {
    const { store, a, b, attempt } = setup();
    assert.equal(store.claimAttempt(attempt.attemptId, b.instanceId, TIMEOUT), false);
    assert.equal(store.getAttempt(attempt.attemptId)!.serverInstanceId, a.instanceId);
  });

  it("a dead owner (stale heartbeat) is claimable; ownership transfers", () => {
    const { store, a, b, attempt } = setup();
    makeStale(store, a.instanceId, TIMEOUT + 60_000);
    assert.equal(store.claimAttempt(attempt.attemptId, b.instanceId, TIMEOUT), true);
    assert.equal(store.getAttempt(attempt.attemptId)!.serverInstanceId, b.instanceId);
  });

  it("the owner re-claiming its own attempt is idempotent (lease renew)", () => {
    const { store, a, attempt } = setup();
    assert.equal(store.claimAttempt(attempt.attemptId, a.instanceId, TIMEOUT), true);
    assert.equal(store.getAttempt(attempt.attemptId)!.serverInstanceId, a.instanceId);
  });

  it("after failover the new live owner is protected from a third instance", () => {
    const { store, a, b, attempt } = setup();
    makeStale(store, a.instanceId, TIMEOUT + 60_000);
    assert.equal(store.claimAttempt(attempt.attemptId, b.instanceId, TIMEOUT), true);
    const c = store.registerServerInstance("hostC", 3);
    assert.equal(store.claimAttempt(attempt.attemptId, c.instanceId, TIMEOUT), false);
    assert.equal(store.getAttempt(attempt.attemptId)!.serverInstanceId, b.instanceId);
  });

  it("a cleanly stopped owner is claimable", () => {
    const { store, a, b, attempt } = setup();
    store.stopServerInstance(a.instanceId);
    assert.equal(store.claimAttempt(attempt.attemptId, b.instanceId, TIMEOUT), true);
    assert.equal(store.getAttempt(attempt.attemptId)!.serverInstanceId, b.instanceId);
  });
});
