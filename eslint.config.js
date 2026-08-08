import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['node_modules'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      // The betaTool run callbacks take `input: any` deliberately — the SDK
      // validates against the JSON schema before they run.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
)
