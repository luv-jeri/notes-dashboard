import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { createContext, useContext } from 'react'
import { categoriesApi, type CategoryInput, type CustomCategory } from '../api/categories'
import type { Note } from '../api/notes'
import { useAccountMutation } from '../auth/session'
import { makeCatalog, type CategoryCatalog } from './categories'

/** Logging in as someone else removes this key, so one person's categories never show for the next. */
export const categoriesKey = ['categories'] as const
const writeKey = ['categories', 'write'] as const
/**
 * Category changes reach the server one at a time, in the order they were
 * made. Each still shows on screen at once: only the requests wait their turn.
 */
const writeScope = { id: 'categories' }
const notesKey = ['notes'] as const

/**
 * Every card, chart and form reads categories from here. Outside a provider
 * (a card on its own in a test, say) only the built-in ones exist.
 */
export const CategoriesContext = createContext<CategoryCatalog>(makeCatalog([]))
export const useCategoryCatalog = () => useContext(CategoriesContext)

export function useCategoriesQuery() {
  return useQuery({
    queryKey: categoriesKey,
    queryFn: ({ signal }) => categoriesApi.list(signal),
  })
}

/** Not optimistic: the new category's key only exists once the server answers. */
export function useCreateCategory() {
  const client = useQueryClient()
  return useAccountMutation({
    mutationKey: writeKey,
    scope: writeScope,
    mutationFn: (input: CategoryInput) => categoriesApi.create(input),
    onSuccess: (created) =>
      setCategories(client, (list) => [...list.filter((category) => category.id !== created.id), created]),
    onSettled: () => refetchWhenIdle(client),
  })
}

export interface CategoryPatch {
  id: number
  patch: Partial<CategoryInput>
}

/**
 * A new colour shows at once and goes back if the server refuses it. A new
 * name waits for the server, which may say it's taken.
 *
 * Arrowing through the swatches sends one change per colour. They reach the
 * server in that order (see writeScope), so the colour picked last is the one
 * saved. Each answer only touches what its own change asked for, and a colour
 * answer leaves the cache alone, so an early answer can't flick the colour
 * back while a later one is still waiting. The list reloads once they have
 * all settled.
 */
export function useUpdateCategory() {
  const client = useQueryClient()
  return useAccountMutation({
    mutationKey: writeKey,
    scope: writeScope,
    mutationFn: ({ id, patch }: CategoryPatch) => categoriesApi.update(id, patch),
    onMutate: async ({ id, patch }) => {
      await client.cancelQueries({ queryKey: categoriesKey })
      const previous = client.getQueryData<CustomCategory[]>(categoriesKey)?.find((c) => c.id === id)
      const { color } = patch
      if (color) setCategories(client, (list) => list.map((c) => (c.id === id ? { ...c, color } : c)))
      return { previous }
    },
    onSuccess: (saved, { patch }) => {
      if (patch.name === undefined) return
      setCategories(client, (list) => list.map((c) => (c.id === saved.id ? { ...c, name: saved.name } : c)))
    },
    onError: (_error, { id, patch }, context) => {
      const previous = context?.previous
      if (!previous || !patch.color) return
      // Only if a later pick hasn't replaced it already.
      setCategories(client, (list) =>
        list.map((c) => (c.id === id && c.color === patch.color ? { ...c, color: previous.color } : c)),
      )
    },
    onSettled: () => refetchWhenIdle(client),
  })
}

/**
 * The server moves the category's notes to Personal as it deletes it. The
 * cached notes move too, so the cards change at once, then the list reloads.
 * `onDeleted` runs even if the component that asked has gone by then.
 */
export function useDeleteCategory(onDeleted?: (category: CustomCategory) => void) {
  const client = useQueryClient()
  return useAccountMutation({
    mutationKey: writeKey,
    scope: writeScope,
    mutationFn: (category: CustomCategory) => categoriesApi.remove(category.id),
    onSuccess: (_answer, removed) => {
      setCategories(client, (list) => list.filter((category) => category.id !== removed.id))
      client.setQueryData<Note[]>(notesKey, (notes) =>
        notes?.map((note) => (note.category === removed.key ? { ...note, category: 'personal' } : note)),
      )
      void client.invalidateQueries({ queryKey: notesKey })
      onDeleted?.(removed)
    },
    onSettled: () => refetchWhenIdle(client),
  })
}

/** How many notes in the cache belong to a category. */
export function useCountNotesIn() {
  const client = useQueryClient()
  return (key: string) =>
    client.getQueryData<Note[]>(notesKey)?.filter((note) => note.category === key).length ?? 0
}

/** Edits the cached list. Does nothing until the first load has finished. */
function setCategories(client: QueryClient, update: (list: CustomCategory[]) => CustomCategory[]) {
  client.setQueryData<CustomCategory[]>(categoriesKey, (list) => list && update(list))
}

/** Re-syncs once the last pending change settles, as the notes do (see useNotes.ts). */
function refetchWhenIdle(client: QueryClient) {
  if (client.isMutating({ mutationKey: writeKey }) === 1) {
    void client.invalidateQueries({ queryKey: categoriesKey })
  }
}
