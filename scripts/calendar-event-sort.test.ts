import assert from 'node:assert/strict'
import test from 'node:test'
import {
  compareDayEventsForCalendarDate,
  eventDaySegmentForCalendarDate,
  eventTimeLabelForCalendarDate,
} from '../src/lib/calendarEventSort.ts'
import type { CalendarEvent } from '../src/types/index.ts'

function event(id: string, changes: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id,
    calendarId: 'department:advertising',
    title: id,
    date: '2026-09-05',
    endDate: '2026-09-05',
    startTime: '09:00',
    endTime: '10:00',
    allDay: false,
    departmentId: 'advertising',
    assigneeIds: [],
    note: '',
    ...changes,
  }
}

test('跨日事件在結束日依畫面顯示的結束時間排序', () => {
  const date = '2026-09-05'
  const rows = [
    event('16:30', { date: '2026-09-04', endDate: date, startTime: '08:00', endTime: '16:30' }),
    event('15:30', { startTime: '15:30' }),
    event('09:00', { date: '2026-09-04', endDate: date, startTime: '18:00', endTime: '09:00' }),
    event('16:00', { startTime: '16:00' }),
  ]

  rows.sort((a, b) => compareDayEventsForCalendarDate(a, b, date))

  assert.deepEqual(rows.map((row) => row.id), ['09:00', '15:30', '16:00', '16:30'])
})

test('全天事件仍優先於有時間事件', () => {
  const date = '2026-09-05'
  const rows = [event('09:00'), event('全天', { allDay: true })]

  rows.sort((a, b) => compareDayEventsForCalendarDate(a, b, date))

  assert.deepEqual(rows.map((row) => row.id), ['全天', '09:00'])
})

test('跨日事件依第一天、中間天與最後一天顯示對應文字', () => {
  const row = event('跨日', {
    date: '2026-09-04',
    endDate: '2026-09-06',
    startTime: '14:00',
    endTime: '16:30',
  })

  assert.equal(eventDaySegmentForCalendarDate(row, '2026-09-04'), 'start')
  assert.equal(eventTimeLabelForCalendarDate(row, '2026-09-04'), '14:00')
  assert.equal(eventDaySegmentForCalendarDate(row, '2026-09-05'), 'middle')
  assert.equal(eventTimeLabelForCalendarDate(row, '2026-09-05'), '持續中')
  assert.equal(eventDaySegmentForCalendarDate(row, '2026-09-06'), 'end')
  assert.equal(eventTimeLabelForCalendarDate(row, '2026-09-06'), '16:30')
})

test('中間天的持續中事件排在一般時間事件之前', () => {
  const date = '2026-09-05'
  const rows = [
    event('09:00', { startTime: '09:00' }),
    event('持續中', { date: '2026-09-04', endDate: '2026-09-06', startTime: '18:00' }),
  ]

  rows.sort((a, b) => compareDayEventsForCalendarDate(a, b, date))

  assert.deepEqual(rows.map((row) => row.id), ['持續中', '09:00'])
})
