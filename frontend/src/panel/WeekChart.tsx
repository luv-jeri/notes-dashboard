import type { CSSProperties } from 'react'
import type { Note } from '../api/notes'
import type { CategoryCatalog } from '../notes/categories'
import { formatWeekday, formatWeekdayLong } from '../notes/dates'
import type { DayTally } from '../notes/selectNotes'
import { formatCount } from '../notes/text'
import { useCategoryCatalog } from '../notes/useCategories'
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
  const categories = useCategoryCatalog()

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
                      style={{ backgroundColor: categories.look(note.category).strong }}
                    />
                  ))
                : countByCategory(day.notes, categories).map(([category, count]) => (
                    <span
                      key={category}
                      className={styles.segment}
                      style={
                        { backgroundColor: categories.look(category).strong, '--count': count } as CSSProperties
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

/**
 * Notes per category, built-in categories first, then the person's own in
 * the order they were added. A note in an unknown category counts as
 * Personal, which is how its card shows too.
 */
function countByCategory(notes: Note[], categories: CategoryCatalog): [string, number][] {
  const counts = new Map(categories.options.map((look) => [look.key, 0]))
  for (const note of notes) {
    const { key } = categories.look(note.category)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts].filter(([, count]) => count > 0)
}
