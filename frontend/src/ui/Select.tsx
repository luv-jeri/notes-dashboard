import { Check, ChevronDown, type LucideIcon } from 'lucide-react'
import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent } from 'react'
import styles from './Select.module.css'

export interface SelectOption<T extends string> {
  value: T
  label: string
}

interface SelectProps<T extends string> {
  /** Shown in front of the value, and the control's name for screen readers. */
  label: string
  value: T
  options: readonly SelectOption<T>[]
  onChange: (value: T) => void
  /** On phones the button shrinks to this icon; the label and value stay readable to screen readers. */
  icon?: LucideIcon
}

/**
 * A select drawn in the app's own style: a pill that opens a list below it.
 * It follows the ARIA "select-only combobox" pattern, so it behaves like a
 * native select: focus stays on the button while arrow keys, Home, End and
 * typed letters move through the list, Enter or Space picks, Escape closes.
 */
export function Select<T extends string>({ label, value, options, onChange, icon: Icon }: SelectProps<T>) {
  const id = useId()
  const labelId = `${id}-label`
  const listId = `${id}-list`
  const optionId = (index: number) => `${id}-option-${index}`

  const [open, setOpen] = useState(false)
  // The option the keyboard or pointer is on while the list is open.
  const [active, setActive] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const typed = useRef({ text: '', timer: 0 })

  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  )
  const last = options.length - 1

  function show(index = selectedIndex) {
    setActive(index)
    setOpen(true)
  }

  function choose(index: number) {
    const option = options[index]
    if (option && option.value !== value) onChange(option.value)
    setOpen(false)
  }

  // A press anywhere outside closes the list, like a native select.
  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [open])

  // Keep the active option in view when the list is long enough to scroll.
  // Only the list scrolls: scrollIntoView would also scroll the page, and the
  // list lives in the sticky toolbar, which the page can't scroll anyway.
  useEffect(() => {
    const list = listRef.current
    const option = open ? document.getElementById(optionId(active)) : null
    if (!list || !option) return
    const bottom = option.offsetTop + option.offsetHeight
    if (option.offsetTop < list.scrollTop) list.scrollTop = option.offsetTop
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight
  })

  /**
   * Type-ahead: letters typed within half a second search together ("du"
   * finds "Due date"). Pressing one letter again moves to the next option
   * that starts with it.
   */
  function findTyped(key: string): number | undefined {
    const state = typed.current
    window.clearTimeout(state.timer)
    state.text += key.toLowerCase()
    state.timer = window.setTimeout(() => (state.text = ''), 500)

    const sameLetter = [...state.text].every((letter) => letter === state.text[0])
    const query = sameLetter ? state.text[0] : state.text
    const from = (open ? active : selectedIndex) + (sameLetter ? 1 : 0)
    for (let step = 0; step < options.length; step++) {
      const index = (from + step) % options.length
      if (options[index].label.toLowerCase().startsWith(query)) return index
    }
    return undefined
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const { key, altKey } = event
    const printable = key.length === 1 && key !== ' ' && !event.metaKey && !event.ctrlKey && !altKey

    if (!open) {
      const opening: Record<string, number> = {
        ArrowDown: selectedIndex,
        ArrowUp: selectedIndex,
        Enter: selectedIndex,
        ' ': selectedIndex,
        Home: 0,
        End: last,
      }
      if (key in opening) {
        // Handled here, so the button's own click (Enter, Space) doesn't follow.
        event.preventDefault()
        show(opening[key])
      } else if (printable) {
        const match = findTyped(key)
        if (match !== undefined) show(match)
      }
      return
    }

    switch (key) {
      case 'ArrowDown':
        event.preventDefault()
        setActive((index) => Math.min(index + 1, last))
        break
      case 'ArrowUp':
        event.preventDefault()
        if (altKey) choose(active)
        else setActive((index) => Math.max(index - 1, 0))
        break
      case 'Home':
      case 'PageUp':
        event.preventDefault()
        setActive(0)
        break
      case 'End':
      case 'PageDown':
        event.preventDefault()
        setActive(last)
        break
      case 'Enter':
      case ' ':
        event.preventDefault()
        choose(active)
        break
      case 'Escape':
        event.preventDefault()
        // Closing the list is all Escape does here.
        event.stopPropagation()
        setOpen(false)
        break
      case 'Tab':
        // As in a native select: leaving keeps the option you were on.
        choose(active)
        break
      default:
        if (printable) {
          const match = findTyped(key)
          if (match !== undefined) setActive(match)
        }
    }
  }

  function handleClick(event: MouseEvent<HTMLButtonElement>) {
    // detail is 0 for a click made by the keyboard, which handleKeyDown already handled.
    if (event.detail === 0) return
    if (open) setOpen(false)
    else show()
  }

  const selected = options[selectedIndex]

  return (
    <div ref={root} className={styles.select}>
      <button
        type="button"
        role="combobox"
        className={Icon ? `${styles.trigger} ${styles.hasIcon}` : styles.trigger}
        aria-labelledby={labelId}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open ? optionId(active) : undefined}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        onBlur={() => setOpen(false)}
      >
        {Icon && <Icon className={styles.icon} size={18} aria-hidden="true" />}
        {/* Names the control. Hidden from the button's own text, so the value reads on its own. */}
        <span id={labelId} className={styles.label} aria-hidden="true">
          {label}
        </span>
        <span className={styles.value}>{selected?.label}</span>
        <ChevronDown className={styles.chevron} size={16} aria-hidden="true" />
      </button>

      <ul
        ref={listRef}
        id={listId}
        role="listbox"
        className={styles.list}
        aria-labelledby={labelId}
        hidden={!open}
        // Pressing an option must not take focus from the button, or the list would close first.
        onPointerDown={(event) => event.preventDefault()}
      >
        {options.map((option, index) => (
          <li
            key={option.value}
            id={optionId(index)}
            role="option"
            className={styles.option}
            aria-selected={option.value === value}
            data-active={(open && index === active) || undefined}
            style={{ '--index': index } as CSSProperties}
            onPointerMove={() => setActive(index)}
            onClick={() => choose(index)}
          >
            <span>{option.label}</span>
            <Check className={styles.check} size={16} strokeWidth={2.5} aria-hidden="true" />
          </li>
        ))}
      </ul>
    </div>
  )
}
