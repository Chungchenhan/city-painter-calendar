import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import admin from 'firebase-admin'

const PROJECT_ID = 'city-painter-erp'
const HR_LEAVE_SOURCE = 'hrLeaveRequest'

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

function recurrenceSourceDate(event) {
  return event?.recurrenceSourceDate || event?.date || ''
}

function isRepeatingEvent(event) {
  return Boolean(event?.repeat && event.repeat !== 'none')
}

function isHrReadonlyEvent(event, id) {
  return event?.source === HR_LEAVE_SOURCE || `${id || ''}`.startsWith('hrLeaveRequest_')
}

async function loadUserRole(db, uid) {
  const snap = await db.collection('userRoles').doc(uid).get()
  return snap.exists ? snap.data() : null
}

async function loadEmployee(db, employeeId) {
  if (!employeeId) return null
  const snap = await db.collection('employees').doc(employeeId).get()
  return snap.exists ? { id: snap.id, ...snap.data() } : null
}

async function canDeleteEvent(db, decoded, event, eventId) {
  if (!decoded?.uid || !event) return false
  if (isHrReadonlyEvent(event, eventId)) return false

  const role = await loadUserRole(db, decoded.uid)
  if (role?.role === 'admin') return true
  if (event.createdBy && event.createdBy === decoded.uid) return true

  const employee = await loadEmployee(db, role?.employeeId)
  if (!employee?.id) return false
  if (employee.departmentName !== '管理部') {
    const departments = await db.collection('departments').get()
    const departmentMap = new Map(departments.docs.map((doc) => [doc.id, doc.data()?.name || '']))
    if (departmentMap.get(event.departmentId) === '管理部') return false
  }

  if ((event.assigneeIds || []).includes(employee.id)) return true
  if (event.departmentId && event.departmentId === employee.departmentId) return true
  if (employee.departmentName && event.departmentId) {
    const deptSnap = await db.collection('departments').doc(event.departmentId).get()
    if (deptSnap.exists && deptSnap.data()?.name === employee.departmentName) return true
  }
  return false
}

async function deleteEventViews(db, eventId) {
  const employeesSnap = await db.collection('employees').get()
  const batch = db.batch()
  employeesSnap.docs.forEach((employeeDoc) => {
    batch.delete(db.collection('calendarEventViews').doc(employeeDoc.id).collection('events').doc(eventId))
  })
  await batch.commit()
}

async function writeActivityLog(db, decoded, event, eventId, actionDate) {
  const role = await loadUserRole(db, decoded.uid)
  await db.collection('calendarActivityLogs').add({
    action: 'delete',
    eventId,
    eventTitle: event.title || '未命名事件',
    calendarId: event.calendarIds?.[0] || event.calendarId || '',
    departmentId: event.departmentId || '',
    assigneeIds: event.assigneeIds || [],
    date: actionDate || event.date || '',
    actorUid: decoded.uid,
    actorName: role?.displayName || decoded.name || decoded.email || '有人',
    createdAt: new Date().toISOString()
  })
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

    const db = admin.firestore()
    const body = await readBody(req)
    const eventId = String(body?.eventId || '').trim()
    const rootId = String(body?.rootId || eventId).trim()
    const sourceDate = String(body?.sourceDate || '').trim()
    const scope = ['single', 'future', 'all'].includes(body?.scope) ? body.scope : 'all'
    if (!eventId || !rootId) return res.status(400).json({ error: 'Missing event id' })

    const rootSnap = await db.collection('calendarEvents').doc(rootId).get()
    const eventSnap = eventId !== rootId ? await db.collection('calendarEvents').doc(eventId).get() : rootSnap
    const event = eventSnap.exists ? { id: eventSnap.id, ...eventSnap.data() } : null
    const rootEvent = rootSnap.exists ? { id: rootSnap.id, ...rootSnap.data() } : event
    if (!rootEvent) return res.status(404).json({ error: 'Event not found' })
    if (!await canDeleteEvent(db, decoded, rootEvent, rootId)) return res.status(403).json({ error: 'Forbidden' })

    const actionDate = sourceDate || recurrenceSourceDate(event || rootEvent)
    if (scope === 'single' && (eventId !== rootId || isRepeatingEvent(rootEvent))) {
      await db.collection('calendarEvents').doc(rootId).update({
        repeatExceptions: admin.firestore.FieldValue.arrayUnion(actionDate),
        updatedAt: new Date().toISOString()
      })
    } else if (scope === 'future' && isRepeatingEvent(rootEvent) && actionDate && actionDate !== rootEvent.date) {
      const previousDate = new Date(`${actionDate}T00:00:00+08:00`)
      previousDate.setDate(previousDate.getDate() - 1)
      await db.collection('calendarEvents').doc(rootId).update({
        repeatUntil: previousDate.toISOString().slice(0, 10),
        updatedAt: new Date().toISOString()
      })
    } else {
      await db.collection('calendarEvents').doc(rootId).delete()
      await deleteEventViews(db, rootId).catch((error) => console.warn('delete calendar event views failed', error))
    }

    await writeActivityLog(db, decoded, rootEvent, rootId, actionDate).catch((error) => console.warn('write delete activity log failed', error))
    return res.status(200).json({ ok: true, eventId: rootId, scope, sourceDate: actionDate })
  } catch (error) {
    console.error(error)
    return res.status(500).json({ error: 'Internal server error' })
  }
}
