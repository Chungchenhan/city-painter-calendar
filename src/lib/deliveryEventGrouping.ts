import type { CalendarEvent } from '../types'

export type CalendarDayDisplayItem = {
  key: string
  primaryEvent: CalendarEvent
  events: CalendarEvent[]
  isDeliveryGroup: boolean
}

const COMPLETED_ORDER_STATUSES = new Set(['已送達', '已完成'])

function normalizedText(value: unknown) {
  return typeof value === 'string'
    ? value.normalize('NFKC').trim().replace(/\s+/g, '').toLocaleLowerCase('zh-Hant')
    : ''
}

function deliveryCustomerKey(event: CalendarEvent) {
  const customerCode = normalizedText(event.sourceCustomerCode)
  if (customerCode) return `code:${customerCode}`
  const customerName = normalizedText(event.sourceCustomerName)
  return customerName ? `name:${customerName}` : ''
}

function deliveryCalendarKey(event: CalendarEvent) {
  const calendarIds = event.calendarIds?.length ? event.calendarIds : [event.calendarId]
  return [...calendarIds].filter(Boolean).sort().join(',')
}

export function deliveryEventGroupKey(event: CalendarEvent) {
  if (event.source !== 'erpSalesDelivery') return ''
  if (!normalizedText(event.sourceId)) return ''
  if ((event.endDate || event.date) !== event.date) return ''
  const customer = deliveryCustomerKey(event)
  const location = normalizedText(event.location)
  if (!customer || !location) return ''

  return [
    'erp-delivery',
    customer,
    `location:${location}`,
    `date:${event.date}`,
    `end:${event.endDate || event.date}`,
    `time:${event.allDay ? 'all-day' : `${event.startTime}-${event.endTime}`}`,
    `method:${normalizedText(event.sourceShippingMethod)}`,
    `calendar:${deliveryCalendarKey(event)}`,
  ].join('|')
}

export function groupCalendarDayEvents(events: CalendarEvent[]): CalendarDayDisplayItem[] {
  const grouped = new Map<string, CalendarEvent[]>()
  const itemKeys: string[] = []

  events.forEach((event) => {
    const groupKey = deliveryEventGroupKey(event)
    if (!groupKey) {
      const eventKey = `event:${event.id}`
      grouped.set(eventKey, [event])
      itemKeys.push(eventKey)
      return
    }

    const existing = grouped.get(groupKey)
    if (existing) {
      existing.push(event)
      return
    }
    grouped.set(groupKey, [event])
    itemKeys.push(groupKey)
  })

  return itemKeys.map((key) => {
    const groupedEvents = grouped.get(key) ?? []
    return {
      key,
      primaryEvent: groupedEvents[0],
      events: groupedEvents,
      isDeliveryGroup: groupedEvents.length > 1,
    }
  })
}

export function deliveryGroupCompletedCount(events: CalendarEvent[]) {
  return events.filter((event) => (
    event.done || COMPLETED_ORDER_STATUSES.has(event.orderStatus?.trim() || '')
  )).length
}

export function deliveryGroupTitle(title: string, eventCount: number) {
  return `${title}（${eventCount}筆訂單）`
}
