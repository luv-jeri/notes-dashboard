import { MailCheck, X } from 'lucide-react'
import { useId, useState } from 'react'
import type { User } from '../api/auth'
import { useResendVerification } from './session'
import styles from './EmailBanner.module.css'

/**
 * Asks a new account to confirm its email. Nothing is locked until they do:
 * the confirmed address is what lets them reset a forgotten password.
 */
export function EmailBanner({ user }: { user: User }) {
  const resend = useResendVerification()
  const [hidden, setHidden] = useState(false)
  const ids = useId()

  if (user.email_verified || hidden) return null

  return (
    <section className={styles.banner} aria-labelledby={`${ids}-title`}>
      <span className={styles.icon} aria-hidden="true">
        <MailCheck size={20} />
      </span>
      <div className={styles.text}>
        <h2 id={`${ids}-title`} className={styles.title}>
          Confirm your email
        </h2>
        <p className={styles.detail} aria-live="polite">
          {resend.isSuccess ? (
            <>
              Sent. Check <strong className={styles.address}>{user.email}</strong>, and the spam folder if it isn't
              there.
            </>
          ) : (
            <>
              Open the link we emailed to <strong className={styles.address}>{user.email}</strong>, so you can reset
              your password if you ever forget it.
            </>
          )}
        </p>
        {resend.isError && (
          <p className={styles.error} role="alert">
            {resend.error.message}
          </p>
        )}
      </div>
      <div className={styles.actions}>
        <button
          type="button"
          className={`button button-small ${styles.send}`}
          aria-disabled={resend.isPending || undefined}
          onClick={() => {
            if (!resend.isPending) resend.mutate()
          }}
        >
          {resend.isPending ? 'Sending…' : 'Send again'}
        </button>
        <button
          type="button"
          className={`icon-button ${styles.hide}`}
          aria-label="Hide for now"
          data-tip="Hide for now"
          onClick={() => setHidden(true)}
        >
          <X size={18} aria-hidden="true" />
        </button>
      </div>
    </section>
  )
}
