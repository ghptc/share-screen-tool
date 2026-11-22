import { test, expect } from '@playwright/test'
import { generatedCapture } from './generated-capture'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'
import WebSocket from 'ws'
import { SignalResponse } from '@livekit/protocol'
import { fixtureAudio, testGame } from './fixture-audio'

test('Discord identity, live discovery, room isolation and voice departure over the protected SFU', async ({
  browser,
  request,
  baseURL,
}) => {
  test.skip(!process.env.DISCORD_FIXTURE_KEY, 'Requires private Discord fixture')
  const fixture = process.env.DISCORD_FIXTURE_URL ?? 'http://127.0.0.1:18091'
  const headers = { Authorization: 'Bearer ' + process.env.DISCORD_FIXTURE_KEY }
  async function state(User: string, Guild: string, Channel: string, Online = true) {
    expect(
      (
        await request.post(fixture + '/scenario', { headers, data: { User, Guild, Channel, Online } })
      ).status(),
    ).toBe(204)
  }
  async function link() {
    const r = await request.get(fixture + '/live', { headers })
    return (await r.text()).replace('Watch or share: ', '')
  }
  const a = await browser.newContext(),
    b = await browser.newContext(),
    wrong = await browser.newContext()
  const gameName = 'discord-test-' + process.pid
  const game = process.env.PLAYER_AUDIO_TEST_SINK
    ? testGame(gameName, 600, process.env.PLAYER_AUDIO_TEST_SINK)
    : null
  function captureLinks() {
    const nodes = JSON.parse(execFileSync('pw-dump', { encoding: 'utf8' })) as {
      info?: { props?: Record<string, string | number> }
    }[]
    const serial = nodes.find((n) => n.info?.props?.['node.name'] === gameName)?.info?.props?.[
      'object.serial'
    ]
    return nodes.filter(
      (n) =>
        String(n.info?.props?.['node.name']).startsWith('whiterun-capture-') &&
        n.info?.props?.['target.object'] === serial,
    ).length
  }
  try {
    await state('1001', '2001', '3001')
    const url = await link()
    expect(await link()).toBe(url)
    expect(new URL(url).pathname).toMatch(/^\/r\/[A-Za-z0-9_-]{32}$/)
    const ref = new URL(url).pathname.slice(3)
    expect(
      (
        await request.post(baseURL + '/api/discord/' + ref + '/join', {
          headers: { Origin: baseURL! },
          data: {},
        })
      ).status(),
    ).toBe(401)
    await generatedCapture(a)
    await fixtureAudio(a, 'discord-test-')
    const alice = await a.newPage()
    const signalURLs: string[] = []
    alice.on('websocket', (s) => signalURLs.push(s.url()))
    await alice.goto(url)
    await expect(alice.locator('.connection')).toHaveText('Connected')
    await expect(alice.getByRole('article')).toHaveCount(0)
    expect(await alice.evaluate(() => window.__screenTest.calls)).toBe(0)
    if (!game) await alice.getByLabel('Share audio', { exact: true }).uncheck()
    await alice.getByRole('button', { name: 'Start sharing' }).click()
    await expect(alice.getByRole('button', { name: 'Stop sharing' })).toBeVisible()
    if (game) await expect.poll(captureLinks).toBe(1)
    await state('1002', '2001', '3001')
    await generatedCapture(b)
    const bob = await b.newPage()
    await bob.goto(url)
    await expect(bob.getByRole('article')).toHaveCount(1)
    await expect
      .poll(() => bob.locator('video').evaluate((v: HTMLVideoElement) => v.videoWidth))
      .toBeGreaterThan(0)
    await state('1003', '2002', '3001')
    expect(await link()).not.toBe(url)
    const copied = await wrong.newPage()
    await copied.goto(url)
    await expect(copied.getByRole('alert')).toContainText('Discord voice channel')
    expect(await copied.locator('video').count()).toBe(0)
    await state('1001', '2001', '3002')
    await expect(bob.getByRole('article')).toHaveCount(0)
    if (game) await expect.poll(captureLinks).toBe(0)
    await expect(alice.getByRole('alert')).toContainText('Discord voice channel')
    expect(
      await alice.evaluate(() =>
        window.__screenTest.streams.every((s) => s.getTracks().every((t) => t.readyState === 'ended')),
      ),
    ).toBe(true)
    await state('1002', '2001', '')
    await expect(bob.getByRole('alert')).toContainText('Discord voice channel')
    const signals = signalURLs.filter((s) => s.includes('/rtc'))
    expect(signals.length).toBeGreaterThan(0)
    expect(signals.every((s) => new URL(s).searchParams.get('access_token') === 'session')).toBe(true)
  } finally {
    await game?.stop()
    await Promise.all([a, b, wrong].map((c) => c.close()))
    await state('1001', '2001', '3001')
  }
})

test('original and SFU-refreshed audio grants expire at the voice authorization boundary', async ({
  browser,
  request,
}) => {
  test.skip(!process.env.DISCORD_FIXTURE_KEY, 'Requires private Discord fixture')
  const fixture = process.env.DISCORD_FIXTURE_URL ?? 'http://127.0.0.1:18091'
  const headers = { Authorization: 'Bearer ' + process.env.DISCORD_FIXTURE_KEY }
  async function move(Channel: string) {
    expect(
      (
        await request.post(fixture + '/scenario', {
          headers,
          data: { User: '1004', Guild: '2001', Channel, Online: true },
        })
      ).status(),
    ).toBe(204)
  }
  await move('3001')
  const url = (await (await request.get(fixture + '/live', { headers })).text()).replace(
    'Watch or share: ',
    '',
  )
  const origin = new URL(url).origin
  const ctx = await browser.newContext()
  let socket: WebSocket | undefined
  try {
    await generatedCapture(ctx)
    const page = await ctx.newPage()
    const joined = page.waitForResponse((r) => r.url().endsWith('/join') && r.status() === 200)
    await page.goto(url)
    await expect(page.locator('.connection')).toHaveText('Connected')
    const { nativeAudioControl } = await (await joined).json()
    await page.getByLabel('Share audio', { exact: true }).uncheck()
    await page.getByRole('button', { name: 'Start sharing' }).click()
    const tile = page.getByRole('article', { name: /\(you\)$/ })
    await expect(tile).toBeVisible()
    const screen = await tile.getAttribute('data-track-sid')
    // Use the real, one-time helper session and authenticated owner watch.
    const pair = await page.evaluate(
      async ({ screen, control }) => {
        const headers = { Authorization: 'Bearer ' + control, 'Content-Type': 'application/json' }
        const res = await fetch('/api/native-audio/sessions', {
          method: 'POST',
          headers,
          body: JSON.stringify({ screen }),
        })
        const pair = await res.json()
        const watch = await fetch('/api/native-audio/' + pair.session + '/watch', {
          method: 'POST',
          headers,
          body: '{}',
        })
        if (!watch.ok) throw new Error('Owner watch failed')
        void watch.text().catch(() => {})
        return pair
      },
      { screen, control: nativeAudioControl },
    )
    const claim = await request.post(origin + '/api/native-audio/claim', {
      data: { code: pair.code, localOnly: true },
    })
    expect(claim.status()).toBe(200)
    const { token, serverUrl } = await claim.json()
    const validate = (grant: string) =>
      request.get(serverUrl.replace(/^ws/, 'http') + '/rtc/validate', {
        headers: { Authorization: 'Bearer ' + grant },
      })
    expect((await validate(token)).status()).toBe(200)
    socket = new WebSocket(serverUrl + '/rtc?protocol=16&auto_subscribe=0', {
      headers: { Authorization: 'Bearer ' + token },
    })
    const refreshed = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('SFU refresh missing')), 5000)
      socket!.on('message', (data: Buffer) => {
        const response = SignalResponse.fromBinary(data)
        if (response.message.case === 'refreshToken') {
          clearTimeout(timer)
          resolve(response.message.value)
        }
      })
      socket!.once('error', reject)
    })
    expect(refreshed !== token && refreshed.split('.').length === 3).toBe(true)
    expect((await validate(refreshed)).status()).toBe(200)
    await move('3002')
    for (const grant of [token, refreshed]) {
      await expect.poll(async () => (await validate(grant)).status()).toBe(403)
      const rejected = await new Promise<number>((resolve, reject) => {
        const ws = new WebSocket(serverUrl + '/rtc?protocol=16&reconnect=1', {
          headers: { Authorization: 'Bearer ' + grant },
        })
        ws.once('unexpected-response', (_, res) => {
          res.resume()
          resolve(res.statusCode || 0)
          ws.terminate()
        })
        ws.once('open', () => {
          ws.close()
          reject(new Error('Revoked credential reconnected'))
        })
        ws.on('error', () => {})
      })
      expect(rejected).toBe(403)
    }
    await expect.poll(() => socket!.readyState).toBe(WebSocket.CLOSED)
  } finally {
    socket?.terminate()
    await ctx.close()
    await move('3001')
  }
})

test('protected room serializes explicit publisher upgrades and clears abandoned reservations', async ({
  browser,
  request,
}) => {
  test.skip(!process.env.DISCORD_FIXTURE_KEY, 'Requires private Discord fixture')
  test.setTimeout(100000)
  const fixture = process.env.DISCORD_FIXTURE_URL ?? 'http://127.0.0.1:18091'
  const headers = { Authorization: 'Bearer ' + process.env.DISCORD_FIXTURE_KEY }
  async function gateway(online: boolean) {
    const res = await request.post(fixture + '/scenario', {
      headers,
      data: { User: '1005', Guild: '2001', Channel: '3002', Online: online },
    })
    expect(res.status()).toBe(204)
  }
  await gateway(true)
  const url = (await (await request.get(fixture + '/live', { headers })).text()).replace(
    'Watch or share: ',
    '',
  )
  const path = '/api/discord/' + new URL(url).pathname.slice(3)
  const contexts = await Promise.all(Array.from({ length: 6 }, () => browser.newContext()))
  try {
    const watchers = await Promise.all(
      contexts.map(async (c) => {
        const page = await c.newPage()
        const joined = page.waitForResponse((r) => r.url().endsWith('/join') && r.ok())
        await page.goto(url)
        await expect(page.locator('.connection')).toHaveText('Connected')
        const { nativeAudioControl } = await (await joined).json()
        return { page, control: nativeAudioControl as string }
      }),
    )
    const viewer = watchers[5].page
    await viewer.addScriptTag({ path: resolve('node_modules/livekit-client/dist/livekit-client.umd.js') })
    const viewerResult = await viewer.evaluate(async (path) => {
      const sdk = (window as unknown as { LivekitClient: typeof import('livekit-client') }).LivekitClient
      const join = await fetch(path + '/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      const credentials = await join.json()
      const room = new sdk.Room()
      await room.connect(credentials.serverUrl, credentials.token)
      const track = document.createElement('canvas').captureStream(1).getVideoTracks()[0]
      try {
        const allowed = room.localParticipant.permissions?.canPublish
        try {
          await room.localParticipant.publishTrack(track, { source: sdk.Track.Source.ScreenShare })
          return { allowed, rejected: false }
        } catch {
          return { allowed, rejected: room.localParticipant.videoTrackPublications.size === 0 }
        }
      } finally {
        track.stop()
        await room.disconnect()
      }
    }, path)
    expect(viewerResult).toEqual({ allowed: false, rejected: true })
    const upgrade = (index: number) =>
      watchers[index].page.evaluate(
        async ({ path, control }) =>
          (
            await fetch(path + '/publish', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + control },
              body: '{}',
            })
          ).status,
        { path, control: watchers[index].control },
      )
    // The workstation API permits a burst of 20 requests at five per second.
    // Let the separate rate-limit bucket refill after the OAuth/login burst so
    // these simultaneous requests exercise room capacity.
    await new Promise((resolve) => setTimeout(resolve, 4000))
    const statuses = await Promise.all([0, 1, 2, 3, 4].map(upgrade))
    expect(statuses.sort()).toEqual([200, 200, 200, 200, 409])
    const five = await Promise.all(Array.from({ length: 5 }, () => upgrade(5)))
    expect(five).toEqual([409, 409, 409, 409, 409])
    // None of the reservations above published media. Reconciliation must
    // demote those participants and free a slot while they remain connected.
    await expect.poll(() => upgrade(5), { timeout: 32000, intervals: [1500] }).toBe(200)
    await gateway(false)
    await expect(watchers[0].page.getByRole('alert')).toContainText('Discord voice channel')
    await gateway(true)
    await watchers[0].page.reload()
    await expect(watchers[0].page.locator('.connection')).toHaveText('Connected')
  } finally {
    await Promise.all(contexts.map((c) => c.close()))
    await gateway(true)
  }
})

test('restarting the authorization backend disconnects media and requires fresh OAuth for the same link', async ({
  browser,
  request,
}) => {
  const project = process.env.DISCORD_TEST_PROJECT ?? ''
  test.skip(
    !process.env.DISCORD_FIXTURE_KEY || !/^whiterun-(channel-validation|audio-test-\d+)$/.test(project),
    'Requires disposable Compose project',
  )
  const fixture = process.env.DISCORD_FIXTURE_URL ?? 'http://127.0.0.1:18091'
  const headers = { Authorization: 'Bearer ' + process.env.DISCORD_FIXTURE_KEY }
  expect(
    (
      await request.post(fixture + '/scenario', {
        headers,
        data: { User: '1006', Guild: '2001', Channel: '3001', Online: true },
      })
    ).status(),
  ).toBe(204)
  const link = async () =>
    (await (await request.get(fixture + '/live', { headers })).text()).replace('Watch or share: ', '')
  const url = await link()
  const ctx = await browser.newContext()
  try {
    const page = await ctx.newPage()
    const joined = page.waitForResponse((r) => r.url().endsWith('/join') && r.ok())
    await page.goto(url)
    const old = await (await joined).json()
    await expect(page.locator('.connection')).toHaveText('Connected')
    const oldState = await ctx.storageState()
    const nextLogin = page.waitForRequest((r) => r.url().includes('/api/discord/auth/'))
    const nextJoin = page.waitForResponse((r) => r.url().endsWith('/join') && r.ok())
    await promisify(execFile)('docker', ['compose', '-p', project, 'restart', 'backend'])
    await nextLogin
    const renewed = await (await nextJoin).json()
    expect(renewed.identity).not.toBe(old.identity)
    await expect(page.locator('.connection')).toHaveText('Connected')
    expect(await link()).toBe(url)
    const stale = await browser.newContext({ storageState: oldState })
    try {
      const origin = new URL(url).origin
      const ref = new URL(url).pathname.slice(3)
      expect(
        (
          await stale.request.post(origin + '/api/discord/' + ref + '/join', {
            headers: { Origin: origin },
            data: {},
          })
        ).status(),
      ).toBe(401)
    } finally {
      await stale.close()
    }
  } finally {
    await ctx.close()
  }
})
