// Offline capture/encoder benchmark. The disposable browser contains only the
// generated test tabs. No microphone, output device, RTP peer or SFU is used.
import { chromium } from 'playwright'

const workload = process.argv.includes('--text') ? 'desktop text' : 'moving overlay'
const browser = await chromium.launch({ channel: 'chromium', args: ['--auto-accept-this-tab-capture', '--mute-audio',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] })
try {
  for (const count of [1, 2]) {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } })
    try {
      await context.route('**/*', route => route.fulfill({ contentType: 'text/html',
        body: '<title>Screen Share quality fixture</title><style>*{margin:0}body{background:#eee;color:#123}main{columns:4;font:16px monospace}i{pointer-events:none;position:fixed;width:20%;height:100%;background:#3479ae80;top:0}</style><button>Measure</button><main></main><i></i>' }))
      const pages = await Promise.all(Array.from({ length: count }, () => context.newPage()))
      for (const page of pages) {
        await page.goto('https://capture.invalid/')
        await page.evaluate(workload => {
          document.querySelector('main').textContent = 'Screen Share 1080p detail 0123456789 '.repeat(1200)
          const bar = document.querySelector('i')
          function paint(time) {
            bar.style.left = Math.round(800 + 800 * Math.sin(time / 800)) + 'px'
            requestAnimationFrame(paint)
          }
          if (workload === 'moving overlay') requestAnimationFrame(paint)
          else setInterval(() => { bar.textContent = String(Math.floor(performance.now() / 1000)) }, 1000)
          document.querySelector('button').onclick = () => {
            window.measurement = (async () => {
              const stream = await navigator.mediaDevices.getDisplayMedia({
                preferCurrentTab: true, video: { frameRate: { ideal: 60, max: 60 } }, audio: false,
              })
              const track = stream.getVideoTracks()[0]
              const { displaySurface, width, height } = track.getSettings()
              if (displaySurface !== 'browser' || stream.getAudioTracks().length) throw Error('Unexpected test surface')
              const reader = new MediaStreamTrackProcessor({ track }).readable.getReader()
              let encoded = 0, bytes = 0, keys = 0, captured = 0, skipped = 0, encoderError
              const intervals = []
              let firstMeasuredTimestamp = Infinity
              let previous
              const encoder = new VideoEncoder({
                output: chunk => {
                  if (chunk.timestamp < firstMeasuredTimestamp) return
                  encoded++
                  bytes += chunk.byteLength
                  keys += Number(chunk.type === 'key')
                },
                error: err => { encoderError = err },
              })
              // Fixed benchmark conditions. The production sender uses WebRTC congestion control.
              encoder.configure({ codec: 'vp8', width, height, framerate: 60, bitrate: 8000000, latencyMode: 'realtime' })
              const start = performance.now() + 3000
              const timer = setTimeout(() => void reader.cancel(), 33000)
              try {
                for (;;) {
                  const { done, value: frame } = await reader.read()
                  if (done) break
                  try {
                    const measuring = performance.now() >= start
                    if (measuring) {
                      firstMeasuredTimestamp = Math.min(firstMeasuredTimestamp, frame.timestamp)
                      captured++
                      if (previous !== undefined) intervals.push((frame.timestamp - previous) / 1000)
                      previous = frame.timestamp
                    }
                    if (encoderError) throw encoderError
                    if (encoder.encodeQueueSize < 2) encoder.encode(frame)
                    else if (measuring) skipped++
                  } finally { frame.close() }
                }
                const seconds = (performance.now() - start) / 1000
                await encoder.flush()
                intervals.sort((a, b) => a - b)
                return { displaySurface, width, height, seconds, captured, encoded, keys, skipped,
                  captureFps: captured / seconds, encodeFps: encoded / seconds, kbps: bytes * 8 / seconds / 1000,
                  captureGapP95Ms: intervals[Math.floor(.95 * intervals.length)] }
              } finally {
                clearTimeout(timer)
                track.stop()
                if (encoder.state !== 'closed') encoder.close()
              }
            })()
          }
        }, workload)
      }
      await Promise.all(pages.map(page => page.getByText('Measure', { exact: true }).click()))
      const results = await Promise.all(pages.map(page => page.evaluate(() => window.measurement)))
      console.log(JSON.stringify({ browser: browser.version(), workload, capturePipelines: count, results }))
    } finally { await context.close() }
  }
} finally { await browser.close() }
