// This module runs only in the loopback Vite development server.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { request } from 'node:http'
import type { Plugin } from 'vite'

// Loopback port forwarding on Linux Docker reaches Vite from the project's
// bridge gateway. Never trust an entire bridge subnet or a forwarded header.
function workstationPeers(): Set<string> {
  const peers = new Set(['127.0.0.1', '::1'])
  if (process.env.PLAYER_COMPOSE_LOOPBACK === '1') {
    const routes = readFileSync('/proc/net/route', 'utf8').trim().split('\n').slice(1)
    for (const line of routes) {
      const [, destination, gateway, flags] = line.trim().split(/\s+/)
      if (destination === '00000000' && /^[a-f0-9]{8}$/i.test(gateway) && (parseInt(flags, 16) & 3) === 3) {
        peers.add(Buffer.from(gateway, 'hex').reverse().join('.'))
      }
    }
  }
  return peers
}

export function localPlayer(): Plugin {
  const signingKey = randomBytes(32)
  const cookieName = 'whiterun_player'
  const sign = (value: string) => createHmac('sha256', signingKey).update(value).digest('hex')
  function valid(cookie: string) {
    const value =
      cookie
        .split(';')
        .map((v) => v.trim())
        .find((v) => v.startsWith(cookieName + '='))
        ?.slice(cookieName.length + 1) || ''
    const match = /^(\d{13}\.[a-f0-9]{32})\.([a-f0-9]{64})$/.exec(value)
    return (
      !!match &&
      Number(match[1].split('.')[0]) > Date.now() &&
      timingSafeEqual(Buffer.from(match[2]), Buffer.from(sign(match[1])))
    )
  }
  return {
    name: 'screen-share-local-player',
    apply: 'serve',
    configureServer(server) {
      const origin = new URL(process.env.APP_ORIGIN || 'http://localhost:5173')
      const key = process.env.LOCAL_PLAYER_KEY
      const peers = workstationPeers()
      server.middlewares.use(async (req, res, next) => {
        const path = req.url?.split('?')[0]
        const local =
          key &&
          key.length >= 32 &&
          peers.has((req.socket.remoteAddress || '').replace(/^::ffff:/, '')) &&
          origin.protocol === 'http:' &&
          origin.hostname === 'localhost' &&
          req.headers.host === origin.host &&
          !Object.keys(req.headers).some((h) => h === 'forwarded' || h.startsWith('x-forwarded-'))
        if ((path === '/' || /^\/r\/[A-Za-z0-9_-]{32}$/.test(path || '')) && req.method === 'GET') {
          res.setHeader('X-Frame-Options', 'DENY')
          res.setHeader('Content-Security-Policy', "frame-ancestors 'none'")
          res.setHeader('Cache-Control', 'no-store')
          if (
            local &&
            req.headers['sec-fetch-mode'] === 'navigate' &&
            req.headers['sec-fetch-dest'] === 'document' &&
            (['none', 'same-origin'].includes(String(req.headers['sec-fetch-site'])) ||
              req.headers['sec-fetch-user'] === '?1') &&
            !valid(req.headers.cookie || '')
          ) {
            const value = Date.now() + 8 * 3600000 + '.' + randomBytes(16).toString('hex')
            res.setHeader(
              'Set-Cookie',
              `${cookieName}=${value}.${sign(value)}; Path=/player/; HttpOnly; SameSite=Strict; Max-Age=28800`,
            )
          }
          return next()
        }
        if (!path?.startsWith('/player/')) return next()
        res.setHeader('Cache-Control', 'no-store')
        res.setHeader('Content-Type', 'application/json')
        function fail(code: number, error: string) {
          res.statusCode = code
          res.end(JSON.stringify({ error }))
        }
        if (
          !local ||
          req.method !== 'POST' ||
          req.headers.origin !== origin.origin ||
          req.headers['sec-fetch-site'] !== 'same-origin' ||
          !valid(req.headers.cookie || '') ||
          req.headers['content-type']?.split(';')[0] !== 'application/json'
        )
          return fail(403, 'Open the local player at its configured localhost address.')
        if (!['/player/join', '/player/sources', '/player/start'].includes(path))
          return fail(404, 'Unknown player action')
        try {
          const chunks: Buffer[] = []
          let size = 0
          for await (const chunk of req) {
            size += chunk.length
            if (size > 4096) return fail(413, 'Request too large')
            chunks.push(Buffer.from(chunk))
          }
          const body = Buffer.concat(chunks)
          if (path === '/player/join') {
            const upstream = await fetch(
              (process.env.API_PROXY_TARGET || 'http://127.0.0.1:8080') + '/local/join',
              {
                method: 'POST',
                redirect: 'error',
                signal: AbortSignal.timeout(6000),
                headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
                body: body.toString(),
              },
            )
            res.statusCode = upstream.status
            res.end(await upstream.text())
            return
          }
          if (!process.env.PLAYER_AUDIO_SOCKET) return fail(503, 'Desktop audio launcher is unavailable.')
          const upstream = request(
            {
              socketPath: process.env.PLAYER_AUDIO_SOCKET,
              path: path.slice('/player'.length),
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              timeout: 48000,
            },
            (response) => {
              res.statusCode = response.statusCode || 502
              response.pipe(res)
              response.on('error', () => res.destroy())
            },
          )
          upstream.on('timeout', () => upstream.destroy())
          upstream.on('error', () => fail(503, 'Desktop audio launcher is unavailable.'))
          upstream.end(body)
        } catch {
          fail(503, 'Local player service unavailable.')
        }
      })
    },
  }
}
