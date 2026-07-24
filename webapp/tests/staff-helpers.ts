import { expect, request as apiRequest } from '@playwright/test'
import type { Page } from '@playwright/test'

// Shared cashier-picker helpers for the POS specs. The picker replaced the
// free-text "Staff name" input whenever the till's branch has active staff, so
// every POS spec now needs (a) a known test cashier to exist server-side and
// (b) the tap-name-then-PIN flow instead of a fill().
//
// The cashier is named `test-cashier` - the `test` substring is the codebase's
// standing cleanup-index convention (skc-api/CLAUDE.md "Test data accumulates
// in production"), and every sale rung through it carries that staff_name.

export const TEST_CASHIER = 'test-cashier'
export const TEST_CASHIER_BRANCH = 'Gaisano'
const PIN = process.env.PLAYWRIGHT_STAFF_PIN

export function staffPin(): string {
  if (!PIN) throw new Error('Set PLAYWRIGHT_STAFF_PIN in .env.playwright - see .env.playwright.example')
  return PIN
}

interface StaffRow {
  staffId: number
  branchName: string
  staffName: string
  isActive: boolean
}

// Idempotently ensure an ACTIVE `test-cashier` exists for Gaisano with the
// known PIN, via the owner API (this box passes the owner IP gate; the zz-owner
// session supplies the role layer). Convergent regardless of prior state or
// spec ordering: create if missing (a 409 = another parallel worker won the
// race = success), otherwise reset the PIN (a previous run may have left a
// different one) and re-activate if disabled. Runs in beforeAll, so it builds
// its own APIRequestContext - the `request` fixture is test-scoped and not
// available there.
export async function ensureTestCashier(): Promise<void> {
  const owner = process.env.PLAYWRIGHT_OWNER_USERNAME
  const ownerPw = process.env.PLAYWRIGHT_OWNER_PASSWORD
  if (!owner || !ownerPw) throw new Error('Set PLAYWRIGHT_OWNER_USERNAME/PASSWORD in .env.playwright')
  const pin = staffPin()

  const ctx = await apiRequest.newContext({
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'https://skc-hq.tail0988bb.ts.net',
    ignoreHTTPSErrors: true,
  })
  try {
    const login = await ctx.post('/api/auth/login', { data: { username: owner, password: ownerPw } })
    expect(login.status(), 'zz-owner login for staff seeding should succeed').toBe(200)

    const listResp = await ctx.get('/api/staff')
    expect(listResp.status(), 'owner staff list should be readable').toBe(200)
    const rows = (await listResp.json()) as StaffRow[]
    const existing = rows.find(
      (r) => r.branchName === TEST_CASHIER_BRANCH && r.staffName.toLowerCase() === TEST_CASHIER,
    )

    if (!existing) {
      const create = await ctx.post('/api/staff', {
        data: { branchName: TEST_CASHIER_BRANCH, staffName: TEST_CASHIER, pin },
      })
      // 409 = a parallel worker created it between our list and post - fine.
      expect([200, 409], 'create test-cashier should succeed (or already exist)').toContain(create.status())
      if (create.status() === 200) return
      // Lost the race: fall through to the reset path against the winner's row.
    }

    const row =
      existing ??
      ((await (await ctx.get('/api/staff')).json()) as StaffRow[]).find(
        (r) => r.branchName === TEST_CASHIER_BRANCH && r.staffName.toLowerCase() === TEST_CASHIER,
      )
    expect(row, 'test-cashier row should exist by now').toBeTruthy()

    // A prior run (or a human) may have changed the PIN or disabled the row -
    // converge both. PIN reset is idempotent by nature (new salt every time).
    const pinResp = await ctx.post(`/api/staff/${row!.staffId}/pin`, { data: { pin } })
    expect(pinResp.status(), 'test-cashier PIN reset should succeed').toBe(200)
    if (!row!.isActive) {
      const act = await ctx.patch(`/api/staff/${row!.staffId}/activate`)
      expect(act.status(), 'test-cashier activate should succeed').toBe(200)
    }
  } finally {
    await ctx.dispose()
  }
}

// Select the test cashier on the till: wait for their picker button (the
// picker only renders after the mount sync's staff pull lands - a fresh
// profile briefly shows the free-text fallback first), tap it, enter the PIN
// (auto-verifies at the 4th digit), and confirm the verified header. Works
// offline too, as long as the staff list was pulled while still online - that
// offline path is exactly what pos-smoke's offline test exercises.
export async function pickCashier(page: Page): Promise<void> {
  const btn = page.getByRole('button', { name: TEST_CASHIER, exact: true })
  await expect(btn).toBeVisible({ timeout: 15_000 })
  await btn.click()
  await page.getByLabel('PIN').fill(staffPin())
  await expect(page.getByText(`Cashier: ${TEST_CASHIER}`)).toBeVisible({ timeout: 5_000 })
}
