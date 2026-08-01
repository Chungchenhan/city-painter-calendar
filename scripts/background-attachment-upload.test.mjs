import assert from 'node:assert/strict'

process.env.LINE_IMAGE_SIGNING_SECRET = 'test-secret'
const {
  attachmentFromUploadJob,
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
  capture: {
    capturedAt: '2026-08-01T01:02:03.000Z',
    capturedAtSource: 'exif',
  },
})
assert.equal(parsed.eventId, 'event-1')
assert.equal(parsed.completionMode, 'fulfillment')
assert.equal(parsed.clientUploadId, '019fbb0c-99fb-7770-8e29-a0a8709621f8')
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
