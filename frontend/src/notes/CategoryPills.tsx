import { LayoutGrid } from 'lucide-react'
import { CATEGORIES } from '../api/notes'
import { CATEGORY_META } from './categories'
import type { CategoryFilter } from './selectNotes'
import styles from './CategoryPills.module.css'

interface CategoryPillsProps {
  value: CategoryFilter
  onChange: (value: CategoryFilter) => void
}

const OPTIONS: { id: CategoryFilter; label: string; Icon: typeof LayoutGrid; fill: string }[] = [
  { id: 'all', label: 'All', Icon: LayoutGrid, fill: 'var(--raised)' },
  ...CATEGORIES.map((id) => ({ id, ...CATEGORY_META[id] })),
]

export function CategoryPills({ value, onChange }: CategoryPillsProps) {
  return (
    <div className={styles.pills} role="group" aria-label="Filter by category">
      {OPTIONS.map(({ id, label, Icon, fill }) => (
        <button
          key={id}
          type="button"
          className={styles.pill}
          aria-pressed={value === id}
          onClick={() => onChange(id)}
        >
          <span className={styles.icon} style={{ backgroundColor: fill }}>
            <Icon size={16} aria-hidden="true" />
          </span>
          {label}
        </button>
      ))}
    </div>
  )
}
