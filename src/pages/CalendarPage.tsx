import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, DragEvent, PointerEvent, ReactNode } from 'react'
import dayjs from 'dayjs'
import { addDoc, arrayUnion, collection, deleteDoc, doc, setDoc, updateDoc } from 'firebase/firestore'
import { signOut } from 'firebase/auth'
import { useQueryClient } from '@tanstack/react-query'
import { auth, db } from '../lib/firebase'
import { useAuth } from '../contexts/AuthContext'
import { useCalendarEvents, useCalendarGroups } from '../hooks/useCalendarData'
import { useDepartments, useEmployees } from '../hooks/useHrData'
import type { CalendarEvent, CalendarGroup } from '../types'

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

export default function CalendarPage() {
  const queryClient = useQueryClient()
  const { user, role, employeeId, displayName } = useAuth()
  const isAdmin = role === 'admin'
  const { data: calendars = [], isLoading: calendarsLoading } = useCalendarGroups()
  const { data: events = [], isLoading: eventsLoading } = useCalendarEvents()
  const { data: employees = [] } = useEmployees()
  const { data: departments = [] } = useDepartments()

  const [month, setMonth] = useState(dayjs().startOf('month'))
  const [selectedDate, setSelectedDate] = useState(dayjs().format('YYYY-MM-DD'))
  const [viewMode, setViewMode] = useState<ViewMode>('month')
  const [activeCalendarIds, setActiveCalendarIds] = useState<string[]>([])
  const [showCalendarDrawer, setShowCalendarDrawer] = useState(false)
  const [showSearchPanel, setShowSearchPanel] = useState(false)
  const [showNotificationsPanel, setShowNotificationsPanel] = useState(false)
  const [dayListDate, setDayListDate] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
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
  const selectedCalendarIds = activeVisibleCalendarIds.length > 0 ? activeVisibleCalendarIds : visibleCalendarIds
  const allCalendarsSelected = selectedCalendarIds.length === visibleCalendarIds.length
  const visibleCalendarMap = useMemo(() => new Map(visibleCalendars.map((calendar) => [calendar.id, calendar])), [visibleCalendars])
  const writableCalendars = visibleCalendars.filter((calendar) => calendar.systemKind !== 'hrLeave')

  const visibleEvents = useMemo(() => {
    const keyword = searchQuery.trim().toLowerCase()
    return events.filter((event) => {
      const calendar = visibleCalendarMap.get(eventDisplayCalendarId(event))
      if (!calendar || !selectedCalendarIds.includes(calendar.id)) return false
      if (keyword) {
        const searchable = [
          event.title,
          event.note ?? '',
          departmentName(event.departmentId),
          calendar.name,
          ...(event.assigneeIds ?? []).map(employeeName)
        ].join(' ').toLowerCase()
        if (!searchable.includes(keyword)) return false
      }
      if (isAdmin) return true
      if (employeeId && event.assigneeIds?.includes(employeeId)) return true
      if (!event.assigneeIds?.length) return true
      return false
    })
  }, [employeeId, events, isAdmin, searchQuery, selectedCalendarIds, visibleCalendarMap, departments, employees, hrLeaveCalendar])

  const eventsByDate = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>()
    visibleEvents.forEach((event) => {
      const list = map.get(event.date) ?? []
      list.push(event)
      map.set(event.date, list)
    })
    return map
  }, [visibleEvents])

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
    if (event.calendarId.startsWith(DEPARTMENT_CALENDAR_PREFIX)) return event.calendarId
    if (event.departmentId) return departmentCalendarId(event.departmentId)
    return event.calendarId
  }

  function eventCalendarColor(event: CalendarEvent) {
    return calendarColor(eventDisplayCalendarId(event))
  }

  function eventCalendarName(event: CalendarEvent) {
    return visibleCalendarMap.get(eventDisplayCalendarId(event))?.name ?? '未分類行事曆'
  }

  function departmentName(id: string) {
    return departments.find((department) => department.id === id)?.name || '未分配'
  }

  function employeeName(id: string) {
    return employees.find((employee) => employee.id === id)?.name || '未指定'
  }

  function getDepartmentEmployeeIds(departmentId: string) {
    const department = departments.find((item) => item.id === departmentId)
    return employees
      .filter((employee) => employee.status !== 'inactive')
      .filter((employee) => employee.departmentId === departmentId || Boolean(department?.name && employee.departmentName === department.name))
      .map((employee) => employee.id)
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
    setActiveCalendarIds([])
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
      currentEmployee?.departmentId && calendar.departmentIds.includes(currentEmployee.departmentId)
    )) ?? writableCalendars[0]
    const defaultDepartmentId = defaultCalendar?.departmentIds[0] ?? currentEmployee?.departmentId ?? ''
    setEventForm({
      ...emptyEvent,
      date,
      calendarId: defaultCalendar?.id ?? '',
      departmentId: defaultDepartmentId
    })
    setAttachmentFiles([])
    setDeletedAttachments([])
    setEditingEventId(null)
    setShowEventModal(true)
  }

  function openEventDetail(event: CalendarEvent) {
    setDragActionMenu(null)
    setDayListDate(null)
    setSelectedDate(event.date)
    setMonth(dayjs(event.date).startOf('month'))
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
      title: event.title,
      date: event.date,
      startTime: event.startTime,
      endTime: event.endTime,
      departmentId: event.departmentId,
      assigneeIds: event.assigneeIds ?? [],
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
    setShowEventModal(true)
  }

  async function refreshCalendarData() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['calendarCalendars'] }),
      queryClient.invalidateQueries({ queryKey: ['calendarEvents'] })
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
    if (!eventForm.calendarId || !eventForm.title.trim() || !eventForm.date) {
      alert('請填寫行事曆、標題與日期')
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
      const selectedDepartmentId = departmentIdFromCalendarId(eventForm.calendarId) || eventForm.departmentId
      const payload = {
        calendarId: eventForm.calendarId,
        title: eventForm.title.trim(),
        date: eventForm.date,
        startTime: eventForm.startTime,
        endTime: eventForm.endTime,
        departmentId: selectedDepartmentId,
        assigneeIds: eventForm.assigneeIds,
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
      } else {
        const created = await addDoc(collection(db, 'calendarEvents'), {
          ...payload,
          done: false,
          createdBy: user?.uid ?? '',
          createdAt: new Date().toISOString()
        })
        savedEventId = created.id
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
      setSelectedEventId((current) => current === event.id ? null : current)
      await queryClient.invalidateQueries({ queryKey: ['calendarEvents'] })
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
    if (events.some((event) => event.calendarId === id)) {
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

  function renderNotificationsPanel() {
    if (!showNotificationsPanel) return null
    return (
      <aside className="tt-floating-panel tt-notifications-panel">
        <div className="panel-head">
          <h2>通知</h2>
          <button onClick={() => setShowNotificationsPanel(false)} aria-label="關閉通知">×</button>
        </div>
        <div className="panel-list">
          {visibleEvents.slice(0, 8).map(renderEventSummary)}
          {visibleEvents.length === 0 && <p className="panel-empty">目前沒有符合條件的通知</p>}
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
          <button className={`tt-icon-button ${showSearchPanel ? 'active' : ''}`} aria-label="搜尋" onClick={() => setShowSearchPanel((open) => !open)}>⌕</button>
          <button className={`tt-icon-button ${showNotificationsPanel ? 'active' : ''}`} aria-label="通知" onClick={() => setShowNotificationsPanel((open) => !open)}>⌒</button>
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
          <p className="panel-hint">{searchQuery.trim() ? `找到 ${visibleEvents.length} 筆` : `目前顯示 ${visibleEvents.length} 筆，範圍：${selectedCalendarNames}`}</p>
          <div className="panel-list">
            {visibleEvents.slice(0, 12).map(renderEventSummary)}
            {visibleEvents.length === 0 && <p className="panel-empty">沒有符合條件的工作</p>}
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
              <input
                className="event-title-input"
                value={eventForm.title}
                onChange={(event) => setEventForm((form) => ({ ...form, title: event.target.value }))}
                placeholder="新增標題"
                autoFocus
              />

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
                          <input type="checkbox" checked={eventForm.assigneeIds.includes(emp.id)} onChange={() => setEventForm((form) => ({ ...form, assigneeIds: toggle(form.assigneeIds, emp.id) }))} />
                          <span>{emp.name}</span>
                          <small>{emp.departmentName || departmentName(emp.departmentId || '')}</small>
                        </label>
                      ))}
                    </div>
                  </details>
                </div>
                <div className="event-editor-row">
                  <EventRowIcon name="department" />
                  <select
                    value={eventForm.departmentId}
                    onChange={(event) => {
                      const nextDepartmentId = event.target.value
                      setEventForm((form) => ({
                        ...form,
                        departmentId: nextDepartmentId,
                        calendarId: nextDepartmentId ? departmentCalendarId(nextDepartmentId) : ''
                      }))
                    }}
                  >
                    <option value="">不指定部門</option>
                    {departments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}
                  </select>
                </div>
                <div className="event-editor-row">
                  <EventRowIcon name="calendar" />
                  <select
                    value={eventForm.calendarId}
                    onChange={(event) => {
                      const nextCalendarId = event.target.value
                      setEventForm((form) => ({
                        ...form,
                        calendarId: nextCalendarId,
                        departmentId: departmentIdFromCalendarId(nextCalendarId) || form.departmentId
                      }))
                    }}
                  >
                    <option value="">選擇行事曆</option>
                    {writableCalendars.map((calendar) => <option key={calendar.id} value={calendar.id}>{calendar.name}</option>)}
                  </select>
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
