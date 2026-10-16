import { useEffect, useState } from 'react'

function read(key: string, fallback: boolean): boolean {
  try {
    const stored = localStorage.getItem(key)
    return stored === null ? fallback : stored === 'true'
  } catch {
    // Storage can be switched off; the flag then lasts for this visit only.
    return fallback
  }
}

/** An on/off setting that is still set after a reload, such as a folded sidebar. */
export function useStoredFlag(key: string, fallback: boolean) {
  const [value, setValue] = useState(() => read(key, fallback))

  useEffect(() => {
    try {
      localStorage.setItem(key, String(value))
    } catch {
      // As above: keep working without storage.
    }
  }, [key, value])

  return [value, setValue] as const
}
