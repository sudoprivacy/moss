import type http from "node:http";
import { HttpError } from "../httpRespond.js";
import type { AuthContext } from "../auth/token.js";
import type { DocumentStore } from "../documentStore.js";
import {
  findOrganizationResource,
  withOrganizationResources,
} from "../catalog/organizationResources.js";
import { searchParkPolicySources, type PolicyMatch } from './policySearch.js';
import { saveConsultationSources, type ConsultationSource } from './consultationSources.js';
import { appendAgentInquiry, isValidAgentIntent } from "./agentInquiry.js";
import type { LeadSignal } from "./rules.js";
import type { ParkStore } from "./store.js";

export interface ParkAgentRouteDeps {
  store: ParkStore;
  orgId: string | null;
  readBody: (req: http.IncomingMessage) => Promise<Record<string, unknown>>;
  documentStore: DocumentStore;
  vectorOptions: null | {
    enabled: boolean;
    modelId: string;
    cacheDir: string;
    mirror?: string;
    topKVector: number;
    maxMatches: number;
  };
}

export interface ParkAgentRouteResult {
  status: number;
  body: unknown;
}

interface SessionSearchRecord {
  count: number;
  refs: ConsultationSource[];
  at: number;
}

const SEARCH_RECORD_TTL_MS = 10 * 60 * 1000;
const sessionSearchRecords = new Map<string, SessionSearchRecord>();

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function stringArray(
  value: unknown,
  maxItems: number,
  maxLength: number,
): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (item): item is string =>
        typeof item === "string" && item.trim().length > 0,
    )
    .map((item) => item.trim().slice(0, maxLength))
    .slice(0, maxItems);
}

/** Latest server-recorded policy search outcome for an agent session (never trusts client reports). */
export function recordSessionSearch(
  agentSessionId: string,
  record: SessionSearchRecord,
): void {
  sessionSearchRecords.set(agentSessionId, record);
  if (sessionSearchRecords.size > 1000) {
    const now = Date.now();
    for (const [key, value] of sessionSearchRecords) {
      if (now - value.at > SEARCH_RECORD_TTL_MS)
        sessionSearchRecords.delete(key);
    }
  }
}

export function peekSessionSearch(
  agentSessionId: string,
): SessionSearchRecord | null {
  const record = sessionSearchRecords.get(agentSessionId);
  if (!record || Date.now() - record.at > SEARCH_RECORD_TTL_MS) return null;
  return record;
}

/** Consume the current turn's search record so it cannot leak into a later turn. */
export function takeSessionSearch(
  agentSessionId: string,
): SessionSearchRecord | null {
  const record = peekSessionSearch(agentSessionId);
  sessionSearchRecords.delete(agentSessionId);
  return record;
}

interface ParkAgentGrant {
  parkOrgId: string;
  assistantId: string;
  anonymousSessionId: string;
  agentSessionId: string;
}

/**
 * Anonymous-scope authorisation for the park agent tool endpoints: the caller
 * must present a session token whose assistant is this park's published public
 * assistant, and whose agent session maps to a live anonymous park session.
 * All context is derived server-side; org fields in request bodies are ignored.
 */
async function resolveParkAgentGrant(
  deps: ParkAgentRouteDeps,
  auth: AuthContext,
): Promise<ParkAgentGrant> {
  if (!deps.orgId) throw new HttpError(503, "Park box is not configured");
  const config = await deps.store.config(deps.orgId);
  if (!config || config.assistant_status !== "published")
    throw new HttpError(403, "park_agent_forbidden");
  const assistantConfig = JSON.parse(config.assistant_config || "{}") as {
    assistant_id?: unknown;
  };
  if (
    typeof assistantConfig.assistant_id !== "string" ||
    !assistantConfig.assistant_id
  )
    throw new HttpError(403, "park_agent_forbidden");
  if (auth.assistantId !== assistantConfig.assistant_id)
    throw new HttpError(403, "park_agent_forbidden");
  if (typeof auth.sessionId !== "string" || !auth.sessionId)
    throw new HttpError(403, "park_session_required");
  const session = await deps.store.db.get<{ id: string; expires_at: number }>(
    "SELECT id, expires_at FROM park_sessions WHERE org_id = ? AND moss_session_id = ?",
    [deps.orgId, auth.sessionId],
  );
  if (!session || Number(session.expires_at) <= Date.now())
    throw new HttpError(403, "park_session_required");
  return {
    parkOrgId: deps.orgId,
    assistantId: assistantConfig.assistant_id,
    anonymousSessionId: session.id,
    agentSessionId: auth.sessionId,
  };
}

async function resolveEnabledWikiIds(
  deps: ParkAgentRouteDeps,
  grant: ParkAgentGrant,
): Promise<string[]> {
  const meta = await withOrganizationResources(
    { orgId: grant.parkOrgId, userId: "park-agent", driver: deps.store.db },
    async () => {
      const resource = await findOrganizationResource(
        "agent",
        grant.assistantId,
      );
      const wikis = resource?.meta.enabledWikis;
      return Array.isArray(wikis)
        ? wikis.filter((id): id is string => typeof id === "string")
        : [];
    },
  );
  return meta;
}

export function leadSignalFromAgentInput(
  intent: string,
  industryTags: string[],
  policyHitCount: number,
  suggestedAction: string,
): LeadSignal {
  let score =
    intent === "settlement_intent" || intent === "subsidy_application"
      ? 50
      : intent === "rent_consultation" || intent === "policy_inquiry"
        ? 30
        : 20;
  const parts: string[] = [`智能体识别意图 ${intent}`];
  if (industryTags.length > 0) {
    score += 20;
    parts.push(`行业标签 ${industryTags.join("、")} +20`);
  }
  if (industryTags.length >= 2) {
    score += 10;
    parts.push("多行业标签 +10");
  }
  if (policyHitCount > 0) {
    score += 20;
    parts.push(`政策命中 ${policyHitCount} 条 +20`);
  }
  const bounded = Math.min(100, score);
  return {
    category: industryTags[0] ? `行业咨询（${industryTags[0]}）` : "园区咨询",
    intent: bounded >= 40 ? "入驻意向" : "一般咨询",
    industry: industryTags[0] ?? null,
    scale: null,
    urgency: null,
    concerns: industryTags,
    score: bounded,
    scoreExplanation: parts.join("；"),
    suggestedAction:
      suggestedAction || (bounded >= 40 ? "人工观察并按需联系" : "继续观察"),
  };
}

async function searchPolicyWikis(
  deps: ParkAgentRouteDeps,
  grant: ParkAgentGrant,
  query: string,
): Promise<{ matches: PolicyMatch[]; refs: ConsultationSource[] }> {
  const wikiIds = await resolveEnabledWikiIds(deps, grant);
  if (!wikiIds.length) throw new HttpError(503, 'Policy knowledge base is unavailable');
  const matches: PolicyMatch[] = [];
  const refs: ConsultationSource[] = [];
  for (const wikiId of wikiIds) {
    const wiki = await deps.documentStore.getWiki(wikiId, grant.parkOrgId);
    if (!wiki) throw new HttpError(503, 'Policy knowledge base is unavailable');
    matches.push(...await searchParkPolicySources(wiki.storagePath, wikiId, query, async (hits, bodies) => {
      refs.push(...await saveConsultationSources(deps.store.db, grant.parkOrgId, grant.anonymousSessionId, hits, bodies));
    }));
  }
  return { matches, refs };
}

/**
 * Dispatch the session-token-scoped park agent tool API. Returns false when the
 * pathname is not a park agent route; mounted inside the authenticated area,
 * after the agent wiki endpoints (same bearer model as /api/v1/agent/wikis/*).
 */
export async function dispatchParkAgentApi(
  deps: ParkAgentRouteDeps,
  auth: AuthContext,
  method: string,
  pathname: string,
  url: URL,
  req: http.IncomingMessage,
): Promise<ParkAgentRouteResult | false> {
  if (!pathname.startsWith("/api/v1/agent/park/")) return false;
  const grant = await resolveParkAgentGrant(deps, auth);

  if (method === "GET" && pathname === "/api/v1/agent/park/policies/search") {
    const query = (url.searchParams.get("q") ?? "").trim().slice(0, 500);
    if (!query) throw new HttpError(400, "q is required");
    const { matches, refs } = await searchPolicyWikis(deps, grant, query);
    recordSessionSearch(grant.agentSessionId, {
      count: matches.length,
      refs,
      at: Date.now(),
    });
    return {
      status: 200,
      body: {
        matches,
      },
    };
  }

  if (method === "POST" && pathname === "/api/v1/agent/park/inquiries") {
    const body = await deps.readBody(req);
    const question = text(body.question, 2000);
    const answer = text(body.answer, 4000);
    const intent = text(body.intent, 60);
    if (!question || !answer || !isValidAgentIntent(intent))
      throw new HttpError(
        400,
        "question, answer and a valid intent are required",
      );
    const search = peekSessionSearch(grant.agentSessionId);
    const config = await deps.store.config(grant.parkOrgId);
    const redaction = JSON.parse(config?.redaction_config || "{}") as {
      extra_terms?: string[];
      summary_max_length?: number;
    };
    const inquiryId = await appendAgentInquiry(deps.store, {
      orgId: grant.parkOrgId,
      sessionId: grant.anonymousSessionId,
      question,
      answer,
      intent,
      industryTags: stringArray(body.industry_tags, 20, 60),
      policyHitCount: search?.count ?? 0,
      sourceRefs: search?.refs ?? [],
      redactionConfig: redaction,
    });
    return { status: 201, body: { inquiry_id: inquiryId } };
  }

  if (method === "POST" && pathname === "/api/v1/agent/park/leads/propose") {
    const body = await deps.readBody(req);
    const intent = text(body.intent, 60) || "settlement_intent";
    if (!isValidAgentIntent(intent)) throw new HttpError(400, "Invalid intent");
    const industryTags = stringArray(body.industry_tags, 20, 60);
    const search = peekSessionSearch(grant.agentSessionId);
    const signal = leadSignalFromAgentInput(
      intent,
      industryTags,
      search?.count ?? 0,
      text(body.suggested_action, 200),
    );
    const inquiryId =
      typeof body.source_inquiry_id === "string"
        ? text(body.source_inquiry_id, 100)
        : null;
    await deps.store.saveLead(
      grant.parkOrgId,
      grant.anonymousSessionId,
      inquiryId,
      signal,
    );
    return { status: 201, body: { proposed: true, score: signal.score } };
  }

  if (method === "GET" && pathname === "/api/v1/agent/park/service-catalog") {
    const config = await deps.store.config(grant.parkOrgId);
    return {
      status: 200,
      body: {
        catalog: JSON.parse(config?.service_catalog || "[]"),
        version: config?.service_catalog_version ?? "1",
      },
    };
  }

  if (method === "GET" && pathname === "/api/v1/agent/park/profile") {
    const config = await deps.store.config(grant.parkOrgId);
    return { status: 200, body: { profile: config?.park_profile ?? "" } };
  }

  return false;
}
