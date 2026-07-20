import { useState } from 'react'
import { DataTable } from '../../components/DataTable'
import type { Column } from '../../components/DataTable'
import { useApi } from '../../lib/useApi'
import { api } from '../../api/client'
import { formatQty } from '../../lib/format'
import type { InventoryRow, Recipe, RecipeInput, RecipeLine } from '../../api/types'

// Ingredient rows carry a client-only key so React keeps each row's identity
// when one is removed from the middle. Index keys would shift every row below
// the deletion onto a different DOM node, which moves focus to the wrong input.
// `key` is stripped before the draft is sent - it isn't part of the wire shape.
interface DraftLine extends RecipeLine {
  key: number
}

interface Draft extends Omit<RecipeInput, 'lines'> {
  lines: DraftLine[]
}

let nextLineKey = 1
const newLine = (line: RecipeLine = { inputSku: '', qty: 1 }): DraftLine => ({
  ...line,
  key: nextLineKey++,
})

const emptyDraft = (): Draft => ({
  name: '',
  kind: 'Baking',
  outputSku: '',
  outputQty: 1,
  lines: [newLine()],
})

// Owner-only recipe management. Baking and decorating share one shape - a
// decorating recipe is just one whose inputs happen to include a BakedGood - so
// there are no separate forms, only the Kind field.
//
// The SKC Admin CLI's Excel round-trip (`skcadmin recipes template/import`)
// stays the owner's bulk path; this screen is for single edits. They write
// through the same endpoints, so the two can't diverge.
export function Recipes() {
  const [includeInactive, setIncludeInactive] = useState(true)
  const recipes = useApi<Recipe[]>(`/api/recipes?includeInactive=${includeInactive}`)
  const catalog = useApi<InventoryRow[]>('/api/inventory')

  const [editing, setEditing] = useState<number | 'new' | null>(null)
  const [draft, setDraft] = useState<Draft>(emptyDraft())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  function startNew() {
    setEditing('new')
    setDraft(emptyDraft())
    setError('')
    setNotice('')
  }

  function startEdit(r: Recipe) {
    setEditing(r.recipeId)
    // Copy the lines array - editing the draft must not mutate the loaded list.
    setDraft({
      name: r.name,
      kind: r.kind,
      outputSku: r.outputSku,
      outputQty: r.outputQty,
      lines: r.lines.map((l) => newLine(l)),
    })
    setError('')
    setNotice('')
  }

  function setLine(key: number, patch: Partial<RecipeLine>) {
    setDraft((d) => ({
      ...d,
      lines: d.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)),
    }))
  }

  async function run(what: () => Promise<unknown>, ok: string, closeEditor: boolean) {
    setError('')
    setNotice('')
    setBusy(true)
    try {
      await what()
      setNotice(ok)
      recipes.reload()
      if (closeEditor) setEditing(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed.')
    } finally {
      setBusy(false)
    }
  }

  // Mirrors ValidateRecipeDto server-side so the common mistakes get a message
  // here instead of a round-trip; the server stays the authority either way.
  function localProblem(): string | null {
    if (!draft.name.trim()) return 'A recipe needs a name.'
    if (!draft.outputSku) return 'Choose what this recipe produces.'
    if (draft.outputQty <= 0) return 'Output quantity must be greater than zero.'
    if (draft.lines.length === 0) return 'A recipe needs at least one input line.'
    if (draft.lines.some((l) => !l.inputSku)) return 'Every input line needs an ingredient.'
    if (draft.lines.some((l) => l.qty <= 0)) return "Every input line's quantity must be greater than zero."
    // Both quantities are `int` server-side, so a typed decimal fails model
    // binding before the handler runs and comes back as an opaque 400. Catch it
    // here where the message can name the actual problem.
    if (!Number.isInteger(draft.outputQty)) return 'Quantity made must be a whole number.'
    if (draft.lines.some((l) => !Number.isInteger(l.qty)))
      return 'Ingredient quantities must be whole numbers.'
    const skus = draft.lines.map((l) => l.inputSku)
    if (new Set(skus).size !== skus.length) return 'The same ingredient is listed twice.'
    return null
  }

  function save() {
    const problem = localProblem()
    if (problem) return setError(problem)
    // Strip the client-only line keys: the API body is {inputSku, qty} only.
    const body: RecipeInput = {
      ...draft,
      name: draft.name.trim(),
      lines: draft.lines.map(({ inputSku, qty }) => ({ inputSku, qty })),
    }
    void run(
      () => (editing === 'new' ? api.post('/api/recipes', body) : api.put(`/api/recipes/${editing}`, body)),
      editing === 'new' ? `Created "${body.name}".` : `Saved "${body.name}".`,
      true,
    )
  }

  const columns: Column<Recipe>[] = [
    { header: 'Recipe', cell: (r) => r.name },
    { header: 'Kind', cell: (r) => r.kind },
    { header: 'Makes', cell: (r) => `${formatQty(r.outputQty)} × ${r.outputSku}` },
    { header: 'Inputs', align: 'right', cell: (r) => r.lines.length },
    {
      header: 'Status',
      cell: (r) =>
        r.isActive ? <span className="pill ok">active</span> : <span className="pill bad">retired</span>,
    },
    {
      header: '',
      cell: (r) => (
        <span className="row-actions">
          <button className="btn neutral" disabled={busy} onClick={() => startEdit(r)}>
            Edit
          </button>
          {/* Retiring or restoring the row that's currently open in the editor
              closes it: the draft would otherwise sit there looking editable
              with no sign that its status just changed underneath. */}
          {r.isActive ? (
            <button
              className="btn destructive"
              disabled={busy}
              onClick={() =>
                void run(
                  () => api.patch(`/api/recipes/${r.recipeId}/deactivate`),
                  `Retired "${r.name}".`,
                  editing === r.recipeId,
                )
              }
            >
              Retire
            </button>
          ) : (
            <button
              className="btn neutral"
              disabled={busy}
              onClick={() =>
                void run(
                  () => api.patch(`/api/recipes/${r.recipeId}/activate`),
                  `Restored "${r.name}".`,
                  editing === r.recipeId,
                )
              }
            >
              Restore
            </button>
          )}
        </span>
      ),
    },
  ]

  // Outputs are what a recipe can produce; raw materials never are. Inputs can
  // be anything (a decorating recipe consumes a BakedGood plus raw materials).
  const outputOptions = (catalog.data ?? []).filter(
    (p) => p.category === 'BakedGood' || p.category === 'DecoratedGood',
  )
  // Some catalog rows repeat the same text in brand and base_name, so joining
  // blindly gives "Fifo Test Fifo Test".
  const label = (p: InventoryRow) =>
    `${p.sku} — ${p.brand && p.brand !== p.basename ? `${p.brand} ${p.basename}` : p.basename}`

  return (
    <section>
      <h1>Recipes</h1>
      <div className="toolbar">
        <label className="inline checkbox">
          <input
            type="checkbox"
            checked={includeInactive}
            onChange={(e) => setIncludeInactive(e.target.checked)}
          />
          Show retired recipes
        </label>
        <button className="btn primary" onClick={startNew} disabled={busy}>
          New recipe
        </button>
      </div>

      {error && <p className="error">{error}</p>}
      {notice && <p className="notice">{notice}</p>}

      <DataTable
        columns={columns}
        rows={recipes.data}
        loading={recipes.loading}
        error={recipes.error}
        rowKey={(r) => String(r.recipeId)}
        selectedKey={editing === 'new' || editing == null ? null : String(editing)}
        empty="No recipes yet."
      />

      {editing !== null && (
        <>
          <h2>{editing === 'new' ? 'New recipe' : `Editing — ${draft.name || '(unnamed)'}`}</h2>
          <div className="editor">
            <div className="toolbar">
              <label className="inline">
                Name
                <input
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  autoFocus
                />
              </label>
              <label className="inline">
                Kind
                <select
                  value={draft.kind}
                  onChange={(e) => setDraft({ ...draft, kind: e.target.value as Recipe['kind'] })}
                >
                  <option value="Baking">Baking</option>
                  <option value="Decorating">Decorating</option>
                </select>
              </label>
              <label className="inline">
                Produces
                <select
                  value={draft.outputSku}
                  onChange={(e) => setDraft({ ...draft, outputSku: e.target.value })}
                >
                  <option value="">— choose —</option>
                  {outputOptions.map((p) => (
                    <option key={p.sku} value={p.sku}>
                      {label(p)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="inline">
                Qty made
                <input
                  type="number"
                  min={1}
                  value={draft.outputQty}
                  onChange={(e) => setDraft({ ...draft, outputQty: Number(e.target.value) })}
                />
              </label>
            </div>

            <h3>Ingredients</h3>
            {draft.lines.map((line) => (
              <div className="toolbar" key={line.key}>
                <label className="inline">
                  Ingredient
                  <select value={line.inputSku} onChange={(e) => setLine(line.key, { inputSku: e.target.value })}>
                    <option value="">— choose —</option>
                    {(catalog.data ?? []).map((p) => (
                      <option key={p.sku} value={p.sku}>
                        {label(p)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="inline">
                  Qty per batch
                  <input
                    type="number"
                    min={1}
                    value={line.qty}
                    onChange={(e) => setLine(line.key, { qty: Number(e.target.value) })}
                  />
                </label>
                <button
                  className="btn destructive"
                  disabled={draft.lines.length === 1}
                  onClick={() => setDraft({ ...draft, lines: draft.lines.filter((l) => l.key !== line.key) })}
                >
                  Remove
                </button>
              </div>
            ))}
            <div className="toolbar">
              <button
                className="btn neutral"
                onClick={() => setDraft({ ...draft, lines: [...draft.lines, newLine()] })}
              >
                Add ingredient
              </button>
            </div>

            <p className="muted">
              Quantities are in base units (grams or pieces), never packs — the same units the FIFO
              ledger and production entry use.
            </p>

            <div className="toolbar">
              <button className="btn primary" onClick={save} disabled={busy}>
                {busy ? 'Saving…' : editing === 'new' ? 'Create recipe' : 'Save changes'}
              </button>
              <button className="btn neutral" onClick={() => setEditing(null)} disabled={busy}>
                Cancel
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  )
}
