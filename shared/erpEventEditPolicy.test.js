import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { canEditOrCopyErpEvent } from './erpEventEditPolicy.js'

test('ERP 主事件、附屬事件依員工 ID 限制，不依姓名；一般事件不變', () => {
  for (const employeeId of ['emp_085101', 'emp_239215']) {
    for (const sourceEventRole of ['primary', 'related', undefined]) {
      assert.equal(canEditOrCopyErpEvent(employeeId, { source: 'erpSalesDelivery', sourceEventRole }), false)
    }
    assert.equal(canEditOrCopyErpEvent(employeeId, { source: 'timeTreeImport' }), true)
    assert.equal(canEditOrCopyErpEvent(employeeId, {}), true)
  }
  assert.equal(canEditOrCopyErpEvent('other-employee', { source: 'erpSalesDelivery', name: '怡姍' }), true)
  assert.equal(canEditOrCopyErpEvent(null, { source: 'erpSalesDelivery' }), false)
})

test('編輯、複製、存檔及拖曳均有權限防護，完成照片仍走既有管理權限', () => {
  const source = readFileSync(new URL('../src/pages/CalendarPage.tsx', import.meta.url), 'utf8')
  for (const entry of ['openEditEvent', 'openCopyEvent', 'startEditEvent', 'eventDragAllowed']) {
    const start = source.indexOf(`function ${entry}(`)
    assert.ok(start >= 0)
    assert.match(source.slice(start, start + 400), /canEditOrCopyErpEvent\(employeeId, event\)/u)
  }
  assert.match(source, /canEditOrCopyErpEvent\(employeeId, editingEvent \?\? copySourceEvent\)/u)
  assert.match(source, /\{canEditOrCopyEvent && \(<>/u)
  const upload = source.slice(source.indexOf('function canUploadDetailAttachment('), source.indexOf('function eventTitleOverrideAppliesToViewer('))
  assert.match(upload, /canManageCalendarEvent\(event\)/u)
  assert.doesNotMatch(upload, /canEditOrCopyErpEvent/u)
})


test('刪除選單與兩個執行入口都套用 ERP 限制名單', async () => {
  const source = await readFile(new URL('../src/pages/CalendarPage.tsx', import.meta.url), 'utf8')
  assert.match(source, /const canDeleteEvent = canManageEvent && canEditOrCopyErpEvent\(employeeId, selectedEvent\)/)
  assert.match(source, /\{canDeleteEvent && \(/)
  for (const name of ['deleteEvent', 'applyDeleteEvent']) {
    const start = source.indexOf(`async function ${name}(`)
    const end = source.indexOf('\n  async function ', start + 1)
    assert.match(source.slice(start, end > start ? end : undefined), /!canEditOrCopyErpEvent\(employeeId, event\)/)
  }
})
