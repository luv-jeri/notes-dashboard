import { useEffect, useState } from 'react'
import { flushSync } from 'react-dom'

export type Theme = 'light' | 'dark'

// The inline script in index.html reads the same key before the first paint.
const STORAGE_KEY = 'notes-theme'

function savedTheme(): Theme | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    return value === 'light' || value === 'dark' ? value : null
  } catch {
    return null // Storage can be blocked, for example in some private windows.
  }
}

/**
 * Light or dark. Starts from what index.html already applied, follows the
 * system setting until the person picks one, then remembers their pick.
 */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() =>
    document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
  )

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const follow = (event: MediaQueryListEvent) => {
      if (!savedTheme()) setTheme(event.matches ? 'dark' : 'light')
    }
    query.addEventListener('change', follow)
    return () => query.removeEventListener('change', follow)
  }, [])

  /**
   * Switches theme. Given the button that was pressed, the new colours spread
   * out from it in a growing circle: the browser snapshots the page, the
   * theme changes underneath, and the new page is revealed through the circle.
   */
  function toggle(origin?: HTMLElement) {
    const next = theme === 'dark' ? 'light' : 'dark'
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // Not remembered, but the switch still works for this visit.
    }

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (!origin || reduce || typeof document.startViewTransition !== 'function') {
      setTheme(next)
      return
    }

    const rect = origin.getBoundingClientRect()
    const x = rect.left + rect.width / 2
    const y = rect.top + rect.height / 2
    // Far enough to cover the corner furthest from the button.
    const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y))

    const transition = document.startViewTransition(() => {
      // The new page has to be in place when this returns, so render now.
      flushSync(() => setTheme(next))
      document.documentElement.dataset.theme = next
    })
    transition.ready
      .then(() => {
        document.documentElement.animate(
          { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
          {
            duration: 520,
            easing: 'cubic-bezier(0.65, 0, 0.35, 1)',
            pseudoElement: '::view-transition-new(root)',
          },
        )
      })
      // Skipped, for example by a second click mid-way: the theme still changed.
      .catch(() => {})
  }

  return { theme, toggle }
}
