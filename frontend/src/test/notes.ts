import type { Note } from '../api/notes'

let nextId = 1

/** A saved note with sensible defaults. Pass only the fields a test cares about. */
export function makeNote(overrides: Partial<Note> = {}): Note {
  const id = overrides.id ?? nextId++
  const created = new Date(Date.now() - id * 60_000).toISOString()
  return {
    id,
    title: `Note ${id}`,
    content: '',
    category: 'personal',
    due_date: null,
    pinned: false,
    done: false,
    created_at: created,
    updated_at: created,
    completed_at: overrides.done ? created : null,
    ...overrides,
  }
}
