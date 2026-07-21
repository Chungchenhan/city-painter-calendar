export type FulfillmentPaymentLineNotification = {
  sent?: boolean
  skipped?: boolean
  reused?: boolean
  reason?: string
  message?: string
}

export type FulfillmentCashPaymentResult = {
  reconcileNo?: string
  appliedAmount?: number
  overAmount?: number
  paymentState?: 'paid' | 'unpaid'
  currentOrderUnpaidAmount?: number
  outstandingTotal?: number
  message?: string
  lineWarning?: string
  warning?: string
  lineNotification?: FulfillmentPaymentLineNotification
}

export type FulfillmentPaymentNotice = {
  variant: 'success' | 'error' | 'muted'
  message: string
}

function text(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

function appendNotice(base: string, detail: string) {
  if (!detail || base.includes(detail)) return base
  return `${base}${/[。！？]$/u.test(base) ? '' : '。'}${detail}`
}

function skippedLineMessage(notification: FulfillmentPaymentLineNotification) {
  const message = text(notification.message)
  if (message) return message
  const reason = text(notification.reason)
  if (reason === 'customer_not_bound' || reason === 'no_recipient') return '客戶尚未綁定可用的 LINE，通知已略過。'
  if (reason === 'notification_disabled' || reason === 'line_notification_mode_none') return '此銷售單設定為不傳送 LINE，通知已略過。'
  if (reason === 'auto_disabled') return '收款 LINE 通知尚未啟用，已略過。'
  if (reason === 'already_sent') return 'LINE 收款通知先前已傳送。'
  return 'LINE 收款通知已略過。'
}

export function fulfillmentPaymentSuccessMessage(result: FulfillmentCashPaymentResult) {
  const provided = text(result.message)
  if (provided) return provided
  const appliedAmount = Number.isFinite(Number(result.appliedAmount)) ? Number(result.appliedAmount) : 0
  const overAmount = Number.isFinite(Number(result.overAmount)) ? Number(result.overAmount) : 0
  return [
    result.reconcileNo ? `沖帳單 ${result.reconcileNo}` : '現金收款已登錄',
    appliedAmount > 0 ? `沖帳 $${appliedAmount.toLocaleString('zh-TW')}` : '',
    overAmount > 0 ? `溢收 $${overAmount.toLocaleString('zh-TW')}` : '',
  ].filter(Boolean).join('，')
}

export function fulfillmentPaymentNotice(result: FulfillmentCashPaymentResult): FulfillmentPaymentNotice {
  const paymentMessage = fulfillmentPaymentSuccessMessage(result)
  const warning = text(result.lineWarning) || text(result.warning)
  if (warning) {
    const detail = warning
      .replace(/^收款完成[，,；;:\s]*(?:但)?\s*/u, '')
      .replace(/^LINE\s*通知[：:,，\s]*/iu, '')
    return {
      variant: 'error',
      message: `收款完成，但 LINE 通知${detail ? `：${detail}` : '未成功。'}`,
    }
  }

  const lineNotification = result.lineNotification
  if (lineNotification?.sent) {
    const lineMessage = text(lineNotification.message) || (lineNotification.reused
      ? 'LINE 收款通知先前已傳送。'
      : 'LINE 收款通知已傳送。')
    return { variant: 'success', message: appendNotice(paymentMessage, lineMessage) }
  }
  if (lineNotification?.skipped) {
    return { variant: 'success', message: appendNotice(paymentMessage, skippedLineMessage(lineNotification)) }
  }
  return { variant: 'success', message: paymentMessage }
}
