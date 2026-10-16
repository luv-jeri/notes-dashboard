import { Briefcase, HeartPulse, Lightbulb, ShoppingBag, User, type LucideIcon } from 'lucide-react'
import type { Category } from '../api/notes'

export interface CategoryMeta {
  label: string
  Icon: LucideIcon
  /** Card fill. A CSS variable from tokens.css. */
  fill: string
  /** Chart segment colour. */
  strong: string
}

/** One colour per category, used everywhere that category appears. */
export const CATEGORY_META: Record<Category, CategoryMeta> = {
  work: { label: 'Work', Icon: Briefcase, fill: 'var(--lilac)', strong: 'var(--lilac-strong)' },
  personal: { label: 'Personal', Icon: User, fill: 'var(--rose)', strong: 'var(--rose-strong)' },
  ideas: { label: 'Ideas', Icon: Lightbulb, fill: 'var(--peach)', strong: 'var(--peach-strong)' },
  shopping: { label: 'Shopping', Icon: ShoppingBag, fill: 'var(--mint)', strong: 'var(--mint-strong)' },
  health: { label: 'Health', Icon: HeartPulse, fill: 'var(--sky)', strong: 'var(--sky-strong)' },
}
