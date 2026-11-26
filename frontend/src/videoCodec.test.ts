import { afterEach, expect, it, vi } from 'vitest'
import { configureVideoCodec } from './videoCodec'

const source = { width: 1920, height: 1080, frameRate: 59.94 }
const codecs = ['VP8', 'rtx', 'H264', 'VP9'].map(name => ({ mimeType: 'video/' + name }))
function setup() {
  const query = vi.fn().mockImplementation(async () => ({ supported: true, smooth: true, powerEfficient: false }))
  vi.stubGlobal('navigator', Object.create(navigator, {
    userAgent: { value: 'Chrome/158' }, mediaCapabilities: { value: { encodingInfo: query } },
  }))
  vi.stubGlobal('RTCRtpSender', { getCapabilities: () => ({ codecs }) })
  const set = vi.fn()
  const tx = { setCodecPreferences: set } as unknown as RTCRtpTransceiver
  return { set, tx, query }
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

it('prefers supported H.264 in the measured software VP8 workload and respects a power-efficient default', async () => {
  const { tx, set, query } = setup()
  await configureVideoCodec(tx, 'auto', source, 60)
  expect(set).toHaveBeenCalledExactlyOnceWith([codecs[2], codecs[0], codecs[1], codecs[3]])
  set.mockClear()
  query.mockResolvedValueOnce({ supported: true, smooth: true, powerEfficient: true })
  await configureVideoCodec(tx, 'auto', source, 60)
  expect(set).not.toHaveBeenCalled()
})

it('preserves browser order outside the measured workload and when the query fails or stalls', async () => {
  const { tx, set, query } = setup()
  await configureVideoCodec(tx, 'browser', source, 60)
  await configureVideoCodec(tx, 'auto', source, 30)
  await configureVideoCodec(tx, 'auto', { width: 3840, height: 2160 }, 60)
  expect(query).not.toHaveBeenCalled()
  vi.useFakeTimers()
  query.mockImplementationOnce(() => new Promise(() => {}))
  const pending = configureVideoCodec(tx, 'auto', source, 60)
  await vi.advanceTimersByTimeAsync(250)
  await pending
  query.mockRejectedValueOnce(Error('unsupported'))
  await configureVideoCodec(tx, 'auto', source, 60)
  expect(set).not.toHaveBeenCalled()
})
