import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    chunkSizeWarningLimit: 1200,
    rollupOptions: { input: ['index.html', 'ar.html'] },
  },
})
