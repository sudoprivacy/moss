import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: path.resolve(__dirname, 'prototype'),
  base: '/',
  publicDir: false,
  envDir: path.resolve(__dirname, 'prototype'),
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, '.') },
  },
  server: {
    host: '127.0.0.1',
    port: 5175,
    strictPort: true,
    fs: { allow: [path.resolve(__dirname, '.')] },
  },
  build: {
    outDir: path.resolve(__dirname, 'prototype-dist'),
    emptyOutDir: true,
  },
})
