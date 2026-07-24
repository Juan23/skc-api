import { expect, test } from '@playwright/test'

// Click-tests the owner Staff (cashier registry) page - owner-gated like
// Devices (Owner-role session AND an owner-IP device; this box is allowlisted).
// Runs its CRUD against branch LILOY deliberately - NOT Gaisano - so it can
// never perturb the POS specs' seeded Gaisano test-cashier under parallel
// workers. All rows zz-tagged per the cleanup convention.
const USERNAME = process.env.PLAYWRIGHT_OWNER_USERNAME
const PASSWORD = process.env.PLAYWRIGHT_OWNER_PASSWORD

test.skip(!USERNAME || !PASSWORD, 'Set PLAYWRIGHT_OWNER_USERNAME/PASSWORD in .env.playwright')

const TEST_NAME = 'zz-ui-test-cashier'
const BRANCH = 'Liloy'

test('manage a cashier through the owner Staff UI', async ({ page, request }) => {
  // The Reset PIN action uses window.prompt (answer with a new PIN); every
  // other dialog (delete confirm) just gets accepted.
  page.on('dialog', (d) => (d.type() === 'prompt' ? d.accept('1357') : d.accept()))

  // --- sign in as the owner test account ---
  await page.goto('/login')
  await page.getByLabel('Username').fill(USERNAME!)
  await page.getByLabel('Password').fill(PASSWORD!)
  const loginResp = page.waitForResponse((r) => r.url().includes('/api/auth/login'))
  await page.getByRole('button', { name: /sign in/i }).click()
  expect((await loginResp).status(), 'owner login should succeed').toBe(200)
  await page.waitForURL((url) => !url.pathname.startsWith('/login'))

  // --- open the Staff page ---
  await page.goto('/owner/staff')
  await expect(page.getByRole('heading', { name: 'Staff', exact: true })).toBeVisible()
  await page.screenshot({ path: 'test-results/staff-list.png', fullPage: true })

  // --- add a zz test cashier on Liloy ---
  await page.getByLabel('Branch').selectOption(BRANCH)
  await page.getByLabel('Staff name').fill(TEST_NAME)
  await page.getByLabel('PIN').fill('2468')
  const createResp = page.waitForResponse((r) => r.url().endsWith('/api/staff') && r.request().method() === 'POST')
  await page.getByRole('button', { name: /add cashier/i }).click()
  expect((await createResp).status(), 'create cashier should succeed').toBe(200)

  const row = page.getByRole('row', { name: new RegExp(TEST_NAME) })
  await expect(row).toBeVisible()
  await page.screenshot({ path: 'test-results/staff-after-add.png', fullPage: true })

  // It should appear in the (ungated) branch feed the tills consume.
  const feed = await request.get(`/api/staff/branch/${BRANCH}`)
  expect(feed.status()).toBe(200)
  let names = ((await feed.json()) as { staffName: string }[]).map((s) => s.staffName)
  expect(names).toContain(TEST_NAME)

  // --- reset the PIN (prompt auto-answered with 1357) ---
  const pinResp = page.waitForResponse((r) => r.url().includes('/pin') && r.request().method() === 'POST')
  await row.getByRole('button', { name: /reset pin/i }).click()
  expect((await pinResp).status(), 'PIN reset should succeed').toBe(200)

  // --- disable -> gone from the branch feed, still listed here ---
  const disableResp = page.waitForResponse((r) => r.url().includes('/deactivate') && r.request().method() === 'PATCH')
  await row.getByRole('button', { name: /disable/i }).click()
  expect((await disableResp).status(), 'deactivate should succeed').toBe(200)
  await expect(row.locator('.pill.bad')).toBeVisible()
  names = (((await (await request.get(`/api/staff/branch/${BRANCH}`)).json()) as { staffName: string }[])).map(
    (s) => s.staffName,
  )
  expect(names, 'disabled cashier must not be served to tills').not.toContain(TEST_NAME)
  await page.screenshot({ path: 'test-results/staff-after-disable.png', fullPage: true })

  // --- delete (confirm auto-accepted) ---
  const delResp = page.waitForResponse((r) => r.url().includes('/api/staff/') && r.request().method() === 'DELETE')
  await row.getByRole('button', { name: /delete/i }).click()
  expect((await delResp).status(), 'delete should succeed').toBe(200)
  await expect(page.getByRole('row', { name: new RegExp(TEST_NAME) })).toHaveCount(0)
  await page.screenshot({ path: 'test-results/staff-after-delete.png', fullPage: true })
})
