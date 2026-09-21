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
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import { PgDriver, type PgPoolLike } from "../db/driver.js";
import { applyPgSchema } from "../db/pg_schema.js";
import { DirectConnectStore, forPostgresDirectConnectStore } from "../db.js";
import { CronStore } from "../services/cron/CronStore.js";
import { AuthCenterDb } from "../authCenter/db.js";
import { createAuthService, isUniqueViolationOn } from "../auth/service.js";
import { EventTriggerStore } from "../services/eventTrigger/EventTriggerStore.js";
import { IdentityRepository } from "../identity/identityRepository.js";
import { UnifiedIdentityService } from "../identity/unifiedIdentityService.js";
import { CatalogRepository } from "../catalog/catalogRepository.js";
import { CatalogService } from "../catalog/catalogService.js";
import { ClientPolicyRepository } from "../configuration/clientPolicyRepository.js";
import { PlatformIntegrationSettingsRepository } from "../configuration/platformIntegrationSettingsRepository.js";
import { DifyRepository } from "../dify/difyRepository.js";
import { DifyDatasetService } from "../dify/difyDatasetService.js";
import { DifyHttpAdapter } from "../dify/difyHttpAdapter.js";
import { BillingRepository } from "../billing/billingRepository.js";
import { WalletService } from "../billing/walletService.js";
import { BillingCoordinator } from "../billing/billingCoordinator.js";
import { SudorouterAccountService } from "../billing/sudorouterAccountService.js";
import type { QuotaSnapshot, SudorouterAccountPort, SudorouterUserAccount } from "../billing/sudorouterAdapter.js";
import { migrationCommandContext, onlineCommandContext } from "../application/commandContext.js";
import { repairConfigAvailability } from "../configuration/configAvailabilitySchema.js";
import { createConfigItemsApi } from "../api/configItems.js";
import { SudoworkConfigService } from "../api/compat/sudowork/configService.js";
import { IdentityMergePlanner } from "../migration/identityMergePlanner.js";
import { IdentityMigrationService } from "../migration/identityMigrationService.js";
import { MigrationRunStore } from "../migration/migrationRunStore.js";
import { P2ConfigurationMigrationService } from "../migration/p2ConfigurationMigrationService.js";
import { P4DifyMigrationService } from "../migration/p4DifyMigrationService.js";
import { OrganizationModelSettingsRepository } from "../configuration/organizationModelSettingsRepository.js";
import { getOrganizationSystemSettings } from "../systemSettings.js";
import { migrateLegacyModelSettings } from "../configuration/migrateLegacyModelSettings.js";
import { migrateLegacyEnterpriseCronPolicy } from "../migration/legacyEnterpriseCronPolicy.js";
import { createEnterpriseApi } from "../api/enterprise.js";
import { withOrganizationResources, saveOrganizationInstallation, listOrganizationResources, updateOrganizationResource, requireOrganizationResource, removeOrganizationResource } from '../catalog/organizationResources.js';

const PG_URL = process.env.MOSS_PG_TEST_URL ?? "";

describe('organization installations on PG', { skip: !PG_URL }, () => {
  it('concurrent installs are unique, config merges are serialized and organizations stay independent', async () => {
    const admin = createAdminPool();
    const database = await createFreshDatabase(admin);
    const fix = await openFixture(database);
    const a = { orgId: 'a', userId: 'u-a', driver: fix.driver };
    const b = { orgId: 'b', userId: 'u-b', driver: fix.driver };
    const meta = { id: 'shared', name: 'shared', enabled: true };
    try {
      await Promise.all(Array.from({ length: 6 }, () => withOrganizationResources(a, () => saveOrganizationInstallation('skill', '/artifact/v1', meta))));
      assert.equal((await withOrganizationResources(a, () => listOrganizationResources('skill')))?.length, 1);
      assert.deepEqual(await withOrganizationResources(b, () => listOrganizationResources('skill')), []);
      await withOrganizationResources(b, () => saveOrganizationInstallation('skill', '/artifact/v1', meta));
      await Promise.all([
        withOrganizationResources(a, () => updateOrganizationResource('skill', 'shared', { description: 'A only' })),
        withOrganizationResources(a, () => updateOrganizationResource('skill', 'shared', { enabled: false })),
      ]);
      const updated = await withOrganizationResources(a, () => requireOrganizationResource('skill', 'shared'));
      assert.equal(updated.meta.description, 'A only');
      assert.equal(updated.meta.enabled, false);
      await withOrganizationResources(a, () => saveOrganizationInstallation('skill', '/artifact/v2', meta));
      assert.equal((await withOrganizationResources(b, () => requireOrganizationResource('skill', 'shared'))).path, '/artifact/v1');
      await withOrganizationResources(a, () => removeOrganizationResource('skill', 'shared'));
      assert.equal((await withOrganizationResources(b, () => listOrganizationResources('skill')))?.length, 1);
    } finally { await fix.release(); await dropDatabase(admin, database); await admin.end(); }
  });
});

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

function databaseUrl(dbName: string): string {
  return PG_URL.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`);
}

async function openPeer(dbName: string): Promise<{ pool: Pool; driver: PgDriver; store: DirectConnectStore }> {
  const pool = new Pool({ connectionString: databaseUrl(dbName), max: 4 });
  const driver = new PgDriver(pool as unknown as PgPoolLike);
  return { pool, driver, store: forPostgresDirectConnectStore(driver) };
}

interface PgFixture {
  driver: PgDriver;
  store: DirectConnectStore;
  release: () => Promise<void>;
}

async function openFixture(dbName: string): Promise<PgFixture> {
  const url = databaseUrl(dbName);
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

describe("organization configuration on PG", { skip: !PG_URL }, () => {
  const admin = createAdminPool();
  let dbName = "";
  let fix!: PgFixture;
  let peer: Awaited<ReturnType<typeof openPeer>>;
  before(async () => {
    dbName = await createFreshDatabase(admin);
    fix = await openFixture(dbName);
    peer = await openPeer(dbName);
    await fix.driver.run(
      "INSERT INTO enterprises (id, created_at, updated_at) VALUES ('default', ?, ?)",
      [Date.now(), Date.now()],
    );
    const auth = new AuthCenterDb(fix.store);
    const identities = new IdentityRepository(fix.driver);
    for (const orgId of ["model-org-a", "model-org-b"]) {
      await auth.createOrganization(orgId, orgId, Date.now());
      await identities.putOrganizationProfile({
        orgId, code: orgId, loginMethod: "password", localEnabled: true, cloudEnabled: true,
      });
    }
  });
  after(async () => {
    await peer?.pool.end();
    await fix?.release();
    await dropDatabase(admin, dbName);
    await admin.end();
  });

  it("isolates model settings across pools and serializes the one-time migration", async () => {
    const repository = new OrganizationModelSettingsRepository(fix.driver);
    const peerRepository = new OrganizationModelSettingsRepository(peer.driver);
    await repository.put("model-org-a", { model: "a-model", image: { model: "a-image" } }, "admin");
    await repository.put("model-org-b", { model: "b-model" }, "admin");
    await Promise.all([
      migrateLegacyModelSettings(fix.driver, "model-org-a"),
      migrateLegacyModelSettings(peer.driver, "model-org-a"),
    ]);
    const a = await getOrganizationSystemSettings("model-org-a", peerRepository, { redactSecrets: true });
    const b = await getOrganizationSystemSettings("model-org-b", repository, { redactSecrets: true });
    assert.equal(a.model, "a-model");
    assert.equal(a.image.model, "a-image");
    assert.equal(b.model, "b-model");
    assert.equal(a.apiKeyConfigured, false);
    assert.equal(b.apiKeyConfigured, false);
    assert.equal(Number((await fix.driver.get("SELECT COUNT(*) AS n FROM organization_model_settings_migrations"))?.n), 1);
    await assert.rejects(fix.driver.transaction(async () => {
      await repository.put("model-org-a", { model: "rolled-back" }, "admin");
      throw new Error("model rollback");
    }), /model rollback/);
    assert.equal((await peerRepository.get("model-org-a")).model, "a-model");
  });

  it("migrates cron restrictions once and rolls back asynchronous enterprise policy writes", async () => {
    const identities = new IdentityRepository(fix.driver);
    const policies = new ClientPolicyRepository(fix.driver);
    await fix.store.updateEnterprise("model-org-a", { client_cron_enabled: false, app_name: "A" });
    await fix.store.updateEnterprise("model-org-b", { client_cron_enabled: true });
    assert.equal((await fix.store.getEnterprise("model-org-a")).client_cron_enabled, false);
    await identities.setOrganizationClientCronEnabled("model-org-b", false);
    const results = await Promise.all([
      migrateLegacyEnterpriseCronPolicy(fix.driver),
      migrateLegacyEnterpriseCronPolicy(peer.driver),
    ]);
    assert.equal(results.reduce((sum, count) => sum + count, 0), 1);
    assert.equal((await identities.getOrganizationProfile("model-org-a"))?.clientCronEnabled, false);
    assert.equal((await identities.getOrganizationProfile("model-org-b"))?.clientCronEnabled, false);
    const api = createEnterpriseApi(fix.store, "/tmp/moss-pg-enterprise", {
      getClientCronEnabled: async orgId => (await identities.getOrganizationProfile(orgId))?.clientCronEnabled ?? true,
      setClientCronEnabled: (orgId, enabled) => identities.setOrganizationClientCronEnabled(orgId, enabled),
      getClientPolicy: orgId => policies.getEffective(orgId),
      putClientPolicy: async (orgId, patch, updatedBy) => {
        await policies.putOrganization(orgId, patch, updatedBy);
        throw new Error("asynchronous policy failure");
      },
    });
    const result = await api.updateConfig("model-org-a", {
      app_name: "not-committed", client_cron_enabled: true, client_show_tool_calls: false,
    });
    assert.equal(result.success, false);
    assert.equal((await fix.store.getEnterprise("model-org-a")).app_name, "A");
    assert.equal((await identities.getOrganizationProfile("model-org-a"))?.clientCronEnabled, false);
    assert.deepEqual(await policies.getOrganization("model-org-a"), {});
    await identities.setOrganizationClientCronEnabled("model-org-a", true);
    assert.equal(await migrateLegacyEnterpriseCronPolicy(peer.driver), 0);
    assert.equal((await identities.getOrganizationProfile("model-org-a"))?.clientCronEnabled, true);
  });
});

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
      assert.deepEqual(rows.map(r => Number(r.version)).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8]);
    });

    it("BIGINT epoch-ms and COUNT(*) come back as JS numbers (typeParser 20)", async () => {
      const { sessionId } = await seedSession(fix.store, "a");
      const session = await fix.store.getSession(sessionId);
      assert.equal(typeof session!.createdAt, "number");
      const count = await fix.store.countActiveSessions();
      assert.equal(typeof count, "number");
      assert.ok(count >= 1);
    });

    it("enforces v6 append-only, balance, and polymorphic-parent constraints", async () => {
      const suffix = Math.random().toString(36).slice(2, 10);
      const billing = new BillingRepository(fix.driver);
      await billing.insertLedgerEntry({
        id: `append-${suffix}`, ownerType: "user", ownerId: `owner-${suffix}`,
        deltaUnits: 1, balanceBeforeUnits: 0, balanceAfterUnits: 1,
        entryType: "BONUS", sourceType: "pg-constraint", sourceId: suffix,
        idempotencyKey: `append-key-${suffix}`, contextSource: "online", createdAt: Date.now(),
      });
      await assert.rejects(
        fix.driver.run("UPDATE billing_ledger_entries SET memo = 'changed' WHERE id = ?", [`append-${suffix}`]),
        /append-only/,
      );
      await assert.rejects(
        fix.driver.run("DELETE FROM billing_ledger_entries WHERE id = ?", [`append-${suffix}`]),
        /append-only/,
      );
      await assert.rejects(fix.driver.run(`
        INSERT INTO billing_ledger_entries (
          id, legacy_id, owner_type, owner_id, delta_units, balance_before_units, balance_after_units,
          entry_type, source_type, source_id, idempotency_key, context_source, created_at
        ) VALUES (?, ?, 'user', ?, 1, 0, 99, 'BONUS', 'pg-constraint', ?, ?, 'online', ?)
      `, [
        `invalid-balance-${suffix}`, 2_200_000_000 + Math.floor(Math.random() * 10_000),
        `owner-${suffix}`, `invalid-${suffix}`, `invalid-key-${suffix}`, Date.now(),
      ]), /billing_ledger_entries_balance_check/);
      await assert.rejects(fix.driver.run(`
        INSERT INTO catalog_resource_org_assignments (resource_type, resource_id, org_id, created_at)
        VALUES ('agent', ?, ?, ?)
      `, [`missing-${suffix}`, `org-${suffix}`, Date.now()]), /catalog resource not found/);
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

  describe("compatibility domains on PG", () => {
    it("reads, writes, and rolls back Identity, Catalog, Configuration, Dify, and Billing together", async () => {
      const suffix = Math.random().toString(36).slice(2, 10);
      const orgId = `compat-org-${suffix}`;
      const userId = `compat-user-${suffix}`;
      const auth = new AuthCenterDb(fix.store);
      const identities = new IdentityRepository(fix.driver);
      await auth.createOrganization(orgId, "Compatibility Org", Date.now());
      await auth.createUser({
        id: userId, orgId, email: `${userId}@example.test`, name: userId, displayName: null,
        departmentId: null, role: "user", status: "active", localAuth: true, tokenLimit: null,
        createdAt: Date.now(), passwordHash: null, passwordUpdatedAt: null, lastLoginAt: null, extUserId: null,
      });
      await identities.putOrganizationProfile({
        orgId, code: `ENT-${suffix}`, loginMethod: "password", localEnabled: true, cloudEnabled: true,
      });
      await identities.createWallet("user", userId, 0);

      const catalog = new CatalogRepository(fix.driver);
      const catalogService = new CatalogService(catalog);
      const skill = await catalogService.createSkill({
        actor: { userId, orgId, role: "user" }, name: `skill-${suffix}`, supportedModes: "both",
      }, onlineCommandContext(`catalog-${suffix}`));

      const policies = new ClientPolicyRepository(fix.driver);
      await policies.putOrganization(orgId, { loginMethod: "cas" }, userId);
      const infrastructure = new PlatformIntegrationSettingsRepository(fix.driver);
      await infrastructure.put(`compat-${suffix}`, { enabled: true }, userId);

      const dify = new DifyRepository(fix.driver);
      await dify.putResource({
        id: `dataset-${suffix}`, orgId, connectionId: `connection-${suffix}`,
        resourceType: "dataset", externalId: `external-${suffix}`, metadata: { name: "Knowledge" },
      });

      const billing = new BillingRepository(fix.driver);
      const wallet = new WalletService(fix.driver, billing);
      await wallet.post({
        ownerType: "user", ownerId: userId, deltaUnits: 25, entryType: "BONUS",
        sourceType: "pg-test", sourceId: suffix, orgId,
      }, onlineCommandContext(`wallet-${suffix}`));

      assert.equal((await catalog.getSkill(skill.id, orgId))?.id, skill.id);
      assert.equal((await policies.getEffective(orgId)).loginMethod, "cas");
      assert.deepEqual(await infrastructure.get(`compat-${suffix}`), { enabled: true });
      assert.equal((await dify.getResourceByExternalId(orgId, `connection-${suffix}`, "dataset", `external-${suffix}`))?.id, `dataset-${suffix}`);
      assert.equal((await billing.getWallet("user", userId))?.balanceUnits, 25);

      const rollbackOrgId = `rollback-org-${suffix}`;
      await assert.rejects(fix.driver.transaction(async () => {
        await auth.createOrganization(rollbackOrgId, "Rollback Org", Date.now());
        await identities.putOrganizationProfile({
          orgId: rollbackOrgId, code: `ROLLBACK-${suffix}`,
          loginMethod: "password", localEnabled: true, cloudEnabled: true,
        });
        throw new Error("rollback compatibility transaction");
      }), /rollback compatibility transaction/);
      assert.equal(await auth.getOrganization(rollbackOrgId), null);
      assert.equal(await identities.getOrganizationProfile(rollbackOrgId), null);
    });

    it("allocates every compatibility counter atomically across two pools and advances past imports", async () => {
      const peer = await openPeer(dbName);
      try {
        const suffix = Math.random().toString(36).slice(2, 10);
        await new AuthCenterDb(fix.store).createOrganization(`org-${suffix}`, "Counter Org", Date.now());
        const identityA = new IdentityRepository(fix.driver);
        const identityB = new IdentityRepository(peer.driver);
        const aliases = await Promise.all(Array.from({ length: 24 }, (_, index) =>
          (index % 2 === 0 ? identityA : identityB).allocateNumericAlias(
            `pg-counter-${suffix}`, `resource-${suffix}-${index}`, `org-${suffix}`,
          ),
        ));
        assert.equal(new Set(aliases).size, aliases.length);

        await Promise.all(Array.from({ length: 16 }, (_, index) =>
          (index % 2 === 0 ? identityA : identityB).insertOperationAudit({
            id: `audit-${suffix}-${index}`, orgId: `org-${suffix}`, action: "TEST",
            resource: "counter", idempotencyKey: `audit-key-${suffix}-${index}`,
          }),
        ));
        const auditIds = await fix.driver.all<{ legacy_id: number }>(`
          SELECT legacy_id FROM operation_audit_events WHERE id LIKE ? ORDER BY legacy_id
        `, [`audit-${suffix}-%`]);
        assert.equal(new Set(auditIds.map(row => Number(row.legacy_id))).size, 16);

        const billingA = new BillingRepository(fix.driver);
        const billingB = new BillingRepository(peer.driver);
        await Promise.all(Array.from({ length: 16 }, (_, index) =>
          (index % 2 === 0 ? billingA : billingB).insertLedgerEntry({
            id: `ledger-${suffix}-${index}`, ownerType: "user", ownerId: `owner-${suffix}`,
            deltaUnits: 1, balanceBeforeUnits: index, balanceAfterUnits: index + 1,
            entryType: "BONUS", sourceType: "pg-test", sourceId: `${index}`,
            idempotencyKey: `ledger-key-${suffix}-${index}`, contextSource: "online", createdAt: Date.now() + index,
          }),
        ));
        const ledgerIds = await fix.driver.all<{ legacy_id: number }>(`
          SELECT legacy_id FROM billing_ledger_entries WHERE id LIKE ? ORDER BY legacy_id
        `, [`ledger-${suffix}-%`]);
        assert.equal(new Set(ledgerIds.map(row => Number(row.legacy_id))).size, 16);

        const activityIds = await Promise.all(Array.from({ length: 16 }, (_, index) =>
          (index % 2 === 0 ? billingA : billingB).allocateActivityLegacyId("ADMIN"),
        ));
        assert.equal(new Set(activityIds).size, activityIds.length);

        const imported = 2_100_000_000 + Math.floor(Math.random() * 10_000);
        await identityA.assignNumericAlias({
          namespace: `pg-import-${suffix}`, legacyId: imported,
          resourceId: `imported-${suffix}`, orgId: `org-${suffix}`,
        });
        assert.ok(await identityB.allocateNumericAlias(
          `pg-import-${suffix}`, `after-import-${suffix}`, `org-${suffix}`,
        ) > imported);
      } finally {
        await peer.pool.end();
      }
    });

    it("repairs ShareOne visibility before compatibility services become visible", async () => {
      await fix.store.ensureDefaultConfigItems();
      await repairConfigAvailability(fix.driver);
      const row = await fix.driver.get<{ availability: string }>(`
        SELECT availability FROM config_items WHERE scope = 'user' AND org_id IS NULL ORDER BY id LIMIT 1
      `);
      assert.equal(row?.availability, "all");

      const suffix = Math.random().toString(36).slice(2, 10);
      const auth = new AuthCenterDb(fix.store);
      const identities = new IdentityRepository(fix.driver);
      const orgId = `visibility-org-${suffix}`;
      await auth.createOrganization(orgId, "Visibility Org", Date.now());
      await identities.putOrganizationProfile({
        orgId, code: `VIS-${suffix}`, loginMethod: "password", localEnabled: true, cloudEnabled: true,
      });
      const service = new SudoworkConfigService({
        db: fix.driver, configItems: createConfigItemsApi(fix.store), identities, authDb: auth,
      });
      const visible = await service.listForUser({ userId: `visibility-user-${suffix}`, orgId, role: "user" });
      assert.ok(visible.some(item => item.name === "ShareOne"));
    });

    it("runs target-side migration dialect branches against PostgreSQL", async () => {
      const migrationDb = await createFreshDatabase(admin);
      const target = await openFixture(migrationDb);
      const control = new DatabaseSync(":memory:");
      try {
        await target.driver.run("DROP TABLE outbox_events");
        const auth = new AuthCenterDb(target.store);
        const identities = new IdentityRepository(target.driver);
        const unified = new UnifiedIdentityService(auth, identities);
        const runs = new MigrationRunStore(control, { idFactory: () => "pg-target-run" });
        runs.createRun({ sourceFingerprint: "pg-target-source", sourceMetadata: {} });
        const identity = new IdentityMigrationService({
          db: target.driver, auth, identities, unified, runs,
          source: { readSnapshot: () => ({ organizations: [], users: [] }) },
          planner: new IdentityMergePlanner({ organizations: [], users: [] }),
        });
        const identityPlan = await identity.plan([]);
        const withoutOutbox = await identity.executeUsers(
          identityPlan, migrationCommandContext("pg-target-run", "identity-without-outbox"),
        );
        assert.equal(withoutOutbox.deliverableExternalOutboxCount, 0);

        const p4 = new P4DifyMigrationService({
          db: target.driver, auth, identities,
          catalog: new CatalogRepository(target.driver),
          dify: new DifyRepository(target.driver),
          source: { readSnapshot: () => ({
            checksum: "pg-p4-empty", connections: [], apps: [], datasets: [], acl: [], metadata: [],
          }) },
          secrets: {
            async putSecret() {},
            async getSecret() { return null; },
          },
        });
        const p4Plan = await p4.plan();
        const p4WithoutOutbox = await p4.execute(
          p4Plan, migrationCommandContext("pg-p4-run", "p4-without-outbox"),
        );
        assert.equal(p4WithoutOutbox.deliverableExternalOutboxCount, 0);

        await target.driver.exec(`
          CREATE TABLE outbox_events (
            id TEXT PRIMARY KEY,
            context_source TEXT NOT NULL,
            status TEXT NOT NULL
          );
          INSERT INTO outbox_events (id, context_source, status)
          VALUES ('pending-migration', 'migration', 'pending');
        `);
        const withOutbox = await identity.executeUsers(
          identityPlan, migrationCommandContext("pg-target-run", "identity-with-outbox"),
        );
        assert.equal(withOutbox.deliverableExternalOutboxCount, 1);

        const suffix = Math.random().toString(36).slice(2, 10);
        const platformOrgId = `migration-platform-${suffix}`;
        await auth.createOrganization(platformOrgId, "Migration Platform", Date.now());
        await identities.putOrganizationProfile({
          orgId: platformOrgId, code: `MIG-${suffix}`,
          loginMethod: "password", localEnabled: true, cloudEnabled: true,
        });
        await identities.assignNumericAlias({
          namespace: "enterprise", legacyId: 900_000 + Math.floor(Math.random() * 10_000),
          resourceId: platformOrgId, orgId: platformOrgId,
        });
        const config = new SudoworkConfigService({
          db: target.driver, configItems: createConfigItemsApi(target.store), identities, authDb: auth,
        });
        const configuration = new P2ConfigurationMigrationService({
          db: target.driver, identities, config, platformConfigOrgId: platformOrgId,
          source: { readConfigItems: () => [
            {
              id: 701, name: `Null Pinyin ${suffix}`, description: null, icon: null, pinyin: null,
              urlPattern: null, scheme: null, bearerPrefix: null, visibleToAll: true, status: 1,
              createdById: null, createdByName: null, updatedById: null, updatedByName: null,
              createdAt: 1, updatedAt: 1, entries: [], enterpriseIds: [],
            },
            {
              id: 702, name: `Named Pinyin ${suffix}`, description: null, icon: null, pinyin: `named-${suffix}`,
              urlPattern: null, scheme: null, bearerPrefix: null, visibleToAll: true, status: 1,
              createdById: null, createdByName: null, updatedById: null, updatedByName: null,
              createdAt: 1, updatedAt: 1, entries: [], enterpriseIds: [],
            },
          ] },
        });
        const configurationPlan = await configuration.plan();
        assert.equal(configurationPlan.status, "ready");
        assert.equal(configurationPlan.items.length, 2);
      } finally {
        control.close();
        await target.release();
        await dropDatabase(admin, migrationDb);
      }
    });
  });

  describe("authentication bootstrap convergence", () => {
    it("two pools bootstrap the same empty database and converge on one root account", async () => {
      const bootstrapDb = await createFreshDatabase(admin);
      const first = await openFixture(bootstrapDb);
      const second = await openPeer(bootstrapDb);
      try {
        const options = {
          dbPath: "postgres",
          tokenTtlSec: 3_600,
          bootstrapAdmin: {
            username: "ha-root", email: "ha-root@example.test", password: "StrongPass123",
          },
        };
        const [a, b] = await Promise.all([
          createAuthService({ ...options, db: first.store }),
          createAuthService({ ...options, db: second.store }),
        ]);
        try {
          const count = await first.driver.get<{ count: number }>(`
            SELECT COUNT(*) AS count FROM users WHERE name = 'ha-root'
          `);
          assert.equal(Number(count?.count), 1);
          const secret = await first.driver.get<{ value: string }>(`
            SELECT value FROM server_config WHERE key = 'jwt_secret'
          `);
          assert.ok(secret?.value);
          assert.equal(await new AuthCenterDb(second.store).getConfig("jwt_secret"), secret?.value);
        } finally {
          a.service.destroy();
          b.service.destroy();
        }
      } finally {
        await first.release();
        await second.pool.end();
        await dropDatabase(admin, bootstrapDb);
      }
    });
  });

  describe("compatibility idempotency claims across pools", () => {
    it("allows only one Dify provider call for one idempotency key", async () => {
      const peer = await openPeer(dbName);
      let releaseProvider!: () => void;
      let signalStarted!: () => void;
      const providerGate = new Promise<void>(resolve => { releaseProvider = resolve; });
      const providerStarted = new Promise<void>(resolve => { signalStarted = resolve; });
      let providerCalls = 0;
      const fetchImpl = (async () => {
        providerCalls += 1;
        signalStarted();
        await providerGate;
        return Response.json({ id: "dataset-ha", name: "HA Dataset", permission: "all_team_members" });
      }) as typeof fetch;
      const adapter = new DifyHttpAdapter({ baseUrl: "https://dify.example.test", fetchImpl });
      const connections = {
        async resolveOrganizationContext(orgId: string) {
          return {
            orgId, connectionId: "connection-ha", tenantId: "tenant-ha", systemAccountId: null,
            apiKey: "service-key", baseUrl: "https://dify.example.test",
          };
        },
      };
      const context = onlineCommandContext(`dify-ha-${Math.random().toString(36).slice(2)}`);
      const serviceA = new DifyDatasetService({
        db: fix.driver, repository: new DifyRepository(fix.driver), adapter, connections,
      });
      const serviceB = new DifyDatasetService({
        db: peer.driver, repository: new DifyRepository(peer.driver), adapter, connections,
      });
      try {
        const first = serviceA.create("org-ha", { name: "HA Dataset" }, context)
          .then(value => ({ status: "fulfilled" as const, value }), reason => ({ status: "rejected" as const, reason }));
        await providerStarted;
        const second = serviceB.create("org-ha", { name: "HA Dataset" }, context)
          .then(value => ({ status: "fulfilled" as const, value }), reason => ({ status: "rejected" as const, reason }));
        await new Promise(resolve => setTimeout(resolve, 100));
        releaseProvider();
        const results = await Promise.all([first, second]);
        assert.equal(providerCalls, 1);
        assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
      } finally {
        releaseProvider();
        await peer.pool.end();
      }
    });

    it("allows only one Sudorouter quota mutation for one billing operation", async () => {
      const peer = await openPeer(dbName);
      const suffix = Math.random().toString(36).slice(2, 10);
      const ownerId = `billing-owner-${suffix}`;
      const identities = new IdentityRepository(fix.driver);
      await identities.createWallet("user", ownerId, 0);
      let releaseProvider!: () => void;
      let signalStarted!: () => void;
      const providerGate = new Promise<void>(resolve => { releaseProvider = resolve; });
      const providerStarted = new Promise<void>(resolve => { signalStarted = resolve; });
      let quotaUnits = 0;
      let changeCalls = 0;
      const provider = {
        async getUser(externalUserId: string): Promise<QuotaSnapshot> {
          return { externalUserId, quotaUnits, usedQuotaUnits: 0 };
        },
        async changeQuota(input: { deltaUnits: number }) {
          changeCalls += 1;
          signalStarted();
          await providerGate;
          quotaUnits += input.deltaUnits;
          return { success: true };
        },
      };
      const repoA = new BillingRepository(fix.driver);
      const repoB = new BillingRepository(peer.driver);
      const coordinatorA = new BillingCoordinator(
        fix.driver, repoA, new WalletService(fix.driver, repoA), provider,
        { idGenerator: () => `quota-a-${suffix}` },
      );
      const coordinatorB = new BillingCoordinator(
        peer.driver, repoB, new WalletService(peer.driver, repoB), provider,
        { idGenerator: () => `quota-b-${suffix}` },
      );
      const input = {
        ownerType: "user" as const, ownerId, orgId: `org-${suffix}`, externalUserId: `external-${suffix}`,
        pointsDelta: 10, reason: "HA", sourceType: "pg-test", sourceId: suffix,
      };
      const context = onlineCommandContext(`quota-ha-${suffix}`);
      try {
        const first = coordinatorA.adjustPoints(input, context)
          .then(value => ({ status: "fulfilled" as const, value }), reason => ({ status: "rejected" as const, reason }));
        await providerStarted;
        const second = coordinatorB.adjustPoints(input, context)
          .then(value => ({ status: "fulfilled" as const, value }), reason => ({ status: "rejected" as const, reason }));
        await new Promise(resolve => setTimeout(resolve, 100));
        releaseProvider();
        const results = await Promise.all([first, second]);
        assert.equal(changeCalls, 1);
        assert.equal(results.filter(result => result.status === "fulfilled" && result.value.status === "SUCCEEDED").length, 1);
        assert.equal(await repoA.countLedgerEntries(`wallet:quota:${context.idempotencyKey}`), 1);
      } finally {
        releaseProvider();
        await peer.pool.end();
      }
    });

    it("allows only one Sudorouter account workflow to call the provider", async () => {
      const peer = await openPeer(dbName);
      const suffix = Math.random().toString(36).slice(2, 10);
      let releaseProvider!: () => void;
      let signalStarted!: () => void;
      const providerGate = new Promise<void>(resolve => { releaseProvider = resolve; });
      const providerStarted = new Promise<void>(resolve => { signalStarted = resolve; });
      const accounts = new Map<string, SudorouterUserAccount>();
      let createCalls = 0;
      let quotaCalls = 0;
      let tokenCalls = 0;
      const provider: SudorouterAccountPort = {
        async findUserByUsername(username) {
          return [...accounts.values()].find(account => account.username === username) ?? null;
        },
        async createUser(input) {
          createCalls += 1;
          signalStarted();
          await providerGate;
          const account = { externalUserId: `external-${suffix}`, username: input.username, quotaUnits: 0, usedQuotaUnits: 0 };
          accounts.set(account.externalUserId, account);
          return account;
        },
        async createToken(input) {
          tokenCalls += 1;
          return `token-${input.externalUserId}`;
        },
        async getUser(externalUserId) {
          return accounts.get(externalUserId) ?? null;
        },
        async changeQuota(input) {
          quotaCalls += 1;
          const account = accounts.get(input.externalUserId);
          if (!account) return { success: false, error: "missing" };
          account.quotaUnits += input.deltaUnits;
          return { success: true };
        },
      };
      const secrets = new Map<string, string>();
      const secretPort = {
        async putSecret(namespace: string, key: string, value: string) { secrets.set(`${namespace}/${key}`, value); },
        async getSecret(namespace: string, key: string) {
          const value = secrets.get(`${namespace}/${key}`);
          return value === undefined ? null : { value, status: "enabled", version: 1 };
        },
      };
      const serviceA = new SudorouterAccountService(
        fix.driver, new BillingRepository(fix.driver), provider, secretPort,
      );
      const serviceB = new SudorouterAccountService(
        peer.driver, new BillingRepository(peer.driver), provider, secretPort,
      );
      const input = {
        ownerId: `account-owner-${suffix}`, orgId: `org-${suffix}`, username: `user-${suffix}`,
        displayName: "HA User", initialQuotaUnits: 500_000,
      };
      const context = onlineCommandContext(`account-ha-${suffix}`);
      try {
        const first = serviceA.ensureAccount(input, context)
          .then(value => ({ status: "fulfilled" as const, value }), reason => ({ status: "rejected" as const, reason }));
        await providerStarted;
        const second = serviceB.ensureAccount(input, context)
          .then(value => ({ status: "fulfilled" as const, value }), reason => ({ status: "rejected" as const, reason }));
        await new Promise(resolve => setTimeout(resolve, 100));
        releaseProvider();
        const results = await Promise.all([first, second]);
        assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
        assert.deepEqual({ createCalls, quotaCalls, tokenCalls }, { createCalls: 1, quotaCalls: 1, tokenCalls: 1 });
      } finally {
        releaseProvider();
        await peer.pool.end();
      }
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

  describe("tryRunExclusiveSession — session-scoped advisory lock (E1/R17)", () => {
    it("excludes a second pool on the same key, allows a different key, releases on return", async () => {
      const url = PG_URL.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`);
      const pool2 = new Pool({ connectionString: url, max: 2 });
      const driver2 = new PgDriver(pool2 as unknown as PgPoolLike);
      try {
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve });
        const holder = fix.driver.tryRunExclusiveSession("sess-lock", async () => { await gate; return "held"; });
        await new Promise(r => setTimeout(r, 200));
        const loser = await driver2.tryRunExclusiveSession("sess-lock", async () => "should-not-run");
        assert.equal(loser, null, "contending session run must be rejected, not queued");
        const other = await driver2.tryRunExclusiveSession("sess-lock-other", async () => "ok");
        assert.equal(other, "ok", "a different key is not blocked");
        release();
        assert.equal(await holder, "held");
        const after = await driver2.tryRunExclusiveSession("sess-lock", async () => "re-taken");
        assert.equal(after, "re-taken", "lock is takeable again after fn returns");
      } finally {
        await pool2.end();
      }
    });

    it("writes inside fn autocommit and are visible to another connection mid-run (no long transaction)", async () => {
      const url = PG_URL.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`);
      const pool2 = new Pool({ connectionString: url, max: 2 });
      const driver2 = new PgDriver(pool2 as unknown as PgPoolLike);
      try {
        const name = `sesslock_${Math.random().toString(36).slice(2)}`;
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve });
        const holder = fix.driver.tryRunExclusiveSession("sess-vis", async () => {
          await fix.store.createConfigItem({ name, pinyin: "p", scope: "user" });
          await gate; // still "inside" fn
          return "done";
        });
        await new Promise(r => setTimeout(r, 200));
        const rows = await driver2.all("SELECT 1 AS x FROM config_items WHERE name = ?", [name]);
        assert.equal(rows.length, 1, "a row committed inside fn must be visible to another connection mid-run");
        release();
        assert.equal(await holder, "done");
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

  describe("HA fixes: LIKE escaping through prepare() (C-7)", () => {
    it("escapeLike + ESCAPE survives the LIKE→ILIKE rewrite and matches literally", async () => {
      const { escapeLike } = await import("../db/driver.js");
      const pool = new Pool({ connectionString: PG_URL, max: 2 });
      try {
        const driver = new PgDriver(pool as unknown as PgPoolLike);
        await driver.run("CREATE TEMP TABLE esc_pg (name TEXT)");
        for (const n of ["100% done", "100x done", "a_b", "axb", "a\\b"]) {
          await driver.run("INSERT INTO esc_pg (name) VALUES (?)", [n]);
        }
        // driver.prepare() applies rewriteLikeToILike + placeholder numbering —
        // the exact production path for these statements.
        const like = async (term: string) =>
          (await driver.all<{ name: string }>(
            "SELECT name FROM esc_pg WHERE name LIKE ? ESCAPE '\\'",
            [`%${escapeLike(term)}%`],
          )).map(r => r.name);
        assert.deepEqual(await like("100%"), ["100% done"]);
        assert.deepEqual(await like("100"), ["100% done", "100x done"]);
        assert.deepEqual(await like("a_b"), ["a_b"]);
        assert.deepEqual(await like("a\\b"), ["a\\b"]);
      } finally {
        await pool.end();
      }
    });
  });

  describe("HA fixes: SQL dialect (A1-A5)", () => {
    it("A2: LIKE search matches across case via ILIKE rewrite", async () => {
      await fix.store.createConfigItem({ name: "GitHubProbe", pinyin: "github", scope: "user" });
      const res = await fix.store.listConfigItems({ name: "githubprobe" });
      assert.ok(
        res.items.some(r => r.name === "GitHubProbe"),
        "lowercase search must match TitleCase name under PG via ILIKE",
      );
    });

    it("A3: string/negative page inputs are clamped, not sent to PG as OFFSET -N", async () => {
      await fix.store.createConfigItem({ name: "PageProbe", pinyin: "pageprobe", scope: "user" });
      const byString = await fix.store.listConfigItems({
        name: "pageprobe",
        page: "abc" as unknown as number,
        pageSize: "abc" as unknown as number,
      });
      assert.equal(byString.items.length, 1);
      const byNeg = await fix.store.listConfigItems({ name: "pageprobe", page: -5, pageSize: -5 });
      assert.equal(byNeg.items.length, 1);
    });

    it("A1: PG names the email UNIQUE constraint users_email_key (matches translator)", async () => {
      const orgId = `o_${Math.random().toString(36).slice(2)}`;
      await fix.driver.run(
        "INSERT INTO organizations (id, name, created_at) VALUES (?, ?, ?)",
        [orgId, "org", Date.now()],
      );
      const email = `dup_${Math.random().toString(36).slice(2)}@x.com`;
      const mkUser = (id: string) =>
        fix.driver.run(
          "INSERT INTO users (id, org_id, email, name, local_auth, created_at) VALUES (?, ?, ?, ?, 0, ?)",
          [id, orgId, email, "n", Date.now()],
        );
      await mkUser("u_a");
      let caught: unknown;
      try { await mkUser("u_b"); } catch (e) { caught = e; }
      assert.ok(caught, "duplicate email must throw under PG");
      assert.equal(isUniqueViolationOn(caught, "users_email_key", "users.email"), true);
    });

    it("A1: PG names the ext-org constraint organizations_ext_uniq", async () => {
      const ext = `ext_${Math.random().toString(36).slice(2)}`;
      const mkOrg = () =>
        fix.driver.run(
          "INSERT INTO organizations (id, name, ext_org_id, created_at) VALUES (?, ?, ?, ?)",
          [`o_${Math.random().toString(36).slice(2)}`, "o", ext, Date.now()],
        );
      await mkOrg();
      let caught: unknown;
      try { await mkOrg(); } catch (e) { caught = e; }
      assert.equal(isUniqueViolationOn(caught, "organizations_ext_uniq", "organizations.ext_org_id"), true);
    });

    it("A5: two concurrent phone-code consumes succeed exactly once (two pool connections)", async () => {
      const authDb = new AuthCenterDb(fix.store);
      const phone = `139${Math.floor(Math.random() * 1e8).toString().padStart(8, "0")}`;
      const hash = "hash-value";
      await authDb.upsertPhoneLoginCode({ phone, codeHash: hash, createdAt: Date.now(), expiresAt: Date.now() + 60_000, attempts: 0 });
      const results = await Promise.all([
        authDb.consumePhoneLoginCode(phone, hash),
        authDb.consumePhoneLoginCode(phone, hash),
      ]);
      assert.equal(results.filter(Boolean).length, 1, "only one concurrent consume may win");
    });
  });

  describe("claimQueuedRuns cross-instance (B2/R5)", () => {
    it("two pools claiming the same queued run — only one wins under READ COMMITTED", async () => {
      const ets1 = new EventTriggerStore(fix.driver);
      const url = PG_URL.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`);
      const pool2 = new Pool({ connectionString: url, max: 2 });
      const driver2 = new PgDriver(pool2 as unknown as PgPoolLike);
      const ets2 = new EventTriggerStore(driver2);
      try {
        const run = await ets1.createRun({ triggerId: "t_b2", orgId: "o1", userId: "u1", payloadJson: null });
        assert.ok(run);
        const [a, b] = await Promise.all([ets1.claimQueuedRuns(10), ets2.claimQueuedRuns(10)]);
        const wins =
          a.filter(r => r.id === run!.id).length + b.filter(r => r.id === run!.id).length;
        assert.equal(wins, 1, "exactly one instance may claim the run (no double-execution)");
      } finally {
        await pool2.end();
      }
    });
  });

  describe("msgaudit lease cross-instance (E2/R18)", () => {
    it("two pools claiming the same corpApp — only one wins; expiry lets the other take over", async () => {
      const url = PG_URL.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`);
      const pool2 = new Pool({ connectionString: url, max: 2 });
      const driver2 = new PgDriver(pool2 as unknown as PgPoolLike);
      const store2 = forPostgresDirectConnectStore(driver2);
      try {
        const corpApp = `ca_${Math.random().toString(36).slice(2)}`;
        const now = Date.now();
        const ttl = 60_000;
        const [a, b] = await Promise.all([
          fix.store.claimMsgAuditLease(corpApp, "A", now + ttl, now),
          store2.claimMsgAuditLease(corpApp, "B", now + ttl, now),
        ]);
        assert.equal([a, b].filter(Boolean).length, 1, "exactly one instance may hold the lease");
        // Before expiry, neither foreign re-claim succeeds.
        assert.equal(await store2.claimMsgAuditLease(corpApp, "C", now + ttl, now + 1_000), false);
        // After expiry, it can be taken over.
        assert.equal(await store2.claimMsgAuditLease(corpApp, "C", now + 2 * ttl, now + ttl + 1), true);
      } finally {
        await pool2.end();
      }
    });
  });

  describe("A4: old-database v2 convergence + idempotent re-run", () => {
    it("converges a pre-a18659f v1 database and is a no-op on re-run", async () => {
      const oldDbName = await createFreshDatabase(admin);
      const url = PG_URL.replace(/\/[^/?]+(\?|$)/, `/${oldDbName}$1`);
      const pool = new Pool({ connectionString: url, max: 2 });
      const driver = new PgDriver(pool as unknown as PgPoolLike);
      try {
        // Hand-rolled pre-a18659f v1 shape: bare nullable wikis columns (with a
        // NULL row), users without phone columns, no phone/msgaudit tables,
        // wiki_build_jobs without claim columns, channel_plugins without lease.
        // tenant_skills/tenant_assistants/channel_sessions stand in minimal —
        // the real v1 schema has them, and v3's index/column additions target
        // them; only the columns v3 touches are modelled.
        await driver.exec(`
          CREATE TABLE _migrations (version BIGINT PRIMARY KEY, name TEXT NOT NULL, applied_at BIGINT NOT NULL);
          INSERT INTO _migrations (version, name, applied_at) VALUES (1, 'initial-schema', 0);
          CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL, ext_org_id TEXT, created_at BIGINT NOT NULL);
          -- Real pre-a18659f v1 databases carry enterprises (v1 SQL creates it);
          -- v5's ALTER TABLE ... ADD COLUMN is not table-idempotent, so the
          -- hand-rolled shape must model it.
          CREATE TABLE enterprises (
            id TEXT PRIMARY KEY DEFAULT 'default',
            logo TEXT,
            app_name TEXT,
            top_name TEXT,
            about_name TEXT,
            app_company_name TEXT,
            login_desp TEXT,
            client_cron_enabled BIGINT,
            created_at BIGINT NOT NULL,
            updated_at BIGINT NOT NULL
          );
          CREATE TABLE users (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, local_auth BIGINT NOT NULL DEFAULT 0, created_at BIGINT NOT NULL);
          CREATE TABLE wikis (id TEXT PRIMARY KEY, source_mode TEXT, source_node_ids TEXT, source_exclude_node_ids TEXT, auto_rebuild BIGINT DEFAULT 0, needs_rebuild BIGINT DEFAULT 0, created_by TEXT NOT NULL, created_at BIGINT NOT NULL);
          INSERT INTO wikis (id, created_by, created_at) VALUES ('w1', 'u1', 0);
          CREATE TABLE wiki_build_jobs (id TEXT PRIMARY KEY, wiki_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', queued_at BIGINT NOT NULL, triggered_by TEXT NOT NULL);
          CREATE TABLE channel_plugins (id TEXT NOT NULL, type TEXT NOT NULL, name TEXT NOT NULL, enabled BIGINT NOT NULL DEFAULT 0, status TEXT NOT NULL, user_id TEXT NOT NULL, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, PRIMARY KEY (id, user_id));
          CREATE TABLE tenant_skills (id TEXT PRIMARY KEY, org_id TEXT, author_id TEXT, status TEXT, enabled BIGINT DEFAULT 1);
          CREATE TABLE tenant_assistants (id TEXT PRIMARY KEY, org_id TEXT, author_id TEXT, status TEXT, enabled BIGINT DEFAULT 1);
          CREATE TABLE config_items (
            id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
            scope TEXT NOT NULL DEFAULT 'system',
            org_id TEXT
          );
          INSERT INTO config_items (scope, org_id) VALUES ('user', NULL);
          CREATE TABLE channel_sessions (id TEXT PRIMARY KEY);
        `);
        // v1 recorded as applied → applyPgSchema runs only v2 + v3.
        await applyPgSchema(driver);

        const migratedAvailability = await driver.get<{ availability: string }>(`
          SELECT availability FROM config_items WHERE scope = 'user' AND org_id IS NULL LIMIT 1
        `);
        assert.equal(migratedAvailability?.availability, 'all');

        // wikis columns are backfilled and now NOT NULL.
        const w = await driver.get<{ source_mode: string; source_node_ids: string; auto_rebuild: number }>(
          "SELECT source_mode, source_node_ids, auto_rebuild FROM wikis WHERE id = 'w1'",
        );
        assert.equal(w!.source_mode, "files");
        assert.equal(w!.source_node_ids, "[]");
        assert.equal(Number(w!.auto_rebuild), 0);
        const notNull = await driver.get<{ n: number }>(
          "SELECT count(*) AS n FROM information_schema.columns WHERE table_name = 'wikis' AND column_name = 'source_mode' AND is_nullable = 'NO'",
        );
        assert.equal(Number(notNull!.n), 1, "source_mode must be NOT NULL after v2");

        // a18659f + HA-fix objects now exist.
        for (const t of ["phone_login_codes", "phone_login_sends", "credit_applications", "msgaudit_leases"]) {
          const r = await driver.get<{ n: number }>(
            "SELECT count(*) AS n FROM information_schema.tables WHERE table_name = ?",
            [t],
          );
          assert.equal(Number(r!.n), 1, `${t} must exist after v2`);
        }
        for (const [tbl, col] of [["users", "phone"], ["wiki_build_jobs", "claimed_by"], ["channel_plugins", "lease_owner"]] as [string, string][]) {
          const r = await driver.get<{ n: number }>(
            "SELECT count(*) AS n FROM information_schema.columns WHERE table_name = ? AND column_name = ?",
            [tbl, col],
          );
          assert.equal(Number(r!.n), 1, `${tbl}.${col} must exist after v2`);
        }

        // Re-run is a no-op: all eight migrations remain applied exactly once.
        await applyPgSchema(driver);
        const versions = await driver.all<{ version: number }>("SELECT version FROM _migrations");
        assert.deepEqual(versions.map(r => Number(r.version)).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8]);
        // v3 (audit fixes): tenant-store org indexes (C-4) + the E-2
        // channel_sessions snapshot column.
        for (const idx of ["idx_tenant_skills_org", "idx_tenant_assistants_org"]) {
          const r = await driver.get<{ n: number }>(
            "SELECT count(*) AS n FROM pg_indexes WHERE indexname = ?",
            [idx],
          );
          assert.equal(Number(r!.n), 1, `${idx} must exist after v3`);
        }
        const colV3 = await driver.get<{ n: number }>(
          "SELECT count(*) AS n FROM information_schema.columns WHERE table_name = 'channel_sessions' AND column_name = 'last_agent_config'",
        );
        assert.equal(Number(colV3!.n), 1, "channel_sessions.last_agent_config must exist after v3");
        // v4 (recharge): paid recharge orders + refund records.
        for (const tbl of ["recharge_orders", "refund_records"]) {
          const r = await driver.get<{ n: number }>(
            "SELECT count(*) AS n FROM information_schema.tables WHERE table_name = ?",
            [tbl],
          );
          assert.equal(Number(r!.n), 1, `${tbl} must exist after v4`);
        }
      } finally {
        await pool.end();
        await dropDatabase(admin, oldDbName);
      }
    });
  });
});
