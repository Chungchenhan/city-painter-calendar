import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('../src/pages/CalendarPage.tsx', import.meta.url), 'utf8')

test('ERP 配送事件編輯不回寫附件欄位', () => {
  assert.match(source, /delete eventOnlyPayload\.attachments/)
})

test('ERP 配送附件在行事曆編輯器維持唯讀', () => {
  assert.match(source, /完成照片請從事件詳情上傳；如需刪除，請至 ERP 附件中心處理。/)
  assert.match(source, /function handleAttachmentFileChange[\s\S]*?if \(editingSalesDeliveryEvent\) return/)
  assert.match(source, /function removeExistingAttachment[\s\S]*?if \(editingSalesDeliveryEvent\) return/)
  assert.match(source, /function removeUploadedAttachment[\s\S]*?if \(editingSalesDeliveryEvent\) return/)
  assert.match(source, /!editingSalesDeliveryEvent && \([\s\S]*?removeExistingAttachment/)
  assert.match(source, /!editingSalesDeliveryEvent && \([\s\S]*?removeUploadedAttachment/)
})

test('背景儲存後從根事件重讀附件再同步檢視', () => {
  assert.match(source, /await getDoc\(doc\(db, 'calendarEvents', event\.id\)\)/)
  assert.match(source, /await Promise\.all\(viewEvents\.map\(\(event\) => syncCalendarEventViews\(event\)\)\)/)
})

test('附件異動會列入活動紀錄', () => {
  assert.match(source, /\['attachments', '附件'\]/)
})
