import { expect, test } from '@playwright/test'

test('installed package performs batched reads in a browser', async ({ page }) => {
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  await expect(page.locator('body')).toHaveText('ok')
  expect(errors).toEqual([])
})
