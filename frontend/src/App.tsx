import { useEffect, useState } from 'react'
import Rooms from './Rooms'

type Status = 'checking' | 'available' | 'unavailable'

export default function App() {
  const [backend, setBackend] = useState<Status>('checking')
  const [livekit, setLivekit] = useState<Status>('checking')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setBackend('checking')
    setLivekit('checking')
    async function check(path: string, field: string, expected: string, update: (status: Status) => void) {
      try {
        const response = await fetch(path, { signal: controller.signal, cache: 'no-store' })
        const body: unknown = await response.json()
        const valid = response.ok && typeof body === 'object' && body !== null && field in body && (body as Record<string, unknown>)[field] === expected
        if (!controller.signal.aborted) update(valid ? 'available' : 'unavailable')
      } catch {
        if (!controller.signal.aborted) update('unavailable')
      }
    }
    const timeout = window.setTimeout(() => {
      controller.abort()
      setBackend((status) => status === 'checking' ? 'unavailable' : status)
      setLivekit((status) => status === 'checking' ? 'unavailable' : status)
    }, 5000)
    void check('/api/healthz', 'status', 'ok', setBackend)
    void check('/api/readyz', 'livekit', 'reachable', setLivekit)
    return () => { controller.abort(); window.clearTimeout(timeout) }
  }, [attempt])

  return (
    <main>
      <p className="eyebrow">SELF-HOSTED · LOCAL DEVELOPMENT</p>
      <h1>Whiterun Live<span>.</span></h1>
      <p className="intro">A shared space for your screens. Built for a local-first, open-source streaming experience.</p>
      <Rooms />
      <section aria-labelledby="foundation-heading">
        <h2 id="foundation-heading">Local foundation</h2>
        <p>Service checks remain available independently of room connections. Screen publishing requires a separate publisher invitation.</p>
        <dl aria-live="polite">
          <div><dt>Go backend</dt><dd data-status={backend}>{backend}</dd></div>
          <div><dt>LiveKit HTTP reachability</dt><dd data-status={livekit}>{livekit}</dd></div>
        </dl>
        <button onClick={() => setAttempt((value) => value + 1)}>Check services again</button>
        <p className="note">Reachability does not verify WebRTC media. Capture starts only from Start sharing. Audio is never captured.</p>
      </section>
      <footer>1440p60 is a future performance target. Requested settings do not prove transmitted resolution or FPS.</footer>
    </main>
  )
}
