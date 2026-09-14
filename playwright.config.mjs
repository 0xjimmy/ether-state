import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './test/browser',
  fullyParallel: true,
  forbidOnly: Boolean(process.env['CI']),
  retries: 0,
  use: { baseURL: 'http://127.0.0.1:4179' },
  webServer: { command: 'node scripts/browser-server.mjs', url: 'http://127.0.0.1:4179', reuseExistingServer: false },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
})
