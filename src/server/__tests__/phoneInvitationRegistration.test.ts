// Runs under Node (AuthCenterDb uses node:sqlite, which Bun lacks): `tsx --test`.
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { AuthCenterDb } from "../authCenter/db.js";
import { AuthService, AuthServiceError } from "../auth/service.js";
import { createIdentityTestRepository } from "../testing/compatibilityRepositories.js";
import { ensureClientPolicySchema } from "../configuration/clientPolicyRepository.js";

let raw: DatabaseSync;
let db: AuthCenterDb;
let auth: AuthService;

beforeEach(() => {
  raw = new DatabaseSync(":memory:");
  db = new AuthCenterDb(raw, ":memory:");
  createIdentityTestRepository(raw, {}, db.driver);
  ensureClientPolicySchema(raw);
  auth = new AuthService(db, 3600);
});

afterEach(() => {
  auth.destroy();
  raw.close();
});

describe("invited phone registration", () => {
  it("joins the invitation organization as a normal user without creating an organization", async () => {
    const created = await auth.createOrganization({ name: "Acme" });
    const orgId = created.organization.id;
    const repository = createIdentityTestRepository(raw, {}, db.driver);
    const profile = await repository.getOrganizationProfile(orgId);
    assert(profile);
    await repository.putOrganizationProfile({ ...profile, loginMethod: "sms" });
    const organizations = auth.createOrganizationIdentityService();
    await organizations.createInvitations({ orgId, count: 1 }, () => "JOINME");

    const result = await auth.registerWithPhone({
      phone: "13800138000",
      nickname: "Alice",
      invitationCode: "JOINME",
    });

    assert.equal(result.user.orgId, orgId);
    assert.equal(result.user.role, "user");
    assert.equal((await auth.listAllOrganizations()).organizations.length, 1);
    assert.equal(
      (await db.getUserByPhone("13800138000"))?.displayName,
      "Alice",
    );
    assert.equal(
      (await organizations.listInvitations({ orgId })).items[0]?.status,
      "used",
    );
  });

  it("rejects a missing or already-used invitation without creating another organization", async () => {
    const created = await auth.createOrganization({ name: "Acme" });
    const orgId = created.organization.id;
    const repository = createIdentityTestRepository(raw, {}, db.driver);
    const profile = await repository.getOrganizationProfile(orgId);
    assert(profile);
    await repository.putOrganizationProfile({ ...profile, loginMethod: "sms" });
    const organizations = auth.createOrganizationIdentityService();
    await organizations.createInvitations({ orgId, count: 1 }, () => "ONCE01");

    await assert.rejects(
      auth.registerWithPhone({
        phone: "13800138001",
        nickname: "Missing",
        invitationCode: "MISSING",
      }),
      (error: unknown) =>
        error instanceof AuthServiceError && error.statusCode === 400,
    );

    await auth.registerWithPhone({
      phone: "13800138002",
      nickname: "First",
      invitationCode: "ONCE01",
    });
    await assert.rejects(
      auth.registerWithPhone({
        phone: "13800138003",
        nickname: "Second",
        invitationCode: "ONCE01",
      }),
      (error: unknown) =>
        error instanceof AuthServiceError && error.statusCode === 409,
    );

    assert.equal((await auth.listAllOrganizations()).organizations.length, 1);
    assert.equal(await db.getUserByPhone("13800138003"), null);
  });
});
