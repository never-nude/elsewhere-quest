import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      // Multi-page: the Elsewhere landing page plus the standalone bouquet.
      input: ['index.html', 'Omaris/index.html'],
    },
  },
})
