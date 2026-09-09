const PREFIX = 'cityPainterCalendarQuery:'
const CACHE_SCHEMA_KEY = 'cityPainterCalendarQuerySchemaVersion'
const CACHE_SCHEMA_VERSION = '2026-09-09-uid-query-cache-v4'
let queryCacheUid = ''
export function setLocalQueryCacheUid(uid: string) { queryCacheUid = uid }
function scopedKey(key: string) { return `${PREFIX}${encodeURIComponent(queryCacheUid)}:${key}` }
const QUERY_BUDGET_BYTES = 1024 * 1024
const ORIGIN_BUDGET_BYTES = 3 * 1024 * 1024
const ARCHIVE_KEY = 'calendarEventsArchive'
const MONTHS_KEY = 'calendarEventsArchiveMonths'
const SEARCH_KEY = 'calendarEventsSearchIndex'

function storedBytes(key: string, value: string) {
  return 2 * (key.length + value.length)
}

function queryKeys(storage: Storage) {
  return Object.keys(storage).filter((key) => key.startsWith(PREFIX))
}

export function readLocalQueryCache<T>(key: string): T | undefined {
  if (!queryCacheUid || typeof window === 'undefined' || key === SEARCH_KEY || key === MONTHS_KEY) return undefined
  try {
    const raw = window.localStorage.getItem(scopedKey(key))
    return raw ? JSON.parse(raw) as T : undefined
  } catch {
    return undefined
  }
}

export function writeLocalQueryCache<T>(key: string, data: T) {
  if (!queryCacheUid || typeof window === 'undefined') return
  try {
    const storage = window.localStorage
    const fullKey = scopedKey(key)
    // 完整搜尋由 React Query 保留於記憶體；月份旗標不能獨立於可能被淘汰的事件保存。
    if (key === SEARCH_KEY || key === MONTHS_KEY) {
      storage.removeItem(fullKey)
      return
    }
    if (key === ARCHIVE_KEY) storage.removeItem(scopedKey(MONTHS_KEY))
    let value = JSON.stringify(data)
    if (value === undefined) return
    // 歷史事件只作啟動畫面提示，可保留最近的一部分；正式查詢仍會補齊。
    if (key === ARCHIVE_KEY && Array.isArray(data)) {
      let length = data.length
      while (length > 0 && storedBytes(fullKey, value) > QUERY_BUDGET_BYTES) {
        length = Math.floor(length / 2)
        value = JSON.stringify(data.slice(0, length))
      }
    }
    storage.removeItem(fullKey)
    if (storedBytes(fullKey, value) > QUERY_BUDGET_BYTES) return
    const entries = Object.keys(storage).map((entryKey) => ({
      key: entryKey,
      bytes: storedBytes(entryKey, storage.getItem(entryKey) || '')
    }))
    let total = entries.reduce((sum, entry) => sum + entry.bytes, 0)
    let queryTotal = entries.filter((entry) => entry.key.startsWith(PREFIX))
      .reduce((sum, entry) => sum + entry.bytes, 0)
    const incoming = storedBytes(fullKey, value)
    for (const entry of entries.filter((entry) => entry.key.startsWith(PREFIX))) {
      if (queryTotal + incoming <= QUERY_BUDGET_BYTES && total + incoming <= ORIGIN_BUDGET_BYTES) break
      storage.removeItem(entry.key)
      queryTotal -= entry.bytes
      total -= entry.bytes
    }
    // 為 Firestore 分頁同步、登入與上傳恢復保留空間，不刪除它們的資料。
    if (total + incoming > ORIGIN_BUDGET_BYTES) return
    try {
      storage.setItem(fullKey, value)
    } catch {
      clearLocalQueryCaches()
    }
  } catch {
    // 儲存被瀏覽器封鎖時，仍使用已取得的查詢結果。
  }
}

export function updateLocalQueryCache<T>(key: string, updater: (data: T | undefined) => T) {
  writeLocalQueryCache(key, updater(readLocalQueryCache<T>(key)))
}

export function removeLocalQueryCache(key: string) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(scopedKey(key))
    if (key === ARCHIVE_KEY) window.localStorage.removeItem(scopedKey(MONTHS_KEY))
  } catch {
    // 本機快取清除失敗不影響主要資料讀取。
  }
}

export function clearLocalQueryCaches() {
  if (typeof window === 'undefined') return
  try {
    queryKeys(window.localStorage).forEach((key) => window.localStorage.removeItem(key))
  } catch {
    // 本機快取清除失敗不影響主要資料讀取。
  }
}

export function ensureLocalQueryCacheSchema() {
  if (typeof window === 'undefined') return
  try {
    const storage = window.localStorage
    const queryBytes = queryKeys(storage).reduce((sum, key) => sum + storedBytes(key, storage.getItem(key) || ''), 0)
    const totalBytes = Object.keys(storage).reduce((sum, key) => sum + storedBytes(key, storage.getItem(key) || ''), 0)
    if (storage.getItem(CACHE_SCHEMA_KEY) !== CACHE_SCHEMA_VERSION
      || queryBytes > QUERY_BUDGET_BYTES || totalBytes > ORIGIN_BUDGET_BYTES) {
      clearLocalQueryCaches()
    }
    storage.removeItem(`${PREFIX}${SEARCH_KEY}`)
    storage.removeItem(scopedKey(MONTHS_KEY))
    storage.setItem(CACHE_SCHEMA_KEY, CACHE_SCHEMA_VERSION)
  } catch {
    // 本機快取版本檢查失敗不影響主要資料讀取。
  }
}
