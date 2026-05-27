import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import admin from 'firebase-admin'
import webpush from 'web-push'

const PROJECT_ID = 'city-painter-erp'
const TAIPEI_TIME_ZONE = 'Asia/Taipei'
const HR_PUNCH_CORRECTION_LEAVE_TYPE = '補打卡'
const DEFAULT_NOTIFICATION_SETTINGS = {
  shiftStartEnabled: true,
  shiftEndEnabled: false,
}

function setCorsHeaders(req, res) {
  const origin = req.headers.origin || '*'
  res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
}

function serviceAccountJson() {
  const source = process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON ||
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 && Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64, 'base64').toString('utf8')
  if (source) return JSON.parse(source)

  const localPath = path.join(os.homedir(), '.firebase', 'service-account.json')
  if (fs.existsSync(localPath)) return JSON.parse(fs.readFileSync(localPath, 'utf8'))
  throw new Error('Missing Firebase service account credentials')
}

function getAdminApp() {
  if (admin.apps.length > 0) return admin.app()

  return admin.initializeApp({
    credential: admin.credential.cert(serviceAccountJson()),
    projectId: PROJECT_ID,
  })
}

async function verifyRequest(req) {
  const authHeader = req.headers.authorization || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!token) return null

  try {
    return await admin.auth().verifyIdToken(token)
  } catch {
    return null
  }
}

async function readBody(req) {
  if (req.body) return req.body
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

async function loadRecipientTargets(db, assigneeIds) {
  const ids = new Set((assigneeIds || []).filter(Boolean))
  const uids = new Set()
  if (ids.size === 0) return { employeeIds: ids, uids }

  const rolesSnap = await db.collection('userRoles').get()
  rolesSnap.forEach((item) => {
    const data = item.data()
    if (data.employeeId && ids.has(data.employeeId)) uids.add(item.id)
  })
  return { employeeIds: ids, uids }
}

function eventTimeLabel(event) {
  const date = event.date || ''
  if (event.allDay) return `${date} 整天`
  const start = event.startTime || ''
  const end = event.endTime || ''
  return `${date} ${start}${end ? `-${end}` : ''}`.trim()
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
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return {
    date: `${map.year}-${map.month}-${map.day}`,
    minutes: Number(map.hour) * 60 + Number(map.minute),
  }
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

async function hasTodayLeave(db, employeeId, today) {
  const snap = await db.collection('calendarEvents')
    .where('date', '<=', today)
    .get()
  return snap.docs.some((doc) => {
    const event = { id: doc.id, ...doc.data() }
    return !isHrPunchCorrectionEvent(event) &&
      (event.source === 'hrLeaveRequest' || event.id.startsWith('hrLeaveRequest_')) &&
      (event.assigneeIds || []).includes(employeeId) &&
      eventEndDate(event) >= today
  })
}

async function canReceiveCalendarNotification(db, sub) {
  if (!sub.uid || !sub.employeeId) return false
  const now = getTaipeiParts()
  const settingsSnap = await db.collection('calendarNotificationSettings').doc(sub.uid).get()
  const employeeSettingsSnap = !settingsSnap.exists
    ? await db.collection('calendarNotificationSettings').doc(sub.employeeId).get()
    : null
  const settings = {
    ...DEFAULT_NOTIFICATION_SETTINGS,
    ...(settingsSnap.exists ? settingsSnap.data() : employeeSettingsSnap?.exists ? employeeSettingsSnap.data() : {})
  }
  if (!settings.shiftStartEnabled && !settings.shiftEndEnabled) return false

  const employeeSnap = await db.collection('employees').doc(sub.employeeId).get()
  if (!employeeSnap.exists) return false
  const employee = employeeSnap.data()
  if (employee.status !== 'active' || !employee.shiftId) return false
  if (await hasTodayLeave(db, sub.employeeId, now.date)) return false

  const shiftSnap = await db.collection('shifts').doc(employee.shiftId).get()
  if (!shiftSnap.exists) return false
  const shift = shiftSnap.data()
  const startMinutes = minutesFromTime(shift.startTime)
  const rawEndMinutes = minutesFromTime(shift.endTime)
  if (startMinutes == null || rawEndMinutes == null) return false

  const endMinutes = rawEndMinutes <= startMinutes ? rawEndMinutes + 1440 : rawEndMinutes
  const normalizedMinutes = now.minutes < startMinutes ? now.minutes + 1440 : now.minutes
  const isDuringShift = normalizedMinutes >= startMinutes && normalizedMinutes < endMinutes
  const isAfterShift = normalizedMinutes >= endMinutes
  return (settings.shiftStartEnabled && isDuringShift) || (settings.shiftEndEnabled && isAfterShift)
}

async function sendPushes(db, event, recipients, actorUid) {
  const subsSnap = await db.collection('calendarNotificationSubscriptions').where('enabled', '==', true).get()
  const targets = []
  subsSnap.forEach((item) => {
    const sub = item.data()
    const matchesUid = sub.uid && recipients.uids.has(sub.uid)
    const matchesEmployee = sub.employeeId && recipients.employeeIds.has(sub.employeeId)
    if (!sub.uid || sub.uid === actorUid || (!matchesUid && !matchesEmployee) || !sub.subscription) return
    targets.push({ ref: item.ref, id: item.id, ...sub })
  })
  if (targets.length === 0) return 0

  const publicKey = process.env.WEB_PUSH_PUBLIC_KEY || process.env.VITE_WEB_PUSH_PUBLIC_KEY
  const privateKey = process.env.WEB_PUSH_PRIVATE_KEY
  if (!publicKey || !privateKey) throw new Error('Missing Web Push keys')

  webpush.setVapidDetails('mailto:admin@city-painter.com', publicKey, privateKey)

  const allowedTargets = []
  for (const sub of targets) {
    if (await canReceiveCalendarNotification(db, sub)) allowedTargets.push(sub)
  }
  if (allowedTargets.length === 0) return 0

  const jobs = allowedTargets.map(async (sub) => {
    const payload = JSON.stringify({
      title: '行事曆通知',
      body: `您被標記在「${event.title || '未命名活動'}」 ${eventTimeLabel(event)}`,
      tag: `calendar-event-${event.id}`,
      url: '/',
      eventId: event.id,
      unreadCount: 1,
    })

    try {
      await webpush.sendNotification(sub.subscription, payload)
    } catch (error) {
      const body = `${error?.body || ''}`
      if (error?.statusCode === 404 || error?.statusCode === 410 || body.includes('VapidPkHashMismatch') || body.includes('VAPID credentials')) {
        await sub.ref.delete()
        return
      }
      console.error('calendar web push failed', sub.id, error)
    }
  })

  await Promise.all(jobs)
  return jobs.length
}

export default async function handler(req, res) {
  setCorsHeaders(req, res)

  if (req.method === 'OPTIONS') {
    return res.status(204).end()
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    getAdminApp()
    const decoded = await verifyRequest(req)
    if (!decoded?.uid) return res.status(401).json({ error: 'Unauthorized' })

    const body = await readBody(req)
    const eventId = body?.eventId
    if (!eventId || typeof eventId !== 'string') {
      return res.status(400).json({ error: 'Missing eventId' })
    }

    const db = admin.firestore()
    const eventSnap = await db.collection('calendarEvents').doc(eventId).get()
    if (!eventSnap.exists) return res.status(404).json({ error: 'Calendar event not found' })

    const event = { id: eventSnap.id, ...eventSnap.data() }
    const recipients = await loadRecipientTargets(db, event.assigneeIds)
    if (recipients.employeeIds.size === 0) {
      return res.status(200).json({ ok: true, sent: 0 })
    }

    const sent = await sendPushes(db, event, recipients, decoded.uid)
    return res.status(200).json({ ok: true, sent })
  } catch (error) {
    console.error(error)
    return res.status(500).json({ error: 'Internal server error' })
  }
}
