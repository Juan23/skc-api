import { expect, test } from '@playwright/test'

// Click-tests the owner Recipes editor (owner-gated, so it needs an Owner-role
// session AND an owner-IP device - this environment's box is on the owner IP
// allowlist as of 2026-07-23). Creates a multi-output recipe through the real
// UI: name, kind, several outputs each with a weight, and an ingredient line.
//
// Uses the zz-owner TEST owner account (see skc-api/CLAUDE.md "Test accounts").
// The recipe it creates is zz-tagged ("zz UI Multi-Output") for the one-shot
// cleanup sweep. Relies on the zz-* products seeded for the multi-output feature
// (zz-choc-8 / zz-choc-10 / zz-cupcake / zz-flour) already existing.

const USERNAME = process.env.PLAYWRIGHT_OWNER_USERNAME
const PASSWORD = process.env.PLAYWRIGHT_OWNER_PASSWORD

test.skip(!USERNAME || !PASSWORD, 'Set PLAYWRIGHT_OWNER_USERNAME/PASSWORD in .env.playwright')

test('create a multi-output recipe through the owner UI', async ({ page }) => {
  // --- sign in as the owner test account ---
  await page.goto('/login')
  await page.getByLabel('Username').fill(USERNAME!)
  await page.getByLabel('Password').fill(PASSWORD!)
  const loginResp = page.waitForResponse((r) => r.url().includes('/api/auth/login'))
  await page.getByRole('button', { name: /sign in/i }).click()
  expect((await loginResp).status(), 'owner login should succeed').toBe(200)
  await page.waitForURL((url) => !url.pathname.startsWith('/login'))

  // --- open the Recipes editor ---
  await page.goto('/owner/recipes')
  await expect(page.getByRole('heading', { name: 'Recipes', exact: true })).toBeVisible()
  await page.getByRole('button', { name: /new recipe/i }).click()

  // Name + kind.
  const name = 'zz UI Multi-Output'
  await page.getByLabel('Name').fill(name)
  await page.getByLabel('Kind').selectOption('Baking')

  // Outputs menu: first row + two more, each a product with a weight.
  await expect(page.getByRole('heading', { name: /can make/i })).toBeVisible()
  // The Product/Ingredient dropdowns populate from the catalog (a separate
  // async load) - wait for its options before selecting, or selectOption races
  // an empty list.
  await expect(page.getByLabel('Product').first().locator('option', { hasText: 'Choc 8in' })).toBeAttached()

  // Row 0 (present by default): 8-inch, weight 40.
  await page.getByLabel('Product').nth(0).selectOption('zz-choc-8')
  await page.getByLabel('Weight').nth(0).fill('40')
  // Add row 1: 10-inch, weight 60.
  await page.getByRole('button', { name: /add output/i }).click()
  await page.getByLabel('Product').nth(1).selectOption('zz-choc-10')
  await page.getByLabel('Weight').nth(1).fill('60')
  // Add row 2: cupcake, weight 2.
  await page.getByRole('button', { name: /add output/i }).click()
  await page.getByLabel('Product').nth(2).selectOption('zz-cupcake')
  await page.getByLabel('Weight').nth(2).fill('2')

  // One ingredient line (zz-flour, 500).
  await page.getByLabel('Ingredient').first().selectOption('zz-flour')
  await page.getByLabel('Qty per batch').first().fill('500')

  await page.screenshot({ path: 'test-results/recipe-multi-output-editor.png', fullPage: true })

  // --- save ---
  const saveResp = page.waitForResponse((r) => r.url().includes('/api/recipes') && r.request().method() === 'POST')
  await page.getByRole('button', { name: /create recipe/i }).click()
  expect((await saveResp).status(), 'recipe create should succeed').toBe(200)

  await expect(page.locator('.notice')).toContainText(name)
  // The list's "Can make" column shows all three output names for the new recipe.
  const row = page.locator('table.data tr', { hasText: name })
  await expect(row).toContainText('Choc 8in')
  await expect(row).toContainText('Choc 10in')
  await expect(row).toContainText('Cupcake')
  await page.screenshot({ path: 'test-results/recipe-multi-output-list.png', fullPage: true })
})
