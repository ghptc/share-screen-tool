// One screen-bound owner watch per publication. A source change waits for
// revocation before obtaining the next one-time claim.
export async function audioPost(path: string, data: unknown, signal: AbortSignal, control?: string) {
  const response = await fetch(path, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      ...(control ? { Authorization: 'Bearer ' + control } : {}),
    },
    body: JSON.stringify(data),
  })
  if (!response.ok) throw new Error('Game audio request failed')
  return response
}

// Owner-watch text lines may be split or coalesced by the HTTP proxy.
export function audioPhaseReader(report: (text: string) => void) {
  const decoder = new TextDecoder()
  let pending = ''
  return (chunk: Uint8Array) => {
    const lines = (pending + decoder.decode(chunk, { stream: true })).split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) {
      if (line === 'waiting') report('Waiting for the selected application to send audio (30-second startup limit).')
      if (line === 'ready') report('Stereo links ready. Waiting for audio.')
      if (line === 'sharing') report('Sharing audio')
    }
  }
}

export async function publishGameAudio(
  screen: string,
  source: string,
  control: string,
  signal: AbortSignal,
  ready: () => void,
  report?: (status: string) => void,
) {
  signal.throwIfAborted()
  const watch = new AbortController()
  const lifetime = AbortSignal.any([signal, watch.signal])
  let session: string | undefined
  let stopping: Promise<unknown> | undefined
  function revoke() {
    if (session && !stopping) {
      stopping = fetch(`/api/native-audio/${session}/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + control },
        body: '{}',
        keepalive: true,
        signal: AbortSignal.timeout(5000),
      }).catch(() => {})
    }
  }
  signal.addEventListener('abort', revoke, { once: true })
  try {
    // Even if the user stops while this POST is in flight, collect the
    // session ID and revoke it. No helper can start without an owner watch.
    const pair = await (
      await audioPost('/api/native-audio/sessions', { screen }, AbortSignal.timeout(6000), control)
    ).json()
    session = pair.session
    lifetime.throwIfAborted()
    const response = await audioPost(`/api/native-audio/${session}/watch`, {}, lifetime, control)
    const reader = response.body?.getReader()
    if (!reader || (await reader.read()).done) throw new Error('Owner watch unavailable')
    let started = false
    const readPhase = audioPhaseReader(text => { if (!started && !lifetime.aborted) report?.(text) })
    const ended = (async () => {
      try {
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done) break
          readPhase(chunk.value)
        }
      } catch {
        /* network loss or deliberate stop */
      } finally {
        reader.releaseLock()
        watch.abort()
      }
    })()
    await audioPost(
      '/player/start',
      { source: source.split(',')[0], additional: source.split(',').slice(1), code: pair.code },
      AbortSignal.any([lifetime, AbortSignal.timeout(50000)]),
    )
    lifetime.throwIfAborted()
    started = true
    ready()
    await ended
  } finally {
    watch.abort()
    revoke()
    signal.removeEventListener('abort', revoke)
    await stopping
  }
}

export function readAudioPreference(key: string) {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
export function writeAudioPreference(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* Sharing also works with storage disabled. */
  }
}
