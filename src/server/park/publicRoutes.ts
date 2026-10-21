import type http from "node:http";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { HttpError, writeJson } from "../httpRespond.js";
import { extractLeadSignal, redactInquiry } from "./rules.js";
import type { ParkSessionRow, ParkStore } from "./store.js";
import type { ParkPhoneVerification } from "./phoneVerification.js";
import type { ParkCaptcha } from "./captcha.js";
import type { ParkAgentChannel } from "./agentChannel.js";
import { takeSessionSearch } from "./parkAgentRoutes.js";
import { readConsultationPreview } from './consultationSources.js';
import { ManagedImageError, type ManagedImageStore } from '../configuration/managedImageStore.js'

const COOKIE_NAME = "park_session";
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const CONTACT_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
const hits = new Map<string, number[]>();
let activeMessages = 0;
/**
 * Idempotent replay window for client_request_id (the persisted inquiry rows
 * are now written by the agent skill, so the replay source is in-memory with
 * a bounded TTL, mirroring the rate-limit store's process-local nature).
 */
const replayCache = new Map<
  string,
  { answer: string; sourceRefs: unknown[]; at: number }
>();
const REPLAY_TTL_MS = 10 * 60 * 1000;

function replayKey(sessionId: string, requestId: string): string {
  return `${sessionId}:${requestId}`;
}

function takeReplay(
  sessionId: string,
  requestId: string,
): { answer: string; sourceRefs: unknown[] } | null {
  const entry = replayCache.get(replayKey(sessionId, requestId));
  if (!entry || Date.now() - entry.at > REPLAY_TTL_MS) return null;
  return { answer: entry.answer, sourceRefs: entry.sourceRefs };
}

function storeReplay(
  sessionId: string,
  requestId: string,
  answer: string,
  sourceRefs: unknown[],
): void {
  if (replayCache.size > 2000) {
    const now = Date.now();
    for (const [key, entry] of replayCache) {
      if (now - entry.at > REPLAY_TTL_MS) replayCache.delete(key);
    }
  }
  replayCache.set(replayKey(sessionId, requestId), {
    answer,
    sourceRefs,
    at: Date.now(),
  });
}

export interface PublicRouteDeps {
  managedImages?: ManagedImageStore
  store: ParkStore;
  orgId: string | null;
  readBody: (req: http.IncomingMessage) => Promise<Record<string, unknown>>;
  phoneVerification?: ParkPhoneVerification;
  captcha?: ParkCaptcha;
  agentChannel?: ParkAgentChannel;
  documentStore?: import("../documentStore.js").DocumentStore;
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function hasSessionCookie(
  req: http.IncomingMessage,
  sessionId: string,
): boolean {
  return (req.headers.cookie ?? "").split(";").some((part) => {
    const cookie = part.trim();
    if (!cookie.startsWith(`${COOKIE_NAME}=`)) return false;
    try {
      return (
        decodeURIComponent(cookie.slice(COOKIE_NAME.length + 1)) === sessionId
      );
    } catch {
      return false;
    }
  });
}

function secureRequest(req: http.IncomingMessage): boolean {
  return (
    Boolean((req.socket as { encrypted?: boolean }).encrypted) ||
    req.headers["x-forwarded-proto"] === "https"
  );
}

async function ownedSession(
  deps: PublicRouteDeps,
  req: http.IncomingMessage,
  id: string,
): Promise<ParkSessionRow> {
  if (!hasSessionCookie(req, id))
    throw new HttpError(401, "Session credential required");
  const session = await deps.store.session(deps.orgId!, id);
  if (!session || Number(session.expires_at) <= Date.now())
    throw new HttpError(401, "Session expired");
  return session;
}

function publicContext(
  config: NonNullable<Awaited<ReturnType<ParkStore["config"]>>>,
  policyVersion: string | null,
) {
  return {
    display_name: config.display_name,
    logo_url: config.logo_url,
    welcome_text: config.welcome_text,
    contact_enabled: Boolean(config.contact_enabled),
    published_policy_version: policyVersion,
  };
}

function startSse(res: http.ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-store",
    connection: "keep-alive",
    "x-content-type-options": "nosniff",
  });
}

function sendSse(
  res: http.ServerResponse,
  answer: string,
  sourceRefs: unknown[],
): void {
  startSse(res);
  for (const chunk of answer.match(/[\s\S]{1,48}/gu) ?? [answer]) {
    res.write(`event: delta\ndata: ${JSON.stringify({ text: chunk })}\n\n`);
  }
  res.write(`event: sources\ndata: ${JSON.stringify(sourceRefs)}\n\n`);
  res.write("event: done\ndata: {}\n\n");
  res.end();
}

export function parkIpIdentity(req: http.IncomingMessage): {
  ip: string;
  subnet: string;
} {
  const peerIp = req.socket.remoteAddress ?? "unknown";
  const forwardedIp = String(req.headers["x-park-client-ip"] ?? "");
  const forwardedTime = String(req.headers["x-park-client-time"] ?? "");
  const forwardedSignature = String(
    req.headers["x-park-client-signature"] ?? "",
  );
  const proxyKey = process.env.PARK_PUBLIC_PROXY_HMAC_KEY;
  let ip = peerIp;
  if (
    proxyKey &&
    isIP(forwardedIp) &&
    /^\d{13}$/.test(forwardedTime) &&
    /^[a-f0-9]{64}$/.test(forwardedSignature) &&
    Math.abs(Date.now() - Number(forwardedTime)) <= 60_000
  ) {
    const expected = createHmac("sha256", proxyKey)
      .update(`${forwardedIp}|${forwardedTime}`)
      .digest();
    const received = Buffer.from(forwardedSignature, "hex");
    if (timingSafeEqual(expected, received)) ip = forwardedIp;
  }
  ip = ip.replace(/^::ffff:/, "");
  if (ip.includes("."))
    return { ip, subnet: ip.split(".").slice(0, 3).join(".") };
  return { ip, subnet: ip.split(":").slice(0, 4).join(":") };
}

function exceedsWindow(
  key: string,
  maximum: number,
  now = Date.now(),
): boolean {
  if (hits.size > 10_000) {
    for (const [identity, times] of hits)
      if (times.every((time) => now - time >= 60_000)) hits.delete(identity);
  }
  const recent = (hits.get(key) ?? []).filter((time) => now - time < 60_000);
  recent.push(now);
  hits.set(key, recent);
  return recent.length > maximum;
}

async function reject(
  deps: PublicRouteDeps,
  res: http.ServerResponse,
  sessionId: string | null,
  reason: string,
  status: number,
  ipPrefix: string | null,
): Promise<never> {
  await deps.store.recordRejection(
    deps.orgId!,
    sessionId,
    reason,
    status,
    ipPrefix,
  );
  if (status === 429) res.setHeader("Retry-After", "60");
  throw new HttpError(status, reason);
}

export async function handlePublicParkRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  deps: PublicRouteDeps,
): Promise<boolean> {
  if (
    !pathname.startsWith("/public/consult/") &&
    !pathname.startsWith("/public/sessions/")
  )
    return false;
  res.setHeader("Cache-Control", "no-store");
  if (!deps.orgId) throw new HttpError(503, "Park box is not configured");
  const config = await deps.store.config(deps.orgId);
  if (!config)
    throw new HttpError(503, "Park public configuration is unavailable");

  const logo = /^\/public\/consult\/logo\/([^/]+)$/.exec(pathname)
  if (logo && req.method === 'GET') {
    if (config.logo_url !== pathname) throw new HttpError(404, 'Logo not found')
    if (!deps.managedImages) throw new HttpError(503, 'Image store is unavailable')
    try {
      const image = await deps.managedImages.read('park-logo', logo[1]!)
      res.writeHead(200, { 'Content-Type': image.mimeType, 'X-Content-Type-Options': 'nosniff', ...(image.mimeType === 'image/svg+xml' ? { 'Content-Security-Policy': 'sandbox' } : {}) })
      res.end(image.bytes)
      return true
    } catch (error) {
      if (error instanceof ManagedImageError) throw new HttpError(error.statusCode, error.message)
      throw error
    }
  }

  if (req.method === "GET" && pathname === "/public/consult/context") {
    let policyVersion: string | null = null;
    if (deps.documentStore) {
      const wikiId = (
        JSON.parse(config.assistant_config || "{}") as {
          policy_wiki_id?: unknown;
        }
      ).policy_wiki_id;
      if (typeof wikiId === "string" && wikiId) {
        const wiki = await deps.documentStore.getWiki(wikiId, deps.orgId);
        if (wiki?.buildStatus === "succeeded" && wiki.lastBuiltAt)
          policyVersion = `wiki-${new Date(Number(wiki.lastBuiltAt)).toISOString().slice(0, 10)}`;
      }
    }
    writeJson(res, 200, {
      ...publicContext(config, policyVersion),
      consent_text: config.consent_text ?? "",
    });
    return true;
  }
  if (req.method === "GET" && pathname === "/public/consult/quick-questions") {
    const rows = await deps.store.quickQuestions(deps.orgId, true);
    writeJson(
      res,
      200,
      rows.map((row) => ({
        id: row.id,
        question: row.question,
        sort_order: row.sort_order,
      })),
    );
    return true;
  }
  if (req.method === "POST" && pathname === "/public/consult/sessions") {
    const body = await deps.readBody(req);
    const requested = text(body.source_channel, 40);
    const configured = requested
      ? await deps.store.db.get<{ channel: string }>(
          "SELECT channel FROM park_public_links WHERE org_id = ? AND channel = ? AND enabled = 1",
          [deps.orgId, requested],
        )
      : null;
    const sourceChannel =
      configured?.channel ??
      (["qr", "web", "campaign", "other"].includes(requested)
        ? requested
        : "web");
    const rate = JSON.parse(config.rate_config || "{}") as Record<
      string,
      unknown
    >;
    const ip = parkIpIdentity(req);
    const blacklist = Array.isArray(rate.blacklist_ips)
      ? rate.blacklist_ips
      : [];
    if (blacklist.includes(ip.ip) || blacklist.includes(ip.subnet))
      await reject(deps, res, null, "blacklist", 429, ip.subnet);
    if (
      exceedsWindow(
        `session-box:${deps.orgId}`,
        Number(rate.box_per_minute) || 120,
      )
    )
      await reject(deps, res, null, "box_rate", 429, ip.subnet);
    if (exceedsWindow(`session-ip:${ip.ip}`, Number(rate.ip_per_minute) || 30))
      await reject(deps, res, null, "ip_rate", 429, ip.subnet);
    if (
      exceedsWindow(
        `session-subnet:${ip.subnet}`,
        Number(rate.subnet_per_minute) || 100,
      )
    )
      await reject(deps, res, null, "subnet_rate", 429, ip.subnet);
    if (deps.agentChannel) {
      const active = await deps.store.db.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM park_sessions WHERE org_id = ? AND expires_at > ?",
        [deps.orgId, Date.now()],
      );
      if (
        Number(active?.count ?? 0) >= (Number(rate.anonymous_session_max) || 16)
      ) {
        await deps.store.recordRejection(
          deps.orgId!,
          null,
          "session_capacity",
          503,
          ip.subnet,
        );
        throw new HttpError(503, "SESSION_CAPACITY_REACHED");
      }
    }
    let session: ParkSessionRow;
    if (deps.agentChannel) {
      if (config.assistant_status !== "published")
        throw new HttpError(503, "Public Assistant is not published");
      const assistantId = (
        JSON.parse(config.assistant_config || "{}") as {
          assistant_id?: unknown;
        }
      ).assistant_id;
      if (typeof assistantId !== "string" || !assistantId)
        throw new HttpError(
          503,
          "Public Assistant session binding is unavailable",
        );
      const anonymousSession = await deps.store.createSession(
        deps.orgId!,
        sourceChannel,
        SESSION_TTL_MS,
      );
      const mossSessionId = await deps.agentChannel.createSession({
        orgId: deps.orgId!,
        assistantId,
        anonymousSessionId: anonymousSession.id,
      });
      await deps.store.db.run(
        "UPDATE park_sessions SET moss_session_id = ? WHERE id = ?",
        [mossSessionId, anonymousSession.id],
      );
      session = (await deps.store.session(deps.orgId!, anonymousSession.id))!;
    } else
      session = await deps.store.createSession(
        deps.orgId!,
        sourceChannel,
        SESSION_TTL_MS,
      );
    res.setHeader(
      "Set-Cookie",
      `${COOKIE_NAME}=${session.id}; HttpOnly; SameSite=Lax; Path=/public; Max-Age=86400${secureRequest(req) ? "; Secure" : ""}`,
    );
    writeJson(res, 201, {
      session_id: session.id,
      expires_at: session.expires_at,
    });
    return true;
  }

  const statusRoute = /^\/public\/sessions\/([^/]+)\/status$/.exec(pathname);
  if (statusRoute && req.method === "GET" && deps.agentChannel) {
    const session = await ownedSession(deps, req, statusRoute[1]!);
    const rate = JSON.parse(config.rate_config || "{}") as Record<
      string,
      unknown
    >;
    const idleMs = (Number(rate.anonymous_session_idle_minutes) || 30) * 60_000;
    writeJson(res, 200, {
      closing_at: Number(session.last_active_at) + idleMs,
      closed: false,
    });
    return true;
  }
  const captchaRoute =
    /^\/public\/sessions\/([^/]+)\/challenge(?:\/(verify))?$/.exec(pathname);
  if (captchaRoute) {
    const session = await ownedSession(deps, req, captchaRoute[1]!);
    if (!deps.captcha) throw new HttpError(503, "CAPTCHA is not configured");
    if (req.method === "GET" && !captchaRoute[2]) {
      const isContactRetry = new URL(req.url ?? "/", "http://localhost").searchParams.get("purpose") === "contact";
      if (isContactRetry) {
        const rate = JSON.parse(config.rate_config || "{}") as Record<string, unknown>;
        const ip = parkIpIdentity(req);
        if (exceedsWindow(`contact-challenge:${ip.ip}`, Number(rate.ip_per_minute) || 30)) {
          res.setHeader("Retry-After", "60");
          throw new HttpError(429, "RATE_LIMITED");
        }
      }
      // Any live session may proactively request a challenge (R8: required
      // before SMS); the risk_state gate only applied to abuse-triggered ones.
      writeJson(res, 200, { image: await deps.captcha.issue(session.id, Date.now(), isContactRetry) });
      return true;
    }
    if (req.method === "POST" && captchaRoute[2] === "verify") {
      const body = await deps.readBody(req);
      if (
        !(await deps.captcha.verify(
          session.id,
          text(body.answer, 5).toUpperCase(),
        ))
      )
        throw new HttpError(400, "Invalid challenge answer");
      await deps.store.db.run(
        "UPDATE park_sessions SET risk_state = ? WHERE id = ?",
        ["normal", session.id],
      );
      writeJson(res, 200, { verified: true });
      return true;
    }
  }
  const codeRoute = /^\/public\/sessions\/([^/]+)\/contact-code$/.exec(
    pathname,
  );
  if (codeRoute && req.method === "POST") {
    const session = await ownedSession(deps, req, codeRoute[1]!);
    if (!config.contact_enabled) throw new HttpError(403, "CONTACT_DISABLED");
    if (!deps.phoneVerification) throw new HttpError(503, "SMS_UNAVAILABLE");
    if (!(await deps.captcha?.isPassed(session.id)))
      throw new HttpError(409, "CAPTCHA_REQUIRED");
    const body = await deps.readBody(req);
    const phone = text(body.phone, 30);
    const rate = JSON.parse(config.rate_config || "{}") as Record<
      string,
      unknown
    >;
    const ip = parkIpIdentity(req);
    if (
      exceedsWindow(`sms-ip:${ip.ip}`, Number(rate.sms_ip_per_minute) || 10) ||
      exceedsWindow(
        `sms-box:${deps.orgId}`,
        Number(rate.sms_box_per_minute) || 100,
      )
    ) {
      await deps.store.recordRejection(
        deps.orgId,
        session.id,
        "sms_rate",
        429,
        ip.subnet,
      );
      res.setHeader("Retry-After", "60");
      throw new HttpError(429, "RATE_LIMITED");
    }
    await deps.phoneVerification.send(session.id, phone);
    writeJson(res, 200, { sent: true, expires_in: 300 });
    return true;
  }
  const preview = /^\/public\/sessions\/([^/]+)\/sources\/([^/]+)\/preview$/.exec(pathname);
  if (preview && req.method === 'GET') {
    const session = await ownedSession(deps, req, preview[1]!);
    writeJson(res, 200, await readConsultationPreview(deps.store.db, deps.orgId, session.id, preview[2]!));
    return true;
  }
  const match = /^\/public\/sessions\/([^/]+)\/(messages|contact)$/.exec(
    pathname,
  );
  if (!match) return false;
  const session = await ownedSession(deps, req, match[1]!);
  if (req.method === "GET" && match[2] === "messages") {
    const rows = await deps.store.db.all(
      "SELECT id, redacted_question, redacted_answer, source_refs_json, created_at FROM park_inquiries WHERE org_id = ? AND session_id = ? ORDER BY created_at",
      [deps.orgId, session.id],
    );
    writeJson(
      res,
      200,
      rows.map((row) => ({
        ...row,
        source_refs: JSON.parse(String(row.source_refs_json)),
        source_refs_json: undefined,
      })),
    );
    return true;
  }
  if (req.method === "POST" && match[2] === "messages") {
    const body = await deps.readBody(req);
    const question =
      typeof body.message === "string" ? body.message.trim() : "";
    const requestId = text(body.client_request_id, 100);
    if (!question || !/^[0-9a-f-]{36}$/i.test(requestId))
      throw new HttpError(400, "Message and client_request_id are required");
    const existing =
      takeReplay(session.id, requestId) ??
      (await deps.store
        .inquiryByRequest(session.id, requestId)
        .then((row) =>
          row
            ? {
                answer: String(row.redacted_answer),
                sourceRefs: JSON.parse(String(row.source_refs_json)),
              }
            : null,
        ));
    if (existing) {
      sendSse(res, existing.answer, existing.sourceRefs);
      return true;
    }
    const rate = JSON.parse(config.rate_config || "{}") as Record<
      string,
      unknown
    >;
    if (
      session.risk_state === "challenge_required" &&
      !(await deps.captcha?.isPassed(session.id))
    ) {
      await deps.store.recordRejection(
        deps.orgId,
        session.id,
        "challenge_required",
        429,
        parkIpIdentity(req).subnet,
      );
      res.setHeader("Retry-After", "1");
      throw new HttpError(429, "CAPTCHA_REQUIRED");
    }
    const maxLength = Number(rate.message_max_length) || 2000;
    const ip = parkIpIdentity(req);
    const blacklist = Array.isArray(rate.blacklist_ips)
      ? rate.blacklist_ips
      : [];
    if (blacklist.includes(ip.ip) || blacklist.includes(ip.subnet))
      await reject(deps, res, session.id, "blacklist", 429, ip.subnet);
    if (question.length > maxLength)
      await reject(deps, res, session.id, "message_too_long", 413, ip.subnet);
    if (
      Number(session.message_count) >= (Number(rate.session_message_max) || 50)
    )
      await reject(
        deps,
        res,
        session.id,
        "session_message_limit",
        429,
        ip.subnet,
      );
    if (
      Number(session.token_budget_used) + question.length >
      (Number(rate.session_token_budget) || 20_000)
    )
      await reject(
        deps,
        res,
        session.id,
        "session_token_budget",
        429,
        ip.subnet,
      );
    if (exceedsWindow(`box:${deps.orgId}`, Number(rate.box_per_minute) || 120))
      await reject(deps, res, session.id, "box_rate", 429, ip.subnet);
    const isPassed = (await deps.captcha?.isPassed(session.id)) ?? false;
    const isAutomation =
      rate.automated_traffic_detection !== false &&
      !isPassed &&
      /(?:python-requests|scrapy|ahrefsbot|semrushbot)/i.test(
        String(req.headers["user-agent"] ?? ""),
      );
    const isIpLimited =
      !isPassed &&
      exceedsWindow(`ip:${ip.ip}`, Number(rate.ip_per_minute) || 30);
    const isSubnetLimited =
      !isPassed &&
      exceedsWindow(
        `subnet:${ip.subnet}`,
        Number(rate.subnet_per_minute) || 100,
      );
    if (isAutomation || isIpLimited || isSubnetLimited) {
      const reason = isAutomation
        ? "automated_traffic"
        : isIpLimited
          ? "ip_rate"
          : "subnet_rate";
      if (rate.captcha_enabled === true && deps.captcha) {
        await deps.store.db.run(
          "UPDATE park_sessions SET risk_state = ? WHERE id = ?",
          ["challenge_required", session.id],
        );
        await deps.store.recordRejection(
          deps.orgId,
          session.id,
          reason,
          429,
          ip.subnet,
        );
        res.setHeader("Retry-After", "1");
        throw new HttpError(429, "CAPTCHA_REQUIRED");
      }
      await reject(deps, res, session.id, reason, 429, ip.subnet);
    }
    if (activeMessages >= (Number(rate.concurrent_max) || 8))
      await reject(deps, res, session.id, "concurrent_limit", 429, ip.subnet);
    activeMessages++;
    try {
      if (!deps.agentChannel || !session.moss_session_id)
        throw new HttpError(503, "Public Assistant is unavailable");
      if (!(await deps.agentChannel.isAlive(session.moss_session_id))) {
        await deps.store.db.run(
          "UPDATE park_sessions SET expires_at = ? WHERE id = ?",
          [Date.now(), session.id],
        );
        throw new HttpError(401, "Session expired");
      }
      let isStreaming = false;
      const result = await deps.agentChannel.sendAndStream(
        session.moss_session_id,
        question,
        requestId,
        (value) => {
          if (!isStreaming) {
            startSse(res);
            isStreaming = true;
          }
          res.write(
            `event: delta\ndata: ${JSON.stringify({ text: value })}\n\n`,
          );
        },
      );
      const search = takeSessionSearch(session.moss_session_id);
      const sourceRefs = search?.refs ?? [];
      storeReplay(session.id, requestId, result.answer, sourceRefs);
      await deps.store.db.run(
        "UPDATE park_sessions SET last_active_at = ?, message_count = message_count + 1, token_budget_used = token_budget_used + ? WHERE id = ?",
        [Date.now(), question.length, session.id],
      );
      if (isStreaming) {
        res.write(`event: sources\ndata: ${JSON.stringify(sourceRefs)}\n\n`);
        res.write("event: done\ndata: {}\n\n");
        res.end();
      } else sendSse(res, result.answer, sourceRefs);
    } catch (error) {
      if (!res.headersSent) throw error;
      res.write(
        'event: error\ndata: {"error":"Public Assistant response failed"}\n\n',
      );
      res.end();
    } finally {
      activeMessages--;
    }
    return true;
  }
  if (req.method === "POST" && match[2] === "contact") {
    if (!config.contact_enabled) throw new HttpError(403, "CONTACT_DISABLED");
    const body = await deps.readBody(req);
    if (body.consent !== true) throw new HttpError(400, "CONSENT_REQUIRED");
    const phone = text(body.phone, 30) || null;
    const email = text(body.email, 150) || null;
    if (!phone && !email) throw new HttpError(400, "CONTACT_EMPTY");
    if (phone && !/^1[3-9]\d{9}$/.test(phone))
      throw new HttpError(400, "PHONE_INVALID");
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      throw new HttpError(400, "EMAIL_INVALID");
    // R7: the SMS code is verified as part of this submission — no separate
    // verify round-trip. A previously verified phone (older submission retry)
    // still counts.
    let phoneVerifiedAt = phone
      ? ((await deps.phoneVerification?.verifiedAt(session.id, phone)) ?? null)
      : null;
    if (phone && !phoneVerifiedAt) {
      const smsCode = text(body.sms_code, 8);
      if (!smsCode) throw new HttpError(409, "PHONE_CODE_REQUIRED");
      if (
        !deps.phoneVerification ||
        !(await deps.phoneVerification.verify(session.id, phone, smsCode))
      )
        throw new HttpError(409, "PHONE_CODE_INVALID");
      phoneVerifiedAt = await deps.phoneVerification.verifiedAt(
        session.id,
        phone,
      );
    }
    let lead = await deps.store.leadBySession(deps.orgId, session.id);
    if (!lead) {
      const inquiry = await deps.store.db.get<{ id: string }>(
        "SELECT id FROM park_inquiries WHERE org_id = ? AND session_id = ? ORDER BY created_at DESC LIMIT 1",
        [deps.orgId, session.id],
      );
      // R12: consultation is encouraged but not required — a direct-contact
      // submission creates a low-score lead without an inquiry reference.
      lead = await deps.store.saveLead(
        deps.orgId,
        session.id,
        inquiry?.id ?? null,
        inquiry
          ? extractLeadSignal("联系园区 入驻咨询")
          : {
              ...extractLeadSignal("联系园区"),
              concerns: ["直接联系"],
              score: 20,
              scoreExplanation: "直接联系 +20",
              suggestedAction: "继续观察",
            },
      );
    }
    await deps.store.saveContact(deps.orgId, lead.id, {
      name: text(body.name, 80) || null,
      companyName: text(body.company_name, 150) || null,
      phone,
      email,
      consentText:
        config.consent_text?.trim() ||
        "同意园区基于咨询对接目的保存联系方式与同意时间，并按约定期限处理。",
      retentionUntil: Date.now() + CONTACT_RETENTION_MS,
      phoneVerifiedAt,
    });
    if (phone)
      await deps.store.db.run(
        "DELETE FROM park_phone_codes WHERE session_id = ?",
        [session.id],
      );
    writeJson(res, 201, { submitted: true });
    return true;
  }
  return false;
}

/**
 * Reclaim idle anonymous sessions (R13): terminate the backing agent session
 * and expire the park session row. Exported so tests and the server timer can
 * both drive it with an explicit clock.
 */
export async function processExpiredParkSessions(
  deps: PublicRouteDeps,
  now = Date.now(),
): Promise<number> {
  if (!deps.agentChannel || !deps.orgId) return 0;
  const rate = JSON.parse(
    (await deps.store.config(deps.orgId))?.rate_config || "{}",
  ) as Record<string, unknown>;
  const idleMs = (Number(rate.anonymous_session_idle_minutes) || 30) * 60_000;
  const rows = await deps.store.db.all<{
    id: string;
    moss_session_id: string | null;
    last_active_at: number;
  }>(
    "SELECT id, moss_session_id, last_active_at FROM park_sessions WHERE org_id = ? AND expires_at > ? AND moss_session_id IS NOT NULL",
    [deps.orgId, now],
  );
  let reclaimed = 0;
  for (const row of rows) {
    if (now - Number(row.last_active_at) < idleMs) continue;
    try {
      await deps.agentChannel.terminate(row.moss_session_id!);
    } catch {
      // A missing agent session still must not keep the park session alive.
    }
    await deps.store.db.run(
      "UPDATE park_sessions SET expires_at = ? WHERE id = ?",
      [now, row.id],
    );
    reclaimed += 1;
  }
  return reclaimed;
}
