import { initializeApp } from 'firebase/app'
import { getToken, initializeAppCheck, ReCaptchaEnterpriseProvider, type AppCheck } from 'firebase/app-check'
import { getAuth } from 'firebase/auth'
import { getFirestore, initializeFirestore, persistentLocalCache, persistentMultipleTabManager } from 'firebase/firestore'

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || 'placeholder-dev',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || 'placeholder.firebaseapp.com',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || 'placeholder-dev',
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || 'placeholder-dev.appspot.com',
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || '000000000000',
  appId: import.meta.env.VITE_FIREBASE_APP_ID || '1:000000000000:web:0000000000000000'
}

const app = initializeApp(firebaseConfig)
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

export async function getAppCheckHeaders() {
  if (!appCheck) throw new Error('網站安全驗證尚未啟用。')
  const result = await getToken(appCheck, false)
  if (!result.token) throw new Error('無法取得網站安全驗證。')
  return { 'X-Firebase-AppCheck': result.token }
}

export const auth = getAuth(app)
export const db = (() => {
  try {
    return initializeFirestore(app, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
    })
  } catch {
    return getFirestore(app)
  }
})()
