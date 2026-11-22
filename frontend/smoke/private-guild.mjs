// Real, operator-assisted Discord validation. Only local HTTP outcome codes leave the profile.
import { createHmac } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
// Playwright debug traces may include callback URLs. Keep this recorder outcome-only.
delete process.env.DEBUG
delete process.env.PWDEBUG
const { firefox } = await import('playwright')
const profile = mkdtempSync(join(tmpdir(), 'whiterun-discord-check-'))
chmodSync(profile, 0o700)
function command(tool, args, input) {
  const result = spawnSync(tool, args, { cwd: root, input, encoding: 'utf8' })
  if (result.status !== 0) throw Error('Private validation setup unavailable')
  return result.stdout
}
function localRoom() {
  const compose = ['compose', '-f', 'compose.discord-private.yaml']
  const cid = command('docker', [...compose, 'ps', '-q', 'discord-bot']).trim()
  // Only request the three settings required to derive the real logical room.
  const get = name => command('docker', ['inspect', '-f',
    '{{range .Config.Env}}{{if eq (index (split . "=") 0) "' + name + '"}}{{println .}}{{end}}{{end}}', cid])
    .trim().slice(name.length + 1)
  const origin = get('APP_ORIGIN')
  const pair = get('DISCORD_CHANNELS').split(',')[0].trim()
  const room = createHmac('sha256', get('DISCORD_ROOM_KEY'))
    .update('whiterun:discord:voice:v1/' + pair).digest().subarray(0, 24).toString('base64url')
  const ca = command('docker', [...compose, 'exec', '-T', 'player', 'cat', '/data/caddy/pki/authorities/local/root.crt'])
  command('certutil', ['-N', '--empty-password', '-d', 'sql:' + profile])
  command('certutil', ['-A', '-d', 'sql:' + profile, '-n', 'Whiterun private test CA', '-t', 'C,,'], ca)
  return new URL('/r/' + room, origin)
}
async function run() {
  const link = process.env.WHITERUN_TEST_ROOM_URL ? new URL(process.env.WHITERUN_TEST_ROOM_URL) : localRoom()
  if (link.protocol !== 'https:' || link.username || link.password || link.search || link.hash ||
      !/^\/r\/[A-Za-z0-9_-]{32}$/.test(link.pathname)) throw Error('Expected a private HTTPS room link')
  const { origin } = link
  const room = link.pathname.slice(3)
  const setupOnly = process.argv.includes('--check-setup')
  if (setupOnly) console.log('Private HTTPS, copied-link and OAuth-start check')
  const browserEnv = Object.fromEntries(['HOME','PATH','LANG','DISPLAY','WAYLAND_DISPLAY','XDG_RUNTIME_DIR',
    'XDG_SESSION_TYPE','DBUS_SESSION_BUS_ADDRESS','XAUTHORITY'].filter(k => process.env[k]).map(k => [k, process.env[k]]))
  const context = await firefox.launchPersistentContext(profile, { headless: setupOnly, timeout: 15000, env: browserEnv })
  try {
    const page = await context.newPage()
    // Opening directly preserves the separate browser session. Never inspect Discord form input.
    const status = (step, value) => console.log(new Date().toISOString(), step, value)
    const joinPath = '/api/discord/' + room + '/join'
    page.on('response', response => {
      const u = new URL(response.url())
      if (u.origin !== origin) return
      if (u.pathname === joinPath) status('room admission', response.status())
      else if (u.pathname === '/api/discord/callback') status('OAuth callback', response.status())
      else if (u.pathname.startsWith('/api/discord/auth/')) status('OAuth start', response.status())
    })
    const [missing, oauthStart] = await Promise.all([
      page.waitForResponse(r => new URL(r.url()).origin === origin && new URL(r.url()).pathname === joinPath, { timeout: 180000 }),
      page.waitForResponse(r => new URL(r.url()).origin === origin && new URL(r.url()).pathname.startsWith('/api/discord/auth/'), { timeout: 180000 }),
      page.goto(link.href),
    ])
    if (missing.status() !== 401 || oauthStart.status() !== 303) throw Error('Initial authorization failed')
    if (setupOnly) return
    console.log('Join the configured voice channel and approve Discord OAuth in this window.')
    const matches = (r, path) => { const u = new URL(r.url()); return u.origin === origin && u.pathname === path }
    const [callback, admitted] = await Promise.all([
      page.waitForResponse(r => matches(r, '/api/discord/callback'), { timeout: 180000 }),
      page.waitForResponse(r => matches(r, joinPath), { timeout: 180000 }),
    ])
    if (callback.status() !== 303 || admitted.status() !== 200) throw Error('Correct-channel admission failed')
    await page.getByText('Connected', { exact: true }).first().waitFor({ timeout: 20000 })
    status('correct channel', 'connected')
    console.log('Now move to another voice channel and leave the player open.')
    await page.getByRole('heading', {name:'Player unavailable'}).waitFor({ timeout: 180000 })
    status('departure', 'player disconnected')
    // Reopen in this profile while still in the wrong channel, including any fresh OAuth consent.
    const fresh = await context.newPage()
    await Promise.all([
      fresh.waitForResponse(r => matches(r, joinPath) && r.status() === 403, { timeout: 120000 }),
      fresh.goto(link.href),
    ])
    status('wrong-channel re-entry', 403)
  } finally {
    await context.close()
  }
}
try { await run() }
catch { console.error('Private-guild validation incomplete. Use the last reported stage.'); process.exitCode = 1 }
finally { rmSync(profile, { recursive: true, force: true }) }
