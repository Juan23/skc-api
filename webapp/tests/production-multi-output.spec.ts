import { expect, test } from '@playwright/test'

// Drives the multi-output production UI (webapp-multi-output-production-plan.md)
// end to end through the real browser against the live droplet: log in as the
// zz-gaisano Branch till, record a bake that yields a MIX of finished-good types
// from one recipe, and confirm the history renders the multiple outputs.
//
// Real production rows: staff name is "test-playwright" (the standing `test`-tag
// convention, see skc-api/CLAUDE.md "Test data accumulates in production"), and
// it bakes the zz-tagged "zz Moist Chocolate" recipe seeded for this feature -
// both safe to leave for the owner's one-shot cleanup sweep.

const USERNAME = process.env.PLAYWRIGHT_BRANCH_USERNAME
const PASSWORD = process.env.PLAYWRIGHT_BRANCH_PASSWORD

test.skip(!USERNAME || !PASSWORD, 'Set PLAYWRIGHT_BRANCH_USERNAME/PASSWORD in .env.playwright')

test('record a multi-output bake and see it in history', async ({ page }) => {
  // A normal (non-empty) bake never fires window.confirm; accept any dialog
  // anyway so an unexpected one can't hang the run.
  page.on('dialog', (d) => d.accept())

  // --- sign in (full Branch session, not the till provisioning flow) ---
  await page.goto('/login')
  await page.getByLabel('Username').fill(USERNAME!)
  await page.getByLabel('Password').fill(PASSWORD!)
  const loginResp = page.waitForResponse((r) => r.url().includes('/api/auth/login'))
  await page.getByRole('button', { name: /sign in/i }).click()
  expect((await loginResp).status(), 'login should succeed').toBe(200)
  // Wait for the app to leave /login (the session cookie is now set) before
  // navigating, otherwise /branch/* redirects straight back to /login.
  await page.waitForURL((url) => !url.pathname.startsWith('/login'))

  // --- open the production entry screen ---
  await page.goto('/branch/production')
  await expect(page.getByRole('heading', { name: /^Production/ })).toBeVisible()
  await page.getByRole('button', { name: /record a batch/i }).click()

  // Kind = Baking, recipe = the seeded multi-output recipe.
  await page.getByLabel('Kind').selectOption('Baking')
  await page.getByLabel('Recipe').selectOption({ label: 'zz Moist Chocolate' })

  // The "What did you make?" section renders one qty box per possible output.
  await expect(page.getByRole('heading', { name: /what did you make/i })).toBeVisible()

  // Enter a mix: 4x 8-inch + 6x cupcakes, leaving 10-inch at 0.
  await page.getByLabel(/Choc 8in/).fill('4')
  await page.getByLabel(/Cupcake/).fill('6')
  await page.getByLabel(/baked \/ decorated by/i).fill('test-playwright')

  // Total-made line should reflect 4 + 6 = 10.
  await expect(page.getByText(/Total made this batch:\s*10/)).toBeVisible()
  await page.screenshot({ path: 'test-results/multi-output-entry.png', fullPage: true })

  // --- record it ---
  await page.getByRole('button', { name: /record batch/i }).click()

  // Success notice lists BOTH outputs.
  const notice = page.locator('.notice')
  await expect(notice).toContainText(/Recorded/i)
  await expect(notice).toContainText(/zz-choc-8/)
  await expect(notice).toContainText(/zz-cupcake/)

  // History table below shows the batch with both outputs stacked in one Made
  // cell (rendered by display name, not SKU). The newest batch is the top row.
  const madeCell = page.locator('table.data td', { hasText: 'Choc 8in' }).first()
  await expect(madeCell).toContainText('Cupcake')
  await page.screenshot({ path: 'test-results/multi-output-history.png', fullPage: true })
})
