import { registerSW } from 'virtual:pwa-register'
import { clearLocalQueryCaches, ensureLocalQueryCacheSchema } from './localQueryCache'

const APP_VERSION_KEY = 'cityPainterCalendarAppVersion'
const RELOAD_FLAG_KEY = 'cityPainterCalendarReloadingForUpdate'

type AppVersionPayload = {
  version?: string
}

async function clearRuntimeCaches() {
  if (!('caches' in window)) return
  const keys = await caches.keys()
  await Promise.all(keys.map((key) => caches.delete(key)))
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
    clearLocalQueryCaches()
    await clearRuntimeCaches()
    window.location.reload()
  } catch {
    // 版本檢查失敗時維持目前畫面，避免弱網路下反覆重載。
  }
}

export function setupAppUpdateChecks() {
  if (import.meta.env.DEV) return

  ensureLocalQueryCacheSchema()

  registerSW({
    immediate: true,
    onNeedRefresh() {
      clearLocalQueryCaches()
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
