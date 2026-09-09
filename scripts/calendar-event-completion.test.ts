import assert from 'node:assert/strict'
import test from 'node:test'
import { isCalendarEventCompleted } from '../src/lib/deliveryEventGrouping.ts'
import { deliveryGroupCompletedCount } from '../src/lib/deliveryEventGrouping.ts'
import type { CalendarEvent } from '../src/types/index.ts'

const base = { done: false, source: 'erpSalesDelivery' }
test('舊 ERP 完成紀錄不依賴 done 旗標', () => {
  assert.equal(isCalendarEventCompleted({ ...base, orderFulfillment: { status: 'completed' } }), true)
  for (const orderStatus of ['已完成', '已送達', ' 已送達 ']) assert.equal(isCalendarEventCompleted({ ...base, orderStatus }), true)
  for (const orderStatus of ['待施工', '生產中', '即將配送', '']) assert.equal(isCalendarEventCompleted({ ...base, orderStatus }), false)
})
test('施工與撤場使用各自完成紀錄，不繼承主單已完成狀態', () => {
  for (const sourceEventKind of ['teardown', 'construction-visit'] as const) {
    const related = { ...base, sourceEventKind, orderStatus: '已完成' }
    assert.equal(isCalendarEventCompleted(related), false)
    assert.equal(isCalendarEventCompleted({ ...related, orderFulfillment: { status: 'completed' } }), true)
    assert.equal(isCalendarEventCompleted({ ...related, done: true }), true)
  }
  assert.equal(isCalendarEventCompleted({ ...base, sourceParentEventId: 'primary', orderStatus: '已完成' }), false)
})
test('只有 ERP 事件淡化，特休與一般事件即使帶有完成旗標仍維持原色', () => {
  assert.equal(isCalendarEventCompleted({ done: false, source: 'hrLeaveRequest', orderStatus: '已完成' }), false)
  for (const source of ['hrLeaveRequest', 'manual', 'timeTreeImport', undefined]) {
    assert.equal(isCalendarEventCompleted({ done: true, source, orderFulfillment: { status: 'completed' }, orderStatus: '已完成' }), false)
  }
})
test('配送群組部分完成不整組淡化，完成數與單筆共用判斷', () => {
  const events = [{ ...base, orderFulfillment: { status: 'completed' } }, { ...base, orderStatus: '即將配送' }] as CalendarEvent[]
  assert.equal(deliveryGroupCompletedCount(events), 1)
  assert.equal(events.every(isCalendarEventCompleted), false)
  events[1].orderStatus = '已送達'
  assert.equal(deliveryGroupCompletedCount(events), 2)
  assert.equal(events.every(isCalendarEventCompleted), true)
})
