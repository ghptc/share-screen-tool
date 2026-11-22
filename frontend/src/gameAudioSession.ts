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

export async function publishGameAudio(
  screen: string,
  source: string,
  control: string,
  signal: AbortSignal,
  ready: () => void,
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
    const ended = (async () => {
      try {
        while (!(await reader.read()).done) {
          /* authenticated heartbeat */
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
      AbortSignal.any([lifetime, AbortSignal.timeout(15000)]),
    )
    lifetime.throwIfAborted()
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
