import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  ERP_SALES_DELIVERY_RELATED_INDEPENDENT_FIELDS,
  ERP_SALES_DELIVERY_RELATED_SHARED_FIELDS,
  erpSalesDeliveryPrimaryEventId,
  isPrimaryErpSalesDeliveryEvent,
  isRelatedErpSalesDeliveryEvent,
  primarySyncFieldsForRelatedEdit,
  relatedErpSalesDeliveryFields,
} from '../src/lib/erpSalesDeliveryEventRelation.ts'

const primary = {
  id: 'erpSalesDelivery_sales-1',
  source: 'erpSalesDelivery',
  sourceId: 'sales-1',
  sourceSalesNo: '263830',
  sourceCustomerCode: 'S12236',
  sourceCustomerName: '客戶甲',
  sourceShippingMethod: '外送',
}

test('編輯期間暫停事件詳情的外部點擊關閉，取消與 Esc 不清除原事件', () => {
  const source = readFileSync(new URL('../src/pages/CalendarPage.tsx', import.meta.url), 'utf8')
  assert.match(source, /if \(!selectedEventId \|\| showEventModal\) return\s+function closeEventDetail/u)
  assert.match(source, /\[selectedEventId, showEventModal, showRelatedEventsPanel, fulfillmentPaymentModal, enlargedEventAttachment\]/u)
  assert.match(source, /if \(event.key === 'Escape' && showRelatedEventsPanel\) \{\s+event.preventDefault\(\)\s+event.stopImmediatePropagation\(\)\s+setShowRelatedEventsPanel\(false\)\s+return/u)
  const closeEditor = source.slice(source.indexOf('function closeEventModal()'), source.indexOf('function handleAttachmentFileChange'))
  assert.doesNotMatch(closeEditor, /setSelectedEventId\(null\)/u)
  assert.match(closeEditor, /event\.stopImmediatePropagation\(\)/u)
})

test('舊 ERP 銷貨事件缺少角色欄位時仍視為不可刪除的主事件', () => {
  assert.equal(isPrimaryErpSalesDeliveryEvent(primary), true)
  assert.equal(isRelatedErpSalesDeliveryEvent(primary), false)
  assert.equal(erpSalesDeliveryPrimaryEventId(primary), primary.id)
})

test('複製 ERP 主事件會保留銷貨關聯並標記為附屬事件', () => {
  assert.deepEqual(relatedErpSalesDeliveryFields(primary), {
    source: 'erpSalesDelivery',
    sourceId: 'sales-1',
    sourceSalesNo: '263830',
    sourceCustomerCode: 'S12236',
    sourceCustomerName: '客戶甲',
    sourceShippingMethod: '外送',
    sourceEventRole: 'related',
    sourceParentEventId: primary.id,
  })
})

test('再次複製附屬事件仍指向最上層 ERP 主事件', () => {
  const related = {
    ...primary,
    id: 'related-1',
    sourceEventRole: 'related' as const,
    sourceParentEventId: primary.id,
  }
  assert.equal(erpSalesDeliveryPrimaryEventId(related), primary.id)
  assert.equal(relatedErpSalesDeliveryFields(related).sourceParentEventId, primary.id)
})

test('附屬事件名稱日期時間保持獨立，只有真正變更的共用欄位套用到主事件', () => {
  const primaryFields = {
    title: '👷 主事件',
    date: '2026-09-10',
    endDate: '2026-09-10',
    startTime: '09:00',
    endTime: '10:00',
    allDay: false,
    location: '舊地址',
    calendarId: 'primary-calendar',
    calendarIds: ['primary-calendar'],
    departmentId: 'primary-department',
    assigneeIds: ['primary-owner'],
    visibleDepartmentIds: [],
    visibleAssigneeIds: [],
    hiddenDepartmentIds: [],
    hiddenAssigneeIds: [],
    titleOverrides: [],
    reminder: '1h',
    url: 'https://primary.example',
  }
  const relatedBefore = {
    ...primaryFields,
    title: '📦 附屬事件',
    date: '2026-09-12',
    endDate: '2026-09-12',
    startTime: '13:00',
    endTime: '14:00',
    calendarId: 'related-calendar',
    calendarIds: ['related-calendar'],
    departmentId: 'related-department',
    reminder: 'none',
    url: '',
  }
  const relatedNext = {
    ...relatedBefore,
    title: '📦 附屬事件新名稱',
    date: '2026-09-13',
    endDate: '2026-09-13',
    startTime: '15:00',
    endTime: '16:00',
    location: '新地址',
    departmentId: 'shared-department',
  }

  const nextPrimary = primarySyncFieldsForRelatedEdit(primaryFields, relatedBefore, relatedNext)

  for (const field of ERP_SALES_DELIVERY_RELATED_INDEPENDENT_FIELDS) {
    assert.deepEqual(nextPrimary[field], primaryFields[field])
  }
  assert.equal(nextPrimary.location, '新地址')
  assert.equal(nextPrimary.departmentId, 'shared-department')
  assert.equal(nextPrimary.calendarId, 'primary-calendar')
  assert.equal(nextPrimary.reminder, '1h')
  assert.equal(nextPrimary.url, 'https://primary.example')
  assert.deepEqual(ERP_SALES_DELIVERY_RELATED_SHARED_FIELDS, [
    'location', 'calendarId', 'calendarIds', 'departmentId', 'assigneeIds',
    'visibleDepartmentIds', 'visibleAssigneeIds', 'hiddenDepartmentIds',
    'hiddenAssigneeIds', 'titleOverrides', 'reminder', 'url',
  ])
})

test('前端同時隱藏主事件刪除入口並將 App Check 傳給刪除 API', () => {
  const source = readFileSync(new URL('../src/pages/CalendarPage.tsx', import.meta.url), 'utf8')
  assert.match(source, /if \(isPrimaryErpSalesDeliveryEvent\(event\)\) \{[\s\S]{0,240}不可在行事曆刪除/u)
  assert.match(source, /fetch\('\/api\/delete-calendar-event',[\s\S]{0,400}\.\.\.appCheckHeaders/u)
  assert.match(source, /!isPrimaryErpSalesDeliveryEvent\(selectedEvent\) && \(/u)
})

test('事件詳情只保留上方選單操作，不顯示底部重複按鈕', () => {
  const source = readFileSync(new URL('../src/pages/CalendarPage.tsx', import.meta.url), 'utf8')
  assert.match(source, /className="event-detail-action-menu"[\s\S]{0,900}>\s*編輯\s*<\/[\s\S]{0,300}>\s*複製\s*<\/[\s\S]{0,500}>\s*刪除\s*</u)
  assert.doesNotMatch(source, /event-detail-footer/u)
})

test('一般附屬事件維持唯讀，施工排程及撤場使用獨立完成流程', () => {
  const source = readFileSync(new URL('../src/pages/CalendarPage.tsx', import.meta.url), 'utf8')
  assert.match(source, /function isErpOrderFulfillmentEvent[\s\S]{0,240}!isOperationalErpSalesDeliveryEvent\(event\)/u)
  assert.match(source, /const salesOperationalEventId = isErpSalesWorkScheduleEvent\(selectedEvent\)[\s\S]{0,100}selectedEvent\?\.id/u)
  assert.match(source, /const salesAttachmentEventId = isErpSalesDeliveryEvent\(selectedEvent\)[\s\S]{0,160}erpSalesDeliveryPrimaryEventId\(selectedEvent\)/u)
  assert.match(source, /const canUploadAttachment = Boolean\(selectedOperationalEvent && \(!isRelatedErpSalesDeliveryEvent\(selectedOperationalEvent\) \|\| isErpSalesWorkScheduleEvent\(selectedOperationalEvent\)\)/u)
  assert.match(source, /function eventDragAllowed\(event: CalendarEvent\) \{\s+return canEditOrCopyErpEvent\(employeeId, event\) && !isRelatedErpSalesDeliveryEvent\(event\) && canManageCalendarEvent\(event\)/u)
  assert.match(source, /async function toggleDetailTodo[\s\S]{0,320}isRelatedErpSalesDeliveryEvent\(selectedEvent\)/u)
  assert.match(source, /disabled=\{!selectedOperationalEvent[\s\S]{0,220}isRelatedErpSalesDeliveryEvent\(selectedOperationalEvent\)\}/u)
})

test('既有附屬事件儲存前確認變更，確認後同步主事件且保持關聯與附件不可變', () => {
  const source = readFileSync(new URL('../src/pages/CalendarPage.tsx', import.meta.url), 'utf8')
  assert.match(source, /if \(editingEvent && isRelatedErpSalesDeliveryEvent\(editingEvent\)\)[\s\S]{0,1800}僅修改此事件的名稱、日期與時間：[\s\S]{0,300}地址會同步所有關聯事件與 ERP 銷貨單，並清除舊郵遞區號：[\s\S]{0,300}其他共用變更會同步主事件與附屬事件：/u)
  assert.match(source, /async function syncRelatedSalesDeliveryEvent[\s\S]{0,2400}action: RELATED_SALES_DELIVERY_EVENT_SYNC_ACTION/u)
  assert.match(source, /primarySyncFieldsForRelatedEdit\([\s\S]{0,300}expectedPrimaryFields,[\s\S]{0,200}expectedRelatedFields,[\s\S]{0,200}relatedNextFields/u)
  assert.match(source, /calendarTitle: titleWithoutKnownIcon\(primaryEvent\.title, titleIconOptions\)\.trim\(\)[\s\S]{0,500}events: \{[\s\S]{0,200}related: relatedNextFields,[\s\S]{0,100}primary: primaryNextFields/u)
  assert.doesNotMatch(source, /events: \{\s+related: nextFields,\s+primary: nextFields/u)
  assert.match(source, /queryClient\.ensureQueryData\([\s\S]{0,300}erp-sales-delivery-related-events/u)
  assert.doesNotMatch(source, /async function syncRelatedSalesDeliveryEvent[\s\S]{0,900}getDoc\(/u)
  assert.match(source, /await syncRelatedSalesDeliveryEvent\(editingEvent, payload\)[\s\S]{0,200}await refreshCalendarData\(\)[\s\S]{0,200}setShowEventModal\(false\)/u)
  assert.match(source, /salesDeliveryAttachmentReadonly/u)
  assert.match(source, /className=\{`event-static-row event-repeat-button[\s\S]{0,300}disabled=\{relatedSalesDeliveryDraft\}/u)
  assert.match(source, /const salesDeliverySystemNoteReadonly = editingSalesDeliveryEvent \|\| isErpSalesDeliveryEvent\(copySourceEvent\)/u)
  assert.match(source, /!salesDeliverySystemNoteReadonly && \([\s\S]{0,220}<div className="event-editor-row note">[\s\S]{0,220}<textarea/u)
  assert.doesNotMatch(source, /<textarea[\s\S]{0,180}disabled=\{relatedSalesDeliveryDraft\}/u)
  assert.match(source, /aria-label="待辦完成"[\s\S]{0,100}disabled=\{relatedSalesDeliveryDraft\}|disabled=\{relatedSalesDeliveryDraft\}[\s\S]{0,180}aria-label="待辦完成"/u)
  assert.doesNotMatch(source, /<fieldset className="event-editor-list" disabled=\{relatedSalesDeliveryDraft\}>/u)
})

test('ERP 主事件變更地址時會等待同步成功後才關閉編輯器', () => {
  const source = readFileSync(new URL('../src/pages/CalendarPage.tsx', import.meta.url), 'utf8')
  assert.match(source, /const shouldAwaitPrimaryAddressSync = Boolean\([\s\S]{0,300}isPrimaryErpSalesDeliveryEvent\(editingEvent\)[\s\S]{0,200}editingEvent\.location[\s\S]{0,120}payload\.location/u)
  assert.match(source, /if \(shouldAwaitPrimaryAddressSync\) \{[\s\S]{0,120}await backgroundSave\(\)[\s\S]{0,700}await refreshCalendarData\(\)[\s\S]{0,200}setShowEventModal\(false\)/u)
  assert.match(source, /if \(shouldAwaitPrimaryAddressSync\)[\s\S]{0,1200}return[\s\S]{0,100}optimisticallyPatchCalendarEvents\(optimisticPatches\)/u)
})

test('關聯標籤先用全域索引快取，事件詳情再依 sourceId 預載跨月份完整清單', () => {
  const source = readFileSync(new URL('../src/pages/CalendarPage.tsx', import.meta.url), 'utf8')
  assert.match(source, /queryKey: \['erp-sales-delivery-relation-index', user\?\.uid \?\? ''\]/u)
  assert.match(source, /where\('sourceEventRole', '==', 'related'\)/u)
  assert.match(source, /staleTime: 5 \* 60 \* 1000[\s\S]{0,80}gcTime: 30 \* 60 \* 1000/u)
  assert.match(source, /return onSnapshot\(query\(collection\(db, 'calendarEvents'\), where\('sourceId', '==', sourceId\)\)/u)
  assert.match(source, /where\('sourceId', '==', sourceId\)/u)
  assert.match(source, /eventAllowedForViewer\(event\)/u)
  assert.match(source, /relationBadgeLabel[\s\S]{0,500}event-detail-related-badge/u)
  assert.match(source, /function renderRelatedEventsPanel/u)
  assert.equal(source.includes("tt-floating-panel tt-day-list-panel related-events-modal${dayListSwipeOffset > 0 ? ' swiping' : ''}"), true)
  assert.match(source, /onTouchStart=\{handleDayListSwipeStart\}[\s\S]{0,240}onTouchEnd=\{handleDayListSwipeEnd\}/u)
  assert.match(source, /if \(showRelatedEventsPanel\) setShowRelatedEventsPanel\(false\)[\s\S]{0,80}else setDayListDate\(null\)/u)
  assert.match(source, /className="panel-list related-events-list"/u)
  assert.equal(source.includes("className={`day-list-event${event.id === selectedEvent.id ? ' active' : ''}`}"), true)
  assert.match(source, /className="day-list-time"[\s\S]{0,500}className="day-list-content"[\s\S]{0,500}className="day-list-owner"/u)
  assert.match(source, /target\.closest\('\.event-detail-panel[^']*\.related-events-overlay'\)/u)
})
