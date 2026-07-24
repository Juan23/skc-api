import { expect, test } from '@playwright/test'
import { TEST_CASHIER, pickCashier, staffPin } from './staff-helpers'

// Playwright stand-in for the manual Claude-in-Chrome pass documented in
// skc-api/CLAUDE.md ("Claude-in-Chrome POS testing") and narrated in
// blog-posts/trying-to-break-the-till-on-purpose.md - same till
// (zz-gaisano), same offline-durability story, but scripted so it can run
// headlessly from this server with no display. See skc-api/CLAUDE.md
// "Browser-based testing" for why Playwright + screenshot review replaces
// live Claude-in-Chrome here.
//
// Real production rows: every sale rung by this test carries staff name
// "test-cashier" (rung through the cashier picker's seeded test row - matches
// the codebase's standing `test`-tag convention, see skc-api/CLAUDE.md "Test
// data accumulates in production") so it's safe to leave in place for the
// owner's eventual one-shot cleanup sweep.

const USERNAME = process.env.PLAYWRIGHT_BRANCH_USERNAME
const PASSWORD = process.env.PLAYWRIGHT_BRANCH_PASSWORD

test.skip(!USERNAME || !PASSWORD, 'Set PLAYWRIGHT_BRANCH_USERNAME/PASSWORD in .env.playwright - see .env.playwright.example')
test.skip(
  !process.env.PLAYWRIGHT_OWNER_USERNAME || !process.env.PLAYWRIGHT_OWNER_PASSWORD || !process.env.PLAYWRIGHT_STAFF_PIN,
  'Set PLAYWRIGHT_OWNER_USERNAME/PASSWORD and PLAYWRIGHT_STAFF_PIN in .env.playwright (needed to seed the test cashier)',
)

// The active Gaisano test-cashier row the picker needs is seeded ONCE per run
// in tests/global-setup.ts (not per-spec - each seeding costs a rate-limited
// owner login).

test.beforeEach(({ page }) => {
  // SaleScreen.submit() gates every completed sale behind window.confirm -
  // auto-accept it like the Claude-in-Chrome pass does (CLAUDE.md note:
  // "Complete sale fires a window.confirm that freezes the extension").
  page.on('dialog', (dialog) => dialog.accept())
})

// The app only discovers it's offline reactively - a failed sync attempt -
// not via a live navigator.onLine listener (see syncEngine.ts: the mount
// effect runs once, then only a 60s timer / 'online' event / a just-completed
// sale re-triggers it). So the OFFLINE badge cannot be asserted right after
// context.setOffline(true) with nothing else happening; something has to
// actually try to reach the server first. Matches skc-api/CLAUDE.md's own
// testing note to verify sync by reading IndexedDB directly rather than
// trusting the badge - used here as the source of truth for durability, with
// the badge checked as a secondary UX signal.
async function countPendingSales(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const req = indexedDB.open('skc-pos')
        req.onerror = () => reject(req.error)
        req.onsuccess = () => {
          const db = req.result
          const tx = db.transaction('pendingSales', 'readonly')
          const countReq = tx.objectStore('pendingSales').count()
          countReq.onsuccess = () => resolve(countReq.result)
          countReq.onerror = () => reject(countReq.error)
        }
      }),
  )
}

async function signInTill(page: import('@playwright/test').Page) {
  await page.goto('/pos')
  // A fresh browser profile has no cached till identity, so this always
  // lands on ProvisionScreen's "Set up this till" form regardless of prior
  // runs - the identity write happens client-side (IndexedDB), not server
  // remembered.
  await page.getByLabel('Username').fill(USERNAME!)
  await page.getByLabel('Password').fill(PASSWORD!)
  await page.getByRole('button', { name: /sign in|set up till/i }).click()
  await expect(page.getByPlaceholder('Search brand or item…')).toBeVisible({ timeout: 10_000 })
}

test('till provisions and rings an online sale', async ({ page }, testInfo) => {
  await signInTill(page)
  await page.screenshot({ path: testInfo.outputPath('01-till-ready.png'), fullPage: true })

  // The cashier picker replaced the free-text input (Gaisano has staff rows).
  // First prove a wrong PIN is rejected inline, then verify with the real one.
  const cashierBtn = page.getByRole('button', { name: TEST_CASHIER, exact: true })
  await expect(cashierBtn).toBeVisible({ timeout: 15_000 })
  await cashierBtn.click()
  await page.getByLabel('PIN').fill('0000')
  await expect(page.getByText(/wrong pin/i)).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('01b-wrong-pin.png'), fullPage: true })
  await page.getByLabel('PIN').fill(staffPin())
  await expect(page.getByText(`Cashier: ${TEST_CASHIER}`)).toBeVisible()

  // First catalog tile - real SKU, but tagging is via the cashier name (the
  // field the codebase's own cleanup-sweep convention greps on), not item
  // choice.
  await page.locator('.pos-tile').first().click()
  await page.screenshot({ path: testInfo.outputPath('02-item-added.png'), fullPage: true })

  const completeBtn = page.getByRole('button', { name: 'Complete sale' })
  await expect(completeBtn).toBeEnabled()
  await completeBtn.click()

  await expect(page.getByText(/sale complete/i)).toBeVisible({ timeout: 10_000 })
  await page.screenshot({ path: testInfo.outputPath('03-sale-complete.png'), fullPage: true })

  const status = page.getByRole('status').filter({ hasText: /SYNCED|PENDING|READY/ })
  await expect(status).toBeVisible()
})

test('a sale rung offline survives a reload and syncs once reconnected', async ({ page, context }, testInfo) => {
  await signInTill(page)

  // A page-navigation reload while genuinely offline can only be served by
  // the PWA's service worker's precache (navigateFallback) - and a worker
  // registered on THIS load doesn't activate instantly. Wait for it here,
  // still online, so the offline reload below has something to be served by
  // instead of hitting a real net::ERR_INTERNET_DISCONNECTED.
  await page.evaluate(() => navigator.serviceWorker.ready)

  // Wait for the cashier picker to appear BEFORE going offline - it only
  // renders once the mount sync's staff pull has landed and been cached, and
  // that pull needs the network. Going offline first would race the pull and
  // strand the till on the free-text fallback.
  await expect(page.getByRole('button', { name: TEST_CASHIER, exact: true })).toBeVisible({ timeout: 15_000 })

  await context.setOffline(true)

  // Ringing the sale is itself the thing that makes the app discover it's
  // offline: commitSale() is purely local (durable regardless of network),
  // but Pos.tsx's onComplete calls sync.triggerSync() right after - that
  // attempt is what actually hits the blocked network and flips the badge.
  //
  // Picking the cashier AFTER the offline flip is deliberate - it's the
  // feature's headline offline assertion: the staff list was cached during
  // the online signInTill sync, and the PIN check is pure client-side
  // SubtleCrypto, so the whole verified-cashier flow must work with the
  // network gone.
  await pickCashier(page)
  await page.locator('.pos-tile').first().click()
  await page.getByRole('button', { name: 'Complete sale' }).click()
  await expect(page.getByText(/sale complete/i)).toBeVisible({ timeout: 10_000 })
  await page.screenshot({ path: testInfo.outputPath('04-offline-sale-complete.png'), fullPage: true })

  await expect(page.getByRole('status').filter({ hasText: 'OFFLINE' })).toBeVisible({ timeout: 10_000 })
  await expect(async () => expect(await countPendingSales(page)).toBe(1)).toPass({ timeout: 5_000 })
  await page.screenshot({ path: testInfo.outputPath('05-offline-badge.png'), fullPage: true })

  // The headline durability check from the manual pass: reload while the
  // sale is still only in IndexedDB, confirm it survived the reload (not
  // "confirm it's still in memory", which proves nothing). The fresh mount's
  // own check()/runSync also fail against the still-blocked network, so this
  // independently re-confirms OFFLINE rather than reusing pre-reload state.
  await page.reload()
  await expect(page.getByRole('status').filter({ hasText: 'OFFLINE' })).toBeVisible({ timeout: 10_000 })
  expect(await countPendingSales(page)).toBe(1)
  await page.screenshot({ path: testInfo.outputPath('06-reloaded-still-queued.png'), fullPage: true })

  await context.setOffline(false)
  await expect(page.getByRole('status').filter({ hasText: 'SYNCED' })).toBeVisible({ timeout: 15_000 })
  await expect(async () => expect(await countPendingSales(page)).toBe(0)).toPass({ timeout: 5_000 })
  await page.screenshot({ path: testInfo.outputPath('07-synced-after-reconnect.png'), fullPage: true })
})
