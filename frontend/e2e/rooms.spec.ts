import { test, expect, type WebSocketRoute } from '@playwright/test'
import { readFileSync } from 'node:fs'

function operatorKey() {
  if (process.env.E2E_OPERATOR_KEY) return process.env.E2E_OPERATOR_KEY
  // Local-only convenience; never print the operator key or credential payloads.
  return readFileSync(new URL('../../.env', import.meta.url), 'utf8').match(/^LOCAL_ADMIN_KEY=(.+)$/m)?.[1] || ''
}

test('two independent sessions: authorized joins, presence, departure, and rejoin', async ({ browser, baseURL, request }) => {
  const first = await browser.newContext()
  const second = await browser.newContext()
  try {
    const alice = await first.newPage()
    const bob = await second.newPage()
    const pageErrors: string[] = []
    alice.on('pageerror', e => pageErrors.push(e.message))
    bob.on('pageerror', e => pageErrors.push(e.message))
    await alice.goto(new URL('/rooms', baseURL!).href)
    await alice.getByLabel('Display name').fill('Alice browser')
    await alice.getByLabel('Room title', { exact: true }).fill('Browser validation room')
    await alice.getByLabel('Local operator key').fill(operatorKey())
    await alice.getByRole('button', { name: 'Create and join room' }).click()
    await expect(alice.getByRole('heading', { name: 'Participants (1)' })).toBeVisible()
    await expect(alice.getByText('Alice browser (you)', { exact: true })).toBeVisible()
    const link = await alice.getByLabel('Share invitation').inputValue()
    const params = new URLSearchParams(new URL(link).hash.slice(1))
    const id = params.get('room')!
    const createDenied = await request.post('/api/rooms', { data: { title: 'Unauthorized room' } })
    expect(createDenied.status()).toBe(401)
    const missing = await request.post(`/api/rooms/${id}/join`, { data: { displayName: 'Intruder' } })
    expect(missing.status()).toBe(403)
    const incorrect = await request.post(`/api/rooms/${id}/join`, { data: { displayName: 'Intruder', invite: 'wrong' } })
    expect(incorrect.status()).toBe(403)
    const arbitrary = await request.post('/api/rooms/arbitrary/join', { data: { displayName: 'Intruder', invite: params.get('invite') } })
    expect(arbitrary.status()).toBe(403)
    await bob.goto(link)
    await bob.getByLabel('Display name').fill('Bob browser')
    await bob.getByRole('button', { name: 'Join room', exact: true }).click()
    await expect(bob.getByRole('heading', { name: 'Participants (2)' })).toBeVisible()
    await expect(alice.getByRole('heading', { name: 'Participants (2)' })).toBeVisible()
    await expect(bob.getByText('Alice browser', { exact: true })).toBeVisible()
    await expect(alice.getByText('Bob browser', { exact: true })).toBeVisible()
    await bob.getByRole('button', { name: 'Leave room' }).click()
    await expect(alice.getByRole('heading', { name: 'Participants (1)' })).toBeVisible()
    await expect(bob.getByText(/You left the room/)).toBeVisible()
    await bob.getByRole('button', { name: 'Join room', exact: true }).click()
    await expect(alice.getByRole('heading', { name: 'Participants (2)' })).toBeVisible()
    await expect(bob.getByRole('heading', { name: 'Participants (2)' })).toBeVisible()
    // Model an interactive tab close so the SDK's page-leave handler can run.
    // Playwright's default close skips unload and instead models abrupt loss.
    await bob.close({ runBeforeUnload: true })
    await expect(alice.getByRole('heading', { name: 'Participants (1)' })).toBeVisible()
    expect(pageErrors).toEqual([])
    await alice.getByRole('button', { name: 'Leave room' }).click()
  } finally { await first.close(); await second.close() }
})

test('an invalid invitation is rejected in the browser', async ({ page, baseURL }) => {
  await page.goto(`${baseURL}/#room=${'A'.repeat(24)}&invite=${'B'.repeat(43)}`)
  await page.getByLabel('Display name').fill('Unauthorized guest')
  await page.getByRole('button', { name: 'Join room', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveText('Room invitation is invalid or expired')
  await expect(page.getByRole('heading', { name: /^Participants/ })).toHaveCount(0)
})


test('real signaling interruption reconnects automatically', async ({ page, baseURL }) => {
  const sockets: { client: WebSocketRoute; server: WebSocketRoute }[] = []
  await page.routeWebSocket('ws://127.0.0.1:*/**', async client => {
    if (sockets.length > 0) await new Promise(resolve => setTimeout(resolve, 800))
    sockets.push({ client, server: client.connectToServer() })
  })
  try {
    await page.goto(new URL('/rooms', baseURL!).href)
    await page.getByLabel('Display name').fill('Reconnect guest')
    await page.getByLabel('Room title', { exact: true }).fill('Reconnect validation room')
    await page.getByLabel('Local operator key').fill(operatorKey())
    await page.getByRole('button', { name: 'Create and join room' }).click()
    await expect(page.getByRole('heading', { name: 'Participants (1)' })).toBeVisible()
    expect(sockets.length).toBeGreaterThan(0)
    const before = sockets.length
    const active = sockets[sockets.length - 1]
    await active.client.close({ code: 1012, reason: 'Local signaling interruption test' })
    await active.server.close({ code: 1012 })
    await expect.poll(() => sockets.length).toBeGreaterThan(before)
    await expect(page.getByText('Connection:', { exact: false })).toHaveText('Connection: connected')
    await expect(page.getByRole('heading', { name: 'Participants (1)' })).toBeVisible()
    await page.getByRole('button', { name: 'Leave room' }).click()
  } finally {
    for (const socket of sockets) await socket.server.close().catch(() => {})
  }
})
