import { fetchCalendarData, createCalendarActivity, getCalendarEventSnapshot } from '../lib/calendarDataApi'
import CalendarAttachmentFile from '../components/CalendarAttachmentFile'
import { createCombinedDeliveryStatusCache, type DeliverySelectionResult } from '../lib/combinedDeliveryStatusCache'
import CombinedDeliveryDialog from '../components/CombinedDeliveryDialog'
import { combinedDeliveryCandidates, type CombinedDeliveryOrder } from '../lib/combinedDelivery'
import { isCalendarEventCompleted } from '../lib/deliveryEventGrouping'
import { readBrowserValue, writeBrowserValue } from '../lib/browserStorage'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ChangeEvent, ClipboardEvent as ReactClipboardEvent, DragEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode, TouchEvent as ReactTouchEvent } from 'react'
import dayjs from 'dayjs'
import { canEditOrCopyErpEvent } from '../../shared/erpEventEditPolicy.js'
import { addDoc, arrayUnion, collection, deleteDoc, deleteField, doc, getDoc, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore'
import { signOut, type User } from 'firebase/auth'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { auth, db, firebaseRequestErrorMessage, getAppCheckHeaders, getFirebaseIdToken } from '../lib/firebase'
import {
  blocksBackgroundAttachmentUnload,
  canUseBackgroundImageUpload,
  durableBackgroundAttachmentFile,
  loadDurableBackgroundAttachmentUploads,
  loadBackgroundAttachmentRecoveries,
  persistDurableBackgroundAttachmentUpload,
  persistDurableBackgroundAttachmentBatch,
  removeDurableBackgroundAttachmentUpload,
  removeDurableBackgroundAttachmentBatch,
  resumeBackgroundAttachmentUpload,
  runWithConcurrency,
  startBackgroundAttachmentUpload,
  updateDurableBackgroundAttachmentUpload,
  type BackgroundAttachmentCompletionMode,
  type DurableBackgroundAttachmentUpload,
  type DurableBackgroundAttachmentStatus,
} from '../lib/backgroundAttachmentUpload'
import { createCloudSafeBatchNotice, shouldUseCalendarCloudUpload } from '../lib/backgroundAttachmentUploadPolicy'
import { employeeNicknameTitle } from '../lib/employeeDirectory'
import { compareDayEventsForCalendarDate, eventDaySegmentForCalendarDate, eventTimeLabelForCalendarDate } from '../lib/calendarEventSort'
import { fulfillmentPaymentNotice, type FulfillmentCashPaymentResult } from '../lib/fulfillmentPaymentResult'
import { fulfillmentRetryDecision } from '../lib/fulfillmentRetryLifecycle'
import { attachmentThumbnailSources, isImageAttachment } from '../lib/attachmentThumbnail'
import { attachmentUploadLabel } from '../lib/attachmentUploadMetadata'
import { resolveEventDetailAttachments } from '../lib/eventDetailAttachments'
import {
  ERP_SALES_DELIVERY_RELATED_INDEPENDENT_FIELDS,
  ERP_SALES_DELIVERY_RELATED_SHARED_FIELDS,
  erpSalesDeliveryPrimaryEventId,
  isErpSalesWorkScheduleEvent,
  isOperationalErpSalesDeliveryEvent,
  workScheduleTitleForOverride,
  resolveTeardownDetailEvent,
  isErpSalesDeliveryEvent,
  isPrimaryErpSalesDeliveryEvent,
  isRelatedErpSalesDeliveryEvent,
  primarySyncFieldsForRelatedEdit,
  relatedErpSalesDeliveryFields,
} from '../lib/erpSalesDeliveryEventRelation'
import { composeEditableEventTitle } from '../lib/calendarEventTitle'
import {
  deliveryGroupCompletedCount,
  deliveryGroupTitle,
  groupCalendarDayEvents,
  type CalendarDayDisplayItem,
} from '../lib/deliveryEventGrouping'
import { readLocalQueryCache, updateLocalQueryCache, writeLocalQueryCache } from '../lib/localQueryCache'
import { extractPhotoCaptureMetadata, type PhotoCaptureMetadata, type PhotoLocation } from '../lib/photoMetadata'
import { mergePhotoCaptureMetadata, requestDevicePhotoLocationForEvent } from '../lib/photoGeolocation'
import { sortAttachmentsNewestFirst } from '../lib/attachmentSort'
import {
  backgroundAttachmentDisplayLabel,
  hideCompletedBackgroundUploadPreviews,
  hideRemoteAttachmentsUsingLocalPreviews,
} from '../lib/backgroundAttachmentDisplay'
import { ensurePushSubscription, isPushSupported } from '../lib/pushNotifications'
import CalendarDatePicker from '../components/CalendarDatePicker'
import AttachmentThumbnail from '../components/AttachmentThumbnail'
import ZoomableAttachmentImage from '../components/ZoomableAttachmentImage'
import CalendarRoutePending from '../components/shared/CalendarRoutePending'
import { useAuth } from '../contexts/AuthContext'
import { useCalendarActivityLogs, useCalendarEvents, useCalendarGroups, useCalendarSearchEvents } from '../hooks/useCalendarData'
import { useDepartments, useEmployees, useShifts } from '../hooks/useHrData'
import { useSalesOperationalStatus } from '../hooks/useSalesOperationalStatus'
import { fetchSalesOperationalStatus, type SalesOperationalStatus } from '../lib/salesOperationalStatus'
import { dismissActiveKeyboard, isVisualViewportReducedByKeyboard } from '../lib/visualViewport'
import type { CalendarActivityLog, CalendarEvent, CalendarEventComment, CalendarGroup, Employee, FulfillmentPaymentPrompt, UserNotificationSettings } from '../types'

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']
const DEFAULT_MONTH_DAY_EVENT_ROW_LIMIT = 6
const COLORS = ['#f6b100', '#1fb6a6', '#3c82f6', '#ef6262', '#8d6df2', '#31a24c', '#f57c35', '#667085']
const DEPARTMENT_CALENDAR_PREFIX = 'department:'
const HR_LEAVE_CALENDAR_NAME = 'HR 請假'
const HR_HOLIDAY_COLOR = '#dc2626'
const HR_PUNCH_CORRECTION_LEAVE_TYPE = '補打卡'
const LOCAL_CALENDAR_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '100.77.87.95',
  'macbook-air.tail7313ae.ts.net'
])
const ALL_DEPARTMENTS_EXCEPT_OWN = 'allDepartmentsExceptOwn'
const ALL_EMPLOYEES_EXCEPT_SELF = 'allEmployeesExceptSelf'
const ACTIVITY_NOTIFICATION_SEEN_KEY = 'cityPainterCalendarActivitySeenAt'
const NOTIFIED_TAGS_KEY = 'cityPainterCalendarNotifiedTags'
const NOTIFIED_TAG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const SALES_ATTACHMENT_PREFETCH_DAYS = 7
const SALES_ATTACHMENT_PREFETCH_EVENT_LIMIT = 14
const SALES_ATTACHMENT_PREFETCH_DELAY_MS = 2500
const SALES_ATTACHMENT_URL_REFRESH_INTERVAL_MS = 4 * 60 * 1000
const SALES_FORM_REDIRECT_REUSE_MS = 90_000
const SALES_FORM_REDIRECT_CACHE_LIMIT = 4
const SALES_FORM_POPUP_NAME = 'city_painter_sales_form'
const SALES_FORM_POPUP_FEATURES = [
  'popup=yes',
  'width=1360',
  'height=820',
  'left=80',
  'top=60',
  'resizable=yes',
  'scrollbars=yes',
].join(',')
const TOUCH_DRAG_LONG_PRESS_MS = 360
const TOUCH_DRAG_START_TOLERANCE = 48
const SALES_DELIVERY_EVENT_SYNC_ACTION = 'sync-sales-delivery-event-fields'
const RELATED_SALES_DELIVERY_EVENT_SYNC_ACTION = 'sync-related-sales-delivery-event-fields'
const RELATED_SALES_DELIVERY_INDEPENDENT_FIELDS = new Set<string>(ERP_SALES_DELIVERY_RELATED_INDEPENDENT_FIELDS)
const RELATED_SALES_DELIVERY_SHARED_FIELDS = new Set<string>(ERP_SALES_DELIVERY_RELATED_SHARED_FIELDS)
const SALES_DELIVERY_EVENT_SYNC_FIELD_NAMES = [
  'title',
  'date',
  'endDate',
  'startTime',
  'endTime',
  'allDay',
  'location',
] as const
const DEFAULT_USER_NOTIFICATION_SETTINGS: UserNotificationSettings = {
  shiftStartEnabled: true,
  shiftEndEnabled: false
}
const REMINDER_OPTIONS = [
  { value: 'none', label: '無通知' },
  { value: 'start', label: '事件開始時' },
  { value: '5m', label: '5 分鐘前' },
  { value: '15m', label: '15 分鐘前' },
  { value: '1h', label: '1 小時前' },
  { value: '1d', label: '1 天前' }
] as const
type TitleIconOption = {
  icon: string
  label: string
}

type SalesFormRedirectPrefetch = {
  salesId: string
  createdAt: number
  redirectUrl: string
  promise: Promise<string>
}

const DEFAULT_TITLE_ICON_OPTIONS: TitleIconOption[] = [
  { icon: '👷', label: '施工' },
  { icon: '📐', label: '丈量' },
  { icon: '📦', label: '送貨' },
  { icon: '🎪', label: '活動' },
  { icon: '🚗', label: '場刊' },
  { icon: '💗', label: '心健月' },
  { icon: '👨‍🦳', label: '失智月' },
  { icon: '💼', label: '開會' },
  { icon: '🈵', label: '不排工作' },
  { icon: '❌', label: '不在' },
  { icon: '🎨', label: '設計' },
  { icon: '🚀', label: '外包' }
]

const loadErpOrderScanner = () => import('../components/ErpOrderScanner')
const ErpOrderScanner = lazy(loadErpOrderScanner)
const preloadedSalesAttachmentPreviews = new Map<string, Promise<void>>()

function shouldSkipSalesAttachmentPrefetch() {
  const connection = (navigator as Navigator & {
    connection?: { saveData?: boolean, effectiveType?: string }
  }).connection
  return connection?.saveData === true || connection?.effectiveType === 'slow-2g' || connection?.effectiveType === '2g'
}

function preloadSalesAttachmentPreview(source: string) {
  if (!source) return Promise.resolve()
  const existing = preloadedSalesAttachmentPreviews.get(source)
  if (existing) return existing
  const promise = new Promise<void>((resolve) => {
    const image = new Image()
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      window.clearTimeout(timeout)
      image.onload = null
      image.onerror = null
      resolve()
    }
    const timeout = window.setTimeout(finish, 12_000)
    image.onload = () => {
      void image.decode().catch(() => undefined).finally(finish)
    }
    image.onerror = finish
    image.decoding = 'async'
    image.referrerPolicy = 'no-referrer'
    image.setAttribute('fetchpriority', 'low')
    image.src = source
  })
  preloadedSalesAttachmentPreviews.set(source, promise)
  return promise
}

function loadCommentAttachmentPreview(source: string) {
  return new Promise<boolean>((resolve) => {
    const image = new Image()
    let settled = false
    const finish = (loaded: boolean) => {
      if (settled) return
      settled = true
      window.clearTimeout(timeout)
      image.onload = null
      image.onerror = null
      resolve(loaded)
    }
    const timeout = window.setTimeout(() => finish(false), 12_000)
    image.onload = () => {
      void image.decode().catch(() => undefined).finally(() => finish(true))
    }
    image.onerror = () => finish(false)
    image.decoding = 'async'
    image.referrerPolicy = 'no-referrer'
    image.src = source
  })
}

function preloadErpOrderScannerModule() {
  return loadErpOrderScanner().then((module) => module.preloadErpOrderScanner())
}
type ViewMode = 'month' | 'week'
type EventEditorIcon = 'person' | 'department' | 'calendar' | 'bell' | 'repeat' | 'link' | 'location' | 'paperclip' | 'note' | 'check'
type RecurrenceEditScope = 'single' | 'future' | 'all'
type EventAttachment = NonNullable<CalendarEvent['attachments']>[number]
type AttachmentUpload = {
  id: string
  name: string
  size: number
  status: 'uploading' | 'uploaded' | 'failed'
  attachment?: EventAttachment
  error?: string
}
type PendingCommentFile = {
  id: string
  file: File
}
type EventCommentsState = {
  cacheKey: string
  rows: CalendarEventComment[]
}
type EventCommentsErrorState = {
  cacheKey: string
  message: string
}

const EVENT_COMMENTS_MEMORY_CACHE_LIMIT = 30
const eventCommentsMemoryCache = new Map<string, CalendarEventComment[]>()

function cacheEventComments(cacheKey: string, rows: CalendarEventComment[]) {
  eventCommentsMemoryCache.delete(cacheKey)
  eventCommentsMemoryCache.set(cacheKey, rows)
  while (eventCommentsMemoryCache.size > EVENT_COMMENTS_MEMORY_CACHE_LIMIT) {
    const oldestKey = eventCommentsMemoryCache.keys().next().value
    if (typeof oldestKey !== 'string') break
    eventCommentsMemoryCache.delete(oldestKey)
  }
}
type ProductionLineStatus = SalesOperationalStatus

function productionLineBindingDescription(status: ProductionLineStatus, includePrefix = true) {
  const prefix = includePrefix ? '官方 LINE：' : ''
  if (status.bound) {
    return `${prefix}已綁定（${status.customerCode} ${status.lineDisplayName || status.customerName}）`
  }
  const groupNames = (status.availableGroupNames || []).filter(Boolean)
  const groupLabel = groupNames.length > 0 ? groupNames.join('、') : '已綁定群組'
  if (status.reason === 'recipient_not_bound_group_available') {
    const recipient = status.recipientName ? `收件人「${status.recipientName}」` : '收件人'
    return `${prefix}群組已綁定（${groupLabel}），但本單設定為僅收件人，${recipient}尚未綁定個人 LINE`
  }
  if (status.reason === 'group_not_selected') {
    return `${prefix}群組已綁定（${groupLabel}），但本單尚未選擇通知群組`
  }
  if (status.reason === 'group_selection_unavailable') {
    return `${prefix}本單選擇的通知群組已失效或不屬於此客戶`
  }
  if (status.reason === 'notification_disabled') return `${prefix}本單設定為不通知`
  if (status.reason === 'recipient_not_bound') return `${prefix}本單收件人尚未綁定個人 LINE`
  if (status.reason === 'customer_not_bound') {
    return `${prefix}尚未綁定（${status.customerCode} ${status.customerName}）`
  }
  if (status.reason === 'contact_inactive') return `${prefix}已封鎖或取消加入`
  return `${prefix}目前無法取得綁定資料`
}

type ApiErrorPayload = string | { message?: string }
type OrderFulfillmentResult = {
  orders?: { eventId: string; salesId: string; orderStatus: string; paymentPrompt?: FulfillmentPaymentPrompt }[]
  orderStatus: string
  shippingMethod?: string
  message: string
  lineSent?: boolean
  lineSkipped?: boolean
  lineWarning?: string
  paymentPrompt?: FulfillmentPaymentPrompt
}
type FulfillmentPaymentModal = FulfillmentPaymentPrompt & {
  batchSalesNo?: string
  eventId: string
  idempotencyKey: string
}
type ProductionLineRetry = {
  fulfillmentOrders?: CombinedDeliveryOrder[]
  fulfillmentRequestId?: string
  fulfillmentSourceEventId?: string
  eventId: string
  attachmentIds: string[]
  mode: 'fulfillment'
  shippingMethod: string
  orderStatus: string
}
type DetailBackgroundUpload = {
  fulfillmentRequestId?: string
  id: string
  jobId?: string
  attachmentPath?: string
  eventId: string
  name: string
  previewUrl: string
  status: DurableBackgroundAttachmentStatus
  progress: number
  cloudSafe: boolean
  createdAt: string
  error?: string
}
type CommentBackgroundUpload = DetailBackgroundUpload & {
  commentId: string
}
const MAX_DIRECT_ATTACHMENT_BYTES = 3.5 * 1024 * 1024

type PreparedAttachmentUpload = {
  file: File
  originalName: string
  originalSize: number
  capture?: PhotoCaptureMetadata
}

function attachmentTransferName(name: string) {
  const baseName = name.replace(/\.[^.]+$/, '') || 'image'
  return `${baseName}.jpg`
}

async function prepareAttachmentUpload(file: File): Promise<PreparedAttachmentUpload> {
  const metadata = { originalName: file.name, originalSize: file.size }
  const imageLike = file.type.startsWith('image/') || /\.(?:avif|heic|heif|jpe?g|png|webp)$/i.test(file.name)
  if (!imageLike || file.type === 'image/svg+xml') {
    if (file.size > MAX_DIRECT_ATTACHMENT_BYTES) throw new Error('附件超過 3.5 MB，請縮小檔案後再試。')
    return { file, ...metadata }
  }
  const capture = await extractPhotoCaptureMetadata(file)
  if (file.size <= MAX_DIRECT_ATTACHMENT_BYTES) {
    return { file, ...metadata, capture }
  }

  const sourceUrl = URL.createObjectURL(file)
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image()
      element.onload = () => resolve(element)
      element.onerror = () => reject(new Error('此照片無法在手機端壓縮，請改用較小的 JPEG、PNG 或 WebP。'))
      element.src = sourceUrl
    })
    const candidates = [
      { size: 1920, quality: 0.8 },
      { size: 1600, quality: 0.74 },
      { size: 1280, quality: 0.68 },
      { size: 1024, quality: 0.62 },
      { size: 800, quality: 0.56 }
    ]

    for (const candidate of candidates) {
      const ratio = Math.min(1, candidate.size / Math.max(image.naturalWidth, image.naturalHeight))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio))
      canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio))
      const context = canvas.getContext('2d')
      if (!context) throw new Error('瀏覽器無法處理此照片，請稍後再試。')
      context.drawImage(image, 0, 0, canvas.width, canvas.height)
      // iOS WebView 的 Canvas 不一定支援 WebP 編碼，JPEG 僅作為傳輸格式，後端仍只保留 WebP。
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', candidate.quality))
      if (blob?.type === 'image/jpeg' && blob.size <= MAX_DIRECT_ATTACHMENT_BYTES) {
        return {
          file: new File([blob], attachmentTransferName(file.name), { type: 'image/jpeg', lastModified: file.lastModified }),
          ...metadata,
          capture
        }
      }
    }

    throw new Error('照片壓縮後仍超過上傳限制，請縮小照片後再試。')
  } finally {
    URL.revokeObjectURL(sourceUrl)
  }
}
type DisplayCalendar = CalendarGroup & { systemKind?: 'department' | 'hrLeave' }
type EventForm = {
  calendarId: string
  calendarIds: string[]
  title: string
  date: string
  endDate: string
  startTime: string
  endTime: string
  allDay: boolean
  departmentId: string
  assigneeIds: string[]
  visibleDepartmentIds: string[]
  visibleAssigneeIds: string[]
  visibilityEnabled: boolean
  hiddenDepartmentIds: string[]
  hiddenAssigneeIds: string[]
  titleOverrides: NonNullable<CalendarEvent['titleOverrides']>
  note: string
  reminder: CalendarEvent['reminder']
  repeat: CalendarEvent['repeat']
  repeatCustom: NonNullable<CalendarEvent['repeatCustom']>
  todos: NonNullable<CalendarEvent['todos']>
  location: string
  url: string
  attachments: NonNullable<CalendarEvent['attachments']>
}
type DragActionMenu = {
  eventId: string
  targetDate: string
  x: number
  y: number
}
type DragPreviewState = {
  title: string
  x: number
  y: number
  width: number
  height: number
  color: string
}

const emptyCalendar = {
  name: '',
  color: COLORS[0],
  departmentIds: [] as string[],
  employeeIds: [] as string[],
  isCompanyWide: false
}

const emptyEvent: EventForm = {
  calendarId: '',
  calendarIds: [] as string[],
  title: '',
  date: dayjs().format('YYYY-MM-DD'),
  endDate: dayjs().format('YYYY-MM-DD'),
  startTime: '09:00',
  endTime: '10:00',
  allDay: false,
  departmentId: '',
  assigneeIds: [] as string[],
  visibleDepartmentIds: [] as string[],
  visibleAssigneeIds: [] as string[],
  visibilityEnabled: false,
  hiddenDepartmentIds: [] as string[],
  hiddenAssigneeIds: [] as string[],
  titleOverrides: [] as NonNullable<CalendarEvent['titleOverrides']>,
  note: '',
  reminder: 'none' as CalendarEvent['reminder'],
  repeat: 'none' as CalendarEvent['repeat'],
  repeatCustom: {
    interval: 1,
    frequency: 'day' as const,
    ends: 'never' as const,
    until: dayjs().add(1, 'month').format('YYYY-MM-DD'),
    count: 1
  },
  todos: [] as NonNullable<CalendarEvent['todos']>,
  location: '',
  url: '',
  attachments: [] as NonNullable<CalendarEvent['attachments']>
}

function toggle(list: string[], id: string) {
  return list.includes(id) ? list.filter((item) => item !== id) : [...list, id]
}

function salesDeliveryEventSyncFields(event: Pick<CalendarEvent, 'title' | 'date' | 'endDate' | 'startTime' | 'endTime' | 'allDay' | 'location'>) {
  return {
    title: event.title,
    date: event.date,
    endDate: event.endDate || event.date,
    startTime: event.startTime,
    endTime: event.endTime,
    allDay: event.allDay === true,
    location: event.location || '',
  }
}

type RelatedSalesDeliveryEventSyncInput = Pick<
  CalendarEvent,
  'title' | 'date' | 'startTime' | 'endTime' | 'calendarId' | 'departmentId' | 'assigneeIds'
> & Partial<Pick<
  CalendarEvent,
  'endDate' | 'allDay' | 'location' | 'calendarIds' | 'visibleDepartmentIds' | 'visibleAssigneeIds'
  | 'hiddenDepartmentIds' | 'hiddenAssigneeIds' | 'titleOverrides' | 'reminder' | 'url'
>>

function relatedSalesDeliveryEventSyncFields(event: RelatedSalesDeliveryEventSyncInput) {
  return {
    ...salesDeliveryEventSyncFields({
      ...event,
      startTime: event.allDay ? '' : event.startTime,
      endTime: event.allDay ? '' : event.endTime,
    }),
    calendarId: event.calendarId || '',
    calendarIds: event.calendarIds ?? [],
    departmentId: event.departmentId || '',
    assigneeIds: event.assigneeIds ?? [],
    visibleDepartmentIds: event.visibleDepartmentIds ?? [],
    visibleAssigneeIds: event.visibleAssigneeIds ?? [],
    hiddenDepartmentIds: event.hiddenDepartmentIds ?? [],
    hiddenAssigneeIds: event.hiddenAssigneeIds ?? [],
    titleOverrides: event.titleOverrides ?? [],
    reminder: event.reminder ?? 'none',
    url: event.url || '',
  }
}

function withoutSalesDeliveryEventSyncFields(payload: Record<string, unknown>) {
  const eventOnlyPayload = { ...payload }
  SALES_DELIVERY_EVENT_SYNC_FIELD_NAMES.forEach((field) => delete eventOnlyPayload[field])
  delete eventOnlyPayload.attachments
  return eventOnlyPayload
}

function titleWithoutKnownIcon(title: string, options: TitleIconOption[] = DEFAULT_TITLE_ICON_OPTIONS) {
  const trimmedTitle = title.trimStart()
  const option = options.find((item) => trimmedTitle.startsWith(item.icon))
  return option ? trimmedTitle.slice(option.icon.length).trimStart() : title
}

function selectedTitleIcon(title: string, options: TitleIconOption[] = DEFAULT_TITLE_ICON_OPTIONS) {
  const trimmedTitle = title.trimStart()
  return options.find((item) => trimmedTitle.startsWith(item.icon))?.icon ?? ''
}

function composeTitleWithIcon(icon: string, title: string, options: TitleIconOption[] = DEFAULT_TITLE_ICON_OPTIONS) {
  const cleanTitle = titleWithoutKnownIcon(title, options).trim()
  return `${icon}${cleanTitle ? ` ${cleanTitle}` : ''}`
}

function normalizeSearchText(text: string, options: TitleIconOption[] = DEFAULT_TITLE_ICON_OPTIONS) {
  return titleWithoutKnownIcon(text, options).trim().toLowerCase()
}

function normalizeDepartmentTitleIconDefaults(value: unknown) {
  const source = (value && typeof value === 'object') ? value as Record<string, unknown> : {}
  return Object.fromEntries(
    Object.entries(source)
      .map(([departmentId, icons]) => {
        const list = Array.isArray(icons) ? icons : [icons]
        return [
          departmentId,
          Array.from(new Set(list.map((icon) => String(icon || '').trim()).filter(Boolean)))
        ]
      })
      .filter(([, icons]) => icons.length)
  )
}

function eventEndDate(event: Pick<CalendarEvent, 'date' | 'endDate'>) {
  return event.endDate || event.date
}

function shiftedEventDateRange(event: Pick<CalendarEvent, 'date' | 'endDate'>, nextStartDate: string) {
  const sourceStart = dayjs(event.date)
  const sourceEnd = dayjs(eventEndDate(event))
  const targetStart = dayjs(nextStartDate)
  if (!sourceStart.isValid() || !sourceEnd.isValid() || !targetStart.isValid()) {
    return { date: nextStartDate, endDate: nextStartDate }
  }
  const durationDays = Math.max(0, sourceEnd.diff(sourceStart, 'day'))
  const nextEndDate = targetStart.add(durationDays, 'day').format('YYYY-MM-DD')
  return { date: nextStartDate, endDate: nextEndDate }
}

function dateRangeBetween(startDate: string, endDate: string) {
  const start = dayjs(startDate)
  const end = dayjs(endDate)
  if (!start.isValid() || !end.isValid()) return [startDate]
  const last = end.isBefore(start, 'day') ? start : end
  const days: string[] = []
  let cursor = start
  while (cursor.isSame(last, 'day') || cursor.isBefore(last, 'day')) {
    days.push(cursor.format('YYYY-MM-DD'))
    cursor = cursor.add(1, 'day')
  }
  return days
}

function shiftEventEndByStartChange(form: EventForm, nextDate: string, nextStartTime: string) {
  const currentStart = dayjs(`${form.date} ${form.startTime}`)
  let currentEnd = dayjs(`${form.endDate || form.date} ${form.endTime}`)
  const nextStart = dayjs(`${nextDate} ${nextStartTime}`)
  if (!currentStart.isValid() || !currentEnd.isValid() || !nextStart.isValid()) {
    return {
      date: nextDate,
      startTime: nextStartTime
    }
  }
  if (currentEnd.isBefore(currentStart)) currentEnd = currentEnd.add(1, 'day')
  const durationMinutes = Math.max(0, currentEnd.diff(currentStart, 'minute'))
  const nextEnd = nextStart.add(durationMinutes, 'minute')
  return {
    date: nextDate,
    startTime: nextStartTime,
    endDate: nextEnd.format('YYYY-MM-DD'),
    endTime: nextEnd.format('HH:mm')
  }
}

function compactText(text: string, limit = 18) {
  const compact = text.replace(/\s+/g, ' ').trim()
  return compact.length > limit ? `${compact.slice(0, limit)}...` : compact
}

function eventSuggestionMeta(event: CalendarEvent) {
  const parts = [event.date]
  if (event.location?.trim()) parts.push(compactText(event.location, 16))
  if (event.url?.trim()) {
    try {
      parts.push(new URL(event.url).hostname.replace(/^www\./, ''))
    } catch {
      parts.push(compactText(event.url, 16))
    }
  }
  if (event.note?.trim()) parts.push(compactText(event.note, 24))
  const todoTexts = (event.todos ?? []).map((todo) => todo.text.trim()).filter(Boolean)
  if (todoTexts.length) parts.push(todoTexts.slice(0, 2).map((text) => compactText(text, 10)).join('、'))
  return parts.join(' · ')
}

function mapsDestinationQuery(location: string) {
  const value = location.trim()
  const compact = value.replace(/\s+/g, '').replace(/１８２/g, '182')
  if (compact === '高雄市三民區民族一路182號') return '高雄市三民區正興里民族一路182號'
  return value
}

function googleMapsDirectionUrl(location: string) {
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(mapsDestinationQuery(location))}`
}

function googleMapsEmbedUrl(location: string) {
  return `https://www.google.com/maps?q=${encodeURIComponent(mapsDestinationQuery(location))}&output=embed`
}

function compareDayEvents(a: CalendarEvent, b: CalendarEvent) {
  if (!!a.allDay !== !!b.allDay) return a.allDay ? -1 : 1
  const timeCompare = (a.startTime || '').localeCompare(b.startTime || '')
  if (timeCompare !== 0) return timeCompare
  return (a.title || '').localeCompare(b.title || '', 'zh-Hant')
}

function reminderOffsetMinutes(reminder: CalendarEvent['reminder']) {
  if (reminder === '5m') return 5
  if (reminder === '15m') return 15
  if (reminder === '1h') return 60
  if (reminder === '1d') return 1440
  return 0
}

function employeeActiveForCalendar(employee: Employee) {
  const today = dayjs().format('YYYY-MM-DD')
  return employee.status !== 'inactive' && (!employee.resignDate || employee.resignDate > today)
}

function todayShiftTime(date: string, time: string, fallbackTime: string) {
  const value = dayjs(`${date} ${time || fallbackTime}`)
  return value.isValid() ? value : dayjs(`${date} ${fallbackTime}`)
}

function attachmentPreviewUrl(attachment: EventAttachment) {
  return attachmentThumbnailSources(attachment)[0] ?? ''
}

function attachmentFullImageUrl(attachment: EventAttachment) {
  if (attachment.lineOriginalUrl) return attachment.lineOriginalUrl
  if (attachment.provider === 'google-drive' && attachment.path) {
    return `https://drive.google.com/thumbnail?id=${encodeURIComponent(attachment.path)}&sz=w2400`
  }
  return attachment.url
}

function apiErrorMessage(error: ApiErrorPayload | undefined, fallback: string) {
  if (typeof error === 'string') return error || fallback
  return error?.message || fallback
}

function finitePaymentAmount(value: unknown) {
  const amount = Number(String(value ?? '').replaceAll(',', '').trim())
  return Number.isFinite(amount) ? Math.max(amount, 0) : 0
}

function normalizeFulfillmentPaymentPrompt(value: unknown): FulfillmentPaymentPrompt | undefined {
  if (!value || typeof value !== 'object') return undefined
  const source = value as Record<string, unknown>
  const paymentState = ['monthly', 'paid', 'unpaid', 'voided'].includes(String(source.paymentState))
    ? source.paymentState as FulfillmentPaymentPrompt['paymentState']
    : undefined
  const outstandingTotal = finitePaymentAmount(source.outstandingTotal ?? source.totalOutstanding)
  const currentOrderUnpaidAmount = finitePaymentAmount(
    source.currentOrderUnpaidAmount ?? source.currentSalesUnpaidAmount ?? source.defaultAmount
  )
  return {
    required: source.required === true && currentOrderUnpaidAmount > 0,
    paymentState,
    customerId: typeof source.customerId === 'string' ? source.customerId : undefined,
    customerCode: typeof source.customerCode === 'string' ? source.customerCode : undefined,
    customerName: typeof source.customerName === 'string' ? source.customerName : undefined,
    outstandingTotal,
    currentOrderUnpaidAmount,
    unpaidOrderCount: finitePaymentAmount(source.unpaidOrderCount) || undefined
  }
}

function fulfillmentShippingMethod(event: CalendarEvent, status: ProductionLineStatus | null) {
  const legacyNoteMethod = event.note.match(/(?:送貨|取件)方式[：:]\s*(外送|施工|活動)/)?.[1] || ''
  return (status?.shippingMethod || event.sourceShippingMethod || legacyNoteMethod).trim()
}

function isErpOrderFulfillmentEvent(event: CalendarEvent, status: ProductionLineStatus | null) {
  if (!isOperationalErpSalesDeliveryEvent(event)) return false
  const shippingMethod = fulfillmentShippingMethod(event, status)
  return shippingMethod === '外送' || shippingMethod === '施工' || shippingMethod === '活動'
}

function fulfillmentRetryForStatus(
  eventId: string,
  attachmentIds: string[],
  status: Pick<ProductionLineStatus, 'shippingMethod' | 'orderStatus'>,
): ProductionLineRetry {
  return {
    eventId,
    attachmentIds,
    mode: 'fulfillment',
    shippingMethod: String(status.shippingMethod || '').trim(),
    orderStatus: String(status.orderStatus || '').trim(),
  }
}

function erpSalesFormUrl(salesId: string) {
  return `${erpOrigin()}/sales/main/${encodeURIComponent(salesId)}/edit`
}

async function createSalesFormRedirectUrl(user: User, salesId: string): Promise<string> {
  const targetPath = `/sales/main/${encodeURIComponent(salesId)}/edit`
  const [token, appCheckHeaders] = await Promise.all([
    getFirebaseIdToken(user),
    getAppCheckHeaders(),
  ])
  const response = await fetch(`${erpOrigin()}/api/access-control`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...appCheckHeaders,
    },
    body: JSON.stringify({
      action: 'create-calendar-scan-ticket',
      targetPath,
    }),
  })
  const payload = await response.json().catch(() => ({})) as {
    redirectUrl?: unknown
    message?: unknown
  }
  if (!response.ok || typeof payload.redirectUrl !== 'string') {
    throw new Error(typeof payload.message === 'string' ? payload.message : '無法建立 ERP 登入接續。')
  }

  const redirectUrl = new URL(payload.redirectUrl)
  if (redirectUrl.origin !== new URL(erpOrigin()).origin || redirectUrl.pathname !== targetPath) {
    throw new Error('ERP 登入接續網址不正確。')
  }
  return redirectUrl.toString()
}

function eventDetailNoteContent(
  event: CalendarEvent,
  canOpenSalesForm: boolean,
  status: ProductionLineStatus | null,
  canViewPaymentStatus: boolean,
  statusLoading: boolean,
  statusError: string,
  onSalesFormClick: (clickEvent: ReactMouseEvent<HTMLAnchorElement>, salesId: string) => void,
): ReactNode {
  const note = event.source === 'erpSalesDelivery'
    ? (() => {
        const lines = event.note
          .split('\n')
          .filter((line) => !/^(?:送貨方式|地址|收貨時間|交易條件|付款狀態)[：:]/.test(line.trim()))
        let paymentStatus = ''
        if (canViewPaymentStatus) {
          if (statusLoading) paymentStatus = '查詢中'
          else if (statusError || !status?.paymentState) paymentStatus = '無法取得'
          else if (status.paymentState === 'monthly') paymentStatus = '月結'
          else if (status.paymentState === 'voided') paymentStatus = '作廢'
          else paymentStatus = [
            `本單未付 $${finitePaymentAmount(status.currentOrderUnpaidAmount).toLocaleString()}`,
            `累計未付 $${finitePaymentAmount(status.outstandingTotal).toLocaleString()}`,
          ].join('、')
        }
        if (paymentStatus) {
          const salesNoIndex = lines.findIndex((line) => /^銷售單號[：:]/.test(line.trim()))
          lines.splice(salesNoIndex >= 0 ? salesNoIndex + 1 : lines.length, 0, `付款狀態：${paymentStatus}`)
        }
        const mainNoteIndex = lines.findIndex((line) => /^主要備註[：:]/.test(line.trim()))
        const salesNoIndex = lines.findIndex((line) => /^銷售單號[：:]/.test(line.trim()))
        if (mainNoteIndex >= 0 && salesNoIndex >= 0) {
          const nextFieldOffset = lines.slice(mainNoteIndex + 1)
            .findIndex((line) => /^(?:銷售單號|付款狀態|收件人|電話|手機|備註)[：:]/.test(line.trim()))
          const count = nextFieldOffset < 0 ? lines.length - mainNoteIndex : nextFieldOffset + 1
          const mainNoteLines = lines.splice(mainNoteIndex, count)
          const anchorIndex = lines.findIndex((line) => /^銷售單號[：:]/.test(line.trim()))
          lines.splice(anchorIndex + 1, 0, ...mainNoteLines)
        }
        return lines.join('\n')
      })()
    : event.note
  const salesNo = event.sourceSalesNo?.trim() || status?.salesNo?.trim() || ''
  if (
    !canOpenSalesForm
    || event.source !== 'erpSalesDelivery'
    || !event.sourceId
    || !/^\d+$/.test(salesNo)
    || !note.includes(salesNo)
  ) return note

  return note.split(salesNo).flatMap((part, index, parts) => [
    part,
    ...(index < parts.length - 1 ? [(
      <a
        className="event-detail-sales-link"
        href={erpSalesFormUrl(event.sourceId as string)}
        target="_blank"
        rel="noreferrer"
        onClick={(clickEvent) => onSalesFormClick(clickEvent, event.sourceId as string)}
        key={`${salesNo}-${index}`}
      >
        {salesNo}
      </a>
    )] : [])
  ])
}

async function setLocalBadge(count: number) {
  const nav = navigator as Navigator & {
    setAppBadge?: (contents?: number) => Promise<void>
    clearAppBadge?: () => Promise<void>
  }
  try {
    if (count > 0 && nav.setAppBadge) await nav.setAppBadge(count)
    if (count <= 0 && nav.clearAppBadge) await nav.clearAppBadge()
  } catch {
    // Badge API 不支援時忽略，不影響通知功能。
  }
}

async function showLocalNotification(title: string, options: NotificationOptions) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return
  if (options.tag && wasNotificationTagSent(options.tag)) return
  if (options.tag) markNotificationTagSent(options.tag)
  if ('serviceWorker' in navigator) {
    try {
      const registration = await navigator.serviceWorker.ready
      await registration.showNotification(title, options)
      return
    } catch {
      // Service Worker 尚未就緒時改用一般瀏覽器通知。
    }
  }
  new Notification(title, options)
}

function readNotifiedTags() {
  try {
    const parsed = JSON.parse(localStorage.getItem(NOTIFIED_TAGS_KEY) || '{}') as Record<string, number>
    const now = Date.now()
    return Object.fromEntries(
      Object.entries(parsed).filter(([, time]) => typeof time === 'number' && now - time < NOTIFIED_TAG_RETENTION_MS)
    ) as Record<string, number>
  } catch {
    return {}
  }
}

function wasNotificationTagSent(tag: string) {
  return Boolean(readNotifiedTags()[tag])
}

function markNotificationTagSent(tag: string) {
  try {
    const tags = readNotifiedTags()
    tags[tag] = Date.now()
    localStorage.setItem(NOTIFIED_TAGS_KEY, JSON.stringify(tags))
  } catch {
    // 通知去重失敗不阻擋通知本身。
  }
}

function isHrReadonlyEvent(event: CalendarEvent) {
  return event.source === 'hrLeaveRequest' || event.source === 'hrHoliday' || event.source === 'hrTyphoonHoliday' || event.id.startsWith('hrLeaveRequest_') || event.id.startsWith('hrHoliday_') || event.id.startsWith('hrTyphoonHoliday_')
}

function isHrLeaveRequestEvent(event: CalendarEvent) {
  return event.source === 'hrLeaveRequest' || event.id.startsWith('hrLeaveRequest_')
}

function isHrPunchCorrectionEvent(event: CalendarEvent) {
  if (!isHrLeaveRequestEvent(event)) return false
  return event.title?.includes(HR_PUNCH_CORRECTION_LEAVE_TYPE) || event.note?.includes(HR_PUNCH_CORRECTION_LEAVE_TYPE)
}

function isHrHolidayEvent(event: CalendarEvent) {
  return event.source === 'hrHoliday' || event.source === 'hrTyphoonHoliday' || event.id.startsWith('hrHoliday_') || event.id.startsWith('hrTyphoonHoliday_')
}

function departmentCalendarId(departmentId: string) {
  return `${DEPARTMENT_CALENDAR_PREFIX}${departmentId}`
}

function departmentCalendarDocId(departmentId: string) {
  return `departmentCalendar_${departmentId}`
}

function departmentIdFromCalendarId(calendarId: string) {
  return calendarId.startsWith(DEPARTMENT_CALENDAR_PREFIX) ? calendarId.slice(DEPARTMENT_CALENDAR_PREFIX.length) : ''
}

function formatChineseDate(date: string) {
  const value = dayjs(date)
  return `${value.format('YYYY/M/D')} (${WEEKDAYS[value.day()]})`
}

function formatDateLabel(date: string) {
  const value = dayjs(date)
  return value.isValid() ? value.format('YYYY年M月D日') : ''
}

function firestoreDateIso(value: unknown, fallback = '') {
  if (typeof value === 'string') return value
  const timestamp = value as { toDate?: () => Date } | null
  if (timestamp && typeof timestamp.toDate === 'function') {
    const date = timestamp.toDate()
    if (!Number.isNaN(date.getTime())) return date.toISOString()
  }
  return fallback
}

function commentDateLabel(createdAt: string) {
  const value = dayjs(createdAt)
  if (!value.isValid()) return '日期不明'
  return `${value.format('YYYY年M月D日')}（${WEEKDAYS[value.day()]}）`
}

function commentTimeLabel(createdAt: string) {
  const value = dayjs(createdAt)
  return value.isValid() ? value.format('M月D日 HH:mm') : '時間不明'
}

function clipboardImageName(file: File, index: number) {
  const extensionByType: Record<string, string> = {
    'image/avif': 'avif',
    'image/gif': 'gif',
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp'
  }
  const extension = extensionByType[file.type] || file.name.match(/\.([a-z0-9]+)$/i)?.[1] || 'png'
  return `剪貼簿圖片-${dayjs().format('YYYYMMDD-HHmmss')}-${index + 1}.${extension}`
}

let fallbackClientIdCounter = 0

function createClientId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
  const randomValues = new Uint32Array(4)
  globalThis.crypto?.getRandomValues?.(randomValues)
  fallbackClientIdCounter += 1
  return `${Date.now().toString(36)}-${fallbackClientIdCounter.toString(36)}-${Array.from(randomValues).map((value) => value.toString(36)).join('')}`
}

function monthlyWeekdayLabel(date: string) {
  const value = dayjs(date)
  if (!value.isValid()) return '每月第幾個星期'
  return `每月第${Math.ceil(value.date() / 7)}星期${WEEKDAYS[value.day()]}`
}

function repeatPresetOptions(date: string) {
  const value = dayjs(date)
  const weekday = value.isValid() ? WEEKDAYS[value.day()] : ''
  const dayOfMonth = value.isValid() ? value.date() : ''
  return [
    { value: 'none', label: '無重複' },
    { value: 'daily', label: '每天' },
    { value: 'weekly', label: `每週星期${weekday || '-'}` },
    { value: 'weekdays', label: '每週平日（週一至週五）' },
    { value: 'monthlyNthWeekday', label: monthlyWeekdayLabel(date) },
    { value: 'monthlyDay', label: `每月${dayOfMonth || '-'}日` },
    { value: 'yearly', label: '每年' },
    { value: 'custom', label: '自訂' }
  ] as const
}

function customRepeatLabel(custom: CalendarEvent['repeatCustom']) {
  if (!custom) return '自訂'
  const frequencyLabel = { day: '天', week: '週', month: '月', year: '年' }[custom.frequency]
  const base = `每 ${Math.max(1, custom.interval || 1)} ${frequencyLabel}`
  if (custom.ends === 'until' && custom.until) return `${base}，直到 ${formatDateLabel(custom.until)}`
  if (custom.ends === 'count') return `${base}，${Math.max(1, custom.count || 1)} 次`
  return `${base}，無結束`
}

function repeatLabel(repeat: CalendarEvent['repeat'], date: string, custom?: CalendarEvent['repeatCustom']) {
  if (repeat === 'custom') return customRepeatLabel(custom)
  const normalizedRepeat = repeat === 'monthly' ? 'monthlyDay' : (repeat ?? 'none')
  return repeatPresetOptions(date).find((option) => option.value === normalizedRepeat)?.label ?? '無重複'
}

function isRepeatingEvent(event: CalendarEvent) {
  return Boolean(event.repeat && event.repeat !== 'none')
}

function recurrenceRootId(event: CalendarEvent) {
  return event.recurrenceParentId || event.id
}

function recurrenceSourceDate(event: CalendarEvent) {
  return event.recurrenceSourceDate || event.date
}

function isRecurrenceOccurrence(event: CalendarEvent) {
  return Boolean(event.recurrenceParentId)
}

function nthWeekdayDate(month: dayjs.Dayjs, sourceDate: dayjs.Dayjs) {
  const nth = Math.ceil(sourceDate.date() / 7)
  const weekday = sourceDate.day()
  let cursor = month.startOf('month')
  while (cursor.day() !== weekday) cursor = cursor.add(1, 'day')
  const candidate = cursor.add(nth - 1, 'week')
  return candidate.month() === month.month() ? candidate : null
}

function monthlyDayDate(month: dayjs.Dayjs, sourceDate: dayjs.Dayjs) {
  return month.date(Math.min(sourceDate.date(), month.daysInMonth()))
}

function addRepeatStep(current: dayjs.Dayjs, event: CalendarEvent) {
  const repeat = event.repeat === 'monthly' ? 'monthlyDay' : event.repeat
  if (repeat === 'daily') return current.add(1, 'day')
  if (repeat === 'weekly') return current.add(1, 'week')
  if (repeat === 'weekdays') {
    let next = current.add(1, 'day')
    while (next.day() === 0 || next.day() === 6) next = next.add(1, 'day')
    return next
  }
  if (repeat === 'monthlyDay') return monthlyDayDate(current.add(1, 'month').startOf('month'), dayjs(event.date))
  if (repeat === 'monthlyNthWeekday') return nthWeekdayDate(current.add(1, 'month').startOf('month'), dayjs(event.date)) ?? current.add(1, 'month')
  if (repeat === 'yearly') return current.add(1, 'year')
  if (repeat === 'custom') {
    const custom = event.repeatCustom ?? { interval: 1, frequency: 'day' as const, ends: 'never' as const }
    return current.add(Math.max(1, custom.interval || 1), custom.frequency)
  }
  return current.add(100, 'year')
}

function repeatEndLimit(event: CalendarEvent) {
  const dates = [event.repeatUntil]
  if (event.repeat === 'custom' && event.repeatCustom?.ends === 'until') dates.push(event.repeatCustom.until)
  const valid = dates
    .filter(Boolean)
    .map((date) => dayjs(date))
    .filter((date) => date.isValid())
    .sort((a, b) => a.valueOf() - b.valueOf())
  return valid[0] ?? null
}

function expandRecurringEvents(events: CalendarEvent[], startDate: string, endDate: string) {
  const rangeStart = dayjs(startDate)
  const rangeEnd = dayjs(endDate)
  const expanded: CalendarEvent[] = []
  events.forEach((event) => {
    if (!isRepeatingEvent(event)) {
      if (event.date <= endDate && eventEndDate(event) >= startDate) expanded.push(event)
      return
    }

    const sourceStart = dayjs(event.date)
    const sourceEnd = dayjs(eventEndDate(event))
    if (!sourceStart.isValid() || !sourceEnd.isValid()) return
    const durationDays = Math.max(0, sourceEnd.diff(sourceStart, 'day'))
    const endLimit = repeatEndLimit(event)
    const exceptions = new Set(event.repeatExceptions ?? [])
    const countLimit = event.repeat === 'custom' && event.repeatCustom?.ends === 'count'
      ? Math.max(1, event.repeatCustom.count || 1)
      : Infinity
    let cursor = sourceStart
    let count = 0
    let guard = 0

    while (guard < 1200 && count < countLimit) {
      guard += 1
      if (endLimit && cursor.isAfter(endLimit, 'day')) break
      if (cursor.isAfter(rangeEnd, 'day')) break
      const occurrenceDate = cursor.format('YYYY-MM-DD')
      if (!exceptions.has(occurrenceDate)) {
        count += 1
        const occurrenceEnd = cursor.add(durationDays, 'day').format('YYYY-MM-DD')
        if (occurrenceDate <= endDate && occurrenceEnd >= startDate) {
          expanded.push({
            ...event,
            id: occurrenceDate === event.date ? event.id : `${event.id}__repeat__${occurrenceDate}`,
            date: occurrenceDate,
            endDate: occurrenceEnd,
            recurrenceParentId: occurrenceDate === event.date ? undefined : event.id,
            recurrenceOriginalDate: event.date,
            recurrenceSourceDate: occurrenceDate
          })
        }
      }
      cursor = addRepeatStep(cursor, event)
    }
  })
  return expanded.sort(compareDayEvents)
}

function EventRowIcon({ name }: { name: EventEditorIcon }) {
  const paths: Record<EventEditorIcon, ReactNode> = {
    person: (
      <>
        <circle cx="12" cy="7.5" r="3.5" />
        <path d="M5 20c.8-3.6 3.2-5.4 7-5.4s6.2 1.8 7 5.4" />
      </>
    ),
    department: (
      <>
        <path d="M4 20h16" />
        <path d="M6 20V8l6-3 6 3v12" />
        <path d="M10 20v-5h4v5" />
        <path d="M9 10h.01M15 10h.01" />
      </>
    ),
    calendar: (
      <>
        <rect x="4" y="5" width="16" height="15" rx="2" />
        <path d="M8 3v4M16 3v4M4 10h16" />
      </>
    ),
    bell: (
      <>
        <path d="M6 17h12" />
        <path d="M8 17V10a4 4 0 0 1 8 0v7" />
        <path d="M10 20a2.2 2.2 0 0 0 4 0" />
      </>
    ),
    repeat: (
      <>
        <path d="M17 2.8 21 6.8l-4 4" />
        <path d="M3 11V9a2.2 2.2 0 0 1 2.2-2.2H21" />
        <path d="m7 21.2-4-4 4-4" />
        <path d="M21 13v2a2.2 2.2 0 0 1-2.2 2.2H3" />
      </>
    ),
    link: (
      <>
        <path d="M10 13.5a4 4 0 0 0 5.7 0l2.2-2.2a4 4 0 0 0-5.7-5.7l-1.2 1.2" />
        <path d="M14 10.5a4 4 0 0 0-5.7 0l-2.2 2.2a4 4 0 0 0 5.7 5.7l1.2-1.2" />
      </>
    ),
    location: (
      <>
        <path d="M19 10.2c0 5-7 10.8-7 10.8S5 15.2 5 10.2a7 7 0 0 1 14 0Z" />
        <circle cx="12" cy="10.2" r="2.3" />
      </>
    ),
    paperclip: (
      <path d="m21 11.5-8.4 8.4a5.2 5.2 0 0 1-7.4-7.4l9-9a3.5 3.5 0 0 1 5 5l-9 9a1.8 1.8 0 1 1-2.6-2.6l8.4-8.4" />
    ),
    note: (
      <>
        <rect x="5" y="4" width="14" height="16" rx="2" />
        <path d="M8 9h8M8 13h8M8 17h5" />
      </>
    ),
    check: (
      <>
        <path d="m4 12 4 4L20 6" />
        <path d="M4 19h16" />
      </>
    )
  }

  return (
    <span className="row-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" focusable="false">
        {paths[name]}
      </svg>
    </span>
  )
}

function TopbarIcon({ name }: { name: 'search' | 'bell' }) {
  return (
    <svg className="topbar-svg-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {name === 'search' ? (
        <>
          <circle cx="11" cy="11" r="6" />
          <path d="m16 16 4 4" />
        </>
      ) : (
        <>
          <path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
          <path d="M10 21a2.4 2.4 0 0 0 4 0" />
        </>
      )}
    </svg>
  )
}

function TimeInputIcon({ name }: { name: 'calendar' | 'clock' }) {
  return (
    <svg className="time-input-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {name === 'calendar' ? (
        <>
          <rect x="4" y="5" width="16" height="15" rx="2.5" />
          <path d="M8 3v4M16 3v4M4 10h16" />
        </>
      ) : (
        <>
          <circle cx="12" cy="12" r="8" />
          <path d="M12 8v4.4l3 1.8" />
        </>
      )}
    </svg>
  )
}

function openInputPicker(input: HTMLInputElement) {
  const pickerInput = input as HTMLInputElement & { showPicker?: () => void }
  pickerInput.showPicker?.()
}

function erpOrigin() {
  const { hostname, port, protocol } = window.location
  if (import.meta.env.DEV && port === '5175' && LOCAL_CALENDAR_HOSTS.has(hostname)) {
    return `${protocol}//${hostname}:5173`
  }
  return 'https://erp.city-painter.com'
}

export default function CalendarPage() {
  const queryClient = useQueryClient()
  const { user, role, employeeId, employeeDepartmentId, employeeDepartmentName, displayName, canOpenSalesForm, canScanSalesOrder, canViewSalesAttachments } = useAuth()
  const isAdmin = role === 'admin'
  const [month, setMonth] = useState(dayjs().startOf('month'))
  const [backgroundDataReady, setBackgroundDataReady] = useState(false)
  const { data: calendars = [], isLoading: calendarsLoading } = useCalendarGroups()
  const { data: events = [], isLoading: eventsLoading, isFetching: eventsFetching } = useCalendarEvents(month.format('YYYY-MM'))
  const { data: activityLogs = [] } = useCalendarActivityLogs(backgroundDataReady)
  const { data: employees = [] } = useEmployees()
  const { data: departments = [] } = useDepartments()
  const { data: shifts = [] } = useShifts(backgroundDataReady)

  const [selectedDate, setSelectedDate] = useState(dayjs().format('YYYY-MM-DD'))
  const [viewMode, setViewMode] = useState<ViewMode>('month')
  const [calendarSelectionMode, setCalendarSelectionMode] = useState<'all' | 'none' | 'custom'>('all')
  const [activeCalendarIds, setActiveCalendarIds] = useState<string[]>([])
  const [lastSelectedCalendarId, setLastSelectedCalendarId] = useState('')
  const [showCalendarDrawer, setShowCalendarDrawer] = useState(false)
  const [showSearchPanel, setShowSearchPanel] = useState(false)
  const [showNotificationsPanel, setShowNotificationsPanel] = useState(false)
  const [showAccountMenu, setShowAccountMenu] = useState(false)
  const [showStartupNotificationPrompt, setShowStartupNotificationPrompt] = useState(false)
  const [showNotificationSettings, setShowNotificationSettings] = useState(false)
  const [showPasswordModal, setShowPasswordModal] = useState(false)
  const [passwordForm, setPasswordForm] = useState({ next: '', confirm: '' })
  const [passwordError, setPasswordError] = useState('')
  const [passwordSuccess, setPasswordSuccess] = useState('')
  const [savingPassword, setSavingPassword] = useState(false)
  const [showErpOrderScanner, setShowErpOrderScanner] = useState(false)
  const [showTitleIconSettings, setShowTitleIconSettings] = useState(false)
  const [showTitleIconPicker, setShowTitleIconPicker] = useState(false)
  const [titleOverrideIconPickerIndex, setTitleOverrideIconPickerIndex] = useState<number | null>(null)
  const [showTitleSuggestions, setShowTitleSuggestions] = useState(false)
  const { data: searchIndexEvents = [], isFetching: searchIndexFetching } = useCalendarSearchEvents(showSearchPanel || showTitleSuggestions)
  const [showRepeatPicker, setShowRepeatPicker] = useState(false)
  const [showRepeatCustomModal, setShowRepeatCustomModal] = useState(false)
  const [dayListDate, setDayListDate] = useState<string | null>(null)
  const combinedDeliveryStatusCache = useMemo(() => createCombinedDeliveryStatusCache(), [user?.uid, role, employeeId, canScanSalesOrder])
  const combinedDeliveryScope = `${user?.uid || ''}:${role}:${employeeId}:${canScanSalesOrder}`
  const [combinedDelivery, setCombinedDelivery] = useState<{ events: CalendarEvent[]; files: File[]; requestId: string } | null>(null)
  const combinedDeliverySubmittingRef = useRef(false)
  const [selectedDeliveryGroupKey, setSelectedDeliveryGroupKey] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [activeSearchDepartmentIds, setActiveSearchDepartmentIds] = useState<string[]>([])
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission>(() => (
    'Notification' in window ? Notification.permission : 'denied'
  ))
  const [notificationSettings, setNotificationSettings] = useState<UserNotificationSettings>(DEFAULT_USER_NOTIFICATION_SETTINGS)
  const [savingNotificationSettings, setSavingNotificationSettings] = useState(false)
  const [titleIconOptions, setTitleIconOptions] = useState<TitleIconOption[]>(DEFAULT_TITLE_ICON_OPTIONS)
  const [titleIconDraft, setTitleIconDraft] = useState<TitleIconOption[]>(DEFAULT_TITLE_ICON_OPTIONS)
  const [departmentTitleIconDefaults, setDepartmentTitleIconDefaults] = useState<Record<string, string[]>>({})
  const [departmentTitleIconDraft, setDepartmentTitleIconDraft] = useState<Record<string, string[]>>({})
  const [savingTitleIcons, setSavingTitleIcons] = useState(false)
  const [lastSeenActivityAt, setLastSeenActivityAt] = useState(() => readBrowserValue(ACTIVITY_NOTIFICATION_SEEN_KEY) || '')
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null)
  const [selectedEventSnapshot, setSelectedEventSnapshot] = useState<CalendarEvent | null>(null)
  const [showRelatedEventsPanel, setShowRelatedEventsPanel] = useState(false)
  const [openingActivityEventId, setOpeningActivityEventId] = useState<string | null>(null)
  const [enlargedEventAttachment, setEnlargedEventAttachment] = useState<EventAttachment | null>(null)
  const [salesFormOpenError, setSalesFormOpenError] = useState('')
  const [monthDayEventRowLimit, setMonthDayEventRowLimit] = useState(DEFAULT_MONTH_DAY_EVENT_ROW_LIMIT)
  const [showEventActionMenu, setShowEventActionMenu] = useState(false)
  const [showCalendarModal, setShowCalendarModal] = useState(false)
  const [showEventModal, setShowEventModal] = useState(false)
  const [showVisibilityEditor, setShowVisibilityEditor] = useState(false)
  const [editingCalendarId, setEditingCalendarId] = useState<string | null>(null)
  const [editingEventId, setEditingEventId] = useState<string | null>(null)
  const [editingEventSnapshot, setEditingEventSnapshot] = useState<CalendarEvent | null>(null)
  const [copySourceEvent, setCopySourceEvent] = useState<CalendarEvent | null>(null)
  const [recurrenceEditMode, setRecurrenceEditMode] = useState<{ scope: RecurrenceEditScope, source: CalendarEvent } | null>(null)
  const [recurrenceEditCandidate, setRecurrenceEditCandidate] = useState<CalendarEvent | null>(null)
  const [recurrenceDeleteCandidate, setRecurrenceDeleteCandidate] = useState<CalendarEvent | null>(null)
  const [calendarForm, setCalendarForm] = useState(emptyCalendar)
  const [eventForm, setEventForm] = useState(emptyEvent)
  const [attachmentUploads, setAttachmentUploads] = useState<AttachmentUpload[]>([])
  const [deletedAttachments, setDeletedAttachments] = useState<EventAttachment[]>([])
  const [dragActionMenu, setDragActionMenu] = useState<DragActionMenu | null>(null)
  const [dragOverDate, setDragOverDate] = useState<string | null>(null)
  const [dragPreview, setDragPreview] = useState<DragPreviewState | null>(null)
  const [isTouchDevice, setIsTouchDevice] = useState(() => (
    window.matchMedia?.('(hover: none), (pointer: coarse)').matches ?? false
  ))
  const [calendarSwipeOffset, setCalendarSwipeOffset] = useState(0)
  const [calendarSwipeAnimating, setCalendarSwipeAnimating] = useState(false)
  const [dayListSwipeOffset, setDayListSwipeOffset] = useState(0)
  const [eventDetailSwipeOffset, setEventDetailSwipeOffset] = useState(0)
  const [eventEditorTouchLocked, setEventEditorTouchLocked] = useState(false)
  const [saving, setSaving] = useState(false)
  const [detailAttachmentUploading, setDetailAttachmentUploading] = useState(false)
  const [detailAttachmentUploadNotice, setDetailAttachmentUploadNotice] = useState<{ id: number; message: string } | null>(null)
  const [detailBackgroundUploads, setDetailBackgroundUploads] = useState<DetailBackgroundUpload[]>([])
  const [commentBackgroundUploads, setCommentBackgroundUploads] = useState<CommentBackgroundUpload[]>([])
  const [eventCommentsState, setEventCommentsState] = useState<EventCommentsState>({ cacheKey: '', rows: [] })
  const [eventCommentsErrorState, setEventCommentsErrorState] = useState<EventCommentsErrorState>({ cacheKey: '', message: '' })
  const [eventCommentsReloadKey, setEventCommentsReloadKey] = useState(0)
  const [commentDraft, setCommentDraft] = useState('')
  const [commentFiles, setCommentFiles] = useState<PendingCommentFile[]>([])
  const [commentSending, setCommentSending] = useState(false)
  const [deletingCommentId, setDeletingCommentId] = useState<string | null>(null)
  const [productionLineNotice, setProductionLineNotice] = useState<{ variant: 'success' | 'error' | 'muted'; message: string } | null>(null)
  const [productionLineRetry, setProductionLineRetry] = useState<ProductionLineRetry | null>(null)
  const [productionLineRetrying, setProductionLineRetrying] = useState(false)
  const [combinedPaymentEventIds, setCombinedPaymentEventIds] = useState<string[]>([])
  const [fulfillmentPaymentModal, setFulfillmentPaymentModal] = useState<FulfillmentPaymentModal | null>(null)
  const [fulfillmentPaymentAmount, setFulfillmentPaymentAmount] = useState('')
  const [fulfillmentPaymentSaving, setFulfillmentPaymentSaving] = useState(false)
  const [fulfillmentPaymentError, setFulfillmentPaymentError] = useState('')
  const noteTextareaRef = useRef<HTMLTextAreaElement | null>(null)
  const detailAttachmentInputRef = useRef<HTMLInputElement | null>(null)
  const salesFormRedirectPrefetchesRef = useRef(new Map<string, SalesFormRedirectPrefetch>())
  const backgroundAttachmentRecoveryIdsRef = useRef(new Set<string>())
  const durableUploadLoadedUidRef = useRef('')
  const detailBackgroundUploadsRef = useRef<DetailBackgroundUpload[]>([])
  const commentBackgroundUploadsRef = useRef<CommentBackgroundUpload[]>([])
  const commentAttachmentInputRef = useRef<HTMLInputElement | null>(null)
  const commentThreadEndRef = useRef<HTMLDivElement | null>(null)
  const activeCommentThreadIdRef = useRef('')
  const monthInputRef = useRef<HTMLInputElement | null>(null)
  const monthGridRef = useRef<HTMLDivElement | null>(null)
  const calendarSurfaceRef = useRef<HTMLElement | null>(null)
  const eventDetailReturnDayListDateRef = useRef<string | null>(null)
  const eventDragPreviewRef = useRef<HTMLDivElement | null>(null)
  const dragOverDateRef = useRef<string | null>(null)
  const dragPreviewFrameRef = useRef<number | null>(null)
  const dragPreviewPointRef = useRef<{ x: number; y: number } | null>(null)
  const calendarTouchStartRef = useRef<{ identifier: number; x: number; y: number; deltaX: number; deltaY: number; dragging: boolean } | null>(null)
  const monthLongPressRef = useRef<{ identifier: number; x: number; y: number; timer: number; triggered: boolean; date: string; shouldOpenAdd: boolean } | null>(null)
  const eventEditorTouchLockTimerRef = useRef<number | null>(null)
  const bottomSystemGestureUntilRef = useRef(0)
  const suppressEventClickRef = useRef(false)
  const lastEventPointerTypeRef = useRef('')
  const pointerDragRef = useRef<{
    eventId: string
    startX: number
    startY: number
    moved: boolean
  } | null>(null)
  const dayListTouchDragRef = useRef<{
    eventId: string
    pointerId: number
    startX: number
    startY: number
    latestX: number
    latestY: number
    timer: number
    active: boolean
    dragging: boolean
    title: string
    width: number
    height: number
    color: string
    sourceElement: HTMLElement | null
  } | null>(null)
  const dayListSwipeRef = useRef<{
    identifier: number
    startX: number
    startY: number
    dragging: boolean
    enabled: boolean
  } | null>(null)
  const eventDetailSwipeRef = useRef<{
    identifier: number
    startX: number
    startY: number
    dragging: boolean
    enabled: boolean
  } | null>(null)
  const seenActivityLogIdsRef = useRef<Set<string> | null>(null)
  const titleIconDragIndexRef = useRef<number | null>(null)
  const canceledAttachmentUploadIdsRef = useRef<Set<string>>(new Set())

  const currentEmployee = employees.find((emp) => emp.id === employeeId)
  const currentEmployeeDepartmentId = currentEmployee?.departmentId || employeeDepartmentId || departments.find((department) => department.name === (currentEmployee?.departmentName || employeeDepartmentName))?.id || ''
  const currentEmployeeDepartmentName = currentEmployee?.departmentName || employeeDepartmentName || departments.find((department) => department.id === currentEmployeeDepartmentId)?.name || ''
  const canManageCalendarColors = currentEmployeeDepartmentName === '管理部'
  const canViewHrLeaveNote = isAdmin || currentEmployeeDepartmentName === '管理部'
  const currentShift = shifts.find((shift) => (
    Boolean(currentEmployee?.shiftId && shift.id === currentEmployee.shiftId) ||
    Boolean(currentEmployee?.shiftName && shift.name === currentEmployee.shiftName)
  ))

  const departmentCalendarSettingsMap = useMemo(() => (
    new Map(calendars.map((calendar) => [calendar.id, calendar]))
  ), [calendars])

  const departmentCalendars = useMemo<DisplayCalendar[]>(() => (
    [...departments]
      .map((department, index) => {
        const setting = departmentCalendarSettingsMap.get(departmentCalendarDocId(department.id))
        return {
          id: departmentCalendarId(department.id),
          name: department.name,
          color: setting?.color || COLORS[index % COLORS.length],
          departmentIds: [department.id],
          employeeIds: employees
            .filter((employee) => employeeActiveForCalendar(employee))
            .filter((employee) => employee.departmentId === department.id || employee.departmentName === department.name)
            .map((employee) => employee.id),
          isCompanyWide: false,
          systemKind: 'department'
        }
      })
  ), [departmentCalendarSettingsMap, departments, employees])

  const hrLeaveCalendar = useMemo<DisplayCalendar | null>(() => {
    const calendar = calendars.find((item) => item.name.trim() === HR_LEAVE_CALENDAR_NAME)
    if (!calendar) return null
    return { ...calendar, systemKind: 'hrLeave' }
  }, [calendars])

  const visibleCalendars = useMemo<DisplayCalendar[]>(() => {
    const isManagementMember = isAdmin || currentEmployeeDepartmentName === '管理部'
    const departmentList = departmentCalendars.filter((calendar) => (
      isManagementMember || calendar.name !== '管理部'
    ))

    return hrLeaveCalendar ? [...departmentList, hrLeaveCalendar] : departmentList
  }, [currentEmployeeDepartmentName, departmentCalendars, hrLeaveCalendar, isAdmin])

  const visibleCalendarIds = useMemo(
    () => visibleCalendars.map((calendar) => calendar.id),
    [visibleCalendars]
  )
  const activeVisibleCalendarIds = useMemo(
    () => activeCalendarIds.filter((id) => visibleCalendarIds.includes(id)),
    [activeCalendarIds, visibleCalendarIds]
  )
  const selectedCalendarIds = useMemo(() => (
    calendarSelectionMode === 'all'
      ? visibleCalendarIds
      : calendarSelectionMode === 'none'
        ? []
        : activeVisibleCalendarIds
  ), [activeVisibleCalendarIds, calendarSelectionMode, visibleCalendarIds])
  const allCalendarsSelected = selectedCalendarIds.length === visibleCalendarIds.length
  const visibleCalendarMap = useMemo(() => new Map(visibleCalendars.map((calendar) => [calendar.id, calendar])), [visibleCalendars])
  const writableCalendars = visibleCalendars.filter((calendar) => calendar.systemKind !== 'hrLeave')
  const canCreateEvent = writableCalendars.length > 0
  const searchDepartmentOptions = useMemo(() => {
    const visibleDepartmentIds = new Set(
      visibleCalendars
        .filter((calendar) => calendar.systemKind === 'department')
        .flatMap((calendar) => calendar.departmentIds)
    )
    return departments.filter((department) => visibleDepartmentIds.has(department.id))
  }, [departments, visibleCalendars])
  const searchDepartmentIds = searchDepartmentOptions.map((department) => department.id)
  const activeVisibleSearchDepartmentIds = activeSearchDepartmentIds.filter((id) => searchDepartmentIds.includes(id))
  const selectedSearchDepartmentIds = activeVisibleSearchDepartmentIds.length > 0 ? activeVisibleSearchDepartmentIds : searchDepartmentIds
  const hasCustomSearchDepartmentFilter = activeVisibleSearchDepartmentIds.length > 0
  const allSearchDepartmentsSelected = selectedSearchDepartmentIds.length === searchDepartmentIds.length

  const visibleSourceEvents = useMemo(() => {
    return events.filter((event) => {
      if (isHrPunchCorrectionEvent(event)) return false
      if (!eventAllowedForViewer(event)) return false
      const eventCalendarIds = eventDisplayCalendarIds(event)
      const eventCalendars = eventCalendarIds.map((id) => visibleCalendarMap.get(id)).filter(Boolean) as DisplayCalendar[]
      if (!eventCalendars.length) return Boolean(employeeId && (event.assigneeIds?.includes(employeeId) || eventVisibilityTargetAppliesToViewer(event) || eventTitleOverrideAppliesToViewer(event)))
      if (!eventCalendars.some((calendar) => selectedCalendarIds.includes(calendar.id))) return false
      return true
    })
  }, [currentEmployeeDepartmentId, currentEmployeeDepartmentName, employeeId, events, selectedCalendarIds, visibleCalendarMap, departments, employees, hrLeaveCalendar])

  const visibleEvents = useMemo(() => {
    const rangeStart = month.subtract(2, 'month').startOf('month').format('YYYY-MM-DD')
    const rangeEnd = month.add(2, 'month').endOf('month').format('YYYY-MM-DD')
    return expandRecurringEvents(visibleSourceEvents, rangeStart, rangeEnd)
  }, [month, visibleSourceEvents])

  const visibleSearchEvents = useMemo(() => {
    const map = new Map<string, CalendarEvent>()
    searchIndexEvents.forEach((event) => map.set(event.id, event))
    events.forEach((event) => map.set(event.id, event))
    return Array.from(map.values())
      .filter((event) => {
        if (isHrPunchCorrectionEvent(event)) return false
        if (!eventAllowedForViewer(event)) return false
        const eventCalendarIds = eventDisplayCalendarIds(event)
        const eventCalendars = eventCalendarIds.map((id) => visibleCalendarMap.get(id)).filter(Boolean) as DisplayCalendar[]
        if (!eventCalendars.length) return Boolean(employeeId && (event.assigneeIds?.includes(employeeId) || eventVisibilityTargetAppliesToViewer(event) || eventTitleOverrideAppliesToViewer(event)))
        return eventCalendars.some((calendar) => selectedCalendarIds.includes(calendar.id))
      })
      .sort((a, b) => `${b.date} ${b.startTime}`.localeCompare(`${a.date} ${a.startTime}`))
  }, [currentEmployeeDepartmentId, currentEmployeeDepartmentName, employeeId, events, searchIndexEvents, selectedCalendarIds, visibleCalendarMap, departments, employees, hrLeaveCalendar])

  const searchEvents = useMemo(() => {
    const keyword = searchQuery.trim().toLowerCase()
    return visibleSearchEvents.filter((event) => {
      if (hasCustomSearchDepartmentFilter && event.departmentId && !selectedSearchDepartmentIds.includes(event.departmentId)) return false
      if (hasCustomSearchDepartmentFilter && !event.departmentId) return false
      if (!keyword) return true
      const searchable = [
        eventDisplayTitle(event),
        event.note ?? '',
        event.location ?? ''
      ].join(' ').toLowerCase()
      return searchable.includes(keyword)
    })
  }, [employees, hasCustomSearchDepartmentFilter, searchQuery, selectedSearchDepartmentIds, visibleSearchEvents])

  const eventsByDate = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>()
    visibleEvents.forEach((event) => {
      dateRangeBetween(event.date, eventEndDate(event)).forEach((date) => {
        const list = map.get(date) ?? []
        list.push(event)
        map.set(date, list)
      })
    })
    map.forEach((list, date) => list.sort((a, b) => compareDayEventsForCalendarDate(a, b, date)))
    return map
  }, [visibleEvents])

  const displayItemsByDate = useMemo(() => {
    const map = new Map<string, CalendarDayDisplayItem[]>()
    eventsByDate.forEach((dayEvents, date) => {
      map.set(date, groupCalendarDayEvents(dayEvents))
    })
    return map
  }, [eventsByDate])

  const deliveryGroupsByKey = useMemo(() => {
    const map = new Map<string, CalendarDayDisplayItem>()
    displayItemsByDate.forEach((items) => {
      items.forEach((item) => {
        if (item.isDeliveryGroup) map.set(item.key, item)
      })
    })
    return map
  }, [displayItemsByDate])

  const selectedDeliveryGroup = selectedDeliveryGroupKey
    ? deliveryGroupsByKey.get(selectedDeliveryGroupKey) ?? null
    : null

  const deliveryStatusPrefetchEvents = useMemo(() => {
    const today = dayjs().format('YYYY-MM-DD')
    return [...deliveryGroupsByKey.values()]
      .sort((a, b) => Math.abs(dayjs(a.primaryEvent.date).diff(dayjs(today), 'day')) - Math.abs(dayjs(b.primaryEvent.date).diff(dayjs(today), 'day')))
      .flatMap((group) => group.events)
      .filter((event, index, rows) => event.sourceShippingMethod === '外送' && !isCalendarEventCompleted(event) && rows.findIndex((row) => row.id === event.id) === index)
      .slice(0, 20)
  }, [deliveryGroupsByKey])

  useEffect(() => {
    if (!user || !deliveryStatusPrefetchEvents.length) return
    const timer = window.setTimeout(() => { void loadCombinedDeliveryStatuses(deliveryStatusPrefetchEvents) }, 0)
    return () => window.clearTimeout(timer)
  }, [combinedDeliveryStatusCache, deliveryStatusPrefetchEvents])

  const combinedDeliveryEvents = useMemo(() => combinedDelivery?.events.map((event) => (
    visibleEvents.find((current) => current.id === event.id) || event
  )) || [], [combinedDelivery, visibleEvents])

  function canReceiveActivityLog(log: CalendarActivityLog) {
    const assigneeIds = log.assigneeIds ?? []
    return Boolean(employeeId && assigneeIds.includes(employeeId))
  }

  const visibleActivityLogs = useMemo(() => (
    activityLogs
      .filter((log) => selectedCalendarIds.includes(log.calendarId) || canReceiveActivityLog(log))
  ), [activityLogs, employeeId, selectedCalendarIds])
  const pushActivityLogs = useMemo(() => (
    visibleActivityLogs.filter(canReceiveActivityLog)
  ), [employeeId, visibleActivityLogs])
  const unreadActivityCount = useMemo(() => (
    pushActivityLogs.filter((log) => log.createdAt && log.createdAt > lastSeenActivityAt).length
  ), [lastSeenActivityAt, pushActivityLogs])

  const hasTodayLeave = useMemo(() => {
    if (!employeeId) return false
    const today = dayjs().format('YYYY-MM-DD')
    return events.some((event) => (
      isHrReadonlyEvent(event) &&
      !isHrPunchCorrectionEvent(event) &&
      event.assigneeIds?.includes(employeeId) &&
      dateRangeBetween(event.date, eventEndDate(event)).includes(today)
    ))
  }, [employeeId, events])

  const canSendCalendarNotificationAt = useCallback((time: dayjs.Dayjs) => {
    if (!employeeId || !currentShift || hasTodayLeave) return false
    const date = time.format('YYYY-MM-DD')
    const shiftStart = todayShiftTime(date, currentShift.startTime, '09:00')
    let shiftEnd = todayShiftTime(date, currentShift.endTime, '18:00')
    if (shiftEnd.isBefore(shiftStart)) shiftEnd = shiftEnd.add(1, 'day')
    const isDuringShift = (time.isSame(shiftStart) || time.isAfter(shiftStart)) && time.isBefore(shiftEnd)
    const isAfterShift = time.isSame(shiftEnd) || time.isAfter(shiftEnd)
    return (notificationSettings.shiftStartEnabled && isDuringShift) || (notificationSettings.shiftEndEnabled && isAfterShift)
  }, [currentShift, employeeId, hasTodayLeave, notificationSettings.shiftEndEnabled, notificationSettings.shiftStartEnabled])

  useEffect(() => {
    if (!backgroundDataReady) return
    if (!user?.uid) {
      setNotificationSettings(DEFAULT_USER_NOTIFICATION_SETTINGS)
      return
    }
    const uid = user.uid
    let cancelled = false
    async function loadNotificationSettings() {
      try {
        const snap = await getDoc(doc(db, 'calendarNotificationSettings', uid))
        const employeeSnap = !snap.exists() && employeeId
          ? await getDoc(doc(db, 'calendarNotificationSettings', employeeId))
          : null
        if (cancelled) return
        setNotificationSettings({
          ...DEFAULT_USER_NOTIFICATION_SETTINGS,
          ...(snap.exists() ? snap.data() : employeeSnap?.exists() ? employeeSnap.data() : {})
        } as UserNotificationSettings)
      } catch {
        if (!cancelled) setNotificationSettings(DEFAULT_USER_NOTIFICATION_SETTINGS)
      }
    }
    void loadNotificationSettings()
    return () => {
      cancelled = true
    }
  }, [backgroundDataReady, employeeId, user?.uid])

  useEffect(() => {
    if (!backgroundDataReady) return
    if (!user?.uid || !('Notification' in window) || Notification.permission === 'granted') return
    setShowStartupNotificationPrompt(true)
  }, [backgroundDataReady, user?.uid])

  useEffect(() => {
    if (!backgroundDataReady || !user?.uid || notificationPermission !== 'granted' || !isPushSupported()) return
    void ensurePushSubscription({ role, employeeId, displayName })
  }, [backgroundDataReady, displayName, employeeId, notificationPermission, role, user?.uid])

  useEffect(() => {
    if (!backgroundDataReady) return
    let cancelled = false
    async function loadTitleIconOptions() {
      try {
        const snap = await getDoc(doc(db, 'calendarSettings', 'titleIcons'))
        const data = snap.exists() ? snap.data() : {}
        const options = data.options as TitleIconOption[] | undefined
        const cleanOptions = (options ?? DEFAULT_TITLE_ICON_OPTIONS)
          .map((item) => ({ icon: String(item.icon || '').trim(), label: String(item.label || '').trim() }))
          .filter((item) => item.icon && item.label)
        if (cancelled) return
        const nextOptions = cleanOptions.length ? cleanOptions : DEFAULT_TITLE_ICON_OPTIONS
        const nextDepartmentDefaults = normalizeDepartmentTitleIconDefaults(data.departmentDefaults)
        setTitleIconOptions(nextOptions)
        setTitleIconDraft(nextOptions)
        setDepartmentTitleIconDefaults(nextDepartmentDefaults)
        setDepartmentTitleIconDraft(nextDepartmentDefaults)
      } catch {
        if (!cancelled) {
          setTitleIconOptions(DEFAULT_TITLE_ICON_OPTIONS)
          setTitleIconDraft(DEFAULT_TITLE_ICON_OPTIONS)
          setDepartmentTitleIconDefaults({})
          setDepartmentTitleIconDraft({})
        }
      }
    }
    void loadTitleIconOptions()
    return () => {
      cancelled = true
    }
  }, [backgroundDataReady])

  useEffect(() => {
    if (!backgroundDataReady) return
    if (!('Notification' in window) || Notification.permission !== 'granted') return
    const timers = visibleEvents.flatMap((event) => {
      if (!event.reminder || event.reminder === 'none') return []
      if (!employeeId || !event.assigneeIds?.includes(employeeId)) return []
      const eventTime = event.allDay ? dayjs(event.date).startOf('day') : dayjs(`${event.date} ${event.startTime}`)
      const notifyTime = eventTime.subtract(reminderOffsetMinutes(event.reminder), 'minute')
      const delay = notifyTime.diff(dayjs())
      if (delay <= 0 || delay > 2147483647) return []
      const timer = window.setTimeout(() => {
        if (!canSendCalendarNotificationAt(dayjs())) return
        void showLocalNotification(eventDisplayTitle(event), {
          body: `${formatChineseDate(event.date)} ${event.allDay ? '整天' : event.startTime}${event.location ? ` · ${event.location}` : ''}`,
          tag: `calendar-reminder-${event.id}-${notifyTime.valueOf()}`,
          icon: '/pwa-192x192.png',
          badge: '/pwa-192x192.png',
          data: { url: '/' }
        })
      }, delay)
      return [timer]
    })
    return () => timers.forEach((timer) => window.clearTimeout(timer))
  }, [backgroundDataReady, canSendCalendarNotificationAt, employeeId, visibleEvents])

  useEffect(() => {
    if (!backgroundDataReady) return
    void setLocalBadge(unreadActivityCount)
  }, [backgroundDataReady, unreadActivityCount])

  useEffect(() => {
    if (!backgroundDataReady) return
    const currentIds = new Set(pushActivityLogs.map((log) => log.id))
    if (!seenActivityLogIdsRef.current && pushActivityLogs.length === 0) return
    if (!seenActivityLogIdsRef.current) {
      seenActivityLogIdsRef.current = currentIds
      return
    }

    const addedLogs = pushActivityLogs
      .filter((log) => !seenActivityLogIdsRef.current?.has(log.id))
      .filter((log) => log.actorUid !== user?.uid)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    seenActivityLogIdsRef.current = currentIds

    if (notificationPermission !== 'granted' || !canSendCalendarNotificationAt(dayjs())) return
    addedLogs.slice(-3).forEach((log) => {
      void showLocalNotification('行事曆通知', {
        body: activityLogText(log),
        tag: `calendar-activity-${log.id}`,
        icon: '/pwa-192x192.png',
        badge: '/pwa-192x192.png',
        data: { url: '/' }
      })
    })
  }, [backgroundDataReady, canSendCalendarNotificationAt, notificationPermission, pushActivityLogs, user?.uid])

  useEffect(() => {
    const textarea = noteTextareaRef.current
    if (!textarea || !showEventModal) return
    textarea.style.height = 'auto'
    textarea.style.height = `${textarea.scrollHeight}px`
  }, [eventForm.note, showEventModal])

  function shouldKeepOverlayOpenForSystemGesture(event: MouseEvent | TouchEvent | ReactMouseEvent | ReactTouchEvent) {
    const nativeEvent = 'nativeEvent' in event ? event.nativeEvent : event
    const bottomThreshold = Math.max(0, window.innerHeight - 42)
    const touchSource = ('changedTouches' in nativeEvent && nativeEvent.changedTouches)
      ? nativeEvent.changedTouches
      : ('touches' in nativeEvent && nativeEvent.touches)
        ? nativeEvent.touches
        : null
    const touches = touchSource ? Array.from(touchSource as TouchList) : []
    if (touches.some((touch) => touch.clientY >= bottomThreshold)) {
      bottomSystemGestureUntilRef.current = Date.now() + 1200
      return true
    }
    if ('clientY' in nativeEvent && Date.now() < bottomSystemGestureUntilRef.current) {
      return nativeEvent.clientY >= window.innerHeight - 96
    }
    return false
  }

  function rememberOverlaySystemGesture(event: ReactTouchEvent) {
    shouldKeepOverlayOpenForSystemGesture(event)
  }

  useEffect(() => {
    if (!dragActionMenu) return

    function closeMenu(event: MouseEvent | TouchEvent) {
      if (shouldKeepOverlayOpenForSystemGesture(event)) return
      const target = event.target
      if (target instanceof Element && target.closest('.event-drag-menu')) return
      setDragActionMenu(null)
      setDragOverDateIfChanged(null)
    }

    function closeMenuWithEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setDragActionMenu(null)
        setDragOverDateIfChanged(null)
      }
    }

    document.addEventListener('mousedown', closeMenu)
    document.addEventListener('touchstart', closeMenu)
    document.addEventListener('keydown', closeMenuWithEscape)
    return () => {
      document.removeEventListener('mousedown', closeMenu)
      document.removeEventListener('touchstart', closeMenu)
      document.removeEventListener('keydown', closeMenuWithEscape)
    }
  }, [dragActionMenu])

  useEffect(() => () => {
    resetDayListTouchDrag()
    if (eventEditorTouchLockTimerRef.current !== null) {
      window.clearTimeout(eventEditorTouchLockTimerRef.current)
    }
  }, [])

  useEffect(() => {
    if (dayListDate || showRelatedEventsPanel) return
    dayListSwipeRef.current = null
    setDayListSwipeOffset(0)
  }, [dayListDate, showRelatedEventsPanel])

  useEffect(() => {
    setEnlargedEventAttachment(null)
    if (selectedEventId) return
    eventDetailSwipeRef.current = null
    setEventDetailSwipeOffset(0)
  }, [selectedEventId])

  useEffect(() => {
    if (!enlargedEventAttachment) return

    function closeAttachmentPreviewWithEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setEnlargedEventAttachment(null)
    }

    document.addEventListener('keydown', closeAttachmentPreviewWithEscape)
    return () => document.removeEventListener('keydown', closeAttachmentPreviewWithEscape)
  }, [enlargedEventAttachment])

  useEffect(() => {
    if (!dayListDate) return

    function closeDayList(event: MouseEvent | TouchEvent) {
      if (shouldKeepOverlayOpenForSystemGesture(event)) return
      const target = event.target
      if (target instanceof Element && target.closest('.tt-day-list-panel, .more-pill')) return
      setDayListDate(null)
    }

    function closeDayListWithEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setDayListDate(null)
    }

    document.addEventListener('mousedown', closeDayList)
    document.addEventListener('touchstart', closeDayList)
    document.addEventListener('keydown', closeDayListWithEscape)
    return () => {
      document.removeEventListener('mousedown', closeDayList)
      document.removeEventListener('touchstart', closeDayList)
      document.removeEventListener('keydown', closeDayListWithEscape)
    }
  }, [dayListDate])

  useEffect(() => {
    if (!selectedDeliveryGroupKey) return
    if (!selectedDeliveryGroup) {
      setSelectedDeliveryGroupKey(null)
      return
    }

    function closeDeliveryGroup(event: MouseEvent | TouchEvent) {
      if (shouldKeepOverlayOpenForSystemGesture(event)) return
      const target = event.target
      if (target instanceof Element && target.closest('.delivery-group-panel')) return
      setSelectedDeliveryGroupKey(null)
    }

    function closeDeliveryGroupWithEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setSelectedDeliveryGroupKey(null)
    }

    document.addEventListener('mousedown', closeDeliveryGroup)
    document.addEventListener('touchstart', closeDeliveryGroup)
    document.addEventListener('keydown', closeDeliveryGroupWithEscape)
    return () => {
      document.removeEventListener('mousedown', closeDeliveryGroup)
      document.removeEventListener('touchstart', closeDeliveryGroup)
      document.removeEventListener('keydown', closeDeliveryGroupWithEscape)
    }
  }, [selectedDeliveryGroup, selectedDeliveryGroupKey])

  useEffect(() => {
    if (!showCalendarDrawer) return

    function closeCalendarDrawer(event: MouseEvent | TouchEvent) {
      if (shouldKeepOverlayOpenForSystemGesture(event)) return
      const target = event.target
      if (target instanceof Element && target.closest('.tt-calendar-drawer, .tt-left-rail')) return
      setShowCalendarDrawer(false)
    }

    function closeCalendarDrawerWithEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setShowCalendarDrawer(false)
    }

    document.addEventListener('mousedown', closeCalendarDrawer)
    document.addEventListener('touchstart', closeCalendarDrawer)
    document.addEventListener('keydown', closeCalendarDrawerWithEscape)
    return () => {
      document.removeEventListener('mousedown', closeCalendarDrawer)
      document.removeEventListener('touchstart', closeCalendarDrawer)
      document.removeEventListener('keydown', closeCalendarDrawerWithEscape)
    }
  }, [showCalendarDrawer])

  useEffect(() => {
    if (!selectedEventId || showEventModal) return

    function closeEventDetail(event: MouseEvent | TouchEvent) {
      if (shouldKeepOverlayOpenForSystemGesture(event)) return
      const target = event.target
      if (target instanceof Element && target.closest('.event-detail-panel, .event-pill, .event-line, .week-event, .fulfillment-payment-overlay, .event-attachment-lightbox-overlay, .related-events-overlay')) return
      setSelectedEventId(null)
      setShowEventActionMenu(false)
    }

    function closeEventDetailWithEscape(event: KeyboardEvent) {
      if (event.key === 'Escape' && showRelatedEventsPanel) {
        event.preventDefault()
        event.stopImmediatePropagation()
        setShowRelatedEventsPanel(false)
        return
      }
      if (event.key === 'Escape' && !fulfillmentPaymentModal && !enlargedEventAttachment) setSelectedEventId(null)
    }

    document.addEventListener('mousedown', closeEventDetail)
    document.addEventListener('touchstart', closeEventDetail)
    document.addEventListener('keydown', closeEventDetailWithEscape)
    return () => {
      document.removeEventListener('mousedown', closeEventDetail)
      document.removeEventListener('touchstart', closeEventDetail)
      document.removeEventListener('keydown', closeEventDetailWithEscape)
    }
  }, [selectedEventId, showEventModal, showRelatedEventsPanel, fulfillmentPaymentModal, enlargedEventAttachment])

  useEffect(() => {
    if (!showEventActionMenu) return

    function closeEventActionMenu(event: MouseEvent | TouchEvent) {
      if (shouldKeepOverlayOpenForSystemGesture(event)) return
      const target = event.target
      if (target instanceof Element && target.closest('.event-detail-action-wrap')) return
      setShowEventActionMenu(false)
    }

    function closeEventActionMenuWithEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setShowEventActionMenu(false)
    }

    document.addEventListener('mousedown', closeEventActionMenu)
    document.addEventListener('touchstart', closeEventActionMenu)
    document.addEventListener('keydown', closeEventActionMenuWithEscape)
    return () => {
      document.removeEventListener('mousedown', closeEventActionMenu)
      document.removeEventListener('touchstart', closeEventActionMenu)
      document.removeEventListener('keydown', closeEventActionMenuWithEscape)
    }
  }, [showEventActionMenu])

  useEffect(() => {
    if (!showSearchPanel && !showNotificationsPanel) return

    function closeTopbarPanels(event: MouseEvent | TouchEvent) {
      if (shouldKeepOverlayOpenForSystemGesture(event)) return
      const target = event.target
      if (target instanceof Element && target.closest('.tt-search-panel, .tt-notifications-panel, .topbar-panel-trigger, .tt-account-menu, .tt-avatar')) return
      if (showNotificationsPanel) markActivityNotificationsSeen()
      setShowSearchPanel(false)
      setShowNotificationsPanel(false)
    }

    function closeTopbarPanelsWithEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      if (showNotificationsPanel) markActivityNotificationsSeen()
      setShowSearchPanel(false)
      setShowNotificationsPanel(false)
    }

    document.addEventListener('mousedown', closeTopbarPanels)
    document.addEventListener('touchstart', closeTopbarPanels)
    document.addEventListener('keydown', closeTopbarPanelsWithEscape)
    return () => {
      document.removeEventListener('mousedown', closeTopbarPanels)
      document.removeEventListener('touchstart', closeTopbarPanels)
      document.removeEventListener('keydown', closeTopbarPanelsWithEscape)
    }
  }, [showSearchPanel, showNotificationsPanel])

  useEffect(() => {
    if (!showAccountMenu) return

    function closeAccountMenu(event: MouseEvent | TouchEvent) {
      if (shouldKeepOverlayOpenForSystemGesture(event)) return
      const target = event.target
      if (target instanceof Element && target.closest('.tt-account-menu, .tt-avatar')) return
      setShowAccountMenu(false)
    }

    function closeAccountMenuWithEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      setShowAccountMenu(false)
    }

    document.addEventListener('mousedown', closeAccountMenu)
    document.addEventListener('touchstart', closeAccountMenu)
    document.addEventListener('keydown', closeAccountMenuWithEscape)
    return () => {
      document.removeEventListener('mousedown', closeAccountMenu)
      document.removeEventListener('touchstart', closeAccountMenu)
      document.removeEventListener('keydown', closeAccountMenuWithEscape)
    }
  }, [showAccountMenu])

  useEffect(() => {
    if (!showTitleIconPicker && titleOverrideIconPickerIndex === null) return

    function closeTitleIconPicker(event: MouseEvent | TouchEvent) {
      if (shouldKeepOverlayOpenForSystemGesture(event)) return
      const target = event.target
      if (target instanceof Element && target.closest('.title-icon-picker, .title-override-icon-picker')) return
      setShowTitleIconPicker(false)
      setTitleOverrideIconPickerIndex(null)
    }

    function closeTitleIconPickerWithEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      setShowTitleIconPicker(false)
      setTitleOverrideIconPickerIndex(null)
    }

    document.addEventListener('mousedown', closeTitleIconPicker)
    document.addEventListener('touchstart', closeTitleIconPicker)
    document.addEventListener('keydown', closeTitleIconPickerWithEscape)
    return () => {
      document.removeEventListener('mousedown', closeTitleIconPicker)
      document.removeEventListener('touchstart', closeTitleIconPicker)
      document.removeEventListener('keydown', closeTitleIconPickerWithEscape)
    }
  }, [showTitleIconPicker, titleOverrideIconPickerIndex])

  useEffect(() => {
    if (!showTitleSuggestions) return

    function closeTitleSuggestions(event: MouseEvent | TouchEvent) {
      if (shouldKeepOverlayOpenForSystemGesture(event)) return
      const target = event.target
      if (target instanceof Element && target.closest('.event-title-row')) return
      setShowTitleSuggestions(false)
    }

    function closeTitleSuggestionsWithEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setShowTitleSuggestions(false)
    }

    document.addEventListener('mousedown', closeTitleSuggestions)
    document.addEventListener('touchstart', closeTitleSuggestions)
    document.addEventListener('keydown', closeTitleSuggestionsWithEscape)
    return () => {
      document.removeEventListener('mousedown', closeTitleSuggestions)
      document.removeEventListener('touchstart', closeTitleSuggestions)
      document.removeEventListener('keydown', closeTitleSuggestionsWithEscape)
    }
  }, [showTitleSuggestions])

  const swipeMonthSets = useMemo(() => (
    [-1, 0, 1].map((offset) => {
      const displayMonth = month.add(offset, 'month')
      const start = displayMonth.startOf('month').startOf('week')
      return {
        key: displayMonth.format('YYYY-MM'),
        displayMonth,
        days: Array.from({ length: 42 }, (_, index) => start.add(index, 'day'))
      }
    })
  ), [month])

  const swipeWeekSets = useMemo(() => (
    [-1, 0, 1].map((offset) => {
      const start = dayjs(selectedDate).startOf('week').add(offset, 'week')
      return {
        key: start.format('YYYY-MM-DD'),
        days: Array.from({ length: 7 }, (_, index) => start.add(index, 'day'))
      }
    })
  ), [selectedDate])

  const weekDays = useMemo(() => {
    const start = dayjs(selectedDate).startOf('week')
    return Array.from({ length: 7 }, (_, index) => start.add(index, 'day'))
  }, [selectedDate])

  const selectedEventRecord = useMemo(() => {
    if (!selectedEventId) return null
    return visibleEvents.find((event) => event.id === selectedEventId) ??
      visibleSearchEvents.find((event) => event.id === selectedEventId) ??
      (selectedEventSnapshot?.id === selectedEventId ? selectedEventSnapshot : null) ??
      null
  }, [selectedEventId, selectedEventSnapshot, visibleEvents, visibleSearchEvents])
  const teardownPrimaryEventId = isErpSalesWorkScheduleEvent(selectedEventRecord)
    ? erpSalesDeliveryPrimaryEventId(selectedEventRecord) : ''
  const teardownPrimaryEventQuery = useQuery({
    queryKey: ['calendar-teardown-primary', user?.uid ?? '', teardownPrimaryEventId],
    enabled: Boolean(teardownPrimaryEventId && user?.uid),
    queryFn: async () => {
      const snapshot = await getCalendarEventSnapshot(teardownPrimaryEventId)
      if (!snapshot.exists()) throw new Error('找不到排程所關聯的主事件')
      const event = { id: snapshot.id, ...snapshot.data() } as CalendarEvent
      if (!eventAllowedForViewer(event) || !isPrimaryErpSalesDeliveryEvent(event)
        || event.sourceId !== selectedEventRecord?.sourceId) throw new Error('無法讀取排程所關聯的主事件')
      return event
    },
    staleTime: 60 * 1000,
  })
  const teardownPrimaryEvent = teardownPrimaryEventId
    ? visibleEvents.find((event) => event.id === teardownPrimaryEventId)
      ?? teardownPrimaryEventQuery.data ?? null
    : null
  const selectedEvent = useMemo(() => selectedEventRecord
    ? resolveTeardownDetailEvent(selectedEventRecord, teardownPrimaryEvent) : null,
  [selectedEventRecord, teardownPrimaryEvent])
  const selectedOperationalEvent = selectedEvent
  const salesDeliveryRelationIndexQuery = useQuery({
    queryKey: ['erp-sales-delivery-relation-index', user?.uid ?? ''],
    enabled: Boolean(user?.uid && backgroundDataReady),
    queryFn: fetchErpSalesDeliveryRelationIndex,
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  })
  const selectedSalesRelationSourceId = isErpSalesDeliveryEvent(selectedEvent)
    ? selectedEvent?.sourceId?.trim() || ''
    : ''
  const [liveSalesRelations, setLiveSalesRelations] = useState<{
    sourceId: string
    events: CalendarEvent[]
    loading: boolean
    error: boolean
  }>({ sourceId: '', events: [], loading: true, error: false })
  const [salesRelationsRetry, setSalesRelationsRetry] = useState(0)
  useEffect(() => {
    if (!selectedEventId || !selectedSalesRelationSourceId || !user?.uid) return
    const sourceId = selectedSalesRelationSourceId
    setLiveSalesRelations({ sourceId, events: [], loading: true, error: false })
    let cancelled = false
    let refreshing = false
    let refreshAgain = false
    const refresh = async () => {
      if (refreshing) { refreshAgain = true; return }
      refreshing = true
      try {
        const events = await fetchCalendarData<CalendarEvent>('source', { sourceId })
        if (!cancelled) setLiveSalesRelations({ sourceId, events, loading: false, error: false })
      } catch {
        if (!cancelled) setLiveSalesRelations({ sourceId, events: [], loading: false, error: true })
      } finally {
        refreshing = false
        if (refreshAgain && !cancelled) { refreshAgain = false; void refresh() }
      }
    }
    void refresh()
    const timer = window.setInterval(refresh, 60000)
    window.addEventListener('calendar-data-revision', refresh)
    window.addEventListener('focus', refresh)
    return () => { cancelled = true; window.clearInterval(timer); window.removeEventListener('calendar-data-revision', refresh); window.removeEventListener('focus', refresh) }

  }, [Boolean(selectedEventId), selectedSalesRelationSourceId, user?.uid, salesRelationsRetry])
  const relatedSalesDeliveryEventsQuery = {
    isLoading: liveSalesRelations.sourceId !== selectedSalesRelationSourceId || liveSalesRelations.loading,
    isError: liveSalesRelations.sourceId === selectedSalesRelationSourceId && liveSalesRelations.error,
    refetch: () => setSalesRelationsRetry((value) => value + 1),
  }
  const relatedSalesDeliveryEvents = liveSalesRelations.sourceId === selectedSalesRelationSourceId
    ? liveSalesRelations.events.filter((event) => isErpSalesDeliveryEvent(event)
      && event.sourceId === selectedSalesRelationSourceId && eventAllowedForViewer(event))
      .sort((a, b) => Number(isRelatedErpSalesDeliveryEvent(a)) - Number(isRelatedErpSalesDeliveryEvent(b))
        || `${a.date} ${a.startTime}`.localeCompare(`${b.date} ${b.startTime}`))
    : []
  const hasRelatedSalesDeliveryEvents = relatedSalesDeliveryEventsQuery.isLoading
    ? Boolean(selectedSalesRelationSourceId && salesDeliveryRelationIndexQuery.data?.[selectedSalesRelationSourceId])
    : relatedSalesDeliveryEvents.some(isRelatedErpSalesDeliveryEvent)
  const salesOperationalEventId = isErpSalesWorkScheduleEvent(selectedEvent)
    ? selectedEvent?.id ?? '' : erpSalesDeliveryPrimaryEventId(selectedEvent)
  const canViewSalesOperationalPayment = Boolean(selectedEvent && (
    canManageCalendarEvent(selectedEvent)
    || (canScanSalesOrder && Boolean(selectedOperationalEvent && isErpOrderFulfillmentEvent(selectedOperationalEvent, null)))
  ))
  const {
    status: productionLineStatus,
    loading: productionLineStatusLoading,
    error: productionLineStatusError,
    setStatus: setProductionLineStatus,
  } = useSalesOperationalStatus({
    user,
    eventId: salesOperationalEventId,
    enabled: Boolean(user?.uid && salesOperationalEventId),
    canViewPayment: canViewSalesOperationalPayment,
  })
  const salesAttachmentEventId = isErpSalesDeliveryEvent(selectedEvent) && canViewSalesAttachments
    ? erpSalesDeliveryPrimaryEventId(selectedEvent)
    : ''
  const salesCenterAttachmentsQuery = useQuery({
    queryKey: ['sales-center-attachments', user?.uid ?? '', salesAttachmentEventId],
    enabled: Boolean(user?.uid && salesAttachmentEventId),
    queryFn: () => fetchSalesCenterAttachments(salesAttachmentEventId),
    staleTime: 7 * 60 * 1000,
    gcTime: 9 * 60 * 1000,
    refetchInterval: SALES_ATTACHMENT_URL_REFRESH_INTERVAL_MS,
    refetchOnWindowFocus: 'always',
    refetchOnReconnect: 'always',
    retry: 1,
  })
  const salesCenterAttachments = salesCenterAttachmentsQuery.data ?? []
  const salesCenterAttachmentsAvailable = salesCenterAttachmentsQuery.data !== undefined
  const salesCenterAttachmentsLoading = Boolean(
    salesAttachmentEventId && salesCenterAttachmentsQuery.isFetching && !salesCenterAttachmentsQuery.data
  )
  const salesCenterAttachmentsError = salesCenterAttachmentsQuery.isError
    ? firebaseRequestErrorMessage(
        salesCenterAttachmentsQuery.error,
        salesCenterAttachmentsQuery.error instanceof Error
          ? salesCenterAttachmentsQuery.error.message
          : '附件中心讀取失敗',
      )
    : ''
  const combinedEventDetailAttachments = useMemo(() => {
    const attachments = resolveEventDetailAttachments({
      eventSource: selectedEvent?.source,
      eventAttachments: selectedEvent?.attachments ?? [],
      salesAttachments: salesCenterAttachments,
      salesSourceAvailable: salesCenterAttachmentsAvailable,
    })
    return sortAttachmentsNewestFirst(attachments)
  }, [salesCenterAttachments, salesCenterAttachmentsAvailable, selectedEvent?.attachments, selectedEvent?.source])
  const selectedEventBackgroundUploadRows = useMemo(
    () => detailBackgroundUploads.filter((upload) => upload.eventId === selectedOperationalEvent?.id),
    [detailBackgroundUploads, selectedOperationalEvent?.id],
  )
  const selectedEventBackgroundUploads = useMemo(
    () => sortAttachmentsNewestFirst([
      ...selectedEventBackgroundUploadRows.filter((upload) => upload.status !== 'failed'),
      ...hideCompletedBackgroundUploadPreviews(
        selectedEventBackgroundUploadRows.filter((upload) => upload.status === 'failed'),
        combinedEventDetailAttachments,
      ),
    ]),
    [combinedEventDetailAttachments, selectedEventBackgroundUploadRows],
  )
  const eventDetailAttachments = useMemo(
    () => hideRemoteAttachmentsUsingLocalPreviews(
      combinedEventDetailAttachments,
      selectedEventBackgroundUploads.filter((upload) => upload.status !== 'failed'),
    ),
    [combinedEventDetailAttachments, selectedEventBackgroundUploads],
  )
  const eventDetailImageAttachments = useMemo(
    () => eventDetailAttachments.filter((attachment) => Boolean(attachmentPreviewUrl(attachment))),
    [eventDetailAttachments],
  )
  const unsafeActiveBackgroundUploads = useMemo(
    () => [...detailBackgroundUploads, ...commentBackgroundUploads].filter(blocksBackgroundAttachmentUnload),
    [commentBackgroundUploads, detailBackgroundUploads],
  )
  useEffect(() => {
    if (
      !backgroundDataReady
      || eventsLoading
      || eventsFetching
      || !user?.uid
      || !canViewSalesAttachments
      || shouldSkipSalesAttachmentPrefetch()
    ) return

    const today = dayjs().startOf('day')
    const finalDate = today.add(SALES_ATTACHMENT_PREFETCH_DAYS - 1, 'day').format('YYYY-MM-DD')
    const eventIds = Array.from(new Set(
      visibleEvents
        .filter((event) => isErpSalesDeliveryEvent(event) && event.date >= today.format('YYYY-MM-DD') && event.date <= finalDate)
        .sort((a, b) => `${a.date} ${a.startTime}`.localeCompare(`${b.date} ${b.startTime}`))
        .map((event) => erpSalesDeliveryPrimaryEventId(event))
    )).slice(0, SALES_ATTACHMENT_PREFETCH_EVENT_LIMIT)
    if (!eventIds.length) return

    let cancelled = false
    let idleCallback: number | undefined
    const preload = async () => {
      for (const eventId of eventIds) {
        if (cancelled) return
        try {
          const attachments = await queryClient.fetchQuery({
            queryKey: ['sales-center-attachments', user.uid, eventId],
            queryFn: () => fetchSalesCenterAttachments(eventId),
            staleTime: 7 * 60 * 1000,
            gcTime: 9 * 60 * 1000,
            retry: 0,
          })
          if (cancelled) return
          const firstPreview = attachments.map(attachmentPreviewUrl).find(Boolean)
          if (firstPreview) await preloadSalesAttachmentPreview(firstPreview)
        } catch {
          // 背景預載失敗不應干擾行事曆操作，點開事件時仍會依原流程重試。
        }
      }
    }
    const timer = window.setTimeout(() => {
      const run = () => void preload()
      idleCallback = window.requestIdleCallback?.(run, { timeout: 3000 })
      if (!idleCallback) run()
    }, SALES_ATTACHMENT_PREFETCH_DELAY_MS)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
      if (idleCallback) window.cancelIdleCallback?.(idleCallback)
    }
  }, [backgroundDataReady, canViewSalesAttachments, eventsFetching, eventsLoading, queryClient, user?.uid, visibleEvents])

  const commentThreadId = selectedEvent
    ? erpSalesDeliveryPrimaryEventId(selectedEvent) || recurrenceRootId(selectedEvent)
    : ''
  const eventCommentsCacheKey = user?.uid && commentThreadId ? `${user.uid}:${commentThreadId}` : ''
  const cachedEventComments = eventCommentsCacheKey
    ? eventCommentsMemoryCache.get(eventCommentsCacheKey)
    : undefined
  const eventComments = eventCommentsState.cacheKey === eventCommentsCacheKey
    ? eventCommentsState.rows
    : cachedEventComments ?? []
  const eventCommentsReady = eventCommentsState.cacheKey === eventCommentsCacheKey
    || cachedEventComments !== undefined
  const eventCommentsError = eventCommentsErrorState.cacheKey === eventCommentsCacheKey
    ? eventCommentsErrorState.message
    : ''
  const groupedEventComments = useMemo(() => {
    const groups: { key: string, label: string, comments: CalendarEventComment[] }[] = []
    eventComments.forEach((comment) => {
      const value = dayjs(comment.createdAt)
      const key = value.isValid() ? value.format('YYYY-MM-DD') : 'unknown'
      const current = groups[groups.length - 1]
      if (current?.key === key) {
        current.comments.push(comment)
        return
      }
      groups.push({ key, label: commentDateLabel(comment.createdAt), comments: [comment] })
    })
    return groups
  }, [eventComments])
  const loading = calendarsLoading || eventsLoading

  const prepareSalesFormRedirect = useCallback((salesId: string): Promise<string> => {
    if (!user) return Promise.reject(new Error('登入已失效，請重新登入行事曆。'))
    const now = Date.now()
    const prefetches = salesFormRedirectPrefetchesRef.current
    for (const [cachedSalesId, cachedEntry] of prefetches) {
      if (now - cachedEntry.createdAt >= SALES_FORM_REDIRECT_REUSE_MS) prefetches.delete(cachedSalesId)
    }
    const cached = prefetches.get(salesId)
    if (cached) {
      return cached.promise
    }

    const prepared: SalesFormRedirectPrefetch = {
      salesId,
      createdAt: Date.now(),
      redirectUrl: '',
      promise: Promise.resolve(''),
    }
    prepared.promise = createSalesFormRedirectUrl(user, salesId).then((redirectUrl) => {
      if (prefetches.get(salesId) === prepared) prepared.redirectUrl = redirectUrl
      return redirectUrl
    }).catch((error) => {
      if (prefetches.get(salesId) === prepared) prefetches.delete(salesId)
      throw error
    })
    prefetches.set(salesId, prepared)
    while (prefetches.size > SALES_FORM_REDIRECT_CACHE_LIMIT) {
      const oldestSalesId = prefetches.keys().next().value
      if (!oldestSalesId) break
      prefetches.delete(oldestSalesId)
    }
    return prepared.promise
  }, [user])

  useEffect(() => {
    activeCommentThreadIdRef.current = commentThreadId
    setCommentDraft('')
    setCommentFiles([])
    setDeletingCommentId(null)
  }, [commentThreadId])

  useEffect(() => {
    setShowRelatedEventsPanel(false)
  }, [selectedEventId])

  useEffect(() => {
    setSalesFormOpenError('')
    const salesId = selectedEvent?.source === 'erpSalesDelivery' && canOpenSalesForm
      ? selectedEvent.sourceId?.trim() || ''
      : ''
    if (!salesId || !user) return

    const preconnect = document.createElement('link')
    preconnect.rel = 'preconnect'
    preconnect.href = erpOrigin()
    preconnect.crossOrigin = 'anonymous'
    document.head.append(preconnect)
    const prefetch = document.createElement('link')
    prefetch.rel = 'prefetch'
    prefetch.as = 'document'
    prefetch.href = erpSalesFormUrl(salesId)
    document.head.append(prefetch)
    void prepareSalesFormRedirect(salesId).catch(() => undefined)
    return () => {
      preconnect.remove()
      prefetch.remove()
    }
  }, [canOpenSalesForm, prepareSalesFormRedirect, selectedEvent?.id, selectedEvent?.source, selectedEvent?.sourceId, user])

  useEffect(() => {
    if (!commentThreadId || !eventCommentsCacheKey) return

    const cachedRows = eventCommentsMemoryCache.get(eventCommentsCacheKey)
    if (cachedRows) setEventCommentsState({ cacheKey: eventCommentsCacheKey, rows: cachedRows })
    setEventCommentsErrorState({ cacheKey: eventCommentsCacheKey, message: '' })

    let cancelled = false
    let refreshing = false
    let refreshAgain = false
    const refresh = async () => {
      if (refreshing) { refreshAgain = true; return }
      refreshing = true
      try {
        const rows = await fetchCalendarData<CalendarEventComment>('comments', { eventId: commentThreadId })
        rows.sort((a, b) => `${a.createdAt}-${a.id}`.localeCompare(`${b.createdAt}-${b.id}`))
        if (cancelled) return
        cacheEventComments(eventCommentsCacheKey, rows)
        setEventCommentsState({ cacheKey: eventCommentsCacheKey, rows })
        setEventCommentsErrorState({ cacheKey: eventCommentsCacheKey, message: '' })
      } catch {
        if (!cancelled) setEventCommentsErrorState({ cacheKey: eventCommentsCacheKey, message: '留言載入失敗，請稍後重試' })
      } finally {
        refreshing = false
        if (refreshAgain && !cancelled) { refreshAgain = false; void refresh() }
      }
    }
    void refresh()
    const timer = window.setInterval(refresh, 60000)
    window.addEventListener('calendar-data-revision', refresh)
    window.addEventListener('focus', refresh)
    return () => { cancelled = true; window.clearInterval(timer); window.removeEventListener('focus', refresh); window.removeEventListener('calendar-data-revision', refresh) }

  }, [commentThreadId, eventCommentsCacheKey, eventCommentsReloadKey])

  useEffect(() => {
    const remoteByCommentId = new Map(eventComments.map((comment) => [comment.id, comment.attachments]))
    const matched = commentBackgroundUploads.flatMap((upload) => {
      const attachment = (remoteByCommentId.get(upload.commentId) ?? []).find((item) => (
        Boolean(upload.jobId && item.uploadJobId === upload.jobId)
        || Boolean(upload.attachmentPath && item.path === upload.attachmentPath)
      ))
      const previewUrl = attachment ? attachmentPreviewUrl(attachment) : ''
      return attachment && previewUrl ? [{ upload, previewUrl }] : []
    })
    if (matched.length === 0) return
    let canceled = false
    void Promise.all(matched.map(async ({ upload, previewUrl }) => (
      await loadCommentAttachmentPreview(previewUrl) ? upload.id : ''
    ))).then((loadedIds) => {
      if (canceled) return
      const completedIds = new Set(loadedIds.filter(Boolean))
      if (completedIds.size === 0) return
      setCommentBackgroundUploads((items) => items.filter((item) => {
        if (!completedIds.has(item.id)) return true
        URL.revokeObjectURL(item.previewUrl)
        return false
      }))
    })
    return () => { canceled = true }
  }, [commentBackgroundUploads, eventComments])

  useEffect(() => {
    setFulfillmentPaymentModal(null)
    setFulfillmentPaymentAmount('')
    setFulfillmentPaymentSaving(false)
    setFulfillmentPaymentError('')
    setProductionLineNotice(null)
    setProductionLineRetry(null)
    const selectedEvent = selectedOperationalEvent
    if (!selectedEvent || !isOperationalErpSalesDeliveryEvent(selectedEvent) || !user?.uid) return

    const storedRetry = selectedEvent.productionLineRetry
    if (!storedRetry) return
    let active = true
    const eventId = selectedEvent.id
    void (async () => {
      try {
        const liveStatus = await fetchProductionLineStatus(eventId)
        if (!active) return
        setProductionLineStatus(liveStatus)
        const decision = fulfillmentRetryDecision(storedRetry, liveStatus)
        if (decision.action === 'clear') {
          await updateDoc(doc(db, 'calendarEvents', eventId), { productionLineRetry: deleteField() })
          return
        }
        if (decision.action !== 'allow') return
        setProductionLineRetry({
          eventId,
          mode: 'fulfillment',
          attachmentIds: decision.attachmentIds,
          shippingMethod: String(storedRetry.shippingMethod || '').trim(),
          orderStatus: String(storedRetry.orderStatus || '').trim(),
          fulfillmentOrders: storedRetry.fulfillmentOrders,
          fulfillmentRequestId: storedRetry.fulfillmentRequestId,
          fulfillmentSourceEventId: storedRetry.fulfillmentSourceEventId,
        })
        setProductionLineNotice({
          variant: 'error',
          message: storedRetry.message || '照片已保留，訂單完成尚待重試。'
        })
      } catch (error) {
        console.warn('[calendar] 重試前訂單狀態核對失敗', error)
      }
    })()
    return () => { active = false }
  }, [selectedOperationalEvent?.id, selectedOperationalEvent?.productionLineRetry?.updatedAt, selectedOperationalEvent?.source, user?.uid])

  useEffect(() => {
    if (unsafeActiveBackgroundUploads.length === 0) return
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warnBeforeUnload)
    return () => window.removeEventListener('beforeunload', warnBeforeUnload)
  }, [unsafeActiveBackgroundUploads.length])

  useEffect(() => {
    if (!detailAttachmentUploadNotice) return
    const timer = window.setTimeout(() => setDetailAttachmentUploadNotice(null), 3000)
    return () => window.clearTimeout(timer)
  }, [detailAttachmentUploadNotice])

  useEffect(() => {
    if (!user?.uid) {
      durableUploadLoadedUidRef.current = ''
      return
    }
    if (durableUploadLoadedUidRef.current === user.uid) return
    durableUploadLoadedUidRef.current = user.uid
    let canceled = false
    void (async () => {
      try {
        const rows = await loadDurableBackgroundAttachmentUploads(user.uid)
        if (canceled || rows.length === 0) return
        const eventRows = rows.filter((row) => (row.uploadKind ?? 'event') === 'event')
        const commentRows = rows.filter((row) => row.uploadKind === 'comment' && row.commentId)
        setDetailBackgroundUploads((items) => {
          const existingIds = new Set(items.map((item) => item.id))
          return [
            ...items,
            ...eventRows.filter((row) => !existingIds.has(row.id)).map((row) => ({
              id: row.id,
              fulfillmentRequestId: row.fulfillmentRequestId,
              jobId: row.jobId || row.attachment?.uploadJobId,
              attachmentPath: row.attachment?.path,
              eventId: row.eventId,
              name: row.name,
              previewUrl: URL.createObjectURL(row.blob),
              status: row.cloudSafe ? row.status : 'queued' as const,
              progress: row.progress,
              cloudSafe: row.cloudSafe,
              createdAt: row.createdAt,
              error: row.error,
            })),
          ]
        })
        setCommentBackgroundUploads((items) => {
          const existingIds = new Set(items.map((item) => item.id))
          return [
            ...items,
            ...commentRows.filter((row) => !existingIds.has(row.id)).map((row) => ({
              id: row.id,
              jobId: row.jobId || row.attachment?.uploadJobId,
              attachmentPath: row.attachment?.path,
              eventId: row.eventId,
              commentId: row.commentId as string,
              name: row.name,
              previewUrl: URL.createObjectURL(row.blob),
              status: row.cloudSafe ? row.status : 'queued' as const,
              progress: row.progress,
              cloudSafe: row.cloudSafe,
              createdAt: row.createdAt,
              error: row.error,
            })),
          ]
        })
        await Promise.all([
          processDurableBackgroundUploads(eventRows),
          processCommentBackgroundUploads(commentRows),
        ])
      } catch (error) {
        console.warn('[calendar] 離線照片佇列恢復失敗', error)
      }
    })()
    return () => { canceled = true }
  }, [user?.uid])

  useEffect(() => {
    if (!user?.uid) return
    const recoveries = loadBackgroundAttachmentRecoveries().filter((recovery) => (
      recovery.completionMode !== 'fulfillment'
      &&
      !backgroundAttachmentRecoveryIdsRef.current.has(recovery.jobId)
    ))
    const groups = new Map<string, typeof recoveries>()
    recoveries.forEach((recovery) => {
      backgroundAttachmentRecoveryIdsRef.current.add(recovery.jobId)
      const key = `${recovery.eventId}:${recovery.completionMode}`
      groups.set(key, [...(groups.get(key) ?? []), recovery])
    })
    groups.forEach((group) => {
      void (async () => {
        try {
          const results = await Promise.all(group.map(async (recovery) => {
            try {
              return await resumeBackgroundAttachmentUpload(recovery)
            } catch (error) {
              console.warn('[calendar] 背景照片工作恢復失敗', recovery.jobId, error)
              return null
            }
          }))
          const completed = results.filter((result): result is NonNullable<typeof result> => Boolean(result))
          if (completed.length > 0) {
            await finishBackgroundDetailAttachments(
              group[0].eventId,
              completed.map((result) => result.attachment),
              group[0].completionMode,
            )
            await invalidateSalesCenterAttachments(group[0].eventId)
          }
        } finally {
          group.forEach((recovery) => backgroundAttachmentRecoveryIdsRef.current.delete(recovery.jobId))
        }
      })()
    })
  }, [queryClient, user?.uid])

  useEffect(() => {
    detailBackgroundUploadsRef.current = detailBackgroundUploads
  }, [detailBackgroundUploads])

  useEffect(() => {
    commentBackgroundUploadsRef.current = commentBackgroundUploads
  }, [commentBackgroundUploads])

  useEffect(() => () => {
    detailBackgroundUploadsRef.current.forEach((upload) => URL.revokeObjectURL(upload.previewUrl))
    detailBackgroundUploadsRef.current = []
    commentBackgroundUploadsRef.current.forEach((upload) => URL.revokeObjectURL(upload.previewUrl))
    commentBackgroundUploadsRef.current = []
  }, [])

  useEffect(() => {
    const run = () => setBackgroundDataReady(true)
    const idleCallback = window.requestIdleCallback?.(run, { timeout: 1200 })
    const timer = window.setTimeout(run, 900)
    return () => {
      if (idleCallback) window.cancelIdleCallback?.(idleCallback)
      window.clearTimeout(timer)
    }
  }, [])

  useEffect(() => {
    function syncMobileOrientationView() {
      const coarsePointer = window.matchMedia?.('(hover: none), (pointer: coarse)').matches ?? false
      const compactDevice = Math.min(window.innerWidth, window.innerHeight) <= 760
      const landscape = window.innerWidth > window.innerHeight
      setIsTouchDevice(coarsePointer)
      if (!coarsePointer || !compactDevice) return
      setViewMode(landscape ? 'week' : 'month')
    }

    syncMobileOrientationView()
    window.addEventListener('resize', syncMobileOrientationView)
    window.addEventListener('orientationchange', syncMobileOrientationView)
    window.visualViewport?.addEventListener('resize', syncMobileOrientationView)
    return () => {
      window.removeEventListener('resize', syncMobileOrientationView)
      window.removeEventListener('orientationchange', syncMobileOrientationView)
      window.visualViewport?.removeEventListener('resize', syncMobileOrientationView)
    }
  }, [])

  useEffect(() => {
    return () => {
      setTouchEventDragDocumentMode(false)
      if (dragPreviewFrameRef.current !== null) {
        window.cancelAnimationFrame(dragPreviewFrameRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (viewMode !== 'month' || loading || showEventModal) return
    const grid = monthGridRef.current
    if (!grid) return
    const currentGrid = grid
    let frame = 0

    function calculateMonthDayEventLimit() {
      if (isVisualViewportReducedByKeyboard()) return
      const cell = currentGrid.querySelector<HTMLElement>('.day-cell')
      if (!cell) return
      const dayEvents = cell.querySelector<HTMLElement>('.day-events')
      const eventRow = currentGrid.querySelector<HTMLElement>('.event-pill, .more-pill')
      const gridRect = currentGrid.getBoundingClientRect()
      const cellRect = cell.getBoundingClientRect()
      const dayEventsRect = dayEvents?.getBoundingClientRect()
      const eventsStyle = dayEvents ? window.getComputedStyle(dayEvents) : null
      const rowGap = Number.parseFloat(eventsStyle?.rowGap || eventsStyle?.gap || '1') || 1
      const rowHeight = eventRow?.getBoundingClientRect().height || (window.matchMedia?.('(max-width: 760px)').matches ? 14 : 17)
      const cellHeight = gridRect.height > 0 ? gridRect.height / 6 : cellRect.height
      const eventsTop = dayEventsRect ? Math.max(0, dayEventsRect.top - cellRect.top) : 24
      const availableHeight = Math.max(0, cellHeight - eventsTop - 2)
      const nextLimit = Math.max(2, Math.min(16, Math.floor((availableHeight + rowGap) / (rowHeight + rowGap)) || DEFAULT_MONTH_DAY_EVENT_ROW_LIMIT))
      setMonthDayEventRowLimit((current) => current === nextLimit ? current : nextLimit)
    }

    function scheduleMonthDayEventLimitCalculation() {
      if (frame) window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(calculateMonthDayEventLimit)
    }

    scheduleMonthDayEventLimitCalculation()
    const settleTimers = [120, 360, 720].map((delay) => (
      window.setTimeout(scheduleMonthDayEventLimitCalculation, delay)
    ))
    const resizeObserver = new ResizeObserver(calculateMonthDayEventLimit)
    resizeObserver.observe(currentGrid)
    if (calendarSurfaceRef.current) resizeObserver.observe(calendarSurfaceRef.current)
    const firstCell = currentGrid.querySelector<HTMLElement>('.day-cell')
    if (firstCell) resizeObserver.observe(firstCell)
    window.addEventListener('resize', scheduleMonthDayEventLimitCalculation)
    window.visualViewport?.addEventListener('resize', scheduleMonthDayEventLimitCalculation)
    return () => {
      if (frame) window.cancelAnimationFrame(frame)
      settleTimers.forEach((timer) => window.clearTimeout(timer))
      resizeObserver.disconnect()
      window.removeEventListener('resize', scheduleMonthDayEventLimitCalculation)
      window.visualViewport?.removeEventListener('resize', scheduleMonthDayEventLimitCalculation)
    }
  }, [loading, month, showEventModal, viewMode])

  const selectedDay = dayjs(selectedDate)
  const currentTitle = viewMode === 'week'
    ? `${weekDays[0].format('M/D')} - ${weekDays[6].format('M/D')}`
    : month.format('YYYY年M月')
  function calendarColor(calendarId: string) {
    return visibleCalendarMap.get(calendarId)?.color ?? '#667085'
  }

  function activityLogColor(log: CalendarActivityLog) {
    if (log.calendarId) return calendarColor(log.calendarId)
    if (log.departmentId) return calendarColor(departmentCalendarId(log.departmentId))
    return '#667085'
  }

  function removeEventsFromArchiveCache(ids: string[]) {
    const idSet = new Set(ids)
    updateLocalQueryCache<CalendarEvent[]>('calendarEventsArchive', (cached) => (
      (cached ?? []).filter((event) => !idSet.has(event.id) && !idSet.has(recurrenceRootId(event)))
    ))
  }

  function optimisticallyRemoveCalendarEvents(ids: string[]) {
    const idSet = new Set(ids)
    const removeRows = (rows: CalendarEvent[] | undefined) => (
      rows?.filter((event) => !idSet.has(event.id) && !idSet.has(recurrenceRootId(event)))
    )
    queryClient.setQueriesData<CalendarEvent[]>({ queryKey: ['calendarEvents'] }, removeRows)
    queryClient.setQueriesData<CalendarEvent[]>({ queryKey: ['calendarEventsSearchIndex'] }, removeRows)
    removeEventsFromArchiveCache(ids)
  }

  function syncAfterDelete() {
    void refreshCalendarData().catch((error) => {
      console.warn('[calendar] refresh after delete failed', error)
    })
  }

  function sortCalendarEventsAscending(rows: CalendarEvent[]) {
    return [...rows].sort((a, b) => `${a.date} ${a.startTime}`.localeCompare(`${b.date} ${b.startTime}`))
  }

  function patchCalendarEventRows(rows: CalendarEvent[] | undefined, patches: CalendarEvent[]) {
    const map = new Map((rows ?? []).map((event) => [event.id, event]))
    patches.forEach((event) => map.set(event.id, { ...(map.get(event.id) ?? {} as CalendarEvent), ...event }))
    return sortCalendarEventsAscending(Array.from(map.values()))
  }

  function optimisticallyPatchCalendarEvents(patches: CalendarEvent[]) {
    if (!patches.length) return
    queryClient.setQueriesData<CalendarEvent[]>({ queryKey: ['calendarEvents'] }, (cached) => (
      cached ? patchCalendarEventRows(cached, patches) : cached
    ))
    queryClient.setQueriesData<CalendarEvent[]>({ queryKey: ['calendarEventsSearchIndex'] }, (cached) => (
      cached ? patchCalendarEventRows(cached, patches) : cached
    ))
    const cachedArchive = readLocalQueryCache<CalendarEvent[]>('calendarEventsArchive')
    if (cachedArchive) {
      writeLocalQueryCache('calendarEventsArchive', patchCalendarEventRows(cachedArchive, patches)
        .sort((a, b) => `${b.date} ${b.startTime}`.localeCompare(`${a.date} ${a.startTime}`))
        .slice(0, 2000))
    }
  }

  function eventDisplayCalendarId(event: CalendarEvent) {
    if (isHrReadonlyEvent(event)) return hrLeaveCalendar?.id ?? event.calendarId
    if (event.calendarIds?.length) return event.calendarIds[0]
    if (event.calendarId.startsWith(DEPARTMENT_CALENDAR_PREFIX)) return event.calendarId
    if (event.departmentId) return departmentCalendarId(event.departmentId)
    return event.calendarId
  }

  function eventDisplayCalendarIds(event: CalendarEvent) {
    if (isHrReadonlyEvent(event)) return [eventDisplayCalendarId(event)]
    return event.calendarIds?.length ? event.calendarIds : [eventDisplayCalendarId(event)]
  }

  function eventCalendarColor(event: CalendarEvent) {
    if (isHrHolidayEvent(event)) return HR_HOLIDAY_COLOR
    return calendarColor(eventDisplayCalendarId(event))
  }

  function eventCalendarName(event: CalendarEvent) {
    const names = eventDisplayCalendarIds(event)
      .map((id) => visibleCalendarMap.get(id)?.name)
      .filter(Boolean)
    return names.join('、') || '未分類行事曆'
  }

  function departmentName(id: string) {
    return departments.find((department) => department.id === id)?.name || '未分配'
  }

  function employeeName(id: string) {
    const employee = employees.find((item) => item.id === id)
    return employee?.nickname || employee?.name || (id === employeeId ? displayName : '') || '未指定'
  }

  function eventOwnerLabel(event: CalendarEvent) {
    const firstAssigneeId = event.assigneeIds?.[0]
    if (firstAssigneeId) return employeeName(firstAssigneeId).slice(0, 1)
    return (eventCalendarName(event) || '行').slice(0, 1)
  }

  function eventListSecondaryText(event: CalendarEvent) {
    const note = isHrLeaveRequestEvent(event) && !canViewHrLeaveNote ? '' : event.note
    return note || event.location || ''
  }

  function isManagementDepartmentEvent(event: CalendarEvent) {
    const eventDepartmentName = event.departmentId ? departmentName(event.departmentId) : ''
    if (eventDepartmentName === '管理部') return true
    return eventDisplayCalendarIds(event).some((id) => {
      const calendar = visibleCalendarMap.get(id)
      if (calendar?.name === '管理部') return true
      return calendar?.departmentIds?.some((departmentId) => departmentName(departmentId) === '管理部') ?? false
    })
  }

  function eventAllowedForViewer(event: CalendarEvent) {
    if (isAdmin) return true
    if (!employeeId) return false
    if (eventVisibilityTargetAppliesToViewer(event)) return true
    const hiddenEmployees = event.hiddenAssigneeIds ?? []
    if (hiddenEmployees.includes(employeeId)) return false
    const hiddenDepartments = event.hiddenDepartmentIds ?? []
    const viewerDepartmentId = currentEmployeeDepartmentId
    const viewerDepartmentName = currentEmployeeDepartmentName
    if (viewerDepartmentId && hiddenDepartments.includes(viewerDepartmentId)) return false
    if (viewerDepartmentName && hiddenDepartments.some((id) => departmentName(id) === viewerDepartmentName)) return false
    const assignees = event.assigneeIds ?? []
    const hasDepartmentScope = Boolean(event.departmentId || event.calendarId || event.calendarIds?.length)
    if (!hasDepartmentScope && assignees.length > 0) return assignees.includes(employeeId)
    return true
  }

  function eventBelongsToCurrentEmployeeDepartment(event: CalendarEvent) {
    if (!employeeId || !event.departmentId) return false
    if (event.departmentId === currentEmployeeDepartmentId) return true
    return Boolean(currentEmployeeDepartmentName && departmentName(event.departmentId) === currentEmployeeDepartmentName)
  }

  function canManageCalendarEvent(event: CalendarEvent) {
    if (isHrReadonlyEvent(event)) return false
    if (isAdmin || Boolean(user?.uid && event.createdBy === user.uid)) return true
    if (currentEmployeeDepartmentName === '管理部') return true
    if (isManagementDepartmentEvent(event) && currentEmployeeDepartmentName !== '管理部') return false
    if (!employeeId || !eventAllowedForViewer(event)) return false
    return Boolean(event.assigneeIds?.includes(employeeId) || eventBelongsToCurrentEmployeeDepartment(event))
  }

  function canUploadDetailAttachment(event: CalendarEvent, status: ProductionLineStatus | null) {
    if (canManageCalendarEvent(event)) return true
    return canScanSalesOrder && isErpOrderFulfillmentEvent(event, status)
  }

  function eventTitleOverrideAppliesToViewer(event: CalendarEvent) {
    const overrides = event.titleOverrides ?? []
    if (!overrides.length || !employeeId) return false
    const hasTitle = (item?: NonNullable<CalendarEvent['titleOverrides']>[number]) => Boolean(item?.title.trim())
    if (hasTitle(overrides.find((item) => item.targetType === 'employee' && item.targetId === employeeId))) return true
    const departmentId = currentEmployeeDepartmentId
    const departmentNameValue = currentEmployeeDepartmentName
    if (hasTitle(overrides.find((item) => (
      item.targetType === 'department' &&
      (item.targetId === departmentId || departmentName(item.targetId) === departmentNameValue)
    )))) return true
    if (hasTitle(overrides.find((item) => item.targetType === ALL_EMPLOYEES_EXCEPT_SELF && item.targetId !== employeeId))) return true
    return hasTitle(overrides.find((item) => (
      item.targetType === ALL_DEPARTMENTS_EXCEPT_OWN &&
      item.targetId !== departmentId &&
      departmentName(item.targetId) !== departmentNameValue
    )))
  }

  function eventVisibilityTargetAppliesToViewer(event: CalendarEvent) {
    if (!employeeId) return false
    if (event.visibleAssigneeIds?.includes(employeeId)) return true
    const departmentId = currentEmployeeDepartmentId
    const departmentNameValue = currentEmployeeDepartmentName
    return Boolean(event.visibleDepartmentIds?.some((id) => (
      id === departmentId || departmentName(id) === departmentNameValue
    )))
  }

  function eventOverrideExcludedForViewer(event: CalendarEvent) {
    if (!employeeId) return false
    if (event.hiddenAssigneeIds?.includes(employeeId)) return true
    const departmentId = currentEmployeeDepartmentId
    const departmentNameValue = currentEmployeeDepartmentName
    return Boolean(event.hiddenDepartmentIds?.some((id) => (
      id === departmentId || departmentName(id) === departmentNameValue
    )))
  }

  function eventTitleOverrideForViewer(event: CalendarEvent) {
    const overrides = event.titleOverrides ?? []
    if (!overrides.length) return ''
    if (eventOverrideExcludedForViewer(event)) return ''
    const displayOverrideTitle = (item?: NonNullable<CalendarEvent['titleOverrides']>[number]) => {
      const title = item?.title.trim() ?? ''
      if (!title) return ''
      return item?.icon ? composeTitleWithIcon(item.icon, title, titleIconOptions) : title
    }
    const userOverride = employeeId
      ? overrides.find((item) => item.targetType === 'employee' && item.targetId === employeeId)
      : null
    const userOverrideTitle = displayOverrideTitle(userOverride ?? undefined)
    if (userOverrideTitle) return userOverrideTitle
    const departmentId = currentEmployeeDepartmentId
    const departmentNameValue = currentEmployeeDepartmentName
    const departmentOverride = overrides.find((item) => (
      item.targetType === 'department' &&
      (item.targetId === departmentId || departmentName(item.targetId) === departmentNameValue)
    ))
    const departmentOverrideTitle = displayOverrideTitle(departmentOverride)
    if (departmentOverrideTitle) return departmentOverrideTitle
    const allEmployeesOverride = employeeId
      ? overrides.find((item) => item.targetType === ALL_EMPLOYEES_EXCEPT_SELF && item.targetId !== employeeId)
      : null
    const allEmployeesOverrideTitle = displayOverrideTitle(allEmployeesOverride ?? undefined)
    if (allEmployeesOverrideTitle) return allEmployeesOverrideTitle
    const allDepartmentsOverride = overrides.find((item) => (
      item.targetType === ALL_DEPARTMENTS_EXCEPT_OWN &&
      item.targetId !== departmentId &&
      departmentName(item.targetId) !== departmentNameValue
    ))
    const allDepartmentsOverrideTitle = displayOverrideTitle(allDepartmentsOverride)
    if (allDepartmentsOverrideTitle) return allDepartmentsOverrideTitle
    if (eventVisibilityTargetAppliesToViewer(event)) {
      return displayOverrideTitle(overrides.find((item) => item.title.trim()))
    }
    return ''
  }

  function eventDisplayTitle(event: CalendarEvent) {
    const overrideTitle = eventTitleOverrideForViewer(event)
    if (overrideTitle) return workScheduleTitleForOverride(event, overrideTitle)
    if (!isHrReadonlyEvent(event) || !event.assigneeIds?.length) return event.title
    const employee = employees.find((item) => item.id === event.assigneeIds[0])
    return employeeNicknameTitle(event.title, employee)
  }

  function eventDetailVisibilityTitleRows(event: CalendarEvent) {
    const rows: { target: string; title: string; muted?: boolean }[] = []
    const addRow = (target: string, title: string, muted = false) => {
      const cleanTarget = target.trim()
      const trimmedTitle = title.trim()
      const cleanTitle = workScheduleTitleForOverride(event, trimmedTitle)
      if (!cleanTarget || !cleanTitle) return
      if (rows.some((row) => row.target === cleanTarget && row.title === cleanTitle && row.muted === muted)) return
      rows.push({ target: cleanTarget, title: cleanTitle, muted })
    }
    const overrideTitle = (override: NonNullable<CalendarEvent['titleOverrides']>[number]) => (
      override.icon ? composeTitleWithIcon(override.icon, override.title, titleIconOptions) : override.title.trim()
    )
    const departmentTitle = (departmentId: string) => {
      const overrides = event.titleOverrides ?? []
      const departmentNameValue = departmentName(departmentId)
      const departmentOverride = overrides.find((override) => (
        override.targetType === 'department' &&
        (override.targetId === departmentId || departmentName(override.targetId) === departmentNameValue)
      ))
      if (departmentOverride?.title.trim()) return overrideTitle(departmentOverride)
      const allDepartmentsOverride = overrides.find((override) => (
        override.targetType === ALL_DEPARTMENTS_EXCEPT_OWN &&
        override.targetId !== departmentId &&
        departmentName(override.targetId) !== departmentNameValue
      ))
      if (allDepartmentsOverride?.title.trim()) return overrideTitle(allDepartmentsOverride)
      return event.title
    }
    const employeeTitle = (assigneeId: string) => {
      const employee = employees.find((item) => item.id === assigneeId)
      const overrides = event.titleOverrides ?? []
      const userOverride = overrides.find((override) => override.targetType === 'employee' && override.targetId === assigneeId)
      if (userOverride?.title.trim()) return overrideTitle(userOverride)
      const departmentOverride = overrides.find((override) => (
        override.targetType === 'department' &&
        (override.targetId === employee?.departmentId || departmentName(override.targetId) === employee?.departmentName)
      ))
      if (departmentOverride?.title.trim()) return overrideTitle(departmentOverride)
      const allEmployeesOverride = overrides.find((override) => override.targetType === ALL_EMPLOYEES_EXCEPT_SELF && override.targetId !== assigneeId)
      if (allEmployeesOverride?.title.trim()) return overrideTitle(allEmployeesOverride)
      const allDepartmentsOverride = overrides.find((override) => (
        override.targetType === ALL_DEPARTMENTS_EXCEPT_OWN &&
        override.targetId !== employee?.departmentId &&
        departmentName(override.targetId) !== employee?.departmentName
      ))
      if (allDepartmentsOverride?.title.trim()) return overrideTitle(allDepartmentsOverride)
      return event.title
    }
    const overrideTargetLabel = (override: NonNullable<CalendarEvent['titleOverrides']>[number]) => {
      if (override.targetType === 'department') return departmentName(override.targetId)
      if (override.targetType === 'employee') return employeeName(override.targetId)
      if (override.targetType === ALL_DEPARTMENTS_EXCEPT_OWN) return `所有部門（除了 ${departmentName(override.targetId) || '自己所屬部門'}）`
      return `所有同仁（除了 ${override.targetId ? employeeName(override.targetId) : '自己'}）`
    }
    const allDepartmentOverrideTargets = new Set(
      (event.titleOverrides ?? [])
        .filter((override) => override.targetType === ALL_DEPARTMENTS_EXCEPT_OWN && override.title.trim())
        .map((override) => override.targetId)
    )

    ;(event.titleOverrides ?? []).forEach((override) => {
      addRow(overrideTargetLabel(override), overrideTitle(override))
    })
    ;(event.visibleDepartmentIds ?? []).forEach((departmentId) => {
      if (Array.from(allDepartmentOverrideTargets).some((targetId) => (
        targetId !== departmentId && departmentName(targetId) !== departmentName(departmentId)
      ))) return
      addRow(departmentName(departmentId), departmentTitle(departmentId))
    })
    ;(event.visibleAssigneeIds ?? []).forEach((assigneeId) => {
      addRow(employeeName(assigneeId), employeeTitle(assigneeId))
    })
    ;(event.hiddenDepartmentIds ?? []).forEach((departmentId) => {
      addRow(departmentName(departmentId), event.title)
    })
    ;(event.hiddenAssigneeIds ?? []).forEach((assigneeId) => {
      addRow(employeeName(assigneeId), event.title)
    })
    return rows
  }

  function textDisplayTitle(title: string) {
    const employee = employees.find((item) => item.nickname?.trim() && item.name?.trim() && title.startsWith(item.name.trim()))
    return employeeNicknameTitle(title, employee)
  }

  function currentActorName() {
    return employeeId ? employeeName(employeeId) : (displayName || user?.displayName || user?.email || '未命名使用者')
  }

  function eventCommentAuthorName(comment: CalendarEventComment) {
    const employee = employees.find((item) => item.id === comment.authorEmployeeId)
    return employee?.nickname || employee?.name || comment.authorName || '未命名使用者'
  }

  function valueLabel(field: string, value: unknown) {
    if (field === 'departmentId') return value ? departmentName(String(value)) : '未分配'
    if (field === 'calendarId') return value ? (visibleCalendarMap.get(String(value))?.name || '未分類行事曆') : '未分類行事曆'
    if (field === 'calendarIds') {
      const ids = Array.isArray(value) ? value : []
      return ids.length ? ids.map((id) => visibleCalendarMap.get(String(id))?.name || '未分類行事曆').join('、') : '未分類行事曆'
    }
    if (field === 'assigneeIds') {
      const ids = Array.isArray(value) ? value : []
      return ids.length ? ids.map((id) => employeeName(String(id))).join('、') : '未指定'
    }
    if (field === 'visibleDepartmentIds') {
      const ids = Array.isArray(value) ? value : []
      return ids.length ? ids.map((id) => departmentName(String(id))).join('、') : '無'
    }
    if (field === 'visibleAssigneeIds') {
      const ids = Array.isArray(value) ? value : []
      return ids.length ? ids.map((id) => employeeName(String(id))).join('、') : '無'
    }
    if (field === 'hiddenDepartmentIds') {
      const ids = Array.isArray(value) ? value : []
      return ids.length ? ids.map((id) => departmentName(String(id))).join('、') : '無'
    }
    if (field === 'hiddenAssigneeIds') {
      const ids = Array.isArray(value) ? value : []
      return ids.length ? ids.map((id) => employeeName(String(id))).join('、') : '無'
    }
    if (field === 'titleOverrides') return Array.isArray(value) ? `${value.length} 個替代標題` : '0 個替代標題'
    if (field === 'reminder') return REMINDER_OPTIONS.find((option) => option.value === value)?.label ?? '無通知'
    if (field === 'repeat') return repeatLabel(value as CalendarEvent['repeat'], eventForm.date, eventForm.repeatCustom)
    if (field === 'repeatCustom') return JSON.stringify(value ?? {})
    if (field === 'todos') return Array.isArray(value) ? `${value.length} 項` : '0 項'
    if (field === 'attachments') return Array.isArray(value) ? `${value.length} 個附件` : '0 個附件'
    if (field === 'allDay') return value === true ? '是' : '否'
    return String(value ?? '').trim() || '空白'
  }

  function eventChangeList(beforeEvent: CalendarEvent, afterEvent: Partial<CalendarEvent>) {
    const fields = [
      ['title', '標題'],
      ['date', '日期'],
      ['endDate', '結束日期'],
      ['startTime', '開始時間'],
      ['endTime', '結束時間'],
      ['allDay', '全天事件'],
      ['departmentId', '部門'],
      ['calendarIds', '行事曆'],
      ['assigneeIds', '同仁'],
      ['visibleDepartmentIds', '顯示部門'],
      ['visibleAssigneeIds', '顯示同仁'],
      ['hiddenDepartmentIds', '排除部門'],
      ['hiddenAssigneeIds', '排除同仁'],
      ['titleOverrides', '替代標題'],
      ['reminder', '通知'],
      ['repeat', '重複'],
      ['repeatCustom', '重複設定'],
      ['location', '地點'],
      ['url', '網址'],
      ['note', '備註'],
      ['todos', '待辦清單'],
      ['attachments', '附件']
    ] as const

    return fields.flatMap(([field, label]) => {
      const beforeValue = beforeEvent[field as keyof CalendarEvent]
      const afterValue = afterEvent[field as keyof CalendarEvent]
      const before = valueLabel(field, beforeValue)
      const after = valueLabel(field, afterValue)
      const structureChanged = ['titleOverrides', 'todos', 'repeatCustom'].includes(field)
        && JSON.stringify(beforeValue ?? (field === 'repeatCustom' ? {} : []))
          !== JSON.stringify(afterValue ?? (field === 'repeatCustom' ? {} : []))
      return before === after && !structureChanged ? [] : [{ field, label, before, after }]
    })
  }

  async function writeActivityLog(input: Omit<CalendarActivityLog, 'id' | 'actorUid' | 'actorName' | 'createdAt'>) {
    try {
      if (input.action !== 'delete') await createCalendarActivity(input)
      await queryClient.invalidateQueries({ queryKey: ['calendarActivityLogs'] })
    } catch (error) {
      console.warn('[calendar] write activity log failed', error)
    }
  }

  function getDepartmentEmployeeIds(departmentId: string) {
    const department = departments.find((item) => item.id === departmentId)
    return employees
      .filter((employee) => employeeActiveForCalendar(employee))
      .filter((employee) => employee.departmentId === departmentId || Boolean(department?.name && employee.departmentName === department.name))
      .map((employee) => employee.id)
  }

  function primaryDepartmentIdFromCalendarIds(calendarIds: string[], fallback = '') {
    const firstCalendarId = calendarIds[0] ?? ''
    return departmentIdFromCalendarId(firstCalendarId) || visibleCalendarMap.get(firstCalendarId)?.departmentIds?.[0] || fallback
  }

  function eventViewerEmployeeIds(event: CalendarEvent) {
    const ids = new Set<string>()
    const departmentScopeIds = new Set<string>()
    const addDepartment = (departmentId: string) => {
      departmentScopeIds.add(departmentId)
      getDepartmentEmployeeIds(departmentId).forEach((id) => ids.add(id))
    }
    ;(event.calendarIds?.length ? event.calendarIds : [eventDisplayCalendarId(event)]).forEach((calendarId) => {
      const departmentId = departmentIdFromCalendarId(calendarId) || visibleCalendarMap.get(calendarId)?.departmentIds?.[0] || ''
      if (departmentId) addDepartment(departmentId)
    })
    if (event.departmentId) addDepartment(event.departmentId)
    ;(event.assigneeIds ?? []).forEach((id) => ids.add(id))
    ;(event.visibleDepartmentIds ?? []).forEach(addDepartment)
    ;(event.visibleAssigneeIds ?? []).forEach((id) => ids.add(id))
    ;(event.hiddenDepartmentIds ?? []).forEach((departmentId) => {
      getDepartmentEmployeeIds(departmentId).forEach((id) => ids.delete(id))
    })
    ;(event.hiddenAssigneeIds ?? []).forEach((id) => ids.delete(id))
    if (departmentScopeIds.size === 0 && event.assigneeIds?.length) {
      const assigned = new Set(event.assigneeIds)
      Array.from(ids).forEach((id) => {
        if (!assigned.has(id)) ids.delete(id)
      })
    }
    return Array.from(ids)
  }

  function toggleEventCalendar(calendarId: string) {
    setEventForm((form) => {
      const calendarIds = toggle(form.calendarIds, calendarId)
      const nextDepartmentId = primaryDepartmentIdFromCalendarIds(calendarIds, form.departmentId)
      const oldDefaultIcons = departmentTitleIconDefaults[form.departmentId] ?? []
      const nextDefaultIcon = departmentTitleIconDefaults[nextDepartmentId]?.[0] ?? ''
      const currentIcon = selectedTitleIcon(form.title, titleIconOptions)
      const currentTitleText = titleWithoutKnownIcon(form.title, titleIconOptions).trim()
      const shouldApplyDefaultIcon = !currentTitleText && (!currentIcon || oldDefaultIcons.includes(currentIcon))
      return {
        ...form,
        calendarIds,
        calendarId: calendarIds[0] ?? '',
        departmentId: nextDepartmentId,
        title: shouldApplyDefaultIcon && nextDefaultIcon ? composeTitleWithIcon(nextDefaultIcon, '', titleIconOptions) : form.title
      }
    })
  }

  function toggleCalendarDepartment(departmentId: string) {
    setCalendarForm((form) => {
      const selected = form.departmentIds.includes(departmentId)
      const departmentEmployeeIds = getDepartmentEmployeeIds(departmentId)
      return {
        ...form,
        departmentIds: selected ? form.departmentIds.filter((id) => id !== departmentId) : [...form.departmentIds, departmentId],
        employeeIds: selected
          ? form.employeeIds.filter((id) => !departmentEmployeeIds.includes(id))
          : Array.from(new Set([...form.employeeIds, ...departmentEmployeeIds]))
      }
    })
  }

  const selectedAssigneeText = eventForm.assigneeIds.length > 0
    ? eventForm.assigneeIds.map(employeeName).join('、')
    : '選擇同仁'
  const ownDepartmentId = currentEmployeeDepartmentId || departments.find((department) => department.name === currentEmployeeDepartmentName)?.id || ''
  const managementDepartmentId = departments.find((department) => department.name === '管理部')?.id || (currentEmployeeDepartmentName === '管理部' ? ownDepartmentId : '')
  const eventFormDepartmentName = departmentName(eventForm.departmentId)
  const visibleOtherDepartmentIds = departments
    .filter((department) => department.id !== eventForm.departmentId && department.name !== eventFormDepartmentName)
    .map((department) => department.id)
  const allOtherDepartmentIds = departments
    .filter((department) => department.id !== ownDepartmentId && department.name !== currentEmployeeDepartmentName)
    .map((department) => department.id)
  const allDepartmentsVisible = visibleOtherDepartmentIds.length > 0 && visibleOtherDepartmentIds.every((id) => eventForm.visibleDepartmentIds.includes(id))
  const hiddenTargetText = [
    eventForm.visibleDepartmentIds.length ? `顯示 ${eventForm.visibleDepartmentIds.length} 個部門` : '',
    eventForm.hiddenAssigneeIds.length ? `排除 ${eventForm.hiddenAssigneeIds.length} 位同仁` : '',
    eventForm.titleOverrides.length ? `${eventForm.titleOverrides.length} 個標題覆寫` : ''
  ].filter(Boolean).join('、') || '顯示對象與替代標題'
  const selectedEventCalendarText = eventForm.calendarIds.length > 0
    ? eventForm.calendarIds.map((id) => visibleCalendarMap.get(id)?.name).filter(Boolean).join('、')
    : '不選部門，僅指定同仁'
  const eventEditorColor = visibleCalendarMap.get(eventForm.calendarIds[0] ?? eventForm.calendarId)?.color ?? COLORS[0]
  const repeatOptions = useMemo(() => repeatPresetOptions(eventForm.date), [eventForm.date])
  const selectedRepeatText = repeatLabel(eventForm.repeat, eventForm.date, eventForm.repeatCustom)
  const currentTitleIcon = selectedTitleIcon(eventForm.title, titleIconOptions)
  const currentTitleText = titleWithoutKnownIcon(eventForm.title, titleIconOptions)
  const editingEventRecord = editingEventId
    ? events.find((event) => event.id === editingEventId)
      ?? (editingEventSnapshot?.id === editingEventId ? editingEventSnapshot : null)
    : null
  const editingSalesDeliveryEvent = isErpSalesDeliveryEvent(editingEventRecord)
  const editingRelatedSalesDeliveryEvent = isRelatedErpSalesDeliveryEvent(editingEventRecord)
  const salesDeliveryEditor = editingSalesDeliveryEvent || isErpSalesDeliveryEvent(copySourceEvent)
  const relatedSalesDeliveryDraft = editingRelatedSalesDeliveryEvent || isErpSalesDeliveryEvent(copySourceEvent)
  const salesDeliveryAttachmentReadonly = editingSalesDeliveryEvent || isErpSalesDeliveryEvent(copySourceEvent)
  const salesDeliverySystemNoteReadonly = editingSalesDeliveryEvent || isErpSalesDeliveryEvent(copySourceEvent)
  const eventDepartmentTitleIcons = departmentTitleIconDefaults[eventForm.departmentId] ?? []
  const eventTitleIconOptions = eventDepartmentTitleIcons.length
    ? titleIconOptions.filter((item) => eventDepartmentTitleIcons.includes(item.icon))
    : titleIconOptions
  const titleSuggestionEnabled = showEventModal && showTitleSuggestions
  const cachedEventArchive = useMemo(
    () => titleSuggestionEnabled
      ? readLocalQueryCache<CalendarEvent[]>('calendarEventsArchive') ?? []
      : [],
    [events, titleSuggestionEnabled]
  )
  const titleSuggestionEvents = useMemo(() => {
    if (!titleSuggestionEnabled) return []
    const map = new Map<string, CalendarEvent>()
    cachedEventArchive.forEach((event) => map.set(event.id, event))
    events.forEach((event) => map.set(event.id, event))
    return Array.from(map.values())
  }, [cachedEventArchive, events, titleSuggestionEnabled])
  const titleSuggestionIndex = useMemo(() => (
    titleSuggestionEnabled
      ? titleSuggestionEvents
      .filter((event) => dayjs(event.date).isBefore(dayjs(eventForm.date).add(1, 'day'), 'day'))
      .sort((a, b) => `${b.date} ${b.startTime}`.localeCompare(`${a.date} ${a.startTime}`))
      .map((event) => ({
        event,
        normalizedTitle: normalizeSearchText(eventDisplayTitle(event), titleIconOptions)
      }))
      : []
  ), [eventForm.date, employees, titleIconOptions, titleSuggestionEnabled, titleSuggestionEvents])
  const titleSuggestions = useMemo(() => {
    const query = normalizeSearchText(currentTitleText, titleIconOptions)
    if (query.length < 1) return []
    return titleSuggestionIndex
      .filter((item) => item.event.id !== editingEventId)
      .filter((item) => item.normalizedTitle.includes(query))
      .map((item) => item.event)
      .slice(0, 6)
  }, [currentTitleText, editingEventId, titleIconOptions, titleSuggestionIndex])
  const todoSummaryText = eventForm.todos.length > 0
    ? `${eventForm.todos.filter((todo) => todo.done).length}/${eventForm.todos.length} 已完成`
    : '待辦清單'

  function openAddCalendar() {
    setCalendarForm(emptyCalendar)
    setEditingCalendarId(null)
    setShowCalendarModal(true)
  }

  function openEditCalendar(calendar: CalendarGroup) {
    const departmentIds = calendar.departmentIds ?? []
    const departmentEmployeeIds = departmentIds.flatMap(getDepartmentEmployeeIds)
    setCalendarForm({
      name: calendar.name,
      color: calendar.color,
      departmentIds,
      employeeIds: Array.from(new Set([...(calendar.employeeIds ?? []), ...departmentEmployeeIds])),
      isCompanyWide: !!calendar.isCompanyWide
    })
    setEditingCalendarId(calendar.id)
    setShowCalendarModal(true)
  }

  function toggleCalendar(calendarId: string) {
    setActiveCalendarIds((list) => {
      const baseIds = calendarSelectionMode === 'all'
        ? visibleCalendarIds
        : calendarSelectionMode === 'none'
          ? []
          : list.filter((id) => visibleCalendarIds.includes(id))
      const nextIds = toggle(baseIds, calendarId)
      const clickedCalendar = visibleCalendarMap.get(calendarId)
      const clickedIsSelected = nextIds.includes(calendarId)
      if (clickedCalendar?.systemKind !== 'hrLeave' && clickedIsSelected) {
        setLastSelectedCalendarId(calendarId)
      } else if (!nextIds.includes(lastSelectedCalendarId) || lastSelectedCalendarId === calendarId) {
        const fallbackId = [...nextIds].reverse().find((id) => visibleCalendarMap.get(id)?.systemKind !== 'hrLeave') ?? ''
        setLastSelectedCalendarId(fallbackId)
      }
      setCalendarSelectionMode(nextIds.length === visibleCalendarIds.length ? 'all' : nextIds.length === 0 ? 'none' : 'custom')
      return nextIds
    })
  }

  function selectAllCalendars() {
    const nextMode = allCalendarsSelected ? 'none' : 'all'
    setCalendarSelectionMode(nextMode)
    setActiveCalendarIds([])
  }

  function toggleSearchDepartment(departmentId: string) {
    setActiveSearchDepartmentIds((ids) => toggle(ids.length ? ids : searchDepartmentIds, departmentId))
  }

  function selectAllSearchDepartments() {
    setActiveSearchDepartmentIds([])
  }

  function managementDefaultTitleOverride(form: EventForm) {
    if (!managementDepartmentId) return null
    const selectedDepartmentName = departmentName(form.departmentId)
    if (currentEmployeeDepartmentName !== '管理部' && selectedDepartmentName !== '管理部') return null
    return {
      targetType: ALL_DEPARTMENTS_EXCEPT_OWN,
      targetId: managementDepartmentId,
      icon: '❌',
      title: '承翰、鮪魚'
    } satisfies NonNullable<CalendarEvent['titleOverrides']>[number]
  }

  function addTitleOverride() {
    const firstDepartmentId = departments[0]?.id ?? ''
    const firstEmployeeId = employees.find((employee) => employeeActiveForCalendar(employee))?.id ?? ''
    setEventForm((form) => ({
      ...form,
      titleOverrides: [
        ...form.titleOverrides,
        managementDefaultTitleOverride(form) ?? {
          targetType: firstDepartmentId ? 'department' : 'employee',
          targetId: firstDepartmentId || firstEmployeeId,
          icon: selectedTitleIcon(form.title, titleIconOptions) || undefined,
          title: ''
        }
      ]
    }))
  }

  function toggleVisibilityEnabled(checked: boolean) {
    setShowVisibilityEditor(checked)
    setEventForm((form) => {
      if (!checked) return { ...form, visibilityEnabled: false }
      const managementDefault = managementDefaultTitleOverride(form)
      const hasManagementDefault = Boolean(managementDefault && form.titleOverrides.some((override) => (
        override.targetType === managementDefault.targetType &&
        override.targetId === managementDefault.targetId
      )))
      return {
        ...form,
        visibilityEnabled: true,
        visibleDepartmentIds: form.visibleDepartmentIds.length
          ? form.visibleDepartmentIds
          : departments
            .filter((department) => department.id !== form.departmentId && department.name !== departmentName(form.departmentId))
            .map((department) => department.id),
        titleOverrides: managementDefault && !hasManagementDefault
          ? [...form.titleOverrides, managementDefault]
          : form.titleOverrides
      }
    })
  }

  function defaultTitleOverrideTargetId(targetType: NonNullable<CalendarEvent['titleOverrides']>[number]['targetType']) {
    if (targetType === ALL_DEPARTMENTS_EXCEPT_OWN) return ownDepartmentId
    if (targetType === ALL_EMPLOYEES_EXCEPT_SELF) return employeeId ?? ''
    return targetType === 'department'
      ? (departments[0]?.id ?? '')
      : (employees.find((emp) => employeeActiveForCalendar(emp))?.id ?? '')
  }

  function updateTitleOverride(index: number, patch: Partial<NonNullable<CalendarEvent['titleOverrides']>[number]>) {
    setEventForm((form) => ({
      ...form,
      titleOverrides: form.titleOverrides.map((item, itemIndex) => (
        itemIndex === index ? { ...item, ...patch } : item
      ))
    }))
  }

  function removeTitleOverride(index: number) {
    setEventForm((form) => ({
      ...form,
      titleOverrides: form.titleOverrides.filter((_, itemIndex) => itemIndex !== index)
    }))
  }

  function toggleAllDepartmentsVisible() {
    setEventForm((form) => {
      const selectedDepartmentName = departmentName(form.departmentId)
      const departmentIds = departments
        .filter((department) => department.id !== form.departmentId && department.name !== selectedDepartmentName)
        .map((department) => department.id)
      const selected = departmentIds.length > 0 && departmentIds.every((id) => form.visibleDepartmentIds.includes(id))
      return {
        ...form,
        visibleDepartmentIds: selected
          ? form.visibleDepartmentIds.filter((id) => !departmentIds.includes(id))
          : Array.from(new Set([...form.visibleDepartmentIds, ...departmentIds]))
      }
    })
  }

  function requiredAssigneeIds(ids: string[]) {
    return Array.from(new Set(ids))
  }

  function goToday() {
    const today = dayjs()
    setMonth(today.startOf('month'))
    setSelectedDate(today.format('YYYY-MM-DD'))
  }

  function movePeriod(direction: -1 | 1) {
    if (viewMode === 'week') {
      const nextDate = dayjs(selectedDate).add(direction, 'week')
      setSelectedDate(nextDate.format('YYYY-MM-DD'))
      setMonth(nextDate.startOf('month'))
      return
    }
    const nextMonth = month.add(direction, 'month')
    setMonth(nextMonth)
  }

  function openMonthPicker() {
    const input = monthInputRef.current
    if (!input) return
    const pickerInput = input as HTMLInputElement & { showPicker?: () => void }
    pickerInput.showPicker?.()
    input.focus()
  }

  function changeMonth(value: string) {
    const nextMonth = dayjs(`${value}-01`)
    if (!nextMonth.isValid()) return
    setMonth(nextMonth.startOf('month'))
    setSelectedDate(nextMonth.startOf('month').format('YYYY-MM-DD'))
  }

  function canSwipeCalendarWithTouch(event?: ReactTouchEvent<HTMLElement>) {
    const touchDrag = dayListTouchDragRef.current
    const canSwipeWithSecondTouch = Boolean(touchDrag?.dragging && event && event.touches.length >= 2)
    return (viewMode === 'month' || viewMode === 'week') &&
      !showEventModal &&
      !selectedEventId &&
      !dragActionMenu &&
      (!touchDrag || canSwipeWithSecondTouch) &&
      !dayListDate
  }

  function handleCalendarTouchStart(event: ReactTouchEvent<HTMLElement>) {
    if (!canSwipeCalendarWithTouch(event)) return
    const touch = event.changedTouches[0] ?? event.touches[0]
    if (!touch) return
    setCalendarSwipeAnimating(false)
    calendarTouchStartRef.current = { identifier: touch.identifier, x: touch.clientX, y: touch.clientY, deltaX: 0, deltaY: 0, dragging: false }
  }

  function handleCalendarTouchMove(event: ReactTouchEvent<HTMLElement>) {
    const start = calendarTouchStartRef.current
    if (!start || (viewMode !== 'month' && viewMode !== 'week')) return
    const touch = Array.from(event.touches).find((item) => item.identifier === start.identifier)
    if (!touch) return
    const deltaX = touch.clientX - start.x
    const deltaY = touch.clientY - start.y
    start.deltaX = deltaX
    start.deltaY = deltaY
    if (viewMode === 'month' && Math.abs(deltaY) > 6 && Math.abs(deltaY) > Math.abs(deltaX)) {
      event.preventDefault()
    }
    if (!start.dragging) {
      if (Math.abs(deltaX) < 8) return
      if (Math.abs(deltaX) < Math.abs(deltaY) * 1.15) {
        calendarTouchStartRef.current = null
        setCalendarSwipeOffset(0)
        return
      }
      start.dragging = true
    }
    event.preventDefault()
    const width = calendarSurfaceRef.current?.clientWidth ?? window.innerWidth
    const maxOffset = Math.max(90, width * 0.48)
    setCalendarSwipeOffset(Math.max(-maxOffset, Math.min(maxOffset, deltaX)))
  }

  function handleCalendarTouchEnd(event: ReactTouchEvent<HTMLElement>) {
    const start = calendarTouchStartRef.current
    const touch = start ? Array.from(event.changedTouches).find((item) => item.identifier === start.identifier) : null
    if (!start || !touch) return
    calendarTouchStartRef.current = null
    const deltaX = start.deltaX || (touch.clientX - start.x)
    const deltaY = start.deltaY || (touch.clientY - start.y)
    if (!start.dragging) {
      setCalendarSwipeOffset(0)
      return
    }
    const width = calendarSurfaceRef.current?.clientWidth ?? window.innerWidth
    const shouldChangePeriod = Math.abs(deltaX) >= Math.min(120, width * 0.22) && Math.abs(deltaX) > Math.abs(deltaY) * 1.15
    setCalendarSwipeAnimating(true)
    if (!shouldChangePeriod) {
      setCalendarSwipeOffset(0)
      window.setTimeout(() => setCalendarSwipeAnimating(false), 210)
      return
    }
    const direction = deltaX < 0 ? 1 : -1
    setCalendarSwipeOffset(direction === 1 ? -width : width)
    window.setTimeout(() => {
      movePeriod(direction)
      setCalendarSwipeAnimating(false)
      setCalendarSwipeOffset(0)
    }, 190)
  }

  function lockEventEditorTouch(ms = 500) {
    if (eventEditorTouchLockTimerRef.current !== null) {
      window.clearTimeout(eventEditorTouchLockTimerRef.current)
    }
    setEventEditorTouchLocked(true)
    eventEditorTouchLockTimerRef.current = window.setTimeout(() => {
      eventEditorTouchLockTimerRef.current = null
      setEventEditorTouchLocked(false)
    }, ms)
  }

  function clearMonthLongPressGuard() {
    const guard = monthLongPressRef.current
    if (guard?.timer) window.clearTimeout(guard.timer)
    monthLongPressRef.current = null
  }

  function monthLongPressTarget(target: EventTarget | null) {
    if (viewMode !== 'month' || !shouldUseMobileEventListFlow()) return false
    if (!(target instanceof Element)) return false
    if (target.closest('.event-pill, .event-line, .week-event, .event-drag-menu, .event-drag-preview, .tt-day-list-panel')) return false
    const dateElement = target.closest<HTMLElement>('.month-grid [data-calendar-date]')
    if (!dateElement?.dataset.calendarDate) return false
    return {
      date: dateElement.dataset.calendarDate,
      shouldOpenAdd: canCreateEvent
    }
  }

  function handleMonthLongPressStart(event: ReactTouchEvent<HTMLElement>) {
    const target = monthLongPressTarget(event.target)
    if (!target || event.touches.length !== 1) return
    const touch = event.changedTouches[0] ?? event.touches[0]
    if (!touch) return
    clearMonthLongPressGuard()
    const identifier = touch.identifier
    const startX = touch.clientX
    const startY = touch.clientY
    const timer = window.setTimeout(() => {
      const guard = monthLongPressRef.current
      if (!guard || guard.identifier !== identifier) return
      guard.triggered = true
      suppressEventClickRef.current = true
      window.getSelection?.()?.removeAllRanges()
      setDragActionMenu(null)
      setDragOverDateIfChanged(null)
      if (guard.shouldOpenAdd) {
        setDayListDate(null)
        lockEventEditorTouch()
        openAddEvent(guard.date)
      }
    }, 1000)
    monthLongPressRef.current = { identifier, x: startX, y: startY, timer, triggered: false, date: target.date, shouldOpenAdd: target.shouldOpenAdd }
  }

  function handleMonthLongPressMove(event: ReactTouchEvent<HTMLElement>) {
    const guard = monthLongPressRef.current
    if (!guard) return
    const touch = Array.from(event.touches).find((item) => item.identifier === guard.identifier)
    if (!touch) return
    const distance = Math.abs(touch.clientX - guard.x) + Math.abs(touch.clientY - guard.y)
    if (distance > 28) clearMonthLongPressGuard()
  }

  function handleMonthLongPressEnd(event: ReactTouchEvent<HTMLElement>) {
    const guard = monthLongPressRef.current
    if (!guard) return
    const triggered = guard.triggered
    clearMonthLongPressGuard()
    if (!triggered) return
    event.preventDefault()
    event.stopPropagation()
    suppressEventClickRef.current = true
    window.setTimeout(() => {
      suppressEventClickRef.current = false
    }, 350)
  }

  function openAddEvent(date = selectedDate) {
    if (!canCreateEvent) return
    const clickedCalendar = writableCalendars.find((calendar) => (
      calendar.id === lastSelectedCalendarId && selectedCalendarIds.includes(calendar.id)
    ))
    const defaultCalendar = clickedCalendar ?? writableCalendars.find((calendar) => (
      Boolean(currentEmployeeDepartmentId && calendar.departmentIds.includes(currentEmployeeDepartmentId)) ||
      Boolean(currentEmployeeDepartmentName && calendar.name === currentEmployeeDepartmentName)
    )) ?? writableCalendars[0]
    const defaultDepartmentId = defaultCalendar?.departmentIds[0] ?? currentEmployeeDepartmentId ?? departments.find((department) => department.name === currentEmployeeDepartmentName)?.id ?? ''
    const defaultTitleIcon = departmentTitleIconDefaults[defaultDepartmentId]?.[0] ?? ''
    setEventForm({
      ...emptyEvent,
      title: defaultTitleIcon ? composeTitleWithIcon(defaultTitleIcon, '', titleIconOptions) : '',
      date,
      endDate: date,
      calendarId: defaultCalendar?.id ?? '',
      calendarIds: defaultCalendar?.id ? [defaultCalendar.id] : [],
      departmentId: defaultDepartmentId,
      assigneeIds: requiredAssigneeIds([])
    })
    resetAttachmentUploadState()
    setDeletedAttachments([])
    setEditingEventId(null)
    setEditingEventSnapshot(null)
    setCopySourceEvent(null)
    setRecurrenceEditMode(null)
    setRecurrenceEditCandidate(null)
    setShowTitleIconPicker(false)
    setShowTitleSuggestions(false)
    setShowRepeatPicker(false)
    setShowRepeatCustomModal(false)
    setShowVisibilityEditor(false)
    setShowEventModal(true)
  }

  function openEventDetail(event: CalendarEvent, options: { preserveMonth?: boolean } = {}) {
    prefetchCombinedDelivery(event)
    setDragActionMenu(null)
    eventDetailReturnDayListDateRef.current = dayListDate
    setDayListDate(null)
    setSelectedDeliveryGroupKey(null)
    setShowEventActionMenu(false)
    setSelectedDate(event.date)
    if (!options.preserveMonth && !dayjs(event.date).isSame(month, 'month')) {
      setMonth(dayjs(event.date).startOf('month'))
    }
    setSelectedEventSnapshot(event)
    setSelectedEventId(event.id)
    if (showNotificationsPanel) markActivityNotificationsSeen()
    setShowNotificationsPanel(false)
    setShowSearchPanel(false)
  }

  async function openActivityLogEvent(log: CalendarActivityLog) {
    if (!log.eventId || log.action === 'delete' || openingActivityEventId) return
    setOpeningActivityEventId(log.eventId)
    try {
      const loadedEvent = events.find((event) => event.id === log.eventId)
      if (loadedEvent && eventAllowedForViewer(loadedEvent)) {
        openEventDetail(loadedEvent)
        return
      }

      const eventSnap = await getCalendarEventSnapshot(log.eventId)
      if (!eventSnap.exists()) {
        alert('此事件已不存在或已被刪除')
        return
      }
      const event = { id: eventSnap.id, ...eventSnap.data() } as CalendarEvent
      if (!eventAllowedForViewer(event)) {
        alert('您目前沒有此事件的檢視權限')
        return
      }
      openEventDetail(event)
    } catch {
      alert('目前無法開啟此事件，請稍後再試')
    } finally {
      setOpeningActivityEventId(null)
    }
  }

  function openDeliveryGroup(item: CalendarDayDisplayItem) {
    void loadCombinedDeliveryStatuses(item.events.filter((event) => event.sourceShippingMethod === '外送' && !isCalendarEventCompleted(event)))
    setDragActionMenu(null)
    setShowEventActionMenu(false)
    setSelectedEventId(null)
    setSelectedDate(item.primaryEvent.date)
    setSelectedDeliveryGroupKey(item.key)
    if (showNotificationsPanel) markActivityNotificationsSeen()
    setShowNotificationsPanel(false)
    setShowSearchPanel(false)
  }

  function openEditEvent(event: CalendarEvent) {
    if (!canEditOrCopyErpEvent(employeeId, event)) {
      alert('沒有 ERP 事件的編輯權限')
      return
    }
    if (isHrReadonlyEvent(event)) {
      alert('此事件來自 HR 後台，請至 HR 後台編輯')
      return
    }
    if (!canManageCalendarEvent(event)) {
      alert('沒有此事件的編輯權限')
      return
    }
    if (canUseRecurrenceScope(event)) {
      setRecurrenceEditCandidate(event)
      return
    }
    startEditEvent(event, 'all')
  }

  function openCopyEvent(event: CalendarEvent, copyDate?: string) {
    if (!canEditOrCopyErpEvent(employeeId, event)) {
      alert('沒有 ERP 事件的複製權限')
      return
    }
    if (!canCreateEvent) {
      alert('沒有新增事件的權限')
      return
    }
    if (isErpSalesDeliveryEvent(event) && (!event.sourceId?.trim() || !erpSalesDeliveryPrimaryEventId(event))) {
      alert('此 ERP 事件的銷貨關聯不完整，請先重新整理後再複製。')
      return
    }
    lockEventEditorTouch()
    const targetDate = copyDate || selectedDate || event.date
    const range = shiftedEventDateRange(event, targetDate)
    const hiddenDepartmentIds = event.hiddenDepartmentIds ?? []
    const hiddenAssigneeIds = event.hiddenAssigneeIds ?? []
    const visibleDepartmentIds = event.visibleDepartmentIds ?? []
    const visibleAssigneeIds = event.visibleAssigneeIds ?? []
    const titleOverrides = event.titleOverrides ?? []
    setEventForm({
      calendarId: eventDisplayCalendarId(event),
      calendarIds: eventDisplayCalendarIds(event),
      title: event.title,
      date: range.date,
      endDate: eventEndDate(range),
      startTime: event.startTime,
      endTime: event.endTime,
      allDay: !!event.allDay,
      departmentId: event.departmentId,
      assigneeIds: event.assigneeIds ?? [],
      visibleDepartmentIds,
      visibleAssigneeIds,
      visibilityEnabled: Boolean(visibleDepartmentIds.length || visibleAssigneeIds.length || hiddenDepartmentIds.length || hiddenAssigneeIds.length || titleOverrides.length),
      hiddenDepartmentIds,
      hiddenAssigneeIds,
      titleOverrides,
      note: event.note ?? '',
      reminder: event.reminder ?? 'none',
      repeat: 'none',
      repeatCustom: emptyEvent.repeatCustom,
      todos: (event.todos ?? []).map((todo) => ({
        id: createClientId(),
        text: todo.text,
        done: false
      })),
      location: event.location ?? '',
      url: event.url ?? '',
      attachments: event.attachments ?? []
    })
    resetAttachmentUploadState()
    setDeletedAttachments([])
    setEditingEventId(null)
    setEditingEventSnapshot(null)
    setCopySourceEvent(event)
    setRecurrenceEditMode(null)
    setRecurrenceEditCandidate(null)
    setShowTitleIconPicker(false)
    setShowTitleSuggestions(false)
    setShowRepeatPicker(false)
    setShowRepeatCustomModal(false)
    setSelectedEventId(null)
    setShowVisibilityEditor(Boolean(visibleDepartmentIds.length || visibleAssigneeIds.length || hiddenDepartmentIds.length || hiddenAssigneeIds.length || titleOverrides.length))
    setShowEventModal(true)
  }

  function canUseRecurrenceScope(event: CalendarEvent) {
    if (isRepeatingEvent(event)) return true
    if (!isRecurrenceOccurrence(event)) return false
    const rootEvent = events.find((item) => item.id === recurrenceRootId(event))
    return Boolean(rootEvent && isRepeatingEvent(rootEvent))
  }

  function startEditEvent(event: CalendarEvent, scope: RecurrenceEditScope) {
    if (!canEditOrCopyErpEvent(employeeId, event)) {
      alert('沒有 ERP 事件的編輯權限')
      return
    }
    const rootEvent = events.find((item) => item.id === recurrenceRootId(event)) ?? event
    const sourceDate = recurrenceSourceDate(event)
    const formDate = scope === 'all' ? rootEvent.date : sourceDate
    const range = shiftedEventDateRange(rootEvent, formDate)
    setEventForm({
      calendarId: eventDisplayCalendarId(rootEvent),
      calendarIds: eventDisplayCalendarIds(rootEvent),
      title: eventDisplayTitle(rootEvent),
      date: range.date,
      endDate: eventEndDate(range),
      startTime: rootEvent.startTime,
      endTime: rootEvent.endTime,
      allDay: !!rootEvent.allDay,
      departmentId: rootEvent.departmentId,
      assigneeIds: requiredAssigneeIds(rootEvent.assigneeIds ?? []),
      visibilityEnabled: Boolean(
        rootEvent.visibleDepartmentIds?.length ||
        rootEvent.visibleAssigneeIds?.length ||
        rootEvent.hiddenDepartmentIds?.length ||
        rootEvent.hiddenAssigneeIds?.length ||
        rootEvent.titleOverrides?.length
      ),
      visibleDepartmentIds: rootEvent.visibleDepartmentIds ?? [],
      visibleAssigneeIds: rootEvent.visibleAssigneeIds ?? [],
      hiddenDepartmentIds: rootEvent.hiddenDepartmentIds ?? [],
      hiddenAssigneeIds: rootEvent.hiddenAssigneeIds ?? [],
      titleOverrides: rootEvent.titleOverrides ?? [],
      note: rootEvent.note ?? '',
      reminder: rootEvent.reminder ?? 'none',
      repeat: scope === 'single' ? 'none' : (rootEvent.repeat ?? 'none'),
      repeatCustom: rootEvent.repeatCustom ?? emptyEvent.repeatCustom,
      todos: rootEvent.todos ?? [],
      location: rootEvent.location ?? '',
      url: rootEvent.url ?? '',
      attachments: rootEvent.attachments ?? []
    })
    resetAttachmentUploadState()
    setDeletedAttachments([])
    setEditingEventId(rootEvent.id)
    setEditingEventSnapshot(rootEvent)
    setCopySourceEvent(null)
    setRecurrenceEditMode(isRepeatingEvent(rootEvent) ? { scope, source: event } : null)
    setRecurrenceEditCandidate(null)
    setShowTitleIconPicker(false)
    setShowTitleSuggestions(false)
    setShowRepeatPicker(false)
    setShowRepeatCustomModal(false)
    setShowVisibilityEditor(Boolean(
      rootEvent.visibleDepartmentIds?.length ||
      rootEvent.visibleAssigneeIds?.length ||
      rootEvent.hiddenDepartmentIds?.length ||
      rootEvent.hiddenAssigneeIds?.length ||
      rootEvent.titleOverrides?.length
    ))
    setShowEventModal(true)
  }

  async function refreshCalendarData() {
    await Promise.all([
      queryClient.refetchQueries({ queryKey: ['calendarEvents'], type: 'active' }),
      queryClient.invalidateQueries({ queryKey: ['calendarCalendars'] }),
      queryClient.invalidateQueries({ queryKey: ['calendarEventsSearchIndex'] }),
      queryClient.invalidateQueries({ queryKey: ['calendarActivityLogs'] }),
      queryClient.invalidateQueries({ queryKey: ['erp-sales-delivery-relation-index'] }),
      queryClient.invalidateQueries({ queryKey: ['erp-sales-delivery-related-events'] })
    ])
  }

  function addTodoItem() {
    setEventForm((form) => ({
      ...form,
      todos: [...form.todos, { id: createClientId(), text: '', done: false }]
    }))
  }

  function updateTodoItem(id: string, changes: Partial<NonNullable<CalendarEvent['todos']>[number]>) {
    setEventForm((form) => ({
      ...form,
      todos: form.todos.map((todo) => todo.id === id ? { ...todo, ...changes } : todo)
    }))
  }

  function removeTodoItem(id: string) {
    setEventForm((form) => ({
      ...form,
      todos: form.todos.filter((todo) => todo.id !== id)
    }))
  }

  async function changeReminder(reminder: CalendarEvent['reminder']) {
    setEventForm((form) => ({ ...form, reminder }))
    if (reminder && reminder !== 'none' && 'Notification' in window && Notification.permission === 'default') {
      try {
        const permission = await Notification.requestPermission()
        setNotificationPermission(permission)
      } catch {
        alert('通知權限啟用失敗，請確認瀏覽器設定')
      }
    }
  }

  async function enableCalendarNotifications() {
    if (!('Notification' in window)) {
      alert('此瀏覽器不支援通知功能')
      return
    }
    try {
      const permission = await Notification.requestPermission()
      setNotificationPermission(permission)
      if (permission === 'granted') {
        await ensurePushSubscription({ role, employeeId, displayName })
      }
      if (permission !== 'granted') {
        alert('通知尚未啟用，請到瀏覽器或手機設定允許通知')
      }
    } catch {
      alert('通知權限啟用失敗，請確認瀏覽器設定')
    }
  }

  function dismissStartupNotificationPrompt() {
    setShowStartupNotificationPrompt(false)
  }

  async function enableStartupNotifications() {
    if (!('Notification' in window)) {
      dismissStartupNotificationPrompt()
      return
    }
    try {
      const permission = await Notification.requestPermission()
      setNotificationPermission(permission)
      if (permission === 'granted') {
        await ensurePushSubscription({ role, employeeId, displayName })
      }
    } finally {
      dismissStartupNotificationPrompt()
    }
  }

  async function saveNotificationSettings() {
    if (!user?.uid) return
    setSavingNotificationSettings(true)
    try {
      if (
        (notificationSettings.shiftStartEnabled ||
          notificationSettings.shiftEndEnabled) &&
        'Notification' in window &&
        Notification.permission === 'default'
      ) {
        const permission = await Notification.requestPermission()
        setNotificationPermission(permission)
      }
      const payload: UserNotificationSettings = {
        ...notificationSettings,
        updatedAt: new Date().toISOString()
      }
      const token = await getFirebaseIdToken(user)
      const controller = new AbortController()
      const timeout = window.setTimeout(() => controller.abort(), 12000)
      try {
        const appCheckHeaders = await getAppCheckHeaders(true)
        const res = await fetch('/api/save-calendar-notification-settings', {
          method: 'POST',
          headers: {
            ...appCheckHeaders,
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`
          },
          body: JSON.stringify({ settings: payload }),
          signal: controller.signal
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const result = await res.json().catch(() => null) as { settings?: UserNotificationSettings } | null
        setNotificationSettings(result?.settings ?? payload)
      } finally {
        window.clearTimeout(timeout)
      }
      setShowNotificationSettings(false)
    } catch {
      alert('通知設定儲存失敗，請稍後再試')
    } finally {
      setSavingNotificationSettings(false)
    }
  }

  function openPasswordModal() {
    setPasswordForm({ next: '', confirm: '' })
    setPasswordError('')
    setPasswordSuccess('')
    setShowPasswordModal(true)
  }

  useEffect(() => {
    if (!user || !canScanSalesOrder) return
    const timer = window.setTimeout(() => {
      void preloadErpOrderScannerModule().catch(() => undefined)
    }, 250)
    return () => window.clearTimeout(timer)
  }, [canScanSalesOrder, user])

  function openErpOrderScan() {
    if (!auth.currentUser) {
      alert('登入已失效，請重新登入')
      return
    }
    if (!canScanSalesOrder) {
      alert('您沒有掃描銷貨單的權限')
      return
    }
    setShowErpOrderScanner(true)
  }

  async function savePasswordChange() {
    if (!auth.currentUser) return
    if (!passwordForm.next || !passwordForm.confirm) {
      setPasswordError('請完整輸入新密碼')
      return
    }
    if (passwordForm.next.length < 6) {
      setPasswordError('新密碼至少需要 6 個字元')
      return
    }
    if (passwordForm.next !== passwordForm.confirm) {
      setPasswordError('新密碼與確認密碼不一致')
      return
    }
    setSavingPassword(true)
    setPasswordError('')
    setPasswordSuccess('')
    try {
      const token = await getFirebaseIdToken(auth.currentUser)
      const response = await fetch(import.meta.env.VITE_CHANGE_PASSWORD_API_URL || 'https://sch.city-painter.com/api/change-password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ password: passwordForm.next }),
      })
      if (!response.ok) {
        const result = await response.json().catch(() => null) as { error?: string } | null
        throw new Error(result?.error || '密碼更新失敗')
      }
      setPasswordForm({ next: '', confirm: '' })
      setPasswordSuccess('密碼已更新')
    } catch (error) {
      const code = (error as { code?: string; message?: string }).code
      const message = (error as { message?: string }).message
      if (code === 'auth/weak-password' || message?.includes('at least 6')) {
        setPasswordError('新密碼強度不足')
      } else {
        setPasswordError('密碼更新失敗，請稍後再試')
      }
    } finally {
      setSavingPassword(false)
    }
  }

  function markActivityNotificationsSeen() {
    const latest = visibleActivityLogs[0]?.createdAt ?? new Date().toISOString()
    writeBrowserValue(ACTIVITY_NOTIFICATION_SEEN_KEY, latest)
    setLastSeenActivityAt(latest)
    void setLocalBadge(0)
  }

  function changeRepeat(repeat: CalendarEvent['repeat']) {
    if (repeat === 'custom') {
      setEventForm((form) => ({ ...form, repeatCustom: form.repeatCustom ?? emptyEvent.repeatCustom }))
      setShowRepeatPicker(false)
      setShowRepeatCustomModal(true)
      return
    }
    setEventForm((form) => ({ ...form, repeat, repeatCustom: form.repeatCustom ?? emptyEvent.repeatCustom }))
    setShowRepeatPicker(false)
  }

  function updateCustomRepeat(changes: Partial<NonNullable<CalendarEvent['repeatCustom']>>) {
    setEventForm((form) => ({
      ...form,
      repeatCustom: {
        ...(form.repeatCustom ?? emptyEvent.repeatCustom),
        ...changes
      }
    }))
  }

  function chooseTitleIcon(icon: string) {
    setEventForm((form) => ({
      ...form,
      title: composeTitleWithIcon(icon, form.title, titleIconOptions)
    }))
    setShowTitleIconPicker(false)
  }

  function chooseTitleOverrideIcon(index: number, icon: string) {
    setEventForm((form) => ({
      ...form,
      titleOverrides: form.titleOverrides.map((item, itemIndex) => (
        itemIndex === index
          ? { ...item, icon, title: titleWithoutKnownIcon(item.title, titleIconOptions) }
          : item
      ))
    }))
    setTitleOverrideIconPickerIndex(null)
  }

  function openTitleIconSettings() {
    setTitleIconDraft(titleIconOptions)
    setDepartmentTitleIconDraft(departmentTitleIconDefaults)
    setShowTitleIconSettings(true)
  }

  function updateTitleIconDraft(index: number, changes: Partial<TitleIconOption>) {
    setTitleIconDraft((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, ...changes } : item))
  }

  function reorderTitleIconDraft(fromIndex: number, toIndex: number) {
    setTitleIconDraft((items) => {
      if (
        fromIndex === toIndex ||
        fromIndex < 0 ||
        toIndex < 0 ||
        fromIndex >= items.length ||
        toIndex >= items.length
      ) {
        return items
      }
      const next = [...items]
      const [movedItem] = next.splice(fromIndex, 1)
      next.splice(toIndex, 0, movedItem)
      return next
    })
  }

  function startTitleIconDrag(event: DragEvent<HTMLButtonElement>, index: number) {
    titleIconDragIndexRef.current = index
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', String(index))
  }

  function moveTitleIconDragOver(event: DragEvent<HTMLDivElement>, index: number) {
    const fromIndex = titleIconDragIndexRef.current
    if (fromIndex === null || fromIndex === index) return
    event.preventDefault()
    reorderTitleIconDraft(fromIndex, index)
    titleIconDragIndexRef.current = index
  }

  function endTitleIconDrag() {
    titleIconDragIndexRef.current = null
  }

  function removeTitleIconDraft(index: number) {
    setTitleIconDraft((items) => items.filter((_, itemIndex) => itemIndex !== index))
  }

  function addTitleIconDraft() {
    setTitleIconDraft((items) => [...items, { icon: '', label: '' }])
  }

  function toggleDepartmentTitleIconDraft(departmentId: string, icon: string) {
    setDepartmentTitleIconDraft((draft) => ({
      ...draft,
      [departmentId]: toggle(draft[departmentId] ?? [], icon)
    }))
  }

  async function saveTitleIconSettings() {
    if (!canManageCalendarColors) return
    const options = titleIconDraft
      .map((item) => ({ icon: item.icon.trim(), label: item.label.trim() }))
      .filter((item) => item.icon && item.label)
    if (!options.length) {
      alert('至少保留一個 icon')
      return
    }
    const cleanDepartmentDefaults = Object.fromEntries(
      Object.entries(departmentTitleIconDraft)
        .map(([departmentId, icons]) => [
          departmentId,
          Array.from(new Set((icons ?? [])
            .map((icon) => String(icon || '').trim())
            .filter((icon) => icon && options.some((item) => item.icon === icon))))
        ])
        .filter(([, icons]) => icons.length)
    )
    setSavingTitleIcons(true)
    try {
      await setDoc(doc(db, 'calendarSettings', 'titleIcons'), {
        options,
        departmentDefaults: cleanDepartmentDefaults,
        updatedAt: new Date().toISOString(),
        updatedBy: user?.uid ?? ''
      }, { merge: true })
      setTitleIconOptions(options)
      setTitleIconDraft(options)
      setDepartmentTitleIconDefaults(cleanDepartmentDefaults)
      setDepartmentTitleIconDraft(cleanDepartmentDefaults)
      setShowTitleIconSettings(false)
    } catch (error) {
      console.warn('[calendar] save title icon settings failed', error)
      alert(error instanceof Error ? `標題 icon 設定儲存失敗：${error.message}` : '標題 icon 設定儲存失敗')
    } finally {
      setSavingTitleIcons(false)
    }
  }

  function applyTitleSuggestion(event: CalendarEvent) {
    setEventForm((form) => ({
      ...form,
      title: eventDisplayTitle(event),
      location: event.location ?? '',
      url: event.url ?? '',
      note: event.note ?? '',
      todos: (event.todos ?? []).map((todo) => ({
        id: createClientId(),
        text: todo.text,
        done: false
      }))
    }))
    setShowTitleSuggestions(false)
  }

  async function saveCalendar() {
    if (!calendarForm.name.trim()) {
      alert('請輸入行事曆名稱')
      return
    }

    setSaving(true)
    try {
      const payload = {
        name: calendarForm.name.trim(),
        color: calendarForm.color,
        departmentIds: calendarForm.isCompanyWide ? [] : calendarForm.departmentIds,
        employeeIds: calendarForm.isCompanyWide ? [] : calendarForm.employeeIds,
        isCompanyWide: calendarForm.isCompanyWide,
        updatedAt: new Date().toISOString()
      }

      if (editingCalendarId) {
        await updateDoc(doc(db, 'calendarCalendars', editingCalendarId), payload)
      } else {
        await addDoc(collection(db, 'calendarCalendars'), {
          ...payload,
          createdBy: user?.uid ?? '',
          createdAt: new Date().toISOString()
        })
      }

      setShowCalendarModal(false)
      await refreshCalendarData()
    } catch {
      alert('行事曆儲存失敗')
    } finally {
      setSaving(false)
    }
  }

  async function updateCalendarColor(calendar: DisplayCalendar, color: string) {
    if (!canManageCalendarColors) return
    const departmentId = calendar.departmentIds[0]
    const docId = calendar.systemKind === 'department'
      ? departmentCalendarDocId(departmentId)
      : calendar.id
    if (!docId) return

    try {
      await setDoc(doc(db, 'calendarCalendars', docId), {
        name: calendar.name,
        color,
        departmentIds: calendar.systemKind === 'department' ? [departmentId] : calendar.departmentIds,
        employeeIds: calendar.employeeIds,
        isCompanyWide: calendar.systemKind === 'department' ? false : calendar.isCompanyWide,
        updatedAt: new Date().toISOString(),
        createdBy: user?.uid ?? ''
      }, { merge: true })
      await queryClient.invalidateQueries({ queryKey: ['calendarCalendars'] })
    } catch {
      alert('行事曆顏色儲存失敗')
    }
  }

  async function syncSalesDeliveryEventFields(
    event: CalendarEvent,
    nextEvent: Pick<CalendarEvent, 'title' | 'date' | 'endDate' | 'startTime' | 'endTime' | 'allDay' | 'location'>,
    calendarTitle: string,
  ) {
    if (!user) throw new Error('尚未登入')
    const [token, appCheckHeaders] = await Promise.all([
      getFirebaseIdToken(user),
      getAppCheckHeaders(),
    ])
    const response = await fetch('/api/upload-drive', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...appCheckHeaders,
      },
      body: JSON.stringify({
        action: SALES_DELIVERY_EVENT_SYNC_ACTION,
        eventId: event.id,
        calendarTitle,
        expected: salesDeliveryEventSyncFields(event),
        event: salesDeliveryEventSyncFields(nextEvent),
      }),
    })
    const result = await response.json().catch(() => null) as { error?: string } | null
    if (!response.ok) {
      throw new Error(result?.error || `銷貨單同步失敗（HTTP ${response.status}）`)
    }
  }

  async function syncRelatedSalesDeliveryEvent(
    event: CalendarEvent,
    payload: RelatedSalesDeliveryEventSyncInput,
  ) {
    if (!user) throw new Error('尚未登入')
    const primaryEventId = erpSalesDeliveryPrimaryEventId(event)
    const sourceId = event.sourceId?.trim() || ''
    if (!primaryEventId || primaryEventId === event.id || !sourceId) {
      throw new Error('附屬事件未綁定有效的 ERP 主事件')
    }
    const relationEvents = await queryClient.ensureQueryData({
      queryKey: ['erp-sales-delivery-related-events', sourceId],
      queryFn: () => fetchRelatedSalesDeliveryEvents(sourceId),
      staleTime: 2 * 60 * 1000,
    })
    const primaryEvent = relationEvents.find((item) => item.id === primaryEventId)
    if (!primaryEvent) throw new Error('ERP 主事件已不存在或無法檢視，請重新整理後再試')
    if (!isPrimaryErpSalesDeliveryEvent(primaryEvent) || primaryEvent.sourceId !== event.sourceId) {
      throw new Error('附屬事件與 ERP 主事件的銷貨關聯不一致，已停止同步')
    }
    const [token, appCheckHeaders] = await Promise.all([
      getFirebaseIdToken(user),
      getAppCheckHeaders(),
    ])
    const expectedRelatedFields = relatedSalesDeliveryEventSyncFields(event)
    const expectedPrimaryFields = relatedSalesDeliveryEventSyncFields(primaryEvent)
    const relatedNextFields = relatedSalesDeliveryEventSyncFields(payload)
    const primaryNextFields = primarySyncFieldsForRelatedEdit(
      expectedPrimaryFields,
      expectedRelatedFields,
      relatedNextFields,
    )
    const response = await fetch('/api/upload-drive', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...appCheckHeaders,
      },
      body: JSON.stringify({
        action: RELATED_SALES_DELIVERY_EVENT_SYNC_ACTION,
        requestId: createClientId(),
        relatedEventId: event.id,
        primaryEventId,
        calendarTitle: titleWithoutKnownIcon(primaryEvent.title, titleIconOptions).trim(),
        expected: {
          related: expectedRelatedFields,
          primary: expectedPrimaryFields,
        },
        events: {
          related: relatedNextFields,
          primary: primaryNextFields,
        },
      }),
    })
    const result = await response.json().catch(() => null) as { error?: string } | null
    if (!response.ok) {
      throw new Error(result?.error || `關聯事件同步失敗（HTTP ${response.status}）`)
    }
  }

  async function saveEvent() {
    const requiredAssignees = requiredAssigneeIds(eventForm.assigneeIds)
    if ((!eventForm.calendarIds.length && !requiredAssignees.length) || !eventForm.title.trim() || !eventForm.date) {
      alert('請填寫標題、日期，並選擇行事曆或指定同仁')
      return
    }
    const normalizedEndDate = dayjs(eventForm.endDate).isBefore(dayjs(eventForm.date), 'day') ? eventForm.date : eventForm.endDate
    const editingEvent = editingEventId
      ? events.find((event) => event.id === editingEventId)
        ?? (editingEventSnapshot?.id === editingEventId ? editingEventSnapshot : null)
      : null
    if (!canEditOrCopyErpEvent(employeeId, editingEvent ?? copySourceEvent)) {
      alert('沒有 ERP 事件的編輯或複製權限')
      return
    }
    if (editingEvent && isHrReadonlyEvent(editingEvent)) {
      alert('此事件來自 HR 後台，請至 HR 後台編輯')
      return
    }
    if (editingEvent?.source === 'erpSalesDelivery') {
      if (eventForm.allDay && isPrimaryErpSalesDeliveryEvent(editingEvent)) {
        alert('銷貨配送事件必須指定開始與結束時間')
        return
      }
      if (!eventForm.allDay) {
        const startAt = dayjs(`${eventForm.date} ${eventForm.startTime}`)
        const endAt = dayjs(`${normalizedEndDate} ${eventForm.endTime}`)
        if (!startAt.isValid() || !endAt.isValid() || !endAt.isAfter(startAt)) {
          alert('收貨結束時間必須晚於開始時間')
          return
        }
      }
      if (!currentTitleText.trim()) {
        alert('行事曆標題不可只有圖示')
        return
      }
    }

    const removedAttachments = [...deletedAttachments]
    const hasUploadingAttachments = attachmentUploads.some((item) => item.status === 'uploading')
    if (hasUploadingAttachments) {
      alert('附件仍在上傳中，請稍候再儲存')
      return
    }
    const failedAttachment = attachmentUploads.find((item) => item.status === 'failed')
    if (failedAttachment) {
      alert(`附件「${failedAttachment.name}」上傳失敗，請刪除後重新選擇`)
      return
    }

    setSaving(true)
    try {
      const now = new Date().toISOString()
      const uploadedAttachments = attachmentUploads
        .map((item) => item.attachment)
        .filter(Boolean) as NonNullable<CalendarEvent['attachments']>
      const selectedCalendarIds = eventForm.calendarIds
      const primaryCalendarId = selectedCalendarIds[0] ?? ''
      const selectedDepartmentId = primaryDepartmentIdFromCalendarIds(selectedCalendarIds, eventForm.departmentId)
      const selectedDepartmentName = departmentName(selectedDepartmentId)
      const visibleDepartmentIds = eventForm.visibleDepartmentIds.filter((id) => (
        id !== selectedDepartmentId && departmentName(id) !== selectedDepartmentName
      ))
      const eventTitle = currentTitleIcon ? composeTitleWithIcon(currentTitleIcon, eventForm.title, titleIconOptions) : eventForm.title.trim()
      const payload = {
        calendarId: primaryCalendarId,
        calendarIds: selectedCalendarIds,
        title: eventTitle,
        date: eventForm.date,
        endDate: normalizedEndDate,
        startTime: eventForm.startTime,
        endTime: eventForm.endTime,
        allDay: !!eventForm.allDay,
        departmentId: selectedDepartmentId,
        assigneeIds: requiredAssignees,
        visibleDepartmentIds: eventForm.visibilityEnabled ? visibleDepartmentIds : [],
        visibleAssigneeIds: eventForm.visibilityEnabled ? eventForm.visibleAssigneeIds : [],
        hiddenDepartmentIds: eventForm.visibilityEnabled ? eventForm.hiddenDepartmentIds : [],
        hiddenAssigneeIds: eventForm.visibilityEnabled ? eventForm.hiddenAssigneeIds : [],
        titleOverrides: eventForm.visibilityEnabled ? eventForm.titleOverrides
          .map((item) => ({ ...item, icon: item.icon?.trim() || undefined, title: titleWithoutKnownIcon(item.title, titleIconOptions).trim() }))
          .filter((item) => item.targetId && item.title) : [],
        note: eventForm.note.trim(),
        reminder: eventForm.reminder ?? 'none',
        repeat: eventForm.repeat ?? 'none',
        repeatCustom: eventForm.repeatCustom ?? emptyEvent.repeatCustom,
        todos: eventForm.todos.map((todo) => ({ ...todo, text: todo.text.trim() })).filter((todo) => todo.text),
        location: eventForm.location.trim(),
        url: eventForm.url.trim(),
        attachments: [...eventForm.attachments, ...uploadedAttachments],
        ...(copySourceEvent ? relatedErpSalesDeliveryFields(copySourceEvent) : {}),
        updatedAt: now
      }
      if (editingEvent && isRelatedErpSalesDeliveryEvent(editingEvent)) {
        const confirmationChanges = eventChangeList(editingEvent, payload).filter((change) => (
          RELATED_SALES_DELIVERY_INDEPENDENT_FIELDS.has(change.field)
          || RELATED_SALES_DELIVERY_SHARED_FIELDS.has(change.field)
        ))
        const independentChanges = confirmationChanges.filter((change) => RELATED_SALES_DELIVERY_INDEPENDENT_FIELDS.has(change.field))
        const addressChanges = confirmationChanges.filter((change) => change.field === 'location')
        const sharedChanges = confirmationChanges.filter((change) => (
          change.field !== 'location' && RELATED_SALES_DELIVERY_SHARED_FIELDS.has(change.field)
        ))
        const formatChanges = (changes: typeof confirmationChanges) => changes.length > 0
          ? changes.map((change) => `${change.label}：「${change.before}」→「${change.after}」`).join('\n')
          : '無'
        const confirmationMessage = [
          '此為附屬事件，確認後才會儲存。',
          '',
          '僅修改此事件的名稱、日期與時間：',
          formatChanges(independentChanges),
          '',
          '地址會同步所有關聯事件與 ERP 銷貨單，並清除舊郵遞區號：',
          formatChanges(addressChanges),
          '',
          '其他共用變更會同步主事件與附屬事件：',
          formatChanges(sharedChanges),
          '',
          '確定儲存？',
        ].join('\n')
        if (!confirm(confirmationMessage)) {
          setSaving(false)
          return
        }
        await syncRelatedSalesDeliveryEvent(editingEvent, payload)
        await refreshCalendarData()
        dismissActiveKeyboard()
        setShowEventModal(false)
        setEditingEventSnapshot(null)
        setCopySourceEvent(null)
        resetAttachmentUploadState()
        setDeletedAttachments([])
        setRecurrenceEditMode(null)
        setSaving(false)
        return
      }

      let savedEventId = editingEventId
      const optimisticPatches: CalendarEvent[] = []
      let backgroundSave: () => Promise<void> = async () => undefined
      if (editingEventId) {
        if (recurrenceEditMode?.scope === 'single' && editingEvent) {
          const sourceDate = recurrenceSourceDate(recurrenceEditMode.source)
          const createdRef = doc(collection(db, 'calendarEvents'))
          const rootPatch: CalendarEvent = {
            ...editingEvent,
            repeatExceptions: Array.from(new Set([...(editingEvent.repeatExceptions ?? []), sourceDate])),
            updatedAt: now
          }
          const createdEvent: CalendarEvent = {
            id: createdRef.id,
            ...payload,
            repeat: 'none',
            repeatCustom: emptyEvent.repeatCustom,
            recurrenceParentId: editingEventId,
            recurrenceOriginalDate: editingEvent.date,
            recurrenceSourceDate: sourceDate,
            done: false,
            createdBy: user?.uid ?? '',
            createdAt: now
          }
          savedEventId = createdRef.id
          optimisticPatches.push(rootPatch, createdEvent)
          backgroundSave = async () => {
            await updateDoc(doc(db, 'calendarEvents', editingEventId), {
              repeatExceptions: arrayUnion(sourceDate),
              updatedAt: now
            })
            const { id: _id, ...createdData } = createdEvent
            await setDoc(createdRef, createdData)
            await writeActivityLog({
              action: 'update',
              eventId: createdRef.id,
              eventTitle: payload.title,
              calendarId: payload.calendarId,
              departmentId: payload.departmentId,
              assigneeIds: payload.assigneeIds,
              date: payload.date,
              changes: eventChangeList(editingEvent, payload)
            })
          }
        } else if (recurrenceEditMode?.scope === 'future' && editingEvent && recurrenceSourceDate(recurrenceEditMode.source) !== editingEvent.date) {
          const sourceDate = recurrenceSourceDate(recurrenceEditMode.source)
          const nextRange = shiftedEventDateRange(payload, sourceDate)
          const createdRef = doc(collection(db, 'calendarEvents'))
          const rootPatch: CalendarEvent = {
            ...editingEvent,
            repeatUntil: dayjs(sourceDate).subtract(1, 'day').format('YYYY-MM-DD'),
            updatedAt: now
          }
          const createdEvent: CalendarEvent = {
            id: createdRef.id,
            ...payload,
            date: sourceDate,
            endDate: nextRange.endDate,
            repeatExceptions: [],
            repeatUntil: '',
            done: false,
            createdBy: user?.uid ?? '',
            createdAt: now
          }
          savedEventId = createdRef.id
          optimisticPatches.push(rootPatch, createdEvent)
          backgroundSave = async () => {
            await updateDoc(doc(db, 'calendarEvents', editingEventId), {
              repeatUntil: rootPatch.repeatUntil,
              updatedAt: now
            })
            const { id: _id, ...createdData } = createdEvent
            await setDoc(createdRef, createdData)
            await writeActivityLog({
              action: 'update',
              eventId: createdRef.id,
              eventTitle: payload.title,
              calendarId: payload.calendarId,
              departmentId: payload.departmentId,
              assigneeIds: payload.assigneeIds,
              date: sourceDate,
              changes: eventChangeList(editingEvent, payload)
            })
          }
        } else {
          const updatedEvent: CalendarEvent = {
            ...(editingEvent ?? {} as CalendarEvent),
            ...payload,
            id: editingEventId,
            done: editingEvent?.done ?? false,
            createdBy: editingEvent?.createdBy ?? user?.uid ?? '',
            createdAt: editingEvent?.createdAt ?? now
          }
          optimisticPatches.push(updatedEvent)
          const changes = editingEvent ? eventChangeList(editingEvent, payload) : []
          backgroundSave = async () => {
            if (editingEvent && isPrimaryErpSalesDeliveryEvent(editingEvent)) {
              await syncSalesDeliveryEventFields(editingEvent, payload, currentTitleText.trim())
              const eventOnlyPayload = withoutSalesDeliveryEventSyncFields(payload)
              if (Object.keys(eventOnlyPayload).length > 0) {
                await updateDoc(doc(db, 'calendarEvents', editingEventId), eventOnlyPayload)
              }
            } else {
              await updateDoc(doc(db, 'calendarEvents', editingEventId), payload)
            }
            if (editingEvent && changes.length) {
              await writeActivityLog({
                action: 'update',
                eventId: editingEventId,
                eventTitle: payload.title,
                calendarId: payload.calendarId,
                departmentId: payload.departmentId,
                assigneeIds: payload.assigneeIds,
                date: payload.date,
                changes
              })
            }
          }
        }
      } else {
        const createdRef = doc(collection(db, 'calendarEvents'))
        const createdEvent: CalendarEvent = {
          id: createdRef.id,
          ...payload,
          done: false,
          createdBy: user?.uid ?? '',
          createdAt: now
        }
        savedEventId = createdRef.id
        optimisticPatches.push(createdEvent)
        backgroundSave = async () => {
          const { id: _id, ...createdData } = createdEvent
          await setDoc(createdRef, createdData)
          await writeActivityLog({
            action: copySourceEvent ? 'copy' : 'create',
            eventId: createdRef.id,
            ...(copySourceEvent ? { sourceEventId: copySourceEvent.id } : {}),
            eventTitle: payload.title,
            calendarId: payload.calendarId,
            departmentId: payload.departmentId,
            assigneeIds: payload.assigneeIds,
            date: payload.date,
            ...(copySourceEvent ? {
              changes: [{
                field: 'date',
                label: '日期',
                before: copySourceEvent.date,
                after: payload.date,
              }],
            } : {}),
          })
        }
      }

      const shouldAwaitPrimaryAddressSync = Boolean(
        editingEvent
        && isPrimaryErpSalesDeliveryEvent(editingEvent)
        && (editingEvent.location ?? '').trim() !== payload.location,
      )
      if (shouldAwaitPrimaryAddressSync) {
        await backgroundSave()
        await refreshCalendarData()
        dismissActiveKeyboard()
        setShowEventModal(false)
        setEditingEventSnapshot(null)
        setCopySourceEvent(null)
        resetAttachmentUploadState()
        setDeletedAttachments([])
        setRecurrenceEditMode(null)
        setSaving(false)
        return
      }

      optimisticallyPatchCalendarEvents(optimisticPatches)
      dismissActiveKeyboard()
      setShowEventModal(false)
      setEditingEventSnapshot(null)
      setCopySourceEvent(null)
      resetAttachmentUploadState()
      setDeletedAttachments([])
      setRecurrenceEditMode(null)
      setSaving(false)
      void (async () => {
        try {
          await backgroundSave()
          await refreshCalendarData()
          if (savedEventId) {
            syncEventAttachmentsInBackground(savedEventId, [], removedAttachments)
          }
        } catch (error) {
          await refreshCalendarData().catch(() => undefined)
          const message = error instanceof Error ? error.message : '事件儲存失敗，請稍後再試'
          alert(message)
        }
      })()
    } catch (error) {
      const message = error instanceof Error ? error.message : '事件儲存失敗，請稍後再試'
      alert(message)
      setSaving(false)
    } finally {
    }
  }

  async function uploadEventAttachments(
    eventId: string,
    files: File[],
    context: { uploadKind?: 'comment', commentId?: string, clientUploadId?: string } = {}
  ) {
    if (!user) throw new Error('登入已失效，請重新登入')
    const token = await getFirebaseIdToken(user)
    const appCheckHeaders = await getAppCheckHeaders()
    const attachments: NonNullable<CalendarEvent['attachments']> = []
    try {
      for (const sourceFile of files) {
        const prepared = await prepareAttachmentUpload(sourceFile)
        const formData = new FormData()
        formData.set('eventId', eventId)
        formData.set('originalName', prepared.originalName)
        formData.set('originalSize', String(prepared.originalSize))
        if (prepared.capture) {
          formData.set('capturedAtSource', prepared.capture.capturedAtSource)
          if (prepared.capture.capturedAt) formData.set('capturedAt', prepared.capture.capturedAt)
          if (prepared.capture.location) formData.set('location', JSON.stringify(prepared.capture.location))
        }
        if (context.uploadKind) formData.set('uploadKind', context.uploadKind)
        if (context.commentId) formData.set('commentId', context.commentId)
        if (context.clientUploadId) formData.set('clientUploadId', context.clientUploadId)
        formData.append('files', prepared.file)

        const response = await fetch('/api/upload-drive', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, ...appCheckHeaders },
          body: formData
        })
        const result = await response.json().catch(() => ({}))
        if (!response.ok || !Array.isArray(result.attachments)) {
          const fallback = response.status === 413
            ? '照片檔案過大，壓縮後仍超過上傳限制。'
            : `附件上傳失敗（HTTP ${response.status}）`
          throw new Error(result.error || fallback)
        }
        attachments.push(...result.attachments)
      }
      return attachments
    } catch (error) {
      if (attachments.length) await deleteRemovedEventAttachments(attachments, eventId).catch(() => 0)
      throw error
    }
  }

  async function createBackgroundCommentShell(
    eventId: string,
    commentId: string,
    text: string,
    pendingAttachmentCount: number,
    attachments: EventAttachment[] = [],
  ) {
    if (!user) throw new Error('登入已失效，請重新登入')
    const [token, appCheckHeaders] = await Promise.all([getFirebaseIdToken(user), getAppCheckHeaders()])
    const response = await fetch('/api/upload-drive', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...appCheckHeaders,
      },
      body: JSON.stringify({
        action: 'create-background-comment',
        eventId,
        commentId,
        text,
        pendingAttachmentCount,
        attachments,
      }),
    })
    const result = await response.json().catch(() => ({})) as { ok?: boolean, error?: ApiErrorPayload }
    if (!response.ok || result.ok !== true) {
      throw new Error(apiErrorMessage(result.error, `留言建立失敗（HTTP ${response.status}）`))
    }
  }

  async function fetchSalesCenterAttachments(eventId: string) {
    if (!user) throw new Error('登入已失效，請重新登入')
    const token = await getFirebaseIdToken(user)
    const appCheckHeaders = await getAppCheckHeaders()
    const response = await fetch('/api/upload-drive', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...appCheckHeaders
      },
      body: JSON.stringify({ action: 'sales-attachments', eventId })
    })
    const result = await response.json().catch(() => null) as {
      ok?: boolean
      attachments?: EventAttachment[]
      error?: ApiErrorPayload
    } | null
    if (!response.ok || result?.ok !== true || !Array.isArray(result.attachments)) {
      throw new Error(apiErrorMessage(result?.error, `附件中心讀取失敗（HTTP ${response.status}）`))
    }
    return result.attachments
  }

  async function fetchErpSalesDeliveryRelationIndex() {
    const events = await fetchCalendarData<CalendarEvent>('source')
    return events.reduce<Record<string, number>>((index, event) => {
      const sourceId = event.sourceId?.trim() || ''
      if (!sourceId || !isRelatedErpSalesDeliveryEvent(event) || !eventAllowedForViewer(event)) return index
      index[sourceId] = (index[sourceId] ?? 0) + 1
      return index
    }, {})
  }

  async function fetchRelatedSalesDeliveryEvents(sourceId: string) {
    const events = await fetchCalendarData<CalendarEvent>('source', { sourceId })
    return events
      .filter((event) => (
        isErpSalesDeliveryEvent(event)
        && event.sourceId === sourceId
        && eventAllowedForViewer(event)
      ))
      .sort((a, b) => {
        const roleOrder = Number(isRelatedErpSalesDeliveryEvent(a)) - Number(isRelatedErpSalesDeliveryEvent(b))
        if (roleOrder !== 0) return roleOrder
        return `${a.date} ${a.startTime}`.localeCompare(`${b.date} ${b.startTime}`)
      })
  }

  async function fetchProductionLineStatus(eventId: string) {
    if (!user) throw new Error('登入已失效，請重新登入')
    return fetchSalesOperationalStatus(user, eventId)
  }

  async function invalidateSalesCenterAttachments(eventId: string) {
    if (!user?.uid) return
    await queryClient.invalidateQueries({
      queryKey: ['sales-center-attachments', user.uid, eventId],
      exact: true,
      refetchType: 'active',
    })
  }

  async function completeOrderFulfillment(retry: ProductionLineRetry) {
    if (!user) throw new Error('登入已失效，請重新登入')
    const token = await getFirebaseIdToken(user)
    const appCheckHeaders = await getAppCheckHeaders()
    const response = await fetch('/api/upload-drive', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...appCheckHeaders
      },
      body: JSON.stringify({
        action: 'complete-order-fulfillment',
        eventId: retry.fulfillmentSourceEventId || retry.eventId,
        attachmentIds: retry.attachmentIds,
        ...(retry.fulfillmentOrders?.length ? { orders: retry.fulfillmentOrders, batchId: retry.fulfillmentRequestId } : {}),
        expectedShippingMethod: retry.shippingMethod,
        expectedOrderStatus: retry.orderStatus,
      })
    })
    const result = await response.json().catch(() => null) as {
      ok?: boolean
      result?: Partial<OrderFulfillmentResult> & { warning?: string; sent?: boolean; skipped?: boolean }
      error?: ApiErrorPayload
    } | null
    if (!response.ok || result?.ok !== true || !result.result?.orderStatus) {
      throw new Error(apiErrorMessage(result?.error, `訂單完成處理失敗（HTTP ${response.status}）`))
    }
    const message = result.result.message || '訂單狀態與附件已更新。'
    const sent = result.result.lineSent ?? result.result.sent
    const skipped = result.result.lineSkipped ?? result.result.skipped
    const pendingWarning = sent === false && skipped === true && message.includes('正在傳送中')
      ? `${message} 請稍後再按「重新傳送 LINE」。`
      : undefined
    const paymentPrompt = normalizeFulfillmentPaymentPrompt(result.result.paymentPrompt)
    return {
      orderStatus: result.result.orderStatus,
      shippingMethod: result.result.shippingMethod,
      message,
      lineSent: sent,
      lineSkipped: skipped,
      lineWarning: result.result.lineWarning || result.result.warning || pendingWarning,
      paymentPrompt,
      orders: result.result.orders,
    } satisfies OrderFulfillmentResult
  }

  useEffect(() => {
    const eventId = combinedPaymentEventIds[0]
    if (!eventId || fulfillmentPaymentModal || fulfillmentPaymentSaving) return
    let active = true
    void fetchProductionLineStatus(eventId).then((status) => {
      if (!active) return
      if (status.paymentPrompt) {
        setFulfillmentPaymentModal({ ...status.paymentPrompt, eventId, batchSalesNo: status.salesNo, idempotencyKey: createClientId() })
        setFulfillmentPaymentAmount(status.paymentPrompt.required ? String(status.paymentPrompt.currentOrderUnpaidAmount) : '')
        setFulfillmentPaymentError('')
      }
      setCombinedPaymentEventIds((ids) => ids.filter((id) => id !== eventId))
    }).catch((error) => {
      if (!active) return
      setProductionLineNotice({ variant: 'error', message: error instanceof Error ? error.message : '請開啟各訂單確認收款狀態' })
      setCombinedPaymentEventIds((ids) => ids.filter((id) => id !== eventId))
    })
    return () => { active = false }
  }, [combinedPaymentEventIds, fulfillmentPaymentModal, fulfillmentPaymentSaving])

  function openFulfillmentPaymentPrompt(eventId: string, prompt: FulfillmentPaymentPrompt | undefined) {
    if (!prompt) return
    setFulfillmentPaymentModal({
      ...prompt,
      eventId,
      idempotencyKey: globalThis.crypto?.randomUUID?.() || createClientId()
    })
    setFulfillmentPaymentAmount(prompt.required ? String(prompt.outstandingTotal) : '')
    setFulfillmentPaymentError('')
  }

  function dismissFulfillmentPaymentPrompt() {
    if (fulfillmentPaymentSaving) return
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    setFulfillmentPaymentModal(null)
    setFulfillmentPaymentAmount('')
    setFulfillmentPaymentError('')
  }

  async function recordFulfillmentCashPayment() {
    if (!user || !fulfillmentPaymentModal || fulfillmentPaymentSaving) return
    const amount = finitePaymentAmount(fulfillmentPaymentAmount)
    if (amount <= 0) {
      setFulfillmentPaymentError('收款金額必須大於 0')
      return
    }
    setFulfillmentPaymentSaving(true)
    setFulfillmentPaymentError('')
    try {
      const token = await getFirebaseIdToken(user)
      const appCheckHeaders = await getAppCheckHeaders()
      const response = await fetch('/api/upload-drive', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...appCheckHeaders
        },
        body: JSON.stringify({
          action: 'record-fulfillment-cash-payment',
          eventId: fulfillmentPaymentModal.eventId,
          amount,
          idempotencyKey: fulfillmentPaymentModal.idempotencyKey
        })
      })
      const payload = await response.json().catch(() => null) as {
        ok?: boolean
        result?: FulfillmentCashPaymentResult
        error?: ApiErrorPayload
      } | null
      if (!response.ok || payload?.ok !== true || !payload.result) {
        throw new Error(apiErrorMessage(payload?.error, `收款沖帳失敗（HTTP ${response.status}）`))
      }
      const currentOrderUnpaidAmount = payload.result.currentOrderUnpaidAmount
      const outstandingTotal = payload.result.outstandingTotal
      setProductionLineStatus((current) => current ? {
        ...current,
        paymentState: payload.result?.paymentState || current.paymentState,
        currentOrderUnpaidAmount: typeof currentOrderUnpaidAmount === 'number'
          ? finitePaymentAmount(currentOrderUnpaidAmount)
          : current.currentOrderUnpaidAmount,
        outstandingTotal: typeof outstandingTotal === 'number'
          ? finitePaymentAmount(outstandingTotal)
          : current.outstandingTotal,
        paymentPrompt: current.paymentPrompt ? {
          ...current.paymentPrompt,
          required: finitePaymentAmount(currentOrderUnpaidAmount) > 0,
          currentOrderUnpaidAmount: finitePaymentAmount(currentOrderUnpaidAmount),
          outstandingTotal: finitePaymentAmount(outstandingTotal),
        } : current.paymentPrompt,
      } : current)
      setProductionLineNotice(fulfillmentPaymentNotice(payload.result))
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
      setFulfillmentPaymentModal(null)
      setFulfillmentPaymentAmount('')
    } catch (error) {
      setFulfillmentPaymentError(error instanceof Error ? error.message : '收款沖帳失敗，請稍後重試')
    } finally {
      setFulfillmentPaymentSaving(false)
    }
  }

  async function applyFulfillmentResult(eventId: string, result: OrderFulfillmentResult) {
    const sourceEvent = events.find((event) => event.id === eventId)
      ?? (selectedOperationalEvent?.id === eventId ? selectedOperationalEvent : null)
    const updatedAt = new Date().toISOString()
    if (result.orders?.length) {
      optimisticallyPatchCalendarEvents(result.orders.flatMap((order) => {
        const event = events.find((item) => item.id === order.eventId)
        return event ? [{ ...event, orderStatus: order.orderStatus, updatedAt }] : []
      }))
      setCombinedPaymentEventIds((ids) => [...new Set([...ids, ...result.orders!.map((order) => order.eventId)])])
      await refreshCalendarData()
      return
    }
    await updateDoc(doc(db, 'calendarEvents', eventId), {
      orderStatus: result.orderStatus,
      ...(result.shippingMethod ? { sourceShippingMethod: result.shippingMethod } : {}),
      updatedAt
    })
    if (sourceEvent) {
      const nextEvent: CalendarEvent = {
        ...sourceEvent,
        orderStatus: result.orderStatus,
        sourceShippingMethod: result.shippingMethod || sourceEvent.sourceShippingMethod,
        updatedAt
      }
      optimisticallyPatchCalendarEvents([nextEvent])
    }
    setProductionLineStatus((current) => current ? {
      ...current,
      orderStatus: result.orderStatus,
      shippingMethod: result.shippingMethod || current.shippingMethod
    } : current)
  }

  async function persistProductionLineRetry(
    retry: ProductionLineRetry,
    status: 'pending' | 'failed',
    message?: string
  ) {
    const metadata: NonNullable<CalendarEvent['productionLineRetry']> = {
      mode: retry.mode,
      attachmentIds: retry.attachmentIds,
      status,
      shippingMethod: retry.shippingMethod,
      orderStatus: retry.orderStatus,
      ...(retry.fulfillmentOrders?.length ? { fulfillmentOrders: retry.fulfillmentOrders, fulfillmentRequestId: retry.fulfillmentRequestId, fulfillmentSourceEventId: retry.fulfillmentSourceEventId || retry.eventId } : {}),
      ...(message ? { message } : {}),
      updatedAt: new Date().toISOString()
    }
    setProductionLineRetry(retry)
    await updateDoc(doc(db, 'calendarEvents', retry.eventId), { productionLineRetry: metadata })
  }

  async function clearProductionLineRetry(eventId: string) {
    await updateDoc(doc(db, 'calendarEvents', eventId), { productionLineRetry: deleteField() })
    setProductionLineRetry((current) => current?.eventId === eventId ? null : current)
  }

  async function finishBackgroundDetailAttachments(
    eventId: string,
    attachments: EventAttachment[],
    completionMode: BackgroundAttachmentCompletionMode,
    serverManaged = true,
    batch?: { fulfillmentOrders?: CombinedDeliveryOrder[]; fulfillmentRequestId?: string },
  ) {
    const attachmentIds = attachments.map((attachment) => attachment.path).filter(Boolean)
    if (attachmentIds.length !== attachments.length) throw new Error('照片背景處理結果不完整')
    const sourceEvent = events.find((item) => item.id === eventId)
      ?? (selectedOperationalEvent?.id === eventId ? selectedOperationalEvent : null)
    if (sourceEvent) {
      const existing = sourceEvent.attachments ?? []
      const additions = attachments.filter((attachment) => {
        const uploadJobId = (attachment as EventAttachment & { uploadJobId?: string }).uploadJobId
        return !existing.some((item) => item.path === attachment.path || Boolean(
          uploadJobId && (item as EventAttachment & { uploadJobId?: string }).uploadJobId === uploadJobId
        ))
      })
      const nextEvent = {
        ...sourceEvent,
        attachments: [...existing, ...additions],
        updatedAt: new Date().toISOString(),
      }
      optimisticallyPatchCalendarEvents([nextEvent])
    }

    const latestStatus = completionMode === 'fulfillment'
      ? await fetchProductionLineStatus(eventId)
      : null
    if (selectedOperationalEvent?.id === eventId && latestStatus) setProductionLineStatus(latestStatus)
    const retry: ProductionLineRetry | null = latestStatus
      ? { ...fulfillmentRetryForStatus(eventId, attachmentIds, latestStatus), ...(batch?.fulfillmentOrders?.length ? batch : {}) }
      : null
    if (!retry) {
      if (completionMode === 'production') await clearProductionLineRetry(eventId).catch(() => undefined)
      await refreshCalendarData()
      return
    }
    if (serverManaged) {
      setProductionLineRetry(null)
      setProductionLineNotice(null)
      const eventSnapshot = await getCalendarEventSnapshot(eventId)
      const storedRetry = eventSnapshot.data()?.productionLineRetry as CalendarEvent['productionLineRetry']
      if (
        storedRetry?.mode === 'fulfillment'
        && (storedRetry.status === 'pending' || storedRetry.status === 'failed')
        && latestStatus
      ) {
        await updateDoc(doc(db, 'calendarEvents', eventId), {
          'productionLineRetry.shippingMethod': latestStatus.shippingMethod || '',
          'productionLineRetry.orderStatus': latestStatus.orderStatus || '',
        })
      }
      if (batch?.fulfillmentOrders?.length && latestStatus?.orderStatus === '已送達') setCombinedPaymentEventIds((ids) => [...new Set([...ids, ...batch.fulfillmentOrders!.map((order) => order.eventId)])])
      await refreshCalendarData()
      return
    }
    setProductionLineRetry(retry)
    try {
      const result = await completeOrderFulfillment(retry)
      await applyFulfillmentResult(eventId, result)
      const warning = result.lineWarning
      setProductionLineNotice(warning ? { variant: 'error', message: warning } : null)
      if (warning) {
        await persistProductionLineRetry({
          ...retry,
          shippingMethod: result.shippingMethod || retry.shippingMethod,
          orderStatus: result.orderStatus,
        }, 'failed', warning)
      }
      else await clearProductionLineRetry(eventId)
    } catch (error) {
      const message = error instanceof Error ? error.message : '照片已保留，但後續處理失敗'
      setProductionLineNotice({ variant: 'error', message })
      if (batch?.fulfillmentOrders?.length) await persistProductionLineRetry(retry, 'failed', message)
      else await persistProductionLineRetry(retry, 'failed', message).catch(() => undefined)
    } finally {
      void refreshCalendarData().catch(() => undefined)
    }
  }

  async function retryProductionPhotoDelivery() {
    if (!productionLineRetry || productionLineRetrying) return
    setProductionLineRetrying(true)
    try {
      const liveStatus = await fetchProductionLineStatus(productionLineRetry.eventId)
      setProductionLineStatus(liveStatus)
      const decision = fulfillmentRetryDecision({
        ...productionLineRetry,
        status: 'failed',
      }, liveStatus)
      if (decision.action === 'clear') {
        await clearProductionLineRetry(productionLineRetry.eventId)
        setProductionLineNotice({
          variant: 'muted',
          message: '訂單的出貨方式或狀態已變更，已取消過期的完成重試。',
        })
        return
      }
      if (decision.action !== 'allow') {
        setProductionLineNotice({
          variant: 'error',
          message: decision.reason === 'permission'
            ? '您目前沒有完成這張訂單的權限。'
            : '無法確認訂單最新狀態，未執行完成重試。',
        })
        return
      }
      const result = await completeOrderFulfillment(productionLineRetry)
      await applyFulfillmentResult(productionLineRetry.eventId, result)
      const warning = result.lineWarning
      setProductionLineNotice({
        variant: warning ? 'error' : result.lineSent ? 'success' : 'muted',
        message: warning || result.message
      })
      if (warning) {
        await persistProductionLineRetry({
          ...productionLineRetry,
          shippingMethod: result.shippingMethod || productionLineRetry.shippingMethod,
          orderStatus: result.orderStatus,
        }, 'failed', warning)
      } else {
        await clearProductionLineRetry(productionLineRetry.eventId)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '訂單完成重試失敗'
      try {
        const liveStatus = await fetchProductionLineStatus(productionLineRetry.eventId)
        setProductionLineStatus(liveStatus)
        const latestDecision = fulfillmentRetryDecision({
          ...productionLineRetry,
          status: 'failed',
        }, liveStatus)
        if (latestDecision.action === 'clear') {
          await clearProductionLineRetry(productionLineRetry.eventId)
          setProductionLineNotice({
            variant: 'muted',
            message: '訂單的出貨方式或狀態已變更，已取消過期的完成重試。',
          })
          return
        }
      } catch (statusError) {
        console.warn('[calendar] 訂單完成重試失敗後狀態核對失敗', statusError)
      }
      setProductionLineNotice({
        variant: 'error',
        message
      })
      await persistProductionLineRetry(productionLineRetry, 'failed', message).catch(() => undefined)
    } finally {
      setProductionLineRetrying(false)
    }
  }

  function resetAttachmentUploadState() {
    setAttachmentUploads([])
    canceledAttachmentUploadIdsRef.current.clear()
  }

  function discardAttachmentUploadState() {
    setAttachmentUploads((items) => {
      items.forEach((item) => {
        canceledAttachmentUploadIdsRef.current.add(item.id)
        if (item.attachment) {
          void deleteRemovedEventAttachments([item.attachment], editingEventId ?? 'draft-event')
        }
      })
      return []
    })
  }

  function closeEventModal() {
    discardAttachmentUploadState()
    dismissActiveKeyboard()
    setEditingEventSnapshot(null)
    setCopySourceEvent(null)
    setShowEventModal(false)
  }

  useEffect(() => {
    if (!showEventModal || showRepeatPicker) return
    function closeEventEditorWithEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.isComposing) return
      event.preventDefault()
      event.stopImmediatePropagation()
      closeEventModal()
    }
    document.addEventListener('keydown', closeEventEditorWithEscape, true)
    return () => document.removeEventListener('keydown', closeEventEditorWithEscape, true)
  }, [showEventModal, showRepeatPicker, closeEventModal])

  function handleAttachmentFileChange(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? [])
    event.target.value = ''
    if (salesDeliveryAttachmentReadonly) return
    if (!files.length) return

    const uploadItems = files.map((file) => ({
      id: createClientId(),
      name: file.name,
      size: file.size,
      status: 'uploading' as const
    }))
    setAttachmentUploads((items) => [...items, ...uploadItems])

    uploadItems.forEach((item, index) => {
      const file = files[index]
      void (async () => {
        try {
          const [attachment] = await uploadEventAttachments(editingEventId ?? 'draft-event', [file])
          if (!attachment) throw new Error('附件上傳失敗')
          if (canceledAttachmentUploadIdsRef.current.has(item.id)) {
            if (attachment) await deleteRemovedEventAttachments([attachment], editingEventId ?? 'draft-event').catch(() => 0)
            canceledAttachmentUploadIdsRef.current.delete(item.id)
            return
          }
          setAttachmentUploads((items) => items.map((upload) => (
            upload.id === item.id
              ? { ...upload, status: 'uploaded', attachment: attachment ?? undefined }
              : upload
          )))
        } catch (error) {
          if (canceledAttachmentUploadIdsRef.current.has(item.id)) {
            canceledAttachmentUploadIdsRef.current.delete(item.id)
            return
          }
          const message = error instanceof Error ? error.message : '附件上傳失敗'
          setAttachmentUploads((items) => items.map((upload) => (
            upload.id === item.id ? { ...upload, status: 'failed', error: message } : upload
          )))
        }
      })()
    })
  }

  function removeFailedDetailBackgroundUpload(uploadId: string) {
    void removeDurableBackgroundAttachmentUpload(uploadId).catch((error) => {
      console.warn('[calendar] 移除離線照片失敗', error)
    })
    setDetailBackgroundUploads((items) => items.filter((item) => {
      if (item.id !== uploadId || item.status !== 'failed') return true
      URL.revokeObjectURL(item.previewUrl)
      return false
    }))
  }

  function openPendingDetailAttachment(upload: DetailBackgroundUpload) {
    setEnlargedEventAttachment({
      name: upload.name,
      originalName: upload.name,
      url: upload.previewUrl,
      path: `local-preview:${upload.id}`,
      type: 'image/*',
    })
  }

  async function commitDevelopmentCommentAttachment(
    eventId: string,
    commentId: string,
    attachment: EventAttachment,
  ) {
    if (!user) throw new Error('尚未登入')
    const [token, appCheckHeaders] = await Promise.all([getFirebaseIdToken(user), getAppCheckHeaders(true)])
    const response = await fetch('/api/upload-drive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...appCheckHeaders },
      body: JSON.stringify({ action: 'commit-development-comment-attachment', eventId, commentId, fileId: attachment.path }),
      signal: AbortSignal.timeout(30_000),
    })
    const result = await response.json().catch(() => null) as { error?: string } | null
    if (!response.ok) throw new Error(result?.error || '留言附件儲存失敗')
  }

  async function processCommentBackgroundUploads(rows: DurableBackgroundAttachmentUpload[]) {
    const validRows = rows.filter((row) => row.uploadKind === 'comment' && row.commentId)
    const groups = new Map<string, DurableBackgroundAttachmentUpload[]>()
    validRows.forEach((row) => {
      if (backgroundAttachmentRecoveryIdsRef.current.has(`durable:${row.id}`)) return
      backgroundAttachmentRecoveryIdsRef.current.add(`durable:${row.id}`)
      const key = `${row.eventId}:${row.commentId}`
      groups.set(key, [...(groups.get(key) ?? []), row])
    })
    await Promise.all(Array.from(groups.values()).map(async (group) => {
      const markCloudSafe = createCloudSafeBatchNotice(group)
      try {
        await runWithConcurrency(group, 3, async (row) => {
          let cloudSafeReached = row.cloudSafe
          try {
            const commentId = row.commentId as string
            const cloudUpload = shouldUseCalendarCloudUpload(import.meta.env.DEV, import.meta.env.VITE_CALENDAR_BACKGROUND_UPLOAD, row.jobId)
            const file = durableBackgroundAttachmentFile(row)
            const capture = row.capture ?? await extractPhotoCaptureMetadata(file)
            const result = await startBackgroundAttachmentUpload({
              eventId: row.eventId,
              file,
              completionMode: 'none',
              uploadKind: 'comment',
              commentId,
              durableUpload: row,
              capture,
              ...(!cloudUpload ? {
                localFallback: async (fallbackFile, clientUploadId) => {
                  const [attachment] = await uploadEventAttachments(row.eventId, [fallbackFile], {
                    uploadKind: 'comment',
                    commentId,
                    clientUploadId,
                  })
                  if (!attachment) throw new Error('本機留言照片上傳失敗')
                  return attachment
                },
              } : {}),
              onJobCreated: (jobId) => setCommentBackgroundUploads((items) => items.map((item) => (
                item.id === row.id ? { ...item, jobId } : item
              ))),
              onCloudSafe: () => {
                cloudSafeReached = true
                setCommentBackgroundUploads((items) => items.map((item) => (
                  item.id === row.id ? { ...item, cloudSafe: true } : item
                )))
                if (markCloudSafe(row.id)) {
                  setDetailAttachmentUploadNotice({
                    id: Date.now(),
                    message: group.length > 1 ? `${group.length} 張照片上傳成功` : '照片上傳成功',
                  })
                }
              },
              onProgress: (status, ratio) => setCommentBackgroundUploads((items) => items.map((item) => (
                item.id === row.id
                  ? { ...item, status, progress: ratio ?? item.progress, error: undefined }
                  : item
              ))),
            })
            if (!cloudUpload) {
              await commitDevelopmentCommentAttachment(row.eventId, commentId, result.attachment)
            }
            setCommentBackgroundUploads((items) => items.map((item) => (
              item.id === row.id
                ? {
                    ...item,
                    jobId: result.attachment.uploadJobId || item.jobId,
                    attachmentPath: result.attachment.path,
                    status: 'finalizing',
                    progress: 1,
                    cloudSafe: true,
                  }
                : item
            )))
            void removeDurableBackgroundAttachmentUpload(row.id).catch((error) => {
              console.warn('[calendar] 留言照片本機佇列清理失敗', error)
            })
          } catch (error) {
            const message = error instanceof Error ? error.message : '留言照片背景上傳失敗'
            if (cloudSafeReached && message.includes('仍在背景處理')) {
              setCommentBackgroundUploads((items) => items.map((item) => (
                item.id === row.id
                  ? { ...item, status: 'finalizing', cloudSafe: true, error: undefined }
                  : item
              )))
              return
            }
            await updateDurableBackgroundAttachmentUpload(row.id, {
              status: 'failed',
              error: message,
            }).catch(() => undefined)
            setCommentBackgroundUploads((items) => items.map((item) => (
              item.id === row.id ? { ...item, status: 'failed', error: message } : item
            )))
          }
        })
      } finally {
        group.forEach((row) => backgroundAttachmentRecoveryIdsRef.current.delete(`durable:${row.id}`))
      }
    }))
  }

  async function processDurableBackgroundUploads(rows: DurableBackgroundAttachmentUpload[]) {
    const groups = new Map<string, DurableBackgroundAttachmentUpload[]>()
    rows.forEach((row) => {
      if (backgroundAttachmentRecoveryIdsRef.current.has(`durable:${row.id}`)) return
      backgroundAttachmentRecoveryIdsRef.current.add(`durable:${row.id}`)
      const key = row.fulfillmentBatchId || `${row.eventId}:${row.completionMode}`
      groups.set(key, [...(groups.get(key) ?? []), row])
    })
    await Promise.all(Array.from(groups.values()).map(async (group) => {
      const completed: { id: string, attachment: EventAttachment }[] = []
      const cloudUpload = shouldUseCalendarCloudUpload(import.meta.env.DEV, import.meta.env.VITE_CALENDAR_BACKGROUND_UPLOAD, group.find((row) => row.jobId)?.jobId)
      const markCloudSafe = createCloudSafeBatchNotice(group)
      try {
        const latestStatus = group[0].completionMode === 'fulfillment'
          ? await fetchProductionLineStatus(group[0].eventId)
          : null
        if (latestStatus && selectedOperationalEvent?.id === group[0].eventId) {
          setProductionLineStatus(latestStatus)
          if (!group[0].fulfillmentOrders?.length) openFulfillmentPaymentPrompt(group[0].eventId, latestStatus.paymentPrompt)
        }
        if (group[0].completionMode === 'fulfillment' && latestStatus) {
          if (!['外送', '施工', '活動'].includes(latestStatus.shippingMethod || '')) {
            throw new Error('此事件目前不是外送、施工或活動訂單')
          }
          if (latestStatus.canCompleteOrder !== true) throw new Error('您沒有完成銷貨單的修改或特殊操作權限')
        }

        await runWithConcurrency(group, 3, async (row) => {
          let cloudSafeReached = row.cloudSafe
          try {
            const file = durableBackgroundAttachmentFile(row)
            const extractedCapture = await extractPhotoCaptureMetadata(file)
            const capture = mergePhotoCaptureMetadata(extractedCapture, row.capture)
            const durableUpload = await updateDurableBackgroundAttachmentUpload(row.id, { capture }).catch(() => row)
            const result = await startBackgroundAttachmentUpload({
              eventId: row.eventId,
              file,
              completionMode: row.completionMode,
              durableUpload,
              capture,
              ...(!cloudUpload ? {
                // 未啟用雲端工作時保留既有本機傳輸，已有工作則必須沿用原工作。
                localFallback: async (fallbackFile, clientUploadId) => {
                  const [attachment] = await uploadEventAttachments(row.eventId, [fallbackFile], { clientUploadId })
                  if (!attachment) throw new Error('本機照片上傳失敗')
                  return attachment
                },
              } : {}),
              onJobCreated: (jobId) => setDetailBackgroundUploads((items) => items.map((item) => (
                item.id === row.id ? { ...item, jobId } : item
              ))),
              onCloudSafe: () => {
                cloudSafeReached = true
                setDetailBackgroundUploads((items) => items.map((item) => (
                  item.id === row.id ? { ...item, cloudSafe: true } : item
                )))
                if (markCloudSafe(row.id)) {
                  setDetailAttachmentUploadNotice({
                    id: Date.now(),
                    message: group.length > 1 ? `${group.length} 張照片上傳成功` : '照片上傳成功',
                  })
                }
              },
              onProgress: (status, ratio) => setDetailBackgroundUploads((items) => items.map((item) => (
                item.id === row.id
                  ? { ...item, status, progress: ratio ?? item.progress, error: undefined }
                  : item
              ))),
            })
            setDetailBackgroundUploads((items) => items.map((item) => (
              item.id === row.id
                ? {
                    ...item,
                    jobId: result.attachment.uploadJobId || item.jobId,
                    attachmentPath: result.attachment.path,
                    status: 'finalizing',
                    progress: 1,
                    cloudSafe: true,
                  }
                : item
            )))
            completed.push({ id: row.id, attachment: result.attachment })
          } catch (error) {
            const message = error instanceof Error ? error.message : '照片背景上傳失敗'
            if (cloudSafeReached && message.includes('仍在背景處理')) {
              setDetailBackgroundUploads((items) => items.map((item) => (
                item.id === row.id ? { ...item, status: 'finalizing', cloudSafe: true, error: undefined } : item
              )))
              return
            }
            await updateDurableBackgroundAttachmentUpload(row.id, {
              status: 'failed',
              error: message,
            }).catch(() => undefined)
            setDetailBackgroundUploads((items) => items.map((item) => (
              item.id === row.id ? { ...item, status: 'failed', error: message } : item
            )))
          }
        })

        if (completed.length === 0) return
        if (group[0].fulfillmentOrders?.length && completed.length !== group[0].fulfillmentBatchSize) {
          throw new Error('本次配達照片尚未全部確認，請重試整批回報以確認配達結果。')
        }
        const completedAttachments = completed.map((item) => item.attachment)
        if (!cloudUpload) {
          const attachmentIds = completedAttachments.map((attachment) => attachment.path).filter(Boolean)
          const updatedAt = new Date().toISOString()
          await updateDoc(doc(db, 'calendarEvents', group[0].eventId), {
            attachments: arrayUnion(...completedAttachments),
            ...(latestStatus && group[0].completionMode === 'fulfillment' ? {
              productionLineRetry: {
                mode: 'fulfillment',
                attachmentIds,
                status: 'pending',
                shippingMethod: latestStatus.shippingMethod || '',
                orderStatus: latestStatus.orderStatus || '',
                ...(group[0].fulfillmentOrders?.length ? { fulfillmentOrders: group[0].fulfillmentOrders, fulfillmentRequestId: group[0].fulfillmentRequestId, fulfillmentSourceEventId: group[0].eventId } : {}),
                message: '照片已保留，訂單完成尚待確認。',
                updatedAt,
              },
            } : {}),
            updatedAt,
          })
        }
        await finishBackgroundDetailAttachments(
          group[0].eventId,
          completedAttachments,
          group[0].completionMode,
          cloudUpload,
          group[0],
        )
        await invalidateSalesCenterAttachments(group[0].eventId)
        await Promise.all(completedAttachments
          .map(attachmentPreviewUrl)
          .filter(Boolean)
          .map(preloadSalesAttachmentPreview))
        const completedIds = new Set(completed.map((item) => item.id))
        if (group[0].fulfillmentOrders?.length) await removeDurableBackgroundAttachmentBatch(Array.from(completedIds))
        setDetailBackgroundUploads((items) => items.filter((item) => {
          if (!completedIds.has(item.id)) return true
          URL.revokeObjectURL(item.previewUrl)
          return false
        }))
        if (!group[0].fulfillmentOrders?.length) {
          void Promise.allSettled(Array.from(completedIds).map((id) => removeDurableBackgroundAttachmentUpload(id))).then((results) => {
            if (results.some((result) => result.status === 'rejected')) console.warn('[calendar] 已完成照片的本機佇列清理失敗，稍後會自動重試')
          })
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : '照片背景上傳失敗'
        await Promise.all(group.map((row) => updateDurableBackgroundAttachmentUpload(row.id, {
          status: 'failed',
          error: message,
        }).catch(() => undefined)))
        const groupIds = new Set(group.map((row) => row.id))
        setDetailBackgroundUploads((items) => items.map((item) => (
          groupIds.has(item.id) && item.status !== 'failed'
            ? { ...item, status: 'failed', error: message }
            : item
        )))
      } finally {
        group.forEach((row) => backgroundAttachmentRecoveryIdsRef.current.delete(`durable:${row.id}`))
      }
    }))
  }

  function queueDetailBackgroundUploads(
    eventSnapshot: CalendarEvent,
    files: File[],
    deviceLocation?: PhotoLocation,
    completionMode: BackgroundAttachmentCompletionMode = 'fulfillment',
    batch?: { fulfillmentOrders: CombinedDeliveryOrder[]; fulfillmentRequestId: string },
    requireWholeBatch = false,
  ) {
    return (async () => {
      if (!user?.uid) return
      const persistedRows: DurableBackgroundAttachmentUpload[] = []
      const fulfillmentBatchId = createClientId()
      const fallbackCapture: PhotoCaptureMetadata | undefined = deviceLocation
        ? { capturedAtSource: 'unknown', location: deviceLocation }
        : undefined
      if (batch || requireWholeBatch) {
        const rows = await persistDurableBackgroundAttachmentBatch(files.map((file) => ({
          id: createClientId(), uploaderUid: user.uid, eventId: eventSnapshot.id, completionMode,
          fulfillmentBatchId, fulfillmentBatchSize: files.length, ...batch, file, capture: fallbackCapture,
        })))
        setDetailBackgroundUploads((items) => [...items, ...rows.map((row) => ({
          id: row.id, eventId: row.eventId, fulfillmentRequestId: row.fulfillmentRequestId,
          name: row.name, previewUrl: URL.createObjectURL(row.blob), status: row.status,
          progress: 0, cloudSafe: false, createdAt: row.createdAt,
        }))])
        void processDurableBackgroundUploads(rows)
        return
      }
      for (const file of files) {
        const id = createClientId()
        const previewUrl = URL.createObjectURL(file)
        setDetailBackgroundUploads((items) => [...items, {
          id,
          eventId: eventSnapshot.id,
          name: file.name,
          previewUrl,
          status: 'queued',
          progress: 0,
          cloudSafe: false,
          createdAt: new Date().toISOString(),
        }])
        try {
          // IndexedDB 交易完成後才會進入任何權限查詢或網路上傳。
          const row = await persistDurableBackgroundAttachmentUpload({
            id,
            uploaderUid: user.uid,
            eventId: eventSnapshot.id,
            completionMode,
            ...(completionMode === 'fulfillment' ? {
              fulfillmentBatchId,
              fulfillmentBatchSize: files.length,
              ...(batch || {}),
            } : {}),
            file,
            capture: fallbackCapture,
          })
          persistedRows.push(row)
        } catch (error) {
          const message = error instanceof Error ? error.message : '無法保存照片至此裝置'
          setDetailBackgroundUploads((items) => items.map((item) => (
            item.id === id
              ? { ...item, status: 'failed', error: `${message}，尚未開始上傳` }
              : item
          )))
        }
      }
      if (persistedRows.length > 0) {
        const normalizedRows = await Promise.all(persistedRows.map((row) => (
          completionMode !== 'fulfillment' || row.fulfillmentBatchSize === persistedRows.length
            ? Promise.resolve(row)
            : updateDurableBackgroundAttachmentUpload(row.id, {
                fulfillmentBatchSize: persistedRows.length,
              })
        )))
        await processDurableBackgroundUploads(normalizedRows)
      }
    })()
  }

  async function retryCombinedBackgroundUploads(requestId: string) {
    if (!user) return
    try {
      const rows = (await loadDurableBackgroundAttachmentUploads(user.uid)).filter((row) => row.fulfillmentRequestId === requestId)
      await processDurableBackgroundUploads(rows)
    } catch (error) {
      setProductionLineNotice({ variant: 'error', message: error instanceof Error ? error.message : '配達回報恢復失敗' })
    }
  }

  async function fetchCombinedDeliveryStatuses(candidates: CalendarEvent[]): Promise<DeliverySelectionResult> {
    if (!user) throw new Error('登入已失效，請重新登入')
    const result: DeliverySelectionResult = { statuses: {}, errors: {} }
    const [token, appCheckHeaders] = await Promise.all([getFirebaseIdToken(user), getAppCheckHeaders()])
    for (let offset = 0; offset < candidates.length; offset += 20) {
      const group = candidates.slice(offset, offset + 20)
      const response = await fetch('/api/upload-drive', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...appCheckHeaders },
        body: JSON.stringify({ action: 'fulfillment-selection-status', eventIds: group.map((event) => event.id) }),
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok || payload?.ok !== true || !Array.isArray(payload.statuses)) throw new Error(apiErrorMessage(payload?.error, '訂單確認失敗'))
      for (const row of payload.statuses) {
        const event = group.find((candidate) => candidate.id === row.eventId && candidate.sourceId === row.salesId)
        if (event && typeof row.status?.canCompleteOrder === 'boolean' && typeof row.status?.shippingMethod === 'string' && typeof row.status?.orderStatus === 'string') {
          result.statuses[event.id] = row.status
        }
      }
      for (const row of Array.isArray(payload.errors) ? payload.errors : []) {
        if (group.some((event) => event.id === row.eventId)) result.errors[row.eventId] = String(row.message || '訂單確認失敗')
      }
    }
    return result
  }

  function loadCombinedDeliveryStatuses(candidates: CalendarEvent[]) {
    return combinedDeliveryStatusCache.load(candidates, fetchCombinedDeliveryStatuses)
  }

  function prefetchCombinedDelivery(source: CalendarEvent) {
    if (source.sourceShippingMethod !== '外送' || source.sourceEventRole === 'related') return
    void loadCombinedDeliveryStatuses(combinedDeliveryCandidates(source, visibleEvents).filter((event) => !isCalendarEventCompleted(event)))
  }

  function openCombinedDelivery(source: CalendarEvent, files: File[] = []) {
    prefetchCombinedDelivery(source)
    setCombinedDelivery({ events: combinedDeliveryCandidates(source, visibleEvents), files, requestId: createClientId() })
    setSelectedDeliveryGroupKey(null)
  }

  async function previewCombinedDelivery(orders: CombinedDeliveryOrder[]) {
    if (!user || !combinedDelivery) throw new Error('登入或配達資料已失效')
    if (orders.length === 1) {
      const status = await fetchProductionLineStatus(orders[0].eventId)
      if (!status.canCompleteOrder || status.shippingMethod !== '外送' || status.orderStatus !== orders[0].expectedOrderStatus) throw new Error('訂單狀態已變更，請重新開啟配達回報')
      return [productionLineBindingDescription(status)]
    }
    const response = await fetch('/api/upload-drive', {
      method: 'POST',
      headers: { Authorization: `Bearer ${await getFirebaseIdToken(user)}`, 'Content-Type': 'application/json', ...await getAppCheckHeaders() },
      body: JSON.stringify({ action: 'complete-order-fulfillment', preflight: true, eventId: combinedDelivery.events[0].id, orders, batchId: combinedDelivery.requestId }),
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok || payload?.ok !== true) throw new Error(apiErrorMessage(payload?.error, '配達資料確認失敗'))
    const notifications = payload.result?.notificationGroups
    const notices = Array.isArray(notifications)
      ? notifications.map((notification: { displayName?: string; orders?: { salesNo: string }[] }) => `${notification.displayName || '已綁定的 LINE 通知對象'}：${notification.orders?.map((order) => order.salesNo).join('、') || ''}`)
      : []
    const warnings = Array.isArray(payload.result?.warnings)
      ? payload.result.warnings.map((warning: { salesNo?: string; message: string }) => `${warning.salesNo || ''} ${warning.message}`.trim())
      : []
    return [...notices, ...warnings, ...(notices.length ? [] : ['本次沒有可發送的 LINE 通知對象，將保留配達紀錄。'])]
  }

  async function submitCombinedDelivery(selected: CalendarEvent[], files: File[], orders: CombinedDeliveryOrder[]) {
    if (!combinedDelivery || combinedDeliverySubmittingRef.current) return
    combinedDeliverySubmittingRef.current = true
    try {
      await previewCombinedDelivery(orders)
      const source = selected[0]
      const location = isTouchDevice ? await requestDevicePhotoLocationForEvent(source.id) : null
      if (location?.warning) setDetailAttachmentUploadNotice({ id: Date.now(), message: location.warning })
      const batch = orders.length > 1 ? { fulfillmentOrders: orders, fulfillmentRequestId: combinedDelivery.requestId } : undefined
      openEventDetail(source)
      await queueDetailBackgroundUploads(source, files, location?.location, 'fulfillment', batch, true)
      setCombinedDelivery(null)
    } finally {
      combinedDeliverySubmittingRef.current = false
    }
  }

  async function handleDetailAttachmentFileChange(event: ChangeEvent<HTMLInputElement>) {
    const selectedEvent = selectedOperationalEvent
    const files = Array.from(event.target.files ?? [])
    event.target.value = ''
    if (!files.length || !selectedEvent) return
    if (!canUploadDetailAttachment(selectedEvent, productionLineStatus) || isHrReadonlyEvent(selectedEvent)) {
      alert('沒有此事件的附件上傳權限')
      return
    }
    if (fulfillmentShippingMethod(selectedEvent, productionLineStatus) === '外送' && !isCalendarEventCompleted(selectedEvent)) {
      openCombinedDelivery(selectedEvent, files)
      return
    }
    let fulfillmentEvent = isErpOrderFulfillmentEvent(selectedEvent, productionLineStatus)
    let latestProductionLineStatus = productionLineStatus
    if (fulfillmentEvent && files.length > 20) {
      alert('外送／施工／活動照片一次最多上傳 20 張')
      return
    }
    if (fulfillmentEvent && files.some((file) => !canUseBackgroundImageUpload(file))) {
      alert('外送／施工／活動完成只能上傳照片')
      return
    }
    let uploadedAttachments: NonNullable<CalendarEvent['attachments']> = []
    let firestoreUpdated = false
    let completedOrderStatus = ''
    let completedShippingMethod = ''
    let lineAttachmentIds: string[] = []
    setDetailAttachmentUploading(true)
    try {
      // 選檔完成後才要求定位，避免 iOS 同時開啟定位授權與照片選擇器。
      const deviceLocationResult = fulfillmentEvent && isTouchDevice
        ? await requestDevicePhotoLocationForEvent(selectedEvent.id)
        : null
      if (deviceLocationResult?.warning) {
        setDetailAttachmentUploadNotice({ id: Date.now(), message: deviceLocationResult.warning })
      }
      // 完工照片需保持整批完成語意，一般照片不觸發訂單完成。
      if (fulfillmentEvent) {
        queueDetailBackgroundUploads(selectedEvent, files, deviceLocationResult?.location)
        return
      }

      if (selectedEvent.source === 'erpSalesDelivery') {
        latestProductionLineStatus = await fetchProductionLineStatus(selectedEvent.id)
        setProductionLineStatus(latestProductionLineStatus)
        const shippingMethod = fulfillmentShippingMethod(selectedEvent, latestProductionLineStatus)
        fulfillmentEvent = shippingMethod === '外送' || shippingMethod === '施工' || shippingMethod === '活動'
        if (fulfillmentEvent && latestProductionLineStatus.canCompleteOrder !== true) {
          throw new Error('您沒有完成銷貨單的修改或特殊操作權限')
        }
        if (fulfillmentEvent && files.some((file) => !file.type.startsWith('image/') || file.type === 'image/svg+xml')) {
          throw new Error('外送／施工／活動完成只能上傳照片')
        }
        openFulfillmentPaymentPrompt(selectedEvent.id, latestProductionLineStatus?.paymentPrompt)
      }
      if (fulfillmentEvent) {
        setDetailAttachmentUploading(false)
        queueDetailBackgroundUploads(selectedEvent, files, deviceLocationResult?.location)
        return
      }
      const photoFiles = files.filter(canUseBackgroundImageUpload)
      const directFiles = files.filter((file) => !canUseBackgroundImageUpload(file))
      if (photoFiles.length) {
        queueDetailBackgroundUploads(selectedEvent, photoFiles, deviceLocationResult?.location, 'none')
      }
      if (!directFiles.length) {
        setDetailAttachmentUploading(false)
        return
      }
      uploadedAttachments = await uploadEventAttachments(selectedEvent.id, directFiles)
      if (!uploadedAttachments.length) throw new Error('附件上傳失敗')
      const nextAttachments = [...(selectedEvent.attachments ?? []), ...uploadedAttachments]
      const updatedAt = new Date().toISOString()
      lineAttachmentIds = uploadedAttachments
        .filter((attachment) => attachment.lineOriginalUrl && attachment.linePreviewUrl && attachment.path)
        .map((attachment) => attachment.path)
      const pendingRetry: ProductionLineRetry | null = lineAttachmentIds.length > 0 && fulfillmentEvent && latestProductionLineStatus
        ? fulfillmentRetryForStatus(selectedEvent.id, lineAttachmentIds, latestProductionLineStatus)
        : null
      const pendingRetryMetadata: CalendarEvent['productionLineRetry'] = pendingRetry ? {
        mode: pendingRetry.mode,
        attachmentIds: pendingRetry.attachmentIds,
        status: 'pending',
        shippingMethod: pendingRetry.shippingMethod,
        orderStatus: pendingRetry.orderStatus,
        message: '照片已保留，訂單完成尚待確認。',
        updatedAt
      } : undefined
      await updateDoc(doc(db, 'calendarEvents', selectedEvent.id), {
        attachments: arrayUnion(...uploadedAttachments),
        ...(pendingRetryMetadata ? { productionLineRetry: pendingRetryMetadata } : {}),
        updatedAt
      })
      firestoreUpdated = true
      if (pendingRetry) setProductionLineRetry(pendingRetry)
      if (fulfillmentEvent) {
        if (lineAttachmentIds.length !== uploadedAttachments.length) {
          throw new Error('外送／施工／活動照片處理不完整，請稍後重試')
        }
        if (!pendingRetry) throw new Error('無法建立訂單完成狀態快照')
        const result = await completeOrderFulfillment(pendingRetry)
        completedOrderStatus = result.orderStatus
        completedShippingMethod = result.shippingMethod || selectedEvent.sourceShippingMethod || ''
        const nextEvent: CalendarEvent = {
          ...selectedEvent,
          attachments: nextAttachments,
          orderStatus: result.orderStatus,
          sourceShippingMethod: result.shippingMethod || selectedEvent.sourceShippingMethod,
          updatedAt
        }
        optimisticallyPatchCalendarEvents([nextEvent])
        setProductionLineStatus((current) => current ? {
          ...current,
          orderStatus: result.orderStatus,
          shippingMethod: result.shippingMethod || current.shippingMethod
        } : current)
        setProductionLineNotice(result.lineWarning
          ? { variant: 'error', message: result.lineWarning }
          : null)
        if (result.lineWarning) {
          await persistProductionLineRetry({
            eventId: selectedEvent.id,
            attachmentIds: lineAttachmentIds,
            mode: 'fulfillment',
            shippingMethod: result.shippingMethod || pendingRetry?.shippingMethod || '',
            orderStatus: result.orderStatus,
          }, 'failed', result.lineWarning)
        } else {
          await clearProductionLineRetry(selectedEvent.id)
        }
      }
      setDetailAttachmentUploading(false)
      if (!photoFiles.length) {
        setDetailAttachmentUploadNotice({
          id: Date.now(),
          message: uploadedAttachments.length > 1 ? `${uploadedAttachments.length} 個附件上傳成功` : '上傳成功',
        })
      }
      void (async () => {
        try {
          await refreshCalendarData()
        } catch {
          await refreshCalendarData().catch(() => undefined)
        }
      })()
    } catch (error) {
      if (!firestoreUpdated && uploadedAttachments.length) {
        await deleteRemovedEventAttachments(uploadedAttachments, selectedEvent.id).catch(() => 0)
      }
      if (fulfillmentEvent && !firestoreUpdated) {
        setFulfillmentPaymentModal((current) => current?.eventId === selectedEvent.id ? null : current)
        setFulfillmentPaymentAmount('')
        setFulfillmentPaymentError('')
      }
      const message = error instanceof Error ? error.message : '附件上傳失敗，請稍後再試'
      if (fulfillmentEvent && firestoreUpdated && lineAttachmentIds.length > 0) {
        setProductionLineNotice({ variant: 'error', message: `照片已保留，但訂單完成失敗：${message}` })
        await persistProductionLineRetry({
          eventId: selectedEvent.id,
          attachmentIds: lineAttachmentIds,
          mode: 'fulfillment',
          shippingMethod: latestProductionLineStatus?.shippingMethod || selectedEvent.sourceShippingMethod || '',
          orderStatus: latestProductionLineStatus?.orderStatus || selectedEvent.orderStatus || '',
        }, 'failed', `照片已保留，但訂單完成失敗：${message}`).catch(() => undefined)
      } else {
        alert(message)
      }
    } finally {
      setDetailAttachmentUploading(false)
    }
  }

  function addCommentFiles(files: File[]) {
    const validFiles = files.filter((file) => file.size > 0)
    if (!validFiles.length) return
    const available = Math.max(0, 10 - commentFiles.length)
    if (available === 0) {
      alert('每則留言最多可附加 10 個檔案')
      return
    }
    if (validFiles.length > available) alert(`每則留言最多可附加 10 個檔案，這次加入前 ${available} 個`)
    setCommentFiles((items) => [
      ...items,
      ...validFiles.slice(0, Math.max(0, 10 - items.length)).map((file) => ({ id: createClientId(), file }))
    ])
  }

  function handleCommentAttachmentChange(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? [])
    event.target.value = ''
    addCommentFiles(files)
  }

  function handleCommentPaste(event: ReactClipboardEvent<HTMLTextAreaElement>) {
    const pastedImages = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file))
      .map((file, index) => new File([file], clipboardImageName(file, index), {
        type: file.type || 'image/png',
        lastModified: Date.now()
      }))
    if (!pastedImages.length) return
    if (!event.clipboardData.getData('text/plain')) event.preventDefault()
    addCommentFiles(pastedImages)
  }

  function removeCommentFile(id: string) {
    if (commentSending) return
    setCommentFiles((items) => items.filter((item) => item.id !== id))
  }

  async function sendEventComment() {
    const threadId = commentThreadId
    const text = commentDraft.trim()
    if (!threadId || !user || !employeeId || commentSending) return
    if (!text && !commentFiles.length) return
    if (text.length > 5000) {
      alert('留言文字最多 5000 字')
      return
    }

    const pendingItems = [...commentFiles]
    const pendingFiles = pendingItems.map((item) => item.file)
    const commentRef = doc(collection(db, 'calendarEvents', threadId, 'comments'))
    let uploadedAttachments: EventAttachment[] = []
    const durableRows: DurableBackgroundAttachmentUpload[] = []
    const photoItems = pendingItems.filter((item) => canUseBackgroundImageUpload(item.file))
    const directFiles = pendingItems.filter((item) => !canUseBackgroundImageUpload(item.file)).map((item) => item.file)
    const useBackgroundPhotoUpload = photoItems.length > 0
    let commentCreated = false
    let commentShellRequested = false
    setCommentSending(true)
    try {
      if (useBackgroundPhotoUpload) {
        for (const item of photoItems) {
          durableRows.push(await persistDurableBackgroundAttachmentUpload({
            id: item.id,
            uploaderUid: user.uid,
            eventId: threadId,
            uploadKind: 'comment',
            commentId: commentRef.id,
            completionMode: 'none',
            file: item.file,
          }))
        }
        if (directFiles.length) {
          uploadedAttachments = await uploadEventAttachments(threadId, directFiles, {
            uploadKind: 'comment',
            commentId: commentRef.id,
          })
        }
        commentShellRequested = true
        await createBackgroundCommentShell(threadId, commentRef.id, text, durableRows.length, uploadedAttachments)
        setEventCommentsReloadKey(value => value + 1)
        commentCreated = true
        setCommentBackgroundUploads((items) => [
          ...items,
          ...durableRows.map((row) => ({
            id: row.id,
            eventId: row.eventId,
            commentId: commentRef.id,
            name: row.name,
            previewUrl: URL.createObjectURL(row.blob),
            status: 'queued' as const,
            progress: 0,
            cloudSafe: false,
            createdAt: row.createdAt,
          })),
        ])
        if (activeCommentThreadIdRef.current === threadId) {
          setCommentDraft('')
          setCommentFiles([])
          window.setTimeout(() => commentThreadEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }), 80)
        }
        void processCommentBackgroundUploads(durableRows)
        return
      }
      if (pendingFiles.length) {
        uploadedAttachments = await uploadEventAttachments(threadId, pendingFiles, {
          uploadKind: 'comment',
          commentId: commentRef.id
        })
      }
      await createBackgroundCommentShell(threadId, commentRef.id, text, 0, uploadedAttachments)
      setEventCommentsReloadKey(value => value + 1)
      if (activeCommentThreadIdRef.current === threadId) {
        setCommentDraft('')
        setCommentFiles([])
        window.setTimeout(() => commentThreadEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }), 80)
      }
    } catch (error) {
      if (commentShellRequested && !commentCreated) {
        const existingComments = await fetchCalendarData<CalendarEventComment>('comments', { eventId: threadId }).catch(() => null)
        commentCreated = existingComments?.some(comment => comment.id === commentRef.id) === true
        if (!commentCreated) {
          console.warn('[calendar] 留言建立結果待確認，保留照片佇列與已上傳附件', error)
          alert('留言建立結果尚待確認，照片已保留於此裝置，請稍後確認留言狀態。')
          return
        }
      }
      if (commentCreated) {
        void processCommentBackgroundUploads(durableRows)
        console.warn('[calendar] 留言已建立，照片佇列繼續處理', error)
        return
      }
      if (uploadedAttachments.length) await deleteRemovedEventAttachments(uploadedAttachments, threadId).catch(() => 0)
      if (durableRows.length) {
        await Promise.allSettled(durableRows.map((row) => removeDurableBackgroundAttachmentUpload(row.id)))
      }
      const message = error instanceof Error ? error.message : '留言送出失敗，請稍後再試'
      alert(message)
    } finally {
      setCommentSending(false)
    }
  }

  async function deleteEventComment(comment: CalendarEventComment) {
    const threadId = commentThreadId
    if (!threadId || !user || deletingCommentId) return
    if (!isAdmin && comment.authorUid !== user.uid) return
    if (!window.confirm('確定要刪除這則留言嗎？')) return

    setDeletingCommentId(comment.id)
    try {
      await createCalendarActivity({ action: 'delete', commentId: comment.id }, 'comments', { eventId: threadId })
      setEventCommentsReloadKey(value => value + 1)
      const deleteFailures = await deleteRemovedEventAttachments(comment.attachments, threadId)
      const localUploads = commentBackgroundUploads.filter((upload) => upload.commentId === comment.id)
      await Promise.allSettled(localUploads.map((upload) => removeDurableBackgroundAttachmentUpload(upload.id)))
      setCommentBackgroundUploads((items) => items.filter((item) => {
        if (item.commentId !== comment.id) return true
        URL.revokeObjectURL(item.previewUrl)
        return false
      }))
      if (deleteFailures > 0) alert('留言已刪除，但部分雲端附件清除失敗')
    } catch (error) {
      const message = error instanceof Error ? error.message : '留言刪除失敗，請稍後再試'
      alert(message)
    } finally {
      setDeletingCommentId(null)
    }
  }

  async function toggleDetailTodo(todoId: string, done: boolean) {
    const selectedEvent = selectedOperationalEvent
    if (!canEditOrCopyErpEvent(employeeId, selectedEvent)) return
    if (!selectedEvent || isRelatedErpSalesDeliveryEvent(selectedEvent) || !canManageCalendarEvent(selectedEvent)) return
    const sourceEvent = events.find((event) => event.id === recurrenceRootId(selectedEvent)) ?? selectedEvent
    const nextTodos = (sourceEvent.todos ?? selectedEvent.todos ?? []).map((todo) => (
      todo.id === todoId ? { ...todo, done } : todo
    ))
    const updatedAt = new Date().toISOString()
    const nextEvent = { ...sourceEvent, todos: nextTodos, updatedAt }
    optimisticallyPatchCalendarEvents([nextEvent])

    try {
      await updateDoc(doc(db, 'calendarEvents', sourceEvent.id), {
        todos: nextTodos,
        updatedAt
      })
      await refreshCalendarData()
    } catch {
      alert('待辦清單更新失敗，請稍後再試')
      await refreshCalendarData().catch(() => undefined)
    }
  }

  function syncEventAttachmentsInBackground(eventId: string, files: File[], removedFiles: EventAttachment[]) {
    if (!files.length && !removedFiles.length) return

    void (async () => {
      let hasUploadFailure = false
      let deleteFailures = 0

      if (files.length) {
        try {
          const uploadedAttachments = await uploadEventAttachments(eventId, files)
          if (uploadedAttachments.length) {
            await updateDoc(doc(db, 'calendarEvents', eventId), {
              attachments: arrayUnion(...uploadedAttachments),
              updatedAt: new Date().toISOString()
            })
            await queryClient.invalidateQueries({ queryKey: ['calendarEvents'] })
          }
        } catch {
          hasUploadFailure = true
        }
      }

      if (removedFiles.length) {
        deleteFailures = await deleteRemovedEventAttachments(removedFiles, eventId)
      }

      if (hasUploadFailure) {
        alert('事件已儲存，但附件背景上傳失敗，請稍後重新上傳')
      } else if (deleteFailures > 0) {
        alert('事件已儲存，但部分雲端附件刪除失敗，請稍後再試')
      }
    })()
  }

  function removeExistingAttachment(file: EventAttachment) {
    if (editingSalesDeliveryEvent) return
    setEventForm((form) => ({
      ...form,
      attachments: form.attachments.filter((attachment) => attachment.path !== file.path)
    }))
    if (file.provider === 'google-drive' && file.path) {
      setDeletedAttachments((attachments) => (
        attachments.some((attachment) => attachment.path === file.path) ? attachments : [...attachments, file]
      ))
    }
  }

  function removeUploadedAttachment(upload: AttachmentUpload) {
    if (editingSalesDeliveryEvent) return
    canceledAttachmentUploadIdsRef.current.add(upload.id)
    setAttachmentUploads((items) => items.filter((item) => item.id !== upload.id))
    if (upload.attachment) {
      void deleteRemovedEventAttachments([upload.attachment], editingEventId ?? 'draft-event')
    }
  }

  async function deleteRemovedEventAttachments(files: EventAttachment[], eventId = '') {
    const driveFileIds = Array.from(new Set(files
      .filter((file) => file.provider === 'google-drive')
      .flatMap((file) => [file.path, file.thumbnailPath])
      .filter(Boolean)))
    if (!driveFileIds.length) return 0
    if (!user) return driveFileIds.length
    const token = await getFirebaseIdToken(user)
    const appCheckHeaders = await getAppCheckHeaders()

    const results = await Promise.allSettled(driveFileIds.map(async (fileId) => {
      const response = await fetch('/api/upload-drive', {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...appCheckHeaders
        },
        body: JSON.stringify({ fileId, eventId })
      })
      if (!response.ok) {
        const result = await response.json().catch(() => ({}))
        throw new Error(result.error || '附件刪除失敗')
      }
    }))

    return results.filter((result) => result.status === 'rejected').length
  }

  async function deleteEventViaApi(event: CalendarEvent, scope: RecurrenceEditScope, rootId: string, sourceDate: string) {
    if (!user) throw new Error('尚未登入')
    const [token, appCheckHeaders] = await Promise.all([
      getFirebaseIdToken(user),
      getAppCheckHeaders(),
    ])
    const response = await fetch('/api/delete-calendar-event', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...appCheckHeaders,
      },
      body: JSON.stringify({
        eventId: event.id,
        rootId,
        sourceDate,
        scope
      })
    })
    if (!response.ok) {
      const result = await response.json().catch(() => ({})) as { error?: string }
      throw new Error(result.error || `事件刪除失敗（HTTP ${response.status}）`)
    }
  }

  async function deleteEvent(event: CalendarEvent) {
    if (isPrimaryErpSalesDeliveryEvent(event)) {
      alert('ERP 建立的主事件不可在行事曆刪除；請刪除銷貨單或更改取件方式。')
      return
    }
    if (isHrReadonlyEvent(event)) {
      alert('此事件來自 HR 後台，請至 HR 後台刪除')
      return
    }
    if (!canManageCalendarEvent(event) || !canEditOrCopyErpEvent(employeeId, event)) {
      alert('沒有此事件的刪除權限')
      return
    }
    if (canUseRecurrenceScope(event)) {
      setRecurrenceDeleteCandidate(event)
      return
    }
    await applyDeleteEvent(event, 'all')
  }

  async function applyDeleteEvent(event: CalendarEvent, scope: RecurrenceEditScope) {
    if (!canManageCalendarEvent(event) || !canEditOrCopyErpEvent(employeeId, event)) {
      alert('沒有此事件的刪除權限')
      setRecurrenceDeleteCandidate(null)
      return
    }
    if (isPrimaryErpSalesDeliveryEvent(event)) {
      alert('ERP 建立的主事件不可在行事曆刪除；請刪除銷貨單或更改取件方式。')
      setRecurrenceDeleteCandidate(null)
      return
    }
    if (!confirm('確定刪除此事件？')) return
    setRecurrenceDeleteCandidate(null)
    try {
      const rootId = recurrenceRootId(event)
      const existingRootEvent = events.find((item) => item.id === rootId)
      const rootEvent = existingRootEvent ?? event
      const sourceDate = recurrenceSourceDate(event)
      await deleteEventViaApi(event, scope, rootId, sourceDate)
      if (isRecurrenceOccurrence(event) && !existingRootEvent) {
        optimisticallyRemoveCalendarEvents([event.id])
        setSelectedEventId(null)
        syncAfterDelete()
        return
      }
      if (scope === 'single' && (isRecurrenceOccurrence(event) || isRepeatingEvent(rootEvent))) {
        setSelectedEventId(null)
        syncAfterDelete()
        return
      }
      if (!(scope === 'future' && isRepeatingEvent(rootEvent) && sourceDate !== rootEvent.date)) {
        optimisticallyRemoveCalendarEvents([rootId])
      }
      setSelectedEventId((current) => current === event.id ? null : current)
      syncAfterDelete()
    } catch (error) {
      console.warn('[calendar] delete event failed', error)
      alert(error instanceof Error ? error.message : '事件刪除失敗')
    }
  }

  function eventDragAllowed(event: CalendarEvent) {
    return canEditOrCopyErpEvent(employeeId, event) && !isRelatedErpSalesDeliveryEvent(event) && canManageCalendarEvent(event)
  }

  function clearEventDragState() {
    setDragOverDateIfChanged(null)
    hideDragPreview()
    pointerDragRef.current = null
  }

  function setTouchEventDragDocumentMode(enabled: boolean) {
    document.documentElement.classList.toggle('calendar-event-touch-dragging', enabled)
    if (enabled) {
      window.getSelection?.()?.removeAllRanges()
    }
  }

  function setDragOverDateIfChanged(date: string | null) {
    if (dragOverDateRef.current === date) return
    dragOverDateRef.current = date
    setDragOverDate(date)
  }

  function showDragPreview(nextPreview: DragPreviewState) {
    if (dragPreviewFrameRef.current !== null) {
      window.cancelAnimationFrame(dragPreviewFrameRef.current)
      dragPreviewFrameRef.current = null
    }
    dragPreviewPointRef.current = null
    setDragPreview(nextPreview)
  }

  function moveDragPreview(x: number, y: number) {
    dragPreviewPointRef.current = { x, y }
    if (dragPreviewFrameRef.current !== null) return
    dragPreviewFrameRef.current = window.requestAnimationFrame(() => {
      dragPreviewFrameRef.current = null
      const point = dragPreviewPointRef.current
      const preview = eventDragPreviewRef.current
      if (!point || !preview) return
      preview.style.left = `${point.x}px`
      preview.style.top = `${point.y}px`
    })
  }

  function hideDragPreview() {
    if (dragPreviewFrameRef.current !== null) {
      window.cancelAnimationFrame(dragPreviewFrameRef.current)
      dragPreviewFrameRef.current = null
    }
    dragPreviewPointRef.current = null
    setDragPreview(null)
  }

  function openDragActionMenu(eventId: string, targetDate: string, x: number, y: number) {
    const draggedEvent = events.find((event) => event.id === eventId)
    if (!draggedEvent || !eventDragAllowed(draggedEvent)) return
    setSelectedDate(targetDate)
    setDragActionMenu({
      eventId,
      targetDate,
      x: Math.min(Math.max(x, 16), window.innerWidth - 176),
      y: Math.min(Math.max(y, 72), window.innerHeight - 130)
    })
  }

  function dragDateFromPoint(x: number, y: number) {
    const elements = document.elementsFromPoint(x, y)
    for (const element of elements) {
      if (element.closest('.event-drag-preview, .event-drag-menu')) continue
      const dateElement = element.closest<HTMLElement>('[data-calendar-date]')
      if (dateElement?.dataset.calendarDate) return dateElement.dataset.calendarDate
    }
    return ''
  }

  function isTouchDragPointer(event: Pick<ReactPointerEvent | globalThis.PointerEvent, 'pointerType'>) {
    return event.pointerType === 'touch' || event.pointerType === 'pen'
  }

  function shouldUseMobileEventListFlow() {
    return lastEventPointerTypeRef.current === 'touch' ||
      lastEventPointerTypeRef.current === 'pen' ||
      window.innerWidth <= 768 ||
      (window.matchMedia?.('(hover: none), (pointer: coarse)').matches ?? false)
  }

  function handleMonthDayClick(date: string) {
    if (selectedDate === date) {
      if (shouldUseMobileEventListFlow()) {
        setDayListDate(date)
        return
      }
      if (canCreateEvent) {
        openAddEvent(date)
        return
      }
      return
    }
    setSelectedDate(date)
  }

  function beginPointerEventDrag(event: ReactPointerEvent, calendarEvent: CalendarEvent) {
    if (isTouchDragPointer(event)) return
    if (!eventDragAllowed(calendarEvent)) return
    pointerDragRef.current = {
      eventId: calendarEvent.id,
      startX: event.clientX,
      startY: event.clientY,
      moved: false
    }
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }

  function movePointerEventDrag(event: ReactPointerEvent) {
    if (isTouchDragPointer(event)) return
    const drag = pointerDragRef.current
    if (!drag) return
    const distance = Math.abs(event.clientX - drag.startX) + Math.abs(event.clientY - drag.startY)
    if (distance < 8) return
    drag.moved = true
    const targetDate = dragDateFromPoint(event.clientX, event.clientY)
    setDragOverDateIfChanged(targetDate || null)
  }

  function endPointerEventDrag(event: ReactPointerEvent) {
    if (isTouchDragPointer(event)) return
    const drag = pointerDragRef.current
    if (!drag) return
    const targetDate = drag.moved ? dragDateFromPoint(event.clientX, event.clientY) : ''
    clearEventDragState()
    if (targetDate) {
      suppressEventClickRef.current = true
      openDragActionMenu(drag.eventId, targetDate, event.clientX, event.clientY)
      window.setTimeout(() => {
        suppressEventClickRef.current = false
      }, 0)
    }
  }

  function startNativeEventDrag(event: DragEvent, calendarEvent: CalendarEvent) {
    if (shouldUseMobileEventListFlow() || !eventDragAllowed(calendarEvent)) {
      event.preventDefault()
      return
    }
    event.dataTransfer.effectAllowed = 'copyMove'
    event.dataTransfer.setData('text/plain', calendarEvent.id)
    setDragActionMenu(null)
  }

  function dropEventOnDate(event: DragEvent, targetDate: string) {
    event.preventDefault()
    event.stopPropagation()
    const eventId = event.dataTransfer.getData('text/plain')
    clearEventDragState()
    if (eventId) {
      openDragActionMenu(eventId, targetDate, event.clientX, event.clientY)
    }
  }

  function clearDayListTouchDragListeners() {
    document.removeEventListener('pointermove', moveDayListTouchDrag)
    document.removeEventListener('pointerup', endDayListTouchDrag)
    document.removeEventListener('pointercancel', cancelDayListTouchDrag)
  }

  function resetDayListTouchDrag() {
    const drag = dayListTouchDragRef.current
    if (drag?.timer) window.clearTimeout(drag.timer)
    dayListTouchDragRef.current = null
    setTouchEventDragDocumentMode(false)
    hideDragPreview()
    clearDayListTouchDragListeners()
  }

  function beginDayListTouchDrag(event: ReactPointerEvent, calendarEvent: CalendarEvent) {
    if (!isTouchDragPointer(event) || !eventDragAllowed(calendarEvent)) return
    event.stopPropagation()
    window.getSelection?.()?.removeAllRanges()
    resetDayListTouchDrag()
    const sourceElement = event.currentTarget as HTMLElement
    const pointerId = event.pointerId
    const startX = event.clientX
    const startY = event.clientY
    const rect = event.currentTarget.getBoundingClientRect()
    const previewWidth = Math.max(112, Math.min(rect.width || 160, 220))
    const previewHeight = Math.max(28, Math.min(rect.height || 36, 56))
    const timer = window.setTimeout(() => {
      const drag = dayListTouchDragRef.current
      if (!drag || drag.pointerId !== pointerId) return
      drag.active = true
      showDragPreview({
        title: drag.title,
        x: drag.latestX,
        y: drag.latestY,
        width: drag.width,
        height: drag.height,
        color: drag.color
      })
      setDayListDate(null)
      setDayListSwipeOffset(0)
      dayListSwipeRef.current = null
    }, TOUCH_DRAG_LONG_PRESS_MS)

    dayListTouchDragRef.current = {
      eventId: calendarEvent.id,
      pointerId,
      startX,
      startY,
      latestX: startX,
      latestY: startY,
      timer,
      active: false,
      dragging: false,
      title: eventDisplayTitle(calendarEvent),
      width: previewWidth,
      height: previewHeight,
      color: eventCalendarColor(calendarEvent),
      sourceElement
    }
    document.addEventListener('pointermove', moveDayListTouchDrag)
    document.addEventListener('pointerup', endDayListTouchDrag)
    document.addEventListener('pointercancel', cancelDayListTouchDrag)
  }

  function moveDayListTouchDrag(event: globalThis.PointerEvent) {
    const drag = dayListTouchDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    drag.latestX = event.clientX
    drag.latestY = event.clientY
    if (drag.active) {
      event.preventDefault()
      event.stopPropagation()
      window.getSelection?.()?.removeAllRanges()
      moveDragPreview(event.clientX, event.clientY)
    }
    if (!drag.active) {
      const distance = Math.abs(event.clientX - drag.startX) + Math.abs(event.clientY - drag.startY)
      if (distance > TOUCH_DRAG_START_TOLERANCE) resetDayListTouchDrag()
      return
    }
    if (!drag.dragging) {
      const distance = Math.abs(event.clientX - drag.startX) + Math.abs(event.clientY - drag.startY)
      if (distance < 12) return
      drag.dragging = true
      suppressEventClickRef.current = true
      setTouchEventDragDocumentMode(true)
      setSelectedEventId(null)
      setDragActionMenu(null)
    }
    setDragOverDateIfChanged(dragDateFromPoint(event.clientX, event.clientY) || null)
  }

  function endDayListTouchDrag(event: globalThis.PointerEvent) {
    const drag = dayListTouchDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const targetDate = drag.dragging ? dragDateFromPoint(event.clientX, event.clientY) : ''
    const eventId = drag.eventId
    const wasDragging = drag.dragging
    const wasActive = drag.active
    resetDayListTouchDrag()
    if (wasDragging && targetDate) {
      setDayListDate(null)
      openDragActionMenu(eventId, targetDate, event.clientX, event.clientY)
    } else {
      setDragOverDateIfChanged(null)
    }
    if (wasActive) {
      suppressEventClickRef.current = true
      window.setTimeout(() => {
        suppressEventClickRef.current = false
      }, 300)
    }
  }

  function cancelDayListTouchDrag(event?: globalThis.PointerEvent) {
    const drag = dayListTouchDragRef.current
    if (event && drag && drag.pointerId !== event.pointerId) return
    const targetDate = drag?.dragging ? dragDateFromPoint(drag.latestX, drag.latestY) : ''
    const eventId = drag?.eventId ?? ''
    const latestX = drag?.latestX ?? window.innerWidth / 2
    const latestY = drag?.latestY ?? window.innerHeight / 2
    resetDayListTouchDrag()
    if (eventId && targetDate) {
      setDayListDate(null)
      openDragActionMenu(eventId, targetDate, latestX, latestY)
    } else {
      setDragOverDateIfChanged(null)
    }
    window.setTimeout(() => {
      suppressEventClickRef.current = false
    }, 300)
  }

  function handleDayListSwipeStart(event: ReactTouchEvent<HTMLElement>) {
    if ((!dayListDate && !showRelatedEventsPanel) || event.touches.length !== 1) return
    const touch = event.changedTouches[0] ?? event.touches[0]
    if (!touch) return
    const target = event.target
    const list = target instanceof Element ? target.closest('.tt-day-list-panel .panel-list') as HTMLElement | null : null
    dayListSwipeRef.current = {
      identifier: touch.identifier,
      startX: touch.clientX,
      startY: touch.clientY,
      dragging: false,
      enabled: !list || list.scrollTop <= 0,
    }
  }

  function handleDayListSwipeMove(event: ReactTouchEvent<HTMLElement>) {
    const swipe = dayListSwipeRef.current
    if (!swipe || !swipe.enabled) return
    const touch = Array.from(event.changedTouches).find((item) => item.identifier === swipe.identifier)
    if (!touch) return
    const deltaX = touch.clientX - swipe.startX
    const deltaY = touch.clientY - swipe.startY
    if (!swipe.dragging) {
      if (deltaY < 12 || Math.abs(deltaX) > deltaY) return
      swipe.dragging = true
      resetDayListTouchDrag()
    }
    event.preventDefault()
    setDayListSwipeOffset(Math.min(180, Math.max(0, deltaY)))
  }

  function handleDayListSwipeEnd(event: ReactTouchEvent<HTMLElement>) {
    const swipe = dayListSwipeRef.current
    if (!swipe) return
    const touch = Array.from(event.changedTouches).find((item) => item.identifier === swipe.identifier)
    const deltaY = touch ? touch.clientY - swipe.startY : dayListSwipeOffset
    const shouldClose = swipe.dragging && deltaY > 72
    dayListSwipeRef.current = null
    setDayListSwipeOffset(0)
    if (shouldClose) {
      event.preventDefault()
      if (showRelatedEventsPanel) setShowRelatedEventsPanel(false)
      else setDayListDate(null)
    }
  }

  function handleEventDetailSwipeStart(event: ReactTouchEvent<HTMLElement>) {
    if (!selectedEventId || event.touches.length !== 1) return
    const touch = event.changedTouches[0] ?? event.touches[0]
    if (!touch) return
    const target = event.target
    if (target instanceof Element && target.closest('button, input, select, textarea, a, .event-comment-composer, .event-detail-title')) {
      eventDetailSwipeRef.current = null
      return
    }
    const body = target instanceof Element ? target.closest('.event-detail-body') as HTMLElement | null : null
    eventDetailSwipeRef.current = {
      identifier: touch.identifier,
      startX: touch.clientX,
      startY: touch.clientY,
      dragging: false,
      enabled: !body || body.scrollTop <= 0,
    }
  }

  function handleEventDetailSwipeMove(event: ReactTouchEvent<HTMLElement>) {
    const swipe = eventDetailSwipeRef.current
    if (!swipe || !swipe.enabled) return
    const touch = Array.from(event.changedTouches).find((item) => item.identifier === swipe.identifier)
    if (!touch) return
    const deltaX = touch.clientX - swipe.startX
    const deltaY = touch.clientY - swipe.startY
    if (!swipe.dragging) {
      if (deltaY < 12 || Math.abs(deltaX) > deltaY) return
      swipe.dragging = true
    }
    event.preventDefault()
    setEventDetailSwipeOffset(Math.min(180, Math.max(0, deltaY)))
  }

  function handleEventDetailSwipeEnd(event: ReactTouchEvent<HTMLElement>) {
    const swipe = eventDetailSwipeRef.current
    if (!swipe) return
    const touch = Array.from(event.changedTouches).find((item) => item.identifier === swipe.identifier)
    const deltaY = touch ? touch.clientY - swipe.startY : eventDetailSwipeOffset
    const shouldClose = swipe.dragging && deltaY > 72
    eventDetailSwipeRef.current = null
    setEventDetailSwipeOffset(0)
    if (shouldClose) {
      event.preventDefault()
      setShowEventActionMenu(false)
      setSelectedEventId(null)
    }
  }

  async function applyDragEventAction(action: 'move' | 'copy') {
    if (!dragActionMenu) return
    const sourceEvent = events.find((event) => event.id === dragActionMenu.eventId)
    if (!sourceEvent || !eventDragAllowed(sourceEvent)) {
      setDragActionMenu(null)
      return
    }
    if (action === 'copy') {
      const targetDate = dragActionMenu.targetDate
      setSelectedDate(targetDate)
      setDragActionMenu(null)
      setDragOverDateIfChanged(null)
      openCopyEvent(sourceEvent, targetDate)
      return
    }

    setSaving(true)
    try {
      const nextDateRange = shiftedEventDateRange(sourceEvent, dragActionMenu.targetDate)
      if (action === 'move') {
        const updatedAt = new Date().toISOString()
        const movedEvent = {
          ...sourceEvent,
          ...nextDateRange,
          updatedAt
        }
        if (isPrimaryErpSalesDeliveryEvent(sourceEvent)) {
          await syncSalesDeliveryEventFields(
            sourceEvent,
            movedEvent,
            titleWithoutKnownIcon(sourceEvent.title, titleIconOptions).trim(),
          )
        } else {
          await updateDoc(doc(db, 'calendarEvents', sourceEvent.id), {
            ...nextDateRange,
            updatedAt
          })
        }
        const followUpResults = await Promise.allSettled([
          writeActivityLog({
            action: 'move',
            eventId: sourceEvent.id,
            eventTitle: eventDisplayTitle(sourceEvent),
            calendarId: eventDisplayCalendarId(sourceEvent),
            departmentId: sourceEvent.departmentId,
            assigneeIds: sourceEvent.assigneeIds,
            date: dragActionMenu.targetDate,
            changes: [{
              field: 'date',
              label: '日期',
              before: eventEndDate(sourceEvent) === sourceEvent.date ? sourceEvent.date : `${sourceEvent.date} - ${eventEndDate(sourceEvent)}`,
              after: nextDateRange.endDate === nextDateRange.date ? nextDateRange.date : `${nextDateRange.date} - ${nextDateRange.endDate}`
            }]
          })
        ])
        followUpResults.forEach((result) => {
          if (result.status === 'rejected') console.warn('[calendar] move follow-up sync failed', result.reason)
        })
        setSelectedEventId(null)
      }
      setDragActionMenu(null)
      setDragOverDateIfChanged(null)
      await refreshCalendarData()
    } catch (error) {
      alert(error instanceof Error
        ? error.message
        : (action === 'move' ? '事件移動失敗，請稍後再試' : '事件複製失敗，請稍後再試'))
    } finally {
      setSaving(false)
    }
  }

  async function deleteCalendar(id: string) {
    if (events.some((event) => event.calendarId === id || event.calendarIds?.includes(id))) {
      alert('此行事曆已有工作，請先刪除或移動工作')
      return
    }
    if (!confirm('確定刪除此行事曆？')) return
    try {
      await deleteDoc(doc(db, 'calendarCalendars', id))
      await queryClient.invalidateQueries({ queryKey: ['calendarCalendars'] })
    } catch {
      alert('行事曆刪除失敗')
    }
  }

  function renderDayListTime(event: CalendarEvent, calendarDate?: string) {
    if (event.allDay) return <b>全天</b>
    const daySegment = calendarDate
      ? eventDaySegmentForCalendarDate(event, calendarDate)
      : 'single'
    if (daySegment === 'middle') return <b>持續中</b>
    if (daySegment === 'start') return <b aria-label={`開始時間 ${event.startTime}`}>{event.startTime}</b>
    if (daySegment === 'end') return <b aria-label={`結束時間 ${event.endTime}`}>{event.endTime}</b>
    return (
      <>
        <b>{event.startTime}</b>
        <small>{event.endTime}</small>
      </>
    )
  }

  function renderEventSummary(event: CalendarEvent, options: { enableTouchDrag?: boolean; calendarDate?: string } = {}) {
    const rangeText = eventEndDate(event) === event.date ? event.date : `${event.date} - ${eventEndDate(event)}`
    const isTimeline = options.enableTouchDrag
    const secondaryText = eventListSecondaryText(event)
    return (
      <button
        className={`${isTimeline ? 'day-list-event' : 'panel-event'} ${isCalendarEventCompleted(event) ? 'done' : ''}`}
        key={event.id}
        style={{ '--event-color': eventCalendarColor(event) } as CSSProperties}
        draggable={Boolean(isTimeline && !isTouchDevice && !shouldUseMobileEventListFlow() && eventDragAllowed(event))}
        onDragStart={isTimeline ? (dragEvent) => startNativeEventDrag(dragEvent, event) : undefined}
        onDragEnd={isTimeline ? clearEventDragState : undefined}
        onPointerDown={(pointerEvent) => {
          if (!isTimeline) return
          lastEventPointerTypeRef.current = pointerEvent.pointerType
          if (isTouchDragPointer(pointerEvent)) {
            beginDayListTouchDrag(pointerEvent, event)
            return
          }
          beginPointerEventDrag(pointerEvent, event)
        }}
        onPointerMove={isTimeline ? movePointerEventDrag : undefined}
        onPointerUp={isTimeline ? endPointerEventDrag : undefined}
        onPointerCancel={isTimeline ? clearEventDragState : undefined}
        onClick={() => {
          if (suppressEventClickRef.current) return
          openEventDetail(event)
        }}
      >
        {isTimeline ? (
          <>
            <span className="day-list-time">
              {renderDayListTime(event, options.calendarDate)}
            </span>
            <span className="day-list-content">
              <strong>{eventDisplayTitle(event)}</strong>
              {secondaryText && <small>{secondaryText}</small>}
            </span>
            <span className="day-list-owner">{eventOwnerLabel(event)}</span>
          </>
        ) : (
          <>
            <span />
            <div>
              <strong>{eventDisplayTitle(event)}</strong>
              <small>{rangeText} {event.startTime} - {event.endTime} · {eventCalendarName(event)}</small>
            </div>
          </>
        )}
      </button>
    )
  }

  function deliveryGroupDisplayTitle(item: CalendarDayDisplayItem) {
    return deliveryGroupTitle(eventDisplayTitle(item.primaryEvent), item.events.length)
  }

  function deliveryGroupProgressText(item: CalendarDayDisplayItem) {
    const completedCount = deliveryGroupCompletedCount(item.events)
    return completedCount > 0 ? `已完成 ${completedCount}/${item.events.length}` : `${item.events.length} 筆訂單`
  }

  function renderDayDisplayItem(item: CalendarDayDisplayItem, date: string) {
    const event = item.primaryEvent
    if (!item.isDeliveryGroup) {
      return renderEventSummary(event, { enableTouchDrag: true, calendarDate: date })
    }
    return (
      <button
        className="day-list-event delivery-group-summary"
        key={item.key}
        style={{ '--event-color': eventCalendarColor(event) } as CSSProperties}
        onClick={() => openDeliveryGroup(item)}
      >
        <span className="day-list-time">
          {renderDayListTime(event, date)}
        </span>
        <span className="day-list-content">
          <strong>{deliveryGroupDisplayTitle(item)}</strong>
          <small>{event.location} · {deliveryGroupProgressText(item)}</small>
        </span>
        <span className="delivery-group-count" aria-label={`${item.events.length}筆訂單`}>{item.events.length}</span>
      </button>
    )
  }

  function renderMonthGridDays(days: dayjs.Dayjs[], displayMonth: dayjs.Dayjs, activeMonth: boolean) {
    return days.map((day) => {
      const date = day.format('YYYY-MM-DD')
      const dayItems = displayItemsByDate.get(date) ?? []
      const visibleDayEventCount = dayItems.length > monthDayEventRowLimit ? monthDayEventRowLimit - 1 : monthDayEventRowLimit
      const visibleDayItems = dayItems.slice(0, visibleDayEventCount)
      const hiddenDayEventCount = dayItems.length - visibleDayEventCount
      const selected = selectedDate === date
      const today = dayjs().format('YYYY-MM-DD') === date
      return (
        <button
          className={`day-cell ${selected ? 'selected' : ''} ${day.month() !== displayMonth.month() ? 'muted' : ''} ${dragOverDate === date ? 'drag-over' : ''}`}
          key={date}
          data-calendar-date={activeMonth ? date : undefined}
          onClick={() => activeMonth && handleMonthDayClick(date)}
          onDragOver={(dragEvent) => {
            if (!activeMonth) return
            dragEvent.preventDefault()
            setDragOverDateIfChanged(date)
          }}
          onDragLeave={() => activeMonth && dragOverDateRef.current === date && setDragOverDateIfChanged(null)}
          onDrop={(dragEvent) => activeMonth && dropEventOnDate(dragEvent, date)}
          tabIndex={activeMonth ? 0 : -1}
          aria-hidden={!activeMonth}
        >
          <span className={`day-number ${today ? 'today' : ''}`}>{day.date()}</span>
          <span className="day-events">
            {visibleDayItems.map((item) => {
              const event = item.primaryEvent
              return (
              <button
                className={`event-pill ${event.allDay ? 'all-day' : 'timed'} ${item.events.every(isCalendarEventCompleted) ? 'done' : ''} ${selectedEventId === event.id || selectedDeliveryGroupKey === item.key ? 'active' : ''}`}
                style={{ '--event-color': eventCalendarColor(event) } as CSSProperties}
                key={item.key}
                draggable={activeMonth && !item.isDeliveryGroup && !isTouchDevice && !shouldUseMobileEventListFlow() && eventDragAllowed(event)}
                onDragStart={(dragEvent) => activeMonth && !item.isDeliveryGroup && startNativeEventDrag(dragEvent, event)}
                onDragEnd={clearEventDragState}
                onTouchStart={() => {
                  if (activeMonth) lastEventPointerTypeRef.current = 'touch'
                }}
                onPointerDown={(pointerEvent) => {
                  if (!activeMonth) return
                  lastEventPointerTypeRef.current = pointerEvent.pointerType
                  if (item.isDeliveryGroup || isTouchDragPointer(pointerEvent)) {
                    return
                  }
                  beginPointerEventDrag(pointerEvent, event)
                }}
                onPointerMove={activeMonth ? movePointerEventDrag : undefined}
                onPointerUp={activeMonth ? endPointerEventDrag : undefined}
                onPointerCancel={clearEventDragState}
                onClick={(clickEvent) => {
                  clickEvent.stopPropagation()
                  if (!activeMonth || suppressEventClickRef.current) return
                  if (shouldUseMobileEventListFlow()) {
                    handleMonthDayClick(date)
                    window.setTimeout(() => {
                      lastEventPointerTypeRef.current = ''
                    }, 0)
                    return
                  }
                  lastEventPointerTypeRef.current = ''
                  if (item.isDeliveryGroup) {
                    openDeliveryGroup(item)
                  } else {
                    openEventDetail(event, { preserveMonth: day.month() !== displayMonth.month() })
                  }
                }}
                tabIndex={activeMonth ? 0 : -1}
              >
                <span>{item.isDeliveryGroup ? deliveryGroupDisplayTitle(item) : eventDisplayTitle(event)}</span>
                {!event.allDay && <small>{eventTimeLabelForCalendarDate(event, date)}</small>}
              </button>
              )
            })}
            {hiddenDayEventCount > 0 && (
              <span
                className="more-pill"
                role="button"
                tabIndex={activeMonth ? 0 : -1}
                onClick={(clickEvent) => {
                  clickEvent.stopPropagation()
                  if (!activeMonth) return
                  setSelectedDate(date)
                  setDayListDate(date)
                }}
                onKeyDown={(keyEvent) => {
                  if (!activeMonth || (keyEvent.key !== 'Enter' && keyEvent.key !== ' ')) return
                  keyEvent.preventDefault()
                  keyEvent.stopPropagation()
                  setSelectedDate(date)
                  setDayListDate(date)
                }}
              >
                +{hiddenDayEventCount}
              </span>
            )}
          </span>
        </button>
      )
    })
  }

  function renderWeekGridDays(days: dayjs.Dayjs[], activeWeek: boolean) {
    return days.map((day) => {
      const date = day.format('YYYY-MM-DD')
      const dayItems = displayItemsByDate.get(date) ?? []
      const selected = activeWeek && selectedDate === date
      const today = dayjs().format('YYYY-MM-DD') === date
      return (
        <button
          className={`week-day ${selected ? 'selected' : ''} ${activeWeek && dragOverDate === date ? 'drag-over' : ''}`}
          key={date}
          data-calendar-date={activeWeek ? date : undefined}
          onClick={() => {
            if (!activeWeek) return
            setSelectedDate(date)
            setMonth(day.startOf('month'))
          }}
          onDragOver={(dragEvent) => {
            if (!activeWeek) return
            dragEvent.preventDefault()
            setDragOverDateIfChanged(date)
          }}
          onDragLeave={() => activeWeek && dragOverDateRef.current === date && setDragOverDateIfChanged(null)}
          onDrop={(dragEvent) => activeWeek && dropEventOnDate(dragEvent, date)}
          tabIndex={activeWeek ? 0 : -1}
          aria-hidden={!activeWeek}
        >
          <span className={`week-date ${today ? 'today' : ''}`}>{day.format('M/D')}</span>
          <strong>星期{WEEKDAYS[day.day()]}</strong>
          <span className="week-events">
            {dayItems.length === 0 ? <small>沒有工作</small> : dayItems.map((item) => {
              const event = item.primaryEvent
              return (
              <button
                className={`week-event ${event.allDay ? 'all-day' : 'timed'} ${item.events.every(isCalendarEventCompleted) ? 'done' : ''} ${selectedEventId === event.id || selectedDeliveryGroupKey === item.key ? 'active' : ''}`}
                style={{ '--event-color': eventCalendarColor(event) } as CSSProperties}
                key={item.key}
                draggable={activeWeek && !item.isDeliveryGroup && !isTouchDevice && !shouldUseMobileEventListFlow() && eventDragAllowed(event)}
                onDragStart={(dragEvent) => activeWeek && !item.isDeliveryGroup && startNativeEventDrag(dragEvent, event)}
                onDragEnd={clearEventDragState}
                onTouchStart={() => {
                  if (activeWeek) lastEventPointerTypeRef.current = 'touch'
                }}
                onPointerDown={(pointerEvent) => {
                  if (!activeWeek) return
                  lastEventPointerTypeRef.current = pointerEvent.pointerType
                  if (item.isDeliveryGroup) return
                  if (isTouchDragPointer(pointerEvent)) {
                    beginDayListTouchDrag(pointerEvent, event)
                    return
                  }
                  beginPointerEventDrag(pointerEvent, event)
                }}
                onPointerMove={activeWeek ? movePointerEventDrag : undefined}
                onPointerUp={activeWeek ? endPointerEventDrag : undefined}
                onPointerCancel={clearEventDragState}
                onClick={(clickEvent) => {
                  clickEvent.stopPropagation()
                  if (!activeWeek || suppressEventClickRef.current) return
                  if (shouldUseMobileEventListFlow()) {
                    handleMonthDayClick(date)
                    window.setTimeout(() => {
                      lastEventPointerTypeRef.current = ''
                    }, 0)
                    return
                  }
                  lastEventPointerTypeRef.current = ''
                  if (item.isDeliveryGroup) {
                    openDeliveryGroup(item)
                  } else {
                    openEventDetail(event)
                  }
                }}
                tabIndex={activeWeek ? 0 : -1}
              >
                <i />
                <span>{event.allDay ? '整天' : eventTimeLabelForCalendarDate(event, date)}</span>
                <b>{item.isDeliveryGroup ? deliveryGroupDisplayTitle(item) : eventDisplayTitle(event)}</b>
              </button>
              )
            })}
          </span>
        </button>
      )
    })
  }

  async function openSalesFormWithCalendarLogin(
    clickEvent: ReactMouseEvent<HTMLAnchorElement>,
    salesId: string,
  ) {
    if (
      clickEvent.button !== 0
      || clickEvent.metaKey
      || clickEvent.ctrlKey
      || clickEvent.shiftKey
      || clickEvent.altKey
    ) return

    setSalesFormOpenError('')
    const prepared = salesFormRedirectPrefetchesRef.current.get(salesId)
    const preparedUrl = prepared && Date.now() - prepared.createdAt < SALES_FORM_REDIRECT_REUSE_MS
      ? prepared.redirectUrl
      : ''
    const salesFormWindow = window.open(
      preparedUrl || 'about:blank',
      SALES_FORM_POPUP_NAME,
      SALES_FORM_POPUP_FEATURES,
    )
    if (!salesFormWindow) {
      setSalesFormOpenError('瀏覽器阻擋了新分頁，請允許彈出式視窗後再試。')
      return
    }
    clickEvent.preventDefault()
    salesFormWindow.opener = null
    if (!preparedUrl) {
      try {
        salesFormWindow.document.title = '正在開啟銷貨單'
        salesFormWindow.document.body.style.cssText = 'margin:0;min-height:100vh;display:grid;place-items:center;background:#f8fafc;color:#475467;font:600 16px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif'
        salesFormWindow.document.body.textContent = '正在開啟銷貨單…'
      } catch {
        // 跨站導覽已提前開始時不再改寫等待畫面。
      }
    }

    try {
      const redirectUrl = preparedUrl || await prepareSalesFormRedirect(salesId)
      salesFormRedirectPrefetchesRef.current.delete(salesId)
      if (!preparedUrl) salesFormWindow.location.replace(redirectUrl)
    } catch (error) {
      salesFormWindow.close()
      setSalesFormOpenError(firebaseRequestErrorMessage(error, '開啟銷貨單失敗，請稍後再試。'))
    }
  }

  function handleManagerChatClick(
    clickEvent: ReactMouseEvent<HTMLAnchorElement>,
    chatUrl: string,
  ) {
    if (!window.matchMedia?.('(max-width: 768px)').matches) return
    clickEvent.preventDefault()
    try {
      window.location.assign(chatUrl)
    } catch (error) {
      setProductionLineNotice({
        variant: 'error',
        message: error instanceof Error ? error.message : '開啟聊天室失敗',
      })
    }
  }

  function renderEventDetailPanel() {
    if (!selectedEvent) return null
    const calendar = visibleCalendarMap.get(eventDisplayCalendarId(selectedEvent))
    const calendarName = calendar?.name || eventCalendarName(selectedEvent) || '未分類行事曆'
    const assignees = selectedEvent.assigneeIds.map(employeeName)
    const reminderLabel = REMINDER_OPTIONS.find((option) => option.value === (selectedEvent.reminder ?? 'none'))?.label ?? '無通知'
    const eventRepeatLabel = repeatLabel(selectedEvent.repeat, selectedEvent.date, selectedEvent.repeatCustom)
    const locationText = selectedEvent.location?.trim()
    const canManageEvent = canManageCalendarEvent(selectedEvent)
    const canEditOrCopyEvent = canManageEvent && canEditOrCopyErpEvent(employeeId, selectedEvent)
    const canDeleteEvent = canManageEvent && canEditOrCopyErpEvent(employeeId, selectedEvent) && !isPrimaryErpSalesDeliveryEvent(selectedEvent)
    const orderFulfillmentEvent = Boolean(selectedOperationalEvent && isErpOrderFulfillmentEvent(selectedOperationalEvent, productionLineStatus))
    const canUploadAttachment = Boolean(selectedOperationalEvent && (!isRelatedErpSalesDeliveryEvent(selectedOperationalEvent) || isErpSalesWorkScheduleEvent(selectedOperationalEvent))
      && canUploadDetailAttachment(selectedOperationalEvent, productionLineStatus))
    const visibilityTitleRows = eventDetailVisibilityTitleRows(selectedEvent)
    const relationBadgeLabel = isRelatedErpSalesDeliveryEvent(selectedEvent)
      ? '附屬事件'
      : hasRelatedSalesDeliveryEvents ? '主事件' : ''
    return (
      <aside
        className={`event-detail-panel${eventDetailSwipeOffset > 0 ? ' swiping' : ''}${canManageEvent ? ' has-management-footer' : ''}`}
        style={{
          '--event-color': eventCalendarColor(selectedEvent),
          '--event-detail-swipe-offset': `${eventDetailSwipeOffset}px`
        } as CSSProperties}
        onTouchStart={handleEventDetailSwipeStart}
        onTouchMove={handleEventDetailSwipeMove}
        onTouchEnd={handleEventDetailSwipeEnd}
        onTouchCancel={handleEventDetailSwipeEnd}
      >
        <div className="event-detail-header">
          <strong>事件詳情</strong>
          <div>
            {canUploadAttachment && selectedEvent.source === 'erpSalesDelivery' && (
              <>
                <button
                  type="button"
                  className="event-detail-upload-btn"
                  onPointerDown={() => { if (selectedOperationalEvent) prefetchCombinedDelivery(selectedOperationalEvent) }}
                  onFocus={() => { if (selectedOperationalEvent) prefetchCombinedDelivery(selectedOperationalEvent) }}
                  onClick={() => detailAttachmentInputRef.current?.click()}
                  disabled={detailAttachmentUploading}
                  aria-label={orderFulfillmentEvent ? '上傳外送、施工或活動完成照片' : '上傳檔案或照片'}
                >
                  <span>＋</span>
                  <b>{detailAttachmentUploading
                    ? '上傳中'
                    : orderFulfillmentEvent ? '完成照片' : '上傳'}</b>
                </button>
                <input
                  ref={detailAttachmentInputRef}
                  className="event-detail-upload-input"
                  type="file"
                  multiple
                  accept={orderFulfillmentEvent ? 'image/*' : undefined}
                  onChange={handleDetailAttachmentFileChange}
                />
              </>
            )}
            {(canEditOrCopyEvent || canDeleteEvent) && (
              <div className="event-detail-action-wrap">
                <button
                  onClick={() => setShowEventActionMenu((open) => !open)}
                  aria-label="開啟事件選單"
                  aria-expanded={showEventActionMenu}
                >
                  ⋮
                </button>
                {showEventActionMenu && (
                  <div className="event-detail-action-menu">
                    {canEditOrCopyEvent && (<>
                    <button
                      type="button"
                      onClick={() => {
                        setShowEventActionMenu(false)
                        openEditEvent(selectedEvent)
                      }}
                    >
                      編輯
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setShowEventActionMenu(false)
                        openCopyEvent(selectedEvent)
                      }}
                    >
                      複製
                    </button>
                    </>)}
                    {canDeleteEvent && (
                      <button
                        type="button"
                        className="danger"
                        onClick={() => {
                          setShowEventActionMenu(false)
                          deleteEvent(selectedEvent)
                        }}
                      >
                        刪除
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
            <button
              onClick={() => {
                const returnDayListDate = eventDetailReturnDayListDateRef.current
                eventDetailReturnDayListDateRef.current = null
                setShowEventActionMenu(false)
                setSelectedEventId(null)
                if (returnDayListDate) setDayListDate(returnDayListDate)
              }}
              aria-label="關閉事件詳情"
            >
              ×
            </button>
          </div>
        </div>

        <div className="event-detail-body">
          <div className="event-detail-badges">
            <div className="event-detail-avatar" style={{ background: eventCalendarColor(selectedEvent) }}>
              {calendarName}
            </div>
            {relationBadgeLabel && (
              <button
                type="button"
                className="event-detail-related-badge"
                onClick={() => setShowRelatedEventsPanel(true)}
                aria-label={`開啟${relationBadgeLabel}的關聯事件清單`}
              >
                {relationBadgeLabel}
              </button>
            )}
          </div>
          <h2 className="event-detail-title">{eventDisplayTitle(selectedEvent)}</h2>
          {visibilityTitleRows.length > 0 && (
            <div className="event-detail-visibility-titles" aria-label="可見對象與替代標題">
              {visibilityTitleRows.map((row) => (
                <div className={row.muted ? 'muted' : ''} key={`${row.target}-${row.title}`}>
                  <span>{row.target}</span>
                  <b>{row.title}</b>
                </div>
              ))}
            </div>
          )}
          <div className="event-detail-time">
            <div>
              <span>{formatChineseDate(selectedEvent.date)}</span>
              {!selectedEvent.allDay && <strong>{selectedEvent.startTime}</strong>}
            </div>
            <b>›</b>
            <div>
              <span>{formatChineseDate(eventEndDate(selectedEvent))}</span>
              {!selectedEvent.allDay && <strong>{selectedEvent.endTime}</strong>}
            </div>
          </div>

          {isErpSalesDeliveryEvent(selectedEvent) && (
            <div className="event-detail-line-delivery">
              <div className="event-detail-fulfillment-status">
                <strong>{productionLineStatus?.orderStatus || selectedEvent.orderStatus || '狀態讀取中'}</strong>
                {(!productionLineStatus?.bound || (productionLineStatus.managerChats || []).length > 0) && (
                  <small className="event-detail-line-summary">
                    <span>{productionLineStatus?.bound
                      ? '官方 LINE：'
                      : productionLineStatus
                        ? productionLineBindingDescription(productionLineStatus)
                        : productionLineStatusLoading
                          ? '官方 LINE：正在確認綁定狀態...'
                          : '官方 LINE：目前無法取得綁定資料'}</span>
                    {(productionLineStatus?.managerChats || []).map((chat, index) => (
                    <span className="event-detail-manager-chat-entry" key={chat.url}>
                      {index > 0 && ' · '}
                      <a
                        className="event-detail-manager-chat-link"
                        href={chat.url}
                        target="_blank"
                        rel="noreferrer"
                        title="開啟官方 LINE 聊天室"
                        onClick={(event) => handleManagerChatClick(event, chat.url)}
                      >
                        {chat.name}
                      </a>
                    </span>
                    ))}
                  </small>
                )}
                {productionLineStatusError && <small className="error" role="status">{productionLineStatusError}</small>}
                {teardownPrimaryEventQuery.isError && <small className="error" role="status">排程共用資訊讀取失敗，請稍後重試。</small>}
                {orderFulfillmentEvent && <small>{isErpSalesWorkScheduleEvent(selectedEvent) || fulfillmentShippingMethod(selectedEvent, productionLineStatus) === '施工'
                  ? '上傳照片後會記錄本次完成並同步客戶附件；全部施工完成後才完成訂單與通知，撤場另外追蹤。'
                  : '上傳照片後會同步完成訂單、客戶附件與 LINE 通知。'}</small>}
              </div>
              {orderFulfillmentEvent && productionLineNotice && (
                <div className={`event-detail-line-notice ${productionLineNotice.variant}`}>
                  <span>{productionLineNotice.message}</span>
                  {productionLineRetry && (
                    <button type="button" disabled={productionLineRetrying} onClick={retryProductionPhotoDelivery}>
                      {productionLineRetrying ? '重試中...' : '重試訂單完成'}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {assignees.length > 0 && (
            <div className="event-detail-row">
              <EventRowIcon name="person" />
              <div>{assignees.join('、')}</div>
            </div>
          )}
          {(selectedEvent.reminder ?? 'none') !== 'none' && (
            <div className="event-detail-row">
              <EventRowIcon name="bell" />
              <div>{reminderLabel}</div>
            </div>
          )}
          {selectedEvent.repeat && selectedEvent.repeat !== 'none' && (
            <div className="event-detail-row">
              <EventRowIcon name="repeat" />
              <div>{eventRepeatLabel}</div>
            </div>
          )}
          {selectedEvent.url && (
            <a className="event-detail-link" href={selectedEvent.url} target="_blank" rel="noreferrer">
              <EventRowIcon name="link" />
              <div>{selectedEvent.url}</div>
            </a>
          )}
          {locationText && (
            <div className="event-detail-row">
              <EventRowIcon name="location" />
              <a href={googleMapsDirectionUrl(locationText)} target="_blank" rel="noreferrer">{locationText}</a>
            </div>
          )}
          {locationText && (
            <a
              className="event-detail-map clickable"
              href={googleMapsDirectionUrl(locationText)}
              target="_blank"
              rel="noreferrer"
              aria-label={`開啟 ${locationText} 的 Google 地圖導航`}
            >
              <iframe
                title={`${locationText} 地圖預覽`}
                src={googleMapsEmbedUrl(locationText)}
                loading="lazy"
                referrerPolicy="no-referrer-when-downgrade"
              />
              <div>
                <strong>{locationText}</strong>
                <small>開啟 Google 地圖導航</small>
              </div>
            </a>
          )}

          {selectedEvent.note && (!isHrLeaveRequestEvent(selectedEvent) || canViewHrLeaveNote) && (
            <div className="event-detail-note">
              <strong>備註</strong>
              <p>{eventDetailNoteContent(
                selectedEvent,
                canOpenSalesForm,
                productionLineStatus,
                canManageEvent,
                productionLineStatusLoading,
                productionLineStatus ? '' : productionLineStatusError,
                openSalesFormWithCalendarLogin,
              )}</p>
              {salesFormOpenError && <div className="form-error" role="alert">{salesFormOpenError}</div>}
            </div>
          )}
          {canViewSalesAttachments && (
            eventDetailAttachments.length > 0
            || selectedEventBackgroundUploads.length > 0
            || salesCenterAttachmentsLoading
            || (selectedEvent.source === 'erpSalesDelivery' && Boolean(salesCenterAttachmentsError))
          ) && (
            <div className="event-detail-attachments">
              <strong>附件中心</strong>
              {salesCenterAttachmentsLoading && eventDetailAttachments.length === 0 && selectedEventBackgroundUploads.length === 0 ? (
                <div className="event-detail-attachment-loading" role="status" aria-label="附件中心照片載入中">
                  <span aria-hidden="true" />
                  <span aria-hidden="true" />
                  <span aria-hidden="true" />
                </div>
              ) : salesCenterAttachmentsError && eventDetailAttachments.length === 0 && selectedEventBackgroundUploads.length === 0 ? (
                <div className="event-detail-attachment-error" role="alert">
                  <span>{salesCenterAttachmentsError}</span>
                  <button type="button" onClick={() => void salesCenterAttachmentsQuery.refetch()}>重試</button>
                </div>
              ) : (
                <div className="event-detail-attachment-grid">
                {selectedEventBackgroundUploads.map((upload) => {
                  const label = backgroundAttachmentDisplayLabel(upload)
                  if (upload.status === 'failed') {
                    return (
                      <div
                        className="event-detail-attachment-thumb"
                        aria-label={`${upload.name}，${label}`}
                        title={label}
                        key={upload.id}
                        style={{ position: 'relative', overflow: 'hidden', opacity: 0.78 }}
                      >
                        <img src={upload.previewUrl} alt={upload.name} style={{ opacity: 0.45 }} />
                        <span style={{
                          position: 'absolute',
                          inset: '4px 4px auto',
                          padding: '4px 6px',
                          borderRadius: 6,
                          background: 'rgba(112, 17, 17, 0.82)',
                          color: '#fff',
                          fontSize: 11,
                          lineHeight: 1.25,
                        }}>
                          {label}
                        </span>
                        <button
                          type="button"
                          onClick={() => upload.fulfillmentRequestId ? void retryCombinedBackgroundUploads(upload.fulfillmentRequestId) : removeFailedDetailBackgroundUpload(upload.id)}
                          aria-label={upload.fulfillmentRequestId ? '重試整批配達回報' : `移除失敗照片：${upload.name}`}
                          style={{
                            position: 'absolute',
                            inset: 'auto 4px 4px',
                            minHeight: 44,
                            border: 0,
                            borderRadius: 8,
                            background: 'rgba(255, 255, 255, 0.94)',
                            color: '#991b1b',
                            fontWeight: 800,
                          }}
                        >
                          {upload.fulfillmentRequestId ? '重試整批回報' : '移除'}
                        </button>
                      </div>
                    )
                  }
                  return (
                    <button
                      type="button"
                      className="event-detail-attachment-thumb"
                      onClick={() => openPendingDetailAttachment(upload)}
                      aria-label={`${upload.name}，${label}`}
                      title={label}
                      key={upload.id}
                      style={{ position: 'relative', overflow: 'hidden' }}
                    >
                      <img src={upload.previewUrl} alt={upload.name} style={{ opacity: upload.cloudSafe ? 1 : 0.55 }} />
                      <span style={{
                        position: 'absolute',
                        inset: 'auto 4px 4px',
                        padding: '4px 6px',
                        borderRadius: 6,
                        background: upload.cloudSafe ? 'rgba(22, 101, 52, 0.9)' : 'rgba(0, 0, 0, 0.72)',
                        color: '#fff',
                        fontSize: 11,
                        lineHeight: 1.25,
                      }}>
                        {label}
                      </span>
                    </button>
                  )
                })}
                {eventDetailAttachments.map((attachment, attachmentIndex) => {
                  const previewUrl = attachmentPreviewUrl(attachment)
                  const attachmentName = attachment.originalName || attachment.name
                  return previewUrl ? (
                    <AttachmentThumbnail
                      eventId={selectedEvent.source === 'erpSalesDelivery' && attachment.linePreviewUrl?.includes('scope=sales-attachment') ? undefined : selectedEvent.id}
                      className="event-detail-attachment-thumb"
                      attachment={{ ...attachment, name: attachmentName }}
                      onOpen={() => setEnlargedEventAttachment(attachment)}
                      onReload={selectedEvent.source === 'erpSalesDelivery'
                        ? () => { void salesCenterAttachmentsQuery.refetch() }
                        : undefined}
                      key={attachment.path || attachment.url}
                      loading={attachmentIndex < 3 ? 'eager' : 'lazy'}
                      fetchPriority={attachmentIndex < 3 ? 'high' : 'auto'}
                    />
                  ) : (
                    <CalendarAttachmentFile
                      eventId={selectedEvent.id}
                      className="event-detail-attachment-file"
                      href={attachment.url}
                      target="_blank"
                      rel="noreferrer"
                      title={attachmentName}
                      key={attachment.path || attachment.url}
                    >
                      <span>附件</span>
                      <b>{attachmentName}</b>
                    </CalendarAttachmentFile>
                  )
                })}
                </div>
              )}
            </div>
          )}
          {selectedEvent.todos && selectedEvent.todos.length > 0 && (
            <div className="event-detail-todos">
              <strong>待辦清單</strong>
              {selectedEvent.todos.map((todo) => (
                <label key={todo.id}>
                  <input
                    type="checkbox"
                    checked={todo.done}
                    disabled={!selectedOperationalEvent || !canEditOrCopyErpEvent(employeeId, selectedOperationalEvent)
                      || !canManageCalendarEvent(selectedOperationalEvent) || isRelatedErpSalesDeliveryEvent(selectedOperationalEvent)}
                    onChange={(event) => toggleDetailTodo(todo.id, event.target.checked)}
                  />
                  <span>{todo.text}</span>
                </label>
              ))}
            </div>
          )}

          <section className="event-comment-thread" aria-label="事件留言板">
            <div className="event-comment-thread-title">
              <strong>留言板</strong>
              {eventComments.length >= 100 && <small>顯示最近 100 則</small>}
            </div>
            {!eventCommentsReady && !eventCommentsError && (
              <div className="event-comment-empty is-loading" aria-label="留言載入中">留言同步中…</div>
            )}
            {eventCommentsError && eventComments.length === 0 && (
              <div className="event-comment-error" role="alert">
                <span>{eventCommentsError}</span>
                <button type="button" onClick={() => setEventCommentsReloadKey((key) => key + 1)}>重試</button>
              </div>
            )}
            {eventCommentsReady && !eventCommentsError && eventComments.length === 0 && (
              <div className="event-comment-empty">還沒有留言，輸入第一則訊息吧</div>
            )}
            {eventComments.length > 0 && groupedEventComments.map((group) => (
              <div className="event-comment-date-group" key={group.key}>
                <div className="event-comment-date-label">{group.label}</div>
                {group.comments.map((comment) => {
                  const isOwnComment = comment.authorUid === user?.uid
                  const canDeleteComment = isAdmin || isOwnComment
                  const remoteJobIds = new Set(comment.attachments.map((attachment) => attachment.uploadJobId).filter(Boolean))
                  const remotePaths = new Set(comment.attachments.map((attachment) => attachment.path).filter(Boolean))
                  const localCommentUploads = commentBackgroundUploads.filter((upload) => (
                    upload.eventId === commentThreadId
                    && upload.commentId === comment.id
                    && !(upload.jobId && remoteJobIds.has(upload.jobId))
                    && !(upload.attachmentPath && remotePaths.has(upload.attachmentPath))
                  ))
                  const hasActiveCommentUpload = localCommentUploads.some((upload) => upload.status !== 'failed')
                  return (
                    <article className={`event-comment${isOwnComment ? ' own' : ''}`} key={comment.id}>
                      <div className="event-comment-content">
                        <div className="event-comment-meta">
                          <span>
                            <strong>{eventCommentAuthorName(comment)}</strong>
                            <time dateTime={comment.createdAt}>{commentTimeLabel(comment.createdAt)}</time>
                          </span>
                          {canDeleteComment && (
                            <button
                              type="button"
                              onClick={() => deleteEventComment(comment)}
                              disabled={deletingCommentId === comment.id || hasActiveCommentUpload}
                              aria-label={`刪除 ${eventCommentAuthorName(comment)} 的留言`}
                            >
                              {deletingCommentId === comment.id ? '刪除中' : '刪除'}
                            </button>
                          )}
                        </div>
                        <div className="event-comment-bubble">
                          {comment.text && <p>{comment.text}</p>}
                          {(comment.attachments.length > 0 || localCommentUploads.length > 0) && (
                            <div className="event-comment-attachments">
                              {comment.attachments.map((attachment) => {
                                const previewUrl = attachmentPreviewUrl(attachment)
                                const attachmentName = attachment.originalName || attachment.name
                                return previewUrl ? (
                                  <AttachmentThumbnail
                      eventId={selectedEvent.source === 'erpSalesDelivery' && attachment.linePreviewUrl?.includes('scope=sales-attachment') ? undefined : selectedEvent.id}
                                    className="event-comment-image"
                                    attachment={{ ...attachment, name: attachmentName }}
                                    onOpen={() => setEnlargedEventAttachment(attachment)}
                                    key={attachment.path || attachment.url}
                                    loading="lazy"
                                  />
                                ) : (
                                  <CalendarAttachmentFile
                                    eventId={selectedEvent.id}
                                    className="event-comment-file"
                                    href={attachment.url}
                                    target="_blank"
                                    rel="noreferrer"
                                    key={attachment.path || attachment.url}
                                  >
                                    <span aria-hidden="true">▧</span>
                                    <div>
                                      <b>{attachment.originalName || attachment.name}</b>
                                      {attachment.size && <small>{Math.ceil(attachment.size / 1024)} KB</small>}
                                    </div>
                                  </CalendarAttachmentFile>
                                )
                              })}
                              {localCommentUploads.map((upload) => (
                                <button
                                  type="button"
                                  className={`event-comment-image pending${upload.status === 'failed' ? ' failed' : ''}`}
                                  onClick={() => openPendingDetailAttachment(upload)}
                                  key={`local:${upload.id}`}
                                  aria-label={`開啟剛上傳的照片：${upload.name}`}
                                >
                                  <img src={upload.previewUrl} alt={upload.name} />
                                  <span>{upload.status === 'failed' ? '轉檔失敗' : upload.cloudSafe ? '上傳成功' : '上傳中'}</span>
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    </article>
                  )
                })}
              </div>
            ))}
            <div ref={commentThreadEndRef} />
          </section>
        </div>

        <div className="event-comment-composer">
          {commentFiles.length > 0 && (
            <div className="event-comment-pending-files" aria-label="準備上傳的檔案">
              {commentFiles.map((item) => (
                <span key={item.id}>
                  <b>{item.file.type.startsWith('image/') ? '照片' : '檔案'}</b>
                  <span>{item.file.name}</span>
                  <button type="button" onClick={() => removeCommentFile(item.id)} disabled={commentSending} aria-label={`移除 ${item.file.name}`}>×</button>
                </span>
              ))}
            </div>
          )}
          <div className="event-comment-composer-main">
            <button
              type="button"
              className="event-comment-upload"
              onClick={() => commentAttachmentInputRef.current?.click()}
              disabled={commentSending}
              aria-label="上傳照片或檔案"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M5 14v4.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V14" />
              </svg>
            </button>
            <input
              ref={commentAttachmentInputRef}
              className="event-comment-file-input"
              type="file"
              multiple
              onChange={handleCommentAttachmentChange}
            />
            <textarea
              value={commentDraft}
              maxLength={5000}
              rows={1}
              placeholder="可貼上照片 ; Ctrl+Enter送出"
              disabled={commentSending}
              onChange={(event) => setCommentDraft(event.target.value)}
              onPaste={handleCommentPaste}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                  event.preventDefault()
                  void sendEventComment()
                }
              }}
            />
            <button
              type="button"
              className="event-comment-send"
              onClick={sendEventComment}
              disabled={commentSending || (!commentDraft.trim() && commentFiles.length === 0)}
              aria-label={commentSending ? '留言送出中' : '送出留言'}
            >
              {commentSending ? (
                <span className="event-comment-spinner" />
              ) : (
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="m4 12 15-8-4.5 16-3.2-6.1L4 12Zm7.3 1.9L19 4" />
                </svg>
              )}
            </button>
          </div>
        </div>

      </aside>
    )
  }

  function renderRelatedEventsPanel() {
    if (!showRelatedEventsPanel || !selectedEvent || !isErpSalesDeliveryEvent(selectedEvent)) return null
    return (
      <div className="modal-overlay related-events-overlay" onClick={() => setShowRelatedEventsPanel(false)}>
        <aside
          className={`tt-floating-panel tt-day-list-panel related-events-modal${dayListSwipeOffset > 0 ? ' swiping' : ''}`}
          style={{ '--day-list-swipe-offset': `${dayListSwipeOffset}px` } as CSSProperties}
          onTouchStart={handleDayListSwipeStart}
          onTouchMove={handleDayListSwipeMove}
          onTouchEnd={handleDayListSwipeEnd}
          onTouchCancel={handleDayListSwipeEnd}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="panel-head">
            <h2>關聯事件</h2>
            <button type="button" onClick={() => setShowRelatedEventsPanel(false)} aria-label="關閉關聯事件清單">×</button>
          </div>
          {!relatedSalesDeliveryEventsQuery.isLoading && !relatedSalesDeliveryEventsQuery.isError && relatedSalesDeliveryEvents.length > 0 && (
            <p className="panel-hint related-events-count">共 {relatedSalesDeliveryEvents.length} 筆</p>
          )}
          <div className="panel-list related-events-list">
            {relatedSalesDeliveryEventsQuery.isLoading ? (
              <p className="panel-hint" role="status">正在讀取關聯事件...</p>
            ) : relatedSalesDeliveryEventsQuery.isError ? (
              <div className="related-events-error" role="alert">
                <span>關聯事件讀取失敗</span>
                <button type="button" onClick={() => void relatedSalesDeliveryEventsQuery.refetch()}>重新載入</button>
              </div>
            ) : relatedSalesDeliveryEvents.length > 0 ? relatedSalesDeliveryEvents.map((event) => {
              const related = isRelatedErpSalesDeliveryEvent(event)
              return (
                <button
                  type="button"
                  className={`day-list-event${event.id === selectedEvent.id ? ' active' : ''}`}
                  style={{ '--event-color': eventCalendarColor(event) } as CSSProperties}
                  onClick={() => {
                    setShowRelatedEventsPanel(false)
                    openEventDetail(event)
                  }}
                  key={event.id}
                >
                  <span className="day-list-time">
                    {renderDayListTime(event, event.date)}
                  </span>
                  <span className="day-list-content">
                    <strong>{eventDisplayTitle(event)}</strong>
                    <small>{related ? '附屬事件' : '主事件'} · {formatChineseDate(event.date)}</small>
                  </span>
                  <span className="day-list-owner">{eventOwnerLabel(event)}</span>
                </button>
              )
            }) : (
              <p className="panel-hint">目前沒有其他關聯事件</p>
            )}
          </div>
        </aside>
      </div>
    )
  }

  function renderDayListPanel() {
    if (!dayListDate) return null
    const dayEvents = eventsByDate.get(dayListDate) ?? []
    const dayItems = displayItemsByDate.get(dayListDate) ?? []
    return (
      <aside
        className={`tt-floating-panel tt-day-list-panel${dayListSwipeOffset > 0 ? ' swiping' : ''}`}
        style={{ '--day-list-swipe-offset': `${dayListSwipeOffset}px` } as CSSProperties}
        onTouchStart={handleDayListSwipeStart}
        onTouchMove={handleDayListSwipeMove}
        onTouchEnd={handleDayListSwipeEnd}
        onTouchCancel={handleDayListSwipeEnd}
      >
        <div className="panel-head">
          <h2>{dayjs(dayListDate).format('M月D日')}事件</h2>
          <button onClick={() => setDayListDate(null)} aria-label="關閉當日事件">×</button>
        </div>
        <p className="panel-hint">共 {dayEvents.length} 筆</p>
        <div className="panel-list">
          {dayItems.map((item) => renderDayDisplayItem(item, dayListDate))}
          {dayEvents.length === 0 && <p className="panel-empty">這天沒有事件</p>}
        </div>
        {canCreateEvent && (
          <button className="day-list-add-btn" onClick={() => openAddEvent(dayListDate)}>新增這天事件</button>
        )}
      </aside>
    )
  }

  function renderDeliveryGroupPanel() {
    if (!selectedDeliveryGroup) return null
    const primaryEvent = selectedDeliveryGroup.primaryEvent
    const completedCount = deliveryGroupCompletedCount(selectedDeliveryGroup.events)
    const timeText = primaryEvent.allDay
      ? '全天'
      : `${primaryEvent.startTime}–${primaryEvent.endTime}`
    return (
      <aside
        className="tt-floating-panel tt-day-list-panel delivery-group-panel"
        style={{ '--event-color': eventCalendarColor(primaryEvent) } as CSSProperties}
      >
        <div className="panel-head">
          <h2>{deliveryGroupDisplayTitle(selectedDeliveryGroup)}</h2>
          <button onClick={() => setSelectedDeliveryGroupKey(null)} aria-label="關閉配送訂單">×</button>
        </div>
        <div className="delivery-group-meta">
          <span>{formatChineseDate(primaryEvent.date)} · {timeText}</span>
          <span>{primaryEvent.location}</span>
          <strong>{completedCount > 0 ? `已完成 ${completedCount}/${selectedDeliveryGroup.events.length}` : '尚未完成'}</strong>
        </div>
        <div className="panel-list delivery-group-orders">
          {selectedDeliveryGroup.events.map((event, index) => (
            <button
              type="button"
              className={`delivery-group-order ${isCalendarEventCompleted(event) ? 'done' : ''}`}
              key={event.id}
              onClick={() => openEventDetail(event)}
            >
              <span className="delivery-group-order-index">{index + 1}</span>
              <span className="delivery-group-order-content">
                <strong>{event.sourceSalesNo || `訂單 ${index + 1}`}</strong>
                <small>{eventListSecondaryText(event) || '無訂單備註'}</small>
              </span>
              <span className="delivery-group-order-status">{event.orderStatus || (isCalendarEventCompleted(event) ? '已完成' : '未設定')}</span>
            </button>
          ))}
        </div>
        {selectedDeliveryGroup.events.some((event) => event.sourceShippingMethod === '外送' && !isCalendarEventCompleted(event)) && <div className="delivery-group-report-footer"><button type="button" className="delivery-group-report-button" onClick={() => {
          const source = selectedDeliveryGroup.events.find((event) => event.sourceShippingMethod === '外送' && !isCalendarEventCompleted(event))
          if (source) openCombinedDelivery(source)
        }}>合併配達回報</button></div>}
      </aside>
    )
  }

  function activityLogText(log: CalendarActivityLog) {
    const eventTitle = textDisplayTitle(log.eventTitle)
    const actorName = textDisplayTitle(log.actorName)
    if (log.action === 'create') return `${actorName} 新增了「${eventTitle}」`
    if (log.action === 'delete') return `${actorName} 刪除了「${eventTitle}」`
    if (log.action === 'move') return `${actorName} 將「${eventTitle}」移到 ${log.changes?.[0]?.after || log.date}`
    if (log.action === 'copy') return `${actorName} 複製了「${eventTitle}」到 ${log.changes?.[0]?.after || log.date}`
    const firstChange = log.changes?.[0]
    if (firstChange) {
      const rest = (log.changes?.length ?? 0) > 1 ? `，另有 ${(log.changes?.length ?? 1) - 1} 項變更` : ''
      return `${actorName} 將「${eventTitle}」的${firstChange.label}從「${firstChange.before}」改成「${firstChange.after}」${rest}`
    }
    return `${actorName} 更新了「${eventTitle}」`
  }

  function renderNotificationsPanel() {
    if (!showNotificationsPanel) return null
    return (
      <aside className="tt-floating-panel tt-notifications-panel">
        <div className="panel-head">
          <h2>通知</h2>
          <button
            onClick={() => {
              markActivityNotificationsSeen()
              setShowNotificationsPanel(false)
            }}
            aria-label="關閉通知"
          >
            ×
          </button>
        </div>
        <div className="panel-list">
          {visibleActivityLogs.slice(0, 30).map((log) => {
            const unread = Boolean(log.createdAt && log.createdAt > lastSeenActivityAt)
            const assignedToMe = canReceiveActivityLog(log)
            const canOpenEvent = Boolean(log.eventId && log.action !== 'delete')
            return (
              <button
                type="button"
                className={`activity-log ${log.action}${unread ? ' unread' : ''}${assignedToMe ? ' assigned-to-me' : ''}`}
                key={log.id}
                disabled={!canOpenEvent || openingActivityEventId === log.eventId}
                aria-label={canOpenEvent ? `開啟事件：${textDisplayTitle(log.eventTitle)}` : undefined}
                onClick={() => void openActivityLogEvent(log)}
              >
                <span style={{ background: activityLogColor(log) }} />
                <div>
                  <strong>{activityLogText(log)}</strong>
                  <small>{dayjs(log.createdAt).format('M/D HH:mm')} · {visibleCalendarMap.get(log.calendarId)?.name || departmentName(log.departmentId)}</small>
                </div>
              </button>
            )
          })}
          {visibleActivityLogs.length === 0 && <p className="panel-empty">目前沒有新的事件紀錄</p>}
        </div>
      </aside>
    )
  }

  function renderStartupNotificationPrompt() {
    if (!showStartupNotificationPrompt) return null
    return (
      <div
        className="modal-overlay"
        onTouchStartCapture={rememberOverlaySystemGesture}
        onClick={(event) => {
          if (shouldKeepOverlayOpenForSystemGesture(event)) return
          dismissStartupNotificationPrompt()
        }}
      >
        <div className="modal notification-startup-modal" onClick={(event) => event.stopPropagation()}>
          <div className="modal-header">
            <h2>開啟通知</h2>
            <button className="close-btn" onClick={dismissStartupNotificationPrompt}>×</button>
          </div>
          <div className="modal-body notification-prompt-body">
            <strong>建議開啟行事曆通知</strong>
            <p>預設只會在上班時間通知。</p>
            <p>若要調整通知內容，可到大頭照選單的「通知設定」修改。</p>
          </div>
          <div className="modal-footer">
            <button type="button" onClick={dismissStartupNotificationPrompt}>稍後</button>
            <button type="button" className="primary-btn" onClick={enableStartupNotifications}>開啟通知</button>
          </div>
        </div>
      </div>
    )
  }

  function renderFulfillmentPaymentPrompt() {
    if (!fulfillmentPaymentModal) return null
    const paymentRequired = fulfillmentPaymentModal.required
      && fulfillmentPaymentModal.currentOrderUnpaidAmount > 0
    const customerLabel = [fulfillmentPaymentModal.customerCode, fulfillmentPaymentModal.customerName]
      .filter(Boolean)
      .join(' ')
    return (
      <div
        className="modal-overlay fulfillment-payment-overlay"
        onTouchStartCapture={rememberOverlaySystemGesture}
      >
        <div
          className="modal fulfillment-payment-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="fulfillment-payment-title"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="modal-header">
            <h2 id="fulfillment-payment-title">{paymentRequired ? '確認現金收款' : '確認收款狀態'}</h2>
          </div>
          <div className="modal-body fulfillment-payment-body">
            {fulfillmentPaymentModal.batchSalesNo && <p>銷售單號：{fulfillmentPaymentModal.batchSalesNo}</p>}
            {customerLabel && <p>{customerLabel}</p>}
            <div className="fulfillment-payment-total">
              {paymentRequired ? <>
                <span>累計未付</span>
                <strong>${fulfillmentPaymentModal.outstandingTotal.toLocaleString()}</strong>
                <small>
                  本單未付 ${fulfillmentPaymentModal.currentOrderUnpaidAmount.toLocaleString()}
                  {fulfillmentPaymentModal.unpaidOrderCount ? `，共 ${fulfillmentPaymentModal.unpaidOrderCount} 筆未付款銷貨單` : ''}
                </small>
              </> : <>
                <span>本張銷貨單</span>
                <strong>{(fulfillmentPaymentModal.paymentState ?? productionLineStatus?.paymentState) === 'monthly' ? '月結客戶' : '已付清'}</strong>
                <small>
                  本單未付 $0
                  {fulfillmentPaymentModal.outstandingTotal > 0
                    ? `，此客戶其他銷貨單累計未付 $${fulfillmentPaymentModal.outstandingTotal.toLocaleString()}`
                    : '，此客戶目前沒有其他未付款銷貨單'}
                </small>
              </>}
            </div>
            {paymentRequired && (
              <label className="fulfillment-payment-field">
                <span>本次收款金額</span>
                <input
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  value={fulfillmentPaymentAmount}
                  disabled={fulfillmentPaymentSaving}
                  onChange={(event) => {
                    setFulfillmentPaymentAmount(event.target.value.replace(/[^0-9.,]/g, ''))
                    setFulfillmentPaymentError('')
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void recordFulfillmentCashPayment()
                  }}
                />
                <small>收款方式固定為現金；多筆會自動依序沖帳，多付的金額會列入溢收。</small>
              </label>
            )}
            {fulfillmentPaymentError && <div className="form-error">{fulfillmentPaymentError}</div>}
          </div>
          <div className="modal-footer fulfillment-payment-actions">
            {paymentRequired ? <>
              <button type="button" disabled={fulfillmentPaymentSaving} onClick={dismissFulfillmentPaymentPrompt}>尚未收款</button>
              <button type="button" className="primary-btn" disabled={fulfillmentPaymentSaving} onClick={recordFulfillmentCashPayment}>
                {fulfillmentPaymentSaving ? '收款處理中...' : '確認收款'}
              </button>
            </> : (
              <button type="button" className="primary-btn" onClick={dismissFulfillmentPaymentPrompt}>已確認</button>
            )}
          </div>
        </div>
      </div>
    )
  }

  function renderEventAttachmentLightbox() {
    if (!enlargedEventAttachment) return null
    const attachmentKey = enlargedEventAttachment.path || enlargedEventAttachment.url
    const attachmentIndex = eventDetailImageAttachments.findIndex(
      (attachment) => (attachment.path || attachment.url) === attachmentKey,
    )
    const canShowPrevious = attachmentIndex > 0
    const canShowNext = attachmentIndex >= 0 && attachmentIndex < eventDetailImageAttachments.length - 1
    const attachmentName = enlargedEventAttachment.originalName || enlargedEventAttachment.name
    const uploadLabel = attachmentUploadLabel(enlargedEventAttachment)
    const showAttachmentAt = (index: number) => {
      const attachment = eventDetailImageAttachments[index]
      if (attachment) setEnlargedEventAttachment(attachment)
    }
    return (
      <div
        className="event-attachment-lightbox-overlay"
        role="dialog"
        aria-modal="true"
        aria-label={`圖片預覽：${attachmentName}`}
        onTouchStartCapture={rememberOverlaySystemGesture}
        onClick={(event) => {
          if (event.target === event.currentTarget && !shouldKeepOverlayOpenForSystemGesture(event)) {
            setEnlargedEventAttachment(null)
          }
        }}
      >
        <div className="event-attachment-lightbox">
          <ZoomableAttachmentImage
            eventId={selectedEvent?.id}
            key={attachmentKey}
            src={attachmentFullImageUrl(enlargedEventAttachment)}
            previewSrc={attachmentPreviewUrl(enlargedEventAttachment)}
            preloadSources={[
              canShowPrevious ? attachmentFullImageUrl(eventDetailImageAttachments[attachmentIndex - 1]) : '',
              canShowNext ? attachmentFullImageUrl(eventDetailImageAttachments[attachmentIndex + 1]) : '',
            ]}
            alt={attachmentName}
            onClose={() => setEnlargedEventAttachment(null)}
            onPrevious={() => showAttachmentAt(attachmentIndex - 1)}
            onNext={() => showAttachmentAt(attachmentIndex + 1)}
            canPrevious={canShowPrevious}
            canNext={canShowNext}
            header={{
              title: attachmentName,
              countLabel: attachmentIndex >= 0
                ? `${attachmentIndex + 1} / ${eventDetailImageAttachments.length}`
                : undefined,
              metadataLabel: uploadLabel,
            }}
          />
        </div>
      </div>
    )
  }

  function renderNotificationSettingsModal() {
    if (!showNotificationSettings) return null
    const shiftText = currentShift ? `${currentShift.name} ${currentShift.startTime} - ${currentShift.endTime}` : '尚未設定班別'
    const disabledByLeave = hasTodayLeave ? '今天已有 HR 請假/休假，班表與打卡通知會自動略過。' : ''
    const permissionState = 'Notification' in window ? notificationPermission : 'unsupported'
    const permissionText = permissionState === 'granted'
      ? '已開啟'
      : permissionState === 'denied'
        ? '已封鎖'
        : permissionState === 'default'
          ? '尚未允許'
          : '不支援'
    const permissionHint = permissionState === 'granted'
      ? '瀏覽器通知權限已開啟，通知會依照下方設定執行。'
      : permissionState === 'denied'
        ? '目前瀏覽器封鎖通知，請到瀏覽器或手機設定中允許此網站通知。'
        : permissionState === 'default'
          ? '尚未開啟瀏覽器通知權限，重新載入頁面時會再次提醒。'
          : '此瀏覽器不支援網站通知。'
    return (
      <div
        className="modal-overlay"
        onTouchStartCapture={rememberOverlaySystemGesture}
        onClick={(event) => {
          if (shouldKeepOverlayOpenForSystemGesture(event)) return
          setShowNotificationSettings(false)
        }}
      >
        <div className="modal notification-settings-modal" onClick={(event) => event.stopPropagation()}>
          <div className="modal-header">
            <h2>通知設定</h2>
            <button className="close-btn" onClick={() => setShowNotificationSettings(false)}>×</button>
          </div>
          <div className="modal-body notification-settings-body">
            <div className="notification-status-card">
              <strong>{employeeId ? employeeName(employeeId) : displayName || '目前使用者'}</strong>
              <span>班別：{shiftText}</span>
              {disabledByLeave && <small>{disabledByLeave}</small>}
            </div>

            <div className={`notification-permission-card ${permissionState}`}>
              <span>通知權限</span>
              <strong>{permissionText}</strong>
              <small>{permissionHint}</small>
            </div>

            <section className="notification-settings-section">
              <div className="notification-section-head">
                <strong>行事曆通知</strong>
                <small>依照 HR 班表，預設只在上班時間通知；錯過時間不補通知。</small>
              </div>
              <label className="notification-setting-row compact">
                <span>
                  <strong>上班時間通知</strong>
                  <small>勾選後，上班時間內有事件新增、修改、刪除，或事件提醒時間到時都會通知。</small>
                </span>
                <input
                  type="checkbox"
                  checked={notificationSettings.shiftStartEnabled}
                  onChange={(event) => setNotificationSettings((settings) => ({ ...settings, shiftStartEnabled: event.target.checked }))}
                />
              </label>
              <label className="notification-setting-row compact">
                <span>
                  <strong>下班後通知</strong>
                  <small>勾選後，下班後上述行事曆通知也會繼續通知。</small>
                </span>
                <input
                  type="checkbox"
                  checked={notificationSettings.shiftEndEnabled}
                  onChange={(event) => setNotificationSettings((settings) => ({ ...settings, shiftEndEnabled: event.target.checked }))}
                />
              </label>
            </section>

          </div>
          <div className="modal-footer">
            <button type="button" onClick={() => setShowNotificationSettings(false)}>取消</button>
            <button type="button" className="primary-btn" disabled={savingNotificationSettings} onClick={saveNotificationSettings}>
              {savingNotificationSettings ? '儲存中' : '儲存'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  function renderTitleIconSettingsModal() {
    if (!showTitleIconSettings || !canManageCalendarColors) return null
    return (
      <div
        className="modal-overlay"
        onTouchStartCapture={rememberOverlaySystemGesture}
        onClick={(event) => {
          if (shouldKeepOverlayOpenForSystemGesture(event)) return
          setShowTitleIconSettings(false)
        }}
      >
        <div className="modal title-icon-settings-modal" onClick={(event) => event.stopPropagation()}>
          <div className="modal-header">
            <h2>標題 icon 設定</h2>
            <button className="close-btn" onClick={() => setShowTitleIconSettings(false)}>×</button>
          </div>
          <div className="modal-body title-icon-settings-body">
            <section className="title-icon-settings-section">
              <strong>可使用 icon</strong>
              {titleIconDraft.map((item, index) => (
                <div
                  className="title-icon-setting-row"
                  key={`title-icon-draft-${index}`}
                  onDragOver={(event) => moveTitleIconDragOver(event, index)}
                  onDrop={(event) => {
                    event.preventDefault()
                    endTitleIconDrag()
                  }}
                >
                  <button
                    type="button"
                    className="title-icon-drag-handle"
                    draggable
                    onDragStart={(event) => startTitleIconDrag(event, index)}
                    onDragEnd={endTitleIconDrag}
                    aria-label={`拖移 ${item.label || item.icon || 'icon'} 調整順序`}
                  >
                    ⋮⋮
                  </button>
                  <input
                    className="title-icon-symbol-input"
                    value={item.icon}
                    onChange={(event) => updateTitleIconDraft(index, { icon: event.target.value })}
                    placeholder="👷"
                    aria-label="icon"
                  />
                  <input
                    value={item.label}
                    onChange={(event) => updateTitleIconDraft(index, { label: event.target.value })}
                    placeholder="名稱"
                    aria-label="icon 名稱"
                  />
                  <button type="button" onClick={() => removeTitleIconDraft(index)} aria-label="刪除 icon">×</button>
                </div>
              ))}
              <button type="button" className="title-icon-add-row" onClick={addTitleIconDraft}>新增 icon</button>
            </section>

            <section className="title-icon-settings-section">
              <strong>部門預設 icon</strong>
              <div className="department-title-icon-list">
                {departments.map((department) => (
                  <div className="department-title-icon-row" key={department.id}>
                    <span>{department.name}</span>
                    <div className="department-title-icon-options">
                      {titleIconDraft
                        .filter((item) => item.icon.trim() && item.label.trim())
                        .map((item) => (
                          <label key={`${department.id}-${item.icon}-${item.label}`}>
                            <input
                              type="checkbox"
                              checked={(departmentTitleIconDraft[department.id] ?? []).includes(item.icon.trim())}
                              onChange={() => toggleDepartmentTitleIconDraft(department.id, item.icon.trim())}
                            />
                            <span className="department-title-icon-check" aria-hidden="true" />
                            <span className="department-title-icon-symbol">{item.icon.trim()}</span>
                            <small>{item.label.trim()}</small>
                          </label>
                        ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </div>
          <div className="modal-footer">
            <button type="button" onClick={() => setShowTitleIconSettings(false)}>取消</button>
            <button type="button" className="primary-btn" disabled={savingTitleIcons} onClick={saveTitleIconSettings}>
              {savingTitleIcons ? '儲存中' : '儲存'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="timetree-page">
      <header className="timetree-topbar">
        <div className="topbar-left">
          <div className="tt-logo">
            <span className="tt-logo-mark">✣</span>
            <span>Citypainter</span>
          </div>
          <button className="tt-today" onClick={goToday}>今天</button>
          <div className="tt-stepper">
            <button onClick={() => movePeriod(-1)}>‹</button>
            <button onClick={() => movePeriod(1)}>›</button>
          </div>
          <button className="month-title-button" type="button" onClick={openMonthPicker} aria-label="切換月份">
            {currentTitle}
          </button>
          <input
            className="month-picker-input"
            ref={monthInputRef}
            type="month"
            value={month.format('YYYY-MM')}
            onChange={(event) => changeMonth(event.target.value)}
            aria-label="選擇月份"
          />
        </div>
        <div className="tt-view-switch">
          <button className={viewMode === 'month' ? 'active' : ''} onClick={() => setViewMode('month')}>月</button>
          <button className={viewMode === 'week' ? 'active' : ''} onClick={() => setViewMode('week')}>週</button>
        </div>
        <div className="topbar-right">
          <button
            className={`tt-icon-button topbar-panel-trigger ${showSearchPanel ? 'active' : ''}`}
            aria-label="搜尋"
            onClick={() => {
              setShowSearchPanel((open) => !open)
              if (showNotificationsPanel) markActivityNotificationsSeen()
              setShowNotificationsPanel(false)
              setShowAccountMenu(false)
            }}
          >
            <TopbarIcon name="search" />
          </button>
          <button
            className={`tt-icon-button topbar-panel-trigger ${showNotificationsPanel ? 'active' : ''}`}
            aria-label="通知"
            onClick={() => {
              setShowNotificationsPanel((open) => {
                const nextOpen = !open
                if (!nextOpen) markActivityNotificationsSeen()
                return nextOpen
              })
              setShowSearchPanel(false)
              setShowAccountMenu(false)
            }}
          >
            <TopbarIcon name="bell" />
            {unreadActivityCount > 0 && <span className="notification-dot">{Math.min(unreadActivityCount, 99)}</span>}
          </button>
          {canCreateEvent && <button className="tt-icon-button add" onClick={() => openAddEvent(selectedDate)} aria-label="新增工作">＋</button>}
          <button
            className={`tt-avatar ${showAccountMenu ? 'active' : ''}`}
            onClick={() => {
              setShowAccountMenu((open) => !open)
              setShowSearchPanel(false)
              if (showNotificationsPanel) markActivityNotificationsSeen()
              setShowNotificationsPanel(false)
            }}
            aria-label="開啟帳號選單"
            aria-expanded={showAccountMenu}
          >
            {user?.photoURL ? <img src={user.photoURL} alt={displayName || user.email || '使用者'} referrerPolicy="no-referrer" /> : (displayName || user?.email || 'U').slice(0, 1)}
          </button>
          {showAccountMenu && (
            <div className="tt-account-menu" role="menu">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setShowAccountMenu(false)
                  setShowNotificationSettings(true)
                }}
              >
                通知設定
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setShowAccountMenu(false)
                  openPasswordModal()
                }}
              >
                修改密碼
              </button>
              {canManageCalendarColors && (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setShowAccountMenu(false)
                      setShowCalendarDrawer(true)
                    }}
                  >
                    行事曆顏色設定
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setShowAccountMenu(false)
                      openTitleIconSettings()
                    }}
                  >
                    標題 icon 設定
                  </button>
                </>
              )}
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setShowAccountMenu(false)
                  signOut(auth)
                }}
              >
                登出
              </button>
            </div>
          )}
        </div>
      </header>

      {unsafeActiveBackgroundUploads.length > 0 ? (
        <div className="durable-upload-banner unsafe" role="status" aria-live="polite">
          照片上傳中，完成前請勿關閉或滑掉此網頁。
        </div>
      ) : detailAttachmentUploadNotice ? (
        <div className="durable-upload-banner safe" role="status" aria-live="polite">
          {detailAttachmentUploadNotice.message}
        </div>
      ) : null}

      {showPasswordModal && (
        <div
          className="modal-overlay"
          onTouchStartCapture={rememberOverlaySystemGesture}
          onClick={(event) => {
            if (shouldKeepOverlayOpenForSystemGesture(event)) return
            setShowPasswordModal(false)
          }}
        >
          <div className="modal password-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h2>修改密碼</h2>
              <button onClick={() => setShowPasswordModal(false)} aria-label="關閉修改密碼">×</button>
            </div>
            <div className="modal-body">
              <label>
                <span>新密碼</span>
                <input
                  type="password"
                  value={passwordForm.next}
                  onChange={(event) => setPasswordForm((form) => ({ ...form, next: event.target.value }))}
                  autoComplete="new-password"
                />
              </label>
              <label>
                <span>確認新密碼</span>
                <input
                  type="password"
                  value={passwordForm.confirm}
                  onChange={(event) => setPasswordForm((form) => ({ ...form, confirm: event.target.value }))}
                  autoComplete="new-password"
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void savePasswordChange()
                  }}
                />
              </label>
              {passwordError && <div className="form-error">{passwordError}</div>}
              {passwordSuccess && <div className="form-success">{passwordSuccess}</div>}
            </div>
            <div className="modal-footer">
              <button type="button" onClick={() => setShowPasswordModal(false)}>取消</button>
              <button type="button" className="primary-btn" disabled={savingPassword} onClick={savePasswordChange}>
                {savingPassword ? '儲存中' : '儲存'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="timetree-body">
        <aside className="tt-left-rail">
          <button
            className={`rail-button ${allCalendarsSelected ? 'active' : ''}`}
            aria-label={allCalendarsSelected ? '取消全選所有行事曆' : '全選所有行事曆'}
            title={allCalendarsSelected ? '取消全選所有行事曆' : '全選所有行事曆'}
            onClick={selectAllCalendars}
          >
            ✓
          </button>
          <div className="rail-calendars">
            {visibleCalendars.slice(0, 8).map((calendar) => {
              const active = selectedCalendarIds.includes(calendar.id)
              return (
                <button
                  key={calendar.id}
                  className={`rail-calendar ${active ? 'active' : ''}`}
                  onClick={() => toggleCalendar(calendar.id)}
                  style={{ '--calendar-color': calendar.color } as CSSProperties}
                  title={calendar.name}
                >
                  <span className="rail-calendar-initial">{calendar.name.slice(0, 1)}</span>
                  <span className="rail-calendar-label">{calendar.name}</span>
                </button>
              )
            })}
          </div>
          <button
            type="button"
            className="tt-erp-scan-link"
            aria-label="掃描 ERP 銷貨單 QR Code"
            aria-expanded={showErpOrderScanner}
            disabled={!canScanSalesOrder}
            onFocus={() => void preloadErpOrderScannerModule().catch(() => undefined)}
            onPointerDown={() => void preloadErpOrderScannerModule().catch(() => undefined)}
            onPointerEnter={() => void preloadErpOrderScannerModule().catch(() => undefined)}
            onClick={openErpOrderScan}
          >
            掃描
          </button>
        </aside>

        {showCalendarDrawer && (
          <aside className="tt-calendar-drawer">
            <div className="panel-head">
              <h2>行事曆顏色設定</h2>
              <button onClick={() => setShowCalendarDrawer(false)} aria-label="關閉顏色設定">×</button>
            </div>
            <div className="drawer-section">
              <div className="panel-title-row">
                <span className="field-label">行事曆</span>
              </div>
              <div className="drawer-calendar-list">
                {visibleCalendars.filter((calendar) => calendar.systemKind === 'department' || calendar.systemKind === 'hrLeave').map((calendar) => {
                  return (
                    <div
                      key={calendar.id}
                      className="drawer-calendar-item active"
                      style={{ '--calendar-color': calendar.color } as CSSProperties}
                    >
                      <div className="drawer-calendar-main">
                        <span />
                        <strong>{calendar.name}</strong>
                        <small>{calendar.systemKind === 'hrLeave' ? 'HR' : '部門'}</small>
                      </div>
                      <div className="drawer-color-row" aria-label={`${calendar.name}顏色`}>
                        {COLORS.map((color) => (
                          <button
                            key={color}
                            className={calendar.color === color ? 'selected' : ''}
                            style={{ '--swatch-color': color } as CSSProperties}
                            onClick={() => updateCalendarColor(calendar, color)}
                            aria-label={`設定${calendar.name}為${color}`}
                          />
                        ))}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          </aside>
        )}

        <section
          className="tt-calendar-surface"
          ref={calendarSurfaceRef}
          onTouchStartCapture={handleMonthLongPressStart}
          onTouchMoveCapture={handleMonthLongPressMove}
          onTouchEndCapture={handleMonthLongPressEnd}
          onTouchCancelCapture={clearMonthLongPressGuard}
          onTouchStart={handleCalendarTouchStart}
          onTouchMove={handleCalendarTouchMove}
          onTouchEnd={handleCalendarTouchEnd}
          onTouchCancel={() => {
            calendarTouchStartRef.current = null
            setCalendarSwipeAnimating(true)
            setCalendarSwipeOffset(0)
            window.setTimeout(() => setCalendarSwipeAnimating(false), 210)
          }}
          onContextMenu={(event) => event.preventDefault()}
        >
          {loading ? (
            <CalendarRoutePending />
          ) : (
            <>
            <div className="weekday-grid">
              {WEEKDAYS.map((day) => <div key={day}>{day}</div>)}
            </div>
            {viewMode === 'month' ? (
              <div className="month-swipe-viewport" ref={monthGridRef}>
                <div
                  className={`month-swipe-track calendar-swipe-track ${calendarSwipeAnimating ? 'swipe-animating' : ''}`}
                  style={{ transform: `translate3d(calc(-100% + ${calendarSwipeOffset}px), 0, 0)` }}
                >
                  {swipeMonthSets.map((monthSet, index) => (
                    <div className="month-grid month-swipe-month" key={monthSet.key}>
                      {renderMonthGridDays(monthSet.days, monthSet.displayMonth, index === 1)}
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="week-swipe-viewport">
                <div
                  className={`week-swipe-track calendar-swipe-track ${calendarSwipeAnimating ? 'swipe-animating' : ''}`}
                  style={{ transform: `translate3d(calc(-100% + ${calendarSwipeOffset}px), 0, 0)` }}
                >
                  {swipeWeekSets.map((weekSet, index) => (
                    <div className="week-grid week-swipe-week" key={weekSet.key}>
                      {renderWeekGridDays(weekSet.days, index === 1)}
                    </div>
                  ))}
                </div>
              </div>
            )}
            </>
          )}
        </section>

      </div>

      {showSearchPanel && (
        <aside className="tt-floating-panel tt-search-panel">
          <div className="panel-head">
            <h2>搜尋工作</h2>
            <button onClick={() => setShowSearchPanel(false)} aria-label="關閉搜尋">×</button>
          </div>
          <input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="搜尋標題、備註、地址" autoFocus />
          <details className="search-department-filter" aria-label="部門篩選">
            <summary>
              <span>部門篩選</span>
              <b>{allSearchDepartmentsSelected ? '全部部門' : `${selectedSearchDepartmentIds.length} 個部門`}</b>
            </summary>
            <div className="search-department-menu">
              <button className={allSearchDepartmentsSelected ? 'active' : ''} type="button" onClick={selectAllSearchDepartments}>全部</button>
              {searchDepartmentOptions.map((department) => (
                <button
                  className={selectedSearchDepartmentIds.includes(department.id) ? 'active' : ''}
                  type="button"
                  key={department.id}
                  onClick={() => toggleSearchDepartment(department.id)}
                >
                  {department.name}
                </button>
              ))}
            </div>
          </details>
          <div className="panel-list">
            {searchIndexFetching && searchEvents.length === 0 && <p className="panel-empty">正在搜尋所有事件…</p>}
            {searchEvents.slice(0, 12).map((event) => renderEventSummary(event))}
            {!searchIndexFetching && searchEvents.length === 0 && <p className="panel-empty">沒有符合條件的工作</p>}
          </div>
        </aside>
      )}

      {renderNotificationsPanel()}
      {renderStartupNotificationPrompt()}
      {renderNotificationSettingsModal()}
      {renderTitleIconSettingsModal()}
      {renderDayListPanel()}
      {renderDeliveryGroupPanel()}
      {combinedDelivery && <CombinedDeliveryDialog key={combinedDeliveryScope} events={combinedDeliveryEvents} initialFiles={combinedDelivery.files} initialStatuses={combinedDeliveryStatusCache.read(combinedDeliveryEvents)} loadStatuses={loadCombinedDeliveryStatuses} preview={previewCombinedDelivery} submit={submitCombinedDelivery} close={() => { if (!combinedDeliverySubmittingRef.current) setCombinedDelivery(null) }} />}
      {renderEventDetailPanel()}
      {renderRelatedEventsPanel()}
      {renderFulfillmentPaymentPrompt()}
      {renderEventAttachmentLightbox()}

      {dragPreview && (
        <div
          ref={eventDragPreviewRef}
          className="event-drag-preview"
          style={{
            '--event-color': dragPreview.color,
            left: dragPreview.x,
            top: dragPreview.y,
            width: dragPreview.width,
            minHeight: dragPreview.height
          } as CSSProperties}
        >
          {dragPreview.title}
        </div>
      )}

      {dragActionMenu && (
        <div
          className="event-drag-menu"
          style={{ left: dragActionMenu.x, top: dragActionMenu.y } as CSSProperties}
          onPointerDown={(event) => event.stopPropagation()}
          onTouchStart={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <button onClick={() => applyDragEventAction('move')} disabled={saving}>移動</button>
          <button onClick={() => applyDragEventAction('copy')} disabled={saving}>複製</button>
        </div>
      )}

      {showCalendarModal && (
        <div className="modal-overlay">
          <div className="modal">
            <div className="modal-header">
              <h2>{editingCalendarId ? '編輯行事曆' : '新增行事曆'}</h2>
              <button className="close-btn" onClick={() => setShowCalendarModal(false)}>×</button>
            </div>
            <div className="modal-body">
              <label>名稱
                <input value={calendarForm.name} onChange={(event) => setCalendarForm((form) => ({ ...form, name: event.target.value }))} />
              </label>
              <div>
                <span className="field-label">顏色</span>
                <div className="color-picker">
                  {COLORS.map((color) => (
                    <button
                      key={color}
                      className={calendarForm.color === color ? 'picked' : ''}
                      style={{ background: color }}
                      onClick={() => setCalendarForm((form) => ({ ...form, color }))}
                      aria-label={`選擇 ${color}`}
                    />
                  ))}
                </div>
              </div>
              <label className="check-line">
                <input type="checkbox" checked={calendarForm.isCompanyWide} onChange={(event) => setCalendarForm((form) => ({ ...form, isCompanyWide: event.target.checked }))} />
                全公司可查看
              </label>
              {!calendarForm.isCompanyWide && (
                <div className="two-col">
                  <div>
                    <span className="field-label">可查看部門</span>
                    <div className="check-list">
                      {departments.map((department) => (
                        <label key={department.id}>
                          <input type="checkbox" checked={calendarForm.departmentIds.includes(department.id)} onChange={() => toggleCalendarDepartment(department.id)} />
                          {department.name}
                        </label>
                      ))}
                    </div>
                  </div>
                  <div>
                    <span className="field-label">指定可查看員工</span>
                    <div className="check-list">
                      {employees.filter((emp) => employeeActiveForCalendar(emp)).map((emp) => (
                        <label key={emp.id}>
                          <input type="checkbox" checked={calendarForm.employeeIds.includes(emp.id)} onChange={() => setCalendarForm((form) => ({ ...form, employeeIds: toggle(form.employeeIds, emp.id) }))} />
                          {employeeName(emp.id)}
                        </label>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
            <div className="modal-footer">
              {editingCalendarId && <button className="danger-btn" onClick={() => deleteCalendar(editingCalendarId)}>刪除</button>}
              <button className="small-btn" onClick={() => setShowCalendarModal(false)}>取消</button>
              <button className="primary-btn" onClick={saveCalendar} disabled={saving}>{saving ? '儲存中...' : '儲存'}</button>
            </div>
          </div>
        </div>
      )}

      {showEventModal && (
        <div className="modal-overlay">
          <div
            className={`modal event-editor-modal${eventEditorTouchLocked ? ' touch-locked' : ''}`}
            style={{ '--event-color': eventEditorColor } as CSSProperties}
            onTouchStartCapture={(event) => {
              if (!eventEditorTouchLocked) return
              event.preventDefault()
              event.stopPropagation()
            }}
            onClickCapture={(event) => {
              if (!eventEditorTouchLocked) return
              event.preventDefault()
              event.stopPropagation()
            }}
          >
            <div className="event-editor-header">
              <button className="text-btn" onClick={closeEventModal}>取消</button>
              <strong>{editingEventId ? '編輯事件' : '新增事件'}</strong>
              <button className="text-btn save" onClick={saveEvent} disabled={saving}>{saving ? '儲存中' : '儲存'}</button>
              <button className="close-btn" onClick={closeEventModal}>×</button>
            </div>
            <div className="event-editor-body">
              <div className="event-title-row">
                <div className="title-icon-picker">
                  <button type="button" onClick={() => setShowTitleIconPicker((open) => !open)} aria-label="選擇標題圖示">
                    {currentTitleIcon || '＋'}
                  </button>
                  {showTitleIconPicker && (
                    <div className="title-icon-menu">
                      {eventTitleIconOptions.map((item) => (
                        <button type="button" key={`${item.icon}-${item.label}`} onClick={() => chooseTitleIcon(item.icon)}>
                          <span>{item.icon}</span>
                          <small>{item.label}</small>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <input
                  className="event-title-input"
                  value={currentTitleText}
                  onChange={(event) => setEventForm((form) => ({
                    ...form,
                    title: currentTitleIcon ? composeEditableEventTitle(currentTitleIcon, event.target.value) : event.target.value
                  }))}
                  onFocus={() => setShowTitleSuggestions(true)}
                  placeholder="新增標題"
                  autoFocus={!eventEditorTouchLocked && !editingEventId}
                />
                {showTitleSuggestions && titleSuggestions.length > 0 && (
                  <div className="title-suggestion-menu">
                    {titleSuggestions.map((suggestion) => (
                      <button type="button" key={suggestion.id} onClick={() => applyTitleSuggestion(suggestion)}>
                        <strong>{eventDisplayTitle(suggestion)}</strong>
                        <small>{eventSuggestionMeta(suggestion)}</small>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="event-time-editor">
                <div className="time-row">
                  <span>開始</span>
                  <div className="time-input-wrap">
                    <TimeInputIcon name="calendar" />
                    <CalendarDatePicker
                      value={eventForm.date}
                      ariaLabel="選擇開始日期"
                      onChange={(nextDate) => {
                        setEventForm((form) => ({
                          ...form,
                          ...shiftEventEndByStartChange(form, nextDate, form.startTime)
                        }))
                      }}
                    />
                  </div>
                  {!eventForm.allDay && (
                    <label className="time-input-wrap compact">
                      <TimeInputIcon name="clock" />
                      <input type="time" value={eventForm.startTime} onClick={(event) => openInputPicker(event.currentTarget)} onChange={(event) => setEventForm((form) => ({ ...form, ...shiftEventEndByStartChange(form, form.date, event.target.value) }))} />
                    </label>
                  )}
                </div>
                <div className="time-row">
                  <span>結束</span>
                  <div className="time-input-wrap">
                    <TimeInputIcon name="calendar" />
                    <CalendarDatePicker
                      value={eventForm.endDate}
                      min={eventForm.date}
                      ariaLabel="選擇結束日期"
                      onChange={(nextDate) => setEventForm((form) => ({ ...form, endDate: nextDate }))}
                    />
                  </div>
                  {!eventForm.allDay && (
                    <label className="time-input-wrap compact">
                      <TimeInputIcon name="clock" />
                      <input type="time" value={eventForm.endTime} onClick={(event) => openInputPicker(event.currentTarget)} onChange={(event) => setEventForm((form) => ({ ...form, endTime: event.target.value }))} />
                    </label>
                  )}
                </div>
                <div className="event-checkbox-row">
                  <label>
                    <input
                      type="checkbox"
                      checked={!!eventForm.allDay}
                      disabled={editingSalesDeliveryEvent && !editingRelatedSalesDeliveryEvent && !eventForm.allDay}
                      onChange={(event) => setEventForm((form) => ({ ...form, allDay: event.target.checked }))}
                    />
                    整天
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={!!eventForm.visibilityEnabled}
                      onChange={(event) => toggleVisibilityEnabled(event.target.checked)}
                    />
                    可見/替代
                  </label>
                </div>
              </div>

              {relatedSalesDeliveryDraft && (
                <div className="sales-delivery-related-editor-notice">
                  此為銷貨單附屬事件。名稱、日期與時間只修改此事件；地址會同步所有關聯事件及 ERP 銷貨單，其他共用欄位會同步主事件與附屬事件。重複、備註、待辦與附件沿用主事件，無法在此修改。
                </div>
              )}
              <fieldset className="event-editor-list">
                {!salesDeliveryEditor && (
                <div className="event-editor-row">
                  <EventRowIcon name="calendar" />
                  <details className="event-picker-row">
                    <summary>
                      <span className={eventForm.calendarIds.length > 0 ? 'selected' : ''}>{selectedEventCalendarText}</span>
                      {eventForm.calendarIds.length > 0 && <small>{eventForm.calendarIds.length} 個行事曆</small>}
                    </summary>
                    <div className="event-assignee-grid event-calendar-grid">
                      {writableCalendars.map((calendar) => (
                        <label key={calendar.id}>
                          <input type="checkbox" checked={eventForm.calendarIds.includes(calendar.id)} onChange={() => toggleEventCalendar(calendar.id)} />
                          <span>{calendar.name}</span>
                          <small>{calendar.systemKind === 'department' ? '部門' : '行事曆'}</small>
                        </label>
                      ))}
                    </div>
                  </details>
                </div>
                )}
                <div className="event-editor-row assignee">
                  <EventRowIcon name="person" />
                  <details className="event-picker-row">
                    <summary>
                      <span className={eventForm.assigneeIds.length > 0 ? 'selected' : ''}>{selectedAssigneeText}</span>
                      {eventForm.assigneeIds.length > 0 && <small>{eventForm.assigneeIds.length} 位同仁</small>}
                    </summary>
                    <div className="event-assignee-grid">
                      {employees.filter((emp) => employeeActiveForCalendar(emp)).map((emp) => (
                        <label key={emp.id}>
                          <input
                            type="checkbox"
                            checked={eventForm.assigneeIds.includes(emp.id)}
                            onChange={() => setEventForm((form) => ({ ...form, assigneeIds: requiredAssigneeIds(toggle(form.assigneeIds, emp.id)) }))}
                          />
                          <span>{employeeName(emp.id)}</span>
                          <small>{emp.departmentName || departmentName(emp.departmentId || '')}</small>
                        </label>
                      ))}
                    </div>
                  </details>
                </div>
                {eventForm.visibilityEnabled && (
                  <div className="event-editor-row">
                    <EventRowIcon name="department" />
                    <details
                      className="event-picker-row"
                      open={showVisibilityEditor}
                      onToggle={(event) => setShowVisibilityEditor(event.currentTarget.open)}
                    >
                      <summary>
                        <span>{hiddenTargetText}</span>
                        <small>顯示對象 / 替代標題</small>
                      </summary>
                      <div className="event-visibility-editor">
                        <strong>替代顯示標題</strong>
                        <div className="title-override-list">
                          {eventForm.titleOverrides.map((override, index) => {
                            const overrideIcon = override.icon || selectedTitleIcon(override.title, titleIconOptions)
                            const overrideTitleText = titleWithoutKnownIcon(override.title, titleIconOptions)
                            return (
                            <div className="title-override-row" key={`${override.targetType}-${override.targetId}-${index}`}>
                              <div className="title-override-target-row">
                                <select
                                  value={override.targetType}
                                  onChange={(event) => {
                                    const targetType = event.target.value as NonNullable<CalendarEvent['titleOverrides']>[number]['targetType']
                                    updateTitleOverride(index, {
                                      targetType,
                                      targetId: defaultTitleOverrideTargetId(targetType)
                                    })
                                  }}
                                >
                                  <option value="department">部門</option>
                                  <option value={ALL_DEPARTMENTS_EXCEPT_OWN}>所有部門（除了自己所屬部門）</option>
                                  <option value="employee">同仁</option>
                                  <option value={ALL_EMPLOYEES_EXCEPT_SELF}>所有同仁（除了自己）</option>
                                </select>
                                <select
                                  value={
                                    override.targetType === ALL_DEPARTMENTS_EXCEPT_OWN
                                      ? (override.targetId || ownDepartmentId)
                                      : override.targetType === ALL_EMPLOYEES_EXCEPT_SELF
                                        ? (override.targetId || employeeId || '')
                                        : override.targetId
                                  }
                                  onChange={(event) => updateTitleOverride(index, { targetId: event.target.value })}
                                  disabled={override.targetType === ALL_DEPARTMENTS_EXCEPT_OWN || override.targetType === ALL_EMPLOYEES_EXCEPT_SELF}
                                >
                                  {override.targetType === 'department' && departments.map((department) => (
                                    <option key={department.id} value={department.id}>{department.name}</option>
                                  ))}
                                  {override.targetType === 'employee' && employees.filter((emp) => employeeActiveForCalendar(emp)).map((emp) => (
                                    <option key={emp.id} value={emp.id}>{employeeName(emp.id)}</option>
                                  ))}
                                  {override.targetType === ALL_DEPARTMENTS_EXCEPT_OWN && (
                                    <option value={override.targetId || ownDepartmentId}>
                                      除了 {departmentName(override.targetId || ownDepartmentId) || '自己所屬部門'}
                                    </option>
                                  )}
                                  {override.targetType === ALL_EMPLOYEES_EXCEPT_SELF && (
                                    <option value={override.targetId || employeeId || ''}>
                                      除了 {override.targetId ? employeeName(override.targetId) : '自己'}
                                    </option>
                                  )}
                                </select>
                                <button type="button" onClick={() => removeTitleOverride(index)} aria-label="刪除替代標題">×</button>
                              </div>
                              <div className="title-override-title-row">
                                <div className="title-override-icon-picker">
                                  <button
                                    type="button"
                                    onClick={() => setTitleOverrideIconPickerIndex((current) => current === index ? null : index)}
                                    aria-label="選擇替代標題圖示"
                                  >
                                    {overrideIcon || '＋'}
                                  </button>
                                  {titleOverrideIconPickerIndex === index && (
                                    <div className="title-icon-menu">
                                      {titleIconOptions.map((item) => (
                                        <button type="button" key={`${item.icon}-${item.label}`} onClick={() => chooseTitleOverrideIcon(index, item.icon)}>
                                          <span>{item.icon}</span>
                                          <small>{item.label}</small>
                                        </button>
                                      ))}
                                    </div>
                                  )}
                                </div>
                                <input
                                  value={overrideTitleText}
                                  onChange={(event) => updateTitleOverride(index, {
                                    icon: overrideIcon || undefined,
                                    title: event.target.value
                                  })}
                                  placeholder="此對象看到的標題"
                                />
                              </div>
                            </div>
                          )})}
                          <button type="button" className="todo-add-btn" onClick={addTitleOverride}>新增替代標題</button>
                        </div>

                        <strong>顯示給這些部門</strong>
                        <div className="event-assignee-grid event-calendar-grid">
                          <label>
                            <input
                              type="checkbox"
                              checked={allDepartmentsVisible}
                              onChange={toggleAllDepartmentsVisible}
                            />
                            <span>所有部門</span>
                            <small>除了事件所屬部門</small>
                          </label>
                          {departments
                            .filter((department) => department.id !== eventForm.departmentId && department.name !== eventFormDepartmentName)
                            .map((department) => (
                            <label key={department.id}>
                              <input
                                type="checkbox"
                                checked={eventForm.visibleDepartmentIds.includes(department.id)}
                                onChange={() => setEventForm((form) => ({ ...form, visibleDepartmentIds: toggle(form.visibleDepartmentIds, department.id) }))}
                              />
                              <span>{department.name}</span>
                              <small>顯示部門</small>
                            </label>
                          ))}
                        </div>

                        <strong>排除這些同仁</strong>
                        <div className="event-assignee-grid">
                          {employees.filter((emp) => employeeActiveForCalendar(emp) && emp.id !== employeeId).map((emp) => (
                            <label key={emp.id}>
                              <input
                                type="checkbox"
                                checked={eventForm.hiddenAssigneeIds.includes(emp.id)}
                                onChange={() => setEventForm((form) => ({ ...form, hiddenAssigneeIds: toggle(form.hiddenAssigneeIds, emp.id) }))}
                              />
                              <span>{employeeName(emp.id)}</span>
                              <small>{emp.departmentName || departmentName(emp.departmentId || '')}</small>
                            </label>
                          ))}
                        </div>
                      </div>
                    </details>
                  </div>
                )}
                <div className="event-editor-row">
                  <EventRowIcon name="bell" />
                  <select
                    className={eventForm.reminder && eventForm.reminder !== 'none' ? '' : 'placeholder'}
                    value={eventForm.reminder}
                    onChange={(event) => changeReminder(event.target.value as CalendarEvent['reminder'])}
                    aria-label="通知"
                  >
                    {REMINDER_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </div>
                {!salesDeliveryEditor && (
                <div className="event-editor-row">
                  <EventRowIcon name="repeat" />
                  <button
                    type="button"
                    className={`event-static-row event-repeat-button ${eventForm.repeat && eventForm.repeat !== 'none' ? 'selected' : ''}`}
                    onClick={() => setShowRepeatPicker(true)}
                    disabled={relatedSalesDeliveryDraft}
                  >
                    {selectedRepeatText}
                  </button>
                </div>
                )}
                <div className="event-editor-row">
                  <EventRowIcon name="link" />
                  <input type="url" value={eventForm.url} onChange={(event) => setEventForm((form) => ({ ...form, url: event.target.value }))} placeholder="網址" />
                </div>
                <div className="event-editor-row">
                  <EventRowIcon name="location" />
                  <input value={eventForm.location} onChange={(event) => setEventForm((form) => ({ ...form, location: event.target.value }))} placeholder="地點" />
                </div>
                <div className="event-editor-row attachment">
                  <EventRowIcon name="paperclip" />
                  <div>
                    {salesDeliveryAttachmentReadonly ? (
                      <small className="sales-delivery-attachment-notice">
                        {relatedSalesDeliveryDraft
                          ? '附件沿用 ERP 主事件附件中心，附屬事件不另外新增或刪除附件。'
                          : '完成照片請從事件詳情上傳；如需刪除，請至 ERP 附件中心處理。'}
                      </small>
                    ) : (
                      <label className="attachment-picker">
                        <input type="file" multiple onChange={handleAttachmentFileChange} />
                        上傳檔案
                      </label>
                    )}
                    {[...eventForm.attachments.map((file) => file.name), ...attachmentUploads.map((file) => file.name)].length > 0 && (
                      <div className={`attachment-list${salesDeliveryAttachmentReadonly ? ' readonly' : ''}`}>
                        {eventForm.attachments.map((file) => (
                          <span key={file.path || file.url}>
                            <span>{file.name}</span>
                            {!salesDeliveryAttachmentReadonly && (
                              <button type="button" aria-label={`刪除 ${file.name}`} onClick={() => removeExistingAttachment(file)}>×</button>
                            )}
                          </span>
                        ))}
                        {attachmentUploads.map((file) => (
                          <span key={file.id} className={`attachment-upload ${file.status}`}>
                            <span>{file.name}</span>
                            <small>{file.status === 'uploading' ? '上傳中' : file.status === 'failed' ? '失敗' : '完成'}</small>
                            {!salesDeliveryAttachmentReadonly && (
                              <button type="button" aria-label={`刪除 ${file.name}`} onClick={() => removeUploadedAttachment(file)}>×</button>
                            )}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                {!salesDeliverySystemNoteReadonly && (
                  <div className="event-editor-row note">
                    <EventRowIcon name="note" />
                    <textarea
                      ref={noteTextareaRef}
                      rows={1}
                      value={eventForm.note}
                      onChange={(event) => {
                        event.currentTarget.style.height = 'auto'
                        event.currentTarget.style.height = `${event.currentTarget.scrollHeight}px`
                        setEventForm((form) => ({ ...form, note: event.target.value }))
                      }}
                      placeholder="備註"
                    />
                  </div>
                )}
                <div className="event-editor-row">
                  <EventRowIcon name="check" />
                  <details className="event-picker-row todo-picker">
                    <summary>
                      <span>{todoSummaryText}</span>
                    </summary>
                    <div className="todo-editor-list">
                      {eventForm.todos.map((todo) => (
                        <div className="todo-editor-item" key={todo.id}>
                          <input type="checkbox" checked={todo.done} disabled={relatedSalesDeliveryDraft} onChange={(event) => updateTodoItem(todo.id, { done: event.target.checked })} aria-label="待辦完成" />
                          <input value={todo.text} disabled={relatedSalesDeliveryDraft} onChange={(event) => updateTodoItem(todo.id, { text: event.target.value })} placeholder="新增待辦" />
                          <button type="button" disabled={relatedSalesDeliveryDraft} onClick={() => removeTodoItem(todo.id)} aria-label="刪除待辦">×</button>
                        </div>
                      ))}
                      <button className="todo-add-btn" type="button" disabled={relatedSalesDeliveryDraft} onClick={addTodoItem}>新增待辦</button>
                    </div>
                  </details>
                </div>
              </fieldset>
            </div>
          </div>
        </div>
      )}

      {recurrenceEditCandidate && (
        <div
          className="modal-overlay repeat-overlay"
          onTouchStartCapture={rememberOverlaySystemGesture}
          onClick={(event) => {
            if (shouldKeepOverlayOpenForSystemGesture(event)) return
            setRecurrenceEditCandidate(null)
          }}
        >
          <div className="modal repeat-modal recurrence-scope-modal" onClick={(event) => event.stopPropagation()}>
            <div className="repeat-option-list">
              <button type="button" onClick={() => startEditEvent(recurrenceEditCandidate, 'single')}>
                <span>只編輯這項預定</span>
              </button>
              <button type="button" onClick={() => startEditEvent(recurrenceEditCandidate, 'future')}>
                <span>編輯這之後的預定</span>
              </button>
              <button type="button" onClick={() => startEditEvent(recurrenceEditCandidate, 'all')}>
                <span>編輯所有預定</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {recurrenceDeleteCandidate && (
        <div
          className="modal-overlay repeat-overlay"
          onTouchStartCapture={rememberOverlaySystemGesture}
          onClick={(event) => {
            if (shouldKeepOverlayOpenForSystemGesture(event)) return
            setRecurrenceDeleteCandidate(null)
          }}
        >
          <div className="modal repeat-modal recurrence-scope-modal" onClick={(event) => event.stopPropagation()}>
            <div className="repeat-option-list">
              <button type="button" onClick={() => applyDeleteEvent(recurrenceDeleteCandidate, 'single')}>
                <span>只刪除這項預定</span>
              </button>
              <button type="button" onClick={() => applyDeleteEvent(recurrenceDeleteCandidate, 'future')}>
                <span>刪除這之後的預定</span>
              </button>
              <button type="button" onClick={() => applyDeleteEvent(recurrenceDeleteCandidate, 'all')}>
                <span>刪除所有預定</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {showRepeatPicker && (
        <div
          className="modal-overlay repeat-overlay"
          onTouchStartCapture={rememberOverlaySystemGesture}
          onClick={(event) => {
            if (shouldKeepOverlayOpenForSystemGesture(event)) return
            setShowRepeatPicker(false)
          }}
        >
          <div className="modal repeat-modal" onClick={(event) => event.stopPropagation()}>
            <div className="repeat-option-list">
              {repeatOptions.map((option) => (
                <button
                  type="button"
                  key={option.value}
                  className={eventForm.repeat === option.value ? 'selected' : ''}
                  onClick={() => changeRepeat(option.value)}
                >
                  <span>{option.label}</span>
                  <i />
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {showErpOrderScanner && (
        <Suspense fallback={<div className="loading-page">掃描器載入中...</div>}>
          <ErpOrderScanner onClose={() => setShowErpOrderScanner(false)} />
        </Suspense>
      )}

      {showRepeatCustomModal && (
        <div
          className="modal-overlay repeat-overlay"
          onTouchStartCapture={rememberOverlaySystemGesture}
          onClick={(event) => {
            if (shouldKeepOverlayOpenForSystemGesture(event)) return
            setShowRepeatCustomModal(false)
          }}
        >
          <div className="modal repeat-custom-modal" onClick={(event) => event.stopPropagation()}>
            <div className="repeat-custom-header">
              <EventRowIcon name="repeat" />
              <strong>自訂</strong>
            </div>
            <div className="repeat-custom-body">
              <div className="repeat-interval-row">
                <span>重複間隔：每</span>
                <input
                  type="number"
                  min="1"
                  value={eventForm.repeatCustom?.interval ?? 1}
                  onChange={(event) => updateCustomRepeat({ interval: Math.max(1, Number(event.target.value) || 1) })}
                />
                <select
                  value={eventForm.repeatCustom?.frequency ?? 'day'}
                  onChange={(event) => updateCustomRepeat({ frequency: event.target.value as NonNullable<CalendarEvent['repeatCustom']>['frequency'] })}
                >
                  <option value="day">天</option>
                  <option value="week">週</option>
                  <option value="month">月</option>
                  <option value="year">年</option>
                </select>
              </div>

              <div className="repeat-end-group">
                <strong>結束時間</strong>
                <label>
                  <input
                    type="radio"
                    name="repeat-end"
                    checked={(eventForm.repeatCustom?.ends ?? 'never') === 'never'}
                    onChange={() => updateCustomRepeat({ ends: 'never' })}
                  />
                  無
                </label>
                <label>
                  <input
                    type="radio"
                    name="repeat-end"
                    checked={eventForm.repeatCustom?.ends === 'until'}
                    onChange={() => updateCustomRepeat({ ends: 'until' })}
                  />
                  於：
                  <CalendarDatePicker
                    value={eventForm.repeatCustom?.until ?? dayjs(eventForm.date).add(1, 'month').format('YYYY-MM-DD')}
                    disabled={eventForm.repeatCustom?.ends !== 'until'}
                    min={eventForm.date}
                    ariaLabel="選擇重複截止日期"
                    className="repeat-until-date-trigger"
                    onChange={(nextDate) => updateCustomRepeat({ until: nextDate })}
                  />
                </label>
                <label>
                  <input
                    type="radio"
                    name="repeat-end"
                    checked={eventForm.repeatCustom?.ends === 'count'}
                    onChange={() => updateCustomRepeat({ ends: 'count' })}
                  />
                  次數：
                  <input
                    type="number"
                    min="1"
                    value={eventForm.repeatCustom?.count ?? 1}
                    disabled={eventForm.repeatCustom?.ends !== 'count'}
                    onChange={(event) => updateCustomRepeat({ count: Math.max(1, Number(event.target.value) || 1) })}
                  />
                </label>
              </div>
            </div>
            <div className="modal-footer">
              <button className="small-btn" onClick={() => setShowRepeatCustomModal(false)}>取消</button>
              <button
                className="primary-btn"
                onClick={() => {
                  setEventForm((form) => ({ ...form, repeat: 'custom', repeatCustom: form.repeatCustom ?? emptyEvent.repeatCustom }))
                  setShowRepeatCustomModal(false)
                }}
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
