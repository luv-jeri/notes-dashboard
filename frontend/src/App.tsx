import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { NotesDashboard } from './notes/NotesDashboard'
import { ToastProvider } from './toast/ToastProvider'

/** The client comes in as a prop, so tests can hand each test a fresh cache. */
export function App({ queryClient }: { queryClient: QueryClient }) {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <NotesDashboard />
      </ToastProvider>
    </QueryClientProvider>
  )
}
