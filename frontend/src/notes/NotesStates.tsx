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
