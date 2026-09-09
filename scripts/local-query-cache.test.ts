import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { setLocalQueryCacheUid, ensureLocalQueryCacheSchema, writeLocalQueryCache, readLocalQueryCache, removeLocalQueryCache } from '../src/lib/localQueryCache.ts'

const prefix = 'cityPainterCalendarQuery:'
function createStorage(limit = 5 * 1024 * 1024) {
  setLocalQueryCacheUid('test-user')
  const values: Record<string, string> = {}
  Object.defineProperties(values, {
    getItem: { value: (key: string) => values[key] ?? null },
    removeItem: { value: (key: string) => { delete values[key] } },
    setItem: { value: (key: string, value: string) => {
      const size = Object.entries({ ...values, [key]: value }).reduce((sum, [k, v]) => sum + 2 * (k.length + v.length), 0)
      if (size > limit) throw new DOMException('full', 'QuotaExceededError')
      values[key] = value
    } }
  })
  Object.defineProperty(globalThis, 'window', { value: { localStorage: values }, configurable: true })
  return values as unknown as Storage
}
function queryBytes(storage: Storage) {
  return Object.keys(storage).filter((key) => key.startsWith(prefix))
    .reduce((sum, key) => sum + 2 * (key.length + storage.getItem(key)!.length), 0)
}

test('舊版滿額快取先清除，保留登入、Firestore 與上傳復原', () => {
  const storage = createStorage()
  for (const key of ['firebase:authUser', 'firestore_mutations_pending', 'uploadRecovery']) storage.setItem(key, 'keep')
  storage.setItem(prefix + 'calendarEventsSearchIndex', 'x'.repeat(2400000))
  ensureLocalQueryCacheSchema()
  assert.equal(queryBytes(storage), 0)
  for (const key of ['firebase:authUser', 'firestore_mutations_pending', 'uploadRecovery']) assert.equal(storage.getItem(key), 'keep')
  assert.doesNotThrow(() => storage.setItem('firestore_targets_test', 'current'))
})
test('重複寫入及大型歷史資料維持一 MB 預算', () => {
  const storage = createStorage()
  ensureLocalQueryCacheSchema()
  for (let i = 0; i < 15; i++) {
    writeLocalQueryCache(`data${i}`, 'x'.repeat(200000))
    assert.ok(queryBytes(storage) <= 1024 * 1024)
  }
  const rows = Array.from({ length: 2000 }, (_, id) => ({ id, content: '工'.repeat(2000) }))
  writeLocalQueryCache('calendarEventsArchive', rows)
  const stored = readLocalQueryCache<typeof rows>('calendarEventsArchive')!
  assert.ok(stored.length > 0 && stored.length < rows.length)
  assert.equal(rows.length, 2000)
  assert.ok(queryBytes(storage) <= 1024 * 1024)
})
test('搜尋與月份旗標不持久化，移除歷史快取也清除舊月份標記', () => {
  const storage = createStorage()
  writeLocalQueryCache('calendarEventsSearchIndex', [{ id: 'a' }])
  writeLocalQueryCache('calendarEventsArchiveMonths', ['2026-09'])
  assert.equal(queryBytes(storage), 0)
  storage.setItem(prefix + 'test-user:calendarEventsArchiveMonths', '["2026-09"]')
  removeLocalQueryCache('calendarEventsArchive')
  assert.equal(storage.getItem(prefix + 'test-user:calendarEventsArchiveMonths'), null)
})
test('額度例外會釋放可重建資料，非快取資料不受影響', () => {
  const storage = createStorage(1000)
  storage.setItem('auth', 'keep')
  writeLocalQueryCache('old', 'small')
  assert.doesNotThrow(() => writeLocalQueryCache('new', 'x'.repeat(600)))
  assert.equal(queryBytes(storage), 0)
  assert.equal(storage.getItem('auth'), 'keep')
})
test('保留兩 MB 空間且不刪除其他用途資料', () => {
  const storage = createStorage()
  storage.setItem('uploadRecovery', 'x'.repeat(1550000))
  writeLocalQueryCache('large', 'x'.repeat(100000))
  assert.equal(queryBytes(storage), 0)
  assert.equal(storage.getItem('uploadRecovery')!.length, 1550000)
})
test('損毀、循環資料與禁止儲存不影響呼叫端', () => {
  const storage = createStorage()
  storage.setItem(prefix + 'broken', '{')
  assert.equal(readLocalQueryCache('broken'), undefined)
  const cyclic: { self?: unknown } = {}; cyclic.self = cyclic
  assert.doesNotThrow(() => writeLocalQueryCache('cyclic', cyclic))
  Object.defineProperty(globalThis, 'window', { value: { get localStorage() { throw new Error('blocked') } }, configurable: true })
  assert.doesNotThrow(() => ensureLocalQueryCacheSchema())
  assert.doesNotThrow(() => writeLocalQueryCache('test', 'value'))
  assert.equal(readLocalQueryCache('test'), undefined)
})
test('啟動清理在 Firebase 初始化前，且不移除 IndexedDB', () => {
  const source = readFileSync(new URL('../src/lib/firebase.ts', import.meta.url), 'utf8')
  assert.ok(source.indexOf('ensureLocalQueryCacheSchema()') < source.indexOf('const app = initializeApp('))
  assert.doesNotMatch(source, /clearIndexedDbPersistence|deleteDatabase/)
})

test('不同登入帳號快取隔離，未登入不讀取或保存查詢', () => {
  const storage = createStorage()
  storage.setItem('uploadRecovery', 'keep')
  setLocalQueryCacheUid('employee-a')
  writeLocalQueryCache('calendarEventsArchive', [{ id: 'private-a' }])
  setLocalQueryCacheUid('employee-b')
  assert.equal(readLocalQueryCache('calendarEventsArchive'), undefined)
  writeLocalQueryCache('calendarEventsArchive', [{ id: 'private-b' }])
  setLocalQueryCacheUid('employee-a')
  assert.deepEqual(readLocalQueryCache('calendarEventsArchive'), [{ id: 'private-a' }])
  setLocalQueryCacheUid('')
  assert.equal(readLocalQueryCache('calendarEventsArchive'), undefined)
  writeLocalQueryCache('calendarEventsArchive', [{ id: 'anonymous' }])
  assert.equal(storage.getItem('uploadRecovery'), 'keep')
})
