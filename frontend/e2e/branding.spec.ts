import { expect, test } from '@playwright/test'

test('room page has a neutral tab icon and no product banner', async ({ page, request }) => {
  await page.route('**/api/discord/*/join', route =>
    route.fulfill({ status: 403, json: { error: 'Connect to the associated Discord voice channel to watch.' } }))
  await page.goto('/r/' + 'x'.repeat(32))
  await expect(page).toHaveTitle('Screen Share')
  const player = page.getByRole('main', { name: 'Screen Share player' })
  await expect(player).toBeVisible()
  await expect(player.locator('header h1, .brand-symbol')).toHaveCount(0)
  await expect(player).not.toContainText(/whiterun/i)
  const icon = page.locator('link[rel="icon"]')
  await expect(icon).toHaveAttribute('href', '/assets/screen-share-icon.png')
  const response = await request.get(await icon.getAttribute('href') as string)
  expect(response.status()).toBe(200)
  expect(response.headers()['content-type']).toContain('image/png')
  expect((await response.body()).readUInt32BE()).toBe(0x89504e47)
})
