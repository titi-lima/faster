import antfu, { GLOB_SRC } from '@antfu/eslint-config'

export default antfu(
  {
    // Disable tests rules because we need to test with various setup
    test: false,
    ignores: [
      '**/coverage',
      '**/*.snap',
      '**/fixtures',
      '**/*.d.ts',
      '**/*.timestamp-*',
      'research/work/**',
      'research/artifacts/**',
      'test/faster-compat/holdout/results/**',
      'test/faster-compat/holdout/.work/**',
      'test/faster-compat/hosts/**',
      'test/faster-compat/.pack/**',
      'test/faster-compat/.fork/**',
    ],
  },
  {
    rules: {
      // prefer global Buffer to not initialize the whole module
      'node/prefer-global/buffer': 'off',
      'node/prefer-global/process': 'off',
      'no-empty-pattern': 'off',
      'antfu/indent-binary-ops': 'off',
      'unused-imports/no-unused-imports': 'error',
      'pnpm/json-enforce-catalog': 'off',
      'style/member-delimiter-style': [
        'error',
        {
          multiline: { delimiter: 'none' },
          singleline: { delimiter: 'semi' },
        },
      ],
      // let TypeScript handle this
      'no-undef': 'off',
      'ts/no-invalid-this': 'off',
      'eslint-comments/no-unlimited-disable': 'off',
      'curly': ['error', 'all'],

      'markdown/fenced-code-language': 'off',

      'no-restricted-imports': [
        'error',
        {
          paths: ['path'],
        },
      ],

      'import/no-named-as-default': 'off',
    },
  },
  {
    // The decision code stays byte-identical to the evaluated fork except for
    // its module specifiers (see src/decision/README.md), so the rules that
    // reorder or merge imports by specifier must not touch it.
    files: [`packages/vitest-faster/src/decision/${GLOB_SRC}`],
    rules: {
      'perfectionist/sort-imports': 'off',
      'perfectionist/sort-named-imports': 'off',
      'import/no-duplicates': 'off',
    },
  },
  {
    files: [
      `**/*.md`,
      `**/*.md/${GLOB_SRC}`,
    ],
    rules: {
      'perfectionist/sort-imports': 'off',
      'import/first': 'off',
      'unused-imports/no-unused-imports': 'off',
    },
  },
  {
    files: [
      `test/${GLOB_SRC}`,
    ],
    rules: {
      'antfu/no-top-level-await': 'off',
      'unicorn/consistent-function-scoping': 'off',
    },
  },
)
