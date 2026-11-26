// Run against a production player build on disk. All requests are intercepted.
// Media and signaling are fixtures. No capture, decoder, playback or RTC transport.
import { chromium } from 'playwright'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import assert from 'node:assert/strict'

const profile = process.argv[2] === '--profile-source'
const build = profile ? await mkdtemp(resolve(tmpdir(), 'screen-share-profile-')) : resolve(process.argv[2] ?? 'dist/screen-share-player')
if (profile) {
  const { build: compile } = await import('vite')
  const root = resolve(process.argv[3] ?? 'frontend')
  await compile({ root, logLevel: 'error', build: { outDir: build }, plugins: [{
    name: 'count-fixture-video-renders', enforce: 'pre',
    transform(code, id) {
      if (!id.endsWith('/src/CloudflareStage.tsx')) return
      const marker = 'const element = useRef<HTMLVideoElement>(null)'
      if (code.split(marker).length !== 2) throw Error('Cannot locate video component')
      return code.replace(marker, 'window.counts.renders++; ' + marker)
    },
  }] })
}
const browser = await chromium.launch({ channel: 'chromium', args: ['--mute-audio'] })
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
  page.on('pageerror', error => console.error(error.message))
  await page.route('**/*', async route => {
    const path = new URL(route.request().url()).pathname
    if (path.startsWith('/assets/')) return route.fulfill({ path: resolve(build, 'assets', basename(path)) })
    if (path.startsWith('/r/')) return route.fulfill({ body: await readFile(resolve(build, 'index.html')), contentType: 'text/html' })
    return route.abort()
  })
  await page.addInitScript(() => {
    const tracks = new WeakMap()
    const requests = { peers: 0, subscriptions: 0, assignments: 0, plays: 0, pauses: 0, renders: 0 }
    window.counts = requests
    // Store object identity without ever connecting a MediaStream to a real sink.
    Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
      get() { return tracks.get(this) },
      set(v) { tracks.set(this, v); if (v) requests.assignments++ },
    })
    HTMLMediaElement.prototype.play = async () => { requests.plays++ }
    HTMLMediaElement.prototype.pause = () => { requests.pauses++ }
    window.MediaStream = class { constructor(tracks) { this.getTracks = () => tracks } }
    class FixturePeer extends EventTarget {
      constructor() { super(); requests.peers++ }
      iceGatheringState = 'complete'
      connectionState = 'new'
      async setRemoteDescription() {
        this.track = { kind: 'video', readyState: 'live', stop() {} }
        this.ontrack({ track: this.track })
      }
      getTransceivers() { return [{ receiver: { track: this.track } }] }
      async createAnswer() { return { type: 'answer', sdp: 'fixture' } }
      async setLocalDescription(d) { this.localDescription = d; this.connectionState = 'connected'; this.onconnectionstatechange() }
      close() { this.connectionState = 'closed' }
    }
    let poll = 0
    const screens = ['first', 'second']
    window.fetch = async (path, options) => {
      const op = String(path).split('/').pop()
      if (op === 'join') {
        window.RTCPeerConnection = FixturePeer
        return Response.json({ transport: 'cloudflare-prototype', identity: 'fixture', canPublish: false,
        serverTime: new Date(), expiresAt: new Date(Date.now() + 600000) })
      }
      if (op === 'state') {
        if (poll++) await new Promise(r => setTimeout(r, 2500))
        return Response.json({ publications: screens, owned: screens, version: String(poll) })
      }
      if (op === 'subscribe') {
        requests.subscriptions++
        return Response.json({ handle: JSON.parse(options.body).publication, sdp: 'fixture' })
      }
      if (op === 'answer' || op === 'close') return Response.json({})
      throw Error('Unexpected fixture request')
    }
  })
  await page.goto('https://player.invalid/r/' + 'a'.repeat(32))
  const focus = page.getByRole('button', { name: 'Focus screen 1' })
  await focus.waitFor({ timeout: 5000 }).catch(async error => {
    throw new Error((await page.locator('body').innerText()) + ' ' + JSON.stringify(await page.evaluate(() => window.counts)), { cause: error })
  })
  assert.equal(await page.locator('video').count(), 2)
  await page.evaluate(() => { window.originalTiles = [...document.querySelectorAll('video')] })
  const start = performance.now()
  const markers = []
  for (let i = 0; i < 6; i++) {
    await delay(Math.max(0, start + i * 5000 - performance.now()))
    if (i % 2 === 0) await focus.click()
    else await page.getByRole('button', { name: 'Back to grid' }).click()
    if (i === 2 || i === 4) await page.getByRole('button', { name: 'Fullscreen' }).click()
    markers.push(await page.evaluate(() => ({
      fullscreen: !!document.fullscreenElement, autoplayElements: [...document.querySelectorAll('video')].filter(v => v.autoplay).length,
    })))
  }
  await delay(Math.max(0, start + 30000 - performance.now()))
  const result = await page.evaluate(() => ({
    ...window.counts, sameElements: [...document.querySelectorAll('video')].every((v, i) => v === window.originalTiles[i]),
  }))
  assert.equal(result.peers, 2)
  assert.equal(result.subscriptions, 2)
  assert.equal(result.assignments, 2)
  assert.equal(result.sameElements, true)
  if (profile) assert.ok(result.renders >= 2)
  else delete result.renders
  assert.deepEqual(markers.map(m => m.fullscreen), [false, false, true, true, false, false])
  console.log(JSON.stringify({ browser: browser.version(), seconds: (performance.now() - start) / 1000, ...result, markers }))
} finally {
  await browser.close()
  if (profile) await rm(build, { recursive: true, force: true })
}
