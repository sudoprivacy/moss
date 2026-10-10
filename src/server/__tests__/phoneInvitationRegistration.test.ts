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
  async function preparePasswordGateway() {
    const created = await auth.createOrganization({ name: "Password gateway" });
    const orgId = created.organization.id;
    const identities = createIdentityTestRepository(raw, {}, db.driver);
    await auth.createOrganizationIdentityService().createInvitations(
      { orgId, count: 1, initialCreditUnits: 200 }, () => "PASSWORD",
    );
    const secrets = new Map<string, string>();
    let isTokenFailure = false;
    let externalUser: { externalUserId: string; username: string; quotaUnits: number; usedQuotaUnits: number } | null = null;
    const calls = { users: 0, tokens: 0, quota: 0 };
    const accounts = new SudorouterAccountService(db.driver, createBillingTestRepository(raw, db.driver), {
      async findUserByUsername() { return externalUser; },
      async createUser(input) {
        calls.users += 1;
        externalUser = { externalUserId: "92", username: input.username, quotaUnits: 0, usedQuotaUnits: 0 };
        return externalUser;
      },
      async getUser() { assert(externalUser); return externalUser; },
      async changeQuota(input) { assert(externalUser); calls.quota += 1; externalUser.quotaUnits += input.deltaUnits; return { success: true }; },
      async createToken() {
        calls.tokens += 1;
        if (isTokenFailure) throw new Error("Temporary token service outage");
        return "password-private-user-key";
      },
    }, {
      async putSecret(namespace, key, value) { secrets.set(`${namespace}/${key}`, value); },
      async getSecret(namespace, key) {
        const value = secrets.get(`${namespace}/${key}`);
        return value ? { value, status: "enabled", version: 1 } : null;
      },
    });
    auth.configureSudorouterAccounts({ accountProvisioner: accounts, initialQuotaUnits: 100000 });
    return { orgId, identities, calls, setTokenFailure: (isFailure: boolean) => { isTokenFailure = isFailure; }, getExternalUser: () => externalUser };
  }

  it("rejects a gateway username that is too long before creating an identity or consuming the invitation", async () => {
    const fixture = await preparePasswordGateway();
    await assert.rejects(auth.registerWithPhone({
      phone: "a".repeat(21), nickname: "Long username", invitationCode: "PASSWORD", loginMethod: "password", password: "StrongPass123",
    }), (error: unknown) => error instanceof AuthServiceError && error.statusCode === 400);
    assert.equal(await db.getUserByPhone("a".repeat(21)), null);
    assert.equal((await fixture.identities.getInvitationByCode("PASSWORD"))?.status, "pending");
    assert.deepEqual(fixture.calls, { users: 0, tokens: 0, quota: 0 });
  });

  it("keeps a failed invited password registration pending and retries without duplicate identities or quota", async () => {
    const fixture = await preparePasswordGateway();
    const input = { phone: "qa-password-retry", nickname: "Retry fixture", invitationCode: "PASSWORD", loginMethod: "password" as const, password: "StrongPass123" };
    fixture.setTokenFailure(true);
    await assert.rejects(auth.registerWithPhone(input), (error: unknown) => error instanceof AuthServiceError && error.statusCode === 503);
    const pending = await db.getUserByPhone(input.phone);
    assert(pending);
    assert.equal(pending.status, "pending");
    const invitation = await fixture.identities.getInvitationByCode("PASSWORD");
    assert.equal(invitation?.status, "used");
    assert.equal(invitation?.usedByUserId, pending.id);
    await assert.rejects(auth.issueTokenFromPassword({ username: input.phone, password: input.password }), (error: unknown) => error instanceof AuthServiceError && error.statusCode === 401);
    const calls = { ...fixture.calls };
    await assert.rejects(auth.registerWithPhone({ ...input, password: "WrongPassword123" }), (error: unknown) => error instanceof AuthServiceError && error.statusCode === 401);
    await assert.rejects(auth.registerWithPhone({ ...input, invitationCode: "OTHER-INVITATION" }), (error: unknown) => error instanceof AuthServiceError && error.statusCode === 409);
    assert.deepEqual(fixture.calls, calls, "rejected retries must not call the gateway");
    assert.equal((await db.getUserById(pending.id))?.status, "pending");
    fixture.setTokenFailure(false);
    const registered = await auth.registerWithPhone(input);
    assert.equal(registered.user.id, pending.id);
    assert.equal((await db.getUserById(pending.id))?.status, "active");
    assert.equal((await fixture.identities.getWallet("user", pending.id))?.balanceUnits, 200);
    assert.equal(fixture.calls.users, 1);
    assert.equal(fixture.calls.quota, 1);
    assert.equal(fixture.getExternalUser()?.quotaUnits, 100000);
    assert.equal((await auth.issueTokenFromPassword({ username: input.phone, password: input.password })).user.id, pending.id);
    assert.deepEqual(await auth.getUserModelCredential(pending.id), { sudorouterUserId: "92", sudorouterKey: "sk-password-private-user-key" });
    assert.equal(await db.getUserModelCredential(pending.id), null);
  });

  it("does not activate an unrelated pending account with a different invitation", async () => {
    const fixture = await preparePasswordGateway();
    const created = await auth.createUser({ orgId: fixture.orgId, name: "qa-admin-pending", phone: "qa-admin-pending", role: "user", password: "StrongPass123", status: "pending" });
    await assert.rejects(auth.registerWithPhone({ phone: "qa-admin-pending", invitationCode: "PASSWORD", loginMethod: "password", password: "StrongPass123" }), (error: unknown) => error instanceof AuthServiceError && error.statusCode === 409);
    assert.equal((await db.getUserById(created.user.id))?.status, "pending");
    assert.equal((await fixture.identities.getInvitationByCode("PASSWORD"))?.status, "pending");
    assert.deepEqual(fixture.calls, { users: 0, tokens: 0, quota: 0 });
  });

  it("provisions a native registrant once and reads its model key from the encrypted store", async () => {
    const created = await auth.createOrganization({ name: "Gateway" });
    const orgId = created.organization.id;
    const identities = createIdentityTestRepository(raw, {}, db.driver);
    await auth.putOrganizationClientPolicy(orgId, {
      loginMethod: "sms",
      loginMethodInherited: false,
    }, "test");
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
    assert.equal(registered.user.localExecutionAllowed, true);
    assert.equal(registered.user.localAuth, true);
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
    await auth.putOrganizationClientPolicy(orgId, {
      loginMethod: "sms",
      loginMethodInherited: false,
    }, "test");
    const organizations = auth.createOrganizationIdentityService();
    await organizations.createInvitations({ orgId, count: 1 }, () => "JOINME");

    const result = await auth.registerWithPhone({
      phone: "13800138000",
      nickname: "Alice",
      invitationCode: "JOINME",
    });

    assert.equal(result.user.orgId, orgId);
    assert.equal(result.user.role, "user");
    const mossSession = await auth.issueMossTokenFromPassword({ username: "13800138000", password: "13800138000" });
    const mossAuth = await auth.verifyAccessToken(mossSession.access_token);
    assert(mossAuth);
    assert.equal(mossAuth.authApp, "moss");
    await auth.changeOwnPassword(mossAuth, "13800138000", "ChangedPass123");
    await assert.rejects(auth.issueMossTokenFromPassword({ username: "13800138000", password: "13800138000" }));
    await auth.registerWithPhone({ phone: "13800138000", invitationCode: "JOINME" });
    assert.equal((await auth.issueMossTokenFromPassword({ username: "13800138000", password: "ChangedPass123" })).user.id, result.user.id);

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
    await auth.putOrganizationClientPolicy(orgId, {
      loginMethod: "sms",
      loginMethodInherited: false,
    }, "test");
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
