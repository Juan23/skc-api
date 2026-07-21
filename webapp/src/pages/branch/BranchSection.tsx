import { Navigate, Route, Routes } from 'react-router-dom'
import { SectionNav } from '../../components/SectionNav'
import { Stock } from './Stock'
import { PendingDeliveries } from './PendingDeliveries'
import { ProductionHistory } from './ProductionHistory'
import { SalesHistory } from './SalesHistory'

// Phase 5 added the branch's write side: delivery acceptance and production
// entry (an entry panel above the history). Sales gained a CSV export; the
// counter POS itself stays in WinForms until phase 7.
const ITEMS = [
  { to: '/branch', label: 'Stock' },
  { to: '/branch/deliveries', label: 'Deliveries' },
  { to: '/branch/production', label: 'Production' },
  { to: '/branch/sales', label: 'Sales' },
]

export function BranchSection() {
  return (
    <>
      <SectionNav items={ITEMS} />
      <Routes>
        <Route index element={<Stock />} />
        <Route path="deliveries" element={<PendingDeliveries />} />
        <Route path="production" element={<ProductionHistory />} />
        <Route path="sales" element={<SalesHistory />} />
        <Route path="*" element={<Navigate to="/branch" replace />} />
      </Routes>
    </>
  )
}
