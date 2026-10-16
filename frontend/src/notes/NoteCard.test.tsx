import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { makeNote } from '../test/notes'
import { NoteCard } from './NoteCard'

const today = '2026-10-16'
const now = new Date('2026-10-16T12:00:00')

function renderCard(overrides: Parameters<typeof makeNote>[0] = {}) {
  const note = makeNote({ title: 'Renew passport', ...overrides })
  const onAction = vi.fn()
  render(<NoteCard note={note} today={today} now={now} onAction={onAction} />)
  return { note, onAction }
}

describe('NoteCard', () => {
  it('shows the title and a short preview of a long note', () => {
    renderCard({ content: 'word '.repeat(2_000) })

    expect(screen.getByRole('article', { name: 'Renew passport' })).toBeInTheDocument()
    expect(screen.getByText(/^word word/).textContent!.length).toBeLessThanOrEqual(280)
  })

  it('says when an open note is overdue', () => {
    renderCard({ due_date: '2026-10-14' })

    // The date itself is in the reader's locale: "14 Oct" or "Oct 14".
    expect(screen.getByText(/^Overdue, was due /)).toBeInTheDocument()
  })

  it('reports done, pin and open with the note', async () => {
    const user = userEvent.setup()
    const { note, onAction } = renderCard()

    await user.click(screen.getByRole('button', { name: 'Mark Renew passport as done' }))
    await user.click(screen.getByRole('button', { name: 'Pin Renew passport' }))
    await user.click(screen.getByRole('button', { name: 'Renew passport' }))

    expect(onAction.mock.calls).toEqual([
      ['done', note],
      ['pin', note],
      ['open', note],
    ])
  })

  it('asks before deleting, and Keep puts focus back on the bin', async () => {
    const user = userEvent.setup()
    const { note, onAction } = renderCard()

    await user.click(screen.getByRole('button', { name: 'Delete Renew passport' }))
    expect(screen.getByText('Delete this note?')).toBeInTheDocument()
    expect(onAction).not.toHaveBeenCalled()
    // Focus starts on the safe choice, so pressing Enter twice can't delete.
    expect(screen.getByRole('button', { name: 'Keep' })).toHaveFocus()

    await user.click(screen.getByRole('button', { name: 'Keep' }))
    expect(screen.getByRole('button', { name: 'Delete Renew passport' })).toHaveFocus()

    await user.click(screen.getByRole('button', { name: 'Delete Renew passport' }))
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    expect(onAction).toHaveBeenCalledWith('delete', note)
  })
})
