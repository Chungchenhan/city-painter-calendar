import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, DragEvent, PointerEvent, ReactNode, TouchEvent as ReactTouchEvent } from 'react'
import dayjs from 'dayjs'
import { addDoc, arrayUnion, collection, deleteDoc, doc, getDoc, getDocs, query, setDoc, updateDoc, where } from 'firebase/firestore'
import { signOut } from 'firebase/auth'
import { useQueryClient } from '@tanstack/react-query'
import { auth, db } from '../lib/firebase'
import { readLocalQueryCache, updateLocalQueryCache } from '../lib/localQueryCache'
import { useAuth } from '../contexts/AuthContext'
import { useCalendarActivityLogs, useCalendarEvents, useCalendarGroups } from '../hooks/useCalendarData'
import { useDepartments, useEmployees, useShifts } from '../hooks/useHrData'
import type { CalendarActivityLog, CalendarEvent, CalendarGroup, PunchLog, UserNotificationSettings } from '../types'

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']
const COLORS = ['#f6b100', '#1fb6a6', '#3c82f6', '#ef6262', '#8d6df2', '#31a24c', '#f57c35', '#667085']
const DEPARTMENT_CALENDAR_PREFIX = 'department:'
const HR_LEAVE_CALENDAR_NAME = 'HR 請假'
const ACTIVITY_NOTIFICATION_SEEN_KEY = 'cityPainterCalendarActivitySeenAt'
const DEFAULT_USER_NOTIFICATION_SETTINGS: UserNotificationSettings = {
  shiftStartEnabled: true,
  shiftEndEnabled: false,
  punchInEnabled: false,
  punchOutEnabled: false,
  punchLeadMinutes: 0
}
const REMINDER_OPTIONS = [
  { value: 'none', label: '無通知' },
  { value: 'start', label: '活動開始時' },
  { value: '5m', label: '5 分鐘前' },
  { value: '15m', label: '15 分鐘前' },
  { value: '1h', label: '1 小時前' },
  { value: '1d', label: '1 天前' }
] as const
type TitleIconOption = {
  icon: string
  label: string
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
type ViewMode = 'month' | 'week'
type EventEditorIcon = 'person' | 'department' | 'calendar' | 'bell' | 'repeat' | 'link' | 'location' | 'paperclip' | 'note' | 'check'
type RecurrenceEditScope = 'single' | 'future' | 'all'
type EventAttachment = NonNullable<CalendarEvent['attachments']>[number]
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

function clampNotificationLeadMinutes(value: unknown) {
  const minutes = Number(value)
  if (!Number.isFinite(minutes)) return 0
  return Math.max(0, Math.min(240, Math.round(minutes)))
}

function todayShiftTime(date: string, time: string, fallbackTime: string) {
  const value = dayjs(`${date} ${time || fallbackTime}`)
  return value.isValid() ? value : dayjs(`${date} ${fallbackTime}`)
}

function isImageAttachment(attachment: EventAttachment) {
  if (attachment.type?.startsWith('image/')) return true
  return /\.(png|jpe?g|webp|gif)$/i.test(attachment.name)
}

function attachmentPreviewUrl(attachment: EventAttachment) {
  if (!isImageAttachment(attachment)) return ''
  if (attachment.provider === 'google-drive' && attachment.path) {
    return `https://drive.google.com/thumbnail?id=${encodeURIComponent(attachment.path)}&sz=w1000`
  }
  return attachment.url
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

function isHrReadonlyEvent(event: CalendarEvent) {
  return event.source === 'hrLeaveRequest' || event.id.startsWith('hrLeaveRequest_')
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

export default function CalendarPage() {
  const queryClient = useQueryClient()
  const { user, role, employeeId, displayName } = useAuth()
  const isAdmin = role === 'admin'
  const [month, setMonth] = useState(dayjs().startOf('month'))
  const { data: calendars = [], isLoading: calendarsLoading } = useCalendarGroups()
  const { data: events = [], isLoading: eventsLoading } = useCalendarEvents(month.format('YYYY-MM'))
  const { data: activityLogs = [] } = useCalendarActivityLogs()
  const { data: employees = [] } = useEmployees()
  const { data: departments = [] } = useDepartments()
  const { data: shifts = [] } = useShifts()

  const [selectedDate, setSelectedDate] = useState(dayjs().format('YYYY-MM-DD'))
  const [viewMode, setViewMode] = useState<ViewMode>('month')
  const [calendarSelectionMode, setCalendarSelectionMode] = useState<'all' | 'none' | 'custom'>('all')
  const [activeCalendarIds, setActiveCalendarIds] = useState<string[]>([])
  const [showCalendarDrawer, setShowCalendarDrawer] = useState(false)
  const [showSearchPanel, setShowSearchPanel] = useState(false)
  const [showNotificationsPanel, setShowNotificationsPanel] = useState(false)
  const [showAccountMenu, setShowAccountMenu] = useState(false)
  const [showStartupNotificationPrompt, setShowStartupNotificationPrompt] = useState(false)
  const [showNotificationSettings, setShowNotificationSettings] = useState(false)
  const [showTitleIconSettings, setShowTitleIconSettings] = useState(false)
  const [showTitleIconPicker, setShowTitleIconPicker] = useState(false)
  const [showTitleSuggestions, setShowTitleSuggestions] = useState(false)
  const [showRepeatPicker, setShowRepeatPicker] = useState(false)
  const [showRepeatCustomModal, setShowRepeatCustomModal] = useState(false)
  const [dayListDate, setDayListDate] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [activeSearchDepartmentIds, setActiveSearchDepartmentIds] = useState<string[]>([])
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission>(() => (
    'Notification' in window ? Notification.permission : 'denied'
  ))
  const [notificationSettings, setNotificationSettings] = useState<UserNotificationSettings>(DEFAULT_USER_NOTIFICATION_SETTINGS)
  const [savingNotificationSettings, setSavingNotificationSettings] = useState(false)
  const [titleIconOptions, setTitleIconOptions] = useState<TitleIconOption[]>(DEFAULT_TITLE_ICON_OPTIONS)
  const [titleIconDraft, setTitleIconDraft] = useState<TitleIconOption[]>(DEFAULT_TITLE_ICON_OPTIONS)
  const [savingTitleIcons, setSavingTitleIcons] = useState(false)
  const [lastSeenActivityAt, setLastSeenActivityAt] = useState(() => localStorage.getItem(ACTIVITY_NOTIFICATION_SEEN_KEY) || '')
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null)
  const [showCalendarModal, setShowCalendarModal] = useState(false)
  const [showEventModal, setShowEventModal] = useState(false)
  const [editingCalendarId, setEditingCalendarId] = useState<string | null>(null)
  const [editingEventId, setEditingEventId] = useState<string | null>(null)
  const [recurrenceEditMode, setRecurrenceEditMode] = useState<{ scope: RecurrenceEditScope, source: CalendarEvent } | null>(null)
  const [recurrenceEditCandidate, setRecurrenceEditCandidate] = useState<CalendarEvent | null>(null)
  const [recurrenceDeleteCandidate, setRecurrenceDeleteCandidate] = useState<CalendarEvent | null>(null)
  const [calendarForm, setCalendarForm] = useState(emptyCalendar)
  const [eventForm, setEventForm] = useState(emptyEvent)
  const [attachmentFiles, setAttachmentFiles] = useState<File[]>([])
  const [deletedAttachments, setDeletedAttachments] = useState<EventAttachment[]>([])
  const [dragActionMenu, setDragActionMenu] = useState<DragActionMenu | null>(null)
  const [dragOverDate, setDragOverDate] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const noteTextareaRef = useRef<HTMLTextAreaElement | null>(null)
  const monthInputRef = useRef<HTMLInputElement | null>(null)
  const calendarTouchStartRef = useRef<{ x: number; y: number } | null>(null)
  const suppressEventClickRef = useRef(false)
  const pointerDragRef = useRef<{
    eventId: string
    startX: number
    startY: number
    moved: boolean
  } | null>(null)
  const seenActivityLogIdsRef = useRef<Set<string> | null>(null)

  const currentEmployee = employees.find((emp) => emp.id === employeeId)
  const currentEmployeeDepartmentName = currentEmployee?.departmentName || departments.find((department) => department.id === currentEmployee?.departmentId)?.name || ''
  const canManageCalendarColors = currentEmployeeDepartmentName === '管理部'
  const currentShift = shifts.find((shift) => (
    Boolean(currentEmployee?.shiftId && shift.id === currentEmployee.shiftId) ||
    Boolean(currentEmployee?.shiftName && shift.name === currentEmployee.shiftName)
  ))

  const departmentCalendarSettingsMap = useMemo(() => (
    new Map(calendars.map((calendar) => [calendar.id, calendar]))
  ), [calendars])

  const departmentCalendars = useMemo<DisplayCalendar[]>(() => (
    [...departments]
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'))
      .map((department, index) => {
        const setting = departmentCalendarSettingsMap.get(departmentCalendarDocId(department.id))
        return {
          id: departmentCalendarId(department.id),
          name: department.name,
          color: setting?.color || COLORS[index % COLORS.length],
          departmentIds: [department.id],
          employeeIds: employees
            .filter((employee) => employee.status !== 'inactive')
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
    const departmentList = isAdmin
      ? departmentCalendars
      : departmentCalendars.filter((calendar) => (
        Boolean(currentEmployee?.departmentId && calendar.departmentIds.includes(currentEmployee.departmentId)) ||
        Boolean(currentEmployee?.departmentName && calendar.name === currentEmployee.departmentName)
      ))

    const canViewHrLeave = hrLeaveCalendar && (
      isAdmin ||
      hrLeaveCalendar.isCompanyWide ||
      Boolean(employeeId && hrLeaveCalendar.employeeIds?.includes(employeeId)) ||
      Boolean(currentEmployee?.departmentId && hrLeaveCalendar.departmentIds?.includes(currentEmployee.departmentId)) ||
      Boolean(currentEmployee?.departmentName && hrLeaveCalendar.departmentIds?.includes(currentEmployee.departmentName))
    )

    return canViewHrLeave ? [...departmentList, hrLeaveCalendar] : departmentList
  }, [currentEmployee?.departmentId, currentEmployee?.departmentName, departmentCalendars, employeeId, hrLeaveCalendar, isAdmin])

  const visibleCalendarIds = visibleCalendars.map((calendar) => calendar.id)
  const activeVisibleCalendarIds = activeCalendarIds.filter((id) => visibleCalendarIds.includes(id))
  const selectedCalendarIds = calendarSelectionMode === 'all'
    ? visibleCalendarIds
    : calendarSelectionMode === 'none'
      ? []
      : activeVisibleCalendarIds
  const allCalendarsSelected = selectedCalendarIds.length === visibleCalendarIds.length
  const visibleCalendarMap = useMemo(() => new Map(visibleCalendars.map((calendar) => [calendar.id, calendar])), [visibleCalendars])
  const writableCalendars = visibleCalendars.filter((calendar) => calendar.systemKind !== 'hrLeave')
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
      const eventCalendarIds = eventDisplayCalendarIds(event)
      const eventCalendars = eventCalendarIds.map((id) => visibleCalendarMap.get(id)).filter(Boolean) as DisplayCalendar[]
      if (!eventCalendars.length) return Boolean(employeeId && event.assigneeIds?.includes(employeeId))
      if (!eventCalendars.some((calendar) => selectedCalendarIds.includes(calendar.id))) return false
      if (isAdmin) return true
      if (employeeId && event.assigneeIds?.includes(employeeId)) return true
      if (!event.assigneeIds?.length) return true
      return false
    })
  }, [employeeId, events, isAdmin, selectedCalendarIds, visibleCalendarMap, departments, employees, hrLeaveCalendar])

  const visibleEvents = useMemo(() => {
    const rangeStart = month.subtract(1, 'month').startOf('month').format('YYYY-MM-DD')
    const rangeEnd = month.add(1, 'month').endOf('month').format('YYYY-MM-DD')
    return expandRecurringEvents(visibleSourceEvents, rangeStart, rangeEnd)
  }, [month, visibleSourceEvents])

  const searchEvents = useMemo(() => {
    const keyword = searchQuery.trim().toLowerCase()
    return visibleEvents.filter((event) => {
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
  }, [employees, hasCustomSearchDepartmentFilter, searchQuery, selectedSearchDepartmentIds, visibleEvents])

  const eventsByDate = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>()
    visibleEvents.forEach((event) => {
      dateRangeBetween(event.date, eventEndDate(event)).forEach((date) => {
        const list = map.get(date) ?? []
        list.push(event)
        map.set(date, list)
      })
    })
    map.forEach((list) => list.sort(compareDayEvents))
    return map
  }, [visibleEvents])

  function canReceiveActivityLog(log: CalendarActivityLog) {
    const assigneeIds = log.assigneeIds ?? []
    if (assigneeIds.length) return Boolean(employeeId && assigneeIds.includes(employeeId))
    if (!log.departmentId) return true
    return Boolean(
      currentEmployee?.departmentId === log.departmentId ||
      currentEmployee?.departmentName === departmentName(log.departmentId)
    )
  }

  const visibleActivityLogs = useMemo(() => (
    activityLogs
      .filter((log) => selectedCalendarIds.includes(log.calendarId))
      .filter(canReceiveActivityLog)
  ), [activityLogs, currentEmployee?.departmentId, currentEmployee?.departmentName, employeeId, selectedCalendarIds])
  const unreadActivityCount = useMemo(() => (
    visibleActivityLogs.filter((log) => log.createdAt && log.createdAt > lastSeenActivityAt).length
  ), [lastSeenActivityAt, visibleActivityLogs])

  const hasTodayLeave = useMemo(() => {
    if (!employeeId) return false
    const today = dayjs().format('YYYY-MM-DD')
    return events.some((event) => (
      isHrReadonlyEvent(event) &&
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
    if (!user?.uid) {
      setNotificationSettings(DEFAULT_USER_NOTIFICATION_SETTINGS)
      return
    }
    const uid = user.uid
    let cancelled = false
    async function loadNotificationSettings() {
      try {
        const snap = await getDoc(doc(db, 'calendarNotificationSettings', uid))
        if (cancelled) return
        setNotificationSettings({
          ...DEFAULT_USER_NOTIFICATION_SETTINGS,
          ...(snap.exists() ? snap.data() : {})
        } as UserNotificationSettings)
      } catch {
        if (!cancelled) setNotificationSettings(DEFAULT_USER_NOTIFICATION_SETTINGS)
      }
    }
    void loadNotificationSettings()
    return () => {
      cancelled = true
    }
  }, [user?.uid])

  useEffect(() => {
    if (!user?.uid || !('Notification' in window) || Notification.permission === 'granted') return
    setShowStartupNotificationPrompt(true)
  }, [user?.uid])

  useEffect(() => {
    let cancelled = false
    async function loadTitleIconOptions() {
      try {
        const snap = await getDoc(doc(db, 'calendarSettings', 'titleIcons'))
        const options = snap.exists() ? (snap.data().options as TitleIconOption[] | undefined) : undefined
        const cleanOptions = (options ?? DEFAULT_TITLE_ICON_OPTIONS)
          .map((item) => ({ icon: String(item.icon || '').trim(), label: String(item.label || '').trim() }))
          .filter((item) => item.icon && item.label)
        if (cancelled) return
        const nextOptions = cleanOptions.length ? cleanOptions : DEFAULT_TITLE_ICON_OPTIONS
        setTitleIconOptions(nextOptions)
        setTitleIconDraft(nextOptions)
      } catch {
        if (!cancelled) {
          setTitleIconOptions(DEFAULT_TITLE_ICON_OPTIONS)
          setTitleIconDraft(DEFAULT_TITLE_ICON_OPTIONS)
        }
      }
    }
    void loadTitleIconOptions()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!('Notification' in window) || Notification.permission !== 'granted') return
    const timers = visibleEvents.flatMap((event) => {
      if (!event.reminder || event.reminder === 'none') return []
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
  }, [canSendCalendarNotificationAt, visibleEvents])

  useEffect(() => {
    if (!employeeId || !currentShift || hasTodayLeave) return
    if (!('Notification' in window) || notificationPermission !== 'granted') return

    const today = dayjs().format('YYYY-MM-DD')
    const shiftStart = todayShiftTime(today, currentShift.startTime, '09:00')
    let shiftEnd = todayShiftTime(today, currentShift.endTime, '18:00')
    if (shiftEnd.isBefore(shiftStart)) shiftEnd = shiftEnd.add(1, 'day')

    const schedules = [
      {
        enabled: notificationSettings.shiftStartEnabled,
        at: shiftStart,
        title: '行事曆通知',
        body: `今日班表 ${currentShift.startTime} - ${currentShift.endTime}`,
        tag: `calendar-shift-start-${employeeId}-${today}`
      },
      {
        enabled: notificationSettings.shiftEndEnabled,
        at: shiftEnd,
        title: '行事曆通知',
        body: `今日班表 ${currentShift.startTime} - ${currentShift.endTime}`,
        tag: `calendar-shift-end-${employeeId}-${today}`
      },
      {
        enabled: notificationSettings.punchInEnabled,
        at: shiftStart.subtract(notificationSettings.punchLeadMinutes, 'minute'),
        title: '上班打卡提醒',
        body: `${currentShift.startTime} 上班，記得打卡`,
        tag: `calendar-punch-in-${employeeId}-${today}`,
        punchKind: 'in' as const
      },
      {
        enabled: notificationSettings.punchOutEnabled,
        at: shiftEnd.subtract(notificationSettings.punchLeadMinutes, 'minute'),
        title: '下班打卡提醒',
        body: `${currentShift.endTime} 下班，記得打卡`,
        tag: `calendar-punch-out-${employeeId}-${today}`,
        punchKind: 'out' as const
      }
    ]

    const timers = schedules.flatMap((schedule) => {
      if (!schedule.enabled) return []
      const delay = schedule.at.diff(dayjs())
      if (delay <= 0 || delay > 2147483647) return []
      const timer = window.setTimeout(async () => {
        if (schedule.punchKind) {
          const punched = await hasCompletedPunch(employeeId, today, schedule.punchKind)
          if (punched) return
        }
        void showLocalNotification(schedule.title, {
          body: schedule.body,
          tag: schedule.tag,
          icon: '/pwa-192x192.png',
          badge: '/pwa-192x192.png',
          data: { url: '/' }
        })
      }, delay)
      return [timer]
    })
    return () => timers.forEach((timer) => window.clearTimeout(timer))
  }, [currentShift, employeeId, hasTodayLeave, notificationPermission, notificationSettings])

  useEffect(() => {
    void setLocalBadge(unreadActivityCount)
  }, [unreadActivityCount])

  useEffect(() => {
    const currentIds = new Set(visibleActivityLogs.map((log) => log.id))
    if (!seenActivityLogIdsRef.current) {
      seenActivityLogIdsRef.current = currentIds
      return
    }

    const addedLogs = visibleActivityLogs
      .filter((log) => !seenActivityLogIdsRef.current?.has(log.id))
      .filter((log) => log.actorUid !== user?.uid)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    seenActivityLogIdsRef.current = currentIds

    if (notificationPermission !== 'granted') return
    if (!canSendCalendarNotificationAt(dayjs())) return
    addedLogs.slice(-3).forEach((log) => {
      void showLocalNotification('行事曆通知', {
        body: activityLogText(log),
        tag: `calendar-activity-${log.id}`,
        icon: '/pwa-192x192.png',
        badge: '/pwa-192x192.png',
        data: { url: '/' }
      })
    })
  }, [canSendCalendarNotificationAt, notificationPermission, user?.uid, visibleActivityLogs])

  useEffect(() => {
    const textarea = noteTextareaRef.current
    if (!textarea || !showEventModal) return
    textarea.style.height = 'auto'
    textarea.style.height = `${textarea.scrollHeight}px`
  }, [eventForm.note, showEventModal])

  useEffect(() => {
    if (!dragActionMenu) return

    function closeMenu(event: MouseEvent | TouchEvent) {
      const target = event.target
      if (target instanceof Element && target.closest('.event-drag-menu')) return
      setDragActionMenu(null)
    }

    function closeMenuWithEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setDragActionMenu(null)
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

  useEffect(() => {
    if (!dayListDate) return

    function closeDayList(event: MouseEvent | TouchEvent) {
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
    if (!selectedEventId) return

    function closeEventDetail(event: MouseEvent | TouchEvent) {
      const target = event.target
      if (target instanceof Element && target.closest('.event-detail-panel, .event-pill, .event-line, .week-event')) return
      setSelectedEventId(null)
    }

    function closeEventDetailWithEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setSelectedEventId(null)
    }

    document.addEventListener('mousedown', closeEventDetail)
    document.addEventListener('touchstart', closeEventDetail)
    document.addEventListener('keydown', closeEventDetailWithEscape)
    return () => {
      document.removeEventListener('mousedown', closeEventDetail)
      document.removeEventListener('touchstart', closeEventDetail)
      document.removeEventListener('keydown', closeEventDetailWithEscape)
    }
  }, [selectedEventId])

  useEffect(() => {
    if (!showSearchPanel && !showNotificationsPanel) return

    function closeTopbarPanels(event: MouseEvent | TouchEvent) {
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
    if (!showTitleIconPicker) return

    function closeTitleIconPicker(event: MouseEvent | TouchEvent) {
      const target = event.target
      if (target instanceof Element && target.closest('.title-icon-picker')) return
      setShowTitleIconPicker(false)
    }

    function closeTitleIconPickerWithEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setShowTitleIconPicker(false)
    }

    document.addEventListener('mousedown', closeTitleIconPicker)
    document.addEventListener('touchstart', closeTitleIconPicker)
    document.addEventListener('keydown', closeTitleIconPickerWithEscape)
    return () => {
      document.removeEventListener('mousedown', closeTitleIconPicker)
      document.removeEventListener('touchstart', closeTitleIconPicker)
      document.removeEventListener('keydown', closeTitleIconPickerWithEscape)
    }
  }, [showTitleIconPicker])

  useEffect(() => {
    if (!showTitleSuggestions) return

    function closeTitleSuggestions(event: MouseEvent | TouchEvent) {
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

  const monthDays = useMemo(() => {
    const start = month.startOf('month').startOf('week')
    return Array.from({ length: 42 }, (_, index) => start.add(index, 'day'))
  }, [month])

  const weekDays = useMemo(() => {
    const start = dayjs(selectedDate).startOf('week')
    return Array.from({ length: 7 }, (_, index) => start.add(index, 'day'))
  }, [selectedDate])

  const selectedEvent = useMemo(() => {
    if (!selectedEventId) return null
    return visibleEvents.find((event) => event.id === selectedEventId) ?? null
  }, [selectedEventId, visibleEvents])
  const loading = calendarsLoading || eventsLoading
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

  function eventDisplayTitle(event: CalendarEvent) {
    if (!isHrReadonlyEvent(event) || !event.assigneeIds?.length) return event.title
    const employee = employees.find((item) => item.id === event.assigneeIds[0])
    const nickname = employee?.nickname?.trim()
    const name = employee?.name?.trim()
    if (!nickname || !name || !event.title.startsWith(name)) return event.title
    return `${nickname}${event.title.slice(name.length)}`
  }

  function textDisplayTitle(title: string) {
    const employee = employees.find((item) => item.nickname?.trim() && item.name?.trim() && title.startsWith(item.name.trim()))
    if (!employee?.nickname || !employee.name) return title
    return `${employee.nickname.trim()}${title.slice(employee.name.trim().length)}`
  }

  function currentActorName() {
    return employeeId ? employeeName(employeeId) : (displayName || user?.displayName || user?.email || '未命名使用者')
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
    if (field === 'reminder') return REMINDER_OPTIONS.find((option) => option.value === value)?.label ?? '無通知'
    if (field === 'repeat') return repeatLabel(value as CalendarEvent['repeat'], eventForm.date, eventForm.repeatCustom)
    if (field === 'todos') return Array.isArray(value) ? `${value.length} 項` : '0 項'
    if (field === 'attachments') return Array.isArray(value) ? `${value.length} 個附件` : '0 個附件'
    return String(value ?? '').trim() || '空白'
  }

  function eventChangeList(beforeEvent: CalendarEvent, afterEvent: Partial<CalendarEvent>) {
    const fields = [
      ['title', '標題'],
      ['date', '日期'],
      ['endDate', '結束日期'],
      ['startTime', '開始時間'],
      ['endTime', '結束時間'],
      ['departmentId', '部門'],
      ['calendarIds', '行事曆'],
      ['assigneeIds', '同仁'],
      ['reminder', '通知'],
      ['repeat', '重複'],
      ['location', '地點'],
      ['url', '網址'],
      ['note', '備註'],
      ['todos', '待辦清單']
    ] as const

    return fields.flatMap(([field, label]) => {
      const before = valueLabel(field, beforeEvent[field as keyof CalendarEvent])
      const after = valueLabel(field, afterEvent[field as keyof CalendarEvent])
      return before === after ? [] : [{ field, label, before, after }]
    })
  }

  async function writeActivityLog(input: Omit<CalendarActivityLog, 'id' | 'actorUid' | 'actorName' | 'createdAt'>) {
    try {
      await addDoc(collection(db, 'calendarActivityLogs'), {
        ...input,
        actorUid: user?.uid ?? '',
        actorName: currentActorName(),
        createdAt: new Date().toISOString()
      })
      await queryClient.invalidateQueries({ queryKey: ['calendarActivityLogs'] })
    } catch {
      // 活動紀錄失敗不應阻擋主要操作。
    }
  }

  function getDepartmentEmployeeIds(departmentId: string) {
    const department = departments.find((item) => item.id === departmentId)
    return employees
      .filter((employee) => employee.status !== 'inactive')
      .filter((employee) => employee.departmentId === departmentId || Boolean(department?.name && employee.departmentName === department.name))
      .map((employee) => employee.id)
  }

  function primaryDepartmentIdFromCalendarIds(calendarIds: string[], fallback = '') {
    const firstCalendarId = calendarIds[0] ?? ''
    return departmentIdFromCalendarId(firstCalendarId) || visibleCalendarMap.get(firstCalendarId)?.departmentIds?.[0] || fallback
  }

  function toggleEventCalendar(calendarId: string) {
    setEventForm((form) => {
      const calendarIds = toggle(form.calendarIds, calendarId)
      return {
        ...form,
        calendarIds,
        calendarId: calendarIds[0] ?? '',
        departmentId: primaryDepartmentIdFromCalendarIds(calendarIds, form.departmentId)
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
  const selectedEventCalendarText = eventForm.calendarIds.length > 0
    ? eventForm.calendarIds.map((id) => visibleCalendarMap.get(id)?.name).filter(Boolean).join('、')
    : '不選部門，僅指定同仁'
  const repeatOptions = useMemo(() => repeatPresetOptions(eventForm.date), [eventForm.date])
  const selectedRepeatText = repeatLabel(eventForm.repeat, eventForm.date, eventForm.repeatCustom)
  const currentTitleIcon = selectedTitleIcon(eventForm.title, titleIconOptions)
  const currentTitleText = titleWithoutKnownIcon(eventForm.title, titleIconOptions)
  const cachedEventArchive = useMemo(() => readLocalQueryCache<CalendarEvent[]>('calendarEventsArchive') ?? [], [events])
  const titleSuggestionEvents = useMemo(() => {
    const map = new Map<string, CalendarEvent>()
    cachedEventArchive.forEach((event) => map.set(event.id, event))
    events.forEach((event) => map.set(event.id, event))
    return Array.from(map.values())
  }, [cachedEventArchive, events])
  const titleSuggestionIndex = useMemo(() => (
    titleSuggestionEvents
      .filter((event) => event.location?.trim() || event.url?.trim() || event.note?.trim() || event.todos?.length)
      .filter((event) => dayjs(event.date).isBefore(dayjs().add(1, 'day'), 'day'))
      .sort((a, b) => `${b.date} ${b.startTime}`.localeCompare(`${a.date} ${a.startTime}`))
      .slice(0, 600)
      .map((event) => ({
        event,
        normalizedTitle: normalizeSearchText(eventDisplayTitle(event), titleIconOptions)
      }))
  ), [employees, titleIconOptions, titleSuggestionEvents])
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

  function requiredAssigneeIds(ids: string[]) {
    return employeeId ? Array.from(new Set([employeeId, ...ids])) : ids
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

  function handleCalendarTouchStart(event: ReactTouchEvent<HTMLElement>) {
    const touch = event.touches[0]
    if (!touch) return
    calendarTouchStartRef.current = { x: touch.clientX, y: touch.clientY }
  }

  function handleCalendarTouchEnd(event: ReactTouchEvent<HTMLElement>) {
    const start = calendarTouchStartRef.current
    calendarTouchStartRef.current = null
    const touch = event.changedTouches[0]
    if (!start || !touch) return
    const deltaX = touch.clientX - start.x
    const deltaY = touch.clientY - start.y
    if (Math.abs(deltaX) < 56 || Math.abs(deltaX) < Math.abs(deltaY) * 1.25) return
    movePeriod(deltaX < 0 ? 1 : -1)
  }

  function openAddEvent(date = selectedDate) {
    const defaultCalendar = writableCalendars.find((calendar) => (
      Boolean(currentEmployee?.departmentId && calendar.departmentIds.includes(currentEmployee.departmentId)) ||
      Boolean(currentEmployee?.departmentName && calendar.name === currentEmployee.departmentName)
    )) ?? writableCalendars[0]
    const defaultDepartmentId = defaultCalendar?.departmentIds[0] ?? currentEmployee?.departmentId ?? departments.find((department) => department.name === currentEmployee?.departmentName)?.id ?? ''
    setEventForm({
      ...emptyEvent,
      date,
      endDate: date,
      calendarId: defaultCalendar?.id ?? '',
      calendarIds: defaultCalendar?.id ? [defaultCalendar.id] : [],
      departmentId: defaultDepartmentId,
      assigneeIds: requiredAssigneeIds([])
    })
    setAttachmentFiles([])
    setDeletedAttachments([])
    setEditingEventId(null)
    setRecurrenceEditMode(null)
    setRecurrenceEditCandidate(null)
    setShowTitleIconPicker(false)
    setShowTitleSuggestions(false)
    setShowRepeatPicker(false)
    setShowRepeatCustomModal(false)
    setShowEventModal(true)
  }

  function openEventDetail(event: CalendarEvent) {
    setDragActionMenu(null)
    setDayListDate(null)
    setSelectedDate(event.date)
    setSelectedEventId(event.id)
    if (showNotificationsPanel) markActivityNotificationsSeen()
    setShowNotificationsPanel(false)
    setShowSearchPanel(false)
  }

  function openEditEvent(event: CalendarEvent) {
    if (isHrReadonlyEvent(event)) {
      alert('此活動來自 HR 後台，請至 HR 後台編輯')
      return
    }
    if (canUseRecurrenceScope(event)) {
      setRecurrenceEditCandidate(event)
      return
    }
    startEditEvent(event, 'all')
  }

  function canUseRecurrenceScope(event: CalendarEvent) {
    if (isRepeatingEvent(event)) return true
    if (!isRecurrenceOccurrence(event)) return false
    const rootEvent = events.find((item) => item.id === recurrenceRootId(event))
    return Boolean(rootEvent && isRepeatingEvent(rootEvent))
  }

  function startEditEvent(event: CalendarEvent, scope: RecurrenceEditScope) {
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
      note: rootEvent.note ?? '',
      reminder: rootEvent.reminder ?? 'none',
      repeat: scope === 'single' ? 'none' : (rootEvent.repeat ?? 'none'),
      repeatCustom: rootEvent.repeatCustom ?? emptyEvent.repeatCustom,
      todos: rootEvent.todos ?? [],
      location: rootEvent.location ?? '',
      url: rootEvent.url ?? '',
      attachments: rootEvent.attachments ?? []
    })
    setAttachmentFiles([])
    setDeletedAttachments([])
    setEditingEventId(rootEvent.id)
    setRecurrenceEditMode(isRepeatingEvent(rootEvent) ? { scope, source: event } : null)
    setRecurrenceEditCandidate(null)
    setShowTitleIconPicker(false)
    setShowTitleSuggestions(false)
    setShowRepeatPicker(false)
    setShowRepeatCustomModal(false)
    setShowEventModal(true)
  }

  async function refreshCalendarData() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['calendarCalendars'] }),
      queryClient.invalidateQueries({ queryKey: ['calendarEvents'] }),
      queryClient.invalidateQueries({ queryKey: ['calendarActivityLogs'] })
    ])
  }

  function addTodoItem() {
    setEventForm((form) => ({
      ...form,
      todos: [...form.todos, { id: crypto.randomUUID(), text: '', done: false }]
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
    } finally {
      dismissStartupNotificationPrompt()
    }
  }

  async function hasCompletedPunch(targetEmployeeId: string, date: string, kind: 'in' | 'out') {
    try {
      const snap = await getDocs(query(
        collection(db, 'punchLogs'),
        where('employeeId', '==', targetEmployeeId),
        where('date', '==', date)
      ))
      const punchLog = snap.docs[0] ? ({ id: snap.docs[0].id, ...snap.docs[0].data() } as PunchLog) : null
      const count = punchLog?.punches?.filter(Boolean).length ?? 0
      return kind === 'in' ? count >= 1 : count >= 2
    } catch {
      return false
    }
  }

  async function saveNotificationSettings() {
    if (!user?.uid) return
    setSavingNotificationSettings(true)
    try {
      if (
        (notificationSettings.shiftStartEnabled ||
          notificationSettings.shiftEndEnabled ||
          notificationSettings.punchInEnabled ||
          notificationSettings.punchOutEnabled) &&
        'Notification' in window &&
        Notification.permission === 'default'
      ) {
        const permission = await Notification.requestPermission()
        setNotificationPermission(permission)
      }
      const payload: UserNotificationSettings = {
        ...notificationSettings,
        punchLeadMinutes: clampNotificationLeadMinutes(notificationSettings.punchLeadMinutes),
        updatedAt: new Date().toISOString()
      }
      await setDoc(doc(db, 'calendarNotificationSettings', user.uid), payload, { merge: true })
      setNotificationSettings(payload)
      setShowNotificationSettings(false)
    } catch {
      alert('通知設定儲存失敗，請稍後再試')
    } finally {
      setSavingNotificationSettings(false)
    }
  }

  function markActivityNotificationsSeen() {
    const latest = visibleActivityLogs[0]?.createdAt ?? new Date().toISOString()
    localStorage.setItem(ACTIVITY_NOTIFICATION_SEEN_KEY, latest)
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

  function openTitleIconSettings() {
    setTitleIconDraft(titleIconOptions)
    setShowTitleIconSettings(true)
  }

  function updateTitleIconDraft(index: number, changes: Partial<TitleIconOption>) {
    setTitleIconDraft((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, ...changes } : item))
  }

  function removeTitleIconDraft(index: number) {
    setTitleIconDraft((items) => items.filter((_, itemIndex) => itemIndex !== index))
  }

  function addTitleIconDraft() {
    setTitleIconDraft((items) => [...items, { icon: '', label: '' }])
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
    setSavingTitleIcons(true)
    try {
      await setDoc(doc(db, 'calendarSettings', 'titleIcons'), {
        options,
        updatedAt: new Date().toISOString(),
        updatedBy: user?.uid ?? ''
      }, { merge: true })
      setTitleIconOptions(options)
      setTitleIconDraft(options)
      setShowTitleIconSettings(false)
    } catch {
      alert('標題 icon 設定儲存失敗')
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
        id: crypto.randomUUID(),
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

  async function updateDepartmentCalendarColor(calendar: DisplayCalendar, color: string) {
    const departmentId = calendar.departmentIds[0]
    if (!departmentId || !canManageCalendarColors) return

    try {
      await setDoc(doc(db, 'calendarCalendars', departmentCalendarDocId(departmentId)), {
        name: calendar.name,
        color,
        departmentIds: [departmentId],
        employeeIds: calendar.employeeIds,
        isCompanyWide: false,
        updatedAt: new Date().toISOString(),
        createdBy: user?.uid ?? ''
      }, { merge: true })
      await queryClient.invalidateQueries({ queryKey: ['calendarCalendars'] })
    } catch {
      alert('行事曆顏色儲存失敗')
    }
  }

  async function saveEvent() {
    const requiredAssignees = requiredAssigneeIds(eventForm.assigneeIds)
    if ((!eventForm.calendarIds.length && !requiredAssignees.length) || !eventForm.title.trim() || !eventForm.date) {
      alert('請填寫標題、日期，並選擇行事曆或指定同仁')
      return
    }
    const normalizedEndDate = dayjs(eventForm.endDate).isBefore(dayjs(eventForm.date), 'day') ? eventForm.date : eventForm.endDate
    const editingEvent = editingEventId ? events.find((event) => event.id === editingEventId) : null
    if (editingEvent && isHrReadonlyEvent(editingEvent)) {
      alert('此活動來自 HR 後台，請至 HR 後台編輯')
      return
    }

    setSaving(true)
    try {
      const pendingAttachmentFiles = [...attachmentFiles]
      const removedAttachments = [...deletedAttachments]
      const selectedCalendarIds = eventForm.calendarIds
      const primaryCalendarId = selectedCalendarIds[0] ?? ''
      const selectedDepartmentId = primaryDepartmentIdFromCalendarIds(selectedCalendarIds, eventForm.departmentId)
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
        note: eventForm.note.trim(),
        reminder: eventForm.reminder ?? 'none',
        repeat: eventForm.repeat ?? 'none',
        repeatCustom: eventForm.repeatCustom ?? emptyEvent.repeatCustom,
        todos: eventForm.todos.map((todo) => ({ ...todo, text: todo.text.trim() })).filter((todo) => todo.text),
        location: eventForm.location.trim(),
        url: eventForm.url.trim(),
        attachments: eventForm.attachments,
        updatedAt: new Date().toISOString()
      }

      let savedEventId = editingEventId
      if (editingEventId) {
        if (recurrenceEditMode?.scope === 'single' && editingEvent) {
          const sourceDate = recurrenceSourceDate(recurrenceEditMode.source)
          await updateDoc(doc(db, 'calendarEvents', editingEventId), {
            repeatExceptions: arrayUnion(sourceDate),
            updatedAt: new Date().toISOString()
          })
          const created = await addDoc(collection(db, 'calendarEvents'), {
            ...payload,
            repeat: 'none',
            repeatCustom: emptyEvent.repeatCustom,
            recurrenceParentId: editingEventId,
            recurrenceOriginalDate: editingEvent.date,
            recurrenceSourceDate: sourceDate,
            done: false,
            createdBy: user?.uid ?? '',
            createdAt: new Date().toISOString()
          })
          savedEventId = created.id
          await writeActivityLog({
            action: 'update',
            eventId: created.id,
            eventTitle: payload.title,
            calendarId: payload.calendarId,
            departmentId: payload.departmentId,
            assigneeIds: payload.assigneeIds,
            date: payload.date,
            changes: eventChangeList(editingEvent, payload)
          })
        } else if (recurrenceEditMode?.scope === 'future' && editingEvent && recurrenceSourceDate(recurrenceEditMode.source) !== editingEvent.date) {
          const sourceDate = recurrenceSourceDate(recurrenceEditMode.source)
          await updateDoc(doc(db, 'calendarEvents', editingEventId), {
            repeatUntil: dayjs(sourceDate).subtract(1, 'day').format('YYYY-MM-DD'),
            updatedAt: new Date().toISOString()
          })
          const created = await addDoc(collection(db, 'calendarEvents'), {
            ...payload,
            date: sourceDate,
            endDate: shiftedEventDateRange(payload, sourceDate).endDate,
            repeatExceptions: [],
            repeatUntil: '',
            done: false,
            createdBy: user?.uid ?? '',
            createdAt: new Date().toISOString()
          })
          savedEventId = created.id
          await writeActivityLog({
            action: 'update',
            eventId: created.id,
            eventTitle: payload.title,
            calendarId: payload.calendarId,
            departmentId: payload.departmentId,
            assigneeIds: payload.assigneeIds,
            date: sourceDate,
            changes: eventChangeList(editingEvent, payload)
          })
        } else {
          await updateDoc(doc(db, 'calendarEvents', editingEventId), payload)
          if (editingEvent) {
            const changes = eventChangeList(editingEvent, payload)
            if (changes.length) {
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
        const created = await addDoc(collection(db, 'calendarEvents'), {
          ...payload,
          done: false,
          createdBy: user?.uid ?? '',
          createdAt: new Date().toISOString()
        })
        savedEventId = created.id
        await writeActivityLog({
          action: 'create',
          eventId: created.id,
          eventTitle: payload.title,
          calendarId: payload.calendarId,
          departmentId: payload.departmentId,
          assigneeIds: payload.assigneeIds,
          date: payload.date
        })
      }

      setShowEventModal(false)
      setAttachmentFiles([])
      setDeletedAttachments([])
      setRecurrenceEditMode(null)
      await refreshCalendarData()
      if (savedEventId) {
        syncEventAttachmentsInBackground(savedEventId, pendingAttachmentFiles, removedAttachments)
      }
    } catch {
      alert('工作儲存失敗，請稍後再試')
    } finally {
      setSaving(false)
    }
  }

  async function uploadEventAttachments(eventId: string, files: File[]) {
    const formData = new FormData()
    formData.set('eventId', eventId)
    files.forEach((file) => formData.append('files', file))

    const response = await fetch('/api/upload-drive', {
      method: 'POST',
      body: formData
    })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) {
      throw new Error(result.error || '附件上傳失敗')
    }
    return result.attachments as NonNullable<CalendarEvent['attachments']>
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
        deleteFailures = await deleteRemovedEventAttachments(removedFiles)
      }

      if (hasUploadFailure) {
        alert('活動已儲存，但附件背景上傳失敗，請稍後重新上傳')
      } else if (deleteFailures > 0) {
        alert('活動已儲存，但部分雲端附件刪除失敗，請稍後再試')
      }
    })()
  }

  function removeExistingAttachment(file: EventAttachment) {
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

  function removePendingAttachment(index: number) {
    setAttachmentFiles((files) => files.filter((_, fileIndex) => fileIndex !== index))
  }

  async function deleteRemovedEventAttachments(files: EventAttachment[]) {
    const driveFiles = files.filter((file) => file.provider === 'google-drive' && file.path)
    if (!driveFiles.length) return 0

    const results = await Promise.allSettled(driveFiles.map(async (file) => {
      const response = await fetch('/api/upload-drive', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileId: file.path })
      })
      if (!response.ok) {
        const result = await response.json().catch(() => ({}))
        throw new Error(result.error || '附件刪除失敗')
      }
    }))

    return results.filter((result) => result.status === 'rejected').length
  }

  async function deleteEvent(event: CalendarEvent) {
    if (isHrReadonlyEvent(event)) {
      alert('此活動來自 HR 後台，請至 HR 後台刪除')
      return
    }
    if (canUseRecurrenceScope(event)) {
      setRecurrenceDeleteCandidate(event)
      return
    }
    await applyDeleteEvent(event, 'all')
  }

  async function applyDeleteEvent(event: CalendarEvent, scope: RecurrenceEditScope) {
    if (!confirm('確定刪除此工作？')) return
    setRecurrenceDeleteCandidate(null)
    try {
      const rootId = recurrenceRootId(event)
      const existingRootEvent = events.find((item) => item.id === rootId)
      const rootEvent = existingRootEvent ?? event
      const sourceDate = recurrenceSourceDate(event)
      if (isRecurrenceOccurrence(event) && !existingRootEvent) {
        await deleteDoc(doc(db, 'calendarEvents', event.id))
        removeEventsFromArchiveCache([event.id])
        await writeActivityLog({
          action: 'delete',
          eventId: event.id,
          eventTitle: eventDisplayTitle(event),
          calendarId: eventDisplayCalendarId(event),
          departmentId: event.departmentId,
          assigneeIds: event.assigneeIds,
          date: event.date
        })
        setSelectedEventId(null)
        await refreshCalendarData()
        return
      }
      if (scope === 'single' && (isRecurrenceOccurrence(event) || isRepeatingEvent(rootEvent))) {
        await updateDoc(doc(db, 'calendarEvents', rootId), {
          repeatExceptions: arrayUnion(sourceDate),
          updatedAt: new Date().toISOString()
        })
        await writeActivityLog({
          action: 'delete',
          eventId: rootId,
          eventTitle: eventDisplayTitle(event),
          calendarId: eventDisplayCalendarId(event),
          departmentId: event.departmentId,
          assigneeIds: event.assigneeIds,
          date: event.date
        })
        setSelectedEventId(null)
        await refreshCalendarData()
        return
      }
      if (scope === 'future' && isRepeatingEvent(rootEvent) && sourceDate !== rootEvent.date) {
        await updateDoc(doc(db, 'calendarEvents', rootId), {
          repeatUntil: dayjs(sourceDate).subtract(1, 'day').format('YYYY-MM-DD'),
          updatedAt: new Date().toISOString()
        })
      } else {
        await deleteDoc(doc(db, 'calendarEvents', rootId))
        removeEventsFromArchiveCache([rootId])
      }
      await writeActivityLog({
        action: 'delete',
        eventId: rootId,
        eventTitle: eventDisplayTitle(event),
        calendarId: eventDisplayCalendarId(event),
        departmentId: event.departmentId,
        assigneeIds: event.assigneeIds,
        date: event.date
      })
      setSelectedEventId((current) => current === event.id ? null : current)
      await refreshCalendarData()
    } catch {
      alert('工作刪除失敗')
    }
  }

  function eventDragAllowed(event: CalendarEvent) {
    return isAdmin && !isHrReadonlyEvent(event)
  }

  function clearEventDragState() {
    setDragOverDate(null)
    pointerDragRef.current = null
  }

  function openDragActionMenu(eventId: string, targetDate: string, x: number, y: number) {
    const draggedEvent = events.find((event) => event.id === eventId)
    if (!draggedEvent || !eventDragAllowed(draggedEvent)) return
    setSelectedDate(targetDate)
    setMonth(dayjs(targetDate).startOf('month'))
    setDragActionMenu({
      eventId,
      targetDate,
      x: Math.min(Math.max(x, 16), window.innerWidth - 176),
      y: Math.min(Math.max(y, 72), window.innerHeight - 130)
    })
  }

  function dragDateFromPoint(x: number, y: number) {
    const element = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-calendar-date]')
    return element?.dataset.calendarDate ?? ''
  }

  function beginPointerEventDrag(event: PointerEvent, calendarEvent: CalendarEvent) {
    if (!eventDragAllowed(calendarEvent)) return
    pointerDragRef.current = {
      eventId: calendarEvent.id,
      startX: event.clientX,
      startY: event.clientY,
      moved: false
    }
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }

  function movePointerEventDrag(event: PointerEvent) {
    const drag = pointerDragRef.current
    if (!drag) return
    const distance = Math.abs(event.clientX - drag.startX) + Math.abs(event.clientY - drag.startY)
    if (distance < 8) return
    drag.moved = true
    const targetDate = dragDateFromPoint(event.clientX, event.clientY)
    setDragOverDate(targetDate || null)
  }

  function endPointerEventDrag(event: PointerEvent) {
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
    if (!eventDragAllowed(calendarEvent)) {
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

  async function applyDragEventAction(action: 'move' | 'copy') {
    if (!dragActionMenu) return
    const sourceEvent = events.find((event) => event.id === dragActionMenu.eventId)
    if (!sourceEvent || !eventDragAllowed(sourceEvent)) {
      setDragActionMenu(null)
      return
    }

    setSaving(true)
    try {
      const nextDateRange = shiftedEventDateRange(sourceEvent, dragActionMenu.targetDate)
      if (action === 'move') {
        await updateDoc(doc(db, 'calendarEvents', sourceEvent.id), {
          ...nextDateRange,
          updatedAt: new Date().toISOString()
        })
        await writeActivityLog({
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
        setSelectedEventId(sourceEvent.id)
      } else {
        const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...eventPayload } = sourceEvent
        const created = await addDoc(collection(db, 'calendarEvents'), {
          ...eventPayload,
          ...nextDateRange,
          source: '',
          sourceId: '',
          sourceDate: '',
          createdBy: user?.uid ?? sourceEvent.createdBy ?? '',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        })
        await writeActivityLog({
          action: 'copy',
          eventId: created.id,
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
        setSelectedEventId(created.id)
      }
      setDragActionMenu(null)
      await refreshCalendarData()
    } catch {
      alert(action === 'move' ? '活動移動失敗，請稍後再試' : '活動複製失敗，請稍後再試')
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

  function renderEventSummary(event: CalendarEvent) {
    const rangeText = eventEndDate(event) === event.date ? event.date : `${event.date} - ${eventEndDate(event)}`
    return (
      <button className={`panel-event ${event.done ? 'done' : ''}`} key={event.id} style={{ '--event-color': eventCalendarColor(event) } as CSSProperties} onClick={() => openEventDetail(event)}>
        <span />
        <div>
          <strong>{eventDisplayTitle(event)}</strong>
          <small>{rangeText} {event.startTime} - {event.endTime} · {eventCalendarName(event)}</small>
        </div>
      </button>
    )
  }

  function renderEventDetailPanel() {
    if (!selectedEvent) return null
    const calendar = visibleCalendarMap.get(eventDisplayCalendarId(selectedEvent))
    const calendarName = calendar?.name || eventCalendarName(selectedEvent) || '未分類行事曆'
    const assignees = selectedEvent.assigneeIds.map(employeeName)
    const reminderLabel = REMINDER_OPTIONS.find((option) => option.value === (selectedEvent.reminder ?? 'none'))?.label ?? '無通知'
    const eventRepeatLabel = repeatLabel(selectedEvent.repeat, selectedEvent.date, selectedEvent.repeatCustom)
    const locationText = selectedEvent.location?.trim()
    const canManageEvent = isAdmin && !isHrReadonlyEvent(selectedEvent)
    return (
      <aside className="event-detail-panel" style={{ '--event-color': eventCalendarColor(selectedEvent) } as CSSProperties}>
        <div className="event-detail-header">
          <strong>活動詳情</strong>
          <div>
            {canManageEvent && <button onClick={() => openEditEvent(selectedEvent)} aria-label="編輯活動">⋮</button>}
            <button onClick={() => setSelectedEventId(null)} aria-label="關閉活動詳情">×</button>
          </div>
        </div>

        <div className="event-detail-body">
          <div className="event-detail-avatar" style={{ background: eventCalendarColor(selectedEvent) }}>
            {calendarName}
          </div>
          <h2>{eventDisplayTitle(selectedEvent)}</h2>
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

          <div className="event-detail-row">
            <EventRowIcon name="bell" />
            <div>{reminderLabel}</div>
          </div>
          <div className="event-detail-row">
            <EventRowIcon name="repeat" />
            <div>{eventRepeatLabel}</div>
          </div>
          <div className="event-detail-row">
            <EventRowIcon name="calendar" />
            <div>{calendarName}</div>
          </div>
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
            >
              <div>
                <strong>{locationText}</strong>
                <small>開啟 Google 地圖導航</small>
              </div>
            </a>
          )}

          {selectedEvent.url && (
            <a className="event-detail-link" href={selectedEvent.url} target="_blank" rel="noreferrer">
              <EventRowIcon name="link" />
              <div>{selectedEvent.url}</div>
            </a>
          )}

          {selectedEvent.attachments && selectedEvent.attachments.length > 0 && (
            <div className="event-detail-attachments">
              <strong>附件</strong>
              {selectedEvent.attachments.map((attachment) => {
                const previewUrl = attachmentPreviewUrl(attachment)
                return (
                  <a className={previewUrl ? 'image-attachment' : ''} href={attachment.url} target="_blank" rel="noreferrer" key={attachment.path || attachment.url}>
                    {previewUrl ? (
                      <img src={previewUrl} alt={attachment.name} loading="lazy" referrerPolicy="no-referrer" />
                    ) : (
                      <span>▧</span>
                    )}
                    <div>
                      <b>{attachment.name}</b>
                      {attachment.size && <small>{Math.ceil(attachment.size / 1024)} KB{attachment.optimized ? ' · WebP' : ''}</small>}
                    </div>
                  </a>
                )
              })}
            </div>
          )}

          {assignees.length > 0 && (
            <div className="event-detail-row">
              <EventRowIcon name="person" />
              <div>{assignees.join('、')}</div>
            </div>
          )}
          {selectedEvent.todos && selectedEvent.todos.length > 0 && (
            <div className="event-detail-todos">
              <strong>待辦清單</strong>
              {selectedEvent.todos.map((todo) => (
                <label key={todo.id}>
                  <input type="checkbox" checked={todo.done} readOnly />
                  <span>{todo.text}</span>
                </label>
              ))}
            </div>
          )}
          {selectedEvent.note && !isHrReadonlyEvent(selectedEvent) && (
            <div className="event-detail-note">
              <strong>備註</strong>
              <p>{selectedEvent.note}</p>
            </div>
          )}
        </div>

        {canManageEvent && (
          <div className="event-detail-footer">
            <button onClick={() => openEditEvent(selectedEvent)}>編輯</button>
            <button className="danger" onClick={() => deleteEvent(selectedEvent)}>刪除</button>
          </div>
        )}
      </aside>
    )
  }

  function renderDayListPanel() {
    if (!dayListDate) return null
    const dayEvents = eventsByDate.get(dayListDate) ?? []
    return (
      <aside className="tt-floating-panel tt-day-list-panel">
        <div className="panel-head">
          <h2>{dayjs(dayListDate).format('M月D日')}活動</h2>
          <button onClick={() => setDayListDate(null)} aria-label="關閉當日活動">×</button>
        </div>
        <p className="panel-hint">共 {dayEvents.length} 筆</p>
        <div className="panel-list">
          {dayEvents.map((event) => renderEventSummary(event))}
          {dayEvents.length === 0 && <p className="panel-empty">這天沒有活動</p>}
        </div>
        {isAdmin && (
          <button className="primary-btn" onClick={() => openAddEvent(dayListDate)}>新增這天活動</button>
        )}
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
          {visibleActivityLogs.slice(0, 12).map((log) => {
            const unread = Boolean(log.createdAt && log.createdAt > lastSeenActivityAt)
            return (
              <article className={`activity-log ${log.action}${unread ? ' unread' : ''}`} key={log.id}>
                <span style={{ background: activityLogColor(log) }} />
                <div>
                  <strong>{activityLogText(log)}</strong>
                  <small>{dayjs(log.createdAt).format('M/D HH:mm')} · {visibleCalendarMap.get(log.calendarId)?.name || departmentName(log.departmentId)}</small>
                </div>
              </article>
            )
          })}
          {visibleActivityLogs.length === 0 && <p className="panel-empty">目前沒有新的活動紀錄</p>}
        </div>
      </aside>
    )
  }

  function renderStartupNotificationPrompt() {
    if (!showStartupNotificationPrompt) return null
    return (
      <div className="modal-overlay" onClick={dismissStartupNotificationPrompt}>
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
      <div className="modal-overlay" onClick={() => setShowNotificationSettings(false)}>
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
                  <small>勾選後，上班時間內有活動新增、修改、刪除，或活動提醒時間到時都會通知。</small>
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

            <section className="notification-settings-section">
              <div className="notification-section-head">
                <strong>打卡提醒</strong>
                <small>到打卡時段才檢查；若已打卡就不提醒，錯過時間不補通知。</small>
              </div>
              <label className="notification-setting-row compact">
                <span>
                  <strong>上班卡</strong>
                  <small>檢查今天是否已有第一筆打卡。</small>
                </span>
                <input
                  type="checkbox"
                  checked={notificationSettings.punchInEnabled}
                  onChange={(event) => setNotificationSettings((settings) => ({ ...settings, punchInEnabled: event.target.checked }))}
                />
              </label>
              <label className="notification-setting-row compact">
                <span>
                  <strong>下班卡</strong>
                  <small>檢查今天是否已有第二筆打卡。</small>
                </span>
                <input
                  type="checkbox"
                  checked={notificationSettings.punchOutEnabled}
                  onChange={(event) => setNotificationSettings((settings) => ({ ...settings, punchOutEnabled: event.target.checked }))}
                />
              </label>
              <label className="notification-lead-row">
                <span>提前提醒</span>
                <input
                  type="number"
                  min="0"
                  max="240"
                  value={notificationSettings.punchLeadMinutes}
                  onChange={(event) => setNotificationSettings((settings) => ({ ...settings, punchLeadMinutes: clampNotificationLeadMinutes(event.target.value) }))}
                />
                <span>分鐘</span>
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
      <div className="modal-overlay" onClick={() => setShowTitleIconSettings(false)}>
        <div className="modal title-icon-settings-modal" onClick={(event) => event.stopPropagation()}>
          <div className="modal-header">
            <h2>標題 icon 設定</h2>
            <button className="close-btn" onClick={() => setShowTitleIconSettings(false)}>×</button>
          </div>
          <div className="modal-body title-icon-settings-body">
            {titleIconDraft.map((item, index) => (
              <div className="title-icon-setting-row" key={index}>
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
          {isAdmin && <button className="tt-icon-button add" onClick={() => openAddEvent(selectedDate)} aria-label="新增工作">＋</button>}
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
        </aside>

        {showCalendarDrawer && (
          <aside className="tt-calendar-drawer">
            <div className="panel-head">
              <h2>行事曆顏色設定</h2>
              <button onClick={() => setShowCalendarDrawer(false)} aria-label="關閉顏色設定">×</button>
            </div>
            <div className="drawer-section">
              <div className="panel-title-row">
                <span className="field-label">部門行事曆</span>
              </div>
              <div className="drawer-calendar-list">
                {visibleCalendars.filter((calendar) => calendar.systemKind === 'department').map((calendar) => {
                  return (
                    <div
                      key={calendar.id}
                      className="drawer-calendar-item active"
                      style={{ '--calendar-color': calendar.color } as CSSProperties}
                    >
                      <div className="drawer-calendar-main">
                        <span />
                        <strong>{calendar.name}</strong>
                        <small>部門</small>
                      </div>
                      <div className="drawer-color-row" aria-label={`${calendar.name}顏色`}>
                        {COLORS.map((color) => (
                          <button
                            key={color}
                            className={calendar.color === color ? 'selected' : ''}
                            style={{ '--swatch-color': color } as CSSProperties}
                            onClick={() => updateDepartmentCalendarColor(calendar, color)}
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

        <section className="tt-calendar-surface" onTouchStart={handleCalendarTouchStart} onTouchEnd={handleCalendarTouchEnd}>
          {loading ? (
            <div className="calendar-skeleton" />
          ) : (
            <>
            <div className="weekday-grid">
              {WEEKDAYS.map((day) => <div key={day}>{day}</div>)}
            </div>
            {viewMode === 'month' ? <div className="month-grid">
              {monthDays.map((day) => {
                const date = day.format('YYYY-MM-DD')
                const dayEvents = eventsByDate.get(date) ?? []
                const selected = selectedDate === date
                const today = dayjs().format('YYYY-MM-DD') === date
                return (
                  <button
                    className={`day-cell ${selected ? 'selected' : ''} ${day.month() !== month.month() ? 'muted' : ''} ${dragOverDate === date ? 'drag-over' : ''}`}
                    key={date}
                    data-calendar-date={date}
                    onClick={() => setSelectedDate(date)}
                    onDoubleClick={() => isAdmin && openAddEvent(date)}
                    onDragOver={(dragEvent) => {
                      dragEvent.preventDefault()
                      setDragOverDate(date)
                    }}
                    onDragLeave={() => setDragOverDate((current) => current === date ? null : current)}
                    onDrop={(dragEvent) => dropEventOnDate(dragEvent, date)}
                  >
                    <span className={`day-number ${today ? 'today' : ''}`}>{day.date()}</span>
                    <span className="day-events">
                      {dayEvents.slice(0, 7).map((event) => (
                        <button
                          className={`event-pill ${event.allDay ? 'all-day' : 'timed'} ${selectedEventId === event.id ? 'active' : ''}`}
                          style={{ '--event-color': eventCalendarColor(event) } as CSSProperties}
                          key={event.id}
                          draggable={eventDragAllowed(event)}
                          onDragStart={(dragEvent) => startNativeEventDrag(dragEvent, event)}
                          onDragEnd={clearEventDragState}
                          onPointerDown={(pointerEvent) => beginPointerEventDrag(pointerEvent, event)}
                          onPointerMove={movePointerEventDrag}
                          onPointerUp={endPointerEventDrag}
                          onPointerCancel={clearEventDragState}
                          onClick={(clickEvent) => {
                            clickEvent.stopPropagation()
                            if (suppressEventClickRef.current) return
                            openEventDetail(event)
                          }}
                        >
                          <span>{eventDisplayTitle(event)}</span>
                          {!event.allDay && <small>{event.startTime}</small>}
                        </button>
                      ))}
                      {dayEvents.length > 7 && (
                        <span
                          className="more-pill"
                          role="button"
                          tabIndex={0}
                          onClick={(clickEvent) => {
                            clickEvent.stopPropagation()
                            setSelectedDate(date)
                            setDayListDate(date)
                          }}
                          onKeyDown={(keyEvent) => {
                            if (keyEvent.key !== 'Enter' && keyEvent.key !== ' ') return
                            keyEvent.preventDefault()
                            keyEvent.stopPropagation()
                            setSelectedDate(date)
                            setDayListDate(date)
                          }}
                        >
                          +{dayEvents.length - 7}
                        </span>
                      )}
                    </span>
                  </button>
                )
              })}
            </div> : <div className="week-grid">
              {weekDays.map((day) => {
                const date = day.format('YYYY-MM-DD')
                const dayEvents = eventsByDate.get(date) ?? []
                const selected = selectedDate === date
                const today = dayjs().format('YYYY-MM-DD') === date
                return (
                  <button
                    className={`week-day ${selected ? 'selected' : ''} ${dragOverDate === date ? 'drag-over' : ''}`}
                    key={date}
                    data-calendar-date={date}
                    onClick={() => { setSelectedDate(date); setMonth(day.startOf('month')) }}
                    onDoubleClick={() => isAdmin && openAddEvent(date)}
                    onDragOver={(dragEvent) => {
                      dragEvent.preventDefault()
                      setDragOverDate(date)
                    }}
                    onDragLeave={() => setDragOverDate((current) => current === date ? null : current)}
                    onDrop={(dragEvent) => dropEventOnDate(dragEvent, date)}
                  >
                    <span className={`week-date ${today ? 'today' : ''}`}>{day.format('M/D')}</span>
                    <strong>星期{WEEKDAYS[day.day()]}</strong>
                    <span className="week-events">
                      {dayEvents.length === 0 ? <small>沒有工作</small> : dayEvents.map((event) => (
                        <button
                          className={`week-event ${event.allDay ? 'all-day' : 'timed'} ${event.done ? 'done' : ''} ${selectedEventId === event.id ? 'active' : ''}`}
                          style={{ '--event-color': eventCalendarColor(event) } as CSSProperties}
                          key={event.id}
                          draggable={eventDragAllowed(event)}
                          onDragStart={(dragEvent) => startNativeEventDrag(dragEvent, event)}
                          onDragEnd={clearEventDragState}
                          onPointerDown={(pointerEvent) => beginPointerEventDrag(pointerEvent, event)}
                          onPointerMove={movePointerEventDrag}
                          onPointerUp={endPointerEventDrag}
                          onPointerCancel={clearEventDragState}
                          onClick={(clickEvent) => {
                            clickEvent.stopPropagation()
                            if (suppressEventClickRef.current) return
                            openEventDetail(event)
                          }}
                        >
                          <i />
                          <span>{event.allDay ? '整天' : event.startTime}</span>
                          <b>{eventDisplayTitle(event)}</b>
                        </button>
                      ))}
                    </span>
                  </button>
                )
              })}
            </div>}
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
            {searchEvents.slice(0, 12).map(renderEventSummary)}
            {searchEvents.length === 0 && <p className="panel-empty">沒有符合條件的工作</p>}
          </div>
        </aside>
      )}

      {renderNotificationsPanel()}
      {renderStartupNotificationPrompt()}
      {renderNotificationSettingsModal()}
      {renderTitleIconSettingsModal()}
      {renderDayListPanel()}
      {renderEventDetailPanel()}

      {dragActionMenu && (
        <div className="event-drag-menu" style={{ left: dragActionMenu.x, top: dragActionMenu.y } as CSSProperties}>
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
                      {employees.filter((emp) => emp.status !== 'inactive').map((emp) => (
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
          <div className="modal event-editor-modal">
            <div className="event-editor-header">
              <button className="text-btn" onClick={() => setShowEventModal(false)}>取消</button>
              <strong>{editingEventId ? '編輯活動' : '新增活動'}</strong>
              <button className="text-btn save" onClick={saveEvent} disabled={saving}>{saving ? '儲存中' : '儲存'}</button>
              <button className="close-btn" onClick={() => setShowEventModal(false)}>×</button>
            </div>
            <div className="event-editor-body">
              <div className="event-title-row">
                <div className="title-icon-picker">
                  <button type="button" onClick={() => setShowTitleIconPicker((open) => !open)} aria-label="選擇標題圖示">
                    {currentTitleIcon || '＋'}
                  </button>
                  {showTitleIconPicker && (
                    <div className="title-icon-menu">
                      {titleIconOptions.map((item) => (
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
                    title: currentTitleIcon ? composeTitleWithIcon(currentTitleIcon, event.target.value, titleIconOptions) : event.target.value
                  }))}
                  onFocus={() => setShowTitleSuggestions(true)}
                  placeholder="新增標題"
                  autoFocus
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
                  <input
                    type="date"
                    value={eventForm.date}
                    onChange={(event) => {
                      const nextDate = event.target.value
                      setEventForm((form) => ({
                        ...form,
                        date: nextDate,
                        endDate: dayjs(form.endDate).isBefore(dayjs(nextDate), 'day') ? nextDate : form.endDate
                      }))
                    }}
                  />
                  {!eventForm.allDay && (
                    <input type="time" value={eventForm.startTime} onChange={(event) => setEventForm((form) => ({ ...form, startTime: event.target.value }))} />
                  )}
                </div>
                <div className="time-row">
                  <span>結束</span>
                  <input type="date" value={eventForm.endDate} min={eventForm.date} onChange={(event) => setEventForm((form) => ({ ...form, endDate: event.target.value }))} />
                  {!eventForm.allDay && (
                    <input type="time" value={eventForm.endTime} onChange={(event) => setEventForm((form) => ({ ...form, endTime: event.target.value }))} />
                  )}
                </div>
                <div className="event-checkbox-row">
                  <label>
                    <input
                      type="checkbox"
                      checked={!!eventForm.allDay}
                      onChange={(event) => setEventForm((form) => ({ ...form, allDay: event.target.checked }))}
                    />
                    整天
                  </label>
                </div>
              </div>

              <div className="event-editor-list">
                <div className="event-editor-row">
                  <EventRowIcon name="calendar" />
                  <details className="event-picker-row">
                    <summary>
                      <span>{selectedEventCalendarText}</span>
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
                <div className="event-editor-row assignee">
                  <EventRowIcon name="person" />
                  <details className="event-picker-row">
                    <summary>
                      <span>{selectedAssigneeText}</span>
                      {eventForm.assigneeIds.length > 0 && <small>{eventForm.assigneeIds.length} 位同仁</small>}
                    </summary>
                    <div className="event-assignee-grid">
                      {employees.filter((emp) => emp.status !== 'inactive').map((emp) => (
                        <label key={emp.id}>
                          <input
                            type="checkbox"
                            checked={eventForm.assigneeIds.includes(emp.id)}
                            disabled={emp.id === employeeId}
                            onChange={() => setEventForm((form) => ({ ...form, assigneeIds: requiredAssigneeIds(toggle(form.assigneeIds, emp.id)) }))}
                          />
                          <span>{employeeName(emp.id)}</span>
                          <small>{emp.departmentName || departmentName(emp.departmentId || '')}</small>
                        </label>
                      ))}
                    </div>
                  </details>
                </div>
                <div className="event-editor-row">
                  <EventRowIcon name="bell" />
                  <select value={eventForm.reminder} onChange={(event) => changeReminder(event.target.value as CalendarEvent['reminder'])} aria-label="通知">
                    {REMINDER_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </div>
                <div className="event-editor-row">
                  <EventRowIcon name="repeat" />
                  <button
                    type="button"
                    className={`event-static-row event-repeat-button ${eventForm.repeat && eventForm.repeat !== 'none' ? 'selected' : ''}`}
                    onClick={() => setShowRepeatPicker(true)}
                  >
                    {selectedRepeatText}
                  </button>
                </div>
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
                    <label className="attachment-picker">
                      <input type="file" multiple onChange={(event) => setAttachmentFiles(Array.from(event.target.files ?? []))} />
                      上傳檔案
                    </label>
                    {[...eventForm.attachments.map((file) => file.name), ...attachmentFiles.map((file) => file.name)].length > 0 && (
                      <div className="attachment-list">
                        {eventForm.attachments.map((file) => (
                          <span key={file.path || file.url}>
                            <span>{file.name}</span>
                            <button type="button" aria-label={`刪除 ${file.name}`} onClick={() => removeExistingAttachment(file)}>×</button>
                          </span>
                        ))}
                        {attachmentFiles.map((file, index) => (
                          <span key={`${file.name}-${file.size}-${index}`}>
                            <span>{file.name}</span>
                            <button type="button" aria-label={`刪除 ${file.name}`} onClick={() => removePendingAttachment(index)}>×</button>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
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
                <div className="event-editor-row">
                  <EventRowIcon name="check" />
                  <details className="event-picker-row todo-picker">
                    <summary>
                      <span>{todoSummaryText}</span>
                    </summary>
                    <div className="todo-editor-list">
                      {eventForm.todos.map((todo) => (
                        <div className="todo-editor-item" key={todo.id}>
                          <input type="checkbox" checked={todo.done} onChange={(event) => updateTodoItem(todo.id, { done: event.target.checked })} aria-label="待辦完成" />
                          <input value={todo.text} onChange={(event) => updateTodoItem(todo.id, { text: event.target.value })} placeholder="新增待辦" />
                          <button type="button" onClick={() => removeTodoItem(todo.id)} aria-label="刪除待辦">×</button>
                        </div>
                      ))}
                      <button className="todo-add-btn" type="button" onClick={addTodoItem}>新增待辦</button>
                    </div>
                  </details>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {recurrenceEditCandidate && (
        <div className="modal-overlay repeat-overlay" onClick={() => setRecurrenceEditCandidate(null)}>
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
        <div className="modal-overlay repeat-overlay" onClick={() => setRecurrenceDeleteCandidate(null)}>
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
        <div className="modal-overlay repeat-overlay" onClick={() => setShowRepeatPicker(false)}>
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

      {showRepeatCustomModal && (
        <div className="modal-overlay repeat-overlay" onClick={() => setShowRepeatCustomModal(false)}>
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
                  <input
                    type="date"
                    value={eventForm.repeatCustom?.until ?? dayjs(eventForm.date).add(1, 'month').format('YYYY-MM-DD')}
                    disabled={eventForm.repeatCustom?.ends !== 'until'}
                    min={eventForm.date}
                    onChange={(event) => updateCustomRepeat({ until: event.target.value })}
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
