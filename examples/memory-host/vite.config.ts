import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const pkg = (path: string) => fileURLToPath(new URL(`../../src/${path}`, import.meta.url))

// Resolve the package from source so the example runs with no build step.
// A real host installs `@sqrdao/live-translate` and drops this alias block.
export default defineConfig({
  resolve: {
    alias: {
      '@sqrdao/live-translate/server': pkg('server/index.ts'),
      '@sqrdao/live-translate/lang/en-vi': pkg('lang/en-vi.ts'),
      '@sqrdao/live-translate': pkg('index.ts'),
    },
  },
  server: {
    proxy: { '/api': 'http://localhost:3001' },
  },
})
