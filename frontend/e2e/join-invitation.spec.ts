import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { frontend } from './built-frontend'

const operatorKey = () => process.env.E2E_OPERATOR_KEY || readFileSync(new URL('../../.env', import.meta.url), 'utf8').match(/^LOCAL_ADMIN_KEY=(.+)$/m)?.[1] || ''


async function create(page: Page, baseURL: string) {
  await page.goto(new URL('/rooms', baseURL).href)
  await page.getByLabel('Display name').fill('Publisher regression')
  await page.getByLabel('Room title', { exact: true }).fill('Join regression room')
  await page.getByLabel('Local operator key').fill(operatorKey())
  await page.getByRole('button', { name: 'Create and join room' }).click()
  await expect(page.getByRole('heading', { name: 'Participants (1)' })).toBeVisible()
  const viewer = new URL(await page.getByLabel('Share invitation').inputValue())
  const publisher = new URL(await page.getByLabel('Screen publisher invitation').inputValue())
  return { viewer: new URLSearchParams(viewer.hash.slice(1)), publisher: new URLSearchParams(publisher.hash.slice(1)) }
}
async function join(page: Page, publish: boolean) {
  expect(await page.getByLabel('Local operator key').inputValue()).toBe('')
  const reply = page.waitForResponse(response => response.url().includes('/api/rooms/') && response.url().endsWith('/join'))
  await expect(page.getByRole('button', { name: 'Join room', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Join room', exact: true }).click()
  const response = await reply
  expect(response.status()).toBe(200)
  expect(response.request().headers()['authorization']).toBeUndefined()
  const result = await response.json()
  expect(result.canPublish).toBe(publish)
  const claims = JSON.parse(Buffer.from(result.token.split('.')[1], 'base64url').toString())
  expect(claims.exp - claims.iat).toBe(300)
  expect(claims.video.room).toBe(result.roomId)
  expect(claims.video.canPublish).toBe(publish)
  expect(claims.video.canPublishData).toBe(false)
  expect(claims.video.canPublishSources).toEqual(publish ? ['screen_share', 'screen_share_audio'] : undefined)
  await expect(page.getByRole('heading', { name: 'Participants (2)' })).toBeVisible()
  return result
}

test('query invitation enables an unnamed guest and joins a second independent context without an operator key', async ({ browser, baseURL }) => {
  const first = await browser.newContext(); const second = await browser.newContext()
  try {
    await frontend(first, baseURL!); await frontend(second, baseURL!)
    const owner = await first.newPage(); const guest = await second.newPage()
    const { viewer } = await create(owner, baseURL!)
    const query = new URL(baseURL!); query.search = viewer.toString(); query.searchParams.set('theme', 'retained')
    await guest.goto(query.href)
    await expect(guest.getByLabel('Invitation link')).toHaveValue(query.href)
    await expect(guest.getByLabel('Display name')).toHaveValue('')
    const result = await join(guest, false)
    expect(result.displayName).toBe('Guest')
    await expect(owner.getByText('Guest', { exact: true })).toBeVisible()
    await expect(guest.getByText('Guest (you)', { exact: true })).toBeVisible()
    const clean = new URL(guest.url())
    expect(clean.search).toBe('?theme=retained'); expect(clean.hash).toBe('')
    await expect(guest.getByRole('button', { name: 'Start sharing' })).toHaveCount(0)
    await guest.getByRole('button', { name: 'Leave room' }).click()
    await expect(owner.getByRole('heading', { name: 'Participants (1)' })).toBeVisible()
    await owner.getByRole('button', { name: 'Leave room' }).click()
  } finally { await first.close(); await second.close() }
})

test('raw tokens require room context; malformed and unauthorized invitations are rejected', async ({ browser, baseURL }) => {
  const first = await browser.newContext(); const second = await browser.newContext()
  try {
    await frontend(first, baseURL!); await frontend(second, baseURL!)
    const owner = await first.newPage(); const guest = await second.newPage()
    const { viewer } = await create(owner, baseURL!)
    await guest.goto(new URL('/rooms', baseURL!).href)
    await expect(guest.getByRole('button', { name: 'Join room', exact: true })).toBeDisabled()
    await guest.getByLabel('Invitation link').fill(viewer.get('invite')!)
    await expect(guest.getByRole('button', { name: 'Join room', exact: true })).toBeDisabled()
    await guest.getByLabel('Room ID', { exact: true }).fill(viewer.get('room')!)
    await expect(guest.getByRole('button', { name: 'Join room', exact: true })).toBeEnabled()
    await guest.getByLabel('Invitation link').fill('malformed')
    await expect(guest.getByRole('button', { name: 'Join room', exact: true })).toBeDisabled()
    await guest.getByLabel('Invitation link').fill('C'.repeat(43))
    await guest.getByRole('button', { name: 'Join room', exact: true }).click()
    await expect(guest.getByRole('alert')).toHaveText('Room invitation is invalid or expired')
    await guest.getByLabel('Invitation link').fill(viewer.get('invite')!)
    await join(guest, false)
    await expect(owner.getByRole('heading', { name: 'Participants (2)' })).toBeVisible()
    await guest.getByRole('button', { name: 'Leave room' }).click()
    await owner.getByRole('button', { name: 'Leave room' }).click()
  } finally { await first.close(); await second.close() }
})

test('query publisher keys remain explicit and raw tokens cannot inherit them', async ({ browser, baseURL }) => {
  const first = await browser.newContext(); const second = await browser.newContext()
  try {
    await frontend(first, baseURL!); await frontend(second, baseURL!)
    const owner = await first.newPage(); const guest = await second.newPage()
    const { publisher, viewer } = await create(owner, baseURL!)
    const query = new URL(baseURL!); query.search = publisher.toString()
    await guest.goto(query.href)
    await join(guest, true)
    await expect(guest.getByRole('button', { name: 'Start sharing' })).toBeEnabled()
    await guest.getByRole('button', { name: 'Leave room' }).click()
    await expect(owner.getByRole('heading', { name: 'Participants (1)' })).toBeVisible()
    await guest.getByLabel('Invitation link').fill(viewer.get('invite')!)
    await join(guest, false)
    await expect(guest.getByRole('button', { name: 'Start sharing' })).toHaveCount(0)
    await expect(guest.getByLabel('Screen publisher invitation')).toHaveCount(0)
    await guest.getByRole('button', { name: 'Leave room' }).click()
    await owner.getByRole('button', { name: 'Leave room' }).click()
  } finally { await first.close(); await second.close() }
})
