// @ts-check
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist/**', '.vercel/**', 'node_modules/**', 'examples/**/dist/**', 'examples/**/node_modules/**', '**/._*'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // The tombstone service worker runs in a ServiceWorkerGlobalScope, which
    // shares none of its globals with the browser or Node configs above.
    files: ['examples/memory-host/public/sw.js'],
    languageOptions: {
      globals: { self: 'readonly', caches: 'readonly', clients: 'readonly' },
    },
  },
  {
    rules: {
      // The engine reads optional protocol fields defensively; `_`-prefixed
      // names are the conventional "deliberately unused".
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
)
