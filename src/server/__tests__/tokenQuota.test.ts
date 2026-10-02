// Runs under Node (the store uses node:sqlite, which Bun lacks): `tsx --test`.
//
// The token budget was enforced at one door only. createSession checked it;
// spawnAttempt — which its own comment calls "the single choke point every
// spin-up funnels through" — did not. A user at their limit could not open a
// new session but could resume an existing one and keep spending: resume, a WS
// cold upgrade, a cron or channel respawn all reach spawnAttempt without ever
// passing createSession.
//
// These assert the gate is on both doors, that a refusal leaves no record, and
// that the refusal reaches the caller as a decision rather than a fault.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type http from "node:http";
import { DirectConnectStore } from "../db.js";
import { RuntimeService, TokenQuotaExceededError } from "../runtimeService.js";
import { writeError } from "../httpRespond.js";
import type { AuthService } from "../auth/service.js";
import type { ServerConfig } from "../types.js";
import type { SessionCreateInput, SessionRecord } from "../types.js";

type Limits = { userLimit: number | null; departmentLimit: number | null };

function makeRuntime(limits: Limits, departmentId: string | null = null) {
  const store = new DirectConnectStore(":memory:");
  const config = { maxSessions: 0, heartbeatTimeoutMs: 30_000 } as unknown as ServerConfig;
  // Both are synchronous on the real AuthService; the quota path uses nothing
  // else from it.
  const authService = {
    buildVisibilityFilter: async () => ({ isAdmin: false, userId: "u", departmentId, visibleDepartmentIds: new Set() }),
    getTokenLimits: () => limits,
    getUserOrNull: () => ({ departmentId }),
  } as unknown as AuthService;
  const runtime = new RuntimeService({ config, store, authService, serverInstanceId: "a" });
  return { runtime, store };
}

/** spawnAttempt is private; the quota guard is at its top, next to the drain guard. */
function spawn(runtime: RuntimeService, session: Partial<SessionRecord>) {
  return (runtime as unknown as { spawnAttempt: (s: SessionRecord) => Promise<unknown> })
    .spawnAttempt(session as SessionRecord);
}

// A limit of 0 is a real limit (null is the "unlimited" value everywhere in
// auth/service.ts), so a user with no sessions and no usage is already at it.
// That keeps these exercising the real loadBudgetStats path with no transcript
// fixtures standing in for it.
const AT_LIMIT: Limits = { userLimit: 0, departmentLimit: null };
const ROOM: Limits = { userLimit: 1_000_000, departmentLimit: null };

describe("token quota is enforced at every door that starts spending", () => {
  it("over the limit → createSession refuses and writes no session row", async () => {
    const { runtime, store } = makeRuntime(AT_LIMIT);
    await assert.rejects(
      () => runtime.createSession({ orgId: "o", userId: "u" } as unknown as SessionCreateInput),
      (e: unknown) => e instanceof TokenQuotaExceededError,
    );
    // The check sits above store.createSession, so a refusal leaves nothing.
    // listSessions is async on the driver-backed store (LB/HA branch).
    assert.equal((await store.listSessions({ orgId: "o" })).length, 0);
  });

  it("over the limit → spawnAttempt refuses (the door resume/WS/cron arrive through)", async () => {
    const { runtime } = makeRuntime(AT_LIMIT);
    await assert.rejects(
      () => spawn(runtime, { sessionId: "s", userId: "u", orgId: "o" }),
      (e: unknown) => e instanceof TokenQuotaExceededError,
      "a session that already exists must not be a way around the budget",
    );
  });

  it("a department limit refuses too, and names the department budget", async () => {
    const { runtime } = makeRuntime({ userLimit: null, departmentLimit: 0 }, "d1");
    await assert.rejects(
      () => spawn(runtime, { sessionId: "s", userId: "u", orgId: "o" }),
      (e: unknown) => e instanceof TokenQuotaExceededError && /部门/.test(e.message),
    );
  });

  it("a department limit on a user with no department does not refuse", async () => {
    const { runtime } = makeRuntime({ userLimit: null, departmentLimit: 0 }, null);
    // Reaches past the quota gate and fails later for an unrelated reason; what
    // matters is that the reason is not the budget.
    await assert.rejects(
      () => spawn(runtime, { sessionId: "s", userId: "u", orgId: "o" }),
      (e: unknown) => !(e instanceof TokenQuotaExceededError),
    );
  });

  it("under the limit → the guard is inert on both doors", async () => {
    const { runtime } = makeRuntime(ROOM);
    await assert.rejects(
      () => spawn(runtime, { sessionId: "s", userId: "u", orgId: "o" }),
      (e: unknown) => !(e instanceof TokenQuotaExceededError),
      "a user with budget left must not be refused by the budget",
    );
  });

  it("no limits set → nothing is computed at all", async () => {
    const { runtime, store } = makeRuntime({ userLimit: null, departmentLimit: null });
    let listed = 0;
    (store as unknown as { listUserSessions: () => unknown[] }).listUserSessions = () => {
      listed++;
      return [];
    };
    await assert.rejects(() => spawn(runtime, { sessionId: "s", userId: "u", orgId: "o" }));
    // Usage is derived by parsing every transcript the user owns. An org with no
    // budgets configured — the default — must not pay for that on every spawn.
    assert.equal(listed, 0, "unlimited must be free, not merely permissive");
  });
});

describe("the derived usage total is computed once per window", () => {
  it("a second check inside the TTL reuses the total instead of re-parsing", async () => {
    const { runtime, store } = makeRuntime(ROOM);
    let listed = 0;
    (store as unknown as { listUserSessions: () => unknown[] }).listUserSessions = () => {
      listed++;
      return [];
    };
    const assertQuota = (runtime as unknown as {
      assertWithinTokenQuota: (u: string, o: string) => Promise<void>;
    }).assertWithinTokenQuota.bind(runtime);

    await assertQuota("u", "o");
    await assertQuota("u", "o");
    // createSession → spawnAttempt is the pair this exists for: two doors, one
    // computation. Without it, every session creation would parse the user's
    // whole transcript history twice.
    assert.equal(listed, 1, "the second check must not recompute");
  });

  it("a different user does not read the first user's total", async () => {
    const { runtime, store } = makeRuntime(ROOM);
    const seen: string[] = [];
    (store as unknown as { listUserSessions: (o: string, u: string) => unknown[] }).listUserSessions = (
      _o: string,
      u: string,
    ) => {
      seen.push(u);
      return [];
    };
    const assertQuota = (runtime as unknown as {
      assertWithinTokenQuota: (u: string, o: string) => Promise<void>;
    }).assertWithinTokenQuota.bind(runtime);

    await assertQuota("u1", "o");
    await assertQuota("u2", "o");
    assert.deepEqual(seen, ["u1", "u2"], "the cache key must separate users");
  });
});

// Minimal ServerResponse fake capturing writeHead status + end body.
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

describe("writeError → TokenQuotaExceededError maps to 403", () => {
  it("a budget refusal is not reported as a server fault", () => {
    const { res, state } = fakeRes();
    const logger = { error() {} } as unknown as Parameters<typeof writeError>[0];
    writeError(logger, res, new TokenQuotaExceededError("个人 Token 额度已用尽 (已用: 10, 限额: 10)"));
    // 500 told the caller moss had broken when moss had decided. The client
    // cannot tell those apart from the status alone, and retries the one it
    // should not.
    assert.equal(state.status, 403);
    assert.deepEqual(JSON.parse(state.body), {
      error: "个人 Token 额度已用尽 (已用: 10, 限额: 10)",
    });
  });
});
