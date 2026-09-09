const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { bumpCalendarDataRevision } = require('./calendarDataRevision')

test('事件與留言異動只保存共同版本，重送不保存識別資訊', async () => {
  const writes = []
  const db = { collection(name) { assert.equal(name, 'calendarDataRevisions'); return { doc(id) {
    assert.equal(id, 'global'); return { set: async (data, options) => writes.push({ data, options }) }
  } } } }
  const fieldValue = { increment: (value) => ({ increment: value }), serverTimestamp: () => ({ serverTimestamp: true }) }
  for (const source of ['event-create', 'event-update', 'event-delete', 'comment-create', 'comment-update', 'comment-delete', 'retry']) {
    await bumpCalendarDataRevision({ db, fieldValue, source, eventId: 'must-not-be-stored', title: 'must-not-be-stored' })
  }
  assert.equal(writes.length, 7)
  for (const write of writes) assert.deepEqual(write, { data: { version: { increment: 1 }, updatedAt: { serverTimestamp: true } }, options: { merge: true } })
})

test('Firestore失敗保留失敗讓trigger重試', async () => {
  const db = { collection: () => ({ doc: () => ({ set: async () => { throw new Error('unavailable') } }) }) }
  const fieldValue = { increment: () => 1, serverTimestamp: () => 1 }
  await assert.rejects(bumpCalendarDataRevision({ db, fieldValue }), /unavailable/)
})

test('事件與留言均使用written trigger且沒有監聽版本文件造成循環', () => {
  const source = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8')
  assert.match(source, /invalidateCalendarDataFromEvents = calendarDataRevisionTrigger\('calendarEvents\/\{eventId\}'\)/)
  assert.match(source, /invalidateCalendarDataFromComments = calendarDataRevisionTrigger\('calendarEvents\/\{eventId\}\/comments\/\{commentId\}'\)/)
  assert.doesNotMatch(source, /calendarDataRevisionTrigger\('calendarDataRevisions/)
})
