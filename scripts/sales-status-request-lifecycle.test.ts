import assert from 'node:assert/strict'
import { createForegroundRequest } from '../src/lib/foregroundRequest.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const committed: string[] = []
const errors: unknown[] = []
const pending: Array<ReturnType<typeof deferred<string>>> = []
const signals: AbortSignal[] = []
const createOwner = () => createForegroundRequest({
  load: (signal) => {
    signals.push(signal)
    const request = deferred<string>()
    pending.push(request)
    return request.promise
  },
  onSuccess: (value) => committed.push(value),
  onError: (error) => errors.push(error),
})

const firstEffect = createOwner()
const oldRequest = firstEffect.run()
assert.equal(firstEffect.run(), oldRequest)
await Promise.resolve()
assert.equal(pending.length, 1)
firstEffect.dispose()
assert.equal(signals[0].aborted, true)

// 同一事件的 effect 重建不得沿用已被清理的舊請求。
const secondEffect = createOwner()
const currentRequest = secondEffect.run()
await Promise.resolve()
assert.equal(pending.length, 2)
pending[0].resolve('舊事件狀態')
await oldRequest
assert.deepEqual(committed, [])
assert.equal(secondEffect.run(), currentRequest)
pending[1].resolve('最新事件狀態')
await currentRequest
assert.deepEqual(committed, ['最新事件狀態'])

const backgroundRequest = secondEffect.run()
await Promise.resolve()
secondEffect.cancel()
assert.equal(signals[2].aborted, true)
const foregroundRequest = secondEffect.run()
await Promise.resolve()
assert.equal(pending.length, 4)
pending[2].reject(new TypeError('Load failed'))
await backgroundRequest
assert.deepEqual(errors, [])
assert.equal(secondEffect.run(), foregroundRequest)
pending[3].resolve('恢復前景狀態')
await foregroundRequest
assert.deepEqual(committed, ['最新事件狀態', '恢復前景狀態'])

const failedRequest = secondEffect.run()
await Promise.resolve()
const realError = new Error('伺服器拒絕讀取')
pending[4].reject(realError)
await failedRequest
assert.deepEqual(errors, [realError])
const recoveredRequest = secondEffect.run()
await Promise.resolve()
pending[5].resolve('連線恢復')
await recoveredRequest
assert.equal(committed.at(-1), '連線恢復')

// StrictMode 在請求開始前 cleanup，也不應留下無主網路請求。
const earlyEffect = createOwner()
const earlyRequest = earlyEffect.run()
earlyEffect.dispose()
await earlyRequest
await earlyEffect.run()
assert.equal(pending.length, 6)
assert.deepEqual(errors, [realError])
console.log('訂單狀態請求生命週期：重建、取消、前景恢復、去重、過期結果與真實錯誤測試通過')
