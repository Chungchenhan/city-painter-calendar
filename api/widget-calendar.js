import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import admin from 'firebase-admin'
import dayjs from 'dayjs'

const PROJECT_ID = 'city-painter-erp'
const COLORS = ['#f6b100', '#1fb6a6', '#3c82f6', '#ef6262', '#8d6df2', '#31a24c', '#f57c35', '#667085']
const DEPARTMENT_CALENDAR_PREFIX = 'department:'
const REPEAT_VALUES = ['daily', 'weekly', 'weekdays', 'monthly', 'monthlyNthWeekday', 'monthlyDay', 'yearly', 'custom']
const HR_PUNCH_CORRECTION_LEAVE_TYPE = '補打卡'

function serviceAccountJson() {
  const source = process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON ||
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 && Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64, 'base64').toString('utf8')
  if (source) return JSON.parse(source)

  const localPath = path.join(os.homedir(), '.firebase', 'service-account.json')
  if (fs.existsSync(localPath)) return JSON.parse(fs.readFileSync(localPath, 'utf8'))
  throw new Error('Missing Firebase service account credentials')
}

function firestore() {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccountJson()),
      projectId: PROJECT_ID
    })
  }
  return admin.firestore()
}

function departmentCalendarId(departmentId) {
  return `${DEPARTMENT_CALENDAR_PREFIX}${departmentId}`
}

function departmentCalendarDocId(departmentId) {
  return `departmentCalendar_${departmentId}`
}

function eventEndDate(event) {
  return event.endDate || event.date
}

function isHrPunchCorrectionEvent(event) {
  const isHrLeaveRequest = event.source === 'hrLeaveRequest' || `${event.id || ''}`.startsWith('hrLeaveRequest_')
  if (!isHrLeaveRequest) return false
  return `${event.title || ''}`.includes(HR_PUNCH_CORRECTION_LEAVE_TYPE) ||
    `${event.note || ''}`.includes(HR_PUNCH_CORRECTION_LEAVE_TYPE)
}

function compareEvents(a, b) {
  const allDaySort = Number(Boolean(b.allDay)) - Number(Boolean(a.allDay))
  if (allDaySort !== 0) return allDaySort
  const timeCompare = `${a.startTime || ''}`.localeCompare(`${b.startTime || ''}`)
  if (timeCompare !== 0) return timeCompare
  return `${a.title || ''}`.localeCompare(`${b.title || ''}`, 'zh-Hant')
}

function isRepeatingEvent(event) {
  return Boolean(event.repeat && event.repeat !== 'none')
}

function nthWeekdayDate(month, sourceDate) {
  const nth = Math.ceil(sourceDate.date() / 7)
  const weekday = sourceDate.day()
  let cursor = month.startOf('month')
  while (cursor.day() !== weekday) cursor = cursor.add(1, 'day')
  const candidate = cursor.add(nth - 1, 'week')
  return candidate.month() === month.month() ? candidate : null
}

function monthlyDayDate(month, sourceDate) {
  return month.date(Math.min(sourceDate.date(), month.daysInMonth()))
}

function addRepeatStep(current, event) {
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
    const custom = event.repeatCustom ?? { interval: 1, frequency: 'day', ends: 'never' }
    return current.add(Math.max(1, custom.interval || 1), custom.frequency)
  }
  return current.add(100, 'year')
}

function repeatEndLimit(event) {
  const dates = [event.repeatUntil]
  if (event.repeat === 'custom' && event.repeatCustom?.ends === 'until') dates.push(event.repeatCustom.until)
  const valid = dates
    .filter(Boolean)
    .map((date) => dayjs(date))
    .filter((date) => date.isValid())
    .sort((a, b) => a.valueOf() - b.valueOf())
  return valid[0] ?? null
}

function expandRecurringEvents(events, startDate, endDate) {
  const rangeEnd = dayjs(endDate)
  const expanded = []

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

  return expanded.sort(compareEvents)
}

function eventCalendarId(event) {
  if (event.calendarIds?.length) return event.calendarIds[0]
  if (event.calendarId) return event.calendarId
  if (event.departmentId) return departmentCalendarId(event.departmentId)
  return ''
}

function eventColor(event, calendarColors, departmentColors) {
  const calendarId = eventCalendarId(event)
  return calendarColors.get(calendarId) ||
    (event.departmentId ? departmentColors.get(event.departmentId) : '') ||
    COLORS[0]
}

function shortTitle(title) {
  return String(title || '').replace(/\s+/g, ' ').trim()
}

function eventPayload(event, color) {
  return {
    id: event.id,
    title: shortTitle(event.title),
    date: event.date,
    endDate: eventEndDate(event),
    startTime: event.startTime || '',
    endTime: event.endTime || '',
    allDay: Boolean(event.allDay),
    color,
    done: Boolean(event.done)
  }
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Widget-Token')
}

function queryValue(req, name) {
  if (req.query?.[name]) return req.query[name]
  const url = new URL(req.url || '/', 'http://localhost')
  return url.searchParams.get(name)
}

export default async function handler(req, res) {
  cors(res)
  if (req.method === 'OPTIONS') {
    res.status(204).end()
    return
  }
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  const requiredToken = process.env.WIDGET_API_TOKEN
  const requestToken = req.headers['x-widget-token'] || queryValue(req, 'token')
  if (requiredToken && requestToken !== requiredToken) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  try {
    const monthValue = dayjs(`${queryValue(req, 'month') || dayjs().format('YYYY-MM')}-01`)
    if (!monthValue.isValid()) {
      res.status(400).json({ error: 'Invalid month. Use YYYY-MM.' })
      return
    }

    const gridStart = monthValue.startOf('month').startOf('week')
    const gridEnd = monthValue.endOf('month').endOf('week')
    const startDate = gridStart.format('YYYY-MM-DD')
    const endDate = gridEnd.format('YYYY-MM-DD')
    const db = firestore()

    const [rangeSnap, repeatSnap, calendarSnap, departmentSnap] = await Promise.all([
      db.collection('calendarEvents')
        .where('date', '>=', startDate)
        .where('date', '<=', endDate)
        .get(),
      db.collection('calendarEvents')
        .where('repeat', 'in', REPEAT_VALUES)
        .get(),
      db.collection('calendarCalendars').get(),
      db.collection('departments').get()
    ])

    const calendarColors = new Map()
    calendarSnap.docs.forEach((doc) => {
      const data = doc.data()
      if (data.color) calendarColors.set(doc.id, data.color)
      if (doc.id.startsWith('departmentCalendar_') && data.departmentIds?.[0] && data.color) {
        calendarColors.set(departmentCalendarId(data.departmentIds[0]), data.color)
      }
    })

    const departmentColors = new Map()
    departmentSnap.docs.forEach((doc, index) => {
      const settingColor = calendarColors.get(departmentCalendarDocId(doc.id)) || calendarColors.get(departmentCalendarId(doc.id))
      departmentColors.set(doc.id, settingColor || COLORS[index % COLORS.length])
    })

    const map = new Map()
    rangeSnap.docs.forEach((doc) => map.set(doc.id, { id: doc.id, ...doc.data() }))
    repeatSnap.docs.forEach((doc) => {
      const event = { id: doc.id, ...doc.data() }
      if (event.date <= endDate) map.set(doc.id, event)
    })

    const expanded = expandRecurringEvents(
      Array.from(map.values()).filter((event) => !isHrPunchCorrectionEvent(event)),
      startDate,
      endDate
    )
    const days = Array.from({ length: 42 }, (_, index) => {
      const day = gridStart.add(index, 'day')
      const date = day.format('YYYY-MM-DD')
      const dayEvents = expanded
        .filter((event) => event.date <= date && eventEndDate(event) >= date)
        .sort(compareEvents)
        .map((event) => eventPayload(event, eventColor(event, calendarColors, departmentColors)))
      return {
        date,
        day: day.date(),
        inMonth: day.month() === monthValue.month(),
        isToday: date === dayjs().format('YYYY-MM-DD'),
        events: dayEvents
      }
    })

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300')
    res.status(200).json({
      month: monthValue.format('YYYY-MM'),
      title: `${monthValue.month() + 1}月`,
      startDate,
      endDate,
      generatedAt: new Date().toISOString(),
      days
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Widget API failed'
    res.status(500).json({ error: message })
  }
}
