import { LayoutGrid, Pencil } from 'lucide-react'
import { useState } from 'react'
import { CategoryGlyph } from './CategoryGlyph'
import { CategoryManager } from './CategoryManager'
import type { CategoryFilter } from './selectNotes'
import { useCategoryCatalog } from './useCategories'
import styles from './CategoryPills.module.css'

interface CategoryPillsProps {
  value: CategoryFilter
  onChange: (value: CategoryFilter) => void
}

/** All, the built-in categories, then the person's own, and the way to change those. */
export function CategoryPills({ value, onChange }: CategoryPillsProps) {
  const { options } = useCategoryCatalog()
  const [managing, setManaging] = useState(false)

  return (
    <>
      <div className={styles.pills} role="group" aria-label="Filter by category">
        <button type="button" className={styles.pill} aria-pressed={value === 'all'} onClick={() => onChange('all')}>
          <span className={`${styles.icon} ${styles.allIcon}`}>
            <LayoutGrid size={16} aria-hidden="true" />
          </span>
          All
        </button>
        {options.map((look) => (
          <button
            key={look.key}
            type="button"
            className={styles.pill}
            aria-pressed={value === look.key}
            onClick={() => onChange(look.key)}
          >
            <span className={styles.icon} style={{ backgroundColor: look.fill }}>
              <CategoryGlyph look={look} />
            </span>
            {look.label}
          </button>
        ))}
        <button
          type="button"
          className={`${styles.pill} ${styles.edit}`}
          aria-haspopup="dialog"
          onClick={() => setManaging(true)}
        >
          <span className={styles.icon}>
            <Pencil size={16} aria-hidden="true" />
          </span>
          Edit categories
        </button>
      </div>

      {managing && (
        <CategoryManager
          onClose={() => setManaging(false)}
          // A filter for a category that's gone would show nothing, so show everything.
          onDeleted={(key) => {
            if (value === key) onChange('all')
          }}
        />
      )}
    </>
  )
}
