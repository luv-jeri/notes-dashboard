import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { notesApi, type Note, type NoteInput } from '../api/notes'
import { useToast } from '../toast/ToastContext'
import { quoteTitle } from './text'

const notesKey = ['notes'] as const
const writeKey = ['notes', 'write'] as const

// A note created optimistically carries a negative id until the server
// answers with the real one.
let lastTempId = 0
const nextTempId = () => --lastTempId

export const isUnsaved = (note: Note) => note.id < 0

export function useNotesQuery() {
  return useQuery({
    queryKey: notesKey,
    queryFn: ({ signal }) => notesApi.list(signal),
  })
}

export function useCreateNote() {
  const client = useQueryClient()
  const toast = useToast()

  const mutation = useMutation({
    mutationKey: writeKey,
    mutationFn: (input: NoteInput) => notesApi.create(input),
    onMutate: async (input) => {
      await client.cancelQueries({ queryKey: notesKey })
      const tempId = nextTempId()
      const now = new Date().toISOString()
      // The server sets the real timestamps; these keep the card readable until it answers.
      const draft: Note = {
        id: tempId,
        ...input,
        created_at: now,
        updated_at: now,
        completed_at: input.done ? now : null,
      }
      setNotes(client, (notes) => [draft, ...notes])
      return { tempId }
    },
    onSuccess: (saved, _input, { tempId }) => {
      setNotes(client, (notes) => notes.map((note) => (note.id === tempId ? saved : note)))
    },
    onError: (error, input, context) => {
      if (context) setNotes(client, (notes) => notes.filter((note) => note.id !== context.tempId))
      toast.show({
        tone: 'error',
        message: `Couldn't add ${quoteTitle(input.title)}. ${error.message}`,
        action: { label: 'Try again', onAction: () => mutation.mutate(input) },
      })
    },
    onSettled: () => refetchWhenIdle(client),
  })

  return mutation
}

export function useUpdateNote() {
  const client = useQueryClient()
  const toast = useToast()

  const mutation = useMutation({
    mutationKey: writeKey,
    mutationFn: ({ id, input }: { id: number; input: NoteInput }) => notesApi.update(id, input),
    onMutate: async ({ id, input }) => {
      await client.cancelQueries({ queryKey: notesKey })
      const previous = client.getQueryData<Note[]>(notesKey)?.find((note) => note.id === id)
      setNotes(client, (notes) =>
        notes.map((note) => (note.id === id ? applyInput(note, input) : note)),
      )
      return { previous }
    },
    onSuccess: (saved) => {
      setNotes(client, (notes) => notes.map((note) => (note.id === saved.id ? saved : note)))
    },
    onError: (error, variables, context) => {
      const previous = context?.previous
      if (previous) {
        setNotes(client, (notes) => notes.map((note) => (note.id === previous.id ? previous : note)))
      }
      toast.show({
        tone: 'error',
        message: `Couldn't save changes to ${quoteTitle(previous?.title ?? variables.input.title)}. ${error.message}`,
        action: { label: 'Try again', onAction: () => mutation.mutate(variables) },
      })
    },
    onSettled: () => refetchWhenIdle(client),
  })

  return mutation
}

export function useDeleteNote() {
  const client = useQueryClient()
  const toast = useToast()

  const mutation = useMutation({
    mutationKey: writeKey,
    mutationFn: (id: number) => notesApi.remove(id),
    onMutate: async (id) => {
      await client.cancelQueries({ queryKey: notesKey })
      const notes = client.getQueryData<Note[]>(notesKey) ?? []
      const index = notes.findIndex((note) => note.id === id)
      setNotes(client, (current) => current.filter((note) => note.id !== id))
      return { removed: notes[index] as Note | undefined, index }
    },
    onError: (error, id, context) => {
      const removed = context?.removed
      if (removed) {
        // Put the note back where it was, unless a refetch already restored it.
        setNotes(client, (notes) =>
          notes.some((note) => note.id === removed.id)
            ? notes
            : notes.toSpliced(context.index, 0, removed),
        )
      }
      toast.show({
        tone: 'error',
        message: `Couldn't delete ${removed ? quoteTitle(removed.title) : 'the note'}. ${error.message}`,
        action: { label: 'Try again', onAction: () => mutation.mutate(id) },
      })
    },
    onSettled: () => refetchWhenIdle(client),
  })

  return mutation
}

/** The note as it will look once the server accepts the edit, mirroring backend/main.py. */
function applyInput(note: Note, input: NoteInput): Note {
  const now = new Date().toISOString()
  const completedAt = input.done ? (note.done ? note.completed_at : now) : null
  return { ...note, ...input, updated_at: now, completed_at: completedAt }
}

/** Edits the cached list in place. Does nothing until the first load has finished. */
function setNotes(client: QueryClient, update: (notes: Note[]) => Note[]) {
  client.setQueryData<Note[]>(notesKey, (notes) => notes && update(notes))
}

/**
 * Re-syncs with the server once the last pending write settles. Refetching
 * while another write is still in flight would briefly undo that write's
 * optimistic change.
 */
function refetchWhenIdle(client: QueryClient) {
  // The settling mutation still counts itself, so 1 means "only me".
  if (client.isMutating({ mutationKey: writeKey }) === 1) {
    void client.invalidateQueries({ queryKey: notesKey })
  }
}
