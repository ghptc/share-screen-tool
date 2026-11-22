import AudioDiagnostics from './AudioDiagnostics'
import { useEffect, useRef, useState } from 'react'
import type { TrackPublication } from 'livekit-client'

// One renderer per remote identity preserves listener choices across video replacement.
export default function RemoteScreenAudio({ owner, publication, connected, ownerIdentity, publisherIdentity, player = false, reportBlocked }: { owner: string; publication?: TrackPublication; connected: boolean; ownerIdentity?: string; publisherIdentity?: string; player?: boolean; reportBlocked?: (id: string, blocked: boolean) => void }) {
  const element = useRef<HTMLAudioElement>(null)
  const [muted, setMuted] = useState(!player)
  const [volume, setVolume] = useState(1)
  const [blocked, setBlocked] = useState(false)
  const [playbackError, setPlaybackError] = useState('')
  const preferences = useRef({ muted, volume })
  preferences.current = { muted, volume }
  const track = publication?.audioTrack
  const latestTrack = useRef(track)
  latestTrack.current = track
  useEffect(() => {
    const audio = element.current
    if (!audio || !track) { setBlocked(false); return }
    let current = true
    audio.muted = true
    track.attach(audio)
    audio.volume = preferences.current.volume
    audio.muted = preferences.current.muted
    if (!audio.muted) void audio.play().then(() => { if (current) setBlocked(false) }).catch(cause => { if (current) { setBlocked(true); setPlaybackError(cause instanceof Error ? `${cause.name}: ${cause.message}` : 'Playback request failed') } })
    return () => { current = false; audio.muted = true; audio.pause(); track.detach(audio); audio.srcObject = null }
  }, [track])
  useEffect(() => {
    if (!reportBlocked || !ownerIdentity) return
    reportBlocked(ownerIdentity, blocked && !muted)
    return () => reportBlocked(ownerIdentity, false)
  }, [blocked, muted, ownerIdentity, reportBlocked])
  async function toggle() {
    const audio = element.current
    if (!audio || !track) return
    if (!muted && (player || !blocked)) { audio.muted = true; setMuted(true); setBlocked(false); return }
    audio.muted = false; audio.volume = volume; setMuted(false); setPlaybackError('')
    try { await audio.play(); if (element.current === audio && latestTrack.current === track) setBlocked(false) }
    catch (cause) { if (element.current === audio && latestTrack.current === track) { setBlocked(true); setPlaybackError(cause instanceof Error ? `${cause.name}: ${cause.message}` : 'Playback request failed') } }
  }
  const status = !connected ? 'Audio reconnecting' : !publication ? 'No screen audio' : !track ? 'Waiting for screen audio' : publication.isMuted ? 'Publisher muted audio' : track.mediaStreamTrack.readyState === 'ended' ? 'Audio ended' : blocked ? 'Playback blocked' : muted ? 'Muted locally' : 'Audio enabled'
  if (player) return <div className="listener-mix" hidden={!publication} aria-label={`${owner} audio`}>
    {track && <audio ref={element} aria-label={`${owner} audio playback`} onPlaying={()=>setBlocked(false)}/>}
    <label>{owner}<input aria-label={`Volume for ${owner}`} type="range" min="0" max="100" value={Math.round(volume*100)} onChange={e=>{
      const next=Number(e.target.value)/100;setVolume(next);if(element.current)element.current.volume=next
    }}/></label>
    <button disabled={!track} aria-label={`${muted?'Unmute':'Mute'} ${owner}`} onClick={()=>void toggle()}>{muted?'Unmute':'Mute'}</button>
  </div>
  return <section aria-label={`${owner} audio`} className="stream-audio">
    <strong>{owner} screen audio</strong>
    {track && <audio ref={element} aria-label={`${owner} audio playback`} />}
    <span role="status">{status}</span>
    <button disabled={!track} onClick={() => void toggle()}>{blocked ? `Enable audio for ${owner}` : `${muted ? 'Unmute' : 'Mute'} ${owner}`}</button>
    <label>Volume for {owner}<input type="range" min="0" max="100" value={Math.round(volume * 100)} onChange={event => { const next = Number(event.target.value) / 100; setVolume(next); if (element.current) element.current.volume = next }} /></label>
    {publisherIdentity?.startsWith('native-audio-') && <p className="note">Same-headset listening: select the local game/application in the native helper. Its capture excludes this remote playback. Whole-output monitor capture is a diagnostic mode that can relay remote audio.</p>}
    <AudioDiagnostics track={track} connected={connected} publication={publication} audio={element} ownerIdentity={ownerIdentity} publisherIdentity={publisherIdentity} />
    {blocked && <p>Browser playback was blocked. Choose Enable audio to retry. {playbackError}</p>}
  </section>
}
