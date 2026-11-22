import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import type { TrackPublication } from 'livekit-client'
import RemoteScreenAudio from './RemoteScreenAudio'

function publication() {
  const track = { attach: vi.fn(), detach: vi.fn(), mediaStreamTrack: { readyState: 'live' } }
  return { track, pub: { audioTrack: track, isMuted: false } as unknown as TrackPublication }
}
let play: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
})
test('multiple sources have independent volume and mute choices and default to muted', async () => {
  const bob = publication(), carol = publication()
  render(<><RemoteScreenAudio owner="Bob" publication={bob.pub} connected /><RemoteScreenAudio owner="Carol" publication={carol.pub} connected /></>)
  const b = screen.getByLabelText('Bob audio playback') as HTMLAudioElement
  const c = screen.getByLabelText('Carol audio playback') as HTMLAudioElement
  expect(b.muted).toBe(true); expect(c.muted).toBe(true)
  fireEvent.change(screen.getByRole('slider', { name: 'Volume for Bob' }), { target: { value: '23' } })
  expect(b.volume).toBe(.23); expect(c.volume).toBe(1)
  fireEvent.click(screen.getByRole('button', { name: 'Unmute Bob' }))
  await waitFor(() => expect(screen.getByText('Audio enabled')).toBeInTheDocument())
  expect(b.muted).toBe(false); expect(c.muted).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Mute Bob' }))
  expect(b.muted).toBe(true); expect(b.volume).toBe(.23)
})
test('autoplay rejection provides an explicit retry and recovers', async () => {
  const bob = publication(); play.mockRejectedValueOnce(new DOMException('Blocked', 'NotAllowedError'))
  render(<RemoteScreenAudio owner="Bob" publication={bob.pub} connected />)
  fireEvent.click(screen.getByRole('button', { name: 'Unmute Bob' }))
  expect(await screen.findByText('Playback blocked')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Enable audio for Bob' }))
  expect(await screen.findByText('Audio enabled')).toBeInTheDocument()
  expect(play).toHaveBeenCalledTimes(2)
})
test('reconnection and track replacement preserve preferences without duplicate playback', async () => {
  const bob = publication(), replacement = publication()
  const { rerender, unmount } = render(<RemoteScreenAudio owner="Bob" publication={bob.pub} connected />)
  fireEvent.change(screen.getByRole('slider'), { target: { value: '37' } })
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Unmute Bob' })))
  const element = screen.getByLabelText('Bob audio playback') as HTMLAudioElement
  rerender(<RemoteScreenAudio owner="Bob" publication={undefined} connected={false} />)
  expect(bob.track.detach).toHaveBeenCalledWith(element)
  expect(element.srcObject).toBeNull()
  rerender(<RemoteScreenAudio owner="Bob" publication={replacement.pub} connected />)
  await waitFor(() => expect(replacement.track.attach).toHaveBeenCalledOnce())
  const recovered = screen.getByLabelText('Bob audio playback') as HTMLAudioElement
  expect(element.isConnected).toBe(false)
  expect(recovered.muted).toBe(false); expect(recovered.volume).toBe(.37)
  expect(document.querySelectorAll('audio')).toHaveLength(1)
  unmount(); expect(replacement.track.detach).toHaveBeenCalledWith(recovered)
})
test('missing audio and delayed subscription are explicit', () => {
  const { rerender } = render(<RemoteScreenAudio owner="Bob" connected />)
  expect(screen.getByText('No screen audio')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Unmute Bob' })).toBeDisabled()
  rerender(<RemoteScreenAudio owner="Bob" publication={{ isMuted: false } as TrackPublication} connected />)
  expect(screen.getByText('Waiting for screen audio')).toBeInTheDocument()
})

test('same-computer native feedback warning preserves independent listener consent',async()=>{
 const bob=publication()
 render(<RemoteScreenAudio owner="Bob" publication={bob.pub} connected ownerIdentity="participant-owner" publisherIdentity="native-audio-helper" />)
 expect(screen.getByText(/Same-headset listening/)).toBeInTheDocument()
 expect(screen.getByText('Screen owner identity').nextElementSibling).toHaveTextContent('participant-owner')
 expect(screen.getByText('Audio publisher identity').nextElementSibling).toHaveTextContent('native-audio-helper')
 fireEvent.click(screen.getByRole('button',{name:'Unmute Bob'}))
 await waitFor(()=>expect(screen.getByRole('button',{name:'Mute Bob'})).toBeEnabled())
 expect((screen.getByLabelText('Bob audio playback') as HTMLAudioElement).muted).toBe(false)
})

test('player offers one autoplay gesture and preserves each listener preference after republication', async () => {
  const { default: PlayerStage } = await import('./PlayerStage')
  const bob = publication(), carol = publication()
  const props = {screens:[], connected:true, sharing:false, busy:'', canPublish:true, error:'', start:vi.fn(), stop:vi.fn()}
  const peers = [{identity:'b',owner:'Bob',publication:bob.pub},{identity:'c',owner:'Carol',publication:carol.pub}]
  play.mockRejectedValue(new DOMException('Needs gesture','NotAllowedError'))
  const {rerender} = render(<PlayerStage {...props} peers={peers}/>)
  const enable = await screen.findByRole('button',{name:'Enable audio'})
  fireEvent.click(screen.getByRole('button',{name:'Audio'}))
  const bobAudio = screen.getByLabelText('Bob audio playback') as HTMLAudioElement
  const carolAudio = screen.getByLabelText('Carol audio playback') as HTMLAudioElement
  fireEvent.change(screen.getByRole('slider',{name:'Volume for Bob'}),{target:{value:'23'}})
  fireEvent.click(screen.getByRole('button',{name:'Mute Bob'}))
  play.mockClear().mockResolvedValue(undefined)
  fireEvent.click(enable)
  expect(play.mock.instances).toEqual([carolAudio])
  fireEvent.playing(carolAudio)
  expect(screen.queryByRole('button',{name:'Enable audio'})).toBeNull()
  rerender(<PlayerStage {...props} peers={[{...peers[0],publication:undefined},peers[1]]}/>)
  rerender(<PlayerStage {...props} peers={peers}/>)
  expect(bobAudio.isConnected).toBe(false)
  const newBob = screen.getByLabelText('Bob audio playback') as HTMLAudioElement
  expect(newBob.muted).toBe(true)
  expect(newBob.volume).toBe(.23)
  expect(carolAudio.muted).toBe(false)
})
