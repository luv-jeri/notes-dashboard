import type { CategoryLook } from './categories'
import styles from './CategoryGlyph.module.css'

/** What sits in a category's circle: its icon, or for a person's own category, its first letter. */
export function CategoryGlyph({ look, size = 16 }: { look: CategoryLook; size?: number }) {
  const { Icon } = look
  if (Icon) return <Icon size={size} aria-hidden="true" />
  return (
    <span className={styles.monogram} style={{ fontSize: `${size / 16}rem` }} aria-hidden="true">
      {look.monogram}
    </span>
  )
}
