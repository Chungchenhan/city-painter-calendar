const PREFIX = 'cityPainterCalendarQuery:'

export function readLocalQueryCache<T>(key: string): T | undefined {
  if (typeof window === 'undefined') return undefined
  try {
    const raw = window.localStorage.getItem(`${PREFIX}${key}`)
    return raw ? JSON.parse(raw) as T : undefined
  } catch {
    return undefined
  }
}

export function writeLocalQueryCache<T>(key: string, data: T) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(`${PREFIX}${key}`, JSON.stringify(data))
  } catch {
    // 本機快取失敗不影響主要資料讀取。
  }
}

export function updateLocalQueryCache<T>(key: string, updater: (data: T | undefined) => T) {
  writeLocalQueryCache(key, updater(readLocalQueryCache<T>(key)))
}

export function clearLocalQueryCaches() {
  if (typeof window === 'undefined') return
  try {
    Object.keys(window.localStorage)
      .filter((key) => key.startsWith(PREFIX))
      .forEach((key) => window.localStorage.removeItem(key))
  } catch {
    // 本機快取清除失敗不影響主要資料讀取。
  }
}
