import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import App from './InvitationRooms'

afterEach(() => vi.unstubAllGlobals())

test('reports independent backend and SFU health and retries', async () => {
  const fetchMock = vi.fn().mockImplementation((path: string) => Promise.resolve({
    ok: path === '/api/healthz',
    json: () => Promise.resolve(path === '/api/healthz' ? { status: 'ok' } : { livekit: 'unreachable' }),
  }))
  vi.stubGlobal('fetch', fetchMock)
  render(<App />)
  expect(await screen.findByText('available')).toBeInTheDocument()
  expect(await screen.findByText('unavailable')).toBeInTheDocument()
  fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve({ status: 'ok', livekit: 'reachable' }) })
  fireEvent.click(screen.getByRole('button', { name: 'Check services again' }))
  await waitFor(() => expect(screen.getAllByText('available')).toHaveLength(2))
})

test('handles network failures without implying streaming works', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
  render(<App />)
  await waitFor(() => expect(screen.getAllByText('unavailable')).toHaveLength(2))
  expect(screen.getByText(/Capture starts only from Start sharing/)).toBeInTheDocument()
})

test('rejects a successful HTTP response with an invalid health payload', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) }))
  render(<App />)
  await waitFor(() => expect(screen.getAllByText('unavailable')).toHaveLength(2))
})
