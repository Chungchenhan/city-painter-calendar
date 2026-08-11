import assert from 'node:assert/strict'
import {
  backgroundAttachmentDisplayLabel,
  hideCompletedBackgroundUploadPreviews,
  hideRemoteAttachmentsUsingLocalPreviews,
} from '../src/lib/backgroundAttachmentDisplay.ts'

assert.equal(backgroundAttachmentDisplayLabel({
  status: 'uploading',
  progress: 0.64,
  cloudSafe: false,
}), '上傳中 64%')
assert.equal(backgroundAttachmentDisplayLabel({
  status: 'processing',
  progress: 1,
  cloudSafe: true,
}), '已完成')
assert.equal(backgroundAttachmentDisplayLabel({
  status: 'finalizing',
  progress: 1,
  cloudSafe: true,
}), '已完成')
assert.equal(backgroundAttachmentDisplayLabel({
  status: 'failed',
  progress: 1,
  cloudSafe: true,
  error: '背景服務暫時無法使用',
}), '處理失敗：背景服務暫時無法使用')

const uploads = [
  { id: 'pending-a', jobId: 'job-a', name: '相同檔名.jpg' },
  { id: 'pending-b', jobId: 'job-b', name: '相同檔名.jpg' },
  { id: 'pending-without-job', name: '相同檔名.jpg' },
]

assert.deepEqual(
  hideCompletedBackgroundUploadPreviews(uploads, [{ uploadJobId: 'job-a' }]).map((upload) => upload.id),
  ['pending-b', 'pending-without-job'],
)

assert.deepEqual(
  hideCompletedBackgroundUploadPreviews(uploads, [{ uploadJobId: 'unrelated-job' }]).map((upload) => upload.id),
  ['pending-a', 'pending-b', 'pending-without-job'],
)

assert.deepEqual(
  hideCompletedBackgroundUploadPreviews(uploads, [{ uploadJobId: '  ' }]).map((upload) => upload.id),
  ['pending-a', 'pending-b', 'pending-without-job'],
)

const remoteAttachments = [
  { path: 'drive-a', uploadJobId: 'job-a', name: '相同檔名.jpg' },
  { path: 'drive-b', uploadJobId: 'job-b', name: '相同檔名.jpg' },
  { path: 'drive-c', name: '相同檔名.jpg' },
]
assert.deepEqual(
  hideRemoteAttachmentsUsingLocalPreviews(remoteAttachments, [uploads[0]]).map((attachment) => attachment.path),
  ['drive-b', 'drive-c'],
)
assert.deepEqual(
  hideRemoteAttachmentsUsingLocalPreviews(remoteAttachments, [{ attachmentPath: 'drive-c' }]).map((attachment) => attachment.path),
  ['drive-a', 'drive-b'],
)
assert.deepEqual(
  hideRemoteAttachmentsUsingLocalPreviews(remoteAttachments, [{ jobId: 'unrelated-job' }]).map((attachment) => attachment.path),
  ['drive-a', 'drive-b', 'drive-c'],
)

console.log('背景附件完成階段顯示去重測試通過。')
