import { auth } from './firebase'

const VAPID_PUBLIC_KEY = import.meta.env.VITE_WEB_PUSH_PUBLIC_KEY || ''
const VAPID_KEY_CACHE_KEY = 'cityPainterCalendarVapidPublicKey'

export interface PushUserMeta {
  role: 'admin' | 'employee' | 'loading' | 'unknown'
  employeeId: string | null
  displayName: string
}

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - base64String.length % 4) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = window.atob(base64)
  const outputArray = new Uint8Array(new ArrayBuffer(rawData.length))
  for (let i = 0; i < rawData.length; i += 1) {
    outputArray[i] = rawData.charCodeAt(i)
  }
  return outputArray
}

function subscriptionUsesCurrentKey(subscription: PushSubscription): boolean {
  const key = subscription.options.applicationServerKey
  if (!key) return true
  const currentKey = urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
  const existingKey = new Uint8Array(key)
  if (existingKey.length !== currentKey.length) return false
  return existingKey.every((value, index) => value === currentKey[index])
}

function storedVapidKeyMatches() {
  try {
    return window.localStorage.getItem(VAPID_KEY_CACHE_KEY) === VAPID_PUBLIC_KEY
  } catch {
    return false
  }
}

function rememberVapidKey() {
  try {
    window.localStorage.setItem(VAPID_KEY_CACHE_KEY, VAPID_PUBLIC_KEY)
  } catch {
    // 本機快取失敗不影響推播訂閱。
  }
}

async function setBadge(count: number) {
  const nav = navigator as Navigator & {
    setAppBadge?: (contents?: number) => Promise<void>
    clearAppBadge?: () => Promise<void>
  }
  try {
    if (count > 0 && nav.setAppBadge) await nav.setAppBadge(count)
    if (count <= 0 && nav.clearAppBadge) await nav.clearAppBadge()
  } catch {
    // Badge API 不支援時忽略，不影響推播通知。
  }
}

export function isPushSupported(): boolean {
  return Boolean(
    VAPID_PUBLIC_KEY &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  )
}

export async function ensurePushSubscription(meta: PushUserMeta): Promise<boolean> {
  const user = auth.currentUser
  if (!user || !isPushSupported()) return false

  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return false

  const registration = await navigator.serviceWorker.ready
  let subscription = await registration.pushManager.getSubscription()
  if (subscription && (!storedVapidKeyMatches() || !subscriptionUsesCurrentKey(subscription))) {
    await subscription.unsubscribe()
    subscription = null
  }
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    })
  }

  const token = await user.getIdToken()
  const res = await fetch('/api/register-calendar-push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      displayName: meta.displayName || user.displayName || user.email || '',
      role: meta.role,
      employeeId: meta.employeeId ?? null,
      subscription: subscription.toJSON(),
    }),
  })
  if (!res.ok) return false

  rememberVapidKey()
  return true
}

export async function disableCurrentPushSubscription(): Promise<void> {
  if (!('serviceWorker' in navigator)) return
  const registration = await navigator.serviceWorker.ready
  const subscription = await registration.pushManager.getSubscription()
  if (!subscription) return

  await subscription.unsubscribe()
  try {
    window.localStorage.removeItem(VAPID_KEY_CACHE_KEY)
  } catch {
    // 本機快取失敗不影響取消訂閱。
  }
  await setBadge(0)
}
