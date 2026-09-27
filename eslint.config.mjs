import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/*.tsbuildinfo', '**/contract.lock.json'] },
  js.configs.recommended,
  // Registers the plugin and the base rule set, forced to TS files only.
  // Applying type-aware rules to .mjs with checkJs off makes every value `any`
  // and buries real findings under noise.
  ...tseslint.configs.recommendedTypeChecked.map((c) => ({ ...c, files: c.files ?? ['**/*.ts'] })),
  {
    // Type-aware rules only where types actually exist. Applying them to .mjs
    // with checkJs off makes every value `any` and produces 60 lines of noise.
    files: ['**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        // An explicit project list rather than projectService: the package
        // tsconfig intentionally excludes test/, but the tests are exactly
        // where type-aware linting is most valuable. tsconfig.check.json is the
        // project that covers src, test, tools and scripts.
        project: ['./tsconfig.check.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Unused args are usually a signature that has not caught up with a
      // refactor. Prefix with _ to opt out.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Type assertions are how you defeat the narrowing in guards.ts. They are
      // allowed, but each one has to be a considered decision.
      '@typescript-eslint/consistent-type-assertions': [
        'error',
        { assertionStyle: 'as', objectLiteralTypeAssertions: 'never' },
      ],
      // Anything a lossy stage could do with `any` silently defeats the
      // unrepresentability guarantee the whole design rests on.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
  {
    files: ['**/*.mjs', '**/*.cjs'],
    languageOptions: { globals: { ...globals.node }, sourceType: 'module' },
  },
  {
    // Tests and dev tools legitimately reach past the type system.
    files: ['**/test/**/*.ts', 'tools/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      // node:test's test() returns a promise that the runner owns; a rejection
      // is already surfaced as a failed test, so awaiting it adds nothing.
      '@typescript-eslint/no-floating-promises': 'off',
    },
  },
  {
    files: ['**/test/**/*.ts', 'tools/**/*.ts', 'scripts/**/*.mjs'],
    rules: { 'no-console': 'off' },
  },
);
