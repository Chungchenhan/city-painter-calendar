import type { CalendarEvent } from '../types'
import type { DeliverySelectionStatus } from './combinedDeliveryStatusCache'
import { deliveryEventGroupKey, isCalendarEventCompleted } from './deliveryEventGrouping'

export type CombinedDeliveryOrder = {
  eventId: string
  salesId: string
  expectedShippingMethod: '外送'
  expectedOrderStatus: string
}

export function combinedDeliveryCandidates(source: CalendarEvent, events: CalendarEvent[]) {
  const key = deliveryEventGroupKey(source)
  const candidates = key ? events.filter((event) => deliveryEventGroupKey(event) === key) : []
  return [source, ...candidates.filter((event) => event.id !== source.id)]
    .filter((event, index, rows) => rows.findIndex((row) => row.sourceId === event.sourceId) === index)
}

export function combinedDeliveryUnavailable(event: CalendarEvent, status?: DeliverySelectionStatus) {
  if (isCalendarEventCompleted(event) || status?.orderStatus === '已送達') return '已配達'
  if (!event.sourceId || event.source !== 'erpSalesDelivery' || event.sourceEventRole === 'related') return '不適用合併配達'
  if (!status) return '正在確認訂單'
  if (status.shippingMethod !== '外送') return '僅外送訂單可合併配達'
  if (!status.canCompleteOrder) return '沒有配達回報權限'
  if (!['未設定', '生產中', '即將配送'].includes(status.orderStatus || '')) return '目前狀態無法配達'
  return ''
}

export function combinedDeliveryOrders(events: CalendarEvent[], statuses: Record<string, DeliverySelectionStatus>) {
  if (!events.length || events.length > 20) throw new Error('請選擇 1～20 筆本次實際送達的訂單')
  return events.map((event): CombinedDeliveryOrder => {
    const unavailable = combinedDeliveryUnavailable(event, statuses[event.id])
    if (unavailable) throw new Error(`${event.sourceSalesNo || '訂單'}：${unavailable}`)
    return { eventId: event.id, salesId: event.sourceId!, expectedShippingMethod: '外送', expectedOrderStatus: statuses[event.id].orderStatus! }
  })
}
