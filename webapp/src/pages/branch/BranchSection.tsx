import { Navigate, Route, Routes } from 'react-router-dom'
import { SectionNav } from '../../components/SectionNav'
import { Stock } from './Stock'
import { ProductionHistory } from './ProductionHistory'
import { SalesHistory } from './SalesHistory'

// Phase 2 is read-only. Delivery acceptance and production entry arrive in
// phase 5; the counter POS stays in WinForms until phase 7.
const ITEMS = [
  { to: '/branch', label: 'Stock' },
  { to: '/branch/production', label: 'Production' },
  { to: '/branch/sales', label: 'Sales' },
]

export function BranchSection() {
  return (
    <>
      <SectionNav items={ITEMS} />
      <Routes>
        <Route index element={<Stock />} />
        <Route path="production" element={<ProductionHistory />} />
        <Route path="sales" element={<SalesHistory />} />
        <Route path="*" element={<Navigate to="/branch" replace />} />
      </Routes>
    </>
  )
}
