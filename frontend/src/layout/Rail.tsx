import {
  CalendarDays,
  CircleCheck,
  LayoutGrid,
  LogOut,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Pin,
  Sun,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useId, useRef, useState, type CSSProperties } from 'react'
import type { User } from '../api/auth'
import type { View } from '../notes/selectNotes'
import type { Theme } from '../theme/useTheme'
import { Logo } from './Logo'
import styles from './Rail.module.css'

const VIEWS: { id: View; label: string; Icon: LucideIcon }[] = [
  { id: 'all', label: 'All notes', Icon: LayoutGrid },
  { id: 'today', label: 'Today', Icon: CalendarDays },
  { id: 'pinned', label: 'Pinned', Icon: Pin },
  { id: 'done', label: 'Done', Icon: CircleCheck },
]

interface RailProps {
  view: View
  onViewChange: (view: View) => void
  /** Open notes due today or overdue. Marks the Today button with a dot. */
  dueCount: number
  theme: Theme
  /** Gets the button, so the new theme can spread out from it. */
  onToggleTheme: (origin: HTMLElement) => void
  /** Wide screens: names beside the icons instead of in tooltips. */
  expanded: boolean
  onToggleExpanded: () => void
  user: User
  onLogOut: () => void
  loggingOut: boolean
}

/** The icon column on wide screens, which can widen to show names; a bottom tab bar on phones. */
export function Rail({
  view,
  onViewChange,
  dueCount,
  theme,
  onToggleTheme,
  expanded,
  onToggleExpanded,
  user,
  onLogOut,
  loggingOut,
}: RailProps) {
  // The theme icon only spins after a switch, not on every page load.
  const [switched, setSwitched] = useState(false)
  const themeLabel = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'
  const toggleLabel = expanded ? 'Collapse sidebar' : 'Expand sidebar'
  const active = VIEWS.findIndex((item) => item.id === view)

  return (
    <nav className={styles.rail} data-expanded={expanded || undefined} aria-label="Views">
      <div className={styles.head}>
        <div className={styles.logo}>
          <Logo />
        </div>
        <span className={styles.brand}>Notes</span>
      </div>

      <div className={styles.viewsWrap} style={{ '--active': active } as CSSProperties}>
        {/* One black shape that slides to the current view, instead of each button
            switching colour on its own. */}
        <span className={styles.indicator} aria-hidden="true" />
        <ul className={styles.views}>
          {VIEWS.map(({ id, label, Icon }) => {
            const due = id === 'today' && dueCount > 0
            const name = due ? `${label} (${dueCount} due)` : label
            return (
              <li key={id}>
                <button
                  type="button"
                  className={styles.button}
                  aria-current={view === id ? 'page' : undefined}
                  aria-label={name}
                  data-tip={name}
                  data-tip-side="right"
                  onClick={() => onViewChange(id)}
                >
                  <span className={styles.circle}>
                    <Icon size={20} aria-hidden="true" />
                    {due && <span className={styles.dot} />}
                  </span>
                  <span className={styles.label} aria-hidden="true">
                    {label}
                  </span>
                  {due && (
                    <span className={styles.badge} aria-hidden="true">
                      {dueCount}
                    </span>
                  )}
                </button>
              </li>
            )
          })}
        </ul>
      </div>

      <div className={styles.foot}>
        <button
          type="button"
          className={`${styles.button} ${styles.quiet} ${styles.toggle}`}
          aria-label={toggleLabel}
          data-tip={toggleLabel}
          data-tip-side="right"
          onClick={onToggleExpanded}
        >
          <span className={styles.circle}>
            {expanded ? (
              <PanelLeftClose size={20} aria-hidden="true" />
            ) : (
              <PanelLeftOpen size={20} aria-hidden="true" />
            )}
          </span>
          <span className={styles.label} aria-hidden="true">
            Collapse
          </span>
        </button>

        <button
          type="button"
          className={`${styles.button} ${styles.quiet}`}
          aria-label={themeLabel}
          data-tip={themeLabel}
          data-tip-side="right"
          onClick={(event) => {
            setSwitched(true)
            onToggleTheme(event.currentTarget)
          }}
        >
          <span className={styles.circle}>
            <span key={theme} className={styles.themeIcon} data-spin={switched || undefined}>
              {theme === 'dark' ? (
                <Sun size={20} aria-hidden="true" />
              ) : (
                <Moon size={20} aria-hidden="true" />
              )}
            </span>
          </span>
          {/* The phone tab bar has room for one short word. */}
          <span className={styles.label} aria-hidden="true">
            <span className={styles.long}>{theme === 'dark' ? 'Light theme' : 'Dark theme'}</span>
            <span className={styles.short}>Theme</span>
          </span>
        </button>

        <Account user={user} onLogOut={onLogOut} loggingOut={loggingOut} />
      </div>
    </nav>
  )
}

interface AccountProps {
  user: User
  onLogOut: () => void
  loggingOut: boolean
}

/**
 * The person's initial at the foot of the rail. It opens a small panel with
 * their name, email and Log out: a disclosure, not a menu, so Tab moves
 * through it like the rest of the page.
 */
function Account({ user, onLogOut, loggingOut }: AccountProps) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const panelId = useId()
  const name = `Account (${user.name})`
  // Array.from keeps an emoji or accented letter whole.
  const initial = Array.from(user.name.trim())[0]?.toUpperCase() ?? '?'

  // A press anywhere else closes it, like the browser's own menus.
  useEffect(() => {
    if (!open) return
    const closeFromOutside = (event: PointerEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', closeFromOutside)
    return () => document.removeEventListener('pointerdown', closeFromOutside)
  }, [open])

  return (
    <div
      ref={wrap}
      className={styles.account}
      onKeyDown={(event) => {
        if (!open || event.key !== 'Escape') return
        event.stopPropagation()
        setOpen(false)
        button.current?.focus()
      }}
      onBlur={(event) => {
        // Tabbing past the panel closes it; moving between its parts doesn't.
        if (open && !event.currentTarget.contains(event.relatedTarget)) setOpen(false)
      }}
    >
      <button
        ref={button}
        type="button"
        className={styles.button}
        aria-label={name}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        data-tip={name}
        data-tip-side="right"
        onClick={() => setOpen((current) => !current)}
      >
        <span className={`${styles.circle} ${styles.avatar}`} aria-hidden="true">
          {/* In its own element, so a press can sink it like the icons. */}
          <span>{initial}</span>
        </span>
        <span className={styles.label} aria-hidden="true">
          <span className={styles.long}>{user.name}</span>
          <span className={styles.short}>Account</span>
        </span>
      </button>

      {open && (
        // Focusable, so a click on its text keeps focus inside and the blur rule above leaves it open.
        <div id={panelId} className={styles.panel} tabIndex={-1}>
          <p className={styles.accountName}>{user.name}</p>
          <p className={styles.accountEmail}>{user.email}</p>
          <button
            type="button"
            className={styles.logOut}
            aria-disabled={loggingOut || undefined}
            onClick={() => {
              if (!loggingOut) onLogOut()
            }}
          >
            <LogOut size={18} aria-hidden="true" />
            {loggingOut ? 'Logging out…' : 'Log out'}
          </button>
        </div>
      )}
    </div>
  )
}
