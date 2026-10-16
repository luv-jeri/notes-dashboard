import { CalendarClock, PanelRightClose, PanelRightOpen } from 'lucide-react'
import { memo, useMemo, useRef, type CSSProperties } from 'react'
import { flushSync } from 'react-dom'
import type { Note } from '../api/notes'
import { CATEGORY_META } from '../notes/categories'
import { dueStatus, formatDueInline, formatLongDate, formatWeekday } from '../notes/dates'
import { countDue, doneByDay, dueSoon } from '../notes/selectNotes'
import { formatCount } from '../notes/text'
import { WeekChart } from './WeekChart'
import styles from './SidePanel.module.css'

interface SidePanelProps {
  /** Undefined until the first load finishes. */
  notes: Note[] | undefined
  today: string
  now: Date
  onOpen: (note: Note) => void
  /** Wide screens fold the panel into a strip. Narrower ones always show it in full, under the notes. */
  collapsed: boolean
  onToggleCollapsed: () => void
}

/** Memoised: typing in search re-renders the dashboard, but none of this changes. */
export const SidePanel = memo(function SidePanel({
  notes,
  today,
  now,
  onOpen,
  collapsed,
  onToggleCollapsed,
}: SidePanelProps) {
  const collapseButton = useRef<HTMLButtonElement>(null)
  const expandButton = useRef<HTMLButtonElement>(null)

  // The pressed button disappears with its half of the panel, so focus moves
  // to the button that undoes it, in the half that just appeared.
  function toggle() {
    flushSync(onToggleCollapsed)
    ;(collapsed ? collapseButton : expandButton).current?.focus({ preventScroll: true })
  }

  return (
    <aside className={styles.panel} data-collapsed={collapsed || undefined} aria-labelledby="panel-date">
      {/* The folded panel: today's date, progress and what's due, at a glance.
          A click anywhere on it opens the panel; the button does the same for keyboards. */}
      <div className={styles.strip} onClick={(event) => event.target === event.currentTarget && toggle()}>
        <button
          ref={expandButton}
          type="button"
          className={`icon-button ${styles.toggle}`}
          aria-label="Expand panel"
          data-tip="Expand panel"
          data-tip-side="left"
          onClick={toggle}
        >
          <PanelRightOpen size={18} aria-hidden="true" />
        </button>
        <p className={styles.stripDay}>
          <span className={styles.stripWeekday}>{formatWeekday(today)}</span>
          <span className={styles.stripDate}>{now.getDate()}</span>
        </p>
        {notes && <ProgressRing notes={notes} />}
        {notes && <DueBadge notes={notes} today={today} />}
      </div>

      <div className={styles.inner}>
        <div className={styles.summary}>
          <div className={styles.summaryHead}>
            <h2 id="panel-date" className={styles.date}>
              {formatLongDate(now)}
            </h2>
            <button
              ref={collapseButton}
              type="button"
              className={`icon-button ${styles.toggle} ${styles.collapse}`}
              aria-label="Collapse panel"
              data-tip="Collapse panel"
              data-tip-side="left"
              onClick={toggle}
            >
              <PanelRightClose size={18} aria-hidden="true" />
            </button>
          </div>
          {notes ? (
            <Progress notes={notes} />
          ) : (
            <p className={styles.muted}>Your progress shows here once your notes load.</p>
          )}
        </div>
        {notes && <WeekCard notes={notes} today={today} />}
        {notes && <DueSoon notes={notes} today={today} onOpen={onOpen} />}
      </div>
    </aside>
  )
})

const useDoneCount = (notes: Note[]) => useMemo(() => notes.filter((note) => note.done).length, [notes])

function Progress({ notes }: { notes: Note[] }) {
  const done = useDoneCount(notes)
  const share = notes.length ? (done / notes.length) * 100 : 0
  return (
    <div className={styles.progress}>
      <p>
        <span className={styles.progressNumber}>{formatCount(done)}</span> of{' '}
        {formatCount(notes.length)} done
      </p>
      <span className={styles.track} aria-hidden="true">
        <span className={styles.fill} style={{ width: `${share}%` }} />
      </span>
    </div>
  )
}

/** The progress bar, curled into a ring that fits the folded panel. */
function ProgressRing({ notes }: { notes: Note[] }) {
  const done = useDoneCount(notes)
  const share = notes.length ? Math.round((done / notes.length) * 100) : 0
  return (
    <p className={styles.ring}>
      <svg viewBox="0 0 40 40" aria-hidden="true">
        <circle className={styles.ringTrack} cx="20" cy="20" r="17" />
        {/* pathLength 100 makes the dash length a percentage. */}
        <circle
          className={styles.ringFill}
          cx="20"
          cy="20"
          r="17"
          pathLength={100}
          strokeDasharray={`${share} 100`}
        />
      </svg>
      <span aria-hidden="true">{share}%</span>
      <span className="visually-hidden">
        {formatCount(done)} of {formatCount(notes.length)} done
      </span>
    </p>
  )
}

function DueBadge({ notes, today }: { notes: Note[]; today: string }) {
  const { dueToday, overdue } = useMemo(() => countDue(notes, today), [notes, today])
  const total = dueToday + overdue
  const label =
    overdue > 0
      ? `${formatCount(total)} due today or overdue`
      : `${formatCount(total)} due today`
  return (
    <p className={overdue > 0 ? `${styles.dueBadge} ${styles.dueBadgeLate}` : styles.dueBadge}>
      <CalendarClock size={18} aria-hidden="true" />
      <span aria-hidden="true">{formatCount(total)}</span>
      <span className="visually-hidden">{label}</span>
    </p>
  )
}

function WeekCard({ notes, today }: { notes: Note[]; today: string }) {
  const days = useMemo(() => doneByDay(notes, today), [notes, today])
  const total = days.reduce((sum, day) => sum + day.notes.length, 0)
  const cheer = total >= 5 ? 'Great week!' : total > 0 ? 'Keep going' : null

  return (
    <section className={styles.card} aria-labelledby="week-heading">
      <h3 id="week-heading" className={styles.cardLabel}>
        Done in the last 7 days
      </h3>
      <div className={styles.weekTotal}>
        <span className={styles.bigNumber}>{formatCount(total)}</span>
        {cheer && <span className={styles.cheer}>{cheer}</span>}
      </div>
      <WeekChart days={days} today={today} />
    </section>
  )
}

function DueSoon({
  notes,
  today,
  onOpen,
}: {
  notes: Note[]
  today: string
  onOpen: (note: Note) => void
}) {
  const soon = useMemo(() => dueSoon(notes, 3), [notes])

  return (
    <section className={styles.dueSection} aria-labelledby="due-heading">
      <h3 id="due-heading" className={styles.sectionLabel}>
        Due soon
      </h3>
      {soon.length === 0 ? (
        <p className={styles.muted}>Nothing has a due date. Add one to a note and it shows here.</p>
      ) : (
        <ul className={styles.dueList}>
          {soon.map((note) => {
            const { Icon, fill } = CATEGORY_META[note.category]
            const due = note.due_date as string
            const overdue = dueStatus(due, today) === 'overdue'
            return (
              <li key={note.id}>
                <button
                  type="button"
                  className={styles.dueCard}
                  style={{ '--due-fill': fill } as CSSProperties}
                  onClick={() => onOpen(note)}
                >
                  <span className={styles.dueIcon}>
                    <Icon size={16} aria-hidden="true" />
                  </span>
                  <span className={styles.dueText}>
                    <span className={styles.dueTitle}>{note.title}</span>
                    <span className={overdue ? `${styles.dueWhen} ${styles.overdue}` : styles.dueWhen}>
                      {overdue
                        ? `Overdue, was due ${formatDueInline(due, today)}`
                        : `Due ${formatDueInline(due, today)}`}
                    </span>
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
