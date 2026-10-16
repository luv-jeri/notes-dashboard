import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { useCallback, useState } from 'react'
import { AuthScreen, AuthSplash, AuthUnavailable } from './auth/AuthScreen'
import { ConfirmEmail, OutcomeToast } from './auth/EmailLinkScreens'
import { OUTCOME_NOTICE, useEmailLink, type LinkOutcome } from './auth/emailLink'
import { useSession } from './auth/session'
import { NotesDashboard } from './notes/NotesDashboard'
import { ToastProvider } from './toast/ToastProvider'

/** The client comes in as a prop, so tests can hand each test a fresh cache. */
export function App({ queryClient }: { queryClient: QueryClient }) {
  return (
    <QueryClientProvider client={queryClient}>
      <SessionGate />
    </QueryClientProvider>
  )
}

/**
 * Asks the server who is logged in, then shows their notes or the log-in
 * screen. A link from one of our emails comes first: it is why the page opened.
 */
function SessionGate() {
  const session = useSession()
  const [link, clearLink] = useEmailLink()
  // What a link did: a toast for someone logged in, a note above the log-in form otherwise.
  const [toast, setToast] = useState<LinkOutcome | null>(null)
  const [notice, setNotice] = useState<LinkOutcome | null>(null)
  const clearToast = useCallback(() => setToast(null), [])

  if (session.isPending) return <AuthSplash />
  if (!session.data) {
    return (
      <AuthUnavailable
        message={session.error?.message ?? ''}
        retrying={session.isFetching}
        onRetry={() => void session.refetch()}
      />
    )
  }

  const { user } = session.data
  // Once someone logs in, the note meant for the log-in screen has done its job.
  if (user && notice) setNotice(null)

  if (link?.kind === 'verify-email') {
    return (
      <ConfirmEmail
        key={link.token}
        token={link.token}
        onDone={(outcome) => {
          clearLink()
          if (outcome && user) setToast(outcome)
          else if (outcome) setNotice(outcome)
        }}
      />
    )
  }

  if (link?.kind === 'reset-password') {
    return (
      <AuthScreen
        key={link.token}
        resetToken={link.token}
        signedIn={Boolean(user)}
        onDone={(outcome) => {
          clearLink()
          setToast(outcome)
        }}
      />
    )
  }

  if (!user) return <AuthScreen notice={notice ? OUTCOME_NOTICE[notice] : session.data.notice} />
  // Keyed by account, so nothing on screen (toasts, filters, an open editor)
  // carries over from one person to the next.
  return (
    <ToastProvider key={user.id}>
      <OutcomeToast outcome={toast} onShown={clearToast} />
      <NotesDashboard user={user} />
    </ToastProvider>
  )
}
