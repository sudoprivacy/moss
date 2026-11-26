import { randomUUID } from 'crypto'
import type { DatabaseSync } from 'node:sqlite'
import type {
  CabinConversation,
  CabinAlert,
  CabinHealthReport,
  CabinHealthReportStatus,
  CabinHealthMetricKey,
  CabinHealthMetricResult,
  CabinHealthReportSummary,
  CabinManagedSeat,
  CabinMessage,
  CabinMessageRole,
  CabinMessageSource,
  CabinOrderCancellationCandidate,
  CabinPendingOrderCancellation,
  CabinPassengerContext,
  CabinToolCall,
} from './types.js'
import { buildConversationKey } from './auth.js'
import { digest, languageCode, textLanguage, type Language } from './language.js'
import { exactCommand } from './commandLanguage.js'
import { comfortActions, type ComfortAction } from './comfortLanguage.js'
import type { ComfortOffer } from './comfortConfirmation.js'

type Row = Record<string, unknown>

function now(): number {
  return Date.now()
}

function mapConversation(row: Row): CabinConversation {
  return {
    id: String(row.id),
    conversationKey: String(row.conversation_key),
    passengerId: row.passenger_id == null ? null : String(row.passenger_id),
    passengerRef: row.passenger_ref == null ? null : String(row.passenger_ref),
    passengerName: row.passenger_name == null ? null : String(row.passenger_name),
    flightId: String(row.flight_id),
    flightDate: String(row.flight_date),
    seatId: row.seat_id == null ? null : String(row.seat_id),
    tabletId: String(row.tablet_id),
    mossSessionId: String(row.moss_session_id),
    status: String(row.status) === 'reset' ? 'reset' : 'active',
    summary: row.summary == null ? null : String(row.summary),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

function mapManagedSeat(row: Row): CabinManagedSeat {
  return {
    id: String(row.id),
    aircraftNo: row.aircraft_no == null ? null : String(row.aircraft_no),
    flightId: String(row.flight_id),
    flightDate: String(row.flight_date),
    seatNo: String(row.seat_no),
    columnNo: row.column_no == null ? null : String(row.column_no),
    flightSeatId: row.flight_seat_id == null ? null : String(row.flight_seat_id),
    aircraftSeatId: row.aircraft_seat_id == null ? null : String(row.aircraft_seat_id),
    tabletId: row.tablet_id == null ? null : String(row.tablet_id),
    tabletType: row.tablet_type == null ? null : String(row.tablet_type),
    status: String(row.status) === 'inactive' ? 'inactive' : 'active',
    lastSeenAt: Number(row.last_seen_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

function mapAlert(row: Row): CabinAlert {
  return {
    id: String(row.id),
    aircraftNo: row.aircraft_no == null ? null : String(row.aircraft_no),
    flightId: String(row.flight_id),
    flightDate: row.flight_date == null ? null : String(row.flight_date),
    phaseCode: row.phase_code == null ? null : Number(row.phase_code),
    phaseName: String(row.phase_name),
    seatNo: row.seat_no == null ? null : String(row.seat_no),
    alertType: String(row.alert_type),
    severity: ['info', 'critical'].includes(String(row.severity))
      ? String(row.severity) as CabinAlert['severity']
      : 'warning',
    message: String(row.message),
    status: String(row.status) === 'resolved' ? 'resolved' : 'active',
    sourceEventId: row.source_event_id == null ? null : String(row.source_event_id),
    details: parseObjectJson(row.details_json),
    createdAt: Number(row.created_at),
    resolvedAt: row.resolved_at == null ? null : Number(row.resolved_at),
  }
}

function mapHealthReport(row: Row): CabinHealthReport {
  return {
    id: String(row.id),
    aircraftNo: row.aircraft_no == null ? null : String(row.aircraft_no),
    flightId: String(row.flight_id),
    flightDate: String(row.flight_date),
    seatNo: String(row.seat_no),
    tabletId: row.tablet_id == null ? null : String(row.tablet_id),
    passengerId: row.passenger_id == null ? null : String(row.passenger_id),
    passengerRef: row.passenger_ref == null ? null : String(row.passenger_ref),
    status: String(row.status) as CabinHealthReportStatus,
    language: row.language == null ? null : String(row.language),
    sampleCount: Number(row.sample_count ?? 0),
    samples: parseArrayJson(row.samples_json),
    metrics: parseObjectJson(row.metrics_json) as Record<CabinHealthMetricKey, CabinHealthMetricResult> | null,
    summary: parseHealthReportSummary(row.summary_json),
    errorCode: row.error_code == null ? null : String(row.error_code),
    errorMessage: row.error_message == null ? null : String(row.error_message),
    cancelledAt: row.cancelled_at == null ? null : Number(row.cancelled_at),
    startedAt: Number(row.started_at),
    collectUntil: Number(row.collect_until),
    generatedAt: row.generated_at == null ? null : Number(row.generated_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

function parseObjectJson(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function parseArrayJson(value: unknown): Record<string, unknown>[] | null {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed)) return null
    return parsed.filter(item => item && typeof item === 'object' && !Array.isArray(item)) as Record<string, unknown>[]
  } catch {
    return null
  }
}

function parseHealthReportSummary(value: unknown): CabinHealthReportSummary | null {
  return parseObjectJson(value) as CabinHealthReportSummary | null
}

function parseToolCallsJson(value: unknown): CabinToolCall[] | null {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed)) return null
    const toolCalls = parsed.filter(item => (
      item &&
      typeof item === 'object' &&
      typeof (item as { id?: unknown }).id === 'string' &&
      typeof (item as { name?: unknown }).name === 'string' &&
      (item as { arguments?: unknown }).arguments &&
      typeof (item as { arguments?: unknown }).arguments === 'object' &&
      !Array.isArray((item as { arguments?: unknown }).arguments)
    )) as CabinToolCall[]
    return toolCalls.length ? toolCalls : null
  } catch {
    return null
  }
}

function mapMessage(row: Row): CabinMessage {
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    role: String(row.role) as CabinMessageRole,
    source: String(row.source) as CabinMessageSource,
    content: String(row.content),
    intent: row.intent == null ? null : String(row.intent),
    slots: parseObjectJson(row.slots_json),
    toolCalls: parseToolCallsJson(row.tool_calls_json),
    createdAt: Number(row.created_at),
  }
}

export function ensureCabinTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cabin_language_hints (
      scope TEXT NOT NULL, text_key TEXT NOT NULL, language TEXT NOT NULL, prompted INTEGER NOT NULL, expires INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS cabin_hint_lookup ON cabin_language_hints(scope, text_key, expires);
    CREATE INDEX IF NOT EXISTS cabin_hint_expiry ON cabin_language_hints(expires);
    CREATE TABLE IF NOT EXISTS cabin_recent_language (scope TEXT PRIMARY KEY, language TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS cabin_recent_expiry ON cabin_recent_language(expires);
    CREATE TABLE IF NOT EXISTS cabin_comfort_offers (scope TEXT PRIMARY KEY, action TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS cabin_lighting_turn (scope TEXT PRIMARY KEY, state TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS cabin_chat_receipts (scope TEXT NOT NULL, client_id TEXT NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY(scope, client_id));
    CREATE INDEX IF NOT EXISTS cabin_offer_expiry ON cabin_comfort_offers(expires);
    CREATE TABLE IF NOT EXISTS cabin_order_language_prompts (scope TEXT PRIMARY KEY, signature TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS cabin_order_prompt_expiry ON cabin_order_language_prompts(expires);
    CREATE TABLE IF NOT EXISTS cabin_conversations (
      id TEXT PRIMARY KEY,
      conversation_key TEXT NOT NULL UNIQUE,
      passenger_id TEXT,
      passenger_ref TEXT,
      passenger_name TEXT,
      flight_id TEXT NOT NULL,
      flight_date TEXT NOT NULL,
      seat_id TEXT,
      tablet_id TEXT NOT NULL,
      moss_session_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      summary TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_cabin_conversations_passenger
      ON cabin_conversations(passenger_id, passenger_ref);

    CREATE INDEX IF NOT EXISTS idx_cabin_conversations_flight
      ON cabin_conversations(flight_id, flight_date);

    CREATE TABLE IF NOT EXISTS cabin_messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES cabin_conversations(id),
      role TEXT NOT NULL,
      source TEXT NOT NULL,
      content TEXT NOT NULL,
      intent TEXT,
      slots_json TEXT,
      tool_calls_json TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_cabin_messages_conversation_created
      ON cabin_messages(conversation_id, created_at);

    CREATE TABLE IF NOT EXISTS cabin_order_cancellation_confirmations (
      conversation_id TEXT PRIMARY KEY REFERENCES cabin_conversations(id),
      candidates_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cabin_voice_logs (
      id TEXT PRIMARY KEY,
      conversation_id TEXT,
      message_id TEXT,
      type TEXT NOT NULL,
      text TEXT,
      status TEXT NOT NULL,
      error_message TEXT,
      elapsed_ms INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cabin_managed_seats (
      id TEXT PRIMARY KEY,
      aircraft_no TEXT,
      flight_id TEXT NOT NULL,
      flight_date TEXT NOT NULL,
      seat_no TEXT NOT NULL,
      column_no TEXT,
      flight_seat_id TEXT,
      aircraft_seat_id TEXT,
      tablet_id TEXT,
      tablet_type TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      last_seen_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(flight_id, flight_date, seat_no)
    );

    CREATE INDEX IF NOT EXISTS idx_cabin_managed_seats_flight
      ON cabin_managed_seats(flight_id, flight_date, status);

    CREATE INDEX IF NOT EXISTS idx_cabin_managed_seats_aircraft
      ON cabin_managed_seats(aircraft_no, status);

    CREATE TABLE IF NOT EXISTS cabin_alerts (
      id TEXT PRIMARY KEY,
      aircraft_no TEXT,
      flight_id TEXT NOT NULL,
      flight_date TEXT,
      phase_code INTEGER,
      phase_name TEXT NOT NULL,
      seat_no TEXT,
      alert_type TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'warning',
      message TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      source_event_id TEXT,
      details_json TEXT,
      created_at INTEGER NOT NULL,
      resolved_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_cabin_alerts_flight_created
      ON cabin_alerts(flight_id, flight_date, created_at);

    CREATE TABLE IF NOT EXISTS cabin_health_reports (
      id TEXT PRIMARY KEY,
      aircraft_no TEXT,
      flight_id TEXT NOT NULL,
      flight_date TEXT NOT NULL,
      seat_no TEXT NOT NULL,
      tablet_id TEXT,
      passenger_id TEXT,
      passenger_ref TEXT,
      status TEXT NOT NULL,
      language TEXT,
      sample_count INTEGER NOT NULL DEFAULT 0,
      samples_json TEXT,
      metrics_json TEXT,
      summary_json TEXT,
      error_code TEXT,
      error_message TEXT,
      cancelled_at INTEGER,
      started_at INTEGER NOT NULL,
      collect_until INTEGER NOT NULL,
      generated_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_cabin_health_reports_seat_status
      ON cabin_health_reports(flight_id, flight_date, seat_no, status);

    CREATE INDEX IF NOT EXISTS idx_cabin_health_reports_created
      ON cabin_health_reports(created_at);
  `)
  const messageColumns = db.prepare('PRAGMA table_info(cabin_messages)').all() as Row[]
  const conversationColumns = db.prepare('PRAGMA table_info(cabin_conversations)').all() as Row[]
  if (!conversationColumns.some(column => column.name === 'language_epoch')) db.exec('ALTER TABLE cabin_conversations ADD COLUMN language_epoch INTEGER NOT NULL DEFAULT 0')
  if (!messageColumns.some(column => column.name === 'tool_calls_json')) {
    db.exec('ALTER TABLE cabin_messages ADD COLUMN tool_calls_json TEXT')
  }
}

export class CabinStore {
  constructor(private readonly db: DatabaseSync) {
    ensureCabinTables(db)
  }

  recordLanguage(scope: string, text: string, language: string, prompted: boolean, time = Date.now()): void {
    this.db.prepare('DELETE FROM cabin_language_hints WHERE expires <= ?').run(time)
    this.db.prepare('INSERT INTO cabin_language_hints VALUES (?, ?, ?, ?, ?)').run(scope, digest(text), language, Number(prompted), time + 120_000)
  }

  languageEpoch(conversation: string): number {
    const row = this.db.prepare('SELECT language_epoch FROM cabin_conversations WHERE id = ?').get(conversation) as Row
    return Number(row.language_epoch)
  }

  recordComfortOffer(scope: string, action: ComfortAction, time = Date.now()): void {
    this.db.prepare('DELETE FROM cabin_comfort_offers WHERE expires <= ?').run(time)
    // Keep the existing three-column table compatible with rollback images.
    // Old versions safely ignore structured offers instead of replaying them.
    this.db.prepare('INSERT OR REPLACE INTO cabin_comfort_offers (scope, action, expires) VALUES (?, ?, ?)')
      .run(scope, JSON.stringify({ id: randomUUID(), action }), time + 120_000)
  }

  claimClientTurn(scope: string, clientId: string) {
    const now = Date.now()
    this.db.prepare('DELETE FROM cabin_chat_receipts WHERE expires <= ?').run(now)
    return this.db.prepare('INSERT OR IGNORE INTO cabin_chat_receipts VALUES (?, ?, ?)').run(scope, clientId, now + 300_000).changes === 1
  }

  takeLightingTurn(scope: string) {
    const row = this.db.prepare('DELETE FROM cabin_lighting_turn WHERE scope = ? RETURNING state, expires').get(scope) as Row | undefined
    if (row && Number(row.expires) > Date.now()) return JSON.parse(String(row.state)) as { pending?: import('./seatLighting.js').LightSettings }
  }

  rememberLightingTurn(scope: string, pending?: import('./seatLighting.js').LightSettings) {
    this.db.prepare('DELETE FROM cabin_lighting_turn WHERE expires <= ?').run(Date.now())
    this.db.prepare('INSERT OR REPLACE INTO cabin_lighting_turn VALUES (?, ?, ?)').run(scope, JSON.stringify({pending}), Date.now()+120000)
  }

  getComfortOffer(scope: string, time = Date.now()): ComfortOffer | undefined {
    const row = this.db.prepare('SELECT action, expires FROM cabin_comfort_offers WHERE scope = ? AND expires > ?').get(scope, time) as Row | undefined
    if (!row) return undefined
    try {
      const offer = JSON.parse(String(row.action))
      return offer && typeof offer.id === 'string' && offer.id && Object.hasOwn(comfortActions, offer.action)
        ? { id: offer.id, action: offer.action as ComfortAction, expires: Number(row.expires) } : undefined
    } catch { return undefined }
  }

  consumeComfortOffer(scope: string, offer: ComfortOffer, time = Date.now()): boolean {
    return !!this.db.prepare('DELETE FROM cabin_comfort_offers WHERE scope = ? AND action = ? AND expires > ? RETURNING scope')
      .get(scope, JSON.stringify({ id: offer.id, action: offer.action }), time)
  }

  takeComfortOffer(scope: string, time = Date.now()): ComfortAction | undefined {
    const offer = this.getComfortOffer(scope, time)
    return offer && this.consumeComfortOffer(scope, offer, time) ? offer.action : undefined
  }

  rememberOrderChoices(scope: string, candidates: CabinOrderCancellationCandidate[], time = Date.now()): void {
    this.db.prepare('DELETE FROM cabin_order_language_prompts WHERE expires <= ?').run(time)
    this.db.prepare('INSERT OR REPLACE INTO cabin_order_language_prompts VALUES (?, ?, ?)').run(scope, digest(JSON.stringify(candidates.map(item => item.orderId))), time + 120_000)
  }

  takeOrderChoices(scope: string, candidates: CabinOrderCancellationCandidate[], time = Date.now()): boolean {
    const row = this.db.prepare('DELETE FROM cabin_order_language_prompts WHERE scope = ? RETURNING signature, expires').get(scope) as Row | undefined
    return !!row && Number(row.expires) > time && row.signature === digest(JSON.stringify(candidates.map(item => item.orderId)))
  }

  resolveLanguage(scope: string, text: string, hint?: string, profile?: string, time = Date.now()): Language {
    const rows = this.db.prepare('DELETE FROM cabin_language_hints WHERE scope = ? AND text_key = ? AND expires > ? RETURNING language, prompted').all(scope, digest(text), time) as Row[]
    const matched = rows.length === 1 ? rows[0] : undefined
    const detected = languageCode(matched?.language)
    const explicit = (matched && !matched.prompted ? detected : undefined) ?? exactCommand(text)?.language ?? textLanguage(text)
    this.db.prepare('DELETE FROM cabin_recent_language WHERE expires <= ?').run(time)
    if (explicit) {
      this.db.prepare('INSERT OR REPLACE INTO cabin_recent_language VALUES (?, ?, ?)').run(scope, explicit, time + 600_000)
      return explicit
    }
    const recent = this.db.prepare('SELECT language FROM cabin_recent_language WHERE scope = ?').get(scope) as Row | undefined
    return languageCode(hint) ?? detected ?? languageCode(recent?.language) ?? languageCode(profile) ?? 'zh'
  }

  getConversationByKey(conversationKey: string, options: { includeReset?: boolean } = {}): CabinConversation | null {
    const row = options.includeReset
      ? this.db.prepare('SELECT * FROM cabin_conversations WHERE conversation_key = ?').get(conversationKey) as Row | undefined
      : this.db.prepare('SELECT * FROM cabin_conversations WHERE conversation_key = ? AND status = ?').get(conversationKey, 'active') as Row | undefined
    return row ? mapConversation(row) : null
  }

  setPendingOrderCancellation(
    conversationId: string,
    candidates: CabinOrderCancellationCandidate[],
    ttlMs = 5 * 60_000,
  ): void {
    const timestamp = now()
    this.db.prepare(`
      INSERT INTO cabin_order_cancellation_confirmations (
        conversation_id, candidates_json, created_at, expires_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(conversation_id) DO UPDATE SET
        candidates_json = excluded.candidates_json,
        created_at = excluded.created_at,
        expires_at = excluded.expires_at
    `).run(
      conversationId,
      JSON.stringify(candidates),
      timestamp,
      timestamp + ttlMs,
    )
  }

  getPendingOrderCancellation(conversationId: string): CabinPendingOrderCancellation | null {
    const row = this.db.prepare(`
      SELECT candidates_json, created_at, expires_at
      FROM cabin_order_cancellation_confirmations
      WHERE conversation_id = ?
    `).get(conversationId) as Row | undefined
    if (!row) return null
    const expiresAt = Number(row.expires_at)
    if (!Number.isFinite(expiresAt) || expiresAt <= now()) {
      this.clearPendingOrderCancellation(conversationId)
      return null
    }
    let candidates: unknown
    try {
      candidates = JSON.parse(String(row.candidates_json))
    } catch {
      this.clearPendingOrderCancellation(conversationId)
      return null
    }
    if (!Array.isArray(candidates)) {
      this.clearPendingOrderCancellation(conversationId)
      return null
    }
    return {
      candidates: candidates.filter(candidate => (
        candidate &&
        typeof candidate === 'object' &&
        typeof (candidate as { orderId?: unknown }).orderId === 'string'
      )) as CabinOrderCancellationCandidate[],
      createdAt: Number(row.created_at),
      expiresAt,
    }
  }

  clearPendingOrderCancellation(conversationId: string): void {
    this.db.prepare(`
      DELETE FROM cabin_order_cancellation_confirmations WHERE conversation_id = ?
    `).run(conversationId)
  }

  createConversation(input: CabinPassengerContext & { mossSessionId: string }): CabinConversation {
    const timestamp = now()
    const conversationKey = buildConversationKey(input)
    const id = randomUUID()
    const existing = this.getConversationByKey(conversationKey, { includeReset: true })
    if (existing) {
      this.db.prepare(`
        UPDATE cabin_conversations
        SET passenger_id = ?, passenger_ref = ?, passenger_name = ?,
            flight_id = ?, flight_date = ?, seat_id = ?, tablet_id = ?,
            moss_session_id = ?, status = 'active', updated_at = ?
        WHERE id = ?
      `).run(
        input.passengerId ?? null,
        input.passengerRef ?? null,
        input.passengerName ?? null,
        input.flightId,
        input.flightDate,
        input.seatId ?? null,
        input.tabletId,
        input.mossSessionId,
        timestamp,
        existing.id,
      )
    } else {
      this.db.prepare(`
        INSERT INTO cabin_conversations (
          id, conversation_key, passenger_id, passenger_ref, passenger_name,
          flight_id, flight_date, seat_id, tablet_id, moss_session_id,
          status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
      `).run(
        id,
        conversationKey,
        input.passengerId ?? null,
        input.passengerRef ?? null,
        input.passengerName ?? null,
        input.flightId,
        input.flightDate,
        input.seatId ?? null,
        input.tabletId,
        input.mossSessionId,
        timestamp,
        timestamp,
      )
    }
    const created = this.getConversationByKey(conversationKey)
    if (!created) throw new Error('Failed to create cabin conversation')
    this.upsertManagedSeatFromContext(input)
    return created
  }

  upsertManagedSeatFromContext(input: CabinPassengerContext): CabinManagedSeat | null {
    if (!input.flightId || !input.flightDate || !input.seatId) return null
    return this.upsertManagedSeat({
      aircraftNo: input.aircraftNo,
      flightId: input.flightId,
      flightDate: input.flightDate,
      seatNo: input.seatId,
      columnNo: input.columnNo,
      flightSeatId: input.flightSeatId,
      aircraftSeatId: input.aircraftSeatId,
      tabletId: input.tabletId,
      tabletType: input.tabletType,
    })
  }

  upsertManagedSeat(input: {
    aircraftNo?: string | null
    flightId: string
    flightDate: string
    seatNo: string
    columnNo?: string | null
    flightSeatId?: string | null
    aircraftSeatId?: string | null
    tabletId?: string | null
    tabletType?: string | null
  }): CabinManagedSeat {
    const timestamp = now()
    const existing = this.db.prepare(`
      SELECT * FROM cabin_managed_seats
      WHERE flight_id = ? AND flight_date = ? AND seat_no = ?
    `).get(input.flightId, input.flightDate, input.seatNo) as Row | undefined
    if (existing) {
      this.db.prepare(`
        UPDATE cabin_managed_seats
        SET aircraft_no = COALESCE(?, aircraft_no),
            column_no = COALESCE(?, column_no),
            flight_seat_id = COALESCE(?, flight_seat_id),
            aircraft_seat_id = COALESCE(?, aircraft_seat_id),
            tablet_id = COALESCE(?, tablet_id),
            tablet_type = COALESCE(?, tablet_type),
            status = 'active',
            last_seen_at = ?,
            updated_at = ?
        WHERE id = ?
      `).run(
        input.aircraftNo ?? null,
        input.columnNo ?? null,
        input.flightSeatId ?? null,
        input.aircraftSeatId ?? null,
        input.tabletId ?? null,
        input.tabletType ?? null,
        timestamp,
        timestamp,
        String(existing.id),
      )
      const row = this.db.prepare('SELECT * FROM cabin_managed_seats WHERE id = ?').get(String(existing.id)) as Row | undefined
      if (!row) throw new Error('Failed to update cabin managed seat')
      return mapManagedSeat(row)
    }
    const id = randomUUID()
    this.db.prepare(`
      INSERT INTO cabin_managed_seats (
        id, aircraft_no, flight_id, flight_date, seat_no, column_no,
        flight_seat_id, aircraft_seat_id, tablet_id, tablet_type,
        status, last_seen_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
    `).run(
      id,
      input.aircraftNo ?? null,
      input.flightId,
      input.flightDate,
      input.seatNo,
      input.columnNo ?? null,
      input.flightSeatId ?? null,
      input.aircraftSeatId ?? null,
      input.tabletId ?? null,
      input.tabletType ?? null,
      timestamp,
      timestamp,
      timestamp,
    )
    const row = this.db.prepare('SELECT * FROM cabin_managed_seats WHERE id = ?').get(id) as Row | undefined
    if (!row) throw new Error('Failed to create cabin managed seat')
    return mapManagedSeat(row)
  }

  listManagedSeats(input: {
    aircraftNo?: string
    flightId?: string
    flightDate?: string
    activeOnly?: boolean
  } = {}): CabinManagedSeat[] {
    const clauses: string[] = []
    const params: unknown[] = []
    if (input.aircraftNo) {
      clauses.push('(aircraft_no = ? OR aircraft_no IS NULL)')
      params.push(input.aircraftNo)
    }
    if (input.flightId) {
      clauses.push('flight_id = ?')
      params.push(input.flightId)
    }
    if (input.flightDate) {
      clauses.push('flight_date = ?')
      params.push(input.flightDate)
    }
    if (input.activeOnly !== false) {
      clauses.push('status = ?')
      params.push('active')
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = this.db.prepare(`
      SELECT * FROM cabin_managed_seats
      ${where}
      ORDER BY seat_no ASC
    `).all(...params) as Row[]
    return rows.map(mapManagedSeat)
  }

  createAlert(input: {
    aircraftNo?: string | null
    flightId: string
    flightDate?: string | null
    phaseCode?: number | null
    phaseName: string
    seatNo?: string | null
    alertType: string
    severity?: CabinAlert['severity']
    message: string
    sourceEventId?: string | null
    details?: Record<string, unknown> | null
  }): CabinAlert {
    const id = randomUUID()
    const timestamp = now()
    this.db.prepare(`
      INSERT INTO cabin_alerts (
        id, aircraft_no, flight_id, flight_date, phase_code, phase_name,
        seat_no, alert_type, severity, message, status, source_event_id,
        details_json, created_at, resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, NULL)
    `).run(
      id,
      input.aircraftNo ?? null,
      input.flightId,
      input.flightDate ?? null,
      input.phaseCode ?? null,
      input.phaseName,
      input.seatNo ?? null,
      input.alertType,
      input.severity ?? 'warning',
      input.message,
      input.sourceEventId ?? null,
      input.details ? JSON.stringify(input.details) : null,
      timestamp,
    )
    const row = this.db.prepare('SELECT * FROM cabin_alerts WHERE id = ?').get(id) as Row | undefined
    if (!row) throw new Error('Failed to create cabin alert')
    return mapAlert(row)
  }

  listAlerts(input: {
    flightId?: string
    flightDate?: string
    seatNo?: string
    status?: 'active' | 'resolved'
    limit?: number
    offset?: number
  } = {}): { alerts: CabinAlert[]; total: number } {
    const clauses: string[] = []
    const params: unknown[] = []
    if (input.flightId) {
      clauses.push('flight_id LIKE ?')
      params.push(`%${input.flightId}%`)
    }
    if (input.flightDate) {
      clauses.push('flight_date = ?')
      params.push(input.flightDate)
    }
    if (input.seatNo) {
      clauses.push('seat_no = ?')
      params.push(input.seatNo)
    }
    if (input.status) {
      clauses.push('status = ?')
      params.push(input.status)
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const totalRow = this.db.prepare(`SELECT COUNT(*) AS total FROM cabin_alerts ${where}`)
      .get(...params) as Row | undefined
    const limit = Math.max(1, Math.min(input.limit ?? 50, 200))
    const offset = Math.max(0, input.offset ?? 0)
    const rows = this.db.prepare(`
      SELECT * FROM cabin_alerts
      ${where}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as Row[]
    return {
      alerts: rows.map(mapAlert),
      total: Number(totalRow?.total ?? 0),
    }
  }

  createHealthReport(input: {
    aircraftNo?: string | null
    flightId: string
    flightDate: string
    seatNo: string
    tabletId?: string | null
    passengerId?: string | null
    passengerRef?: string | null
    language?: string | null
    startedAt: number
    collectUntil: number
  }): CabinHealthReport {
    const id = `hr_${randomUUID().replace(/-/g, '').slice(0, 16)}`
    const timestamp = now()
    this.db.prepare(`
      INSERT INTO cabin_health_reports (
        id, aircraft_no, flight_id, flight_date, seat_no, tablet_id,
        passenger_id, passenger_ref, status, language, sample_count,
        samples_json, metrics_json, summary_json, error_code, error_message,
        cancelled_at, started_at, collect_until, generated_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'collecting', ?, 0, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL, ?, ?)
    `).run(
      id,
      input.aircraftNo ?? null,
      input.flightId,
      input.flightDate,
      input.seatNo,
      input.tabletId ?? null,
      input.passengerId ?? null,
      input.passengerRef ?? null,
      input.language ?? null,
      input.startedAt,
      input.collectUntil,
      timestamp,
      timestamp,
    )
    const report = this.getHealthReport(id)
    if (!report) throw new Error('Failed to create cabin health report')
    return report
  }

  getHealthReport(reportId: string): CabinHealthReport | null {
    const row = this.db.prepare('SELECT * FROM cabin_health_reports WHERE id = ?').get(reportId) as Row | undefined
    return row ? mapHealthReport(row) : null
  }

  cancelUnfinishedHealthReports(input: {
    flightId: string
    flightDate: string
    seatNo: string
    newReportId?: string
  }): CabinHealthReport[] {
    const rows = this.db.prepare(`
      SELECT * FROM cabin_health_reports
      WHERE flight_id = ? AND flight_date = ? AND seat_no = ?
        AND status IN ('collecting', 'generating')
      ORDER BY created_at ASC
    `).all(input.flightId, input.flightDate, input.seatNo) as Row[]
    if (!rows.length) return []
    const timestamp = now()
    const cancelled = rows.map(mapHealthReport)
    this.db.prepare(`
      UPDATE cabin_health_reports
      SET status = 'cancelled',
          error_code = 'SUPERSEDED_BY_NEW_REPORT',
          error_message = '已开始新的检测，本次检测已取消。',
          cancelled_at = ?,
          updated_at = ?
      WHERE flight_id = ? AND flight_date = ? AND seat_no = ?
        AND status IN ('collecting', 'generating')
    `).run(timestamp, timestamp, input.flightId, input.flightDate, input.seatNo)
    return cancelled
  }

  updateHealthReportSamples(reportId: string, samples: Record<string, unknown>[]): CabinHealthReport | null {
    this.db.prepare(`
      UPDATE cabin_health_reports
      SET sample_count = ?, samples_json = ?, updated_at = ?
      WHERE id = ? AND status = 'collecting'
    `).run(samples.length, samples.length ? JSON.stringify(samples) : null, now(), reportId)
    return this.getHealthReport(reportId)
  }

  markHealthReportGenerating(reportId: string): CabinHealthReport | null {
    this.db.prepare(`
      UPDATE cabin_health_reports
      SET status = 'generating', updated_at = ?
      WHERE id = ? AND status = 'collecting'
    `).run(now(), reportId)
    return this.getHealthReport(reportId)
  }

  completeHealthReport(input: {
    reportId: string
    metrics: Record<CabinHealthMetricKey, CabinHealthMetricResult>
    summary: CabinHealthReportSummary
  }): CabinHealthReport | null {
    const timestamp = now()
    this.db.prepare(`
      UPDATE cabin_health_reports
      SET status = 'completed',
          metrics_json = ?,
          summary_json = ?,
          generated_at = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      JSON.stringify(input.metrics),
      JSON.stringify(input.summary),
      timestamp,
      timestamp,
      input.reportId,
    )
    return this.getHealthReport(input.reportId)
  }

  failHealthReport(input: {
    reportId: string
    errorCode: string
    errorMessage: string
  }): CabinHealthReport | null {
    const timestamp = now()
    this.db.prepare(`
      UPDATE cabin_health_reports
      SET status = 'failed',
          error_code = ?,
          error_message = ?,
          generated_at = ?,
          updated_at = ?
      WHERE id = ? AND status IN ('collecting', 'generating')
    `).run(input.errorCode, input.errorMessage, timestamp, timestamp, input.reportId)
    return this.getHealthReport(input.reportId)
  }

  touchConversation(conversationId: string): void {
    this.db.prepare('UPDATE cabin_conversations SET updated_at = ?, status = ? WHERE id = ?')
      .run(now(), 'active', conversationId)
  }

  appendMessage(input: {
    conversationId: string
    role: CabinMessageRole
    source: CabinMessageSource
    content: string
    intent?: string | null
    slots?: Record<string, unknown> | null
    toolCalls?: CabinToolCall[] | null
  }): CabinMessage {
    const id = randomUUID()
    const createdAt = now()
    this.db.prepare(`
      INSERT INTO cabin_messages (
        id, conversation_id, role, source, content, intent, slots_json, tool_calls_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.conversationId,
      input.role,
      input.source,
      input.content,
      input.intent ?? null,
      input.slots ? JSON.stringify(input.slots) : null,
      input.toolCalls?.length ? JSON.stringify(input.toolCalls) : null,
      createdAt,
    )
    this.touchConversation(input.conversationId)
    const row = this.db.prepare('SELECT * FROM cabin_messages WHERE id = ?').get(id) as Row | undefined
    if (!row) throw new Error('Failed to create cabin message')
    return mapMessage(row)
  }

  isLatestPassengerMessage(conversationId: string, messageId: string): boolean {
    const row = this.db.prepare("SELECT id FROM cabin_messages WHERE conversation_id = ? AND role = 'user' ORDER BY created_at DESC, rowid DESC LIMIT 1").get(conversationId) as Row | undefined
    return row?.id === messageId
  }

  listMessages(conversationId: string, limit: number, options: { beforeId?: string; afterId?: string } = {}): CabinMessage[] {
    const params: unknown[] = [conversationId]
    let cursorClause = ''
    if (options.beforeId) {
      const cursor = this.db.prepare('SELECT created_at FROM cabin_messages WHERE id = ? AND conversation_id = ?')
        .get(options.beforeId, conversationId) as Row | undefined
      if (cursor) {
        cursorClause = 'AND created_at < ?'
        params.push(Number(cursor.created_at))
      }
    } else if (options.afterId) {
      const cursor = this.db.prepare('SELECT created_at FROM cabin_messages WHERE id = ? AND conversation_id = ?')
        .get(options.afterId, conversationId) as Row | undefined
      if (cursor) {
        cursorClause = 'AND created_at > ?'
        params.push(Number(cursor.created_at))
      }
    }
    params.push(Math.max(1, Math.min(limit, 200)))
    const rows = this.db.prepare(`
      SELECT * FROM cabin_messages
      WHERE conversation_id = ?
      ${cursorClause}
      ORDER BY created_at DESC
      LIMIT ?
    `).all(...params) as Row[]
    return rows.reverse().map(mapMessage)
  }

  listConversations(input: {
    flightId?: string
    flightDate?: string
    seatId?: string
    passenger?: string
    status?: 'active' | 'reset'
    limit?: number
    offset?: number
  } = {}): { conversations: CabinConversation[]; total: number } {
    const clauses: string[] = []
    const params: unknown[] = []
    if (input.flightId) {
      clauses.push('flight_id LIKE ?')
      params.push(`%${input.flightId}%`)
    }
    if (input.flightDate) {
      clauses.push('flight_date = ?')
      params.push(input.flightDate)
    }
    if (input.seatId) {
      clauses.push('seat_id LIKE ?')
      params.push(`%${input.seatId}%`)
    }
    if (input.passenger) {
      clauses.push('(passenger_id LIKE ? OR passenger_ref LIKE ? OR passenger_name LIKE ?)')
      const like = `%${input.passenger}%`
      params.push(like, like, like)
    }
    if (input.status) {
      clauses.push('status = ?')
      params.push(input.status)
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const totalRow = this.db.prepare(`SELECT COUNT(*) AS total FROM cabin_conversations ${where}`)
      .get(...params) as Row | undefined
    const limit = Math.max(1, Math.min(input.limit ?? 50, 200))
    const offset = Math.max(0, input.offset ?? 0)
    const rows = this.db.prepare(`
      SELECT * FROM cabin_conversations
      ${where}
      ORDER BY updated_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as Row[]
    return {
      conversations: rows.map(mapConversation),
      total: Number(totalRow?.total ?? 0),
    }
  }

  getConversationById(conversationId: string): CabinConversation | null {
    const row = this.db.prepare('SELECT * FROM cabin_conversations WHERE id = ?').get(conversationId) as Row | undefined
    return row ? mapConversation(row) : null
  }

  resetConversation(conversationId: string): void {
    const timestamp = now()
    this.db.prepare('UPDATE cabin_conversations SET status = ?, updated_at = ?, language_epoch = language_epoch + 1 WHERE id = ?')
      .run('reset', timestamp, conversationId)
    this.db.prepare(`
      INSERT INTO cabin_messages (id, conversation_id, role, source, content, created_at)
      VALUES (?, ?, 'system', 'agent', ?, ?)
    `).run(randomUUID(), conversationId, 'conversation reset', timestamp)
  }

  // Point a conversation at a freshly-minted MOSS session in place, keeping the same
  // conversation row so cabin_messages (keyed by conversation_id) stay fully intact.
  // Unlike resetConversation this inserts NO 'conversation reset' marker — session
  // recovery must be continuous and passenger-invisible.
  rebindMossSession(conversationId: string, newSessionId: string): void {
    this.db.prepare(`
      UPDATE cabin_conversations
      SET moss_session_id = ?, status = 'active', updated_at = ?
      WHERE id = ?
    `).run(newSessionId, now(), conversationId)
  }

  insertVoiceLog(input: {
    conversationId?: string | null
    messageId?: string | null
    type: 'asr' | 'tts'
    text?: string | null
    status: 'ok' | 'error'
    errorMessage?: string | null
    elapsedMs?: number | null
  }): void {
    this.db.prepare(`
      INSERT INTO cabin_voice_logs (
        id, conversation_id, message_id, type, text, status, error_message, elapsed_ms, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      input.conversationId ?? null,
      input.messageId ?? null,
      input.type,
      input.text ?? null,
      input.status,
      input.errorMessage ?? null,
      input.elapsedMs ?? null,
      now(),
    )
  }
}
