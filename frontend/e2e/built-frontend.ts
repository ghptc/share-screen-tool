import type { BrowserContext } from '@playwright/test'
import { readFile } from 'node:fs/promises'

export async function frontend(context: BrowserContext, baseURL: string) {
  if (process.env.E2E_BUILT_FRONTEND !== '1') return
  // Keep the real document response/address space and all API/WebRTC requests.
  // Only these test contexts load the fixed built entry and its CSS, so the
  // running publisher receives neither an HMR update nor a frontend restart.
  const html = await readFile(new URL('../dist/index.html', import.meta.url), 'utf8')
  const entry = html.match(/src="(\/assets\/[A-Za-z0-9_.-]+\.js)"/)?.[1]
  const styles = [...html.matchAll(/href="(\/assets\/[A-Za-z0-9_.-]+\.css)"/g)].map(match => match[1])
  if (!entry) throw new Error('Build the frontend before E2E_BUILT_FRONTEND=1')
  const origin = new URL(baseURL).origin
  await context.route(`${origin}/**`, async route => {
    const path = new URL(route.request().url()).pathname
    if (route.request().method() !== 'GET') return route.continue()
    if (path === '/src/main.tsx') {
      const css = `${JSON.stringify(styles)}.forEach(href => { const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = href; document.head.appendChild(link); });\n`
      await route.fulfill({ status: 200, contentType: 'text/javascript', body: css + await readFile(new URL(`../dist${entry}`, import.meta.url), 'utf8') })
    } else if (/^\/assets\/[A-Za-z0-9_.-]+$/.test(path)) {
      await route.fulfill({ status: 200, contentType: path.endsWith('.css') ? 'text/css' : 'text/javascript', body: await readFile(new URL(`../dist${path}`, import.meta.url)) })
    } else await route.continue()
  })
}
