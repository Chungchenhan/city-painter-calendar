import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { test } from 'node:test'

function load(relative, globals = {}, imports = {}, extra = '') {
  const source = readFileSync(new URL(relative, import.meta.url), 'utf8').replaceAll('import.meta.env.DEV', 'false') + extra
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const exports = {}
  vm.runInNewContext(code, { exports, require: (key) => imports[key], console, URL, ...globals })
  return exports
}
function storage(limit = Infinity) {
  const values = {}
  Object.defineProperties(values, {
    getItem: { value: (key) => values[key] ?? null },
    setItem: { value: (key, value) => {
      if (Object.entries({ ...values, [key]: value }).reduce((n, [k,v]) => n + 2 * (k.length + v.length), 0) > limit) throw new Error('quota')
      values[key] = value
    } },
    removeItem: { value: (key) => { delete values[key] } },
  })
  return values
}

test('復原紀錄寫滿只回收查詢快取，保留登入和原紀錄', () => {
  const target = storage(1000)
  target.setItem('cityPainterCalendarQuery:old', 'x'.repeat(300))
  target.setItem('auth', 'keep')
  target.setItem('recovery', 'previous')
  const window = { localStorage: target }
  const cache = load('../src/lib/localQueryCache.ts', { window })
  const safe = load('../src/lib/browserStorage.ts', { window }, { './localQueryCache': cache })
  assert.equal(safe.writeBrowserValue('recovery', 'new'.repeat(100)), true)
  assert.equal(target.getItem('auth'), 'keep')
  assert.equal(target.getItem('cityPainterCalendarQuery:old'), null)
  assert.equal(safe.writeBrowserValue('recovery', 'x'.repeat(2000)), false)
  assert.equal(target.getItem('recovery'), 'new'.repeat(100))
})

test('定位提示主動清理過期與超量資料，不碰照片或上傳復原', () => {
  const target = storage()
  const now = Date.now()
  target.setItem('uploadRecovery', 'keep')
  target.setItem('calendar:fulfillment-photo-location:v1:old', JSON.stringify({ capturedAt: new Date(now - 9 * 3600000).toISOString(), location: {source:'device',latitude:25,longitude:121} }))
  for (let i=0;i<500;i++) target.setItem(`calendar:fulfillment-photo-location:v1:${i}`, JSON.stringify({ capturedAt: new Date(now-i).toISOString(), location: {source:'device',latitude:25,longitude:121} }))
  const geo = load('../src/lib/photoGeolocation.ts', { window: { localStorage: target } })
  geo.pruneDevicePhotoLocationCache(now)
  assert.equal(target.getItem('calendar:fulfillment-photo-location:v1:old'), null)
  assert.equal(target.getItem('uploadRecovery'), 'keep')
  const bytes = Object.entries(target).filter(([k]) => k.startsWith('calendar:fulfillment-photo-location:v1:')).reduce((n,[k,v]) => n+2*(k.length+v.length),0)
  assert.ok(bytes <= 64 * 1024)
})

test('兩種儲存皆禁用仍更新，網址標记跨重載阻止循環', async () => {
  let replaced = ''
  let cleared = 0
  const globals = {
    __APP_VERSION__: 'old',
    fetch: async () => ({ok:true,json:async()=>({version:'new'})}),
    caches: {keys:async()=>['pages'],delete:async()=>{cleared++;return true}},
    window: { caches: {}, location: {href:'https://calendar.test/',replace:value=>{replaced=value},reload:()=>assert.fail('應使用網址替代標記')} },
  }
  const imports = {
    './browserStorage': { readBrowserValue:()=>null,writeBrowserValue:()=>false,removeBrowserValue:()=>{} },
    './localQueryCache': {}, 'virtual:pwa-register': {},
  }
  const update = load('../src/lib/appUpdate.ts', globals, imports, '\nexport { checkAppVersion }')
  await update.checkAppVersion()
  assert.ok(replaced.includes('__calendarUpdate=new'))
  assert.equal(cleared,1)
  await update.checkAppVersion()
  assert.equal(cleared,1)
  globals.window.location.href = replaced
  const afterReload = load('../src/lib/appUpdate.ts', globals, imports, '\nexport { checkAppVersion }')
  await afterReload.checkAppVersion()
  assert.equal(cleared,1)
})

test('並發版本請求在儲存禁止時只導覽一次', async () => {
  const resolvers = []
  let navigations = 0
  const update = load('../src/lib/appUpdate.ts', {
    __APP_VERSION__: 'old',
    fetch: async () => ({ok:true,json:()=>new Promise(resolve=>resolvers.push(resolve))}),
    caches: {keys:async()=>[],delete:async()=>true},
    window: {caches:{},location:{href:'https://calendar.test/',replace:()=>{navigations++}}},
  }, {
    './browserStorage': {readBrowserValue:()=>null,writeBrowserValue:()=>false,removeBrowserValue:()=>{}},
    './localQueryCache': {}, 'virtual:pwa-register': {},
  }, '\nexport { checkAppVersion }')
  const pending = [update.checkAppVersion(), update.checkAppVersion()]
  await new Promise(setImmediate)
  resolvers.forEach(resolve => resolve({version:'new'}))
  await Promise.all(pending)
  assert.equal(navigations,1)
})

test('快取清理失敗不留下永久阻擋更新的標記', async () => {
  const flags = new Map()
  let attempts = 0
  const update = load('../src/lib/appUpdate.ts', {
    __APP_VERSION__: 'old',fetch:async()=>({ok:true,json:async()=>({version:'new'})}),
    caches:{keys:async()=>{attempts++;throw new Error('blocked') }},
    window:{caches:{},location:{href:'https://calendar.test/'}},
  }, {
    './browserStorage': {readBrowserValue:key=>flags.get(key)??null,writeBrowserValue:(key,value)=>{flags.set(key,value);return true},removeBrowserValue:key=>flags.delete(key)},
    './localQueryCache':{},'virtual:pwa-register':{},
  }, '\nexport { checkAppVersion }')
  await update.checkAppVersion()
  await update.checkAppVersion()
  assert.equal(attempts,2)
  assert.equal(flags.has('cityPainterCalendarReloadingForUpdate'),false)
})
