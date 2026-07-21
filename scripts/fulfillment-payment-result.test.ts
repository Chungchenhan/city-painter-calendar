import assert from 'node:assert/strict'
import {
  fulfillmentPaymentNotice,
  fulfillmentPaymentSuccessMessage,
} from '../src/lib/fulfillmentPaymentResult.ts'

assert.deepEqual(fulfillmentPaymentNotice({
  message: '現金收款完成，已沖帳 1,000 元。',
  lineWarning: 'LINE 通知傳送失敗，請稍後重試。',
}), {
  variant: 'error',
  message: '收款完成，但 LINE 通知：傳送失敗，請稍後重試。',
})

assert.deepEqual(fulfillmentPaymentNotice({
  message: '現金收款完成，已沖帳 1,000 元。',
  warning: '客戶 LINE 目前無法使用。',
}), {
  variant: 'error',
  message: '收款完成，但 LINE 通知：客戶 LINE 目前無法使用。',
})

assert.deepEqual(fulfillmentPaymentNotice({
  message: '現金收款完成。',
  lineNotification: { sent: true },
}), {
  variant: 'success',
  message: '現金收款完成。LINE 收款通知已傳送。',
})

assert.deepEqual(fulfillmentPaymentNotice({
  message: '現金收款完成。',
  lineNotification: { skipped: true, reason: 'line_notification_mode_none' },
}), {
  variant: 'success',
  message: '現金收款完成。此銷售單設定為不傳送 LINE，通知已略過。',
})

assert.equal(fulfillmentPaymentSuccessMessage({
  reconcileNo: 'A260721001',
  appliedAmount: 1_000,
  overAmount: 200,
}), '沖帳單 A260721001，沖帳 $1,000，溢收 $200')

assert.equal(fulfillmentPaymentSuccessMessage({}), '現金收款已登錄')

console.log('fulfillment-payment-result tests passed')
