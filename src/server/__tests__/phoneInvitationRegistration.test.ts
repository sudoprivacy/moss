// Runs under Node (AuthCenterDb uses node:sqlite, which Bun lacks): `tsx --test`.
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { AuthCenterDb } from "../authCenter/db.js";
import { AuthService, AuthServiceError } from "../auth/service.js";
import { createBillingTestRepository, createIdentityTestRepository } from "../testing/compatibilityRepositories.js";
import { ensureClientPolicySchema } from "../configuration/clientPolicyRepository.js";
import { SudorouterAccountService } from "../billing/sudorouterAccountService.js";

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
  it("provisions a native registrant once and reads its model key from the encrypted store", async () => {
    const created = await auth.createOrganization({ name: "Gateway" });
    const orgId = created.organization.id;
    const identities = createIdentityTestRepository(raw, {}, db.driver);
    const profile = await identities.getOrganizationProfile(orgId);
    assert(profile);
    await identities.putOrganizationProfile({ ...profile, loginMethod: "sms" });
    await auth.createOrganizationIdentityService().createInvitations(
      { orgId, count: 1, initialCreditUnits: 200 }, () => "GATEWAY",
    );
    const billing = createBillingTestRepository(raw, db.driver);
    const secrets = new Map<string, string>();
    let usersCreated = 0;
    let tokensCreated = 0;
    let quota = 0;
    const accounts = new SudorouterAccountService(db.driver, billing, {
      async findUserByUsername() { return null; },
      async createUser(input) {
        usersCreated += 1;
        return { externalUserId: "91", username: input.username, quotaUnits: 0, usedQuotaUnits: 0 };
      },
      async getUser() { return { externalUserId: "91", quotaUnits: quota, usedQuotaUnits: 0 }; },
      async changeQuota(input) { quota += input.deltaUnits; return { success: true }; },
      async createToken() { tokensCreated += 1; return "private-user-key"; },
    }, {
      async putSecret(namespace, key, value) { secrets.set(`${namespace}/${key}`, value); },
      async getSecret(namespace, key) {
        const value = secrets.get(`${namespace}/${key}`);
        return value ? { value, status: "enabled", version: 1 } : null;
      },
    });
    auth.configureSudorouterAccounts({ accountProvisioner: accounts, initialQuotaUnits: 100000 });
    const registered = await auth.registerWithPhone({ phone: "13800138004", nickname: "Alice", invitationCode: "GATEWAY" });
    assert.equal(await auth.getUserModelCredential(registered.user.id), null);
    assert.equal(usersCreated, 0, "reading a missing credential must not provision an account");
    await auth.ensureUserSudorouterAccount(registered.user.id);
    await auth.ensureUserSudorouterAccount(registered.user.id);
    assert.deepEqual(await auth.getUserModelCredential(registered.user.id), {
      sudorouterUserId: "91", sudorouterKey: "sk-private-user-key",
    });
    assert.equal(usersCreated, 1);
    assert.equal(tokensCreated, 1);
    assert.equal(quota, 100000);
    assert.equal(await db.getUserModelCredential(registered.user.id), null, "no plaintext key in users table");
    secrets.clear();
    await assert.rejects(auth.getUserModelCredential(registered.user.id), /Token/);
    await assert.rejects(auth.ensureUserSudorouterAccount(registered.user.id), (error: unknown) =>
      error instanceof AuthServiceError && error.statusCode === 503,
    );
    assert.equal(tokensCreated, 1, "missing stored secrets must not silently mint replacement keys");
  });

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
