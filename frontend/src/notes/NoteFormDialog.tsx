import { X } from 'lucide-react'
import { useEffect, useId, useRef, useState, type CSSProperties, type SubmitEvent } from 'react'
import {
  CATEGORIES,
  CONTENT_MAX,
  TITLE_MAX,
  toInput,
  type Category,
  type Note,
  type NoteInput,
} from '../api/notes'
import { CATEGORY_META } from './categories'
import { addDays } from './dates'
import { formatCount } from './text'
import styles from './NoteFormDialog.module.css'

export type NoteDefaults = Partial<Pick<NoteInput, 'category' | 'due_date' | 'pinned'>>

interface NoteFormDialogProps {
  /** The note to edit. Leave out to write a new one. */
  note?: Note
  /** Starting values for a new note, taken from the current view and filter. */
  defaults?: NoteDefaults
  /** Today's local date, "YYYY-MM-DD". */
  today: string
  onSubmit: (input: NoteInput) => void
  onClose: () => void
}

export function NoteFormDialog({ note, defaults = {}, today, onSubmit, onClose }: NoteFormDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const titleRef = useRef<HTMLTextAreaElement>(null)
  const [title, setTitle] = useState(note?.title ?? '')
  const [content, setContent] = useState(note?.content ?? '')
  const [category, setCategory] = useState<Category>(note?.category ?? defaults.category ?? 'personal')
  const [dueDate, setDueDate] = useState(note?.due_date ?? defaults.due_date ?? '')
  const [pinned, setPinned] = useState(note?.pinned ?? defaults.pinned ?? false)
  const [titleError, setTitleError] = useState<string | null>(null)
  const ids = useId()
  const isEditing = note !== undefined

  // showModal() traps focus, closes on Escape, and returns focus to the
  // button that opened the dialog when it closes. On its own it would focus
  // the first button (Close), so move focus to the title, caret at the end.
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog || dialog.open) return
    dialog.showModal()
    const field = titleRef.current
    field?.focus()
    field?.setSelectionRange(field.value.length, field.value.length)
  }, [])

  function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    const input: NoteInput = {
      title: title.trim(),
      content: content.trim(),
      category,
      due_date: dueDate || null,
      pinned,
      done: note?.done ?? false,
    }
    if (!input.title) {
      setTitleError('Give the note a title.')
      titleRef.current?.focus()
      return
    }
    const unchanged = isEditing && JSON.stringify(input) === JSON.stringify(toInput(note))
    if (!unchanged) onSubmit(input)
    dialogRef.current?.close()
  }

  const close = () => dialogRef.current?.close()

  // The dialog is closed (focus is already back) the moment close() runs, but
  // it is still fading out. It leaves the page once that has finished.
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  function handleClose() {
    const fading = dialogRef.current?.getAnimations?.() ?? []
    if (fading.length === 0) {
      onClose()
      return
    }
    // Opening another note mid-fade replaces this dialog: then it's too late
    // to report closing, which would close the new one.
    void Promise.allSettled(fading.map((animation) => animation.finished)).then(() => {
      if (mounted.current) onClose()
    })
  }
  const quickDates = [
    { label: 'Today', value: today },
    { label: 'Tomorrow', value: addDays(today, 1) },
    { label: 'Next week', value: addDays(today, 7) },
  ]

  return (
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      aria-labelledby={`${ids}-heading`}
      onClose={handleClose}
    >
      <form className={styles.form} onSubmit={handleSubmit} noValidate>
        {/* The top half takes the category's colour: a preview of the card. */}
        <div
          className={styles.sheet}
          style={{ '--sheet-fill': CATEGORY_META[category].fill } as CSSProperties}
        >
          <div className={styles.sheetHead}>
            <h2 id={`${ids}-heading`} className={styles.heading}>
              {isEditing ? 'Edit note' : 'New note'}
            </h2>
            <button type="button" className={styles.close} aria-label="Close" onClick={close}>
              <X size={18} aria-hidden="true" />
            </button>
          </div>

          <label className="visually-hidden" htmlFor={`${ids}-title`}>
            Title
          </label>
          {/* A textarea so a long title wraps and stays readable. It still acts
              like a one-line field: Enter saves, and pasted line breaks become spaces. */}
          <textarea
            ref={titleRef}
            id={`${ids}-title`}
            className={styles.title}
            value={title}
            rows={1}
            placeholder="Title"
            maxLength={TITLE_MAX}
            autoComplete="off"
            aria-invalid={titleError !== null}
            aria-describedby={titleError ? `${ids}-title-error` : `${ids}-title-hint`}
            onChange={(event) => {
              setTitle(event.target.value.replace(/\s*\n\s*/g, ' '))
              setTitleError(null)
            }}
            onKeyDown={(event) => {
              // isComposing: Enter also confirms a word in Japanese or Chinese input.
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault()
                event.currentTarget.form?.requestSubmit()
              }
            }}
          />
          {titleError ? (
            <p id={`${ids}-title-error`} className={styles.error}>
              {titleError}
            </p>
          ) : (
            <LengthHint id={`${ids}-title-hint`} length={title.length} max={TITLE_MAX} />
          )}

          <label className="visually-hidden" htmlFor={`${ids}-content`}>
            Note
          </label>
          <textarea
            id={`${ids}-content`}
            className={styles.content}
            value={content}
            placeholder="Details, a list, anything"
            maxLength={CONTENT_MAX}
            rows={5}
            aria-describedby={`${ids}-content-hint`}
            onChange={(event) => setContent(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.currentTarget.form?.requestSubmit()
              }
            }}
          />
          <LengthHint id={`${ids}-content-hint`} length={content.length} max={CONTENT_MAX} />
        </div>

        <fieldset className={styles.field}>
          <legend className={styles.label}>Category</legend>
          <div className={styles.choices}>
            {CATEGORIES.map((id) => {
              const { label, Icon, fill } = CATEGORY_META[id]
              return (
                <label key={id} className={styles.choice}>
                  <input
                    type="radio"
                    name={`${ids}-category`}
                    className="visually-hidden"
                    value={id}
                    checked={category === id}
                    onChange={() => setCategory(id)}
                  />
                  <span className={styles.choiceIcon} style={{ backgroundColor: fill }}>
                    <Icon size={14} aria-hidden="true" />
                  </span>
                  {label}
                </label>
              )
            })}
          </div>
        </fieldset>

        <div className={styles.field}>
          <label className={styles.label} htmlFor={`${ids}-due`}>
            Due date
          </label>
          <div className={styles.dueRow}>
            <input
              id={`${ids}-due`}
              className={styles.date}
              type="date"
              value={dueDate}
              onChange={(event) => setDueDate(event.target.value)}
            />
            {quickDates.map(({ label, value }) => (
              <button
                key={label}
                type="button"
                className={styles.quick}
                aria-pressed={dueDate === value}
                onClick={() => setDueDate(value)}
              >
                {label}
              </button>
            ))}
            {dueDate && (
              <button
                type="button"
                className={styles.quick}
                onClick={() => {
                  setDueDate('')
                  document.getElementById(`${ids}-due`)?.focus()
                }}
              >
                No date
              </button>
            )}
          </div>
        </div>

        <label className={styles.switchRow}>
          <input
            type="checkbox"
            role="switch"
            className={styles.switch}
            checked={pinned}
            onChange={(event) => setPinned(event.target.checked)}
          />
          Pin to the top
        </label>

        <div className={styles.footer}>
          <button type="button" className="button button-quiet" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="button button-primary">
            {isEditing ? 'Save changes' : 'Add note'}
          </button>
        </div>
      </form>
    </dialog>
  )
}

/** Appears once a field is 80% full, so the limit never comes as a surprise. */
function LengthHint({ id, length, max }: { id: string; length: number; max: number }) {
  if (length < max * 0.8) return null
  const left = max - length
  return (
    <p id={id} className={left === 0 ? `${styles.hint} ${styles.hintFull}` : styles.hint}>
      {left === 0
        ? `That's the limit of ${formatCount(max)} characters.`
        : `${formatCount(left)} ${left === 1 ? 'character' : 'characters'} left`}
    </p>
  )
}
