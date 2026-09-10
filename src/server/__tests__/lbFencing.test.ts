// Runs under Node: `tsx --test`. Covers runner fencing (HA):
// touchAttemptHeartbeat's conditional update — the mechanism that makes a
// detached runner exit once another instance claims its attempt (failover)
// or the attempt reaches a terminal state — plus the single-instance
// unconditional mode.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DirectConnectStore } from "../db.js";

function setup() {
  return new DirectConnectStore(":memory:");
}

async function seedAttempt(store: DirectConnectStore, ownerInstanceId: string) {
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
    runtime: { type: "host", engine: "scode", configDir: null, containerName: null } as never,
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

describe("touchAttemptHeartbeat — fencing conditions (HA)", () => {
  it("lands while owner matches and state is running", async () => {
    const store = setup();
    const { attemptId } = await seedAttempt(store, "a");
    const ok = await store.touchAttemptHeartbeat(attemptId, "running", "a");
    assert.equal(ok, true);
    const row = store.db
      .prepare("SELECT runtime_state FROM session_attempts WHERE attempt_id = ?")
      .get(attemptId) as { runtime_state: string };
    assert.equal(row.runtime_state, "running");
  });

  it("fences (returns false, no write) after another instance claimed the attempt", async () => {
    const store = setup();
    await store.registerServerInstance("hostA", 101, "a");
    await store.registerServerInstance("hostB", 202, "b");
    const { attemptId } = await seedAttempt(store, "a");
    // Instance a dies (heartbeat goes stale) — its detached runner is still
    // alive and will keep heartbeating.
    store.db
      .prepare("UPDATE server_instances SET heartbeat_at = ? WHERE instance_id = ?")
      .run(Date.now() - 60_000, "a");
    // Failover: b wins the CAS while a's old runner is still alive.
    const claimed = await store.claimAttempt(attemptId, "b", 30_000);
    assert.equal(claimed, true);

    const ok = await store.touchAttemptHeartbeat(attemptId, "running", "a");
    assert.equal(ok, false, "old owner's heartbeat must not land after the claim");
    const row = store.db
      .prepare("SELECT server_instance_id, runtime_state, last_heartbeat_at FROM session_attempts WHERE attempt_id = ?")
      .get(attemptId) as { server_instance_id: string; runtime_state: string; last_heartbeat_at: number };
    assert.equal(row.server_instance_id, "b");
    assert.equal(row.runtime_state, "starting", "claim transfers ownership only, not state");
    // New owner heartbeats fine.
    assert.equal(await store.touchAttemptHeartbeat(attemptId, "running", "b"), true);
  });

  it("fences when the attempt reached a terminal state (stopped)", async () => {
    const store = setup();
    const { attemptId } = await seedAttempt(store, "a");
    await store.markAttemptStopped(attemptId, { runtimeState: "stopped", stopReason: "terminated" });
    const ok = await store.touchAttemptHeartbeat(attemptId, "running", "a");
    assert.equal(ok, false, "heartbeat must not resurrect a stopped attempt");
    const row = store.db
      .prepare("SELECT runtime_state FROM session_attempts WHERE attempt_id = ?")
      .get(attemptId) as { runtime_state: string };
    assert.equal(row.runtime_state, "stopped");
  });

  it("single-instance mode (no ownerInstanceId) stays unconditional", async () => {
    const store = setup();
    const { attemptId } = await seedAttempt(store, "a");
    await store.markAttemptStopped(attemptId, { runtimeState: "stopped", stopReason: "terminated" });
    // Legacy signature: no owner → unconditional update, always true.
    const ok = await store.touchAttemptHeartbeat(attemptId);
    assert.equal(ok, true);
  });

  it("unknown attempt id without owner returns true (legacy no-op semantics), with owner returns false", async () => {
    const store = setup();
    assert.equal(await store.touchAttemptHeartbeat("nope"), true);
    assert.equal(await store.touchAttemptHeartbeat("nope", "running", "a"), false);
  });
});
