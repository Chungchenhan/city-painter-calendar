import type { User } from 'firebase/auth'
import type { FulfillmentPaymentPrompt } from '../types'
import { getAppCheckHeaders } from './firebase'

export type SalesOperationalStatus = {
  eligible: boolean
  bound: boolean
  hasAnyLineBinding?: boolean
  canCompleteOrder?: boolean
  customerCode: string
  customerName: string
  recipientName?: string
  lineDisplayName: string
  lineTargetType?: string
  recipientCount?: number
  notificationMode?: 'recipient' | 'group' | 'recipient_and_group' | 'none'
  availablePersonalCount?: number
  availableGroupCount?: number
  availableGroupNames?: string[]
  salesNo: string
  reason: string
  shippingMethod?: string
  orderStatus?: string
  paymentState?: 'monthly' | 'paid' | 'unpaid' | 'voided'
  currentOrderUnpaidAmount?: number
  outstandingTotal?: number
  paymentPrompt?: FulfillmentPaymentPrompt
}

export type SalesLineStatusPatch = Omit<
  Partial<SalesOperationalStatus>,
  'paymentState' | 'currentOrderUnpaidAmount' | 'outstandingTotal' | 'paymentPrompt'
>

export type SalesPaymentStatusPatch = Pick<
  Partial<SalesOperationalStatus>,
  'paymentState' | 'currentOrderUnpaidAmount' | 'outstandingTotal' | 'paymentPrompt'
>

type ApiErrorPayload = string | { message?: string }

function apiErrorMessage(error: ApiErrorPayload | undefined, fallback: string) {
  if (typeof error === 'string') return error || fallback
  return error?.message || fallback
}

function finitePaymentAmount(value: unknown) {
  const amount = Number(String(value ?? '').replaceAll(',', '').trim())
  return Number.isFinite(amount) ? Math.max(amount, 0) : 0
}

export function normalizeSalesPaymentPrompt(value: unknown): FulfillmentPaymentPrompt | undefined {
  if (!value || typeof value !== 'object') return undefined
  const source = value as Record<string, unknown>
  const paymentState = ['monthly', 'paid', 'unpaid', 'voided'].includes(String(source.paymentState))
    ? source.paymentState as FulfillmentPaymentPrompt['paymentState']
    : undefined
  const outstandingTotal = finitePaymentAmount(source.outstandingTotal ?? source.totalOutstanding)
  const currentOrderUnpaidAmount = finitePaymentAmount(
    source.currentOrderUnpaidAmount ?? source.currentSalesUnpaidAmount ?? source.defaultAmount
  )
  return {
    required: source.required === true && currentOrderUnpaidAmount > 0,
    paymentState,
    customerId: typeof source.customerId === 'string' ? source.customerId : undefined,
    customerCode: typeof source.customerCode === 'string' ? source.customerCode : undefined,
    customerName: typeof source.customerName === 'string' ? source.customerName : undefined,
    outstandingTotal,
    currentOrderUnpaidAmount,
    unpaidOrderCount: finitePaymentAmount(source.unpaidOrderCount) || undefined,
  }
}

export function normalizeSalesOperationalStatus(value: unknown): SalesOperationalStatus | null {
  if (!value || typeof value !== 'object') return null
  const source = value as Record<string, unknown>
  const lineStatus = normalizeSalesLineStatusPatch(source)
  if (!lineStatus || typeof lineStatus.eligible !== 'boolean' || typeof lineStatus.bound !== 'boolean') return null
  return {
    ...lineStatus,
    ...normalizeSalesPaymentStatusPatch(source),
    customerCode: typeof lineStatus.customerCode === 'string' ? lineStatus.customerCode : '',
    customerName: typeof lineStatus.customerName === 'string' ? lineStatus.customerName : '',
    lineDisplayName: typeof lineStatus.lineDisplayName === 'string' ? lineStatus.lineDisplayName : '',
    salesNo: typeof lineStatus.salesNo === 'string' ? lineStatus.salesNo : '',
    reason: typeof lineStatus.reason === 'string' ? lineStatus.reason : '',
  } as SalesOperationalStatus
}

export function splitSalesOperationalStatus(status: SalesOperationalStatus) {
  const {
    paymentState,
    currentOrderUnpaidAmount,
    outstandingTotal,
    paymentPrompt,
    ...lineStatus
  } = status
  return {
    lineStatus: lineStatus satisfies SalesLineStatusPatch,
    paymentStatus: {
      paymentState,
      currentOrderUnpaidAmount,
      outstandingTotal,
      paymentPrompt,
    } satisfies SalesPaymentStatusPatch,
  }
}

export function normalizeSalesLineStatusPatch(value: unknown): SalesLineStatusPatch | null {
  if (!value || typeof value !== 'object') return null
  const source = value as Record<string, unknown>
  const patch: SalesLineStatusPatch = {}
  const keys: (keyof SalesLineStatusPatch)[] = [
    'eligible', 'bound', 'hasAnyLineBinding', 'canCompleteOrder', 'customerCode', 'customerName',
    'recipientName', 'lineDisplayName', 'lineTargetType', 'recipientCount', 'notificationMode',
    'availablePersonalCount', 'availableGroupCount', 'availableGroupNames', 'salesNo', 'reason',
    'shippingMethod', 'orderStatus',
  ]
  keys.forEach((key) => {
    if (source[key] !== undefined) (patch as Record<string, unknown>)[key] = source[key]
  })
  return Object.keys(patch).length > 0 ? patch : null
}

export function normalizeSalesPaymentStatusPatch(value: unknown): SalesPaymentStatusPatch | null {
  if (!value || typeof value !== 'object') return null
  const source = value as Record<string, unknown>
  const paymentState = ['monthly', 'paid', 'unpaid', 'voided'].includes(String(source.paymentState))
    ? source.paymentState as SalesOperationalStatus['paymentState']
    : undefined
  const patch: SalesPaymentStatusPatch = {
    ...(paymentState ? { paymentState } : {}),
    ...(source.currentOrderUnpaidAmount !== undefined
      ? { currentOrderUnpaidAmount: finitePaymentAmount(source.currentOrderUnpaidAmount) }
      : {}),
    ...(source.outstandingTotal !== undefined
      ? { outstandingTotal: finitePaymentAmount(source.outstandingTotal) }
      : {}),
    ...(source.paymentPrompt !== undefined
      ? { paymentPrompt: normalizeSalesPaymentPrompt(source.paymentPrompt) }
      : {}),
  }
  return Object.keys(patch).length > 0 ? patch : null
}

export async function fetchSalesOperationalStatus(user: User, eventId: string) {
  const token = await user.getIdToken()
  const appCheckHeaders = await getAppCheckHeaders()
  const response = await fetch('/api/upload-drive', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...appCheckHeaders,
    },
    body: JSON.stringify({ action: 'production-photo-status', eventId }),
  })
  const result = await response.json().catch(() => null) as (
    Record<string, unknown> & { ok?: boolean, error?: ApiErrorPayload }
  ) | null
  if (!response.ok || result?.ok !== true) {
    throw new Error(apiErrorMessage(result?.error, '訂單狀態讀取失敗'))
  }
  const normalized = normalizeSalesOperationalStatus(result)
  if (!normalized) throw new Error('訂單狀態格式不正確')
  return normalized
}
