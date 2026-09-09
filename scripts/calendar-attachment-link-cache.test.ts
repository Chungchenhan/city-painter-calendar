import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createCalendarAttachmentLinkCache } from '../src/lib/calendarAttachmentLinkCache.ts'
const links = (fileId: string) => ({ fileId, lineOriginalUrl: `original-${fileId}`, linePreviewUrl: `preview-${fileId}`, downloadUrl: `download-${fileId}` })
test('批次最多20、去重、暖快取不需再請求', async () => {
  const calls: string[][] = []
  const cache = createCalendarAttachmentLinkCache({ load: async (_uid, _event, ids) => { calls.push(ids); return { expiresAt: Date.now() + 600000, links: ids.map(links) } } })
  cache.setIdentity('a')
  const one = cache.request('event', 'file0')
  assert.equal(one, cache.request('event', 'file0'))
  await Promise.all(Array.from({ length: 25 }, (_, i) => cache.request('event', `file${i}`)))
  assert.deepEqual(calls.map((ids) => ids.length), [20, 5])
  await cache.request('event', 'file0')
  assert.equal(calls.length, 2)
})
test('登出換帳號立即清除、舊請求不能填入新帳號', async () => {
  let finish!: (value: { expiresAt: number; links: ReturnType<typeof links>[] }) => void
  const cache = createCalendarAttachmentLinkCache({ load: () => new Promise((resolve) => { finish = resolve }) })
  cache.setIdentity('a')
  const request = cache.request('event', 'file')
  const rejection = assert.rejects(request, /帳號已變更/)
  await Promise.resolve()
  cache.setIdentity('b')
  finish({ expiresAt: Date.now() + 600000, links: [links('file')] })
  await rejection
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(cache.peek('event', 'file'), undefined)
  cache.setIdentity('')
  await assert.rejects(cache.request('event', 'file'), /登入/)
})
test('過期刷新失敗不回傳舊網址，容量有界並隔離事件', async () => {
  let time = 1000000
  let fail = false
  const cache = createCalendarAttachmentLinkCache({ capacity: 2, now: () => time, load: async (_uid, _event, ids) => {
    if (fail) throw new Error('offline')
    return { expiresAt: time + 600000, links: ids.map(links) }
  } })
  cache.setIdentity('a')
  await cache.request('e1', 'f1'); await cache.request('e1', 'f2'); await cache.request('e1', 'f3')
  assert.equal(cache.peek('e1', 'f1'), undefined)
  assert.equal(cache.peek('e2', 'f2'), undefined)
  time += 600000
  fail = true
  assert.equal(cache.peek('e1', 'f2'), undefined)
  await assert.rejects(cache.request('e1', 'f2'), /offline/)
  assert.equal(cache.peek('e1', 'f2'), undefined)
})
test('一張被刪附件不阻止同批其他照片，非403不放大重試', async () => {
  let calls = 0
  const cache = createCalendarAttachmentLinkCache({ load: async (_uid, _event, ids) => {
    calls++
    if (ids.includes('missing')) throw Object.assign(new Error('forbidden'), { status: 403 })
    return { expiresAt: Date.now() + 600000, links: ids.map(links) }
  } })
  cache.setIdentity('a')
  const result = await Promise.allSettled([cache.request('e', 'good'), cache.request('e', 'missing')])
  assert.equal(result[0].status, 'fulfilled')
  assert.equal(result[1].status, 'rejected')
  assert.equal(calls, 3)
})
test('401、App Check及網路失敗不逐張放大請求', async () => {
  let calls = 0
  const cache = createCalendarAttachmentLinkCache({ load: async () => { calls++; throw Object.assign(new Error('unauthorized'), { status: 401 }) } })
  cache.setIdentity('a')
  const results = await Promise.allSettled([cache.request('e', 'a'), cache.request('e', 'b')])
  assert.deepEqual(results.map((result) => result.status), ['rejected', 'rejected'])
  assert.equal(calls, 1)
})
test('背景批次同時最多兩個請求，等待中的工作也有容量上限', async () => {
  let active = 0
  let maximum = 0
  const cache = createCalendarAttachmentLinkCache({ capacity: 4, load: async (_uid, _event, ids) => {
    maximum = Math.max(maximum, ++active)
    await new Promise((resolve) => setTimeout(resolve, 5))
    active--
    return { expiresAt: Date.now() + 600000, links: ids.map(links) }
  } })
  cache.setIdentity('a')
  const requests = [cache.request('e1', 'f'), cache.request('e2', 'f')]
  await Promise.resolve()
  requests.push(cache.request('e3', 'f'), cache.request('e4', 'f'))
  await assert.rejects(cache.request('e5', 'f'), /繁忙/)
  await Promise.all(requests)
  assert.equal(maximum, 2)
})
