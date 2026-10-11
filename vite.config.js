import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Relative asset URLs so the build works from a GitHub Pages project subpath
  // (/topology-of-us/) as well as from the root. Safe while there's no routing.
  base: './',
})
