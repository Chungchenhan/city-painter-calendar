import { canReadCalendarEvent } from '../shared/calendarEventAccess.js'
import { authenticateCalendar, calendarServices } from '../shared/calendarApiSecurity.js'
import fs from 'node:fs'
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import admin from 'firebase-admin'
import { google } from 'googleapis'
import formidable from 'formidable'
import sharp from 'sharp'
import { isErpEventEditRestricted } from '../shared/erpEventEditPolicy.js'

const DEFAULT_DRIVE_FOLDER_ID = '1aqx7A8VwTKBSltaEj0IFoOXQP4HUJWF4'
const DEFAULT_PUBLIC_BASE_URL = 'https://sch.city-painter.com'
const PROJECT_ID = 'city-painter-erp'
const MAX_DIRECT_SALES_THUMBNAIL_BYTES = 2 * 1024 * 1024
const DIRECT_SALES_THUMBNAIL_MIME_TYPES = new Set(['image/webp', 'image/jpeg', 'image/png'])
const FORWARDED_LINE_ACTIONS = new Set([
  'production-photo-status',
  'complete-order-fulfillment',
  'record-fulfillment-cash-payment'
])
const SALES_DELIVERY_EVENT_SYNC_ACTION = 'sync-sales-delivery-event-fields'
const RELATED_SALES_DELIVERY_EVENT_SYNC_ACTION = 'sync-related-sales-delivery-event-fields'
const MAX_RELATED_SALES_DELIVERY_ADDRESS_SYNC_EVENTS = 200
const SALES_DELIVERY_EVENT_SYNC_FIELDS = [
  'title',
  'date',
  'endDate',
  'startTime',
  'endTime',
  'allDay',
  'location',
]
const RELATED_SALES_DELIVERY_EVENT_SYNC_FIELDS = [
  ...SALES_DELIVERY_EVENT_SYNC_FIELDS,
  'calendarId',
  'calendarIds',
  'departmentId',
  'assigneeIds',
  'visibleDepartmentIds',
  'visibleAssigneeIds',
  'hiddenDepartmentIds',
  'hiddenAssigneeIds',
  'titleOverrides',
  'reminder',
  'url',
]
const RELATED_SALES_DELIVERY_INDEPENDENT_FIELDS = [
  'title',
  'date',
  'endDate',
  'startTime',
  'endTime',
  'allDay',
]

export const config = {
  api: {
    bodyParser: false
  }
}

function getServiceAccountCredentials() {
  const rawJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
  const base64Json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64
  const source = rawJson || (base64Json ? Buffer.from(base64Json, 'base64').toString('utf8') : '')
  if (source) return JSON.parse(source)

  const localCredentialsPath = path.join(os.homedir(), '.firebase', 'service-account.json')
  if (fs.existsSync(localCredentialsPath)) {
    return JSON.parse(fs.readFileSync(localCredentialsPath, 'utf8'))
  }

  throw new Error('Missing Google service account credentials')
}

function getAdminApp() {
  if (admin.apps.length > 0) return admin.app()
  return admin.initializeApp({
    credential: admin.credential.cert(getServiceAccountCredentials()),
    projectId: PROJECT_ID
  })
}


function requestError(message, status = 400) {
  return Object.assign(new Error(message), { status })
}

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function stringList(value) {
  return Array.isArray(value) ? value.map(text).filter(Boolean) : []
}

export function attachmentUploaderFields(actor) {
  return {
    uploadedByUid: text(actor?.uid),
    uploadedByEmployeeNo: text(actor?.employee?.empNo),
    uploadedByName: text(actor?.employee?.nickname)
      || text(actor?.employee?.name)
      || text(actor?.decoded?.name)
      || text(actor?.decoded?.email)
      || text(actor?.employee?.empNo)
      || text(actor?.employeeId),
  }
}

export function salesAttachmentUploadMetadata(attachment) {
  const uploadedAt = text(attachment?.uploadedAt) || text(attachment?.createdAtText)
  return {
    ...(text(attachment?.uploadedByUid) ? { uploadedByUid: text(attachment.uploadedByUid) } : {}),
    ...(text(attachment?.uploadedByEmployeeNo) ? { uploadedByEmployeeNo: text(attachment.uploadedByEmployeeNo) } : {}),
    ...(text(attachment?.uploadedByName) ? { uploadedByName: text(attachment.uploadedByName) } : {}),
    ...(uploadedAt ? { uploadedAt } : {}),
  }
}

async function authenticateEmployee(req) {
  const actor = await authenticateCalendar(req, calendarServices())
  return { ...actor, decoded: { uid: actor.uid, name: actor.displayName, email: actor.email } }
}

async function departmentName(db, departmentId) {
  const id = text(departmentId)
  if (!id) return ''
  const snapshot = await db.collection('departments').doc(id).get()
  return snapshot.exists ? text(snapshot.data()?.name) : ''
}

function eventDepartmentIds(event) {
  return Array.from(new Set([
    text(event?.departmentId),
    ...stringList(event?.calendarIds).map((id) => id.startsWith('department:') ? id.slice('department:'.length) : ''),
    text(event?.calendarId).startsWith('department:') ? text(event.calendarId).slice('department:'.length) : '',
  ].filter(Boolean)))
}

async function actorDepartmentMatches(db, actor, departmentId) {
  const id = text(departmentId)
  if (!id) return false
  if (id === text(actor.employee.departmentId)) return true
  const actorDepartmentName = text(actor.employee.departmentName)
  return Boolean(actorDepartmentName && await departmentName(db, id) === actorDepartmentName)
}

async function eventTargetsActorDepartment(db, event, field, actor) {
  for (const departmentId of stringList(event?.[field])) {
    if (await actorDepartmentMatches(db, actor, departmentId)) return true
  }
  return false
}

async function isManagementEvent(db, event) {
  for (const departmentId of eventDepartmentIds(event)) {
    if (await departmentName(db, departmentId) === '管理部') return true
  }
  return false
}

async function canViewEvent(db, actor, event) {
  if (!event) return false
  if (
    actor.role === 'admin'
    || text(event.createdBy) === actor.uid
    || text(actor.employee.departmentName) === '管理部'
  ) return true
  const explicitlyVisible = stringList(event.visibleAssigneeIds).includes(actor.employeeId)
    || await eventTargetsActorDepartment(db, event, 'visibleDepartmentIds', actor)
  if (explicitlyVisible) return true
  if (stringList(event.hiddenAssigneeIds).includes(actor.employeeId)) return false
  if (await eventTargetsActorDepartment(db, event, 'hiddenDepartmentIds', actor)) return false
  if (await isManagementEvent(db, event) && text(actor.employee.departmentName) !== '管理部') return false
  if (stringList(event.assigneeIds).includes(actor.employeeId)) return true
  for (const departmentId of eventDepartmentIds(event)) {
    if (await actorDepartmentMatches(db, actor, departmentId)) return true
  }
  return eventDepartmentIds(event).length === 0 && stringList(event.assigneeIds).length === 0
}

async function canManageEvent(db, actor, event, eventId) {
  if (!event || text(event.source) === 'hrLeaveRequest' || text(eventId).startsWith('hrLeaveRequest_')) return false
  if (actor.role === 'admin' || text(event.createdBy) === actor.uid || text(actor.employee.departmentName) === '管理部') return true
  if (!await canViewEvent(db, actor, event)) return false
  if (stringList(event.assigneeIds).includes(actor.employeeId)) return true
  for (const departmentId of eventDepartmentIds(event)) {
    if (await actorDepartmentMatches(db, actor, departmentId)) return true
  }
  return false
}

function canonicalSalesDeliveryDate(value, label) {
  const normalized = text(value).replaceAll('/', '-')
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) throw requestError(`${label}格式錯誤`, 400)
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== normalized) {
    throw requestError(`${label}格式錯誤`, 400)
  }
  return normalized
}

function canonicalSalesDeliveryTime(value, label) {
  const normalized = text(value)
  const match = normalized.match(/^(\d{2}):(\d{2})$/)
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) {
    throw requestError(`${label}格式錯誤`, 400)
  }
  return normalized
}

function salesDeliveryDateTimeMinutes(date, time) {
  return Date.parse(`${date}T${time}:00Z`) / 60000
}

function normalizeSalesDeliveryEventFields(value, labelPrefix, { allowAllDay = false } = {}) {
  const source = value && typeof value === 'object' ? value : {}
  const title = text(source.title)
  const date = canonicalSalesDeliveryDate(source.date, `${labelPrefix}日期`)
  const endDate = canonicalSalesDeliveryDate(source.endDate || source.date, `${labelPrefix}結束日期`)
  const allDay = source.allDay === true
  const startTime = allDay ? text(source.startTime) : canonicalSalesDeliveryTime(source.startTime, `${labelPrefix}開始時間`)
  const endTime = allDay ? text(source.endTime) : canonicalSalesDeliveryTime(source.endTime, `${labelPrefix}結束時間`)
  const location = text(source.location)
  if (!title) throw requestError('事件標題不可空白', 400)
  if (title.length > 300) throw requestError('事件標題不可超過 300 字', 400)
  if (endDate < date) throw requestError('結束日期不得早於開始日期', 400)
  if (allDay && (!allowAllDay || startTime || endTime)) {
    throw requestError('銷貨配送事件必須指定開始與結束時間', 400)
  }
  if (!allDay && salesDeliveryDateTimeMinutes(endDate, endTime) <= salesDeliveryDateTimeMinutes(date, startTime)) {
    throw requestError('收貨結束時間必須晚於開始時間', 400)
  }
  if (location.length > 1000) throw requestError('地點不可超過 1000 字', 400)
  return { title, date, endDate, startTime, endTime, allDay, location }
}

function normalizeExpectedSalesDeliveryEventFields(value) {
  const source = value && typeof value === 'object' ? value : {}
  const title = text(source.title)
  const date = canonicalSalesDeliveryDate(source.date, '原日期')
  const endDate = canonicalSalesDeliveryDate(source.endDate || source.date, '原結束日期')
  const startTime = text(source.startTime)
  const endTime = text(source.endTime)
  const location = text(source.location)
  if (!title) throw requestError('原事件標題不可空白', 400)
  if (title.length > 300) throw requestError('原事件標題不可超過 300 字', 400)
  if (location.length > 1000) throw requestError('原地點不可超過 1000 字', 400)
  return { title, date, endDate, startTime, endTime, allDay: source.allDay === true, location }
}

export function normalizeSalesDeliveryEventSyncInput(body) {
  const eventId = text(body?.eventId)
  if (!eventId || eventId.includes('/') || eventId.length > 200) {
    throw requestError('事件識別碼不正確', 400)
  }
  const calendarTitle = text(body?.calendarTitle)
  if (!calendarTitle) throw requestError('行事曆標題不可只有圖示', 400)
  if (calendarTitle.length > 300) throw requestError('行事曆標題不可超過 300 字', 400)
  const expected = normalizeExpectedSalesDeliveryEventFields(body?.expected)
  const event = normalizeSalesDeliveryEventFields(body?.event, '', { allowAllDay: expected.allDay })
  return {
    eventId,
    calendarTitle,
    event,
    expected,
    sales: {
      calendarTitle,
      deliveryDate: event.date.replaceAll('-', '/'),
      deliveryStartTime: event.startTime,
      deliveryEndTime: event.endTime,
      deliveryTime: event.allDay ? '' : '指定時間',
      deliveryScheduleSource: 'manual',
      recipientAddress: event.location,
      recipientPostalCode: '',
    },
  }
}

function comparableSalesDeliveryEventFields(event) {
  return {
    title: text(event?.title),
    date: text(event?.date).replaceAll('/', '-'),
    endDate: text(event?.endDate || event?.date).replaceAll('/', '-'),
    startTime: text(event?.startTime),
    endTime: text(event?.endTime),
    allDay: event?.allDay === true,
    location: text(event?.location),
  }
}

export function salesDeliveryEventFieldsMatch(event, expected) {
  const current = comparableSalesDeliveryEventFields(event)
  return SALES_DELIVERY_EVENT_SYNC_FIELDS.every((field) => current[field] === expected[field])
}

function normalizeStoredSalesDeliveryField(field, value) {
  if (field === 'deliveryDate') return text(value).replaceAll('-', '/')
  return text(value)
}

export function changedSalesDeliveryFields(sales, nextSales) {
  const labels = {
    calendarTitle: '行事曆標題',
    deliveryDate: '收貨日期',
    deliveryStartTime: '收貨開始時間',
    deliveryEndTime: '收貨結束時間',
    deliveryTime: '收貨時間',
    deliveryScheduleSource: '收貨排程來源',
    recipientAddress: '收件地址',
    recipientPostalCode: '收件郵遞區號',
  }
  return Object.keys(nextSales)
    .filter((field) => normalizeStoredSalesDeliveryField(field, sales?.[field]) !== nextSales[field])
    .map((field) => labels[field])
}

export function salesDeliveryPatchForEventChanges(expected, next, mappedSales) {
  const patch = {}
  if (expected.title !== next.title) patch.calendarTitle = mappedSales.calendarTitle
  if (expected.location !== next.location) {
    patch.recipientAddress = mappedSales.recipientAddress
    patch.recipientPostalCode = ''
  }
  if (['date', 'endDate', 'startTime', 'endTime', 'allDay'].some((field) => expected[field] !== next[field])) {
    patch.deliveryDate = mappedSales.deliveryDate
    patch.deliveryStartTime = mappedSales.deliveryStartTime
    patch.deliveryEndTime = mappedSales.deliveryEndTime
    patch.deliveryTime = mappedSales.deliveryTime
    patch.deliveryScheduleSource = mappedSales.deliveryScheduleSource
  }
  return patch
}

function assertNonEmptyChangedSalesDeliveryLocation(expected, next) {
  if (expected.location !== next.location && !next.location) {
    throw requestError('收件地址不可空白', 400)
  }
}

function validRelatedSalesDeliveryEventSnapshots(querySnapshot, sourceId, salesNo, primaryEventId) {
  const snapshots = (querySnapshot?.docs || []).filter((snapshot) => {
    const event = snapshot.data() || {}
    return text(event.source) === 'erpSalesDelivery'
      && text(event.sourceId) === sourceId
      && text(event.sourceEventRole) === 'related'
      && text(event.sourceParentEventId) === primaryEventId
      && Boolean(salesNo)
      && text(event.sourceSalesNo) === salesNo
  })
  if (snapshots.length > MAX_RELATED_SALES_DELIVERY_ADDRESS_SYNC_EVENTS) {
    throw requestError('附屬事件數量過多，已停止地址同步', 409)
  }
  return snapshots
}

function relatedSalesDeliveryPrimaryNext(expectedRelated, expectedPrimary, nextRelated) {
  const nextPrimary = { ...expectedPrimary }
  for (const field of RELATED_SALES_DELIVERY_EVENT_SYNC_FIELDS) {
    if (RELATED_SALES_DELIVERY_INDEPENDENT_FIELDS.includes(field)) continue
    if (JSON.stringify(expectedRelated[field]) !== JSON.stringify(nextRelated[field])) {
      nextPrimary[field] = nextRelated[field]
    }
  }
  return nextPrimary
}

function salesDeliveryAddressActivityChange(before, after) {
  return [{
    field: 'location',
    label: '地點',
    before: text(before) || '空白',
    after: text(after) || '空白',
  }]
}

function writeRelatedSalesDeliveryAddressActivity(transaction, db, snapshot, location, actor, actorName, requestId, createdAt) {
  const event = snapshot.data() || {}
  const activityRef = db.collection('calendarActivityLogs').doc()
  transaction.set(activityRef, {
    action: 'update',
    eventId: snapshot.id,
    eventTitle: text(event.title),
    calendarId: stringList(event.calendarIds)[0] || text(event.calendarId),
    departmentId: text(event.departmentId),
    assigneeIds: stringList(event.assigneeIds),
    date: text(event.date),
    changes: salesDeliveryAddressActivityChange(event.location, location),
    actorUid: text(actor.uid),
    actorName,
    ...(requestId ? { requestId } : {}),
    createdAt,
  })
}

function taipeiDateTimeText(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date).map((part) => [part.type, part.value]))
  return `${parts.year}/${parts.month}/${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`
}

function normalizeSalesDeliverySyncTextList(value, label) {
  if (!Array.isArray(value)) throw requestError(`${label}格式錯誤`, 400)
  const items = value.map(text).filter(Boolean)
  if (items.length > 300 || items.some((item) => item.length > 200)) throw requestError(`${label}格式錯誤`, 400)
  return Array.from(new Set(items))
}

function normalizeSalesDeliveryTitleOverrides(value, label) {
  if (!Array.isArray(value)) throw requestError(`${label}格式錯誤`, 400)
  if (value.length > 100) throw requestError(`${label}筆數過多`, 400)
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw requestError(`${label}格式錯誤`, 400)
    const unknownFields = Object.keys(item).filter((field) => !['targetType', 'targetId', 'title', 'icon'].includes(field))
    if (unknownFields.length > 0) throw requestError(`${label}包含不允許的欄位`, 400)
    const targetType = text(item.targetType)
    const targetId = text(item.targetId)
    const title = text(item.title)
    const icon = text(item.icon)
    if (!targetId || targetId.length > 200 || title.length > 300 || icon.length > 20) {
      throw requestError(`${label}格式錯誤`, 400)
    }
    return { targetType, targetId, title, ...(icon ? { icon } : {}) }
  })
}

export function normalizeRelatedSalesDeliveryEventFields(value, label) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : null
  if (!source) throw requestError(`${label}格式錯誤`, 400)
  const unknownFields = Object.keys(source).filter((field) => !RELATED_SALES_DELIVERY_EVENT_SYNC_FIELDS.includes(field))
  if (unknownFields.length > 0) throw requestError(`${label}包含不允許的欄位：${unknownFields.join('、')}`, 400)
  const core = normalizeSalesDeliveryEventFields(source, label, { allowAllDay: true })
  const reminder = text(source.reminder) || 'none'
  if (!['none', 'start', '5m', '15m', '1h', '1d'].includes(reminder)) throw requestError(`${label}提醒設定錯誤`, 400)
  const calendarId = text(source.calendarId)
  const departmentId = text(source.departmentId)
  const url = text(source.url)
  if (calendarId.length > 200 || departmentId.length > 200 || url.length > 2000) {
    throw requestError(`${label}包含過長欄位`, 400)
  }
  return {
    ...core,
    calendarId,
    calendarIds: normalizeSalesDeliverySyncTextList(source.calendarIds ?? [], `${label}行事曆`),
    departmentId,
    assigneeIds: normalizeSalesDeliverySyncTextList(source.assigneeIds ?? [], `${label}負責人`),
    visibleDepartmentIds: normalizeSalesDeliverySyncTextList(source.visibleDepartmentIds ?? [], `${label}可見部門`),
    visibleAssigneeIds: normalizeSalesDeliverySyncTextList(source.visibleAssigneeIds ?? [], `${label}可見人員`),
    hiddenDepartmentIds: normalizeSalesDeliverySyncTextList(source.hiddenDepartmentIds ?? [], `${label}隱藏部門`),
    hiddenAssigneeIds: normalizeSalesDeliverySyncTextList(source.hiddenAssigneeIds ?? [], `${label}隱藏人員`),
    titleOverrides: normalizeSalesDeliveryTitleOverrides(source.titleOverrides ?? [], `${label}替代標題`),
    reminder,
    url,
  }
}

function salesDeliverySyncEventFieldsMatch(event, expected) {
  const current = normalizeRelatedSalesDeliveryEventFields(
    Object.fromEntries(RELATED_SALES_DELIVERY_EVENT_SYNC_FIELDS.map((field) => [field, event?.[field]])),
    '目前事件',
  )
  return RELATED_SALES_DELIVERY_EVENT_SYNC_FIELDS.every((field) => (
    JSON.stringify(current[field]) === JSON.stringify(expected[field])
  ))
}

function salesDeliverySyncEventChanges(expected, next) {
  const labels = {
    title: '標題', date: '日期', endDate: '結束日期', startTime: '開始時間', endTime: '結束時間',
    allDay: '整天', location: '地點', calendarId: '行事曆', calendarIds: '行事曆', departmentId: '部門',
    assigneeIds: '負責人', visibleDepartmentIds: '可見部門', visibleAssigneeIds: '可見人員',
    hiddenDepartmentIds: '隱藏部門', hiddenAssigneeIds: '隱藏人員', titleOverrides: '替代標題',
    reminder: '提醒', url: '網址',
  }
  const valueLabel = (value) => {
    if (typeof value === 'boolean') return value ? '是' : '否'
    if (Array.isArray(value)) return value.length > 0 ? JSON.stringify(value) : '空白'
    return text(value) || '空白'
  }
  return RELATED_SALES_DELIVERY_EVENT_SYNC_FIELDS.flatMap((field) => (
    JSON.stringify(expected[field]) === JSON.stringify(next[field])
      ? []
      : [{
          field,
          label: labels[field] || field,
          before: valueLabel(expected[field]),
          after: valueLabel(next[field]),
        }]
  ))
}

export function normalizeRelatedSalesDeliveryEventSyncInput(body) {
  const requestId = text(body?.requestId)
  const relatedEventId = text(body?.relatedEventId)
  const primaryEventId = text(body?.primaryEventId)
  const calendarTitle = text(body?.calendarTitle)
  if (!/^[A-Za-z0-9_-]{16,120}$/.test(requestId)) throw requestError('同步要求識別碼不正確', 400)
  for (const [value, label] of [[relatedEventId, '附屬事件'], [primaryEventId, '主事件']]) {
    if (!value || value.includes('/') || value.length > 200) throw requestError(`${label}識別碼不正確`, 400)
  }
  if (relatedEventId === primaryEventId) throw requestError('主事件與附屬事件不可相同', 400)
  if (!calendarTitle || calendarTitle.length > 300) throw requestError('行事曆標題不正確', 400)
  const expectedRelated = normalizeRelatedSalesDeliveryEventFields(body?.expected?.related, '原附屬事件')
  const expectedPrimary = normalizeRelatedSalesDeliveryEventFields(body?.expected?.primary, '原主事件')
  const related = normalizeRelatedSalesDeliveryEventFields(body?.events?.related, '附屬事件')
  const primary = normalizeRelatedSalesDeliveryEventFields(body?.events?.primary, '主事件')
  return { requestId, relatedEventId, primaryEventId, calendarTitle, expectedRelated, expectedPrimary, related, primary }
}

export async function syncRelatedSalesDeliveryEventFields(db, actor, body) {
  if (isErpEventEditRestricted(actor.employeeId)) throw requestError('沒有 ERP 事件的編輯權限', 403)
  const input = normalizeRelatedSalesDeliveryEventSyncInput(body)
  assertNonEmptyChangedSalesDeliveryLocation(input.expectedRelated, input.related)
  const locationChanged = input.expectedRelated.location !== input.related.location
  const [authorizedRelated, authorizedPrimary] = await Promise.all([
    loadEvent(db, input.relatedEventId),
    loadEvent(db, input.primaryEventId),
  ])
  if (!authorizedRelated || !authorizedPrimary) throw requestError('找不到主事件或附屬事件', 404)
  if (!await canManageEvent(db, actor, authorizedRelated, input.relatedEventId)
    || !await canManageEvent(db, actor, authorizedPrimary, input.primaryEventId)) {
    throw requestError('沒有同步此銷貨單事件的權限', 403)
  }

  const sourceId = text(authorizedRelated.sourceId)
  if (!sourceId || sourceId.includes('/') || sourceId.length > 200) throw requestError('附屬事件未綁定有效銷貨單', 409)
  const relatedRef = db.collection('calendarEvents').doc(input.relatedEventId)
  const primaryRef = db.collection('calendarEvents').doc(input.primaryEventId)
  const salesRef = db.collection('sales').doc(sourceId)
  const requestRef = db.collection('calendarEventSyncRequests').doc(input.requestId)
  const linkedEventsQuery = db.collection('calendarEvents').where('sourceId', '==', sourceId)
  const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex')
  const now = new Date()
  const nowIso = now.toISOString()
  const updatedAtText = taipeiDateTimeText(now)
  const updatedBy = text(actor.employee.name)
    || text(actor.employee.nickname)
    || text(actor.decoded?.name)
    || text(actor.decoded?.email)
    || actor.employeeId

  return db.runTransaction(async (transaction) => {
    const [requestSnapshot, relatedSnapshot, primarySnapshot, salesSnapshot, linkedEventsSnapshot] = await Promise.all([
      transaction.get(requestRef),
      transaction.get(relatedRef),
      transaction.get(primaryRef),
      transaction.get(salesRef),
      locationChanged ? transaction.get(linkedEventsQuery) : Promise.resolve(null),
    ])
    if (requestSnapshot.exists) {
      const stored = requestSnapshot.data() || {}
      if (text(stored.fingerprint) !== fingerprint || text(stored.actorUid) !== text(actor.uid)) {
        throw requestError('同步要求識別碼已由其他內容使用', 409)
      }
      return { ...(stored.result || {}), reused: true }
    }
    if (!relatedSnapshot.exists || !primarySnapshot.exists) throw requestError('主事件或附屬事件已不存在', 404)
    if (!salesSnapshot.exists) throw requestError('對應的銷貨單已不存在', 404)
    const related = relatedSnapshot.data() || {}
    const primary = primarySnapshot.data() || {}
    const sales = salesSnapshot.data() || {}
    const salesNo = text(sales.salesNo)
    if (text(related.source) !== 'erpSalesDelivery'
      || text(related.sourceEventRole) !== 'related'
      || text(related.sourceParentEventId) !== input.primaryEventId
      || text(related.sourceId) !== sourceId
      || !text(related.sourceSalesNo)
      || text(related.sourceSalesNo) !== salesNo) {
      throw requestError('附屬事件關聯已變更，請重新開啟後再試', 409)
    }
    if (text(primary.source) !== 'erpSalesDelivery'
      || !['', 'primary'].includes(text(primary.sourceEventRole))
      || text(primary.sourceParentEventId)
      || text(primary.sourceId) !== sourceId) {
      throw requestError('主事件關聯已變更，請重新開啟後再試', 409)
    }
    if (text(primary.sourceSalesNo) && text(primary.sourceSalesNo) !== salesNo) {
      throw requestError('主事件與銷貨單號不一致，已停止同步', 409)
    }
    if (text(sales.deliveryCalendarEventId) !== input.primaryEventId) {
      throw requestError('銷貨單主要事件指標不一致，已停止同步', 409)
    }
    if (!['外送', '施工', '活動'].includes(text(sales.shippingMethod))) {
      throw requestError('此銷貨單已不是外送、施工或活動，請重新整理行事曆', 409)
    }
    if (!salesDeliverySyncEventFieldsMatch(related, input.expectedRelated)
      || !salesDeliverySyncEventFieldsMatch(primary, input.expectedPrimary)) {
      throw requestError('主事件或附屬事件已由其他畫面更新，請重新開啟後再修改', 409)
    }

    const linkedRelatedSnapshots = locationChanged
      ? validRelatedSalesDeliveryEventSnapshots(linkedEventsSnapshot, sourceId, salesNo, input.primaryEventId)
      : []
    const siblingAddressSnapshots = linkedRelatedSnapshots.filter((snapshot) => (
      snapshot.id !== input.relatedEventId
      && text(snapshot.data()?.location) !== input.related.location
    ))
    const primaryNext = relatedSalesDeliveryPrimaryNext(
      input.expectedRelated,
      input.expectedPrimary,
      input.related,
    )
    const salesPatch = locationChanged
      ? { recipientAddress: input.related.location, recipientPostalCode: '' }
      : {}
    const changedFields = changedSalesDeliveryFields(sales, salesPatch)
    const relatedChanges = salesDeliverySyncEventChanges(input.expectedRelated, input.related)
    const primaryChanges = salesDeliverySyncEventChanges(input.expectedPrimary, primaryNext)
    transaction.update(relatedRef, { ...input.related, updatedAt: nowIso })
    transaction.update(primaryRef, { ...primaryNext, updatedAt: nowIso })
    siblingAddressSnapshots.forEach((snapshot) => {
      transaction.update(snapshot.ref, { location: input.related.location, updatedAt: nowIso })
      writeRelatedSalesDeliveryAddressActivity(
        transaction,
        db,
        snapshot,
        input.related.location,
        actor,
        updatedBy,
        input.requestId,
        nowIso,
      )
    })
    if (changedFields.length > 0) {
      transaction.update(salesRef, {
        ...salesPatch,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAtText,
        updatedBy,
      })
      const salesAuditRef = db.collection('sales_audit_logs').doc()
      transaction.set(salesAuditRef, {
        salesId: salesSnapshot.id,
        salesNo,
        action: '行事曆關聯同步',
        actorCode: text(actor.employee.empNo) || actor.employeeId,
        actorName: updatedBy,
        changedFields,
        detail: `由附屬事件同步主事件：${changedFields.join('、')}${siblingAddressSnapshots.length > 0 ? `；同步 ${siblingAddressSnapshots.length} 個附屬事件地址` : ''}`,
        requestId: input.requestId,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        createdAtText: updatedAtText,
      })
    }
    for (const [snapshot, next, changes] of [
      [relatedSnapshot, input.related, relatedChanges],
      [primarySnapshot, primaryNext, primaryChanges],
    ]) {
      if (changes.length === 0) continue
      const activityRef = db.collection('calendarActivityLogs').doc()
      transaction.set(activityRef, {
        action: 'update',
        eventId: snapshot.id,
        eventTitle: next.title,
        calendarId: next.calendarIds[0] || next.calendarId,
        departmentId: next.departmentId,
        assigneeIds: next.assigneeIds,
        date: next.date,
        changes,
        actorUid: text(actor.uid),
        actorName: updatedBy,
        requestId: input.requestId,
        createdAt: nowIso,
      })
    }
    const result = {
      ok: true,
      requestId: input.requestId,
      relatedEventId: input.relatedEventId,
      primaryEventId: input.primaryEventId,
      salesId: salesSnapshot.id,
      changedFields,
      relatedChangedFields: relatedChanges.map((change) => change.field),
      primaryChangedFields: primaryChanges.map((change) => change.field),
      siblingAddressEventIds: siblingAddressSnapshots.map((snapshot) => snapshot.id),
    }
    transaction.set(requestRef, {
      requestId: input.requestId,
      fingerprint,
      actorUid: text(actor.uid),
      result,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    })
    return { ...result, reused: false }
  })
}

export async function syncSalesDeliveryEventFields(db, actor, body) {
  if (isErpEventEditRestricted(actor.employeeId)) throw requestError('沒有 ERP 事件的編輯權限', 403)
  const input = normalizeSalesDeliveryEventSyncInput(body)
  assertNonEmptyChangedSalesDeliveryLocation(input.expected, input.event)
  const locationChanged = input.expected.location !== input.event.location
  const authorizedEvent = await loadEvent(db, input.eventId)
  if (!authorizedEvent || text(authorizedEvent.source) !== 'erpSalesDelivery') {
    throw requestError('找不到對應的銷貨單事件', 404)
  }
  if (text(authorizedEvent.sourceEventRole) === 'related' || text(authorizedEvent.sourceParentEventId)) {
    throw requestError('附屬事件不可使用主事件同步操作', 409)
  }
  if (!await canManageEvent(db, actor, authorizedEvent, input.eventId)) {
    throw requestError('沒有此銷貨單事件的編輯權限', 403)
  }

  const sourceId = text(authorizedEvent.sourceId)
  if (!sourceId || sourceId.includes('/') || sourceId.length > 200) {
    throw requestError('事件未綁定有效的銷貨單', 409)
  }
  const eventRef = db.collection('calendarEvents').doc(input.eventId)
  const salesRef = db.collection('sales').doc(sourceId)
  const linkedEventsQuery = db.collection('calendarEvents').where('sourceId', '==', sourceId)
  const now = new Date()
  const nowIso = now.toISOString()
  const updatedAtText = taipeiDateTimeText(now)
  const updatedBy = text(actor.employee.name)
    || text(actor.employee.nickname)
    || text(actor.decoded?.name)
    || text(actor.decoded?.email)
    || actor.employeeId

  return db.runTransaction(async (transaction) => {
    const [eventSnapshot, salesSnapshot, linkedEventsSnapshot] = await Promise.all([
      transaction.get(eventRef),
      transaction.get(salesRef),
      locationChanged ? transaction.get(linkedEventsQuery) : Promise.resolve(null),
    ])
    if (!eventSnapshot.exists) throw requestError('行事曆事件已不存在', 404)
    if (!salesSnapshot.exists) throw requestError('對應的銷貨單已不存在', 404)
    const event = eventSnapshot.data() || {}
    const sales = salesSnapshot.data() || {}
    if (text(event.source) !== 'erpSalesDelivery' || text(event.sourceId) !== sourceId) {
      throw requestError('事件與銷貨單的綁定已變更，請重新開啟後再試', 409)
    }
    if (text(event.sourceEventRole) === 'related' || text(event.sourceParentEventId)) {
      throw requestError('附屬事件不可使用主事件同步操作', 409)
    }
    if (text(event.sourceSalesNo) && text(sales.salesNo) !== text(event.sourceSalesNo)) {
      throw requestError('事件與銷貨單號不一致，已停止同步', 409)
    }
    const primaryEventId = text(sales.deliveryCalendarEventId)
    if (primaryEventId && primaryEventId !== input.eventId) {
      throw requestError('此事件不是銷貨單目前綁定的主要事件，已停止同步', 409)
    }
    if (!primaryEventId && input.eventId !== `erpSalesDelivery_${sourceId}`) {
      throw requestError('銷貨單缺少主要事件指標，無法安全同步', 409)
    }
    if (!['外送', '施工', '活動'].includes(text(sales.shippingMethod))) {
      throw requestError('此銷貨單已不是外送、施工或活動，請重新整理行事曆', 409)
    }
    if (!salesDeliveryEventFieldsMatch(event, input.expected)) {
      throw requestError('事件已由其他畫面更新，請重新開啟後再修改', 409)
    }

    const relatedAddressSnapshots = locationChanged
      ? validRelatedSalesDeliveryEventSnapshots(
          linkedEventsSnapshot,
          sourceId,
          text(sales.salesNo),
          input.eventId,
        ).filter((snapshot) => text(snapshot.data()?.location) !== input.event.location)
      : []
    const salesPatch = salesDeliveryPatchForEventChanges(input.expected, input.event, input.sales)
    const changedFields = changedSalesDeliveryFields(sales, salesPatch)
    transaction.update(eventRef, { ...input.event, updatedAt: nowIso })
    relatedAddressSnapshots.forEach((snapshot) => {
      transaction.update(snapshot.ref, { location: input.event.location, updatedAt: nowIso })
      writeRelatedSalesDeliveryAddressActivity(
        transaction,
        db,
        snapshot,
        input.event.location,
        actor,
        updatedBy,
        '',
        nowIso,
      )
    })
    if (changedFields.length > 0) {
      transaction.update(salesRef, {
        ...salesPatch,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAtText,
        updatedBy,
      })
      const auditRef = db.collection('sales_audit_logs').doc()
      transaction.set(auditRef, {
        salesId: salesSnapshot.id,
        salesNo: text(sales.salesNo),
        action: '行事曆同步',
        actorCode: text(actor.employee.empNo) || actor.employeeId,
        actorName: updatedBy,
        changedFields,
        detail: `由行事曆同步：${changedFields.join('、')}${relatedAddressSnapshots.length > 0 ? `；同步 ${relatedAddressSnapshots.length} 個附屬事件地址` : ''}`,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        createdAtText: updatedAtText,
      })
    }
    return { ok: true, eventId: input.eventId, salesId: salesSnapshot.id, changedFields }
  })
}

export function canOpenSalesAttachmentCenterFromAccess(access, actor) {
  const employeeNo = text(actor.employee.empNo)
  if (
    access.enabled !== true
    || text(access.uid) !== actor.uid
    || text(access.employeeId) !== actor.employeeId
    || (employeeNo && text(access.employeeNo) !== employeeNo)
    || Number(access.schemaVersion) < 2
  ) return false
  const matrix = access.permissionMatrix && typeof access.permissionMatrix === 'object'
    ? access.permissionMatrix
    : {}
  return [
    { keys: ['sales-order-scan', 'dashboard-order-status'], actions: ['update', 'special'] },
    { keys: ['sales-main', 'dashboard-sales-main'], actions: ['update', 'delete'] },
  ].some(({ keys, actions }) => keys.some((featureKey) => {
    const permission = matrix[featureKey]
    return permission && typeof permission === 'object'
      && permission.browse === true
      && actions.some((action) => permission[action] === true)
  }))
}

async function canOpenSalesAttachmentCenter(db, actor) {
  const accessSnapshot = await db.collection('erp_access').doc(actor.uid).get()
  if (!accessSnapshot.exists) return false
  return canOpenSalesAttachmentCenterFromAccess(accessSnapshot.data() || {}, actor)
}

export function canUseErpOrderFulfillmentPermission(event, canScanSalesOrder) {
  if (!canScanSalesOrder) return false
  if (text(event?.source) !== 'erpSalesDelivery') return false
  const shippingMethod = text(event?.sourceShippingMethod)
  return shippingMethod === '外送' || shippingMethod === '施工' || shippingMethod === '活動'
}

async function canOperateErpOrderFulfillment(db, actor, event) {
  return canUseErpOrderFulfillmentPermission(
    event,
    await canOpenSalesAttachmentCenter(db, actor),
  )
}

async function loadEvent(db, eventId) {
  const id = text(eventId)
  if (!id || id === 'draft-event') return null
  const snapshot = await db.collection('calendarEvents').doc(id).get()
  return snapshot.exists ? { id: snapshot.id, ...snapshot.data() } : null
}

async function loadSalesRecordForEvent(db, event) {
  const sourceId = text(event?.sourceId)
  const salesNo = text(event?.sourceSalesNo)
  if (sourceId && !sourceId.includes('/')) {
    const snapshot = await db.collection('sales').doc(sourceId).get()
    if (snapshot.exists) return { id: snapshot.id, ...snapshot.data() }
  }
  if (!salesNo) return null
  const snapshot = await db.collection('sales').where('salesNo', '==', salesNo).limit(1).get()
  return snapshot.empty ? null : { id: snapshot.docs[0].id, ...snapshot.docs[0].data() }
}

function salesAttachmentFileIds(sales) {
  return new Set((Array.isArray(sales?.attachments) ? sales.attachments : []).flatMap((attachment) => [
    text(attachment?.path),
    text(attachment?.thumbnailPath),
    text(attachment?.sourceAttachmentId),
  ]).filter(Boolean))
}

export function canServeDirectSalesAttachmentThumbnail(sales, { fileId, variant, mimeType, size }) {
  if (variant !== 'preview') return false
  const normalizedFileId = text(fileId)
  const isThumbnail = (Array.isArray(sales?.attachments) ? sales.attachments : []).some((attachment) => (
    text(attachment?.thumbnailPath) === normalizedFileId
  ))
  if (!normalizedFileId || !isThumbnail) return false
  if (!DIRECT_SALES_THUMBNAIL_MIME_TYPES.has(text(mimeType).toLowerCase())) return false
  const byteSize = Number(size)
  return Number.isFinite(byteSize) && byteSize > 0 && byteSize <= MAX_DIRECT_SALES_THUMBNAIL_BYTES
}

function attachmentBelongsToEvent(event, fileId) {
  return Array.isArray(event?.attachments) && event.attachments.some((attachment) => (
    text(attachment?.path) === fileId || text(attachment?.thumbnailPath) === fileId
  ))
}

export function calendarAttachmentDeletePolicy({ fileId, appProperties = {}, job = null, event = null, sales = null }) {
  const normalizedFileId = text(fileId)
  const matchingAttachments = [
    ...(Array.isArray(event?.attachments) ? event.attachments : []),
    ...(Array.isArray(sales?.attachments) ? sales.attachments : []),
  ].filter(attachment => [attachment?.path, attachment?.thumbnailPath, attachment?.sourceAttachmentId].some(id => text(id) === normalizedFileId))
  if (text(appProperties.fulfillmentBatchId) || Array.isArray(job?.target?.fulfillmentOrders)
    || matchingAttachments.some(attachment => text(attachment.fulfillmentBatchId))) {
    return { action: 'retain', reason: 'shared-fulfillment-attachment' }
  }
  const metadataJobId = text(appProperties.attachmentUploadJobId)
  const metadataEventId = text(appProperties.calendarEventId)
  const jobEventId = text(job?.target?.eventId)
  const jobProtectsFile = Boolean(
    normalizedFileId
    && metadataJobId
    && text(job?.target?.completionMode) === 'fulfillment'
    && text(job?.target?.uploadKind) === 'event'
    && (!metadataEventId || !jobEventId || metadataEventId === jobEventId)
    && !['failed', 'expired'].includes(text(job?.status))
  )
  if (jobProtectsFile) {
    return { action: 'retain', reason: 'fulfillment-job-managed' }
  }
  if (text(event?.source) !== 'erpSalesDelivery') return { action: 'delete', reason: 'unmanaged' }
  if (attachmentBelongsToEvent(event, normalizedFileId) || salesAttachmentFileIds(sales).has(normalizedFileId)) {
    return { action: 'retain', reason: 'erp-sales-attachment-managed' }
  }
  return { action: 'delete', reason: 'unreferenced' }
}

export async function resolveCalendarAttachmentDeletePolicy(db, fileId, requestedEventId, appProperties) {
  const jobId = text(appProperties?.attachmentUploadJobId)
  const eventId = text(appProperties?.calendarEventId) || text(requestedEventId)
  const [protectedFiles, legacyProtectedFiles] = await Promise.all([
    db.collection('calendar_fulfillment_batches').where('protectedFileIds', 'array-contains', fileId).limit(1).get(),
    db.collection('calendar_fulfillment_batches').where('attachmentIds', 'array-contains', fileId).limit(1).get(),
  ])
  if (!protectedFiles.empty || !legacyProtectedFiles.empty) return { action: 'retain', reason: 'shared-fulfillment-attachment' }
  const [jobSnapshot, event] = await Promise.all([
    jobId && !jobId.includes('/')
      ? db.collection('attachmentUploadJobs').doc(jobId).get()
      : Promise.resolve(null),
    loadEvent(db, eventId),
  ])
  const job = jobSnapshot?.exists ? jobSnapshot.data() || {} : null
  const sales = text(event?.source) === 'erpSalesDelivery'
    ? await loadSalesRecordForEvent(db, event)
    : null
  return calendarAttachmentDeletePolicy({ fileId, appProperties, job, event, sales })
}

function lineImageSigningSecret() {
  return process.env.LINE_IMAGE_SIGNING_SECRET || getServiceAccountCredentials().private_key
}

export function lineImageSignature(fileId, variant, expires) {
  return createHmac('sha256', lineImageSigningSecret())
    .update(`${fileId}:${variant}:${expires}`)
    .digest('hex')
}

export function validLineImageSignature(fileId, variant, expires, signature, now = Math.floor(Date.now() / 1000)) {
  if (!['original', 'preview', 'download'].includes(variant) || !Number.isSafeInteger(expires)
    || expires <= now || expires > now + 86400 || !/^[a-f0-9]{64}$/.test(String(signature || ''))) return false
  const expected = Buffer.from(lineImageSignature(fileId, variant, expires), 'hex')
  let received
  try {
    received = Buffer.from(String(signature || ''), 'hex')
  } catch {
    return false
  }
  return expected.length === received.length && timingSafeEqual(expected, received)
}

function salesAttachmentSignature(eventId, fileId, variant, expires) {
  return createHmac('sha256', lineImageSigningSecret())
    .update(`sales-attachment:${eventId}:${fileId}:${variant}:${expires}`)
    .digest('hex')
}

function validSalesAttachmentSignature(eventId, fileId, variant, expires, signature) {
  const expected = Buffer.from(salesAttachmentSignature(eventId, fileId, variant, expires), 'hex')
  let received
  try {
    received = Buffer.from(String(signature || ''), 'hex')
  } catch {
    return false
  }
  return expected.length === received.length && timingSafeEqual(expected, received)
}

function salesAttachmentImageUrl(eventId, fileId, variant, expires) {
  const params = new URLSearchParams({
    scope: 'sales-attachment',
    eventId,
    fileId,
    variant,
    expires: String(expires),
    signature: salesAttachmentSignature(eventId, fileId, variant, expires),
  })
  return `/api/upload-drive?${params.toString()}`
}

export function lineImageUrls(fileId, expires = Math.floor(Date.now() / 1000) + 86400) {
  const baseUrl = (process.env.CALENDAR_PUBLIC_BASE_URL || DEFAULT_PUBLIC_BASE_URL).replace(/\/$/, '')
  const url = (variant) => `${baseUrl}/api/upload-drive?fileId=${encodeURIComponent(fileId)}&variant=${variant}&expires=${expires}&signature=${lineImageSignature(fileId, variant, expires)}`
  return {
    lineOriginalUrl: url('original'),
    linePreviewUrl: url('preview')
  }
}

export async function assertPrivateDriveFolder(drive, folderId, fallbackFactory) {
  const inspect = async (reader) => {
    let pageToken
    do {
      const response = await reader.permissions.list({ fileId: folderId, supportsAllDrives: true, pageSize: 100,
        fields: 'nextPageToken,permissions(type)', ...(pageToken ? { pageToken } : {}) })
      if ((response.data.permissions || []).some((permission) => permission.type === 'anyone')) {
        throw new Error('附件資料夾具有公開繼承權限，請先由管理員處理')
      }
      pageToken = response.data.nextPageToken
    } while (pageToken)
  }
  try { await inspect(drive) } catch (error) {
    if (![403, 404].includes(Number(error?.code || error?.response?.status))) throw error
    // Drive OAuth 的 drive.file 範圍可操作子檔卻看不到父目錄，改用已授權的伺服器身分完整驗證。
    const reader = fallbackFactory ? fallbackFactory() : google.drive({ version: 'v3', auth: new google.auth.GoogleAuth({ credentials: getServiceAccountCredentials(), scopes: ['https://www.googleapis.com/auth/drive'] }) })
    await inspect(reader)
  }
}

function getDriveAuth() {
  const clientId = process.env.GOOGLE_DRIVE_OAUTH_CLIENT_ID
  const clientSecret = process.env.GOOGLE_DRIVE_OAUTH_CLIENT_SECRET
  const refreshToken = process.env.GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN

  if (clientId && clientSecret && refreshToken) {
    const auth = new google.auth.OAuth2(clientId, clientSecret)
    auth.setCredentials({ refresh_token: refreshToken })
    return auth
  }

  const credentials = getServiceAccountCredentials()
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive']
  })
}

function parseUpload(req) {
  const form = formidable({
    multiples: true,
    keepExtensions: true,
    maxFileSize: 25 * 1024 * 1024
  })

  return new Promise((resolve, reject) => {
    form.parse(req, (error, fields, files) => {
      if (error) {
        reject(error)
        return
      }
      resolve({ fields, files })
    })
  })
}

async function parseJsonBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (!chunks.length) return {}
  const body = Buffer.concat(chunks).toString('utf8')
  return body ? JSON.parse(body) : {}
}

function normalizeFiles(fileField) {
  if (!fileField) return []
  return Array.isArray(fileField) ? fileField : [fileField]
}

function fieldText(value) {
  const normalized = Array.isArray(value) ? value[0] : value
  return typeof normalized === 'string' ? normalized.trim() : ''
}

function parsePhotoLocation(value) {
  const source = fieldText(value)
  if (!source) return null
  let location
  try {
    location = JSON.parse(source)
  } catch {
    throw requestError('照片拍攝地點格式不正確', 400)
  }
  const latitude = Number(location?.latitude)
  const longitude = Number(location?.longitude)
  const accuracy = Number(location?.accuracy)
  const locationSource = text(location?.source)
  if (
    !Number.isFinite(latitude)
    || latitude < -90
    || latitude > 90
    || !Number.isFinite(longitude)
    || longitude < -180
    || longitude > 180
    || !['exif', 'manual', 'device'].includes(locationSource)
  ) throw requestError('照片拍攝地點格式不正確', 400)
  return {
    latitude,
    longitude,
    source: locationSource,
    ...(Number.isFinite(accuracy) && accuracy >= 0 ? { accuracy } : {}),
    ...(text(location?.label) ? { label: text(location.label).slice(0, 300) } : {})
  }
}

export function parseUploadPhotoMetadata(metadata = {}) {
  const source = fieldText(metadata.capturedAtSource)
  if (source && !['exif', 'manual', 'unknown'].includes(source)) {
    throw requestError('照片拍攝日期來源不正確', 400)
  }
  const capturedAtText = fieldText(metadata.capturedAt)
  const capturedAtDate = capturedAtText ? new Date(capturedAtText) : null
  if (capturedAtDate && Number.isNaN(capturedAtDate.getTime())) {
    throw requestError('照片拍攝日期格式不正確', 400)
  }
  return {
    capturedAtSource: source || 'unknown',
    ...(capturedAtDate ? { capturedAt: capturedAtDate.toISOString() } : {}),
    ...(fieldText(metadata.location) ? { location: parsePhotoLocation(metadata.location) } : {})
  }
}

function isImage(file) {
  return Boolean(file.mimetype?.startsWith('image/')) && file.mimetype !== 'image/svg+xml'
}

const MAX_BACKGROUND_IMAGE_BYTES = 50 * 1024 * 1024
const BACKGROUND_COMPLETION_MODES = new Set(['fulfillment', 'production', 'none'])

export function parseFulfillmentOrders(value, sourceEventId) {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length < 2 || value.length > 20) throw requestError('合併配達需選擇 2～20 筆訂單', 400)
  const orders = value.map((row) => {
    const eventId = text(row?.eventId)
    const salesId = text(row?.salesId)
    const expectedShippingMethod = text(row?.expectedShippingMethod)
    const expectedOrderStatus = text(row?.expectedOrderStatus)
    if (!eventId || eventId.includes('/') || eventId.length > 200 || !salesId || salesId.includes('/') || salesId.length > 200
      || expectedShippingMethod !== '外送' || !expectedOrderStatus || expectedOrderStatus.length > 100) {
      throw requestError('合併配達訂單資料不正確', 400)
    }
    return { eventId, salesId, expectedShippingMethod, expectedOrderStatus }
  }).sort((a, b) => a.eventId.localeCompare(b.eventId))
  if (!orders.some(row => row.eventId === sourceEventId)
    || new Set(orders.map(row => row.eventId)).size !== orders.length
    || new Set(orders.map(row => row.salesId)).size !== orders.length) throw requestError('合併配達訂單重複或未包含照片訂單', 400)
  return orders
}

export function parseAttachmentUploadJobRequest(body = {}) {
  const eventId = text(body.eventId)
  const name = text(body.originalName)
  const type = text(body.contentType).toLowerCase()
  const size = Number(body.originalSize)
  const completionMode = text(body.completionMode)
  const clientUploadId = text(body.clientUploadId)
  const uploadKind = text(body.uploadKind) || 'event'
  const commentId = text(body.commentId)
  const fulfillmentBatchId = text(body.fulfillmentBatchId)
  const fulfillmentBatchSize = Number(body.fulfillmentBatchSize)
  const fulfillmentOrders = parseFulfillmentOrders(body.fulfillmentOrders, eventId)
  const fulfillmentRequestId = text(body.fulfillmentRequestId)
  if (fulfillmentOrders && (completionMode !== 'fulfillment' || !/^[A-Za-z0-9-]{8,120}$/.test(fulfillmentRequestId))) {
    throw requestError('合併配達識別碼或模式不正確', 400)
  }
  if (!fulfillmentOrders && fulfillmentRequestId) throw requestError('合併配達訂單不完整', 400)
  if (!eventId || eventId.includes('/') || eventId.length > 200) throw requestError('附件事件識別碼不正確', 400)
  if (!name || name.length > 500) throw requestError('照片檔名不正確', 400)
  if (!type.startsWith('image/') || type === 'image/svg+xml') throw requestError('外送／施工／活動完成只能上傳照片', 400)
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_BACKGROUND_IMAGE_BYTES) {
    throw requestError('照片不可超過 50 MB', 400)
  }
  if (!BACKGROUND_COMPLETION_MODES.has(completionMode)) throw requestError('照片完成模式不正確', 400)
  if (clientUploadId && !/^[A-Za-z0-9-]{8,120}$/.test(clientUploadId)) {
    throw requestError('照片佇列識別碼不正確', 400)
  }
  if (!['event', 'comment'].includes(uploadKind)) throw requestError('照片上傳目標不正確', 400)
  if (uploadKind === 'comment' && (!commentId || commentId.includes('/') || commentId.length > 200)) {
    throw requestError('留言識別碼不正確', 400)
  }
  if (uploadKind === 'comment' && completionMode !== 'none') {
    throw requestError('留言照片完成模式不正確', 400)
  }
  if (completionMode === 'fulfillment') {
    if (!/^[A-Za-z0-9-]{8,120}$/.test(fulfillmentBatchId)) {
      throw requestError('完工照片批次識別碼不正確', 400)
    }
    if (!Number.isSafeInteger(fulfillmentBatchSize) || fulfillmentBatchSize < 1 || fulfillmentBatchSize > 20) {
      throw requestError('完工照片批次張數不正確', 400)
    }
  } else if (fulfillmentBatchId || Number.isFinite(fulfillmentBatchSize)) {
    throw requestError('非完工照片不可指定完工批次', 400)
  }
  const capture = parseUploadPhotoMetadata({
    capturedAt: body.capture?.capturedAt,
    capturedAtSource: body.capture?.capturedAtSource,
    location: body.capture?.location ? JSON.stringify(body.capture.location) : ''
  })
  return {
    eventId,
    name,
    type,
    size,
    completionMode: completionMode === 'production' ? 'none' : completionMode,
    capture,
    clientUploadId,
    uploadKind,
    commentId: uploadKind === 'comment' ? commentId : '',
    fulfillmentBatchId: completionMode === 'fulfillment' ? fulfillmentBatchId : '',
    fulfillmentBatchSize: completionMode === 'fulfillment' ? fulfillmentBatchSize : 0,
    ...(fulfillmentOrders ? { fulfillmentOrders, fulfillmentRequestId } : {})
  }
}

export function attachmentUploadJobDocumentId(uploaderUid, clientUploadId) {
  return `calendar-${createHash('sha256').update(`${text(uploaderUid)}\0${text(clientUploadId)}`).digest('hex').slice(0, 48)}`
}

export function attachmentFromUploadJob(jobId, job) {
  const image = job?.result?.image && typeof job.result.image === 'object' ? job.result.image : {}
  const thumbnail = job?.result?.thumbnail && typeof job.result.thumbnail === 'object' ? job.result.thumbnail : {}
  const fileId = text(image.path)
  if (!fileId) throw requestError('背景照片處理結果不完整', 409)
  const original = job?.original && typeof job.original === 'object' ? job.original : {}
  const originalName = text(original.name) || text(image.name) || '照片'
  return {
    name: text(image.name) || webpName(originalName),
    url: text(image.url) || `https://drive.google.com/file/d/${fileId}/view`,
    path: fileId,
    type: text(image.type) || 'image/webp',
    size: Number(image.size) || 0,
    provider: 'google-drive',
    originalName,
    originalSize: Number(original.size) || 0,
    optimized: true,
    ...(text(thumbnail.path) ? { thumbnailPath: text(thumbnail.path) } : {}),
    ...(text(image.uploadedAt) ? { uploadedAt: text(image.uploadedAt) } : {}),
    ...(text(job?.capture?.capturedAt) ? { capturedAt: text(job.capture.capturedAt) } : {}),
    ...(text(job?.capture?.capturedAtSource) ? { capturedAtSource: text(job.capture.capturedAtSource) } : {}),
    ...(job?.capture?.location && typeof job.capture.location === 'object' ? { location: job.capture.location } : {}),
    ...(text(job?.uploadedByUid) ? { uploadedByUid: text(job.uploadedByUid) } : {}),
    ...(text(job?.uploadedByEmployeeNo) ? { uploadedByEmployeeNo: text(job.uploadedByEmployeeNo) } : {}),
    ...(text(job?.uploadedByName) ? { uploadedByName: text(job.uploadedByName) } : {}),
    ...lineImageUrls(fileId),
    uploadJobId: jobId
  }
}

export function mergeProductionLineRetryAttachmentIds(previousRetry, completionMode, attachmentPath) {
  const existing = previousRetry?.mode === completionMode && Array.isArray(previousRetry.attachmentIds)
    ? previousRetry.attachmentIds.map(text).filter(Boolean)
    : []
  return Array.from(new Set([...existing, text(attachmentPath)].filter(Boolean)))
}

async function createAttachmentUploadJob(db, actor, body, req) {
  const request = parseAttachmentUploadJobRequest(body)
  await authorizeUpload(db, actor, {
    eventId: request.eventId,
    uploadKind: request.uploadKind,
    commentId: request.commentId,
  })
  if (request.fulfillmentOrders) {
    for (const order of request.fulfillmentOrders) await authorizeLineAction(db, actor, order)
    const preflight = await forwardLineAction(req, {
      action: 'complete-order-fulfillment', eventId: request.eventId,
      orders: request.fulfillmentOrders, batchId: request.fulfillmentRequestId, preflight: true,
    }, { canManageEvent: true })
    if (preflight.status < 200 || preflight.status >= 300 || preflight.body?.ok !== true) {
      throw requestError(text(preflight.body?.error?.message || preflight.body?.error) || '合併配達驗證失敗', preflight.status >= 400 ? preflight.status : 409)
    }
  }
  if (request.uploadKind === 'comment') {
    const commentSnapshot = await db.collection('calendarEvents')
      .doc(request.eventId)
      .collection('comments')
      .doc(request.commentId)
      .get()
    if (!commentSnapshot.exists) throw requestError('找不到附件對應的留言', 404)
    if (text(commentSnapshot.data()?.authorUid) !== actor.uid) throw requestError('沒有此留言的附件上傳權限', 403)
  }
  const jobRef = request.clientUploadId
    ? db.collection('attachmentUploadJobs').doc(attachmentUploadJobDocumentId(actor.uid, request.clientUploadId))
    : db.collection('attachmentUploadJobs').doc()
  const stagingPath = `attachment-staging/${actor.uid}/${jobRef.id}/original`
  await db.runTransaction(async (transaction) => {
    const existingSnapshot = await transaction.get(jobRef)
    if (existingSnapshot.exists) {
      const existing = existingSnapshot.data() || {}
      if (
        text(existing.uploaderUid) !== actor.uid
        || text(existing.clientUploadId) !== request.clientUploadId
        || text(existing.target?.eventId) !== request.eventId
        || text(existing.target?.completionMode) !== request.completionMode
        || text(existing.target?.uploadKind) !== request.uploadKind
        || text(existing.target?.commentId) !== request.commentId
        || text(existing.target?.fulfillmentBatchId) !== request.fulfillmentBatchId
        || Number(existing.target?.fulfillmentBatchSize || 0) !== request.fulfillmentBatchSize
        || text(existing.target?.fulfillmentRequestId) !== text(request.fulfillmentRequestId)
        || JSON.stringify(existing.target?.fulfillmentOrders || []) !== JSON.stringify(request.fulfillmentOrders || [])
        || text(existing.original?.name) !== request.name
        || Number(existing.original?.size) !== request.size
        || text(existing.original?.type) !== request.type
      ) throw requestError('照片背景工作識別碼衝突', 409)
      return
    }
    transaction.create(jobRef, {
      status: 'created',
      ...(request.eventId !== 'draft-event' ? { autoCommitCalendarAttachment: true } : {}),
      uploaderUid: actor.uid,
      uploaderEmployeeId: actor.employeeId,
      ...attachmentUploaderFields(actor),
      ...(request.clientUploadId ? { clientUploadId: request.clientUploadId } : {}),
      stagingPath,
      original: {
        name: request.name,
        size: request.size,
        type: request.type
      },
      capture: request.capture,
      metadata: {
        source: 'calendar',
        jobId: jobRef.id,
        ...(request.clientUploadId ? { clientUploadId: request.clientUploadId } : {})
      },
      target: {
        kind: 'calendar-event',
        eventId: request.eventId,
        uploadKind: request.uploadKind,
        ...(request.commentId ? { commentId: request.commentId } : {}),
        completionMode: request.completionMode,
        ...(request.fulfillmentBatchId ? {
          fulfillmentBatchId: request.fulfillmentBatchId,
          fulfillmentBatchSize: request.fulfillmentBatchSize,
          ...(request.fulfillmentOrders ? { fulfillmentOrders: request.fulfillmentOrders, fulfillmentRequestId: request.fulfillmentRequestId } : {})
        } : {})
      },
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    })
  })
  return { ok: true, jobId: jobRef.id, stagingPath }
}

async function finalizeAttachmentUploadJob(db, actor, body) {
  const jobId = text(body.jobId)
  if (!jobId || jobId.includes('/') || jobId.length > 200) throw requestError('背景工作識別碼不正確', 400)
  const jobRef = db.collection('attachmentUploadJobs').doc(jobId)
  return db.runTransaction(async (transaction) => {
    const jobSnapshot = await transaction.get(jobRef)
    if (!jobSnapshot.exists) throw requestError('找不到背景照片工作', 404)
    const job = jobSnapshot.data() || {}
    if (text(job.uploaderUid) !== actor.uid) throw requestError('沒有此背景照片工作的權限', 403)
    if (text(job.status) === 'committed') {
      const attachment = job.attachment && typeof job.attachment === 'object'
        ? job.attachment
        : attachmentFromUploadJob(jobId, job)
      return { ok: true, attachment, committed: true, completionMode: text(job.target?.completionMode) || 'none' }
    }
    if (text(job.target?.completionMode) === 'fulfillment' && text(job.target?.fulfillmentBatchId)) {
      throw requestError('完工照片批次仍在背景處理中', 409)
    }
    if (text(job.status) !== 'ready') throw requestError('照片仍在背景處理中', 409)
    const uploadKind = text(job.target?.uploadKind)
    if (text(job.target?.kind) !== 'calendar-event' || !['event', 'comment'].includes(uploadKind)) {
      throw requestError('背景照片目標不正確', 409)
    }
    const eventId = text(job.target?.eventId)
    const eventRef = db.collection('calendarEvents').doc(eventId)
    const eventSnapshot = await transaction.get(eventRef)
    if (!eventSnapshot.exists) throw requestError('找不到附件對應的行事曆事件', 404)
    const attachment = attachmentFromUploadJob(jobId, job)
    const event = { id: eventSnapshot.id, ...eventSnapshot.data() }
    if (uploadKind === 'comment') {
      if (!await canReadCalendarEvent(db, actor, event)) throw requestError('沒有此事件的附件上傳權限', 403)
      const commentId = text(job.target?.commentId)
      if (!commentId || commentId.includes('/') || commentId.length > 200) {
        throw requestError('留言識別碼不正確', 409)
      }
      const commentRef = eventRef.collection('comments').doc(commentId)
      const commentSnapshot = await transaction.get(commentRef)
      if (!commentSnapshot.exists) throw requestError('找不到附件對應的留言', 404)
      const comment = commentSnapshot.data() || {}
      const existingAttachments = Array.isArray(comment.attachments) ? comment.attachments : []
      const alreadyAttached = existingAttachments.some((item) => text(item?.uploadJobId) === jobId)
      const nextAttachments = alreadyAttached ? existingAttachments : [...existingAttachments, attachment]
      const pendingAttachmentCount = Math.max(0, (Number(comment.pendingAttachmentCount) || 0) - (alreadyAttached ? 0 : 1))
      transaction.update(commentRef, {
        attachments: nextAttachments,
        pendingAttachmentCount,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      })
      transaction.update(jobRef, {
        status: 'committed',
        attachment,
        committedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      })
      return { ok: true, attachment, committed: true, completionMode: 'none' }
    }
    if (
      !await canManageEvent(db, actor, event, eventId)
      && !await canOperateErpOrderFulfillment(db, actor, event)
    ) throw requestError('沒有此事件的附件上傳權限', 403)

    const existingAttachments = Array.isArray(event.attachments) ? event.attachments : []
    const alreadyAttached = existingAttachments.some((item) => text(item?.uploadJobId) === jobId)
    const completionMode = BACKGROUND_COMPLETION_MODES.has(text(job.target?.completionMode))
      ? text(job.target.completionMode)
      : 'none'
    const now = new Date().toISOString()
    const update = {
      attachments: alreadyAttached ? existingAttachments : [...existingAttachments, attachment],
      updatedAt: now
    }
    if (completionMode === 'fulfillment') {
      const previousRetry = event.productionLineRetry && typeof event.productionLineRetry === 'object'
        ? event.productionLineRetry
        : null
      // 交易衝突重試後會重新讀取事件，確保多張並行 finalize 不會彼此覆蓋。
      const attachmentIds = mergeProductionLineRetryAttachmentIds(previousRetry, completionMode, attachment.path)
      update.productionLineRetry = {
        mode: completionMode,
        attachmentIds,
        status: 'pending',
        message: completionMode === 'fulfillment'
          ? '照片已保留，訂單完成尚待確認。'
          : '照片已保留，LINE 傳送尚待確認。',
        updatedAt: now
      }
    }
    transaction.update(eventRef, update)
    transaction.update(jobRef, {
      status: 'committed',
      attachment,
      committedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    })
    return { ok: true, attachment, committed: true, completionMode }
  })
}

function webpName(filename) {
  const parsed = path.parse(filename || 'image')
  return `${parsed.name || 'image'}.webp`
}

async function prepareUploadFile(file, metadata = {}) {
  const originalName = fieldText(metadata.originalName) || file.originalFilename || file.newFilename
  const parsedOriginalSize = Number(fieldText(metadata.originalSize))
  const originalSize = Number.isFinite(parsedOriginalSize) && parsedOriginalSize > 0 ? parsedOriginalSize : file.size
  if (!isImage(file)) {
    return {
      filepath: file.filepath,
      name: file.originalFilename || file.newFilename,
      mimeType: file.mimetype || 'application/octet-stream',
      size: file.size,
      originalName,
      originalSize,
      optimized: false
    }
  }

  const photoMetadata = parseUploadPhotoMetadata(metadata)

  const outputPath = path.join(os.tmpdir(), `${randomUUID()}.webp`)
  await sharp(file.filepath)
    .rotate()
    .resize({ width: 1920, height: 1920, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 78, effort: 4 })
    .toFile(outputPath)

  const stat = await fs.promises.stat(outputPath)
  return {
    filepath: outputPath,
    name: webpName(originalName),
    mimeType: 'image/webp',
    size: stat.size,
    originalName,
    originalSize,
    optimized: true,
    ...photoMetadata
  }
}

async function createLineJpeg(input, variant) {
  const variants = variant === 'preview'
    ? [
        { size: 720, quality: 72 },
        { size: 560, quality: 66 },
        { size: 420, quality: 60 }
      ]
    : [
        { size: 1920, quality: 82 },
        { size: 1600, quality: 76 },
        { size: 1280, quality: 72 },
        { size: 1024, quality: 68 }
      ]
  const maxBytes = variant === 'preview' ? 900 * 1024 : 4 * 1024 * 1024
  let output = null

  for (const option of variants) {
    output = await sharp(input)
      .rotate()
      .resize({ width: option.size, height: option.size, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: option.quality, mozjpeg: true })
      .toBuffer()
    if (output.length <= maxBytes) return output
  }

  return output
}

async function renderLineImage(req, res) {
  const requestUrl = new URL(req.url || '/', 'http://localhost')
  const fileId = typeof req.query?.fileId === 'string' ? req.query.fileId.trim() : String(requestUrl.searchParams.get('fileId') || '').trim()
  const requestedVariant = typeof req.query?.variant === 'string' ? req.query.variant : requestUrl.searchParams.get('variant')
  const variant = requestedVariant
  const expires = Number(typeof req.query?.expires === 'string' ? req.query.expires : requestUrl.searchParams.get('expires'))
  const signature = typeof req.query?.signature === 'string' ? req.query.signature : requestUrl.searchParams.get('signature') || ''
  if (!fileId || !validLineImageSignature(fileId, variant, expires, signature)) {
    res.status(403).json({ error: 'Invalid image signature' })
    return
  }

  const drive = google.drive({ version: 'v3', auth: getDriveAuth() })
  const metadata = await drive.files.get({ fileId, fields: 'mimeType', supportsAllDrives: true })
  if (variant !== 'download' && !metadata.data.mimeType?.startsWith('image/')) {
    res.status(415).json({ error: 'Unsupported image type' })
    return
  }
  const source = await drive.files.get({ fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' })
  const input = Buffer.from(source.data)
  const output = variant === 'download' ? input : await createLineJpeg(input, variant)

  if (variant === 'download') res.setHeader('Content-Disposition', 'attachment')
  res.setHeader('Content-Type', variant === 'download' ? 'application/octet-stream' : 'image/jpeg')
  res.setHeader('Content-Length', String(output.length))
  res.setHeader('Cache-Control', 'private, no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.status(200).end(output)
}

async function renderSalesAttachmentImage(req, res) {
  const requestUrl = new URL(req.url || '/', 'http://localhost')
  const value = (key) => typeof req.query?.[key] === 'string'
    ? req.query[key].trim()
    : String(requestUrl.searchParams.get(key) || '').trim()
  const eventId = value('eventId')
  const fileId = value('fileId')
  const variant = value('variant') === 'preview' ? 'preview' : 'original'
  const expires = Number(value('expires'))
  const signature = value('signature')
  const now = Math.floor(Date.now() / 1000)
  if (
    !eventId
    || eventId.includes('/')
    || !/^[A-Za-z0-9_-]{10,200}$/.test(fileId)
    || !Number.isSafeInteger(expires)
    || expires <= now
    || !validSalesAttachmentSignature(eventId, fileId, variant, expires, signature)
  ) {
    throw requestError('附件預覽連結無效或已過期', 403)
  }

  getAdminApp()
  const db = admin.firestore()
  const event = await loadEvent(db, eventId)
  if (!event || text(event.source) !== 'erpSalesDelivery') throw requestError('找不到對應的銷貨單事件', 404)
  const sales = await loadSalesRecordForEvent(db, event)
  if (!sales || !salesAttachmentFileIds(sales).has(fileId)) throw requestError('找不到此銷貨單附件', 404)

  const drive = google.drive({ version: 'v3', auth: getDriveAuth() })
  const metadata = await drive.files.get({ fileId, fields: 'mimeType,size', supportsAllDrives: true })
  if (!metadata.data.mimeType?.startsWith('image/')) throw requestError('此附件不是圖片', 415)
  const source = await drive.files.get({ fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' })
  const input = Buffer.from(source.data)
  const serveDirectThumbnail = canServeDirectSalesAttachmentThumbnail(sales, {
    fileId,
    variant,
    mimeType: metadata.data.mimeType,
    size: metadata.data.size,
  }) && input.length <= MAX_DIRECT_SALES_THUMBNAIL_BYTES
  const output = serveDirectThumbnail ? input : await createLineJpeg(input, variant)
  const responseMimeType = serveDirectThumbnail ? metadata.data.mimeType : 'image/jpeg'

  res.setHeader('Content-Type', responseMimeType)
  res.setHeader('Content-Length', String(output.length))
  res.setHeader('Cache-Control', `private, max-age=${Math.max(0, Math.min(600, expires - now))}`)
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.status(200).end(output)
}

async function salesAttachmentCenterResponse(db, actor, body) {
  const event = await loadEvent(db, body.eventId)
  if (!event || text(event.source) !== 'erpSalesDelivery') throw requestError('找不到對應的銷貨單事件', 404)
  if (!await canViewEvent(db, actor, event)) throw requestError('沒有查看此銷貨單事件的權限', 403)
  if (!await canOpenSalesAttachmentCenter(db, actor)) throw requestError('沒有查看銷貨單附件中心的權限', 403)
  const sales = await loadSalesRecordForEvent(db, event)
  if (!sales) throw requestError('找不到對應的銷貨單', 404)
  const expires = Math.floor(Date.now() / 1000) + 10 * 60
  const attachments = (Array.isArray(sales.attachments) ? sales.attachments : [])
    .filter((attachment) => text(attachment?.type).startsWith('image/') || text(attachment?.kind) === 'image')
    .map((attachment) => {
      const fileId = text(attachment.path)
      const previewFileId = text(attachment.thumbnailPath) || fileId
      if (!fileId || !previewFileId) return null
      return {
        name: text(attachment.name) || text(attachment.originalName) || '圖片',
        originalName: text(attachment.originalName) || text(attachment.name) || '圖片',
        path: fileId,
        type: text(attachment.type) || 'image/jpeg',
        size: Number(attachment.size) || undefined,
        provider: 'google-drive',
        ...(text(attachment.capturedAt) ? { capturedAt: text(attachment.capturedAt) } : {}),
        ...(text(attachment.capturedAtSource) ? { capturedAtSource: text(attachment.capturedAtSource) } : {}),
        ...salesAttachmentUploadMetadata(attachment),
        ...(attachment.location && typeof attachment.location === 'object' ? { location: attachment.location } : {}),
        linePreviewUrl: salesAttachmentImageUrl(event.id, previewFileId, 'preview', expires),
        lineOriginalUrl: salesAttachmentImageUrl(event.id, fileId, 'original', expires),
      }
    })
    .filter(Boolean)
  return { ok: true, attachments, expiresAt: new Date(expires * 1000).toISOString() }
}

export function buildForwardedLineActionBody(body) {
  const action = String(body.action || '')
  if (action === 'record-fulfillment-cash-payment') {
    return {
      action,
      eventId: body.eventId,
      amount: body.amount,
      idempotencyKey: body.idempotencyKey
    }
  }
  if (action === 'complete-order-fulfillment') {
    return {
      action,
      eventId: body.eventId,
      attachmentIds: body.attachmentIds,
      expectedShippingMethod: body.expectedShippingMethod,
      expectedOrderStatus: body.expectedOrderStatus,
      ...(body.orders !== undefined ? { orders: body.orders, batchId: body.batchId, ...(body.preflight === true ? { preflight: true } : {}) } : {})
    }
  }
  return {
    action,
    eventId: body.eventId,
    attachmentIds: body.attachmentIds
  }
}

export function isForwardedLineAction(action) {
  return FORWARDED_LINE_ACTIONS.has(text(action))
}

export function buildForwardedLineActionResponse(action, result, authorization) {
  return {
    ...result,
    ...(action === 'production-photo-status' ? {
      canCompleteOrder: authorization.canManageEvent,
      ...(authorization.canManageEvent ? {} : {
        paymentPrompt: undefined,
        paymentState: undefined,
        currentOrderUnpaidAmount: undefined,
        outstandingTotal: undefined
      })
    } : {})
  }
}

async function forwardLineAction(req, body, authorization) {
  const action = String(body.action || '')
  const appCheckToken = String(req.headers['x-firebase-appcheck'] || '')
  const forwardedBody = buildForwardedLineActionBody(body)
  const response = await fetch(process.env.ERP_LINE_API_URL || 'https://erp.city-painter.com/api/line', {
    method: 'POST',
    headers: {
      Authorization: String(req.headers.authorization || ''),
      'Content-Type': 'application/json',
      ...(appCheckToken ? { 'X-Firebase-AppCheck': appCheckToken } : {})
    },
    body: JSON.stringify(forwardedBody)
  })
  const result = await response.json().catch(() => null)
  return {
    status: response.status,
    body: result
      ? buildForwardedLineActionResponse(action, result, authorization)
      : { ok: false, error: { message: `LINE 服務回應錯誤（HTTP ${response.status}）` } }
  }
}

export async function authorizeUpload(db, actor, fields) {
  const eventId = fieldText(fields.eventId)
  const uploadKind = fieldText(fields.uploadKind)
  const commentId = fieldText(fields.commentId)
  if (!eventId || eventId.includes('/') || eventId.length > 200) {
    throw requestError('附件事件識別碼不正確', 400)
  }
  if (eventId === 'draft-event') {
    if (uploadKind === 'comment') throw requestError('留言事件不存在', 404)
    return { eventId, uploadKind: 'draft', commentId: '' }
  }

  const event = await loadEvent(db, eventId)
  if (!event) throw requestError('找不到附件對應的行事曆事件', 404)
  if (uploadKind === 'comment') {
    if (!commentId || commentId.includes('/') || commentId.length > 200) throw requestError('留言識別碼不正確', 400)
    if (!await canReadCalendarEvent(db, actor, event)) throw requestError('沒有此事件的附件上傳權限', 403)
    return { eventId, uploadKind: 'comment', commentId }
  }
  if (
    !await canManageEvent(db, actor, event, eventId)
    && !await canOperateErpOrderFulfillment(db, actor, event)
  ) throw requestError('沒有此事件的附件上傳權限', 403)
  return { eventId, uploadKind: 'event', commentId: '' }
}

export async function resolveBackgroundCommentAttachments(drive, actor, eventId, commentId, attachments = []) {
  if (!Array.isArray(attachments) || attachments.length > 10) throw requestError('留言附件數量不正確', 400)
  const ids = attachments.map((item) => text(item?.path))
  if (ids.some((id) => !/^[A-Za-z0-9_-]{10,200}$/.test(id)) || new Set(ids).size !== ids.length) {
    throw requestError('留言附件識別碼不正確', 400)
  }
  return Promise.all(ids.map(async (id) => {
    const response = await drive.files.get({
      fileId: id,
      fields: 'id,name,mimeType,size,createdTime,webViewLink,appProperties,trashed',
      supportsAllDrives: true,
    })
    const file = response.data || {}
    const properties = file.appProperties || {}
    if (file.trashed || text(file.id) !== id
      || text(properties.calendarUploaderUid) !== actor.uid
      || text(properties.calendarEventId) !== eventId
      || text(properties.calendarCommentId) !== commentId
      || text(properties.calendarUploadKind) !== 'comment') {
      throw requestError('沒有此留言附件的使用權限', 403)
    }
    // 混合留言只接收既有上傳的檔案識別碼，不採用瀏覽器提供的網址或檔案屬性。
    return {
      name: text(file.name),
      originalName: text(file.name),
      path: id,
      url: `https://drive.google.com/file/d/${id}/view`,
      type: text(file.mimeType) || 'application/octet-stream',
      size: Math.max(0, Number(file.size) || 0),
      provider: 'google-drive',
      ...attachmentUploaderFields(actor),
      ...(text(file.createdTime) ? { uploadedAt: text(file.createdTime) } : {}),
    }
  }))
}

export async function createBackgroundComment(db, actor, body) {
  const eventId = text(body.eventId)
  const commentId = text(body.commentId)
  const commentText = typeof body.text === 'string' ? body.text.trim() : ''
  const pendingAttachmentCount = Number(body.pendingAttachmentCount ?? 0)
  const requestedAttachments = body.attachments ?? []
  if (!Array.isArray(requestedAttachments) || requestedAttachments.length + pendingAttachmentCount > 10) {
    throw requestError('每則留言最多可附加 10 個附件', 400)
  }
  if (!eventId || eventId.includes('/') || eventId.length > 200) throw requestError('留言事件識別碼不正確', 400)
  if (!commentId || commentId.includes('/') || commentId.length > 200) throw requestError('留言識別碼不正確', 400)
  if (commentText.length > 5000) throw requestError('留言文字最多 5000 字', 400)
  if (!Number.isSafeInteger(pendingAttachmentCount) || pendingAttachmentCount < 0 || pendingAttachmentCount > 10) {
    throw requestError('每則留言最多可附加 10 張照片', 400)
  }
  if (!commentText && !requestedAttachments.length && pendingAttachmentCount === 0) throw requestError('請輸入留言或附加檔案', 400)
  const event = await loadEvent(db, eventId)
  if (!event) throw requestError('找不到附件對應的行事曆事件', 404)
  if (!await canReadCalendarEvent(db, actor, event)) throw requestError('沒有此事件的留言權限', 403)
  const attachments = requestedAttachments.length
    ? await resolveBackgroundCommentAttachments(google.drive({ version: 'v3', auth: getDriveAuth() }), actor, eventId, commentId, requestedAttachments)
    : []
  const initialAttachmentPaths = attachments.map((attachment) => attachment.path)
  const authorName = text(actor.employee.name)
    || text(actor.employee.nickname)
    || text(actor.decoded?.name)
    || text(actor.decoded?.email)
    || actor.employeeId
  const commentRef = db.collection('calendarEvents').doc(eventId).collection('comments').doc(commentId)
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(commentRef)
    if (snapshot.exists) {
      const existing = snapshot.data() || {}
      if (
        text(existing.authorUid) !== actor.uid
        || text(existing.text) !== commentText
        || Number(existing.initialPendingAttachmentCount ?? existing.pendingAttachmentCount) !== pendingAttachmentCount
        || JSON.stringify(existing.initialAttachmentPaths || []) !== JSON.stringify(initialAttachmentPaths)
      ) throw requestError('留言識別碼衝突', 409)
      return
    }
    transaction.create(commentRef, {
      authorUid: actor.uid,
      authorEmployeeId: actor.employeeId,
      authorName,
      text: commentText,
      attachments,
      initialAttachmentPaths,
      initialPendingAttachmentCount: pendingAttachmentCount,
      pendingAttachmentCount,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    })
  })
  return { ok: true, commentId }
}

export async function commitDevelopmentCommentAttachment(db, actor, body, suppliedDrive) {
  const eventId = text(body.eventId)
  const commentId = text(body.commentId)
  if (!eventId || eventId.includes('/') || eventId.length > 200
    || !commentId || commentId.includes('/') || commentId.length > 200) throw requestError('留言識別碼不正確', 400)
  const event = await loadEvent(db, eventId)
  if (!event || !await canReadCalendarEvent(db, actor, event)) throw requestError('沒有此事件的留言權限', 403)
  const drive = suppliedDrive || google.drive({ version: 'v3', auth: getDriveAuth() })
  const [attachment] = await resolveBackgroundCommentAttachments(drive, actor, eventId, commentId, [{ path: body.fileId }])
  const commentRef = db.collection('calendarEvents').doc(eventId).collection('comments').doc(commentId)
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(commentRef)
    if (!snapshot.exists) throw requestError('找不到附件對應的留言', 404)
    const comment = snapshot.data() || {}
    if (comment.authorUid !== actor.uid || comment.authorEmployeeId !== actor.employeeId) throw requestError('只能更新自己的留言附件', 403)
    const attachments = Array.isArray(comment.attachments) ? comment.attachments : []
    if (attachments.some((item) => item.path === attachment.path)) return
    const pending = Number(comment.pendingAttachmentCount)
    if (!Number.isSafeInteger(pending) || pending < 1 || attachments.length >= 10) throw requestError('留言沒有待上傳的附件欄位', 409)
    transaction.update(commentRef, {
      attachments: [...attachments, attachment],
      pendingAttachmentCount: pending - 1,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    })
  })
  return { ok: true, commentId, attachment }
}

async function authorizeDelete(db, actor, fileId, requestedEventId, appProperties) {
  if (actor.role === 'admin') return
  const uploadKind = text(appProperties.calendarUploadKind)
  const uploaderUid = text(appProperties.calendarUploaderUid)
  const storedEventId = text(appProperties.calendarEventId)
  if (uploadKind === 'comment' || uploadKind === 'draft') {
    if (uploaderUid === actor.uid) return
    throw requestError('沒有此附件的刪除權限', 403)
  }
  if (uploadKind === 'event' && storedEventId) {
    const event = await loadEvent(db, storedEventId)
    if (
      event
      && (
        await canManageEvent(db, actor, event, storedEventId)
        || await canOperateErpOrderFulfillment(db, actor, event)
      )
    ) return
    throw requestError('沒有此附件的刪除權限', 403)
  }

  const eventId = text(requestedEventId)
  const event = await loadEvent(db, eventId)
  if (
    event
    && attachmentBelongsToEvent(event, fileId)
    && (
      await canManageEvent(db, actor, event, eventId)
      || await canOperateErpOrderFulfillment(db, actor, event)
    )
  ) return
  throw requestError('舊附件缺少所有權資料，僅管理員可刪除', 403)
}

export async function fulfillmentSelectionStatus(db, actor, body) {
  const requestedIds = body?.eventIds
  if (!Array.isArray(requestedIds) || requestedIds.length < 1 || requestedIds.length > 20
    || requestedIds.some((id) => typeof id !== 'string' || !id.trim() || id !== id.trim()
      || id.includes('/') || id.length > 200 || /[\u0000-\u001f\u007f]/u.test(id))) {
    throw requestError('請提供 1 至 20 筆有效的行事曆事件識別碼', 400)
  }
  const eventIds = [...new Set(requestedIds)]
  const results = new Array(eventIds.length)
  let cursor = 0
  const worker = async () => {
    while (cursor < eventIds.length) {
      const index = cursor++
      const eventId = eventIds[index]
      try {
        const event = await loadEvent(db, eventId)
        if (!event || text(event.source) !== 'erpSalesDelivery') throw requestError('找不到對應的銷貨單事件', 404)
        if (!await canViewEvent(db, actor, event)) throw requestError('沒有查看此銷貨單事件的權限', 403)
        if (!await canManageEvent(db, actor, event, eventId)
          && !await canOperateErpOrderFulfillment(db, actor, event)) {
          throw requestError('沒有配達回報權限', 403)
        }
        if (text(event.sourceEventRole) === 'related' || text(event.sourceParentEventId)) {
          throw requestError('附屬事件不能執行合併配達回報', 400)
        }
        const salesId = text(event.sourceId)
        if (!salesId || salesId.includes('/') || salesId.length > 200) throw requestError('事件缺少有效的銷貨單資料', 409)
        // 僅以事件保存的精確識別碼查單，避免舊單號相似或重複時誤選。
        const snapshot = await db.collection('sales').doc(salesId).get()
        if (!snapshot.exists) throw requestError('找不到事件對應的銷貨單', 404)
        const sales = snapshot.data() || {}
        if (sales.deleted === true || sales.isDeleted === true || sales.deletedAt || sales.voided === true
          || ['作廢', '刪除', '已刪除', '取消', '已取消', 'cancelled', 'canceled', 'void', 'voided', 'deleted']
            .includes(text(sales.status).toLowerCase())) {
          throw requestError('作廢或刪除的訂單不可配達', 409)
        }
        // 與 ERP 完成訂單的狀態正規化一致，空白舊單仍可使用「未設定」送出預期狀態。
        const orderStatus = text(sales.orderStatus) || '未設定'
        results[index] = { eventId, salesId, status: {
          canCompleteOrder: true,
          shippingMethod: text(sales.shippingMethod),
          orderStatus: orderStatus === '已送出' ? '已寄出' : orderStatus,
        } }
      } catch (error) {
        results[index] = { eventId, message: Number(error?.status) >= 400 && Number(error?.status) < 500
          ? error.message : '訂單狀態讀取失敗，請稍後再試' }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, eventIds.length) }, worker))
  return { ok: true, statuses: results.filter((result) => result.status), errors: results.filter((result) => !result.status) }
}

export async function authorizeLineAction(db, actor, body) {
  const eventId = text(body.eventId)
  const event = await loadEvent(db, eventId)
  if (!event || text(event.source) !== 'erpSalesDelivery') throw requestError('找不到對應的銷貨單事件', 404)
  if (body.action === 'production-photo-status') {
    if (!await canViewEvent(db, actor, event)) throw requestError('沒有查看此銷貨單事件的權限', 403)
    return {
      canManageEvent: await canManageEvent(db, actor, event, eventId)
        || await canOperateErpOrderFulfillment(db, actor, event)
    }
  }
  if (
    !await canManageEvent(db, actor, event, eventId)
    && !await canOperateErpOrderFulfillment(db, actor, event)
  ) throw requestError('沒有操作此銷貨單事件的權限', 403)
  return { canManageEvent: true }
}

export async function calendarAttachmentLinks(db, actor, body) {
  const eventId = text(body.eventId)
  const fileIds = body.fileIds
  if (!eventId || eventId.includes('/') || !Array.isArray(fileIds) || fileIds.length < 1 || fileIds.length > 20
    || fileIds.some((id) => typeof id !== 'string' || !/^[A-Za-z0-9_-]{10,200}$/.test(id))) {
    throw requestError('附件識別碼不正確', 400)
  }
  const event = await loadEvent(db, eventId)
  if (!event || !await canReadCalendarEvent(db, actor, event)) throw requestError('沒有此事件的附件讀取權限', 403)
  const attachments = [...(event.attachments || [])]
  if (fileIds.some((id) => !attachments.some((item) => item.path === id || item.thumbnailPath === id))) {
    const comments = await db.collection('calendarEvents').doc(eventId).collection('comments').get()
    for (const comment of comments.docs) attachments.push(...(comment.data().attachments || []))
  }
  if (fileIds.some((id) => !attachments.some((item) => item.path === id || item.thumbnailPath === id))) {
    throw requestError('附件不屬於此事件', 403)
  }
  const expires = Math.floor(Date.now() / 1000) + 600
  return { expiresAt: expires * 1000, links: fileIds.map((fileId) => ({
    fileId,
    ...lineImageUrls(fileId, expires),
    downloadUrl: `${(process.env.CALENDAR_PUBLIC_BASE_URL || DEFAULT_PUBLIC_BASE_URL).replace(/\/$/, '')}/api/upload-drive?fileId=${encodeURIComponent(fileId)}&variant=download&expires=${expires}&signature=${lineImageSignature(fileId, 'download', expires)}`,
  })) }
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    try {
      const requestUrl = new URL(req.url || '/', 'http://localhost')
      const scope = typeof req.query?.scope === 'string' ? req.query.scope : requestUrl.searchParams.get('scope')
      if (scope === 'sales-attachment') await renderSalesAttachmentImage(req, res)
      else await renderLineImage(req, res)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Image conversion failed'
      res.status(Number(error?.status) || 500).json({ error: message })
    }
    return
  }

  if (req.method === 'OPTIONS') {
    res.status(204).end()
    return
  }

  if (!['POST', 'DELETE'].includes(req.method || '')) {
    res.setHeader('Allow', 'GET, POST, DELETE, OPTIONS')
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  try {
    const actor = await authenticateEmployee(req)
    const db = admin.firestore()

    if (req.method === 'DELETE') {
      const { fileId, eventId } = await parseJsonBody(req)
      if (!fileId || typeof fileId !== 'string' || !/^[A-Za-z0-9_-]{10,200}$/.test(fileId)) {
        res.status(400).json({ error: 'Missing fileId' })
        return
      }

      const auth = getDriveAuth()
      const drive = google.drive({ version: 'v3', auth })
      try {
        const metadata = await drive.files.get({
          fileId,
          fields: 'id,appProperties',
          supportsAllDrives: true
        })
        const appProperties = metadata.data.appProperties || {}
        await authorizeDelete(db, actor, fileId, eventId, appProperties)
        const deletePolicy = await resolveCalendarAttachmentDeletePolicy(db, fileId, eventId, appProperties)
        if (deletePolicy.action === 'retain') {
          res.status(200).json({ ok: true, retained: true, reason: deletePolicy.reason })
          return
        }
        await drive.files.delete({ fileId })
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 404) {
          res.status(200).json({ ok: true })
          return
        }
        throw error
      }

      res.status(200).json({ ok: true })
      return
    }

    if (req.headers['content-type']?.includes('application/json')) {
      const body = await parseJsonBody(req)
      if (body.action === 'calendar-attachment-links') {
        res.setHeader('Cache-Control', 'no-store')
        res.status(200).json(await calendarAttachmentLinks(db, actor, body))
        return
      }
      if (body.action === 'create-attachment-upload-job') {
        res.status(201).json(await createAttachmentUploadJob(db, actor, body, req))
        return
      }
      if (body.action === 'commit-development-comment-attachment') {
        res.status(200).json(await commitDevelopmentCommentAttachment(db, actor, body))
        return
      }
      if (body.action === 'create-background-comment') {
        res.status(201).json(await createBackgroundComment(db, actor, body))
        return
      }
      if (body.action === 'finalize-attachment-upload-job') {
        res.status(200).json(await finalizeAttachmentUploadJob(db, actor, body))
        return
      }
      if (body.action === 'fulfillment-selection-status') {
        res.setHeader('Cache-Control', 'private, no-store')
        res.status(200).json(await fulfillmentSelectionStatus(db, actor, body))
        return
      }
      if (body.action === 'sales-attachments') {
        res.setHeader('Cache-Control', 'private, no-store')
        res.status(200).json(await salesAttachmentCenterResponse(db, actor, body))
        return
      }
      if (body.action === SALES_DELIVERY_EVENT_SYNC_ACTION) {
        res.status(200).json(await syncSalesDeliveryEventFields(db, actor, body))
        return
      }
      if (body.action === RELATED_SALES_DELIVERY_EVENT_SYNC_ACTION) {
        res.status(200).json(await syncRelatedSalesDeliveryEventFields(db, actor, body))
        return
      }
      if (!isForwardedLineAction(body.action)) {
        res.status(400).json({ error: 'Unsupported action' })
        return
      }
      const lineAuthorization = await authorizeLineAction(db, actor, body)
      const forwarded = await forwardLineAction(req, body, lineAuthorization)
      res.status(forwarded.status).json(forwarded.body)
      return
    }

    const { fields, files } = await parseUpload(req)
    const uploadFiles = normalizeFiles(files.files)
    if (!uploadFiles.length) {
      res.status(400).json({ error: 'No files uploaded' })
      return
    }

    const auth = getDriveAuth()
    const drive = google.drive({ version: 'v3', auth })
    const folderId = process.env.GOOGLE_DRIVE_CALENDAR_FOLDER_ID || DEFAULT_DRIVE_FOLDER_ID
    const uploadContext = await authorizeUpload(db, actor, fields)
    await assertPrivateDriveFolder(drive, folderId)
    const uploaderFields = attachmentUploaderFields(actor)
    const clientUploadId = fieldText(fields.clientUploadId)
    if (clientUploadId && !/^[A-Za-z0-9-]{8,120}$/.test(clientUploadId)) {
      throw requestError('照片佇列識別碼不正確', 400)
    }

    const attachments = []
    for (const file of uploadFiles) {
      const prepared = await prepareUploadFile(file, {
        originalName: fields.originalName,
        originalSize: fields.originalSize,
        capturedAt: fields.capturedAt,
        capturedAtSource: fields.capturedAtSource,
        location: fields.location
      })
      let driveFile = null
      if (clientUploadId) {
        const existing = await drive.files.list({
          q: `'${folderId}' in parents and trashed = false and appProperties has { key='calendarClientUploadId' and value='${clientUploadId}' }`,
          spaces: 'drive',
          pageSize: 10,
          fields: 'files(id,name,mimeType,size,createdTime,webViewLink,webContentLink,appProperties)'
        })
        driveFile = existing.data.files?.find((item) => (
          text(item.appProperties?.calendarUploaderUid) === actor.uid
          && text(item.appProperties?.calendarEventId) === uploadContext.eventId
        )) || null
      }
      if (!driveFile) {
        const created = await drive.files.create({
          requestBody: {
            name: prepared.name,
            mimeType: prepared.mimeType,
            parents: [folderId],
            appProperties: {
              calendarUploadKind: uploadContext.uploadKind,
              calendarUploaderUid: actor.uid,
              calendarEventId: uploadContext.eventId,
              ...(clientUploadId ? { calendarClientUploadId: clientUploadId } : {}),
              ...(uploadContext.commentId ? { calendarCommentId: uploadContext.commentId } : {})
            }
          },
          media: {
            mimeType: prepared.mimeType,
            body: fs.createReadStream(prepared.filepath)
          },
          fields: 'id,name,mimeType,size,createdTime,webViewLink,webContentLink'
        })
        driveFile = created.data


      }

      attachments.push({
        name: driveFile.name || prepared.name,
        url: driveFile.webViewLink || `https://drive.google.com/file/d/${driveFile.id}/view`,
        path: driveFile.id || '',
        type: driveFile.mimeType || prepared.mimeType,
        size: driveFile.size ? Number(driveFile.size) : prepared.size,
        provider: 'google-drive',
        originalName: prepared.originalName,
        originalSize: prepared.originalSize,
        optimized: prepared.optimized,
        ...uploaderFields,
        ...(prepared.capturedAt ? { capturedAt: prepared.capturedAt } : {}),
        ...(prepared.capturedAtSource ? { capturedAtSource: prepared.capturedAtSource } : {}),
        ...(prepared.location ? { location: prepared.location } : {}),
        ...(text(driveFile.createdTime) ? { uploadedAt: text(driveFile.createdTime) } : {}),
        ...(prepared.optimized && driveFile.id ? lineImageUrls(driveFile.id) : {})
      })

      if (prepared.optimized) {
        await fs.promises.unlink(prepared.filepath).catch(() => {})
      }
    }

    res.status(200).json({ attachments })
  } catch (error) {
    const status = Number(error?.status) || 500
    if (status >= 500) console.error('Calendar attachment API failed', error)
    const message = status >= 500 ? '附件服務處理失敗，請稍後再試' : error instanceof Error ? error.message : '附件服務處理失敗'
    res.status(status).json({ error: message })
  }
}
