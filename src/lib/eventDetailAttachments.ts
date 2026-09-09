import type { CalendarEvent } from '../types'

export type EventDetailAttachment = NonNullable<CalendarEvent['attachments']>[number]

const EVENT_DISPLAY_FALLBACK_FIELDS: (keyof EventDetailAttachment)[] = [
  'name',
  'originalName',
  'url',
  'lineOriginalUrl',
  'linePreviewUrl',
  'thumbnailPath',
  'type',
  'size',
  'provider',
  'originalSize',
  'optimized',
]

function stableAttachmentKeys(attachment: EventDetailAttachment) {
  return [attachment.path, attachment.url]
    .map((value) => typeof value === 'string' ? value.trim() : '')
    .filter(Boolean)
}

function hasValue(value: unknown) {
  return value !== undefined && value !== null && value !== ''
}

function fillMissingDisplayFields(
  canonical: EventDetailAttachment,
  eventAttachment?: EventDetailAttachment,
) {
  if (!eventAttachment) return canonical
  const merged = { ...canonical }
  for (const field of EVENT_DISPLAY_FALLBACK_FIELDS) {
    if (!hasValue(merged[field]) && hasValue(eventAttachment[field])) {
      Object.assign(merged, { [field]: eventAttachment[field] })
    }
  }
  return merged
}

export function resolveEventDetailAttachments({
  eventSource,
  eventAttachments,
  salesAttachments,
  salesSourceAvailable,
}: {
  eventSource?: string
  eventAttachments: readonly EventDetailAttachment[]
  salesAttachments: readonly EventDetailAttachment[]
  salesSourceAvailable: boolean
}) {
  if (eventSource !== 'erpSalesDelivery' || !salesSourceAvailable) return [...eventAttachments]

  const eventByStableKey = new Map<string, EventDetailAttachment>()
  eventAttachments.forEach((attachment) => {
    stableAttachmentKeys(attachment).forEach((key) => {
      if (!eventByStableKey.has(key)) eventByStableKey.set(key, attachment)
    })
  })

  const seen = new Set<string>()
  return salesAttachments.flatMap((canonical) => {
    const keys = stableAttachmentKeys(canonical)
    if (keys.some((key) => seen.has(key))) return []
    keys.forEach((key) => seen.add(key))
    const eventAttachment = keys.map((key) => eventByStableKey.get(key)).find(Boolean)
    return [fillMissingDisplayFields(canonical, eventAttachment)]
  })
}
