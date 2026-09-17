// Runs under Node: `tsx --test` (and bun test). Store-level coverage for the
// 2026-09-15 review-verification fixes (dev-baseline batch):
//   A2  setSessionLifecycle conditional write (spawn vs concurrent terminate)
//   A6  markAttemptLost(ownerInstanceId) does not clobber a peer's attempt
//   A10 listOrphanedActiveSessions is bounded (LIMIT 100 per adoption tick)
//   F-25 concurrent registerServerInstance (Promise.all) stays UPSERT-safe
// The daemon/plugin cases (A4 mayStampDaemonLifecycle, A5 stopPluginLocally)
// live in reviewFixesDaemon.test.ts — their import chains carry bun:-protocol
// transitive deps, so that file is Bun-only (same constraint as
// runtimeServiceFencing.test.ts, where the A8 refetch case lives).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DirectConnectStore } from "../db.js";
import { assertSafeInstanceIdentity } from "../startupGuards.js";

function newStore() {
  return new DirectConnectStore(":memory:");
}

async function seedSession(
  store: DirectConnectStore,
  sessionId: string,
  desiredState: "active" | "terminated" | "ended" = "active",
) {
  return store.createSession({
    sessionId,
    transcriptSessionId: `t-${sessionId}`,
    transcriptPath: `/tmp/t-${sessionId}`,
    userId: "u1",
    orgId: "o1",
    role: "user",
    scopes: [],
    cwd: "/tmp",
    runtime: { type: "host", hostMode: "host" } as never,
    status: "active",
    desiredState,
  });
}

async function seedAttempt(store: DirectConnectStore, sessionId: string, ownerInstanceId: string) {
  const attempt = await store.createAttempt({
    sessionId,
    generation: 1,
    backendType: "host",
    resumeTranscriptSessionId: `t-${sessionId}`,
    serverInstanceId: ownerInstanceId,
    attachPath: `/tmp/sock-${sessionId}`,
  });
  // listOrphanedActiveSessions joins sessions.current_attempt_id → the seed
  // must wire the pointer exactly like spawnAttempt does in production.
  await store.setCurrentAttempt(sessionId, attempt.attemptId);
  return attempt;
}

describe("A2: setSessionLifecycle onlyWhenDesiredActive", () => {
  it("overwrites while desired_state is still active (normal spawn-complete path)", async () => {
    const store = newStore();
    await seedSession(store, "s-a2-1", "active");
    await store.setSessionLifecycle("s-a2-1", "active", "active", true);
    const row = await store.getSession("s-a2-1");
    assert.equal(row!.status, "active");
    assert.equal(row!.desiredState, "active");
    store.db.close();
  });

  it("does NOT flip a session the user terminated back to active", async () => {
    const store = newStore();
    await seedSession(store, "s-a2-2", "active");
    // terminateSession's write lands first:
    await store.setSessionLifecycle("s-a2-2", "terminated", "terminated");
    // ... then spawnAttempt's conditional completion write must be a no-op:
    await store.setSessionLifecycle("s-a2-2", "active", "active", true);
    const row = await store.getSession("s-a2-2");
    assert.equal(row!.status, "terminated", "status must stay terminated");
    assert.equal(row!.desiredState, "terminated", "desired_state must stay terminated");
    store.db.close();
  });

  it("without the flag the write stays unconditional (existing callers unchanged)", async () => {
    const store = newStore();
    await seedSession(store, "s-a2-3", "active");
    await store.setSessionLifecycle("s-a2-3", "terminated", "terminated");
    // Legacy call sites (terminate, lost-marking, daemon detach...) rely on the
    // unconditional overwrite semantics — the flag must not leak into them.
    await store.setSessionLifecycle("s-a2-3", "active", "active");
    const row = await store.getSession("s-a2-3");
    assert.equal(row!.status, "active");
    store.db.close();
  });
});

describe("A6: markAttemptLost owner predicate", () => {
  it("does not write 'lost' over an attempt another instance now owns", async () => {
    const store = newStore();
    await seedSession(store, "s-a6-1");
    const attempt = await seedAttempt(store, "s-a6-1", "instance-B");

    // The fencing-wait timeout fires on instance A AFTER a faster survivor
    // (B) re-claimed the attempt: the owner-predicated write must be a no-op.
    await store.markAttemptLost(attempt.attemptId, "fencing wait timed out", "instance-A");
    const after = await store.getAttempt(attempt.attemptId);
    // createAttempt seeds runtime_state='starting' — untouched means untouched.
    assert.equal(after!.runtimeState, "starting", "peer's live attempt must be untouched");

    // The rightful owner's write still lands.
    await store.markAttemptLost(attempt.attemptId, "fencing wait timed out", "instance-B");
    const owned = await store.getAttempt(attempt.attemptId);
    assert.equal(owned!.runtimeState, "lost");
    store.db.close();
  });

  it("without ownerInstanceId the legacy unconditional write is preserved", async () => {
    const store = newStore();
    await seedSession(store, "s-a6-2");
    const attempt = await seedAttempt(store, "s-a6-2", "instance-B");
    await store.markAttemptLost(attempt.attemptId, "attach socket unavailable");
    const after = await store.getAttempt(attempt.attemptId);
    assert.equal(after!.runtimeState, "lost");
    store.db.close();
  });
});

describe("A10: listOrphanedActiveSessions is bounded", () => {
  it("returns at most 100 rows per adoption tick (periodic drain converges)", async () => {
    const store = newStore();
    // 150 active sessions whose attempt owner has no live server_instances row.
    for (let i = 0; i < 150; i++) {
      const sid = `s-a10-${i}`;
      await seedSession(store, sid, "active");
      await seedAttempt(store, sid, "dead-owner");
    }
    const orphans = await store.listOrphanedActiveSessions("self-instance", 30_000);
    assert.equal(orphans.length, 100, "first tick drains a bounded batch");
    // Non-active sessions and live-owner attempts are never listed.
    await seedSession(store, "s-a10-term", "terminated");
    await seedAttempt(store, "s-a10-term", "dead-owner");
    const again = await store.listOrphanedActiveSessions("self-instance", 30_000);
    assert.equal(again.length, 100);
    assert.ok(!again.some(s => s.sessionId === "s-a10-term"), "terminated session excluded");
    store.db.close();
  });
});

describe("F-25: concurrent registerServerInstance", () => {
  it("distinct ids register in parallel without interference", async () => {
    const store = newStore();
    await Promise.all([
      store.registerServerInstance("host-a", 1, "inst-a"),
      store.registerServerInstance("host-b", 2, "inst-b"),
    ]);
    const rows = store.db
      .prepare("SELECT instance_id FROM server_instances ORDER BY instance_id")
      .all() as Array<{ instance_id: string }>;
    assert.deepEqual(rows.map(r => r.instance_id), ["inst-a", "inst-b"]);
    store.db.close();
  });

  it("same-id concurrent re-register stays UPSERT-safe (single row, no crash)", async () => {
    const store = newStore();
    await Promise.all([
      store.registerServerInstance("host-a", 1, "same-id"),
      store.registerServerInstance("host-a", 2, "same-id"),
    ]);
    const rows = store.db
      .prepare("SELECT COUNT(*) AS n FROM server_instances WHERE instance_id = 'same-id'")
      .get() as { n: number };
    assert.equal(Number(rows.n), 1, "stable id UPSERTs over itself — exactly one row");
    store.db.close();
  });
});

describe("E-5: missing instance identity startup guard", () => {
  it("allows a legacy single-node install with publicBaseUrl and no instance id", () => {
    assert.doesNotThrow(() =>
      assertSafeInstanceIdentity(
        { instanceId: undefined, publicBaseUrl: "http://10.0.1.206:43127" },
        0,
      ),
    );
  });

  it("rejects an unidentified process when a live peer already exists", () => {
    assert.throws(
      () =>
        assertSafeInstanceIdentity(
          { instanceId: undefined, publicBaseUrl: "http://moss.example.test" },
          1,
        ),
      /1 live peer instance\(s\) found but MOSS_INSTANCE_ID is not set/,
    );
  });

  it("allows an identified instance and leaves shared-SQLite checks to the next guard", () => {
    assert.doesNotThrow(() =>
      assertSafeInstanceIdentity(
        { instanceId: "moss-206", publicBaseUrl: "http://10.0.1.206:43127" },
        1,
      ),
    );
  });
});
