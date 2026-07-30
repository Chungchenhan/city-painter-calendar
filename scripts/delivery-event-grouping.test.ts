import assert from 'node:assert/strict'
import test from 'node:test'
import {
  deliveryEventGroupKey,
  deliveryGroupCompletedCount,
  deliveryGroupTitle,
  groupCalendarDayEvents,
} from '../src/lib/deliveryEventGrouping.ts'
import type { CalendarEvent } from '../src/types/index.ts'

function event(id: string, changes: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id,
    calendarId: 'department:advertising',
    calendarIds: ['department:advertising'],
    title: '📦 鄭光峰',
    date: '2026-07-25',
    endDate: '2026-07-25',
    startTime: '14:00',
    endTime: '15:00',
    allDay: false,
    departmentId: 'advertising',
    assigneeIds: [],
    note: '',
    location: '台中市西屯區市政路 1 號',
    done: false,
    source: 'erpSalesDelivery',
    sourceId: id,
    sourceSalesNo: `S-${id}`,
    sourceCustomerCode: 'C001',
    sourceCustomerName: '鄭光峰',
    sourceShippingMethod: '外送',
    ...changes,
  }
}

test('同客戶、地址、日期與時段的 ERP 配送事件合併顯示', () => {
  const rows = groupCalendarDayEvents([
    event('1'),
    event('2', { location: '台中市西屯區市政路1號' }),
    event('3', { orderStatus: '已送達' }),
  ])

  assert.equal(rows.length, 1)
  assert.equal(rows[0].isDeliveryGroup, true)
  assert.deepEqual(rows[0].events.map((row) => row.id), ['1', '2', '3'])
  assert.equal(deliveryGroupCompletedCount(rows[0].events), 1)
  assert.equal(deliveryGroupTitle(rows[0].primaryEvent.title, rows[0].events.length), '📦 鄭光峰（3筆訂單）')
})

test('不同地址、時段、配送方式或客戶不得合併', () => {
  const rows = groupCalendarDayEvents([
    event('1'),
    event('2', { location: '台中市西屯區市政路2號' }),
    event('3', { startTime: '15:00', endTime: '16:00' }),
    event('4', { sourceShippingMethod: '施工' }),
    event('5', { sourceCustomerCode: 'C002' }),
  ])

  assert.equal(rows.length, 5)
  assert.ok(rows.every((row) => !row.isDeliveryGroup))
})

test('地址或客戶識別缺漏時維持逐筆顯示', () => {
  const missingLocation = event('1', { location: '' })
  const missingCustomer = event('2', { sourceCustomerCode: '', sourceCustomerName: '' })
  const missingSourceId = event('3', { sourceId: '' })
  const multiDay = event('4', { endDate: '2026-07-26' })

  assert.equal(deliveryEventGroupKey(missingLocation), '')
  assert.equal(deliveryEventGroupKey(missingCustomer), '')
  assert.equal(deliveryEventGroupKey(missingSourceId), '')
  assert.equal(deliveryEventGroupKey(multiDay), '')
  assert.equal(groupCalendarDayEvents([missingLocation, missingCustomer, missingSourceId, multiDay]).length, 4)
})

test('一般行事曆事件不參與配送分組', () => {
  const regular = event('regular', { source: 'manual' })
  const rows = groupCalendarDayEvents([regular, { ...regular, id: 'regular-2' }])

  assert.equal(rows.length, 2)
  assert.ok(rows.every((row) => !row.isDeliveryGroup))
})
