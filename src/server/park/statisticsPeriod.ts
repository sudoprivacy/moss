import { HttpError } from '../httpRespond.js'
import { DAY, shanghaiDay } from './statistics.js'

export interface StatisticsRange { from: string; to: string }
export interface StatisticsPeriod extends StatisticsRange {
  start: number
  end: number
  days: string[]
  time_zone: string
  is_partial: boolean
}

export function subtractMonths(day: string, months: number): string {
  const [year, month, date] = day.split('-').map(Number)
  const target = new Date(Date.UTC(year!, month! - 1 - months, 1))
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()
  return `${target.getUTCFullYear()}-${String(target.getUTCMonth() + 1).padStart(2, '0')}-${String(Math.min(date!, last)).padStart(2, '0')}`
}

function parseDay(day: string): number {
  const value = Date.parse(`${day}T00:00:00+08:00`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(value) || shanghaiDay(value) !== day) {
    throw new HttpError(400, 'Invalid statistics date')
  }
  return value
}

export function statisticsPeriod(now: number, range?: StatisticsRange, isSummary = false): StatisticsPeriod {
  const today = shanghaiDay(now)
  const from = range?.from ?? (isSummary ? subtractMonths(today, 3) : shanghaiDay(now - 13 * DAY))
  const to = range?.to ?? today
  const start = parseDay(from), finish = parseDay(to)
  if (from > to || to > today) throw new HttpError(400, 'Invalid statistics range')
  const end = Math.min(finish + DAY, now + 1)
  const days: string[] = []
  for (let time = start; time <= finish; time += DAY) days.push(shanghaiDay(time))
  return { from, to, start, end, days, time_zone: 'Asia/Shanghai', is_partial: end < finish + DAY }
}

export function requestedStatisticsRange(url: string): StatisticsRange | undefined {
  const params = new URL(url, 'http://localhost').searchParams
  const from = params.get('from'), to = params.get('to')
  if (from === null && to === null) return undefined
  if (!from || !to) throw new HttpError(400, 'Both statistics dates are required')
  return { from, to }
}
