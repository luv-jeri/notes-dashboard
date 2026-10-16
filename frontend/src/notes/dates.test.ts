import { describe, expect, it } from 'vitest'
import { addDays, dueStatus, formatAgo, formatDue, toDateKey } from './dates'

describe('dates', () => {
  it('adds days across month and year ends', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
  })

  it('reads a date key in local time, not UTC', () => {
    // new Date('2026-10-16') would be midnight UTC: the evening before, west of Greenwich.
    expect(toDateKey(new Date(2026, 9, 16, 23, 30))).toBe('2026-10-16')
  })

  it('tells overdue, today and upcoming apart', () => {
    expect(dueStatus('2026-10-15', '2026-10-16')).toBe('overdue')
    expect(dueStatus('2026-10-16', '2026-10-16')).toBe('today')
    expect(dueStatus('2026-10-17', '2026-10-16')).toBe('upcoming')
  })

  it('names nearby due dates in words', () => {
    expect(formatDue('2026-10-16', '2026-10-16')).toBe('Today')
    expect(formatDue('2026-10-17', '2026-10-16')).toBe('Tomorrow')
    expect(formatDue('2026-10-15', '2026-10-16')).toBe('Yesterday')
  })

  it('says "just now" for the last few seconds', () => {
    const now = new Date('2026-10-16T12:00:00Z')

    expect(formatAgo('2026-10-16T11:59:30Z', now)).toBe('just now')
    expect(formatAgo('2026-10-16T11:55:00Z', now)).toBe('5 minutes ago')
    // Saved after the minute clock last ticked.
    expect(formatAgo('2026-10-16T12:00:50Z', now)).toBe('just now')
  })
})
