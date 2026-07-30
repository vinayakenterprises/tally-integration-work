import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/tally': {
        target: 'http://192.232.32.70:9001/',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/tally/, ''),
      },
    },
  },
})

