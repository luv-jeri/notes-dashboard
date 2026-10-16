import { useEffect, useState, type RefObject } from 'react'

/**
 * For a bar with position: sticky. Returns true once the element above it has
 * scrolled out of view, which is when the bar sticks, so it can show that it
 * is floating over the content.
 *
 * Also publishes the bar's height as --toolbar-height on <html>. The notes
 * turn that into scroll-margin, so when Tab moves focus to a card the
 * browser scrolls it clear of the bar instead of underneath it.
 */
export function useStickyBar(bar: RefObject<HTMLElement | null>, above: RefObject<HTMLElement | null>) {
  const [stuck, setStuck] = useState(false)

  useEffect(() => {
    const node = above.current
    if (!node || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(([entry]) =>
      setStuck(!entry.isIntersecting && entry.boundingClientRect.bottom <= 0),
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [above])

  useEffect(() => {
    const node = bar.current
    if (!node || typeof ResizeObserver === 'undefined') return
    const root = document.documentElement
    const observer = new ResizeObserver(() =>
      root.style.setProperty('--toolbar-height', `${node.offsetHeight}px`),
    )
    observer.observe(node)
    return () => {
      observer.disconnect()
      root.style.removeProperty('--toolbar-height')
    }
  }, [bar])

  return stuck
}
