import { localPlayer } from './local-player.ts'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react(), localPlayer()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        ws: true,
        target: process.env.API_PROXY_TARGET || 'http://127.0.0.1:8080',
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  test: {
    environment: 'jsdom',
    exclude: ['e2e/**', 'node_modules/**'],
    setupFiles: ['./src/test-setup.ts'],
    restoreMocks: true,
  },
})
