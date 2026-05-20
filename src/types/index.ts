export interface Department {
  id: string
  name: string
}

export interface Employee {
  id: string
  empNo?: string
  name: string
  departmentId?: string
  departmentName?: string
  status?: string
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
  departmentId: string
  assigneeIds: string[]
  note: string
  reminder?: 'none' | 'start' | '5m' | '15m' | '1h' | '1d'
  repeat?: 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly'
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
  date: string
  changes?: {
    field: string
    label: string
    before: string
    after: string
  }[]
  createdAt: string
}
