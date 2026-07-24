import { ensureTestCashier } from './staff-helpers'

// Runs ONCE per `playwright test` invocation, before any worker starts. The
// cashier-picker specs need the seeded Gaisano test-cashier; seeding here
// instead of per-spec beforeAll matters because every seeding pass costs a
// zz-owner login, and the API rate-limits logins per source IP per 5-minute
// window (Program.cs; 50 since 2026-07-24, was 10 - three per-spec seedings
// plus the till and owner UI logins pushed a full run past the old cap).
export default async function globalSetup(): Promise<void> {
  if (
    !process.env.PLAYWRIGHT_OWNER_USERNAME ||
    !process.env.PLAYWRIGHT_OWNER_PASSWORD ||
    !process.env.PLAYWRIGHT_STAFF_PIN
  ) {
    // Specs guard themselves with test.skip on the same vars; seeding just
    // no-ops so a creds-less environment still runs whatever isn't skipped.
    console.warn('[global-setup] Owner creds / staff PIN not set - skipping test-cashier seeding.')
    return
  }
  await ensureTestCashier()
}
