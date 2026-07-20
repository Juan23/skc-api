import { useState } from 'react'
import { StockView } from '../../components/StockView'
import { STOCK_LOCATIONS } from '../../lib/branches'

// Mirrors BranchInventoryReport in the office app: office-side view of what any
// one location is holding.
export function BranchInventoryReport() {
  const [branch, setBranch] = useState<string>(STOCK_LOCATIONS[0])
  return (
    <section>
      <h1>Stock by location</h1>
      <div className="toolbar">
        <label className="inline">
          Location
          <select value={branch} onChange={(e) => setBranch(e.target.value)}>
            {STOCK_LOCATIONS.map((b) => (
              <option key={b} value={b}>{b}</option>
            ))}
          </select>
        </label>
      </div>
      <StockView key={branch} branch={branch} />
    </section>
  )
}
