import { useEffect, useMemo, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import dayjs from 'dayjs'
import { addDoc, collection, deleteDoc, doc, updateDoc } from 'firebase/firestore'
import { getDownloadURL, ref, uploadBytes } from 'firebase/storage'
import { signOut } from 'firebase/auth'
import { useQueryClient } from '@tanstack/react-query'
import { auth, db, storage } from '../lib/firebase'
import { useAuth } from '../contexts/AuthContext'
import { useCalendarEvents, useCalendarGroups } from '../hooks/useCalendarData'
import { useDepartments, useEmployees } from '../hooks/useHrData'
import type { CalendarEvent, CalendarGroup } from '../types'

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']
const COLORS = ['#f6b100', '#1fb6a6', '#3c82f6', '#ef6262', '#8d6df2', '#31a24c', '#f57c35', '#667085']
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
const TOOL_PANELS = [
  { id: 'comments', label: '留言', icon: '▤' },
  { id: 'photos', label: '照片', icon: '▧' },
  { id: 'members', label: '成員', icon: '♙' },
  { id: 'notifications', label: '通知', icon: '⌒' },
  { id: 'settings', label: '設定', icon: '☷' }
] as const

type ViewMode = 'month' | 'week'
type ToolPanelId = typeof TOOL_PANELS[number]['id']
type EventEditorIcon = 'person' | 'department' | 'calendar' | 'bell' | 'repeat' | 'link' | 'location' | 'paperclip' | 'note' | 'check'

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
  const [departmentFilter, setDepartmentFilter] = useState('')
  const [activeCalendarIds, setActiveCalendarIds] = useState<string[]>([])
  const [showCalendarDrawer, setShowCalendarDrawer] = useState(false)
  const [showSearchPanel, setShowSearchPanel] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [activeToolPanel, setActiveToolPanel] = useState<ToolPanelId | null>(null)
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null)
  const [showCalendarModal, setShowCalendarModal] = useState(false)
  const [showEventModal, setShowEventModal] = useState(false)
  const [editingCalendarId, setEditingCalendarId] = useState<string | null>(null)
  const [editingEventId, setEditingEventId] = useState<string | null>(null)
  const [calendarForm, setCalendarForm] = useState(emptyCalendar)
  const [eventForm, setEventForm] = useState(emptyEvent)
  const [attachmentFiles, setAttachmentFiles] = useState<File[]>([])
  const [saving, setSaving] = useState(false)

  const currentEmployee = employees.find((emp) => emp.id === employeeId)

  const visibleCalendars = useMemo(() => {
    if (isAdmin) return calendars
    return calendars.filter((calendar) => {
      if (calendar.isCompanyWide) return true
      if (employeeId && calendar.employeeIds?.includes(employeeId)) return true
      if (currentEmployee?.departmentId && calendar.departmentIds?.includes(currentEmployee.departmentId)) return true
      return Boolean(currentEmployee?.departmentName && calendar.departmentIds?.includes(currentEmployee.departmentName))
    })
  }, [calendars, currentEmployee?.departmentId, currentEmployee?.departmentName, employeeId, isAdmin])

  const selectedCalendarIds = activeCalendarIds.length > 0 ? activeCalendarIds : visibleCalendars.map((calendar) => calendar.id)
  const visibleCalendarMap = useMemo(() => new Map(visibleCalendars.map((calendar) => [calendar.id, calendar])), [visibleCalendars])

  const visibleEvents = useMemo(() => {
    const keyword = searchQuery.trim().toLowerCase()
    return events.filter((event) => {
      const calendar = visibleCalendarMap.get(event.calendarId)
      if (!calendar || !selectedCalendarIds.includes(event.calendarId)) return false
      if (departmentFilter && event.departmentId !== departmentFilter) return false
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
  }, [departmentFilter, employeeId, events, isAdmin, searchQuery, selectedCalendarIds, visibleCalendarMap, departments, employees])

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

  function departmentName(id: string) {
    return departments.find((department) => department.id === id)?.name || '未分配'
  }

  function employeeName(id: string) {
    return employees.find((employee) => employee.id === id)?.name || '未指定'
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
    setCalendarForm({
      name: calendar.name,
      color: calendar.color,
      departmentIds: calendar.departmentIds ?? [],
      employeeIds: calendar.employeeIds ?? [],
      isCompanyWide: !!calendar.isCompanyWide
    })
    setEditingCalendarId(calendar.id)
    setShowCalendarModal(true)
  }

  function toggleCalendar(calendarId: string) {
    setActiveCalendarIds((list) => toggle(list.length ? list : visibleCalendars.map((item) => item.id), calendarId))
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
    setEventForm({
      ...emptyEvent,
      date,
      calendarId: visibleCalendars[0]?.id ?? '',
      departmentId: departmentFilter || currentEmployee?.departmentId || ''
    })
    setAttachmentFiles([])
    setEditingEventId(null)
    setShowEventModal(true)
  }

  function openEventDetail(event: CalendarEvent) {
    setSelectedDate(event.date)
    setMonth(dayjs(event.date).startOf('month'))
    setSelectedEventId(event.id)
    setActiveToolPanel(null)
    setShowSearchPanel(false)
  }

  function openEditEvent(event: CalendarEvent) {
    setEventForm({
      calendarId: event.calendarId,
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

  async function saveEvent() {
    if (!eventForm.calendarId || !eventForm.title.trim() || !eventForm.date) {
      alert('請填寫行事曆、標題與日期')
      return
    }

    setSaving(true)
    try {
      const uploadedAttachments = attachmentFiles.length > 0
        ? await uploadEventAttachments(editingEventId ?? crypto.randomUUID(), attachmentFiles)
        : []
      const payload = {
        calendarId: eventForm.calendarId,
        title: eventForm.title.trim(),
        date: eventForm.date,
        startTime: eventForm.startTime,
        endTime: eventForm.endTime,
        departmentId: eventForm.departmentId,
        assigneeIds: eventForm.assigneeIds,
        note: eventForm.note.trim(),
        reminder: eventForm.reminder ?? 'none',
        repeat: eventForm.repeat ?? 'none',
        todos: eventForm.todos.map((todo) => ({ ...todo, text: todo.text.trim() })).filter((todo) => todo.text),
        location: eventForm.location.trim(),
        url: eventForm.url.trim(),
        attachments: [...eventForm.attachments, ...uploadedAttachments],
        updatedAt: new Date().toISOString()
      }

      if (editingEventId) {
        await updateDoc(doc(db, 'calendarEvents', editingEventId), payload)
      } else {
        await addDoc(collection(db, 'calendarEvents'), {
          ...payload,
          done: false,
          createdBy: user?.uid ?? '',
          createdAt: new Date().toISOString()
        })
      }

      setShowEventModal(false)
      setAttachmentFiles([])
      await refreshCalendarData()
    } catch {
      alert('工作儲存失敗，請確認附件上傳權限或稍後再試')
    } finally {
      setSaving(false)
    }
  }

  async function uploadEventAttachments(eventId: string, files: File[]) {
    return Promise.all(files.map(async (file) => {
      const safeName = file.name.replace(/[^\w.\-\u4e00-\u9fa5]/g, '_')
      const path = `calendarEvents/${eventId}/${Date.now()}-${safeName}`
      const fileRef = ref(storage, path)
      await uploadBytes(fileRef, file)
      const url = await getDownloadURL(fileRef)
      return { name: file.name, url, path, type: file.type, size: file.size }
    }))
  }

  async function toggleDone(event: CalendarEvent) {
    try {
      await updateDoc(doc(db, 'calendarEvents', event.id), {
        done: !event.done,
        updatedAt: new Date().toISOString()
      })
      await queryClient.invalidateQueries({ queryKey: ['calendarEvents'] })
    } catch {
      alert('狀態更新失敗')
    }
  }

  async function deleteEvent(id: string) {
    if (!confirm('確定刪除此工作？')) return
    try {
      await deleteDoc(doc(db, 'calendarEvents', id))
      setSelectedEventId((current) => current === id ? null : current)
      await queryClient.invalidateQueries({ queryKey: ['calendarEvents'] })
    } catch {
      alert('工作刪除失敗')
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
      <button className={`panel-event ${event.done ? 'done' : ''}`} key={event.id} style={{ '--event-color': calendarColor(event.calendarId) } as CSSProperties} onClick={() => openEventDetail(event)}>
        <span />
        <div>
          <strong>{event.title}</strong>
          <small>{event.date} {event.startTime} - {event.endTime} · {departmentName(event.departmentId)}</small>
        </div>
      </button>
    )
  }

  function renderEventDetailPanel() {
    if (!selectedEvent) return null
    const calendar = visibleCalendarMap.get(selectedEvent.calendarId)
    const assignees = selectedEvent.assigneeIds.map(employeeName)
    const reminderLabel = REMINDER_OPTIONS.find((option) => option.value === (selectedEvent.reminder ?? 'none'))?.label ?? '無通知'
    const repeatLabel = REPEAT_OPTIONS.find((option) => option.value === (selectedEvent.repeat ?? 'none'))?.label ?? '無重複'
    const locationText = selectedEvent.location?.trim()
    return (
      <aside className="event-detail-panel">
        <div className="event-detail-header">
          <strong>活動詳情</strong>
          <div>
            {isAdmin && <button onClick={() => openEditEvent(selectedEvent)} aria-label="編輯活動">⋮</button>}
            <button onClick={() => setSelectedEventId(null)} aria-label="關閉活動詳情">×</button>
          </div>
        </div>

        <div className="event-detail-body">
          <div className="event-detail-avatar" style={{ background: calendarColor(selectedEvent.calendarId) }}>
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
              {selectedEvent.attachments.map((attachment) => (
                <a href={attachment.url} target="_blank" rel="noreferrer" key={attachment.path}>
                  <span>▧</span>
                  <div>
                    <b>{attachment.name}</b>
                    {attachment.size && <small>{Math.ceil(attachment.size / 1024)} KB</small>}
                  </div>
                </a>
              ))}
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
          {selectedEvent.note && (
            <div className="event-detail-note">
              <strong>備註</strong>
              <p>{selectedEvent.note}</p>
            </div>
          )}
        </div>

        <div className="event-detail-footer">
          <button onClick={() => toggleDone(selectedEvent)}>{selectedEvent.done ? '恢復工作' : '標記完成'}</button>
          {isAdmin && <button onClick={() => openEditEvent(selectedEvent)}>編輯</button>}
          {isAdmin && <button className="danger" onClick={() => deleteEvent(selectedEvent.id)}>刪除</button>}
        </div>
      </aside>
    )
  }

  function renderToolPanel() {
    if (!activeToolPanel) return null
    const panel = TOOL_PANELS.find((item) => item.id === activeToolPanel)
    return (
      <aside className="tt-floating-panel tt-tool-panel">
        <div className="panel-head">
          <h2>{panel?.label}</h2>
          <button onClick={() => setActiveToolPanel(null)} aria-label="關閉面板">×</button>
        </div>

        {activeToolPanel === 'comments' && (
          <div className="panel-list">
            {visibleEvents.filter((event) => event.date === selectedDate && event.note).length ? visibleEvents.filter((event) => event.date === selectedDate && event.note).map((event) => (
              <article className="panel-note" key={event.id}>
                <strong>{event.title}</strong>
                <p>{event.note}</p>
              </article>
            )) : <p className="panel-empty">目前選取日期沒有留言備註</p>}
          </div>
        )}

        {activeToolPanel === 'photos' && (
          <div className="panel-list">
            <p className="panel-empty">目前工作尚未附加照片。可先在工作備註記錄照片需求。</p>
            {visibleEvents.filter((event) => event.date === selectedDate).map(renderEventSummary)}
          </div>
        )}

        {activeToolPanel === 'members' && (
          <div className="panel-list">
            {employees.filter((emp) => emp.status !== 'inactive').map((emp) => (
              <article className="member-row" key={emp.id}>
                <span>{emp.name.slice(0, 1)}</span>
                <div>
                  <strong>{emp.name}</strong>
                  <small>{emp.departmentName || departmentName(emp.departmentId || '')}</small>
                </div>
              </article>
            ))}
          </div>
        )}

        {activeToolPanel === 'notifications' && (
          <div className="panel-list">
            {visibleEvents.slice(0, 8).map(renderEventSummary)}
            {visibleEvents.length === 0 && <p className="panel-empty">目前沒有符合條件的通知</p>}
          </div>
        )}

        {activeToolPanel === 'settings' && (
          <div className="panel-list">
            {isAdmin && <button className="primary-btn" onClick={openAddCalendar}>新增行事曆</button>}
            {visibleCalendars.map((calendar) => (
              <article className="settings-calendar" key={calendar.id}>
                <span style={{ background: calendar.color }} />
                <div>
                  <strong>{calendar.name}</strong>
                  <small>{calendar.isCompanyWide ? '全公司' : '限定部門/成員'}</small>
                </div>
                {isAdmin && <button className="small-btn" onClick={() => openEditCalendar(calendar)}>編輯</button>}
              </article>
            ))}
          </div>
        )}
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
          <select className="tt-department-select" value={departmentFilter} onChange={(event) => setDepartmentFilter(event.target.value)} aria-label="部門篩選">
            <option value="">全部</option>
            {departments.map((department) => <option value={department.id} key={department.id}>{department.name}</option>)}
          </select>
          <button className={`tt-icon-button ${showSearchPanel ? 'active' : ''}`} aria-label="搜尋" onClick={() => setShowSearchPanel((open) => !open)}>⌕</button>
          {isAdmin && <button className="tt-icon-button add" onClick={() => openAddEvent(selectedDate)} aria-label="新增工作">＋</button>}
          <button className="tt-avatar" onClick={() => signOut(auth)} title="登出">{(displayName || user?.email || 'U').slice(0, 1)}</button>
        </div>
      </header>

      <div className="timetree-body">
        <aside className={`tt-left-rail ${showCalendarDrawer ? 'drawer-open' : ''}`}>
          <button className={`rail-button ${viewMode === 'month' ? 'active' : ''}`} aria-label="月曆" onClick={() => setViewMode('month')}>✓</button>
          <button className="rail-button" aria-label="行事曆設定" onClick={openAddCalendar}>＋</button>
          <div className="rail-calendars">
            {visibleCalendars.slice(0, 8).map((calendar) => {
              const active = selectedCalendarIds.includes(calendar.id)
              return (
                <button
                  key={calendar.id}
                  className={`rail-calendar ${active ? 'active' : ''}`}
                  onClick={() => toggleCalendar(calendar.id)}
                  onDoubleClick={() => isAdmin && openEditCalendar(calendar)}
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
              <span className="field-label">部門</span>
              <select value={departmentFilter} onChange={(event) => setDepartmentFilter(event.target.value)}>
                <option value="">全部部門</option>
                {departments.map((department) => <option value={department.id} key={department.id}>{department.name}</option>)}
              </select>
            </div>
            <div className="drawer-section">
              <div className="panel-title-row">
                <span className="field-label">行事曆</span>
                {isAdmin && <button className="text-btn" onClick={openAddCalendar}>新增</button>}
              </div>
              <div className="drawer-calendar-list">
                {visibleCalendars.map((calendar) => {
                  const active = selectedCalendarIds.includes(calendar.id)
                  return (
                    <button
                      key={calendar.id}
                      className={active ? 'active' : ''}
                      onClick={() => toggleCalendar(calendar.id)}
                      style={{ '--calendar-color': calendar.color } as CSSProperties}
                    >
                      <span />
                      <strong>{calendar.name}</strong>
                      {isAdmin && <small onClick={(event) => { event.stopPropagation(); openEditCalendar(calendar) }}>設定</small>}
                    </button>
                  )
                })}
              </div>
            </div>
            <div className="drawer-actions">
              <button className="small-btn" onClick={() => setActiveCalendarIds([])}>全選</button>
              {isAdmin && <button className="primary-btn" onClick={openAddCalendar}>新增行事曆</button>}
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
                    className={`day-cell ${selected ? 'selected' : ''} ${day.month() !== month.month() ? 'muted' : ''}`}
                    key={date}
                    onClick={() => setSelectedDate(date)}
                    onDoubleClick={() => isAdmin && openAddEvent(date)}
                  >
                    <span className={`day-number ${today ? 'today' : ''}`}>{day.date()}</span>
                    <span className="day-events">
                      {dayEvents.slice(0, 4).map((event, index) => (
                        <button
                          className={`${index === 0 ? 'event-pill' : 'event-line'} ${selectedEventId === event.id ? 'active' : ''}`}
                          style={{ '--event-color': calendarColor(event.calendarId) } as CSSProperties}
                          key={event.id}
                          onClick={(clickEvent) => {
                            clickEvent.stopPropagation()
                            openEventDetail(event)
                          }}
                        >
                          {index === 0 ? `${event.title}` : `${event.title}`}
                          <small>{event.startTime}</small>
                        </button>
                      ))}
                      {dayEvents.length > 4 && <span className="more-pill">+{dayEvents.length - 4}</span>}
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
                    className={`week-day ${selected ? 'selected' : ''}`}
                    key={date}
                    onClick={() => { setSelectedDate(date); setMonth(day.startOf('month')) }}
                    onDoubleClick={() => isAdmin && openAddEvent(date)}
                  >
                    <span className={`week-date ${today ? 'today' : ''}`}>{day.format('M/D')}</span>
                    <strong>星期{WEEKDAYS[day.day()]}</strong>
                    <span className="week-events">
                      {dayEvents.length === 0 ? <small>沒有工作</small> : dayEvents.map((event) => (
                        <button
                          className={`week-event ${event.done ? 'done' : ''} ${selectedEventId === event.id ? 'active' : ''}`}
                          style={{ '--event-color': calendarColor(event.calendarId) } as CSSProperties}
                          key={event.id}
                          onClick={(clickEvent) => {
                            clickEvent.stopPropagation()
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

        <aside className="tt-right-rail">
          {TOOL_PANELS.map((panel) => (
            <button
              key={panel.id}
              className={activeToolPanel === panel.id ? 'active' : ''}
              title={panel.label}
              onClick={() => setActiveToolPanel((current) => current === panel.id ? null : panel.id)}
            >
              {panel.icon}
            </button>
          ))}
        </aside>
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

      {renderToolPanel()}
      {renderEventDetailPanel()}

      {isAdmin && (
        <nav className="mobile-action-bar">
          <button onClick={openAddCalendar}>行事曆</button>
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
                          <input type="checkbox" checked={calendarForm.departmentIds.includes(department.id)} onChange={() => setCalendarForm((form) => ({ ...form, departmentIds: toggle(form.departmentIds, department.id) }))} />
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
                  <select value={eventForm.departmentId} onChange={(event) => setEventForm((form) => ({ ...form, departmentId: event.target.value }))}>
                    <option value="">不指定部門</option>
                    {departments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}
                  </select>
                </div>
                <div className="event-editor-row">
                  <EventRowIcon name="calendar" />
                  <select value={eventForm.calendarId} onChange={(event) => setEventForm((form) => ({ ...form, calendarId: event.target.value }))}>
                    <option value="">選擇行事曆</option>
                    {visibleCalendars.map((calendar) => <option key={calendar.id} value={calendar.id}>{calendar.name}</option>)}
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
                        {eventForm.attachments.map((file) => <span key={file.path}>{file.name}</span>)}
                        {attachmentFiles.map((file) => <span key={`${file.name}-${file.size}`}>{file.name}</span>)}
                      </div>
                    )}
                  </div>
                </div>
                <div className="event-editor-row note">
                  <EventRowIcon name="note" />
                  <textarea
                    rows={1}
                    value={eventForm.note}
                    onChange={(event) => {
                      event.currentTarget.style.height = 'auto'
                      event.currentTarget.style.height = `${event.currentTarget.scrollHeight}px`
                      setEventForm((form) => ({ ...form, note: event.target.value }))
                    }}
                    placeholder="備註"
                    style={{ height: eventForm.note ? undefined : 44 }}
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
