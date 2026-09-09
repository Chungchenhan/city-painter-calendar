import assert from 'node:assert/strict'
import { test } from 'node:test'
import { calendarAttachmentThumbnailAccess } from '../src/lib/attachmentThumbnail.ts'
const base = { name: 'photo.jpg', type: 'image/jpeg', url: '' }
test('Drive path空時從網址解析，仍須授權而非舊網址回退', () => {
  const result = calendarAttachmentThumbnailAccess({ ...base, provider: 'google-drive', url: 'https://drive.google.com/file/d/abcdefghijk/view' })
  assert.equal(result.fileId, 'abcdefghijk')
  assert.equal(result.requiresAuthorization, true)
  assert.deepEqual(result.sources, [])
})
test('無法識別的Drive附件不pending且沒有不受保護的回退', () => {
  const result = calendarAttachmentThumbnailAccess({ ...base, provider: 'google-drive', path: 'old/path', url: 'https://drive.google.com/file/d/invalid/view' })
  assert.equal(result.fileId, '')
  assert.equal(result.requiresAuthorization, true)
  assert.deepEqual(result.sources, [])
})
test('Firebase與一般來源不走Drive授權', () => {
  const result = calendarAttachmentThumbnailAccess({ ...base, provider: 'firebase-storage', path: 'calendar/photos/old.jpg', url: 'https://firebasestorage.googleapis.com/v0/b/test/o/photo' })
  assert.equal(result.fileId, '')
  assert.equal(result.requiresAuthorization, false)
  assert.equal(result.sources.length, 1)
})
test('sales-attachment保留自己的受保護來源且不加入舊Drive縮圖', () => {
  const result = calendarAttachmentThumbnailAccess({ ...base, provider: 'google-drive', path: 'abcdefghijk', linePreviewUrl: '/api/upload-drive?scope=sales-attachment&fileId=abcdefghijk&signature=valid', url: 'https://drive.google.com/file/d/abcdefghijk/view' })
  assert.equal(result.requiresAuthorization, false)
  assert.equal(result.fileId, '')
  assert.equal(result.sources.length, 1)
  assert.match(result.sources[0], /scope=sales-attachment/)
})
