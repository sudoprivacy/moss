// PG backend verification (P1-4). Runs ONLY when MOSS_PG_TEST_URL points at a
// throwaway PostgreSQL instance (docker run postgres:16-alpine — see the
// command in the P1 memory/plan); without it every suite skips, so the
// regular lb* sqlite baseline is unaffected.
//
// Covers the items the sqlite-only dev loop cannot prove: the full pg_schema
// DDL, IDENTITY + RETURNING id, BIGINT typeParser normalisation, the
// json_array_elements co-owner branch, LIKE-on-text, the corp-app seq unique
// index + 23505 retry under concurrent inserts, claimAttempt CAS / fencing on
// PG, tryRunExclusive advisory-lock mutual exclusion across two pools, and
// the AuthCenterDb shared-store (postgres) construction form.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { PgDriver, type PgPoolLike } from "../db/driver.js";
import { applyPgSchema } from "../db/pg_schema.js";
import { DirectConnectStore, forPostgresDirectConnectStore } from "../db.js";
import { CronStore } from "../services/cron/CronStore.js";
import { AuthCenterDb } from "../authCenter/db.js";

const PG_URL = process.env.MOSS_PG_TEST_URL ?? "";

function createAdminPool(): Pool {
  // Pool construction is lazy (no connection until first query), so this
  // stays synchronous — the admin pool talks to the server's default db.
  return new Pool({ connectionString: PG_URL, max: 2 });
}

/** Fresh throwaway database per test file run (full schema isolation). */
async function createFreshDatabase(admin: Pool): Promise<string> {
  const dbName = `moss_pg_test_${Math.random().toString(36).slice(2, 10)}`;
  await admin.query(`CREATE DATABASE ${dbName}`);
  return dbName;
}

async function dropDatabase(admin: Pool, dbName: string): Promise<void> {
  // Terminate lingering connections first, or DROP hangs on pool checkout.
  await admin.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [dbName],
  );
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
}

interface PgFixture {
  driver: PgDriver;
  store: DirectConnectStore;
  release: () => Promise<void>;
}

async function openFixture(dbName: string): Promise<PgFixture> {
  const url = PG_URL.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`);
  const { types } = await import("pg");
  // Same global normalisation openStoreAsync installs (int8 → number).
  types.setTypeParser(20, Number);
  const pool = new Pool({ connectionString: url, max: 4 });
  const driver = new PgDriver(pool as unknown as PgPoolLike);
  await applyPgSchema(driver);
  const store = forPostgresDirectConnectStore(driver);
  return {
    driver,
    store,
    release: async () => {
      await pool.end();
    },
  };
}

const seedSession = async (store: DirectConnectStore, ownerInstanceId: string) => {
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
    status: "active" as never,
    desiredState: "active" as never,
  });
  const attempt = await store.createAttempt({
    sessionId,
    generation: 1,
    backendType: "host",
    resumeTranscriptSessionId: "t1",
    serverInstanceId: ownerInstanceId,
    attachPath: "/tmp/x.sock",
  });
  await store.setCurrentAttempt(sessionId, attempt.attemptId);
  return { sessionId, attemptId: attempt.attemptId };
};

describe("pg backend (P1-4)", { skip: !PG_URL }, () => {
  const admin = createAdminPool();
  let dbName = "";
  let fix!: PgFixture;

  before(async () => {
    dbName = await createFreshDatabase(admin);
    fix = await openFixture(dbName);
  });

  after(async () => {
    await fix?.release();
    await dropDatabase(admin, dbName);
    await admin.end();
  });

  describe("pg_schema + type normalisation", () => {
    it("applyPgSchema is idempotent (re-run records nothing new)", async () => {
      await applyPgSchema(fix.driver);
      const rows = await fix.driver.all<{ version: number }>("SELECT version FROM _migrations");
      assert.deepEqual(rows.map(r => Number(r.version)), [1]);
    });

    it("BIGINT epoch-ms and COUNT(*) come back as JS numbers (typeParser 20)", async () => {
      const { sessionId } = await seedSession(fix.store, "a");
      const session = await fix.store.getSession(sessionId);
      assert.equal(typeof session!.createdAt, "number");
      const count = await fix.store.countActiveSessions();
      assert.equal(typeof count, "number");
      assert.ok(count >= 1);
    });
  });

  describe("DirectConnectStore on PG", () => {
    it("registerServerInstance upserts a stable instance id", async () => {
      const rec = await fix.store.registerServerInstance("hostA", 101, "pg-a");
      assert.equal(rec.instanceId, "pg-a");
      await fix.store.stopServerInstance("pg-a");
      const rec2 = await fix.store.registerServerInstance("hostB", 202, "pg-a");
      assert.equal(rec2.instanceId, "pg-a");
      assert.equal(rec2.status, "running");
    });

    it("createConfigItem returns an IDENTITY id via RETURNING (number)", async () => {
      const id = await fix.store.createConfigItem({
        name: "ShareOne",
        pinyin: "shareone",
        scope: "user",
      });
      assert.equal(typeof id, "number");
      assert.ok(id > 0);
      const id2 = await fix.store.createConfigItem({
        name: "Other",
        pinyin: "other",
        scope: "user",
      });
      assert.equal(id2, id + 1);
    });

    it("findWikisReferencingDocument: LIKE containment over TEXT json column", async () => {
      const wikiId = `w_${Math.random().toString(36).slice(2)}`;
      await fix.driver.run(
        `INSERT INTO wikis (id, org_id, name, storage_path, source_document_ids, created_by, created_at, updated_at)
         VALUES (?, 'o1', 'w', '/tmp/w', ?, 'u1', ?, ?)`,
        [wikiId, JSON.stringify(["docA", "docB"]), Date.now(), Date.now()],
      );
      const hits = await fix.store.findWikisReferencingDocument("docA");
      assert.equal(hits.length, 1);
      assert.equal(String(hits[0]!.id), wikiId);
      const misses = await fix.store.findWikisReferencingDocument("docC");
      assert.equal(misses.length, 0);
    });
  });

  describe("claimAttempt CAS + fencing on PG", () => {
    it("live owner is protected; dead owner transfers; re-claim is idempotent", async () => {
      const a = await fix.store.registerServerInstance("hostA", 1, "pg-cas-a");
      const b = await fix.store.registerServerInstance("hostB", 2, "pg-cas-b");
      const { attemptId } = await seedSession(fix.store, a.instanceId);
      const TIMEOUT = 30_000;

      assert.equal(await fix.store.claimAttempt(attemptId, b.instanceId, TIMEOUT), false);
      assert.equal(await fix.store.claimAttempt(attemptId, a.instanceId, TIMEOUT), true);

      // a dies (stale heartbeat) → b wins the CAS; a's runner is fenced.
      await fix.driver.run(
        `UPDATE server_instances SET heartbeat_at = ? WHERE instance_id = ?`,
        [Date.now() - (TIMEOUT + 60_000), a.instanceId],
      );
      assert.equal(await fix.store.claimAttempt(attemptId, b.instanceId, TIMEOUT), true);
      assert.equal(await fix.store.touchAttemptHeartbeat(attemptId, "running", a.instanceId), false);
      assert.equal(await fix.store.touchAttemptHeartbeat(attemptId, "running", b.instanceId), true);
      assert.equal(await fix.store.touchAttemptHeartbeat(attemptId), true, "legacy unconditional form");
    });

    it("getAttemptOwnerStatus reports liveness from the JOIN", async () => {
      const a = await fix.store.registerServerInstance("hostA", 1, "pg-owner");
      const { attemptId } = await seedSession(fix.store, a.instanceId);
      const live = await fix.store.getAttemptOwnerStatus(attemptId, 30_000);
      assert.equal(live.ownerInstanceId, "pg-owner");
      assert.equal(live.ownerLive, true);
      await fix.driver.run(`UPDATE server_instances SET status = 'stopped' WHERE instance_id = ?`, [a.instanceId]);
      const dead = await fix.store.getAttemptOwnerStatus(attemptId, 30_000);
      assert.equal(dead.ownerLive, false);
    });
  });

  describe("corp_app_inbound seq race (unique index + 23505 retry)", () => {
    it("concurrent inserts from two pools stay unique and monotonic", async () => {
      await fix.driver.run(
        `INSERT INTO corp_apps (id, org_id, type, name, app_key, config_json, created_by, created_at, updated_at)
         VALUES ('app-seq', 'o1', 'wecomapp', 'seq', 'k', '{}', 'u1', ?, ?)`,
        [Date.now(), Date.now()],
      );
      // Second pool = the second instance behind the LB.
      const url = PG_URL.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`);
      const pool2 = new Pool({ connectionString: url, max: 2 });
      const driver2 = new PgDriver(pool2 as unknown as PgPoolLike);
      const store2 = forPostgresDirectConnectStore(driver2);
      try {
        const msg = (n: number, i: number) => ({
          corp_app_id: "app-seq",
          org_id: "o1",
          text: `m${n}-${i}`,
        });
        // Fire both sides concurrently; the single-statement MAX+1 races under
        // READ COMMITTED, the unique index rejects the loser, and the retry
        // loop re-runs it against the winner's committed row.
        const batches = await Promise.all(
          [fix.store, store2].map((s, i) =>
            Promise.all(
              Array.from({ length: 8 }, (_, n) => s.appendCorpAppInbound(msg(n, i))),
            ),
          ),
        );
        const all = batches.flat();
        assert.equal(all.length, 16);
        assert.equal(new Set(all).size, 16, "no duplicate seq across pools");
        assert.deepEqual(
          [...all].sort((x, y) => x - y),
          Array.from({ length: 16 }, (_, i) => i + 1),
          "seq covers 1..16 with no gaps",
        );
      } finally {
        await pool2.end();
      }
    });
  });

  describe("CronStore co-owner queries (json_array_elements branch)", () => {
    it("listByUser / listBySubtree match co-owners stored as JSON array", async () => {
      const cronStore = new CronStore(fix.driver);
      const jobId = `cj_${Math.random().toString(36).slice(2)}`;
      await fix.driver.run(
        `INSERT INTO cron_jobs (id, org_id, user_id, co_owner_ids, name, schedule_kind, schedule_value, payload_message, conversation_mode, created_at, updated_at)
         VALUES (?, 'o1', 'owner', ?, 'j', 'daily', '9:00', 'hi', 'new', ?, ?)`,
        [jobId, JSON.stringify(["co1", "co2"]), Date.now(), Date.now()],
      );
      const byCoOwner = await cronStore.listByUser("o1", "co1");
      assert.equal(byCoOwner.length, 1);
      assert.equal(byCoOwner[0]!.id, jobId);
      const bySubtree = await cronStore.listBySubtree("o1", ["other", "co2"]);
      assert.equal(bySubtree.length, 1);
      const byStranger = await cronStore.listByUser("o1", "stranger");
      assert.equal(byStranger.length, 0);
    });
  });

  describe("tryRunExclusive advisory lock", () => {
    it("second pool cannot enter while the first holds the tx-scoped lock", async () => {
      const url = PG_URL.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`);
      const pool2 = new Pool({ connectionString: url, max: 2 });
      const driver2 = new PgDriver(pool2 as unknown as PgPoolLike);
      try {
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve });
        const holder = fix.driver.tryRunExclusive("lock-test", async () => {
          await gate;
          return "held";
        });
        // Give the holder's transaction time to actually take the lock.
        await new Promise(r => setTimeout(r, 200));
        const loser = await driver2.tryRunExclusive("lock-test", async () => "should-not-run");
        assert.equal(loser, null, "contending run must be rejected, not queued");
        const outsider = await driver2.tryRunExclusive("lock-test-other", async () => "ok");
        assert.equal(outsider, "ok", "different key is not blocked");
        release();
        assert.equal(await holder, "held");
        // Lock released with the transaction → the key is takeable again.
        const after = await driver2.tryRunExclusive("lock-test", async () => "re-taken");
        assert.equal(after, "re-taken");
      } finally {
        await pool2.end();
      }
    });
  });

  describe("AuthCenterDb shared-store construction on PG", () => {
    it("constructs without sqlite init and reads/writes server_config", async () => {
      const authDb = new AuthCenterDb(fix.store);
      await authDb.loadSecretCache();
      const before = await authDb.getJwtSecret();
      assert.ok(!before, "fresh DB has no jwt secret (empty or null)");
      await authDb.setConfig("jwt_secret", "test-secret-value");
      assert.equal(await authDb.getConfig("jwt_secret"), "test-secret-value");
    });
  });
});
