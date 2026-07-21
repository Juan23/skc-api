// Increment 1 (webapp-pos-plan.md): confirm the secure-context PWA shell can
// actually get durable storage before any IndexedDB code is written on top of
// it. `persist()` only ever prompts/succeeds on a real secure context (HTTPS
// or localhost) - a false/failed result here means the till would be exposed
// to the browser evicting its offline sales queue under storage pressure.
export async function runStorageDiagnostics(): Promise<void> {
  if (!('storage' in navigator) || !navigator.storage.persist) {
    console.warn('[pos] Storage API unavailable - not a secure context, or an old browser.')
    return
  }

  try {
    const persisted = await navigator.storage.persist()
    const estimate = await navigator.storage.estimate?.()

    console.log('[pos] storage.persist() ->', persisted)
    if (estimate) {
      const usedMb = ((estimate.usage ?? 0) / (1024 * 1024)).toFixed(2)
      const quotaMb = ((estimate.quota ?? 0) / (1024 * 1024)).toFixed(2)
      console.log(`[pos] storage.estimate() -> ${usedMb} MB used / ${quotaMb} MB quota`)
    }
  } catch (err) {
    // Some browsers (Firefox private browsing, restrictive Permissions-Policy
    // contexts) reject rather than resolve false - never let that surface as
    // an unhandled rejection, this is diagnostics only.
    console.warn('[pos] Storage diagnostics failed:', err)
  }
}
