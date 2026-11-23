import { useEffect, useRef, useState } from 'react'
import { sourceLabel, type Source } from './DesktopAudio'
import { publishGameAudio } from './gameAudioSession'
import NativeAudio from './NativeAudio'

async function launcher(action: 'sources' | 'start', data: unknown, signal: AbortSignal) {
  const response = await fetch('https://127.0.0.1:18495/' + action, {
    method: 'POST', mode: 'cors', credentials: 'include', redirect: 'error', cache: 'no-store',
    referrerPolicy: 'no-referrer', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data), signal,
  })
  if (!response.ok) throw new Error('Desktop launcher unavailable')
  return response
}

async function startApplication(source: string, code: string, signal: AbortSignal) {
  const response = await launcher('start', { source, code }, signal)
  if ((await response.json())?.started !== true) throw new Error('Desktop launcher did not confirm startup')
}

export default function HostedAudio({ screen, control, open, status }: {
  screen: string; control: string; open: boolean; status?: string
}) {
  const desktopLinux = location.protocol === 'https:' && /^Linux/i.test(navigator.platform) && !/Android|CrOS/.test(navigator.userAgent)
  const [sources, setSources] = useState<Source[]>([])
  const [selected, setSelected] = useState('')
  const [discovery, setDiscovery] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [manual, setManual] = useState(false)
  const [phase, setPhase] = useState('')
  const [busy, setBusy] = useState(false)
  const capture = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!desktopLinux || !control || !open || manual || busy) return
    const request = new AbortController()
    setSources([])
    setSelected('')
    setDiscovery('Finding applications…')
    async function discover() {
      try {
        const response = await launcher('sources', {}, AbortSignal.any([request.signal, AbortSignal.timeout(10000)]))
        const items: Source[] = await response.json()
        if (!Array.isArray(items) || items.some(s => !/^\d+:\d+$/.test(s.id) || typeof s.name !== 'string'))
          throw new Error('Invalid desktop source list')
        if (!request.signal.aborted) {
          setSources(items)
          setDiscovery(items.length ? '' : 'No eligible applications found.')
        }
      } catch {
        if (!request.signal.aborted) setDiscovery('Desktop launcher unavailable. Retry or pair manually.')
      }
    }
    void discover()
    return () => request.abort()
  }, [desktopLinux, control, open, manual, busy, refresh])

  useEffect(() => {
    setPhase('')
    setBusy(false)
    const stop = () => capture.current?.abort()
    window.addEventListener('pagehide', stop)
    return () => {
      window.removeEventListener('pagehide', stop)
      stop()
      capture.current = null
    }
  }, [screen, control])

  async function share() {
    if (capture.current || !sources.some(s => s.id === selected)) return
    const attempt = new AbortController()
    capture.current = attempt
    setBusy(true)
    setPhase('Connecting…')
    let stopped = 'Stopped'
    try {
      await publishGameAudio(screen, selected, control, attempt.signal, () => setPhase('Sharing audio'), setPhase, startApplication)
    } catch {
      if (!attempt.signal.aborted) stopped = 'Stopped. Check the selected application and try again.'
    } finally {
      if (capture.current === attempt) {
        capture.current = null
        setBusy(false)
        setPhase(stopped)
      }
    }
  }

  if (!control) return null
  if (manual || !desktopLinux) return <>
    <NativeAudio screen={screen} control={control} status={status} />
    {desktopLinux && <button onClick={() => setManual(false)}>Use desktop launcher</button>}
  </>
  return <section className="source-picker" aria-label="Application audio">
    <label htmlFor="hosted-audio-source">Application audio</label>
    <div className="source-row"><select id="hosted-audio-source" disabled={!sources.length || busy}
      value={selected} onChange={event => setSelected(event.target.value)}>
      <option value="" disabled>Select application</option>
      {sources.map(s => <option key={s.id} value={s.id}>{sourceLabel(s)}{s.idle ? ' (idle)' : ''}</option>)}
    </select></div>
    {busy
      ? <button onClick={() => capture.current?.abort()}>Stop sharing audio</button>
      : <>
        <button disabled={!selected} onClick={() => void share()}>Share application audio</button>
        <button onClick={() => setRefresh(n => n + 1)}>Refresh applications</button>
        <button onClick={() => setManual(true)}>Pair manually</button>
      </>}
    <p role="status">{[phase, !busy && discovery].filter(Boolean).join(' · ')}</p>
  </section>
}
