import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  attachmentThumbnailAttemptCount,
  attachmentThumbnailAttemptSourceIndex,
  attachmentThumbnailSources,
  cacheBustedAttachmentThumbnailUrl,
} from '../src/lib/attachmentThumbnail.ts'

const attachment = {
  name: 'IMG_5527.jpeg',
  type: 'image/jpeg',
  provider: 'google-drive' as const,
  path: 'drive-file-id',
  url: 'https://files.example.com/original.jpg',
  linePreviewUrl: '/api/upload-drive?variant=preview&signature=preview-signature',
  lineOriginalUrl: '/api/upload-drive?variant=original&signature=original-signature',
}

assert.deepEqual(attachmentThumbnailSources(attachment), [
  attachment.linePreviewUrl,
  attachment.lineOriginalUrl,
  'https://drive.google.com/thumbnail?id=drive-file-id&sz=w1000',
  attachment.url,
])
assert.equal(attachmentThumbnailAttemptCount(4), 5)
assert.deepEqual(
  Array.from({ length: 6 }, (_, index) => attachmentThumbnailAttemptSourceIndex(index, 4)),
  [0, 0, 1, 2, 3, -1],
  '第一來源應以 cache-bust 重試一次，再依序回退其餘來源並停止',
)
assert.equal(
  cacheBustedAttachmentThumbnailUrl('/api/image?signature=abc#preview', 'manual 1'),
  '/api/image?signature=abc&cpThumbnailRetry=manual%201#preview',
)
assert.deepEqual(
  attachmentThumbnailSources({ ...attachment, lineOriginalUrl: attachment.linePreviewUrl, url: attachment.linePreviewUrl }),
  [attachment.linePreviewUrl, 'https://drive.google.com/thumbnail?id=drive-file-id&sz=w1000'],
  '相同來源不得重複請求',
)

const calendarPageSource = await readFile(new URL('../src/pages/CalendarPage.tsx', import.meta.url), 'utf8')
assert.match(
  calendarPageSource,
  /async function invalidateSalesCenterAttachments[\s\S]*queryKey: \['sales-center-attachments', user\.uid, eventId\][\s\S]*refetchType: 'active'/,
  '附件中心快取失效時必須立即重抓目前開啟的事件',
)
const processStartIndex = calendarPageSource.indexOf('async function processDurableBackgroundUploads(')
const finishIndex = calendarPageSource.indexOf('await finishBackgroundDetailAttachments(', processStartIndex)
const invalidateIndex = calendarPageSource.indexOf('await invalidateSalesCenterAttachments(group[0].eventId)', finishIndex)
const localPreviewRemovalIndex = calendarPageSource.indexOf('setDetailBackgroundUploads((items) => items.filter', finishIndex)
assert.ok(finishIndex >= 0 && invalidateIndex > finishIndex, '背景照片完成後必須失效附件中心快取')
assert.ok(localPreviewRemovalIndex > invalidateIndex, '遠端附件更新完成前不得移除本機預覽')
assert.ok(
  calendarPageSource.match(/await invalidateSalesCenterAttachments\(group\[0\]\.eventId\)/g)?.length === 2,
  '新背景上傳與舊工作恢復完成後都必須更新附件中心',
)

console.log('附件縮圖重試、來源回退與附件中心快取更新測試通過。')
