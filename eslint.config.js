// @ts-check
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'examples/**/dist/**', 'examples/**/node_modules/**', '**/._*'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // The engine reads optional protocol fields defensively; `_`-prefixed
      // names are the conventional "deliberately unused".
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
)
