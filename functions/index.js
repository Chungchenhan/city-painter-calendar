const crypto = require('node:crypto')
const admin = require('firebase-admin')
const { onDocumentCreated } = require('firebase-functions/v2/firestore')
const { onSchedule } = require('firebase-functions/v2/scheduler')
const webpush = require('web-push')

admin.initializeApp()

const WEB_PUSH_CONTACT = 'mailto:admin@city-painter.com'
const TAIPEI_TIME_ZONE = 'Asia/Taipei'
const REMINDER_WINDOW_MINUTES = 10
const DEPARTMENT_CALENDAR_PREFIX = 'department:'
const REPEAT_VALUES = ['daily', 'weekly', 'weekdays', 'monthly', 'monthlyNthWeekday', 'monthlyDay', 'yearly', 'custom']
const HR_PUNCH_CORRECTION_LEAVE_TYPE = '補打卡'
const DEFAULT_NOTIFICATION_SETTINGS = {
  shiftStartEnabled: true,
  shiftEndEnabled: false,
}

let vapidDetailsReady = false

function ensureVapidDetails() {
  if (vapidDetailsReady) return
  const publicKey = process.env.WEB_PUSH_PUBLIC_KEY
  const privateKey = process.env.WEB_PUSH_PRIVATE_KEY
  if (!publicKey || !privateKey) throw new Error('Missing WEB_PUSH_PUBLIC_KEY or WEB_PUSH_PRIVATE_KEY')
  webpush.setVapidDetails(WEB_PUSH_CONTACT, publicKey, privateKey)
  vapidDetailsReady = true
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function getTaipeiParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TAIPEI_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date)
  const map = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return {
    date: `${map.year}-${map.month}-${map.day}`,
    minutes: Number(map.hour) * 60 + Number(map.minute),
  }
}

function addDays(dateString, days) {
  const date = new Date(`${dateString}T00:00:00+08:00`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function minutesFromTime(value) {
  const [hour, minute] = String(value || '').split(':').map(Number)
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null
  return hour * 60 + minute
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

function isRepeatingEvent(event) {
  return Boolean(event.repeat && event.repeat !== 'none')
}

function nthWeekdayDate(monthDate, sourceDate) {
  const nth = Math.ceil(sourceDate.getUTCDate() / 7)
  const weekday = sourceDate.getUTCDay()
  const cursor = new Date(Date.UTC(monthDate.getUTCFullYear(), monthDate.getUTCMonth(), 1))
  while (cursor.getUTCDay() !== weekday) cursor.setUTCDate(cursor.getUTCDate() + 1)
  cursor.setUTCDate(cursor.getUTCDate() + (nth - 1) * 7)
  return cursor.getUTCMonth() === monthDate.getUTCMonth() ? cursor : null
}

function dateString(date) {
  return date.toISOString().slice(0, 10)
}

function parseTaipeiDate(date) {
  return new Date(`${date}T00:00:00+08:00`)
}

function addRepeatStep(current, event) {
  const repeat = event.repeat === 'monthly' ? 'monthlyDay' : event.repeat
  const next = new Date(current)
  if (repeat === 'daily') next.setUTCDate(next.getUTCDate() + 1)
  else if (repeat === 'weekly') next.setUTCDate(next.getUTCDate() + 7)
  else if (repeat === 'weekdays') {
    do {
      next.setUTCDate(next.getUTCDate() + 1)
    } while (next.getUTCDay() === 0 || next.getUTCDay() === 6)
  } else if (repeat === 'monthlyDay' || repeat === 'monthlyNthWeekday') {
    const month = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 1))
    const candidate = repeat === 'monthlyNthWeekday'
      ? nthWeekdayDate(month, parseTaipeiDate(event.date))
      : new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), Math.min(parseTaipeiDate(event.date).getUTCDate(), new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0)).getUTCDate())))
    return candidate || month
  } else if (repeat === 'yearly') next.setUTCFullYear(next.getUTCFullYear() + 1)
  else if (repeat === 'custom') {
    const custom = event.repeatCustom || { interval: 1, frequency: 'day' }
    const interval = Math.max(1, custom.interval || 1)
    if (custom.frequency === 'week') next.setUTCDate(next.getUTCDate() + interval * 7)
    else if (custom.frequency === 'month') next.setUTCMonth(next.getUTCMonth() + interval)
    else if (custom.frequency === 'year') next.setUTCFullYear(next.getUTCFullYear() + interval)
    else next.setUTCDate(next.getUTCDate() + interval)
  } else {
    next.setUTCFullYear(next.getUTCFullYear() + 100)
  }
  return next
}

function repeatEndLimit(event) {
  const values = [event.repeatUntil]
  if (event.repeat === 'custom' && event.repeatCustom && event.repeatCustom.ends === 'until') values.push(event.repeatCustom.until)
  const valid = values.filter(Boolean).map(parseTaipeiDate).filter(date => !Number.isNaN(date.getTime())).sort((a, b) => a - b)
  return valid[0] || null
}

function expandRecurringEvents(events, startDate, endDate) {
  const rangeEnd = parseTaipeiDate(endDate)
  const expanded = []
  for (const event of events) {
    if (!isRepeatingEvent(event)) {
      if (event.date <= endDate && eventEndDate(event) >= startDate) expanded.push(event)
      continue
    }

    const sourceStart = parseTaipeiDate(event.date)
    const sourceEnd = parseTaipeiDate(eventEndDate(event))
    if (Number.isNaN(sourceStart.getTime()) || Number.isNaN(sourceEnd.getTime())) continue
    const durationDays = Math.max(0, Math.round((sourceEnd - sourceStart) / 86400000))
    const endLimit = repeatEndLimit(event)
    const exceptions = new Set(event.repeatExceptions || [])
    const countLimit = event.repeat === 'custom' && event.repeatCustom && event.repeatCustom.ends === 'count'
      ? Math.max(1, event.repeatCustom.count || 1)
      : Infinity
    let cursor = sourceStart
    let count = 0
    let guard = 0

    while (guard < 1200 && count < countLimit) {
      guard += 1
      if (endLimit && cursor > endLimit) break
      if (cursor > rangeEnd) break
      const occurrenceDate = dateString(cursor)
      if (!exceptions.has(occurrenceDate)) {
        count += 1
        const occurrenceEndDate = new Date(cursor)
        occurrenceEndDate.setUTCDate(occurrenceEndDate.getUTCDate() + durationDays)
        const occurrenceEnd = dateString(occurrenceEndDate)
        if (occurrenceDate <= endDate && occurrenceEnd >= startDate) {
          expanded.push({
            ...event,
            id: occurrenceDate === event.date ? event.id : `${event.id}__repeat__${occurrenceDate}`,
            date: occurrenceDate,
            endDate: occurrenceEnd,
            recurrenceParentId: occurrenceDate === event.date ? undefined : event.id,
            recurrenceOriginalDate: event.date,
            recurrenceSourceDate: occurrenceDate,
          })
        }
      }
      cursor = addRepeatStep(cursor, event)
    }
  }
  return expanded
}

function reminderOffsetMinutes(reminder) {
  if (reminder === '5m') return 5
  if (reminder === '15m') return 15
  if (reminder === '1h') return 60
  if (reminder === '1d') return 1440
  return 0
}

function eventStartMs(event) {
  const time = event.allDay ? '00:00' : (event.startTime || '00:00')
  return new Date(`${event.date}T${time}:00+08:00`).getTime()
}

function eventTimeBody(event) {
  const time = event.allDay ? '整天' : (event.startTime || '')
  return `${event.date} ${time}${event.location ? ` · ${event.location}` : ''}`.trim()
}

async function hasTodayLeave(db, employeeId, today) {
  const snap = await db.collection('calendarEvents')
    .where('date', '<=', today)
    .get()
  return snap.docs.some(doc => {
    const event = { id: doc.id, ...doc.data() }
    return !isHrPunchCorrectionEvent(event) &&
      (event.source === 'hrLeaveRequest' || event.id.startsWith('hrLeaveRequest_')) &&
      (event.assigneeIds || []).includes(employeeId) &&
      eventEndDate(event) >= today
  })
}

async function loadSubscriptions(db) {
  const snap = await db.collection('calendarNotificationSubscriptions')
    .where('enabled', '==', true)
    .get()
  const list = []
  snap.forEach(doc => {
    const data = doc.data()
    if (!data.subscription || !data.employeeId) return
    list.push({ id: doc.id, ...data })
  })
  return list
}

function groupByEmployee(subscriptions) {
  const map = new Map()
  for (const sub of subscriptions) {
    const list = map.get(sub.employeeId) || []
    list.push(sub)
    map.set(sub.employeeId, list)
  }
  return map
}

function createNotificationGate(db) {
  const employeeCache = new Map()
  const shiftCache = new Map()
  const settingsCache = new Map()
  const leaveCache = new Map()

  async function loadEmployee(employeeId) {
    if (employeeCache.has(employeeId)) return employeeCache.get(employeeId)
    const snap = await db.collection('employees').doc(employeeId).get()
    const employee = snap.exists ? { id: snap.id, ...snap.data() } : null
    employeeCache.set(employeeId, employee)
    return employee
  }

  async function loadShift(shiftId) {
    if (shiftCache.has(shiftId)) return shiftCache.get(shiftId)
    const snap = await db.collection('shifts').doc(shiftId).get()
    const shift = snap.exists ? snap.data() : null
    shiftCache.set(shiftId, shift)
    return shift
  }

  async function loadSettings(uid) {
    if (settingsCache.has(uid)) return settingsCache.get(uid)
    const snap = await db.collection('calendarNotificationSettings').doc(uid).get()
    const settings = { ...DEFAULT_NOTIFICATION_SETTINGS, ...(snap.exists ? snap.data() : {}) }
    settingsCache.set(uid, settings)
    return settings
  }

  async function employeeHasLeave(employeeId, date) {
    const key = `${employeeId}:${date}`
    if (leaveCache.has(key)) return leaveCache.get(key)
    const value = await hasTodayLeave(db, employeeId, date)
    leaveCache.set(key, value)
    return value
  }

  return async function canReceiveCalendarNotification(sub, date, minutes) {
    if (!sub.uid || !sub.employeeId) return false
    const settings = await loadSettings(sub.uid)
    if (!settings.shiftStartEnabled && !settings.shiftEndEnabled) return false

    const employee = await loadEmployee(sub.employeeId)
    if (!employee || employee.status !== 'active' || !employee.shiftId) return false
    if (await employeeHasLeave(sub.employeeId, date)) return false

    const shift = await loadShift(employee.shiftId)
    if (!shift) return false
    const startMinutes = minutesFromTime(shift.startTime)
    const rawEndMinutes = minutesFromTime(shift.endTime)
    if (startMinutes == null || rawEndMinutes == null) return false

    const endMinutes = rawEndMinutes <= startMinutes ? rawEndMinutes + 1440 : rawEndMinutes
    const normalizedMinutes = minutes < startMinutes ? minutes + 1440 : minutes
    const isDuringShift = normalizedMinutes >= startMinutes && normalizedMinutes < endMinutes
    const isAfterShift = normalizedMinutes >= endMinutes
    return (settings.shiftStartEnabled && isDuringShift) || (settings.shiftEndEnabled && isAfterShift)
  }
}

async function sendPush(db, sub, payload) {
  ensureVapidDetails()
  try {
    await webpush.sendNotification(sub.subscription, JSON.stringify(payload))
    const key = sha256(`${sub.id}:${payload.tag}`)
    const deliveryRef = db.collection('calendarNotificationDeliveries').doc(key)
    await deliveryRef.create({
      subscriptionId: sub.id,
      uid: sub.uid || '',
      employeeId: sub.employeeId || '',
      tag: payload.tag,
      title: payload.title,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    }).catch((error) => {
      if (error && (error.code === 6 || String(error.message || '').includes('ALREADY_EXISTS'))) return
      throw error
    })
    return true
  } catch (error) {
    const statusCode = error && error.statusCode
    const body = `${error && error.body || ''}`
    if (statusCode === 404 || statusCode === 410 || body.includes('VapidPkHashMismatch') || body.includes('VAPID credentials')) {
      await db.collection('calendarNotificationSubscriptions').doc(sub.id).delete()
      return false
    }
    console.error('calendar web push failed', sub.id, error)
    return false
  }
}

async function sendToSubscriptions(db, subscriptions, payload) {
  const results = await Promise.all(subscriptions.map(sub => sendPush(db, sub, payload)))
  return results.filter(Boolean).length
}

async function sendEventReminders(db, subscriptionsByEmployee, windowStartMs, windowEndMs, today, canReceiveCalendarNotification) {
  const startDate = addDays(today, -1)
  const endDate = addDays(today, 2)
  const [rangeSnap, repeatSnap] = await Promise.all([
    db.collection('calendarEvents').where('date', '>=', startDate).where('date', '<=', endDate).get(),
    db.collection('calendarEvents').where('repeat', 'in', REPEAT_VALUES).get(),
  ])

  const map = new Map()
  rangeSnap.forEach(doc => map.set(doc.id, { id: doc.id, ...doc.data() }))
  repeatSnap.forEach(doc => {
    const event = { id: doc.id, ...doc.data() }
    if (event.date <= endDate) map.set(doc.id, event)
  })

  let sent = 0
  const events = expandRecurringEvents(Array.from(map.values()), startDate, endDate)
  for (const event of events) {
    if (!event.reminder || event.reminder === 'none' || !(event.assigneeIds || []).length) continue
    const notifyAt = eventStartMs(event) - reminderOffsetMinutes(event.reminder) * 60000
    if (notifyAt < windowStartMs || notifyAt > windowEndMs) continue
    const notifyParts = getTaipeiParts(new Date(notifyAt))
    const tag = `calendar-reminder-${event.id}-${notifyAt}`
    for (const employeeId of event.assigneeIds || []) {
      const subscriptions = subscriptionsByEmployee.get(employeeId)
      if (!subscriptions || subscriptions.length === 0) continue
      const targets = []
      for (const sub of subscriptions) {
        if (await canReceiveCalendarNotification(sub, notifyParts.date, notifyParts.minutes)) targets.push(sub)
      }
      if (targets.length === 0) continue
      sent += await sendToSubscriptions(db, targets, {
        title: event.title || '行事曆提醒',
        body: eventTimeBody(event),
        tag,
        url: '/',
        eventId: event.id,
        unreadCount: 1,
      })
    }
  }
  return sent
}

async function sendShiftAndPunchReminders(db, subscriptionsByEmployee, windowStartMs, windowEndMs, today) {
  const employeesSnap = await db.collection('employees').where('status', '==', 'active').get()
  const shiftCache = new Map()
  const settingsCache = new Map()
  let sent = 0

  for (const employeeDoc of employeesSnap.docs) {
    const employee = { id: employeeDoc.id, ...employeeDoc.data() }
    const subscriptions = subscriptionsByEmployee.get(employee.id)
    if (!subscriptions || subscriptions.length === 0 || !employee.shiftId) continue
    if (await hasTodayLeave(db, employee.id, today)) continue

    let shift = shiftCache.get(employee.shiftId)
    if (!shift) {
      const shiftSnap = await db.collection('shifts').doc(employee.shiftId).get()
      if (!shiftSnap.exists) continue
      shift = shiftSnap.data()
      shiftCache.set(employee.shiftId, shift)
    }

    const startMinutes = minutesFromTime(shift.startTime)
    const endMinutes = minutesFromTime(shift.endTime)
    if (startMinutes == null || endMinutes == null) continue

    for (const sub of subscriptions) {
      let settings = settingsCache.get(sub.uid)
      if (!settings) {
        const settingsSnap = await db.collection('calendarNotificationSettings').doc(sub.uid).get()
        settings = { ...DEFAULT_NOTIFICATION_SETTINGS, ...(settingsSnap.exists ? settingsSnap.data() : {}) }
        settingsCache.set(sub.uid, settings)
      }

      const schedules = [
        {
          enabled: settings.shiftStartEnabled,
          at: startMinutes,
          title: '行事曆通知',
          body: `今日班表 ${shift.startTime} - ${shift.endTime}`,
          tag: `calendar-shift-start-${employee.id}-${today}`,
        },
      {
        enabled: settings.shiftEndEnabled,
        at: endMinutes,
        title: '行事曆通知',
        body: `今日班表 ${shift.startTime} - ${shift.endTime}`,
        tag: `calendar-shift-end-${employee.id}-${today}`,
      },
    ]

      for (const schedule of schedules) {
        if (!schedule.enabled) continue
        const targetMs = new Date(`${today}T00:00:00+08:00`).getTime() + schedule.at * 60000
        if (targetMs < windowStartMs || targetMs > windowEndMs) continue
        sent += await sendPush(db, sub, {
          title: schedule.title,
          body: schedule.body,
          tag: schedule.tag,
          url: '/',
          unreadCount: 1,
        }) ? 1 : 0
      }
    }
  }

  return sent
}

exports.sendCalendarScheduledNotifications = onSchedule({
  schedule: 'every 5 minutes',
  timeZone: TAIPEI_TIME_ZONE,
  region: 'asia-east1',
}, async () => {
  const db = admin.firestore()
  const { date: today } = getTaipeiParts()
  const nowMs = Date.now()
  const windowStartMs = nowMs - REMINDER_WINDOW_MINUTES * 60000
  const windowEndMs = nowMs
  const subscriptions = await loadSubscriptions(db)
  if (subscriptions.length === 0) return

  const subscriptionsByEmployee = groupByEmployee(subscriptions)
  const canReceiveCalendarNotification = createNotificationGate(db)
  await sendEventReminders(db, subscriptionsByEmployee, windowStartMs, windowEndMs, today, canReceiveCalendarNotification)
  await sendShiftAndPunchReminders(db, subscriptionsByEmployee, windowStartMs, windowEndMs, today)
})

exports.sendCalendarActivityNotifications = onDocumentCreated({
  document: 'calendarActivityLogs/{logId}',
  region: 'asia-east1',
}, async (event) => {
  const log = event.data && event.data.data()
  if (!log || !(log.assigneeIds || []).length) return

  const db = admin.firestore()
  const subscriptions = await loadSubscriptions(db)
  const canReceiveCalendarNotification = createNotificationGate(db)
  const now = getTaipeiParts()
  const targets = []
  for (const sub of subscriptions) {
    if (!(log.assigneeIds || []).includes(sub.employeeId) || sub.uid === log.actorUid) continue
    if (await canReceiveCalendarNotification(sub, now.date, now.minutes)) targets.push(sub)
  }
  if (targets.length === 0) return

  const actionText = log.action === 'create' ? '新增' : log.action === 'delete' ? '刪除' : log.action === 'move' ? '移動' : log.action === 'copy' ? '複製' : '更新'
  await sendToSubscriptions(db, targets, {
    title: '行事曆通知',
    body: `${log.actorName || '有人'}${actionText}「${log.eventTitle || '未命名活動'}」`,
    tag: `calendar-activity-${event.params.logId}`,
    url: '/',
    eventId: log.eventId || '',
    unreadCount: 1,
  })
})
