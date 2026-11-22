import { test, expect, type Page, type WebSocketRoute } from '@playwright/test'
import { generatedCapture } from './generated-capture'

const connected = (page: Page) => expect(page.locator('.connection')).toHaveText('Connected')
const start = (page: Page) => page.getByRole('button', { name: 'Start sharing', exact: true }).click()
const tiles = (page: Page) => page.getByRole('article')

test('local entry requires a same-origin browser session and capture waits for consent', async ({
  browser,
  request,
  baseURL,
}) => {
  const context = await browser.newContext()
  await generatedCapture(context)
  const page = await context.newPage()
  const lists: string[] = []
  page.on('request', (req) => {
    if (req.url().endsWith('/player/sources')) lists.push(req.url())
  })
  const url = baseURL!
  try {
    const headers = { Origin: url, 'Sec-Fetch-Site': 'same-origin' }
    expect((await request.post(url + '/player/join', { headers, data: {} })).status()).toBe(403)
    expect((await request.post(url + '/api/local/join', { data: {} })).status()).toBe(403)
    await page.goto(url)
    await connected(page)
    await expect(page.getByRole('button', { name: /join|create room/i })).toHaveCount(0)
    await expect(page.getByRole('textbox')).toHaveCount(0)
    expect(await page.evaluate(() => window.__screenTest.calls)).toBe(0)
    expect(lists).toHaveLength(0)
    const cookie = (await context.cookies()).find((c) => c.name === 'whiterun_player')
    expect(cookie?.httpOnly).toBe(true)
    expect(cookie?.sameSite).toBe('Strict')
    for (const extra of [{ Origin: 'http://elsewhere.invalid' }, { 'X-Forwarded-Host': 'localhost:5173' }]) {
      const denied = await context.request.post(url + '/player/join', {
        headers: { ...headers, ...extra },
        data: {},
      })
      expect(denied.status()).toBe(403)
    }
    await page.evaluate(() => {
      window.__screenTest.denied = true
    })
    await expect(page.getByRole('checkbox', { name: 'Share audio' })).toBeChecked()
    await start(page)
    await expect(page.getByRole('alert')).toContainText('denied or cancelled')
    await expect(page.getByRole('article', { name: /\(you\)$/ })).toHaveCount(0)
    await page.getByRole('button', { name: 'Audio', exact: true }).click()
    await expect(
      page.getByRole('region', { name: 'Audio controls' }).getByRole('checkbox', { name: 'Share audio' }),
    ).toBeChecked()
    expect(lists).toHaveLength(0)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: 'Audio', exact: true })).toBeFocused()
    await page.reload()
    await connected(page)
    expect(await page.evaluate(() => window.__screenTest.calls)).toBe(0)
    await expect(page.getByRole('button', { name: 'Start sharing' })).toBeEnabled()
  } finally {
    await context.close()
  }
})

test('three local players share, focus, reconnect, refresh and release the screen', async ({
  browser,
  baseURL,
}) => {
  const contexts = await Promise.all(
    [1, 2, 3].map(() => browser.newContext({ viewport: { width: 1280, height: 720 } })),
  )
  const sockets: { client: WebSocketRoute; server: WebSocketRoute }[] = []
  try {
    const pages = await Promise.all(
      contexts.map(async (c) => {
        await generatedCapture(c)
        return c.newPage()
      }),
    )
    const [alice, bob, third] = pages
    const audioRequests: string[] = []
    for (const page of pages)
      page.on('request', (req) => {
        if (/\/player\/(sources|start)$/.test(req.url())) audioRequests.push(req.url())
      })
    await alice.routeWebSocket('ws://127.0.0.1:*/**', (client) => {
      sockets.push({ client, server: client.connectToServer() })
    })
    await Promise.all(
      pages.map(async (p) => {
        await p.goto(baseURL!)
        await connected(p)
      }),
    )
    // This layout exercise shares only synthetic video, never host applications.
    for (const p of pages) await p.getByRole('checkbox', { name: 'Share audio' }).uncheck()
    await start(alice)
    await expect(tiles(alice)).toHaveCount(1)
    expect((await tiles(alice).first().boundingBox())!.width).toBe(1280)
    await start(bob)
    await expect(tiles(alice)).toHaveCount(2)
    const boxes = await Promise.all((await tiles(alice).all()).map((tile) => tile.boundingBox()))
    expect(boxes[0]!.y).toBe(boxes[1]!.y)
    expect(boxes[0]!.width).toBeLessThan(650)
    await alice.setViewportSize({ width: 390, height: 844 })
    const mobile = await Promise.all((await tiles(alice).all()).map((tile) => tile.boundingBox()))
    expect(mobile[0]!.y).toBe(mobile[1]!.y)
    expect(mobile[0]!.width).toBeLessThan(200)
    await alice.setViewportSize({ width: 1280, height: 720 })
    await start(third)
    await expect(tiles(alice)).toHaveCount(3)
    await alice.bringToFront()
    await expect
      .poll(() =>
        alice
          .locator('video')
          .evaluateAll((els) => els.filter((v) => v.readyState >= 2 && v.videoWidth > 0).length),
      )
      .toBe(3)
    await alice
      .getByRole('button', { name: /^Focus / })
      .last()
      .click()
    await expect(tiles(alice)).toHaveCount(1)
    const switcher = alice.getByRole('combobox', {name:'Focused screen'})
    const beforeFocus = await tiles(alice).getAttribute('data-track-sid')
    await alice.getByRole('button',{name:'Toggle fullscreen'}).click()
    await switcher.selectOption({index:1})
    await expect(tiles(alice)).not.toHaveAttribute('data-track-sid',beforeFocus!)
    await expect.poll(()=>alice.evaluate(()=>Boolean(document.fullscreenElement))).toBe(true)
    await alice.evaluate(()=>document.exitFullscreen())
    await alice.getByRole('button', { name: 'Back to grid' }).click()
    await expect(tiles(alice)).toHaveCount(3)
    await alice.getByRole('button', { name: 'Toggle fullscreen' }).click()
    await expect.poll(() => alice.evaluate(() => Boolean(document.fullscreenElement))).toBe(true)
    await alice.evaluate(() => document.exitFullscreen())
    const before = sockets.length
    const active = sockets[before - 1]
    await active.client.close({ code: 1012, reason: 'Player reconnect test' })
    await active.server.close({ code: 1012 })
    await expect.poll(() => sockets.length).toBeGreaterThan(before)
    await connected(alice)
    await expect(tiles(alice)).toHaveCount(3)
    expect(await alice.evaluate(() => window.__screenTest.calls)).toBe(1)
    await bob.reload()
    await connected(bob)
    await expect(tiles(alice)).toHaveCount(2)
    expect(await bob.evaluate(() => window.__screenTest.calls)).toBe(0)
    await third.getByRole('button', { name: 'Stop sharing' }).click()
    await expect(tiles(alice)).toHaveCount(1)
    await alice.getByRole('button', { name: 'Stop sharing' }).click()
    await expect(tiles(bob)).toHaveCount(0)
    expect(audioRequests).toEqual([])
    expect(
      await alice.evaluate(() =>
        window.__screenTest.streams.every((s) => s.getTracks().every((t) => t.readyState === 'ended')),
      ),
    ).toBe(true)
  } finally {
    for (const socket of sockets) await socket.server.close().catch(() => {})
    await Promise.all(contexts.map((c) => c.close()))
  }
})

test('initial gateway interruption retries local entry without prompting for capture', async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext()
  await generatedCapture(context)
  const page = await context.newPage()
  let attempts = 0
  try {
    await page.route('**/player/join', (route) => {
      attempts++
      return attempts === 1
        ? route.fulfill({ status: 503, body: 'temporarily unavailable' })
        : route.continue()
    })
    await page.goto(baseURL!)
    await connected(page)
    expect(attempts).toBe(2)
    expect(await page.evaluate(() => window.__screenTest.calls)).toBe(0)
  } finally {
    await context.close()
  }
})

test('four simultaneous screen slots admit viewers and recover after departure', async ({ browser, baseURL }) => {
  test.setTimeout(160000)
  const contexts = await Promise.all(Array.from({ length: 6 }, () => browser.newContext()))
  async function enter(index: number) {
    await generatedCapture(contexts[index])
    const page = await contexts[index].newPage()
    await page.goto(baseURL!)
    await connected(page)
    await page.getByRole('checkbox', { name: 'Share audio' }).uncheck()
    return page
  }
  try {
    const pages = await Promise.all([0,1,2,3,4].map(enter))
    for (const p of pages.slice(0,3)) {
      await start(p)
      await expect(p.getByRole('button', { name: 'Stop sharing' })).toBeVisible()
    }
    await Promise.all(pages.slice(3).map(p => expect(tiles(p)).toHaveCount(3)))
    // Both participants must enter the real SFU publication path before a
    // fourth screen can become visible and trigger the player's UX precheck.
    let approvals = 0
    let ready!: () => void
    const barrier = new Promise<void>(resolve => { ready = resolve })
    for (const p of pages.slice(3)) {
      await p.exposeFunction('releasePicker', async () => {
        if (++approvals === 2) ready()
        await barrier
      })
      await p.evaluate(() => {
        const capture = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices)
        navigator.mediaDevices.getDisplayMedia = async options => {
          await (window as unknown as { releasePicker(): Promise<void> }).releasePicker()
          return capture(options)
        }
      })
    }
    await Promise.all(pages.slice(3).map(start))
    await expect(tiles(pages[0])).toHaveCount(4)
    const viewer = await enter(5)
    await expect(tiles(viewer)).toHaveCount(4)
    await viewer.bringToFront()
    await expect.poll(() => viewer.locator('video').evaluateAll(v => v.filter(e => e.videoWidth > 0 && e.readyState >= 2).length)).toBe(4)
    const boxes = await Promise.all((await tiles(viewer).all()).map(el => el.boundingBox()))
    expect(new Set(boxes.map(b => b!.x)).size).toBe(2)
    expect(new Set(boxes.map(b => b!.y)).size).toBe(2)
    const loser = (await pages[3].getByRole('button', { name: 'Stop sharing' }).isVisible()) ? pages[4] : pages[3]
    await expect(loser.getByRole('alert')).toContainText('All four screens', {timeout: 20000})
    expect(await loser.evaluate(() => window.__screenTest.streams.every(s => s.getTracks().every(t => t.readyState === 'ended')))).toBe(true)
    await contexts[0].close()
    await expect(tiles(loser)).toHaveCount(3, {timeout: 95000})
    await start(loser)
    await expect(tiles(viewer)).toHaveCount(4)
    expect(await viewer.evaluate(() => window.__screenTest.calls)).toBe(0)
    for (const p of pages.slice(1)) await p.getByRole('button', { name: 'Stop sharing' }).click()
    await expect(tiles(viewer)).toHaveCount(0)
  } finally {
    await Promise.all(contexts.map(c => c.close()))
  }
})
