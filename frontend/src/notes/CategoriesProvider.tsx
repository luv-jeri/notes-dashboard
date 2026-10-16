import { useMemo, type ReactNode } from 'react'
import { makeCatalog } from './categories'
import { CategoriesContext, useCategoriesQuery } from './useCategories'

/**
 * Loads the person's own categories once and hands them to everything below.
 * Until they arrive, or if they fail to, the built-in ones still work.
 */
export function CategoriesProvider({ children }: { children: ReactNode }) {
  const { data, isSuccess } = useCategoriesQuery()
  const catalog = useMemo(() => makeCatalog(data ?? [], isSuccess), [data, isSuccess])
  return <CategoriesContext value={catalog}>{children}</CategoriesContext>
}
