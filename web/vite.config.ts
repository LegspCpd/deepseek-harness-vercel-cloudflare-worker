import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Vercel injects NEXT_PUBLIC_* into the build environment. Vite only
// auto-exposes VITE_*; we map the worker URL explicitly at build time so
// `import.meta.env.NEXT_PUBLIC_WORKER_URL` resolves from the Vercel env var.
const workerUrl = process.env.NEXT_PUBLIC_WORKER_URL ?? ''

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    allowedHosts: true,
    port: 5173,
  },
  define: {
    'import.meta.env.NEXT_PUBLIC_WORKER_URL': JSON.stringify(workerUrl),
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
})
