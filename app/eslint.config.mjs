import tseslint from '@electron-toolkit/eslint-config-ts'

export default tseslint.map((config) => ({
  ...config,
  ignores: ['**/node_modules/**', '**/dist/**', '**/out/**']
}))
