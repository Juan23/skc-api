import { Navigate, Route, Routes } from 'react-router-dom'
import { SectionNav } from '../../components/SectionNav'
import { InventoryCatalog } from './InventoryCatalog'
import { PurchasesReport } from './PurchasesReport'
import { Deliveries } from './Deliveries'
import { AdjustmentHistory } from './AdjustmentHistory'
import { BranchInventoryReport } from './BranchInventoryReport'
import { BranchSalesReport } from './BranchSalesReport'
import { ProductionReport } from './ProductionReport'

// Phase 2 is read-only. The write screens (purchases entry, delivery create /
// edit-ticket, product add/edit, adjust) arrive in phase 4 and slot in here.
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
        <Route path="purchases" element={<PurchasesReport />} />
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
