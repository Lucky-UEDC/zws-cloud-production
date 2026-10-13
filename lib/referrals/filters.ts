/**
 * Shared referral query parsing.
 *
 * Every value a caller can influence is clamped here, before it reaches
 * Prisma: page sizes are capped, search terms are length-limited and stripped
 * of wildcards, and dates are resolved against one timezone so that
 * "this month" means the same thing on the client dashboard, on the admin
 * dashboard and in an export.
 *
 * Pure on purpose - no database, no request object - so the rules are unit
 * testable and identical on both sides of the feature.
 */

export const REFERRAL_APP_TIMEZONE = "Asia/Kolkata"

export const REFERRAL_DATE_RANGES = [
  { key: "all", label: "All time" },
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "this_week", label: "This week" },
  { key: "this_month", label: "This month" },
  { key: "last_month", label: "Last month" },
  { key: "last_30_days", label: "Last 30 days" },
  { key: "custom", label: "Custom" },
] as const

export type ReferralRangeKey = (typeof REFERRAL_DATE_RANGES)[number]["key"]

export const DEFAULT_REFERRAL_PAGE_SIZE = 20
export const MAX_REFERRAL_PAGE_SIZE = 100
export const MAX_REFERRAL_SEARCH_LENGTH = 120
export const MAX_REFERRAL_GROUP_ROWS = 500
export const MAX_REFERRAL_MONTH_ROWS = 60
export const MAX_REFERRAL_DAY_ROWS = 400

const RANGE_KEYS = new Set<string>(REFERRAL_DATE_RANGES.map((item) => item.key))

export type ReferralWindow = {
  range: ReferralRangeKey
  start: Date | null
  end: Date | null
}

/**
 * Offset of `timeZone` from UTC, in minutes, at the given instant.
 *
 * Derived from Intl rather than from `Date#getTimezoneOffset`, because a report
 * must mean the same thing regardless of the host the process happens to run
 * on: a filter for "31 March" has to end at 31 March in the billing timezone,
 * not at whatever midnight the server box thinks it is.
 */
export function zoneOffsetMinutes(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date)
  const map: Record<string, string> = {}
  for (const part of parts) if (part.type !== "literal") map[part.type] = part.value
  const asUtc = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour) % 24,
    Number(map.minute),
    Number(map.second),
  )
  return Math.round((asUtc - date.getTime()) / 60000)
}

export function startOfDayInAppTimezone(date: Date): Date {
  const offset = zoneOffsetMinutes(date, REFERRAL_APP_TIMEZONE)
  const shifted = new Date(date.getTime() + offset * 60_000)
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - offset * 60_000)
}

/** Midnight of a calendar day in the application timezone, as a real instant. */
function appTimezoneDayStart(year: number, month: number, day: number): Date {
  const probe = new Date(Date.UTC(year, month - 1, day, 12, 0, 0))
  const offset = zoneOffsetMinutes(probe, REFERRAL_APP_TIMEZONE)
  return new Date(Date.UTC(year, month - 1, day) - offset * 60_000)
}

function appTimezoneDayEnd(year: number, month: number, day: number): Date {
  const start = appTimezoneDayStart(year, month, day)
  return new Date(start.getTime() + 86_400_000 - 1)
}

/** Calendar date of `instant` as seen in the billing timezone. */
export function calendarDateInAppTimezone(instant: Date): { year: number; month: number; day: number; weekday: number } {
  const offset = zoneOffsetMinutes(instant, REFERRAL_APP_TIMEZONE)
  const shifted = new Date(instant.getTime() + offset * 60_000)
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(),
  }
}

// Exported for tests only: a report must be verifiable against an explicit
// calendar day rather than against whatever the host clock believes.
export const appTimezoneDayStartForTest = appTimezoneDayStart
export const appTimezoneDayEndForTest = appTimezoneDayEnd

/**
 * `YYYY-MM-DD` -> a real Date. Rejects impossible dates (2026-02-31) rather
 * than silently rolling them into the next month, because a rolled date would
 * quietly widen or narrow a revenue window.
 */
export function parseCalendarDay(value: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || "").trim())
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  const probe = new Date(Date.UTC(year, month - 1, day))
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null
  return { year, month, day }
}

export function resolveReferralWindow(input: {
  range?: string | null
  start?: string | null
  end?: string | null
  now?: Date
}): ReferralWindow {
  const now = input.now instanceof Date && !Number.isNaN(input.now.getTime()) ? input.now : new Date()
  const today = startOfDayInAppTimezone(now)

  const explicitStart = String(input.start || "").trim()
  const explicitEnd = String(input.end || "").trim()
  if (explicitStart || explicitEnd) {
    const parsedStart = parseCalendarDay(explicitStart)
    const parsedEnd = parseCalendarDay(explicitEnd)
    const start = parsedStart ? appTimezoneDayStart(parsedStart.year, parsedStart.month, parsedStart.day) : null
    const end = parsedEnd ? appTimezoneDayEnd(parsedEnd.year, parsedEnd.month, parsedEnd.day) : null
    if (start || end) {
      // An inverted range would silently return nothing; swap instead.
      if (start && end && start.getTime() > end.getTime()) {
        return { range: "custom", start: end, end: start }
      }
      return { range: "custom", start, end }
    }
  }

  const rawRange = String(input.range || "").trim().toLowerCase()
  const range: ReferralRangeKey = RANGE_KEYS.has(rawRange) ? (rawRange as ReferralRangeKey) : "all"

  // `today` is an exact midnight instant in the billing timezone. Asia/Kolkata
  // has no daylight saving, so stepping whole days from it is exact; calendar
  // arithmetic below is done on the billing-timezone date, never on the host's.
  const shiftDays = (days: number) => new Date(today.getTime() + days * 86_400_000)
  const calendar = calendarDateInAppTimezone(today)

  if (range === "today") return { range, start: today, end: now }
  if (range === "yesterday") return { range, start: shiftDays(-1), end: today }
  if (range === "this_week") return { range, start: shiftDays(-calendar.weekday), end: now }
  if (range === "this_month") {
    return { range, start: appTimezoneDayStart(calendar.year, calendar.month, 1), end: now }
  }
  if (range === "last_month") {
    const year = calendar.month === 1 ? calendar.year - 1 : calendar.year
    const month = calendar.month === 1 ? 12 : calendar.month - 1
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
    return { range, start: appTimezoneDayStart(year, month, 1), end: appTimezoneDayEnd(year, month, lastDay) }
  }
  if (range === "last_30_days") return { range, start: shiftDays(-29), end: now }
  return { range: "all", start: null, end: null }
}

export function referralWindowWhere(window: ReferralWindow, field: "earnedAt" | "registeredAt" = "earnedAt") {
  if (!window.start && !window.end) return {}
  return {
    [field]: {
      ...(window.start ? { gte: window.start } : {}),
      ...(window.end ? { lte: window.end } : {}),
    },
  }
}

export function normalizePagination(input: { page?: unknown; pageSize?: unknown }) {
  const page = Math.max(1, Math.min(100_000, Math.trunc(Number(input.page) || 1) || 1))
  const rawSize = Math.trunc(Number(input.pageSize) || 0)
  const pageSize = Math.max(1, Math.min(MAX_REFERRAL_PAGE_SIZE, rawSize || DEFAULT_REFERRAL_PAGE_SIZE))
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize }
}

export function buildPaginationMeta(input: { page: number; pageSize: number; total: number }) {
  const total = Math.max(0, Math.trunc(Number(input.total) || 0))
  return {
    page: input.page,
    pageSize: input.pageSize,
    total,
    pages: Math.max(1, Math.ceil(total / Math.max(1, input.pageSize))),
  }
}

/**
 * `%` and `_` are wildcards in Postgres `contains`, so a search for `100%`
 * would otherwise match every row. They are removed rather than escaped
 * because a user typing them wants a literal substring.
 */
export function normalizeReferralSearch(value: unknown): string {
  const text = String(value ?? "").trim().slice(0, MAX_REFERRAL_SEARCH_LENGTH)
  if (!text) return ""
  return text.replace(/[%_\\]/g, "").trim().slice(0, MAX_REFERRAL_SEARCH_LENGTH)
}

const REFERRAL_STATUS_VALUES = new Set(["registered", "active", "inactive", "blocked"])
const REFERRAL_COMMISSION_STATUS_VALUES = new Set(["pending", "paid", "reversed", "cancelled"])

export function normalizeReferralStatus(value: unknown): string {
  const text = String(value ?? "").trim().toLowerCase()
  return REFERRAL_STATUS_VALUES.has(text) ? text : "all"
}

export function normalizeCommissionStatus(value: unknown): string {
  const text = String(value ?? "").trim().toLowerCase()
  return REFERRAL_COMMISSION_STATUS_VALUES.has(text) ? text : "all"
}

/** `YYYY-MM` in the application timezone - the key monthly reports group by. */
export function referralMonthKey(value: Date | string | null | undefined): string | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return null
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: REFERRAL_APP_TIMEZONE,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(date)
  const year = parts.find((part) => part.type === "year")?.value
  const month = parts.find((part) => part.type === "month")?.value
  return year && month ? `${year}-${month}` : null
}

/** Every `YYYY-MM` key between two dates, inclusive - fills gaps in a series. */
export function referralMonthSeries(from: string, to: string, limit = MAX_REFERRAL_MONTH_ROWS): string[] {
  const keys: string[] = []
  const [fromYear, fromMonth] = from.split("-").map(Number)
  const [toYear, toMonth] = to.split("-").map(Number)
  if (!fromYear || !fromMonth || !toYear || !toMonth) return keys
  let year = fromYear
  let month = fromMonth
  while ((year < toYear || (year === toYear && month <= toMonth)) && keys.length < limit) {
    keys.push(`${year}-${String(month).padStart(2, "0")}`)
    month += 1
    if (month > 12) {
      month = 1
      year += 1
    }
  }
  return keys
}

export function referralDayKey(value: Date | string | null | undefined): string | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return null
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: REFERRAL_APP_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date)
  const year = parts.find((part) => part.type === "year")?.value
  const month = parts.find((part) => part.type === "month")?.value
  const day = parts.find((part) => part.type === "day")?.value
  return year && month && day ? `${year}-${month}-${day}` : null
}

export function referralDaySeries(from: Date, to: Date, limit = MAX_REFERRAL_DAY_ROWS): string[] {
  const keys: string[] = []
  let cursor = startOfDayInAppTimezone(from)
  const end = startOfDayInAppTimezone(to)
  while (cursor.getTime() <= end.getTime() && keys.length < limit) {
    const key = referralDayKey(cursor)
    if (key) keys.push(key)
    cursor = new Date(cursor.getTime() + 86_400_000)
  }
  return keys
}