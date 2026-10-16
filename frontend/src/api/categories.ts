import { request } from './client'

/** The colours a category may have. Mirrors CategoryColor in backend/main.py. */
export const CATEGORY_COLORS = ['lilac', 'rose', 'peach', 'mint', 'sky', 'butter', 'sage', 'stone'] as const
export type CategoryColor = (typeof CATEGORY_COLORS)[number]

/** Same limit as backend/main.py, which refuses a longer name. */
export const CATEGORY_NAME_MAX = 24

/** A category someone made for themselves. Its key is what a note stores in `category`. */
export interface CustomCategory {
  id: number
  /** "c" + id, for example "c12". */
  key: string
  name: string
  color: CategoryColor
}

export interface CategoryInput {
  name: string
  color: CategoryColor
}

export const categoriesApi = {
  /** The person's own categories, oldest first. */
  list: (signal?: AbortSignal) => request<CustomCategory[]>('/categories', { signal }),

  create: (input: CategoryInput) =>
    request<CustomCategory>('/categories', { method: 'POST', body: JSON.stringify(input) }),

  update: (id: number, patch: Partial<CategoryInput>) =>
    request<CustomCategory>(`/categories/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),

  /** The server moves the category's notes to Personal in the same step. */
  remove: (id: number) => request<void>(`/categories/${id}`, { method: 'DELETE' }),
}
