import { useEffect, useMemo, useRef, useState } from 'react'
import type { InventoryRow } from '../api/types'
import { centavosToDecimalString, formatCentavos, toCentavos } from './money'
import { useCart } from './useCart'
import type { CartLine } from './useCart'
import './pos.css'

// The web POS's cart screen (webapp-pos-plan.md Increment 3, redesigned as a
// modern touch-friendly split (product grid + cart rail) rather than mirroring
// the WinForms frmPos layout - the underlying cart/money logic (useCart,
// money.ts) is unchanged and already covered by the increment's tests, only
// the presentation here is new. Still cart-only itself: this component never
// touches IndexedDB or the network directly - `onComplete` (wired by Pos.tsx,
// Increment 5) is the durable-commit sequence, awaited here so the cart only
// resets and shows the "sale complete" confirmation once the sale is actually
// durable, never speculatively.
export interface CompletedSale {
  staffName: string
  lines: CartLine[]
  totalCentavos: number
  tenderedCentavos: number | null
  changeCentavos: number | null
}

interface Props {
  catalog: InventoryRow[]
  onComplete?: (sale: CompletedSale) => Promise<void>
}

function productName(p: InventoryRow): string {
  return p.brand && p.brand !== p.basename ? `${p.brand} ${p.basename}` : p.basename
}

// A plain `defaultValue` input desyncs from `line.qty` once the row's DOM
// node outlives a change that didn't come from this input itself - a merge
// via addItem (same `key`, so React reuses the node) leaves the box showing
// the pre-merge number even though the line total right next to it updated.
// Keeping a local text buffer resynced from `line.qty` via useEffect fixes
// both that and the "invalid text left on screen" case: an invalid blur
// reverts the box to the true current qty instead of leaving stale text. The
// +/- buttons commit through the exact same validated path as typing.
function QtyCell({ line, onCommit }: { line: CartLine; onCommit: (line: CartLine, raw: string) => void }) {
  const [text, setText] = useState(String(line.qty))

  useEffect(() => {
    setText(String(line.qty))
  }, [line.qty])

  function commit(raw: string) {
    const q = Number(raw)
    if (!Number.isInteger(q) || q <= 0) {
      setText(String(line.qty))
      return
    }
    onCommit(line, raw)
  }

  function step(delta: number) {
    const base = Number(text)
    const next = Math.max(1, (Number.isInteger(base) ? base : line.qty) + delta)
    const raw = String(next)
    setText(raw)
    commit(raw)
  }

  return (
    <div className="qty-stepper">
      <button type="button" className="qty-step" onClick={() => step(-1)} aria-label="Decrease quantity">
        −
      </button>
      <input
        type="number"
        min={1}
        step={1}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        className="qty-input"
        aria-label={`Quantity for ${line.description}`}
      />
      <button type="button" className="qty-step" onClick={() => step(1)} aria-label="Increase quantity">
        +
      </button>
    </div>
  )
}

// Quick-cash presets: exact change, then the total rounded up to the nearest
// ₱100/₱500/₱1000 - a cashier is normally handed a round bill, not the exact
// centavo amount. Rounding up (never down) means every preset is always a
// usable tender, regardless of how large the total is - a fixed bill list
// would go sparse (or empty) past ₱1000, which the fixed-list version did.
function quickCashOptions(totalCentavos: number): number[] {
  if (totalCentavos <= 0) return []
  const roundUpTo = (denomCentavos: number) => Math.ceil(totalCentavos / denomCentavos) * denomCentavos
  const options = new Set<number>([totalCentavos, roundUpTo(10000), roundUpTo(50000), roundUpTo(100000)])
  return Array.from(options).sort((a, b) => a - b)
}

export function SaleScreen({ catalog, onComplete }: Props) {
  const cart = useCart()
  const [search, setSearch] = useState('')
  const [discountOpen, setDiscountOpen] = useState(false)
  const [discountAmount, setDiscountAmount] = useState('')
  const [error, setError] = useState('')

  const tiles = useMemo(() => {
    const term = search.trim().toLowerCase()
    if (!term) return catalog
    const tokens = term.split(/\s+/).filter(Boolean)
    return catalog.filter((p) => {
      const haystack = `${p.brand ?? ''} ${p.basename}`.toLowerCase()
      return tokens.every((t) => haystack.includes(t))
    })
  }, [catalog, search])

  function currentCartQty(sku: string): number {
    return cart.lines.filter((l) => l.sku === sku).reduce((sum, l) => sum + l.qty, 0)
  }

  // A synchronous mirror of "qty in cart per SKU", separate from React state.
  // Reading cart.lines (React state, a render-time snapshot) for the oversell
  // check has a real race on a touchscreen: two taps/edits landing before
  // React re-renders would both read the SAME stale snapshot. This ref is
  // updated immediately at EVERY cart-mutating call site below (add, remove,
  // qty edit) - not just add - so a same-tick second interaction always sees
  // the first one's effect, in either direction (a remove-then-add sequence
  // must not read a stale higher count and false-warn just as much as an
  // add-then-add sequence must not read a stale lower one). The effect
  // resyncs it from the authoritative cart.lines after every real render as a
  // backstop, but the mutation sites are what actually close the race window.
  const cartQtyRef = useRef<Map<string, number>>(new Map())
  // Last qty this ref was told about for each LINE (by key), not read from
  // `line.qty` at call time - QtyCell's own +/- buttons can fire twice in one
  // synchronous tick (a fast double-tap, before React re-renders and the
  // `line` prop updates), and both calls would otherwise compute their delta
  // against the SAME stale `line.qty`, double-applying it even though
  // cart.setLineQty itself converges correctly (it's idempotent - same target
  // qty both times). Tracking the per-line contribution here instead makes a
  // repeated call with the same target qty a true no-op delta, matching
  // cart.setLineQty's own idempotency.
  const lineQtyRef = useRef<Map<number, number>>(new Map())
  useEffect(() => {
    const m = new Map<string, number>()
    const lineMap = new Map<number, number>()
    for (const l of cart.lines) {
      lineMap.set(l.key, l.qty)
      if (l.sku != null) m.set(l.sku, (m.get(l.sku) ?? 0) + l.qty)
    }
    cartQtyRef.current = m
    lineQtyRef.current = lineMap
  }, [cart.lines])

  function adjustCartQtyRef(sku: string, delta: number) {
    const current = cartQtyRef.current.get(sku) ?? 0
    cartQtyRef.current.set(sku, Math.max(0, current + delta))
  }

  // Tapping a tile adds one unit - the modern-POS-grid convention (Square,
  // Toast, etc.), simpler on a touchscreen than "set a quantity, then pick."
  // Tap again (or use the cart's +) for more.
  function addOne(product: InventoryRow) {
    setError('')
    setLastSale(null)
    const already = cartQtyRef.current.get(product.sku) ?? 0
    const projected = already + 1

    // Warn-but-allow oversell, exactly like frmPos: cached stock can be
    // minutes stale (baking/decorating recorded after the fact), so the
    // counter must never hard-stop a sale over it.
    if (projected > product.currentstock) {
      const proceed = window.confirm(
        `Stock shows only ${product.currentstock} of "${product.basename}" (cart already has ${already}).\n\n` +
          'If this was baked/decorated today, it may not be recorded yet - the sale will be ' +
          'flagged for the office.\n\nSell anyway?',
      )
      if (!proceed) return
    }

    adjustCartQtyRef(product.sku, 1)
    cart.addItem(product, 1)
    setAnnouncement(`Added ${productName(product)}. ${cartQtyRef.current.get(product.sku)} in cart.`)
  }

  function removeCartLine(line: CartLine) {
    if (line.sku != null) adjustCartQtyRef(line.sku, -line.qty)
    cart.removeLine(line.key)
    setAnnouncement(`Removed ${line.description} from the sale.`)
  }

  // Re-checks oversell after an inline edit too, matching frmPos's
  // dgvCart_CellEndEdit - informational only (an alert, not a confirm): the
  // edit has already happened, this just flags it the same way the tap-to-add
  // path's confirm does before the fact. The delta is against lineQtyRef's
  // last-known value for THIS line, not the `line.qty` prop (which can be
  // stale across two same-tick calls - see the ref's own comment above).
  function onQtyChange(line: CartLine, raw: string) {
    const q = Number(raw)
    if (!Number.isInteger(q) || q <= 0) return // ignore mid-typing/invalid states; last valid value stands
    cart.setLineQty(line.key, q)

    if (line.sku == null) return
    const priorQtyForThisLine = lineQtyRef.current.get(line.key) ?? line.qty
    adjustCartQtyRef(line.sku, q - priorQtyForThisLine)
    lineQtyRef.current.set(line.key, q)

    const product = catalog.find((p) => p.sku === line.sku)
    if (!product) return
    const qtyForSku = cartQtyRef.current.get(line.sku) ?? q
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
    setDiscountOpen(false)
  }

  // A single global status announcer, not one aria-live region per tile.
  // aria-live nested INSIDE a native <button> is an inconsistent cross-
  // browser/AT pattern (several screen reader/browser combos treat a button
  // as an atomic leaf and never surface mutations inside it) - the WAI-ARIA
  // APG's own workaround is a visually-hidden live region as a SIBLING of the
  // interactive control, not a descendant, which is what this is.
  const [announcement, setAnnouncement] = useState('')

  const [completing, setCompleting] = useState(false)
  // Shown in the cart-lines area right after a reset, replacing the ordinary
  // "tap an item" empty state once - the counter's only confirmation that the
  // sale actually went through, since this app deliberately never prints a
  // receipt (see MEMORY: pos-void-and-branch-history-scope). Cleared by the
  // next tap-to-add.
  const [lastSale, setLastSale] = useState<{ total: number; change: number | null } | null>(null)

  const hasSellableLine = cart.lines.some((l) => l.sku != null)
  const canComplete =
    !!onComplete && !completing && cart.staffName.trim() !== '' && hasSellableLine && cart.totalCentavos >= 0

  async function complete() {
    if (!onComplete || !canComplete) return
    if (!window.confirm(`Complete this sale for ${formatCentavos(cart.totalCentavos)}?`)) return
    const total = cart.totalCentavos
    const change = cart.changeCentavos
    setCompleting(true)
    setError('')
    try {
      await onComplete({
        staffName: cart.staffName.trim(),
        lines: cart.lines,
        totalCentavos: total,
        tenderedCentavos: cart.tenderedCentavos,
        changeCentavos: change,
      })
      cart.reset()
      setLastSale({ total, change })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not record the sale - try again.')
    } finally {
      setCompleting(false)
    }
  }

  return (
    <div className="pos-screen">
      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>
      <div className="pos-catalog">
        <input
          className="pos-search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search brand or item…"
          autoFocus
        />
        <div className="pos-grid">
          {tiles.length === 0 && <p className="pos-empty">No items match "{search}".</p>}
          {tiles.map((p) => {
            const inCart = currentCartQty(p.sku)
            const low = inCart >= p.currentstock
            return (
              <button
                key={p.sku}
                type="button"
                className="pos-tile"
                onClick={() => addOne(p)}
                aria-label={`${productName(p)}, ${formatCentavos(toCentavos(p.price))}, ${p.currentstock} on hand${inCart > 0 ? `, ${inCart} in cart` : ''}`}
              >
                <span className="pos-tile-name" aria-hidden="true">
                  {productName(p)}
                </span>
                <span className="pos-tile-price" aria-hidden="true">
                  {formatCentavos(toCentavos(p.price))}
                </span>
                <span className={`pos-tile-stock${low ? ' low' : ''}`} aria-hidden="true">
                  {p.currentstock} on hand{inCart > 0 ? ` · ${inCart} in cart` : ''}
                </span>
              </button>
            )
          })}
        </div>
      </div>

      <div className="pos-cart">
        <div className="pos-cart-header">
          <h1>Current sale</h1>
          <input
            className="pos-staff-input"
            value={cart.staffName}
            onChange={(e) => cart.setStaffName(e.target.value)}
            placeholder="Staff name"
            aria-label="Staff name"
          />
        </div>

        <div className="pos-cart-lines">
          {cart.lines.length === 0 ? (
            lastSale ? (
              <div className="pos-last-sale" role="status">
                <p className="pos-last-sale-total">Sale complete — {formatCentavos(lastSale.total)}</p>
                {lastSale.change != null && lastSale.change >= 0 && (
                  <p className="pos-last-sale-change">Change: {formatCentavos(lastSale.change)}</p>
                )}
              </div>
            ) : (
              <p className="pos-cart-empty">Tap an item to add it to the sale.</p>
            )
          ) : (
            cart.lines.map((l) => (
              <div className="pos-line" key={l.key}>
                <div className="pos-line-info">
                  <div className="pos-line-name">{l.description}</div>
                  {l.sku != null && <div className="pos-line-price">{formatCentavos(l.unitPriceCentavos)} each</div>}
                </div>
                {l.sku == null ? (
                  // Same real markup as QtyCell (not a fixed-width div guessing
                  // its size) so the discount row's total/remove columns stay
                  // aligned with product rows even if the stepper's own sizing
                  // ever changes - nothing to keep in sync by hand.
                  <div className="qty-stepper" style={{ visibility: 'hidden' }} aria-hidden="true">
                    <button type="button" className="qty-step" tabIndex={-1}>
                      −
                    </button>
                    <input className="qty-input" value={1} readOnly tabIndex={-1} />
                    <button type="button" className="qty-step" tabIndex={-1}>
                      +
                    </button>
                  </div>
                ) : (
                  <QtyCell line={l} onCommit={onQtyChange} />
                )}
                <span className={`pos-line-total${l.lineTotalCentavos < 0 ? ' negative' : ''}`}>
                  {formatCentavos(l.lineTotalCentavos)}
                </span>
                <button
                  type="button"
                  className="pos-line-remove"
                  onClick={() => removeCartLine(l)}
                  aria-label={`Remove ${l.description}`}
                >
                  ×
                </button>
              </div>
            ))
          )}
        </div>

        <div className="pos-checkout">
          {error && <p className="error">{error}</p>}

          {discountOpen ? (
            <div className="pos-discount-form">
              <input
                type="number"
                min={0}
                step="0.01"
                autoFocus
                placeholder="Discount amount"
                aria-label="Discount amount"
                value={discountAmount}
                onChange={(e) => setDiscountAmount(e.target.value)}
              />
              <button className="btn neutral" onClick={applyDiscount} disabled={!discountAmount}>
                Apply
              </button>
              <button
                type="button"
                className="pos-discount-toggle"
                onClick={() => {
                  setDiscountOpen(false)
                  setDiscountAmount('')
                  setError('')
                }}
              >
                Cancel
              </button>
            </div>
          ) : (
            <button type="button" className="pos-discount-toggle" onClick={() => setDiscountOpen(true)}>
              + Add discount
            </button>
          )}

          <div className="pos-cash-row">
            <label htmlFor="pos-cash">Cash</label>
            <input
              id="pos-cash"
              type="number"
              min={0}
              step="0.01"
              value={cart.tenderedCentavos == null ? '' : centavosToDecimalString(cart.tenderedCentavos)}
              onChange={(e) => {
                const v = e.target.value
                cart.setTenderedCentavos(v === '' ? null : toCentavos(Number(v)))
              }}
            />
          </div>
          <div className="pos-quick-cash">
            {quickCashOptions(cart.totalCentavos).map((c) => (
              <button
                key={c}
                type="button"
                className="pos-chip"
                onClick={() => cart.setTenderedCentavos(c)}
              >
                {formatCentavos(c)}
              </button>
            ))}
          </div>

          {cart.totalCentavos < 0 && (
            <p className="error">Total is negative — remove or reduce the discount before completing.</p>
          )}

          <div className="pos-totals-row">
            <span className="pos-total-label">Total</span>
            <span className="pos-total-value">{formatCentavos(cart.totalCentavos)}</span>
          </div>
          {cart.changeCentavos != null && cart.changeCentavos >= 0 && (
            <div className="pos-totals-row">
              <span className="pos-total-label">Change</span>
              <span className="pos-change-value">{formatCentavos(cart.changeCentavos)}</span>
            </div>
          )}

          <button
            type="button"
            className="pos-complete-btn"
            onClick={complete}
            disabled={!canComplete}
            title={onComplete ? undefined : 'Coming in the next increment'}
          >
            {completing ? 'Recording…' : 'Complete sale'}
          </button>
        </div>
      </div>
    </div>
  )
}
