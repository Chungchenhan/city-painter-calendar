import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { attachmentUploadLabel } from '../src/lib/attachmentUploadMetadata.ts'

test('附件標題優先顯示姓名並格式化上傳時間', () => {
  assert.equal(attachmentUploadLabel({
    uploadedByName: '小明',
    uploadedByEmployeeNo: 'C100001',
    uploadedAt: '2026-09-05T10:20:30+08:00',
  }), '小明 2026/09/05 10:20:30 上傳')
})

test('附件標題缺姓名時依序回退員工編號與舊建立時間', () => {
  assert.equal(attachmentUploadLabel({
    uploadedByEmployeeNo: 'C100001',
    createdAtText: '2026/09/04 09:08:07',
  }), 'C100001 2026/09/04 09:08:07 上傳')
  assert.equal(attachmentUploadLabel({}), '未提供 未提供 上傳')
})

test('行事曆 lightbox 將完整標題資料交給共用 Viewer', async () => {
  const [pageSource, viewerSource] = await Promise.all([
    readFile(new URL('../src/pages/CalendarPage.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/shared/AttachmentImageViewer.tsx', import.meta.url), 'utf8'),
  ])
  assert.match(pageSource, /metadataLabel: uploadLabel/u)
  assert.match(pageSource, /countLabel: attachmentIndex >= 0/u)
  assert.match(viewerSource, /standard-attachment-viewer-header-metadata/u)
  assert.match(viewerSource, /standard-attachment-viewer-header-count/u)
  assert.match(viewerSource, /standard-attachment-viewer-header-title strong \{[\s\S]*?flex: 0 1 auto;/u)
  assert.match(viewerSource, /standard-attachment-viewer-header-metadata \{[\s\S]*?margin-left: auto;/u)
})
