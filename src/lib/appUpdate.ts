import { registerSW } from 'virtual:pwa-register'
import { ensureLocalQueryCacheSchema } from './localQueryCache'

declare const __APP_VERSION__: string

const APP_VERSION_KEY = 'cityPainterCalendarAppVersion'
const RELOAD_FLAG_KEY = 'cityPainterCalendarReloadingForUpdate'
const DEV_PWA_CACHE_SCHEMA_KEY = 'cityPainterCalendarDevPwaCacheSchema'
const DEV_PWA_CACHE_SCHEMA = '2'

type AppVersionPayload = {
  version?: string
}

async function clearRuntimeCaches(includePrecache = false) {
  if (!('caches' in window)) return
  const keys = await caches.keys()
  await Promise.all(
    keys
      .filter((key) => (
        key === 'pages'
        || key === 'firebase-api'
        || (includePrecache && key.startsWith('workbox-precache-'))
      ))
      .map((key) => caches.delete(key))
  )
}

async function checkAppVersion() {
  try {
    const response = await fetch(`/app-version.json?t=${Date.now()}`, {
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache' }
    })
    if (!response.ok) return
    const payload = await response.json() as AppVersionPayload
    const version = payload.version?.trim()
    if (!version) return

    const currentVersion = localStorage.getItem(APP_VERSION_KEY)
    const loadedVersion = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__.trim() : ''
    const loadedVersionChanged = Boolean(loadedVersion && loadedVersion !== version)
    if (!loadedVersionChanged) sessionStorage.removeItem(RELOAD_FLAG_KEY)
    const needsDevelopmentCacheReset = import.meta.env.DEV
      && navigator.serviceWorker.controller !== null
      && localStorage.getItem(DEV_PWA_CACHE_SCHEMA_KEY) !== DEV_PWA_CACHE_SCHEMA
    if (import.meta.env.DEV) localStorage.setItem(DEV_PWA_CACHE_SCHEMA_KEY, DEV_PWA_CACHE_SCHEMA)
    if (!currentVersion) localStorage.setItem(APP_VERSION_KEY, version)
    if (sessionStorage.getItem(RELOAD_FLAG_KEY) === version) return
    if (!needsDevelopmentCacheReset && !loadedVersionChanged && (
      !currentVersion
      || currentVersion === version
    )) return

    localStorage.setItem(APP_VERSION_KEY, version)
    sessionStorage.setItem(RELOAD_FLAG_KEY, version)
    if (import.meta.env.DEV && 'serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations()
      await Promise.all(registrations.map((registration) => registration.unregister()))
    }
    await clearRuntimeCaches(import.meta.env.DEV)
    window.location.reload()
  } catch {
    // 版本檢查失敗時維持目前畫面，避免弱網路下反覆重載。
  }
}

export function setupAppUpdateChecks() {
  if (import.meta.env.DEV) {
    registerSW({ immediate: true })
  } else {
    ensureLocalQueryCacheSchema()

    registerSW({
      immediate: true,
      onNeedRefresh() {
        void clearRuntimeCaches().finally(() => window.location.reload())
      },
      onRegisteredSW(_swUrl, registration) {
        registration?.update()
        window.setInterval(() => registration?.update(), 5 * 60 * 1000)
      }
    })
  }

  void checkAppVersion()
  window.addEventListener('focus', () => void checkAppVersion())
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void checkAppVersion()
  })
}
