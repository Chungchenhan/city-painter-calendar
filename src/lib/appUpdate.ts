import { registerSW } from 'virtual:pwa-register'

const APP_VERSION_KEY = 'cityPainterCalendarAppVersion'
const RELOAD_FLAG_KEY = 'cityPainterCalendarReloadingForUpdate'
const ICON_CACHE_VERSION = '20260523-icons'
const ICON_CACHE_KEY = 'cityPainterCalendarIconCacheVersion'
const ICON_RELOAD_KEY = 'cityPainterCalendarIconReloading'

type AppVersionPayload = {
  version?: string
}

async function clearRuntimeCaches() {
  if (!('caches' in window)) return
  const keys = await caches.keys()
  await Promise.all(keys.map((key) => caches.delete(key)))
}

async function refreshIconCaches() {
  try {
    if (localStorage.getItem(ICON_CACHE_KEY) === ICON_CACHE_VERSION) return
    localStorage.setItem(ICON_CACHE_KEY, ICON_CACHE_VERSION)
    await clearRuntimeCaches()

    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations()
      await Promise.all(registrations.map((registration) => registration.update()))
    }

    if (sessionStorage.getItem(ICON_RELOAD_KEY) !== ICON_CACHE_VERSION) {
      sessionStorage.setItem(ICON_RELOAD_KEY, ICON_CACHE_VERSION)
      window.location.reload()
    }
  } catch {
    // 快取清除失敗時維持目前畫面，避免弱網路下反覆重載。
  }
}

async function checkAppVersion() {
  if (import.meta.env.DEV) return
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
    if (!currentVersion) {
      localStorage.setItem(APP_VERSION_KEY, version)
      return
    }
    if (currentVersion === version || sessionStorage.getItem(RELOAD_FLAG_KEY) === version) return

    localStorage.setItem(APP_VERSION_KEY, version)
    sessionStorage.setItem(RELOAD_FLAG_KEY, version)
    await clearRuntimeCaches()
    window.location.reload()
  } catch {
    // 版本檢查失敗時維持目前畫面，避免弱網路下反覆重載。
  }
}

export function setupAppUpdateChecks() {
  if (import.meta.env.DEV) return

  void refreshIconCaches()

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

  void checkAppVersion()
  window.addEventListener('focus', () => void checkAppVersion())
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void checkAppVersion()
  })
}
