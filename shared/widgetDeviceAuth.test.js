import test from 'node:test'
import assert from 'node:assert/strict'
import { handleWidgetDevice, authenticateWidgetDevice, parseWidgetCredential } from './widgetDeviceAuth.js'

function fixture() {
  const rows = new Map([['userRoles/alice', { employeeId: 'employee-a', role: 'employee' }], ['employees/employee-a', { status: 'active', departmentId: 'sales' }]])
  const account = { uid: 'alice', disabled: false, tokensValidAfterTime: '1970-01-01T00:00:00Z' }
  const db = { collection: collection => ({ doc: id => ({ get: async () => ({ exists: rows.has(`${collection}/${id}`), data: () => rows.get(`${collection}/${id}`) }), set: async data => rows.set(`${collection}/${id}`, data), update: async data => rows.set(`${collection}/${id}`, { ...rows.get(`${collection}/${id}`), ...data }) }) }) }
  const services = { db, auth: { verifyIdToken: async (token, revoked) => { assert.equal(revoked, true); if (token !== 'good') throw new Error(); return { uid: 'alice', auth_time: 1000 } }, getUser: async () => account }, appCheck: { verifyToken: async token => { if (token !== 'good') throw new Error() } } }
  return { services, rows, account }
}
const headers = { authorization: 'Bearer good', 'x-firebase-appcheck': 'good' }
const deviceId = 'aabbccdd-1234-5678-9012-aabbccddeeff'
async function enroll(f, overrides = {}) {
  const res = { setHeader() {}, status() { return this }, json(body) { this.body = body; return this } }
  await handleWidgetDevice({ method: 'POST', query: { action: 'widget-device-register' }, headers, body: { deviceId, uid: 'forged', employeeId: 'forged' }, ...overrides }, res, f.services)
  return res.body
}
const request = credential => ({ headers: { 'x-widget-token': credential } })
test('enrollment binds authenticated employee and stores only hashed secret', async () => {
  const f = fixture()
  const result = await enroll(f)
  const parsed = parseWidgetCredential(result.credential)
  const row = f.rows.get(`calendarWidgetDevices/${parsed.id}`)
  assert.equal(row.uid, 'alice'); assert.equal(row.employeeId, 'employee-a')
  assert.equal(JSON.stringify(row).includes(result.credential.split('.')[2]), false)
  assert.equal((await authenticateWidgetDevice(request(result.credential), f.services.db, f.services.auth)).employeeId, 'employee-a')
})
for (const [name, authHeaders] of [['no auth', {}], ['bad auth', { ...headers, authorization: 'Bearer bad' }], ['no AppCheck', { authorization: 'Bearer good' }], ['bad AppCheck', { ...headers, 'x-firebase-appcheck': 'bad' }]]) test(`enrollment rejects ${name}`, async () => {
  const f = fixture(); await assert.rejects(enroll(f, { headers: authHeaders })); assert.equal(f.rows.size, 2)
})
test('re-enrollment rotates credential and old token cannot revoke new enrollment', async () => {
  const f = fixture(); const first = await enroll(f); const second = await enroll(f)
  await assert.rejects(authenticateWidgetDevice(request(first.credential), f.services.db, f.services.auth), { status: 401 })
  await assert.rejects(enroll(f, { query: { action: 'widget-device-revoke' }, headers: request(first.credential).headers }), { status: 401 })
  assert.equal((await authenticateWidgetDevice(request(second.credential), f.services.db, f.services.auth)).uid, 'alice')
})
test('credential revocation immediately denies further reads', async () => {
  const f = fixture(); const result = await enroll(f)
  await enroll(f, { query: { action: 'widget-device-revoke' }, headers: request(result.credential).headers })
  await assert.rejects(authenticateWidgetDevice(request(result.credential), f.services.db, f.services.auth), { status: 401 })
})
for (const state of ['expired', 'employee inactive', 'account disabled', 'auth revoked', 'employee changed']) test(`read denies ${state}`, async () => {
  const f = fixture(); const result = await enroll(f); const row = f.rows.get(`calendarWidgetDevices/${parseWidgetCredential(result.credential).id}`)
  if (state === 'expired') row.expiresAt = 1
  if (state === 'employee inactive') f.rows.get('employees/employee-a').status = 'inactive'
  if (state === 'account disabled') f.account.disabled = true
  if (state === 'auth revoked') f.account.tokensValidAfterTime = '2026-09-09T00:00:00Z'
  if (state === 'employee changed') row.employeeId = 'other'
  await assert.rejects(authenticateWidgetDevice(request(result.credential), f.services.db, f.services.auth))
})
test('static, malformed and tampered tokens fail closed', async () => {
  const f = fixture(); const result = await enroll(f)
  for (const credential of ['', 'x'.repeat(40), result.credential.slice(0, -1) + (result.credential.endsWith('x') ? 'y' : 'x')]) {
    await assert.rejects(authenticateWidgetDevice(request(credential), f.services.db, f.services.auth), { status: 401 })
  }
})
