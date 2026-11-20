// Lint catches what the typecheck can't. `npm run lint` runs it; `npm run check` includes it.
// Server: type-aware rules for async mistakes and unhandled cases. Web: hooks rules (the web app is
// on TypeScript 7, which typescript-eslint's type information doesn't support yet).
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'web/src/avatar/shapes.gen.ts', 'speech/**', 'tests/**'] },
  {
    files: ['server/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { project: ['server/tsconfig.json', 'server/test/tsconfig.json'], tsconfigRootDir: import.meta.dirname },
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      // An unhandled rejection stops the server: await a promise, .catch it, or mark it `void` on purpose.
      '@typescript-eslint/no-floating-promises': 'error',
      // A switch over a union handles every member, or says why not with a default.
      '@typescript-eslint/switch-exhaustiveness-check': ['error', { considerDefaultExhaustiveForUnions: true }],
    },
  },
  {
    files: ['web/**/*.{ts,tsx}'],
    languageOptions: { parser: tseslint.parser },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
);
