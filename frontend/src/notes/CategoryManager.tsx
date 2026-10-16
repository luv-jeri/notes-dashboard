import { Palette, Pencil, Trash2, X } from 'lucide-react'
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { flushSync } from 'react-dom'
import { CATEGORY_NAME_MAX, type CategoryColor, type CustomCategory } from '../api/categories'
import { isSessionEnded } from '../auth/session'
import { customLook } from './categories'
import { CategoryGlyph } from './CategoryGlyph'
import { NewCategoryForm } from './NewCategoryForm'
import { SwatchPicker } from './SwatchPicker'
import { formatCount } from './text'
import { useCategoriesQuery, useCountNotesIn, useDeleteCategory, useUpdateCategory } from './useCategories'
import formStyles from './CategoryForm.module.css'
import styles from './CategoryManager.module.css'
// The note editor's dialog: the same card, fade and phone sheet.
import dialogStyles from './NoteFormDialog.module.css'

interface CategoryManagerProps {
  onClose: () => void
  /** A category has gone; anything still set to its key should let go of it. */
  onDeleted: (key: string) => void
}

/** "Your categories": rename, recolour, delete and add the person's own categories. */
export function CategoryManager({ onClose, onDeleted }: CategoryManagerProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const newNameRef = useRef<HTMLInputElement>(null)
  const query = useCategoriesQuery()
  const categories = query.data
  const [announcement, setAnnouncement] = useState('')
  const ids = useId()
  const startsEmpty = useRef(categories?.length === 0)

  // showModal() would focus Close. With nothing to edit yet, the only thing
  // to do is add one, so start there.
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog || dialog.open) return
    dialog.showModal()
    if (startsEmpty.current) newNameRef.current?.focus()
  }, [])

  // A deleted row takes focus with it. Once it has gone, focus goes to the
  // row that moved up into its place, else the one above, else the name field.
  const deleted = useRef<{ id: number; index: number } | null>(null)
  function handleDeleted(category: CustomCategory, index: number) {
    deleted.current = { id: category.id, index }
    setAnnouncement(`Deleted "${category.name}".`)
    onDeleted(category.key)
  }
  useLayoutEffect(() => {
    const gone = deleted.current
    if (!gone || categories?.some((category) => category.id === gone.id)) return
    deleted.current = null
    const dialog = dialogRef.current
    const active = document.activeElement
    if (!dialog?.open || (active && active !== document.body && dialog.contains(active))) return
    const rows = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-action="rename"]') ?? [])]
    ;(rows[gone.index] ?? rows[gone.index - 1] ?? newNameRef.current)?.focus()
  })

  const close = () => dialogRef.current?.close()

  // As in NoteFormDialog: focus is back the moment close() runs, and the
  // dialog leaves the page once its fade has finished.
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
    void Promise.allSettled(fading.map((animation) => animation.finished)).then(() => {
      if (mounted.current) onClose()
    })
  }

  let list
  if (categories === undefined) {
    list = query.isError ? (
      <div className={styles.message}>
        <p>Your categories didn't load.</p>
        <button type="button" className="button button-outline" onClick={() => void query.refetch()}>
          Try again
        </button>
      </div>
    ) : (
      <p className={styles.message} role="status">
        Loading your categories…
      </p>
    )
  } else if (categories.length === 0) {
    list = <p className={styles.message}>You haven't made any categories of your own yet.</p>
  } else {
    list = (
      <ul ref={listRef} className={styles.list}>
        {categories.map((category, index) => (
          <CategoryRow
            key={category.id}
            category={category}
            onDeleted={(removed) => handleDeleted(removed, index)}
          />
        ))}
      </ul>
    )
  }

  return (
    <dialog ref={dialogRef} className={dialogStyles.dialog} aria-labelledby={`${ids}-heading`} onClose={handleClose}>
      <div className={styles.body}>
        <div className={styles.head}>
          <h2 id={`${ids}-heading`} className={styles.heading}>
            Your categories
          </h2>
          <button type="button" className={styles.close} aria-label="Close" onClick={close}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        {list}

        <section className={styles.add} aria-labelledby={`${ids}-new`}>
          <h3 id={`${ids}-new`} className={styles.subheading}>
            New category
          </h3>
          <NewCategoryForm
            labelledBy={`${ids}-new`}
            nameRef={newNameRef}
            onAdded={(created) => setAnnouncement(`Added "${created.name}".`)}
          />
        </section>

        <p className="visually-hidden" role="status">
          {announcement}
        </p>
      </div>
    </dialog>
  )
}

interface CategoryRowProps {
  category: CustomCategory
  onDeleted: (category: CustomCategory) => void
}

type RowMode = 'view' | 'rename' | 'confirm'

function CategoryRow({ category, onDeleted }: CategoryRowProps) {
  const look = customLook(category)
  const [mode, setMode] = useState<RowMode>('view')
  const [picking, setPicking] = useState(false)
  const [draft, setDraft] = useState(category.name)
  const [nameError, setNameError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const rename = useUpdateCategory()
  const recolor = useUpdateCategory()
  const remove = useDeleteCategory(onDeleted)
  const countNotesIn = useCountNotesIn()
  const nameInput = useRef<HTMLInputElement>(null)
  const renameButton = useRef<HTMLButtonElement>(null)
  const colorButton = useRef<HTMLButtonElement>(null)
  const deleteButton = useRef<HTMLButtonElement>(null)
  const ids = useId()

  // The whole name starts selected, ready to type over.
  useLayoutEffect(() => {
    if (mode !== 'rename') return
    nameInput.current?.focus()
    nameInput.current?.select()
  }, [mode])

  /** Back to the plain row, with focus on the button that started it. */
  function backToRow(button: RefObject<HTMLButtonElement | null>) {
    flushSync(() => {
      setMode('view')
      setPicking(false)
    })
    button.current?.focus()
  }

  // Escape steps back out of renaming, choosing or confirming. Cancelling the
  // keydown keeps the dialog open.
  function escapeTo(event: KeyboardEvent, button: RefObject<HTMLButtonElement | null>) {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    backToRow(button)
  }

  function startRename() {
    setDraft(category.name)
    setNameError(null)
    setError(null)
    setPicking(false)
    setMode('rename')
  }

  function saveName() {
    if (rename.isPending) return
    const name = draft.trim()
    if (!name) {
      setNameError('Give the category a name.')
      nameInput.current?.focus()
      return
    }
    if (name === category.name) {
      backToRow(renameButton)
      return
    }
    rename.mutate(
      { id: category.id, patch: { name } },
      {
        onSuccess: () => backToRow(renameButton),
        onError: (failure) => {
          if (isSessionEnded(failure)) return
          setNameError(failure.message)
          nameInput.current?.focus()
        },
      },
    )
  }

  function changeColor(color: CategoryColor) {
    setError(null)
    recolor.mutate(
      { id: category.id, patch: { color } },
      {
        onError: (failure) => {
          if (!isSessionEnded(failure)) setError(failure.message)
        },
      },
    )
  }

  function startDelete() {
    setError(null)
    setPicking(false)
    setMode('confirm')
  }

  function confirmDelete() {
    if (remove.isPending) return
    remove.mutate(category, {
      onError: (failure) => {
        if (!isSessionEnded(failure)) setError(failure.message)
      },
    })
  }

  const count = mode === 'confirm' ? countNotesIn(category.key) : 0
  const question =
    count === 0
      ? `Delete "${category.name}"?`
      : `Delete "${category.name}"? Its ${formatCount(count)} ${count === 1 ? 'note moves' : 'notes move'} to Personal.`

  return (
    <li className={styles.row} data-key={category.key}>
      <div className={styles.line}>
        <span className={styles.glyph} style={{ backgroundColor: look.fill }}>
          <CategoryGlyph look={look} />
        </span>

        {mode === 'rename' ? (
          <>
            <label className="visually-hidden" htmlFor={`${ids}-name`}>
              New name for {category.name}
            </label>
            <input
              ref={nameInput}
              id={`${ids}-name`}
              className={`${formStyles.input} ${styles.nameInput}`}
              value={draft}
              maxLength={CATEGORY_NAME_MAX}
              autoComplete="off"
              aria-invalid={nameError !== null}
              aria-describedby={nameError ? `${ids}-name-error` : undefined}
              onChange={(event) => {
                setDraft(event.target.value)
                setNameError(null)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  saveName()
                } else {
                  escapeTo(event, renameButton)
                }
              }}
            />
          </>
        ) : (
          <span className={styles.name}>{category.name}</span>
        )}

        {mode === 'view' && (
          <div className={styles.actions}>
            <button
              ref={renameButton}
              type="button"
              className={styles.action}
              data-action="rename"
              aria-label={`Rename ${category.name}`}
              data-tip="Rename"
              onClick={startRename}
            >
              <Pencil size={18} aria-hidden="true" />
            </button>
            <button
              ref={colorButton}
              type="button"
              className={styles.action}
              aria-label={`Change colour of ${category.name}`}
              aria-expanded={picking}
              aria-controls={picking ? `${ids}-colors` : undefined}
              data-tip="Colour"
              onClick={() => setPicking((open) => !open)}
            >
              <Palette size={18} aria-hidden="true" />
            </button>
            <button
              ref={deleteButton}
              type="button"
              className={styles.action}
              aria-label={`Delete ${category.name}`}
              data-tip="Delete"
              onClick={startDelete}
            >
              <Trash2 size={18} aria-hidden="true" />
            </button>
          </div>
        )}
      </div>

      {mode === 'rename' && (
        <div className={styles.more}>
          {nameError && (
            <p id={`${ids}-name-error`} className={formStyles.error}>
              {nameError}
            </p>
          )}
          <div className={formStyles.actions}>
            <button type="button" className="button button-quiet" onClick={() => backToRow(renameButton)}>
              Cancel
            </button>
            <button
              type="button"
              className="button button-primary"
              aria-disabled={rename.isPending || undefined}
              onClick={saveName}
            >
              {rename.isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}

      {mode === 'view' && picking && (
        <div id={`${ids}-colors`} className={styles.more} onKeyDown={(event) => escapeTo(event, colorButton)}>
          <SwatchPicker
            name={`${ids}-color`}
            legend={`Colour for ${category.name}`}
            hideLegend
            value={category.color}
            onChange={changeColor}
          />
        </div>
      )}

      {mode === 'confirm' && (
        <div className={`${styles.more} ${styles.confirm}`} onKeyDown={(event) => escapeTo(event, deleteButton)}>
          <p className={styles.question}>{question}</p>
          <div className={formStyles.actions}>
            <button type="button" className="button button-quiet" onClick={() => backToRow(deleteButton)} autoFocus>
              Cancel
            </button>
            <button
              type="button"
              className="button button-danger"
              aria-disabled={remove.isPending || undefined}
              onClick={confirmDelete}
            >
              {remove.isPending ? 'Deleting…' : 'Delete'}
            </button>
          </div>
        </div>
      )}

      {error && (
        <p className={`${formStyles.error} ${styles.more}`} role="alert">
          {error}
        </p>
      )}
    </li>
  )
}
