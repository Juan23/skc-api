import { useEffect, useState } from 'react'
import { ProductPicker } from '../components/ProductPicker'
import type { InventoryRow } from '../api/types'
import { centavosToDecimalString, formatCentavos, toCentavos } from './money'
import { useCart } from './useCart'
import type { CartLine } from './useCart'

// The web POS's cart screen (webapp-pos-plan.md Increment 3) - mirrors
// frmPos's UX (search-and-add with an oversell warning, inline qty edit, a
// discount line, cash/change, staff name) but is cart-only: nothing here
// writes to IndexedDB or the network. `onComplete` is undefined until
// Increment 4 wires up the durable-commit sequence; until then the button
// exists so the screen's shape is real, but can't actually be pressed.
//
// Not mounted on any route yet - Increment 5 adds the chromeless /pos route
// this will live under, once PosAuthProvider exists to guard it.
export interface CompletedSale {
  staffName: string
  lines: CartLine[]
  totalCentavos: number
  tenderedCentavos: number | null
  changeCentavos: number | null
}

interface Props {
  catalog: InventoryRow[]
  onComplete?: (sale: CompletedSale) => void
}

// A plain `defaultValue` input desyncs from `line.qty` once the row's DOM
// node outlives a change that didn't come from this input itself - a merge
// via addItem (same `key`, so React reuses the node) leaves the box showing
// the pre-merge number even though the line total right next to it updated.
// Keeping a local text buffer resynced from `line.qty` via useEffect fixes
// both that and the "invalid text left on screen" case: an invalid blur
// reverts the box to the true current qty instead of leaving stale text.
function QtyCell({ line, onCommit }: { line: CartLine; onCommit: (line: CartLine, raw: string) => void }) {
  const [text, setText] = useState(String(line.qty))

  useEffect(() => {
    setText(String(line.qty))
  }, [line.qty])

  function commit() {
    const q = Number(text)
    if (!Number.isInteger(q) || q <= 0) {
      setText(String(line.qty))
      return
    }
    onCommit(line, text)
  }

  return (
    <input
      type="number"
      min={1}
      step={1}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      style={{ width: 60, textAlign: 'right' }}
    />
  )
}

export function SaleScreen({ catalog, onComplete }: Props) {
  const cart = useCart()
  const [qty, setQty] = useState('1')
  const [discountAmount, setDiscountAmount] = useState('')
  const [error, setError] = useState('')

  function currentCartQty(sku: string): number {
    return cart.lines.filter((l) => l.sku === sku).reduce((sum, l) => sum + l.qty, 0)
  }

  function pick(product: InventoryRow) {
    setError('')
    const q = Number(qty)
    if (!Number.isInteger(q) || q <= 0) {
      setError('Quantity must be a whole number greater than zero.')
      return
    }

    // Warn-but-allow oversell, exactly like frmPos: cached stock can be
    // minutes stale (baking/decorating recorded after the fact), so the
    // counter must never hard-stop a sale over it.
    const projected = currentCartQty(product.sku) + q
    if (projected > product.currentstock) {
      const proceed = window.confirm(
        `Stock shows only ${product.currentstock} of "${product.basename}" ` +
          `(cart already has ${currentCartQty(product.sku)}).\n\n` +
          'If this was baked/decorated today, it may not be recorded yet - the sale will be ' +
          'flagged for the office.\n\nSell anyway?',
      )
      if (!proceed) return
    }

    cart.addItem(product, q)
    setQty('1')
  }

  // Re-checks oversell after an inline edit too, matching frmPos's
  // dgvCart_CellEndEdit - informational only (an alert, not a confirm): the
  // edit has already happened, this just flags it the same way the search-add
  // path's confirm does before the fact.
  function onQtyChange(line: CartLine, raw: string) {
    const q = Number(raw)
    if (!Number.isInteger(q) || q <= 0) return // ignore mid-typing/invalid states; last valid value stands
    cart.setLineQty(line.key, q)

    if (line.sku == null) return
    const product = catalog.find((p) => p.sku === line.sku)
    if (!product) return
    const qtyForSku = cart.lines
      .map((l) => (l.key === line.key ? { ...l, qty: q } : l))
      .filter((l) => l.sku === line.sku)
      .reduce((sum, l) => sum + l.qty, 0)
    if (qtyForSku > product.currentstock) {
      window.alert(
        `Stock shows only ${product.currentstock} of "${product.basename}", but the cart now has ${qtyForSku}.\n\n` +
          'If this was baked/decorated today, it may not be recorded yet - the sale will be flagged for the office.',
      )
    }
  }

  function applyDiscount() {
    setError('')
    const amount = Number(discountAmount)
    if (!(amount > 0)) return setError('Enter a discount amount greater than zero.')
    const err = cart.addDiscount(toCentavos(amount))
    if (err) return setError(err)
    setDiscountAmount('')
  }

  const hasSellableLine = cart.lines.some((l) => l.sku != null)
  const canComplete =
    !!onComplete && cart.staffName.trim() !== '' && hasSellableLine && cart.totalCentavos >= 0

  function complete() {
    if (!onComplete || !canComplete) return
    if (!window.confirm(`Complete this sale for ${formatCentavos(cart.totalCentavos)}?`)) return
    onComplete({
      staffName: cart.staffName.trim(),
      lines: cart.lines,
      totalCentavos: cart.totalCentavos,
      tenderedCentavos: cart.tenderedCentavos,
      changeCentavos: cart.changeCentavos,
    })
  }

  return (
    <section>
      <h1>Sale</h1>

      {error && <p className="error">{error}</p>}

      <div className="inline-form">
        <label className="inline">
          Product
          <ProductPicker catalog={catalog} onPick={pick} placeholder="Search brand or item" />
        </label>
        <label className="inline">
          Qty
          <input
            type="number"
            min={1}
            step={1}
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            style={{ width: 70 }}
          />
        </label>
      </div>

      {cart.lines.length > 0 && (
        <div className="table-wrap" style={{ marginTop: 6 }}>
          <table className="data">
            <thead>
              <tr>
                <th>Item</th>
                <th style={{ textAlign: 'right' }}>Qty</th>
                <th style={{ textAlign: 'right' }}>Price</th>
                <th style={{ textAlign: 'right' }}>Line total</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {cart.lines.map((l) => (
                <tr key={l.key}>
                  <td>{l.description}</td>
                  <td style={{ textAlign: 'right' }}>
                    {l.sku == null ? l.qty : <QtyCell line={l} onCommit={onQtyChange} />}
                  </td>
                  <td style={{ textAlign: 'right' }}>{formatCentavos(l.unitPriceCentavos)}</td>
                  <td style={{ textAlign: 'right' }}>{formatCentavos(l.lineTotalCentavos)}</td>
                  <td style={{ textAlign: 'right' }}>
                    <span className="row-actions">
                      <button className="btn destructive" onClick={() => cart.removeLine(l.key)}>
                        Remove
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="inline-form">
        <label className="inline">
          Discount amount
          <input
            type="number"
            min={0}
            step="0.01"
            value={discountAmount}
            onChange={(e) => setDiscountAmount(e.target.value)}
            style={{ width: 100 }}
          />
        </label>
        <button className="btn neutral" onClick={applyDiscount} disabled={!discountAmount}>
          Apply discount
        </button>
      </div>

      <div className="inline-form">
        <label className="inline">
          Staff name
          <input value={cart.staffName} onChange={(e) => cart.setStaffName(e.target.value)} />
        </label>
        <label className="inline">
          Cash tendered
          <input
            type="number"
            min={0}
            step="0.01"
            value={cart.tenderedCentavos == null ? '' : centavosToDecimalString(cart.tenderedCentavos)}
            onChange={(e) => {
              const v = e.target.value
              cart.setTenderedCentavos(v === '' ? null : toCentavos(Number(v)))
            }}
            style={{ width: 100 }}
          />
        </label>
      </div>

      {cart.totalCentavos < 0 && (
        <p className="error">
          Total is negative — remove or reduce the discount before completing this sale.
        </p>
      )}

      <div className="toolbar" style={{ marginTop: 12 }}>
        <span className="muted">
          Total: <strong>{formatCentavos(cart.totalCentavos)}</strong>
          {cart.changeCentavos != null && cart.changeCentavos >= 0 && (
            <> &nbsp;·&nbsp; Change: {formatCentavos(cart.changeCentavos)}</>
          )}
        </span>
        <button
          className="btn primary"
          onClick={complete}
          disabled={!canComplete}
          title={onComplete ? undefined : 'Coming in the next increment'}
        >
          Complete sale
        </button>
      </div>
    </section>
  )
}
