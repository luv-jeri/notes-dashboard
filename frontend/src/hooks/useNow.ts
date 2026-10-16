import { useEffect, useState } from 'react'

/**
 * The current time, refreshed every minute, so "5 minutes ago" labels and
 * the meaning of "today" stay right on a page left open overnight.
 */
export function useNow(intervalMs = 60_000): Date {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), intervalMs)
    return () => window.clearInterval(timer)
  }, [intervalMs])

  return now
}
