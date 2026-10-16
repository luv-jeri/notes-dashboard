import { NoteFan } from '../layout/NoteFan'
import styles from './NotesStates.module.css'

export function NotesLoading() {
  return (
    <div className={styles.grid} aria-busy="true">
      <p className="visually-hidden" role="status">
        Loading notes…
      </p>
      {[0, 1, 2, 3, 4, 5].map((index) => (
        <div key={index} className={styles.skeleton} aria-hidden="true">
          <span className={styles.skeletonCircle} />
          <span className={styles.skeletonLine} />
          <span className={`${styles.skeletonLine} ${styles.short}`} />
        </div>
      ))}
    </div>
  )
}

interface NotesMessageProps {
  title: string
  detail?: string
  actionLabel?: string
  onAction?: () => void
}

/** Empty, no-match and failed screens share one shape: what happened, and what to do next. */
export function NotesMessage({ title, detail, actionLabel, onAction }: NotesMessageProps) {
  return (
    <div className={styles.message}>
      <h2 className={styles.messageTitle}>{title}</h2>
      {detail && <p className={styles.messageDetail}>{detail}</p>}
      {actionLabel && onAction && (
        <button type="button" className="button button-primary" onClick={onAction}>
          {actionLabel}
        </button>
      )}
    </div>
  )
}

interface NotesWelcomeProps {
  onNewNote: () => void
  onAddSamples: () => void
  addingSamples: boolean
}

/** A new account's first screen: start writing, or look around with sample notes first. */
export function NotesWelcome({ onNewNote, onAddSamples, addingSamples }: NotesWelcomeProps) {
  return (
    <div className={styles.welcome}>
      <div className={styles.welcomeText}>
        <h2 className={styles.messageTitle}>No notes yet</h2>
        <p className={styles.messageDetail}>
          Write down a task, a list or an idea. Give it a due date to see it in Today.
        </p>
        <p className={styles.messageDetail}>
          Or add a few sample notes to see how Today, Pinned and Done work. Delete them whenever you like.
        </p>
        <div className={styles.welcomeActions}>
          <button type="button" className="button button-primary" onClick={onNewNote}>
            New note
          </button>
          <button
            type="button"
            className="button button-outline"
            aria-disabled={addingSamples || undefined}
            onClick={() => {
              if (!addingSamples) onAddSamples()
            }}
          >
            {addingSamples ? 'Adding sample notes…' : 'Add sample notes'}
          </button>
        </div>
      </div>
      <div className={styles.welcomeFan}>
        <NoteFan size="small" />
      </div>
    </div>
  )
}
