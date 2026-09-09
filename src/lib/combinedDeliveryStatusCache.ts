import type { CalendarEvent } from '../types'

export type DeliverySelectionStatus = {
  canCompleteOrder: boolean
  shippingMethod: string
  orderStatus: string
}
export type DeliverySelectionResult = {
  statuses: Record<string, DeliverySelectionStatus>
  errors: Record<string, string>
}
type Entry = { expires: number; value?: DeliverySelectionStatus; pending?: Promise<DeliverySelectionStatus> }

function identity(event: CalendarEvent) {
  return JSON.stringify([event.id, event.sourceId, event.sourceShippingMethod, event.orderStatus,
    event.done, event.updatedAt, event.orderFulfillment, event.calendarId, event.calendarIds,
    event.assigneeIds, event.visibleAssigneeIds, event.visibleDepartmentIds,
    event.hiddenAssigneeIds, event.hiddenDepartmentIds])
}

export function createCombinedDeliveryStatusCache({ now = Date.now, ttl = 60_000, capacity = 80 } = {}) {
  const entries = new Map<string, Entry>()
  const keyFor = (event: CalendarEvent) => identity(event)
  const trim = () => {
    for (const [key, entry] of entries) if (!entry.pending && entry.expires <= now()) entries.delete(key)
    while (entries.size > capacity) entries.delete(entries.keys().next().value!)
  }
  const read = (events: CalendarEvent[]) => {
    trim()
    return Object.fromEntries(events.flatMap((event) => {
      const entry = entries.get(keyFor(event))
      return entry?.value && entry.expires > now() ? [[event.id, entry.value]] : []
    })) as Record<string, DeliverySelectionStatus>
  }
  return {
    read,
    clear: () => entries.clear(),
    async load(events: CalendarEvent[], loader: (events: CalendarEvent[]) => Promise<DeliverySelectionResult>): Promise<DeliverySelectionResult> {
      trim()
      const unique = events.filter((event, index) => events.findIndex((item) => item.id === event.id) === index)
      const needed = unique.filter((event) => {
        const entry = entries.get(keyFor(event))
        return !entry?.pending && !(entry?.value && entry.expires > now())
      })
      if (needed.length) {
        const response = Promise.resolve().then(() => loader(needed))
        for (const event of needed) {
          const key = keyFor(event)
          const entry: Entry = { expires: 0 }
          entry.pending = response.then((result) => {
            const status = result.statuses[event.id]
            if (!status) throw new Error(result.errors[event.id] || '訂單確認失敗，請重試')
            if (entries.get(key) === entry) { entry.value = status; entry.expires = now() + ttl }
            return status
          }).finally(() => {
            if (entries.get(key) === entry) {
              entry.pending = undefined
              if (!entry.value) entries.delete(key)
              trim()
            }
          })
          entries.set(key, entry)
        }
      }
      const pending = unique.map(async (event) => {
        const entry = entries.get(keyFor(event))
        try {
          const status = await (entry?.pending || entry?.value)
          if (!status) throw new Error('訂單確認尚未完成，請重試')
          return { eventId: event.id, status }
        } catch (error) {
          return { eventId: event.id, error: error instanceof Error ? error.message : '訂單確認失敗' }
        }
      })
      trim()
      const results = await Promise.all(pending)
      return {
        statuses: Object.fromEntries(results.flatMap((result) => result.status ? [[result.eventId, result.status]] : [])),
        errors: Object.fromEntries(results.flatMap((result) => result.error ? [[result.eventId, result.error]] : [])),
      }
    },
  }
}
