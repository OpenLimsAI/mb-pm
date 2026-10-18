import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    environmentOptions: { jsdom: { url: 'http://localhost:5175' } },
    setupFiles: ['src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      include: ['src/components/accounts/**/*.{ts,tsx}', 'src/pages/PortalAccounts.tsx', 'src/lib/accountAdmin.ts', 'src/api/accounts.ts'],
      exclude: ['**/*.test.{ts,tsx}'],
      reporter: ['text', 'json-summary', 'html'],
      thresholds: { perFile: true, lines: 90, statements: 90, functions: 90, branches: 90 },
    },
  },
})
