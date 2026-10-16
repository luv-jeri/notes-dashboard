import { ArrowDownUp, Plus, Search } from 'lucide-react'
import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { toInput, type Note, type NoteInput } from '../api/notes'
import { useNow } from '../hooks/useNow'
import { useShortcuts } from '../hooks/useShortcuts'
import { useStableCallback } from '../hooks/useStableCallback'
import { useStickyBar } from '../hooks/useStickyBar'
import { useStoredFlag } from '../hooks/useStoredFlag'
import { Rail } from '../layout/Rail'
import { SidePanel } from '../panel/SidePanel'
import { useTheme } from '../theme/useTheme'
import { useToast } from '../toast/ToastContext'
import { Select, type SelectOption } from '../ui/Select'
import { CATEGORY_META } from './categories'
import { CategoryPills } from './CategoryPills'
import { greeting, toDateKey } from './dates'
import { NoteCard, type CardAction, type CardActionHandler } from './NoteCard'
import { NoteFormDialog, type NoteDefaults } from './NoteFormDialog'
import { NoteMap } from './NoteMap'
import { NotesLoading, NotesMessage } from './NotesStates'
import {
  countDue,
  selectSections,
  type CategoryFilter,
  type Filters,
  type SortOrder,
  type View,
} from './selectNotes'
import { formatCount, quoteTitle } from './text'
import { useCreateNote, useDeleteNote, useNotesQuery, useUpdateNote } from './useNotes'
import styles from './NotesDashboard.module.css'
import gridStyles from './NotesStates.module.css'

type DialogState =
  | { mode: 'closed' }
  | { mode: 'create'; defaults: NoteDefaults }
  | { mode: 'edit'; note: Note }

/** Focus to place once a card has re-rendered somewhere else or left the page. */
interface PendingFocus {
  /** The card's list item before the change. Focus waits until it is gone. */
  leaving: Element | null
  target: () => HTMLElement | null
}

/** Cards rendered per section before "Show more". Fills 1, 2, 3, 4 or 6 columns evenly. */
const PAGE_SIZE = 48

const SORT_OPTIONS: readonly SelectOption<SortOrder>[] = [
  { value: 'newest', label: 'Newest first' },
  { value: 'due', label: 'Due date' },
  { value: 'title', label: 'A to Z' },
]

const cardItem = (id: number) => document.querySelector(`li[data-note-id="${id}"]`)
const cardControl = (id: number, action: CardAction) =>
  document.querySelector<HTMLElement>(`li[data-note-id="${id}"] [data-action="${action}"]`)

export function NotesDashboard() {
  const notesQuery = useNotesQuery()
  const createNote = useCreateNote()
  const updateNote = useUpdateNote()
  const deleteNote = useDeleteNote()
  const toast = useToast()
  const { theme, toggle: toggleTheme } = useTheme()
  const now = useNow()
  const today = toDateKey(now)

  const [view, setView] = useState<View>('all')
  const [category, setCategory] = useState<CategoryFilter>('all')
  const [sort, setSort] = useState<SortOrder>('newest')
  const [search, setSearch] = useState('')
  // Typing stays responsive with many notes: React filters at a lower priority.
  const deferredSearch = useDeferredValue(search)
  const [dialog, setDialog] = useState<DialogState>({ mode: 'closed' })
  // Both side columns remember how they were left.
  const [railExpanded, setRailExpanded] = useStoredFlag('notes-rail-expanded', false)
  const [panelCollapsed, setPanelCollapsed] = useStoredFlag('notes-panel-collapsed', false)
  const toggleRail = useCallback(() => setRailExpanded((current) => !current), [setRailExpanded])
  const togglePanel = useCallback(() => setPanelCollapsed((current) => !current), [setPanelCollapsed])

  const searchInput = useRef<HTMLInputElement>(null)
  const newNoteButton = useRef<HTMLButtonElement>(null)
  const pendingFocus = useRef<PendingFocus | null>(null)
  const headlineRef = useRef<HTMLHeadingElement>(null)
  const toolbar = useRef<HTMLDivElement>(null)
  const notesArea = useRef<HTMLDivElement>(null)
  const stuck = useStickyBar(toolbar, headlineRef)

  const notes = notesQuery.data
  const filters: Filters = useMemo(
    () => ({ view, category, search: deferredSearch, sort, today }),
    [view, category, deferredSearch, sort, today],
  )
  const sections = useMemo(() => selectSections(notes ?? [], filters), [notes, filters])
  const { dueToday, overdue } = useMemo(() => countDue(notes ?? [], today), [notes, today])
  const sectionOf = (note: Note) => selectSections([note], filters)[0]?.id
  // Today and Done keep their own order (soonest due, latest finished), so
  // Sort only shows where it changes something.
  const canSort = (view === 'all' || view === 'pinned') && sections.some((section) => section.id !== 'done')

  // Runs after every render: once the card that had focus has moved or gone,
  // put focus where the last action asked for it.
  useLayoutEffect(() => {
    const pending = pendingFocus.current
    if (!pending || pending.leaving?.isConnected) return
    const target = pending.target()
    if (!target) return
    pendingFocus.current = null
    target.focus()
  })

  // The safety net for every other case, such as a retried change taking the
  // focused card away: New note takes focus rather than the page body. Without
  // scrolling, so a mouse user's page stays put.
  const lastFocused = useRef<Element | null>(null)
  useEffect(() => {
    const remember = (event: FocusEvent) => {
      if (event.target instanceof Element) lastFocused.current = event.target
    }
    document.addEventListener('focusin', remember)
    return () => document.removeEventListener('focusin', remember)
  }, [])
  useLayoutEffect(() => {
    if (document.activeElement !== document.body || lastFocused.current?.isConnected !== false) return
    newNoteButton.current?.focus({ preventScroll: true })
  })

  function focusAfterRender(leaving: Element | null, target: () => HTMLElement | null) {
    const pending = { leaving, target }
    pendingFocus.current = pending
    // Forget the request if the change never happens, for example a failed save.
    window.setTimeout(() => {
      if (pendingFocus.current === pending) pendingFocus.current = null
    }, 1500)
  }

  /**
   * The card is about to leave its list. If focus is on it, move focus to the
   * same button on the card that takes its place, so someone ticking off a
   * list with the keyboard can keep pressing Space.
   */
  function focusNeighbourOnLeave(note: Note, action: CardAction, focusIsComingBack = false) {
    const item = cardItem(note.id)
    if (!item || (!focusIsComingBack && !item.contains(document.activeElement))) return
    const neighbour = item.nextElementSibling ?? item.previousElementSibling
    const neighbourId = Number(neighbour?.getAttribute('data-note-id'))
    focusAfterRender(item, () =>
      (neighbourId ? cardControl(neighbourId, action) : null) ?? newNoteButton.current,
    )
  }

  /**
   * The card is moving to another list: keep focus on it. If it lands past
   * the cards shown so far in that list, focus the New note button instead.
   */
  function followCard(id: number, action: CardAction) {
    focusAfterRender(cardItem(id), () => cardControl(id, action) ?? newNoteButton.current)
  }

  function openNewNote() {
    const defaults: NoteDefaults = {}
    if (category !== 'all') defaults.category = category
    if (view === 'today') defaults.due_date = today
    if (view === 'pinned') defaults.pinned = true
    setDialog({ mode: 'create', defaults })
  }

  function handleSubmit(input: NoteInput) {
    if (dialog.mode === 'edit') {
      const before = dialog.note
      const after = { ...before, ...input }
      // The dialog hands focus back to the card's title. If the edit moves the
      // card to another list, or out of this view, that title is about to go.
      if (sectionOf(before) !== sectionOf(after)) {
        if (sectionOf(after)) followCard(before.id, 'open')
        else focusNeighbourOnLeave(before, 'open', true)
      }
      updateNote.mutate({ id: before.id, input })
      return
    }

    createNote.mutate(input)
    // A new note that the current view or filters would hide looks lost.
    const draft: Note = {
      id: 0,
      ...input,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      completed_at: null,
    }
    if (!sectionOf(draft)) {
      setView('all')
      setCategory('all')
      setSearch('')
      toast.show({ message: `Showing all notes, so ${quoteTitle(input.title)} is in view.` })
    }
  }

  function toggleDone(note: Note) {
    const input = { ...toInput(note), done: !note.done }
    if (sectionOf(note) !== sectionOf({ ...note, ...input })) focusNeighbourOnLeave(note, 'done')
    updateNote.mutate({ id: note.id, input })
    if (input.done) {
      toast.show({
        message: `Marked ${quoteTitle(note.title)} as done.`,
        action: {
          label: 'Undo',
          onAction: () => {
            followCard(note.id, 'done')
            updateNote.mutate({ id: note.id, input: toInput(note) })
          },
        },
      })
    }
  }

  function togglePin(note: Note) {
    const input = { ...toInput(note), pinned: !note.pinned }
    if (sectionOf(note) !== sectionOf({ ...note, ...input })) focusNeighbourOnLeave(note, 'pin')
    updateNote.mutate({ id: note.id, input })
  }

  function handleDelete(note: Note) {
    focusNeighbourOnLeave(note, 'open')
    deleteNote.mutate(note.id)
  }

  // One function with a fixed identity for every card, so the memoised cards
  // skip re-rendering when only the dashboard's own state changes.
  const onCardAction = useStableCallback<Parameters<CardActionHandler>, void>((action, note) => {
    if (action === 'open') setDialog({ mode: 'edit', note })
    else if (action === 'pin') togglePin(note)
    else if (action === 'delete') handleDelete(note)
    else toggleDone(note)
  })
  const openEditor = useCallback((note: Note) => setDialog({ mode: 'edit', note }), [])

  // The buttons that clear filters disappear once they work, so focus moves
  // to the search box instead of falling back to the page.
  function clearFilters({ keepSearch = false } = {}) {
    if (!keepSearch) setSearch('')
    setCategory('all')
    setView('all')
    searchInput.current?.focus()
  }

  function showAllNotes() {
    setView('all')
    searchInput.current?.focus()
  }

  useShortcuts({
    n: () => {
      // The editor hands focus back to whatever had it. Pressed from nowhere
      // in particular, that's the page itself, so start from New note instead.
      if (document.activeElement === document.body) newNoteButton.current?.focus()
      openNewNote()
    },
    '/': () => searchInput.current?.focus(),
  })

  function headline(): string {
    if (notesQuery.isPending) return 'Loading your notes'
    if (!notes) return "Your notes didn't load"
    if (dueToday > 0) return `${formatCount(dueToday)} ${dueToday === 1 ? 'note' : 'notes'} due today`
    if (overdue > 0) return `${formatCount(overdue)} overdue ${overdue === 1 ? 'note' : 'notes'}`
    if (notes.length === 0) return 'Start your first note'
    if (notes.some((note) => !note.done)) return 'Nothing due today'
    return "Everything's done"
  }

  function renderEmpty() {
    const query = deferredSearch.trim()
    const label = category === 'all' ? null : CATEGORY_META[category].label.toLowerCase()

    if (query) {
      const narrowed = view !== 'all' || category !== 'all'
      return (
        <NotesMessage
          title={`No notes match ${quoteTitle(query)}`}
          detail={
            narrowed
              ? 'The search only looked in this view and category.'
              : 'Check the spelling or try another word.'
          }
          actionLabel={narrowed ? 'Search all notes' : 'Clear search'}
          onAction={() => clearFilters({ keepSearch: narrowed })}
        />
      )
    }

    if (label) {
      const titles: Record<View, string> = {
        all: `No ${label} notes yet`,
        today: `No ${label} notes due today`,
        pinned: `No pinned ${label} notes`,
        done: `No ${label} notes done yet`,
      }
      return (
        <NotesMessage
          title={titles[view]}
          detail="Pick another category, or add a note to this one."
          actionLabel="Show all categories"
          onAction={() => {
            setCategory('all')
            searchInput.current?.focus()
          }}
        />
      )
    }

    if (view === 'today') {
      return (
        <NotesMessage
          title="Nothing due today"
          detail="Notes due today, and any that are overdue, show up here."
          actionLabel="Add a note for today"
          onAction={() => {
            newNoteButton.current?.focus()
            openNewNote()
          }}
        />
      )
    }
    if (view === 'pinned') {
      return (
        <NotesMessage
          title="No pinned notes"
          detail="Pin a note to keep it at the top of your notes."
          actionLabel="Show all notes"
          onAction={showAllNotes}
        />
      )
    }
    return (
      <NotesMessage
        title="Nothing done yet"
        detail="Tick the check on a note when you finish it, and it moves here."
        actionLabel="Show all notes"
        onAction={showAllNotes}
      />
    )
  }

  function renderNotes() {
    if (notesQuery.isPending) return <NotesLoading />

    if (!notes) {
      return (
        <NotesMessage
          title="Your notes didn't load"
          detail={notesQuery.error?.message}
          actionLabel="Try again"
          onAction={() => void notesQuery.refetch()}
        />
      )
    }

    if (notes.length === 0) {
      return (
        <NotesMessage
          title="No notes yet"
          detail="Write down a task, a list or an idea. Give it a due date to see it in Today."
          actionLabel="New note"
          onAction={() => {
            // This button disappears once a note exists. Focusing the header
            // button first means the dialog hands focus back to one that stays.
            newNoteButton.current?.focus()
            openNewNote()
          }}
        />
      )
    }

    if (sections.length === 0) return renderEmpty()

    return (
      <div className={styles.sections}>
        {sections.map((section) => (
          <section
            key={section.id}
            className={styles.section}
            aria-labelledby={`section-${section.id}`}
            data-map-section=""
          >
            <div className={styles.sectionHead}>
              {/* Heard as "Pinned, 3 notes". Built from the visible parts, a
                  hidden comma came out as "Pinned , 3" in Chrome. */}
              <h2
                id={`section-${section.id}`}
                className={styles.sectionTitle}
                aria-label={`${section.title}, ${formatCount(section.notes.length)} ${section.notes.length === 1 ? 'note' : 'notes'}`}
              >
                {section.title}
                <span className={styles.count}>{formatCount(section.notes.length)}</span>
              </h2>
            </div>
            {/* A new view, category or sort starts each list at its first page again. */}
            <SectionGrid
              key={`${view}-${category}-${sort}`}
              notes={section.notes}
              today={today}
              now={now}
              onAction={onCardAction}
            />
          </section>
        ))}
      </div>
    )
  }

  const shownCount = sections.reduce((sum, section) => sum + section.notes.length, 0)

  return (
    <div
      className={styles.app}
      data-rail={railExpanded ? 'expanded' : undefined}
      data-panel={panelCollapsed ? 'collapsed' : undefined}
    >
      <div className={styles.railSlot}>
        <Rail
          view={view}
          onViewChange={setView}
          dueCount={dueToday + overdue}
          theme={theme}
          onToggleTheme={toggleTheme}
          expanded={railExpanded}
          onToggleExpanded={toggleRail}
        />
      </div>

      <main className={styles.main}>
        <h1 ref={headlineRef} className={styles.headline}>
          <span className={styles.headlineLine}>{greeting(now)},</span>{' '}
          <span className={styles.headlineLine}>{headline()}</span>
        </h1>

        {/* Stays at the top of the screen while the notes scroll under it. In
            the page's order the actions come first, as they did in the header. */}
        <div ref={toolbar} className={styles.toolbar} data-stuck={stuck || undefined}>
          <div className={styles.actions}>
            <div className={styles.search}>
              <Search size={18} aria-hidden="true" />
              <input
                ref={searchInput}
                type="search"
                name="search"
                // It filters as you type, so the browser's list of past searches would only cover the results.
                autoComplete="off"
                aria-label="Search notes"
                aria-keyshortcuts="/"
                placeholder="Search notes"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              {!search && (
                <kbd className={styles.kbd} aria-hidden="true">
                  /
                </kbd>
              )}
            </div>
            {canSort && (
              <Select label="Sort" value={sort} options={SORT_OPTIONS} onChange={setSort} icon={ArrowDownUp} />
            )}
            <button
              ref={newNoteButton}
              type="button"
              className={`button button-primary ${styles.newNote}`}
              aria-keyshortcuts="n"
              onClick={openNewNote}
            >
              <Plus size={18} className={styles.newNoteIcon} aria-hidden="true" />
              <span className={styles.newNoteLabel}>New note</span>
            </button>
          </div>

          <div className={styles.filters}>
            <CategoryPills value={category} onChange={setCategory} />
          </div>
        </div>

        {/* A background refresh failed, but the last good copy is still on screen. */}
        {notes && notesQuery.isError && (
          <p className={styles.stale} role="status">
            <span>{notesQuery.error.message} Showing the notes from the last successful load.</span>
            <button
              type="button"
              className="button button-small button-primary"
              onClick={() => void notesQuery.refetch()}
            >
              Try again
            </button>
          </p>
        )}

        <p className="visually-hidden" role="status">
          {notes ? `${formatCount(shownCount)} ${shownCount === 1 ? 'note' : 'notes'} found` : ''}
        </p>

        <div ref={notesArea} className={styles.notesArea}>
          {renderNotes()}
        </div>
      </main>

      <div className={styles.mapSlot}>
        <NoteMap content={notesArea} toolbar={toolbar} layoutKey={sections} />
      </div>

      <div className={styles.panelSlot}>
        <SidePanel
          notes={notes}
          today={today}
          now={now}
          onOpen={openEditor}
          collapsed={panelCollapsed}
          onToggleCollapsed={togglePanel}
        />
      </div>

      {dialog.mode !== 'closed' && (
        <NoteFormDialog
          key={dialog.mode === 'edit' ? dialog.note.id : 'new'}
          note={dialog.mode === 'edit' ? dialog.note : undefined}
          defaults={dialog.mode === 'create' ? dialog.defaults : undefined}
          today={today}
          onSubmit={handleSubmit}
          onClose={() => setDialog({ mode: 'closed' })}
        />
      )}
    </div>
  )
}

interface SectionGridProps {
  notes: Note[]
  today: string
  now: Date
  onAction: CardActionHandler
}

/**
 * Renders a section's cards a page at a time. Thousands of notes would mean
 * thousands of cards to build and lay out; search finds the rest.
 */
function SectionGrid({ notes, today, now, onAction }: SectionGridProps) {
  const [limit, setLimit] = useState(PAGE_SIZE)
  const list = useRef<HTMLUListElement>(null)
  const shown = notes.length > limit ? notes.slice(0, limit) : notes
  const hidden = notes.length - shown.length

  function showMore() {
    const firstNew = shown.length
    flushSync(() => setLimit((current) => current + PAGE_SIZE))
    // Carry on reading where the new cards start. On the last page the button
    // disappears, so focus needs a new home anyway.
    list.current?.children[firstNew]?.querySelector<HTMLElement>('[data-action="open"]')?.focus()
  }

  return (
    <>
      <ul ref={list} className={gridStyles.grid}>
        {shown.map((note) => (
          <li
            key={note.id}
            data-note-id={note.id}
            data-category={note.category}
            data-done={note.done || undefined}
          >
            <NoteCard note={note} today={today} now={now} onAction={onAction} />
          </li>
        ))}
      </ul>
      {hidden > 0 && (
        <div className={styles.more}>
          <p className={styles.moreCount}>
            Showing {formatCount(shown.length)} of {formatCount(notes.length)}
          </p>
          <button type="button" className="button button-small button-outline" onClick={showMore}>
            Show {formatCount(Math.min(hidden, PAGE_SIZE))} more
          </button>
        </div>
      )}
    </>
  )
}
