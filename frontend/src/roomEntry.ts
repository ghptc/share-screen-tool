// Only navigation metadata goes in this history entry. A new visit from Discord
// starts without it. Authentication always comes from the HttpOnly cookie.
type Entry = { channel: string; key: string; deadline?: number; ended?: boolean }
function save<T extends Entry>(entry: T): T {
  history.replaceState({ ...history.state, whiterunEntry: entry }, '')
  return entry
}
export function roomEntry(channel: string): Entry {
  const entry = history.state?.whiterunEntry
  return entry?.channel === channel ? entry : save({ channel, key: crypto.randomUUID() })
}
export function rememberDeadline(entry: Entry, expiresAt: string, serverTime: string, requestedAt: number) {
  const remaining = Date.parse(expiresAt) - Date.parse(serverTime)
  if (!Number.isFinite(remaining) || remaining < 0 || remaining > 36_000_000)
    throw Error('Invalid room deadline')
  // A lost response or refresh must never extend the same navigation's lease.
  return save({ ...entry, deadline: Math.min(entry.deadline ?? Infinity, requestedAt + remaining) })
}
export function endRoomEntry(entry: Entry) {
  save({ ...entry, ended: true })
}
