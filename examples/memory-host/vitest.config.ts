import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const pkg = (path: string) => fileURLToPath(new URL(`../../src/${path}`, import.meta.url))

/**
 * The example's own suite, run from this directory (`npm test`, as the README
 * says). The root config covers these files too when the whole repo is tested;
 * this one exists so the documented command works on its own.
 *
 * It resolves the package from source for the same reason `vite.config.ts`
 * does — no build step — and carries the root's AppleDouble exclude, without
 * which `._memory-sink.test.ts` is handed to esbuild as if it were TypeScript.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@sqrdao/live-translate/server': pkg('server/index.ts'),
      '@sqrdao/live-translate/lang/en-vi': pkg('lang/en-vi.ts'),
      '@sqrdao/live-translate': pkg('index.ts'),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    // macOS AppleDouble sidecars on this exFAT/SMB volume; never source.
    exclude: ['**/node_modules/**', '**/dist/**', '**/._*'],
    environment: 'node',
    globals: false,
  },
})
