import { initializeApp } from 'firebase/app'
import { getToken, initializeAppCheck, ReCaptchaEnterpriseProvider, type AppCheck } from 'firebase/app-check'
import { getAuth, type User } from 'firebase/auth'
import { getFirestore, initializeFirestore, persistentLocalCache, persistentMultipleTabManager } from 'firebase/firestore'
import { getStorage } from 'firebase/storage'
import { ensureLocalQueryCacheSchema } from './localQueryCache'
import { pruneDevicePhotoLocationCache } from './photoGeolocation'

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || 'placeholder-dev',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || 'placeholder.firebaseapp.com',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || 'placeholder-dev',
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || 'placeholder-dev.appspot.com',
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || '000000000000',
  appId: import.meta.env.VITE_FIREBASE_APP_ID || '1:000000000000:web:0000000000000000'
}

// 必須先釋放舊查詢快取，避免 Firestore 啟動分頁同步時因額度不足中止。
pruneDevicePhotoLocationCache()
ensureLocalQueryCacheSchema()

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

function firebaseErrorCode(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : ''
}

function isFirebaseNetworkError(error: unknown) {
  const code = firebaseErrorCode(error)
  if (code === 'auth/network-request-failed' || code.includes('fetch-network-error')) return true
  const message = error instanceof Error ? error.message : String(error)
  return /network-request-failed|failed to fetch|load failed|networkerror/i.test(message)
}

export function firebaseRequestErrorMessage(error: unknown, fallback: string) {
  const code = firebaseErrorCode(error)
  const message = error instanceof Error ? error.message : ''
  if (/^(?:目前沒有網路連線|網路連線不穩定|登入已失效)/.test(message)) return message
  if (isFirebaseNetworkError(error)) {
    return navigator.onLine === false
      ? '目前沒有網路連線，請恢復連線後再試。'
      : '網路連線不穩定，請稍後再試。'
  }
  if (['auth/id-token-expired', 'auth/invalid-user-token', 'auth/user-token-expired', 'auth/user-disabled'].includes(code)) {
    return '登入已失效，請重新登入行事曆。'
  }
  return fallback
}

export async function getFirebaseIdToken(user: User) {
  try {
    return await user.getIdToken()
  } catch (error) {
    if (!isFirebaseNetworkError(error) || navigator.onLine === false) {
      throw new Error(firebaseRequestErrorMessage(error, '登入驗證失敗，請重新登入行事曆。'))
    }
    await new Promise((resolve) => window.setTimeout(resolve, 400))
    try {
      return await user.getIdToken()
    } catch (retryError) {
      throw new Error(firebaseRequestErrorMessage(retryError, '登入驗證失敗，請重新登入行事曆。'))
    }
  }
}

let appCheckRequest: Promise<Awaited<ReturnType<typeof getToken>>> | null = null

export async function getAppCheckHeaders(required = false): Promise<Record<string, string>> {
  if (!appCheck) {
    if (import.meta.env.DEV && !required) return {}
    throw new Error('網站安全驗證尚未啟用。')
  }
  try {
    if (!appCheckRequest) {
      let timer: ReturnType<typeof setTimeout>
      appCheckRequest = Promise.race([
        getToken(appCheck, false),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(Object.assign(new Error('網站安全驗證逾時，請檢查網路後重試。'), { code: 'appCheck/timeout' })), 12000)
        }),
      ]).finally(() => { clearTimeout(timer); appCheckRequest = null })
    }
    const result = await appCheckRequest
    if (!result.token) throw new Error('無法取得網站安全驗證。')
    return { 'X-Firebase-AppCheck': result.token }
  } catch (error) {
    // iOS WebView 連線本機網址時可能回傳 Unsupported；本機 API 另有登入與員工權限驗證。
    if (import.meta.env.DEV && !required) return {}
    const code = firebaseErrorCode(error)
    const fallback = code === 'appCheck/timeout'
      ? '網站安全驗證逾時，請檢查網路後重試。'
      : '網站安全驗證被拒絕，請重新載入網頁再試；若持續發生，請聯絡管理者。'
    throw Object.assign(new Error(firebaseRequestErrorMessage(error, fallback)), { code: code || 'appCheck/failed' })
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
