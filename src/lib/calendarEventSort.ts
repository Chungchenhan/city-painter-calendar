import type { CalendarEvent } from '../types'

export type CalendarEventDaySegment = 'single' | 'start' | 'middle' | 'end'

export function eventDaySegmentForCalendarDate(
  event: Pick<CalendarEvent, 'date' | 'endDate'>,
  date: string,
): CalendarEventDaySegment {
  const endDate = event.endDate || event.date
  if (event.date === endDate) return 'single'
  if (date === event.date) return 'start'
  if (date === endDate) return 'end'
  return 'middle'
}

export function eventTimeForCalendarDate(
  event: Pick<CalendarEvent, 'date' | 'endDate' | 'startTime' | 'endTime'>,
  date: string,
) {
  if (eventDaySegmentForCalendarDate(event, date) === 'end') return event.endTime
  return event.startTime
}

export function eventTimeLabelForCalendarDate(
  event: Pick<CalendarEvent, 'date' | 'endDate' | 'startTime' | 'endTime'>,
  date: string,
) {
  if (eventDaySegmentForCalendarDate(event, date) === 'middle') return '持續中'
  return eventTimeForCalendarDate(event, date)
}

export function compareDayEventsForCalendarDate(a: CalendarEvent, b: CalendarEvent, date: string) {
  if (!!a.allDay !== !!b.allDay) return a.allDay ? -1 : 1
  const aIsMiddle = eventDaySegmentForCalendarDate(a, date) === 'middle'
  const bIsMiddle = eventDaySegmentForCalendarDate(b, date) === 'middle'
  if (aIsMiddle !== bIsMiddle) return aIsMiddle ? -1 : 1
  const timeCompare = eventTimeForCalendarDate(a, date).localeCompare(eventTimeForCalendarDate(b, date))
  if (timeCompare !== 0) return timeCompare
  return (a.title || '').localeCompare(b.title || '', 'zh-Hant')
}
