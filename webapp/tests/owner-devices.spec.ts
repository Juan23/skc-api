import { expect, test } from '@playwright/test'

// Click-tests the owner Devices registry page (owner-gated: needs an Owner-role
// session AND an owner-IP device - this environment's box is on the owner IP
// allowlist). Adds a zz-tagged test device through the real UI, checks it shows
// in the table, then deletes it. Uses the zz-owner TEST owner account.
const USERNAME = process.env.PLAYWRIGHT_OWNER_USERNAME
const PASSWORD = process.env.PLAYWRIGHT_OWNER_PASSWORD

test.skip(!USERNAME || !PASSWORD, 'Set PLAYWRIGHT_OWNER_USERNAME/PASSWORD in .env.playwright')

const TEST_IP = '100.111.111.111'

test('manage a device through the owner Devices UI', async ({ page }) => {
  // Auto-accept the delete confirm() dialog.
  page.on('dialog', (d) => d.accept())

  // --- sign in as the owner test account ---
  await page.goto('/login')
  await page.getByLabel('Username').fill(USERNAME!)
  await page.getByLabel('Password').fill(PASSWORD!)
  const loginResp = page.waitForResponse((r) => r.url().includes('/api/auth/login'))
  await page.getByRole('button', { name: /sign in/i }).click()
  expect((await loginResp).status(), 'owner login should succeed').toBe(200)
  await page.waitForURL((url) => !url.pathname.startsWith('/login'))

  // --- open the Devices registry ---
  await page.goto('/owner/devices')
  await expect(page.getByRole('heading', { name: 'Devices', exact: true })).toBeVisible()
  // The five seeded rows should be present.
  await expect(page.getByText('100.108.218.24')).toBeVisible()
  await page.screenshot({ path: 'test-results/devices-list.png', fullPage: true })

  // --- add a zz test device (Office tier) ---
  await page.getByLabel('Tailscale IP').fill(TEST_IP)
  await page.getByLabel('Tier').selectOption('Office')
  await page.getByLabel('Label').fill('zz UI test device')
  const createResp = page.waitForResponse(
    (r) => r.url().includes('/api/devices') && r.request().method() === 'POST',
  )
  await page.getByRole('button', { name: /add device/i }).click()
  expect((await createResp).status(), 'create device should succeed').toBe(200)

  // It should now be in the table.
  const row = page.getByRole('row', { name: new RegExp(TEST_IP) })
  await expect(row).toBeVisible()
  await page.screenshot({ path: 'test-results/devices-after-add.png', fullPage: true })

  // --- delete it (confirm dialog auto-accepted) ---
  const delResp = page.waitForResponse(
    (r) => r.url().includes('/api/devices/') && r.request().method() === 'DELETE',
  )
  await row.getByRole('button', { name: /delete/i }).click()
  expect((await delResp).status(), 'delete device should succeed').toBe(200)
  await expect(page.getByRole('row', { name: new RegExp(TEST_IP) })).toHaveCount(0)
  await page.screenshot({ path: 'test-results/devices-after-delete.png', fullPage: true })
})
