import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 90000,
  expect: { timeout: 15000 },
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: { browserName: process.env.E2E_BROWSER === 'firefox' ? 'firefox' : 'chromium', baseURL: process.env.E2E_BASE_URL || 'http://localhost:5173', headless: true, launchOptions: { chromiumSandbox: true }, trace: 'off', screenshot: 'off', video: 'off' },
})
