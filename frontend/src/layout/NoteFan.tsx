import type { CSSProperties } from 'react'
import type { BuiltInCategory } from '../api/notes'
import { CATEGORY_META } from '../notes/categories'
import styles from './NoteFan.module.css'

/** One card per category, titled like the sample notes, so the picture shows what the app holds. */
const CARDS: { category: BuiltInCategory; title: string }[] = [
  { category: 'personal', title: 'Renew passport' },
  { category: 'shopping', title: 'Weekend market list' },
  { category: 'work', title: 'Prepare the Q4 roadmap review' },
  { category: 'health', title: 'Book a dentist appointment' },
  { category: 'ideas', title: 'App idea: shared grocery lists' },
]

/**
 * Five pastel notes fanned out like a hand of cards. A picture only: hidden
 * from screen readers, which hear the words next to it instead.
 */
export function NoteFan({ size = 'large' }: { size?: 'large' | 'small' }) {
  const middle = (CARDS.length - 1) / 2
  return (
    <div className={styles.fan} data-size={size} aria-hidden="true">
      {CARDS.map(({ category, title }, index) => {
        const { label, Icon, fill } = CATEGORY_META[category]
        const offset = index - middle
        const style = {
          '--offset': offset,
          '--distance': Math.abs(offset),
          '--fill': fill,
        } as CSSProperties
        return (
          <div key={category} className={styles.card} style={style}>
            <span className={styles.head}>
              <span className={styles.icon}>
                <Icon size={size === 'large' ? 16 : 13} />
              </span>
              <span className={styles.words}>{label}</span>
            </span>
            <span className={`${styles.title} ${styles.words}`}>{title}</span>
          </div>
        )
      })}
    </div>
  )
}
