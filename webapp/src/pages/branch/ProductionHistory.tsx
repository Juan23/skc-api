import { useMemo, useRef, useState } from 'react'
import { ProductionView } from '../../components/ProductionView'
import { useAuth } from '../../auth/AuthContext'
import { useApi } from '../../lib/useApi'
import { api, ApiError } from '../../api/client'
import { formatMoney, formatQty } from '../../lib/format'
import { newTicketId } from '../../lib/tickets'
import type { InventoryRow, Recipe } from '../../api/types'

// Mirrors frmProduction + frmProductionHistory in the branch app: record a
// baking/decorating batch against the company recipe list, with the history
// below. Scoped to the session's own branch - no picker.
//
// The ingredient preview shows ceil(lineQty × multiplier) per input - the same
// round-up the server applies - next to the branch's current stock, so the baker
// can see an insufficiency before submitting rather than bouncing off the 409.
export function ProductionHistory() {
  const { user } = useAuth()
  const branch = user?.branchName ?? ''

  const recipes = useApi<Recipe[]>('/api/recipes') // active only, like frmProduction
  const stock = useApi<InventoryRow[]>(branch ? `/api/inventory/branch/${encodeURIComponent(branch)}` : null)
  // Full catalog just for output display names - a finished-good SKU the branch
  // has never produced won't be in its branch stock yet, so fall back to the SKU.
  const catalog = useApi<InventoryRow[]>('/api/inventory')
  const stockName = (sku: string) => {
    const p = (catalog.data ?? []).find((r) => r.sku === sku)
    return p ? (p.brand && p.brand !== p.basename ? `${p.brand} ${p.basename}` : p.basename) : sku
  }

  const [entryOpen, setEntryOpen] = useState(false)
  const [kind, setKind] = useState<Recipe['kind']>('Baking')
  const [recipeId, setRecipeId] = useState<number | ''>('')
  const [multiplier, setMultiplier] = useState('1')
  // What the baker actually made, keyed by output SKU. Every possible output
  // starts blank (= 0); the baker types how many of each they made. The recipe
  // no longer has a single fixed yield - a bake is whatever mix was produced.
  const [outputQtys, setOutputQtys] = useState<Record<string, string>>({})
  const [staff, setStaff] = useState('')

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  // Remounts the history view after a submit so it reloads - it owns its own
  // date-range state, so a key bump is the clean way to refresh it.
  const [historyNonce, setHistoryNonce] = useState(0)

  // One PRD id per batch attempt, reused across retries so a resubmit after a
  // lost response dedups server-side. Cleared on confirmed success. Same
  // contract as frmProduction's productionTransactionId.
  const txId = useRef<string | null>(null)

  const kindRecipes = (recipes.data ?? []).filter((r) => r.kind === kind)
  const recipe = kindRecipes.find((r) => r.recipeId === recipeId) ?? null

  const mult = Number(multiplier)
  const multValid = mult > 0 && Number.isFinite(mult)

  // Parse an entered per-output qty ('' / undefined = 0).
  const enteredQty = (sku: string) => {
    const v = outputQtys[sku]
    return v === undefined || v === '' ? 0 : Number(v)
  }
  const totalMade = (recipe?.outputs ?? []).reduce((sum, o) => sum + enteredQty(o.outputSku), 0)

  const preview = useMemo(() => {
    if (!recipe || !multValid) return []
    const rows = stock.data ?? []
    return recipe.lines.map((l) => {
      const p = rows.find((r) => r.sku === l.inputSku)
      const needed = Math.ceil(l.qty * mult) // server rounds up too
      const have = p?.currentstock ?? 0
      return {
        sku: l.inputSku,
        item: p ? (p.brand && p.brand !== p.basename ? `${p.brand} ${p.basename}` : p.basename) : l.inputSku,
        needed,
        have,
        short: needed > have,
      }
    })
  }, [recipe, mult, multValid, stock.data])

  const anyShort = preview.some((p) => p.short)

  function pickKind(k: Recipe['kind']) {
    setKind(k)
    setRecipeId('')
    setOutputQtys({})
  }

  async function submit() {
    setError('')
    setNotice('')
    if (!recipe) return setError('Choose a recipe.')
    if (!multValid) return setError('Batch multiplier must be greater than zero.')
    if (!staff.trim()) return setError('Enter who baked or decorated this batch.')

    // Validate each entered output qty: non-negative whole number.
    for (const o of recipe.outputs) {
      const raw = outputQtys[o.outputSku]
      if (raw === undefined || raw === '') continue
      const n = Number(raw)
      if (!Number.isInteger(n) || n < 0)
        return setError('Each quantity made must be a whole number of zero or more.')
    }

    // Build the outputs the baker actually made (qty > 0). Weights are looked up
    // server-side from the recipe, so we send only {outputSku, qty} - the field
    // name must be outputSku to bind to the server's ProductionOutputInputDto.
    const outputs = recipe.outputs
      .map((o) => ({ outputSku: o.outputSku, qty: enteredQty(o.outputSku) }))
      .filter((x) => x.qty > 0)

    // Burnt-batch guard: nothing made but ingredients are still consumed (a
    // recorded loss). Warn-but-allow, same spirit as the old zero-yield path.
    if (outputs.length === 0) {
      if (
        !window.confirm(
          'This batch produces nothing but still consumes ingredients (a recorded loss). ' +
            'Record it anyway?',
        )
      )
        return
    }

    if (!txId.current) txId.current = newTicketId('PRD')
    setBusy(true)
    try {
      const result = await api.post<{
        outputs: { outputSku: string; qty: number; unitCost: number; cost: number }[]
        totalInputCost: number
      }>('/api/production', {
        branch,
        recipeId: recipe.recipeId,
        staffName: staff.trim(),
        batchMultiplier: mult,
        outputs,
        transactionId: txId.current,
      })
      // Name + per-unit cost, matching the history table right below (which
      // shows "4 × Choc 8in @ 232.56"): a raw SKU with no cost read as cryptic
      // next to it, and the server already hands back the resolved unit cost.
      const made = result.outputs.length
        ? result.outputs.map((o) => `${formatQty(o.qty)} × ${stockName(o.outputSku)} @ ${formatMoney(o.unitCost)}`).join(', ')
        : 'nothing (recorded loss)'
      setNotice(`Recorded. Produced ${made} (ingredient cost ${formatMoney(result.totalInputCost)}).`)
      txId.current = null
      // Reset: staff, multiplier, and the entered quantities clear; the recipe
      // stays picked for the common bake-again-tomorrow flow.
      setStaff('')
      setMultiplier('1')
      setOutputQtys({})
      stock.reload()
      setHistoryNonce((n) => n + 1)
    } catch (err) {
      // 409 = insufficient branch stock for an input; the message names the SKU
      // and how short it is. Draft and PRD id are kept for a retry after fixing
      // stock (accepting a delivery, adjusting a count).
      if (err instanceof ApiError && err.status === 409) setError(err.message)
      else setError(err instanceof Error ? err.message : 'Production failed.')
    } finally {
      setBusy(false)
    }
  }

  if (!branch) return <p className="muted">This account isn't tied to a branch.</p>

  return (
    <section>
      <h1>Production — {branch}</h1>

      <div className="toolbar">
        <button className="btn primary" onClick={() => setEntryOpen((v) => !v)} disabled={busy}>
          {entryOpen ? 'Close entry' : 'Record a batch'}
        </button>
      </div>

      {error && <p className="error">{error}</p>}
      {notice && <p className="notice">{notice}</p>}

      {entryOpen && (
        <div className="editor">
          <h2>Record baking / decorating</h2>
          <div className="toolbar">
            <label className="inline">
              Kind
              <select value={kind} onChange={(e) => pickKind(e.target.value as Recipe['kind'])}>
                <option value="Baking">Baking</option>
                <option value="Decorating">Decorating</option>
              </select>
            </label>
            <label className="inline">
              Recipe
              <select
                value={recipeId === '' ? '' : String(recipeId)}
                onChange={(e) => {
                  setRecipeId(e.target.value === '' ? '' : Number(e.target.value))
                  setOutputQtys({})
                }}
              >
                <option value="">— choose —</option>
                {kindRecipes.map((r) => (
                  <option key={r.recipeId} value={r.recipeId}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="inline">
              Batches
              <input
                type="number"
                min={0}
                step="any"
                value={multiplier}
                onChange={(e) => setMultiplier(e.target.value)}
              />
            </label>
            <label className="inline">
              Baked / decorated by
              <input value={staff} onChange={(e) => setStaff(e.target.value)} placeholder="Staff name" />
            </label>
          </div>
          <p className="muted" style={{ marginTop: 4 }}>
            <strong>Batches</strong> scales the ingredients — 1 = one full recipe. It's separate from
            the counts below (what you actually made).
          </p>

          {/* The output labels are product names resolved from the catalog; hold
              the section until it loads rather than flash raw SKUs (zz-choc-8…). */}
          {recipe && !catalog.data && <p className="muted">Loading products…</p>}
          {recipe && catalog.data && (
            <>
              <h3>What did you make?</h3>
              <p className="muted">
                These are the actual items produced — leave a type at 0 if you didn't make it. They
                split the ingredient cost by size. The ingredients used come from the batches number
                above, not from these counts.
              </p>
              <div className="toolbar" style={{ flexWrap: 'wrap' }}>
                {recipe.outputs.map((o) => (
                  <label className="inline" key={o.outputSku}>
                    {stockName(o.outputSku)}
                    <input
                      type="number"
                      min={0}
                      step={1}
                      value={outputQtys[o.outputSku] ?? ''}
                      onChange={(e) => setOutputQtys((m) => ({ ...m, [o.outputSku]: e.target.value }))}
                      placeholder="0"
                      style={{ width: 90 }}
                    />
                  </label>
                ))}
              </div>
              <p className="muted">Total made this batch: {formatQty(totalMade)}</p>
            </>
          )}

          {recipe && preview.length > 0 && (
            <>
              <h3>Ingredients this batch will use</h3>
              <p className="muted">Based on the number of batches — not the counts above.</p>
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Item</th>
                      <th style={{ textAlign: 'right' }}>Needed</th>
                      <th style={{ textAlign: 'right' }}>In stock here</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.map((p) => (
                      <tr key={p.sku}>
                        <td>{p.item}</td>
                        <td style={{ textAlign: 'right' }}>{formatQty(p.needed)}</td>
                        <td style={{ textAlign: 'right' }}>
                          {p.short ? <span className="neg">{formatQty(p.have)}</span> : formatQty(p.have)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {anyShort && (
                <p className="entry-hint neg">
                  Not enough stock for the highlighted ingredients — the server will refuse this batch.
                </p>
              )}
            </>
          )}

          <div className="toolbar" style={{ marginTop: 12 }}>
            <button className="btn primary" onClick={() => void submit()} disabled={busy || !recipe}>
              {busy ? 'Recording…' : 'Record batch'}
            </button>
          </div>
        </div>
      )}

      <ProductionView key={historyNonce} branch={branch} />
    </section>
  )
}
