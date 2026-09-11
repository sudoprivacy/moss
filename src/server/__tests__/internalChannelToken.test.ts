// Runs under Node: `tsx --test`. D1/R12: the internal-channel token must be
// minted with ONLY the internal:channel scope — never sessions:attach:any — so
// a leak within its 120s window cannot drive attach:any-gated endpoints. The
// cross-user 403 / same-user allow is the server WS double-gate
// (canAccessSession), covered at the HTTP layer; lbInternalChannel.test.ts is
// the client-channel regression.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { AuthCenterDb } from "../authCenter/db.js";
import { AuthService } from "../auth/service.js";
import { verifyAccessToken } from "../auth/token.js";

describe("D1: internal-channel token scope", () => {
  it("mints a token scoped to internal:channel only (no sessions:attach:any)", async () => {
    const raw = new DatabaseSync(":memory:");
    const db = new AuthCenterDb(raw, ":memory:");
    await db.loadSecretCache();
    await db.setConfig("jwt_secret", "test-secret-value");

    await db.createOrganization("o1", "Org", Date.now(), null);
    await db.createUser({
      id: "u1",
      orgId: "o1",
      email: "u1@example.com",
      name: "u1",
      displayName: null,
      departmentId: null,
      role: "user",
      status: "active",
      localAuth: true,
      tokenLimit: null,
      createdAt: Date.now(),
      passwordHash: null,
      passwordUpdatedAt: null,
      lastLoginAt: null,
      extUserId: null,
      phone: null,
    });

    const svc = new AuthService(db, 3600);
    const tok = await svc.issueInternalChannelToken("u1", "o1");
    assert.ok(tok, "token minted for an active user");

    const ctx = verifyAccessToken(tok!.access_token, db.getJwtSecret());
    assert.ok(ctx, "token verifies with the server secret");
    assert.deepEqual(ctx!.scopes, ["internal:channel"]);
    assert.ok(!ctx!.scopes.includes("sessions:attach:any"), "must not carry attach:any");

    raw.close();
  });

  it("returns null for a non-active user", async () => {
    const raw = new DatabaseSync(":memory:");
    const db = new AuthCenterDb(raw, ":memory:");
    await db.loadSecretCache();
    await db.setConfig("jwt_secret", "test-secret-value");
    await db.createOrganization("o1", "Org", Date.now(), null);
    await db.createUser({
      id: "u2", orgId: "o1", email: "u2@example.com", name: "u2", displayName: null,
      departmentId: null, role: "user", status: "disabled", localAuth: true, tokenLimit: null,
      createdAt: Date.now(), passwordHash: null, passwordUpdatedAt: null, lastLoginAt: null,
      extUserId: null, phone: null,
    });
    const svc = new AuthService(db, 3600);
    assert.equal(await svc.issueInternalChannelToken("u2", "o1"), null);
    raw.close();
  });
});
