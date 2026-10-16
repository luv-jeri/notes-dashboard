import type { CSSProperties } from 'react'
import { CATEGORIES, type Note } from '../api/notes'
import { CATEGORY_META } from '../notes/categories'
import { formatWeekday, formatWeekdayLong } from '../notes/dates'
import type { DayTally } from '../notes/selectNotes'
import { formatCount } from '../notes/text'
import styles from './WeekChart.module.css'

/** Up to this many notes a day, each gets its own block. Past it, blocks would be slivers. */
const MAX_BLOCKS = 8

/**
 * One bar per day, one block per finished note in its category's colour. On a
 * very busy week, each bar shows one segment per category instead, sized by
 * its share. Screen readers get the same facts as a list: "Friday, today: 2 done".
 */
export function WeekChart({ days, today }: { days: DayTally[]; today: string }) {
  // At least three rows, so a single note doesn't look like a full bar.
  const rows = Math.max(3, ...days.map((day) => day.notes.length))
  const perNote = rows <= MAX_BLOCKS

  return (
    <ol className={styles.chart} style={{ '--rows': rows } as CSSProperties}>
      {days.map((day) => {
        const isToday = day.date === today
        return (
          <li key={day.date} className={isToday ? `${styles.day} ${styles.today}` : styles.day}>
            <span className="visually-hidden">
              {`${formatWeekdayLong(day.date)}${isToday ? ', today' : ''}: ${formatCount(day.notes.length)} done`}
            </span>
            <span className={styles.bar} aria-hidden="true">
              {perNote
                ? day.notes.map((note) => (
                    <span
                      key={note.id}
                      className={styles.block}
                      style={{ backgroundColor: CATEGORY_META[note.category].strong }}
                    />
                  ))
                : countByCategory(day.notes).map(([category, count]) => (
                    <span
                      key={category}
                      className={styles.segment}
                      style={
                        { backgroundColor: CATEGORY_META[category].strong, '--count': count } as CSSProperties
                      }
                    />
                  ))}
            </span>
            <span className={styles.label} aria-hidden="true">
              {formatWeekday(day.date)}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

function countByCategory(notes: Note[]) {
  const counts = new Map(CATEGORIES.map((category) => [category, 0]))
  for (const note of notes) counts.set(note.category, (counts.get(note.category) ?? 0) + 1)
  return [...counts].filter(([, count]) => count > 0)
}
