import { useCallback, useLayoutEffect, useRef } from 'react'

/**
 * Returns a function whose identity never changes but which always runs the
 * latest `callback`. Pass it to memoised children (the note cards) so they
 * skip re-rendering when only the parent's state changed.
 *
 * Call the result from event handlers, never during render: it reads a ref
 * that is updated after each render.
 */
export function useStableCallback<Args extends unknown[], Result>(
  callback: (...args: Args) => Result,
): (...args: Args) => Result {
  const latest = useRef(callback)
  useLayoutEffect(() => {
    latest.current = callback
  })
  return useCallback((...args: Args) => latest.current(...args), [])
}
