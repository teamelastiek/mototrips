import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Op GitHub Pages staat de app in een submap (/mototrips/); lokaal in de root
  base: process.env.BASE_PATH || '/',
  // host: true maakt de dev-server bereikbaar vanaf je telefoon op hetzelfde wifi-netwerk
  server: { host: true },
  build: { chunkSizeWarningLimit: 2000 },
})
