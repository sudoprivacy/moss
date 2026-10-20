// Runs under Node (the store uses node:sqlite, which Bun lacks): `tsx --test`.
//
// A cron run takes a lease that spans the whole run window (~31 min). If the
// lease is not given back when the run ends, a job scheduled more often than
// that is refused at its next slot and only re-fires once the lease expires:
// a `*/15` job ran every ~31 min on ruigu_prod because of this.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DirectConnectStore } from "../db.js";
import { CronService } from "../services/cron/CronService.js";
import { CronStore } from "../services/cron/CronStore.js";

const MIN = 60_000;

function setup() {
  const { db } = new DirectConnectStore(":memory:");
  const store = new CronStore(db);
  const svc = new CronService(db, {
    runtimeService: {} as never,
    runtimeDir: "/tmp/moss-cron-test",
    defaultRuntime: "host",
    dockerContainerMode: "session",
    // No auth → the run fails fast inside executeJob, which is enough to
    // exercise the lease lifecycle around it.
    getUserAuth: async () => null,
  });
  const job = store.insert({
    orgId: "o1",
    userId: "u1",
    name: "every 15 min",
    schedule: { kind: "cron", value: "*/15 * * * *", tz: "Asia/Shanghai" },
    payloadMessage: "hi",
    conversationMode: "new",
  });
  // Make the job due at the current 15-min slot. The post-run backstop reads
  // the real clock, so the test clock has to sit in the same slot.
  const t0 = Math.floor(Date.now() / (15 * MIN)) * 15 * MIN;
  db.prepare("UPDATE cron_jobs SET next_run_at = ?, lease_until = NULL WHERE id = ?").run(t0, job.id);
  const fire = (ts: number) => (svc as any).executeDueJob(job.id, ts) as Promise<void>;
  return { db, store, job, t0, fire };
}

describe("cron lease release", () => {
  it("releases the lease when a run ends, so the next 15-min slot fires", async () => {
    const { store, job, t0, fire } = setup();

    await fire(t0);
    const afterFirst = store.getById(job.id)!;
    assert.equal(afterFirst.leaseUntil, null, "lease must be released after the run");
    assert.equal(afterFirst.nextRunAt, t0 + 15 * MIN);

    await fire(t0 + 15 * MIN);
    assert.equal(store.listRunsByJob(job.id).length, 2, "the next 15-min slot must run");
  });

  it("does not fire the same slot twice", async () => {
    const { store, job, t0, fire } = setup();
    await fire(t0);
    await fire(t0 + 1 * MIN); // the 60s poll, still inside the same slot
    assert.equal(store.listRunsByJob(job.id).length, 1);
  });

  it("only clears its own lease", () => {
    const { db, store, job } = setup();
    db.prepare("UPDATE cron_jobs SET lease_until = ? WHERE id = ?").run(222, job.id);
    store.releaseLease(job.id, 111); // a stale holder giving back an old lease
    assert.equal(store.getById(job.id)!.leaseUntil, 222);
    store.releaseLease(job.id, 222);
    assert.equal(store.getById(job.id)!.leaseUntil, null);
  });
});
