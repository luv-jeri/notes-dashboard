/*
 * Due dates are calendar dates ("2026-10-16") with no time zone, so they are
 * compared as strings in the person's local calendar. Timestamps from the
 * server (created, edited, done) are full ISO instants in UTC.
 */

/** A local calendar date as "YYYY-MM-DD". */
export function toDateKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/**
 * Reads "YYYY-MM-DD" as local midnight. `new Date("2026-10-16")` would mean
 * midnight UTC, which is the previous evening west of Greenwich.
 */
export function fromDateKey(key: string): Date {
  const [year, month, day] = key.split('-').map(Number)
  return new Date(year, month - 1, day)
}

export function addDays(key: string, days: number): string {
  const date = fromDateKey(key)
  date.setDate(date.getDate() + days)
  return toDateKey(date)
}

export type DueStatus = 'overdue' | 'today' | 'upcoming'

export function dueStatus(dueDate: string, today: string): DueStatus {
  // "YYYY-MM-DD" strings sort in date order, so plain comparison works.
  if (dueDate < today) return 'overdue'
  if (dueDate === today) return 'today'
  return 'upcoming'
}

const weekdayFormat = new Intl.DateTimeFormat(undefined, { weekday: 'short' })
const weekdayLongFormat = new Intl.DateTimeFormat(undefined, { weekday: 'long' })
const dayMonthFormat = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' })
const longFormat = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
})

/** "Today", "Tomorrow", "Yesterday", a weekday within the coming week, otherwise "17 Oct". */
export function formatDue(dueDate: string, today: string): string {
  const relative = relativeDay(dueDate, today)
  if (relative) return relative[0].toUpperCase() + relative.slice(1)
  const date = fromDateKey(dueDate)
  if (dueDate > today && dueDate < addDays(today, 7)) return weekdayFormat.format(date)
  return dayMonthFormat.format(date)
}

/** The same words for the middle of a sentence: "Due today", "was due 14 Oct". */
export function formatDueInline(dueDate: string, today: string): string {
  return relativeDay(dueDate, today) ?? formatDue(dueDate, today)
}

function relativeDay(dueDate: string, today: string) {
  if (dueDate === today) return 'today'
  if (dueDate === addDays(today, 1)) return 'tomorrow'
  if (dueDate === addDays(today, -1)) return 'yesterday'
  return null
}

export const formatWeekday = (key: string) => weekdayFormat.format(fromDateKey(key))
export const formatWeekdayLong = (key: string) => weekdayLongFormat.format(fromDateKey(key))
export const formatLongDate = (date: Date) => longFormat.format(date)

const relativeFormat = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

/** "just now", "5 minutes ago", "3 hours ago", "yesterday", then a date. */
export function formatAgo(iso: string, now = new Date()): string {
  const seconds = Math.round((new Date(iso).getTime() - now.getTime()) / 1000)
  const elapsed = Math.abs(seconds)
  // Everything shown here has already happened. A time ahead of `now` means a
  // note saved since the once-a-minute clock last ticked, not "in 1 minute".
  if (seconds > 0 || elapsed < 45) return 'just now'
  if (elapsed < 3600) return relativeFormat.format(Math.round(seconds / 60), 'minute')
  if (elapsed < 86_400) return relativeFormat.format(Math.round(seconds / 3600), 'hour')
  if (elapsed < 7 * 86_400) return relativeFormat.format(Math.round(seconds / 86_400), 'day')
  return dayMonthFormat.format(new Date(iso))
}

export function greeting(now = new Date()): string {
  const hour = now.getHours()
  if (hour < 5) return 'Working late'
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}
