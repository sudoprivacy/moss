import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { createHmac, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { SqliteDriver } from "../db/driver.js";
import { DirectConnectStore } from "../db.js";
import { HttpError, writeJson } from "../httpRespond.js";
import { extractLeadSignal, redactInquiry } from "./rules.js";
import { ParkStore } from "./store.js";
import { ConsultationTurns } from "./consultationTurns.js";
import {
  handlePublicParkRoute,
  parkIpIdentity,
  processExpiredParkSessions,
} from "./publicRoutes.js";
import { ParkPhoneVerification } from "./phoneVerification.js";
import { ParkCaptcha } from "./captcha.js";
import { BoxOperations } from "./boxOperations.js";
import type { AuthService } from "../auth/service.js";
import {
  parkCompliance,
  parkMonthlyReport,
  parkOverview,
} from "./aggregates.js";
import { handleInternalParkRoute, recordParkAudit } from "./internalRoutes.js";
import { ensureIdentitySchema } from "../identity/identityRepository.js";
import {
  createCatalogTestRepository,
  createIdentityTestRepository,
} from "../testing/compatibilityRepositories.js";
import { publishParkPublicAssistant } from "./publicAssistant.js";
import { FakeAgentChannel } from "./testing/fakeAgentChannel.js";
import {
  dispatchParkAgentApi,
  leadSignalFromAgentInput,
  peekSessionSearch,
  recordSessionSearch,
} from "./parkAgentRoutes.js";
import { appendAgentInquiry, computeAgentConfidence } from "./agentInquiry.js";
import { DocumentStore } from "../documentStore.js";
import type { AuthContext } from "../auth/token.js";

void test("redaction and deterministic lead rule", () => {
  assert.equal(
    redactInquiry("电话 13812345678 邮箱 a@example.com"),
    "电话 [手机号] 邮箱 [邮箱]",
  );
  const result = extractLeadSignal(
    "我们是人工智能企业，计划下个月入驻，需要 200 平米场地和算力支持",
  );
  assert.ok(result.score >= 40);
  assert.equal(result.industry, "人工智能");
  assert.ok(result.concerns.includes("算力支持"));
});

void test("park schema migrates legacy columns idempotently and relaxes lead inquiry nullability", async () => {
  const db = new DatabaseSync(":memory:");
  const driver = new SqliteDriver(db);
  // Legacy layout: no consent_text, no moss_session_id, source_inquiry_id NOT NULL.
  db.exec(`CREATE TABLE park_config (
    org_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, logo_url TEXT,
    welcome_text TEXT NOT NULL, contact_enabled INTEGER NOT NULL DEFAULT 1,
    park_profile TEXT NOT NULL DEFAULT '', service_catalog TEXT NOT NULL DEFAULT '[]',
    service_catalog_version TEXT NOT NULL DEFAULT '1',
    assistant_status TEXT NOT NULL DEFAULT 'draft', assistant_config TEXT NOT NULL DEFAULT '{}',
    rate_config TEXT NOT NULL DEFAULT '{}', redaction_config TEXT NOT NULL DEFAULT '{}',
    updated_at BIGINT NOT NULL)`);
  db.exec(`CREATE TABLE park_sessions (
    id TEXT PRIMARY KEY, org_id TEXT NOT NULL, source_channel TEXT NOT NULL,
    started_at BIGINT NOT NULL, last_active_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL, risk_state TEXT NOT NULL DEFAULT 'normal',
    message_count INTEGER NOT NULL DEFAULT 0, token_budget_used INTEGER NOT NULL DEFAULT 0)`);
  db.exec(`CREATE TABLE park_leads (
    id TEXT PRIMARY KEY, org_id TEXT NOT NULL, source_session_id TEXT NOT NULL UNIQUE,
    source_inquiry_id TEXT NOT NULL, score INTEGER NOT NULL,
    score_explanation TEXT NOT NULL, tags_json TEXT NOT NULL,
    suggested_action TEXT NOT NULL, contact_status TEXT NOT NULL DEFAULT 'none',
    status TEXT NOT NULL DEFAULT 'proposed', owner_id TEXT,
    created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL)`);
  db.prepare(
    `INSERT INTO park_config (org_id, display_name, welcome_text, park_profile, service_catalog, service_catalog_version, assistant_status, assistant_config, rate_config, redaction_config, updated_at)
    VALUES ('park-mig', '旧园区', '欢迎', '', '[]', '1', 'draft', '{}', '{}', '{}', ?)`,
  ).run(Date.now());
  db.prepare(
    `INSERT INTO park_leads (id, org_id, source_session_id, source_inquiry_id, score, score_explanation, tags_json, suggested_action, created_at, updated_at)
    VALUES ('lead-1', 'park-mig', 'session-1', 'inquiry-1', 40, '入驻条件 +20；场地空间 +20', '[]', '人工观察并按需联系', ?, ?)`,
  ).run(Date.now(), Date.now());

  const store = new ParkStore(driver);
  await store.init();
  const columns = (table: string) =>
    db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
      notnull: number;
    }>;
  const configColumns = columns("park_config");
  assert.ok(
    configColumns.some(
      (column) => column.name === "consent_text" && column.notnull === 1,
    ),
  );
  assert.ok(
    columns("park_sessions").some(
      (column) => column.name === "moss_session_id" && column.notnull === 0,
    ),
  );
  const leadInquiry = columns("park_leads").find(
    (column) => column.name === "source_inquiry_id",
  );
  assert.equal(leadInquiry?.notnull, 0);
  // The rebuilt table keeps existing rows.
  assert.equal(
    (
      db.prepare("SELECT COUNT(*) AS count FROM park_leads").get() as {
        count: number;
      }
    ).count,
    1,
  );
  assert.equal((await store.config("park-mig"))?.display_name, "旧园区");
  // A nullable inquiry reference can now be written (direct-contact leads).
  db.prepare(
    `INSERT INTO park_leads (id, org_id, source_session_id, source_inquiry_id, score, score_explanation, tags_json, suggested_action, created_at, updated_at)
    VALUES ('lead-2', 'park-mig', 'session-2', NULL, 20, '直接联系 +20', '["直接联系"]', '继续观察', ?, ?)`,
  ).run(Date.now(), Date.now());
  // Running init again is a no-op.
  await store.init();
  assert.equal(
    (
      db.prepare("SELECT COUNT(*) AS count FROM park_leads").get() as {
        count: number;
      }
    ).count,
    2,
  );
});

void test("park agent tool endpoints authorize via session token context and persist skill records", async () => {
  const db = new DatabaseSync(":memory:");
  const driver = new SqliteDriver(db);
  const store = new ParkStore(driver);
  await store.init();
  const orgId = "park-agent-test";
  await store.putConfig(orgId, {
    display_name: "测试园区",
    assistant_status: "published",
    assistant_config: JSON.stringify({
      assistant_id: "agent-1",
      policy_wiki_id: "wiki-1",
    }),
  } as never);
  const anonymousSession = await store.createSession(orgId, "web", 60 * 60_000);
  await store.db.run(
    "UPDATE park_sessions SET moss_session_id = ? WHERE id = ?",
    ["moss-1", anonymousSession.id],
  );

  const fakeDocumentStore = {
    getWiki: async () => null,
  } as unknown as DocumentStore;
  const deps = {
    store,
    orgId,
    readBody: async () => ({}),
    documentStore: fakeDocumentStore,
    vectorOptions: null,
  };
  const makeAuth = (
    assistantId: string | undefined,
    sessionId: string | undefined,
  ): AuthContext => ({
    rawToken: "test",
    userId: "park-public-consultation",
    orgId,
    role: "public",
    scopes: [],
    keyId: "k",
    jti: "j",
    exp: Date.now() / 1000 + 60,
    ...(assistantId !== undefined ? { assistantId } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
  });
  const dispatch = (
    auth: AuthContext,
    method = "GET",
    pathname = "/api/v1/agent/park/profile",
  ) =>
    dispatchParkAgentApi(
      deps,
      auth,
      method,
      pathname,
      new URL("http://localhost" + pathname),
      {} as never,
    );

  // Authorization chain: assistant mismatch, missing session mapping, unpublished assistant.
  await assert.rejects(
    dispatch(makeAuth("other-agent", "moss-1")),
    (error: unknown) => error instanceof HttpError && error.statusCode === 403,
  );
  await assert.rejects(
    dispatch(makeAuth("agent-1", "moss-missing")),
    (error: unknown) => error instanceof HttpError && error.statusCode === 403,
  );
  const draftOrg = "park-agent-draft";
  await store.putConfig(draftOrg, {
    display_name: "草稿园区",
    assistant_status: "draft",
    assistant_config: JSON.stringify({ assistant_id: "agent-1" }),
  } as never);
  await assert.rejects(
    dispatchParkAgentApi(
      { ...deps, orgId: draftOrg },
      makeAuth("agent-1", "moss-1"),
      "GET",
      "/api/v1/agent/park/profile",
      new URL("http://localhost/api/v1/agent/park/profile"),
      {} as never,
    ),
    (error: unknown) => error instanceof HttpError && error.statusCode === 403,
  );

  // Read endpoints derive park scope from the token.
  const profile = await dispatch(makeAuth("agent-1", "moss-1"));
  assert.ok(profile && profile.status === 200);

  // inquiry.append persists a redacted turn with server-side source refs and confidence.
  recordSessionSearch("moss-1", {
    count: 2,
    refs: [{ name: "租金减免政策.md", version: "wiki-v1", section: "第 2 行" }],
    at: Date.now(),
  });
  assert.equal(peekSessionSearch("moss-1")?.count, 2);
  const inquiryBody = {
    question: "入驻需要什么条件？电话 13812345678",
    answer: "根据《租金减免政策》第 2 行：可申请减免。",
    intent: "settlement_intent",
    industry_tags: ["人工智能", "机器人"],
  };
  const turns = new ConsultationTurns(store);
  const { turn } = await turns.begin(orgId, anonymousSession.id, randomUUID(), inquiryBody.question);
  const inquiry = await dispatchParkAgentApi(
    { ...deps, readBody: async () => inquiryBody },
    makeAuth("agent-1", "moss-1"),
    "POST",
    "/api/v1/agent/park/inquiries",
    new URL("http://localhost/api/v1/agent/park/inquiries"),
    {} as never,
  );
  assert.ok(inquiry && inquiry.status === 201);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM park_inquiries').get()!.count, 0);
  const lead = await dispatchParkAgentApi(
    { ...deps, readBody: async () => ({ intent: 'settlement_intent' }) },
    makeAuth('agent-1', 'moss-1'), 'POST', '/api/v1/agent/park/leads/propose',
    new URL('http://localhost/api/v1/agent/park/leads/propose'), {} as never,
  );
  assert.ok(lead && lead.status === 202);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM park_leads').get()!.count, 0);
  await turns.complete(turn, inquiryBody.question, inquiryBody.answer, peekSessionSearch('moss-1')!.refs);
  const row = db
    .prepare("SELECT * FROM park_inquiries WHERE org_id = ?")
    .get(orgId) as {
    redacted_question: string;
    intent: string;
    confidence: number;
    source_refs_json: string;
    client_request_id: string;
  };
  assert.ok(row.redacted_question.includes("[手机号]"));
  assert.equal(row.intent, "一般咨询");
  assert.equal(row.confidence, 0);
  assert.deepEqual(JSON.parse(row.source_refs_json), [
    { name: "租金减免政策.md", version: "wiki-v1", section: "第 2 行" },
  ]);
  assert.equal(row.client_request_id, turn.request_id);

});

void test("publishing the public assistant binds the policy wiki and registers the org skill", async () => {
  const previousHome = process.env.MOSS_HOME;
  const home = await mkdtemp(join(tmpdir(), "park-publish-"));
  process.env.MOSS_HOME = home;
  try {
    const db = new DatabaseSync(":memory:");
    createIdentityTestRepository(db);
    createCatalogTestRepository(db);
    const driver = new SqliteDriver(db);
    const store = new ParkStore(driver);
    await store.init();
    const orgId = "park-publish-test";
    await store.putConfig(orgId, { display_name: "测试园区" });
    const fakeDocumentStore = {
      getWiki: async (id: string) =>
        id === "wiki-built"
          ? { id, buildStatus: "succeeded", lastBuiltAt: Date.now() }
          : id === "wiki-pending"
            ? { id, buildStatus: "pending", lastBuiltAt: null }
            : null,
    } as unknown as DocumentStore;
    const skillEntries = [
      {
        path: "SKILL.md",
        contentBase64: Buffer.from(
          "---\nname: park-consultation-tools\ndisplayName: 园区咨询工具\ndescription: test\n---\n# Park Consultation Tools\n",
          "utf8",
        ).toString("base64"),
      },
    ];
    const publish = (wikiId: string) =>
      publishParkPublicAssistant(
        driver,
        orgId,
        { policy_wiki_id: wikiId },
        { documentStore: fakeDocumentStore, skillEntries },
      );
    await assert.rejects(
      publish("wiki-pending"),
      (error: unknown) =>
        error instanceof HttpError && error.statusCode === 400,
    );
    await assert.rejects(
      publish("wiki-missing"),
      (error: unknown) =>
        error instanceof HttpError && error.statusCode === 400,
    );
    const binding = await publish("wiki-built");
    assert.equal(binding.policy_wiki_id, "wiki-built");
    assert.ok(binding.assistant_id);
    assert.equal(
      (await publish("wiki-built")).assistant_id,
      binding.assistant_id,
    );
    const skill = await driver.get<{
      org_id: string;
      status: string;
      file_path: string;
    }>(
      "SELECT org_id, status, file_path FROM tenant_skills WHERE org_id = ? AND name = ?",
      [orgId, "park-consultation-tools"],
    );
    assert.ok(skill);
    assert.equal(skill.status, "approved");
    assert.ok(skill.file_path);
    const agent = await driver.get<{ config_json: string; visible_to: string }>(
      "SELECT config_json, visible_to FROM tenant_assistants WHERE id = ?",
      [binding.assistant_id],
    );
    const meta = JSON.parse(String(agent?.config_json ?? "{}")) as {
      enabledWikis?: string[];
      enabledSkills?: string[];
      skills?: string[];
    };
    assert.deepEqual(meta.enabledWikis, ["wiki-built"]);
    assert.deepEqual(meta.skills, meta.enabledSkills);
    // enabledSkills is resolved to the registered skill resource id at update time.
    assert.equal(meta.enabledSkills?.length, 1);
    assert.deepEqual(JSON.parse(agent?.visible_to ?? "{}").user_ids, [
      "park-public-consultation",
    ]);
  } finally {
    await rm(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.MOSS_HOME;
    else process.env.MOSS_HOME = previousHome;
  }
});

void test("public consultation streams through the agent channel with server-recorded sources and idempotent replay", async () => {
  const driver = new SqliteDriver(new DatabaseSync(":memory:"));
  const store = new ParkStore(driver);
  await store.init();
  await store.putConfig("park-1", {
    display_name: "测试园区",
    assistant_status: "published",
    assistant_config: JSON.stringify({
      assistant_id: "agent-1",
      policy_wiki_id: "wiki-built",
    }),
  });
  const channel = new FakeAgentChannel();
  channel.script = ["根据《算力政策》第 2 行：", "算力服务可申请。"];
  const readBody = async (
    request: http.IncomingMessage,
  ): Promise<Record<string, unknown>> => {
    let raw = "";
    for await (const chunk of request) raw += String(chunk);
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  };
  const server = http.createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      if (
        await handlePublicParkRoute(req, res, path, {
          store,
          orgId: "park-1",
          readBody,
          agentChannel: channel,
        })
      )
        return;
      writeJson(res, 404, {});
    })().catch((error) => {
      if (!res.headersSent)
        writeJson(res, error instanceof HttpError ? error.statusCode : 500, {
          error: error instanceof HttpError ? error.message : String(error),
        });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const created = await fetch(`${base}/public/consult/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(created.status, 201);
    const cookie = created.headers.get("set-cookie")!.split(";")[0];
    const session = (await created.json()) as { session_id: string };
    assert.equal(channel.created.length, 0);
    let mossSessionId: string | undefined;
    // Simulate the skill's policy.search recording its hits server-side.
    channel.beforeSend = async () => { mossSessionId = (await store.session("park-1", session.session_id))!.moss_session_id!; if (channel.sent.length === 1) recordSessionSearch(mossSessionId!, {
      count: 1,
      refs: [{ name: "算力政策.md", version: "wiki-v1", section: "第 2 行" }],
      at: Date.now(),
    });
    };
    const requestId = randomUUID();
    const ask = () =>
      fetch(`${base}/public/sessions/${session.session_id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({
          message: "算力支持是什么？",
          client_request_id: requestId,
        }),
      });
    const first = await (await ask()).text();
    assert.match(first, /event: delta/);
    assert.match(first, /算力服务可申请/);
    assert.match(first, /event: sources/);
    assert.match(first, /算力政策\.md/);
    assert.match(first, /event: done/);
    assert.equal(peekSessionSearch(mossSessionId!), null);
    assert.equal(channel.sent.length, 1);
    // Retrying the same client_request_id replays without a second agent turn.
    const replay = await (await ask()).text();
    assert.match(replay, /event: done/);
    assert.match(replay, /算力政策\.md/);
    assert.equal(channel.sent.length, 1);
    const nextTurn = await (
      await fetch(`${base}/public/sessions/${session.session_id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({
          message: "园区在哪里？",
          client_request_id: randomUUID(),
        }),
      })
    ).text();
    assert.doesNotMatch(nextTurn, /算力政策\.md/);
    // Every completed response is persisted once by the public route.
    assert.equal(
      (
        await driver.get<{ count: number }>(
          "SELECT COUNT(*) AS count FROM park_inquiries",
        )
      )?.count,
      2,
    );
    const updated = await driver.get<{ message_count: number }>(
      "SELECT message_count FROM park_sessions WHERE id = ?",
      [session.session_id],
    );
    assert.equal(Number(updated?.message_count), 2);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await driver.close();
  }
});

void test("idle lightweight visitor sessions are reclaimed without starting a runtime", async () => {
  const driver = new SqliteDriver(new DatabaseSync(":memory:"));
  const store = new ParkStore(driver);
  await store.init();
  await store.putConfig("park-cap", {
    display_name: "测试园区",
    assistant_status: "published",
    assistant_config: JSON.stringify({
      assistant_id: "agent-1",
      policy_wiki_id: "wiki-built",
    }),
    rate_config: JSON.stringify({
      anonymous_session_max: 2,
      anonymous_session_idle_minutes: 30,
    }),
  });
  const channel = new FakeAgentChannel();
  const readBody = async (): Promise<Record<string, unknown>> => ({});
  const deps = { store, orgId: "park-cap", readBody, agentChannel: channel };
  const server = http.createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      if (await handlePublicParkRoute(req, res, path, deps)) return;
      writeJson(res, 404, {});
    })().catch((error) => {
      if (!res.headersSent)
        writeJson(res, error instanceof HttpError ? error.statusCode : 500, {
          error: error instanceof HttpError ? error.message : String(error),
        });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const make = async () =>
      fetch(`${base}/public/consult/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
    assert.equal((await make()).status, 201);
    const second = await make();
    assert.equal(second.status, 201);
    const cookie = second.headers.get("set-cookie")!.split(";")[0];
    const session = (await second.json()) as { session_id: string };
    assert.equal((await make()).status, 201);
    assert.equal(channel.created.length, 0);
    // The status endpoint reports the server-authoritative closing time.
    const status = (await (
      await fetch(`${base}/public/sessions/${session.session_id}/status`, {
        headers: { cookie },
      })
    ).json()) as { closing_at: number; closed: boolean };
    assert.equal(status.closed, false);
    assert.ok(status.closing_at > Date.now() + 29 * 60_000);
    // Age both sessions past the idle window, then reclaim with the real clock.
    await driver.run("UPDATE park_sessions SET last_active_at = ?", [
      Date.now() - 31 * 60_000,
    ]);
    assert.equal(await processExpiredParkSessions(deps), 3);
    assert.equal(channel.terminated.length, 0);
    const expired = await fetch(
      `${base}/public/sessions/${session.session_id}/status`,
      { headers: { cookie } },
    );
    assert.equal(expired.status, 401);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await driver.close();
  }
});
void test("signed public proxy identity is used for visitor limits and forged identity falls back to the peer", () => {
  const previous = process.env.PARK_PUBLIC_PROXY_HMAC_KEY;
  const key = "test-public-proxy-key-with-more-than-32-characters";
  process.env.PARK_PUBLIC_PROXY_HMAC_KEY = key;
  try {
    const ip = "198.51.100.31";
    const time = String(Date.now());
    const signature = createHmac("sha256", key)
      .update(`${ip}|${time}`)
      .digest("hex");
    const request = {
      socket: { remoteAddress: "127.0.0.1" },
      headers: {
        "x-park-client-ip": ip,
        "x-park-client-time": time,
        "x-park-client-signature": signature,
      },
    } as unknown as http.IncomingMessage;
    assert.deepEqual(parkIpIdentity(request), { ip, subnet: "198.51.100" });
    request.headers["x-park-client-signature"] = "0".repeat(64);
    assert.deepEqual(parkIpIdentity(request), {
      ip: "127.0.0.1",
      subnet: "127.0.0",
    });
  } finally {
    if (previous === undefined) delete process.env.PARK_PUBLIC_PROXY_HMAC_KEY;
    else process.env.PARK_PUBLIC_PROXY_HMAC_KEY = previous;
  }
});

void test("lead jobs survive processing retries and claim is atomic", async () => {
  const driver = new SqliteDriver(new DatabaseSync(":memory:"));
  const store = new ParkStore(driver);
  await store.init();
  const session = await store.createSession("park-1", "web", 60_000);
  const signal = extractLeadSignal(
    "我们计划下个月入驻，需要 200 平米场地和算力支持",
  );
  await store.recordInquiry({
    orgId: "park-1",
    sessionId: session.id,
    requestId: "request-1",
    question: "已脱敏提问",
    answer: "已脱敏回答",
    signal,
    sourceRefs: [],
  });
  assert.equal(
    (
      await driver.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM park_lead_jobs WHERE status = 'queued'",
      )
    )?.count,
    1,
  );
  await store.processLeadJobs(async () => ({ signal, evidence: {}, confidence: null }));
  const lead = await store.leadBySession("park-1", session.id);
  assert.ok(lead);
  assert.equal(await store.claimLead("park-1", lead.id, "user-1"), true);
  assert.equal(await store.claimLead("park-1", lead.id, "user-2"), false);
  assert.ok(
    await store.addFollowUp("park-1", lead.id, "user-1", "已联系", null),
  );
  assert.equal(
    await store.closeLead("park-1", lead.id, "user-1", "converted"),
    true,
  );
  assert.equal(
    await store.addFollowUp("park-1", lead.id, "user-1", "不能恢复", null),
    null,
  );
  assert.equal(
    await store.closeLead("park-1", lead.id, "user-1", "closed"),
    false,
  );
  await driver.close();
});

void test("monthly report uses Shanghai month boundaries and overview channels use persisted sessions", async () => {
  const driver = new SqliteDriver(new DatabaseSync(":memory:"));
  const store = new ParkStore(driver);
  await store.init();
  const session = await store.createSession("park-1", "campaign-a", 60_000);
  const signal = extractLeadSignal("入驻");
  await store.recordInquiry({
    orgId: "park-1",
    sessionId: session.id,
    requestId: "boundary",
    inquiryId: randomUUID(),
    question: "入驻",
    answer: "已回答",
    signal,
    sourceRefs: [
      {
        document_id: "policy-1",
        citation_status: "verified",
        name: "入驻政策",
        version: "v1",
        section: "第一条",
      },
      { name: "服务目录", version: "v1", section: "算力" },
    ],
  });
  const lastMinute = Date.parse("2026-10-31T23:59:00+08:00");
  await driver.run("UPDATE park_sessions SET started_at = ? WHERE id = ?", [
    lastMinute,
    session.id,
  ]);
  await driver.run(
    "UPDATE park_inquiries SET created_at = ? WHERE session_id = ?",
    [lastMinute, session.id],
  );
  assert.equal(
    (await parkMonthlyReport(store, "park-1", "2026-10", lastMinute)).inquiries,
    1,
  );
  assert.equal(
    (await parkMonthlyReport(store, "park-1", "2026-11", lastMinute)).inquiries,
    0,
  );
  const overview = await parkOverview(store, "park-1", lastMinute);
  assert.deepEqual(overview.channels, [
    { channel: "campaign-a", sessions: 1, consulted: 1, contacted: 0, converted: 0 },
  ]);
  assert.deepEqual(overview.policy_interest, [
    { document_id: "policy-1", policy: "入驻政策", count: 1 },
  ]);
  await driver.close();
});

void test("compliance metrics separate rejection reasons and use inclusive retention boundaries", async () => {
  const driver = new SqliteDriver(new DatabaseSync(":memory:"));
  const store = new ParkStore(driver);
  await store.init();
  await driver.exec(
    "CREATE TABLE operation_audit_events (org_id TEXT NOT NULL, response_status INTEGER NOT NULL, created_at BIGINT NOT NULL DEFAULT 0, path TEXT NOT NULL DEFAULT '')",
  );
  const now = Date.now() + 1000;
  const session = await store.createSession("park-1", "web", 60_000);
  await driver.run("UPDATE park_sessions SET risk_state = ? WHERE id = ?", [
    "challenge_required",
    session.id,
  ]);
  await store.recordRejection(
    "park-1",
    session.id,
    "message_too_long",
    413,
    null,
  );
  await store.recordRejection("park-1", session.id, "ip_rate", 429, null);
  for (const status of [401, 403, 500])
    await driver.run(
      "INSERT INTO operation_audit_events (org_id, response_status, created_at, path) VALUES (?, ?, ?, ?)",
      ["park-1", status, now, "/api/v1/parks/park-1/metrics"],
    );
  for (const [index, retention] of [
    now - 1,
    now,
    now + 30 * 86_400_000,
    now + 30 * 86_400_000 + 1,
  ].entries()) {
    await driver.run(
      "INSERT INTO park_contacts (lead_id, org_id, consent_text, consent_at, retention_until) VALUES (?, ?, ?, ?, ?)",
      [`lead-${index}`, "park-1", "同意", now, retention],
    );
  }
  const metrics = await parkCompliance(store, "park-1", now);
  assert.equal(metrics.session_risk.challenge_required, 1);
  assert.deepEqual(metrics.rejection_hits.by_status, { "413": 1, "429": 1 });
  assert.equal(metrics.audit_failures.total, 3);
  assert.equal(metrics.audit_failures.auth_rejections, 2);
  assert.equal(metrics.contact_retention.expired, 1);
  assert.equal(metrics.contact_retention.expiring_soon, 2);
  await driver.close();
});

void test("phone code verifies once and respects the session and phone", async () => {
  const db = new DatabaseSync(":memory:");
  const driver = new SqliteDriver(db);
  const store = new ParkStore(driver);
  await store.init();
  let delivered = "";
  const phone = new ParkPhoneVerification(
    store,
    async (_number, code) => {
      delivered = code;
    },
    "test-secret-that-is-longer-than-32-characters",
  );
  await phone.send("session-1", "13812345678");
  assert.match(delivered, /^\d{6}$/);
  assert.equal(
    await phone.verify("session-2", "13812345678", delivered),
    false,
  );
  assert.equal(
    await phone.verify("session-1", "13912345678", delivered),
    false,
  );
  assert.equal(await phone.verify("session-1", "13812345678", delivered), true);
  assert.ok(await phone.verifiedAt("session-1", "13812345678"));
  assert.equal(
    await phone.verify("session-1", "13812345678", delivered),
    false,
  );
  await driver.close();
});

void test("phone code enforces cooldown, expiry, attempt and hourly limits and clears failed sends", async () => {
  const driver = new SqliteDriver(new DatabaseSync(":memory:"));
  const store = new ParkStore(driver);
  await store.init();
  const sent: string[] = [];
  const verification = new ParkPhoneVerification(
    store,
    async (_phone, code) => {
      sent.push(code);
    },
    "test-secret-that-is-longer-than-32-characters",
  );
  const base = Date.now();
  try {
    await verification.send("cooldown", "13812345678", base);
    await assert.rejects(
      verification.send("cooldown", "13812345678", base + 59_999),
      (error: unknown) =>
        error instanceof HttpError && error.statusCode === 429,
    );
    assert.equal(sent.length, 1);
    assert.equal(
      await verification.verify(
        "cooldown",
        "13812345678",
        sent[0]!,
        base + 300_000,
      ),
      false,
    );

    await verification.send("attempts", "13912345678", base);
    const wrong = sent[1] === "000000" ? "999999" : "000000";
    for (let attempt = 0; attempt < 5; attempt++)
      assert.equal(
        await verification.verify(
          "attempts",
          "13912345678",
          wrong,
          base + attempt,
        ),
        false,
      );
    assert.equal(
      await verification.verify("attempts", "13912345678", sent[1]!, base + 5),
      false,
    );

    for (let index = 1; index < 5; index++)
      await verification.send(
        `hourly-${index}`,
        "13812345678",
        base + index * 61_000,
      );
    await assert.rejects(
      verification.send("hourly-5", "13812345678", base + 5 * 61_000),
      (error: unknown) =>
        error instanceof HttpError && error.statusCode === 429,
    );
    assert.equal(sent.length, 6);

    const failing = new ParkPhoneVerification(
      store,
      async () => {
        throw new Error("test sender failure");
      },
      "test-secret-that-is-longer-than-32-characters",
    );
    await assert.rejects(
      failing.send("failed", "13712345678", base),
      (error: unknown) =>
        error instanceof HttpError && error.statusCode === 502,
    );
    const failedCode = await driver.get(
      "SELECT session_id FROM park_phone_codes WHERE session_id = ?",
      ["failed"],
    );
    const failedSend = await driver.get(
      "SELECT session_id FROM park_phone_sends WHERE session_id = ?",
      ["failed"],
    );
    assert.equal(failedCode, undefined);
    assert.equal(failedSend, undefined);
  } finally {
    await driver.close();
  }
});

void test("CAPTCHA grants a short session-scoped pass and cannot be replayed", async () => {
  const driver = new SqliteDriver(new DatabaseSync(":memory:"));
  const store = new ParkStore(driver);
  await store.init();
  const answer = "ABCDE";
  const captcha = new ParkCaptcha(
    store,
    "test-secret-that-is-longer-than-32-characters",
    () => answer,
  );
  const image = await captcha.issue("session-1");
  assert.match(image, /^data:image\/png;base64,/);
  assert.equal(answer.length, 5);
  assert.equal(await captcha.verify("session-2", answer), false);
  assert.equal(await captcha.verify("session-1", answer), true);
  assert.equal(await captcha.isPassed("session-1"), true);
  assert.equal(await captcha.verify("session-1", answer), false);
  await driver.close();
});

void test("box upgrade verifies Ed25519 signatures and rolls back a failed installer", async () => {
  const dir = await mkdtemp(join(tmpdir(), "park-box-test-"));
  const upgradeDir = join(dir, "upgrades");
  await mkdir(upgradeDir);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const archive = Buffer.from("signed upgrade payload");
  await writeFile(join(upgradeDir, "release.tar"), archive);
  await writeFile(
    join(upgradeDir, "release.tar.sig"),
    sign(null, archive, privateKey),
  );
  const publicKeyPath = join(dir, "public.pem");
  await writeFile(
    publicKeyPath,
    publicKey.export({ type: "spki", format: "pem" }),
  );
  const calls: string[] = [];
  const operations = new BoxOperations({
    rootDir: dir,
    upgradeDir,
    publicKeyPath,
    hooks: {
      upgrade: join(dir, "upgrade.exe"),
      rollback: join(dir, "rollback.exe"),
    },
    run: async (command) => {
      calls.push(command);
      if (command.endsWith("upgrade.exe")) throw new Error("installer failed");
      return "ok";
    },
  });
  try {
    assert.equal(await operations.verifyUpgrade("release.tar"), true);
    await assert.rejects(operations.upgrade("../release.tar"));
    await assert.rejects(operations.upgrade("release.tar"), /installer failed/);
    assert.equal(calls.length, 2);
    assert.ok(calls[1]?.endsWith("rollback.exe"));
    await writeFile(join(upgradeDir, "release.tar"), "tampered");
    assert.equal(await operations.verifyUpgrade("release.tar"), false);
  } finally {
    if (resolve(dir).startsWith(`${resolve(tmpdir())}${sep}`))
      await rm(dir, { recursive: true, force: true });
  }
});

void test("box status, backup, restore and reindex use fixed executables and selected archive", async () => {
  const dir = await mkdtemp(join(tmpdir(), "park-operations-test-"));
  const backupDir = join(dir, "backups");
  await mkdir(backupDir);
  await writeFile(join(backupDir, "snapshot.sqlite"), "backup data");
  const calls: Array<{ command: string; args: string[] }> = [];
  const operations = new BoxOperations({
    rootDir: dir,
    backupDir,
    hooks: {
      backup: join(dir, "backup.exe"),
      restore: join(dir, "restore.exe"),
      reindex: join(dir, "reindex.exe"),
      modelCheck: join(dir, "model.exe"),
    },
    run: async (command, args) => {
      calls.push({ command, args });
      return command.endsWith("model.exe") ? '{"healthy":true}' : "ok";
    },
  });
  try {
    const status = (await operations.status()) as {
      disk: { total_bytes: number };
      model: { healthy: boolean };
      archives: string[];
    };
    assert.ok(status.disk.total_bytes > 0);
    assert.equal(status.model.healthy, true);
    assert.deepEqual(status.archives, ["snapshot.sqlite"]);
    await operations.backup();
    await operations.restore("snapshot.sqlite");
    await operations.reindex();
    assert.deepEqual(
      calls.slice(1).map((call) => call.command.split(/[\\/]/).at(-1)),
      ["backup.exe", "restore.exe", "reindex.exe"],
    );
    assert.equal(calls[2]?.args[0], join(backupDir, "snapshot.sqlite"));
    await assert.rejects(operations.restore("../snapshot.sqlite"));
  } finally {
    if (resolve(dir).startsWith(`${resolve(tmpdir())}${sep}`))
      await rm(dir, { recursive: true, force: true });
  }
});

void test("public route streams agent answers idempotently and never leaks internal fields", async () => {
  const db = new DatabaseSync(":memory:");
  const driver = new SqliteDriver(db);
  const store = new ParkStore(driver);
  await store.init();
  await store.putConfig("park-1", {
    display_name: "测试园区",
    welcome_text: "欢迎咨询",
    assistant_status: "published",
    assistant_config: JSON.stringify({
      assistant_id: "agent-1",
      policy_wiki_id: "wiki-built",
    }),
  });
  const channel = new FakeAgentChannel();
  channel.script = ["根据《算力政策》（v1，第一条）：算力服务可申请。"];
  const server = http.createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      await handlePublicParkRoute(req, res, path, {
        store,
        orgId: "park-1",
        agentChannel: channel,
        readBody: async (request) => {
          let raw = "";
          for await (const chunk of request) raw += String(chunk);
          return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        },
      });
    })().catch((error) =>
      writeJson(res, error instanceof HttpError ? error.statusCode : 500, {
        error: String(error),
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const context = (await fetch(`${base}/public/consult/context`).then(
      (response) => response.json(),
    )) as Record<string, unknown>;
    assert.equal(context.display_name, "测试园区");
    assert.equal(context.published_policy_version, null);
    assert.equal("org_id" in context, false);
    assert.equal("access_token" in context, false);
    const created = await fetch(`${base}/public/consult/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ park_id: "other-park", role: "park_leader" }),
    });
    assert.equal(created.status, 201);
    const cookie = created.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie);
    assert.match(
      created.headers.get("set-cookie") ?? "",
      /HttpOnly; SameSite=Lax/,
    );
    assert.doesNotMatch(created.headers.get("set-cookie") ?? "", /Secure/);
    const session = (await created.json()) as {
      session_id: string;
      expires_at: number;
    };
    assert.ok(session.expires_at - Date.now() > 86_390_000);
    assert.ok(session.expires_at - Date.now() <= 86_400_000);
    const storedSession = await driver.get<{ org_id: string }>(
      "SELECT org_id FROM park_sessions WHERE id = ?",
      [session.session_id],
    );
    assert.equal(storedSession?.org_id, "park-1");
    const secureCreated = await fetch(`${base}/public/consult/sessions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-proto": "https",
      },
      body: "{}",
    });
    assert.equal(secureCreated.status, 201);
    assert.match(secureCreated.headers.get("set-cookie") ?? "", /; Secure/);
    assert.notEqual(
      ((await secureCreated.json()) as { session_id: string }).session_id,
      session.session_id,
    );
    const requestId = "11111111-1111-4111-8111-111111111111";
    const request = () =>
      fetch(`${base}/public/sessions/${session.session_id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({
          message: "算力支持是什么？",
          client_request_id: requestId,
        }),
      });
    const first = await request();
    const stream = await first.text();
    assert.equal(first.status, 200);
    assert.match(stream, /算力服务可申请/);
    assert.doesNotMatch(stream, /过期算力|未发布算力/);
    for (const body of [JSON.stringify(context), stream])
      assert.doesNotMatch(body, /access_token|refresh_token|org_id/);
    assert.equal((await request()).status, 200);
    // Inquiry rows come from the agent skill tool, not the route.
    const inquiry = await driver.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM park_inquiries",
    );
    assert.equal(inquiry?.count, 1);
    const noCookie = await fetch(
      `${base}/public/sessions/${session.session_id}/messages`,
    );
    assert.equal(noCookie.status, 401);
    const otherCookie = secureCreated.headers.get("set-cookie")!.split(";")[0];
    assert.equal(
      (
        await fetch(`${base}/public/sessions/${session.session_id}/messages`, {
          headers: { cookie: otherCookie },
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await fetch(`${base}/public/sessions/${session.session_id}/messages`, {
          headers: { cookie: `park_session=stale-session; ${cookie}` },
        })
      ).status,
      200,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await driver.close();
  }
});

void test("HTTP abuse challenge persists until verified and records both rejection reasons", async () => {
  const driver = new SqliteDriver(new DatabaseSync(":memory:"));
  const store = new ParkStore(driver);
  await store.init();
  await store.putConfig("challenge-park", {
    display_name: "安全测试园区",
    assistant_status: "published",
    assistant_config: JSON.stringify({ assistant_id: "agent-1" }),
    rate_config: JSON.stringify({ captcha_enabled: true }),
  });
  const captcha = new ParkCaptcha(
    store,
    "test-secret-that-is-longer-than-32-characters",
    () => "ABCDE",
  );
  const challengeChannel = new FakeAgentChannel();
  challengeChannel.script = ["园区答复"];
  const server = http.createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      await handlePublicParkRoute(req, res, path, {
        store,
        orgId: "challenge-park",
        captcha,
        agentChannel: challengeChannel,
        readBody: async (request) => {
          let raw = "";
          for await (const chunk of request) raw += String(chunk);
          return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        },
      });
    })().catch((error) =>
      writeJson(res, error instanceof HttpError ? error.statusCode : 500, {
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const created = await fetch(`${base}/public/consult/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const cookie = created.headers.get("set-cookie")!.split(";")[0];
    const session = (await created.json()) as { session_id: string };
    const message = (requestId: string, userAgent = "browser") =>
      fetch(`${base}/public/sessions/${session.session_id}/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie,
          "user-agent": userAgent,
        },
        body: JSON.stringify({
          message: "园区有哪些服务？",
          client_request_id: requestId,
        }),
      });
    const first = await message(
      "11111111-1111-4111-8111-111111111111",
      "python-requests",
    );
    assert.equal(first.status, 429);
    assert.equal(
      ((await first.json()) as { error: string }).error,
      "CAPTCHA_REQUIRED",
    );
    assert.equal(
      (await message("22222222-2222-4222-8222-222222222222")).status,
      429,
    );
    const challenge = (await fetch(
      `${base}/public/sessions/${session.session_id}/challenge`,
      { headers: { cookie } },
    ).then((response) => response.json())) as { image: string };
    assert.match(challenge.image, /^data:image\/png;base64,/);
    const answer = "ABCDE";
    const verified = await fetch(
      `${base}/public/sessions/${session.session_id}/challenge/verify`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ answer }),
      },
    );
    assert.equal(verified.status, 200);
    assert.equal(
      (await message("33333333-3333-4333-8333-333333333333")).status,
      200,
    );
    const reasons = await driver.all<{ reason: string }>(
      "SELECT reason FROM park_rejection_hits WHERE org_id = ?",
      ["challenge-park"],
    );
    assert.deepEqual(
      reasons.map((row) => row.reason),
      ["automated_traffic", "challenge_required"],
    );
    await store.putConfig("challenge-park", {
      rate_config: JSON.stringify({
        captcha_enabled: true,
        automated_traffic_detection: false,
      }),
    });
    const next = await fetch(`${base}/public/consult/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const nextCookie = next.headers.get("set-cookie")!.split(";")[0];
    const nextSession = (await next.json()) as { session_id: string };
    const allowed = await fetch(
      `${base}/public/sessions/${nextSession.session_id}/messages`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: nextCookie,
          "user-agent": "python-requests",
        },
        body: JSON.stringify({
          message: "园区有哪些服务？",
          client_request_id: randomUUID(),
        }),
      },
    );
    assert.equal(allowed.status, 200);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await driver.close();
  }
});

void test("public HTTP limits persist distinct box, IP, subnet, blacklist, length and frequency reasons", async () => {
  const previousKey = process.env.PARK_PUBLIC_PROXY_HMAC_KEY;
  const proxyKey = "park-limit-test-proxy-key-with-more-than-32-characters";
  process.env.PARK_PUBLIC_PROXY_HMAC_KEY = proxyKey;
  const driver = new SqliteDriver(new DatabaseSync(":memory:"));
  const store = new ParkStore(driver);
  await store.init();
  await driver.exec(
    "CREATE TABLE operation_audit_events (org_id TEXT NOT NULL, response_status INTEGER NOT NULL, created_at BIGINT NOT NULL DEFAULT 0, path TEXT NOT NULL DEFAULT '')",
  );
  let orgId = "rate-box";
  const limitsChannel = new FakeAgentChannel();
  limitsChannel.script = ["园区答复"];
  const server = http.createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      await handlePublicParkRoute(req, res, path, {
        store,
        orgId,
        agentChannel: limitsChannel,
        readBody: async (request) => {
          let raw = "";
          for await (const chunk of request) raw += String(chunk);
          return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        },
      });
    })().catch((error) =>
      writeJson(res, error instanceof HttpError ? error.statusCode : 500, {
        error: String(error),
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const identity = (ip: string) => {
      const time = String(Date.now());
      return {
        "x-park-client-ip": ip,
        "x-park-client-time": time,
        "x-park-client-signature": createHmac("sha256", proxyKey)
          .update(`${ip}|${time}`)
          .digest("hex"),
      };
    };
    const createSession = (ip: string) =>
      fetch(`${base}/public/consult/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...identity(ip) },
        body: "{}",
      });
    const configure = async (id: string, rate: Record<string, unknown>) => {
      orgId = id;
      await store.putConfig(id, {
        display_name: id,
        assistant_status: "published",
        assistant_config: JSON.stringify({ assistant_id: "agent-1" }),
        rate_config: JSON.stringify(rate),
      });
    };
    const rejected = async (
      response: Response,
      reason: string,
      status = 429,
    ) => {
      assert.equal(response.status, status);
      if (status === 429)
        assert.ok(Number(response.headers.get("retry-after")) > 0);
      const row = await driver.get<{ reason: string }>(
        "SELECT reason FROM park_rejection_hits WHERE org_id = ? ORDER BY rowid DESC LIMIT 1",
        [orgId],
      );
      assert.equal(row?.reason, reason);
    };

    await configure("rate-box", {
      box_per_minute: 1,
      ip_per_minute: 100,
      subnet_per_minute: 100,
    });
    assert.equal((await createSession("198.51.100.1")).status, 201);
    await rejected(await createSession("198.51.100.2"), "box_rate");

    await configure("rate-ip", {
      box_per_minute: 100,
      ip_per_minute: 1,
      subnet_per_minute: 100,
    });
    assert.equal((await createSession("198.51.101.1")).status, 201);
    await rejected(await createSession("198.51.101.1"), "ip_rate");

    await configure("rate-subnet", {
      box_per_minute: 100,
      ip_per_minute: 100,
      subnet_per_minute: 1,
    });
    assert.equal((await createSession("198.51.102.1")).status, 201);
    await rejected(await createSession("198.51.102.2"), "subnet_rate");

    await configure("rate-blacklist", { blacklist_ips: ["198.51.103.1"] });
    await rejected(await createSession("198.51.103.1"), "blacklist");

    await configure("rate-message", {
      message_max_length: 5,
      ip_per_minute: 1,
      box_per_minute: 100,
      subnet_per_minute: 100,
    });
    const created = await createSession("198.51.104.1");
    assert.equal(created.status, 201);
    const cookie = created.headers.get("set-cookie")!.split(";")[0];
    const session = (await created.json()) as { session_id: string };
    const message = (value: string) =>
      fetch(`${base}/public/sessions/${session.session_id}/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie,
          ...identity("198.51.104.1"),
        },
        body: JSON.stringify({
          message: value,
          client_request_id: randomUUID(),
        }),
      });
    await rejected(await message("123456"), "message_too_long", 413);
    assert.equal((await message("入驻")).status, 200);
    await rejected(await message("政策"), "ip_rate");
    const compliance = await parkCompliance(store, orgId);
    assert.equal(compliance.rejection_hits.by_reason.message_too_long, 1);
    assert.equal(compliance.rejection_hits.by_reason.ip_rate, 1);
    assert.deepEqual(compliance.rejection_hits.by_status, {
      "413": 1,
      "429": 1,
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await driver.close();
    if (previousKey === undefined)
      delete process.env.PARK_PUBLIC_PROXY_HMAC_KEY;
    else process.env.PARK_PUBLIC_PROXY_HMAC_KEY = previousKey;
  }
});

void test("concurrent public messages are rejected and counted while an answer is in progress", async () => {
  const driver = new SqliteDriver(new DatabaseSync(":memory:"));
  const store = new ParkStore(driver);
  await store.init();
  await store.putConfig("concurrent-park", {
    display_name: "并发测试园区",
    assistant_status: "published",
    assistant_config: JSON.stringify({ assistant_id: "agent-1" }),
    rate_config: JSON.stringify({
      concurrent_max: 1,
      box_per_minute: 100,
      ip_per_minute: 100,
      subnet_per_minute: 100,
    }),
  });
  let onStarted!: () => void;
  let onRelease!: () => void;
  const started = new Promise<void>((resolve) => {
    onStarted = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    onRelease = resolve;
  });
  const gatingChannel = new FakeAgentChannel();
  gatingChannel.beforeSend = async () => {
    onStarted();
    await pending;
  };
  const server = http.createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      await handlePublicParkRoute(req, res, path, {
        store,
        orgId: "concurrent-park",
        readBody: async (request) => {
          let raw = "";
          for await (const chunk of request) raw += String(chunk);
          return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        },
        agentChannel: gatingChannel,
      });
    })().catch((error) =>
      writeJson(res, error instanceof HttpError ? error.statusCode : 500, {
        error: String(error),
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const created = await fetch(`${base}/public/consult/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(created.status, 201);
    const cookie = created.headers.get("set-cookie")!.split(";")[0];
    const session = (await created.json()) as { session_id: string };
    const message = () =>
      fetch(`${base}/public/sessions/${session.session_id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({
          message: "园区政策",
          client_request_id: randomUUID(),
        }),
      });
    const first = message();
    await started;
    const second = await message();
    assert.equal(second.status, 429);
    assert.ok(Number(second.headers.get("retry-after")) > 0);
    const rejection = await driver.get<{ reason: string }>(
      "SELECT reason FROM park_rejection_hits WHERE org_id = ?",
      ["concurrent-park"],
    );
    assert.equal(rejection?.reason, "concurrent_limit");
    onRelease();
    assert.equal((await first).status, 200);
  } finally {
    onRelease();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await driver.close();
  }
});

void test("public inquiry flows through contact, recruiter actions, leader totals and audit", async () => {
  const db = new DatabaseSync(":memory:");
  ensureIdentitySchema(db);
  db.exec(
    "CREATE TABLE IF NOT EXISTS compatibility_id_counters (counter_key TEXT PRIMARY KEY, last_value INTEGER NOT NULL)",
  );
  const driver = new SqliteDriver(db);
  const store = new ParkStore(driver);
  await store.init();
  await store.putConfig("journey-park", {
    display_name: "旅程测试园区",
    welcome_text: "欢迎咨询",
    assistant_status: "published",
    assistant_config: JSON.stringify({
      assistant_id: "agent-1",
      policy_wiki_id: "wiki-built",
    }),
  });
  await store.putPolicy("journey-park", {
    title: "入驻及算力政策",
    version: "v1",
    section: "第一条",
    content: "入驻企业可申请园区算力支持。",
    status: "published",
    effectiveFrom: Date.now() - 1000,
    effectiveUntil: null,
  });
  await store.grantRole(
    "journey-park",
    "recruiter-1",
    "park_recruiter",
    "admin-1",
  );
  await store.grantRole("journey-park", "leader-1", "park_leader", "admin-1");
  await store.grantRole(
    "journey-park",
    "operator-1",
    "park_system_operator",
    "admin-1",
  );
  const actors: Record<string, string> = {
    "recruiter-token": "recruiter-1",
    "leader-token": "leader-1",
    "operator-token": "operator-1",
  };
  const journeyChannel = new FakeAgentChannel();
  journeyChannel.script = [
    "根据《入驻及算力政策》（v1，第一条）：入驻企业可申请园区算力支持。",
  ];
  const server = http.createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      const readBody = async (
        request: http.IncomingMessage,
      ): Promise<Record<string, unknown>> => {
        let raw = "";
        for await (const chunk of request) raw += String(chunk);
        return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      };
      if (path.startsWith("/public/")) {
        if (
          await handlePublicParkRoute(req, res, path, {
            store,
            orgId: "journey-park",
            readBody,
            agentChannel: journeyChannel,
          })
        )
          return;
      } else if (path.startsWith("/api/v1/parks/")) {
        const actor =
          actors[
            String(req.headers.authorization ?? "").replace(/^Bearer /, "")
          ];
        if (!actor) throw new HttpError(401, "Unauthorized");
        try {
          if (
            await handleInternalParkRoute(
              req,
              res,
              path,
              {
                userId: actor,
                orgId: "journey-park",
                role: "user",
                scopes: [],
              } as unknown as Parameters<typeof handleInternalParkRoute>[3],
              {
                store,
                orgId: "journey-park",
                authService: {} as Parameters<
                  typeof handleInternalParkRoute
                >[4]["authService"],
                readBody,
              },
            )
          )
            return;
        } catch (error) {
          if (error instanceof HttpError)
            await recordParkAudit(
              store,
              "journey-park",
              path,
              req.method ?? "GET",
              error.statusCode,
              actor,
              error.message,
            );
          throw error;
        }
      }
      writeJson(res, 404, { error: "NOT_FOUND" });
    })().catch((error) =>
      writeJson(res, error instanceof HttpError ? error.statusCode : 500, {
        error: String(error),
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const created = await fetch(`${base}/public/consult/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const cookie = created.headers.get("set-cookie")!.split(";")[0];
    const session = (await created.json()) as { session_id: string };
    const question = await fetch(
      `${base}/public/sessions/${session.session_id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({
          message:
            "我们是人工智能企业，下个月需要 200 平米场地和算力，如何入驻？电话 13812345678",
          client_request_id: randomUUID(),
        }),
      },
    );
    assert.equal(question.status, 200);
    assert.match(await question.text(), /入驻企业可申请园区算力支持/);
    const journeyInquiryId = await driver.get<{ id: string }>(
      "SELECT id FROM park_inquiries WHERE org_id = ? AND session_id = ?",
      ["journey-park", session.session_id],
    );
    await store.saveLead(
      "journey-park",
      session.session_id,
      journeyInquiryId?.id ?? null,
      leadSignalFromAgentInput(
        "settlement_intent",
        ["人工智能"],
        1,
        "建议安排园区参观",
      ),
    );
    const inquiry = await driver.get<{
      redacted_question: string;
      source_refs_json: string;
    }>(
      "SELECT redacted_question, source_refs_json FROM park_inquiries WHERE org_id = ?",
      ["journey-park"],
    );
    assert.match(inquiry?.redacted_question ?? "", /\[手机号\]/);
    assert.doesNotMatch(inquiry?.redacted_question ?? "", /13812345678/);
    assert.deepEqual(
      JSON.parse(inquiry!.source_refs_json).map(
        (source: { name: string; version: string; section: string }) => [
          source.name,
          source.version,
          source.section,
        ],
      ),
      [],
    );
    const contact = await fetch(
      `${base}/public/sessions/${session.session_id}/contact`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ email: "visitor@example.com", consent: true }),
      },
    );
    assert.equal(contact.status, 201);
    const recruiterHeaders = {
      authorization: "Bearer recruiter-token",
      "content-type": "application/json",
    };
    const leads = (await fetch(`${base}/api/v1/parks/journey-park/leads`, {
      headers: recruiterHeaders,
    }).then((response) => response.json())) as Array<{
      id: string;
      has_contact: boolean;
    }>;
    assert.equal(leads.length, 1);
    assert.equal(leads[0]?.has_contact, true);
    const leadId = leads[0]!.id;
    const leadRow = await driver.get<{
      score: number;
      tags_json: string;
      suggested_action: string;
    }>(
      "SELECT score, tags_json, suggested_action FROM park_leads WHERE id = ?",
      [leadId],
    );
    assert.ok((leadRow?.score ?? 0) >= 40);
    assert.ok(Array.isArray(JSON.parse(leadRow!.tags_json)));
    assert.ok(leadRow?.suggested_action);
    const contactRow = await driver.get<{
      consent_text: string;
      consent_at: number;
      retention_until: number;
    }>(
      "SELECT consent_text, consent_at, retention_until FROM park_contacts WHERE lead_id = ?",
      [leadId],
    );
    assert.match(contactRow?.consent_text ?? "", /同意/);
    assert.ok(Number(contactRow?.consent_at) > 0);
    assert.ok(
      Number(contactRow?.retention_until) > Number(contactRow?.consent_at),
    );
    const claim = await fetch(
      `${base}/api/v1/parks/journey-park/leads/${leadId}/claim`,
      { method: "POST", headers: recruiterHeaders, body: "{}" },
    );
    assert.equal(claim.status, 200, await claim.text());
    assert.equal(
      (
        await fetch(
          `${base}/api/v1/parks/journey-park/leads/${leadId}/follow-ups`,
          {
            method: "POST",
            headers: recruiterHeaders,
            body: JSON.stringify({ note: "已联系并确认需求" }),
          },
        )
      ).status,
      201,
    );
    const owned = (await fetch(`${base}/api/v1/parks/journey-park/follow-ups`, {
      headers: recruiterHeaders,
    }).then((response) => response.json())) as Array<{
      id: string;
      has_contact: boolean;
      display_name: string;
      tags: string[];
    }>;
    assert.equal(owned.find((item) => item.id === leadId)?.has_contact, true);
    assert.equal(
      owned.find((item) => item.id === leadId)?.display_name,
      "已留联线索",
    );
    assert.ok(Array.isArray(owned.find((item) => item.id === leadId)?.tags));
    assert.equal(
      (
        await fetch(`${base}/api/v1/parks/journey-park/leads/${leadId}`, {
          method: "PATCH",
          headers: recruiterHeaders,
          body: JSON.stringify({ status: "converted" }),
        })
      ).status,
      200,
    );
    const anonymousCreated = await fetch(`${base}/public/consult/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const anonymousCookie = anonymousCreated.headers
      .get("set-cookie")!
      .split(";")[0];
    const anonymousSession = (await anonymousCreated.json()) as {
      session_id: string;
    };
    assert.equal(
      (
        await fetch(
          `${base}/public/sessions/${anonymousSession.session_id}/messages`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              cookie: anonymousCookie,
            },
            body: JSON.stringify({
              message: "下个月需要 200 平米场地和算力，如何入驻？",
              client_request_id: randomUUID(),
            }),
          },
        )
      ).status,
      200,
    );
    // The skill proposes the anonymous lead for the new session.
    await store.saveLead(
      "journey-park",
      anonymousSession.session_id,
      null,
      leadSignalFromAgentInput("settlement_intent", [], 1, ""),
    );
    const allLeads = (await fetch(`${base}/api/v1/parks/journey-park/leads`, {
      headers: recruiterHeaders,
    }).then((response) => response.json())) as Array<{
      source_session_id: string;
      has_contact: boolean;
      display_name: string;
    }>;
    const anonymousLead = allLeads.find(
      (item) => item.source_session_id === anonymousSession.session_id,
    );
    assert.ok(anonymousLead);
    assert.equal(anonymousLead.has_contact, false);
    assert.match(anonymousLead.display_name, /匿名潜在线索/);
    const leaderHeaders = { authorization: "Bearer leader-token" };
    const overview = (await fetch(`${base}/api/v1/parks/journey-park/metrics`, {
      headers: leaderHeaders,
    }).then((response) => response.json())) as {
      cards: Record<string, number>;
    };
    const total = await driver.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM park_inquiries WHERE org_id = ?",
      ["journey-park"],
    );
    const contacts = await driver.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM park_contacts WHERE org_id = ?",
      ["journey-park"],
    );
    const leadCount = await driver.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM park_leads WHERE org_id = ?",
      ["journey-park"],
    );
    const converted = await driver.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM park_leads WHERE org_id = ? AND status = 'converted'",
      ["journey-park"],
    );
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    const todayStart = Date.parse(`${today}T00:00:00+08:00`);
    const todayInquiries = await driver.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM park_inquiries WHERE org_id = ? AND created_at >= ?",
      ["journey-park", todayStart],
    );
    assert.equal(overview.cards.total_inquiries, total?.count);
    assert.equal(overview.cards.today_inquiries, todayInquiries?.count);
    assert.equal(
      overview.cards.anonymous_leads,
      (leadCount?.count ?? 0) - (contacts?.count ?? 0),
    );
    assert.equal(overview.cards.contacted_leads, contacts?.count);
    assert.equal(overview.cards.converted_leads, converted?.count);
    const summary = (await fetch(
      `${base}/api/v1/parks/journey-park/leads/summary`,
      { headers: leaderHeaders },
    ).then((response) => response.json())) as {
      distribution: Record<string, number>;
    };
    assert.equal(summary.distribution.converted, 1);
    const audit = (await fetch(
      `${base}/api/v1/parks/journey-park/admin/audit-events`,
      { headers: { authorization: "Bearer operator-token" } },
    ).then((response) => response.json())) as Array<{ path: string }>;
    assert.ok(audit.some((row) => row.path.endsWith(`leads/${leadId}/claim`)));
    assert.equal(
      (
        await fetch(`${base}/api/v1/parks/journey-park/leads`, {
          headers: leaderHeaders,
        })
      ).status,
      403,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await driver.close();
  }
});

void test("contact submission verifies the SMS code inline and accepts direct contact without consultation", async () => {
  const driver = new SqliteDriver(new DatabaseSync(":memory:"));
  const store = new ParkStore(driver);
  await store.init();
  await store.putConfig("contact-park", {
    display_name: "联系测试园区",
    assistant_status: "published",
    assistant_config: JSON.stringify({
      assistant_id: "agent-1",
      policy_wiki_id: "wiki-built",
    }),
    consent_text: "本园区承诺仅用于招商对接。",
  });
  const smsLog: Array<{ phone: string; code: string }> = [];
  const phoneVerification = new ParkPhoneVerification(
    store,
    async (phone, code) => {
      smsLog.push({ phone, code });
    },
    "contact-test-secret-longer-than-32-chars",
  );
  const captcha = new ParkCaptcha(
    store,
    "contact-captcha-secret-longer-than-32-characters",
    () => "XY7AB",
  );
  const channel = new FakeAgentChannel();
  channel.script = ["园区答复"];
  const readBody = async (
    request: http.IncomingMessage,
  ): Promise<Record<string, unknown>> => {
    let raw = "";
    for await (const chunk of request) raw += String(chunk);
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  };
  const deps = {
    store,
    orgId: "contact-park",
    readBody,
    phoneVerification,
    captcha,
    agentChannel: channel,
  };
  const server = http.createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      if (await handlePublicParkRoute(req, res, path, deps)) return;
      writeJson(res, 404, {});
    })().catch((error) => {
      if (!res.headersSent)
        writeJson(res, error instanceof HttpError ? error.statusCode : 500, {
          error: error instanceof HttpError ? error.message : String(error),
        });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const created = await fetch(`${base}/public/consult/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const cookie = created.headers.get("set-cookie")!.split(";")[0];
    const session = (await created.json()) as { session_id: string };
    const post = (path: string, body: Record<string, unknown>) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify(body),
      });

    // R8: sending an SMS code requires a passed CAPTCHA first.
    assert.equal(
      (
        await post(`/public/sessions/${session.session_id}/contact-code`, {
          phone: "13800138000",
        })
      ).status,
      409,
    );
    const challenge = (await (
      await fetch(`${base}/public/sessions/${session.session_id}/challenge`, {
        headers: { cookie },
      })
    ).json()) as { image: string };
    assert.ok(challenge.image);
    const challengePath = `/public/sessions/${session.session_id}/challenge`;
    assert.equal((await fetch(`${base}${challengePath}`, { headers: { cookie } })).status, 429);
    // Contact retries are independent of the ordinary challenge issue interval.
    for (let attempt = 0; attempt < 5; attempt++) {
      assert.equal((await post(`${challengePath}/verify`, { answer: "ZZZZZ" })).status, 400);
    }
    assert.equal((await post(`${challengePath}/verify`, { answer: "XY7AB" })).status, 400);
    const retry = await fetch(`${base}${challengePath}?purpose=contact`, { headers: { cookie } });
    assert.equal(retry.status, 200);
    assert.match(((await retry.json()) as { image: string }).image, /^data:image\/png;base64,/);
    await store.db.run("UPDATE park_captcha_challenges SET expires_at = ? WHERE session_id = ?", [Date.now() - 1, session.session_id]);
    assert.equal((await post(`${challengePath}/verify`, { answer: "XY7AB" })).status, 400);
    assert.equal((await fetch(`${base}${challengePath}?purpose=contact`, { headers: { cookie } })).status, 200);
    assert.equal(
      (
        await post(`/public/sessions/${session.session_id}/challenge/verify`, {
          answer: "xy7ab",
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await post(`/public/sessions/${session.session_id}/contact-code`, {
          phone: "13800138000",
        })
      ).status,
      200,
    );
    assert.equal(smsLog.length, 1);
    await store.putConfig("contact-park", { rate_config: JSON.stringify({ ip_per_minute: 1 }) });
    const limitedChallenge = await fetch(`${base}${challengePath}?purpose=contact`, { headers: { cookie } });
    assert.equal(limitedChallenge.status, 429);
    assert.equal(limitedChallenge.headers.get("retry-after"), "60");
    assert.equal(((await limitedChallenge.json()) as { error: string }).error, "RATE_LIMITED");
    await store.putConfig("contact-park", { rate_config: "{}" });


    // R9/R6: empty contact, missing and wrong SMS codes carry distinct codes.
    assert.equal(
      (
        await post(`/public/sessions/${session.session_id}/contact`, {
          consent: true,
        })
      ).status,
      400,
    );
    const missing = await post(
      `/public/sessions/${session.session_id}/contact`,
      { phone: "13800138000", consent: true },
    );
    assert.equal(missing.status, 409);
    assert.equal(
      ((await missing.json()) as { error: string }).error,
      "PHONE_CODE_REQUIRED",
    );
    const wrong = await post(`/public/sessions/${session.session_id}/contact`, {
      phone: "13800138000",
      sms_code: "000000",
      consent: true,
    });
    assert.equal(
      ((await wrong.json()) as { error: string }).error,
      "PHONE_CODE_INVALID",
    );

    // R7: the correct code is verified as part of the submission itself.
    const submitted = await post(
      `/public/sessions/${session.session_id}/contact`,
      { phone: "13800138000", sms_code: smsLog[0]!.code, consent: true },
    );
    assert.equal(submitted.status, 201);

    // R12: a fresh session without any consultation can still leave contact details.
    const fresh = await fetch(`${base}/public/consult/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const freshCookie = fresh.headers.get("set-cookie")!.split(";")[0];
    const freshSession = (await fresh.json()) as { session_id: string };
    const direct = await fetch(
      `${base}/public/sessions/${freshSession.session_id}/contact`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie: freshCookie },
        body: JSON.stringify({ email: "direct@example.com", consent: true }),
      },
    );
    assert.equal(direct.status, 201);
    const directLead = await driver.get<{
      id: string;
      score: number;
      source_inquiry_id: string | null;
      tags_json: string;
    }>("SELECT * FROM park_leads WHERE source_session_id = ?", [
      freshSession.session_id,
    ]);
    assert.equal(directLead?.source_inquiry_id, null);
    assert.equal(directLead?.score, 20);
    assert.match(String(directLead?.tags_json), /直接联系/);
    // R10: the consent snapshot comes from the configured text.
    const contact = await driver.get<{ consent_text: string }>(
      "SELECT consent_text FROM park_contacts WHERE lead_id = ?",
      [directLead!.id],
    );
    assert.equal(contact?.consent_text, "本园区承诺仅用于招商对接。");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await driver.close();
  }
});

void test('deleting a policy document cascades out of every wiki source list', async () => {
  const cascadeHome = await mkdtemp(join(tmpdir(), 'park-cascade-'))
  const connect = new DirectConnectStore(join(cascadeHome, 'docs.db'))
  const driver = connect.driver
  const park = new ParkStore(driver)
  await park.init()
  try {
  await park.putConfig('cascade-park', { display_name: '级联测试园区' })
  const documentStore = new DocumentStore(connect)
  const node = await documentStore.createNode({ orgId: 'cascade-park', parentId: null, name: '政策文件' })
  const upload1 = await documentStore.uploadDocument({
    orgId: 'cascade-park', nodeId: node.id, fileName: '人才补贴.md', mimeType: 'text/markdown',
    content: Buffer.from('# 人才补贴\n\n引进人才可享租房补贴。\n', 'utf8'), uploadedBy: 'operator-1',
  })
  const upload2 = await documentStore.uploadDocument({
    orgId: 'cascade-park', nodeId: node.id, fileName: '算力优惠.md', mimeType: 'text/markdown',
    content: Buffer.from('# 算力优惠\n\n人工智能企业算力八折。\n', 'utf8'), uploadedBy: 'operator-1',
  })
  const wiki = await documentStore.createWiki({ orgId: 'cascade-park', name: '政策库A', sourceDocumentIds: [upload1.id, upload2.id], sourceMode: 'files', createdBy: 'operator-1' })
  await documentStore.createWiki({ orgId: 'cascade-park', name: '政策库B', sourceDocumentIds: [upload1.id], sourceMode: 'files', createdBy: 'operator-1' })

  await documentStore.deleteDocument(upload1.id, 'cascade-park')

  const wikiA = await documentStore.getWiki(wiki.id, 'cascade-park')
  assert.deepEqual(wikiA?.sourceDocumentIds, [upload2.id])
  const wikiB = await documentStore.getWiki((await documentStore.listWikis('cascade-park')).find(item => item.name === '政策库B')!.id, 'cascade-park')
  assert.deepEqual(wikiB?.sourceDocumentIds, [])
  await connect.close()
  } finally { await rm(cascadeHome, { recursive: true, force: true }) }
})

void test('runtime admission serializes startup and recovery, preserves active slots and cleans failed binding', async () => {
  const driver = new SqliteDriver(new DatabaseSync(':memory:'));
  const store = new ParkStore(driver);
  await store.init();
  await store.putConfig('admission', { display_name: 'Admission', assistant_status: 'published', assistant_config: JSON.stringify({ assistant_id: 'agent' }), rate_config: JSON.stringify({ anonymous_session_max: 1 }) });
  const { parkSessionLifecycle } = await import('./sessionLifecycle.js');
  const lifecycle = parkSessionLifecycle(store);
  const channel = new FakeAgentChannel();
  const first = await store.createSession('admission', 'web', 86_400_000);
  const second = await store.createSession('admission', 'web', 86_400_000);
  try {
    const results = await Promise.allSettled([lifecycle.prepare(first, channel), lifecycle.prepare(second, channel)]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = results.find(result => result.status === 'rejected');
    assert.ok(rejected?.status === 'rejected');
    assert.equal(rejected.reason.message, 'SESSION_CAPACITY_REACHED');
    assert.equal(await channel.runningCount('admission'), 1);
    assert.equal(channel.created.length, 1);
    const prepared = await lifecycle.prepare(first, channel);
    prepared.dispose();
    channel.idleSessions.add(first.moss_session_id!);
    const next = await lifecycle.prepare(second, channel);
    next.dispose();
    await assert.rejects(lifecycle.prepare(first, channel), /SESSION_CAPACITY_REACHED/);
    channel.idleSessions.add(second.moss_session_id!);
    const restored = await lifecycle.prepare(first, channel);
    restored.dispose();
    assert.equal(channel.created.length, 2);
    await driver.run('UPDATE park_sessions SET last_active_at = ?', [Date.now() - 31 * 60_000]);
    const running = await new ConsultationTurns(store).begin('admission', first.id, randomUUID(), 'still running');
    assert.equal(await lifecycle.reclaim('admission', channel, Date.now()), 1);
    assert.ok(await lifecycle.usable('admission', first.id));
    await new ConsultationTurns(store).fail(running.turn, 'test');
    assert.equal(await lifecycle.reclaim('admission', channel, Date.now()), 1);
    const third = await store.createSession('admission', 'web', 86_400_000);
    const originalRun = driver.run.bind(driver);
    driver.run = async (sql, params) => {
      if (sql.startsWith('UPDATE park_sessions SET moss_session_id = ?')) throw new Error('controlled binding failure');
      return originalRun(sql, params);
    };
    await assert.rejects(lifecycle.prepare(third, channel), /controlled binding failure/);
    assert.equal(await channel.runningCount('admission'), 0);
    assert.equal((await store.session('admission', third.id))!.moss_session_id, null);
    driver.run = originalRun;
    const retry = await lifecycle.prepare(third, channel);
    retry.dispose();
    assert.equal(await channel.runningCount('admission'), 1);
  } finally { await driver.close(); }
});

void test('public initialization reuses cookie identity without changing attribution or budgets', async () => {
  const driver = new SqliteDriver(new DatabaseSync(':memory:'));
  const store = new ParkStore(driver);
  await store.init();
  await store.putConfig('reuse', { display_name: 'Reuse', assistant_status: 'published', assistant_config: JSON.stringify({ assistant_id: 'agent' }) });
  const channel = new FakeAgentChannel();
  const deps = { store, orgId: 'reuse', agentChannel: channel, readBody: async () => ({ source_channel: 'campaign' }) };
  const server = http.createServer((req, res) => {
    void handlePublicParkRoute(req, res, new URL(req.url!, 'http://localhost').pathname, deps).catch(error => writeJson(res, error instanceof HttpError ? error.statusCode : 500, { error: error.message }));
  });
  await new Promise<void>(resolve => server.listen(0, resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const first = await fetch(`${base}/public/consult/sessions`, { method: 'POST' });
    const cookie = first.headers.get('set-cookie')!.split(';')[0];
    const session = await first.json() as { session_id: string };
    await driver.run('UPDATE park_sessions SET message_count = 4, token_budget_used = 200 WHERE id = ?', [session.session_id]);
    const before = (await store.session('reuse', session.session_id))!;
    const next = await fetch(`${base}/public/consult/sessions`, { method: 'POST', headers: { cookie } });
    assert.equal((await next.json() as { session_id: string }).session_id, session.session_id);
    assert.deepEqual(await store.session('reuse', session.session_id), before);
    assert.equal(channel.created.length, 0);
    assert.equal((await fetch(`${base}/public/consult/session`, { headers: { cookie } })).status, 200);
    assert.equal((await fetch(`${base}/public/consult/session`)).status, 401);
    await driver.run('UPDATE park_sessions SET last_active_at = ? WHERE id = ?', [Date.now() - 31 * 60_000, session.session_id]);
    assert.equal((await fetch(`${base}/public/consult/session`, { headers: { cookie } })).status, 401);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await driver.close();
  }
});

void test('HTTP capacity refusal does not consume a turn and retries after runtime idle release', async () => {
  const driver = new SqliteDriver(new DatabaseSync(':memory:'));
  const store = new ParkStore(driver); await store.init();
  await store.putConfig('capacity-http', { display_name: 'Capacity', assistant_status: 'published', assistant_config: JSON.stringify({ assistant_id: 'agent' }), rate_config: JSON.stringify({ anonymous_session_max: 1 }) });
  const channel = new FakeAgentChannel(); channel.script = ['answer'];
  const deps = { store, orgId: 'capacity-http', agentChannel: channel, readBody: async (req: http.IncomingMessage) => { let raw = ''; for await (const chunk of req) raw += String(chunk); return raw ? JSON.parse(raw) as Record<string, unknown> : {}; } };
  const server = http.createServer((req, res) => { void handlePublicParkRoute(req, res, new URL(req.url!, 'http://localhost').pathname, deps).catch(error => writeJson(res, error instanceof HttpError ? error.statusCode : 500, { error: error.message })); });
  await new Promise<void>(resolve => server.listen(0, resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const create = async () => { const res = await fetch(`${base}/public/consult/sessions`, { method: 'POST' }); return { cookie: res.headers.get('set-cookie')!.split(';')[0], id: (await res.json() as { session_id: string }).session_id }; };
    const first = await create(); const second = await create();
    const ask = (visitor: { cookie: string; id: string }, requestId: string) => fetch(`${base}/public/sessions/${visitor.id}/messages`, { method: 'POST', headers: { cookie: visitor.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ message: 'question', client_request_id: requestId }) });
    const answer = await ask(first, randomUUID()); assert.match(await answer.text(), /event: done/);
    const requestId = randomUUID();
    const blocked = await ask(second, requestId);
    assert.equal(blocked.status, 503); assert.equal(blocked.headers.get('Retry-After'), '30');
    assert.equal((await blocked.json() as { error: string }).error, 'SESSION_CAPACITY_REACHED');
    assert.equal((await driver.get<{ count: number }>('SELECT COUNT(*) AS count FROM park_consultation_turns WHERE session_id = ?', [second.id]))!.count, 0);
    assert.ok(await store.session('capacity-http', second.id));
    channel.idleSessions.add((await store.session('capacity-http', first.id))!.moss_session_id!);
    const retried = await ask(second, requestId); assert.match(await retried.text(), /event: done/);
    assert.equal((await driver.get<{ count: number }>('SELECT COUNT(*) AS count FROM park_inquiries WHERE session_id = ?', [second.id]))!.count, 1);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await driver.close(); }
});

void test('prepared runtime uses one connection and cleans a failed startup even when no ID was returned', async () => {
  const { ParkRuntimeAgentChannel } = await import('./agentChannel.js');
  const { PassThrough } = await import('node:stream');
  const socket = new PassThrough();
  let ensures = 0; const retired: string[] = [];
  const runtime = {
    createSession: async () => { throw new Error('startup failed'); },
    listSessionRecords: async () => [{ sessionId: 'partial', source: 'park_public_consultation', channelChatId: 'visitor', status: 'failed' }, { sessionId: 'unrelated', source: 'wiki-build', channelChatId: 'visitor', status: 'active' }],
    terminateSession: async (id: string) => { retired.push(id); },
    ensureSessionReady: async () => { ensures++; return { attempt: {} }; },
    store: { getCurrentAttempt: async () => ({}) },
    connectToAttempt: async () => socket,
  } as unknown as import('../runtimeService.js').RuntimeService;
  const channel = new ParkRuntimeAgentChannel(runtime);
  await assert.rejects(channel.createSession({ orgId: 'park', assistantId: 'agent', anonymousSessionId: 'visitor' }), /startup failed/);
  assert.deepEqual(retired, ['partial']);
  const prepared = await channel.prepareTurn('runtime', false);
  const response = prepared.send('question', 'request', () => {});
  setImmediate(() => {
    socket.write(JSON.stringify({ type: 'text', text: 'answer' }) + '\n');
    socket.write(JSON.stringify({ type: 'result', session_id: 'runtime', request_id: 'request', status: 'success' }) + '\n');
  });
  assert.equal((await response).answer, 'answer');
  assert.equal(ensures, 0); prepared.dispose();
});

void test('expired bound sessions retry failed termination and abandoned preparation releases only its acquired runtime', async () => {
  const driver = new SqliteDriver(new DatabaseSync(':memory:')); const store = new ParkStore(driver); await store.init();
  await store.putConfig('cleanup', { display_name: 'Cleanup', assistant_status: 'published', assistant_config: JSON.stringify({ assistant_id: 'agent' }) });
  const { parkSessionLifecycle } = await import('./sessionLifecycle.js'); const lifecycle = parkSessionLifecycle(store); const channel = new FakeAgentChannel();
  try {
    const session = await store.createSession('cleanup', 'web', 86_400_000);
    const acquired = await lifecycle.prepare(session, channel);
    await acquired.abandon!();
    assert.equal(await channel.runningCount('cleanup'), 0);
    assert.equal((await store.session('cleanup', session.id))!.moss_session_id, null);
    const active = await lifecycle.prepare((await store.session('cleanup', session.id))!, channel); active.dispose();
    const reused = await lifecycle.prepare((await store.session('cleanup', session.id))!, channel); await reused.abandon!();
    assert.equal(await channel.runningCount('cleanup'), 1);
    await driver.run('UPDATE park_sessions SET expires_at = ? WHERE id = ?', [Date.now() - 1, session.id]);
    const terminate = channel.terminate.bind(channel); let fail = true;
    channel.terminate = async id => { if (fail) throw new Error('controlled termination failure'); await terminate(id); };
    await assert.rejects(lifecycle.reclaim('cleanup', channel, Date.now()), /controlled termination failure/);
    assert.equal(await channel.runningCount('cleanup'), 1);
    fail = false; await lifecycle.reclaim('cleanup', channel, Date.now());
    assert.equal(await channel.runningCount('cleanup'), 0);
    assert.ok((await store.session('cleanup', session.id))!.moss_session_id);
  } finally { await driver.close(); }
});
