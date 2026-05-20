import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, DragEvent, PointerEvent, ReactNode } from 'react'
import dayjs from 'dayjs'
import { addDoc, arrayUnion, collection, deleteDoc, doc, setDoc, updateDoc } from 'firebase/firestore'
import { signOut } from 'firebase/auth'
import { useQueryClient } from '@tanstack/react-query'
import { auth, db } from '../lib/firebase'
import { useAuth } from '../contexts/AuthContext'
import { useCalendarActivityLogs, useCalendarEvents, useCalendarGroups } from '../hooks/useCalendarData'
import { useDepartments, useEmployees } from '../hooks/useHrData'
import type { CalendarActivityLog, CalendarEvent, CalendarGroup } from '../types'

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']
const COLORS = ['#f6b100', '#1fb6a6', '#3c82f6', '#ef6262', '#8d6df2', '#31a24c', '#f57c35', '#667085']
const DEPARTMENT_CALENDAR_PREFIX = 'department:'
const HR_LEAVE_CALENDAR_NAME = 'HR 請假'
const REMINDER_OPTIONS = [
  { value: 'none', label: '無通知' },
  { value: 'start', label: '活動開始時' },
  { value: '5m', label: '5 分鐘前' },
  { value: '15m', label: '15 分鐘前' },
  { value: '1h', label: '1 小時前' },
  { value: '1d', label: '1 天前' }
] as const
const REPEAT_OPTIONS = [
  { value: 'none', label: '無重複' },
  { value: 'daily', label: '每天' },
  { value: 'weekly', label: '每週' },
  { value: 'monthly', label: '每月' },
  { value: 'yearly', label: '每年' }
] as const
const TITLE_ICON_OPTIONS = [
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
] as const
type ViewMode = 'month' | 'week'
type EventEditorIcon = 'person' | 'department' | 'calendar' | 'bell' | 'repeat' | 'link' | 'location' | 'paperclip' | 'note' | 'check'
type EventAttachment = NonNullable<CalendarEvent['attachments']>[number]
type DisplayCalendar = CalendarGroup & { systemKind?: 'department' | 'hrLeave' }
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

const emptyEvent = {
  calendarId: '',
  calendarIds: [] as string[],
  title: '',
  date: dayjs().format('YYYY-MM-DD'),
  startTime: '09:00',
  endTime: '10:00',
  departmentId: '',
  assigneeIds: [] as string[],
  note: '',
  reminder: 'none' as CalendarEvent['reminder'],
  repeat: 'none' as CalendarEvent['repeat'],
  todos: [] as NonNullable<CalendarEvent['todos']>,
  location: '',
  url: '',
  attachments: [] as NonNullable<CalendarEvent['attachments']>
}

function toggle(list: string[], id: string) {
  return list.includes(id) ? list.filter((item) => item !== id) : [...list, id]
}

function titleWithoutKnownIcon(title: string) {
  const trimmedTitle = title.trimStart()
  const option = TITLE_ICON_OPTIONS.find((item) => trimmedTitle.startsWith(item.icon))
  return option ? trimmedTitle.slice(option.icon.length).trimStart() : title
}

function selectedTitleIcon(title: string) {
  const trimmedTitle = title.trimStart()
  return TITLE_ICON_OPTIONS.find((item) => trimmedTitle.startsWith(item.icon))?.icon ?? ''
}

function composeTitleWithIcon(icon: string, title: string) {
  const cleanTitle = titleWithoutKnownIcon(title).trim()
  return `${icon}${cleanTitle ? ` ${cleanTitle}` : ''}`
}

function googleMapsDirectionUrl(location: string) {
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(location)}`
}

function reminderOffsetMinutes(reminder: CalendarEvent['reminder']) {
  if (reminder === '5m') return 5
  if (reminder === '15m') return 15
  if (reminder === '1h') return 60
  if (reminder === '1d') return 1440
  return 0
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
  const { data: calendars = [], isLoading: calendarsLoading } = useCalendarGroups()
  const { data: events = [], isLoading: eventsLoading } = useCalendarEvents()
  const { data: activityLogs = [] } = useCalendarActivityLogs()
  const { data: employees = [] } = useEmployees()
  const { data: departments = [] } = useDepartments()

  const [month, setMonth] = useState(dayjs().startOf('month'))
  const [selectedDate, setSelectedDate] = useState(dayjs().format('YYYY-MM-DD'))
  const [viewMode, setViewMode] = useState<ViewMode>('month')
  const [activeCalendarIds, setActiveCalendarIds] = useState<string[]>([])
  const [showCalendarDrawer, setShowCalendarDrawer] = useState(false)
  const [showSearchPanel, setShowSearchPanel] = useState(false)
  const [showNotificationsPanel, setShowNotificationsPanel] = useState(false)
  const [showTitleIconPicker, setShowTitleIconPicker] = useState(false)
  const [showTitleSuggestions, setShowTitleSuggestions] = useState(false)
  const [dayListDate, setDayListDate] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [activeSearchDepartmentIds, setActiveSearchDepartmentIds] = useState<string[]>([])
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null)
  const [showCalendarModal, setShowCalendarModal] = useState(false)
  const [showEventModal, setShowEventModal] = useState(false)
  const [editingCalendarId, setEditingCalendarId] = useState<string | null>(null)
  const [editingEventId, setEditingEventId] = useState<string | null>(null)
  const [calendarForm, setCalendarForm] = useState(emptyCalendar)
  const [eventForm, setEventForm] = useState(emptyEvent)
  const [attachmentFiles, setAttachmentFiles] = useState<File[]>([])
  const [deletedAttachments, setDeletedAttachments] = useState<EventAttachment[]>([])
  const [dragActionMenu, setDragActionMenu] = useState<DragActionMenu | null>(null)
  const [dragOverDate, setDragOverDate] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const noteTextareaRef = useRef<HTMLTextAreaElement | null>(null)
  const suppressEventClickRef = useRef(false)
  const pointerDragRef = useRef<{
    eventId: string
    startX: number
    startY: number
    moved: boolean
  } | null>(null)

  const currentEmployee = employees.find((emp) => emp.id === employeeId)
  const currentEmployeeDepartmentName = currentEmployee?.departmentName || departments.find((department) => department.id === currentEmployee?.departmentId)?.name || ''
  const canManageCalendarColors = currentEmployeeDepartmentName === '管理部'

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
  const selectedCalendarIds = activeCalendarIds.length > 0 ? activeVisibleCalendarIds : visibleCalendarIds
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

  const visibleEvents = useMemo(() => {
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

  const searchEvents = useMemo(() => {
    const keyword = searchQuery.trim().toLowerCase()
    return visibleEvents.filter((event) => {
      if (hasCustomSearchDepartmentFilter && event.departmentId && !selectedSearchDepartmentIds.includes(event.departmentId)) return false
      if (hasCustomSearchDepartmentFilter && !event.departmentId) return false
      if (!keyword) return true
      const eventCalendars = eventDisplayCalendarIds(event).map((id) => visibleCalendarMap.get(id)).filter(Boolean) as DisplayCalendar[]
      const searchable = [
        event.title,
        event.note ?? '',
        departmentName(event.departmentId),
        ...eventCalendars.map((calendar) => calendar.name),
        ...(event.assigneeIds ?? []).map(employeeName)
      ].join(' ').toLowerCase()
      return searchable.includes(keyword)
    })
  }, [employees, hasCustomSearchDepartmentFilter, searchQuery, selectedSearchDepartmentIds, visibleCalendarMap, visibleEvents, departments, hrLeaveCalendar])

  const eventsByDate = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>()
    visibleEvents.forEach((event) => {
      const list = map.get(event.date) ?? []
      list.push(event)
      map.set(event.date, list)
    })
    return map
  }, [visibleEvents])

  const visibleActivityLogs = useMemo(() => (
    activityLogs.filter((log) => selectedCalendarIds.includes(log.calendarId))
  ), [activityLogs, selectedCalendarIds])

  useEffect(() => {
    if (!('Notification' in window) || Notification.permission !== 'granted') return
    const timers = visibleEvents.flatMap((event) => {
      if (!event.reminder || event.reminder === 'none') return []
      const eventTime = dayjs(`${event.date} ${event.startTime}`)
      const notifyTime = eventTime.subtract(reminderOffsetMinutes(event.reminder), 'minute')
      const delay = notifyTime.diff(dayjs())
      if (delay <= 0 || delay > 2147483647) return []
      const timer = window.setTimeout(() => {
        new Notification(event.title, {
          body: `${event.date} ${event.startTime}${event.location ? ` · ${event.location}` : ''}`
        })
      }, delay)
      return [timer]
    })
    return () => timers.forEach((timer) => window.clearTimeout(timer))
  }, [visibleEvents])

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
    if (!showSearchPanel && !showNotificationsPanel) return

    function closeTopbarPanels(event: MouseEvent | TouchEvent) {
      const target = event.target
      if (target instanceof Element && target.closest('.tt-search-panel, .tt-notifications-panel, .topbar-panel-trigger')) return
      setShowSearchPanel(false)
      setShowNotificationsPanel(false)
    }

    function closeTopbarPanelsWithEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
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
  const selectedCalendarNames = selectedCalendarIds
    .map((id) => visibleCalendarMap.get(id)?.name)
    .filter(Boolean)
    .join('、') || '未選擇行事曆'

  function calendarColor(calendarId: string) {
    return visibleCalendarMap.get(calendarId)?.color ?? '#667085'
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
    return employees.find((employee) => employee.id === id)?.name || '未指定'
  }

  function currentActorName() {
    return displayName || user?.displayName || user?.email || '未命名使用者'
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
    if (field === 'repeat') return REPEAT_OPTIONS.find((option) => option.value === value)?.label ?? '無重複'
    if (field === 'todos') return Array.isArray(value) ? `${value.length} 項` : '0 項'
    if (field === 'attachments') return Array.isArray(value) ? `${value.length} 個附件` : '0 個附件'
    return String(value ?? '').trim() || '空白'
  }

  function eventChangeList(beforeEvent: CalendarEvent, afterEvent: Partial<CalendarEvent>) {
    const fields = [
      ['title', '標題'],
      ['date', '日期'],
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
  const currentTitleIcon = selectedTitleIcon(eventForm.title)
  const currentTitleText = titleWithoutKnownIcon(eventForm.title)
  const titleSuggestions = useMemo(() => {
    const query = currentTitleText.trim().toLowerCase()
    if (query.length < 1) return []
    return events
      .filter((event) => event.id !== editingEventId)
      .filter((event) => dayjs(event.date).isBefore(dayjs().add(1, 'day'), 'day'))
      .filter((event) => titleWithoutKnownIcon(event.title).toLowerCase().includes(query))
      .filter((event) => event.location?.trim() || event.url?.trim() || event.note?.trim() || event.todos?.length)
      .sort((a, b) => `${b.date} ${b.startTime}`.localeCompare(`${a.date} ${a.startTime}`))
      .slice(0, 6)
  }, [currentTitleText, editingEventId, events])
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
    setActiveCalendarIds((list) => toggle(list.length ? list.filter((id) => visibleCalendarIds.includes(id)) : visibleCalendarIds, calendarId))
  }

  function selectAllCalendars() {
    setActiveCalendarIds((ids) => {
      const activeIds = ids.filter((id) => visibleCalendarIds.includes(id))
      return activeIds.length === visibleCalendarIds.length ? ['__none__'] : []
    })
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

  function openAddEvent(date = selectedDate) {
    const defaultCalendar = writableCalendars.find((calendar) => (
      Boolean(currentEmployee?.departmentId && calendar.departmentIds.includes(currentEmployee.departmentId)) ||
      Boolean(currentEmployee?.departmentName && calendar.name === currentEmployee.departmentName)
    )) ?? writableCalendars[0]
    const defaultDepartmentId = defaultCalendar?.departmentIds[0] ?? currentEmployee?.departmentId ?? departments.find((department) => department.name === currentEmployee?.departmentName)?.id ?? ''
    setEventForm({
      ...emptyEvent,
      date,
      calendarId: defaultCalendar?.id ?? '',
      calendarIds: defaultCalendar?.id ? [defaultCalendar.id] : [],
      departmentId: defaultDepartmentId,
      assigneeIds: requiredAssigneeIds([])
    })
    setAttachmentFiles([])
    setDeletedAttachments([])
    setEditingEventId(null)
    setShowTitleIconPicker(false)
    setShowTitleSuggestions(false)
    setShowEventModal(true)
  }

  function openEventDetail(event: CalendarEvent) {
    setDragActionMenu(null)
    setDayListDate(null)
    setSelectedDate(event.date)
    setSelectedEventId(event.id)
    setShowNotificationsPanel(false)
    setShowSearchPanel(false)
  }

  function openEditEvent(event: CalendarEvent) {
    if (isHrReadonlyEvent(event)) {
      alert('此活動來自 HR 後台，請至 HR 後台編輯')
      return
    }

    setEventForm({
      calendarId: eventDisplayCalendarId(event),
      calendarIds: eventDisplayCalendarIds(event),
      title: event.title,
      date: event.date,
      startTime: event.startTime,
      endTime: event.endTime,
      departmentId: event.departmentId,
      assigneeIds: requiredAssigneeIds(event.assigneeIds ?? []),
      note: event.note ?? '',
      reminder: event.reminder ?? 'none',
      repeat: event.repeat ?? 'none',
      todos: event.todos ?? [],
      location: event.location ?? '',
      url: event.url ?? '',
      attachments: event.attachments ?? []
    })
    setAttachmentFiles([])
    setDeletedAttachments([])
    setEditingEventId(event.id)
    setShowTitleIconPicker(false)
    setShowTitleSuggestions(false)
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
        await Notification.requestPermission()
      } catch {
        alert('通知權限啟用失敗，請確認瀏覽器設定')
      }
    }
  }

  function chooseTitleIcon(icon: string) {
    setEventForm((form) => ({
      ...form,
      title: composeTitleWithIcon(icon, form.title)
    }))
    setShowTitleIconPicker(false)
  }

  function applyTitleSuggestion(event: CalendarEvent) {
    setEventForm((form) => ({
      ...form,
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
      const eventTitle = currentTitleIcon ? composeTitleWithIcon(currentTitleIcon, eventForm.title) : eventForm.title.trim()
      const payload = {
        calendarId: primaryCalendarId,
        calendarIds: selectedCalendarIds,
        title: eventTitle,
        date: eventForm.date,
        startTime: eventForm.startTime,
        endTime: eventForm.endTime,
        departmentId: selectedDepartmentId,
        assigneeIds: requiredAssignees,
        note: eventForm.note.trim(),
        reminder: eventForm.reminder ?? 'none',
        repeat: eventForm.repeat ?? 'none',
        todos: eventForm.todos.map((todo) => ({ ...todo, text: todo.text.trim() })).filter((todo) => todo.text),
        location: eventForm.location.trim(),
        url: eventForm.url.trim(),
        attachments: eventForm.attachments,
        updatedAt: new Date().toISOString()
      }

      let savedEventId = editingEventId
      if (editingEventId) {
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
              date: payload.date,
              changes
            })
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
          date: payload.date
        })
      }

      setShowEventModal(false)
      setAttachmentFiles([])
      setDeletedAttachments([])
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
    if (!confirm('確定刪除此工作？')) return
    try {
      await deleteDoc(doc(db, 'calendarEvents', event.id))
      await writeActivityLog({
        action: 'delete',
        eventId: event.id,
        eventTitle: event.title,
        calendarId: eventDisplayCalendarId(event),
        departmentId: event.departmentId,
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
      if (action === 'move') {
        await updateDoc(doc(db, 'calendarEvents', sourceEvent.id), {
          date: dragActionMenu.targetDate,
          updatedAt: new Date().toISOString()
        })
        await writeActivityLog({
          action: 'move',
          eventId: sourceEvent.id,
          eventTitle: sourceEvent.title,
          calendarId: eventDisplayCalendarId(sourceEvent),
          departmentId: sourceEvent.departmentId,
          date: dragActionMenu.targetDate,
          changes: [{
            field: 'date',
            label: '日期',
            before: sourceEvent.date,
            after: dragActionMenu.targetDate
          }]
        })
        setSelectedEventId(sourceEvent.id)
      } else {
        const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...eventPayload } = sourceEvent
        const created = await addDoc(collection(db, 'calendarEvents'), {
          ...eventPayload,
          date: dragActionMenu.targetDate,
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
          eventTitle: sourceEvent.title,
          calendarId: eventDisplayCalendarId(sourceEvent),
          departmentId: sourceEvent.departmentId,
          date: dragActionMenu.targetDate,
          changes: [{
            field: 'date',
            label: '日期',
            before: sourceEvent.date,
            after: dragActionMenu.targetDate
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
    return (
      <button className={`panel-event ${event.done ? 'done' : ''}`} key={event.id} style={{ '--event-color': eventCalendarColor(event) } as CSSProperties} onClick={() => openEventDetail(event)}>
        <span />
        <div>
          <strong>{event.title}</strong>
          <small>{event.date} {event.startTime} - {event.endTime} · {eventCalendarName(event)}</small>
        </div>
      </button>
    )
  }

  function renderEventDetailPanel() {
    if (!selectedEvent) return null
    const calendar = visibleCalendarMap.get(eventDisplayCalendarId(selectedEvent))
    const assignees = selectedEvent.assigneeIds.map(employeeName)
    const reminderLabel = REMINDER_OPTIONS.find((option) => option.value === (selectedEvent.reminder ?? 'none'))?.label ?? '無通知'
    const repeatLabel = REPEAT_OPTIONS.find((option) => option.value === (selectedEvent.repeat ?? 'none'))?.label ?? '無重複'
    const locationText = selectedEvent.location?.trim()
    const canManageEvent = isAdmin && !isHrReadonlyEvent(selectedEvent)
    return (
      <aside className="event-detail-panel">
        <div className="event-detail-header">
          <strong>活動詳情</strong>
          <div>
            {canManageEvent && <button onClick={() => openEditEvent(selectedEvent)} aria-label="編輯活動">⋮</button>}
            <button onClick={() => setSelectedEventId(null)} aria-label="關閉活動詳情">×</button>
          </div>
        </div>

        <div className="event-detail-body">
          <div className="event-detail-avatar" style={{ background: eventCalendarColor(selectedEvent) }}>
            {(calendar?.name || selectedEvent.title).slice(0, 1)}
          </div>
          <h2>{selectedEvent.title}</h2>
          <div className="event-detail-time">
            <div>
              <span>{dayjs(selectedEvent.date).format('YYYY/M/D (ddd)')}</span>
              <strong>{selectedEvent.startTime}</strong>
            </div>
            <b>›</b>
            <div>
              <span>{dayjs(selectedEvent.date).format('YYYY/M/D (ddd)')}</span>
              <strong>{selectedEvent.endTime}</strong>
            </div>
          </div>

          <div className="event-detail-row">
            <span>⏰</span>
            <div>{reminderLabel}</div>
          </div>
          <div className="event-detail-row">
            <span>↻</span>
            <div>{repeatLabel}</div>
          </div>
          <div className="event-detail-row">
            <span>▣</span>
            <div>{calendar?.name || '未分類行事曆'}</div>
          </div>
          <div className="event-detail-row">
            <span>⌖</span>
            {locationText ? (
              <a href={googleMapsDirectionUrl(locationText)} target="_blank" rel="noreferrer">{locationText}</a>
            ) : (
              <div>{departmentName(selectedEvent.departmentId)}</div>
            )}
          </div>
          <a
            className={`event-detail-map ${locationText ? 'clickable' : ''}`}
            href={locationText ? googleMapsDirectionUrl(locationText) : undefined}
            target="_blank"
            rel="noreferrer"
            aria-disabled={!locationText}
          >
            <div>
              <strong>{locationText || departmentName(selectedEvent.departmentId)}</strong>
              <small>{locationText ? '開啟 Google 地圖導航' : '尚未填寫地點'}</small>
            </div>
          </a>

          {selectedEvent.url && (
            <a className="event-detail-link" href={selectedEvent.url} target="_blank" rel="noreferrer">
              <span>🔗</span>
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
              <span>♙</span>
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
    if (log.action === 'create') return `${log.actorName} 新增了「${log.eventTitle}」`
    if (log.action === 'delete') return `${log.actorName} 刪除了「${log.eventTitle}」`
    if (log.action === 'move') return `${log.actorName} 將「${log.eventTitle}」移到 ${log.changes?.[0]?.after || log.date}`
    if (log.action === 'copy') return `${log.actorName} 複製了「${log.eventTitle}」到 ${log.changes?.[0]?.after || log.date}`
    const firstChange = log.changes?.[0]
    if (firstChange) {
      const rest = (log.changes?.length ?? 0) > 1 ? `，另有 ${(log.changes?.length ?? 1) - 1} 項變更` : ''
      return `${log.actorName} 將「${log.eventTitle}」的${firstChange.label}從「${firstChange.before}」改成「${firstChange.after}」${rest}`
    }
    return `${log.actorName} 更新了「${log.eventTitle}」`
  }

  function renderNotificationsPanel() {
    if (!showNotificationsPanel) return null
    return (
      <aside className="tt-floating-panel tt-notifications-panel">
        <div className="panel-head">
          <h2>通知</h2>
          <button onClick={() => setShowNotificationsPanel(false)} aria-label="關閉通知">×</button>
        </div>
        <div className="panel-list">
          {visibleActivityLogs.slice(0, 12).map((log) => (
            <article className={`activity-log ${log.action}`} key={log.id}>
              <span />
              <div>
                <strong>{activityLogText(log)}</strong>
                <small>{dayjs(log.createdAt).format('M/D HH:mm')} · {visibleCalendarMap.get(log.calendarId)?.name || departmentName(log.departmentId)}</small>
              </div>
            </article>
          ))}
          {visibleActivityLogs.length === 0 && <p className="panel-empty">目前沒有新的活動紀錄</p>}
        </div>
      </aside>
    )
  }

  return (
    <div className="timetree-page">
      <header className="timetree-topbar">
        <div className="topbar-left">
          <button className="tt-icon-button" aria-label="開啟選單" onClick={() => setShowCalendarDrawer((open) => !open)}>☰</button>
          <div className="tt-logo">
            <span className="tt-logo-mark">✣</span>
            <span>TimeTree</span>
          </div>
          <button className="tt-today" onClick={goToday}>今天</button>
          <div className="tt-stepper">
            <button onClick={() => movePeriod(-1)}>‹</button>
            <button onClick={() => movePeriod(1)}>›</button>
          </div>
          <h1>{currentTitle}</h1>
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
              setShowNotificationsPanel(false)
            }}
          >
            <TopbarIcon name="search" />
          </button>
          <button
            className={`tt-icon-button topbar-panel-trigger ${showNotificationsPanel ? 'active' : ''}`}
            aria-label="通知"
            onClick={() => {
              setShowNotificationsPanel((open) => !open)
              setShowSearchPanel(false)
            }}
          >
            <TopbarIcon name="bell" />
          </button>
          {isAdmin && <button className="tt-icon-button add" onClick={() => openAddEvent(selectedDate)} aria-label="新增工作">＋</button>}
          <button className="tt-avatar" onClick={() => signOut(auth)} title="登出">
            {user?.photoURL ? <img src={user.photoURL} alt={displayName || user.email || '使用者'} referrerPolicy="no-referrer" /> : (displayName || user?.email || 'U').slice(0, 1)}
          </button>
        </div>
      </header>

      <div className="timetree-body">
        <aside className={`tt-left-rail ${showCalendarDrawer ? 'drawer-open' : ''}`}>
          <button className={`rail-button ${allCalendarsSelected ? 'active' : ''}`} aria-label="全選所有行事曆" title="全選所有行事曆" onClick={selectAllCalendars}>✓</button>
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
                  {calendar.name.slice(0, 1)}
                </button>
              )
            })}
          </div>
        </aside>

        {showCalendarDrawer && (
          <aside className="tt-calendar-drawer">
            <div className="panel-head">
              <h2>行事曆篩選</h2>
              <button onClick={() => setShowCalendarDrawer(false)} aria-label="關閉篩選">×</button>
            </div>
            <div className="drawer-section">
              <div className="panel-title-row">
                <span className="field-label">行事曆</span>
              </div>
              <div className="drawer-calendar-list">
                {visibleCalendars.map((calendar) => {
                  const active = selectedCalendarIds.includes(calendar.id)
                  return (
                    <div
                      key={calendar.id}
                      className={`drawer-calendar-item ${active ? 'active' : ''}`}
                      style={{ '--calendar-color': calendar.color } as CSSProperties}
                    >
                      <button className="drawer-calendar-main" onClick={() => toggleCalendar(calendar.id)}>
                        <span />
                        <strong>{calendar.name}</strong>
                        <small>{calendar.systemKind === 'hrLeave' ? 'HR' : '部門'}</small>
                      </button>
                      {calendar.systemKind === 'department' && canManageCalendarColors && (
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
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
            <div className="drawer-actions">
              <button className="small-btn" onClick={selectAllCalendars}>全選</button>
            </div>
          </aside>
        )}

        <section className="tt-calendar-surface">
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
                          className={`event-pill ${selectedEventId === event.id ? 'active' : ''}`}
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
                          <span>{event.title}</span>
                          <small>{event.startTime}</small>
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
                          className={`week-event ${event.done ? 'done' : ''} ${selectedEventId === event.id ? 'active' : ''}`}
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
                          <span>{event.startTime}</span>
                          <b>{event.title}</b>
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
          <input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="搜尋標題、備註、部門、成員" autoFocus />
          <div className="search-department-filter" aria-label="部門篩選">
            <div>
              <span>部門</span>
              <button className={allSearchDepartmentsSelected ? 'active' : ''} type="button" onClick={selectAllSearchDepartments}>全選</button>
            </div>
            <div>
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
          </div>
          <p className="panel-hint">{searchQuery.trim() ? `找到 ${searchEvents.length} 筆` : `目前顯示 ${searchEvents.length} 筆，範圍：${selectedCalendarNames}`}</p>
          <div className="panel-list">
            {searchEvents.slice(0, 12).map(renderEventSummary)}
            {searchEvents.length === 0 && <p className="panel-empty">沒有符合條件的工作</p>}
          </div>
        </aside>
      )}

      {renderNotificationsPanel()}
      {renderDayListPanel()}
      {renderEventDetailPanel()}

      {dragActionMenu && (
        <div className="event-drag-menu" style={{ left: dragActionMenu.x, top: dragActionMenu.y } as CSSProperties}>
          <button onClick={() => applyDragEventAction('move')} disabled={saving}>移動</button>
          <button onClick={() => applyDragEventAction('copy')} disabled={saving}>複製</button>
        </div>
      )}

      {isAdmin && (
        <nav className="mobile-action-bar">
          <button onClick={() => openAddEvent(selectedDate)}>新增工作</button>
        </nav>
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
                          {emp.name}
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
                      {TITLE_ICON_OPTIONS.map((item) => (
                        <button type="button" key={item.label} onClick={() => chooseTitleIcon(item.icon)}>
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
                    title: currentTitleIcon ? composeTitleWithIcon(currentTitleIcon, event.target.value) : event.target.value
                  }))}
                  onFocus={() => setShowTitleSuggestions(true)}
                  placeholder="新增標題"
                  autoFocus
                />
                {showTitleSuggestions && titleSuggestions.length > 0 && (
                  <div className="title-suggestion-menu">
                    {titleSuggestions.map((suggestion) => (
                      <button type="button" key={suggestion.id} onClick={() => applyTitleSuggestion(suggestion)}>
                        <strong>{suggestion.title}</strong>
                        <small>
                          {suggestion.date}
                          {suggestion.location ? ` · ${suggestion.location}` : ''}
                          {suggestion.url ? ' · 網址' : ''}
                          {suggestion.note ? ' · 備註' : ''}
                          {suggestion.todos?.length ? ` · ${suggestion.todos.length} 項待辦` : ''}
                        </small>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="event-time-editor">
                <div className="time-row">
                  <span>開始</span>
                  <input type="date" value={eventForm.date} onChange={(event) => setEventForm((form) => ({ ...form, date: event.target.value }))} />
                  <input type="time" value={eventForm.startTime} onChange={(event) => setEventForm((form) => ({ ...form, startTime: event.target.value }))} />
                </div>
                <div className="time-row">
                  <span>結束</span>
                  <input type="date" value={eventForm.date} onChange={(event) => setEventForm((form) => ({ ...form, date: event.target.value }))} />
                  <input type="time" value={eventForm.endTime} onChange={(event) => setEventForm((form) => ({ ...form, endTime: event.target.value }))} />
                </div>
                <div className="event-checkbox-row">
                  <label><input type="checkbox" /> 全天</label>
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
                          <span>{emp.name}</span>
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
                  <select value={eventForm.repeat} onChange={(event) => setEventForm((form) => ({ ...form, repeat: event.target.value as CalendarEvent['repeat'] }))} aria-label="重複">
                    {REPEAT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
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
    </div>
  )
}
