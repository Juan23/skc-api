import { useMemo, useRef, useState } from 'react'
import type { InventoryRow } from '../api/types'

// A typeahead over the catalog, shared by the purchase and delivery entry
// screens. It mirrors the token search in Purchases.cs / Delivery.cs: every
// whitespace-separated token must appear somewhere in "brand baseName sku", so
// typing "beryl dark" finds an item even though no single field holds the whole
// phrase, and order doesn't matter.
//
// It emits the chosen product via onPick and then clears itself, ready for the
// next line - the caller shows what's currently selected. Keyboard: Down/Up move
// the highlight, Enter commits it, Escape closes. Blur closes on a short delay so
// a mouse click on an option still registers first.

// Some catalog rows repeat the same text in brand and base_name; joining blindly
// renders "Fifo Test Fifo Test", so collapse that case (same helper the Recipes
// screen uses). productName is the brand+item text alone; productLabel prefixes
// the SKU for the picker's dropdown ("sku — Brand Item").
export function productName(p: InventoryRow): string {
  return p.brand && p.brand !== p.basename ? `${p.brand} ${p.basename}` : p.basename
}

export function productLabel(p: InventoryRow): string {
  return `${p.sku} — ${productName(p)}`
}

interface Props {
  catalog: InventoryRow[]
  onPick: (p: InventoryRow) => void
  placeholder?: string
  disabled?: boolean
}

export function ProductPicker({ catalog, onPick, placeholder, disabled }: Props) {
  const [text, setText] = useState('')
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const blurTimer = useRef<number | undefined>(undefined)

  const matches = useMemo(() => {
    const term = text.trim().toLowerCase()
    if (!term) return []
    const tokens = term.split(/\s+/).filter(Boolean)
    return catalog
      .filter((p) => {
        const haystack = `${p.brand ?? ''} ${p.basename} ${p.sku}`.toLowerCase()
        return tokens.every((t) => haystack.includes(t))
      })
      .slice(0, 20) // keep the dropdown short; refine the search for more
  }, [catalog, text])

  function commit(index: number) {
    const chosen = matches[index]
    if (!chosen) return
    onPick(chosen)
    setText('')
    setOpen(false)
    setHighlight(0)
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || matches.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlight((h) => Math.min(h + 1, matches.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight((h) => Math.max(h - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      commit(highlight)
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  return (
    <div className="picker">
      <input
        value={text}
        disabled={disabled}
        placeholder={placeholder ?? 'Search SKU, brand or item'}
        onChange={(e) => {
          setText(e.target.value)
          setOpen(true)
          setHighlight(0)
        }}
        onFocus={() => text && setOpen(true)}
        onKeyDown={onKeyDown}
        onBlur={() => {
          // Delay so a click on an option lands before the list unmounts.
          blurTimer.current = window.setTimeout(() => setOpen(false), 150)
        }}
      />
      {open && matches.length > 0 && (
        <ul className="picker-list">
          {matches.map((p, i) => (
            <li
              key={p.sku}
              className={i === highlight ? 'active' : ''}
              // onMouseDown (not onClick) so it fires before the input's blur.
              onMouseDown={(e) => {
                e.preventDefault()
                window.clearTimeout(blurTimer.current)
                commit(i)
              }}
            >
              {productLabel(p)}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
