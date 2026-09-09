import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createCombinedDeliveryStatusCache } from '../src/lib/combinedDeliveryStatusCache.ts'
import type { CalendarEvent } from '../src/types/index.ts'
const events = [1, 2].map((id) => ({ id: `e${id}`, sourceId: `s${id}`, orderStatus: '即將配送', updatedAt: '1' } as CalendarEvent))
const status = { canCompleteOrder: true, shippingMethod: '外送', orderStatus: '即將配送' }
const result = { statuses: { e1: status, e2: status }, errors: {} }

test('群組預取與開啟視窗共用單一批次請求，完成後同步首幀取得', async () => {
  const cache = createCombinedDeliveryStatusCache()
  let finish!: (value: typeof result) => void, calls = 0
  const loader = async () => { calls++; return new Promise<typeof result>((resolve) => { finish = resolve }) }
  const preload = cache.load(events, loader)
  const dialog = cache.load(events, loader)
  await Promise.resolve()
  assert.equal(calls, 1)
  finish(result)
  await Promise.all([preload, dialog])
  assert.deepEqual(cache.read(events), result.statuses)
  await cache.load(events, loader)
  assert.equal(calls, 1)
})

test('到期、狀態變動、資料來源更換與清除後不能使用舊確認', async () => {
  let time = 0
  const cache = createCombinedDeliveryStatusCache({ now: () => time, ttl: 10 })
  await cache.load(events, async () => result)
  assert.equal(Object.keys(cache.read(events)).length, 2)
  assert.equal(Object.keys(cache.read([{ ...events[0], sourceId: 'changed' }])).length, 0)
  assert.equal(Object.keys(cache.read([{ ...events[0], orderStatus: '已送達' }])).length, 0)
  time = 11
  assert.deepEqual(cache.read(events), {})
  await cache.load(events, async () => result)
  cache.clear()
  assert.deepEqual(cache.read(events), {})
})

test('新權限scope不共享舊使用者資料；失敗可重試，不快取錯誤', async () => {
  const cache = createCombinedDeliveryStatusCache()
  const failed = await cache.load(events, async () => { throw new Error('沒有權限') })
  assert.deepEqual(failed.statuses, {})
  assert.equal(failed.errors.e1, '沒有權限')
  const recovered = await cache.load(events, async () => result)
  assert.deepEqual(recovered.statuses, result.statuses)
  assert.deepEqual(createCombinedDeliveryStatusCache().read(events), {})
})

test('有容量上限；一筆無權限不會阻塞其他已確認訂單', async () => {
  const cache = createCombinedDeliveryStatusCache({ capacity: 1 })
  const loaded = await cache.load(events, async () => ({ statuses: { e1: status }, errors: { e2: '沒有權限' } }))
  assert.deepEqual(loaded.statuses.e1, status)
  assert.equal(loaded.errors.e2, '沒有權限')
  assert.ok(Object.keys(cache.read(events)).length <= 1)
})

test('cache清除後，舊請求晚回覆不可重新寫入已失效確認', async () => {
  const cache = createCombinedDeliveryStatusCache()
  let finish!: (value: typeof result) => void
  const pending = cache.load(events, async () => new Promise<typeof result>((resolve) => { finish = resolve }))
  await Promise.resolve()
  cache.clear()
  finish(result)
  await pending
  assert.deepEqual(cache.read(events), {})
})
