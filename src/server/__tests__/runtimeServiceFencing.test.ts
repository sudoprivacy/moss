// A-1/A-4 regression suite with a stubbed store: the background fencing-wait
// must never resurrect a session the user terminated (desiredState !=
// 'active'), and the startup stale-cleanup must not stamp a FRESH-heartbeat
// attempt stopped (that is what made startup retire a healthy session after
// a cross-host adopt).
// NOTE: runnable under Bun only — runtimeService.ts's transitive deps
// include bun-only imports (same class as the 15 baseline files the audit
// report recorded as `protocol 'bun:'` environment failures under Node).
import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { RuntimeService } from "../runtimeService.js";
import type { SessionRecord, AttemptRecord } from "../types.js";

interface StoreStub {
  getSession: ReturnType<typeof mock.fn>;
  getAttempt: ReturnType<typeof mock.fn>;
  markAttemptStopped: ReturnType<typeof mock.fn>;
  markAttemptLost: ReturnType<typeof mock.fn>;
  addEvent: ReturnType<typeof mock.fn>;
  claimAttempt: ReturnType<typeof mock.fn>;
  listAttemptsByRuntimeState: ReturnType<typeof mock.fn>;
  listSessionsToRecover: ReturnType<typeof mock.fn>;
  ensureAttemptSpy: ReturnType<typeof mock.fn>;
}

function makeService(overrides: {
  session: Partial<SessionRecord>;
  attempt: Partial<AttemptRecord> | null;
}): { svc: RuntimeService; stub: StoreStub } {
  const session: SessionRecord = {
    sessionId: "s1",
    orgId: "o1",
    userId: "u1",
    status: "active",
    desiredState: "active",
    currentAttemptId: "a1",
    runtime: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides.session,
  } as SessionRecord;
  const attempt: AttemptRecord | null = overrides.attempt
    ? ({
        attemptId: "a1",
        sessionId: "s1",
        generation: 1,
        serverInstanceId: "i-self",
        runtimeState: "running",
        runnerPid: null,
        attachPath: null,
        lastHeartbeatAt: Date.now(),
        createdAt: Date.now(),
        ...overrides.attempt,
      } as AttemptRecord)
    : null;
  const ensureAttemptSpy = mock.fn(async () => {
    throw new Error("ensureAttempt must not run in this scenario");
  });
  const stub: StoreStub = {
    getSession: mock.fn(async () => session),
    getAttempt: mock.fn(async () => attempt),
    markAttemptStopped: mock.fn(async () => 1),
    markAttemptLost: mock.fn(async () => 1),
    addEvent: mock.fn(async () => {}),
    claimAttempt: mock.fn(async () => true),
    listAttemptsByRuntimeState: mock.fn(async () => (attempt ? [attempt] : [])),
    listSessionsToRecover: mock.fn(async () => []),
    ensureAttemptSpy,
  };
  const svc = new RuntimeService({
    store: stub as never,
    authService: null,
    serverInstanceId: "i-self",
    config: {
      dbBackend: "sqlite",
      runtimeDir: "/tmp/moss-test-rt",
      heartbeatTimeoutMs: 30_000,
      reattachProbeTimeoutMs: 3_000,
      resumeOnMissingRuntime: true,
      defaultRuntime: "host",
    },
  } as never);
  return { svc, stub };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise(resolve => setImmediate(resolve));
  }
}

describe("A-1: fencing-wait respawn honours desiredState", () => {
  it("does NOT respawn (nor mark lost) a session terminated while waiting", async () => {
    // Cross-host adopt claimed the attempt; the user then terminated it via
    // the new owner: attempt is terminal (stopped → not fresh) and
    // desiredState='terminated'. The poll fires: it must release the wait
    // slot and do NOTHING else.
    const { svc, stub } = makeService({
      session: { desiredState: "terminated", status: "terminated" },
      attempt: { runtimeState: "stopped", lastHeartbeatAt: Date.now() - 60_000 },
    });
    // ensureAttempt would throw if called; also assert via the store writes.
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      (svc as unknown as { "#scheduleFencingWait": (s: SessionRecord) => void })["#scheduleFencingWait"](
        { sessionId: "s1" } as SessionRecord,
      );
      await mock.timers.tick(5_000);
      await flushMicrotasks();
      assert.equal(stub.markAttemptLost.mock.callCount(), 0, "no markAttemptLost for a terminated session");
      assert.equal(stub.getSession.mock.callCount() > 0, true, "poll ran and read the session");
    } finally {
      mock.timers.reset();
    }
    // ensureAttempt never ran — proven by the absence of an addEvent
    // 'reconcile_failed' (its catch writes one) and no spawn-side writes.
    const events = stub.addEvent.mock.calls.map(c => (c.arguments[2] as string | null));
    assert.ok(!events.includes("reconcile_failed"), "ensureAttempt (and its catch) must not run");
    assert.ok(!events.includes("attempt_lost"), "no attempt_lost event");
  });

  it("respawns normally for an active session whose attempt went stale", async () => {
    // Same wait, healthy session: attempt not fresh → the respawn path runs.
    const { svc, stub } = makeService({
      session: { desiredState: "active" },
      attempt: { runtimeState: "running", lastHeartbeatAt: Date.now() - 120_000 },
    });
    // Make ensureAttempt observable instead of throwing.
    const realEnsure = (svc as unknown as { ensureAttempt: (s: SessionRecord) => Promise<unknown> }).ensureAttempt;
    (svc as unknown as { ensureAttempt: unknown }).ensureAttempt = async () => {
      await realEnsure.call(svc, { sessionId: "s1" } as SessionRecord).catch(() => {});
      stub.ensureAttemptSpy();
    };
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      (svc as unknown as { "#scheduleFencingWait": (s: SessionRecord) => void })["#scheduleFencingWait"](
        { sessionId: "s1" } as SessionRecord,
      );
      await mock.timers.tick(5_000);
      await flushMicrotasks();
      assert.equal(stub.ensureAttemptSpy.mock.callCount(), 1, "active session respawns via ensureAttempt");
    } finally {
      mock.timers.reset();
    }
  });
});

describe("A-4: startup stale-cleanup skips fresh-heartbeat attempts", () => {
  it("does not markAttemptStopped a fresh attempt whose pid is not probeable locally", async () => {
    // Cross-host adopt shape: pid recorded, not alive on THIS host (probe
    // false), heartbeat still fresh. The old code stamped it stopped, which
    // retired the healthy session in the loop below; it must be skipped.
    const { svc, stub } = makeService({
      session: { desiredState: "active" },
      attempt: { runtimeState: "running", runnerPid: 999999999, lastHeartbeatAt: Date.now() },
    });
    await svc.reconcileOnStartup();
    assert.equal(stub.markAttemptStopped.mock.callCount(), 0, "fresh attempt must not be stamped stopped");
  });

  it("still stamps stopped a genuinely dead attempt (stale heartbeat, dead pid)", async () => {
    const { svc, stub } = makeService({
      session: { desiredState: "active" },
      attempt: { runtimeState: "running", runnerPid: 999999999, lastHeartbeatAt: Date.now() - 120_000 },
    });
    await svc.reconcileOnStartup();
    assert.equal(stub.markAttemptStopped.mock.callCount(), 1, "dead attempt is still cleaned up");
  });
});
