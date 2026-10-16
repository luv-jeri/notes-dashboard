import { Briefcase, HeartPulse, Lightbulb, ShoppingBag, User, type LucideIcon } from 'lucide-react'
import { CATEGORY_COLORS, type CategoryColor, type CustomCategory } from '../api/categories'
import { CATEGORIES, type BuiltInCategory } from '../api/notes'
import { firstGrapheme } from './text'

export interface CategoryMeta {
  label: string
  Icon: LucideIcon
  color: CategoryColor
  /** Card fill. A CSS variable from tokens.css. */
  fill: string
  /** Chart segment colour. */
  strong: string
}

/** Each colour's pastel fill and its stronger shade, as CSS variables from tokens.css. */
export const colorVars = (color: CategoryColor) => ({
  fill: `var(--${color})`,
  strong: `var(--${color}-strong)`,
})

/** Swatch names, for people who can't see the colour. */
export const COLOR_LABELS: Record<CategoryColor, string> = {
  lilac: 'Lilac',
  rose: 'Rose',
  peach: 'Peach',
  mint: 'Mint',
  sky: 'Sky',
  butter: 'Butter',
  sage: 'Sage',
  stone: 'Stone',
}

const builtIn = (label: string, Icon: LucideIcon, color: CategoryColor): CategoryMeta => ({
  label,
  Icon,
  color,
  ...colorVars(color),
})

/** One colour per built-in category, used everywhere that category appears. */
export const CATEGORY_META: Record<BuiltInCategory, CategoryMeta> = {
  work: builtIn('Work', Briefcase, 'lilac'),
  personal: builtIn('Personal', User, 'rose'),
  ideas: builtIn('Ideas', Lightbulb, 'peach'),
  shopping: builtIn('Shopping', ShoppingBag, 'mint'),
  health: builtIn('Health', HeartPulse, 'sky'),
}

/** How a category shows on screen, whether built in or the person's own. */
export interface CategoryLook {
  key: string
  label: string
  color: CategoryColor
  fill: string
  strong: string
  /** Built-in categories draw an icon. */
  Icon: LucideIcon | null
  /** A person's own category shows the first letter of its name instead. */
  monogram: string
}

export interface CategoryCatalog {
  /** Built-in categories first, then the person's own in the order they were added. */
  options: CategoryLook[]
  /** The person's own categories, as the server sent them. */
  custom: CustomCategory[]
  /**
   * The look for a note's category. A key that isn't known (a category just
   * deleted in another tab, say) shows as Personal, which is where the server
   * moves those notes.
   */
  look: (key: string) => CategoryLook
  /**
   * Whether the person's own categories have arrived. Until they have, or if
   * loading them failed, a key missing from `options` may still be one of
   * theirs, so nothing should treat it as gone.
   */
  loaded: boolean
}

const BUILT_IN_LOOKS: CategoryLook[] = CATEGORIES.map((key) => ({
  key,
  ...CATEGORY_META[key],
  monogram: '',
}))

export function customLook(category: CustomCategory): CategoryLook {
  return {
    key: category.key,
    label: category.name,
    color: category.color,
    ...colorVars(category.color),
    Icon: null,
    monogram: firstGrapheme(category.name).toLocaleUpperCase(),
  }
}

export function makeCatalog(custom: CustomCategory[], loaded = false): CategoryCatalog {
  const options = [...BUILT_IN_LOOKS, ...custom.map(customLook)]
  const byKey = new Map(options.map((look) => [look.key, look]))
  const fallback = byKey.get('personal') as CategoryLook
  return { options, custom, look: (key) => byKey.get(key) ?? fallback, loaded }
}

export const isBuiltIn = (key: string): key is BuiltInCategory =>
  (CATEGORIES as readonly string[]).includes(key)

/**
 * The colour a new category starts with: the first one no category uses yet,
 * built-in ones included, so a first category isn't lilac like Work. Once all
 * eight are taken, the least used, so the colours stay spread out.
 */
export function suggestColor(custom: readonly CustomCategory[]): CategoryColor {
  const uses = new Map<CategoryColor, number>(CATEGORY_COLORS.map((color) => [color, 0]))
  for (const { color } of [...BUILT_IN_LOOKS, ...custom]) uses.set(color, (uses.get(color) ?? 0) + 1)
  const fewest = Math.min(...uses.values())
  return CATEGORY_COLORS.find((color) => uses.get(color) === fewest) ?? 'lilac'
}
