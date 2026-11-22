import type { BrowserContext } from '@playwright/test'

declare global {
  interface Window {
    __fullAudioRegistry?: boolean
  }
}

// Two test participants can share a physical machine. Limit each test view
// to its own live PipeWire fixtures after the genuine authenticated fetch.
export async function fixtureAudio(context: BrowserContext, prefix: string) {
  await context.addInitScript((prefix) => {
    const fetch = window.fetch.bind(window)
    let fixtures = new Set<string>()
    window.fetch = async (input, options) => {
      const path = new URL(input instanceof Request ? input.url : input.toString(), location.href).pathname
      const selection = path === '/player/start' ? JSON.parse(String(options?.body)) : null
      if (selection && [selection.source, ...(selection.additional ?? [])].some(id => !fixtures.has(id))) {
        throw new Error('Test attempted to capture an unrelated application')
      }
      const response = await fetch(input, options)
      if (path !== '/player/sources' || !response.ok) return response
      const sources = await response.clone().json()
      const owned = sources.filter((s: { detail: string }) => s.detail.startsWith(prefix))
      fixtures = new Set(owned.map((s: { id: string }) => s.id))
      return window.__fullAudioRegistry ? response : Response.json(owned)
    }
  }, prefix)
}
