import {
  deleteDoc,
  doc,
  serverTimestamp,
  setDoc,
} from 'firebase/firestore'
import { auth, db } from './firebase'

const VAPID_PUBLIC_KEY = import.meta.env.VITE_WEB_PUSH_PUBLIC_KEY || ''

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

async function getSubscriptionId(subscription: PushSubscription): Promise<string> {
  const data = new TextEncoder().encode(subscription.endpoint)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function subscriptionUsesCurrentKey(subscription: PushSubscription): boolean {
  const key = subscription.options.applicationServerKey
  if (!key) return true
  const currentKey = urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
  const existingKey = new Uint8Array(key)
  if (existingKey.length !== currentKey.length) return false
  return existingKey.every((value, index) => value === currentKey[index])
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
  if (subscription && !subscriptionUsesCurrentKey(subscription)) {
    await subscription.unsubscribe()
    subscription = null
  }
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    })
  }

  const id = await getSubscriptionId(subscription)
  await setDoc(doc(db, 'calendarNotificationSubscriptions', id), {
    uid: user.uid,
    email: user.email ?? '',
    displayName: meta.displayName || user.displayName || user.email || '',
    role: meta.role,
    employeeId: meta.employeeId ?? null,
    endpoint: subscription.endpoint,
    subscription: subscription.toJSON(),
    enabled: true,
    updatedAt: serverTimestamp(),
    createdAt: serverTimestamp(),
  }, { merge: true })

  return true
}

export async function disableCurrentPushSubscription(): Promise<void> {
  if (!('serviceWorker' in navigator)) return
  const registration = await navigator.serviceWorker.ready
  const subscription = await registration.pushManager.getSubscription()
  if (!subscription) return

  const id = await getSubscriptionId(subscription)
  await deleteDoc(doc(db, 'calendarNotificationSubscriptions', id))
  await subscription.unsubscribe()
  await setBadge(0)
}
