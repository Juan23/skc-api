import { expect, test } from '@playwright/test'
import { pickCashier } from './staff-helpers'

// STRESS / durability probe for the offline-first web POS - beyond the single
// sale in pos-smoke.spec.ts. Rings a burst of sales while offline (cash,
// cashless, and a discounted sale), reloads mid-queue, then reconnects and
// asserts the WHOLE burst drains with no loss and no duplication - checked in
// IndexedDB (pendingSales -> 0, syncedLog -> N) AND against the server's
// authoritative day-log. Real rows, staff name "test-cashier" (the seeded
// picker row) per the codebase's test-tag cleanup convention (skc-api/CLAUDE.md
// "Test data accumulates").
//
// This is a review-time probe, not permanent regression coverage; delete after
// the review round if it isn't wanted as a keeper.

const USERNAME = process.env.PLAYWRIGHT_BRANCH_USERNAME
const PASSWORD = process.env.PLAYWRIGHT_BRANCH_PASSWORD

test.skip(!USERNAME || !PASSWORD, 'Set PLAYWRIGHT_BRANCH_USERNAME/PASSWORD in .env.playwright')
test.skip(
  !process.env.PLAYWRIGHT_OWNER_USERNAME || !process.env.PLAYWRIGHT_OWNER_PASSWORD || !process.env.PLAYWRIGHT_STAFF_PIN,
  'Set PLAYWRIGHT_OWNER_USERNAME/PASSWORD and PLAYWRIGHT_STAFF_PIN in .env.playwright (needed to seed the test cashier)',
)

test.beforeEach(({ page }) => {
  page.on('dialog', (dialog) => dialog.accept())
})

type Page = import('@playwright/test').Page

function countStore(page: Page, store: 'pendingSales' | 'syncedLog'): Promise<number> {
  return page.evaluate(
    (storeName) =>
      new Promise<number>((resolve, reject) => {
        const req = indexedDB.open('skc-pos')
        req.onerror = () => reject(req.error)
        req.onsuccess = () => {
          const tx = req.result.transaction(storeName, 'readonly')
          const c = tx.objectStore(storeName).count()
          c.onsuccess = () => resolve(c.result)
          c.onerror = () => reject(c.error)
        }
      }),
    store,
  )
}

// Every clientSaleId currently in syncedLog - to prove no duplication (a set of
// N unique ids after draining N sales).
function syncedIds(page: Page): Promise<string[]> {
  return page.evaluate(
    () =>
      new Promise<string[]>((resolve, reject) => {
        const req = indexedDB.open('skc-pos')
        req.onerror = () => reject(req.error)
        req.onsuccess = () => {
          const tx = req.result.transaction('syncedLog', 'readonly')
          const all = tx.objectStore('syncedLog').getAllKeys()
          all.onsuccess = () => resolve(all.result as string[])
          all.onerror = () => reject(all.error)
        }
      }),
  )
}

async function signInTill(page: Page) {
  await page.goto('/pos')
  await page.getByLabel('Username').fill(USERNAME!)
  await page.getByLabel('Password').fill(PASSWORD!)
  await page.getByRole('button', { name: /sign in|set up till/i }).click()
  await expect(page.getByPlaceholder('Search brand or item…')).toBeVisible({ timeout: 10_000 })
}

// Rings one sale: tap the Nth catalog tile, optionally add a discount, complete
// via cash or a cashless method. Waits for the "sale complete" confirmation so
// the durable commit has landed before the next ring.
// The cashier is picked ONCE before the burst (see the test body) and persists
// across consecutive sales - useCart.reset() deliberately keeps staffName, and
// each subsequent Complete being enabled implicitly asserts that persistence.
async function ringSale(page: Page, opts: { tile: number; method: string; discount?: string }) {
  const tiles = page.locator('.pos-tile')
  await tiles.nth(opts.tile).click()
  if (opts.discount) {
    await page.getByRole('button', { name: /add discount/i }).click()
    await page.getByLabel('Discount amount').fill(opts.discount)
    await page.getByRole('button', { name: 'Apply' }).click()
  }
  if (opts.method === 'Cash') {
    await page.getByRole('button', { name: 'Complete sale' }).click()
  } else {
    await page.getByRole('button', { name: opts.method, exact: true }).click()
  }
  await expect(page.getByText(/sale complete/i)).toBeVisible({ timeout: 10_000 })
}

test('a burst of offline sales survives reloads and fully drains on reconnect', async ({ page, context }, testInfo) => {
  await signInTill(page)
  await page.evaluate(() => navigator.serviceWorker.ready)

  // Baseline: however many the till already had synced today (other tests /
  // prior runs share the zz-gaisano till), so the assertions are deltas.
  const baseSynced = await countStore(page, 'syncedLog')

  // Verify the cashier while still online (the picker only appears once the
  // mount sync's staff pull lands - going offline first would race it), then
  // ring the whole burst offline on that one verification.
  await pickCashier(page)

  await context.setOffline(true)

  // Burst of 6 sales, mixing every completion path so the batch push exercises
  // Cash, all three cashless methods, and a discounted sale together.
  const plan = [
    { tile: 0, method: 'Cash' as const },
    { tile: 1, method: 'GCash' as const },
    { tile: 0, method: 'GCash Terminal' as const },
    { tile: 2, method: 'Foodpanda' as const },
    { tile: 1, method: 'Cash' as const, discount: '1.00' },
    { tile: 0, method: 'Cash' as const },
  ]
  for (const s of plan) await ringSale(page, s)

  await expect(page.getByRole('status').filter({ hasText: 'OFFLINE' })).toBeVisible({ timeout: 10_000 })
  await expect(async () => expect(await countStore(page, 'pendingSales')).toBe(plan.length)).toPass({ timeout: 5_000 })
  await page.screenshot({ path: testInfo.outputPath('01-burst-queued-offline.png'), fullPage: true })

  // Reload TWICE while still offline - the queue must survive every reload,
  // still on the blocked network.
  await page.reload()
  await expect(page.getByRole('status').filter({ hasText: 'OFFLINE' })).toBeVisible({ timeout: 10_000 })
  await page.reload()
  expect(await countStore(page, 'pendingSales')).toBe(plan.length)
  await page.screenshot({ path: testInfo.outputPath('02-survived-reloads.png'), fullPage: true })

  // Reconnect: the whole burst drains. pendingSales -> 0, syncedLog gains
  // exactly plan.length rows, and every synced id is unique (no double-commit).
  await context.setOffline(false)
  await expect(async () => expect(await countStore(page, 'pendingSales')).toBe(0)).toPass({ timeout: 20_000 })
  const synced = await syncedIds(page)
  expect(new Set(synced).size).toBe(synced.length) // no duplicates
  expect(synced.length - baseSynced).toBe(plan.length)
  await page.screenshot({ path: testInfo.outputPath('03-fully-drained.png'), fullPage: true })

  // Server-side confirmation: the day log's reconcile pulls the authoritative
  // rows. Switch to it and confirm our test-cashier sales are actually there.
  // (Scoped to the day-log entry markup - a bare getByText would also match
  // the hidden Sell view's picker button for the same name.)
  await page.getByRole('tab', { name: /today's sales/i }).click()
  await expect(page.locator('.pos-daylog-who', { hasText: 'test-cashier' }).first()).toBeVisible({ timeout: 10_000 })
  await page.screenshot({ path: testInfo.outputPath('04-server-daylog.png'), fullPage: true })
})
