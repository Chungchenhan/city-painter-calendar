import test from 'node:test'
import assert from 'node:assert/strict'
import { handleCalendarData } from '../shared/calendarData.js'

function setup({ role = 'employee', disabled = false, invalidCheck = false } = {}) {
  const values = new Map([
    ['userRoles/u', { role, employeeId: 'e' }], ['employees/e', { status: 'active', name: '測試', departmentId: 'dept_ad', departmentName: '廣告部' }],
    ['departments/dept_mgmt', { name: '管理部' }], ['departments/dept_ad', { name: '廣告部' }],
    ['calendarEvents/private', { title: '管理資料', departmentId: 'dept_mgmt' }],
    ['calendarEvents/public', { title: '跨部門', departmentId: 'dept_ad', assigneeIds: ['e'], updatedAt: 'revision1' }],
    ['calendarEvents/hidden', { title: '隱藏', departmentId: 'dept_ad', hiddenAssigneeIds: ['e'] }],
  ])
  const ref = path => ({ path, id: path.split('/').at(-1), get: async () => snap(path), collection: name => collection(path + '/' + name) })
  const snap = path => ({ exists: values.has(path), id: path.split('/').at(-1), data: () => values.get(path), ref: ref(path), updateTime: { toMillis: () => 100 } })
  const collection = name => ({ doc: id => ref(name + '/' + id) })
  const db = { collection, runTransaction: async fn => fn({ get: async ref => snap(ref.path), create: (ref, data) => values.set(ref.path, data) }) }
  const services = { db, auth: { verifyIdToken: async () => ({ uid: 'u' }), getUser: async () => ({ disabled }) }, appCheck: { verifyToken: async () => { if (invalidCheck) throw new Error('bad') } } }
  const call = async (query, body, headers = {}) => {
    const response = { code: 200, setHeader() {}, status(code) { this.code = code; return this }, json(data) { this.data = data; return this }, end() { return this } }
    await handleCalendarData({ method: body ? 'POST' : 'GET', query, body, headers: { authorization: 'Bearer test', 'x-firebase-appcheck': 'valid', ...headers } }, response, services)
    return response
  }
  return { call, values }
}
test('員工可讀共享事件但不可讀管理部與hidden，管理者可讀', async () => {
  const employee = setup()
  assert.equal((await employee.call({ kind: 'event', eventId: 'public' })).code, 200)
  assert.equal((await employee.call({ kind: 'event', eventId: 'private' })).code, 404)
  assert.equal((await employee.call({ kind: 'event', eventId: 'hidden' })).code, 404)
  assert.equal((await setup({ role: 'admin' }).call({ kind: 'event', eventId: 'private' })).code, 200)
})
test('無效App Check／停用帳號與無token被拒絕', async () => {
  assert.equal((await setup({ invalidCheck: true }).call({ kind: 'event', eventId: 'public' })).code, 401)
  assert.equal((await setup({ disabled: true }).call({ kind: 'event', eventId: 'public' })).code, 403)
  assert.equal((await setup().call({ kind: 'event', eventId: 'public' }, null, { authorization: '' })).code, 401)
})
test('活動紀錄綁定雲端event與actor，revision重放只寫一次', async () => {
  const context = setup()
  const body = { eventId: 'public', action: 'update', actorUid: 'victim', assigneeIds: ['victim'], eventTitle: 'forged' }
  assert.equal((await context.call({ kind: 'activity' }, body)).code, 200)
  assert.equal((await context.call({ kind: 'activity' }, body)).code, 200)
  const logs = [...context.values].filter(([key]) => key.startsWith('calendarActivityLogs/'))
  assert.equal(logs.length, 1)
  assert.equal(logs[0][1].actorUid, 'u')
  assert.equal(logs[0][1].eventTitle, '跨部門')
  assert.deepEqual(logs[0][1].assigneeIds, ['e'])
  assert.equal(logs[0][1].serverVerified, true)
  assert.equal((await context.call({ kind: 'activity' }, { ...body, eventId: 'private' })).code, 403)
})

test('非管理者請假標題從權威員工資料產生通用名稱，移除原因與替代標題', async () => {
  const context = setup()
  context.values.set('leaveRequests/leave1', { employeeId: 'e' })
  context.values.set('calendarEvents/hrLeaveRequest_leave1', { source: 'hrLeaveRequest', sourceId: 'leave1', assigneeIds: ['e'], title: '任意 病假', note: '敏感原因', titleOverrides: [{ title: '敏感替代' }] })
  const response = await context.call({ kind: 'event', eventId: 'hrLeaveRequest_leave1' })
  assert.equal(response.code, 200)
  assert.equal(response.data.rows[0].title, '測試 請假')
  assert.equal(response.data.rows[0].note, '')
  assert.deepEqual(response.data.rows[0].titleOverrides, [])
})
