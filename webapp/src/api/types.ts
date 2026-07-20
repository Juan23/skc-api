// TypeScript mirrors of the API's wire DTOs.
//
// ASP.NET's minimal API camelCases property names on the way out, and it does so
// per-word: `SKU` becomes `sku`, `BranchName` becomes `branchName`. Phase 2 adds
// the inventory/delivery/sales types - capture the real JSON with curl before
// writing each one rather than transcribing the C# class from memory.

export type Role = 'Owner' | 'Office' | 'Branch'

export interface CurrentUser {
  username: string
  role: Role
  branchName: string | null
  mustChangePassword: boolean
}

export interface SetupNeeded {
  needed: boolean
}

export interface AppUser {
  userId: number
  username: string
  role: Role
  branchName: string | null
  isActive: boolean
  mustChangePassword: boolean
  // Rendered as text, never parsed into a JS Date: the DB stores
  // `timestamp without time zone` whose meaning is mixed across the schema
  // (client-sent values are PH local, server CURRENT_TIMESTAMP values are UTC),
  // so a Date round-trip would silently shift some of them.
  createdAt: string
}
