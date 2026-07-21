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

  const [entryOpen, setEntryOpen] = useState(false)
  const [kind, setKind] = useState<Recipe['kind']>('Baking')
  const [recipeId, setRecipeId] = useState<number | ''>('')
  const [multiplier, setMultiplier] = useState('1')
  // '' = follow the recipe default (outputQty × multiplier); a typed number is
  // the actual yield (a burnt tray, extra pieces). Sent as 0 when following the
  // default, which the server reads as "use the recipe's scaled yield".
  const [outputQty, setOutputQty] = useState('')
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

  // Default yield, shown as the output placeholder and used when outputQty is
  // left blank - same formula as frmProduction's numOutputQty auto-fill. C#'s
  // Math.Round defaults to banker's rounding (half to even), JS's rounds half
  // up, and this number must preview what the SERVER will record for a blank
  // yield - so replicate ToEven for the exact-half case (yield 5 x 0.5 = 2.5
  // records 2, not 3).
  const roundHalfEven = (v: number) => {
    const floor = Math.floor(v)
    const diff = v - floor
    if (diff > 0.5) return floor + 1
    if (diff < 0.5) return floor
    return floor % 2 === 0 ? floor : floor + 1
  }
  const defaultYield = recipe && multValid ? roundHalfEven(recipe.outputQty * mult) : 0

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
    setOutputQty('')
  }

  async function submit() {
    setError('')
    setNotice('')
    if (!recipe) return setError('Choose a recipe.')
    if (!multValid) return setError('Batch multiplier must be greater than zero.')
    if (!staff.trim()) return setError('Enter who baked or decorated this batch.')

    const actual = outputQty === '' ? 0 : Number(outputQty)
    if (outputQty !== '' && (!Number.isInteger(actual) || actual < 0))
      return setError('Actual yield must be a whole number of zero or more.')

    // An explicitly typed 0 cannot be honoured: the server treats OutputQty <= 0
    // as "use the recipe's default yield", so a burnt-batch 0 would be silently
    // recorded as a full successful batch. (WinForms has the same silent
    // discard - logged in /bug-track.md.) Refuse with the truth rather than
    // submit something that means the opposite of what was typed.
    if (outputQty !== '' && actual === 0 && defaultYield > 0)
      return setError(
        `A zero yield can't be recorded yet: the server replaces 0 with the recipe's default ` +
          `(${defaultYield}). Leave the field blank to use the default, or record the loss as a ` +
          `stock adjustment instead.`,
      )

    // Same phantom-loss guard as frmProduction: a too-small multiplier can round
    // the yield to 0 while ingredients (rounded up) are still consumed. Checked
    // on the value actually being submitted (blank -> the recipe default).
    const effectiveYield = outputQty === '' ? defaultYield : actual
    if (effectiveYield === 0) {
      if (
        !window.confirm(
          'This batch produces 0 output at the current multiplier but still consumes ingredients ' +
            '(usually the multiplier is too small). Record it anyway?',
        )
      )
        return
    }

    if (!txId.current) txId.current = newTicketId('PRD')
    setBusy(true)
    try {
      const result = await api.post<{ outputSku: string; outputQty: number; totalInputCost: number }>(
        '/api/production',
        {
          branch,
          recipeId: recipe.recipeId,
          staffName: staff.trim(),
          batchMultiplier: mult,
          outputQty: actual,
          transactionId: txId.current,
        },
      )
      setNotice(
        `Recorded. Produced ${formatQty(result.outputQty)} of ${result.outputSku} ` +
          `(ingredient cost ${formatMoney(result.totalInputCost)}).`,
      )
      txId.current = null
      // Reset like frmProduction: staff and multiplier clear, the recipe stays
      // picked for the common bake-again-tomorrow flow.
      setStaff('')
      setMultiplier('1')
      setOutputQty('')
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
                  setOutputQty('')
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
              Batch multiplier
              <input
                type="number"
                min={0}
                step="any"
                value={multiplier}
                onChange={(e) => setMultiplier(e.target.value)}
              />
            </label>
            <label className="inline">
              Actual yield
              <input
                type="number"
                min={0}
                step={1}
                value={outputQty}
                onChange={(e) => setOutputQty(e.target.value)}
                placeholder={recipe ? `${defaultYield} (recipe)` : ''}
              />
            </label>
            <label className="inline">
              Baked / decorated by
              <input value={staff} onChange={(e) => setStaff(e.target.value)} placeholder="Staff name" />
            </label>
          </div>

          {recipe && preview.length > 0 && (
            <>
              <h3>Ingredients this batch will use</h3>
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
