import { CalendarDays, Check, CircleAlert, Pin, Trash } from 'lucide-react'
import { Fragment, memo, useRef, useState, type CSSProperties } from 'react'
import { flushSync } from 'react-dom'
import type { Note } from '../api/notes'
import { CategoryGlyph } from './CategoryGlyph'
import { dueStatus, formatAgo, formatDue, formatDueInline } from './dates'
import { shorten } from './text'
import { useCategoryCatalog } from './useCategories'
import { isUnsaved } from './useNotes'
import styles from './NoteCard.module.css'

export type CardAction = 'open' | 'pin' | 'delete' | 'done'
export type CardActionHandler = (action: CardAction, note: Note) => void

/**
 * The preview shows three lines at most. Cutting the text first means a
 * 10,000-character note costs the browser a few lines of layout, not pages.
 */
const PREVIEW_MAX = 280

interface NoteCardProps {
  note: Note
  /** Today's local date, "YYYY-MM-DD". */
  today: string
  now: Date
  /** Keep this function stable (see useStableCallback): the card is memoised. */
  onAction: CardActionHandler
}

/**
 * One note. Memoised: with hundreds of cards on screen, typing in search or
 * ticking one note re-renders only the cards whose note actually changed.
 */
export const NoteCard = memo(function NoteCard({ note, today, now, onAction }: NoteCardProps) {
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const deleteButton = useRef<HTMLButtonElement>(null)
  const unsaved = isUnsaved(note)
  const look = useCategoryCatalog().look(note.category)
  const titleId = `note-${note.id}-title`
  const overdue = !note.done && note.due_date !== null && dueStatus(note.due_date, today) === 'overdue'

  function keepNote() {
    // Render the Delete button again first, so focus has somewhere to go.
    flushSync(() => setConfirmingDelete(false))
    deleteButton.current?.focus()
  }

  const className = [styles.card, note.done && styles.done, unsaved && styles.unsaved]
    .filter(Boolean)
    .join(' ')

  return (
    <article
      className={className}
      style={{ '--category-fill': look.fill } as CSSProperties}
      aria-labelledby={titleId}
      aria-busy={unsaved || undefined}
    >
      <div className={styles.top}>
        <span className={styles.category}>
          <span className={styles.iconCircle}>
            <CategoryGlyph look={look} />
          </span>
          {look.label}
        </span>

        {/* Pinned shows on the pin button itself: filled, like a ticked check. */}
        <span className={styles.chips}>
          {note.due_date && (
            <span className={overdue ? `${styles.chip} ${styles.overdue}` : styles.chip}>
              {overdue ? (
                <CircleAlert size={14} aria-hidden="true" />
              ) : (
                <CalendarDays size={14} aria-hidden="true" />
              )}
              <span className="visually-hidden">
                {overdue
                  ? `Overdue, was due ${formatDueInline(note.due_date, today)}`
                  : `Due ${formatDueInline(note.due_date, today)}`}
              </span>
              <span aria-hidden="true">{formatDue(note.due_date, today)}</span>
            </span>
          )}
        </span>
      </div>

      <h3 id={titleId} className={styles.title}>
        {/* The whole card is this button's click area; see .open::after. */}
        <button
          type="button"
          className={styles.open}
          data-action="open"
          disabled={unsaved}
          onClick={() => onAction('open', note)}
        >
          <span className={styles.titleText}>{note.title}</span>
        </button>
      </h3>

      {note.content && <p className={styles.preview}>{shorten(note.content, PREVIEW_MAX)}</p>}

      <div
        className={styles.foot}
        onKeyDown={(event) => {
          if (confirmingDelete && event.key === 'Escape') keepNote()
        }}
      >
        {/* Keyed, so React builds fresh buttons. Reusing them turned the focused
            bin into Delete (two Enters deleted the note) and skipped Keep's autoFocus. */}
        {confirmingDelete ? (
          <Fragment key="confirm">
            <p className={styles.question}>Delete this note?</p>
            {/* On the right, away from the bin, so a double click can't confirm. */}
            <div className={`${styles.toolbar} ${styles.confirm}`}>
              <button type="button" className={`button button-small ${styles.keep}`} onClick={keepNote} autoFocus>
                Keep
              </button>
              <button
                type="button"
                className="button button-small button-danger"
                onClick={() => onAction('delete', note)}
              >
                Delete
              </button>
            </div>
          </Fragment>
        ) : (
          <Fragment key="actions">
            <p className={styles.meta}>{unsaved ? 'Saving…' : metaLine(note, now)}</p>
            {/* Rendered while saving too, so the card keeps its height when the save lands. */}
            <div className={styles.toolbar}>
              <button
                type="button"
                className={note.pinned ? `${styles.action} ${styles.checked}` : styles.action}
                data-action="pin"
                aria-label={`${note.pinned ? 'Unpin' : 'Pin'} ${note.title}`}
                data-tip={note.pinned ? 'Unpin' : 'Pin to top'}
                disabled={unsaved}
                onClick={() => onAction('pin', note)}
              >
                <Pin size={18} aria-hidden="true" />
              </button>
              <button
                ref={deleteButton}
                type="button"
                className={styles.action}
                data-action="delete"
                aria-label={`Delete ${note.title}`}
                data-tip="Delete"
                disabled={unsaved}
                onClick={() => setConfirmingDelete(true)}
              >
                <Trash size={18} aria-hidden="true" />
              </button>
              <button
                type="button"
                className={note.done ? `${styles.action} ${styles.doneAction} ${styles.checked}` : `${styles.action} ${styles.doneAction}`}
                data-action="done"
                aria-label={`Mark ${note.title} as ${note.done ? 'not done' : 'done'}`}
                data-tip={note.done ? 'Mark not done' : 'Mark done'}
                disabled={unsaved}
                onClick={() => onAction('done', note)}
              >
                <Check size={18} strokeWidth={2.5} aria-hidden="true" />
              </button>
            </div>
          </Fragment>
        )}
      </div>
    </article>
  )
})

/** "Done 2 hours ago", "Edited yesterday" or "Added 5 minutes ago". */
function metaLine(note: Note, now: Date): string {
  if (note.done && note.completed_at) return `Done ${formatAgo(note.completed_at, now)}`
  const edited = new Date(note.updated_at).getTime() - new Date(note.created_at).getTime() > 60_000
  return edited
    ? `Edited ${formatAgo(note.updated_at, now)}`
    : `Added ${formatAgo(note.created_at, now)}`
}
