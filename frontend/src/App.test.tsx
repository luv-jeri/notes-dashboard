import { onlineManager } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { authApi, type User } from './api/auth'
import { ApiError } from './api/client'
import { notesApi, type Note, type NoteInput } from './api/notes'
import { App } from './App'
import { createQueryClient } from './queryClient'
import { makeNote } from './test/notes'

// Only the network calls are fake. Types, limits and helpers stay real.
vi.mock('./api/notes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api/notes')>()),
  notesApi: { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), addSamples: vi.fn() },
}))
vi.mock('./api/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api/auth')>()),
  authApi: { me: vi.fn(), signup: vi.fn(), login: vi.fn(), logout: vi.fn() },
}))
// No categories of their own. src/notes/customCategories.test.tsx covers those.
vi.mock('./api/categories', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api/categories')>()),
  categoriesApi: { list: vi.fn(async () => []), create: vi.fn(), update: vi.fn(), remove: vi.fn() },
}))
const api = vi.mocked(notesApi)
const auth = vi.mocked(authApi)

const ada: User = { id: 1, name: 'Ada Lovelace', email: 'ada@example.com', email_verified: true }

/** What the fake server holds. Each test starts it with a few notes. */
let server: Note[] = []

beforeEach(() => {
  vi.resetAllMocks()
  server = [
    makeNote({ title: 'Plan the offsite', pinned: true }),
    makeNote({ title: 'Buy lemons', content: 'And basil' }),
  ]
  api.list.mockImplementation(async () => [...server])
  api.create.mockImplementation(async (input: NoteInput) => {
    const note = makeNote(input)
    server = [note, ...server]
    return note
  })
  api.update.mockImplementation(async (id: number, input: NoteInput) => {
    const note = { ...server.find((n) => n.id === id)!, ...input }
    note.completed_at = input.done ? new Date().toISOString() : null
    server = server.map((n) => (n.id === id ? note : n))
    return note
  })
  api.remove.mockImplementation(async (id: number) => {
    server = server.filter((n) => n.id !== id)
  })
  // Logged in unless a test says otherwise.
  auth.me.mockResolvedValue(ada)
  auth.logout.mockResolvedValue(undefined)
})

afterEach(() => onlineManager.setOnline(true))

function renderApp() {
  // A fresh cache per test, and no retries, so a failure shows at once.
  render(<App queryClient={createQueryClient({ retry: false })} />)
  return userEvent.setup()
}

const card = (title: string) => screen.getByRole('article', { name: title })
/** A list section by its heading: "Done" finds "Done, 3 notes", not the panel's "Done in the last 7 days". */
const section = (name: string) => screen.getByRole('region', { name: new RegExp(`^${name}, \\d+ notes?$`) })

describe('Notes dashboard', () => {
  it('shows a loading state, then the notes in their sections', async () => {
    renderApp()

    // First the session check, then the notes.
    expect(await screen.findByText('Loading notes…')).toBeInTheDocument()
    expect(await screen.findByRole('article', { name: 'Buy lemons' })).toBeInTheDocument()
    expect(within(section('Pinned')).getByRole('article', { name: 'Plan the offsite' })).toBeInTheDocument()
    expect(within(section('Notes')).getByRole('article', { name: 'Buy lemons' })).toBeInTheDocument()
  })

  it('explains a failed load and loads again on Try again', async () => {
    api.list.mockRejectedValueOnce(
      new ApiError(0, "Can't reach the notes server. Check that the backend is running."),
    )
    const user = renderApp()

    expect(await screen.findByRole('heading', { name: "Your notes didn't load" })).toBeInTheDocument()
    expect(screen.getByText(/Can't reach the notes server/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('article', { name: 'Buy lemons' })).toBeInTheDocument()
  })

  it('shows a new note at once, before the server answers', async () => {
    let answer!: () => void
    const create = api.create.getMockImplementation()!
    api.create.mockImplementation(async (input) => {
      await new Promise<void>((resolve) => (answer = resolve))
      return create(input)
    })
    const user = renderApp()
    await screen.findByRole('article', { name: 'Buy lemons' })

    await user.click(screen.getByRole('button', { name: 'New note' }))
    const dialog = screen.getByRole('dialog', { name: 'New note' })
    expect(within(dialog).getByRole('textbox', { name: 'Title' })).toHaveFocus()
    await user.keyboard('Call the venue')
    await user.click(within(dialog).getByRole('button', { name: 'Add note' }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(await screen.findByRole('article', { name: 'Call the venue' })).toHaveTextContent('Saving…')

    answer()
    await waitFor(() => expect(card('Call the venue')).not.toHaveTextContent('Saving…'))
    expect(api.create).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Call the venue', category: 'personal', due_date: null }),
    )
  })

  it('narrows the cards as you search, and says when nothing matches', async () => {
    const user = renderApp()
    await screen.findByRole('article', { name: 'Buy lemons' })
    const search = screen.getByRole('searchbox', { name: 'Search notes' })

    await user.type(search, 'BASIL')
    await waitFor(() => expect(screen.queryByRole('article', { name: 'Plan the offsite' })).not.toBeInTheDocument())
    expect(card('Buy lemons')).toBeInTheDocument()

    await user.type(search, 'zzz')
    await user.click(await screen.findByRole('button', { name: 'Clear search' }))
    expect(await screen.findByRole('article', { name: 'Plan the offsite' })).toBeInTheDocument()
    expect(search).toHaveValue('')
    expect(search).toHaveFocus()
  })

  it('moves a ticked note to Done, and Undo brings it back', async () => {
    const user = renderApp()
    await screen.findByRole('article', { name: 'Buy lemons' })

    await user.click(screen.getByRole('button', { name: 'Mark Buy lemons as done' }))
    expect(within(section('Done')).getByRole('article', { name: 'Buy lemons' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(within(section('Notes')).getByRole('article', { name: 'Buy lemons' })).toBeInTheDocument())
    // Focus follows the note back, so Space can tick it again.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Mark Buy lemons as done' })).toHaveFocus())
    await waitFor(() => expect(server.find((n) => n.title === 'Buy lemons')?.done).toBe(false))
  })

  it('puts a note back when the delete fails, and Try again deletes it', async () => {
    api.remove.mockRejectedValueOnce(new ApiError(500, 'The server answered 500.'))
    const user = renderApp()
    await screen.findByRole('article', { name: 'Buy lemons' })

    await user.click(screen.getByRole('button', { name: 'Delete Buy lemons' }))
    await user.click(screen.getByRole('button', { name: 'Delete' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Couldn\'t delete "Buy lemons". The server answered 500.')
    expect(card('Buy lemons')).toBeInTheDocument()

    await user.click(within(alert).getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(screen.queryByRole('article', { name: 'Buy lemons' })).not.toBeInTheDocument())
    expect(server.map((n) => n.title)).toEqual(['Plan the offsite'])
  })

  it('says at once when a save fails offline, and keeps focus in the page', async () => {
    const user = renderApp()
    await screen.findByRole('article', { name: 'Buy lemons' })
    onlineManager.setOnline(false)
    const offline = new ApiError(0, "You're offline. Check your connection.")
    api.update.mockRejectedValueOnce(offline).mockRejectedValueOnce(offline)
    const tick = () => user.click(screen.getByRole('button', { name: 'Mark Buy lemons as done' }))

    await tick()
    let alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Couldn\'t save changes to "Buy lemons". You\'re offline.')
    expect(within(section('Notes')).getByRole('article', { name: 'Buy lemons' })).toBeInTheDocument()

    // Closing the toast hands focus back to where it came from.
    const focusedBefore = document.activeElement
    expect(focusedBefore).not.toBe(document.body)
    await user.click(within(alert).getByRole('button', { name: 'Dismiss' }))
    expect(document.activeElement).toBe(focusedBefore)

    // Fails again. Some time later, back online, Try again saves it and moves
    // the card to Done; focus goes to New note rather than the page body.
    await tick()
    alert = await screen.findByRole('alert')
    await new Promise((resolve) => setTimeout(resolve, 1600)) // past the dashboard's 1.5 s focus hand-off
    onlineManager.setOnline(true)
    await user.click(within(alert).getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(within(section('Done')).getByRole('article', { name: 'Buy lemons' })).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'New note' })).toHaveFocus()
    await waitFor(() => expect(server.find((n) => n.title === 'Buy lemons')?.done).toBe(true))
  })
})

describe('Accounts', () => {
  const LOGIN_FAILED = "That email and password don't match an account."

  async function fillLogIn(user: ReturnType<typeof userEvent.setup>, email: string, password: string) {
    await user.type(await screen.findByRole('textbox', { name: 'Email' }), email)
    await user.type(screen.getByLabelText('Password'), password)
    await user.click(screen.getByRole('button', { name: 'Log in' }))
  }

  it('shows the log-in screen when logged out, and the notes after logging in', async () => {
    auth.me.mockResolvedValue(null)
    auth.login.mockResolvedValue(ada)
    const user = renderApp()

    expect(await screen.findByRole('heading', { name: 'Log in' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Email' })).toHaveFocus()
    await fillLogIn(user, '  ada@example.com ', 'correct horse')

    expect(await screen.findByRole('article', { name: 'Buy lemons' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/, Ada,/)
    expect(auth.login).toHaveBeenCalledWith({ email: 'ada@example.com', password: 'correct horse' })
  })

  it('says when the password is wrong, without treating it as an ended session', async () => {
    auth.me.mockResolvedValue(null)
    auth.login.mockRejectedValue(new ApiError(401, LOGIN_FAILED))
    const user = renderApp()

    await fillLogIn(user, 'ada@example.com', 'wrong horse')

    expect(await screen.findByRole('alert')).toHaveTextContent(LOGIN_FAILED)
    expect(screen.getByRole('textbox', { name: 'Email' })).toHaveValue('ada@example.com')
    expect(screen.queryByText(/Your session ended/)).not.toBeInTheDocument()

    // Typing again clears the old answer.
    await user.type(screen.getByLabelText('Password'), '!')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('checks the signup fields before sending anything', async () => {
    auth.me.mockResolvedValue(null)
    const user = renderApp()

    await user.click(await screen.findByRole('button', { name: 'Create an account' }))
    expect(screen.getByRole('heading', { name: 'Create your account' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Create account' }))

    expect(screen.getByText('Enter your name.')).toBeInTheDocument()
    expect(screen.getByText('Enter your email address.')).toBeInTheDocument()
    expect(screen.getByText('Enter your password.')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveFocus()

    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Ada')
    await user.type(screen.getByRole('textbox', { name: 'Email' }), 'ada@example')
    await user.type(screen.getByLabelText('Password'), 'short')
    await user.click(screen.getByRole('button', { name: 'Create account' }))

    expect(screen.getByText('Enter an email address like name@example.com.')).toBeInTheDocument()
    expect(screen.getByText('Use at least 8 characters.')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Email' })).toHaveFocus()
    expect(auth.signup).not.toHaveBeenCalled()
  })

  it('starts a new account on the empty screen, and Add sample notes fills it', async () => {
    auth.me.mockResolvedValue(null)
    auth.signup.mockResolvedValue(ada)
    server = []
    api.addSamples.mockImplementation(async () => {
      server = [makeNote({ title: 'Weekend market list' }), makeNote({ title: 'Renew passport' })]
      return [...server]
    })
    const user = renderApp()

    await user.click(await screen.findByRole('button', { name: 'Create an account' }))
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Ada Lovelace')
    await user.type(screen.getByRole('textbox', { name: 'Email' }), 'ada@example.com')
    await user.type(screen.getByLabelText('Password'), 'correct horse')
    await user.click(screen.getByRole('button', { name: 'Create account' }))

    expect(await screen.findByRole('heading', { name: 'No notes yet' })).toBeInTheDocument()
    expect(auth.signup).toHaveBeenCalledWith({ name: 'Ada Lovelace', email: 'ada@example.com', password: 'correct horse' })

    await user.click(screen.getByRole('button', { name: 'Add sample notes' }))
    expect(await screen.findByRole('article', { name: 'Weekend market list' })).toBeInTheDocument()
    expect(screen.getByText(/Added the sample notes/)).toBeInTheDocument()
  })

  it('offers to log in when the signup email is taken', async () => {
    auth.me.mockResolvedValue(null)
    auth.signup.mockRejectedValue(
      new ApiError(409, 'An account with that email already exists. Log in instead.'),
    )
    const user = renderApp()

    await user.click(await screen.findByRole('button', { name: 'Create an account' }))
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Ada')
    await user.type(screen.getByRole('textbox', { name: 'Email' }), 'ada@example.com')
    await user.type(screen.getByLabelText('Password'), 'correct horse')
    await user.click(screen.getByRole('button', { name: 'Create account' }))

    const alert = await screen.findByRole('alert')
    await user.click(within(alert).getByRole('button', { name: 'Log in instead' }))
    expect(screen.getByRole('heading', { name: 'Log in' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Email' })).toHaveValue('ada@example.com')
  })

  it('logs out from the account panel and returns to the log-in screen', async () => {
    const user = renderApp()
    await screen.findByRole('article', { name: 'Buy lemons' })

    const account = screen.getByRole('button', { name: 'Account (Ada Lovelace)' })
    await user.click(account)
    expect(account).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('ada@example.com')).toBeInTheDocument()

    // Escape closes it and hands focus back.
    await user.keyboard('{Escape}')
    expect(account).toHaveAttribute('aria-expanded', 'false')
    expect(account).toHaveFocus()

    await user.click(account)
    await user.click(screen.getByRole('button', { name: 'Log out' }))
    expect(await screen.findByRole('heading', { name: 'Log in' })).toBeInTheDocument()
    expect(screen.queryByRole('article')).not.toBeInTheDocument()
    expect(auth.logout).toHaveBeenCalledOnce()
  })

  it('returns to the log-in screen with a reason when the session ends', async () => {
    api.list.mockRejectedValue(new ApiError(401, 'Log in to see your notes.'))
    renderApp()

    expect(await screen.findByRole('heading', { name: 'Log in' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Your session ended. Log in again to see your notes.')
  })

  it('ends the session when a save is refused, with no toast to retry', async () => {
    const user = renderApp()
    await screen.findByRole('article', { name: 'Buy lemons' })
    api.update.mockRejectedValue(new ApiError(401, 'Log in to see your notes.'))

    await user.click(screen.getByRole('button', { name: 'Mark Buy lemons as done' }))

    expect(await screen.findByText('Your session ended. Log in again to see your notes.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument()
  })
})
