import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// The SPA is served by skc-api itself out of wwwroot/, so build straight into
// it. emptyOutDir matters: asset filenames are content-hashed, and leaving old
// chunks behind is how a deploy ends up serving a half-stale app.
//
// In dev, `npm run dev` proxies /api to the locally-running API. Note the port:
// 53756 is the HTTP profile (53755 is HTTPS) - see Properties/launchSettings.json.
// Proxying rather than pointing at the droplet keeps the session cookie
// same-origin in dev exactly as it is in production.
export default defineConfig({
  plugins: [
    react(),
    // PWA shell for the eventual web POS (webapp-pos-plan.md Increment 1).
    // registerType 'prompt' + skipWaiting/clientsClaim left off: an open till
    // must keep running its current version offline indefinitely rather than
    // being force-upgraded mid-shift - the app decides when it's safe to
    // reload (cart empty), never the service worker.
    VitePWA({
      registerType: 'prompt',
      injectRegister: 'auto',
      // Registration scope, NOT the manifest's own `scope` below (a separate,
      // install-window-navigation concept). The POS is meant to be a standalone
      // instance that doesn't touch the rest of the app (see webapp-pos-plan.md
      // decision #2) - narrowing this means the service worker never controls
      // /office, /owner, /branch, or /login navigations, so a future webapp
      // deploy still lands on their next refresh exactly as documented in
      // CLAUDE.md. Valid even though sw.js is served from site root: a
      // registration scope narrower than the script's own directory needs no
      // Service-Worker-Allowed header, only a wider one would.
      //
      // MUST be '/pos', not '/pos/'. Scope matching is a raw string-prefix
      // check on the URL, not path-boundary-aware - but the app's actual URL
      // (the router's <Route path="/pos">, the manifest start_url below, every
      // link to the till) never carries a trailing slash. A '/pos/' scope
      // therefore never matches it: navigator.serviceWorker.controller stays
      // null on the real page, and the one thing this service worker exists
      // for - navigateFallback serving the app shell on an offline reload -
      // silently never engages. (Found via a Playwright offline-reload test:
      // `serviceWorker.controller` was null on /pos, set once trailing-slash
      // /pos/ was loaded directly - the registration itself was fine, only the
      // scope-to-URL match was wrong.) Trade-off accepted: '/pos' as a raw
      // prefix would also match a hypothetical future '/postal' route, but no
      // such route exists, and any route it did over-match would just get the
      // same navigateFallback app-shell behavior every unmatched SPA path
      // already gets - not a security issue like the IsTrustedOfficeCaller-
      // style prefix bugs this codebase has fixed elsewhere.
      scope: '/pos',
      // globPatterns below already precaches every public/*.png (icons
      // included) - without this the manifest icons get added a second time
      // as duplicate precache entries. webmanifest is excluded from
      // globPatterns for the same reason: vite-plugin-pwa injects it into the
      // precache list on its own regardless, so matching it here too would
      // just add a second, identical entry.
      includeManifestIcons: false,
      manifest: {
        name: 'SKC',
        short_name: 'SKC',
        description: 'SKC internal system',
        start_url: '/pos',
        scope: '/',
        display: 'standalone',
        orientation: 'landscape',
        theme_color: '#b4794a',
        background_color: '#fbf6ef',
        icons: [
          { src: '/pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // App shell only - every /api/* call stays NetworkOnly, so offline
        // behavior is 100% the (future) IndexedDB queue, never a stale SW
        // response. navigateFallbackDenylist keeps an offline API 404/500
        // from ever getting silently swapped for index.html.
        globPatterns: ['**/*.{js,css,html,ico,png,svg}'],
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            urlPattern: /^\/api\//,
            handler: 'NetworkOnly',
          },
        ],
      },
    }),
  ],
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
