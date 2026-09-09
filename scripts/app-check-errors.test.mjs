import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

function loadFirebase(getToken, timers = {}) {
  const source = fs.readFileSync(new URL('../src/lib/firebase.ts', import.meta.url), 'utf8')
    .replace(/^import .*\n/gm, '').replaceAll('import.meta.env', 'testEnv')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const exports = {}
  vm.runInNewContext(compiled, {
    exports, testEnv: { DEV: false, VITE_FIREBASE_APPCHECK_SITE_KEY: 'test-site' },
    initializeApp: () => ({}), getAuth: () => ({}), getStorage: () => ({}),
    initializeAppCheck: () => ({}), ReCaptchaEnterpriseProvider: class {},
    initializeFirestore: () => ({}), getFirestore: () => ({}), persistentLocalCache: () => ({}), persistentMultipleTabManager: () => ({}),
    ensureLocalQueryCacheSchema() {}, pruneDevicePhotoLocationCache() {}, getToken,
    window: { setTimeout }, navigator: { onLine: true }, setTimeout, clearTimeout,
    ...timers,
  })
  return exports
}

test('同時請求共用一次App Check驗證，不重複交換token', async () => {
  let calls = 0, complete
  const api = loadFirebase(() => { calls++; return new Promise(resolve => { complete = resolve }) })
  const first = api.getAppCheckHeaders(true)
  const second = api.getAppCheckHeaders(true)
  assert.equal(calls, 1)
  complete({ token: 'diagnostic-token' })
  const results = await Promise.all([first, second])
  assert.equal(results[0]['X-Firebase-AppCheck'], 'diagnostic-token')
  assert.equal(results[1]['X-Firebase-AppCheck'], 'diagnostic-token')
})

test('安全驗證拒絕保留code與明確錯誤，不回退空header', async () => {
  const api = loadFirebase(async () => { throw { code: 'appCheck/throttled' } })
  await assert.rejects(api.getAppCheckHeaders(true), error => error.code === 'appCheck/throttled' && error.message.includes('安全驗證被拒絕'))
})

test('安全驗證一直等待會明確逾時，結束後可重新嘗試', async () => {
  let calls = 0
  const api = loadFirebase(() => { calls++; return new Promise(() => {}) }, {
    setTimeout: fn => { queueMicrotask(fn); return 1 }, clearTimeout() {},
  })
  await assert.rejects(api.getAppCheckHeaders(true), error => error.code === 'appCheck/timeout')
  await assert.rejects(api.getAppCheckHeaders(true), error => error.code === 'appCheck/timeout')
  assert.equal(calls, 2)
})
