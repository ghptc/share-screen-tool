import type { BrowserContext } from '@playwright/test'

declare global {
  interface Window { __screenTest: { calls: number; streams: MediaStream[]; denied: boolean; requested: DisplayMediaStreamOptions[]; endLatest: () => void } }
}
export async function generatedCapture(context: BrowserContext, size = { width: 640, height: 360, fps: 15 }) {
  await context.addInitScript((size) => {
    const endings = new WeakMap<MediaStreamTrack, () => void>()
    window.__screenTest = { calls: 0, streams: [], denied: false, requested: [], endLatest() {
      const track = this.streams[this.streams.length - 1].getVideoTracks()[0]
      track.stop(); endings.get(track)?.()
    } }
    if (!navigator.mediaDevices) return
    // Mock only the permission/capture boundary. RTP, encoding, SFU forwarding,
    // decoding, SDK publication/subscription, and DOM video attachment are real.
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { configurable: true, value: async (options: DisplayMediaStreamOptions) => {
      window.__screenTest.calls++; window.__screenTest.requested.push(options)
      if (window.__screenTest.denied) throw new DOMException('Test user denied capture', 'NotAllowedError')
      const canvas = document.createElement('canvas'); canvas.width = size.width; canvas.height = size.height
      const context = canvas.getContext('2d')!
      let frame = 0
      const paint = () => {
        context.fillStyle = `hsl(${frame % 360} 60% 30%)`; context.fillRect(0, 0, 640, 360)
        context.fillStyle = 'white'; context.font = '36px sans-serif'; context.fillText(`Generated frame ${frame++}`, 24, 180)
      }
      paint()
      const timer = window.setInterval(paint, 1000 / size.fps)
      const stream = canvas.captureStream(size.fps)
      const track = stream.getVideoTracks()[0]
      // Firefox ignores untrusted MediaStreamTrack 'ended' dispatches. This is
      // explicitly a mocked native-ended delivery, not a real browser stop button.
      const target: EventTarget = track
      const endedListeners = new Set<EventListenerOrEventListenerObject>()
      const add = target.addEventListener.bind(target)
      const remove = target.removeEventListener.bind(target)
      target.addEventListener = (type, listener, options) => {
        if (type === 'ended' && listener) endedListeners.add(listener)
        add(type, listener, options)
      }
      target.removeEventListener = (type, listener, options) => {
        if (type === 'ended' && listener) endedListeners.delete(listener)
        remove(type, listener, options)
      }
      endings.set(track, () => {
        const event = new Event('ended')
        for (const listener of [...endedListeners]) {
          if (!endedListeners.has(listener)) continue
          if (typeof listener === 'function') listener.call(track, event)
          else listener.handleEvent(event)
        }
        endedListeners.clear()
      })
      const stop = track.stop.bind(track)
      track.stop = () => { window.clearInterval(timer); stop() }
      window.__screenTest.streams.push(stream)
      return stream
    } })
  }, size)
}
