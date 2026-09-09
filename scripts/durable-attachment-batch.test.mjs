import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

const source = readFileSync(new URL('../src/lib/backgroundAttachmentUpload.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText

function harness(failAt = 0, failDeleteAt = 0) {
  const saved = new Map([['existing', { id: 'existing', blob: 'protected' }]])
  let transactions = 0
  let aborted = false
  const database = {
    transaction() {
      transactions += 1
      const pending = new Map(saved)
      let count = 0
      const transaction = {
        abort() { aborted = true },
        objectStore() {
          return { put(row) {
            count += 1
            if (count === failAt) throw new Error('QuotaExceededError')
            pending.set(row.id, row)
          }, delete(id) {
            count += 1
            if (count === failDeleteAt) throw new Error('StorageBlocked')
            pending.delete(id)
          } }
        },
      }
      queueMicrotask(() => {
        if (aborted) return
        saved.clear()
        for (const [key, value] of pending) saved.set(key, value)
        transaction.oncomplete?.()
      })
      return transaction
    },
  }
  const context = {
    exports: {}, require: () => ({}), Blob, File, Date, Set, Map, Promise,
    indexedDB: { open() { const request = { result: database }; queueMicrotask(() => request.onsuccess?.()); return request } },
  }
  vm.runInNewContext(compiled, context)
  return { api: context.exports, saved, transactions: () => transactions, aborted: () => aborted }
}

const rows = [1, 2].map(index => ({
  id: `upload-${index}`, uploaderUid: 'employee-1', eventId: 'event-1',
  completionMode: 'fulfillment', fulfillmentBatchId: 'photo-batch-1', fulfillmentBatchSize: 2,
  fulfillmentRequestId: 'request-1', fulfillmentOrders: [{ eventId: 'event-1' }, { eventId: 'event-2' }],
  file: new File(['photo'], `photo-${index}.jpg`, { type: 'image/jpeg' }),
}))

test('整批照片與訂單快照只用一次交易，全部保存才成功', async () => {
  const state = harness()
  const result = await state.api.persistDurableBackgroundAttachmentBatch(rows)
  assert.equal(state.transactions(), 1)
  assert.equal(result.length, 2)
  assert.equal(state.saved.size, 3)
  assert.equal(state.saved.get('upload-2').fulfillmentRequestId, 'request-1')
  assert.equal(state.saved.get('existing').blob, 'protected')
})

test('第二張照片儲存失敗時回滾整批，保留原有復原資料', async () => {
  const state = harness(2)
  await assert.rejects(state.api.persistDurableBackgroundAttachmentBatch(rows), /QuotaExceededError/)
  assert.equal(state.aborted(), true)
  assert.equal(state.saved.size, 1)
  assert.equal(state.saved.get('existing').blob, 'protected')
})


test('整批清理第二筆失敗時保留全批，不產生無法湊齊的殘留批次', async () => {
  const state = harness(0, 2)
  await state.api.persistDurableBackgroundAttachmentBatch(rows)
  await assert.rejects(state.api.removeDurableBackgroundAttachmentBatch(rows.map(row => row.id)), /StorageBlocked/)
  assert.equal(state.saved.has('upload-1'), true)
  assert.equal(state.saved.has('upload-2'), true)
  assert.equal(state.saved.has('existing'), true)
})

test('整批清理成功只移除指定照片，不影響其他復原資料', async () => {
  const state = harness()
  await state.api.persistDurableBackgroundAttachmentBatch(rows)
  await state.api.removeDurableBackgroundAttachmentBatch(rows.map(row => row.id))
  assert.equal(state.saved.size, 1)
  assert.equal(state.saved.has('existing'), true)
})
