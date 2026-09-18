import tseslint from 'typescript-eslint'

export default tseslint.config(
  ...tseslint.configs.strictTypeChecked,
  {
    files: ['src/**/*.ts', 'examples/**/*.ts'],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],
      '@typescript-eslint/no-non-null-assertion': 'error'
    }
  }
)
