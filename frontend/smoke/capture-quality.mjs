// Disposable local tab capture. The optional offer probe stops before ICE or signaling.
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import { installImageSample, scoreImage } from './frame-fidelity.mjs'
import { chromium } from 'playwright'

const codecs = { vp8: 'vp8', vp9: 'vp09.00.41.08', h264: 'avc1.42E02A', av1: 'av01.0.09M.08' }
const flags = new Set(process.argv.slice(2))
const option = (name, fallback) => [...flags].find(s => s.startsWith('--' + name + '='))?.split('=')[1] ?? fallback
const codec = option('codec', 'vp8')
const hint = option('hint', '')
const acceleration = option('acceleration', 'no-preference')
const counts = option('count', 'both') === 'both' ? [1, 2] : [Number(option('count'))]
if (!(Object.hasOwn(codecs, codec) || codec === 'capture') || !counts.every(n => [1, 2].includes(n)) ||
    !['', 'detail', 'motion'].includes(hint) || !['no-preference', 'prefer-software', 'prefer-hardware'].includes(acceleration))
  throw Error('Invalid benchmark options')

const fidelity = flags.has('--fidelity')
if (fidelity && (codec === 'capture' || counts.length !== 1 || counts[0] !== 1)) throw Error('Use --fidelity with --count=1 and a codec')
const fixture = {
  workload: flags.has('--text') ? 'desktop text' : 'moving overlay', fullscreen: flags.has('--fullscreen'), hint,
  config: { codec: codecs[codec], width: 1920, height: 1080, framerate: 60, bitrate: 8_000_000,
    latencyMode: 'realtime', contentHint: hint, hardwareAcceleration: acceleration,
    ...(fidelity && codec === 'h264' && { avc: { format: 'annexb' } }) },
}
const browser = await chromium.launch({ channel: 'chromium', args: ['--auto-accept-this-tab-capture', '--mute-audio',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] })
try {
  const cdp = await browser.newBrowserCDPSession()
  const { gpu } = await cdp.send('SystemInfo.getInfo')
  const environment = { browser: browser.version(), renderer: gpu.auxAttributes.glRenderer,
    videoEncode: gpu.featureStatus.video_encode, hardwareProfiles: gpu.videoEncoding.map(p => p.profile) }
  for (const count of counts) {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } })
    try {
      await context.route('**/*', route => route.fulfill({ contentType: 'text/html',
        body: '<title>Screen Share quality fixture</title><style>*{margin:0}body{background:#eee;color:#123}main{columns:4;font:16px monospace}i{pointer-events:none;position:fixed;width:20%;height:100%;background:#3479ae80;top:0}</style><button>Measure</button><main></main><i></i>' }))
      const pages = await Promise.all(Array.from({ length: count }, () => context.newPage()))
      for (const page of pages) await page.goto('https://capture.invalid/')
      if (flags.has('--probe')) {
        const codecModule = new URL('../src/videoCodec.ts', import.meta.url)
        await pages[0].route('**/videoCodec.js', async route => route.fulfill({
          contentType: 'text/javascript', body: stripTypeScriptTypes(await readFile(codecModule, 'utf8')),
        }))
        const support = await pages[0].evaluate(async configs => {
          const results = []
          for (const config of configs) {
            const tested = await VideoEncoder.isConfigSupported(config)
            results.push({ codec: config.codec, acceleration: config.hardwareAcceleration, supported: tested.supported,
              recognizesHint: 'contentHint' in tested.config })
          }
          // Inspect the player's actual offer policy before any ICE or signaling.
          const { configureVideoCodec } = await import('/videoCodec.js')
          const offers = []
          for (const preference of ['browser', 'auto', 'H264', 'VP8', 'VP9', 'AV1']) {
            const pc = new RTCPeerConnection({ iceServers: [] })
            try {
              const tx = pc.addTransceiver('video', { direction: 'sendonly', sendEncodings: [{ maxFramerate: 60 }] })
              await configureVideoCodec(tx, preference, { width: 1920, height: 1080, frameRate: 60 }, 60)
              const { sdp } = await pc.createOffer()
              const first = sdp.split('\r\n').find(l => l.startsWith('m=video ')).split(' ')[3]
              const encoding = sdp.split('\r\n').find(l => l.startsWith('a=rtpmap:' + first + ' ')).split(' ')[1]
              offers.push({ preference, firstCodec: encoding.split('/')[0], encodings: tx.sender.getParameters().encodings.length })
            } finally { pc.close() }
          }
          return { webCodecs: results, offers, rtp: [...new Set(RTCRtpSender.getCapabilities('video').codecs.map(c => c.mimeType))] }
        }, Object.values(codecs).flatMap(codec => ['prefer-hardware', 'prefer-software', 'no-preference']
          .map(hardwareAcceleration => ({ ...fixture.config, codec, hardwareAcceleration }))))
        console.log(JSON.stringify({ ...environment, ...support }))
        break
      }
      if (codec !== 'capture' && !await pages[0].evaluate(async config => (await VideoEncoder.isConfigSupported(config)).supported, fixture.config)) {
        console.log(JSON.stringify({ ...environment, codec, acceleration, supported: false }))
        break
      }
      if (fidelity) await pages[0].evaluate(installImageSample)
      for (const page of pages) await page.evaluate(({ workload, config, hint, fullscreen }) => {
        document.querySelector('main').textContent = 'Screen Share 1080p detail 0123456789 '.repeat(1200)
        const bar = document.querySelector('i')
        function paint(time) {
          bar.style.left = Math.round(800 + 800 * Math.sin(time / 800)) + 'px'
          requestAnimationFrame(paint)
        }
        if (workload === 'moving overlay') requestAnimationFrame(paint)
        else setInterval(() => { bar.textContent = String(Math.floor(performance.now() / 1000)) }, 1000)
        document.querySelector('button').onclick = () => {
          window.ready = (async () => {
            if (fullscreen) await document.documentElement.requestFullscreen()
            const stream = await navigator.mediaDevices.getDisplayMedia({
              preferCurrentTab: true, video: { frameRate: { ideal: 60, max: 60 } }, audio: false,
            })
            const track = stream.getVideoTracks()[0]
            const { displaySurface, width, height } = track.getSettings()
            if (displaySurface !== 'browser' || stream.getAudioTracks().length || width !== config.width || height !== config.height)
              throw Error('Unexpected capture settings')
            track.contentHint = hint
            const reader = new MediaStreamTrackProcessor({ track }).readable.getReader()
            window.measure = async ({ startEpoch, traceIndex }) => {
              const start = startEpoch - performance.timeOrigin
              if (traceIndex !== undefined) {
                setTimeout(() => performance.mark('fixture-publisher-' + traceIndex), start - performance.now())
              }
              const end = start + 30000
              const timer = setTimeout(() => void reader.cancel(), end - performance.now())
              let captured = 0, encoded = 0, bytes = 0, keys = 0, skipped = 0
              let previousSource, previousOutput, encodedWidth, encodedHeight, encoderError
              const pending = new Map()
              const latency = [], captureGaps = [], outputGaps = []
              const encoder = config.codec ? new VideoEncoder({
                output: (chunk, metadata) => {
                  window.imageSample?.output(chunk)
                  if (metadata.decoderConfig) {
                    encodedWidth = metadata.decoderConfig.codedWidth
                    encodedHeight = metadata.decoderConfig.codedHeight
                  }
                  const enqueued = pending.get(chunk.timestamp)
                  if (enqueued === undefined) return
                  pending.delete(chunk.timestamp)
                  const now = performance.now()
                  latency.push(now - enqueued)
                  if (previousOutput !== undefined) outputGaps.push(now - previousOutput)
                  previousOutput = now
                  encoded++
                  bytes += chunk.byteLength
                  keys += Number(chunk.type === 'key')
                }, error: err => { encoderError = err },
              }) : undefined
              const p95 = list => list.sort((a, b) => a - b)[Math.floor(.95 * list.length)]
              try {
                encoder?.configure(config)
                for (;;) {
                  const { done, value: frame } = await reader.read()
                  if (done) break
                  try {
                    if (encoderError) throw encoderError
                    const now = performance.now()
                    if (now >= end) break
                    const measuring = now >= start
                    if (measuring) {
                      captured++
                      if (previousSource !== undefined) captureGaps.push((frame.timestamp - previousSource) / 1000)
                      previousSource = frame.timestamp
                    }
                    if (encoder && encoder.encodeQueueSize < 2) {
                      if (measuring) pending.set(frame.timestamp, now)
                      encoder.encode(frame, { keyFrame: measuring && window.imageSample?.input(frame) })
                    } else if (encoder && measuring) skipped++
                  } finally { frame.close() }
                }
                await encoder?.flush()
                if (encoderError) throw encoderError
                return { width, height, captureFps: captured / 30, captureGapP95Ms: p95(captureGaps),
                  ...(encoder && { encodedWidth, encodedHeight, encodedFps: encoded / 30, keys, skipped,
                    inputsWithoutOutput: captured - skipped - encoded, kbps: bytes * 8 / 30000,
                    enqueueToOutputMeanMs: latency.length ? latency.reduce((a, b) => a + b, 0) / latency.length : undefined,
                    enqueueToOutputMaxMs: latency.length ? Math.max(...latency) : undefined, outputGapP95Ms: p95(outputGaps) }) }
              } finally {
                clearTimeout(timer)
                track.stop()
                if (encoder && encoder.state !== 'closed') encoder.close()
              }
            }
          })()
        }
      }, fixture)
      await Promise.all(pages.map(page => page.getByRole('button').click()))
      await Promise.all(pages.map(page => page.evaluate(() => window.ready)))
      const trace = flags.has('--trace')
      const events = []
      const onTrace = ({ value }) => {
        for (const event of value) {
          if (event.name.startsWith('fixture-publisher-') ||
              (event.ph === 'X' && ['vpx_codec_encode', 'OpenH264::EncodeFrame', 'aom_codec_encode'].includes(event.name))) {
            events.push({ name: event.name, pid: event.pid, ts: event.ts, dur: event.dur })
          }
        }
      }
      if (trace) {
        cdp.on('Tracing.dataCollected', onTrace)
        await cdp.send('Tracing.start', { categories: 'media,blink.user_timing', transferMode: 'ReportEvents' })
      }
      const start = Date.now() + 3000
      const until = epoch => delay(Math.max(0, epoch - Date.now()))
      const cpu = async () => (await cdp.send('SystemInfo.getProcessInfo')).processInfo
      const cpuByProcess = new Map()
      const measureCpu = async () => {
        await until(start)
        const before = await cpu()
        const t = performance.now()
        await until(start + 30000)
        const after = await cpu()
        const seconds = (performance.now() - t) / 1000
        const cores = {}
        for (const proc of after) {
          const old = before.find(p => p.id === proc.id && p.type === proc.type)
          if (!old) continue
          const used = (proc.cpuTime - old.cpuTime) / seconds
          cores[proc.type] = (cores[proc.type] ?? 0) + used
          cpuByProcess.set(proc.id, used)
        }
        return cores
      }
      const [results, browserCpuCores] = await Promise.all([
        Promise.all(pages.map((page, i) => page.evaluate(options => window.measure(options),
          { startEpoch: start, traceIndex: trace ? i : undefined }))), measureCpu(),
      ])
      if (trace) {
        const done = new Promise(resolve => cdp.once('Tracing.tracingComplete', resolve))
        await cdp.send('Tracing.end')
        const { dataLossOccurred } = await done
        cdp.off('Tracing.dataCollected', onTrace)
        const marks = events.filter(e => e.name.startsWith('fixture-publisher-'))
        results.forEach((r, i) => {
          const mark = marks.find(e => e.name === 'fixture-publisher-' + i)
          if (dataLossOccurred || !mark || marks.filter(m => m.pid === mark.pid).length !== 1) return
          r.rendererCpuCores = cpuByProcess.get(mark.pid)
          const calls = events.filter(e => e.dur !== undefined && e.pid === mark.pid &&
            !e.name.startsWith('fixture-') && e.ts >= mark.ts && e.ts < mark.ts + 30_000_000)
          if (calls.length) r.codecTrace = { name: calls[0].name, calls: calls.length,
            meanMs: calls.reduce((n, e) => n + e.dur, 0) / calls.length / 1000,
            maxMs: Math.max(...calls.map(e => e.dur)) / 1000 }
        })
      }
      let textCrop
      if (fidelity) {
        const sample = await pages[0].evaluate(() => window.imageSample.finish())
        textCrop = await scoreImage(codec, sample, fixture.config.width, fixture.config.height)
      }
      console.log(JSON.stringify({ ...environment, textCrop, workload: fixture.workload, fullscreenSource: fixture.fullscreen, seconds: 30,
        codec, acceleration, hint, count, targetKbps: codec !== 'capture' ? 8000 : undefined, browserCpuCores, results }))
    } finally { await context.close() }
  }
} finally { await browser.close() }
