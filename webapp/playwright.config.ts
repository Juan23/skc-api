import { existsSync } from 'node:fs'
import { defineConfig } from '@playwright/test'

// Real till credentials live in .env.playwright (gitignored, never committed -
// see .env.playwright.example). Node's built-in loader, not a dotenv
// dependency - available since Node 20.6, and this repo already runs Node 24.
if (existsSync('.env.playwright')) process.loadEnvFile('.env.playwright')

// Runs against the live droplet (see skc-api/CLAUDE.md "Browser-based testing"
// section) - there is no staging environment for this system, matching every
// other verification method already documented there. baseURL defaults to the
// Tailscale HTTPS origin (required: the session cookie is Secure-only, see
// skc-api/CLAUDE.md's auth-model note - a plain-HTTP origin silently drops it).
export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  retries: 0,
  // One-time seeding (the cashier-picker specs' test-cashier row). Global, not
  // per-spec beforeAll: each seeding pass costs a zz-owner login and the API
  // rate-limits logins to 10 per IP per 5 minutes - see tests/global-setup.ts.
  globalSetup: './tests/global-setup.ts',
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'https://skc-hq.tail0988bb.ts.net',
    screenshot: 'on',
    trace: 'retain-on-failure',
    ignoreHTTPSErrors: true,
    // Playwright's headless default is the stripped-down chrome-headless-shell
    // binary, which does not register service workers - fatal for this app's
    // offline-reload test (navigateFallback needs an active SW). channel:
    // 'chromium' selects the full Chrome-for-Testing build's own --headless=new
    // mode instead, which has full SW support.
    channel: 'chromium',
  },
})
