// Runs under Node: `tsx --test`. B-1 regression: the per-source inflight map
// must only be marked once the advisory lock is actually HELD (inside
// runSyncLocked). The old set-before-lock order leaked an inflight entry on
// every lock loss, so after the winner released the lock this instance's tick
// skipped the source until the 30-minute stale cleanup — a failover stalled
// source sync for up to half an hour.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SourceSyncWorker } from "../sources/syncWorker.js";
import type { ExternalSourceRow } from "../sources/types.js";

type LockBehavior = "lose" | "acquire-throw" | "win";

function makeWorker(lockBehavior: LockBehavior): SourceSyncWorker {
  const driver = {
    kind: "postgres" as const,
    async tryRunExclusiveSession(_key: string, fn: () => Promise<unknown>): Promise<unknown> {
      if (lockBehavior === "lose") return null;
      if (lockBehavior === "acquire-throw") throw new Error("lock acquisition blew up");
      return await fn();
    },
  };
  const db = {
    driver,
    async updateExternalSourceSyncStatus(): Promise<void> { /* stub */ },
    async purgeOldSoftDeletes(): Promise<{ documents: number; nodes: number }> {
      return { documents: 0, nodes: 0 };
    },
  };
  const docStore = {};
  return new SourceSyncWorker(db as never, docStore as never);
}

const source: ExternalSourceRow = {
  id: "src1",
  org_id: "o1",
  type: "git",
  name: "s",
  config_json: "{}",
  credentials_secret_key: null,
  sync_interval_sec: 3600,
  auto_build_enabled: 0,
  enabled: 1,
  last_sync_at: null,
  last_sync_status: null,
  last_sync_error: null,
  created_by: "u1",
};

function inflightSize(worker: SourceSyncWorker): number {
  return (worker as unknown as { inflight: Map<string, number> }).inflight.size;
}

describe("B-1: syncWorker inflight marking order", () => {
  it("lock loss returns skipped and does NOT mark inflight", async () => {
    const worker = makeWorker("lose");
    const stats = await (worker as unknown as {
      runSync: (s: ExternalSourceRow) => Promise<{ errors: number }>;
    }).runSync(source);
    assert.equal(stats.errors, 0, "skipped run reports no errors");
    assert.equal(inflightSize(worker), 0, "losing the lock must not leave an inflight entry");
  });

  it("lock acquisition throwing does not mark inflight", async () => {
    const worker = makeWorker("acquire-throw");
    await assert.rejects(() =>
      (worker as unknown as { runSync: (s: ExternalSourceRow) => Promise<unknown> }).runSync(source),
    );
    assert.equal(inflightSize(worker), 0, "acquisition failure must not leave an inflight entry");
  });

  it("lock win cleans inflight after the run (fn errors land in catch, finally deletes)", async () => {
    const worker = makeWorker("win");
    const stats = await (worker as unknown as {
      runSync: (s: ExternalSourceRow) => Promise<{ errors: number }>;
    }).runSync(source);
    // The stub db has no credential/connector machinery, so runSyncLocked's
    // body is expected to fail into its catch (errors > 0) — what matters for
    // B-1 is that the finally releases the inflight mark either way.
    assert.ok(stats.errors > 0, "stubbed run fails into catch");
    assert.equal(inflightSize(worker), 0, "finally must delete the inflight entry");
  });
});
