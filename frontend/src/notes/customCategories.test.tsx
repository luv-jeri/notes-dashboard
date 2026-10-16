import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { authApi, type User } from '../api/auth'
import { categoriesApi, type CategoryColor, type CustomCategory } from '../api/categories'
import { ApiError } from '../api/client'
import { CATEGORIES, notesApi, type Note } from '../api/notes'
import { App } from '../App'
import { createQueryClient } from '../queryClient'
import { makeNote } from '../test/notes'

// Only the network calls are fake. Types, limits and helpers stay real.
vi.mock('../api/notes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/notes')>()),
  notesApi: { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), addSamples: vi.fn() },
}))
vi.mock('../api/auth', async (importOriginal) => {
  const real = await importOriginal<typeof import('../api/auth')>()
  return { ...real, authApi: Object.fromEntries(Object.keys(real.authApi).map((name) => [name, vi.fn()])) }
})
vi.mock('../api/categories', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/categories')>()),
  categoriesApi: { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() },
}))
const notesCalls = vi.mocked(notesApi)
const categoryCalls = vi.mocked(categoriesApi)
const auth = vi.mocked(authApi)

const ada: User = { id: 1, name: 'Ada Lovelace', email: 'ada@example.com', email_verified: true }

/** What the fake server holds. */
let notes: Note[] = []
let categories: CustomCategory[] = []
let nextCategoryId = 1

function addCategory(name: string, color: CategoryColor): CustomCategory {
  const id = nextCategoryId++
  const category = { id, key: `c${id}`, name, color }
  categories = [...categories, category]
  return category
}

/** As the server does: names are unique per person, whatever their case. */
function checkName(name: string, ownId?: number) {
  if (categories.some((c) => c.id !== ownId && c.name.toLowerCase() === name.toLowerCase())) {
    throw new ApiError(409, `You already have a category called "${name}".`)
  }
}

function checkCategory(category: string) {
  if (!(CATEGORIES as readonly string[]).includes(category) && !categories.some((c) => c.key === category)) {
    throw new ApiError(422, 'Choose a category from the list.')
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  notes = [makeNote({ title: 'Buy lemons' })]
  categories = []
  nextCategoryId = 1

  notesCalls.list.mockImplementation(async () => [...notes])
  notesCalls.create.mockImplementation(async (input) => {
    checkCategory(input.category)
    const note = makeNote(input)
    notes = [note, ...notes]
    return note
  })
  notesCalls.update.mockImplementation(async (id, input) => {
    checkCategory(input.category)
    const note = { ...notes.find((n) => n.id === id)!, ...input }
    notes = notes.map((n) => (n.id === id ? note : n))
    return note
  })

  categoryCalls.list.mockImplementation(async () => [...categories])
  categoryCalls.create.mockImplementation(async ({ name, color }) => {
    checkName(name)
    return addCategory(name, color)
  })
  categoryCalls.update.mockImplementation(async (id, patch) => {
    if (patch.name !== undefined) checkName(patch.name, id)
    const category = { ...categories.find((c) => c.id === id)!, ...patch }
    categories = categories.map((c) => (c.id === id ? category : c))
    return category
  })
  categoryCalls.remove.mockImplementation(async (id) => {
    const gone = categories.find((c) => c.id === id)!
    notes = notes.map((n) => (n.category === gone.key ? { ...n, category: 'personal' } : n))
    categories = categories.filter((c) => c.id !== id)
  })

  auth.me.mockResolvedValue(ada)
})

function renderApp() {
  render(<App queryClient={createQueryClient({ retry: false })} />)
  return userEvent.setup()
}

type Session = ReturnType<typeof renderApp>

const card = (title: string) => screen.getByRole('article', { name: title })
const filterRow = () => screen.getByRole('group', { name: 'Filter by category' })
/** The card's colour, as a token name: "var(--sage)". */
const fillOf = (article: HTMLElement) => article.style.getPropertyValue('--category-fill')

async function openNewNote(user: Session) {
  await user.click(screen.getByRole('button', { name: 'New note' }))
  return screen.getByRole('dialog', { name: 'New note' })
}

async function openManager(user: Session) {
  await user.click(within(filterRow()).getByRole('button', { name: 'Edit categories' }))
  return screen.getByRole('dialog', { name: 'Your categories' })
}

describe('Custom categories', () => {
  it('adds a category from the note form, saves the note in it, and filters by it', async () => {
    const user = renderApp()
    await screen.findByRole('article', { name: 'Buy lemons' })
    const dialog = await openNewNote(user)
    await user.keyboard('Book flights')

    // Escape closes the little form, not the note.
    const newCategory = within(dialog).getByRole('button', { name: 'New category' })
    await user.click(newCategory)
    expect(newCategory).toHaveAttribute('aria-expanded', 'true')
    await user.keyboard('{Escape}')
    expect(within(dialog).queryByRole('group', { name: 'New category' })).not.toBeInTheDocument()
    expect(newCategory).toHaveFocus()
    expect(dialog).toHaveAttribute('open')

    await user.click(newCategory)
    const form = within(dialog).getByRole('group', { name: 'New category' })
    expect(within(form).getByRole('textbox', { name: 'Name' })).toHaveFocus()
    // The first colour no category uses yet, built-in ones included.
    expect(within(form).getByRole('radio', { name: 'Butter' })).toBeChecked()
    await user.keyboard('Travel{Enter}')

    const travel = await within(dialog).findByRole('radio', { name: 'Travel' })
    expect(categoryCalls.create).toHaveBeenCalledWith({ name: 'Travel', color: 'butter' })
    await waitFor(() => expect(travel).toHaveFocus())
    expect(travel).toBeChecked()
    expect(within(dialog).queryByRole('group', { name: 'New category' })).not.toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: 'Add note' }))
    await waitFor(() =>
      expect(notesCalls.create).toHaveBeenCalledWith(expect.objectContaining({ title: 'Book flights', category: 'c1' })),
    )
    await waitFor(() => expect(card('Book flights')).not.toHaveTextContent('Saving…'))
    expect(card('Book flights')).toHaveTextContent('Travel')
    expect(fillOf(card('Book flights'))).toBe('var(--butter)')

    // All, the built-in ones, theirs, then the way to change them.
    const pills = within(filterRow()).getAllByRole('button')
    expect(pills).toHaveLength(8)
    expect(pills[5]).toHaveAccessibleName('Health')
    expect(pills[6]).toHaveAccessibleName('Travel')
    expect(pills[7]).toHaveAccessibleName('Edit categories')

    await user.click(pills[6])
    expect(pills[6]).toHaveAttribute('aria-pressed', 'true')
    await waitFor(() => expect(screen.queryByRole('article', { name: 'Buy lemons' })).not.toBeInTheDocument())
    expect(card('Book flights')).toBeInTheDocument()
  })

  it('renames a category', async () => {
    addCategory('Travel', 'sky')
    notes = [makeNote({ title: 'Book flights', category: 'c1' })]
    const user = renderApp()
    expect(await screen.findByRole('article', { name: 'Book flights' })).toHaveTextContent('Travel')
    const manager = await openManager(user)

    // Escape leaves the name as it was, and the dialog open.
    await user.click(within(manager).getByRole('button', { name: 'Rename Travel' }))
    expect(within(manager).getByRole('textbox', { name: 'New name for Travel' })).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(within(manager).getByRole('button', { name: 'Rename Travel' })).toHaveFocus()
    expect(manager).toHaveAttribute('open')

    // The name starts selected, so typing replaces it.
    await user.click(within(manager).getByRole('button', { name: 'Rename Travel' }))
    await user.keyboard('Trips{Enter}')

    await waitFor(() => expect(within(manager).getByRole('button', { name: 'Rename Trips' })).toHaveFocus())
    expect(categoryCalls.update).toHaveBeenCalledOnce()
    expect(categoryCalls.update).toHaveBeenCalledWith(1, { name: 'Trips' })
    expect(card('Book flights')).toHaveTextContent('Trips')
    expect(within(filterRow()).getByRole('button', { name: 'Trips' })).toBeInTheDocument()
  })

  it('recolours a category before the server answers', async () => {
    addCategory('Travel', 'sky')
    notes = [makeNote({ title: 'Book flights', category: 'c1' })]
    let answer!: () => void
    const update = categoryCalls.update.getMockImplementation()!
    categoryCalls.update.mockImplementationOnce(async (id, patch) => {
      await new Promise<void>((resolve) => (answer = resolve))
      return update(id, patch)
    })
    const user = renderApp()
    await screen.findByRole('article', { name: 'Book flights' })
    const manager = await openManager(user)

    const colourButton = within(manager).getByRole('button', { name: 'Change colour of Travel' })
    await user.click(colourButton)
    expect(colourButton).toHaveAttribute('aria-expanded', 'true')
    const swatches = within(manager).getByRole('group', { name: 'Colour for Travel' })
    expect(within(swatches).getByRole('radio', { name: 'Sky' })).toBeChecked()

    await user.click(within(swatches).getByRole('radio', { name: 'Sage' }))
    await waitFor(() => expect(within(swatches).getByRole('radio', { name: 'Sage' })).toBeChecked())
    expect(fillOf(card('Book flights'))).toBe('var(--sage)')
    expect(categoryCalls.update).toHaveBeenCalledWith(1, { color: 'sage' })

    answer()
    await waitFor(() => expect(categories[0].color).toBe('sage'))
    expect(fillOf(card('Book flights'))).toBe('var(--sage)')

    // Escape puts the swatches away and keeps the dialog open.
    await user.keyboard('{Escape}')
    expect(within(manager).queryByRole('group', { name: 'Colour for Travel' })).not.toBeInTheDocument()
    expect(colourButton).toHaveFocus()
    expect(manager).toHaveAttribute('open')
  })

  it('deletes a category after asking, and its notes move to Personal', async () => {
    addCategory('Travel', 'sky')
    addCategory('Garden', 'sage')
    notes = [
      makeNote({ title: 'Book flights', category: 'c1' }),
      makeNote({ title: 'Pack the bags', category: 'c1' }),
      makeNote({ title: 'Renew passport', category: 'c1' }),
    ]
    const user = renderApp()
    await screen.findByRole('article', { name: 'Book flights' })
    // Filtering by the category that's about to go.
    await user.click(await within(filterRow()).findByRole('button', { name: 'Travel' }))
    const manager = await openManager(user)

    await user.click(within(manager).getByRole('button', { name: 'Delete Travel' }))
    expect(within(manager).getByText('Delete "Travel"? Its 3 notes move to Personal.')).toBeInTheDocument()
    expect(within(manager).getByRole('button', { name: 'Cancel' })).toHaveFocus()
    await user.click(within(manager).getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(within(manager).queryByRole('button', { name: 'Rename Travel' })).not.toBeInTheDocument())
    expect(categoryCalls.remove).toHaveBeenCalledWith(1)
    // Focus goes to the row that moved up into its place.
    expect(within(manager).getByRole('button', { name: 'Rename Garden' })).toHaveFocus()
    expect(within(filterRow()).queryByRole('button', { name: 'Travel' })).not.toBeInTheDocument()
    expect(within(filterRow()).getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true')
    for (const title of ['Book flights', 'Pack the bags', 'Renew passport']) {
      expect(card(title)).toHaveTextContent('Personal')
    }

    // A category with no notes asks without a count. Escape backs out.
    await user.click(within(manager).getByRole('button', { name: 'Delete Garden' }))
    expect(within(manager).getByText('Delete "Garden"?')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(within(manager).getByRole('button', { name: 'Delete Garden' })).toHaveFocus()
    expect(categoryCalls.remove).toHaveBeenCalledOnce()
  })

  it('shows a name the server refuses under the field', async () => {
    addCategory('Travel', 'sky')
    const user = renderApp()
    await screen.findByRole('article', { name: 'Buy lemons' })
    const dialog = await openNewNote(user)
    await within(dialog).findByRole('radio', { name: 'Travel' })

    await user.click(within(dialog).getByRole('button', { name: 'New category' }))
    const form = within(dialog).getByRole('group', { name: 'New category' })
    await user.keyboard('travel')
    await user.click(within(form).getByRole('button', { name: 'Add' }))

    const message = 'You already have a category called "travel".'
    const name = within(form).getByRole('textbox', { name: 'Name' })
    expect(await within(form).findByText(message)).toBeInTheDocument()
    expect(name).toHaveAttribute('aria-invalid', 'true')
    expect(name).toHaveAccessibleDescription(message)
    expect(name).toHaveFocus()
    // The note itself is untouched.
    expect(dialog).toHaveAttribute('open')
    expect(within(dialog).getByRole('radio', { name: 'Personal' })).toBeChecked()

    // The limit, from the "Your categories" dialog.
    await user.click(within(dialog).getByRole('button', { name: 'Close' }))
    categoryCalls.create.mockRejectedValueOnce(new ApiError(409, 'You can have up to 20 categories of your own.'))
    const manager = await openManager(user)
    const add = within(manager).getByRole('group', { name: 'New category' })
    await user.type(within(add).getByRole('textbox', { name: 'Name' }), 'Garden')
    await user.click(within(add).getByRole('button', { name: 'Add' }))
    expect(await within(add).findByText('You can have up to 20 categories of your own.')).toBeInTheDocument()
  })

  it("shows a note in a category it doesn't know as Personal", async () => {
    notes = [makeNote({ title: 'Old trip', category: 'c99' })]
    const user = renderApp()

    const old = await screen.findByRole('article', { name: 'Old trip' })
    expect(old).toHaveTextContent('Personal')
    expect(fillOf(old)).toBe('var(--rose)')

    await user.click(within(old).getByRole('button', { name: 'Old trip' }))
    const dialog = screen.getByRole('dialog', { name: 'Edit note' })
    expect(within(dialog).getByRole('radio', { name: 'Personal' })).toBeChecked()
  })

  it('saves a note whose category is gone as Personal, as the form shows it', async () => {
    addCategory('Garden', 'sage')
    const old = makeNote({ title: 'Old trip', category: 'c99' })
    notes = [old]
    const user = renderApp()
    const article = await screen.findByRole('article', { name: 'Old trip' })
    // Their categories have loaded, and c99 isn't one of them.
    await within(filterRow()).findByRole('button', { name: 'Garden' })

    await user.click(within(article).getByRole('button', { name: 'Old trip' }))
    const dialog = screen.getByRole('dialog', { name: 'Edit note' })
    await user.type(within(dialog).getByRole('textbox', { name: 'Title' }), ' to Rome')
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }))

    await waitFor(() =>
      expect(notesCalls.update).toHaveBeenCalledWith(
        old.id,
        expect.objectContaining({ title: 'Old trip to Rome', category: 'personal' }),
      ),
    )
  })

  it("keeps a note's category while their categories can't be loaded", async () => {
    addCategory('Travel', 'sky')
    const trip = makeNote({ title: 'Book flights', category: 'c1' })
    notes = [trip]
    categoryCalls.list.mockRejectedValue(new ApiError(0, "Can't reach the notes server."))
    const user = renderApp()

    await user.click(within(await screen.findByRole('article', { name: 'Book flights' })).getByRole('button', { name: 'Book flights' }))
    const dialog = screen.getByRole('dialog', { name: 'Edit note' })
    await user.type(within(dialog).getByRole('textbox', { name: 'Title' }), ' to Rome')
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }))

    await waitFor(() =>
      expect(notesCalls.update).toHaveBeenCalledWith(
        trip.id,
        expect.objectContaining({ title: 'Book flights to Rome', category: 'c1' }),
      ),
    )
  })
})
