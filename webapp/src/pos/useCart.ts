// Cart state for the offline-first web POS (webapp-pos-plan.md Increment 3).
// Cart only - nothing here writes to IndexedDB or the network; that's
// Increment 4 (durable commit) and Increment 5 (sync engine).
import { useMemo, useState } from 'react'
import type { InventoryRow } from '../api/types'
import type { PosSaleLine } from './db'
import { lineTotalCentavos, sumCentavos, toCentavos } from './money'

export interface CartLine extends PosSaleLine {
  key: number
}

let nextKey = 1

function productDescription(p: InventoryRow): string {
  return p.brand && p.brand !== p.basename ? `${p.brand} ${p.basename}` : p.basename
}

export function useCart() {
  const [lines, setLines] = useState<CartLine[]>([])
  const [staffName, setStaffName] = useState('')
  const [tenderedCentavos, setTenderedCentavos] = useState<number | null>(null)

  const totalCentavos = useMemo(() => sumCentavos(lines.map((l) => l.lineTotalCentavos)), [lines])
  const changeCentavos = tenderedCentavos != null ? tenderedCentavos - totalCentavos : null

  // Merge into an existing line for the same SKU (qty accumulates) rather than
  // adding a second row - mirrors frmPos's AddToCart, so scanning the same
  // item twice behaves the way cashiers already expect. Merging keeps the
  // EXISTING line's unitPriceCentavos (captured on the first add), the same
  // as frmPos's `existing.LineTotal = existing.Qty * existing.Price` - it
  // deliberately uses the line's own price, not the freshly-matched
  // product's, so a mid-sale catalog refresh (once Increment 5 polls
  // periodically) can never silently re-price units already rung up.
  function addItem(product: InventoryRow, qty: number) {
    setLines((prev) => {
      const idx = prev.findIndex((l) => l.sku === product.sku)
      if (idx >= 0) {
        const newQty = prev[idx].qty + qty
        const updated: CartLine = {
          ...prev[idx],
          qty: newQty,
          lineTotalCentavos: lineTotalCentavos(prev[idx].unitPriceCentavos, newQty),
        }
        return prev.map((l, i) => (i === idx ? updated : l))
      }
      const unitPriceCentavos = toCentavos(product.price)
      return [
        ...prev,
        {
          key: nextKey++,
          sku: product.sku,
          description: productDescription(product),
          qty,
          unitPriceCentavos,
          lineTotalCentavos: lineTotalCentavos(unitPriceCentavos, qty),
        },
      ]
    })
  }

  // Inline qty edit, matching frmPos's editable Qty column. A discount line's
  // qty is fixed at 1 and not user-editable - the caller (SaleScreen) is
  // responsible for not exposing this control on a discount row, same as
  // frmPos's CellBeginEdit guard.
  function setLineQty(key: number, qty: number) {
    setLines((prev) =>
      prev.map((l) =>
        l.key === key ? { ...l, qty, lineTotalCentavos: lineTotalCentavos(l.unitPriceCentavos, qty) } : l,
      ),
    )
  }

  function removeLine(key: number) {
    setLines((prev) => prev.filter((l) => l.key !== key))
  }

  // sku: null, negative centavos - capped so the total can never go negative,
  // mirrors frmPos's btnDiscount_Click check. Returns an error message instead
  // of throwing, same convention as this app's other entry-screen validators.
  function addDiscount(amountCentavos: number): string | null {
    if (!(amountCentavos > 0)) return 'Enter a discount amount greater than zero.'
    if (amountCentavos > totalCentavos) return 'Discount cannot be more than the sale total.'
    setLines((prev) => [
      ...prev,
      {
        key: nextKey++,
        sku: null,
        description: 'Discount',
        qty: 1,
        unitPriceCentavos: -amountCentavos,
        lineTotalCentavos: -amountCentavos,
      },
    ])
    return null
  }

  // Clears the cart for the next sale but deliberately KEEPS staffName: the only
  // caller is SaleScreen's submit, and at a counter the same cashier rings many
  // consecutive sales, so wiping the name every time forced a re-type on each
  // one. The name persists until the operator edits the field (e.g. a shift
  // change), matching how POS terminals hold the signed-in cashier across sales.
  function reset() {
    setLines([])
    setTenderedCentavos(null)
  }

  return {
    lines,
    staffName,
    setStaffName,
    tenderedCentavos,
    setTenderedCentavos,
    totalCentavos,
    changeCentavos,
    addItem,
    setLineQty,
    removeLine,
    addDiscount,
    reset,
  }
}
