import { useEffect, useRef } from 'react'
import { ApiError } from '../api/client'
import { useToast } from '../toast/ToastContext'
import { AuthSplash, AuthUnavailable } from './AuthScreen'
import { OUTCOME_TOAST, type LinkOutcome } from './emailLink'
import { useVerifyEmail } from './session'

/** Says what a link did, once, inside the dashboard's toasts. */
export function OutcomeToast({ outcome, onShown }: { outcome: LinkOutcome | null; onShown: () => void }) {
  const toast = useToast()
  // Strict Mode runs effects twice on mount; one toast is enough.
  const shown = useRef<LinkOutcome | null>(null)

  useEffect(() => {
    if (!outcome) {
      shown.current = null
      return
    }
    if (shown.current === outcome) return
    shown.current = outcome
    toast.show(OUTCOME_TOAST[outcome])
    onShown()
  }, [outcome, onShown, toast])

  return null
}

/**
 * Opened from a confirmation email: sends the token once, then hands over to
 * the usual screens. A link that has run out is a normal answer, not a failure;
 * only an unreachable server stops here, with Try again.
 */
export function ConfirmEmail({ token, onDone }: { token: string; onDone: (outcome: LinkOutcome | null) => void }) {
  const verify = useVerifyEmail()
  const sent = useRef(false)

  function send() {
    verify.mutate(token, {
      onSuccess: () => onDone('email-confirmed'),
      onError: (error) => {
        if (error instanceof ApiError && error.status === 400) onDone('email-link-expired')
      },
    })
  }

  useEffect(() => {
    // Strict Mode runs this twice; the link must be sent once.
    if (sent.current) return
    sent.current = true
    send()
    // Runs once per link; SessionGate keys this screen by the token.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (verify.isError && !(verify.error instanceof ApiError && verify.error.status === 400)) {
    return (
      <AuthUnavailable
        heading="Your email isn't confirmed yet"
        message={verify.error.message}
        retrying={verify.isPending}
        onRetry={send}
        onSkip={() => onDone(null)}
      />
    )
  }
  return <AuthSplash label="Confirming your email…" />
}
