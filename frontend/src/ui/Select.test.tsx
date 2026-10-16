import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Select } from './Select'

const OPTIONS = [
  { value: 'newest', label: 'Newest first' },
  { value: 'due', label: 'Due date' },
  { value: 'title', label: 'A to Z' },
] as const

type Sort = (typeof OPTIONS)[number]['value']

function renderSelect(onChange = vi.fn()) {
  function Harness() {
    const [value, setValue] = useState<Sort>('newest')
    return (
      <>
        <Select
          label="Sort"
          value={value}
          options={OPTIONS}
          onChange={(next) => {
            onChange(next)
            setValue(next)
          }}
        />
        <p>Outside</p>
      </>
    )
  }
  render(<Harness />)
  return { onChange, combobox: screen.getByRole('combobox', { name: 'Sort' }) }
}

describe('Select', () => {
  it('opens on click and picks the option pressed', async () => {
    const user = userEvent.setup()
    const { onChange, combobox } = renderSelect()

    expect(combobox).toHaveTextContent('Newest first')
    await user.click(combobox)
    expect(combobox).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('option', { name: 'Newest first' })).toHaveAttribute('aria-selected', 'true')

    await user.click(screen.getByRole('option', { name: 'Due date' }))

    expect(onChange).toHaveBeenCalledWith('due')
    expect(combobox).toHaveAttribute('aria-expanded', 'false')
    expect(combobox).toHaveTextContent('Due date')
    // Focus stayed on the button the whole time, as with a native select.
    expect(combobox).toHaveFocus()
  })

  it('works from the keyboard alone', async () => {
    const user = userEvent.setup()
    const { onChange, combobox } = renderSelect()

    await user.tab()
    expect(combobox).toHaveFocus()

    // Opens on the current option, then moves down two and picks.
    await user.keyboard('{ArrowDown}')
    expect(combobox).toHaveAttribute('aria-activedescendant', screen.getByRole('option', { name: 'Newest first' }).id)
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}')

    expect(onChange).toHaveBeenCalledWith('title')
    expect(combobox).toHaveAttribute('aria-expanded', 'false')
    expect(combobox).not.toHaveAttribute('aria-activedescendant')
  })

  it('closes on Escape without changing anything', async () => {
    const user = userEvent.setup()
    const { onChange, combobox } = renderSelect()

    await user.click(combobox)
    await user.keyboard('{ArrowDown}{Escape}')

    expect(combobox).toHaveAttribute('aria-expanded', 'false')
    expect(onChange).not.toHaveBeenCalled()
    expect(combobox).toHaveTextContent('Newest first')
  })

  it('jumps to an option by its first letters', async () => {
    const user = userEvent.setup()
    const { onChange, combobox } = renderSelect()

    combobox.focus()
    await user.keyboard('a')
    expect(combobox).toHaveAttribute('aria-activedescendant', screen.getByRole('option', { name: 'A to Z' }).id)
    await user.keyboard('{Enter}')

    expect(onChange).toHaveBeenCalledWith('title')
  })

  it('closes when pressing outside it', async () => {
    const user = userEvent.setup()
    const { combobox } = renderSelect()

    await user.click(combobox)
    fireEvent.pointerDown(screen.getByText('Outside'))

    expect(combobox).toHaveAttribute('aria-expanded', 'false')
  })
})
