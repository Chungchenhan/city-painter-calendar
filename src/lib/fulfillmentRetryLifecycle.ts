export type FulfillmentRetryLifecycle = {
  mode?: unknown
  attachmentIds?: unknown
  status?: unknown
  shippingMethod?: unknown
  orderStatus?: unknown
}

export type FulfillmentRetryLiveStatus = {
  shippingMethod?: unknown
  orderStatus?: unknown
  canCompleteOrder?: unknown
}

export type FulfillmentRetryDecision =
  | { action: 'allow', attachmentIds: string[] }
  | { action: 'hide', reason: 'processing' | 'permission' | 'status_unavailable' }
  | { action: 'clear', reason: 'legacy' | 'invalid' | 'lifecycle_changed' }

const FULFILLMENT_SHIPPING_METHODS = new Set(['外送', '施工', '活動'])
const RETRYABLE_STATUSES = new Set(['pending', 'failed'])
const FULFILLMENT_FINAL_STATUS: Record<string, string> = {
  '外送': '已送達',
  '施工': '已完成',
  '活動': '已完成',
}
const FULFILLMENT_PRE_FINAL_STATUSES: Record<string, ReadonlySet<string>> = {
  '外送': new Set(['未設定', '生產中', '即將配送']),
  '施工': new Set(['未設定', '生產中', '待施工', '處理中']),
  '活動': new Set(['未設定', '生產中']),
}

function normalizedText(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

export function fulfillmentRetryDecision(
  retry: FulfillmentRetryLifecycle | null | undefined,
  liveStatus: FulfillmentRetryLiveStatus | null | undefined,
): FulfillmentRetryDecision {
  if (!retry || retry.mode !== 'fulfillment') return { action: 'clear', reason: 'invalid' }
  if (retry.status === 'processing') return { action: 'hide', reason: 'processing' }
  if (!RETRYABLE_STATUSES.has(normalizedText(retry.status))) return { action: 'clear', reason: 'invalid' }

  const attachmentIds = Array.isArray(retry.attachmentIds)
    ? [...new Set(retry.attachmentIds.map(normalizedText).filter(Boolean))]
    : []
  if (attachmentIds.length === 0) return { action: 'clear', reason: 'invalid' }

  const expectedShippingMethod = normalizedText(retry.shippingMethod)
  const expectedOrderStatus = normalizedText(retry.orderStatus)
  if (!expectedShippingMethod || !expectedOrderStatus) return { action: 'clear', reason: 'legacy' }
  if (!liveStatus) return { action: 'hide', reason: 'status_unavailable' }

  const liveShippingMethod = normalizedText(liveStatus.shippingMethod)
  const liveOrderStatus = normalizedText(liveStatus.orderStatus)
  if (!liveShippingMethod || !liveOrderStatus) return { action: 'hide', reason: 'status_unavailable' }
  const sameLifecycleStatus = expectedOrderStatus === liveOrderStatus
    || (
      FULFILLMENT_PRE_FINAL_STATUSES[expectedShippingMethod]?.has(expectedOrderStatus)
      && liveOrderStatus === FULFILLMENT_FINAL_STATUS[expectedShippingMethod]
    )
  if (
    !FULFILLMENT_SHIPPING_METHODS.has(expectedShippingMethod)
    || !FULFILLMENT_SHIPPING_METHODS.has(liveShippingMethod)
    || expectedShippingMethod !== liveShippingMethod
    || !sameLifecycleStatus
  ) {
    return { action: 'clear', reason: 'lifecycle_changed' }
  }
  if (liveStatus.canCompleteOrder !== true) return { action: 'hide', reason: 'permission' }
  return { action: 'allow', attachmentIds }
}
