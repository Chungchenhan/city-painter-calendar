import { readBrowserValue, writeBrowserValue, removeBrowserValue } from './browserStorage'
import { registerSW } from 'virtual:pwa-register'
import { ensureLocalQueryCacheSchema } from './localQueryCache'

declare const __APP_VERSION__: string

const APP_VERSION_KEY = 'cityPainterCalendarAppVersion'
const RELOAD_FLAG_KEY = 'cityPainterCalendarReloadingForUpdate'
const DEV_PWA_CACHE_SCHEMA_KEY = 'cityPainterCalendarDevPwaCacheSchema'
const DEV_PWA_CACHE_SCHEMA = '2'
const RELOAD_QUERY_KEY = '__calendarUpdate'
let updateInProgress = false

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
  if (updateInProgress) return
  try {
    const response = await fetch(`/app-version.json?t=${Date.now()}`, {
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache' }
    })
    if (!response.ok || updateInProgress) return
    const payload = await response.json() as AppVersionPayload
    const version = payload.version?.trim()
    if (!version || updateInProgress) return

    const currentVersion = readBrowserValue(APP_VERSION_KEY)
    const loadedVersion = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__.trim() : ''
    const loadedVersionChanged = Boolean(loadedVersion && loadedVersion !== version)
    const pageUrl = new URL(window.location.href)
    if (!loadedVersionChanged) {
      removeBrowserValue(RELOAD_FLAG_KEY, 'sessionStorage')
      if (pageUrl.searchParams.has(RELOAD_QUERY_KEY)) {
        pageUrl.searchParams.delete(RELOAD_QUERY_KEY)
        window.history.replaceState(window.history.state, '', pageUrl)
      }
    }
    const needsDevelopmentCacheReset = import.meta.env.DEV
      && navigator.serviceWorker.controller !== null
      && readBrowserValue(DEV_PWA_CACHE_SCHEMA_KEY) !== DEV_PWA_CACHE_SCHEMA
    if (import.meta.env.DEV) writeBrowserValue(DEV_PWA_CACHE_SCHEMA_KEY, DEV_PWA_CACHE_SCHEMA)
    if (!currentVersion) writeBrowserValue(APP_VERSION_KEY, version)
    if (readBrowserValue(RELOAD_FLAG_KEY, 'sessionStorage') === version
      || (loadedVersionChanged && pageUrl.searchParams.get(RELOAD_QUERY_KEY) === version)) return
    if (!needsDevelopmentCacheReset && !loadedVersionChanged && (
      !currentVersion
      || currentVersion === version
    )) return

    writeBrowserValue(APP_VERSION_KEY, version)
    const reloadFlagStored = writeBrowserValue(RELOAD_FLAG_KEY, version, 'sessionStorage')
    updateInProgress = true
    if (import.meta.env.DEV && 'serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations()
      await Promise.all(registrations.map((registration) => registration.unregister()))
    }
    await clearRuntimeCaches(import.meta.env.DEV)
    if (reloadFlagStored) window.location.reload()
    else {
      // 儲存被封鎖時用網址保存一次性版本標記，避免舊 Service Worker 造成無限刷新。
      pageUrl.searchParams.set(RELOAD_QUERY_KEY, version)
      window.location.replace(pageUrl.toString())
    }
  } catch {
    removeBrowserValue(RELOAD_FLAG_KEY, 'sessionStorage')
    updateInProgress = false
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
        if (updateInProgress) return
        updateInProgress = true
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
