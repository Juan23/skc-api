import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { AuthProvider } from './auth/AuthContext'
import { App } from './App'
import { runStorageDiagnostics } from './pos/storageDiagnostics'
import './styles.css'

// Increment 1 of webapp-pos-plan.md - see storageDiagnostics.ts. Gated to
// /pos only, matching the service worker's own narrowed registration scope
// (vite.config.ts) - office/owner/branch staff should see no trace of this
// (including no Firefox persistent-storage permission prompt) until the POS
// route actually exists and someone opens it.
if (location.pathname.startsWith('/pos')) void runStorageDiagnostics()

// AuthProvider sits inside BrowserRouter because it navigates (the expired-
// session redirect) - useNavigate needs a router above it.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
)
