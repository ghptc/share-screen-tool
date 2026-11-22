// TestTwoBrowserMedia starts a TLS loopback origin and passes short-lived app
// sessions over stdin. Only aggregate playback measurements go to stdout.
import { chromium, firefox } from 'playwright'
import { readFileSync } from 'node:fs'

const { origin, ref, cookies, hosted, withAudio, browserTag } = JSON.parse(readFileSync(0, 'utf8'))
const engine = process.env.E2E_BROWSER === 'firefox' ? firefox : chromium
let browser
let stage = 'launch'

async function measure(page, i) {
  const deadline = Date.now() + 16000
  while (Date.now() < deadline) {
    const result = await page.evaluate(async (i) => {
      const video = document.querySelector('[aria-label="Remote screen"] video')
      if (video?.videoWidth !== 320 || video.videoHeight !== 180) return
      const pc = window.testPeers.find(
        (p) =>
          p.connectionState === 'connected' &&
          p
            .getTransceivers()
            .some((t) => t.currentDirection === 'recvonly' && t.receiver.track.kind === 'video'),
      )
      if (!pc) return
      const v = Array.from((await pc.getStats()).values()).find(
        (s) => s.type === 'inbound-rtp' && s.kind === 'video',
      )
      if (!(v?.framesDecoded >= 12) || !v.bytesReceived) return
      const probe = document.createElement('canvas').getContext('2d')
      probe.drawImage(video, 0, 0, 1, 1)
      const [r, , b] = probe.getImageData(0, 0, 1, 1).data
      if (i ? r - b < 100 : b - r < 100) return
      return {
        frames: v.framesDecoded,
        bytes: v.bytesReceived,
        width: video.videoWidth,
        height: video.videoHeight,
      }
    }, i)
    if (result) return result
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw Error('Remote playback timed out')
}

async function measureAudio(page) {
  const player = page.locator('audio')
  await player.waitFor({ state: 'attached', timeout: 25000 })
  // Resume the analyser using a real user gesture on the existing audio menu.
  await page.evaluate(() => {
    const ctx = new AudioContext()
    document.addEventListener(
      'click',
      () => {
        void ctx.resume()
      },
      { once: true },
    )
    const splitter = ctx.createChannelSplitter(2)
    const source = ctx.createMediaStreamSource(document.querySelector('audio').srcObject)
    source.connect(splitter)
    const analysers = [0, 1].map((channel) => {
      const a = ctx.createAnalyser()
      a.fftSize = 2048
      splitter.connect(a, channel)
      return a
    })
    window.testAudio = { ctx, analysers, source, splitter }
  })
  await page.getByRole('button', { name: 'Audio', exact: true }).click()
  const enable = page.getByRole('button', { name: 'Enable audio', exact: true })
  if (await enable.isVisible()) await enable.click()
  let last
  let first
  for (let i = 0; i < 60; i++) {
    last = await page.evaluate(async () => {
      const { ctx, analysers } = window.testAudio
      const levels = analysers.map((a) => {
        const data = new Float32Array(a.frequencyBinCount)
        a.getFloatFrequencyData(data)
        return [750, 1500].map((hz) => {
          const bin = Math.round((hz * a.fftSize) / ctx.sampleRate)
          return Math.round(Math.max(-160, ...data.slice(bin - 1, bin + 2)))
        })
      })
      const pc = window.testPeers.find(
        (p) => p.connectionState === 'connected' && p.getReceivers().some((r) => r.track.kind === 'audio'),
      )
      if (!pc)
        return {
          levels,
          failures: window.testActions.slice(-4),
          peers: window.testPeers.map((p) => p.connectionState),
        }
      const stats = await pc.getStats()
      const audio = Array.from(stats.values()).find(
        (s) => s.type === 'inbound-rtp' && (s.kind === 'audio' || s.mediaType === 'audio'),
      )
      const stream = document.querySelector('audio')
      return {
        levels,
        packets: audio?.packetsReceived,
        bytes: audio?.bytesReceived,
        lost: audio?.packetsLost,
        concealed: audio?.concealedSamples,
        codec: stats.get(audio?.codecId)?.mimeType,
        playing: !stream.paused && stream.currentTime > 0,
      }
    })
    const [[l, r], [l2, r2]] = last.levels
    if (
      last.playing &&
      last.packets >= 20 &&
      last.bytes > 0 &&
      last.codec?.toLowerCase() === 'audio/opus' &&
      l > -70 &&
      r2 > -70 &&
      l - r >= 12 &&
      r2 - l2 >= 12
    ) {
      first ??= { time: Date.now(), packets: last.packets, lost: last.lost, concealed: last.concealed }
      const durationMs = Date.now() - first.time
      if (durationMs >= 2000 && last.packets - first.packets >= 80) {
        await page.evaluate(() => window.testAudio.ctx.close())
        return {
          ...last,
          durationMs,
          intervalPackets: last.packets - first.packets,
          intervalLost: last.lost == null ? null : last.lost - first.lost,
          intervalConcealed: last.concealed == null ? null : last.concealed - first.concealed,
        }
      }
    }
    await page.waitForTimeout(150)
  }
  throw Error('audio measurement ' + JSON.stringify(last))
}

try {
  browser = await engine.launch({
    headless: true,
    chromiumSandbox: true,
    ...(withAudio && {
      ignoreDefaultArgs: ['--mute-audio'],
      env: { ...process.env, PULSE_PROP: 'whiterun.test=' + browserTag },
    }),
  })
  const pages = await Promise.all(
    cookies.map(async (value, i) => {
      const ctx = await browser.newContext({ ignoreHTTPSErrors: true })
      await ctx.addCookies([
        { name: '__Host-wl-session', value, url: origin, secure: true, httpOnly: true, sameSite: 'Strict' },
      ])
      await ctx.addInitScript(
        ({ i, hosted, withAudio }) => {
          localStorage.setItem('whiterun.gameAudio.enabled', withAudio && i === 0 ? 'on' : 'off')
          window.captureCount = 0
          window.testPeers = []
          const Peer = window.RTCPeerConnection
          window.RTCPeerConnection = class extends Peer {
            constructor(config) {
              super(hosted ? config : { iceServers: [] })
              window.testPeers.push(this)
            }
            addTransceiver(track, options) {
              const t = super.addTransceiver(track, {
                ...options,
                sendEncodings: [{ maxBitrate: 160000, maxFramerate: 10 }],
              })
              t.setCodecPreferences(
                RTCRtpSender.getCapabilities('video').codecs.filter(
                  (c) => c.mimeType.toLowerCase() === 'video/vp8',
                ),
              )
              return t
            }
          }
          navigator.mediaDevices.getDisplayMedia = async (constraints) => {
            if (constraints.audio !== false || constraints.video.frameRate.ideal !== 60)
              throw Error('Unexpected capture constraints')
            window.captureCount++
            const canvas = document.createElement('canvas')
            canvas.width = 320
            canvas.height = 180
            const ctx = canvas.getContext('2d')
            let frame = 0
            const paint = () => {
              ctx.fillStyle = i ? '#2020ec' : '#ec2020'
              ctx.fillRect(0, 0, 320, 180)
              ctx.fillStyle = 'white'
              ctx.fillRect(frame++ % 200, 10, 8, 8)
            }
            paint()
            setInterval(paint, 100)
            window.testCapture = canvas.captureStream(10)
            return window.testCapture
          }
        },
        { i, hosted, withAudio },
      )
      const page = await ctx.newPage()
      await page.addInitScript(() => {
        window.testActions = []
        const fn = window.fetch
        window.fetch = async (...args) => {
          const res = await fn(...args)
          if (typeof args[0] === 'string' && res.status >= 400) {
            const op = args[0].split('/').pop()
            window.testActions.push([op, res.status])
          }
          return res
        }
      })
      await page.goto(origin + '/r/' + ref)
      await page.getByRole('button', { name: 'Start sharing' }).waitFor({ timeout: 10000 })
      if (await page.evaluate(() => window.captureCount !== 0)) throw Error('Capture before consent')
      return page
    }),
  )
  stage = 'publish'
  await Promise.all(pages.map((p) => p.getByRole('button', { name: 'Start sharing' }).click()))
  stage = 'remote playback'
  const results = await Promise.all(pages.map(measure))
  let audio
  if (withAudio) {
    stage = 'hosted Opus reception'
    audio = await measureAudio(pages[1])
    if ((await pages[0].locator('audio').count()) !== 0) throw Error('Local audio subscribed')
    console.log('audio-received')
    stage = 'revoke audio while screen remains active'
    await pages[0].getByRole('checkbox', { name: 'Share audio' }).uncheck()
    await pages[1].locator('audio').waitFor({ state: 'detached', timeout: 10000 })
    await pages[1].getByRole('article', { name: 'Remote screen' }).waitFor()
    stage = 'reauthorize stereo audio'
    await pages[0].getByRole('checkbox', { name: 'Share audio' }).check()
    await measureAudio(pages[1])
    console.log('audio-received')
  }
  stage = 'stop'
  await pages[1].getByRole('button', { name: 'Stop sharing' }).click()
  await pages[0]
    .getByRole('article', { name: 'Remote screen' })
    .waitFor({ state: 'detached', timeout: 10000 })
  if (await pages[1].evaluate(() => window.testCapture.getTracks().some((t) => t.readyState !== 'ended')))
    throw Error('Capture remained live')
  stage = 'voice departure'
  // The Go driver delivers the event over the fixture's private voice authority.
  console.log('switch-publisher-channel')
  await pages[0].getByRole('heading', { name: 'Player unavailable' }).waitFor({ timeout: 12000 })
  await pages[1].getByRole('heading', { name: 'No active screens' }).waitFor({ timeout: 10000 })
  if (await pages[0].evaluate(() => window.testCapture.getTracks().some((t) => t.readyState !== 'ended')))
    throw Error('Revoked capture remained live')
  if (withAudio) await pages[1].locator('audio').waitFor({ state: 'detached', timeout: 6000 })
  console.log(
    JSON.stringify({
      audio,
      audioToggle: withAudio,
      browser: engine.name(),
      received: results,
      explicitStop: true,
      voiceDeparture: true,
    }),
  )
} catch (error) {
  console.log(
    'Failure during ' +
      stage +
      (String(error.message).startsWith('audio measurement ') ? ' ' + error.message : ''),
  )
  process.exitCode = 1
} finally {
  await browser?.close()
}
