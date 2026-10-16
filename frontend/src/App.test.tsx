import { onlineManager } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from './api/client'
import { notesApi, type Note, type NoteInput } from './api/notes'
import { App } from './App'
import { createQueryClient } from './queryClient'
import { makeNote } from './test/notes'

// Only the network calls are fake. Types, limits and helpers stay real.
vi.mock('./api/notes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api/notes')>()),
  notesApi: { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() },
}))
const api = vi.mocked(notesApi)

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

    expect(screen.getByText('Loading notes…')).toBeInTheDocument()
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
