import { test, expect, type BrowserContext, type Page, type WebSocketRoute } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { fixtureAudio, testGame } from './fixture-audio'
import { generatedCapture } from './generated-capture'

const sink = process.env.PLAYER_AUDIO_TEST_SINK
const toggle = (page: Page) => page.getByRole('checkbox', { name: 'Share audio' })
const dock = (page: Page) => page.locator('.audio-action')
const selector = (page: Page) => page.getByRole('combobox', { name: /Game audio/ })
const share = (page: Page) => page.getByRole('button', { name: 'Start sharing', exact: true }).click()

type GraphNode = { type: string; info?: { props?: Record<string, string | number> } }
function nodes(): GraphNode[] {
  return JSON.parse(execFileSync('pw-dump', { encoding: 'utf8', timeout: 3000 }))
}
function taps(serials: number[]) {
  return nodes()
    .filter((n) => String(n.info?.props?.['node.name'] || '').startsWith('whiterun-capture-'))
    .map((n) => Number(n.info?.props?.['target.object']))
    .filter((serial) => serials.includes(serial))
}

test('automatic native audio follows screen consent, live source identity, reconnection and teardown', async ({
  browser,
  baseURL,
}) => {
  test.skip(!sink, 'Set PLAYER_AUDIO_TEST_SINK to exercise real PipeWire and LiveKit')
  test.setTimeout(120000)
  const prefix = 'player-game-' + process.pid + '-'
  const contexts: BrowserContext[] = []
  const games: ReturnType<typeof testGame>[] = []
  const ids: number[] = []
  const sockets: { client: WebSocketRoute; server: WebSocketRoute }[] = []
  async function participant() {
    const context = await browser.newContext()
    contexts.push(context)
    await generatedCapture(context)
    await fixtureAudio(context, prefix)
    const page = await context.newPage()
    await page.goto(baseURL!)
    await expect(page.locator('.connection')).toHaveText('Connected')
    return page
  }
  async function playGame(label: string, hz: number) {
    const fixture = testGame(prefix + label, hz, sink!)
    games.push(fixture)
    const serial = () =>
      Number(
        nodes().find((n) => n.type.endsWith(':Node') && n.info?.props?.['node.name'] === fixture.name)?.info
          ?.props?.['object.serial'],
      )
    await expect.poll(serial).toBeGreaterThan(0)
    const id = serial()
    ids.push(id)
    return { ...fixture, id }
  }
  const onlyTap = (id?: number) => expect.poll(() => taps(ids)).toEqual(id ? [id] : [])
  async function openMenu(page: Page) {
    if ((await dock(page).getAttribute('aria-expanded')) === 'false') await dock(page).click()
  }
  async function choose(page: Page, name: string) {
    const opt = selector(page).locator('option').filter({ hasText: name })
    await expect(opt).toHaveCount(1)
    await selector(page).selectOption(await opt.getAttribute('value'))
  }
  try {
    const listener = await participant()
    const owner = await participant()
    await expect(toggle(owner)).toBeChecked()
    await share(owner)
    await expect(dock(owner)).toHaveText('Waiting for audio source')
    await expect(listener.getByRole('article')).toHaveCount(1)
    await expect(listener.locator('audio')).toHaveCount(0)

    const a = await playGame('one', 500)
    await expect(dock(owner)).toHaveText('Choose audio source')
    await onlyTap()
    await owner.getByRole('button', { name: /Allow audio · .*one/ }).click()
    await expect(dock(owner)).toHaveText('Sharing audio')
    await onlyTap(a.id)
    await expect(listener.locator('audio')).toHaveCount(1)
    if (await listener.getByRole('button', { name: 'Enable audio' }).isVisible())
      await listener.getByRole('button', { name: 'Enable audio' }).click()
    const b = await playGame('two', 1000)
    await openMenu(owner)
    await owner.getByRole('button', { name: /Allow audio · .*two/ }).click()
    await expect.poll(() => taps(ids).sort((l, r) => l - r)).toEqual([a.id, b.id].sort((l, r) => l - r))
    await expect(listener.locator('audio')).toHaveCount(1)
    // Sample the received LiveKit track before output gain; do not connect a
    // second renderer to the physical headset.
    await listener.bringToFront()
    await listener.getByRole('button', { name: 'Audio', exact: true }).click()
    const spectrum = await listener.evaluate(async () => {
      const element = document.querySelector('audio')!
      const ctx = new AudioContext()
      try {
        await ctx.resume()
        const input = ctx.createMediaStreamSource(element.srcObject as MediaStream)
        const meter = ctx.createAnalyser()
        meter.fftSize = 8192
        meter.smoothingTimeConstant = 0
        input.connect(meter)
        const data = new Float32Array(meter.frequencyBinCount)
        let levels = [-Infinity, -Infinity]
        for (let attempt = 0; attempt < 25; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 120))
          meter.getFloatFrequencyData(data)
          levels = [500, 1000].map((hz) => {
            const bin = Math.round((hz * meter.fftSize) / ctx.sampleRate)
            return Math.max(...data.slice(bin - 2, bin + 3))
          })
          if (levels.every((db) => db > -65)) break
        }
        return levels
      } finally {
        await ctx.close()
      }
    })
    expect(spectrum.every((db) => db > -65)).toBe(true)
    console.log(
      'Received two-source mix, 500 Hz and 1000 Hz dBFS',
      spectrum.map((db) => db.toFixed(1)),
    )
    await owner.getByRole('button', { name: /Revoke .*one/ }).click()
    await choose(owner, b.name)
    await onlyTap(b.id)
    await expect(dock(owner)).toHaveText('Sharing audio')
    await toggle(owner).uncheck()
    await onlyTap()
    await expect(listener.locator('audio')).toHaveCount(0)
    await expect(listener.getByRole('article')).toHaveCount(1)
    await toggle(owner).check()
    await onlyTap(b.id)
    await expect(dock(owner)).toHaveText('Sharing audio')

    // Intercept only the next connection. The page being refreshed must
    // be able to send its real leave event on its original signaling socket.
    await owner.routeWebSocket('ws://127.0.0.1:*/**', (client) => {
      sockets.push({ client, server: client.connectToServer() })
    })
    await owner.reload()
    await expect(owner.locator('.connection')).toHaveText('Connected')
    await onlyTap()
    await expect(listener.getByRole('article')).toHaveCount(0)
    // The saved exact stream must win even in the unfiltered workstation graph.
    await owner.evaluate(() => {
      window.__fullAudioRegistry = true
    })
    await share(owner)
    await onlyTap(b.id)
    await expect(dock(owner)).toHaveText('Sharing audio')
    await owner.evaluate(() => {
      window.__fullAudioRegistry = false
    })
    const before = sockets.length
    await sockets[before - 1].client.close({ code: 1012, reason: 'Player audio reconnect test' })
    await sockets[before - 1].server.close({ code: 1012 })
    await expect.poll(() => sockets.length).toBeGreaterThan(before)
    await expect(owner.locator('.connection')).toHaveText('Connected')
    await expect(dock(owner)).toHaveText('Sharing audio')
    await onlyTap(b.id)
    expect(await owner.evaluate(() => window.__screenTest.calls)).toBe(1)

    await b.stop()
    await expect(dock(owner)).toHaveText('Choose audio source')
    await onlyTap()
    const replacement = await playGame('two', 1000)
    expect(replacement.id).not.toBe(b.id)
    await expect(selector(owner).locator('option').filter({ hasText: replacement.name })).toHaveCount(1)
    await onlyTap()
    await choose(owner, replacement.name)
    await onlyTap(replacement.id)
    await owner.context().close()
    // Playwright's signaling proxy can outlive its page. Model the upstream
    // connection dropping too while the SFU processes its reconnect grace.
    for (const socket of sockets) await socket.server.close().catch(() => {})
    await onlyTap()
    await expect(listener.locator('audio')).toHaveCount(0)

    const fresh = await participant()
    await share(fresh)
    await expect(dock(fresh)).toHaveText('Choose audio source')
    await expect(selector(fresh)).toBeVisible()
    await onlyTap()
    await choose(fresh, a.name)
    await onlyTap(a.id)
    await expect(dock(fresh)).toHaveText('Sharing audio')
    const title = await fresh.getByRole('article', { name: /\(you\)$/ }).getAttribute('aria-label')
    const remote = listener.getByRole('article', { name: title!.replace(' (you)', ''), exact: true })
    await expect(remote).toHaveCount(1)
    await fresh.getByRole('button', { name: 'Stop sharing', exact: true }).click()
    await onlyTap()
    await expect(remote).toHaveCount(0)
    await expect(listener.locator('audio')).toHaveCount(0)
  } finally {
    for (const socket of sockets) await socket.server.close().catch(() => {})
    await Promise.all(contexts.map((c) => c.close()))
    await Promise.all(games.map((g) => g.stop()))
  }
})
