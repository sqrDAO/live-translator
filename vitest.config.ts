import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const src = (path: string) => fileURLToPath(new URL(`./src/${path}`, import.meta.url))

/**
 * The whole suite runs with no network, no credentials and no emulator: every
 * socket is a stub behind the `createSocket` seam, every clock is fake or
 * injected, and the token exchange takes an injected `fetch`.
 */
export default defineConfig({
  resolve: {
    // The example host imports the package by name; resolve it from source so
    // its suite runs without a build step.
    alias: {
      '@sqrdao/live-translate/server': src('server/index.ts'),
      '@sqrdao/live-translate/lang/en-vi': src('lang/en-vi.ts'),
      '@sqrdao/live-translate': src('index.ts'),
    },
  },
  test: {
    include: ['test/**/*.test.ts', 'examples/**/test/**/*.test.ts'],
    // macOS AppleDouble sidecars on this exFAT/SMB volume; never source.
    exclude: ['**/node_modules/**', '**/dist/**', '**/._*'],
    environment: 'node',
    globals: false,
  },
})
