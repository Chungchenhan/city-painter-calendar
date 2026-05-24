export interface Department {
  id: string
  name: string
  sort?: number
}

export interface Employee {
  id: string
  empNo?: string
  name: string
  nickname?: string
  departmentId?: string
  departmentName?: string
  shiftId?: string
  shiftName?: string
  status?: string
}

export interface Shift {
  id: string
  name: string
  startTime: string
  endTime: string
  breakMinutes?: number
  lateToleranceMinutes?: number
  earlyLeaveToleranceMinutes?: number
}

export interface PunchLog {
  id: string
  employeeId: string
  date: string
  punches: string[]
  firstPunch?: string
  lastPunch?: string
}

export interface UserRole {
  uid: string
  email: string
  displayName: string
  role: 'admin' | 'employee'
  employeeId?: string
  createdAt?: string
}

export interface CalendarGroup {
  id: string
  name: string
  color: string
  departmentIds: string[]
  employeeIds: string[]
  isCompanyWide: boolean
  createdBy?: string
  createdAt?: string
  updatedAt?: string
}

export interface CalendarEvent {
  id: string
  calendarId: string
  calendarIds?: string[]
  title: string
  date: string
  endDate?: string
  startTime: string
  endTime: string
  allDay?: boolean
  departmentId: string
  assigneeIds: string[]
  hiddenDepartmentIds?: string[]
  hiddenAssigneeIds?: string[]
  titleOverrides?: {
    targetType: 'department' | 'employee' | 'allDepartmentsExceptOwn' | 'allEmployeesExceptSelf'
    targetId: string
    icon?: string
    title: string
  }[]
  note: string
  reminder?: 'none' | 'start' | '5m' | '15m' | '1h' | '1d'
  repeat?: 'none' | 'daily' | 'weekly' | 'weekdays' | 'monthly' | 'monthlyNthWeekday' | 'monthlyDay' | 'yearly' | 'custom'
  repeatCustom?: {
    interval: number
    frequency: 'day' | 'week' | 'month' | 'year'
    ends: 'never' | 'until' | 'count'
    until?: string
    count?: number
  }
  repeatUntil?: string
  repeatExceptions?: string[]
  recurrenceParentId?: string
  recurrenceOriginalDate?: string
  recurrenceSourceDate?: string
  todos?: {
    id: string
    text: string
    done: boolean
  }[]
  location?: string
  url?: string
  attachments?: {
    name: string
    url: string
    path: string
    type?: string
    size?: number
    provider?: 'google-drive' | 'firebase-storage'
    originalName?: string
    originalSize?: number
    optimized?: boolean
  }[]
  done: boolean
  source?: string
  sourceId?: string
  sourceDate?: string
  createdBy?: string
  createdAt?: string
  updatedAt?: string
}

export interface CalendarActivityLog {
  id: string
  action: 'create' | 'update' | 'delete' | 'move' | 'copy'
  actorUid: string
  actorName: string
  eventId?: string
  eventTitle: string
  calendarId: string
  departmentId: string
  assigneeIds?: string[]
  date: string
  changes?: {
    field: string
    label: string
    before: string
    after: string
  }[]
  createdAt: string
}

export interface UserNotificationSettings {
  shiftStartEnabled: boolean
  shiftEndEnabled: boolean
  punchInEnabled: boolean
  punchOutEnabled: boolean
  punchLeadMinutes: number
  updatedAt?: string
}
