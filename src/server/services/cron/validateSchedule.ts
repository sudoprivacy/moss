import { Cron } from 'croner'
import type { CronJobSchedule } from './CronStore.js'

/** Validate schedules before persistence, including schedules for disabled jobs. */
export function validateSchedule(schedule: CronJobSchedule): string | null {
  if (!schedule || typeof schedule.value !== 'string' || !schedule.value.trim()) {
    return 'schedule.value is required'
  }
  if (schedule.tz !== undefined) {
    if (typeof schedule.tz !== 'string' || !schedule.tz.trim()) return 'Invalid schedule timezone'
    try {
      new Intl.DateTimeFormat('en', { timeZone: schedule.tz }).format()
    } catch {
      return 'Invalid schedule timezone'
    }
  }
  switch (schedule.kind) {
    case 'cron':
      try {
        new Cron(schedule.value, { timezone: schedule.tz ?? 'Asia/Shanghai' })
        return null
      } catch {
        return 'Invalid cron expression'
      }
    case 'every': {
      const match = schedule.value.match(/^(\d+)([mhd])$/)
      const interval = match ? Number(match[1]) : 0
      const multiplier = match?.[2] === 'm' ? 60_000 : match?.[2] === 'h' ? 3_600_000 : 86_400_000
      return Number.isSafeInteger(interval * multiplier) && interval > 0 ? null : 'Invalid schedule interval'
    }
    case 'at':
      return Number.isFinite(Date.parse(schedule.value)) ? null : 'Invalid scheduled date'
    default:
      return 'Invalid schedule kind'
  }
}
