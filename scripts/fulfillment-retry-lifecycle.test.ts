import assert from 'node:assert/strict'
import { fulfillmentRetryDecision } from '../src/lib/fulfillmentRetryLifecycle.ts'

const live = {
  shippingMethod: '施工',
  orderStatus: '生產中',
  canCompleteOrder: true,
}

assert.deepEqual(fulfillmentRetryDecision({
  mode: 'fulfillment',
  status: 'failed',
  attachmentIds: ['photo-a', 'photo-a', 'photo-b'],
  shippingMethod: '施工',
  orderStatus: '生產中',
}, live), {
  action: 'allow',
  attachmentIds: ['photo-a', 'photo-b'],
})

assert.deepEqual(fulfillmentRetryDecision({
  mode: 'fulfillment',
  status: 'failed',
  attachmentIds: ['photo-a'],
}, live), { action: 'clear', reason: 'legacy' })

assert.deepEqual(fulfillmentRetryDecision({
  mode: 'fulfillment',
  status: 'pending',
  attachmentIds: ['photo-a'],
  shippingMethod: '外送',
  orderStatus: '生產中',
}, live), { action: 'clear', reason: 'lifecycle_changed' })

assert.deepEqual(fulfillmentRetryDecision({
  mode: 'fulfillment',
  status: 'failed',
  attachmentIds: ['photo-a'],
  shippingMethod: '施工',
  orderStatus: '生產中',
}, {
  ...live,
  orderStatus: '已完成',
}), { action: 'allow', attachmentIds: ['photo-a'] })

assert.deepEqual(fulfillmentRetryDecision({
  mode: 'fulfillment',
  status: 'failed',
  attachmentIds: ['photo-a'],
  shippingMethod: '外送',
  orderStatus: '生產中',
}, {
  ...live,
  shippingMethod: '外送',
  orderStatus: '已送達',
}), { action: 'allow', attachmentIds: ['photo-a'] })

assert.deepEqual(fulfillmentRetryDecision({
  mode: 'fulfillment',
  status: 'failed',
  attachmentIds: ['photo-a'],
  shippingMethod: '施工',
  orderStatus: '已完成',
}, live), { action: 'clear', reason: 'lifecycle_changed' })

assert.deepEqual(fulfillmentRetryDecision({
  mode: 'fulfillment',
  status: 'processing',
  attachmentIds: ['photo-a'],
  shippingMethod: '施工',
  orderStatus: '生產中',
}, live), { action: 'hide', reason: 'processing' })

assert.deepEqual(fulfillmentRetryDecision({
  mode: 'fulfillment',
  status: 'failed',
  attachmentIds: ['photo-a'],
  shippingMethod: '施工',
  orderStatus: '生產中',
}, { ...live, canCompleteOrder: false }), { action: 'hide', reason: 'permission' })

assert.deepEqual(fulfillmentRetryDecision({
  mode: 'fulfillment',
  status: 'failed',
  attachmentIds: ['photo-a'],
  shippingMethod: '施工',
  orderStatus: '生產中',
}, null), { action: 'hide', reason: 'status_unavailable' })

assert.deepEqual(fulfillmentRetryDecision({
  mode: 'production',
  status: 'failed',
  attachmentIds: ['photo-a'],
  shippingMethod: '施工',
  orderStatus: '生產中',
}, live), { action: 'clear', reason: 'invalid' })

console.log('fulfillment retry lifecycle tests passed')
