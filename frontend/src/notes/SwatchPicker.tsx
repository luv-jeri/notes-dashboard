import { Check } from 'lucide-react'
import type { CSSProperties } from 'react'
import { CATEGORY_COLORS, type CategoryColor } from '../api/categories'
import { COLOR_LABELS, colorVars } from './categories'
import styles from './CategoryForm.module.css'

interface SwatchPickerProps {
  /** Shared by the radios, so arrow keys move between them. */
  name: string
  legend: string
  /** For a picker whose row already says what it's for. */
  hideLegend?: boolean
  value: CategoryColor
  onChange: (color: CategoryColor) => void
}

/** The eight category colours as one radio group. */
export function SwatchPicker({ name, legend, hideLegend = false, value, onChange }: SwatchPickerProps) {
  return (
    <fieldset className={styles.picker}>
      <legend className={hideLegend ? 'visually-hidden' : styles.label}>{legend}</legend>
      <div className={styles.swatches}>
        {CATEGORY_COLORS.map((color) => (
          <label
            key={color}
            className={styles.swatch}
            style={{ '--swatch': colorVars(color).fill } as CSSProperties}
          >
            <input
              type="radio"
              className="visually-hidden"
              name={name}
              value={color}
              checked={value === color}
              onChange={() => onChange(color)}
            />
            <span className={styles.dot} aria-hidden="true">
              <Check size={16} strokeWidth={2.5} />
            </span>
            <span className="visually-hidden">{COLOR_LABELS[color]}</span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}
