import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The SPA is served by skc-api itself out of wwwroot/, so build straight into
// it. emptyOutDir matters: asset filenames are content-hashed, and leaving old
// chunks behind is how a deploy ends up serving a half-stale app.
//
// In dev, `npm run dev` proxies /api to the locally-running API. Note the port:
// 53756 is the HTTP profile (53755 is HTTPS) - see Properties/launchSettings.json.
// Proxying rather than pointing at the droplet keeps the session cookie
// same-origin in dev exactly as it is in production.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../wwwroot',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:53756',
        changeOrigin: false,
      },
    },
  },
})
