import assert from 'node:assert/strict'
import test from 'node:test'
import { erpSalesDeliveryPrimaryEventId, isErpSalesTeardownEvent, resolveTeardownDetailEvent, workScheduleTitleForOverride } from '../src/lib/erpSalesDeliveryEventRelation.ts'
import type { CalendarEvent } from '../src/types/index.ts'

const primary = {
  id: 'primary-real-id', source: 'erpSalesDelivery', sourceId: 'sales-1',
  title: '👷 工作', date: '2026-09-10', endDate: '2026-09-12', startTime: '14:00', endTime: '15:00',
  note: '收件資訊', url: 'sales-link', location: '施工地址', attachments: [{ path: 'photo' }],
  assigneeIds: ['employee-1'], sourceShippingMethod: '施工',
} as CalendarEvent
const teardown = {
  ...primary, id: 'erpSalesTeardown_sales-1', sourceEventRole: 'related', sourceParentEventId: primary.id,
  title: '👷 工作-撤場', date: '2026-09-30', endDate: '2026-09-30', startTime: '18:00', endTime: '19:00',
  note: '', url: '', location: '', attachments: [],
} as CalendarEvent

test('撤場只保留獨立事件身分與標題時間，其餘詳情沿用主事件', () => {
  const result = resolveTeardownDetailEvent(teardown, primary)
  for (const key of ['id', 'title', 'date', 'endDate', 'startTime', 'endTime', 'sourceEventRole', 'sourceParentEventId'] as const) {
    assert.equal(result[key], teardown[key])
  }
  for (const key of ['note', 'url', 'location', 'attachments', 'assigneeIds', 'sourceShippingMethod'] as const) {
    assert.equal(result[key], primary[key])
  }
  assert.equal(teardown.note, '')
})

test('撤場識別支援種類及舊 ID，一般附屬事件不變', () => {
  assert.equal(isErpSalesTeardownEvent(teardown), true)
  assert.equal(isErpSalesTeardownEvent({ ...teardown, id: 'new-id', sourceEventKind: 'teardown' }), true)
  const related = { ...teardown, id: 'normal-related' }
  assert.equal(resolveTeardownDetailEvent(related, primary), related)
})

test('缺少主事件、跨銷貨單或錯誤主事件 ID 不混用資訊', () => {
  assert.equal(resolveTeardownDetailEvent(teardown, null), teardown)
  assert.equal(resolveTeardownDetailEvent(teardown, { ...primary, sourceId: 'another-sale' }), teardown)
  assert.equal(resolveTeardownDetailEvent(teardown, { ...primary, id: 'another-event' }), teardown)
})

test('撤場保留自身 ID 後，留言資料仍解析至真實主事件 ID', () => {
  const detail = resolveTeardownDetailEvent(teardown, primary)
  assert.notEqual(detail.id, primary.id)
  assert.equal(erpSalesDeliveryPrimaryEventId(detail), primary.id)
  assert.equal(erpSalesDeliveryPrimaryEventId(detail), erpSalesDeliveryPrimaryEventId(primary))
})

test('二次施工與撤場共享詳情但保留各次完成狀態，主事件完成不會完成後續施工', () => {
  for (const sourceEventKind of ['construction-visit', 'teardown'] as const) {
    const event = { ...teardown, id: `schedule-${sourceEventKind}`, sourceEventKind, sourceWorkVisitId: 'stable-visit', done: false, orderStatus: '待施工', orderFulfillment: { completedAt: null }, productionLineRetry: undefined }
    const completedPrimary = { ...primary, done: true, orderStatus: '已完成', orderFulfillment: { completedAt: '2026-09-10' } }
    const detail = resolveTeardownDetailEvent(event, completedPrimary)
    assert.equal(detail.note, primary.note)
    assert.equal(detail.done, false)
    assert.equal(detail.orderStatus, '待施工')
    assert.equal(detail.orderFulfillment, event.orderFulfillment)
    assert.equal(detail.sourceWorkVisitId, 'stable-visit')
    assert.equal(detail.productionLineRetry, undefined)
    assert.equal(erpSalesDeliveryPrimaryEventId(detail), primary.id)
  }
})

test('個人與部門標題覆寫保留各次施工後綴，不會誤顯示撤場', () => {
  const visit = { ...teardown, id: 'visit-2', sourceEventKind: 'construction-visit' as const, title: '工作-二次施工' }
  assert.equal(workScheduleTitleForOverride(visit, '部門工作'), '部門工作-二次施工')
  assert.equal(workScheduleTitleForOverride(visit, '部門工作-二次施工'), '部門工作-二次施工')
  assert.equal(workScheduleTitleForOverride(teardown, '部門工作'), '部門工作-撤場')
})
