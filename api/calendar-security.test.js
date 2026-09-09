import { createHash } from 'node:crypto'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHandler as register } from './register-calendar-push.js'
import { createHandler as settings } from './save-calendar-notification-settings.js'
import { createHandler as widget } from './widget-calendar.js'
import { createHandler as notify } from './notify-calendar.js'
import identity from '../functions/calendarPushIdentity.js'

const subscription = { endpoint: 'https://web.push.apple.com/test', keys: { p256dh: 'a'.repeat(87), auth: 'b'.repeat(22) } }
const headers = { authorization: 'Bearer good', 'x-firebase-appcheck': 'valid' }

function fixture() {
  const rows = new Map([
    ['userRoles/alice', { role: 'employee', employeeId: 'a' }],
    ['employees/a', { status: 'active', departmentId: 'sales', name: 'Test A' }],
    ['userRoles/bob', { role: 'employee', employeeId: 'b' }],
    ['employees/b', { status: 'active', departmentId: 'admin' }],
    ['departments/sales', { name: '業務部' }],
    ['departments/admin', { name: '管理部' }],
    ['calendarEvents/own', { createdBy: 'alice', date: '2026-09-09', departmentId: 'sales', title: 'own', assigneeIds: ['b'] }],
    ['calendarEvents/private', { createdBy: 'bob', date: '2026-09-09', departmentId: 'admin', title: 'private' }],
  ])
  let writes = 0
  const snapshot = (key) => ({ id: key.split('/').at(-1), exists: rows.has(key), data: () => rows.get(key), ref: ref(key) })
  const ref = (key) => ({
    get: async () => snapshot(key),
    set: async (data) => { writes++; rows.set(key, data) },
    update: async (data) => { writes++; rows.set(key, { ...rows.get(key), ...data }) },
  })
  const db = {
    collection(name) {
      const query = {
        doc: (id) => ref(`${name}/${id}`),
        where: () => query,
        get: async () => {
          const docs = [...rows.keys()].filter((key) => key.startsWith(`${name}/`)).map(snapshot)
          return { docs, forEach: (callback) => docs.forEach(callback) }
        },
      }
      return query
    },
    batch() {
      const jobs = []
      return { set: (r, d) => jobs.push(() => r.set(d)), commit: async () => Promise.all(jobs.map((job) => job())) }
    },
    runTransaction: async (callback) => callback({ get: (r) => r.get(), set: (r, d) => r.set(d) }),
  }
  const services = {
    db,
    auth: {
      async verifyIdToken(token, revoked) { assert.equal(revoked, true); if (token !== 'good') throw new Error('bad'); return { uid: 'alice' } },
      async getUser(uid) { return { uid, disabled: false, email: 'test@example.invalid' } },
    },
    appCheck: { async verifyToken(token) { if (token !== 'valid') throw new Error('bad') } },
    fieldValue: { serverTimestamp: () => 'timestamp' },
  }
  return { rows, services, writes: () => writes }
}

async function call(handler, req = {}) {
  const response = { code: 200, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v }, status(code) { this.code = code; return this }, json(body) { this.body = body; return this }, end() {} }
  await handler({ method: 'POST', headers: { ...headers }, body: {}, ...req }, response)
  return response
}

test('訂閱員工身分由伺服器決定，忽略前端冒用', async () => {
  const f = fixture()
  const res = await call(register(() => f.services), { body: { subscription, employeeId: 'b', role: 'admin' } })
  assert.equal(res.code, 200)
  const stored = f.rows.get(`calendarNotificationSubscriptions/${res.body.id}`)
  assert.equal(stored.employeeId, 'a')
  assert.equal(stored.role, 'employee')
})

for (const [label, requestHeaders] of [
  ['未登入', {}], ['撤銷或無效登入', { ...headers, authorization: 'Bearer revoked' }],
  ['缺少 App Check', { authorization: 'Bearer good' }], ['無效 App Check', { ...headers, 'x-firebase-appcheck': 'bad' }],
]) test(`${label}不能寫訂閱`, async () => {
  const f = fixture()
  const res = await call(register(() => f.services), { headers: requestHeaders, body: { subscription } })
  assert.equal(res.code, 401)
  assert.equal(f.writes(), 0)
})

for (const variant of ['inactive', 'resigned', 'disabled', 'customer']) test(`${variant}帳號被拒`, async () => {
  const f = fixture()
  if (variant === 'inactive') f.rows.get('employees/a').status = 'inactive'
  if (variant === 'resigned') f.rows.get('employees/a').resignDate = '2026-09-01'
  if (variant === 'disabled') f.services.auth.getUser = async () => ({ disabled: true })
  if (variant === 'customer') f.rows.get('userRoles/alice').role = 'customer'
  assert.equal((await call(register(() => f.services), { body: { subscription } })).code, 403)
  assert.equal(f.writes(), 0)
})

test('拒絕任意主機及未解析的壞 JSON', async () => {
  const f = fixture()
  assert.equal((await call(register(() => f.services), { body: { subscription: { ...subscription, endpoint: 'http://127.0.0.1/' } } })).code, 400)
  assert.equal((await call(register(() => f.services), { body: '{' })).code, 400)
  assert.equal(f.writes(), 0)
})

test('通知設定只同步已驗證本人的兩種識別碼', async () => {
  const f = fixture()
  assert.equal((await call(settings(() => f.services), { body: { employeeId: 'b', settings: { shiftStartEnabled: false } } })).code, 200)
  assert.equal(f.rows.get('calendarNotificationSettings/a').shiftStartEnabled, false)
  assert.equal(f.rows.has('calendarNotificationSettings/b'), false)
})

test('背景推播再次排除歷史偽造的員工映射', async () => {
  const f = fixture()
  const accepted = await identity.trustedSubscriptions(f.services.db, f.services.auth, [
    { uid: 'alice', employeeId: 'b', subscription },
    { uid: 'alice', employeeId: 'a', subscription },
  ])
  assert.equal(accepted.length, 1)
  assert.equal(accepted[0].employeeId, 'a')
})

test('非事件授權者不能發送通知；同事件版本不重複送', async () => {
  const f = fixture()
  let sent = 0
  const handler = notify({ getServices: () => f.services, send: async () => { sent++; return 1 } })
  assert.equal((await call(handler, { body: { eventId: 'private' } })).code, 403)
  assert.equal(sent, 0)
  assert.equal((await call(handler, { body: { eventId: 'own' } })).body.sent, 1)
  assert.equal((await call(handler, { body: { eventId: 'own' } })).body.duplicate, true)
  assert.equal(sent, 1)
})

const widgetToken = `wd1.${'a'.repeat(64)}.${'b'.repeat(43)}`
function seedWidget(f) {
  f.rows.set(`calendarWidgetDevices/${'a'.repeat(64)}`, { uid: 'alice', employeeId: 'a', secretHash: createHash('sha256').update('b'.repeat(43)).digest('hex'), authTime: 1, expiresAt: Date.now() + 100000, revokedAt: null })
}
test('Widget 未設定/未授權均在讀資料前拒絕，query token不接受', async () => {
  let reads = 0
  const getDb = () => { reads++; throw new Error('not expected') }
  const handler = widget({ getDb })
  assert.equal((await call(handler, { method: 'GET', headers: {} })).code, 401)
  assert.equal((await call(handler, { method: 'GET', headers: {}, query: { token: widgetToken } })).code, 401)
  assert.equal(reads, 0)
})

test('Widget 合法憑證僅回授權事件且禁止共享快取', async () => {
  const f = fixture()
  seedWidget(f)
  const handler = widget({ getDb: () => f.services.db, getAuth: () => f.services.auth,  })
  const res = await call(handler, { method: 'GET', headers: { 'x-widget-token': widgetToken }, query: { month: '2026-09' } })
  assert.equal(res.code, 200)
  assert.equal(res.headers['cache-control'], 'private, no-store')
  assert.equal(res.headers['vercel-cdn-cache-control'], 'no-store')
  assert.deepEqual(res.body.days.flatMap((d) => d.events).map((e) => e.id), ['own'])
  f.rows.get('employees/a').status = 'inactive'
  assert.equal((await call(handler, { method: 'GET', headers: { 'x-widget-token': widgetToken } })).code, 403)
})

test('Widget 拒絕非法月份且不把內部例外回傳', async () => {
  const f = fixture()
  seedWidget(f)
  const handler = widget({ getDb: () => f.services.db, getAuth: () => f.services.auth,  })
  const request = { method: 'GET', headers: { 'x-widget-token': widgetToken }, query: { month: '2026-13' } }
  assert.equal((await call(handler, request)).code, 400)
  f.services.auth.getUser = async () => { throw new Error('private credentials path') }
  const res = await call(handler, { ...request, query: { month: '2026-09' } })
  assert.equal(res.code, 500)
  assert.equal(JSON.stringify(res.body).includes('credentials'), false)
})

test('客戶 token 即使誤有員工角色文件仍拒絕', async () => {
  const f = fixture()
  f.services.auth.verifyIdToken = async () => ({ uid: 'alice', accountType: 'customer' })
  assert.equal((await call(register(() => f.services), { body: { subscription } })).code, 403)
  assert.equal(f.writes(), 0)
})
