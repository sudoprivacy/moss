// Runs under Node: `tsx --test`. Covers the corp-app inbound seq hardening
// (HA dual callback entry): the single-statement atomic increment must keep
// per-corp-app seq unique+monotonic across two store instances sharing one DB
// file (the WAL multi-writer shape behind an LB), and the unique index must
// reject duplicate (corp_app_id, seq) outright.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DirectConnectStore } from "../db.js";

describe("appendCorpAppInbound — seq atomicity behind dual LB entries (HA)", () => {
  it("alternating inserts from two store instances stay unique and monotonic", async () => {
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

      // Interleave: a, b, a, b, a — the old two-step (SELECT MAX → INSERT)
      // could collide when two inserts land between the same read and write;
      // the single-statement form serialises under the WAL write lock.
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
