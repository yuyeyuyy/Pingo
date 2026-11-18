import { builtinModules } from 'node:module'
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import prettier from 'eslint-config-prettier'

const systemImports = ['node:*', 'electron', 'electron/*']

export default [
  { ignores: ['out/**', 'dist/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      'no-restricted-imports': [
        'error',
        {
          paths: builtinModules,
          patterns: [
            ...systemImports,
            '**/main/**',
            '**/preload/**',
            '**/infrastructure/**',
            '**/application/**',
            '**/domain/**',
          ],
        },
      ],
    },
  },
  {
    files: ['src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex:
                '^(?!\\./|\\.\\./)|(?:^|/)(application|infrastructure|main|preload|renderer|shared)/',
            },
          ],
        },
      ],
    },
  },
  prettier,
]
