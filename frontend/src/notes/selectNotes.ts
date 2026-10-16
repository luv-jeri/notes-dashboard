import type { Category, Note } from '../api/notes'
import { addDays, toDateKey } from './dates'

export type View = 'all' | 'today' | 'pinned' | 'done'
export type SortOrder = 'newest' | 'due' | 'title'
export type CategoryFilter = Category | 'all'

export interface Filters {
  view: View
  category: CategoryFilter
  search: string
  sort: SortOrder
  /** Today's local date, "YYYY-MM-DD". */
  today: string
}

export interface NoteSection {
  id: string
  title: string
  notes: Note[]
}

/**
 * Caches a value worked out from a note. Notes are never changed in place: an
 * edit replaces the object. So the note itself is a safe cache key, and a
 * WeakMap forgets the value once nothing holds the old note.
 */
function perNote<T>(compute: (note: Note) => T): (note: Note) => T {
  const cache = new WeakMap<Note, T>()
  return (note) => {
    let value = cache.get(note)
    if (value === undefined) {
      value = compute(note)
      cache.set(note, value)
    }
    return value
  }
}

// Lowercasing every note's text on each keystroke is the slow part of search
// with thousands of long notes, so it happens once per version of a note.
const searchText = perNote((note) => `${note.title}\n${note.content}`.toLowerCase())
const createdTime = perNote((note) => Date.parse(note.created_at))
const completedTime = perNote((note) => Date.parse(note.completed_at ?? note.updated_at))
// One collator for every comparison; numeric puts "Week 2" before "Week 10".
const titleOrder = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })

/** Case-insensitive match on title or content. An empty query matches every note. */
export function matchesSearch(note: Note, query: string): boolean {
  const needle = query.trim().toLowerCase()
  return !needle || searchText(note).includes(needle)
}

/**
 * Splits the notes into the sections the current view shows, after the
 * category and search filters. Empty sections are left out.
 */
export function selectSections(notes: Note[], filters: Filters): NoteSection[] {
  const { view, category, search, sort, today } = filters
  const needle = search.trim().toLowerCase()
  const visible = notes.filter(
    (note) =>
      (category === 'all' || note.category === category) &&
      (!needle || searchText(note).includes(needle)),
  )
  const open = visible.filter((note) => !note.done)
  const done = visible.filter((note) => note.done).sort(byCompletedNewest)

  const sections: NoteSection[] = []
  switch (view) {
    case 'all':
      sections.push(
        { id: 'pinned', title: 'Pinned', notes: sortNotes(open.filter((n) => n.pinned), sort) },
        { id: 'notes', title: 'Notes', notes: sortNotes(open.filter((n) => !n.pinned), sort) },
        { id: 'done', title: 'Done', notes: done },
      )
      break
    case 'today':
      sections.push(
        {
          id: 'overdue',
          title: 'Overdue',
          notes: sortNotes(open.filter((n) => n.due_date !== null && n.due_date < today), 'due'),
        },
        {
          id: 'today',
          title: 'Due today',
          notes: sortNotes(open.filter((n) => n.due_date === today), 'newest'),
        },
      )
      break
    case 'pinned':
      sections.push(
        { id: 'pinned', title: 'Pinned', notes: sortNotes(open.filter((n) => n.pinned), sort) },
        { id: 'done', title: 'Done', notes: done.filter((n) => n.pinned) },
      )
      break
    case 'done':
      sections.push({ id: 'done', title: 'Done', notes: done })
      break
  }
  return sections.filter((section) => section.notes.length > 0)
}

/** Open notes with a due date, soonest (or most overdue) first. */
export function dueSoon(notes: Note[], limit: number): Note[] {
  return sortNotes(
    notes.filter((note) => !note.done && note.due_date !== null),
    'due',
  ).slice(0, limit)
}

export function countDue(notes: Note[], today: string) {
  let dueToday = 0
  let overdue = 0
  for (const note of notes) {
    if (note.done || note.due_date === null) continue
    if (note.due_date === today) dueToday++
    else if (note.due_date < today) overdue++
  }
  return { dueToday, overdue }
}

export interface DayTally {
  /** Local date, "YYYY-MM-DD". */
  date: string
  notes: Note[]
}

/** Notes finished on each of the last `days` local days, oldest day first, ending today. */
export function doneByDay(notes: Note[], today: string, days = 7): DayTally[] {
  const tallies = Array.from({ length: days }, (_, index) => ({
    date: addDays(today, index - (days - 1)),
    notes: [] as Note[],
  }))
  const byDate = new Map(tallies.map((tally) => [tally.date, tally]))
  for (const note of notes) {
    if (!note.done || !note.completed_at) continue
    byDate.get(toDateKey(new Date(note.completed_at)))?.notes.push(note)
  }
  return tallies
}

export function sortNotes(notes: Note[], order: SortOrder): Note[] {
  return notes.toSorted(order === 'due' ? byDueDate : order === 'title' ? byTitle : byNewest)
}

function byNewest(a: Note, b: Note) {
  return createdTime(b) - createdTime(a) || b.id - a.id
}

/** Soonest due first; notes with no due date go last. */
function byDueDate(a: Note, b: Note) {
  if (a.due_date === b.due_date) return byNewest(a, b)
  if (a.due_date === null) return 1
  if (b.due_date === null) return -1
  return a.due_date < b.due_date ? -1 : 1
}

function byTitle(a: Note, b: Note) {
  return titleOrder.compare(a.title, b.title) || byNewest(a, b)
}

function byCompletedNewest(a: Note, b: Note) {
  return completedTime(b) - completedTime(a) || b.id - a.id
}
