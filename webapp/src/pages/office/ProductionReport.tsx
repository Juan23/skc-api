import { useState } from 'react'
import { ProductionView } from '../../components/ProductionView'
import { BRANCHES } from '../../lib/branches'

// Office-side view of any branch's baking/decorating, so the owner isn't
// limited to what a Branch login can see. There was no equivalent in the
// WinForms office app - frmProductionHistory only ever existed branch-side.
//
// BRANCHES, not STOCK_LOCATIONS: production is a branch activity. The office
// holds stock and sells at a counter but does no baking or decorating, so an
// 'Office' option would be a permanently empty choice.
export function ProductionReport() {
  const [branch, setBranch] = useState<string>(BRANCHES[0])
  return (
    <section>
      <h1>Production by branch</h1>
      <div className="toolbar">
        <label className="inline">
          Branch
          <select value={branch} onChange={(e) => setBranch(e.target.value)}>
            {BRANCHES.map((b) => (
              <option key={b} value={b}>{b}</option>
            ))}
          </select>
        </label>
      </div>
      {/* key remounts the view so switching branch clears the loaded range
          instead of showing one branch's batches under another's name. */}
      <ProductionView key={branch} branch={branch} />
    </section>
  )
}
