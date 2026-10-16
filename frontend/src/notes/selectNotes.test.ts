import { describe, expect, it } from 'vitest'
import { makeNote } from '../test/notes'
import { selectSections, type Filters } from './selectNotes'

const today = '2026-10-16'
const filters = (overrides: Partial<Filters> = {}): Filters => ({
  view: 'all',
  category: 'all',
  search: '',
  sort: 'newest',
  today,
  ...overrides,
})
const titles = (notes: { title: string }[]) => notes.map((note) => note.title)

describe('selectSections', () => {
  it('splits all notes into pinned, the rest, and done, leaving out empty sections', () => {
    const notes = [
      makeNote({ title: 'Pinned', pinned: true }),
      makeNote({ title: 'Open' }),
      makeNote({ title: 'Finished', done: true }),
      // A done note leaves Pinned even if it was pinned.
      makeNote({ title: 'Pinned and finished', pinned: true, done: true }),
    ]

    const sections = selectSections(notes, filters())

    expect(sections.map((section) => section.id)).toEqual(['pinned', 'notes', 'done'])
    expect(titles(sections[0].notes)).toEqual(['Pinned'])
    expect(titles(sections[2].notes)).toEqual(['Finished', 'Pinned and finished'])
    expect(selectSections([makeNote()], filters()).map((section) => section.id)).toEqual(['notes'])
  })

  it('searches titles and content, ignoring case and surrounding spaces', () => {
    const notes = [
      makeNote({ title: 'Buy LEMONS' }),
      makeNote({ title: 'Groceries', content: 'lemons, basil' }),
      makeNote({ title: 'Call the bank' }),
    ]

    const [section] = selectSections(notes, filters({ search: '  Lemons ' }))

    expect(titles(section.notes)).toEqual(['Buy LEMONS', 'Groceries'])
  })

  it('filters by category', () => {
    const notes = [makeNote({ title: 'Deck', category: 'work' }), makeNote({ category: 'health' })]

    const [section] = selectSections(notes, filters({ category: 'work' }))

    expect(titles(section.notes)).toEqual(['Deck'])
  })

  it('shows overdue notes, most overdue first, then notes due today, in the Today view', () => {
    const notes = [
      makeNote({ title: 'Due today', due_date: today }),
      makeNote({ title: 'Two days late', due_date: '2026-10-14' }),
      makeNote({ title: 'Five days late', due_date: '2026-10-11' }),
      makeNote({ title: 'Next week', due_date: '2026-10-23' }),
      makeNote({ title: 'Late but done', due_date: '2026-10-10', done: true }),
    ]

    const sections = selectSections(notes, filters({ view: 'today' }))

    expect(sections.map((section) => section.id)).toEqual(['overdue', 'today'])
    expect(titles(sections[0].notes)).toEqual(['Five days late', 'Two days late'])
    expect(titles(sections[1].notes)).toEqual(['Due today'])
  })

  it('sorts A to Z the way people read numbers, so Week 2 comes before Week 10', () => {
    const notes = [makeNote({ title: 'week 10' }), makeNote({ title: 'Week 2' }), makeNote({ title: 'apples' })]

    const [section] = selectSections(notes, filters({ sort: 'title' }))

    expect(titles(section.notes)).toEqual(['apples', 'Week 2', 'week 10'])
  })

  it('sorts by due date with undated notes last', () => {
    const notes = [
      makeNote({ title: 'No date' }),
      makeNote({ title: 'Later', due_date: '2026-11-01' }),
      makeNote({ title: 'Sooner', due_date: '2026-10-20' }),
    ]

    const [section] = selectSections(notes, filters({ sort: 'due' }))

    expect(titles(section.notes)).toEqual(['Sooner', 'Later', 'No date'])
  })
})
