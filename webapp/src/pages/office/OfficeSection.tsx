import { Navigate, Route, Routes } from 'react-router-dom'
import { SectionNav } from '../../components/SectionNav'
import { InventoryCatalog } from './InventoryCatalog'
import { Purchases } from './Purchases'
import { Deliveries } from './Deliveries'
import { AdjustmentHistory } from './AdjustmentHistory'
import { BranchInventoryReport } from './BranchInventoryReport'
import { BranchSalesReport } from './BranchSalesReport'
import { ProductionReport } from './ProductionReport'

// Phase 4 added the write side: purchases entry + delete, delivery create /
// edit-ticket / delete, product add / edit / deactivate, and stock adjust all
// live inside these same screens (an entry panel above each report).
const ITEMS = [
  { to: '/office', label: 'Catalog' },
  { to: '/office/purchases', label: 'Purchases' },
  { to: '/office/deliveries', label: 'Deliveries' },
  { to: '/office/adjustments', label: 'Adjustments' },
  { to: '/office/stock', label: 'Stock by location' },
  { to: '/office/production', label: 'Production' },
  { to: '/office/sales', label: 'Branch sales' },
]

export function OfficeSection() {
  return (
    <>
      <SectionNav items={ITEMS} />
      <Routes>
        <Route index element={<InventoryCatalog />} />
        <Route path="purchases" element={<Purchases />} />
        <Route path="deliveries" element={<Deliveries />} />
        <Route path="adjustments" element={<AdjustmentHistory />} />
        <Route path="stock" element={<BranchInventoryReport />} />
        <Route path="production" element={<ProductionReport />} />
        <Route path="sales" element={<BranchSalesReport />} />
        <Route path="*" element={<Navigate to="/office" replace />} />
      </Routes>
    </>
  )
}
