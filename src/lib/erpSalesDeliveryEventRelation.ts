import type { CalendarEvent } from '../types'

export const ERP_SALES_DELIVERY_RELATED_INDEPENDENT_FIELDS = [
  'title',
  'date',
  'endDate',
  'startTime',
  'endTime',
  'allDay',
] as const

export const ERP_SALES_DELIVERY_RELATED_SHARED_FIELDS = [
  'location',
  'calendarId',
  'calendarIds',
  'departmentId',
  'assigneeIds',
  'visibleDepartmentIds',
  'visibleAssigneeIds',
  'hiddenDepartmentIds',
  'hiddenAssigneeIds',
  'titleOverrides',
  'reminder',
  'url',
] as const

function relationFieldValuesMatch(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function primarySyncFieldsForRelatedEdit<T extends Record<string, unknown>>(
  primary: T,
  relatedBefore: Record<string, unknown>,
  relatedNext: Record<string, unknown>,
) {
  const nextPrimary: Record<string, unknown> = { ...primary }
  ERP_SALES_DELIVERY_RELATED_SHARED_FIELDS.forEach((field) => {
    if (!relationFieldValuesMatch(relatedBefore[field], relatedNext[field])) {
      nextPrimary[field] = relatedNext[field]
    }
  })
  return nextPrimary as T
}

type SalesDeliveryEvent = Pick<
  CalendarEvent,
  | 'id'
  | 'source'
  | 'sourceId'
  | 'sourceSalesNo'
  | 'sourceCustomerCode'
  | 'sourceCustomerName'
  | 'sourceShippingMethod'
  | 'sourceEventRole'
  | 'sourceParentEventId'
>

export function isErpSalesDeliveryEvent(event: Pick<CalendarEvent, 'source' | 'sourceId'> | null | undefined) {
  return event?.source === 'erpSalesDelivery'
}

export function isRelatedErpSalesDeliveryEvent(
  event: Pick<CalendarEvent, 'source' | 'sourceId' | 'sourceEventRole' | 'sourceParentEventId'> | null | undefined,
) {
  return isErpSalesDeliveryEvent(event) && event?.sourceEventRole === 'related'
}

export function isPrimaryErpSalesDeliveryEvent(
  event: Pick<CalendarEvent, 'source' | 'sourceId' | 'sourceEventRole' | 'sourceParentEventId'> | null | undefined,
) {
  return isErpSalesDeliveryEvent(event) && !isRelatedErpSalesDeliveryEvent(event)
}

export function erpSalesDeliveryPrimaryEventId(event: SalesDeliveryEvent | null | undefined) {
  if (!isErpSalesDeliveryEvent(event)) return ''
  if (isRelatedErpSalesDeliveryEvent(event)) {
    return event?.sourceParentEventId?.trim() || `erpSalesDelivery_${event?.sourceId?.trim()}`
  }
  return event?.id?.trim() || ''
}

export function relatedErpSalesDeliveryFields(event: SalesDeliveryEvent) {
  if (!isErpSalesDeliveryEvent(event) || !event.sourceId?.trim()) return {}
  const sourceParentEventId = erpSalesDeliveryPrimaryEventId(event)
  if (!sourceParentEventId) return {}
  return {
    source: 'erpSalesDelivery',
    sourceId: event.sourceId,
    ...(event.sourceSalesNo ? { sourceSalesNo: event.sourceSalesNo } : {}),
    ...(event.sourceCustomerCode ? { sourceCustomerCode: event.sourceCustomerCode } : {}),
    ...(event.sourceCustomerName ? { sourceCustomerName: event.sourceCustomerName } : {}),
    ...(event.sourceShippingMethod ? { sourceShippingMethod: event.sourceShippingMethod } : {}),
    sourceEventRole: 'related' as const,
    sourceParentEventId,
  }
}

export function isErpSalesTeardownEvent(event: (SalesDeliveryEvent & { sourceEventKind?: string }) | null | undefined) {
  return Boolean(event && isRelatedErpSalesDeliveryEvent(event)
    && (event.sourceEventKind === 'teardown' || event.id.startsWith('erpSalesTeardown_')))
}

export function isErpSalesWorkScheduleEvent(event: CalendarEvent | null | undefined) {
  return Boolean(event && (isErpSalesTeardownEvent(event)
    || (isRelatedErpSalesDeliveryEvent(event) && event.sourceEventKind === 'construction-visit')))
}

export function isOperationalErpSalesDeliveryEvent(event: CalendarEvent | null | undefined) {
  return isPrimaryErpSalesDeliveryEvent(event) || isErpSalesWorkScheduleEvent(event)
}

export function resolveTeardownDetailEvent(event: CalendarEvent, primary: CalendarEvent | null | undefined): CalendarEvent {
  if (!isErpSalesWorkScheduleEvent(event) || !primary || !isPrimaryErpSalesDeliveryEvent(primary)
    || primary.id !== erpSalesDeliveryPrimaryEventId(event) || primary.sourceId !== event.sourceId) return event
  return {
    ...primary,
    id: event.id,
    title: event.title,
    date: event.date,
    endDate: event.endDate,
    startTime: event.startTime,
    endTime: event.endTime,
    allDay: event.allDay,
    done: event.done,
    orderStatus: event.orderStatus,
    orderFulfillment: event.orderFulfillment,
    productionLineRetry: event.productionLineRetry,
    sourceWorkVisitId: event.sourceWorkVisitId,
    sourceEventRole: event.sourceEventRole,
    sourceParentEventId: event.sourceParentEventId,
    ...('sourceEventKind' in event ? { sourceEventKind: event.sourceEventKind } : {}),
  }
}

export function workScheduleTitleForOverride(event: CalendarEvent, title: string) {
  if (!title || !isErpSalesWorkScheduleEvent(event)) return title
  const suffix = isErpSalesTeardownEvent(event) ? '-撤場' : event.title.match(/-[^-]+次施工$/u)?.[0] || ''
  return suffix && !title.endsWith(suffix) ? title + suffix : title
}
