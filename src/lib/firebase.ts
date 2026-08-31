import { initializeApp } from 'firebase/app'
import { getToken, initializeAppCheck, ReCaptchaEnterpriseProvider, type AppCheck } from 'firebase/app-check'
import { getAuth } from 'firebase/auth'
import { getFirestore, initializeFirestore, persistentLocalCache, persistentMultipleTabManager } from 'firebase/firestore'
import { getStorage } from 'firebase/storage'

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || 'placeholder-dev',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || 'placeholder.firebaseapp.com',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || 'placeholder-dev',
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || 'placeholder-dev.appspot.com',
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || '000000000000',
  appId: import.meta.env.VITE_FIREBASE_APP_ID || '1:000000000000:web:0000000000000000'
}

const app = initializeApp(firebaseConfig)
export const auth = getAuth(app)
const appCheckSiteKey = import.meta.env.VITE_FIREBASE_APPCHECK_SITE_KEY?.trim()
const appCheckDebugToken = import.meta.env.VITE_FIREBASE_APPCHECK_DEBUG_TOKEN?.trim()
if (import.meta.env.DEV && appCheckDebugToken) {
  ;(globalThis as typeof globalThis & { FIREBASE_APPCHECK_DEBUG_TOKEN?: string }).FIREBASE_APPCHECK_DEBUG_TOKEN = appCheckDebugToken
}
export const appCheck: AppCheck | null = appCheckSiteKey
  ? initializeAppCheck(app, {
      provider: new ReCaptchaEnterpriseProvider(appCheckSiteKey),
      isTokenAutoRefreshEnabled: true,
    })
  : null

let firebaseSessionRefreshPromise: Promise<void> | null = null
let lastFirebaseSessionRefreshAt = 0

function appCheckThrottleRetryDelay(error: unknown) {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : ''
  if (code !== 'appCheck/throttled' && code !== 'appCheck/initial-throttle') return 0

  const message = error instanceof Error ? error.message : String(error)
  const time = message.match(/(?:(\d+)d:)?(?:(\d+)h:)?(\d+)m:(\d+)s/i)
  if (!time) return 1_250
  const remainingMs = (
    Number(time[1] || 0) * 86_400
    + Number(time[2] || 0) * 3_600
    + Number(time[3] || 0) * 60
    + Number(time[4] || 0)
  ) * 1_000
  return Math.min(Math.max(remainingMs + 250, 500), 5_000)
}

async function refreshAppCheckToken() {
  if (!appCheck) {
    if (import.meta.env.DEV) return
    throw new Error('網站安全驗證尚未啟用。')
  }

  try {
    await getToken(appCheck, true)
  } catch (error) {
    const retryDelay = appCheckThrottleRetryDelay(error)
    if (!retryDelay) throw error
    await new Promise((resolve) => window.setTimeout(resolve, retryDelay))
    await getToken(appCheck, true)
  }
}

export function refreshFirebaseSession(): Promise<void> {
  const currentUser = auth.currentUser
  if (!currentUser) return Promise.resolve()
  if (firebaseSessionRefreshPromise) return firebaseSessionRefreshPromise
  if (Date.now() - lastFirebaseSessionRefreshAt < 5_000) return Promise.resolve()

  firebaseSessionRefreshPromise = Promise.all([
    currentUser.getIdToken(true),
    refreshAppCheckToken(),
  ]).then(() => {
    lastFirebaseSessionRefreshAt = Date.now()
  }).finally(() => {
    firebaseSessionRefreshPromise = null
  })
  return firebaseSessionRefreshPromise
}

export function setupFirebaseSessionRefresh() {
  const refresh = () => {
    if (document.visibilityState !== 'visible') return
    void refreshFirebaseSession().catch((error) => {
      console.warn('[calendar] 前景驗證更新失敗', error)
    })
  }
  window.addEventListener('focus', refresh)
  document.addEventListener('visibilitychange', refresh)
}

export async function getAppCheckHeaders(): Promise<Record<string, string>> {
  if (!appCheck) {
    if (import.meta.env.DEV) return {}
    throw new Error('網站安全驗證尚未啟用。')
  }
  try {
    const result = await getToken(appCheck, false)
    if (!result.token) throw new Error('無法取得網站安全驗證。')
    return { 'X-Firebase-AppCheck': result.token }
  } catch (error) {
    // iOS WebView 連線本機網址時可能回傳 Unsupported；本機 API 另有登入與員工權限驗證。
    if (import.meta.env.DEV) return {}
    throw error
  }
}

export const storage = getStorage(app)
export const db = (() => {
  try {
    return initializeFirestore(app, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
    })
  } catch {
    return getFirestore(app)
  }
})()
