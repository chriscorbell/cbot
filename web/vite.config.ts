import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const API = process.env.DISPATCH_API ?? 'http://localhost:8787';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@shared': fileURLToPath(new URL('../server/src', import.meta.url)) },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: API, changeOrigin: false, ws: true },
    },
  },
  // noVNC uses top-level await, so target ES2022+.
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
    // The service worker (src/sw.ts) is an entry of its own at a fixed address, /sw.js: a worker's
    // scope is the folder it is served from, and the browser checks that one address for new versions.
    rolldownOptions: {
      input: { index: fileURLToPath(new URL('index.html', import.meta.url)), sw: fileURLToPath(new URL('src/sw.ts', import.meta.url)) },
      output: { entryFileNames: (chunk) => (chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js') },
    },
  },
});
