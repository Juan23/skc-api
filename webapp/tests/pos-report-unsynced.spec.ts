import { expect, test } from '@playwright/test'
import { ensureTestCashier, pickCashier } from './staff-helpers'

// Regression for bug-track L1 (2026-07-23): an ONLINE POS DayReport must include
// today's not-yet-synced local sales, so its gross matches the day log's takings
// instead of silently dropping a sale still inside the 60s sync window.
//
// Deterministic repro without racing the sync engine: intercept the sync
// POST /api/sales so it fails (sale stays syncState 'pending', never becomes a
// server row), while GET /api/sales?... (the report's own fetch) is left to
// reach the live server. The report is therefore genuinely ONLINE (no offline
// banner) yet must still surface the pending sale via the "Not yet synced"
// summary line - which, before the fix, only ever appeared on the OFFLINE path.
//
// Real login only; the blocked sale never reaches the server, so no test row is
// created. Staff name "test-cashier" (the seeded picker row) per the test-tag
// convention regardless.

const USERNAME = process.env.PLAYWRIGHT_BRANCH_USERNAME
const PASSWORD = process.env.PLAYWRIGHT_BRANCH_PASSWORD

test.skip(!USERNAME || !PASSWORD, 'Set PLAYWRIGHT_BRANCH_USERNAME/PASSWORD in .env.playwright')
test.skip(
  !process.env.PLAYWRIGHT_OWNER_USERNAME || !process.env.PLAYWRIGHT_OWNER_PASSWORD || !process.env.PLAYWRIGHT_STAFF_PIN,
  'Set PLAYWRIGHT_OWNER_USERNAME/PASSWORD and PLAYWRIGHT_STAFF_PIN in .env.playwright (needed to seed the test cashier)',
)

test.beforeAll(() => ensureTestCashier())

test.beforeEach(({ page }) => {
  page.on('dialog', (dialog) => dialog.accept())
})

type Page = import('@playwright/test').Page

function countPendingSales(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const req = indexedDB.open('skc-pos')
        req.onerror = () => reject(req.error)
        req.onsuccess = () => {
          const tx = req.result.transaction('pendingSales', 'readonly')
          const c = tx.objectStore('pendingSales').count()
          c.onsuccess = () => resolve(c.result)
          c.onerror = () => reject(c.error)
        }
      }),
  )
}

test('an online report includes a not-yet-synced sale (L1)', async ({ page }, testInfo) => {
  // Block ONLY the sync push (POST /api/sales). GET /api/sales?... and
  // /api/sales/lines?... (different method / path) reach the live server, so the
  // report loads online. Regex, not glob, so /api/sales/lines and /void are not
  // caught.
  await page.route(/\/api\/sales(\?|$)/, (route) => {
    if (route.request().method() === 'POST') return route.fulfill({ status: 500, body: 'blocked for L1 test' })
    return route.continue()
  })

  // Provision the till (real login; auth endpoints aren't touched by the route).
  await page.goto('/pos')
  await page.getByLabel('Username').fill(USERNAME!)
  await page.getByLabel('Password').fill(PASSWORD!)
  await page.getByRole('button', { name: /sign in|set up till/i }).click()
  await expect(page.getByPlaceholder('Search brand or item…')).toBeVisible({ timeout: 10_000 })

  // Ring a sale. commitSale makes it durable+pending; the post-sale sync push is
  // 500-blocked, so it stays 'pending' (not moved to synced, not a server row).
  // (The staff pull is a GET, untouched by the POST-only route above, so the
  // cashier picker works normally here.)
  await pickCashier(page)
  await page.locator('.pos-tile').first().click()
  await page.getByRole('button', { name: 'Complete sale' }).click()
  await expect(page.getByText(/sale complete/i)).toBeVisible({ timeout: 10_000 })
  await expect(async () => expect(await countPendingSales(page)).toBe(1)).toPass({ timeout: 5_000 })

  // Open the Report tab - it fetches today from the live server (online) and
  // merges the still-pending local sale.
  await page.getByRole('tab', { name: /^report$/i }).click()

  // The report is genuinely ONLINE: the "Offline copy" banner must NOT show...
  await expect(page.getByText(/Offline copy/i)).toHaveCount(0)
  // ...yet the not-yet-synced sale is surfaced and counted. Before the fix this
  // line only appeared on the offline path; an online report dropped the sale.
  await expect(page.getByText(/not yet synced/i)).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText(/Gross total/i)).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('01-online-report-with-unsynced.png'), fullPage: true })
})
