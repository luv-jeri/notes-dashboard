import { useEffect, useEffectEvent } from 'react'

/**
 * Single-key shortcuts for the whole page, keyed by `event.key` in lower case.
 * They stay quiet while someone is typing or has a dialog open, and never
 * override browser shortcuts that use a modifier key.
 */
export function useShortcuts(shortcuts: Record<string, () => void>) {
  // An effect event always sees the latest `shortcuts` without re-adding the
  // listener on every render.
  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
    const target = event.target instanceof Element ? event.target : null
    if (target?.closest('input, textarea, select, [contenteditable]')) return
    if (document.querySelector('dialog[open]')) return

    const run = shortcuts[event.key.toLowerCase()]
    if (!run) return
    event.preventDefault()
    run()
  })

  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKeyDown(event)
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [])
}
