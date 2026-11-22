import { test, expect, type BrowserContext, type Page, type WebSocketRoute, firefox } from '@playwright/test'
import { readFileSync } from 'node:fs'

import { generatedCapture } from './generated-capture'

function key() { return process.env.E2E_OPERATOR_KEY || readFileSync(new URL('../../.env', import.meta.url), 'utf8').match(/^LOCAL_ADMIN_KEY=(.+)$/m)?.[1] || '' }
async function create(page: Page, baseURL: string, name: string) {
  await page.goto(new URL('/rooms', baseURL).href)
  await page.getByLabel('Display name').fill(name)
  await page.getByLabel('Room title', { exact: true }).fill('Screen transport validation')
  await page.getByLabel('Local operator key').fill(key())
  await page.getByRole('button', { name: 'Create and join room' }).click()
  await expect(page.getByRole('heading', { name: 'Participants (1)' })).toBeVisible()
}
async function decoded(page: Page, count: number) {
  await expect(page.getByRole('article')).toHaveCount(count)
  await page.bringToFront()
  // Adaptive stream intentionally pauses offscreen tiles; validate visible playback.
  await page.locator('.stream-grid').scrollIntoViewIfNeeded()
  try { await expect.poll(() => page.locator('.stream-grid video').evaluateAll(elements => elements.filter(element => {
    const video = element as HTMLVideoElement & { __validationFrames?: number }
    if (video.__validationFrames === undefined && video.requestVideoFrameCallback) {
      video.__validationFrames = 0
      const frame = () => { video.__validationFrames!++; video.requestVideoFrameCallback(frame) }
      video.requestVideoFrameCallback(frame)
    }
    return video.readyState >= 2 && video.videoWidth > 0 && (video.__validationFrames ?? video.getVideoPlaybackQuality().totalVideoFrames) > 1
  }).length), { timeout: 30000 }).toBe(count) } catch (error) {
    console.log('Playback diagnostic', await page.locator('.stream-grid video').evaluateAll(elements => ({ visibility: document.visibilityState, videos: elements.map(element => {
      const v = element as HTMLVideoElement
      return { width: v.videoWidth, height: v.videoHeight, readyState: v.readyState, paused: v.paused, time: v.currentTime, frames: (v as HTMLVideoElement & { __validationFrames?: number }).__validationFrames, qualityFrames: v.getVideoPlaybackQuality().totalVideoFrames, tracks: (v.srcObject as MediaStream | null)?.getTracks().map(t => ({ kind: t.kind, state: t.readyState, muted: t.muted })) }
    }) })))
    throw error
  }
}

test('generated video through real SFU: two publishers, reconnect, fullscreen, stop, and departure', async ({ browser, baseURL, browserName }) => {
  const first = await browser.newContext()
  const remoteBrowser = process.env.E2E_REMOTE_BROWSER === 'firefox' ? await firefox.launch({ headless: true }) : null
  const second = await (remoteBrowser || browser).newContext()
  await generatedCapture(first); await generatedCapture(second)
  const alice = await first.newPage(); const bob = await second.newPage()
  const sockets: { client: WebSocketRoute; server: WebSocketRoute }[] = []
  await bob.routeWebSocket('ws://127.0.0.1:*/**', async client => {
    if (sockets.length) await new Promise(resolve => setTimeout(resolve, 800))
    sockets.push({ client, server: client.connectToServer() })
  })
  try {
    await create(alice, baseURL!, 'Alice media')
    const publisher = await alice.getByLabel('Screen publisher invitation').inputValue()
    const viewer = await alice.getByLabel('Share invitation').inputValue()
    await bob.goto(publisher)
    await bob.getByLabel('Display name').fill('Bob media')
    await bob.getByRole('button', { name: 'Join room', exact: true }).click()
    await expect(bob.getByRole('heading', { name: 'Participants (2)' })).toBeVisible()
    expect(await alice.evaluate(() => window.__screenTest.calls)).toBe(0)
    expect(await bob.evaluate(() => window.__screenTest.calls)).toBe(0)
    await alice.getByRole('button', { name: 'Start sharing' }).click()
    await decoded(alice, 1); await decoded(bob, 1)
    await bob.getByRole('button', { name: 'Start sharing' }).click()
    await decoded(alice, 2); await decoded(bob, 2)
    const before = sockets.length
    const active = sockets[sockets.length - 1]
    await active.client.close({ code: 1012, reason: 'Media reconnect test' }); await active.server.close({ code: 1012 })
    await expect.poll(() => sockets.length).toBeGreaterThan(before)
    await expect(bob.getByText('Connection:', { exact: false })).toHaveText('Connection: connected')
    await decoded(alice, 2); await decoded(bob, 2)
    await alice.bringToFront()
    await alice.locator('.stream-grid').scrollIntoViewIfNeeded()
    const remote = alice.getByLabel('Bob media screen video', { exact: true })
    const frames = await remote.evaluate(element => (element as HTMLVideoElement & { __validationFrames?: number }).__validationFrames ?? 0)
    await expect.poll(() => remote.evaluate(element => (element as HTMLVideoElement & { __validationFrames?: number }).__validationFrames ?? 0)).toBeGreaterThan(frames)
    expect(await bob.evaluate(() => window.__screenTest.calls)).toBe(1)
    const remoteTile = alice.getByRole('article', { name: 'Bob media screen', exact: true })
    await remoteTile.getByText('Runtime diagnostics', { exact: true }).click()
    await remote.scrollIntoViewIfNeeded()
    const fpsMetric = remoteTile.getByText('Decoded FPS', { exact: true }).locator('..').locator('dd')
    await expect.poll(async () => Number(await fpsMetric.textContent())).toBeGreaterThan(0)
    await expect(remoteTile.getByText('video/VP8', { exact: true })).toBeVisible()
    console.log('Measured inbound diagnostics', await remoteTile.locator('dl').innerText())
    await remoteTile.getByText('Runtime diagnostics', { exact: true }).click()
    await alice.getByRole('button', { name: 'Fullscreen Bob media' }).click()
    await expect.poll(() => alice.evaluate(() => document.fullscreenElement?.getAttribute('aria-label'))).toBe('Bob media screen')
    const fullscreenFrames = await remote.evaluate(element => (element as HTMLVideoElement & { __validationFrames?: number }).__validationFrames ?? 0)
    await expect.poll(() => remote.evaluate(element => (element as HTMLVideoElement & { __validationFrames?: number }).__validationFrames ?? 0)).toBeGreaterThan(fullscreenFrames)
    await alice.evaluate(() => document.exitFullscreen())
    await decoded(alice, 2)
    // Real IntersectionObserver adaptation: offscreen pause and visible recovery.
    await alice.evaluate(() => { const spacer = document.createElement('div'); spacer.id = 'validation-scroll-space'; spacer.style.height = '3000px'; document.body.append(spacer); window.scrollTo(0, document.body.scrollHeight) })
    await expect(remoteTile.getByText('Adaptive pause', { exact: true })).toBeVisible()
    await alice.evaluate(() => document.getElementById('validation-scroll-space')?.remove())
    await decoded(alice, 2)
    await expect(remoteTile.getByText('Streaming', { exact: true })).toBeVisible()
    console.log('Generated-video evidence', JSON.stringify({ browser: browserName, remoteBrowser: remoteBrowser ? 'firefox' : browserName,
      capture: await alice.evaluate(() => { const { width, height, frameRate } = window.__screenTest.streams[0].getVideoTracks()[0].getSettings(); return { width, height, frameRate } }),
      decoded: await alice.locator('.stream-grid video').evaluateAll(elements => elements.map(element => {
        const video = element as HTMLVideoElement
        return { width: video.videoWidth, height: video.videoHeight, presentedCallbacks: (video as HTMLVideoElement & { __validationFrames?: number }).__validationFrames }
      })) }))
    await alice.evaluate(() => window.__screenTest.endLatest())
    await decoded(alice, 1); await decoded(bob, 1)
    await expect(alice.getByRole('button', { name: 'Start sharing' })).toBeEnabled()
    await alice.getByRole('button', { name: 'Start sharing' }).click()
    await decoded(alice, 2); await decoded(bob, 2)
    await bob.getByRole('button', { name: 'Leave room' }).click()
    await decoded(alice, 1)
    expect(await bob.evaluate(() => window.__screenTest.streams.every(stream => stream.getTracks().every(track => track.readyState === 'ended')))).toBe(true)
    await bob.getByLabel('Invitation link').fill(viewer)
    await bob.getByRole('button', { name: 'Join room', exact: true }).click()
    await expect(bob.getByText(/Viewer mode/)).toBeVisible()
    await expect(bob.getByRole('button', { name: 'Start sharing' })).toHaveCount(0)
    await decoded(bob, 1)
    await alice.getByRole('button', { name: 'Stop sharing' }).click()
    await expect(alice.getByRole('article')).toHaveCount(0); await expect(bob.getByRole('article')).toHaveCount(0)
    expect(await alice.evaluate(() => window.__screenTest.requested.every(options => options.audio === false))).toBe(true)
    expect(await alice.evaluate(() => window.__screenTest.streams.every(stream => stream.getTracks().every(track => track.readyState === 'ended')))).toBe(true)
    await alice.getByRole('button', { name: 'Leave room' }).click()
    await bob.getByRole('button', { name: 'Leave room' }).click()
  } finally {
    for (const socket of sockets) await socket.server.close().catch(() => {})
    await first.close(); await second.close(); await remoteBrowser?.close()
  }
})

test('mocked capture permission rejection in a real browser leaves no stream', async ({ browser, baseURL }) => {
  const context = await browser.newContext(); await generatedCapture(context)
  try {
    const page = await context.newPage(); await create(page, baseURL!, 'Permission test')
    await page.evaluate(() => { window.__screenTest.denied = true })
    await page.getByRole('button', { name: 'Start sharing' }).click()
    await expect(page.getByRole('alert')).toContainText('denied or cancelled')
    await expect(page.getByRole('article')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Start sharing' })).toBeEnabled()
    await page.getByRole('button', { name: 'Leave room' }).click()
  } finally { await context.close() }
})
