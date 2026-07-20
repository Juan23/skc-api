import { useState } from 'react'
import { SalesView } from '../../components/SalesView'
import { STOCK_LOCATIONS } from '../../lib/branches'

// Mirrors BranchSalesReport in the office app. 'Office' is included because the
// office counter POS posts sales under branch_name = 'Office' through the very
// same /api/sales pipeline.
export function BranchSalesReport() {
  const [branch, setBranch] = useState<string>(STOCK_LOCATIONS[0])
  return (
    <section>
      <h1>Branch sales</h1>
      <div className="toolbar">
        <label className="inline">
          Branch
          <select value={branch} onChange={(e) => setBranch(e.target.value)}>
            {STOCK_LOCATIONS.map((b) => (
              <option key={b} value={b}>{b}</option>
            ))}
          </select>
        </label>
      </div>
      {/* key remounts the view so a branch switch clears the loaded range and
          selected sale instead of showing one branch's rows under another's name. */}
      <SalesView key={branch} branch={branch} />
    </section>
  )
}
