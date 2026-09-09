const test = require('node:test')
const assert = require('node:assert/strict')
const { trustedActivityEvent, canSendEventToSubscription } = require('./calendarActivitySecurity')
const actor = { uid: 'sender', employeeId: 'employee1', role: 'employee', employee: { status: 'active' } }
const db = (event) => ({ collection: (collection) => ({ doc: () => ({ get: async () => ({
  exists: collection !== 'calendarEvents' || Boolean(event),
  data: () => collection === 'userRoles' ? { role: 'employee', employeeId: 'employee1' }
    : collection === 'employees' ? { status: 'active', name: '可信員工' } : event,
}) }) }) })
const auth = { getUser: async () => ({ disabled: false }) }

test('未經serverVerified的活動不能觸發通知或查詢收件者', async () => {
  assert.equal(await trustedActivityEvent(null, null, { eventId: 'event1', actorUid: 'sender', assigneeIds: ['victim'] }), null)
  assert.equal(await trustedActivityEvent(null, null, { serverVerified: true, eventId: '../event', actorUid: 'sender' }), null)
})
test('活動必須讀回事件且送件人確有通知權限', async () => {
  const log = { serverVerified: true, eventId: 'event1', actorUid: 'sender', eventTitle: '偽造標題', assigneeIds: ['victim'] }
  const result = await trustedActivityEvent(db({ title: '可信標題', assigneeIds: ['employee1'] }), auth, log)
  assert.equal(result.event.title, '可信標題')
  assert.deepEqual(result.event.assigneeIds, ['employee1'])
  assert.equal(await trustedActivityEvent(db({ assigneeIds: ['other'] }), auth, log), null)
  assert.equal(await trustedActivityEvent(db(null), auth, log), null)
})
test('刪除僅接受後端保存且操作者有權限的eventSnapshot', async () => {
  const log = { serverVerified: true, action: 'delete', eventId: 'event1', actorUid: 'sender', eventSnapshot: { assigneeIds: ['employee1'], title: '舊標題' } }
  assert.equal((await trustedActivityEvent(db(null), auth, log)).event.title, '舊標題')
  assert.equal(await trustedActivityEvent(db(null), auth, { ...log, serverVerified: false }), null)
})
test('仍被指定但已排除的員工不應收到標題推播', async () => {
  assert.equal(await canSendEventToSubscription(db(null), { actor }, { assigneeIds: ['employee1'] }), true)
  assert.equal(await canSendEventToSubscription(db(null), { actor }, { assigneeIds: ['employee1'], hiddenAssigneeIds: ['employee1'] }), false)
  assert.equal(await canSendEventToSubscription(db(null), {}, { assigneeIds: ['employee1'] }), false)
})
