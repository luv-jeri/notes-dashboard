import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query'
import { authKey, isSessionEnded, SESSION_ENDED, sessionKey, setSession } from './auth/session'

/** The app's query client. Tests build theirs here too, so they run under the same rules. */
export function createQueryClient({ retry = 1 }: { retry?: number | false } = {}) {
  // Any request can be the first to find the session gone: the list on a
  // window focus, a save, a delete. One handler sends every one of them back
  // to the log-in screen, with a line saying why.
  const endSession = (error: unknown) => {
    if (isSessionEnded(error)) setSession(client, { user: null, notice: SESSION_ENDED })
  }

  const client: QueryClient = new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => {
        if (query.queryKey[0] !== sessionKey[0]) endSession(error)
      },
    }),
    mutationCache: new MutationCache({
      onError: (error, _variables, _context, mutation) => {
        if (mutation.options.mutationKey?.[0] !== authKey[0]) endSession(error)
      },
    }),
    defaultOptions: {
      queries: {
        // The default is three retries with backoff, which keeps the loading state
        // up for about seven seconds before an error shows. One retry is enough here.
        // A 401 won't change on a second try, so it never retries.
        retry: (failures, error) => !isSessionEnded(error) && (retry === false ? false : failures < retry),
        networkMode: 'always',
        // 'always' turns this off by default; coming back online should still refresh.
        refetchOnReconnect: true,
      },
      // By default a request waits while the browser says it's offline. A held
      // save looked done, said nothing, and was lost if the tab closed. Sending
      // it anyway means it fails at once, rolls back and offers Try again. It
      // also keeps a backend on this machine working with Wi-Fi off.
      mutations: { networkMode: 'always' },
    },
  })
  return client
}
