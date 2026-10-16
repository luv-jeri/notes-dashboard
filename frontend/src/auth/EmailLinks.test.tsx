import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { authApi, type User } from '../api/auth'
import { categoriesApi } from '../api/categories'
import { ApiError } from '../api/client'
import { notesApi } from '../api/notes'
import { App } from '../App'
import { createQueryClient } from '../queryClient'
import { makeNote } from '../test/notes'
import { readEmailLink } from './emailLink'

// Only the network calls are fake. Types, limits and helpers stay real.
vi.mock('../api/notes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/notes')>()),
  notesApi: { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), addSamples: vi.fn() },
}))
vi.mock('../api/categories', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/categories')>()),
  categoriesApi: { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() },
}))
vi.mock('../api/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/auth')>()),
  authApi: {
    me: vi.fn(),
    signup: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
    verifyEmail: vi.fn(),
    resendVerification: vi.fn(),
    forgotPassword: vi.fn(),
    resetPassword: vi.fn(),
  },
}))
const auth = vi.mocked(authApi)

const ada: User = { id: 1, name: 'Ada Lovelace', email: 'ada@example.com', email_verified: true }
const newAda: User = { ...ada, email_verified: false }
const LINK_USED = 'This link has expired or was already used.'

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(notesApi).list.mockResolvedValue([makeNote({ title: 'Buy lemons' })])
  vi.mocked(categoriesApi).list.mockResolvedValue([])
  auth.me.mockResolvedValue(null)
})

afterEach(() => window.history.replaceState(null, '', '/'))

/**
 * Opens the app the way a link in an email does. Under Strict Mode, as
 * main.tsx renders it, so effects run twice and a link sent twice shows up.
 */
function renderApp(hash = '') {
  window.history.replaceState(null, '', `/${hash}`)
  render(
    <StrictMode>
      <App queryClient={createQueryClient({ retry: false })} />
    </StrictMode>,
  )
  return userEvent.setup()
}

describe('readEmailLink', () => {
  it('reads our two links and nothing else', () => {
    expect(readEmailLink('#verify-email=abc_DEF-123')).toEqual({ kind: 'verify-email', token: 'abc_DEF-123' })
    expect(readEmailLink('#reset-password=xyz')).toEqual({ kind: 'reset-password', token: 'xyz' })
    expect(readEmailLink('')).toBeNull()
    expect(readEmailLink('#verify-email=')).toBeNull()
    expect(readEmailLink('#verify-email=a b')).toBeNull()
    expect(readEmailLink('#something-else=abc')).toBeNull()
    expect(readEmailLink(`#reset-password=${'a'.repeat(129)}`)).toBeNull()
  })
})

describe('Forgot password', () => {
  it('keeps the typed email, sends a link, and says the same thing whoever asked', async () => {
    auth.forgotPassword.mockResolvedValue(undefined)
    const user = renderApp()

    await user.type(await screen.findByRole('textbox', { name: 'Email' }), 'ada@example.com')
    await user.click(screen.getByRole('button', { name: 'Forgot password?' }))

    expect(screen.getByRole('heading', { name: 'Reset your password' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Email' })).toHaveValue('ada@example.com')
    await user.click(screen.getByRole('button', { name: 'Email me a link' }))

    const heading = await screen.findByRole('heading', { name: 'Check your email' })
    expect(heading).toHaveFocus()
    expect(auth.forgotPassword).toHaveBeenCalledWith('ada@example.com')
    expect(screen.getByText(/If an account uses/)).toHaveTextContent('ada@example.com')

    // The server sends one a minute, so the button waits as long.
    const again = screen.getByRole('button', { name: /Send again in \d+ s/ })
    expect(again).toHaveAttribute('aria-disabled', 'true')
    await user.click(again)
    expect(auth.forgotPassword).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('button', { name: 'Back to log in' }))
    expect(screen.getByRole('heading', { name: 'Log in' })).toBeInTheDocument()
  })

  it('checks the email before sending', async () => {
    const user = renderApp()

    await user.click(await screen.findByRole('button', { name: 'Forgot password?' }))
    await user.click(screen.getByRole('button', { name: 'Email me a link' }))

    expect(screen.getByText('Enter your email address.')).toBeInTheDocument()
    expect(auth.forgotPassword).not.toHaveBeenCalled()
  })
})

describe('Reset link', () => {
  it('sets the new password, logs in, and takes the token out of the address bar', async () => {
    auth.resetPassword.mockResolvedValue(ada)
    const user = renderApp('#reset-password=reset_token_1')

    expect(await screen.findByRole('heading', { name: 'Choose a new password' })).toBeInTheDocument()
    expect(window.location.hash).toBe('')
    expect(screen.getByLabelText('New password')).toHaveFocus()

    await user.type(screen.getByLabelText('New password'), 'short')
    await user.click(screen.getByRole('button', { name: 'Save password' }))
    expect(screen.getByText('Use at least 8 characters.')).toBeInTheDocument()
    expect(auth.resetPassword).not.toHaveBeenCalled()

    await user.type(screen.getByLabelText('New password'), ' and longer')
    await user.click(screen.getByRole('button', { name: 'Save password' }))

    expect(await screen.findByRole('article', { name: 'Buy lemons' })).toBeInTheDocument()
    expect(screen.getByText("Password changed. You're logged in.")).toBeInTheDocument()
    expect(auth.resetPassword).toHaveBeenCalledWith({ token: 'reset_token_1', password: 'short and longer' })
  })

  it('offers a new link when this one has run out', async () => {
    auth.resetPassword.mockRejectedValue(new ApiError(400, LINK_USED))
    const user = renderApp('#reset-password=old_token')

    await user.type(await screen.findByLabelText('New password'), 'correct horse')
    await user.click(screen.getByRole('button', { name: 'Save password' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(LINK_USED)
    await user.click(within(alert).getByRole('button', { name: 'Send a new link' }))
    expect(screen.getByRole('heading', { name: 'Reset your password' })).toBeInTheDocument()
  })

  it('goes back to the notes when someone logged in leaves it', async () => {
    auth.me.mockResolvedValue(ada)
    const user = renderApp('#reset-password=any_token')

    await user.click(await screen.findByRole('button', { name: 'Back to your notes' }))
    expect(await screen.findByRole('article', { name: 'Buy lemons' })).toBeInTheDocument()
    expect(auth.resetPassword).not.toHaveBeenCalled()
  })
})

describe('Confirmation link', () => {
  it('confirms the email of someone logged in and says so once', async () => {
    auth.me.mockResolvedValueOnce(newAda).mockResolvedValue(ada)
    auth.verifyEmail.mockResolvedValue(undefined)
    renderApp('#verify-email=verify_token_1')

    expect(await screen.findByText('Email confirmed.')).toBeInTheDocument()
    expect(auth.verifyEmail).toHaveBeenCalledTimes(1)
    expect(auth.verifyEmail).toHaveBeenCalledWith('verify_token_1')
    expect(window.location.hash).toBe('')
    expect(await screen.findByRole('article', { name: 'Buy lemons' })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Confirm your email' })).not.toBeInTheDocument()
  })

  it('tells someone logged out to log in next', async () => {
    auth.verifyEmail.mockResolvedValue(undefined)
    renderApp('#verify-email=verify_token_2')

    expect(await screen.findByRole('heading', { name: 'Log in' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Email confirmed. Log in to see your notes.')
  })

  it('explains a link that has run out', async () => {
    auth.verifyEmail.mockRejectedValue(new ApiError(400, LINK_USED))
    renderApp('#verify-email=old_token')

    expect(await screen.findByRole('heading', { name: 'Log in' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(/expired or was already used. Log in to get a new one/)
  })

  it('offers Try again and a way on when the server cannot be reached', async () => {
    auth.verifyEmail
      .mockRejectedValueOnce(new ApiError(0, "Can't reach the notes server."))
      .mockResolvedValue(undefined)
    const user = renderApp('#verify-email=verify_token_3')

    expect(await screen.findByRole('heading', { name: "Your email isn't confirmed yet" })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('heading', { name: 'Log in' })).toBeInTheDocument()
    expect(auth.verifyEmail).toHaveBeenCalledTimes(2)
  })
})

describe('Confirm your email banner', () => {
  it('sends another link, explains a refusal, and hides for now', async () => {
    auth.me.mockResolvedValue(newAda)
    auth.resendVerification
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new ApiError(429, 'Wait a minute before asking for another email.'))
    const user = renderApp()

    const banner = await screen.findByRole('region', { name: 'Confirm your email' })
    expect(banner).toHaveTextContent('ada@example.com')

    await user.click(within(banner).getByRole('button', { name: 'Send again' }))
    expect(await within(banner).findByText(/^Sent\. Check/)).toBeInTheDocument()

    await user.click(within(banner).getByRole('button', { name: 'Send again' }))
    expect(await within(banner).findByRole('alert')).toHaveTextContent('Wait a minute before asking for another email.')

    await user.click(within(banner).getByRole('button', { name: 'Hide for now' }))
    expect(screen.queryByRole('region', { name: 'Confirm your email' })).not.toBeInTheDocument()
  })

  it('stays away once the email is confirmed', async () => {
    auth.me.mockResolvedValue(ada)
    renderApp()

    expect(await screen.findByRole('article', { name: 'Buy lemons' })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Confirm your email' })).not.toBeInTheDocument()
  })
})
