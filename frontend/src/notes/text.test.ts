import { describe, expect, it } from 'vitest'
import { shorten } from './text'

describe('shorten', () => {
  it('leaves text that fits alone', () => {
    expect(shorten('Short note', 20)).toBe('Short note')
  })

  it('cuts long text to the limit, ellipsis included', () => {
    const result = shorten('a'.repeat(10_000), 280)

    expect(result).toHaveLength(280)
    expect(result.endsWith('…')).toBe(true)
  })

  it('never splits an emoji, even one built from several characters', () => {
    // A family emoji is 11 UTF-16 code units joined by zero-width joiners;
    // a flag is two regional-indicator letters.
    const family = '👨‍👩‍👧‍👦'
    const flag = '🇮🇳'

    expect(shorten(`Trip ${family} plans`, 10)).toBe('Trip…')
    expect(shorten(`Go ${flag}${flag}${flag}`, 8)).toBe(`Go ${flag}…`)
  })

  it('drops the space before the ellipsis', () => {
    expect(shorten('Pack the bags tonight', 10)).toBe('Pack the…')
  })
})
