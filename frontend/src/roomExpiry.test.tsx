import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import App from './App'

vi.mock('./CloudflareStage', () => ({ default: () => <div>Connected screen</div> }))
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  history.replaceState(null, '', '/')
})

test('expiry ends the player at 36,000 seconds and a reload of that entry makes no request', async () => {
  vi.useFakeTimers()
  const start = Date.UTC(2026, 0, 1)
  vi.setSystemTime(start)
  const url = '/r/' + 'a'.repeat(32)
  history.replaceState(null, '', url)
  const join = vi.fn(() =>
    Promise.resolve(
      Response.json({
        transport: 'cloudflare-prototype',
        identity: 'peer',
        expiresAt: new Date(start + 36_000_000),
        serverTime: new Date(start),
      }),
    ),
  )
  vi.stubGlobal('fetch', join)
  const player = render(<App />)
  expect(screen.getByRole('main', { name: 'Screen Share player' })).toBeInTheDocument()
  expect(screen.queryByRole('heading', { level: 1 })).toBeNull()
  await act(() => vi.advanceTimersByTimeAsync(0))
  expect(screen.getByText('Connected screen')).toBeInTheDocument()
  await act(() => vi.advanceTimersByTimeAsync(35_999_999))
  expect(screen.getByText('Connected screen')).toBeInTheDocument()
  await act(() => vi.advanceTimersByTimeAsync(1))
  expect(screen.getByText('Session expired')).toBeInTheDocument()
  expect(screen.queryByText('Connected screen')).toBeNull()
  expect(screen.getByRole('link', { name: 'Sign in with Discord' })).toHaveAttribute('href', '/api/discord/auth/' + 'a'.repeat(32))
  player.unmount()
  render(<App />)
  await act(() => vi.advanceTimersByTimeAsync(600_000))
  expect(screen.getByText('Session expired')).toBeInTheDocument()
  expect(join).toHaveBeenCalledTimes(1)
  cleanup()
  history.pushState(null, '', url)
  render(<App />)
  await act(() => vi.advanceTimersByTimeAsync(0))
  expect(join).toHaveBeenCalledTimes(2)
})
