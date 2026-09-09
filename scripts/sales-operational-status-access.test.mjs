import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

function harness({ uid = 'employee-a', canViewPayment = false, cache = new Map(), fail = false } = {}) {
  const effects = [], states = [], listeners = [], handlers = new Map()
  let calls = 0, cleanup
  const status = { eligible: true, bound: true, lineDisplayName: 'Fixture', paymentState: 'paid', outstandingTotal: 900 }
  const split = value => {
    const { paymentState, outstandingTotal, ...lineStatus } = value
    return { lineStatus, paymentStatus: { paymentState, outstandingTotal } }
  }
  const foreground = fs.readFileSync(new URL('../src/lib/foregroundRequest.ts', import.meta.url), 'utf8')
  const foregroundExports = {}
  vm.runInNewContext(ts.transpileModule(foreground, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText,
    { exports: foregroundExports, AbortController, Promise })
  const deps = {
    react: {
      useCallback: fn => fn, useMemo: fn => fn(), useRef: current => ({ current }), useEffect: fn => effects.push(fn),
      useState: init => { const index = states.length; states.push(typeof init === 'function' ? init() : init); return [states[index], next => { states[index] = typeof next === 'function' ? next(states[index]) : next }] },
    },
    'firebase/firestore': {
      doc: (_db, collection, id) => ({ collection, id }),
      onSnapshot: (ref, success, error) => { const item = { ...ref, success, error, stopped: false }; listeners.push(item); return () => { item.stopped = true } },
    },
    '../lib/firebase': { db: {} },
    '../lib/foregroundRequest': foregroundExports,
    '../lib/localQueryCache': { readLocalQueryCache: key => cache.get(key), writeLocalQueryCache: (key, value) => cache.set(key, value), removeLocalQueryCache: key => cache.delete(key) },
    '../lib/salesOperationalStatus': {
      splitSalesOperationalStatus: split,
      fetchSalesOperationalStatus: async () => { calls++; if (fail) throw new Error('拒絕存取'); return status },
    },
  }
  const exports = {}
  const document = { visibilityState: 'visible', addEventListener: (name, fn) => handlers.set(name, fn), removeEventListener: name => handlers.delete(name) }
  const source = fs.readFileSync(new URL('../src/hooks/useSalesOperationalStatus.ts', import.meta.url), 'utf8')
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, require: name => deps[name], document, window: document, console, Error })
  const result = exports.useSalesOperationalStatus({ user: { uid }, eventId: 'event-a', enabled: true, canViewPayment })
  cleanup = effects[0]()
  return { result, states, listeners, cache, cleanup, get calls() { return calls } }
}
const flush = () => new Promise(resolve => setImmediate(resolve))
const snapshot = (lineVersion, paymentVersion = 0) => ({ exists: () => true, data: () => ({ lineVersion, paymentVersion }) })

test('一般員工只監聽非敏感版本，API 成功不再出現受限制文件的連線錯誤', async () => {
  const run = harness()
  await flush()
  assert.deepEqual(run.listeners.map(item => item.collection), ['calendarSalesStatusRevisions'])
  assert.equal(run.states[0].status.bound, true)
  assert.equal(run.states[0].status.paymentState, undefined)
  assert.equal(run.states[1].error, '')
  run.listeners[0].success(snapshot(1))
  run.listeners[0].success(snapshot(2))
  await flush()
  assert.equal(run.calls, 2)
  run.cleanup()
  assert.ok(run.listeners.every(item => item.stopped))
})

test('已授權帳號事件快取立即顯示，另一帳號不可沿用', async () => {
  const cache = new Map([['sales-operational-status:employee-a:event-a:line', { eligible: true, bound: true }]])
  const first = harness({ cache })
  assert.equal(first.result.status.bound, true)
  assert.equal(first.result.loading, false)
  first.cleanup()
  const second = harness({ uid: 'employee-b', cache })
  assert.equal(second.result.status, null)
  assert.equal(second.result.loading, true)
  second.cleanup()
  await flush()
})

test('真正 API 失敗仍顯示錯誤，付款權限不被版本監聽繞過', async () => {
  const run = harness({ fail: true })
  await flush()
  assert.match(run.states[1].error, /拒絕存取/)
  run.cleanup()
  const manager = harness({ canViewPayment: true })
  await flush()
  assert.equal(manager.states[0].status.paymentState, 'paid')
  manager.cleanup()
})
