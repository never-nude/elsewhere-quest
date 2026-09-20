import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      // Keep entry exports isolated: shared generated helpers must not import
      // the React startup chunk into a flower page that has no React #root.
      preserveEntrySignatures: 'strict',
      // Multi-page: the Elsewhere landing page plus the standalone bouquet.
      input: ['index.html', 'Omaris/index.html', 'Omaris/ar.html'],
    },
  },
})
