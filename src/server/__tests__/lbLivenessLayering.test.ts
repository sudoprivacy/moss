// Runs under Node: `tsx --test`. Covers the owner-aware liveness layering of
// ensureAttempt / ensureSessionReadyNonBlocking (P2-2): which quadrant an
// attempt falls into decides probe/spawn behaviour. resumeOnMissingRuntime is
// disabled so the respawn quadrant surfaces as a deterministic "Runtime
// missing" throw instead of actually spawning a runner.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DirectConnectStore } from "../db.js";
import { RuntimeService, AttemptTakeoverPendingError } from "../runtimeService.js";
import type { AuthService } from "../auth/service.js";
import type { ServerConfig } from "../types.js";

function makeRuntime() {
  const store = new DirectConnectStore(":memory:");
  const config = {
    heartbeatTimeoutMs: 30_000,
    reattachProbeTimeoutMs: 200,
    resumeOnMissingRuntime: false,
  } as unknown as ServerConfig;
  const runtime = new RuntimeService({
    config,
    store,
    authService: {} as unknown as AuthService,
    serverInstanceId: "a",
  });
  return { runtime, store };
}

async function seed(store: DirectConnectStore, opts: { owner: string; ownerLive: boolean; heartbeatAgeMs: number | null }) {
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
    serverInstanceId: opts.owner,
    attachPath: process.platform === "win32"
      ? `\\\\.\\pipe\\moss-test-${Math.random().toString(36).slice(2)}`
      : `/tmp/moss-test-${Math.random().toString(36).slice(2)}.sock`,
  });
  await store.registerServerInstance("hostB", 202, "b");
  if (!opts.ownerLive) {
    store.db
      .prepare("UPDATE server_instances SET heartbeat_at = ? WHERE instance_id = ?")
      .run(Date.now() - 60_000, "b");
  }
  // Bind the attempt as the session's current attempt (spawnAttempt does
  // this in production; the seed must mirror it or ensure sees no attempt).
  await store.setCurrentAttempt(sessionId, attempt.attemptId)
  if (opts.heartbeatAgeMs !== null) {
    store.db
      .prepare("UPDATE session_attempts SET last_heartbeat_at = ? WHERE attempt_id = ?")
      .run(Date.now() - opts.heartbeatAgeMs, attempt.attemptId);
  }
  return { sessionId, attemptId: attempt.attemptId };
}

describe("ensureAttempt — owner-aware liveness layering (P2-2)", () => {
  it("another LIVE owner: returns metadata, no local spawn/lost (409/route handles it)", async () => {
    const { runtime, store } = makeRuntime();
    const { sessionId, attemptId } = await seed(store, { owner: "b", ownerLive: true, heartbeatAgeMs: 1_000 });
    const ready = await runtime.ensureSessionReady(sessionId);
    assert.equal(ready.attempt.attemptId, attemptId);
    const row = store.db
      .prepare("SELECT runtime_state, server_instance_id FROM session_attempts WHERE attempt_id = ?")
      .get(attemptId) as { runtime_state: string; server_instance_id: string };
    assert.equal(row.runtime_state, "starting", "must not mark another owner's attempt lost");
    assert.equal(row.server_instance_id, "b", "must not claim a live owner's attempt");
  });

  it("dead owner + fresh runner heartbeat (claim window): AttemptTakeoverPendingError", async () => {
    const { runtime, store } = makeRuntime();
    const { sessionId } = await seed(store, { owner: "b", ownerLive: false, heartbeatAgeMs: 1_000 });
    await assert.rejects(
      () => runtime.ensureSessionReady(sessionId),
      (e: unknown) => e instanceof AttemptTakeoverPendingError,
    );
    // The claim happened (owner moved to us) — fencing now owns the respawn.
    const session = await store.getSession(sessionId);
    const row = store.db
      .prepare("SELECT server_instance_id FROM session_attempts WHERE attempt_id = ?")
      .get(session!.currentAttemptId!) as { server_instance_id: string };
    assert.equal(row.server_instance_id, "a");
  });

  it("dead owner + expired heartbeat: falls to respawn path (lost + Runtime missing with resume off)", async () => {
    const { runtime, store } = makeRuntime();
    const { sessionId } = await seed(store, { owner: "b", ownerLive: false, heartbeatAgeMs: 60_000 });
    await assert.rejects(
      () => runtime.ensureSessionReady(sessionId),
      (e: unknown) => e instanceof Error && /Runtime missing/.test((e as Error).message),
    );
    const session = await store.getSession(sessionId);
    const row = store.db
      .prepare("SELECT runtime_state FROM session_attempts WHERE attempt_id = ?")
      .get(session!.currentAttemptId!) as { runtime_state: string };
    assert.equal(row.runtime_state, "lost");
  });

  it("ensureSessionReadyNonBlocking: another live owner → metadata only, no lifecycle rewrite, no respawn kick", async () => {
    const { runtime, store } = makeRuntime();
    const { sessionId, attemptId } = await seed(store, { owner: "b", ownerLive: true, heartbeatAgeMs: 1_000 });
    const before = store.db
      .prepare("SELECT status FROM sessions WHERE session_id = ?")
      .get(sessionId) as { status: string };
    const result = await runtime.ensureSessionReadyNonBlocking(sessionId);
    assert.ok(result.session);
    const after = store.db
      .prepare("SELECT status FROM sessions WHERE session_id = ?")
      .get(sessionId) as { status: string };
    assert.equal(after.status, before.status, "must not rewrite lifecycle for a foreign owner");
    const row = store.db
      .prepare("SELECT runtime_state FROM session_attempts WHERE attempt_id = ?")
      .get(attemptId) as { runtime_state: string };
    assert.equal(row.runtime_state, "starting", "no lost/spawn side effects");
  });
});
