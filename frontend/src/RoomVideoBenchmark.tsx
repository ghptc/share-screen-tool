import { useEffect, useRef, useState, type RefObject } from 'react'
import { snapshot, summarizeVideo, type VideoEndpoint } from './videoMeasurement'

type Props = { endpoints: VideoEndpoint[]; root: RefObject<HTMLDivElement | null> }

// All initially visible and focus-hidden publishers share a sampling clock.
// Keep the output local and free of room names, handles, SDP and network addresses.
export default function RoomVideoBenchmark({ endpoints, root }: Props) {
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState('')
  const current = useRef(endpoints)
  current.current = endpoints
  const run = useRef<AbortController | null>(null)
  useEffect(() => () => run.current?.abort(), [])
  async function measure() {
    const stage = root.current
    if (!stage || run.current) return
    const controller = new AbortController()
    run.current = controller
    setRunning(true)
    setResult('')
    const utc = new Date().toISOString()
    const start = performance.now()
    const series = endpoints.map((): Awaited<ReturnType<typeof snapshot>>[] => [])
    try {
      for (let i = 0; i <= 15; i++) {
        if (i) await new Promise(resolve => setTimeout(resolve, Math.max(0, start + i * 2000 - performance.now())))
        if (controller.signal.aborted) return
        await Promise.all(endpoints.map(async (e, index) => {
          try { series[index].push(await snapshot(e, stage)) } catch { /* Incomplete series is marked below. */ }
        }))
      }
      if (controller.signal.aborted) return
      const screens = endpoints.map((e, i) => ({
        tile: i + 1,
        ...(current.current.some(c => c.pc === e.pc && c.stream === e.stream)
          ? summarizeVideo(series[i], e) : { status: 'Screen replaced or ended' }),
      }))
      setResult(JSON.stringify({ startUtc: utc, endUtc: new Date().toISOString(), screens }, (_, v) =>
        typeof v === 'number' ? Math.round(v * 100) / 100 : v, 2))
    } finally {
      if (!controller.signal.aborted) setRunning(false)
      run.current = null
    }
  }
  return <>
    <button disabled={running || !endpoints.length} onClick={() => void measure()}>
      {running ? 'Measuring video…' : 'Measure all screens for 30 s'}
    </button>
    {result && <textarea aria-label="Video measurement report" readOnly rows={8} value={result} />}
  </>
}
