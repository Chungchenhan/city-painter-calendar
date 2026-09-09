import { clearLocalQueryCaches } from './localQueryCache'

type StorageKind = 'localStorage' | 'sessionStorage'

export function readBrowserValue(key: string, kind: StorageKind = 'localStorage'): string | null {
  try {
    return window[kind].getItem(key)
  } catch {
    return null
  }
}

export function writeBrowserValue(key: string, value: string, kind: StorageKind = 'localStorage'): boolean {
  try {
    window[kind].setItem(key, value)
    return true
  } catch {
    if (kind !== 'localStorage') return false
    // 只回收可重新查詢的資料，不能清除登入或尚未完成的工作。
    clearLocalQueryCaches()
    try {
      window[kind].setItem(key, value)
      return true
    } catch {
      return false
    }
  }
}

export function removeBrowserValue(key: string, kind: StorageKind = 'localStorage') {
  try {
    window[kind].removeItem(key)
  } catch {
    // 儲存被封鎖時不阻擋畫面與版本更新。
  }
}
