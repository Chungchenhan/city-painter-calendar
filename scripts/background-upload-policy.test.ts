import assert from 'node:assert/strict'
import test from 'node:test'
import { createCloudSafeBatchNotice, shouldUseCalendarCloudUpload } from '../src/lib/backgroundAttachmentUploadPolicy.ts'

test('正式站原圖上雲，本機僅在功能已啟用時使用', () => {
  assert.equal(shouldUseCalendarCloudUpload(false, undefined), true)
  assert.equal(shouldUseCalendarCloudUpload(false, 'false'), true)
  assert.equal(shouldUseCalendarCloudUpload(true, undefined), false)
  assert.equal(shouldUseCalendarCloudUpload(true, 'false'), false)
  assert.equal(shouldUseCalendarCloudUpload(true, 'true'), true)
})

test('已建立的雲端工作即使本機開關關閉仍須沿用，不得重傳或改跑完工', () => {
  assert.equal(shouldUseCalendarCloudUpload(true, undefined, 'job-1'), true)
})

test('照片須全部上雲才提示一次，重複回呼和轉檔完成不再提示', () => {
  const safe = createCloudSafeBatchNotice([{ id: 'a', cloudSafe: false }, { id: 'b', cloudSafe: false }])
  assert.equal(safe('a'), false)
  assert.equal(safe('a'), false)
  assert.equal(safe('b'), true)
  assert.equal(safe('b'), false)
  assert.equal(safe('a'), false)
})

test('恢復已上雲的整批照片不重播成功，仍在傳輸的部分完成才提示', () => {
  const completed = createCloudSafeBatchNotice([{ id: 'a', cloudSafe: true }])
  assert.equal(completed('a'), false)
  const partial = createCloudSafeBatchNotice([{ id: 'a', cloudSafe: true }, { id: 'b', cloudSafe: false }])
  assert.equal(partial('a'), false)
  assert.equal(partial('b'), true)
})

test('未知照片不計入完成張數，空批次不提示', () => {
  const safe = createCloudSafeBatchNotice([{ id: 'a', cloudSafe: false }])
  assert.equal(safe('unknown'), false)
  assert.equal(safe('a'), true)
  assert.equal(createCloudSafeBatchNotice([])('unknown'), false)
})
