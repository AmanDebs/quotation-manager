import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

/**
 * Lint rules for the web app.
 *
 * This exists for one rule in particular. `react-hooks/rules-of-hooks` catches
 * a hook called below an early return — which renders on some passes and not
 * others, so React sees the hook order change and unmounts the whole page. That
 * shipped once and turned every existing document into a blank screen; neither
 * `tsc` nor the production build says a word about it, because it is not a type
 * error and not a syntax error. A linter is the only thing that catches it
 * before a person does.
 *
 * Deliberately narrow. Style is not policed here: the value is in the rules
 * that catch a broken page, and a wall of formatting complaints is how a lint
 * step gets ignored.
 */
export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      // The two that matter, both errors: a violation is a broken page, not a
      // matter of taste.
      'react-hooks/rules-of-hooks': 'error',
      // A stale closure reads yesterday's state and shows a figure that is
      // quietly wrong, which on this app means money. Warn rather than error:
      // several existing effects opt out on purpose with an eslint-disable and
      // a comment saying why.
      'react-hooks/exhaustive-deps': 'warn',

      // Unused code is worth knowing about, but an underscore prefix is how
      // this codebase already says "destructured to drop it" — see the
      // document forms peeling server-only fields off before editing.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // `any` appears where pdfmake and the SQLite rows are cast at a
      // boundary; those are considered, not accidental.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  }
);
