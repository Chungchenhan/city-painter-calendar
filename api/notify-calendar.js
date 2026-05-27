import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import admin from 'firebase-admin'
import webpush from 'web-push'

const PROJECT_ID = 'city-painter-erp'

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

async function loadRecipientUids(db, assigneeIds) {
  const ids = new Set((assigneeIds || []).filter(Boolean))
  const uids = new Set()
  if (ids.size === 0) return uids

  const rolesSnap = await db.collection('userRoles').get()
  rolesSnap.forEach((item) => {
    const data = item.data()
    if (data.employeeId && ids.has(data.employeeId)) uids.add(item.id)
  })
  return uids
}

function eventTimeLabel(event) {
  const date = event.date || ''
  if (event.allDay) return `${date} 整天`
  const start = event.startTime || ''
  const end = event.endTime || ''
  return `${date} ${start}${end ? `-${end}` : ''}`.trim()
}

async function sendPushes(db, event, recipientUids, actorUid) {
  const subsSnap = await db.collection('calendarNotificationSubscriptions').where('enabled', '==', true).get()
  const targets = []
  subsSnap.forEach((item) => {
    const sub = item.data()
    if (!sub.uid || sub.uid === actorUid || !recipientUids.has(sub.uid) || !sub.subscription) return
    targets.push({ ref: item.ref, id: item.id, ...sub })
  })
  if (targets.length === 0) return 0

  const publicKey = process.env.WEB_PUSH_PUBLIC_KEY || process.env.VITE_WEB_PUSH_PUBLIC_KEY
  const privateKey = process.env.WEB_PUSH_PRIVATE_KEY
  if (!publicKey || !privateKey) throw new Error('Missing Web Push keys')

  webpush.setVapidDetails('mailto:admin@city-painter.com', publicKey, privateKey)

  const jobs = targets.map(async (sub) => {
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
      if (error?.statusCode === 404 || error?.statusCode === 410) {
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
    const recipientUids = await loadRecipientUids(db, event.assigneeIds)
    if (recipientUids.size === 0) {
      return res.status(200).json({ ok: true, sent: 0 })
    }

    const sent = await sendPushes(db, event, recipientUids, decoded.uid)
    return res.status(200).json({ ok: true, sent })
  } catch (error) {
    console.error(error)
    return res.status(500).json({ error: 'Internal server error' })
  }
}
