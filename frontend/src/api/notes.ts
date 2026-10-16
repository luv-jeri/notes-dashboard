import { request } from './client'

/** The five categories every account has. */
export const CATEGORIES = ['work', 'personal', 'ideas', 'shopping', 'health'] as const
export type BuiltInCategory = (typeof CATEGORIES)[number]
/** A built-in key, or the key of one of the person's own categories ("c12"). */
export type Category = string

/** Same limits as backend/main.py, which refuses anything longer. */
export const TITLE_MAX = 200
export const CONTENT_MAX = 10_000

/** The fields a client may send. Mirrors NoteInput in backend/main.py. */
export interface NoteInput {
  title: string
  content: string
  category: Category
  /** A calendar date, "YYYY-MM-DD", with no time or time zone. */
  due_date: string | null
  pinned: boolean
  done: boolean
}

/** A saved note. The server assigns the id and owns the timestamps (ISO 8601, UTC). */
export interface Note extends NoteInput {
  id: number
  created_at: string
  updated_at: string
  completed_at: string | null
}

/** The editable part of a note, for building an update from an existing one. */
export function toInput(note: Note): NoteInput {
  const { title, content, category, due_date, pinned, done } = note
  return { title, content, category, due_date, pinned, done }
}

export const notesApi = {
  list: (signal?: AbortSignal) => request<Note[]>('/notes', { signal }),

  create: (input: NoteInput) =>
    request<Note>('/notes', { method: 'POST', body: JSON.stringify(input) }),

  update: (id: number, input: NoteInput) =>
    request<Note>(`/notes/${id}`, { method: 'PUT', body: JSON.stringify(input) }),

  remove: (id: number) => request<void>(`/notes/${id}`, { method: 'DELETE' }),

  /** Adds the example notes to the account and answers with the whole list. */
  addSamples: () => request<Note[]>('/notes/samples', { method: 'POST' }),
}
