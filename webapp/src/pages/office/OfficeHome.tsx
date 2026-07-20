// Phase 1 shell. Phase 2 fills this in with the read-only office reports
// (InventoryCatalog, PurchasesReport, Deliveries, AdjustmentHistory,
// BranchInventoryReport, BranchSalesReport); Phase 4 adds the write screens.
export function OfficeHome() {
  return (
    <section>
      <h1>Office</h1>
      <p className="muted">
        Inventory, purchases, deliveries and reports arrive in the next phase. Until then the
        WinForms office app remains the way to do this work.
      </p>
    </section>
  )
}
