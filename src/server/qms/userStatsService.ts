import type { QmsSqlPort } from './qmsSchema.js'

export interface QmsUserStatsQuery {
  tenantId?: string | null
  startTime?: number
  endTime?: number
  orgId?: string
  loginMode?: string
  userId?: string
  stepType?: string
  order?: string
  limit?: number
}

function numeric(value: unknown): number {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

function optional(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value)
}

export class QmsUserStatsService {
  constructor(private readonly db: QmsSqlPort, private readonly now: () => Date = () => new Date()) {}

  async conversations(query: QmsUserStatsQuery) {
    const scope = this.scope(query)
    const rows = await this.db.execute(
      `WITH combined AS (
        SELECT user_id, org_id, tenant_id, login_mode, user_nickname, user_phone,
          conversation_count, total_tokens, input_tokens, output_tokens, success_count, error_count,
          avg_duration_ms * conversation_count AS duration_total
        FROM telemetry_user_conversations_daily
        WHERE bucket >= $1 AND bucket < $2${scope.dailyFilters}
        UNION ALL
        SELECT COALESCE(NULLIF(user_id, ''), NULLIF(user_phone, '')) AS user_id,
          org_id, tenant_id, login_mode, MAX(user_nickname), MAX(user_phone),
          COUNT(*)::INTEGER, COALESCE(SUM(tokens_used), 0)::BIGINT,
          COALESCE(SUM(input_tokens), 0)::BIGINT, COALESCE(SUM(output_tokens), 0)::BIGINT,
          COUNT(*) FILTER (WHERE status = 'success')::INTEGER,
          COUNT(*) FILTER (WHERE status = 'error')::INTEGER, COALESCE(SUM(duration_ms), 0)::BIGINT
        FROM telemetry_conversations
        WHERE timestamp >= GREATEST($1, $2) AND timestamp < $3${scope.rawFilters}
          AND COALESCE(NULLIF(user_id, ''), NULLIF(user_phone, '')) IS NOT NULL
        GROUP BY COALESCE(NULLIF(user_id, ''), NULLIF(user_phone, '')), org_id, tenant_id, login_mode
      )
      SELECT user_id, org_id, tenant_id, login_mode, MAX(user_nickname) AS user_nickname,
        MAX(user_phone) AS user_phone, SUM(conversation_count)::INTEGER AS conversation_count,
        SUM(total_tokens)::BIGINT AS total_tokens, SUM(input_tokens)::BIGINT AS input_tokens,
        SUM(output_tokens)::BIGINT AS output_tokens,
        ROUND(SUM(duration_total)::DECIMAL / NULLIF(SUM(conversation_count), 0))::INTEGER AS avg_duration_ms,
        SUM(success_count)::INTEGER AS success_count, SUM(error_count)::INTEGER AS error_count,
        COALESCE(ROUND(SUM(success_count)::DECIMAL /
          NULLIF(SUM(success_count) + SUM(error_count), 0) * 100), 100)::INTEGER AS success_rate
      FROM combined GROUP BY user_id, org_id, tenant_id, login_mode
      ORDER BY conversation_count ${scope.order} LIMIT $${scope.parameters.length + 1}`,
      [...scope.parameters, scope.limit],
    )
    return rows.map(row => ({
      user_id: String(row.user_id), org_id: optional(row.org_id), tenant_id: optional(row.tenant_id),
      login_mode: optional(row.login_mode), user_nickname: optional(row.user_nickname), user_phone: optional(row.user_phone),
      conversation_count: numeric(row.conversation_count), total_tokens: numeric(row.total_tokens),
      input_tokens: numeric(row.input_tokens), output_tokens: numeric(row.output_tokens),
      avg_duration_ms: numeric(row.avg_duration_ms), success_count: numeric(row.success_count),
      success_rate: numeric(row.success_rate), error_count: numeric(row.error_count),
    }))
  }

  async turns(query: QmsUserStatsQuery) {
    const scope = this.scope(query)
    const rows = await this.db.execute(
      `WITH combined AS (
        SELECT user_id, org_id, tenant_id, login_mode, user_nickname, user_phone,
          turn_count, total_tokens, success_count, error_count
        FROM telemetry_user_turns_daily WHERE bucket >= $1 AND bucket < $2${scope.dailyFilters}
        UNION ALL
        SELECT COALESCE(NULLIF(user_id, ''), NULLIF(user_phone, '')), org_id, tenant_id, login_mode,
          MAX(user_nickname), MAX(user_phone), COUNT(*)::INTEGER,
          COALESCE(SUM(total_tokens), 0)::BIGINT,
          COUNT(*) FILTER (WHERE status = 'success')::INTEGER,
          COUNT(*) FILTER (WHERE status = 'error')::INTEGER
        FROM telemetry_turns WHERE timestamp >= GREATEST($1, $2) AND timestamp < $3${scope.rawFilters}
          AND COALESCE(NULLIF(user_id, ''), NULLIF(user_phone, '')) IS NOT NULL
        GROUP BY COALESCE(NULLIF(user_id, ''), NULLIF(user_phone, '')), org_id, tenant_id, login_mode
      )
      SELECT user_id, org_id, tenant_id, login_mode, MAX(user_nickname) AS user_nickname,
        MAX(user_phone) AS user_phone, SUM(turn_count)::INTEGER AS turn_count,
        SUM(total_tokens)::BIGINT AS total_tokens,
        ROUND(SUM(total_tokens)::DECIMAL / NULLIF(SUM(turn_count), 0))::INTEGER AS avg_tokens_per_turn,
        COALESCE(ROUND(SUM(success_count)::DECIMAL /
          NULLIF(SUM(success_count) + SUM(error_count), 0) * 100), 100)::INTEGER AS success_rate
      FROM combined GROUP BY user_id, org_id, tenant_id, login_mode
      ORDER BY turn_count ${scope.order} LIMIT $${scope.parameters.length + 1}`,
      [...scope.parameters, scope.limit],
    )
    return rows.map(row => ({
      user_id: String(row.user_id), org_id: optional(row.org_id), tenant_id: optional(row.tenant_id),
      login_mode: optional(row.login_mode), user_nickname: optional(row.user_nickname), user_phone: optional(row.user_phone),
      turn_count: numeric(row.turn_count), total_tokens: numeric(row.total_tokens),
      avg_tokens_per_turn: numeric(row.avg_tokens_per_turn), success_rate: numeric(row.success_rate),
    }))
  }

  async steps(query: QmsUserStatsQuery) {
    const scope = this.scope(query, true)
    const rows = await this.db.execute(
      `WITH combined AS (
        SELECT user_id, org_id, tenant_id, login_mode, user_nickname, user_phone, step_type,
          step_count, success_count, error_count, avg_duration_ms * step_count AS duration_total
        FROM telemetry_user_steps_daily WHERE bucket >= $1 AND bucket < $2${scope.dailyFilters}
        UNION ALL
        SELECT COALESCE(NULLIF(user_id, ''), NULLIF(user_phone, '')), org_id, tenant_id, login_mode,
          MAX(user_nickname), MAX(user_phone), step_type, COUNT(*)::INTEGER,
          COUNT(*) FILTER (WHERE status = 'success')::INTEGER,
          COUNT(*) FILTER (WHERE status = 'error')::INTEGER, COALESCE(SUM(duration_ms), 0)::BIGINT
        FROM telemetry_steps WHERE timestamp >= GREATEST($1, $2) AND timestamp < $3${scope.rawFilters}
          AND COALESCE(NULLIF(user_id, ''), NULLIF(user_phone, '')) IS NOT NULL
        GROUP BY COALESCE(NULLIF(user_id, ''), NULLIF(user_phone, '')), org_id, tenant_id, login_mode, step_type
      )
      SELECT user_id, org_id, tenant_id, login_mode, MAX(user_nickname) AS user_nickname,
        MAX(user_phone) AS user_phone, step_type, SUM(step_count)::INTEGER AS step_count,
        SUM(success_count)::INTEGER AS success_count, SUM(error_count)::INTEGER AS error_count,
        ROUND(SUM(success_count)::DECIMAL / NULLIF(SUM(step_count), 0) * 100)::INTEGER AS success_rate,
        ROUND(SUM(duration_total)::DECIMAL / NULLIF(SUM(step_count), 0))::INTEGER AS avg_duration_ms
      FROM combined GROUP BY user_id, org_id, tenant_id, login_mode, step_type
      ORDER BY step_count ${scope.order} LIMIT $${scope.parameters.length + 1}`,
      [...scope.parameters, scope.limit],
    )
    return rows.map(row => ({
      user_id: String(row.user_id), org_id: optional(row.org_id), tenant_id: optional(row.tenant_id),
      login_mode: optional(row.login_mode), user_nickname: optional(row.user_nickname), user_phone: optional(row.user_phone),
      step_type: String(row.step_type), step_count: numeric(row.step_count), success_count: numeric(row.success_count),
      error_count: numeric(row.error_count), success_rate: numeric(row.success_rate), avg_duration_ms: numeric(row.avg_duration_ms),
    }))
  }

  async leaderboard(type: string, query: QmsUserStatsQuery) {
    if (!['conversations', 'turns', 'steps', 'tokens'].includes(type)) {
      throw new Error('Invalid leaderboard type. Must be conversations, turns, steps, or tokens')
    }
    const rows = type === 'conversations'
      ? await this.conversations(query)
      : type === 'steps'
        ? await this.steps(query)
        : await this.turns(query)
    const value = type === 'conversations' ? 'conversation_count'
      : type === 'steps' ? 'step_count'
        : type === 'tokens' ? 'total_tokens' : 'turn_count'
    const merged = new Map<string, Record<string, unknown>>()
    for (const row of rows) {
      const record = row as Record<string, unknown>
      const key = JSON.stringify([row.user_id, row.org_id ?? null, row.tenant_id ?? null, row.login_mode ?? null])
      const existing = merged.get(key)
      if (existing) existing[value] = numeric(existing[value]) + numeric(record[value])
      else merged.set(key, { ...record })
    }
    const direction = query.order === 'asc' ? 1 : -1
    return [...merged.values()]
      .sort((left, right) => (numeric(left[value]) - numeric(right[value])) * direction)
      .slice(0, Math.min(query.limit ?? 10, 50))
      .map((row, index) => ({
        rank: index + 1, user_id: row.user_id, org_id: row.org_id, tenant_id: row.tenant_id,
        login_mode: row.login_mode, user_nickname: row.user_nickname, user_phone: row.user_phone,
        value: numeric(row[value]),
      }))
  }

  async userDetail(userId: string, query: QmsUserStatsQuery) {
    const range = this.rawScope(query, 30 * 86_400_000, userId)
    const [identity, conversations, turns, steps, models] = await Promise.all([
      this.db.execute(`SELECT MAX(user_nickname) AS user_nickname, MAX(user_phone) AS user_phone
        FROM telemetry_conversations WHERE COALESCE(NULLIF(user_id, ''), NULLIF(user_phone, '')) = $3${range.tenantSql}`,
      range.parameters),
      this.db.execute(`SELECT COUNT(*)::INTEGER AS conversation_count,
        COALESCE(SUM(tokens_used), 0)::BIGINT AS total_tokens, AVG(duration_ms)::INTEGER AS avg_duration_ms,
        COUNT(*) FILTER (WHERE status = 'success')::INTEGER AS success_count,
        COALESCE(ROUND(COUNT(*) FILTER (WHERE status = 'success')::DECIMAL /
          NULLIF(COUNT(*) FILTER (WHERE status IN ('success','error')), 0) * 100), 100)::INTEGER AS success_rate
        FROM telemetry_conversations WHERE timestamp >= $1 AND timestamp < $2
        AND COALESCE(NULLIF(user_id, ''), NULLIF(user_phone, '')) = $3${range.tenantSql}`, range.parameters),
      this.db.execute(`SELECT COUNT(*)::INTEGER AS turn_count, COALESCE(SUM(total_tokens), 0)::BIGINT AS total_tokens,
        ROUND(AVG(COALESCE(total_tokens, 0)))::INTEGER AS avg_tokens_per_turn FROM telemetry_turns
        WHERE timestamp >= $1 AND timestamp < $2
        AND COALESCE(NULLIF(user_id, ''), NULLIF(user_phone, '')) = $3${range.tenantSql}`, range.parameters),
      this.db.execute(`SELECT step_type, COUNT(*)::INTEGER AS count,
        ROUND(COUNT(*) FILTER (WHERE status = 'success')::DECIMAL / NULLIF(COUNT(*), 0) * 100)::INTEGER AS success_rate
        FROM telemetry_steps WHERE timestamp >= $1 AND timestamp < $2
        AND COALESCE(NULLIF(user_id, ''), NULLIF(user_phone, '')) = $3${range.tenantSql}
        GROUP BY step_type`, range.parameters),
      this.db.execute(`SELECT model_id, COUNT(*)::INTEGER AS count FROM telemetry_turns
        WHERE timestamp >= $1 AND timestamp < $2
        AND COALESCE(NULLIF(user_id, ''), NULLIF(user_phone, '')) = $3${range.tenantSql}
        GROUP BY model_id ORDER BY count DESC LIMIT 5`, range.parameters),
    ])
    return {
      user_id: userId, user_nickname: identity[0]?.user_nickname ?? null, user_phone: identity[0]?.user_phone ?? null,
      conversations: this.numericObject(conversations[0]), turns: this.numericObject(turns[0]),
      steps: steps.map(row => ({ step_type: String(row.step_type), count: numeric(row.count), success_rate: numeric(row.success_rate) })),
      model_usage: models.map(row => ({ model_id: String(row.model_id), count: numeric(row.count) })),
    }
  }

  async realtime(query: QmsUserStatsQuery) {
    const range = this.rawScope(query)
    const identity = "COALESCE(NULLIF(user_id, ''), NULLIF(user_phone, ''))"
    const [users, conversations, turns, steps, tokens] = await Promise.all([
      this.db.execute(`SELECT COUNT(DISTINCT ${identity})::INTEGER AS total_users FROM telemetry_conversations
        WHERE timestamp >= $1 AND timestamp < $2${range.tenantSql} AND ${identity} IS NOT NULL`, range.parameters),
      this.db.execute(`SELECT COUNT(*)::BIGINT AS total_conversations FROM telemetry_conversations
        WHERE timestamp >= $1 AND timestamp < $2${range.tenantSql} AND ${identity} IS NOT NULL`, range.parameters),
      this.db.execute(`SELECT COUNT(*)::BIGINT AS total_turns FROM telemetry_turns
        WHERE timestamp >= $1 AND timestamp < $2${range.tenantSql} AND ${identity} IS NOT NULL`, range.parameters),
      this.db.execute(`SELECT COUNT(*)::BIGINT AS total_steps FROM telemetry_steps
        WHERE timestamp >= $1 AND timestamp < $2${range.tenantSql} AND ${identity} IS NOT NULL`, range.parameters),
      this.db.execute(`SELECT COALESCE(SUM(total_tokens), 0)::BIGINT AS total_tokens FROM telemetry_turns
        WHERE timestamp >= $1 AND timestamp < $2${range.tenantSql} AND ${identity} IS NOT NULL`, range.parameters),
    ])
    return {
      total_users: numeric(users[0]?.total_users), total_conversations: numeric(conversations[0]?.total_conversations),
      total_turns: numeric(turns[0]?.total_turns), total_steps: numeric(steps[0]?.total_steps),
      total_tokens: numeric(tokens[0]?.total_tokens),
    }
  }

  private scope(query: QmsUserStatsQuery, includeStep = false) {
    const endMs = query.endTime ?? this.now().getTime()
    const startMs = query.startTime ?? endMs - 7 * 86_400_000
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) throw new Error('Invalid user stats time range')
    const now = this.now()
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    const parameters: unknown[] = [new Date(startMs), today, new Date(endMs)]
    let dailyFilters = ''
    let rawFilters = ''
    for (const [column, value] of [
      ['tenant_id', query.tenantId], ['org_id', query.orgId], ['login_mode', query.loginMode],
      ['user_id', query.userId], ...(includeStep ? [['step_type', query.stepType]] : []),
    ] as Array<[string, unknown]>) {
      if (value === undefined || value === null || value === '') continue
      parameters.push(value)
      const position = `$${parameters.length}`
      dailyFilters += ` AND ${column} = ${position}`
      rawFilters += column === 'user_id'
        ? ` AND COALESCE(NULLIF(user_id, ''), NULLIF(user_phone, '')) = ${position}`
        : ` AND ${column} = ${position}`
    }
    return {
      parameters, dailyFilters, rawFilters,
      order: query.order === 'asc' ? 'ASC' : 'DESC', limit: Math.min(Math.max(query.limit ?? 50, 1), 100),
    }
  }

  private rawScope(query: QmsUserStatsQuery, duration = 7 * 86_400_000, userId?: string) {
    const endMs = query.endTime ?? this.now().getTime()
    const startMs = query.startTime ?? endMs - duration
    const parameters: unknown[] = [new Date(startMs), new Date(endMs)]
    if (userId !== undefined) parameters.push(userId)
    const tenantSql = query.tenantId ? ` AND tenant_id = $${parameters.push(query.tenantId)}` : ''
    return { parameters, tenantSql }
  }

  private numericObject(row?: Record<string, unknown>) {
    if (!row) return {}
    return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === 'number' || /^-?\d+(\.\d+)?$/.test(String(value)) ? numeric(value) : value]))
  }
}
