// Runs under Node (the store uses node:sqlite, which Bun lacks): `tsx --test`.
// Covers the graceful-drain guards added for multi-instance LB: RuntimeService
// rejects/​no-ops while draining, and writeError maps ServerDrainingError → 503.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type http from "node:http";
import { DirectConnectStore } from "../db.js";
import { RuntimeService, ServerDrainingError } from "../runtimeService.js";
import { writeError } from "../server.js";
import type { AuthService } from "../auth/service.js";
import type { ServerConfig } from "../types.js";
import type { SessionCreateInput, SessionRecord } from "../types.js";

function makeRuntime() {
  const store = new DirectConnectStore(":memory:");
  // Only fields the drain-guard paths touch: maxSessions (createSession, unused
  // because the guard is the first line) and heartbeatTimeoutMs
  // (adoptOrphanedSessions' orphan query). authService/nexusClient are never
  // reached on the guarded paths, so bare stubs are safe.
  const config = { maxSessions: 0, heartbeatTimeoutMs: 30_000 } as unknown as ServerConfig;
  const runtime = new RuntimeService({
    config,
    store,
    authService: {} as unknown as AuthService,
    serverInstanceId: "a",
  });
  return { runtime, store };
}

describe("RuntimeService graceful-drain guards", () => {
  it("draining=true → createSession rejects with ServerDrainingError and writes no session row", async () => {
    const { runtime, store } = makeRuntime();
    runtime.draining = true;
    await assert.rejects(
      () => runtime.createSession({ orgId: "o", userId: "u" } as unknown as SessionCreateInput),
      (e: unknown) => e instanceof ServerDrainingError,
    );
    // The guard is above store.createSession, so no half-created row is left.
    assert.equal((await store.listSessions({ orgId: "o" })).length, 0);
  });

  it("draining=true → spawnAttempt (private choke point) rejects with ServerDrainingError", async () => {
    const { runtime } = makeRuntime();
    runtime.draining = true;
    await assert.rejects(
      // spawnAttempt is private; the guard is its first line and throws before
      // reading the session, so a minimal cast is sufficient to exercise it.
      () => (runtime as unknown as { spawnAttempt: (s: SessionRecord) => Promise<unknown> })
        .spawnAttempt({ sessionId: "s" } as unknown as SessionRecord),
      (e: unknown) => e instanceof ServerDrainingError,
    );
  });

  // Stub the orphan query to record whether it was reached and return no
  // orphans — proving guard behavior without exercising the real query's
  // downstream adoption logic.
  function spyOrphanQuery(store: DirectConnectStore): () => boolean {
    let queried = false;
    (store as unknown as { listOrphanedActiveSessions: (...a: unknown[]) => unknown })
      .listOrphanedActiveSessions = () => {
        queried = true;
        return [];
      };
    return () => queried;
  }

  it("draining=true → adoptOrphanedSessions no-ops (never queries orphans)", async () => {
    const { runtime, store } = makeRuntime();
    const wasQueried = spyOrphanQuery(store);
    runtime.draining = true;
    await runtime.adoptOrphanedSessions();
    assert.equal(wasQueried(), false, "drain must skip orphan adoption entirely");
  });

  it("draining=false (default) → guards inert: adoptOrphanedSessions proceeds to query orphans", async () => {
    const { runtime, store } = makeRuntime();
    const wasQueried = spyOrphanQuery(store);
    assert.equal(runtime.draining, false, "default is off (single-instance behavior)");
    await runtime.adoptOrphanedSessions();
    assert.equal(wasQueried(), true, "default behavior unchanged — orphans are queried");
  });
});

// Minimal ServerResponse fake capturing writeHead status + end body (writeJson
// calls res.writeHead(status, headers) then res.end(payload)).
function fakeRes() {
  const state = { status: 0, body: "" };
  const res = {
    writeHead(status: number) {
      state.status = status;
      return res;
    },
    end(payload?: string) {
      if (payload) state.body = payload;
    },
  };
  return { res: res as unknown as http.ServerResponse, state };
}

describe("writeError → ServerDrainingError maps to 503", () => {
  it("returns 503 with flat { error: <message> } (consistent with other writeError branches)", () => {
    const { res, state } = fakeRes();
    const logger = { error() {} } as unknown as Parameters<typeof writeError>[0];
    writeError(logger, res, new ServerDrainingError());
    assert.equal(state.status, 503);
    assert.deepEqual(JSON.parse(state.body), {
      error: "server is draining, not accepting new sessions",
    });
  });
});
