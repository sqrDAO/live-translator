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
      '@sqrdao/live-translate/lang/en-zh': pkg('lang/en-zh.ts'),
      '@sqrdao/live-translate/lang/vi-zh': pkg('lang/vi-zh.ts'),
      '@sqrdao/live-translate': pkg('index.ts'),
    },
  },
  server: {
    proxy: { '/api': 'http://localhost:3001' },
    // The page imports `api/_context.ts` by relative path so the panel can run
    // the server's own reader. Alias targets are allowed automatically; a
    // relative import outside this folder is not, and the dev server answers
    // it with 403 (the production build has no such check, so CI passes).
    // Only the folders the page actually reads from, never the repo root, which
    // holds the `.env` with the API key.
    fs: {
      allow: ['.', '../../src', '../../api'].map((dir) => fileURLToPath(new URL(dir, import.meta.url))),
    },
  },
})
