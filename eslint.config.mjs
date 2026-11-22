// Lint catches what the typecheck can't. `npm run lint` runs it; `npm run check` includes it.
// Both workspaces get the type-aware rules for async mistakes and unhandled cases; the web app also
// gets React's hooks rules.
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

const typeAware = {
  // A promise nobody awaits or catches: on the server an unhandled rejection stops the process, and in
  // the browser it fails without a word. Await it, .catch it, or mark it `void` when it can't reject.
  '@typescript-eslint/no-floating-promises': 'error',
  // A switch over a union handles every member, or says why not with a default.
  '@typescript-eslint/switch-exhaustiveness-check': ['error', { considerDefaultExhaustiveForUnions: true }],
  // Data from outside (Hermes, the speech service, the browser, other services) is parsed with zod
  // where it enters; past that, types are trusted. `any` would let unchecked data through.
  '@typescript-eslint/no-explicit-any': 'error',
};

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'web/src/avatar/shapes.gen.ts', 'speech/**', 'tests/**', '.tmp/**'] },
  {
    files: ['server/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { project: ['server/tsconfig.json', 'server/test/tsconfig.json'], tsconfigRootDir: import.meta.dirname },
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: typeAware,
  },
  {
    files: ['web/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { project: ['web/tsconfig.json', 'web/tsconfig.sw.json'], tsconfigRootDir: import.meta.dirname },
    },
    plugins: { '@typescript-eslint': tseslint.plugin, 'react-hooks': reactHooks },
    rules: {
      ...typeAware,
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
);
