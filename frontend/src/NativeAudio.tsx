import { useEffect, useRef, useState } from 'react'

export default function NativeAudio({ control, screen, status }: { control?: string; screen?: string; status?: string }) {
  const [session, setSession] = useState('')
  const [pair, setPair] = useState('')
  const [watchReady, setWatchReady] = useState(false)
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const mounted = useRef(false)
  const current = useRef({ control, screen })
  current.current = { control, screen }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  async function request(path: string, body: unknown) {
    const response = await fetch(`/api/native-audio/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${control}` }, body: JSON.stringify(body) })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error || 'Native audio request failed')
    return result
  }
  useEffect(() => {
    if (!session) return
    const controller = new AbortController()
    const options = { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${control}` }, body: '{}' }
    const stopSession = () => {
      controller.abort()
      void fetch(`/api/native-audio/${session}/stop`, { ...options, keepalive: true }).catch(() => {})
    }
    async function watch() {
      try {
        const response = await fetch(`/api/native-audio/${session}/watch`, { ...options, signal: controller.signal })
        if (!response.ok || !response.body) throw new Error('Could not connect to the native audio session.')
        const reader = response.body.getReader()
        try {
          while (!(await reader.read()).done) {
            if (!controller.signal.aborted) setWatchReady(true)
          }
        } finally { reader.releaseLock() }
      } catch { /* A broken owner connection also ends capture at the backend. */ }
      if (!controller.signal.aborted) {
        setSession(''); setPair(''); setWatchReady(false)
        setError('Native audio session ended. Pair again to share application audio.')
      }
    }
    void watch()
    window.addEventListener('pagehide', stopSession)
    return () => { window.removeEventListener('pagehide', stopSession); stopSession() }
  }, [session, control])
  useEffect(() => { if (!screen) { setSession(''); setPair('') } }, [screen])

  async function start() {
    if (pending || !screen || !control) return
    setPending(true); setError('')
    try {
      const result = await request('sessions', { screen })
      if (!mounted.current || current.current.screen !== screen || current.current.control !== control) {
        void request(`${result.session}/stop`, {}).catch(() => {})
        return
      }
      setWatchReady(false); setSession(result.session)
      setPair(JSON.stringify({ apiUrl: `${location.origin}/api`, code: result.code }))
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : 'Native audio unavailable') }
    finally { if (mounted.current) setPending(false) }
  }
  async function stop() {
    try { await request(`${session}/stop`, {}); setSession(''); setPair('') }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not stop native audio') }
  }
  if (!control) return null
  return <section aria-label="Native system audio">
    <h4>Native system audio (Linux)</h4>
    <p role="status">{status || 'Native helper not connected.'}</p>
    <p>To share a Linux game, start screen sharing and pair the helper. Select the game in your terminal. Your headset plays the game and the participants you unmute.</p>
    <button disabled={!screen || !!session || pending} onClick={() => void start()}>Pair native audio helper</button>
    {pending && <p role="status">Creating native audio pairing…</p>}
    {session && <>
      {watchReady ? <>
        <label>One-time native audio pairing JSON<input readOnly value={pair} /></label>
        <p>Run <code>whiterun-audio --list-applications</code>, then <code>whiterun-audio --start --application SERIAL</code> with your game's number. Paste this single-use code into the helper within one minute.</p>
      </> : <p role="status">Connecting to the native audio session…</p>}
      <button onClick={() => void stop()}>Stop native audio session</button>
    </>}
    {!screen && <p>Start screen sharing to enable native audio pairing.</p>}
    {error && <p role="alert">{error}</p>}
  </section>
}
