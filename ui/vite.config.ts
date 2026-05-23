import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: parseInt(process.env.VITE_DEV_SERVER_PORT || '5173', 10),
    strictPort: true,
    hmr: {
      host: '127.0.0.1',
      port: parseInt(process.env.VITE_DEV_SERVER_PORT || '5173', 10),
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src/renderer-react'),
    },
  },
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: path.resolve(__dirname, 'index.html'),
        execution: path.resolve(__dirname, 'src', 'execution.html'),
      },
    },
  },
});
