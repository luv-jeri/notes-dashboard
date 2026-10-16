/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The FastAPI server listens on :8000. Proxying /api through Vite keeps the
// browser on a single origin, so the backend needs no CORS setup.
const apiProxy = {
  '/api': {
    target: 'http://127.0.0.1:8000',
    rewrite: (path: string) => path.replace(/^\/api/, ''),
  },
}

export default defineConfig({
  plugins: [react()],
  server: { proxy: apiProxy },
  preview: { proxy: apiProxy },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
  },
})
