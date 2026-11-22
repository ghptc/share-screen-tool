// Two logical participants, one real HyperX output. Metadata only; no listening verdict.
import { createRequire } from 'node:module'
import { spawn, execFileSync } from 'node:child_process'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fixtureAudio } from '../../frontend/e2e/fixture-audio.ts'
import { frontend } from '../../frontend/e2e/built-frontend.ts'
import { verifyPlaybackLinks } from './verify-routing.mjs'
import { playbackMeter, measurePlayback, measureRTP } from './playback-meter.mjs'
const require = createRequire(new URL('../../frontend/package.json', import.meta.url))
const { chromium, firefox } = require('@playwright/test')
const helperPath = resolve(process.env.SAME_HEADSET_HELPER || 'native-audio/whiterun-audio')
const playerUI = process.env.SAME_HEADSET_PLAYER === '1'
const sink = process.env.SAME_HEADSET_SINK
if (!sink) throw new Error('Explicit SAME_HEADSET_SINK required')
const seconds = Number(process.env.SAME_HEADSET_SECONDS || 60)
if (!Number.isFinite(seconds) || seconds < 15 || seconds > 600)
  throw new Error('Duration must be 15..600 seconds')
const realScreen = process.env.SAME_HEADSET_REAL_SCREEN === '1'
const base = process.env.E2E_BASE_URL || 'http://localhost:5173'
const dir = resolve(process.env.SAME_HEADSET_RESULTS || `/tmp/whiterun-same-headset-${Date.now()}`)
mkdirSync(dir, { recursive: false, mode: 0o700 })
const graph = () => JSON.parse(execFileSync('pw-dump', { encoding: 'utf8', timeout: 3000 }))
const initial = graph()
const physical = initial.find(
  (n) => n.info?.props?.['node.name'] === sink && n.info.props['media.class'] === 'Audio/Sink',
)
if (!physical || !sink.startsWith('alsa_output.') || /aloop|loopback/i.test(sink))
  throw new Error('Use a physical ALSA headset output')
const defaultSink = () => execFileSync('pactl', ['get-default-sink'], { encoding: 'utf8' }).trim()
const initialDefault = defaultSink()
const cleanup = process.env.SAME_HEADSET_CLEANUP || (playerUI ? 'source-end' : 'helper-killed')
if (!['helper-killed', 'source-end', 'owner-disconnect'].includes(cleanup))
  throw new Error('Unknown cleanup scenario')
const children = [],
  browsers = [],
  pages = [],
  helpers = [],
  players = [],
  captures = [],
  samples = []
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
const names = ['Alice', 'Bob'],
  frequencies = [440, 997]
const labels = [...names]
const renderSelector = playerUI ? '.listener-mix audio' : '.stream-audio audio'
const runTag = `whiterun-test-${process.pid}`
const meters = [[], []]
const outputs = () =>
  JSON.parse(execFileSync('pactl', ['-f', 'json', 'list', 'sink-inputs'])).filter(
    (stream) =>
      !stream.corked && names.some((_, i) => stream.properties?.['whiterun.test'] === `${runTag}-${i}`),
  )
function gameLinks(g, source) {
  return g
    .filter(
      (n) =>
        n.type.endsWith(':Link') &&
        n.info.state === 'active' &&
        n.info['output-node-id'] === source &&
        n.info['input-node-id'] === physical.id,
    )
    .map((n) => n.info.props['object.serial'])
    .sort()
}
function checkOriginalLinks(g, source) {
  if (JSON.stringify(gameLinks(g, source.sourceID)) !== JSON.stringify(source.originalLinks)) {
    throw new Error('Original game-to-headset links changed')
  }
}
let failure
function child(cmd, args, stdio) {
  const p = spawn(cmd, args, { stdio })
  children.push(p)
  p.on('error', (e) => {
    failure = e
  })
  return p
}
try {
  for (let i = 0; i < 2; i++) {
    const engine = i === 0 ? chromium : firefox
    const browser = await engine.launch({
      headless: !realScreen,
      env: { ...process.env, PULSE_SINK: sink, PULSE_PROP: `whiterun.test=${runTag}-${i}` },
      ignoreDefaultArgs: ['--mute-audio'],
      chromiumSandbox: true,
    })
    browsers.push(browser)
    const context = await browser.newContext()
    process.env.E2E_BUILT_FRONTEND = '1'
    await frontend(context, base)
    if (playerUI) await fixtureAudio(context, `isolation-game-${names[i].toLowerCase()}-${process.pid}`)
    await context.addInitScript(
      ({ realScreen }) => {
        const peers = []
        const Native = RTCPeerConnection
        window.RTCPeerConnection = class extends Native {
          constructor(c) {
            super(c)
            peers.push(this)
          }
        }
        window.__peers = peers
        if (!realScreen)
          navigator.mediaDevices.getDisplayMedia = async () => {
            const canvas = document.createElement('canvas')
            canvas.width = 640
            canvas.height = 360
            const c = canvas.getContext('2d')
            const timer = setInterval(() => {
              c.fillStyle = Date.now() % 2 ? 'green' : 'navy'
              c.fillRect(0, 0, 640, 360)
            }, 50)
            const stream = canvas.captureStream(20)
            stream.getVideoTracks()[0].addEventListener('ended', () => clearInterval(timer))
            return stream
          }
      },
      { realScreen },
    )
    const page = await context.newPage()
    pages.push(page)
    page.setDefaultTimeout(realScreen ? 120000 : 15000)
  }
  if (playerUI) {
    for (const page of pages) {
      await page.goto(base)
      await page.getByRole('button', { name: 'Start sharing' }).waitFor()
    }
  } else {
    const key =
      process.env.E2E_OPERATOR_KEY ||
      readFileSync(new URL('../../.env', import.meta.url), 'utf8').match(/^LOCAL_ADMIN_KEY=(.+)$/m)?.[1]
    await pages[0].goto(new URL('/rooms', base).href)
    await pages[0].getByLabel('Display name').fill('Alice')
    await pages[0].getByLabel('Room title', { exact: true }).fill('Same headset isolation diagnostic')
    await pages[0].getByLabel('Local operator key').fill(key)
    await pages[0].getByRole('button', { name: 'Create and join room' }).click()
    const invitation = await pages[0].getByLabel('Screen publisher invitation').inputValue()
    await pages[1].goto(invitation)
    await pages[1].getByLabel('Display name').fill('Bob')
    await pages[1].getByRole('button', { name: 'Join room', exact: true }).click()
  }
  for (let i = 0; i < 2; i++) {
    const name = `isolation-game-${names[i].toLowerCase()}-${process.pid}`
    const source = child(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=${frequencies[i]}:sample_rate=48000`,
        '-af',
        'volume=0.12',
        '-ac',
        '2',
        '-f',
        's16le',
        'pipe:1',
      ],
      ['ignore', 'pipe', 'ignore'],
    )
    const player = child(
      'pw-cat',
      [
        '--playback',
        '--raw',
        '--target',
        sink,
        '--rate',
        '48000',
        '--channels',
        '2',
        '--format',
        's16',
        '--properties',
        `node.name=${name}`,
        '-',
      ],
      ['pipe', 'ignore', 'ignore'],
    )
    players.push(player)
    source.stdout.pipe(player.stdin)
    player.stdin.on('error', () => {})
    let node
    for (let attempt = 0; attempt < 40 && !node; attempt++) {
      await pause(100)
      node = graph().find((n) => n.info?.props?.['node.name'] === name)
    }
    if (!node) throw new Error('Fixture playback stream did not appear')
    const serial = node.info.props['object.serial']
    const originalLinks = gameLinks(graph(), node.id)
    if (originalLinks.length !== 2) throw new Error('Expected local stereo game playback before capture')
    captures.push({ sourceSerial: serial, sourceID: node.id, name, originalLinks })
    if (realScreen) console.log(`Choose a real desktop for ${names[i]} in its normal picker`)
    await pages[i].getByRole('button', { name: 'Start sharing', exact: true }).click()
    if (playerUI) {
      const page = pages[i]
      labels[i] = (
        await page.locator('.player-tile header strong').filter({ hasText: ' (you)' }).innerText()
      ).replace(' (you)', '')
      const live = page.getByRole('button', { name: 'Sharing audio', exact: true })
      await live.waitFor()
      await live.click()
      if (i === 0) {
        const toggle = page.getByRole('checkbox', { name: 'Share audio' })
        await toggle.uncheck()
        const tapPresent = () =>
          graph().some(
            (n) =>
              n.info?.props?.['node.name']?.startsWith('whiterun-capture-') &&
              String(n.info.props['target.object']) === String(serial),
          )
        const deadline = Date.now() + 10000
        while (tapPresent() && Date.now() < deadline) await pause(100)
        if (tapPresent()) throw new Error('Stopping game audio left its capture active')
        checkOriginalLinks(graph(), captures[i])
        await page.getByRole('button', { name: 'Stop sharing', exact: true }).waitFor()
        await toggle.check()
        await live.waitFor()
      }
    } else {
      await pages[i].getByRole('button', { name: 'Pair native audio helper' }).click()
      const pair = await pages[i].getByLabel('One-time native audio pairing JSON').inputValue()
      const helper = child(
        helperPath,
        ['--start', '--application', String(serial), '--timing-json', resolve(dir, `${names[i]}.jsonl`)],
        ['pipe', 'ignore', 'pipe'],
      )
      helpers.push(helper)
      helper.stderr.on('data', (data) => process.stderr.write(data))
      helper.stdin.end(pair + '\n')
    }
  }
  for (let i = 0; i < 2; i++) {
    const remote = labels[1 - i]
    await pages[i].getByRole('slider', { name: `Volume for ${remote}` }).fill('30')
    if (!playerUI) await pages[i].getByRole('button', { name: `Unmute ${remote}`, exact: true }).click()
    else {
      const enable = pages[i].getByRole('button', { name: 'Enable audio', exact: true })
      if (await enable.isVisible()) await enable.click()
    }
    await pages[i].waitForFunction(
      (selector) => document.querySelector(selector)?.readyState >= 2,
      renderSelector,
    )
  }
  // Tap only test-owned renderers, including any silent auxiliary streams.
  // These downstream measurement nodes are never attached to a physical monitor.
  await pause(1000)
  const listing = execFileSync(helperPath, ['--list-applications'], { encoding: 'utf8' })
  const eligible = new Set(
    listing
      .trim()
      .split('\n')
      .map((line) => line.split('\t')[0]),
  )
  if (captures.some((source) => !eligible.has(String(source.sourceSerial))))
    throw new Error('Game missing from application selector')
  for (const stream of outputs()) {
    const listener = names.findIndex((_, i) => stream.properties['whiterun.test'] === `${runTag}-${i}`)
    const serial = String(stream.properties['object.serial'])
    if (eligible.has(serial)) throw new Error('Application selector offered the room playback stream')
    meters[listener].push(playbackMeter(child, serial, `${runTag}-meter-${serial}`, frequencies))
  }
  if (meters.some((group) => !group.length)) throw new Error('Missing test browser output')
  await pause(500)
  const start = Date.now()
  while (Date.now() - start < seconds * 1000) {
    if (failure) throw failure
    if (helpers.some((h) => h.exitCode !== null || h.signalCode !== null))
      throw new Error('Helper ended prematurely')
    const g = graph()
    const tapNodes = captures.map((source) => {
      checkOriginalLinks(g, source)
      const tap = g.find(
        (n) =>
          n.type.endsWith(':Node') &&
          n.info?.props?.['node.name']?.startsWith('whiterun-capture-') &&
          String(n.info.props['target.object']) === String(source.sourceSerial),
      )
      if (!tap) throw new Error('Missing serial-targeted game capture')
      source.captureSerial ??= tap.info.props['object.serial']
      if (source.captureSerial !== tap.info.props['object.serial'])
        throw new Error('Session capture replaced')
      const inputs = g.filter((n) => n.type.endsWith(':Link') && n.info['input-node-id'] === tap.id)
      if (
        inputs.length !== 2 ||
        inputs.some((l) => l.info.state !== 'active' || l.info['output-node-id'] !== source.sourceID)
      ) {
        throw new Error('Unexpected source or inactive application capture')
      }
      return tap
    })
    const streams = outputs()
    const measurementLinks = new Set()
    for (const meter of meters.flat()) {
      const probe = g.find((n) => n.type.endsWith(':Node') && n.info?.props?.['node.name'] === meter.name)
      const source = g.find(
        (n) => n.type.endsWith(':Node') && String(n.info?.props?.['object.serial']) === meter.serial,
      )
      const inputs = g.filter((n) => n.type.endsWith(':Link') && n.info['input-node-id'] === probe?.id)
      const playing = streams.some((s) => String(s.properties['object.serial']) === meter.serial)
      if (
        inputs.some((l) => l.info['output-node-id'] !== source?.id) ||
        (playing && (inputs.length !== 2 || inputs.some((l) => l.info.state !== 'active')))
      ) {
        throw new Error('Renderer measurement route changed')
      }
      inputs.forEach((l) => measurementLinks.add(l.id))
    }
    if (
      streams.some(
        (s) =>
          s.mute ||
          !meters.flat().some((m) => m.serial === String(s.properties['object.serial'])) ||
          !Object.values(s.volume).every((channel) => channel.value > 0),
      )
    )
      throw new Error('Test browser output muted, replaced or missing')
    const routes = verifyPlaybackLinks(
      g.filter((n) => !measurementLinks.has(n.id)),
      streams,
      sink,
    )
    const captureGraph = g
      .filter((n) => n.type.endsWith(':Link') && tapNodes.some((t) => t.id === n.info?.['input-node-id']))
      .map((n) => ({
        id: n.id,
        source: n.info['output-node-id'],
        capture: n.info['input-node-id'],
        sourcePort: n.info['output-port-id'],
        capturePort: n.info['input-port-id'],
      }))
    const row = { captureGraph, unixMs: Date.now(), elapsedMs: Date.now() - start, routes, browsers: [] }
    for (const page of pages)
      row.browsers.push(
        await page.evaluate(async (selector) => {
          const stats = []
          for (const peer of window.__peers) {
            if (peer.connectionState === 'closed') continue
            const report = await peer.getStats()
            report.forEach((r) => {
              if (r.type === 'inbound-rtp' && r.kind === 'audio')
                stats.push({
                  id: r.id,
                  codec: report.get(r.codecId)?.mimeType,
                  packets: r.packetsReceived,
                  lost: r.packetsLost,
                  emitted: r.jitterBufferEmittedCount,
                  concealed: r.concealedSamples,
                })
            })
          }
          const elements = [...document.querySelectorAll(selector)].map((a) => ({
            paused: a.paused,
            muted: a.muted,
            time: a.currentTime,
            ready: a.readyState,
          }))
          return { stats, elements }
        }, renderSelector),
      )
    samples.push(row)
    if (row.elapsedMs >= 2000)
      for (const b of row.browsers) {
        if (
          b.elements.length !== 1 ||
          b.elements[0].muted ||
          b.elements[0].paused ||
          b.stats.length !== 1 ||
          b.stats[0].codec?.toLowerCase() !== 'audio/opus'
        )
          throw new Error('Expected exactly one playing remote Opus stream')
      }
    await pause(500)
  }
  const end = Date.now(),
    steadyStart = start + 5000
  const steady = samples.filter((row) => row.unixMs >= steadyStart)
  const receivers = names.map((name, i) => {
    const rows = steady.map((row) => row.browsers[i])
    const first = rows[0].stats[0]
    for (let j = 1; j < rows.length; j++) {
      const next = rows[j].stats[0],
        prev = rows[j - 1].stats[0]
      if (
        ![next.lost, next.concealed, next.emitted].every(Number.isFinite) ||
        next.id !== first.id ||
        next.lost !== first.lost ||
        next.concealed !== first.concealed ||
        next.emitted <= prev.emitted ||
        next.packets <= prev.packets ||
        rows[j].elements[0].time <= rows[j - 1].elements[0].time
      ) {
        throw new Error(`Loss, concealment or stalled Opus playback for ${name}`)
      }
    }
    return {
      participant: name,
      codec: first.codec,
      inboundStreams: 1,
      playbackElements: 1,
      lostAt5s: first.lost,
      concealedAt5s: first.concealed,
      lostDelta: 0,
      concealedDelta: 0,
      rendered: measurePlayback(meters[i], i, steadyStart, end),
    }
  })
  // Change Alice's local control and measure both actual browser outputs.
  await pages[0].getByRole('slider', { name: `Volume for ${labels[1]}` }).fill('60')
  await pause(750)
  const gainStart = Date.now()
  await pause(2000)
  const gainEnd = Date.now()
  for (let i = 0; i < 2; i++) {
    const adjusted = measurePlayback(meters[i], i, gainStart, gainEnd)
    const ratio = adjusted.meanLevel / receivers[i].rendered.meanLevel
    if (i === 0 ? ratio < 1.7 || ratio > 2.3 : ratio < 0.9 || ratio > 1.1) {
      throw new Error(`Unexpected listener ${i} gain ratio ${ratio}`)
    }
    receivers[i].measuredGainRatio = ratio
  }
  await pages[0].getByRole('button', { name: 'Stop sharing', exact: true }).click()
  // Alice is still a listener after stopping her game publication.
  const stopDeadline = Date.now() + 10000
  const capturePresent = (source) =>
    graph().some((n) => n.info?.props?.['object.serial'] === source.captureSerial)
  while (
    (playerUI
      ? capturePresent(captures[0])
      : helpers[0].exitCode === null && helpers[0].signalCode === null) &&
    Date.now() < stopDeadline
  )
    await pause(100)
  if (graph().some((n) => n.info?.props?.['object.serial'] === captures[0].captureSerial))
    throw new Error('Normal screen stop left the game tap running')
  const listenStart = Date.now()
  await pause(1600)
  const afterOwnStop = measurePlayback(meters[0], 0, listenStart, Date.now())
  const cleanupStart = Date.now()
  if (cleanup === 'source-end') players[1].kill('SIGTERM')
  else if (cleanup === 'owner-disconnect') await browsers[1].close()
  else if (playerUI) {
    const g = graph()
    const node = g.find((n) => n.info?.props?.['object.serial'] === captures[1].captureSerial)
    const client = g.find((n) => n.type.endsWith(':Client') && n.id === node?.info?.props?.['client.id'])
    const pid = Number(
      client?.info?.props?.['pipewire.sec.pid'] ??
        client?.info?.props?.['application.process.id'] ??
        node?.info?.props?.['application.process.id'],
    )
    if (!Number.isInteger(pid) || pid < 2) throw new Error('Test capture client PID unavailable')
    const parent = Number(readFileSync(`/proc/${pid}/status`, 'utf8').match(/^PPid:\s+(\d+)$/m)?.[1])
    const args = readFileSync(`/proc/${parent}/cmdline`, 'utf8').split('\0')
    if (
      !args.includes('--local-player-capture') ||
      args[args.indexOf('--application') + 1] !== String(captures[1].sourceSerial)
    )
      throw new Error('Cannot identify the test-owned capture child')
    process.kill(parent, 'SIGKILL')
  } else helpers[1].kill('SIGKILL')
  const deadline = cleanupStart + 15000
  while (
    (playerUI
      ? capturePresent(captures[1])
      : helpers.some((h) => h.exitCode === null && h.signalCode === null)) &&
    Date.now() < deadline
  )
    await pause(100)
  const cleanupWaitMs = Date.now() - cleanupStart
  const after = graph()
  if (
    helpers.some((h) => h.exitCode === null && h.signalCode === null) ||
    after.some((n) => captures.some((c) => c.captureSerial === n.info?.props?.['object.serial']))
  )
    throw new Error('Capture survived teardown')
  for (const c of cleanup === 'source-end' ? captures.slice(0, 1) : captures) checkOriginalLinks(after, c)
  if (defaultSink() !== initialDefault) throw new Error('Default output changed')
  let helperRestarted = false
  if (playerUI && cleanup !== 'owner-disconnect') {
    const bob = pages[1]
    await bob.getByRole('button', { name: 'Stop sharing', exact: true }).waitFor()
    if (cleanup === 'source-end') {
      await bob.getByRole('button', { name: 'Waiting for audio source', exact: true }).waitFor()
    } else {
      const target = () =>
        graph().filter(
          (n) =>
            n.info?.props?.['node.name']?.startsWith('whiterun-capture-') &&
            String(n.info.props['target.object']) === String(captures[1].sourceSerial),
        )
      const recoveryDeadline = Date.now() + 30000
      while (!target().length && Date.now() < recoveryDeadline) await pause(150)
      const restored = target()
      if (restored.length !== 1 || restored[0].info.props['object.serial'] === captures[1].captureSerial)
        throw new Error('Helper failed to restart on the original game')
      await bob.getByRole('button', { name: 'Sharing audio', exact: true }).waitFor()
      await pages[0].waitForFunction((selector) => {
        const els = document.querySelectorAll(selector)
        return els.length === 1 && els[0].readyState >= 2 && !els[0].paused
      }, renderSelector)
      helperRestarted = true
      await bob.getByRole('button', { name: 'Stop sharing', exact: true }).click()
      const stopDeadline = Date.now() + 10000
      while (target().length && Date.now() < stopDeadline) await pause(100)
      if (target().length) throw new Error('Restarted helper survived screen stop')
    }
  }
  const rtp = playerUI
    ? undefined
    : names.map((name) => measureRTP(readFileSync(resolve(dir, `${name}.jsonl`), 'utf8'), steadyStart, end))
  const result = {
    sink,
    defaultOutput: initialDefault,
    seconds,
    screen: realScreen ? 'desktop' : 'synthetic',
    startedUtc: new Date(start).toISOString(),
    browsers: browsers.map((b) => b.version()),
    entry: playerUI ? 'local player and desktop launcher' : 'invitation and CLI',
    logicalParticipantsOnOneHost: true,
    listeningValidated: false,
    cleanupScenario: cleanup,
    ...(playerUI
      ? { automaticAudio: true, helperRestarted, sourceCatalog: 'participant-specific real fixture' }
      : {}),
    afterOwnStop,
    cleanupVerified: true,
    cleanupWaitMs,
    sourceNodes: captures,
    samples: samples.length,
    receivers,
    rtp,
    exampleGraph: { inputLinks: steady[0].captureGraph, playbackLinks: steady[0].routes },
  }
  writeFileSync(resolve(dir, 'run.json'), JSON.stringify(result, null, 2))
  console.log('RESULT_DIRECTORY', dir)
} catch (e) {
  writeFileSync(
    resolve(dir, 'failure-graph.json'),
    JSON.stringify(
      graph()
        .filter((n) => n.type.endsWith(':Link') || n.type.endsWith(':Node'))
        .map((n) => ({
          id: n.id,
          type: n.type,
          info: n.type.endsWith(':Link')
            ? n.info
            : {
                props: {
                  'node.name': n.info?.props?.['node.name'],
                  'object.serial': n.info?.props?.['object.serial'],
                },
              },
        })),
      null,
      2,
    ),
  )
  writeFileSync(
    resolve(dir, 'failure.json'),
    JSON.stringify({ message: e.message, listeningValidated: false }),
  )
  throw e
} finally {
  for (const h of helpers) if (h.exitCode === null) h.kill('SIGTERM')
  for (const page of playerUI ? [] : pages) {
    try {
      await page.getByRole('button', { name: 'Leave room', exact: true }).click()
    } catch {}
  }
  // A fixture encoder can block on stdout after its selected player is stopped.
  // Close our pipe ends and bound termination; never leave a generator running.
  for (const p of children) {
    p.stdin?.destroy()
    p.stdout?.destroy()
    p.stderr?.destroy()
    if (p.exitCode === null && p.signalCode === null) p.kill('SIGTERM')
  }
  await Promise.all(
    children.map(
      (p) =>
        new Promise((done) => {
          if (p.exitCode !== null || p.signalCode !== null) return done()
          const timer = setTimeout(() => p.kill('SIGKILL'), 1000)
          p.once('close', () => {
            clearTimeout(timer)
            done()
          })
        }),
    ),
  )
  for (const browser of browsers) await browser.close()
  writeFileSync(resolve(dir, 'receivers.json'), JSON.stringify(samples))
  writeFileSync(resolve(dir, 'rendered-levels.json'), JSON.stringify(meters))
}
