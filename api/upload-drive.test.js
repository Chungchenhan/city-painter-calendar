import assert from 'node:assert/strict'
import test from 'node:test'
import { buildForwardedLineActionBody, buildForwardedLineActionResponse } from './upload-drive.js'

test('舊的完工 action 只轉送事件與附件資料', () => {
  assert.deepEqual(buildForwardedLineActionBody({
    action: 'complete-order-fulfillment',
    eventId: 'event-1',
    attachmentIds: ['photo-1'],
    amount: 999,
    customerId: 'forged-customer',
    paymentMethod: '匯款'
  }), {
    action: 'complete-order-fulfillment',
    eventId: 'event-1',
    attachmentIds: ['photo-1']
  })
})

test('現金付款 action 只轉送金額與冪等鍵', () => {
  assert.deepEqual(buildForwardedLineActionBody({
    action: 'record-fulfillment-cash-payment',
    eventId: 'event-1',
    amount: 1200,
    idempotencyKey: 'payment-attempt-1',
    attachmentIds: ['photo-1'],
    customerId: 'forged-customer',
    salesId: 'forged-sales',
    paymentMethod: '匯款'
  }), {
    action: 'record-fulfillment-cash-payment',
    eventId: 'event-1',
    amount: 1200,
    idempotencyKey: 'payment-attempt-1'
  })
})

test('只有可管理事件者能取得背景未付款提示', () => {
  const result = {
    ok: true,
    bound: true,
    paymentPrompt: { required: true, outstandingTotal: 5867 }
  }
  assert.deepEqual(buildForwardedLineActionResponse('production-photo-status', result, { canManageEvent: false }), {
    ok: true,
    bound: true,
    paymentPrompt: undefined,
    paymentState: undefined,
    currentOrderUnpaidAmount: undefined,
    outstandingTotal: undefined,
    canCompleteOrder: false
  })
  assert.deepEqual(buildForwardedLineActionResponse('production-photo-status', result, { canManageEvent: true }), {
    ...result,
    canCompleteOrder: true
  })
})
