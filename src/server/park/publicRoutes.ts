import type http from 'node:http'
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { isIP } from 'node:net'
import { HttpError, writeJson } from '../httpRespond.js'
import { extractLeadSignal, redactInquiry } from './rules.js'
import type { ParkPolicyRow, ParkSessionRow, ParkStore } from './store.js'
import type { ParkPhoneVerification } from './phoneVerification.js'
import type { ParkCaptcha } from './captcha.js'
import { groundedParkAnswer, type ParkAnswer } from './answer.js'

const COOKIE_NAME = 'park_session'
const SESSION_TTL_MS = 24 * 60 * 60 * 1000
const CONTACT_RETENTION_MS = 180 * 24 * 60 * 60 * 1000
const hits = new Map<string, number[]>()
let activeMessages = 0

export interface PublicRouteDeps {
  store: ParkStore
  orgId: string | null
  readBody: (req: http.IncomingMessage) => Promise<Record<string, unknown>>
  phoneVerification?: ParkPhoneVerification
  captcha?: ParkCaptcha
  answerer?: (orgId: string, question: string, config: NonNullable<Awaited<ReturnType<ParkStore['config']>>>, policies: ParkPolicyRow[]) => Promise<ParkAnswer>
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function sessionCookie(req: http.IncomingMessage): string | null {
  const pair = (req.headers.cookie ?? '').split(';').map(part => part.trim()).find(part => part.startsWith(`${COOKIE_NAME}=`))
  return pair ? decodeURIComponent(pair.slice(COOKIE_NAME.length + 1)) : null
}

function secureRequest(req: http.IncomingMessage): boolean {
  return Boolean((req.socket as { encrypted?: boolean }).encrypted) || req.headers['x-forwarded-proto'] === 'https'
}

async function ownedSession(deps: PublicRouteDeps, req: http.IncomingMessage, id: string): Promise<ParkSessionRow> {
  if (sessionCookie(req) !== id) throw new HttpError(401, 'Session credential required')
  const session = await deps.store.session(deps.orgId!, id)
  if (!session || Number(session.expires_at) <= Date.now()) throw new HttpError(401, 'Session expired')
  return session
}

function publicContext(config: NonNullable<Awaited<ReturnType<ParkStore['config']>>>, policyVersion: string | null) {
  return {
    display_name: config.display_name,
    logo_url: config.logo_url,
    welcome_text: config.welcome_text,
    contact_enabled: Boolean(config.contact_enabled),
    published_policy_version: policyVersion,
  }
}

function sendSse(res: http.ServerResponse, answer: string, sourceRefs: unknown[]): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-store',
    connection: 'keep-alive',
    'x-content-type-options': 'nosniff',
  })
  for (const chunk of answer.match(/.{1,48}/gu) ?? [answer]) {
    res.write(`event: delta\ndata: ${JSON.stringify({ text: chunk })}\n\n`)
  }
  res.write(`event: sources\ndata: ${JSON.stringify(sourceRefs)}\n\n`)
  res.write('event: done\ndata: {}\n\n')
  res.end()
}

export function parkIpIdentity(req: http.IncomingMessage): { ip: string; subnet: string } {
  const peerIp = req.socket.remoteAddress ?? 'unknown'
  const forwardedIp = String(req.headers['x-park-client-ip'] ?? '')
  const forwardedTime = String(req.headers['x-park-client-time'] ?? '')
  const forwardedSignature = String(req.headers['x-park-client-signature'] ?? '')
  const proxyKey = process.env.PARK_PUBLIC_PROXY_HMAC_KEY
  let ip = peerIp
  if (proxyKey && isIP(forwardedIp) && /^\d{13}$/.test(forwardedTime) && /^[a-f0-9]{64}$/.test(forwardedSignature)
    && Math.abs(Date.now() - Number(forwardedTime)) <= 60_000) {
    const expected = createHmac('sha256', proxyKey).update(`${forwardedIp}|${forwardedTime}`).digest()
    const received = Buffer.from(forwardedSignature, 'hex')
    if (timingSafeEqual(expected, received)) ip = forwardedIp
  }
  ip = ip.replace(/^::ffff:/, '')
  if (ip.includes('.')) return { ip, subnet: ip.split('.').slice(0, 3).join('.') }
  return { ip, subnet: ip.split(':').slice(0, 4).join(':') }
}

function exceedsWindow(key: string, maximum: number, now = Date.now()): boolean {
  if (hits.size > 10_000) {
    for (const [identity, times] of hits) if (times.every(time => now - time >= 60_000)) hits.delete(identity)
  }
  const recent = (hits.get(key) ?? []).filter(time => now - time < 60_000)
  recent.push(now)
  hits.set(key, recent)
  return recent.length > maximum
}

async function reject(deps: PublicRouteDeps, res: http.ServerResponse, sessionId: string | null, reason: string, status: number, ipPrefix: string | null): Promise<never> {
  await deps.store.recordRejection(deps.orgId!, sessionId, reason, status, ipPrefix)
  if (status === 429) res.setHeader('Retry-After', '60')
  throw new HttpError(status, reason)
}

export async function handlePublicParkRoute(req: http.IncomingMessage, res: http.ServerResponse, pathname: string, deps: PublicRouteDeps): Promise<boolean> {
  if (!pathname.startsWith('/public/consult/') && !pathname.startsWith('/public/sessions/')) return false
  res.setHeader('Cache-Control', 'no-store')
  if (!deps.orgId) throw new HttpError(503, 'Park box is not configured')
  const config = await deps.store.config(deps.orgId)
  if (!config) throw new HttpError(503, 'Park public configuration is unavailable')

  if (req.method === 'GET' && pathname === '/public/consult/context') {
    const policies = await deps.store.publicPolicies(deps.orgId)
    writeJson(res, 200, publicContext(config, policies[0]?.version ?? null))
    return true
  }
  if (req.method === 'GET' && pathname === '/public/consult/quick-questions') {
    const rows = await deps.store.quickQuestions(deps.orgId, true)
    writeJson(res, 200, rows.map(row => ({ id: row.id, question: row.question, sort_order: row.sort_order })))
    return true
  }
  if (req.method === 'POST' && pathname === '/public/consult/sessions') {
    const body = await deps.readBody(req)
    const requested = text(body.source_channel, 40)
    const configured = requested ? await deps.store.db.get<{ channel: string }>('SELECT channel FROM park_public_links WHERE org_id = ? AND channel = ? AND enabled = 1', [deps.orgId, requested]) : null
    const sourceChannel = configured?.channel ?? (['qr', 'web', 'campaign', 'other'].includes(requested) ? requested : 'web')
    const rate = JSON.parse(config.rate_config || '{}') as Record<string, unknown>
    const ip = parkIpIdentity(req)
    const blacklist = Array.isArray(rate.blacklist_ips) ? rate.blacklist_ips : []
    if (blacklist.includes(ip.ip) || blacklist.includes(ip.subnet)) await reject(deps, res, null, 'blacklist', 429, ip.subnet)
    if (exceedsWindow(`session-box:${deps.orgId}`, Number(rate.box_per_minute) || 120)) await reject(deps, res, null, 'box_rate', 429, ip.subnet)
    if (exceedsWindow(`session-ip:${ip.ip}`, Number(rate.ip_per_minute) || 30)) await reject(deps, res, null, 'ip_rate', 429, ip.subnet)
    if (exceedsWindow(`session-subnet:${ip.subnet}`, Number(rate.subnet_per_minute) || 100)) await reject(deps, res, null, 'subnet_rate', 429, ip.subnet)
    const session = await deps.store.createSession(deps.orgId, sourceChannel, SESSION_TTL_MS)
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=${session.id}; HttpOnly; SameSite=Lax; Path=/public; Max-Age=86400${secureRequest(req) ? '; Secure' : ''}`)
    writeJson(res, 201, { session_id: session.id, expires_at: session.expires_at })
    return true
  }

  const captchaRoute = /^\/public\/sessions\/([^/]+)\/challenge(?:\/(verify))?$/.exec(pathname)
  if (captchaRoute) {
    const session = await ownedSession(deps, req, captchaRoute[1]!)
    if (!deps.captcha) throw new HttpError(503, 'CAPTCHA is not configured')
    if (req.method === 'GET' && !captchaRoute[2]) {
      if (session.risk_state !== 'challenge_required') throw new HttpError(403, 'Challenge is not required')
      writeJson(res, 200, { image: await deps.captcha.issue(session.id) })
      return true
    }
    if (req.method === 'POST' && captchaRoute[2] === 'verify') {
      const body = await deps.readBody(req)
      if (!(await deps.captcha.verify(session.id, text(body.answer, 5).toUpperCase()))) throw new HttpError(400, 'Invalid challenge answer')
      await deps.store.db.run('UPDATE park_sessions SET risk_state = ? WHERE id = ?', ['normal', session.id])
      writeJson(res, 200, { verified: true })
      return true
    }
  }
  const codeRoute = /^\/public\/sessions\/([^/]+)\/contact-code(?:\/(verify))?$/.exec(pathname)
  if (codeRoute && req.method === 'POST') {
    const session = await ownedSession(deps, req, codeRoute[1]!)
    if (!config.contact_enabled) throw new HttpError(403, 'Contact is disabled')
    if (!deps.phoneVerification) throw new HttpError(503, 'SMS verification is not configured')
    const body = await deps.readBody(req)
    const phone = text(body.phone, 30)
    if (codeRoute[2] === 'verify') {
      const verified = await deps.phoneVerification.verify(session.id, phone, text(body.code, 8))
      if (!verified) throw new HttpError(400, 'Invalid or expired verification code')
      writeJson(res, 200, { verified: true })
    } else {
      const ip = parkIpIdentity(req)
      if (exceedsWindow(`sms-ip:${ip.ip}`, 10) || exceedsWindow(`sms-box:${deps.orgId}`, 100)) await reject(deps, res, session.id, 'sms_rate', 429, ip.subnet)
      await deps.phoneVerification.send(session.id, phone)
      writeJson(res, 200, { sent: true, expires_in: 300 })
    }
    return true
  }
  const match = /^\/public\/sessions\/([^/]+)\/(messages|contact)$/.exec(pathname)
  if (!match) return false
  const session = await ownedSession(deps, req, match[1]!)
  if (req.method === 'GET' && match[2] === 'messages') {
    const rows = await deps.store.db.all('SELECT id, redacted_question, redacted_answer, source_refs_json, created_at FROM park_inquiries WHERE org_id = ? AND session_id = ? ORDER BY created_at', [deps.orgId, session.id])
    writeJson(res, 200, rows.map(row => ({ ...row, source_refs: JSON.parse(String(row.source_refs_json)), source_refs_json: undefined })))
    return true
  }
  if (req.method === 'POST' && match[2] === 'messages') {
    const body = await deps.readBody(req)
    const question = typeof body.message === 'string' ? body.message.trim() : ''
    const requestId = text(body.client_request_id, 100)
    if (!question || !/^[0-9a-f-]{36}$/i.test(requestId)) throw new HttpError(400, 'Message and client_request_id are required')
    const existing = await deps.store.inquiryByRequest(session.id, requestId)
    if (existing) { sendSse(res, String(existing.redacted_answer), JSON.parse(String(existing.source_refs_json))); return true }
    const rate = JSON.parse(config.rate_config || '{}') as Record<string, unknown>
    if (session.risk_state === 'challenge_required' && !(await deps.captcha?.isPassed(session.id))) {
      await deps.store.recordRejection(deps.orgId, session.id, 'challenge_required', 429, parkIpIdentity(req).subnet)
      res.setHeader('Retry-After', '1')
      throw new HttpError(429, 'CAPTCHA_REQUIRED')
    }
    const maxLength = Number(rate.message_max_length) || 2000
    const ip = parkIpIdentity(req)
    const blacklist = Array.isArray(rate.blacklist_ips) ? rate.blacklist_ips : []
    if (blacklist.includes(ip.ip) || blacklist.includes(ip.subnet)) await reject(deps, res, session.id, 'blacklist', 429, ip.subnet)
    if (question.length > maxLength) await reject(deps, res, session.id, 'message_too_long', 413, ip.subnet)
    if (Number(session.message_count) >= (Number(rate.session_message_max) || 50)) await reject(deps, res, session.id, 'session_message_limit', 429, ip.subnet)
    if (Number(session.token_budget_used) + question.length > (Number(rate.session_token_budget) || 20_000)) await reject(deps, res, session.id, 'session_token_budget', 429, ip.subnet)
    if (exceedsWindow(`box:${deps.orgId}`, Number(rate.box_per_minute) || 120)) await reject(deps, res, session.id, 'box_rate', 429, ip.subnet)
    const isPassed = await deps.captcha?.isPassed(session.id) ?? false
    const isAutomation = rate.automated_traffic_detection !== false && !isPassed && /(?:python-requests|scrapy|ahrefsbot|semrushbot)/i.test(String(req.headers['user-agent'] ?? ''))
    const isIpLimited = !isPassed && exceedsWindow(`ip:${ip.ip}`, Number(rate.ip_per_minute) || 30)
    const isSubnetLimited = !isPassed && exceedsWindow(`subnet:${ip.subnet}`, Number(rate.subnet_per_minute) || 100)
    if (isAutomation || isIpLimited || isSubnetLimited) {
      const reason = isAutomation ? 'automated_traffic' : isIpLimited ? 'ip_rate' : 'subnet_rate'
      if (rate.captcha_enabled === true && deps.captcha) {
        await deps.store.db.run('UPDATE park_sessions SET risk_state = ? WHERE id = ?', ['challenge_required', session.id])
        await deps.store.recordRejection(deps.orgId, session.id, reason, 429, ip.subnet)
        res.setHeader('Retry-After', '1')
        throw new HttpError(429, 'CAPTCHA_REQUIRED')
      }
      await reject(deps, res, session.id, reason, 429, ip.subnet)
    }
    if (activeMessages >= (Number(rate.concurrent_max) || 8)) await reject(deps, res, session.id, 'concurrent_limit', 429, ip.subnet)
    activeMessages++
    try {
      const policies = await deps.store.publicPolicies(deps.orgId)
      const result = deps.answerer
        ? await deps.answerer(deps.orgId, question, config, policies)
        : groundedParkAnswer(question, config, policies)
      const redactionConfig = JSON.parse(config.redaction_config || '{}') as { extra_terms?: string[]; summary_max_length?: number }
      const signal = extractLeadSignal(question)
      await deps.store.recordInquiry({ orgId: deps.orgId, sessionId: session.id, requestId,
        question: redactInquiry(question, redactionConfig), answer: redactInquiry(result.answer, redactionConfig), signal, sourceRefs: result.sourceRefs })
      await deps.store.db.run('UPDATE park_sessions SET last_active_at = ?, message_count = message_count + 1, token_budget_used = token_budget_used + ? WHERE id = ?', [Date.now(), question.length, session.id])
      sendSse(res, result.answer, result.sourceRefs)
      if (signal.score >= 40) void deps.store.processLeadJobs().catch(() => {})
    } finally { activeMessages-- }
    return true
  }
  if (req.method === 'POST' && match[2] === 'contact') {
    if (!config.contact_enabled) throw new HttpError(403, 'Contact is disabled')
    const body = await deps.readBody(req)
    if (body.consent !== true) throw new HttpError(400, 'Consent is required')
    const phone = text(body.phone, 30) || null
    const email = text(body.email, 150) || null
    if (!phone && !email) throw new HttpError(400, 'Phone or email is required')
    if (phone && !/^1[3-9]\d{9}$/.test(phone)) throw new HttpError(400, 'Invalid phone')
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Invalid email')
    const phoneVerifiedAt = phone ? await deps.phoneVerification?.verifiedAt(session.id, phone) ?? null : null
    if (phone && !phoneVerifiedAt) throw new HttpError(409, 'Phone verification is required')
    let lead = await deps.store.leadBySession(deps.orgId, session.id)
    if (!lead) {
      const signal = extractLeadSignal('联系园区 入驻咨询')
      const inquiry = await deps.store.db.get<{ id: string }>('SELECT id FROM park_inquiries WHERE org_id = ? AND session_id = ? ORDER BY created_at DESC LIMIT 1', [deps.orgId, session.id])
      if (!inquiry) throw new HttpError(409, 'Ask a question before submitting contact')
      lead = await deps.store.saveLead(deps.orgId, session.id, inquiry.id, signal)
    }
    await deps.store.saveContact(deps.orgId, lead.id, {
      name: text(body.name, 80) || null, companyName: text(body.company_name, 150) || null,
      phone, email, consentText: '同意园区基于咨询对接目的保存联系方式与同意时间，并按约定期限处理。',
      retentionUntil: Date.now() + CONTACT_RETENTION_MS, phoneVerifiedAt,
    })
    if (phone) await deps.store.db.run('DELETE FROM park_phone_codes WHERE session_id = ?', [session.id])
    writeJson(res, 201, { submitted: true })
    return true
  }
  return false
}
