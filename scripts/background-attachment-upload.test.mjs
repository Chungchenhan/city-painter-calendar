import assert from 'node:assert/strict'

process.env.LINE_IMAGE_SIGNING_SECRET = 'test-secret'
const {
  attachmentFromUploadJob,
  buildForwardedLineActionBody,
  attachmentUploadJobDocumentId,
  mergeProductionLineRetryAttachmentIds,
  parseAttachmentUploadJobRequest,
} = await import('../api/upload-drive.js')

const parsed = parseAttachmentUploadJobRequest({
  eventId: 'event-1',
  originalName: '施工現場.jpg',
  originalSize: 1024,
  contentType: 'image/jpeg',
  completionMode: 'fulfillment',
  clientUploadId: '019fbb0c-99fb-7770-8e29-a0a8709621f8',
  fulfillmentBatchId: 'fulfillment-batch-1',
  fulfillmentBatchSize: 1,
  capture: {
    capturedAt: '2026-08-01T01:02:03.000Z',
    capturedAtSource: 'exif',
  },
})
assert.equal(parsed.eventId, 'event-1')
assert.equal(parsed.completionMode, 'fulfillment')
assert.equal(parsed.clientUploadId, '019fbb0c-99fb-7770-8e29-a0a8709621f8')
assert.equal(parsed.fulfillmentBatchId, 'fulfillment-batch-1')
assert.equal(parsed.fulfillmentBatchSize, 1)
assert.equal(parsed.capture.capturedAtSource, 'exif')

const durableJobId = attachmentUploadJobDocumentId('user-1', parsed.clientUploadId)
assert.equal(durableJobId, attachmentUploadJobDocumentId('user-1', parsed.clientUploadId))
assert.notEqual(durableJobId, attachmentUploadJobDocumentId('user-2', parsed.clientUploadId))
assert.match(durableJobId, /^calendar-[a-f0-9]{48}$/)

assert.throws(() => parseAttachmentUploadJobRequest({
  eventId: 'event-1',
  originalName: '施工現場.jpg',
  originalSize: 1024,
  contentType: 'image/jpeg',
  completionMode: 'fulfillment',
  clientUploadId: '../../unsafe',
}), /佇列識別碼/)

assert.throws(() => parseAttachmentUploadJobRequest({
  eventId: 'event-1',
  originalName: 'unsafe.svg',
  originalSize: 10,
  contentType: 'image/svg+xml',
  completionMode: 'none',
}), /只能上傳照片/)

assert.throws(() => parseAttachmentUploadJobRequest({
  eventId: 'event-1',
  originalName: 'too-large.jpg',
  originalSize: 50 * 1024 * 1024 + 1,
  contentType: 'image/jpeg',
  completionMode: 'production',
}), /50 MB/)

const attachment = attachmentFromUploadJob('job-1', {
  uploadedByUid: 'user-1',
  uploadedByEmployeeNo: 'C100001',
  uploadedByName: '小明',
  original: { name: '施工現場.jpg', size: 4096, type: 'image/jpeg' },
  capture: { capturedAtSource: 'unknown' },
  result: {
    image: {
      path: 'drive-image-id',
      url: 'https://drive.google.com/image',
      name: '施工現場.webp',
      size: 2048,
      type: 'image/webp',
      uploadedAt: '2026-08-01T02:00:00.000Z',
    },
    thumbnail: {
      path: 'drive-thumbnail-id',
      url: 'https://drive.google.com/thumbnail',
      name: '施工現場-thumb.webp',
      size: 512,
      type: 'image/webp',
    },
  },
})
assert.equal(attachment.path, 'drive-image-id')
assert.equal(attachment.thumbnailPath, 'drive-thumbnail-id')
assert.equal(attachment.originalName, '施工現場.jpg')
assert.equal(attachment.uploadJobId, 'job-1')
assert.equal(attachment.uploadedByUid, 'user-1')
assert.equal(attachment.uploadedByEmployeeNo, 'C100001')
assert.equal(attachment.uploadedByName, '小明')
assert.match(attachment.lineOriginalUrl, /fileId=drive-image-id/)

assert.deepEqual(
  mergeProductionLineRetryAttachmentIds(
    { mode: 'fulfillment', attachmentIds: ['drive-image-a', 'drive-image-b'] },
    'fulfillment',
    'drive-image-c',
  ),
  ['drive-image-a', 'drive-image-b', 'drive-image-c'],
)
assert.deepEqual(
  mergeProductionLineRetryAttachmentIds(
    { mode: 'fulfillment', attachmentIds: ['drive-image-a'] },
    'production',
    'drive-image-b',
  ),
  ['drive-image-b'],
)

console.log('背景附件上傳 API helper 測試通過。')

const batchRequest = {
  eventId: 'event-1', originalName: '配達.jpg', originalSize: 100,
  contentType: 'image/jpeg', completionMode: 'fulfillment',
  fulfillmentBatchId: 'photos-batch-1', fulfillmentBatchSize: 2,
  fulfillmentRequestId: 'delivery-request-1',
  fulfillmentOrders: [
    { eventId: 'event-1', salesId: 'sale-1', expectedShippingMethod: '外送', expectedOrderStatus: '即將配送' },
    { eventId: 'event-2', salesId: 'sale-2', expectedShippingMethod: '外送', expectedOrderStatus: '即將配送' },
  ],
}
assert.deepEqual(parseAttachmentUploadJobRequest(batchRequest).fulfillmentOrders, batchRequest.fulfillmentOrders)
assert.equal(parseAttachmentUploadJobRequest(batchRequest).fulfillmentRequestId, 'delivery-request-1')
assert.throws(() => parseAttachmentUploadJobRequest({ ...batchRequest, fulfillmentRequestId: '' }), /識別碼/)
assert.throws(() => parseAttachmentUploadJobRequest({ ...batchRequest, fulfillmentOrders: [batchRequest.fulfillmentOrders[0], batchRequest.fulfillmentOrders[0]] }), /重複/)
assert.throws(() => parseAttachmentUploadJobRequest({ ...batchRequest, eventId: 'event-3' }), /未包含/)
assert.throws(() => parseAttachmentUploadJobRequest({ ...batchRequest, fulfillmentOrders: batchRequest.fulfillmentOrders.map(row => ({ ...row, expectedShippingMethod: '自取' })) }), /不正確/)

assert.deepEqual(buildForwardedLineActionBody({
  action: 'complete-order-fulfillment', eventId: 'event-1',
  orders: batchRequest.fulfillmentOrders, batchId: 'delivery-request-1', preflight: true,
}).orders, batchRequest.fulfillmentOrders)
assert.equal(buildForwardedLineActionBody({ action: 'complete-order-fulfillment', orders: batchRequest.fulfillmentOrders, preflight: true }).preflight, true)
