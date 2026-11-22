import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'

const origin = 'https://pilot.example'
const ref = 'x'.repeat(32)
const api = '/api/discord/'
let mf, result, requests
before(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, scriptPath: fileURLToPath(new URL('worker.mjs', import.meta.url)),
    compatibilityDate: '2026-11-22', cf: false, bindings: { PLAYER_ORIGIN: origin },
    serviceBindings: {
      ASSETS: () => new Response('<title>Player</title>'),
      CONTROLLER: async request => {
        requests.push({ method: request.method, path: new URL(request.url).pathname, headers: request.headers,
          query: new URL(request.url).search, body: await request.text() })
        return result()
      },
    },
  }))
  await mf.ready
})
after(async () => { if (mf) await mf.dispose() })
function get(path, options) {
  return mf.dispatchFetch(origin + path, { redirect: 'manual', ...options })
}
test('only the dedicated room entry serves the uncached player', async () => {
  requests = []
  const page = await get('/r/' + ref)
  assert.equal(await page.text(), '<title>Player</title>')
  assert.match(page.headers.get('cache-control'), /no-store/)
  for (const path of ['/', '/r/bad', '/api/fixture/authorize', '/internal/discord/admit', '/player/join', '/api/discord/' + ref + '/token']) {
    assert.equal((await get(path)).status, 404)
  }
  assert.equal((await mf.dispatchFetch('https://alternate.example/r/' + ref)).status, 404)
  assert.equal(requests.length, 0)
})
test('OAuth and callback preserve cookies and issue browser redirects without following them', async () => {
  requests = []
  result = () => new Response(null, { status: 303, headers: { Location: 'https://discord.com/oauth2/authorize?state=test' } })
  assert.equal((await get(api + 'auth/' + ref)).status, 303)
  result = () => {
    const h = new Headers({ Location: '/r/' + ref })
    h.append('Set-Cookie', '__Host-wl-login=; Max-Age=0; Secure; HttpOnly; Path=/')
    h.append('Set-Cookie', '__Host-wl-session=test; Secure; HttpOnly; SameSite=Strict; Path=/')
    return new Response(null, { status: 303, headers: h })
  }
  const callback = await get(api + 'callback?code=fixture&state=test', { headers: { Cookie: '__Host-wl-login=test; CF_Authorization=unrelated' } })
  assert.equal(callback.status, 303)
  assert.equal(callback.headers.getSetCookie().length, 2)
  assert.equal(requests[1].query, '?code=fixture&state=test')
  assert.equal(requests[1].headers.get('cookie'), '__Host-wl-login=test')
  assert.equal(requests[1].path, '/discord/callback')
  result = () => Response.redirect('https://another.example/', 303)
  assert.equal((await get(api + 'auth/' + ref)).status, 502)
  assert.equal(requests.length, 3)
})
test('same-origin admission passes the authenticated controller decision once', async () => {
  requests = []
  const path = api + ref + '/join'
  const options = { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json',
    'X-Whiterun-Entry': 'visit', 'X-Forwarded-User': 'forged', Cookie: '__Host-wl-session=test' }, body: '{}' }
  for (const status of [401, 403, 409, 410, 200]) {
    result = () => Response.json({ status }, { status })
    assert.equal((await get(path, options)).status, status)
  }
  assert.equal(requests.length, 5)
  assert.equal(requests[0].body, '{}')
  assert.equal(requests[0].headers.get('X-Whiterun-Entry'), 'visit')
  assert.equal(requests[0].headers.get('X-Forwarded-User'), null)
  assert.equal((await get(path)).status, 405)
  assert.equal((await get(path, { ...options, headers: {Origin: 'https://another.example'} })).status, 403)
  assert.equal(requests.length, 5)
})

test('the replacement shell cannot reach OAuth or media before Access has been validated', async () => {
  const shell = new Miniflare(convertV4MiniflareOptions({
    modules: true, scriptPath: fileURLToPath(new URL('worker.mjs', import.meta.url)),
    compatibilityDate: '2026-11-22', cf: false, bindings: { PLAYER_ORIGIN: origin },
    serviceBindings: { ASSETS: () => new Response('<title>Screen Share</title>') },
  }))
  try {
    assert.equal((await shell.dispatchFetch(origin + '/r/' + ref)).status, 200)
    assert.equal((await shell.dispatchFetch(origin + api + 'auth/' + ref)).status, 503)
    for (const action of ['join', 'media/state']) {
      const response = await shell.dispatchFetch(origin + api + ref + '/' + action, {
        method: 'POST', headers: { Origin: origin },
      })
      assert.equal(response.status, 503)
    }
  } finally {
    await shell.dispose()
  }
})

test('Access setup can expose only the shell before the pilot gets a private binding', async () => {
  const { mkdtemp, copyFile, readFile, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { execFileSync } = await import('node:child_process')
  const dir = await mkdtemp(join(tmpdir(), 'screen-share-config-'))
  try {
    for (const name of ['configure.mjs', 'wrangler.json']) await copyFile(new URL(name, import.meta.url), join(dir, name))
    const legacy = join(dir, 'wrangler.private.json')
    await writeFile(legacy, 'previous deployment config')
    for (const hostname of ['pilot', 'pilot.workers.dev']) {
      const printed = execFileSync(process.execPath, ['configure.mjs', '--callback', hostname], { cwd: dir, encoding: 'utf8' })
      assert.equal(printed.trim(), 'https://screen-share-player.pilot.workers.dev/api/discord/callback')
    }
    assert.throws(() => execFileSync(process.execPath, ['configure.mjs', '--callback', 'worker.pilot.workers.dev'], { cwd: dir, stdio: 'pipe' }))
    await assert.rejects(readFile(join(dir, 'wrangler.screen-share.json')), { code: 'ENOENT' })
    execFileSync(process.execPath, ['configure.mjs', '--prepare', 'pilot.workers.dev'], { cwd: dir })
    const prepared = JSON.parse(await readFile(join(dir, 'wrangler.screen-share.json'), 'utf8'))
    assert.equal(prepared.name, 'screen-share-player')
    assert.equal(prepared.vars.PLAYER_ORIGIN, 'https://screen-share-player.pilot.workers.dev')
    assert.equal(prepared.workers_dev, false)
    assert.equal(prepared.preview_urls, false)
    assert.equal(prepared.routes, undefined)
    assert.equal(prepared.vpc_services, undefined)
    assert.throws(() => execFileSync(process.execPath, ['configure.mjs', '--prepare', 'pilot', '--private-pilot'], { cwd: dir, stdio: 'pipe' }))
    execFileSync(process.execPath, ['configure.mjs', '--access-setup', 'gabrielhpittacosta.workers.dev'], { cwd: dir })
    const shell = JSON.parse(await readFile(join(dir, 'wrangler.screen-share.json'), 'utf8'))
    assert.equal(shell.workers_dev, true)
    assert.equal(shell.preview_urls, false)
    assert.equal(shell.vpc_services, undefined)
    const hostOrigin = (await readFile(new URL('origin/player.env', import.meta.url), 'utf8')).trim()
    assert.equal(hostOrigin, 'APP_ORIGIN=' + shell.vars.PLAYER_ORIGIN)
    const base = JSON.parse(await readFile(join(dir, 'wrangler.json'), 'utf8'))
    assert.equal(base.vars.PLAYER_ORIGIN, shell.vars.PLAYER_ORIGIN)
    for (const stage of [undefined, '--access-setup', '--private-pilot']) {
      const args = ['configure.mjs','pilot','00000000-0000-4000-8000-000000000001']
      if (stage) args.push(stage)
      execFileSync(process.execPath, args, { cwd: dir })
      const config = JSON.parse(await readFile(join(dir, 'wrangler.screen-share.json'), 'utf8'))
      assert.equal(config.preview_urls, false)
      assert.equal(config.workers_dev, Boolean(stage))
      assert.equal(Boolean(config.vpc_services), stage !== '--access-setup')
    }
    assert.equal(await readFile(legacy, 'utf8'), 'previous deployment config')
  } finally { await rm(dir, { recursive: true, force: true }) }
})
