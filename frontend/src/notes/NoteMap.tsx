import { useEffect, useRef, useState, type CSSProperties, type PointerEvent, type RefObject } from 'react'
import { useCategoryCatalog } from './useCategories'
import styles from './NoteMap.module.css'

interface MapCard {
  id: string
  x: number
  y: number
  width: number
  height: number
  category: string
  done: boolean
  title: string
}

interface Layout {
  cards: MapCard[]
  /** Where each section starts. */
  sections: number[]
  width: number
  height: number
}

interface NoteMapProps {
  /** The element holding the note cards. The map draws what's inside it in miniature. */
  content: RefObject<HTMLElement | null>
  /** The sticky toolbar. Cards under it are covered, so they don't count as on screen. */
  toolbar: RefObject<HTMLElement | null>
  /** Changes whenever cards may move without the list changing size, such as a new sort. */
  layoutKey: unknown
}

/**
 * The most a card is shrunk by is 1:7. A short list then reads as a small
 * picture at the top of the track, rather than a few cards blown up to fill it.
 */
const MAX_SCALE = 1 / 7
const EMPTY: Layout = { cards: [], sections: [], width: 1, height: 1 }
const DRAG_THRESHOLD = 4

const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

/** Where every card sits, relative to the list. One read per card. */
function readLayout(area: HTMLElement): Layout {
  const box = area.getBoundingClientRect()
  const cards = [...area.querySelectorAll<HTMLElement>('li[data-note-id]')].map((item) => {
    const rect = item.getBoundingClientRect()
    return {
      id: item.dataset.noteId ?? '',
      x: rect.left - box.left,
      y: rect.top - box.top,
      width: rect.width,
      height: rect.height,
      category: item.dataset.category ?? '',
      done: item.dataset.done !== undefined,
      title: item.querySelector('[data-action="open"]')?.textContent ?? '',
    }
  })
  const sections = [...area.querySelectorAll<HTMLElement>('[data-map-section]')].map(
    (section) => section.getBoundingClientRect().top - box.top,
  )
  return { cards, sections, width: box.width || 1, height: box.height || 1 }
}

/** The top of the part of the screen not covered by the sticky toolbar. */
const visibleTop = (toolbar: HTMLElement | null) => Math.max(0, toolbar?.getBoundingClientRect().bottom ?? 0)

/**
 * A scroll map: every card on the page, drawn as a small block in its
 * category's colour, with a lens over the part that's on screen. Click a
 * block to jump to that note; press anywhere else, or drag, to scroll there.
 *
 * It's a pointer shortcut, like a scrollbar, so it's hidden from screen
 * readers and skipped by Tab: the page itself stays the way to reach a note.
 */
export function NoteMap({ content, toolbar, layoutKey }: NoteMapProps) {
  const track = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLDivElement>(null)
  const lens = useRef<HTMLDivElement>(null)
  const [layout, setLayout] = useState<Layout>(EMPTY)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [hovered, setHovered] = useState<MapCard | null>(null)
  const categories = useCategoryCatalog()
  const [dragging, setDragging] = useState(false)
  const press = useRef<{ startY: number; moved: boolean } | null>(null)

  const scaleX = size.width / layout.width
  const scaleY = Math.min(size.height / layout.height, MAX_SCALE)

  // Re-read the cards whenever the list or the track changes size. A
  // ResizeObserver always reports once as soon as it starts watching, so
  // starting a fresh one when layoutKey changes (a new sort moves cards
  // without resizing anything) re-reads them then too, a frame later.
  useEffect(() => {
    const area = content.current
    const trackNode = canvas.current
    if (!area || !trackNode || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === trackNode) {
          setSize({ width: trackNode.clientWidth, height: trackNode.clientHeight })
        } else {
          setLayout(readLayout(area))
        }
      }
    })
    observer.observe(area)
    observer.observe(trackNode)
    return () => observer.disconnect()
  }, [content, layoutKey])

  // The lens follows the page's scroll position, once per frame at most. It
  // is moved directly rather than through React state, so scrolling never
  // re-renders the map.
  useEffect(() => {
    const area = content.current
    const node = lens.current
    if (!area || !node) return
    let frame = 0
    const place = () => {
      frame = 0
      const box = area.getBoundingClientRect()
      const bottom = box.height * scaleY
      const from = Math.min(Math.max((visibleTop(toolbar.current) - box.top) * scaleY, 0), bottom)
      const to = Math.min(Math.max((window.innerHeight - box.top) * scaleY, 0), bottom)
      node.style.translate = `0 ${from}px`
      node.style.height = `${to - from}px`
      node.style.opacity = to - from > 1 ? '1' : '0'
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(place)
    }
    place()
    window.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
    }
  }, [content, toolbar, scaleY, layout])

  function mapPoint(event: PointerEvent) {
    const rect = canvas.current?.getBoundingClientRect()
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) }
  }

  function cardAt(event: PointerEvent): MapCard | null {
    const { x, y } = mapPoint(event)
    // Blocks are thin, so the whole row's height and a little either side counts.
    return (
      layout.cards.find(
        (card) =>
          y >= card.y * scaleY - 1 &&
          y <= (card.y + card.height) * scaleY + 1 &&
          x >= card.x * scaleX - 2 &&
          x <= (card.x + card.width) * scaleX + 2,
      ) ?? null
    )
  }

  /** Scroll so the spot under the pointer is in the middle of the visible part of the screen. */
  function scrollToMapY(y: number, behavior: ScrollBehavior) {
    const area = content.current
    if (!area || !scaleY) return
    const top = visibleTop(toolbar.current)
    const middle = top + (window.innerHeight - top) / 2
    const target = area.getBoundingClientRect().top + y / scaleY - middle
    window.scrollTo({ top: window.scrollY + target, behavior })
  }

  function jumpTo(card: MapCard) {
    const item = content.current?.querySelector<HTMLElement>(`li[data-note-id="${card.id}"]`)
    if (!item) return
    const reduce = prefersReducedMotion()
    item.scrollIntoView({ block: 'center', behavior: reduce ? 'instant' : 'smooth' })
    // A ring pulses round the card once it has scrolled into place, so the
    // eye lands on the right one among many alike.
    const ring = getComputedStyle(document.documentElement).getPropertyValue('--ink').trim()
    item.firstElementChild?.animate(
      [
        { boxShadow: `0 0 0 0 ${ring}` },
        { boxShadow: `0 0 0 5px ${ring}`, offset: 0.3 },
        { boxShadow: '0 0 0 0 transparent' },
      ],
      { duration: 1000, delay: reduce ? 0 : 380, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' },
    )
  }

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return
    // No text selection or native drag while scrubbing.
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    press.current = { startY: event.clientY, moved: false }
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    const current = press.current
    if (!current) {
      const card = cardAt(event)
      if (card?.id !== hovered?.id) setHovered(card)
      return
    }
    if (!current.moved && Math.abs(event.clientY - current.startY) < DRAG_THRESHOLD) return
    if (!current.moved) {
      current.moved = true
      setDragging(true)
      setHovered(null)
    }
    scrollToMapY(mapPoint(event).y, 'instant')
  }

  function handlePointerUp(event: PointerEvent<HTMLDivElement>) {
    const current = press.current
    press.current = null
    setDragging(false)
    if (!current || current.moved) return
    const card = cardAt(event)
    if (card) jumpTo(card)
    else scrollToMapY(mapPoint(event).y, prefersReducedMotion() ? 'instant' : 'smooth')
  }

  const empty = layout.cards.length === 0

  return (
    <div className={styles.map} aria-hidden="true" data-empty={empty || undefined}>
      <div
        ref={track}
        className={styles.track}
        data-dragging={dragging || undefined}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={() => {
          press.current = null
          setDragging(false)
        }}
        onPointerLeave={() => setHovered(null)}
      >
        <div ref={canvas} className={styles.canvas}>
          {layout.sections.map((y, index) =>
            index === 0 ? null : (
              <span key={index} className={styles.section} style={{ translate: `0 ${y * scaleY - 3}px` }} />
            ),
          )}
          {layout.cards.map((card) => (
            <span
              key={card.id}
              className={styles.card}
              // From the catalog, not the list, so a new colour shows at once.
              data-color={categories.look(card.category).color}
              data-done={card.done || undefined}
              data-hovered={card.id === hovered?.id || undefined}
              style={
                {
                  width: Math.max(card.width * scaleX - 2, 2),
                  height: Math.max(card.height * scaleY - 2, 2),
                  translate: `${card.x * scaleX + 1}px ${card.y * scaleY + 1}px`,
                } as CSSProperties
              }
            />
          ))}
          <div ref={lens} className={styles.lens} />
        </div>

        {hovered && (
          <p
            className={styles.label}
            style={{ top: `calc(0.5rem + ${(hovered.y + hovered.height / 2) * scaleY}px)` }}
          >
            {hovered.title}
          </p>
        )}
      </div>
    </div>
  )
}
