import { useId, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { CATEGORY_NAME_MAX, type CategoryColor, type CustomCategory } from '../api/categories'
import { isSessionEnded } from '../auth/session'
import { suggestColor } from './categories'
import { SwatchPicker } from './SwatchPicker'
import { useCategoryCatalog, useCreateCategory } from './useCategories'
import styles from './CategoryForm.module.css'

interface NewCategoryFormProps {
  /** The group's name for screen readers, unless a heading names it (labelledBy). */
  label?: string
  labelledBy?: string
  onAdded: (category: CustomCategory) => void
  /** Shows Cancel, and lets Escape close the form without closing the dialog around it. */
  onCancel?: () => void
  autoFocus?: boolean
  nameRef?: RefObject<HTMLInputElement | null>
}

/**
 * A name and a colour. Not a <form>: it also sits inside the note editor's
 * form, and forms can't nest. Enter in the name field adds, as a form would.
 */
export function NewCategoryForm({ label, labelledBy, onAdded, onCancel, autoFocus, nameRef }: NewCategoryFormProps) {
  const { custom } = useCategoryCatalog()
  const create = useCreateCategory()
  const [name, setName] = useState('')
  // Until someone picks a colour, the suggestion follows the categories they have.
  const [picked, setPicked] = useState<CategoryColor | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fallbackRef = useRef<HTMLInputElement>(null)
  const nameInput = nameRef ?? fallbackRef
  const ids = useId()
  const color = picked ?? suggestColor(custom)

  function add() {
    if (create.isPending) return
    const trimmed = name.trim()
    if (!trimmed) {
      setError('Give the category a name.')
      nameInput.current?.focus()
      return
    }
    create.mutate(
      { name: trimmed, color },
      {
        onSuccess: (created) => {
          setName('')
          setPicked(null)
          setError(null)
          onAdded(created)
        },
        onError: (failure) => {
          // The log-in screen takes over.
          if (isSessionEnded(failure)) return
          setError(failure.message)
          nameInput.current?.focus()
        },
      },
    )
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    // Enter on the name or a swatch would otherwise submit the note around it.
    if (event.key === 'Enter' && event.target instanceof HTMLInputElement && !event.nativeEvent.isComposing) {
      event.preventDefault()
      add()
    } else if (event.key === 'Escape' && onCancel) {
      // Cancelling the keydown stops the dialog closing too.
      event.preventDefault()
      event.stopPropagation()
      onCancel()
    }
  }

  return (
    <div
      role="group"
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      className={styles.form}
      onKeyDown={handleKeyDown}
    >
      <div className={styles.field}>
        <label className={styles.label} htmlFor={`${ids}-name`}>
          Name
        </label>
        <input
          ref={nameInput}
          id={`${ids}-name`}
          className={styles.input}
          value={name}
          maxLength={CATEGORY_NAME_MAX}
          autoComplete="off"
          autoFocus={autoFocus}
          aria-invalid={error !== null}
          aria-describedby={error ? `${ids}-error` : undefined}
          onChange={(event) => {
            setName(event.target.value)
            setError(null)
          }}
        />
        {error && (
          <p id={`${ids}-error`} className={styles.error}>
            {error}
          </p>
        )}
      </div>

      <SwatchPicker name={`${ids}-color`} legend="Colour" value={color} onChange={setPicked} />

      <div className={styles.actions}>
        {onCancel && (
          <button type="button" className="button button-quiet" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button type="button" className="button button-primary" aria-disabled={create.isPending || undefined} onClick={add}>
          {create.isPending ? 'Adding…' : 'Add'}
        </button>
      </div>
    </div>
  )
}
