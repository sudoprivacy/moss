// Runs under Node: `tsx --test`. SQLite-side / pure-function coverage for the
// SQL-dialect fixes (A1 UNIQUE-violation dual-dialect translation, A2
// LIKE→ILIKE rewrite, A3 pagination clamp). The PG round-trips for the same
// fixes live in pgBackend.test.ts (gated on MOSS_PG_TEST_URL).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PgDriver } from "../db/driver.js";
import { isUniqueViolationOn } from "../auth/service.js";
import { DirectConnectStore } from "../db.js";

describe("A2: PgDriver.rewriteLikeToILike", () => {
  it("rewrites a bare LIKE operator to ILIKE", () => {
    assert.equal(
      PgDriver.rewriteLikeToILike("SELECT * FROM t WHERE name LIKE ?"),
      "SELECT * FROM t WHERE name ILIKE ?",
    );
  });

  it("is case-insensitive on the keyword (lowercase like is caught)", () => {
    assert.equal(
      PgDriver.rewriteLikeToILike("SELECT * FROM t WHERE name like ?"),
      "SELECT * FROM t WHERE name ILIKE ?",
    );
  });

  it("does not touch LIKE inside a string literal", () => {
    assert.equal(
      PgDriver.rewriteLikeToILike("SELECT 'a LIKE b' AS x WHERE c LIKE ?"),
      "SELECT 'a LIKE b' AS x WHERE c ILIKE ?",
    );
  });

  it("does not touch LIKE inside a double-quoted identifier", () => {
    assert.equal(
      PgDriver.rewriteLikeToILike('SELECT "LIKE" FROM t WHERE a LIKE ?'),
      'SELECT "LIKE" FROM t WHERE a ILIKE ?',
    );
  });

  it("does not touch an identifier that merely contains 'like' (word boundary)", () => {
    assert.equal(
      PgDriver.rewriteLikeToILike("SELECT like_count, unlike FROM t"),
      "SELECT like_count, unlike FROM t",
    );
  });

  it("rewrites multiple LIKEs in one statement", () => {
    assert.equal(
      PgDriver.rewriteLikeToILike("WHERE (name LIKE ? OR pinyin LIKE ?)"),
      "WHERE (name ILIKE ? OR pinyin ILIKE ?)",
    );
  });
});

describe("A1: isUniqueViolationOn dual-dialect matching", () => {
  const pgErr = (constraint: string) =>
    Object.assign(
      new Error(`duplicate key value violates unique constraint "${constraint}"`),
      { code: "23505" },
    );

  it("matches a PG 23505 error by constraint name", () => {
    assert.equal(isUniqueViolationOn(pgErr("users_email_key"), "users_email_key", "users.email"), true);
  });

  it("matches a SQLite UNIQUE error by column list", () => {
    const err = new Error("UNIQUE constraint failed: users.email");
    assert.equal(isUniqueViolationOn(err, "users_email_key", "users.email"), true);
  });

  it("does not match a different constraint under PG", () => {
    assert.equal(isUniqueViolationOn(pgErr("users_ext_uniq"), "users_email_key", "users.email"), false);
  });

  it("does not match a different column list under SQLite", () => {
    const err = new Error("UNIQUE constraint failed: users.org_id, users.ext_user_id");
    assert.equal(isUniqueViolationOn(err, "users_email_key", "users.email"), false);
  });

  it("does not match a non-unique error", () => {
    assert.equal(isUniqueViolationOn(new Error("connection reset"), "users_email_key", "users.email"), false);
  });
});

describe("A3: pagination clamp (SQLite)", () => {
  it("string / NaN / negative page inputs fall back to safe defaults instead of crashing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "moss-page-"));
    const dbPath = join(dir, "page.db");
    try {
      const store = new DirectConnectStore(dbPath);
      await store.createConfigItem({ name: "GitHub", pinyin: "github", scope: "user" });

      // ?page=abc — Number('abc')=NaN → 1 (would otherwise be a SQLite datatype
      // mismatch on OFFSET).
      const byString = await store.listConfigItems({ page: "abc" as unknown as number, pageSize: "abc" as unknown as number });
      assert.equal(byString.total, 1);
      assert.equal(byString.items.length, 1);

      // ?page=-5 — negative offset would be OFFSET -5 (PG 500 / SQLite error).
      const byNeg = await store.listConfigItems({ page: -5, pageSize: -5 });
      assert.equal(byNeg.items.length, 1);

      // A valid page beyond the data returns empty, not an error.
      const byValid = await store.listConfigItems({ page: 5, pageSize: 20 });
      assert.equal(byValid.total, 1);
      assert.equal(byValid.items.length, 0);
      store.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
