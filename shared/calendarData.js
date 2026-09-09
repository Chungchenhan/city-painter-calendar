import { authenticateCalendar } from './calendarApiSecurity.js'
import { createHash } from 'node:crypto'
import { FieldPath } from 'firebase-admin/firestore'
import identity from '../functions/calendarPushIdentity.js'
import { canReadCalendarEvent, canNotifyCalendarEvent } from './calendarEventAccess.js'

const REPEATS = ['daily', 'weekly', 'weekdays', 'monthly', 'monthlyNthWeekday', 'monthlyDay', 'yearly', 'custom']
const origins = new Set(['https://sch.city-painter.com', 'http://localhost:5175', 'https://macbook-air.tail7313ae.ts.net:5175'])
const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))
async function redactCalendarRow(db, actor, row, names) {
  if (actor.role === 'admin' || actor.employee.departmentName === '管理部'
    || !(row.source === 'hrLeaveRequest' || row.id.startsWith('hrLeaveRequest_'))) return row
  let name = ''
  if (identity.validDocumentId(row.sourceId)) {
    if (!names.has(row.sourceId)) {
      const leave = await db.collection('leaveRequests').doc(row.sourceId).get()
      const employeeId = leave.exists ? leave.data().employeeId : ''
      const employee = identity.validDocumentId(employeeId) ? await db.collection('employees').doc(employeeId).get() : null
      names.set(row.sourceId, employee?.exists ? String(employee.data().nickname || employee.data().name || '') : '')
    }
    name = names.get(row.sourceId)
  }
  return { ...row, title: `${name || '員工'} 請假`, note: '', titleOverrides: [] }
}

export async function handleCalendarData(req, res, { db, auth, appCheck }) {
  res.setHeader('Cache-Control', 'no-store')
  const origin = req.headers.origin
  if (origin && !origins.has(origin)) return res.status(403).json({ error: 'Origin not allowed' })
  if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin') }
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Firebase-AppCheck')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' })
  try {
    const actor = await authenticateCalendar(req, { db, auth, appCheck })
    const kind = String(req.query.kind || '')
    const leaveNames = new Map()
    if (kind === 'event' || kind === 'comments') {
      const eventId = String(req.query.eventId || '')
      if (!identity.validDocumentId(eventId)) return res.status(400).json({ error: 'Invalid event' })
      const snapshot = await db.collection('calendarEvents').doc(eventId).get()
      if (!snapshot.exists || !await canReadCalendarEvent(db, actor, snapshot.data())) return res.status(404).json({ error: 'Event unavailable' })
      if (kind === 'event' && req.method === 'GET') {
        const row = { ...snapshot.data(), id: snapshot.id }
        return res.status(200).json({ ok: true, rows: [await redactCalendarRow(db, actor, row, leaveNames)], cursor: null })
      }
      if (kind === 'comments' && req.method === 'GET') {
        const comments = await snapshot.ref.collection('comments').orderBy('createdAt', 'desc').limit(100).get()
        return res.status(200).json({ ok: true, rows: comments.docs.map(doc => ({ ...doc.data(), id: doc.id, createdAt: doc.data().createdAt?.toDate?.().toISOString() || doc.data().createdAt || '' })), cursor: null })
      }
      if (kind === 'comments' && req.method === 'POST' && req.body?.action === 'delete' && identity.validDocumentId(req.body.commentId)) {
        const ref = snapshot.ref.collection('comments').doc(req.body.commentId)
        await db.runTransaction(async tx => {
          const comment = await tx.get(ref)
          if (!comment.exists) return
          if (actor.role !== 'admin' && comment.data().authorUid !== actor.uid) throw Object.assign(new Error('Forbidden'), { status: 403 })
          tx.delete(ref)
        })
        return res.status(200).json({ ok: true })
      }
      return res.status(400).json({ error: 'Invalid comment operation' })
    }
    if (req.method === 'POST') {
      if (kind !== 'activity') return res.status(400).json({ error: 'Invalid kind' })
      const body = req.body || {}
      if (!identity.validDocumentId(body.eventId)) return res.status(400).json({ error: 'Event required' })
      const eventSnap = await db.collection('calendarEvents').doc(body.eventId).get()
      if (!eventSnap.exists) return res.status(409).json({ error: 'Event no longer exists' })
      const event = eventSnap.data()
      if (!await canNotifyCalendarEvent(db, actor, event)) return res.status(403).json({ error: 'Forbidden' })
      if (!['create', 'update', 'move', 'copy'].includes(body.action)) return res.status(400).json({ error: 'Invalid activity action' })
      const revision = eventSnap.updateTime.toMillis()
      const logId = createHash('sha256').update(`${eventSnap.id}:${revision}:${actor.uid}:${body.action}`).digest('hex')
      const logRef = db.collection('calendarActivityLogs').doc(logId)
      await db.runTransaction(async tx => {
        if ((await tx.get(logRef)).exists) return
        tx.create(logRef, {
        action: body.action, actorUid: actor.uid, actorName: actor.displayName,
        changes: Array.isArray(body.changes) ? body.changes.slice(0, 40).map(change => Object.fromEntries(['field', 'label', 'before', 'after'].map(key => [key, String(change?.[key] || '').slice(0, 2000)]))) : [],
        eventId: eventSnap.id, eventTitle: String(event.title || ''), calendarId: String(event.calendarId || ''),
        departmentId: String(event.departmentId || ''), assigneeIds: Array.isArray(event.assigneeIds) ? event.assigneeIds : [],
        date: String(event.date || ''), createdAt: new Date().toISOString(),
        scopeSnapshot: { source: event.source || '', sourceId: event.sourceId || '', calendarId: event.calendarId || '', calendarIds: event.calendarIds || [], departmentId: event.departmentId || '', visibleAssigneeIds: event.visibleAssigneeIds || [], visibleDepartmentIds: event.visibleDepartmentIds || [], hiddenAssigneeIds: event.hiddenAssigneeIds || [], hiddenDepartmentIds: event.hiddenDepartmentIds || [], assigneeIds: event.assigneeIds || [] },
        scopeVerified: true, serverVerified: true,
        })
      })
      return res.status(200).json({ ok: true })
    }
    let query
    let collection = 'calendarEvents'
    if (kind === 'groups') collection = 'calendarCalendars'
    else if (kind === 'activity') collection = 'calendarActivityLogs'
    else if (!['events', 'repeat', 'source'].includes(kind)) return res.status(400).json({ error: 'Invalid kind' })
    query = db.collection(collection)
    if (kind === 'events' && (req.query.start || req.query.end)) {
      if (!validDate(req.query.start) || !validDate(req.query.end) || req.query.start > req.query.end) return res.status(400).json({ error: 'Invalid range' })
      query = query.where('date', '>=', req.query.start).where('date', '<=', req.query.end).orderBy('date')
    } else if (kind === 'repeat') query = query.where('repeat', 'in', REPEATS).orderBy(FieldPath.documentId())
    else if (kind === 'source') {
      if (req.query.sourceId && !identity.validDocumentId(req.query.sourceId)) return res.status(400).json({ error: 'Invalid source' })
      query = req.query.sourceId ? query.where('sourceId', '==', req.query.sourceId) : query.where('sourceEventRole', '==', 'related')
      query = query.orderBy(FieldPath.documentId())
    } else if (kind === 'activity') query = query.orderBy('createdAt', 'desc')
    else query = query.orderBy(FieldPath.documentId())
    if (req.query.cursor) {
      if (!identity.validDocumentId(req.query.cursor)) return res.status(400).json({ error: 'Invalid cursor' })
      const cursor = await db.collection(collection).doc(req.query.cursor).get()
      if (!cursor.exists) return res.status(409).json({ error: 'Cursor expired' })
      query = query.startAfter(cursor)
    }
    const snap = await query.limit(200).get()
    const rows = []
    for (const doc of snap.docs) {
      const data = doc.data()
      let event = data
      if (kind === 'activity') {
        if (actor.role === 'admin') { rows.push({ ...data, id: doc.id }); continue }
        if (!identity.validDocumentId(data.eventId)) continue
        const source = await db.collection('calendarEvents').doc(data.eventId).get()
        if (!source.exists && data.scopeVerified !== true) continue
        event = source.exists ? source.data() : data.scopeSnapshot
      }
      const allowed = kind === 'groups'
        ? await canReadCalendarEvent(db, actor, { calendarId: doc.id })
        : await canReadCalendarEvent(db, actor, event)
      if (allowed) {
        const row = { ...data, id: doc.id }
        if (kind === 'activity' && actor.role !== 'admin' && actor.employee.departmentName !== '管理部' && event?.source === 'hrLeaveRequest') {
          const publicEvent = await redactCalendarRow(db, actor, { ...event, id: data.eventId }, leaveNames)
          row.eventTitle = publicEvent.title
          row.changes = []
        }
        rows.push(await redactCalendarRow(db, actor, row, leaveNames))
      }
    }
    return res.status(200).json({ ok: true, rows, cursor: snap.size === 200 ? snap.docs.at(-1).id : null })
  } catch (error) {
    console.error('[calendar-data] failed', error?.code || 'internal')
    return res.status(error?.status || 500).json({ error: error?.status ? error.message : '行事曆資料暫時無法讀取，請稍後再試。' })
  }
}
