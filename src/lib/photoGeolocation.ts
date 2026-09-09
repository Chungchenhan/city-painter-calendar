import type { PhotoCaptureMetadata, PhotoLocation } from './photoMetadata'

export type DevicePhotoLocationResult = {
  location?: PhotoLocation
  warning?: string
}

const LOCATION_OPTIONS: PositionOptions = {
  enableHighAccuracy: true,
  timeout: 10_000,
  maximumAge: 0,
}

const EVENT_LOCATION_CACHE_PREFIX = 'calendar:fulfillment-photo-location:v1:'
const EVENT_LOCATION_CACHE_TTL_MS = 8 * 60 * 60 * 1_000

type EventLocationCache = {
  location: PhotoLocation
  capturedAt: string
}

function browserStorage() {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage
  } catch {
    return undefined
  }
}

export function pruneDevicePhotoLocationCache(now = Date.now()) {
  const storage = browserStorage()
  if (!storage) return
  try {
    const entries: { key: string; bytes: number; time: number }[] = []
    for (const key of Object.keys(storage).filter((item) => item.startsWith(EVENT_LOCATION_CACHE_PREFIX))) {
      const raw = storage.getItem(key)
      if (!raw) continue
      try {
        const row = JSON.parse(raw) as Partial<EventLocationCache>
        const time = Date.parse(String(row.capturedAt || ''))
        if (!validDeviceLocation(row.location) || !Number.isFinite(time) || time > now || now - time > EVENT_LOCATION_CACHE_TTL_MS) {
          storage.removeItem(key)
        } else {
          entries.push({ key, bytes: 2 * (key.length + raw.length), time })
        }
      } catch {
        storage.removeItem(key)
      }
    }
    let bytes = entries.reduce((sum, entry) => sum + entry.bytes, 0)
    for (const entry of entries.sort((a, b) => a.time - b.time)) {
      if (bytes <= 64 * 1024) break
      storage.removeItem(entry.key)
      bytes -= entry.bytes
    }
  } catch {
    // 定位提示可重新取得；清理失敗不影響照片原檔與已保存的位置。
  }
}

function validDeviceLocation(value: unknown): PhotoLocation | undefined {
  if (!value || typeof value !== 'object') return undefined
  const source = value as Record<string, unknown>
  const latitude = Number(source.latitude)
  const longitude = Number(source.longitude)
  const accuracy = Number(source.accuracy)
  if (
    source.source !== 'device'
    || !Number.isFinite(latitude)
    || latitude < -90
    || latitude > 90
    || !Number.isFinite(longitude)
    || longitude < -180
    || longitude > 180
  ) return undefined
  return {
    latitude,
    longitude,
    source: 'device',
    ...(Number.isFinite(accuracy) && accuracy >= 0 ? { accuracy } : {}),
  }
}

function eventLocationCacheKey(eventId: string) {
  return `${EVENT_LOCATION_CACHE_PREFIX}${encodeURIComponent(eventId.trim())}`
}

export function cachedDevicePhotoLocation(
  eventId: string,
  storage: Pick<Storage, 'getItem' | 'removeItem'> | undefined = browserStorage(),
  now = Date.now(),
): PhotoLocation | undefined {
  if (!eventId.trim() || !storage) return undefined
  try {
    const raw = storage.getItem(eventLocationCacheKey(eventId))
    if (!raw) return undefined
    const cached = JSON.parse(raw) as Partial<EventLocationCache>
    const capturedAt = Date.parse(String(cached.capturedAt || ''))
    const location = validDeviceLocation(cached.location)
    if (!location || !Number.isFinite(capturedAt) || now - capturedAt > EVENT_LOCATION_CACHE_TTL_MS || capturedAt > now) {
      storage.removeItem(eventLocationCacheKey(eventId))
      return undefined
    }
    return location
  } catch {
    return undefined
  }
}

function saveDevicePhotoLocation(
  eventId: string,
  location: PhotoLocation,
  storage: Pick<Storage, 'setItem'> | undefined = browserStorage(),
  now = Date.now(),
) {
  if (!eventId.trim() || !storage) return
  pruneDevicePhotoLocationCache(now)
  try {
    storage.setItem(eventLocationCacheKey(eventId), JSON.stringify({
      location,
      capturedAt: new Date(now).toISOString(),
    } satisfies EventLocationCache))
    pruneDevicePhotoLocationCache(now)
  } catch {
    // Safari 私密瀏覽或儲存空間不足時，仍可完成這次定位與照片上傳。
  }
}

function locationWarning(code?: number) {
  if (code === 1) {
    return '尚未允許位置權限；若照片本身沒有定位資訊，這批照片將顯示「拍攝地點未提供」。'
  }
  if (code === 3) {
    return '取得目前位置逾時；若照片本身沒有定位資訊，這批照片將顯示「拍攝地點未提供」。'
  }
  return '暫時無法取得目前位置；若照片本身沒有定位資訊，這批照片將顯示「拍攝地點未提供」。'
}

export function requestDevicePhotoLocation(
  geolocation: Pick<Geolocation, 'getCurrentPosition'> | undefined = (
    typeof navigator === 'undefined' ? undefined : navigator.geolocation
  ),
): Promise<DevicePhotoLocationResult> {
  if (!geolocation) return Promise.resolve({ warning: locationWarning() })
  return new Promise((resolve) => {
    try {
      geolocation.getCurrentPosition(
        (position) => resolve({
          location: {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            source: 'device',
            ...(Number.isFinite(position.coords.accuracy) && position.coords.accuracy >= 0
              ? { accuracy: position.coords.accuracy }
              : {}),
          },
        }),
        (error) => resolve({ warning: locationWarning(error.code) }),
        LOCATION_OPTIONS,
      )
    } catch {
      resolve({ warning: locationWarning() })
    }
  })
}

export function requestDevicePhotoLocationForEvent(
  eventId: string,
  options: {
    geolocation?: Pick<Geolocation, 'getCurrentPosition'>
    storage?: Pick<Storage, 'getItem' | 'removeItem' | 'setItem'>
    now?: number
  } = {},
): Promise<DevicePhotoLocationResult> {
  const storage = options.storage ?? browserStorage()
  const now = options.now ?? Date.now()
  const cached = cachedDevicePhotoLocation(eventId, storage, now)
  if (cached) return Promise.resolve({ location: cached })
  return requestDevicePhotoLocation(options.geolocation).then((result) => {
    if (result.location) saveDevicePhotoLocation(eventId, result.location, storage, now)
    return result
  })
}

export function mergePhotoCaptureMetadata(
  extracted: PhotoCaptureMetadata,
  fallback?: PhotoCaptureMetadata,
): PhotoCaptureMetadata {
  const capturedAt = extracted.capturedAt || fallback?.capturedAt
  const capturedAtSource = extracted.capturedAt
    ? extracted.capturedAtSource
    : fallback?.capturedAt
      ? fallback.capturedAtSource
      : 'unknown'
  const location = extracted.location || fallback?.location
  return {
    ...(capturedAt ? { capturedAt } : {}),
    capturedAtSource,
    ...(location ? { location } : {}),
  }
}
