// The VPC Service binding has a single private HTTP destination. OAuth and
// provider credentials exist only on the Go host. Never follow its redirects.
const roomPage = /^\/r\/[A-Za-z0-9_-]{32}$/
const authStart = /^\/api\/discord\/auth\/[A-Za-z0-9_-]{32}$/
const callback = '/api/discord/callback'
const control = /^\/api\/discord\/[A-Za-z0-9_-]{32}\/(?:join|media\/(?:state|publish|subscribe|answer|ready|close))$/
const helper = /^\/api\/native-audio\/(?:sessions|claim|[A-Za-z0-9_-]+\/(?:watch|lease|stop|publish|ready))$/

const privateHeaders = {
  'Cache-Control': 'private, no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
}
function reject(status) {
  return new Response(null, { status, headers: privateHeaders })
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.origin !== env.PLAYER_ORIGIN || url.protocol !== 'https:') return reject(404)
    const path = url.pathname
    if (roomPage.test(path) && request.method === 'GET' && !url.search) {
      const index = await env.ASSETS.fetch(new URL('/', url.origin))
      return new Response(index.body, {
        status: index.status,
        headers: { ...privateHeaders, 'Content-Type': 'text/html; charset=utf-8' },
      })
    }
    const login = authStart.test(path)
    const completing = path === callback
    if (login || completing) {
      if (request.method !== 'GET') return reject(405)
    } else if (control.test(path) || helper.test(path)) {
      if (request.method !== 'POST') return reject(405)
      const origin = request.headers.get('Origin')
      if ((origin || control.test(path)) && origin !== url.origin) return reject(403)
    } else {
      return reject(404)
    }
    if (!completing && url.search) return reject(400)
    if (!env.CONTROLLER) return reject(503)
    const headers = new Headers()
    for (const name of ['Content-Type', 'Origin', 'Authorization', 'X-Whiterun-Entry', 'X-Whiterun-Peer']) {
      if (request.headers.has(name)) headers.set(name, request.headers.get(name))
    }
    const cookies = (request.headers.get('Cookie') || '').split(';')
      .map(c => c.trim()).filter(c => /^__Host-wl-(?:login|session|room-[A-Za-z0-9_-]+)=/.test(c))
    if (cookies.length) headers.set('Cookie', cookies.join('; '))

    const upstream = new URL('http://127.0.0.1:18492')
    upstream.pathname = path.slice('/api'.length)
    upstream.search = url.search
    try {
      const result = await env.CONTROLLER.fetch(upstream.href, {
        method: request.method, headers, body: request.body, redirect: 'manual', signal: request.signal,
      })
      if (result.status >= 300 && result.status < 400) {
        const location = result.headers.get('Location')
        if (!location || result.status !== 303) return reject(502)
        const target = new URL(location, url.origin)
        const valid = login && target.origin === 'https://discord.com' && target.pathname === '/oauth2/authorize'
          || completing && target.origin === url.origin && roomPage.test(target.pathname) && !target.search
        if (!valid || target.username || target.password || target.hash) return reject(502)
      }
      const output = new Headers(privateHeaders)
      for (const name of ['Content-Type', 'Location', 'Retry-After']) {
        if (result.headers.has(name)) output.set(name, result.headers.get(name))
      }
      for (const cookie of result.headers.getSetCookie()) output.append('Set-Cookie', cookie)
      return new Response(result.body, { status: result.status, headers: output })
    } catch {
      return reject(503)
    }
  },
}
