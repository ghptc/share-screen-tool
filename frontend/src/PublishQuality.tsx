import { resolutions, type VideoTarget } from './videoQuality'

type Props = {
  value: VideoTarget
  contentControl?: boolean
  settings?: MediaTrackSettings
  busy: boolean
  sharing: boolean
  onChange: (value: VideoTarget) => void
}

export default function PublishQuality({ value, settings, busy, sharing, onChange, contentControl }: Props) {
  return <>
    {contentControl && <label>Content preference <select disabled={busy} value={value.content ?? ''}
      onChange={e => onChange({ ...value, content: e.target.value as VideoTarget['content'] })}>
      <option value="">Automatic</option><option value="detail">Desktop and text · preserve resolution</option>
      <option value="motion">Games and motion · preserve frame rate</option>
    </select></label>}
    <label>Publish FPS <select value={value.fps} disabled={busy} onChange={e => onChange({...value, fps: Number(e.target.value)})}>
      {[60, 30, 15].map(fps => <option key={fps}>{fps}</option>)}
    </select></label>
    <label>Publish resolution <select value={value.height} disabled={busy || !sharing} onChange={e => onChange({...value, height: Number(e.target.value)})}>
      <option value={0}>Native</option>
      {resolutions(settings).map(h => <option value={h} key={h}>{h}p</option>)}
    </select></label>
  </>
}
