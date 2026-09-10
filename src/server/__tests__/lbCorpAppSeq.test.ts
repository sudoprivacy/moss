// Runs under Node: `tsx --test`. Correctness regression anchor for the
// corp-app inbound seq (HA dual callback entry): the single-statement atomic
// increment keeps per-corp-app seq unique+monotonic, and the unique index
// rejects duplicate (corp_app_id, seq) outright.
//
// NOTE ON CONCURRENCY: SQLite is a single writer — a read-modify-write seq race
// is structurally impossible here, and the async driver's synchronous SQLite
// path does not interleave, so this file does NOT and CANNOT detect a real
// concurrency race. The genuine race (PostgreSQL READ COMMITTED, two pools
// behind an LB) and its unique-index + 23505-retry resolution are covered in
// pgBackend.test.ts. This file only anchors single-writer correctness.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DirectConnectStore } from "../db.js";

describe("appendCorpAppInbound — single-writer seq correctness (HA anchor)", () => {
  it("sequential inserts from two store instances stay unique and monotonic", async () => {
    const dir = mkdtempSync(join(tmpdir(), "moss-seq-"));
    const dbPath = join(dir, "seq.db");
    try {
      // Two instances, one shared DB file (the docker-compose.ha shape).
      const storeA = new DirectConnectStore(dbPath);
      const storeB = new DirectConnectStore(dbPath);

      const msg = (seq: number) => ({
        corp_app_id: "app1",
        org_id: "o1",
        from_user: `u${seq}`,
        msg_type: "text",
        text: `m${seq}`,
      });

      // Sequential a, b, a, b, a on a shared DB file. Asserts single-writer
      // correctness (unique + monotonic), NOT concurrency: SQLite serialises
      // writes and the async driver's SQLite path does not interleave, so this
      // cannot reproduce the old two-step race. Real race coverage: pgBackend.test.ts.
      const seqs = [
        await storeA.appendCorpAppInbound(msg(1)),
        await storeB.appendCorpAppInbound(msg(2)),
        await storeA.appendCorpAppInbound(msg(3)),
        await storeB.appendCorpAppInbound(msg(4)),
        await storeA.appendCorpAppInbound(msg(5)),
      ];
      assert.deepEqual(seqs, [1, 2, 3, 4, 5]);
      assert.equal(new Set(seqs).size, 5, "no duplicate seq across instances");

      const rows = storeA.db
        .prepare("SELECT seq FROM corp_app_inbound WHERE corp_app_id = ? ORDER BY seq")
        .all("app1") as Array<{ seq: number }>;
      assert.deepEqual(rows.map(r => r.seq), [1, 2, 3, 4, 5]);

      storeA.db.close();
      storeB.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the (corp_app_id, seq) unique index rejects duplicate seq inserts", () => {
    const store = new DirectConnectStore(":memory:");
    store.db
      .prepare(
        `INSERT INTO corp_app_inbound (id, corp_app_id, org_id, seq, from_user, msg_type, text, received_at)
         VALUES ('r1', 'app1', 'o1', 7, 'u', 'text', 'x', 0)`,
      )
      .run();
    assert.throws(
      () =>
        store.db
          .prepare(
            `INSERT INTO corp_app_inbound (id, corp_app_id, org_id, seq, from_user, msg_type, text, received_at)
             VALUES ('r2', 'app1', 'o1', 7, 'u', 'text', 'y', 0)`,
          )
          .run(),
      /UNIQUE constraint failed/i,
    );
    // Different corp app reusing the same seq is fine — the scope is per-app.
    store.db
      .prepare(
        `INSERT INTO corp_app_inbound (id, corp_app_id, org_id, seq, from_user, msg_type, text, received_at)
         VALUES ('r3', 'app2', 'o1', 7, 'u', 'text', 'z', 0)`,
      )
      .run();
  });

  it("returns the seq of its own inserted row", async () => {
    const store = new DirectConnectStore(":memory:");
    const first = await store.appendCorpAppInbound({
      corp_app_id: "app1",
      org_id: "o1",
      text: "a",
    });
    const second = await store.appendCorpAppInbound({
      corp_app_id: "app1",
      org_id: "o1",
      text: "b",
    });
    assert.equal(first, 1);
    assert.equal(second, 2);
  });
});

// Keep the DatabaseSync import referenced even if assertions change shape.
void DatabaseSync;
