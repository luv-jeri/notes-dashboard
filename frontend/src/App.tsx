import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { AuthScreen, AuthSplash, AuthUnavailable } from './auth/AuthScreen'
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

/** Asks the server who is logged in, then shows their notes or the log-in screen. */
function SessionGate() {
  const session = useSession()

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

  const { user, notice } = session.data
  if (!user) return <AuthScreen notice={notice} />
  // Keyed by account, so nothing on screen (toasts, filters, an open editor)
  // carries over from one person to the next.
  return (
    <ToastProvider key={user.id}>
      <NotesDashboard user={user} />
    </ToastProvider>
  )
}
