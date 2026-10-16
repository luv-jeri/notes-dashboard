import { useEffect, useState } from 'react'

/**
 * A link from one of our emails: /#verify-email=<token> or /#reset-password=<token>.
 * The token sits after the #, so the browser never sends it to a server: it
 * stays out of request logs and Referer headers.
 */
export interface EmailLink {
  kind: 'verify-email' | 'reset-password'
  token: string
}

const LINK = /^#(verify-email|reset-password)=([\w-]{1,128})$/

export function readEmailLink(hash: string): EmailLink | null {
  const match = LINK.exec(hash)
  return match ? { kind: match[1] as EmailLink['kind'], token: match[2] } : null
}

/** Takes the token out of the address bar, so it isn't left in history or a bookmark. */
function forgetLinkInAddressBar() {
  if (readEmailLink(window.location.hash)) {
    history.replaceState(history.state, '', window.location.pathname + window.location.search)
  }
}

/**
 * The email link the page was opened with, if any, until `clear` is called.
 * A link pasted into a tab that's already open arrives as a hash change.
 */
export function useEmailLink() {
  const [link, setLink] = useState(() => readEmailLink(window.location.hash))

  useEffect(() => {
    forgetLinkInAddressBar()
    const onHashChange = () => {
      const next = readEmailLink(window.location.hash)
      if (!next) return
      forgetLinkInAddressBar()
      setLink(next)
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  return [link, () => setLink(null)] as const
}

/** What a link did, for the next screen to mention once. */
export type LinkOutcome = 'email-confirmed' | 'email-link-expired' | 'password-changed'

/** On the log-in screen, for someone who isn't logged in. */
export const OUTCOME_NOTICE: Record<LinkOutcome, string> = {
  'email-confirmed': 'Email confirmed. Log in to see your notes.',
  'email-link-expired': 'That confirmation link has expired or was already used. Log in to get a new one.',
  'password-changed': 'Password changed. Log in with your new password.',
}

/** In a toast on the dashboard, for someone who is. */
export const OUTCOME_TOAST: Record<LinkOutcome, { message: string; tone?: 'error' }> = {
  'email-confirmed': { message: 'Email confirmed.' },
  'email-link-expired': {
    message: 'That confirmation link has expired or was already used. Use Send again for a new one.',
    tone: 'error',
  },
  'password-changed': { message: "Password changed. You're logged in." },
}
