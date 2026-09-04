import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2021',
  },
  server: {
    port: 5183,
    strictPort: true,
  },
})
