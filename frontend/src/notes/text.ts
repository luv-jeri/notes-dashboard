const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const countFormat = new Intl.NumberFormat()

/**
 * Cuts text to at most `max` characters and adds "…". It cuts between
 * graphemes (what a reader sees as one character), so an emoji or an accented
 * letter is never split in half.
 */
export function shorten(text: string, max: number): string {
  if (text.length <= max) return text
  let end = 0
  // The iterator is lazy: a 10,000-character note stops after `max` steps.
  for (const { index, segment } of graphemes.segment(text)) {
    if (index + segment.length > max - 1) break
    end = index + segment.length
  }
  return `${text.slice(0, end).trimEnd()}…`
}

/** What a reader sees as the first character: "É", "👩‍🍳" or "東", never half of one. */
export function firstGrapheme(text: string): string {
  for (const { segment } of graphemes.segment(text.trim())) return segment
  return ''
}

/** A title inside a sentence, quoted and short enough for a toast: "Renew passport". */
export const quoteTitle = (title: string) => `"${shorten(title, 60)}"`

/** "1,234", in the reader's own number format. */
export const formatCount = (count: number) => countFormat.format(count)
