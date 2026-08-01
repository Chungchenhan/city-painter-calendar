const assert = require('node:assert/strict')
const test = require('node:test')
const {
  REVISION_DOCUMENT_PATH,
  buildCalendarSalesStatusRevisionUpdate,
  bumpCalendarSalesStatusRevision,
} = require('./calendarSalesStatusRevision')

function fakeFieldValue() {
  return {
    increment: value => ({ type: 'increment', value }),
    serverTimestamp: () => ({ type: 'serverTimestamp' }),
  }
}

test('LINE 與付款版本可在同一次原子更新中遞增', () => {
  const update = buildCalendarSalesStatusRevisionUpdate({
    line: true,
    payment: true,
    fieldValue: fakeFieldValue(),
  })

  assert.deepEqual(update.lineVersion, { type: 'increment', value: 1 })
  assert.deepEqual(update.paymentVersion, { type: 'increment', value: 1 })
  assert.equal('lastSourceCollection' in update, false)
  assert.equal('lastSourceDocumentId' in update, false)
  assert.equal(update.version, 1)
})

test('應收異動只遞增付款版本', () => {
  const update = buildCalendarSalesStatusRevisionUpdate({
    line: false,
    payment: true,
    fieldValue: fakeFieldValue(),
  })

  assert.equal('lineVersion' in update, false)
  assert.deepEqual(update.paymentVersion, { type: 'increment', value: 1 })
})

test('沒有任何狀態受影響時不寫入 Firestore', async () => {
  let writeCount = 0
  await bumpCalendarSalesStatusRevision({
    db: {
      doc: () => ({
        set: async () => {
          writeCount += 1
        },
      }),
    },
    fieldValue: fakeFieldValue(),
  })

  assert.equal(REVISION_DOCUMENT_PATH, 'calendarSalesStatusRevisions/global')
  assert.equal(writeCount, 0)
})
