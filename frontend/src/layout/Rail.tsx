import {
  CalendarDays,
  CircleCheck,
  LayoutGrid,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Pin,
  Sun,
  type LucideIcon,
} from 'lucide-react'
import { useState, type CSSProperties } from 'react'
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
      </div>
    </nav>
  )
}
