// The branch list is hardcoded here, which makes this the fifth place it lives
// (Delivery.cs, frmBranchPicker.cs, BranchInventoryReport.cs, and the
// delivery_logs.to_branch strings themselves). There is still no `branches`
// table - see the standing item in /spec-status.md. Names are exact and
// case-sensitive on the wire; add or rename in every one of those places at once.
export const BRANCHES = ['Yoho', 'Gaisano', 'Liloy', 'Labason'] as const

// 'Office' is a branch as far as inventory_lots and pos_sales are concerned -
// the office is both the delivery hub and a storefront - so stock reports need
// it alongside the real branches.
export const STOCK_LOCATIONS = ['Office', ...BRANCHES] as const
