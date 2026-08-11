import assert from 'node:assert/strict'
import {
  keepRemoteUploadResult,
  keepUploadFlowAfterLocalStateFailure,
} from '../src/lib/backgroundAttachmentUploadResult.ts'

let continuedFailure: unknown
const continued = await keepUploadFlowAfterLocalStateFailure(
  async () => {
    throw new Error('離線照片佇列操作失敗')
  },
  (error) => {
    continuedFailure = error
  },
)
assert.equal(continued, false)
assert.match(continuedFailure instanceof Error ? continuedFailure.message : '', /離線照片佇列操作失敗/)

const persisted = await keepUploadFlowAfterLocalStateFailure(
  async () => undefined,
  () => assert.fail('成功寫入本機狀態時不應回報失敗'),
)
assert.equal(persisted, true)

const remoteResult = { attachment: { path: 'drive-file-id' } }
let failure: unknown

const resolved = await keepRemoteUploadResult(
  remoteResult,
  async () => {
    throw new Error('離線照片佇列操作失敗')
  },
  (error) => {
    failure = error
  },
)

assert.equal(resolved, remoteResult)
assert.match(failure instanceof Error ? failure.message : '', /離線照片佇列操作失敗/)

let localResultPersisted = false
const persistedResult = await keepRemoteUploadResult(
  remoteResult,
  async () => {
    localResultPersisted = true
  },
  () => assert.fail('成功寫入本機狀態時不應回報失敗'),
)

assert.equal(persistedResult, remoteResult)
assert.equal(localResultPersisted, true)

console.log('背景附件遠端成功判定測試通過。')
