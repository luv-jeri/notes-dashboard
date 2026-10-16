import { QueryClient } from '@tanstack/react-query'

/** The app's query client. Tests build theirs here too, so they run under the same rules. */
export function createQueryClient({ retry = 1 }: { retry?: number | false } = {}) {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // The default is three retries with backoff, which keeps the loading state
        // up for about seven seconds before an error shows. One retry is enough here.
        retry,
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
}
