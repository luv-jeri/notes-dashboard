import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { User } from '../api/auth'
import { categoriesApi, type CustomCategory } from '../api/categories'
import { notesApi, type Note } from '../api/notes'
import { useAddSampleNotes } from '../notes/useNotes'
import { categoriesKey, useCreateCategory } from '../notes/useCategories'
import { createQueryClient } from '../queryClient'
import { makeNote } from '../test/notes'
import { ToastProvider } from '../toast/ToastProvider'
import { setSession } from './session'

// Only the network calls are fake. Types, limits and helpers stay real.
vi.mock('../api/notes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/notes')>()),
  notesApi: { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), addSamples: vi.fn() },
}))
vi.mock('../api/categories', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/categories')>()),
  categoriesApi: { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() },
}))

const ada: User = { id: 1, name: 'Ada Lovelace', email: 'ada@example.com', email_verified: true }
const grace: User = { id: 2, name: 'Grace Hopper', email: 'grace@example.com', email_verified: true }

let client: QueryClient
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>
    <ToastProvider>{children}</ToastProvider>
  </QueryClientProvider>
)

/** A request that answers only when the test says so. */
function held<T>() {
  let answer!: (value: T) => void
  const promise = new Promise<T>((resolve) => (answer = resolve))
  return { promise, answer }
}

/** Ada logs out and Grace logs in on the same tab, and Grace's lists load. */
function switchToGrace(lists: { categories?: CustomCategory[]; notes?: Note[] }) {
  setSession(client, { user: null })
  setSession(client, { user: grace })
  if (lists.categories) client.setQueryData(categoriesKey, lists.categories)
  if (lists.notes) client.setQueryData(['notes'], lists.notes)
}

beforeEach(() => {
  vi.resetAllMocks()
  client = createQueryClient({ retry: false })
  setSession(client, { user: ada })
})

describe('A change that answers after someone else has logged in', () => {
  it("leaves the new person's categories alone", async () => {
    const graces: CustomCategory[] = [{ id: 5, key: 'c5', name: 'Garden', color: 'sage' }]
    client.setQueryData<CustomCategory[]>(categoriesKey, [])
    const create = held<CustomCategory>()
    vi.mocked(categoriesApi).create.mockReturnValueOnce(create.promise)
    const { result } = renderHook(() => useCreateCategory(), { wrapper })

    act(() => result.current.mutate({ name: 'Travel', color: 'sky' }))
    await waitFor(() => expect(categoriesApi.create).toHaveBeenCalledOnce())
    switchToGrace({ categories: graces })

    await act(async () => create.answer({ id: 7, key: 'c7', name: 'Travel', color: 'sky' }))
    await waitFor(() => expect(client.isMutating()).toBe(0))
    expect(client.getQueryData(categoriesKey)).toEqual(graces)
  })

  it("leaves the new person's notes alone", async () => {
    const graces = [makeNote({ title: 'Ship the compiler' })]
    client.setQueryData<Note[]>(['notes'], [])
    const samples = held<Note[]>()
    vi.mocked(notesApi).addSamples.mockReturnValueOnce(samples.promise)
    const { result } = renderHook(() => useAddSampleNotes(), { wrapper })

    act(() => result.current.mutate())
    await waitFor(() => expect(notesApi.addSamples).toHaveBeenCalledOnce())
    switchToGrace({ notes: graces })

    await act(async () => samples.answer([makeNote({ title: "Ada's sample note" })]))
    await waitFor(() => expect(client.isMutating()).toBe(0))
    expect(client.getQueryData(['notes'])).toEqual(graces)
  })

  it('still lands when the same person is logged in', async () => {
    client.setQueryData<CustomCategory[]>(categoriesKey, [])
    const travel: CustomCategory = { id: 7, key: 'c7', name: 'Travel', color: 'sky' }
    vi.mocked(categoriesApi).create.mockResolvedValueOnce(travel)
    const { result } = renderHook(() => useCreateCategory(), { wrapper })

    act(() => result.current.mutate({ name: 'Travel', color: 'sky' }))
    await waitFor(() => expect(client.getQueryData(categoriesKey)).toEqual([travel]))
  })
})
