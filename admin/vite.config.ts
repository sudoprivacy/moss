import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const adminBase = process.env.MOSS_ADMIN_BASE || '/admin/'
const apiTarget = process.env.VITE_BACKEND_URL || 'http://127.0.0.1:43127'

export default defineConfig({
  base: adminBase.endsWith('/') ? adminBase : `${adminBase}/`,
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
  server: {
    proxy: {
      '/healthz': apiTarget,
      '/readyz': apiTarget,
      '/api': apiTarget,
      '/ws': {
        target: apiTarget,
        ws: true,
      },
    },
  },
})
