// Runs under Node: `tsx --test`. SQLite-side coverage for the HA claim/reap
// fixes: wiki build-job atomic claim + stale reaper + dynamic-SET no-resurrect
// (B1/R1), and the event-trigger boot reap age threshold (B3/R6). The genuine
// two-pool concurrency races (PG READ COMMITTED) are in pgBackend.test.ts.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DirectConnectStore } from "../db.js";
import { EventTriggerStore } from "../services/eventTrigger/EventTriggerStore.js";

const EVENT_RUN_TIMEOUT_MS = 15 * 60 * 1000;

describe("B1: wiki build-job claim CAS + stale reaper", () => {
  async function seedJob(store: DirectConnectStore, jobId: string) {
    await store.createWiki({ id: `w_${jobId}`, org_id: "o1", name: "W", storage_path: `/tmp/${jobId}`, created_by: "u1" });
    await store.createWikiBuildJob({ id: jobId, wiki_id: `w_${jobId}`, triggered_by: "u1" });
  }

  it("only one claim wins; the second sees nothing left to claim", async () => {
    const store = new DirectConnectStore(":memory:");
    await seedJob(store, "j1");
    const now = Date.now();
    const first = await store.claimQueuedWikiBuildJobs(5, "a", now);
    const second = await store.claimQueuedWikiBuildJobs(5, "b", now);
    assert.equal(first.length, 1);
    assert.equal(second.length, 0);
    assert.equal(String(first[0]!.claimed_by), "a");
    assert.equal(String(first[0]!.status), "running");
    assert.equal(Number(first[0]!.started_at), now);
    store.db.close();
  });

  it("reaper lists only stale running jobs, and a reaped job is not resurrected by a later progress update", async () => {
    const store = new DirectConnectStore(":memory:");
    await seedJob(store, "jstale");
    await seedJob(store, "jfresh");
    const now = Date.now();
    await store.claimQueuedWikiBuildJobs(5, "a", now);        // jstale + jfresh → running
    // Age jstale's claim beyond the timeout; jfresh stays fresh.
    store.db.prepare("UPDATE wiki_build_jobs SET claimed_at = ? WHERE id = ?").run(now - 10 * 3600_000, "jstale");

    const stale = await store.listStaleRunningWikiBuildJobs(now - 3600_000);
    assert.equal(stale.length, 1);
    assert.equal(String(stale[0]!.id), "jstale");

    // Reaper fails it.
    await store.updateWikiBuildJob("jstale", { status: "failed", error_message: "reaped", finished_at: now });
    // A slow owner's progress update carries NO status — dynamic SET must leave
    // the reaped 'failed' intact (no resurrection to 'running').
    await store.updateWikiBuildJob("jstale", { progress: 50, current_step: "still working" });
    const after = await store.getWikiBuildJob("jstale");
    assert.equal(String(after!.status), "failed");
    assert.equal(Number(after!.progress), 50);
    store.db.close();
  });
});

describe("B3: event-trigger boot reap age threshold", () => {
  it("does not reap a freshly created run, but does reap one older than the timeout", async () => {
    const store = new DirectConnectStore(":memory:");
    const ets = new EventTriggerStore(store.driver);
    const now = Date.now();

    const fresh = await ets.createRun({ triggerId: "t1", orgId: "o1", userId: "u1", payloadJson: null });
    assert.ok(fresh);
    // Boot reap threshold = now - (timeout + margin). A run created just now is
    // NOT reaped (this is the fix: a rolling restart must not erase the peer's
    // in-flight/just-enqueued runs).
    const staleBefore = now - (EVENT_RUN_TIMEOUT_MS + 60_000);
    const reapedFresh = await ets.reapStaleRuns(staleBefore, "stale");
    assert.equal(reapedFresh, 0);

    // Age it beyond the threshold → now it IS reaped.
    store.db.prepare("UPDATE event_trigger_runs SET created_at = ? WHERE id = ?").run(now - 60 * 60 * 1000, fresh!.id);
    const reapedOld = await ets.reapStaleRuns(staleBefore, "stale");
    assert.equal(reapedOld, 1);
    store.db.close();
  });
});
