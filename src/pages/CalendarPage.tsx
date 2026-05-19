import { useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import dayjs from 'dayjs'
import { addDoc, collection, deleteDoc, doc, updateDoc } from 'firebase/firestore'
import { signOut } from 'firebase/auth'
import { useQueryClient } from '@tanstack/react-query'
import { auth, db } from '../lib/firebase'
import { useAuth } from '../contexts/AuthContext'
import { useCalendarEvents, useCalendarGroups } from '../hooks/useCalendarData'
import { useDepartments, useEmployees } from '../hooks/useHrData'
import type { CalendarEvent, CalendarGroup } from '../types'

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']
const COLORS = ['#f6b100', '#1fb6a6', '#3c82f6', '#ef6262', '#8d6df2', '#31a24c', '#f57c35', '#667085']
const TOOL_PANELS = [
  { id: 'comments', label: '留言', icon: '▤' },
  { id: 'photos', label: '照片', icon: '▧' },
  { id: 'members', label: '成員', icon: '♙' },
  { id: 'notifications', label: '通知', icon: '⌒' },
  { id: 'settings', label: '設定', icon: '☷' }
] as const

type ViewMode = 'month' | 'week'
type ToolPanelId = typeof TOOL_PANELS[number]['id']

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
  note: ''
}

function toggle(list: string[], id: string) {
  return list.includes(id) ? list.filter((item) => item !== id) : [...list, id]
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
  const [showCalendarModal, setShowCalendarModal] = useState(false)
  const [showEventModal, setShowEventModal] = useState(false)
  const [editingCalendarId, setEditingCalendarId] = useState<string | null>(null)
  const [editingEventId, setEditingEventId] = useState<string | null>(null)
  const [calendarForm, setCalendarForm] = useState(emptyCalendar)
  const [eventForm, setEventForm] = useState(emptyEvent)
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

  const monthDays = useMemo(() => {
    const start = month.startOf('month').startOf('week')
    return Array.from({ length: 42 }, (_, index) => start.add(index, 'day'))
  }, [month])

  const weekDays = useMemo(() => {
    const start = dayjs(selectedDate).startOf('week')
    return Array.from({ length: 7 }, (_, index) => start.add(index, 'day'))
  }, [selectedDate])

  const selectedEvents = eventsByDate.get(selectedDate) ?? []
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
    setEditingEventId(null)
    setShowEventModal(true)
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
      note: event.note ?? ''
    })
    setEditingEventId(event.id)
    setShowEventModal(true)
  }

  async function refreshCalendarData() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['calendarCalendars'] }),
      queryClient.invalidateQueries({ queryKey: ['calendarEvents'] })
    ])
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
      const payload = {
        calendarId: eventForm.calendarId,
        title: eventForm.title.trim(),
        date: eventForm.date,
        startTime: eventForm.startTime,
        endTime: eventForm.endTime,
        departmentId: eventForm.departmentId,
        assigneeIds: eventForm.assigneeIds,
        note: eventForm.note.trim(),
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
      await refreshCalendarData()
    } catch {
      alert('工作儲存失敗')
    } finally {
      setSaving(false)
    }
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
      <article className={`panel-event ${event.done ? 'done' : ''}`} key={event.id} style={{ '--event-color': calendarColor(event.calendarId) } as CSSProperties}>
        <span />
        <div>
          <strong>{event.title}</strong>
          <small>{event.date} {event.startTime} - {event.endTime} · {departmentName(event.departmentId)}</small>
        </div>
      </article>
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
            {selectedEvents.filter((event) => event.note).length ? selectedEvents.filter((event) => event.note).map((event) => (
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
            {selectedEvents.map(renderEventSummary)}
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
                        <span className={index === 0 ? 'event-pill' : 'event-line'} style={{ '--event-color': calendarColor(event.calendarId) } as CSSProperties} key={event.id}>
                          {index === 0 ? `${event.title}` : `${event.title}`}
                          <small>{event.startTime}</small>
                        </span>
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
                        <span className={`week-event ${event.done ? 'done' : ''}`} style={{ '--event-color': calendarColor(event.calendarId) } as CSSProperties} key={event.id}>
                          <i />
                          <span>{event.startTime}</span>
                          <b>{event.title}</b>
                        </span>
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

      <section className="tt-day-dock">
        <div className="dock-date">
          <strong>{selectedDay.format('M/D')}</strong>
          <span>星期{WEEKDAYS[selectedDay.day()]}</span>
        </div>
        <div className="dock-events">
          {selectedEvents.length === 0 ? (
            <span className="dock-empty">這天沒有工作</span>
          ) : selectedEvents.slice(0, 4).map((event) => (
            <article className={`dock-event ${event.done ? 'done' : ''}`} key={event.id} style={{ '--event-color': calendarColor(event.calendarId) } as CSSProperties}>
              <button className="done-dot" onClick={() => toggleDone(event)} aria-label={event.done ? '恢復工作' : '完成工作'} />
              <div>
                <strong>{event.title}</strong>
                <span>{event.startTime} - {event.endTime} · {departmentName(event.departmentId)}</span>
              </div>
              <div className="dock-actions">
                {event.assigneeIds.length > 0 && <small>{event.assigneeIds.map(employeeName).join('、')}</small>}
                {isAdmin && <button onClick={() => openEditEvent(event)}>編輯</button>}
                {isAdmin && <button onClick={() => deleteEvent(event.id)}>刪除</button>}
              </div>
            </article>
          ))}
        </div>
      </section>

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
          <div className="modal wide">
            <div className="modal-header">
              <h2>{editingEventId ? '編輯工作' : '新增工作'}</h2>
              <button className="close-btn" onClick={() => setShowEventModal(false)}>×</button>
            </div>
            <div className="modal-body">
              <div className="two-col">
                <label>行事曆
                  <select value={eventForm.calendarId} onChange={(event) => setEventForm((form) => ({ ...form, calendarId: event.target.value }))}>
                    <option value="">請選擇</option>
                    {visibleCalendars.map((calendar) => <option key={calendar.id} value={calendar.id}>{calendar.name}</option>)}
                  </select>
                </label>
                <label>部門
                  <select value={eventForm.departmentId} onChange={(event) => setEventForm((form) => ({ ...form, departmentId: event.target.value }))}>
                    <option value="">未分配</option>
                    {departments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}
                  </select>
                </label>
              </div>
              <label>工作標題
                <input value={eventForm.title} onChange={(event) => setEventForm((form) => ({ ...form, title: event.target.value }))} />
              </label>
              <div className="three-col">
                <label>日期
                  <input type="date" value={eventForm.date} onChange={(event) => setEventForm((form) => ({ ...form, date: event.target.value }))} />
                </label>
                <label>開始
                  <input type="time" value={eventForm.startTime} onChange={(event) => setEventForm((form) => ({ ...form, startTime: event.target.value }))} />
                </label>
                <label>結束
                  <input type="time" value={eventForm.endTime} onChange={(event) => setEventForm((form) => ({ ...form, endTime: event.target.value }))} />
                </label>
              </div>
              <label>備註
                <textarea rows={3} value={eventForm.note} onChange={(event) => setEventForm((form) => ({ ...form, note: event.target.value }))} />
              </label>
              <div>
                <span className="field-label">指派員工</span>
                <div className="employee-grid">
                  {employees.filter((emp) => emp.status !== 'inactive').map((emp) => (
                    <label key={emp.id}>
                      <input type="checkbox" checked={eventForm.assigneeIds.includes(emp.id)} onChange={() => setEventForm((form) => ({ ...form, assigneeIds: toggle(form.assigneeIds, emp.id) }))} />
                      <span>{emp.name}</span>
                      <small>{emp.departmentName || departmentName(emp.departmentId || '')}</small>
                    </label>
                  ))}
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button className="small-btn" onClick={() => setShowEventModal(false)}>取消</button>
              <button className="primary-btn" onClick={saveEvent} disabled={saving}>{saving ? '儲存中...' : '儲存'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
