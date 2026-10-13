import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: { target: ['es2022', 'chrome105'], chunkSizeWarningLimit: 900 },
  test: { environment: 'jsdom', include: ['tests/**/*.test.ts'], restoreMocks: true },
})
