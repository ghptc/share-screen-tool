import { useEffect, useRef, useState } from 'react'
import { audioPost, publishGameAudio, readAudioPreference, writeAudioPreference } from './gameAudioSession'

type Source = { id: string; name: string; detail: string }
const previousSourceKey = 'whiterun.gameAudio.previousSource'
const sourceLabel = (s: Source) => (s.detail && s.detail !== s.name ? s.name + ' · ' + s.detail : s.name)

export default function DesktopAudio({
  open,
  screen,
  control,
  onStatus, onOffer,
}: {
  open: boolean
  screen?: string
  control: string
  onStatus: (status: string) => void
  onOffer: (offered:boolean) => void
}) {
  const [previous] = useState(() => readAudioPreference(previousSourceKey))
  const [selected, setSelected] = useState<string[] | null>(null)
  const initial = useRef<Set<string> | null>(null)
  const [catalog, setCatalog] = useState<{ screen: string; items: Source[] } | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const [capture, setCapture] = useState<{ screen: string; source: string; status: string } | null>(null)
  const pending = useRef(Promise.resolve())
  const [pageActive, setPageActive] = useState(true)
  useEffect(() => {
    const leave = () => setPageActive(false)
    window.addEventListener('pagehide', leave)
    return () => window.removeEventListener('pagehide', leave)
  }, [])
  const authorized = pageActive ? screen : undefined
  const sources = catalog?.screen === authorized ? catalog?.items : undefined
  const activeIDs = (selected ?? []).filter(id => sources?.some(s => s.id === id))
  const target = activeIDs.join(',')
  const offered = sources?.filter(s => !activeIDs.includes(s.id)) ?? []
  const late = offered.some(s => initial.current && !initial.current.has(s.id))
  const phase = capture?.source === target && capture.screen === authorized ? capture.status : ''
  useEffect(() => { onOffer(Boolean(authorized && late && !open)) }, [authorized, late, open, onOffer])

  useEffect(() => {
    if (!authorized) {
      setCatalog(null)
      setUnavailable(false)
      return
    }

    const request = new AbortController()
    let timer: number
    async function list() {
      try {
        const res = await audioPost(
          '/player/sources',
          {},
          AbortSignal.any([request.signal, AbortSignal.timeout(5000)]),
        )
        const items: Source[] = await res.json()
        // Older launchers expose bare serials which can be reused after a daemon restart.
        if (items.some((s) => !/^\d+:\d+$/.test(s.id))) throw new Error('Update desktop launcher')
        if (!request.signal.aborted) {
          if (!initial.current) initial.current = new Set(items.map(s => s.id))
          setSelected(current => {
            if (current !== null) return current
            const candidate = items.find(s => s.id === previous) ?? (items.length === 1 ? items[0] : undefined)
            return candidate ? [candidate.id] : []
          })
          setCatalog({ screen: authorized!, items })
          setUnavailable(false)
        }
      } catch {
        if (!request.signal.aborted) {
          setUnavailable(true)
          setCatalog(null)
        }
      } finally {
        if (!request.signal.aborted) timer = window.setTimeout(list, 2000)
      }
    }
    void list()
    return () => {
      request.abort()
      window.clearTimeout(timer)
    }
  }, [authorized, previous])

  useEffect(() => {
    if (!authorized || !target) {
      setCapture(null)
      return
    }
    // Pin even an automatic choice for this screen. A replacement node jumps
    // to the chooser, including when it is the only remaining application.

    const controller = new AbortController()
    const stop = () => controller.abort()
    window.addEventListener('pagehide', stop)
    let timer: number
    let failures = 0
    function start() {
      pending.current = pending.current.then(async () => {
        if (controller.signal.aborted) return
        try {
          await publishGameAudio(authorized!, target, control, controller.signal, () => {
            failures = 0
            writeAudioPreference(previousSourceKey, target.split(',')[0])
            setCapture({ screen: authorized!, source: target, status: 'Sharing audio' })
          })
        } catch {
          /* Retry only while this screen and source remain authorized. */
        }
        if (!controller.signal.aborted) {
          setCapture({ screen: authorized!, source: target, status: 'Reconnecting audio' })
          timer = window.setTimeout(start, Math.min(12000, 2000 * 2 ** Math.min(failures++, 3)))
        }
      })
    }
    start()
    return () => {
      window.removeEventListener('pagehide', stop)
      stop()
      window.clearTimeout(timer)
    }
  }, [authorized, target, control])

  let status = ''
  if (authorized) {
    if (unavailable) status = 'Audio launcher unavailable'
    else if (!sources) status = 'Finding audio source'
    else if (target) status = phase || 'Starting audio'
    else status = sources.length ? 'Choose audio source' : 'Waiting for audio source'
  }
  useEffect(() => {
    onStatus(status)
  }, [status, onStatus])

  if (!authorized) return null
  return (
    <div className="source-picker">
      <label htmlFor="game-source">
        Game audio <small>Stereo · 48 kHz</small>
      </label>
      <div className="source-row">
        <select
          id="game-source"
          value={activeIDs[0] ?? ''}
          disabled={!sources?.length}
          onChange={(e) => setSelected([e.target.value])}
        >
          <option value="" disabled>
            {sources?.length ? 'Select application' : 'No available applications'}
          </option>
          {sources?.map((s) => (
            <option key={s.id} value={s.id}>
              {sourceLabel(s)}
            </option>
          ))}
        </select>
      </div>
      {activeIDs.length > 0 && <ul aria-label="Authorized applications">{activeIDs.map(id => {
        const name = sourceLabel(sources!.find(s => s.id === id)!)
        return <li key={id}>{name} <button aria-label={'Revoke '+name} onClick={() => setSelected(activeIDs.filter(active => active !== id))}>Revoke</button></li>
      })}</ul>}
      {offered.map(s => <button key={s.id} disabled={activeIDs.length >= 8} onClick={() => setSelected([...activeIDs, s.id])}>Allow audio · {sourceLabel(s)}</button>)}
      <p role="status">{status}</p>
    </div>
  )
}
